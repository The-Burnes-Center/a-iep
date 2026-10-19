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
from botocore.exceptions import BotoCoreError, ClientError

from providers import (
    get_provider,
    TTSProviderError,
    TTSProviderNotConfigured,
    TTSProviderUnavailable,
)
from student_name_substitution import replacement_for, substitute_text, usable_student_name
from text_utils import markdown_to_text

dynamodb = boto3.resource('dynamodb')
USER_PROFILES_TABLE_NAME = os.environ.get('USER_PROFILES_TABLE', '')
IEP_DOCUMENTS_TABLE_NAME = os.environ.get('IEP_DOCUMENTS_TABLE', '')
BUCKET = os.environ.get('BUCKET', '')
# Checked per request, not at import: a missing setting becomes a logged 500
# instead of a cold-start crash that the API answers with a bare 502.
user_profiles_table = dynamodb.Table(USER_PROFILES_TABLE_NAME)
iep_documents_table = dynamodb.Table(IEP_DOCUMENTS_TABLE_NAME)

# Child names are CMK-encrypted in the profile; this reads one per request so
# the voice says the name rather than the placeholder stored in its place.
kms_client = boto3.client(
    'kms', region_name=os.environ.get('AWS_REGION',
                                      os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')))

# SigV4 is required for presigned URLs on KMS-encrypted objects
s3_client = boto3.client('s3', config=Config(signature_version='s3v4'))

SUPPORTED_LANGUAGES = ['en', 'zh', 'es', 'vi', 'ar']
VALID_TARGETS = ['summary', 'section']
PRESIGN_TTL_SECONDS = 3600

# The longest text one request may read aloud, in characters after markdown is
# stripped. The parsing model returns the whole document (summary and every
# section) in one response, capped at gpt-4.1's 32,768 output tokens. At about
# four characters per token that is roughly 131,000 characters, so nothing the
# pipeline can emit is refused. The cap only stops a runaway stored section
# from turning into an unbounded paid synthesis.
MAX_SPOKEN_CHARS = 131_072

# S3 answers a missing object with one of these codes (HeadObject reports 404).
NOT_FOUND_CODES = ('404', 'NoSuchKey', 'NotFound')
UNAVAILABLE_MESSAGE = 'Temporarily unavailable, please try again'


def create_response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS, POST',
            'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
            'Cache-Control': 'no-store',
        },
        'body': json.dumps(body)
    }


def _error_code(error):
    return error.response.get('Error', {}).get('Code', 'unknown')


def _user_owns_child(user_id, child_id):
    """The authenticated user must have a child with the matching childId.

    A DynamoDB fault propagates: it is the service's failure, so the caller
    gets a 503, not a claim that the child is not theirs.
    """
    if not user_id or not child_id:
        return False

    profile = user_profiles_table.get_item(Key={'userId': user_id}).get('Item')
    if not profile:
        return False

    children = profile.get('children') or []
    if not isinstance(children, list):
        return False

    return any(
        isinstance(child, dict) and child.get('childId') == child_id
        for child in children
    )


def _decrypt_profile_field(value):
    """Decrypt a KMS-encrypted profile field, or hand back what was stored.

    Same contract as kms_decrypt_string in user-profile-handler, which is what
    wrote the value: child names became CMK-encrypted when the name was made
    mandatory, and rows written before that are still plaintext. Falling
    through on a decrypt failure is what keeps those legacy rows readable, and
    usable_student_name's length guard is what stops a ciphertext that fell
    through from being spelled out loud as the child's name.
    """
    if not isinstance(value, str) or not value:
        return value
    try:
        blob = base64.b64decode(value)
    except Exception:
        return value  # not base64, so it was never encrypted
    try:
        return kms_client.decrypt(CiphertextBlob=blob)['Plaintext'].decode('utf-8')
    except Exception as e:
        # Class name only, and no value: this argument is a child's name.
        print(f"Profile field decrypt failed: {type(e).__name__}")
        return value


def _child_name(user_id, child_id):
    """The child's name from the profile, decrypted, or None.

    None is a complete answer rather than a failure: replacement_for falls
    back to the neutral phrase for the language being spoken. Nothing here
    raises. A parent who hears "your child" instead of a name still gets their
    summary read aloud, which is worth more than a failed request.
    """
    try:
        profile = user_profiles_table.get_item(Key={'userId': user_id}).get('Item') or {}
        for child in profile.get('children') or []:
            if isinstance(child, dict) and child.get('childId') == child_id:
                return usable_student_name(_decrypt_profile_field(child.get('name')))
    except Exception as e:
        print(f"Could not read the child's name for speech: {type(e).__name__}")
    return None


def _slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', (name or '').lower()).strip('-')
    return slug or 'section'


def _parse_body(event):
    """The request body as a JSON object. Anything else raises ValueError."""
    body = event.get('body') or '{}'
    if event.get('isBase64Encoded'):
        body = base64.b64decode(body).decode('utf-8')
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise ValueError('body is not a JSON object')
    return parsed


def _load_content(doc, iep_id, child_id):
    """Read content.json via the document's S3 reference (with legacy-key fallback).

    Returns None only for a genuinely missing object. Any other S3 failure
    propagates, so throttling or an access fault is a 503 and not a 404 that
    tells the parent the content does not exist yet.
    """
    s3_ref = doc.get('contentS3Reference') or {}
    bucket = s3_ref.get('bucket') or BUCKET
    key = s3_ref.get('s3Key') or f'iep-data/{iep_id}/{child_id}/content.json'
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
    except ClientError as e:
        if _error_code(e) in NOT_FOUND_CODES:
            print(f"content.json not found for {iep_id}")
            return None
        raise
    return json.loads(response['Body'].read().decode('utf-8'))


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
    """True when the cache object exists. Only a genuine not-found is a miss:
    any other S3 failure propagates, so a throttled HeadObject cannot send the
    request into a second paid synthesis."""
    try:
        s3_client.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError as e:
        if _error_code(e) in NOT_FOUND_CODES:
            return False
        raise


def _presigned_url(key):
    return s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': BUCKET, 'Key': key},
        ExpiresIn=PRESIGN_TTL_SECONDS
    )


def _reject(status, message, **context):
    """
    Refuse a request AND say why in the log.

    Every validation path here used to return silently, so a rejected request
    was indistinguishable from a healthy one: a 2ms invocation with no output.
    A staging E2E failure on 2026-07-29 could not be diagnosed for exactly that
    reason. None of the logged fields carry document content: ids, the target,
    and the language are safe, and presence flags avoid echoing anything else.
    """
    print(f"Rejected TTS request ({status}): {message} | {json.dumps(context)}")
    return create_response(status, {'message': message})


def _missing_config():
    settings = (
        ('USER_PROFILES_TABLE', USER_PROFILES_TABLE_NAME),
        ('IEP_DOCUMENTS_TABLE', IEP_DOCUMENTS_TABLE_NAME),
        ('BUCKET', BUCKET),
    )
    return [name for name, value in settings if not value]


def _validate_request(iep_id, body):
    """(request fields, None), or (None, 400 response) with the reason logged."""
    child_id = body.get('childId')
    language = body.get('language')
    target = body.get('target')
    section_name = body.get('sectionName')

    # Shared context for the rejections below: enough to tell which field the
    # caller got wrong without logging anything sensitive.
    request_meta = {
        'iep_id': iep_id,
        'has_child_id': bool(child_id),
        'language': language,
        'target': target,
        'has_section_name': bool(section_name),
    }

    if not child_id or not isinstance(child_id, str):
        return None, _reject(400, 'Missing childId', **request_meta)
    if language not in SUPPORTED_LANGUAGES:
        return None, _reject(400, f'Unsupported language: {language}', **request_meta)
    if target not in VALID_TARGETS:
        return None, _reject(400, f'Invalid target: {target}', **request_meta)
    if target == 'section' and not section_name:
        return None, _reject(400, 'Missing sectionName for section target', **request_meta)
    if section_name is not None and not isinstance(section_name, str):
        return None, _reject(400, 'sectionName must be a string', **request_meta)
    return {'child_id': child_id, 'language': language, 'target': target,
            'section_name': section_name, 'meta': request_meta}, None


def _load_owned_document(iep_id, child_id, user_id, meta):
    """(document, None) or (None, 404 response). A missing document and one
    owned by someone else get the same answer; only the log tells them apart."""
    doc = iep_documents_table.get_item(Key={'iepId': iep_id, 'childId': child_id}).get('Item')
    if not doc:
        return None, _reject(404, 'Document not found', **meta, reason='no document row')
    if doc.get('userId') != user_id:
        return None, _reject(404, 'Document not found', **meta, reason='document owned by another user')
    return doc, None


def _spoken_text(doc, iep_id, child_id, user_id, fields):
    """The plain text to read aloud, with the student token substituted, or None."""
    content = _load_content(doc, iep_id, child_id)
    if not content:
        return None, _reject(404, 'Document content not available yet', **fields['meta'])

    markdown = _resolve_text(content, fields['language'], fields['target'], fields['section_name'])

    # Stored content calls the child {{S}} and keeps doing so. Substituting
    # here, before markdown_to_text and before the cache key is derived from
    # the text, is what keeps the provider from reading a placeholder aloud
    # and what makes a corrected name miss the cache instead of replaying the
    # old one. Never raises: a placeholder spoken is better than a 500.
    if markdown:
        try:
            markdown, substituted = substitute_text(
                markdown, replacement_for(_child_name(user_id, child_id), fields['language']))
            print(f"Substituted the student token in {substituted} place(s) before synthesis")
        except Exception as e:
            print(f"Student name substitution failed: {type(e).__name__}")

    plain_text = markdown_to_text(markdown) if markdown else ''
    if not plain_text:
        return None, _reject(404, f"No {fields['target']} content available for language {fields['language']}",
                             **fields['meta'])
    return plain_text, None


def _synthesize(provider, plain_text, language):
    """(audio bytes, content type), or (None, error response) with the reason logged."""
    try:
        audio_bytes, content_type = provider.synthesize(plain_text, language)
    except TTSProviderNotConfigured as e:
        print(f"TTS provider not configured: {e}")
        return None, create_response(500, {'message': 'Server configuration error'})
    except TTSProviderUnavailable as e:
        print(f"TTS provider unreachable: {e}")
        return None, create_response(503, {'message': UNAVAILABLE_MESSAGE})
    except TTSProviderError as e:
        print(f"TTS provider error: {e}")
        return None, create_response(502, {'message': 'Speech synthesis failed'})

    if not audio_bytes:
        print("TTS provider returned empty audio")
        return None, create_response(502, {'message': 'Speech synthesis failed'})
    return (audio_bytes, content_type), None


def _handle_audio_request(event, user_id):
    iep_id = (event.get('pathParameters') or {}).get('iepId')
    if not iep_id:
        return _reject(400, 'Missing iepId path parameter')

    try:
        body = _parse_body(event)
    except (ValueError, TypeError):
        return _reject(400, 'Invalid JSON body', iep_id=iep_id)

    fields, error = _validate_request(iep_id, body)
    if error:
        return error
    child_id, language, target = fields['child_id'], fields['language'], fields['target']

    # The child check and the document check answer identically, so a caller
    # cannot tell an unknown child from another family's document.
    if not _user_owns_child(user_id, child_id):
        return _reject(404, 'Document not found', **fields['meta'], reason='child not on the caller profile')
    doc, error = _load_owned_document(iep_id, child_id, user_id, fields['meta'])
    if error:
        return error

    plain_text, error = _spoken_text(doc, iep_id, child_id, user_id, fields)
    if error:
        return error
    if len(plain_text) > MAX_SPOKEN_CHARS:
        return _reject(413, 'Content is too long to read aloud', **fields['meta'],
                       chars=len(plain_text), limit=MAX_SPOKEN_CHARS)

    provider = get_provider()
    text_hash = hashlib.sha256(
        f'{provider.fingerprint(language)}|{plain_text}'.encode('utf-8')
    ).hexdigest()[:16]
    target_slug = 'summary' if target == 'summary' else _slugify(fields['section_name'])
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
    synthesized, error = _synthesize(provider, plain_text, language)
    if error:
        return error
    audio_bytes, content_type = synthesized

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


def lambda_handler(event, context):
    method = (
        event.get('requestContext', {}).get('http', {}).get('method')
        or event.get('httpMethod', '')
    )
    if method == 'OPTIONS':
        return create_response(200, {})

    missing = _missing_config()
    if missing:
        print(f"Server misconfigured: {', '.join(missing)} not set")
        return create_response(500, {'message': 'Server configuration error'})

    iep_id = (event.get('pathParameters') or {}).get('iepId')
    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return _reject(401, 'Unauthorized', iep_id=iep_id)

    try:
        return _handle_audio_request(event, user_id)
    except (BotoCoreError, ClientError) as e:
        # The error code names the failure (throttling, access); the message
        # can quote table and bucket names, so it stays out of the log.
        name = _error_code(e) if isinstance(e, ClientError) else type(e).__name__
        print(f"AWS call failed while serving audio: {name}")
        return create_response(503, {'message': UNAVAILABLE_MESSAGE})
    except Exception as e:
        print(f"Unexpected error while serving audio: {type(e).__name__}")
        return create_response(500, {'message': 'Internal error'})
