"""scripts/audit-residue.py tests.

The audit is what will tell us a cleanup path broke, so each check is pinned
in both directions: it fires on the residue it exists to catch, and stays
quiet on a healthy environment. A check that cannot fail would report "all
clean" forever, which is worse than not having it.

Every check is a pure function over already-fetched AWS data, so most tests
build that data directly. The end-to-end audit() test runs against moto.
"""
import importlib.util
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from moto import mock_aws

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO_ROOT, 'scripts', 'audit-residue.py')

NOW = datetime(2026, 8, 8, 12, 0, tzinfo=timezone.utc)
BUCKET = 'ai-iep-knowledge-source-dev'
TABLE = 'AIEPStagingStack-ChatbotAPIstagingIepDocumentsTable-test'


@pytest.fixture(scope='module')
def audit_mod():
    """Load the ops script by path: its filename is not a valid module name."""
    spec = importlib.util.spec_from_file_location('audit_residue', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules['audit_residue'] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop('audit_residue', None)


def obj(key):
    return {'Key': key}


def iso(minutes_ago=0, days_ago=0):
    return (NOW - timedelta(minutes=minutes_ago, days=days_ago)).isoformat()


def only(findings, name):
    return next(f for f in findings if f['check'] == name)


# ---------------------------------------------------------------------------
# Unredacted originals: the FERPA check

def test_unredacted_original_is_an_error_and_reports_the_iep_id(audit_mod):
    findings = []
    audit_mod.check_unredacted_originals([
        obj('iep-data/iep-1/child-1/content.json'),
        obj('iep-audio/iep-1/child-1/en/summary-abc.mp3'),
        obj('user-9/child-1/iep-7/Psychological eval SURNAME, B.doc'),
    ], findings)
    f = only(findings, 'unredacted_originals')
    assert f['level'] == 'error'
    assert f['count'] == 1
    assert f['detail'] == ['iep-7']


def test_unredacted_originals_never_leak_the_filename(audit_mod):
    """The upload filename carries the student's name."""
    findings = []
    audit_mod.check_unredacted_originals(
        [obj('user-9/child-1/iep-7/Psychological eval SURNAME, B.doc')], findings)
    blob = json.dumps(only(findings, 'unredacted_originals'))
    assert 'SURNAME' not in blob
    assert '.doc' not in blob


def test_no_originals_is_clean(audit_mod):
    findings = []
    audit_mod.check_unredacted_originals(
        [obj('iep-data/iep-1/child-1/content.json')], findings)
    assert only(findings, 'unredacted_originals')['level'] is None


# ---------------------------------------------------------------------------
# Noncurrent originals outliving the lifecycle rule

def test_overdue_noncurrent_original_is_an_error(audit_mod):
    findings = []
    audit_mod.check_stale_noncurrent_originals(
        [{'Key': 'u/c/iep-1/f.pdf', 'IsLatest': False, 'LastModified': iso(days_ago=40)}],
        [{'Key': 'u/c/iep-1/f.pdf', 'LastModified': iso(days_ago=14)}],
        findings, reference=NOW)
    f = only(findings, 'stale_noncurrent_originals')
    assert f['level'] == 'error' and f['count'] == 1


def test_recent_noncurrent_and_derived_versions_are_ignored(audit_mod):
    findings = []
    audit_mod.check_stale_noncurrent_originals([
        # inside the grace window: the lifecycle sweep is asynchronous
        {'Key': 'u/c/iep-1/f.pdf', 'IsLatest': False, 'LastModified': iso(days_ago=1)},
        # a derived artifact, not an unredacted original
        {'Key': 'iep-data/iep-2/c/content.json', 'IsLatest': False,
         'LastModified': iso(days_ago=99)},
        # the live object is handled by check_unredacted_originals
        {'Key': 'u/c/iep-3/f.pdf', 'IsLatest': True, 'LastModified': iso(days_ago=99)},
    ], [], findings, reference=NOW)
    assert only(findings, 'stale_noncurrent_originals')['level'] is None


def test_a_just_deleted_old_original_is_not_reported_as_overdue(audit_mod):
    """The clock starts when the version became noncurrent, not at upload.

    Purging prod on 2026-08-10 deleted an original uploaded on 2026-07-14 and
    the check immediately called it '26.8 days' overdue, when it had been
    noncurrent for seconds. The delete marker is the real reference.
    """
    findings = []
    audit_mod.check_stale_noncurrent_originals(
        [{'Key': 'u/c/iep-1/f.pdf', 'IsLatest': False, 'LastModified': iso(days_ago=27)}],
        [{'Key': 'u/c/iep-1/f.pdf', 'LastModified': iso(minutes_ago=1)}],
        findings, reference=NOW)
    assert only(findings, 'stale_noncurrent_originals')['level'] is None


def test_a_version_with_no_delete_marker_falls_back_to_its_own_age(audit_mod):
    """Superseded by a newer upload rather than deleted: no marker exists."""
    findings = []
    audit_mod.check_stale_noncurrent_originals(
        [{'Key': 'u/c/iep-1/f.pdf', 'IsLatest': False, 'LastModified': iso(days_ago=30)}],
        [], findings, reference=NOW)
    assert only(findings, 'stale_noncurrent_originals')['level'] == 'error'


# ---------------------------------------------------------------------------
# Stuck in-flight documents

def test_idle_in_flight_document_is_an_error(audit_mod):
    findings = []
    audit_mod.check_stuck_documents([
        {'iepId': 'iep-1', 'status': 'PROCESSING', 'updated_at': iso(minutes_ago=90),
         'current_step': 'ocr_complete'},
    ], findings, reference=NOW)
    f = only(findings, 'stuck_documents')
    assert f['level'] == 'error'
    assert f['detail'][0]['iepId'] == 'iep-1' and f['detail'][0]['idleMin'] == 90


def test_stuck_check_uses_updated_at_not_created_at(audit_mod):
    """A re-translation of an old document has a createdAt weeks in the past.

    Measuring from createdAt reported a healthy re-translation as stuck for 23
    days, so the freshness signal has to be updated_at.
    """
    findings = []
    audit_mod.check_stuck_documents([
        {'iepId': 'iep-old', 'status': 'PROCESSING_TRANSLATIONS',
         'createdAt': int((NOW - timedelta(days=23)).timestamp()),
         'updated_at': iso(minutes_ago=2), 'current_step': 'translation_requested'},
    ], findings, reference=NOW)
    assert only(findings, 'stuck_documents')['level'] is None


def test_settled_documents_are_never_stuck(audit_mod):
    findings = []
    audit_mod.check_stuck_documents([
        {'iepId': 'iep-1', 'status': 'PROCESSED', 'updated_at': iso(days_ago=30)},
        {'iepId': 'iep-2', 'status': 'FAILED', 'updated_at': iso(days_ago=30)},
    ], findings, reference=NOW)
    assert only(findings, 'stuck_documents')['level'] is None


# ---------------------------------------------------------------------------
# Rows that never got a status

def test_statusless_row_past_the_window_is_flagged(audit_mod):
    findings = []
    audit_mod.check_statusless_documents([
        {'iepId': 'iep-old', 'createdAt': int((NOW - timedelta(hours=3)).timestamp())},
    ], findings, reference=NOW)
    f = only(findings, 'statusless_documents')
    assert f['level'] == 'warn' and f['detail'] == ['iep-old']


def test_freshly_created_statusless_row_is_not_flagged(audit_mod):
    """The upload handler writes the row before InitializeProcessing writes
    the status, so a few seconds without one is normal."""
    findings = []
    audit_mod.check_statusless_documents([
        {'iepId': 'iep-new', 'createdAt': int((NOW - timedelta(seconds=20)).timestamp())},
    ], findings, reference=NOW)
    assert only(findings, 'statusless_documents')['level'] is None


# ---------------------------------------------------------------------------
# Orphaned derived artifacts

def test_orphaned_content_and_audio_are_flagged_separately(audit_mod):
    findings = []
    audit_mod.check_orphaned_artifacts(
        [obj('iep-data/iep-gone/child-1/content.json'),
         obj('iep-audio/iep-gone/child-1/en/summary-abc.mp3'),
         obj('iep-data/iep-live/child-1/content.json')],
        [{'iepId': 'iep-live'}], findings)
    f = only(findings, 'orphaned_artifacts')
    assert f['level'] == 'warn' and f['count'] == 2
    assert f['detail'] == {'content': ['iep-gone'], 'audio': ['iep-gone']}


def test_artifacts_with_live_rows_are_clean(audit_mod):
    findings = []
    audit_mod.check_orphaned_artifacts(
        [obj('iep-data/iep-1/child-1/content.json')], [{'iepId': 'iep-1'}], findings)
    assert only(findings, 'orphaned_artifacts')['level'] is None


# ---------------------------------------------------------------------------
# Recent failures

def test_recent_failure_is_reported_and_old_one_is_not(audit_mod):
    findings = []
    audit_mod.check_recent_failures([
        {'iepId': 'iep-new', 'status': 'FAILED', 'updated_at': iso(minutes_ago=30)},
        {'iepId': 'iep-old', 'status': 'FAILED', 'updated_at': iso(days_ago=9)},
    ], findings, reference=NOW)
    f = only(findings, 'recent_failures')
    assert f['count'] == 1 and f['detail'][0]['iepId'] == 'iep-new'


# ---------------------------------------------------------------------------
# Rendering

def test_render_collapses_a_clean_environment_to_one_line(audit_mod):
    findings = [{'check': 'a', 'level': None, 'count': 0, 'detail': [], 'message': 'ok'}]
    out = audit_mod.render('staging', findings)
    assert 'No residue in staging' in out and 'all 1 checks clean' in out


def test_render_surfaces_errors_with_detail(audit_mod):
    findings = [
        {'check': 'a', 'level': 'error', 'count': 1, 'detail': ['iep-7'],
         'message': '1 unredacted original(s) still in the bucket'},
        {'check': 'b', 'level': None, 'count': 0, 'detail': [], 'message': 'fine'},
    ]
    out = audit_mod.render('prod', findings)
    assert 'unredacted original' in out and 'iep-7' in out
    assert '1 of 2 checks clean' in out


# ---------------------------------------------------------------------------
# End to end against moto

MACHINE = 'ChatbotAPIstagingIEPProcessingStateMachine-test'


@pytest.fixture()
def staged(monkeypatch):
    """A staging-shaped environment: names must satisfy real discover()."""
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        dynamodb.create_table(
            TableName=TABLE,
            KeySchema=[{'AttributeName': 'iepId', 'KeyType': 'HASH'},
                       {'AttributeName': 'childId', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'iepId', 'AttributeType': 'S'},
                                  {'AttributeName': 'childId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        sfn = boto3.client('stepfunctions', region_name='us-east-1')
        sfn.create_state_machine(
            name=MACHINE,
            definition=json.dumps({'StartAt': 'X', 'States': {'X': {'Type': 'Pass', 'End': True}}}),
            roleArn='arn:aws:iam::123456789012:role/service-role/StatesRole',
        )
        yield dynamodb, s3, sfn


def healthy_document(dynamodb):
    """A row as the upload path really writes it, userId included.

    userId is not optional decoration: without it the row is invisible to the
    byUserId GSI account deletion queries, so a fixture missing it is not a
    healthy document and check_unreachable_documents rightly rejects it.
    """
    dynamodb.Table(TABLE).put_item(Item={
        'iepId': 'iep-1', 'childId': 'child-1', 'userId': 'user-sub-1',
        'status': 'PROCESSED',
        'createdAt': int(NOW.timestamp()), 'updated_at': iso(minutes_ago=5)})


def test_audit_end_to_end_flags_a_leftover_original(audit_mod, staged):
    dynamodb, s3, sfn = staged
    healthy_document(dynamodb)
    s3.put_object(Bucket=BUCKET, Key='iep-data/iep-1/child-1/content.json', Body=b'{}')
    s3.put_object(Bucket=BUCKET, Key='user-9/child-1/iep-1/original.pdf', Body=b'pdf')

    findings = audit_mod.audit('staging', dynamodb=dynamodb, s3=s3, sfn=sfn, reference=NOW)

    assert only(findings, 'unredacted_originals')['level'] == 'error'
    assert only(findings, 'unredacted_originals')['detail'] == ['iep-1']
    assert only(findings, 'orphaned_artifacts')['level'] is None
    assert only(findings, 'stuck_documents')['level'] is None


def test_audit_end_to_end_flags_an_orphaned_summary(audit_mod, staged):
    """The regression this whole audit was added for."""
    dynamodb, s3, sfn = staged
    healthy_document(dynamodb)
    s3.put_object(Bucket=BUCKET, Key='iep-data/iep-1/child-1/content.json', Body=b'{}')
    s3.put_object(Bucket=BUCKET, Key='iep-data/iep-deleted/child-1/content.json', Body=b'{}')
    s3.put_object(Bucket=BUCKET, Key='iep-audio/iep-deleted/child-1/en/s-a.mp3', Body=b'x')

    findings = audit_mod.audit('staging', dynamodb=dynamodb, s3=s3, sfn=sfn, reference=NOW)

    f = only(findings, 'orphaned_artifacts')
    assert f['level'] == 'warn'
    assert f['detail'] == {'content': ['iep-deleted'], 'audio': ['iep-deleted']}


def test_audit_end_to_end_is_clean_when_nothing_is_left_over(audit_mod, staged):
    dynamodb, s3, sfn = staged
    healthy_document(dynamodb)
    s3.put_object(Bucket=BUCKET, Key='iep-data/iep-1/child-1/content.json', Body=b'{}')

    findings = audit_mod.audit('staging', dynamodb=dynamodb, s3=s3, sfn=sfn, reference=NOW)

    assert [f['check'] for f in findings if f['level']] == []
    assert 'No residue in staging' in audit_mod.render('staging', findings)


def test_prod_discovery_refuses_to_read_staging_resources(audit_mod, staged):
    """A prod audit that resolved staging's table would report prod clean."""
    dynamodb, s3, sfn = staged
    with pytest.raises(SystemExit):
        audit_mod.discover('prod', dynamodb, sfn)


# ---------------------------------------------------------------------------
# Rows account deletion can never reach

def test_a_row_with_no_userid_is_an_error(audit_mod):
    """The signature of a resurrected row, and of a row nothing can delete.

    DynamoDB does not index items missing a GSI key, so a row without userId is
    invisible to the byUserId query account deletion uses. Prod held one for
    weeks while the audit reported it healthy, because the row had a status and
    no check looked for a missing owner.
    """
    findings = []
    audit_mod.check_unreachable_documents([
        {'iepId': 'iep-phantom', 'childId': 'c1', 'status': 'FAILED'},
        {'iepId': 'iep-ok', 'childId': 'c1', 'userId': 'u1', 'status': 'PROCESSED'},
    ], findings)
    f = only(findings, 'unreachable_documents')
    assert f['level'] == 'error'
    assert f['detail'] == ['iep-phantom']


def test_rows_with_owners_are_clean(audit_mod):
    findings = []
    audit_mod.check_unreachable_documents(
        [{'iepId': 'iep-1', 'userId': 'u1'}], findings)
    assert only(findings, 'unreachable_documents')['level'] is None


def test_an_empty_userid_counts_as_unreachable(audit_mod):
    """An empty string is not a usable GSI key either."""
    findings = []
    audit_mod.check_unreachable_documents(
        [{'iepId': 'iep-1', 'userId': ''}], findings)
    assert only(findings, 'unreachable_documents')['level'] == 'error'


def test_audit_end_to_end_flags_an_unreachable_row(audit_mod, staged):
    dynamodb, s3, sfn = staged
    dynamodb.Table(TABLE).put_item(Item={
        'iepId': 'iep-phantom', 'childId': 'child-1', 'status': 'FAILED',
        'updated_at': iso(minutes_ago=5)})  # no userId
    findings = audit_mod.audit('staging', dynamodb=dynamodb, s3=s3, sfn=sfn,
                               reference=NOW)
    f = only(findings, 'unreachable_documents')
    assert f['level'] == 'error' and f['detail'] == ['iep-phantom']
    assert 'account' in f['message']
