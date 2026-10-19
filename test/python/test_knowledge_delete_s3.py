"""knowledge-management delete-s3 tests: a user may delete only their own
uploads. Keys are laid out as {userId}/{childId}/{iepId}/{filename}, and the
handler must reject foreign prefixes and path traversal.

It must also delete the whole document, not one object. Deleting the raw
upload alone left the document row pointing at a missing file, plus the
summary, the redacted OCR text and every cached mp3 in the bucket. The two
other delete paths (user-profile-handler and upload-s3/utils) already strip
all of it, so the assertions here mirror theirs.
"""
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import create_versioned_bucket, load_lambda_module, retrievable_versions, unload

BUCKET = 'kb-bucket-test'
DOCUMENTS_TABLE = 'documents-test'
USER = 'user-sub-1'


@pytest.fixture()
def delete_s3(monkeypatch):
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        create_versioned_bucket(s3, BUCKET)
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
        monkeypatch.setenv('BUCKET', BUCKET)
        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        module = load_lambda_module('knowledge-management/delete-s3', 'kb_delete_lambda')
        try:
            yield SimpleNamespace(module=module, s3=s3, documents=documents)
        finally:
            unload('kb_delete_lambda')


def call(delete_s3, key=None, authed=True, raw_body=None):
    event = {'body': raw_body if raw_body is not None else json.dumps({'KEY': key})}
    if authed:
        event['requestContext'] = {'authorizer': {'jwt': {'claims': {'sub': USER}}}}
    response = delete_s3.module.lambda_handler(event, None)
    return response['statusCode'], json.loads(response['body'])


def seed_document(delete_s3, iep_id='iep-1', child_id='child-1', user=USER):
    """One document as the pipeline leaves it: raw upload, row, summary,
    redacted OCR text and two cached mp3s."""
    raw_key = f'{user}/{child_id}/{iep_id}/report.pdf'
    content_key = f'iep-data/{iep_id}/{child_id}/content.json'
    derived = [
        content_key,
        f'iep-data/{iep_id}/{child_id}/redacted_ocr_result.json',
        f'iep-audio/{iep_id}/{child_id}/en/summary-deadbeef.mp3',
        f'iep-audio/{iep_id}/{child_id}/es/summary-deadbeef.mp3',
    ]
    delete_s3.s3.put_object(Bucket=BUCKET, Key=raw_key, Body=b'pdf')
    for key in derived:
        delete_s3.s3.put_object(Bucket=BUCKET, Key=key, Body=b'{}')
    delete_s3.documents.put_item(Item={
        'iepId': iep_id, 'childId': child_id, 'userId': user,
        'status': 'PROCESSED',
        'contentS3Reference': {'bucket': BUCKET, 's3Key': content_key},
    })
    return SimpleNamespace(raw_key=raw_key, derived=derived,
                           iep_id=iep_id, child_id=child_id)


def key_exists(delete_s3, key):
    return delete_s3.s3.list_objects_v2(Bucket=BUCKET, Prefix=key).get('KeyCount', 0) == 1


def row_exists(delete_s3, iep_id='iep-1', child_id='child-1'):
    return delete_s3.documents.get_item(
        Key={'iepId': iep_id, 'childId': child_id}).get('Item') is not None


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

    # Not-owned is 404, the same answer as a key that does not exist.
    assert call(delete_s3, key=foreign)[0] == 404
    assert call(delete_s3, key=f'{USER}/../other-user/report.pdf')[0] == 404
    # The foreign object is untouched
    assert delete_s3.s3.list_objects_v2(Bucket=BUCKET, Prefix=foreign)['KeyCount'] == 1


def test_validation_and_auth(delete_s3):
    assert call(delete_s3, key='x', authed=False)[0] == 401
    assert call(delete_s3, key=None)[0] == 400            # KEY missing
    assert call(delete_s3, raw_body='not json')[0] == 400


def test_every_rejection_says_why_in_the_log(delete_s3, capsys):
    """A 4xx with no log line is undiagnosable; an unlogged validation
    rejection has already made one real failure impossible to diagnose."""
    call(delete_s3, raw_body='not json')
    call(delete_s3, key=None)
    call(delete_s3, key='x', authed=False)

    logged = capsys.readouterr().out
    assert 'body is not valid JSON' in logged
    assert 'KEY missing or not a string' in logged
    assert 'no JWT sub claim' in logged


def test_deletes_the_row_and_every_derived_artifact(delete_s3):
    """The whole document, not one object.

    Fails before the fix: the handler deleted the raw upload and returned 200
    with the row, the summary, the redacted OCR and both mp3s still there.
    """
    doc = seed_document(delete_s3)

    status, body = call(delete_s3, key=doc.raw_key)
    assert status == 200
    assert body['documentDeleted'] is True

    assert key_exists(delete_s3, doc.raw_key) is False, 'raw upload survived'
    for key in doc.derived:
        assert key_exists(delete_s3, key) is False, f'FERPA content left behind: {key}'
    assert row_exists(delete_s3) is False, 'row left pointing at a missing object'
    # 1 raw + contentS3Reference + 1 more under iep-data + 2 mp3s
    assert body['objectsDeleted'] == 5


def test_a_partial_failure_is_not_reported_as_success(delete_s3, monkeypatch, capsys):
    """Fails before the fix: any purge error still returned 200 'Deleted'."""
    doc = seed_document(delete_s3)

    def boom(s3, bucket, prefix):
        raise RuntimeError('S3 unavailable')

    monkeypatch.setattr(delete_s3.module, '_delete_prefix', boom)

    status, body = call(delete_s3, key=doc.raw_key)
    assert status == 503
    assert 'S3 unavailable' not in json.dumps(body), 'internals leaked to the caller'

    marker = [line for line in capsys.readouterr().out.splitlines()
              if line.startswith('DELETION_INCOMPLETE')]
    assert marker, 'nothing for an alarm to count'
    assert 'scope=document' in marker[0] and 'essential=yes' in marker[0]
    assert 'survived=derived-artifacts,document-row' in marker[0]
    assert 'iep=iep-1' in marker[0]
    # Ids and kinds only: no key names, no bucket, no exception text.
    assert 'report.pdf' not in marker[0] and 'S3 unavailable' not in marker[0]

    # The row is the only pointer to what survived, so it must outlive it.
    assert row_exists(delete_s3) is True


def test_retry_after_a_partial_failure_converges(delete_s3, monkeypatch):
    doc = seed_document(delete_s3)
    real_delete_prefix = delete_s3.module._delete_prefix
    monkeypatch.setattr(delete_s3.module, '_delete_prefix',
                        lambda *args: (_ for _ in ()).throw(RuntimeError('S3 unavailable')))
    assert call(delete_s3, key=doc.raw_key)[0] == 503

    # Second attempt, S3 healthy again. The raw upload is already gone, so
    # this also pins that a deleted object is not an error on the way back.
    monkeypatch.setattr(delete_s3.module, '_delete_prefix', real_delete_prefix)
    status, body = call(delete_s3, key=doc.raw_key)

    assert status == 200
    for key in doc.derived:
        assert key_exists(delete_s3, key) is False, f'retry left {key} behind'
    assert row_exists(delete_s3) is False


def test_refuses_a_key_naming_another_familys_document(delete_s3):
    """The prefix proves who owns the KEY, not who owns the iepId in it.

    childId and iepId are caller-supplied, and the derived sweeps are keyed on
    them alone, so a key with this user's own prefix could otherwise purge
    another family's summary and row.
    """
    victim = seed_document(delete_s3, iep_id='iep-victim', child_id='child-9',
                           user='other-user')

    status, _ = call(delete_s3, key=f'{USER}/child-9/iep-victim/report.pdf')
    assert status == 404

    for key in victim.derived:
        assert key_exists(delete_s3, key) is True, f"another family's {key} was deleted"
    assert row_exists(delete_s3, iep_id='iep-victim', child_id='child-9') is True


def test_fails_closed_when_the_documents_table_is_not_configured(delete_s3, monkeypatch, capsys):
    """Without the table this route can only half-delete, which is the bug."""
    doc = seed_document(delete_s3)
    monkeypatch.delenv('IEP_DOCUMENTS_TABLE')

    assert call(delete_s3, key=doc.raw_key)[0] == 500
    assert key_exists(delete_s3, doc.raw_key) is True, 'deleted anyway, then reported failure'
    assert 'DELETION_INCOMPLETE' in capsys.readouterr().out


# A parent's filename is student data: families name the file after the
# child. Every log line here must carry the ids and never the filename.
NAMED_FILE = 'Sofia Ejemplo IEP 2025.pdf'


def test_deleting_a_document_never_logs_its_filename(delete_s3, capsys):
    key = f'{USER}/child-1/iep-1/{NAMED_FILE}'
    delete_s3.s3.put_object(Bucket=BUCKET, Key=key, Body=b'pdf')

    status, _ = call(delete_s3, key=key)

    out = capsys.readouterr().out
    assert status == 200
    assert 'Sofia' not in out
    assert f'{USER}/child-1/iep-1/...' in out


def test_a_refused_key_is_logged_without_its_filename(delete_s3, capsys):
    status, _ = call(delete_s3, key=f'someone-else/child-1/iep-1/{NAMED_FILE}')

    out = capsys.readouterr().out
    assert status == 404
    assert 'Sofia' not in out
    assert 'someone-else/child-1/iep-1/...' in out


# A parent who deletes a document is owed a deletion, not a delete marker
# over bytes that stay retrievable by version id for another 1 to 3 days.
def test_deleting_a_document_leaves_no_retrievable_version(delete_s3):
    doc = seed_document(delete_s3)

    assert call(delete_s3, key=doc.raw_key)[0] == 200

    assert retrievable_versions(delete_s3.s3, BUCKET) == set()


@pytest.mark.parametrize('raw_body', ['[1, 2]', '"report.pdf"', 'null', '42'])
def test_a_body_that_is_not_an_object_is_a_400_with_the_reason_logged(delete_s3, raw_body, capsys):
    status, _ = call(delete_s3, raw_body=raw_body)

    assert status == 400
    assert 'body is not a JSON object' in capsys.readouterr().out


def test_every_response_says_no_store(delete_s3):
    doc = seed_document(delete_s3)
    response = delete_s3.module.lambda_handler(
        {'body': json.dumps({'KEY': doc.raw_key}),
         'requestContext': {'authorizer': {'jwt': {'claims': {'sub': USER}}}}}, None)
    assert response['headers']['Cache-Control'] == 'no-store'

    refusal = delete_s3.module.lambda_handler({'body': 'not json'}, None)
    assert refusal['headers']['Cache-Control'] == 'no-store'


def test_a_missing_bucket_setting_fails_closed_with_the_marker(delete_s3, monkeypatch, capsys):
    doc = seed_document(delete_s3)
    monkeypatch.delenv('BUCKET')

    status, body = call(delete_s3, key=doc.raw_key)

    assert status == 500
    assert body['message'] == 'Could not delete the document. Please try again later.'
    assert 'DELETION_INCOMPLETE' in capsys.readouterr().out
    assert key_exists(delete_s3, doc.raw_key) is True, 'deleted anyway, then reported failure'


def test_a_documents_table_read_fault_is_a_generic_503(delete_s3, monkeypatch, capsys):
    """A DynamoDB fault is the service's, not the caller's: never a 404 or 403
    that would read as a claim about the document."""
    doc = seed_document(delete_s3)

    class ThrottledTable:
        def get_item(self, **_kwargs):
            raise RuntimeError(f'ProvisionedThroughputExceeded on {DOCUMENTS_TABLE}')

    class ThrottledResource:
        def Table(self, _name):
            return ThrottledTable()

    monkeypatch.setattr(delete_s3.module, 'dynamodb', ThrottledResource())

    status, body = call(delete_s3, key=doc.raw_key)

    assert status == 503
    assert DOCUMENTS_TABLE not in json.dumps(body)
    assert 'Throughput' not in json.dumps(body)
    assert key_exists(delete_s3, doc.raw_key) is True
    assert 'DELETION_INCOMPLETE' in capsys.readouterr().out


class FakeS3:
    """Records delete_objects calls; the listing is a single page of entries."""

    def __init__(self, entries, errors=None):
        self.entries = entries
        self.errors = errors or []
        self.batches = []

    def get_paginator(self, _name):
        entries = self.entries

        class Paginator:
            def paginate(self, **_kwargs):
                return [{'Versions': [e for e in entries if not e.get('IsDeleteMarker')],
                         'DeleteMarkers': [e for e in entries if e.get('IsDeleteMarker')]}]
        return Paginator()

    def delete_objects(self, Bucket, Delete):
        self.batches.append(list(Delete['Objects']))
        return {'Errors': self.errors} if self.errors else {}


def test_every_version_and_marker_goes_out_in_batches_of_at_most_1000(delete_s3):
    """Batching must not drop an entry: 2001 entries become 1000 + 1000 + 1."""
    prefix = f'{USER}/child-1/iep-1/'
    entries = [{'Key': f'{prefix}f{i}.pdf', 'VersionId': f'v{i}', 'IsLatest': False}
               for i in range(2001)]
    fake = FakeS3(entries)

    delete_s3.module._delete_every_version(fake, BUCKET, prefix)

    assert [len(batch) for batch in fake.batches] == [1000, 1000, 1]
    sent = {o['VersionId'] for batch in fake.batches for o in batch}
    assert sent == {e['VersionId'] for e in entries}


def test_a_version_the_store_refuses_is_raised_not_counted(delete_s3):
    """DeleteObjects reports per-key failures in a 200 body. Treating that as
    success would drop the row that points at the surviving bytes."""
    entries = [{'Key': 'iep-data/iep-1/child-1/content.json', 'VersionId': 'v1', 'IsLatest': True}]
    fake = FakeS3(entries, errors=[{'Key': 'iep-data/iep-1/child-1/content.json',
                                    'VersionId': 'v1', 'Code': 'AccessDenied'}])

    with pytest.raises(RuntimeError) as raised:
        delete_s3.module._delete_every_version(fake, BUCKET, 'iep-data/iep-1/child-1/')

    message = str(raised.value)
    assert 'AccessDenied' in message
    assert 'content.json' not in message
