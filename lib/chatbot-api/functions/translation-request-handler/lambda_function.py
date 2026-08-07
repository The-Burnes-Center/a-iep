"""
On-demand translation of an already-processed IEP into ONE additional language.

POST /profile/children/{childId}/documents/{iepId}/translations
  {"language": "es"}

Before this existed, a parent whose preferred language had no translation was
told to upload the whole document again: a second OCR + redaction + analysis
pass, minutes of waiting, and a second trip through the pipeline for a
FERPA-protected record. This endpoint instead re-runs only the existing
translation step against the English content already in S3. The pipeline's
save_content_to_s3 merges per language, so the languages already present are
never clobbered.

Responses (the frontend is built against exactly these):
  202 {"status": "PROCESSING_TRANSLATIONS", ...}   generation started
  200 {"status": "PROCESSED", "alreadyExists": true}   already translated, no-op
  400 missing or unsupported language ('en' is the source, never a target)
  403 not the caller's child, or not the caller's document
  404 no such document
  409 no English content to translate from, or one is already in flight
  429 this document has spent its translation-attempt budget
  500 could not start the work

The real work runs in the SingleLanguageTranslation state machine: the
translation step is a 600s lambda, far past API Gateway's 29s cap, and nothing
would put the document back to PROCESSED if it were fire-and-forget.

Error bodies are generic {"error": "..."} and never carry exception text.
Returning str(e) from a handler once leaked table names and AWS error codes to
callers.
"""
import base64
import json
import os
import re
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')
user_profiles_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])
iep_documents_table = dynamodb.Table(os.environ['IEP_DOCUMENTS_TABLE'])

s3_client = boto3.client('s3')
BUCKET = os.environ['BUCKET']

# Canonical list, same as user-profile-handler and tts-handler.
SUPPORTED_LANGUAGES = ['en', 'zh', 'es', 'vi', 'ar']

# The pipeline translates FROM English, so English can never be a target: a
# request for 'en' is a bug in the caller, not a translation we can produce.
SOURCE_LANGUAGE = 'en'
TRANSLATABLE_LANGUAGES = [lang for lang in SUPPORTED_LANGUAGES if lang != SOURCE_LANGUAGE]

# Statuses that mean the pipeline already has work in flight for a document.
# Both are polled by the frontend, so either one means "come back later".
IN_FLIGHT_STATUSES = ('PROCESSING', 'PROCESSING_TRANSLATIONS')
IN_FLIGHT_STATUS = 'PROCESSING_TRANSLATIONS'
COMPLETED_STATUS = 'PROCESSED'

# Cost guard. Every accepted request spends real OpenAI money, and there is no
# per-user metering anywhere in this app. Two things already bound the spend:
# a language that exists returns a free 200, and only 4 languages are
# translatable, so the honest ceiling is 4 paid runs per document. The hole is
# retries: a translation that FAILS writes nothing, so the same request is
# accepted again, forever. This budget closes that at ~3 attempts per language.
# It is counted on the document item itself (translationRequestCount) inside
# the same conditional write that claims the in-flight slot, so no extra table
# and no second round trip. A slot we release without spending is decremented.
MAX_TRANSLATION_ATTEMPTS = 12

# Where the progress bar sits while a single language is generated. The main
# pipeline reports 65 after analysis and 85 after translation; 70 lands inside
# that window so a re-translation reads as "nearly done" rather than restarting.
IN_FLIGHT_PROGRESS = 70

# Step Functions rejects execution names outside [A-Za-z0-9_-]{1,80}.
EXECUTION_NAME_MAX_LENGTH = 80


def _stepfunctions_client():
    """Step Functions client factory, kept as a module attribute so tests can
    swap in a fake at the point of use instead of patching boto3 globally."""
    return boto3.client('stepfunctions')


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


def _now_iso():
    """
    UTC timestamp in the same offset-free shape every other writer of this table
    uses (ddb-service's update_progress), so updated_at stays comparable across
    them. datetime.utcnow() would give the identical string but is deprecated.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def _reject(status_code, reason, **context):
    """
    Refuse a request AND say why in the log.

    A silent 4xx is a defect here: an unlogged validation rejection in the TTS
    handler made a real staging failure undiagnosable on 2026-07-29. The logged
    context is ids, the language, and presence flags only — never document
    content, and never the underlying exception, which is what the caller must
    not see either.
    """
    print(f"Rejected translation request ({status_code}): {reason} "
          f"| {json.dumps(context, default=str)}")
    return create_response(status_code, {'error': reason})


def _claim_sub(event):
    """The Cognito subject the JWT authorizer verified, or None."""
    try:
        return event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return None


def _parse_body(event):
    body = event.get('body') or '{}'
    if event.get('isBase64Encoded'):
        body = base64.b64decode(body).decode('utf-8')
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise ValueError('body is not a JSON object')
    return parsed


def _user_owns_child(user_id, child_id):
    """The authenticated user must have a child with the matching childId."""
    if not user_id or not child_id:
        return False
    try:
        profile_response = user_profiles_table.get_item(Key={'userId': user_id})
    except ClientError as e:
        print(f"Error loading profile for ownership check: {e.response['Error']['Code']}")
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


def _load_document(iep_id, child_id):
    """The document row, or None. Raises ClientError so the caller can 500."""
    response = iep_documents_table.get_item(Key={'iepId': iep_id, 'childId': child_id})
    return response.get('Item')


def _load_content(doc, iep_id, child_id):
    """Read content.json via the document's S3 reference (legacy-key fallback)."""
    s3_ref = doc.get('contentS3Reference') or {}
    bucket = s3_ref.get('bucket') or BUCKET
    key = s3_ref.get('s3Key') or f'iep-data/{iep_id}/{child_id}/content.json'
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        return json.loads(response['Body'].read().decode('utf-8'))
    except (ClientError, ValueError) as e:
        # Error code only: the body is the document itself.
        code = e.response['Error']['Code'] if isinstance(e, ClientError) else 'InvalidJSON'
        print(f"Could not load content.json for {iep_id}/{child_id}: {code}")
        return None


def _translated_languages(content):
    """Languages that have BOTH a summary and sections, i.e. are usable."""
    summaries = (content or {}).get('summaries') or {}
    sections = (content or {}).get('sections') or {}
    if not isinstance(summaries, dict) or not isinstance(sections, dict):
        return set()
    return {lang for lang in summaries if summaries.get(lang) and sections.get(lang)}


def _claim_translation_slot(iep_id, child_id):
    """
    Atomically flip the document into PROCESSING_TRANSLATIONS and count the
    attempt. Returns False when another writer got there first or the budget is
    spent.

    The reads in lambda_handler already rejected an in-flight document, but a
    read followed by a write is not atomic, and there is no locking anywhere
    else on this table: two taps a few milliseconds apart would both pass the
    read and start two executions racing over one content.json. This
    ConditionExpression is what actually makes the guard hold, because it
    re-checks status and budget against the item as it is at write time. The
    read-side check stays because it is what produces the specific reason for
    the caller and the log; a failed condition can only say "no".

    attribute_exists(iepId) matters too: UpdateItem is an upsert, so without it
    a document deleted between the read and this write would come back as a
    stub row that no upload created.
    """
    now = _now_iso()
    try:
        iep_documents_table.update_item(
            Key={'iepId': iep_id, 'childId': child_id},
            UpdateExpression=(
                'SET #status = :in_flight, current_step = :step, '
                'progress = :progress, updated_at = :now '
                'ADD translationRequestCount :one'
            ),
            ConditionExpression=(
                'attribute_exists(iepId) '
                'AND (attribute_not_exists(#status) '
                '     OR (#status <> :processing AND #status <> :in_flight)) '
                'AND (attribute_not_exists(translationRequestCount) '
                '     OR translationRequestCount < :max_attempts)'
            ),
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':in_flight': IN_FLIGHT_STATUS,
                ':processing': 'PROCESSING',
                ':step': 'translation_requested',
                ':progress': IN_FLIGHT_PROGRESS,
                ':now': now,
                ':one': 1,
                ':max_attempts': MAX_TRANSLATION_ATTEMPTS,
            }
        )
        return True
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False
        raise


def _release_translation_slot(iep_id, child_id, previous_status, previous_progress):
    """
    Undo a claim whose execution never started, so the document does not sit at
    PROCESSING_TRANSLATIONS forever with nothing running behind it. Conditional
    on the status still being ours, and the attempt is refunded because no
    OpenAI call was made. Best effort: the caller is already returning 500.
    """
    try:
        iep_documents_table.update_item(
            Key={'iepId': iep_id, 'childId': child_id},
            UpdateExpression=(
                'SET #status = :previous, current_step = :step, '
                'progress = :progress, updated_at = :now '
                'ADD translationRequestCount :minus_one'
            ),
            ConditionExpression='#status = :in_flight',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':previous': previous_status or COMPLETED_STATUS,
                ':in_flight': IN_FLIGHT_STATUS,
                ':step': 'translation_request_failed',
                ':progress': previous_progress,
                ':now': _now_iso(),
                ':minus_one': -1,
            }
        )
        print(f"Released translation slot for {iep_id}/{child_id}")
    except ClientError as e:
        print(f"Could not release translation slot for {iep_id}/{child_id}: "
              f"{e.response['Error']['Code']}")


def _execution_name(iep_id, language, context):
    """
    Build a Step Functions execution name: [A-Za-z0-9_-]{1,80}.

    iepId arrives from the URL path, so it is sanitized rather than trusted
    even though it had to match a real document to get here — a stray character
    would otherwise turn a valid request into a 500. The request id goes before
    the id so truncation can never eat the part that makes the name unique.
    """
    request_id = (getattr(context, 'aws_request_id', '') or '')[:8]
    raw = f'xlate-{language}-{request_id}-{iep_id}'
    return re.sub(r'[^A-Za-z0-9_-]', '-', raw)[:EXECUTION_NAME_MAX_LENGTH]


def _start_translation(iep_id, child_id, user_id, language, context):
    """Start the state machine. The event shape is translate_content's own."""
    state_machine_arn = os.environ.get('TRANSLATION_STATE_MACHINE_ARN')
    if not state_machine_arn:
        raise RuntimeError('TRANSLATION_STATE_MACHINE_ARN is not configured')

    execution_input = {
        'iep_id': iep_id,
        'child_id': child_id,
        'user_id': user_id,
        'target_languages': [language],
        'content_type': 'parsing_result',
    }
    response = _stepfunctions_client().start_execution(
        stateMachineArn=state_machine_arn,
        name=_execution_name(iep_id, language, context),
        input=json.dumps(execution_input)
    )
    return response['executionArn']


def lambda_handler(event, context):
    method = (
        event.get('requestContext', {}).get('http', {}).get('method')
        or event.get('httpMethod', '')
    )
    if method == 'OPTIONS':
        return create_response(200, {})

    path_params = event.get('pathParameters') or {}
    child_id = path_params.get('childId')
    iep_id = path_params.get('iepId')

    user_id = _claim_sub(event)
    if not user_id:
        return _reject(401, 'Unauthorized', iep_id=iep_id)

    if not child_id or not iep_id:
        return _reject(400, 'Missing childId or iepId path parameter',
                       has_child_id=bool(child_id), has_iep_id=bool(iep_id))

    try:
        body = _parse_body(event)
    except (ValueError, TypeError):
        return _reject(400, 'Invalid JSON body', iep_id=iep_id)

    language = body.get('language')
    request_meta = {'iep_id': iep_id, 'child_id': child_id, 'language': language}

    if not language:
        return _reject(400, 'Missing language', **request_meta)
    if language == SOURCE_LANGUAGE:
        # Not merely unsupported: English is the source the pipeline translates
        # from, so there is no such thing as generating it.
        return _reject(400, 'English is the source language, not a translation',
                       **request_meta)
    if language not in TRANSLATABLE_LANGUAGES:
        return _reject(400, 'Unsupported language', **request_meta)

    if not _user_owns_child(user_id, child_id):
        return _reject(403, 'Access denied', **request_meta)

    try:
        doc = _load_document(iep_id, child_id)
    except ClientError as e:
        print(f"Error loading document {iep_id}: {e.response['Error']['Code']}")
        return create_response(500, {'error': 'Could not load document'})

    if not doc:
        return _reject(404, 'Document not found', **request_meta)
    if doc.get('userId') != user_id:
        # Owning the child is not enough: the document row carries its own
        # owner, and only that owner may spend money against it.
        return _reject(403, 'Access denied', **request_meta)

    content = _load_content(doc, iep_id, child_id)
    available = _translated_languages(content)

    if language in available:
        # Free no-op. Checked before the English gate so a parent asking for
        # something they already have always gets a clean answer.
        print(f"Translation already present for {iep_id} ({language}), nothing to do")
        return create_response(200, {
            'status': COMPLETED_STATUS,
            'language': language,
            'iepId': iep_id,
            'alreadyExists': True,
        })

    if SOURCE_LANGUAGE not in available:
        # translate_content hard-raises without summaries.en / sections.en, so
        # accepting this would burn an execution to fail. 409, not 404: the
        # document exists, its English content just is not ready.
        return _reject(409, 'No English content available to translate',
                       **request_meta, available_languages=sorted(available))

    document_status = doc.get('status')
    if document_status in IN_FLIGHT_STATUSES:
        return _reject(409, 'A translation is already in progress',
                       **request_meta, document_status=document_status)

    attempts = int(doc.get('translationRequestCount') or 0)
    if attempts >= MAX_TRANSLATION_ATTEMPTS:
        return _reject(429, 'Translation attempt limit reached for this document',
                       **request_meta, attempts=attempts)

    if not _claim_translation_slot(iep_id, child_id):
        # Lost the race, or the budget was spent between the read and the
        # write. Either way the honest answer is "not now".
        return _reject(409, 'A translation is already in progress',
                       **request_meta, document_status=document_status,
                       conditional_write='failed')

    previous_progress = doc.get('progress', 100)
    try:
        execution_arn = _start_translation(iep_id, child_id, user_id, language, context)
    except Exception as e:
        # Never leave the document in-flight with nothing behind it.
        print(f"Failed to start translation execution for {iep_id}: {type(e).__name__}")
        _release_translation_slot(iep_id, child_id, document_status, previous_progress)
        return create_response(500, {'error': 'Could not start translation'})

    print(f"Started single-language translation for {iep_id} ({language}): {execution_arn}")
    return create_response(202, {
        'status': IN_FLIGHT_STATUS,
        'language': language,
        'iepId': iep_id,
        'alreadyExists': False,
    })
