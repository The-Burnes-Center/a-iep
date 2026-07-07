"""
On-demand text-to-speech for IEP summaries and sections.

POST /documents/{iepId}/audio
  {"childId": "...", "language": "es", "target": "summary"}
  {"childId": "...", "language": "zh", "target": "section", "sectionName": "Goals"}

The client only references content — the text is always read server-side from
the canonical content.json in S3, so this endpoint cannot be used as a free
TTS service. Synthesized MP3s are cached in S3 under iep-audio/ keyed by a
hash of provider+model+voice+text, and served via presigned GET URLs.
"""
import base64
import hashlib
import json
import os
import re
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from providers import get_provider, TTSProviderError
from text_utils import markdown_to_text

dynamodb = boto3.resource('dynamodb')
user_profiles_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])
iep_documents_table = dynamodb.Table(os.environ['IEP_DOCUMENTS_TABLE'])

# SigV4 is required for presigned URLs on KMS-encrypted objects
s3_client = boto3.client('s3', config=Config(signature_version='s3v4'))
BUCKET = os.environ['BUCKET']

SUPPORTED_LANGUAGES = ['en', 'zh', 'es', 'vi', 'ar']
VALID_TARGETS = ['summary', 'section']
PRESIGN_TTL_SECONDS = 3600


def create_response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS, POST',
            'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
        },
        'body': json.dumps(body)
    }


def _user_owns_child(user_id, child_id):
    """The authenticated user must have a child with the matching childId."""
    if not user_id or not child_id:
        return False
    try:
        profile_response = user_profiles_table.get_item(Key={'userId': user_id})
    except Exception as e:
        print(f"Error loading profile for ownership check: {str(e)}")
        return False

    profile = profile_response.get('Item')
    if not profile:
        return False

    children = profile.get('children') or []
    if not isinstance(children, list):
        return False

    return any(
        isinstance(child, dict) and child.get('childId') == child_id
        for child in children
    )


def _slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', (name or '').lower()).strip('-')
    return slug or 'section'


def _parse_body(event):
    body = event.get('body') or '{}'
    if event.get('isBase64Encoded'):
        body = base64.b64decode(body).decode('utf-8')
    return json.loads(body)


def _load_content(doc, iep_id, child_id):
    """Read content.json via the document's S3 reference (with legacy-key fallback)."""
    s3_ref = doc.get('contentS3Reference') or {}
    bucket = s3_ref.get('bucket') or BUCKET
    key = s3_ref.get('s3Key') or f'iep-data/{iep_id}/{child_id}/content.json'
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        return json.loads(response['Body'].read().decode('utf-8'))
    except ClientError as e:
        print(f"Could not load content.json ({key}): {e.response['Error']['Code']}")
        return None


def _resolve_text(content, language, target, section_name):
    """Pull the requested markdown out of content.json; None if unavailable.

    Sections in content.json carry the canonical English name in 'title'
    (see parsing_agent/data_model.py); the frontend re-maps it to 'name'.
    """
    if target == 'summary':
        return (content.get('summaries') or {}).get(language)
    sections = (content.get('sections') or {}).get(language) or []
    for section in sections:
        if not isinstance(section, dict):
            continue
        if section.get('title') == section_name or section.get('name') == section_name:
            return section.get('content')
    return None


def _cached_audio_exists(key):
    try:
        s3_client.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError:
        return False


def _presigned_url(key):
    return s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': BUCKET, 'Key': key},
        ExpiresIn=PRESIGN_TTL_SECONDS
    )


def lambda_handler(event, context):
    method = (
        event.get('requestContext', {}).get('http', {}).get('method')
        or event.get('httpMethod', '')
    )
    if method == 'OPTIONS':
        return create_response(200, {})

    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return create_response(401, {'message': 'Unauthorized'})

    iep_id = (event.get('pathParameters') or {}).get('iepId')
    if not iep_id:
        return create_response(400, {'message': 'Missing iepId path parameter'})

    try:
        body = _parse_body(event)
    except (ValueError, TypeError):
        return create_response(400, {'message': 'Invalid JSON body'})

    child_id = body.get('childId')
    language = body.get('language')
    target = body.get('target')
    section_name = body.get('sectionName')

    if not child_id:
        return create_response(400, {'message': 'Missing childId'})
    if language not in SUPPORTED_LANGUAGES:
        return create_response(400, {'message': f'Unsupported language: {language}'})
    if target not in VALID_TARGETS:
        return create_response(400, {'message': f'Invalid target: {target}'})
    if target == 'section' and not section_name:
        return create_response(400, {'message': 'Missing sectionName for section target'})

    # Authorization: user must own the child, and the document must belong to them
    if not _user_owns_child(user_id, child_id):
        print(f"Access denied: user does not own requested child")
        return create_response(403, {'message': 'Access denied'})

    try:
        doc_response = iep_documents_table.get_item(Key={'iepId': iep_id, 'childId': child_id})
    except Exception as e:
        print(f"Error loading document {iep_id}: {str(e)}")
        return create_response(500, {'message': 'Error loading document'})

    doc = doc_response.get('Item')
    if not doc or doc.get('userId') != user_id:
        print(f"Access denied: document not found or not owned by user")
        return create_response(403, {'message': 'Access denied'})

    content = _load_content(doc, iep_id, child_id)
    if not content:
        return create_response(404, {'message': 'Document content not available yet'})

    markdown = _resolve_text(content, language, target, section_name)
    plain_text = markdown_to_text(markdown) if markdown else ''
    if not plain_text:
        return create_response(404, {'message': f'No {target} content available for language {language}'})

    provider = get_provider()
    text_hash = hashlib.sha256(
        f'{provider.fingerprint(language)}|{plain_text}'.encode('utf-8')
    ).hexdigest()[:16]
    target_slug = 'summary' if target == 'summary' else _slugify(section_name)
    audio_key = f'iep-audio/{iep_id}/{child_id}/{language}/{target_slug}-{text_hash}.mp3'

    if _cached_audio_exists(audio_key):
        print(f"Audio cache hit: {audio_key}")
        return create_response(200, {
            'status': 'ready',
            'url': _presigned_url(audio_key),
            'expiresInSeconds': PRESIGN_TTL_SECONDS,
            'cached': True,
            'provider': provider.name
        })

    print(f"Audio cache miss, synthesizing {len(plain_text)} chars via {provider.name}: {audio_key}")
    try:
        audio_bytes, content_type = provider.synthesize(plain_text, language)
    except TTSProviderError as e:
        print(f"TTS provider error: {str(e)}")
        return create_response(502, {'message': 'Speech synthesis failed'})

    if not audio_bytes:
        print("TTS provider returned empty audio")
        return create_response(502, {'message': 'Speech synthesis failed'})

    s3_client.put_object(
        Bucket=BUCKET,
        Key=audio_key,
        Body=audio_bytes,
        ContentType=content_type,
        ServerSideEncryption='aws:kms'
    )

    return create_response(200, {
        'status': 'ready',
        'url': _presigned_url(audio_key),
        'expiresInSeconds': PRESIGN_TTL_SECONDS,
        'cached': False,
        'provider': provider.name
    })
