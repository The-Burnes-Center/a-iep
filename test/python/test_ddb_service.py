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
