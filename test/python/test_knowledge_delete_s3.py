"""knowledge-management delete-s3 tests: a user may delete only their own
uploads. Keys are laid out as {userId}/{childId}/{iepId}/{filename}, and the
handler must reject foreign prefixes and path traversal.
"""
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

BUCKET = 'kb-bucket-test'
USER = 'user-sub-1'


@pytest.fixture()
def delete_s3(monkeypatch):
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        monkeypatch.setenv('BUCKET', BUCKET)
        module = load_lambda_module('knowledge-management/delete-s3', 'kb_delete_lambda')
        try:
            yield SimpleNamespace(module=module, s3=s3)
        finally:
            unload('kb_delete_lambda')


def call(delete_s3, key=None, authed=True, raw_body=None):
    event = {'body': raw_body if raw_body is not None else json.dumps({'KEY': key})}
    if authed:
        event['requestContext'] = {'authorizer': {'jwt': {'claims': {'sub': USER}}}}
    response = delete_s3.module.lambda_handler(event, None)
    return response['statusCode'], json.loads(response['body'])


def test_deletes_own_object(delete_s3):
    key = f'{USER}/child-1/iep-1/report.pdf'
    delete_s3.s3.put_object(Bucket=BUCKET, Key=key, Body=b'pdf')

    status, body = call(delete_s3, key=key)
    assert status == 200
    assert body['key'] == key
    assert 'Contents' not in delete_s3.s3.list_objects_v2(Bucket=BUCKET, Prefix=key)


def test_rejects_other_users_keys_and_traversal(delete_s3):
    foreign = 'other-user/child-1/iep-1/report.pdf'
    delete_s3.s3.put_object(Bucket=BUCKET, Key=foreign, Body=b'pdf')

    assert call(delete_s3, key=foreign)[0] == 403
    assert call(delete_s3, key=f'{USER}/../other-user/report.pdf')[0] == 403
    # The foreign object is untouched
    assert delete_s3.s3.list_objects_v2(Bucket=BUCKET, Prefix=foreign)['KeyCount'] == 1


def test_validation_and_auth(delete_s3):
    assert call(delete_s3, key='x', authed=False)[0] == 401
    assert call(delete_s3, key=None)[0] == 400            # KEY missing
    assert call(delete_s3, raw_body='not json')[0] == 400
