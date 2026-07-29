"""delete_original step tests: the data-retention step.

Once redaction succeeds this step must purge BOTH unredacted artifacts: the
uploaded document in S3 and the raw OCR payload. The raw-OCR purge runs
through the real ddb-service module (FakeLambdaClient is just the transport),
so this suite is also the contract test between the step and the service:
renaming the operation, changing its params, or changing the response shape
fails here instead of silently retaining FERPA-protected data in production.
"""
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import FakeLambdaClient, ScopedBoto3, load_lambda_module, unload

DOCUMENTS_TABLE = 'documents-test'
PROFILES_TABLE = 'profiles-test'
METADATA_BUCKET = 'metadata-bucket-test'
UPLOADS_BUCKET = 'iep-uploads-test'
IEP, CHILD, USER = 'iep-1', 'child-1', 'user-sub-1'
KEY = {'iepId': IEP, 'childId': CHILD}
UPLOAD_KEY = f'{USER}/{CHILD}/{IEP}/report.pdf'
RAW_OCR_KEY = f'iep-data/{IEP}/{CHILD}/ocr_result.json'
REDACTED_OCR_KEY = f'iep-data/{IEP}/{CHILD}/redacted_ocr_result.json'
DDB_SERVICE = 'DDBServiceTest'


@pytest.fixture()
def step(monkeypatch):
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
        s3.create_bucket(Bucket=METADATA_BUCKET)
        s3.create_bucket(Bucket=UPLOADS_BUCKET)

        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('BUCKET', METADATA_BUCKET)

        ddb_service = load_lambda_module('metadata-handler/ddb-service',
                                         'ddb_service_for_delete', module_name='handler')
        module = load_lambda_module('metadata-handler/steps/delete_original',
                                    'delete_original_handler', module_name='handler')
        fake_lambda = FakeLambdaClient(
            lambda payload: ddb_service.lambda_handler(payload, None))
        monkeypatch.setattr(module, 'boto3', ScopedBoto3(fake_lambda))
        try:
            yield SimpleNamespace(module=module, documents=documents, s3=s3,
                                  fake_lambda=fake_lambda)
        finally:
            unload('delete_original_handler')
            unload('ddb_service_for_delete')
            unload('s3_content_handler')  # sibling import caches BUCKET at import


def seed(step, with_upload=True):
    """A document mid-pipeline: original PDF, raw OCR (S3 ref + legacy inline
    attribute), and the redacted OCR that must survive."""
    step.s3.put_object(Bucket=METADATA_BUCKET, Key=RAW_OCR_KEY,
                       Body=json.dumps({'pages': [{'markdown': 'raw UNREDACTED text'}]}))
    step.s3.put_object(Bucket=METADATA_BUCKET, Key=REDACTED_OCR_KEY,
                       Body=json.dumps({'pages': [{'markdown': 'redacted text'}]}))
    if with_upload:
        step.s3.put_object(Bucket=UPLOADS_BUCKET, Key=UPLOAD_KEY, Body=b'%PDF-1.4 original')
    step.documents.put_item(Item={
        **KEY, 'userId': USER, 'status': 'PROCESSING',
        'documentUrl': f's3://{UPLOADS_BUCKET}/{UPLOAD_KEY}',
        'ocr_result': 'legacy inline raw OCR',
        'ocr_result_s3_ref': {'bucket': METADATA_BUCKET, 's3Key': RAW_OCR_KEY},
        'redacted_ocr_result_s3_ref': {'bucket': METADATA_BUCKET, 's3Key': REDACTED_OCR_KEY},
    })


def event(**extra):
    return {'iep_id': IEP, 'user_id': USER, 'child_id': CHILD,
            's3_bucket': UPLOADS_BUCKET, 's3_key': UPLOAD_KEY,
            'ddb_service_arn': DDB_SERVICE, **extra}


def bucket_keys(step, bucket):
    listing = step.s3.list_objects_v2(Bucket=bucket)
    return {obj['Key'] for obj in listing.get('Contents', [])}


def test_purges_the_original_pdf_and_the_raw_ocr_only(step):
    seed(step)
    result = step.module.lambda_handler(event(progress=22), None)

    assert bucket_keys(step, UPLOADS_BUCKET) == set()
    assert bucket_keys(step, METADATA_BUCKET) == {REDACTED_OCR_KEY}

    item = step.documents.get_item(Key=KEY)['Item']
    assert 'ocr_result' not in item           # legacy inline copy purged too
    assert 'ocr_result_s3_ref' not in item
    assert item['redacted_ocr_result_s3_ref']['s3Key'] == REDACTED_OCR_KEY

    assert result == event(progress=22)       # passthrough unchanged


def test_raw_ocr_purge_payload_matches_the_ddb_service_contract(step):
    seed(step)
    step.module.lambda_handler(event(), None)

    (function_name, payload), = step.fake_lambda.invocations
    assert function_name == DDB_SERVICE
    assert payload == {
        'operation': 'delete_ocr_data',
        'params': {'iep_id': IEP, 'user_id': USER, 'child_id': CHILD,
                   'data_type': 'ocr_result'},
    }


def test_already_deleted_original_still_purges_the_raw_ocr(step):
    # A Step Functions retry lands here: the PDF may already be gone, but the
    # retry must still purge the raw OCR rather than short-circuit or raise.
    seed(step, with_upload=False)
    step.module.lambda_handler(event(), None)
    assert bucket_keys(step, METADATA_BUCKET) == {REDACTED_OCR_KEY}


@pytest.mark.parametrize('drifted_response', [
    {'statusCode': 500, 'body': json.dumps({'error': 'Unknown operation: delete_ocr_data'})},
    {'body': json.dumps({'message': 'ok'})},  # shape drift: no statusCode
    None,                                     # service returned nothing
])
def test_ddb_service_drift_fails_the_step_loudly(step, drifted_response):
    # If the ddb-service stops honoring this call, the step must raise so
    # Step Functions retries and records the failure. Swallowing it would
    # retain raw unredacted OCR forever while the document reports success.
    seed(step)
    step.fake_lambda.handler = lambda payload: drifted_response
    with pytest.raises(Exception):
        step.module.lambda_handler(event(), None)


def test_service_name_falls_back_to_the_env_var(step, monkeypatch):
    seed(step)
    monkeypatch.setenv('DDB_SERVICE_FUNCTION_NAME', 'DDBServiceFromEnv')
    stripped = event()
    del stripped['ddb_service_arn']
    step.module.lambda_handler(stripped, None)

    (function_name, _), = step.fake_lambda.invocations
    assert function_name == 'DDBServiceFromEnv'


def test_missing_s3_location_raises_before_touching_anything(step):
    seed(step)
    with pytest.raises(KeyError):
        step.module.lambda_handler({'iep_id': IEP, 'child_id': CHILD}, None)
    assert bucket_keys(step, UPLOADS_BUCKET) == {UPLOAD_KEY}
    assert step.fake_lambda.invocations == []
