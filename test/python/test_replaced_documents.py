"""Replacing a child's IEP: the previous document is deleted only after the new
one finishes processing.

The product rule: a parent who replaces an IEP keeps the old one until the new
one is ready. Before this, upload-s3 deleted the old document when the
presigned URL was requested, so a cancelled upload, a failed upload or a failed
pipeline run left the family with no IEP at all. Now the pipeline's
PurgeReplacedDocuments state calls ddb-service's purge_replaced_documents once
FinalizeResults has marked the new document PROCESSED, and nothing else deletes
a superseded document.

These tests drive the real ddb-service module against moto S3 (versioned, like
the production bucket) and DynamoDB (with the byChildId index).
"""
import json
import sys
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import create_versioned_bucket, load_lambda_module, retrievable_versions, unload

DOCUMENTS_TABLE = 'documents-test'
PROFILES_TABLE = 'profiles-test'
BUCKET = 'replace-bucket-test'
USER, OTHER_USER = 'user-sub-1', 'user-sub-2'
CHILD, OTHER_CHILD = 'child-1', 'child-2'
OLD, NEW = 'iep-old', 'iep-new'
OLD_CREATED, NEW_CREATED = 1_000, 2_000


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
                {'AttributeName': 'createdAt', 'AttributeType': 'N'},
            ],
            GlobalSecondaryIndexes=[{
                'IndexName': 'byChildId',
                'KeySchema': [
                    {'AttributeName': 'childId', 'KeyType': 'HASH'},
                    {'AttributeName': 'createdAt', 'KeyType': 'RANGE'},
                ],
                'Projection': {'ProjectionType': 'ALL'},
            }],
            BillingMode='PAY_PER_REQUEST',
        )
        dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        s3 = boto3.client('s3', region_name='us-east-1')
        create_versioned_bucket(s3, BUCKET)

        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('BUCKET', BUCKET)

        module = load_lambda_module('metadata-handler/ddb-service', 'ddb_service_replace',
                                    module_name='handler')
        try:
            yield SimpleNamespace(module=module, documents=documents, s3=s3)
        finally:
            unload('ddb_service_replace')
            unload('s3_content_handler')
            unload('replaced_documents')


def invoke(service, operation, context=None, **params):
    response = service.module.lambda_handler({'operation': operation, 'params': params}, context)
    return response['statusCode'], json.loads(response['body'])


def purge(service, iep_id=NEW, child_id=CHILD, user_id=USER, context=None):
    return invoke(service, 'purge_replaced_documents', context,
                  iep_id=iep_id, child_id=child_id, user_id=user_id)


def artifact_keys(iep_id, child_id=CHILD, user_id=USER):
    """Every S3 object a processed document owns, in all three places."""
    return {
        'raw': f'{user_id}/{child_id}/{iep_id}/plan.pdf',
        'content': f'iep-data/{iep_id}/{child_id}/content.json',
        'redacted': f'iep-data/{iep_id}/{child_id}/redacted_ocr_result.json',
        'audio': f'iep-audio/{iep_id}/{child_id}/en-summary.mp3',
    }


def seed_document(service, iep_id, created_at, status='PROCESSED',
                  user_id=USER, child_id=CHILD):
    """A document row plus its S3 artifacts, each written twice so there is a
    superseded version, and the raw upload also carries a delete marker."""
    keys = artifact_keys(iep_id, child_id, user_id)
    for name, key in keys.items():
        service.s3.put_object(Bucket=BUCKET, Key=key, Body=b'first')
        service.s3.put_object(Bucket=BUCKET, Key=key, Body=b'second')
    service.s3.delete_object(Bucket=BUCKET, Key=keys['raw'])
    service.documents.put_item(Item={
        'iepId': iep_id, 'childId': child_id, 'userId': user_id,
        'status': status, 'createdAt': created_at,
        'documentUrl': f"s3://{BUCKET}/{keys['raw']}",
        'contentS3Reference': {'bucket': BUCKET, 's3Key': keys['content']},
    })
    return keys


def row(service, iep_id, child_id=CHILD):
    return service.documents.get_item(Key={'iepId': iep_id, 'childId': child_id}).get('Item')


def surviving(service, iep_id, child_id=CHILD, user_id=USER):
    """Keys with any version or delete marker left for this document."""
    return {name for name, key in artifact_keys(iep_id, child_id, user_id).items()
            if retrievable_versions(service.s3, BUCKET, key)}


def incomplete_lines(capsys):
    return [line for line in capsys.readouterr().out.splitlines()
            if line.startswith('DELETION_INCOMPLETE')]


# ---------------------------------------------------------------------------
# New document succeeds -> the old one is gone, completely
# ---------------------------------------------------------------------------

def test_the_old_document_is_deleted_once_the_new_one_is_ready(service):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    status, body = purge(service)

    assert status == 200
    assert body['purged'] == [OLD]
    assert body['incomplete'] == []
    assert row(service, OLD) is None


def test_every_version_and_marker_of_the_old_document_is_deleted(service):
    # The bucket is versioned: a plain delete only writes a marker and leaves the
    # bytes retrievable by version id, so "not listed" is not "gone".
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    purge(service)

    assert surviving(service, OLD) == set()
    assert retrievable_versions(service.s3, BUCKET, f'{USER}/{CHILD}/{OLD}/') == set()
    assert retrievable_versions(service.s3, BUCKET, f'iep-data/{OLD}/{CHILD}/') == set()
    assert retrievable_versions(service.s3, BUCKET, f'iep-audio/{OLD}/{CHILD}/') == set()


def test_the_summary_object_the_row_points_at_is_deleted_even_off_the_legacy_prefix(service):
    seed_document(service, NEW, NEW_CREATED)
    elsewhere = f'summaries/{OLD}.json'
    service.s3.put_object(Bucket=BUCKET, Key=elsewhere, Body=b'translations live in here')
    service.documents.put_item(Item={
        'iepId': OLD, 'childId': CHILD, 'userId': USER, 'status': 'PROCESSED',
        'createdAt': OLD_CREATED,
        'contentS3Reference': {'bucket': BUCKET, 's3Key': elsewhere},
    })

    purge(service)

    assert retrievable_versions(service.s3, BUCKET, elsewhere) == set()
    assert row(service, OLD) is None


def test_the_new_document_is_never_deleted(service):
    # Mutation-checked: removing the iepId exclusion in _superseded_documents
    # makes this fail, because the replacement is then listed as one of the
    # child's documents and deleted along with the old one.
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    purge(service)

    kept = row(service, NEW)
    assert kept is not None and kept['status'] == 'PROCESSED'
    assert surviving(service, NEW) == {'raw', 'content', 'redacted', 'audio'}


def test_nothing_to_replace_is_a_clean_no_op(service):
    seed_document(service, NEW, NEW_CREATED)

    status, body = purge(service)

    assert status == 200
    assert body['purged'] == []
    assert row(service, NEW) is not None


def test_a_second_run_after_a_partial_failure_finishes_the_job(service, monkeypatch):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    replaced = sys.modules['replaced_documents']
    real = replaced.delete_every_version

    with monkeypatch.context() as broken_s3:
        _break_s3_deletes(broken_s3)
        purge(service)
    assert row(service, OLD) is not None  # the row is the retry handle

    assert replaced.delete_every_version is real
    status, body = purge(service)

    assert status == 200
    assert body['purged'] == [OLD]
    assert row(service, OLD) is None
    assert surviving(service, OLD) == set()


# ---------------------------------------------------------------------------
# New run fails, or the upload is abandoned -> the old document is untouched
# ---------------------------------------------------------------------------

def test_a_failed_run_leaves_the_old_document_untouched(service):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED, status='PROCESSING')

    status, _ = invoke(service, 'record_failure', iep_id=NEW, child_id=CHILD, user_id=USER,
                       error_message='OCR provider exploded', failed_step='MistralOCR')

    assert status == 200
    assert row(service, NEW)['status'] == 'FAILED'
    assert row(service, OLD)['status'] == 'PROCESSED'
    assert surviving(service, OLD) == {'raw', 'content', 'redacted', 'audio'}


@pytest.mark.parametrize('status', ['PROCESSING', 'PROCESSING_TRANSLATIONS', 'FAILED', 'PENDING_UPLOAD'])
def test_the_purge_refuses_a_replacement_that_is_not_finished(service, status, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED, status=status)

    code, body = purge(service)

    assert code == 500
    assert 'not finished' in body['error']
    assert 'DDB_SERVICE_ERROR operation=purge_replaced_documents' in capsys.readouterr().out
    assert row(service, OLD) is not None
    assert surviving(service, OLD) == {'raw', 'content', 'redacted', 'audio'}


def test_the_purge_refuses_a_replacement_that_does_not_exist(service):
    seed_document(service, OLD, OLD_CREATED)

    code, _ = purge(service, iep_id='iep-never-written')

    assert code == 500
    assert row(service, OLD) is not None
    assert surviving(service, OLD) == {'raw', 'content', 'redacted', 'audio'}


def test_the_purge_refuses_a_replacement_owned_by_someone_else(service):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    code, _ = purge(service, user_id=OTHER_USER)

    assert code == 500
    assert row(service, OLD) is not None
    assert row(service, NEW) is not None


def test_the_purge_requires_all_three_ids(service):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    for missing in ('iep_id', 'child_id', 'user_id'):
        params = {'iep_id': NEW, 'child_id': CHILD, 'user_id': USER}
        params[missing] = ''
        code, _ = invoke(service, 'purge_replaced_documents', **params)
        assert code == 500

    assert row(service, OLD) is not None


def test_an_abandoned_upload_does_not_delete_the_old_document(service):
    # The parent asked for a new upload URL and never sent the file. The
    # pending-upload sweep fails that row closed; the old IEP must survive.
    now = 1_000_000
    seed_document(service, OLD, now - 86_400)
    service.documents.put_item(Item={
        'iepId': NEW, 'childId': CHILD, 'userId': USER, 'status': 'PENDING_UPLOAD',
        'createdAt': now - 16 * 60, 'summaries': {},
    })

    status, body = invoke(service, 'expire_stale_pending_uploads', now_epoch_seconds=now)

    assert status == 200
    assert body['expired'] == [NEW]
    assert row(service, NEW)['status'] == 'FAILED'
    assert row(service, OLD)['status'] == 'PROCESSED'
    assert surviving(service, OLD) == {'raw', 'content', 'redacted', 'audio'}


# ---------------------------------------------------------------------------
# Cleanup trouble never un-completes the new document, and is loud
# ---------------------------------------------------------------------------

def _break_s3_deletes(patcher):
    def broken(*args, **kwargs):
        raise RuntimeError('quoting plan-for-Jordan.pdf in an error')
    patcher.setattr(sys.modules['replaced_documents'], 'delete_every_version', broken)


def test_a_failed_cleanup_leaves_the_new_document_complete(service, monkeypatch):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    _break_s3_deletes(monkeypatch)

    status, body = purge(service)

    assert status == 200
    assert body['incomplete'] == [OLD]
    assert row(service, NEW)['status'] == 'PROCESSED'
    assert surviving(service, NEW) == {'raw', 'content', 'redacted', 'audio'}
    # The row survives as the pointer an operator (or the next run) finishes from.
    assert row(service, OLD) is not None


def test_a_failed_cleanup_logs_the_marker_an_alarm_counts(service, monkeypatch, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    _break_s3_deletes(monkeypatch)

    purge(service)

    lines = incomplete_lines(capsys)
    assert len(lines) == 1
    line = lines[0]
    assert 'scope=replaced-document' in line
    assert 'essential=yes' in line
    assert f'user={USER}' in line and f'child={CHILD}' in line and f'iep={NEW}' in line
    assert f'superseded={OLD}' in line
    assert 'raw-upload' in line and 'derived-artifacts' in line and 'document-row' in line


def test_the_marker_and_logs_carry_ids_only(service, monkeypatch, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    _break_s3_deletes(monkeypatch)

    purge(service)

    out = capsys.readouterr().out
    assert 'Jordan' not in out
    assert 'plan.pdf' not in out


def test_a_failed_row_delete_is_reported(service, monkeypatch, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    class RowDeleteFails:
        def __init__(self, table):
            self._table = table

        def delete_item(self, **kwargs):
            raise RuntimeError('throttled')

        def __getattr__(self, name):
            return getattr(self._table, name)

    monkeypatch.setattr(service.module, 'table', RowDeleteFails(service.module.table))

    status, body = purge(service)

    assert status == 200
    assert body['incomplete'] == [OLD]
    assert 'survived=document-row' in incomplete_lines(capsys)[0]
    assert row(service, NEW)['status'] == 'PROCESSED'


def test_a_failed_listing_is_reported_and_deletes_nothing(service, monkeypatch, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    class QueryFails:
        def __init__(self, table):
            self._table = table

        def query(self, **kwargs):
            raise RuntimeError('index unavailable')

        def __getattr__(self, name):
            return getattr(self._table, name)

    monkeypatch.setattr(service.module, 'table', QueryFails(service.module.table))

    status, _ = purge(service)

    assert status == 200
    assert 'survived=document-listing' in incomplete_lines(capsys)[0]
    assert row(service, OLD) is not None
    assert row(service, NEW)['status'] == 'PROCESSED'


def test_running_short_of_time_stops_cleanly_and_says_so(service, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    nearly_out_of_time = SimpleNamespace(get_remaining_time_in_millis=lambda: 1_000)

    status, body = purge(service, context=nearly_out_of_time)

    assert status == 200
    assert body['incomplete'] == [OLD]
    assert 'survived=time-budget' in incomplete_lines(capsys)[0]
    assert row(service, OLD) is not None


# ---------------------------------------------------------------------------
# Scope: only this user's, only this child's, only the older documents
# ---------------------------------------------------------------------------

def test_a_document_uploaded_after_the_replacement_is_left_alone(service):
    # The parent uploaded again while this run was in flight. That newer
    # upload is the one they are waiting for and cleans up after itself.
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    newer = seed_document(service, 'iep-newer', NEW_CREATED + 500, status='PROCESSING')

    status, body = purge(service)

    assert status == 200
    assert body['purged'] == [OLD]
    assert row(service, 'iep-newer')['status'] == 'PROCESSING'
    assert all(retrievable_versions(service.s3, BUCKET, key) for key in newer.values())


def test_another_childs_documents_are_not_touched(service):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    sibling = seed_document(service, 'iep-sibling', OLD_CREATED, child_id=OTHER_CHILD)

    purge(service)

    assert row(service, 'iep-sibling', OTHER_CHILD) is not None
    assert all(retrievable_versions(service.s3, BUCKET, key) for key in sibling.values())


def test_another_users_document_for_the_same_child_id_is_not_touched(service):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)
    foreign = seed_document(service, 'iep-foreign', OLD_CREATED, user_id=OTHER_USER)

    purge(service)

    assert row(service, 'iep-foreign') is not None
    assert all(retrievable_versions(service.s3, BUCKET, key) for key in foreign.values())


def test_a_prefix_lookalike_iep_id_is_not_swept(service):
    # iep-old and iep-old2 share a string prefix; only a trailing-slash prefix
    # keeps the sweep off the second one.
    seed_document(service, NEW, NEW_CREATED)
    seed_document(service, OLD, OLD_CREATED)
    lookalike = seed_document(service, 'iep-old2', NEW_CREATED + 1, status='PROCESSING')

    purge(service)

    assert all(retrievable_versions(service.s3, BUCKET, key) for key in lookalike.values())


def test_every_page_of_the_childs_documents_is_considered(service):
    seed_document(service, NEW, NEW_CREATED)
    for index in range(30):
        service.documents.put_item(Item={
            'iepId': f'iep-old-{index:02d}', 'childId': CHILD, 'userId': USER,
            'status': 'FAILED', 'createdAt': OLD_CREATED + index,
            'filler': 'x' * 40_000,  # ~1.2MB in all: forces the query onto a second page
        })

    status, body = purge(service)

    assert status == 200
    assert len(body['purged']) == 30
    remaining = service.documents.scan()['Items']
    assert [item['iepId'] for item in remaining] == [NEW]


def test_a_clean_run_logs_no_filename(service, capsys):
    seed_document(service, OLD, OLD_CREATED)
    seed_document(service, NEW, NEW_CREATED)

    purge(service)

    out = capsys.readouterr().out
    assert 'plan.pdf' not in out
    assert 'DELETION_INCOMPLETE' not in out
