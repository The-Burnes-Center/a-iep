"""metadata-handler ddb-service tests. This internal lambda is the single
writer for document status/content: the Step Functions steps call it for
every progress update, OCR payload, and final result, and the profile API's
lazy migration depends on get_document_with_content. The retention rules
matter most: OCR payloads live in S3 (400KB item limit), and a FAILED
document must retain no unredacted artifacts.
"""
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

DOCUMENTS_TABLE = 'documents-test'
PROFILES_TABLE = 'profiles-test'
BUCKET = 'metadata-bucket-test'
IEP, CHILD, USER = 'iep-1', 'child-1', 'user-sub-1'
KEY = {'iepId': IEP, 'childId': CHILD}
IDS = {'iep_id': IEP, 'child_id': CHILD, 'user_id': USER}


@pytest.fixture()
def service(monkeypatch):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        documents = dynamodb.create_table(
            TableName=DOCUMENTS_TABLE,
            KeySchema=[
                {'AttributeName': 'iepId', 'KeyType': 'HASH'},
                {'AttributeName': 'childId', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'iepId', 'AttributeType': 'S'},
                {'AttributeName': 'childId', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)

        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('BUCKET', BUCKET)

        module = load_lambda_module('metadata-handler/ddb-service', 'ddb_service',
                                    module_name='handler')
        try:
            yield SimpleNamespace(
                module=module, documents=documents, s3=s3,
                profiles=dynamodb.Table(PROFILES_TABLE))
        finally:
            unload('ddb_service')
            unload('s3_content_handler')  # sibling import caches BUCKET at import


def op(service, operation, **params):
    response = service.module.lambda_handler(
        {'operation': operation, 'params': params}, None)
    return response['statusCode'], json.loads(response['body'])


def item(service):
    return service.documents.get_item(Key=KEY).get('Item')


def s3_keys(service, prefix=''):
    listing = service.s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
    return {obj['Key'] for obj in listing.get('Contents', [])}


def seed_document(service, **extra):
    service.documents.put_item(Item={**KEY, 'userId': USER, 'status': 'PROCESSING', **extra})


def test_unknown_operation_is_a_500(service):
    status, body = op(service, 'drop_all_tables')
    assert status == 500
    assert 'Unknown operation' in body['error']


def test_update_progress_writes_status_and_step(service):
    seed_document(service)
    status, _ = op(service, 'update_progress', **IDS,
                   status='PROCESSING_TRANSLATIONS', current_step='translating',
                   progress=60, error_message='retryable blip')
    assert status == 200

    doc = item(service)
    assert doc['status'] == 'PROCESSING_TRANSLATIONS'
    assert doc['current_step'] == 'translating'
    assert doc['progress'] == 60
    assert doc['error_message'] == 'retryable blip'
    assert 'updated_at' in doc


def test_get_document(service):
    assert op(service, 'get_document', **IDS)[0] == 404
    seed_document(service, progress=40)
    status, body = op(service, 'get_document', **IDS)
    assert status == 200
    assert body['status'] == 'PROCESSING'


def test_ocr_payloads_live_in_s3_not_dynamodb(service):
    seed_document(service, ocr_result='legacy inline blob')
    status, body = op(service, 'save_ocr_data', **IDS,
                      ocr_data={'pages': ['page one text']})
    assert status == 200

    doc = item(service)
    assert 'ocr_result' not in doc  # legacy inline attribute removed
    ref = doc['ocr_result_s3_ref']
    assert ref['s3Key'] == f'iep-data/{IEP}/{CHILD}/ocr_result.json'

    stored = json.loads(service.s3.get_object(
        Bucket=ref['bucket'], Key=ref['s3Key'])['Body'].read())
    assert stored == {'pages': ['page one text']}

    status, body = op(service, 'get_ocr_data', **IDS)
    assert status == 200
    assert body['data'] == {'pages': ['page one text']}


def test_ocr_data_type_is_allowlisted(service):
    seed_document(service)
    status, body = op(service, 'save_ocr_data', **IDS,
                      ocr_data={}, data_type='status = :s REMOVE userId')
    assert status == 500
    assert 'Invalid OCR data_type' in body['error']


def test_get_ocr_data_legacy_inline_and_missing(service):
    seed_document(service, ocr_result='legacy inline blob')
    status, body = op(service, 'get_ocr_data', **IDS)
    assert (status, body['data']) == (200, 'legacy inline blob')

    status, body = op(service, 'get_ocr_data', **IDS, data_type='redacted_ocr_result')
    assert status == 404


def test_delete_ocr_data_purges_object_and_attributes(service):
    seed_document(service)
    op(service, 'save_ocr_data', **IDS, ocr_data={'pages': ['raw text']})
    assert s3_keys(service, f'iep-data/{IEP}/')

    status, _ = op(service, 'delete_ocr_data', **IDS)
    assert status == 200
    doc = item(service)
    assert 'ocr_result_s3_ref' not in doc
    assert 'ocr_result' not in doc
    assert not s3_keys(service, f'iep-data/{IEP}/{CHILD}/ocr_result.json')


def test_record_failure_purges_unredacted_artifacts(service):
    # A failed document must keep no original upload and no raw OCR.
    service.s3.put_object(Bucket=BUCKET, Key=f'{USER}/{CHILD}/{IEP}/original.pdf', Body=b'pdf')
    seed_document(service, documentUrl=f's3://{BUCKET}/{USER}/{CHILD}/{IEP}/original.pdf')
    op(service, 'save_ocr_data', **IDS, ocr_data={'pages': ['raw']})

    status, _ = op(service, 'record_failure', **IDS,
                   error_message='OCR provider exploded', failed_step='mistral_ocr')
    assert status == 200

    doc = item(service)
    assert doc['status'] == 'FAILED'
    assert doc['failed_step'] == 'mistral_ocr'
    assert doc['error_message'] == 'OCR provider exploded'
    assert 'ocr_result_s3_ref' not in doc
    assert not s3_keys(service, f'{USER}/')          # original gone
    assert not s3_keys(service, f'iep-data/{IEP}/{CHILD}/ocr_result.json')


# ---------------------------------------------------------------------------
# Pending-upload sweep: reclaims documents whose upload never reached S3.
#
# upload-s3 writes the row with status PENDING_UPLOAD before the browser's PUT
# to S3 is confirmed. If that PUT never lands, no S3 event ever fires the
# orchestrator, and nothing in the pipeline itself moves the row again — this
# sweep (expire_stale_pending_uploads) is what actually reclaims it.

# The failure marker is the only aggregate signal that documents are failing:
# a failed document produces a SUCCESSFUL state machine execution (every Task
# catches into record_failure, which ends the machine normally), so
# ExecutionsFailed stays at zero through a total outage. MonitoringStack's
# DocumentFailureFilter counts this line and alarms on the rate, so the exact
# token matters as much as any assertion about DynamoDB.
# ---------------------------------------------------------------------------
# The failure text must never reach CloudWatch verbatim.
#
# $.error.Cause is Step Functions' Lambda envelope, and the message inside can
# quote FERPA-protected content: a pydantic ValidationError from parsing_agent
# names the section text it rejected. CLAUDE.md is explicit that document
# content never gets logged. The exception CLASS is kept because it is the most
# useful triage fact and cannot contain content.
# ---------------------------------------------------------------------------
# A realistic pydantic failure: the shape that leaks. The quoted value here
# stands in for a child's IEP section text.
LEAKY_CAUSE = json.dumps({
    'errorMessage': (
        "1 validation error for SingleLanguageIEP\n"
        "sections.2.content\n"
        "  Input should be a valid string "
        "[type=string_type, input_value='Jordan requires extended time and a "
        "read-aloud accommodation for all assessments', input_type=dict]"
    ),
    'errorType': 'ValidationError',
    'requestId': 'abc-123',
    'stackTrace': ['  File \"/var/task/handler.py\", line 1\n'],
})

QUOTED_SECTION_TEXT = 'Jordan requires extended time'


def test_the_failure_reason_is_never_logged_verbatim(service, capsys):
    seed_document(service)

    status, _ = op(service, 'record_failure', **IDS,
                   error_message=LEAKY_CAUSE, failed_step='parsing_agent')
    assert status == 200

    logged = capsys.readouterr().out
    # The whole point: the quoted IEP text must not be anywhere in the logs.
    assert QUOTED_SECTION_TEXT not in logged
    assert 'input_value' not in logged
    # But the class survives, because it is what tells an operator whether to
    # look at our schema or at a third party.
    assert 'ValidationError' in logged


def test_the_exception_class_and_size_survive_redaction(service, capsys):
    seed_document(service)

    op(service, 'record_failure', **IDS,
       error_message=LEAKY_CAUSE, failed_step='parsing_agent')

    logged = capsys.readouterr().out
    inner = json.loads(LEAKY_CAUSE)['errorMessage']
    assert f'{len(inner)} chars' in logged


def test_a_plain_sentence_reason_is_reduced_to_its_length(service, capsys):
    # The pending-upload sweep passes prose, not the Lambda envelope.
    seed_document(service, status='PENDING_UPLOAD')
    reason = 'Upload never completed: no document reached the pipeline within 15 minutes'

    op(service, 'record_failure', **IDS, error_message=reason,
       failed_step='PENDING_UPLOAD', only_if_status_in=['PENDING_UPLOAD'])

    logged = capsys.readouterr().out
    assert reason not in logged
    assert f'{len(reason)} chars' in logged


def test_the_failure_reason_is_still_kept_on_the_record(service):
    # Redaction is about CloudWatch, not about losing the reason. The row is
    # inside the CMK-encrypted FERPA store and is returned to no caller, so it
    # stays the diagnostic record of last resort.
    seed_document(service)

    op(service, 'record_failure', **IDS,
       error_message=LEAKY_CAUSE, failed_step='parsing_agent')

    assert item(service)['error_message'] == LEAKY_CAUSE


def test_record_failure_logs_the_marker_the_alarm_counts(service, capsys):
    seed_document(service)

    status, _ = op(service, 'record_failure', **IDS,
                   error_message='OCR provider exploded', failed_step='mistral_ocr')
    assert status == 200

    logged = capsys.readouterr().out
    # RECORD_FAILURE is the literal filter pattern in
    # lib/chatbot-api/monitoring/monitoring.ts; renaming one without the other
    # silently stops the alarm counting.
    marker = [line for line in logged.splitlines() if 'RECORD_FAILURE' in line]
    assert len(marker) == 1, logged
    assert f'iep={IEP}' in marker[0]
    assert 'step=mistral_ocr' in marker[0]
    # Scoped to the marker line on purpose. The exception text from a failing
    # step can quote document content (a pydantic validation error naming the
    # value it rejected, for one), so the marker carries ids and the step only.
    # The handler's own event dump DOES still log error_message: that is
    # pre-existing, tracked separately, and not something this line adds to.
    assert 'OCR provider exploded' not in marker[0]


def test_record_failure_logs_no_marker_when_there_was_nothing_to_fail(service, capsys):
    # The document moved on (or was deleted), so no failure is recorded and the
    # alarm must not count one: otherwise the sweep's guarded no-ops would look
    # like an outage.
    seed_document(service, status='PROCESSED')

    status, body = op(service, 'record_failure', **IDS,
                      error_message='too late', failed_step='PENDING_UPLOAD',
                      only_if_status_in=['PENDING_UPLOAD'])
    assert status == 200

    assert 'RECORD_FAILURE' not in capsys.readouterr().out


def test_record_failure_guard_skips_a_row_that_already_moved_on(service):
    seed_document(service, status='PROCESSING')  # pipeline already claimed it
    status, body = op(service, 'record_failure', **IDS,
                      error_message='stale sweep pass', failed_step='PENDING_UPLOAD',
                      only_if_status_in=['PENDING_UPLOAD'])
    assert status == 200
    assert body['documentDeleted'] is True  # guard tripped: no failure recorded
    assert item(service)['status'] == 'PROCESSING'  # untouched


def test_record_failure_guard_allows_a_matching_status(service):
    seed_document(service, status='PENDING_UPLOAD')
    status, _ = op(service, 'record_failure', **IDS,
                   error_message='upload never completed', failed_step='PENDING_UPLOAD',
                   only_if_status_in=['PENDING_UPLOAD'])
    assert status == 200
    assert item(service)['status'] == 'FAILED'


def test_record_failure_guard_allows_a_missing_status(service):
    service.documents.put_item(Item={**KEY, 'userId': USER, 'createdAt': 1000})
    status, _ = op(service, 'record_failure', **IDS,
                   error_message='upload never completed', failed_step='PENDING_UPLOAD',
                   only_if_status_in=['PENDING_UPLOAD'])
    assert status == 200
    assert item(service)['status'] == 'FAILED'


def test_expire_stale_pending_uploads_fails_closed_past_the_timeout(service):
    now = 1_000_000
    stale_created_at = now - 16 * 60  # 16 minutes ago, past the 15m timeout
    service.s3.put_object(Bucket=BUCKET, Key=f'{USER}/{CHILD}/{IEP}/original.pdf', Body=b'pdf')
    seed_document(service, status='PENDING_UPLOAD', createdAt=stale_created_at,
                 documentUrl=f's3://{BUCKET}/{USER}/{CHILD}/{IEP}/original.pdf')

    status, body = op(service, 'expire_stale_pending_uploads', now_epoch_seconds=now)
    assert status == 200
    assert body['expired'] == [IEP]

    doc = item(service)
    assert doc['status'] == 'FAILED'
    assert doc['failed_step'] == 'PENDING_UPLOAD'
    assert not s3_keys(service, f'{USER}/')  # the abandoned original is purged too


def test_expire_stale_pending_uploads_ignores_uploads_still_within_the_window(service):
    now = 1_000_000
    seed_document(service, status='PENDING_UPLOAD', createdAt=now - 60)  # 1 minute ago

    status, body = op(service, 'expire_stale_pending_uploads', now_epoch_seconds=now)
    assert status == 200
    assert body['expired'] == []
    assert item(service)['status'] == 'PENDING_UPLOAD'


def test_expire_stale_pending_uploads_ignores_documents_already_in_flight(service):
    now = 1_000_000
    # Old but legitimately running: must never be reclassified as a dead upload.
    seed_document(service, status='PROCESSING', createdAt=now - 3600)

    status, body = op(service, 'expire_stale_pending_uploads', now_epoch_seconds=now)
    assert status == 200
    assert body['expired'] == []
    assert item(service)['status'] == 'PROCESSING'


def test_expire_stale_pending_uploads_catches_legacy_rows_with_no_status(service):
    now = 1_000_000
    service.documents.put_item(Item={**KEY, 'userId': USER, 'createdAt': now - 3600})

    status, body = op(service, 'expire_stale_pending_uploads', now_epoch_seconds=now)
    assert status == 200
    assert body['expired'] == [IEP]
    assert item(service)['status'] == 'FAILED'


def test_expire_stale_pending_uploads_one_bad_row_does_not_block_the_rest(service, monkeypatch):
    """Mutation-check: a per-row failure must not abort the whole sweep."""
    now = 1_000_000
    seed_document(service, status='PENDING_UPLOAD', createdAt=now - 3600)
    other_key = {'iepId': 'iep-2', 'childId': 'child-2'}
    service.documents.put_item(Item={**other_key, 'userId': USER, 'status': 'PENDING_UPLOAD',
                                     'createdAt': now - 3600})

    real_record_failure = service.module.record_failure

    def flaky(params):
        if params['iep_id'] == 'iep-2':
            raise RuntimeError('boom')
        return real_record_failure(params)

    monkeypatch.setattr(service.module, 'record_failure', flaky)

    status, body = op(service, 'expire_stale_pending_uploads', now_epoch_seconds=now)
    assert status == 200
    assert body['expired'] == [IEP]           # the healthy row still got fixed
    assert body['errored'] == ['iep-2']        # the broken one is reported, not swallowed
    assert item(service)['status'] == 'FAILED'


def test_save_content_merges_languages_without_clobbering(service):
    seed_document(service, summaries={'en': 'Inline legacy summary'})

    status, _ = op(service, 'save_content_to_s3', iep_id=IEP, child_id=CHILD,
                   content={'summaries': {'en': 'English summary'},
                            'document_index': {'en': 'Table of contents'}})
    assert status == 200
    doc = item(service)
    assert 'summaries' not in doc  # inline content replaced by the S3 ref
    ref = doc['contentS3Reference']

    # Second save (e.g. the translation step) merges instead of replacing:
    # new language keys land, empty dicts never clobber existing content.
    status, _ = op(service, 'save_content_to_s3', iep_id=IEP, child_id=CHILD,
                   content={'summaries': {'es': 'Resumen'}, 'document_index': {}})
    assert status == 200

    content = json.loads(service.s3.get_object(
        Bucket=ref['bucket'], Key=ref['s3Key'])['Body'].read())
    assert content['summaries'] == {'en': 'English summary', 'es': 'Resumen'}
    assert content['document_index'] == {'en': 'Table of contents'}


def test_get_document_with_content_merges_s3_content(service):
    seed_document(service)
    op(service, 'save_content_to_s3', iep_id=IEP, child_id=CHILD,
       content={'summaries': {'en': 'English summary'}})

    status, body = op(service, 'get_document_with_content', **IDS)
    assert status == 200
    assert body['summaries'] == {'en': 'English summary'}
    assert body['status'] == 'PROCESSING'
    assert 'contentS3Reference' not in body  # internal detail stays internal


def test_get_document_with_content_lazily_migrates_legacy_items(service):
    seed_document(service, summaries={'en': 'Legacy summary'},
                  sections={'en': [{'title': 'Goals', 'content': 'G'}]})

    status, body = op(service, 'get_document_with_content', **IDS)
    assert status == 200
    assert body['summaries'] == {'en': 'Legacy summary'}

    doc = item(service)
    assert 'contentS3Reference' in doc  # migrated
    assert 'summaries' not in doc
    migrated = json.loads(service.s3.get_object(
        Bucket=doc['contentS3Reference']['bucket'],
        Key=doc['contentS3Reference']['s3Key'])['Body'].read())
    assert migrated['summaries'] == {'en': 'Legacy summary'}


def test_get_document_with_content_survives_missing_s3_object(service):
    seed_document(service, contentS3Reference={'bucket': BUCKET, 's3Key': 'iep-data/ghost.json'})
    status, body = op(service, 'get_document_with_content', **IDS)
    assert status == 200
    assert body['status'] == 'PROCESSING'  # metadata still served


def test_sanitize_event_redacts_content_params(service):
    safe = service.module.sanitize_event_for_logging({
        'operation': 'save_ocr_data',
        'params': {'iep_id': IEP, 'ocr_data': 'full FERPA-protected text',
                   'content': {'summaries': {}}, 'data_type': 'ocr_result'},
    })
    assert safe['params']['ocr_data'] == '[REDACTED]'
    assert safe['params']['content'] == '[REDACTED]'
    assert safe['params']['iep_id'] == IEP
    assert safe['params']['data_type'] == 'ocr_result'


# ---------------------------------------------------------------------------
# A deleted document must never be resurrected
#
# update_item is an upsert, so every write here used to recreate a row that had
# already been deleted. One active IEP per child means an upload replaces (and
# deletes) the previous document, so re-uploading while a run is still in
# flight hits this directly. The resurrected row carries only that one write's
# attributes: no userId, which makes it invisible to the byUserId GSI and
# therefore immune to account deletion forever. Production holds exactly one,
# iep-1779204464686-sphdqh6kagq, whose attribute set is precisely what
# record_failure writes.

def call(service, operation, **params):
    return service.module.lambda_handler(
        {'operation': operation, 'params': {**IDS, **params}}, None)


def test_update_progress_refuses_to_recreate_a_deleted_document(service):
    response = call(service, 'update_progress', status='PROCESSING',
                    current_step='ocr_complete', progress=15)
    assert response['statusCode'] == 500  # the row never existed
    assert service.documents.get_item(Key=KEY).get('Item') is None, \
        'a deleted document was resurrected'


def test_record_failure_on_a_deleted_document_is_a_no_op_success(service):
    """The terminal state must not fail an execution over a row the user removed."""
    response = call(service, 'record_failure', error_message='boom',
                    failed_step='MistralOCR')
    assert response['statusCode'] == 200
    assert json.loads(response['body'])['documentDeleted'] is True
    assert service.documents.get_item(Key=KEY).get('Item') is None, \
        'record_failure resurrected the row it could not find'


def test_save_ocr_data_rolls_back_its_object_when_the_row_is_gone(service):
    response = call(service, 'save_ocr_data', ocr_data={'text': 'x'},
                    data_type='ocr_result')
    assert response['statusCode'] == 500
    assert service.documents.get_item(Key=KEY).get('Item') is None
    remaining = service.s3.list_objects_v2(Bucket=BUCKET, Prefix=f'iep-data/{IEP}/')
    assert remaining.get('KeyCount', 0) == 0, \
        'unredacted OCR left in the bucket with nothing pointing at it'


def test_save_content_rolls_back_its_object_when_the_row_is_gone(service):
    response = call(service, 'save_content_to_s3',
                    content={'summaries': {'en': 'S'}})
    assert response['statusCode'] == 500
    assert service.documents.get_item(Key=KEY).get('Item') is None
    remaining = service.s3.list_objects_v2(Bucket=BUCKET, Prefix=f'iep-data/{IEP}/')
    assert remaining.get('KeyCount', 0) == 0, 'orphaned summary left in the bucket'


def test_delete_ocr_data_does_not_recreate_a_deleted_document(service):
    """A REMOVE-only update creates the item too, if it is absent."""
    response = call(service, 'delete_ocr_data', data_type='ocr_result')
    assert response['statusCode'] == 500
    assert service.documents.get_item(Key=KEY).get('Item') is None


def test_the_guard_does_not_break_the_normal_path(service):
    """Mutation-safety: the condition must only reject ABSENT rows."""
    service.documents.put_item(Item={**KEY, 'userId': USER, 'status': 'PROCESSING'})
    assert call(service, 'update_progress', status='PROCESSING',
                current_step='ocr_complete', progress=15)['statusCode'] == 200
    assert call(service, 'save_ocr_data', ocr_data={'text': 'x'},
                data_type='redacted_ocr_result')['statusCode'] == 200
    assert call(service, 'save_content_to_s3',
                content={'summaries': {'en': 'S'}})['statusCode'] == 200
    item = service.documents.get_item(Key=KEY)['Item']
    assert item['userId'] == USER, 'the guard must not disturb existing attributes'
    assert 'contentS3Reference' in item
