"""finalize_results step tests: the pipeline's last step, which marks the
document PROCESSED via the centralized ddb-service and does nothing else.

"Nothing else" is load-bearing. This step used to put the child's real name
back into the stored summary before reporting success; it does not any more.
Content keeps the {{S}} placeholder permanently and the name is substituted at
read time, so the name never enters stored content, never reaches a
translation model, and a parent correcting it reaches every existing summary.

It also does not record its own failure. The state machine's Catch is the
single writer of the failure row; see the second half of this file.

No dedicated suite existed for this handler before this change. Coverage here
is deliberately minimal (just enough to prove the fixture's mocking is real)
plus the outer catch-all's safe-logging guarantee: this is the last uncovered
path by which a rejected value could reach CloudWatch after f48b08f's fixes
to the other six step handlers.
"""
import json
import os
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import FakeLambdaClient, ScopedBoto3, load_lambda_module, unload

IEP, CHILD, USER = 'iep-1', 'child-1', 'user-sub-1'
IDS = {'iep_id': IEP, 'user_id': USER, 'child_id': CHILD}
DDB_SERVICE = 'DDBServiceTest'
SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'
OK_UPDATE = {'statusCode': 200, 'body': json.dumps({'message': 'ok'})}


@pytest.fixture()
def step(monkeypatch):
    monkeypatch.setenv('DDB_SERVICE_FUNCTION_NAME', DDB_SERVICE)
    module = load_lambda_module('metadata-handler/steps/finalize_results',
                                'finalize_results_handler', module_name='handler')
    try:
        yield SimpleNamespace(module=module)
    finally:
        unload('finalize_results_handler')


def wire(step, monkeypatch, handler):
    fake = FakeLambdaClient(handler)
    monkeypatch.setattr(step.module, 'boto3', ScopedBoto3(fake))
    return fake


def test_marks_the_document_processed(step, monkeypatch):
    fake = wire(step, monkeypatch, lambda payload: OK_UPDATE)

    result = step.module.lambda_handler({**IDS}, None)

    assert result['status'] == 'PROCESSED'
    assert result['progress'] == 100
    assert result['finalized'] is True
    # Exactly one call, and it writes status only. A second operation here
    # would be this step touching content again, which is the write-time
    # restore this design removed.
    assert [p['operation'] for _, p in fake.invocations] == ['update_progress']
    assert {name for name, _ in fake.invocations} == {DDB_SERVICE}
    assert fake.payloads('update_progress')[0]['params']['status'] == 'PROCESSED'


def test_outer_catch_all_never_logs_the_rejected_value(step, monkeypatch, capsys):
    """The outermost catch-all used to print(str(e)) and
    traceback.format_exc() verbatim -- the last uncovered path by which a
    rejected value could reach CloudWatch after f48b08f's fixes elsewhere in
    the pipeline."""
    def _boom(payload):
        raise Exception(SENTINEL)
    wire(step, monkeypatch, _boom)

    with pytest.raises(Exception):
        step.module.lambda_handler({**IDS}, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives


def test_the_step_records_no_failure_of_its_own(step, monkeypatch):
    """This assertion replaces an older one that pinned the opposite.

    The handler used to invoke record_failure here and then re-raise, and this
    test pinned the log line from that call's guard ("Failed to record error in
    DDB"). That call was the double-write: the state machine's Catch writes the
    same row straight afterwards. The pin was not wrong about what the code
    did, it pinned code that should not have existed, so it is replaced rather
    than dropped -- the step must now make no failure-recording call at all.

    Marker counting for the real thing is in the second half of this file; this
    is the cheap version that fails the instant the inner call comes back.
    """
    fake = wire(step, monkeypatch, lambda payload: {'statusCode': 500, 'body': '{}'})

    with pytest.raises(Exception):
        step.module.lambda_handler({**IDS}, None)

    assert [p['operation'] for _, p in fake.invocations] == ['update_progress']
    assert fake.payloads('record_failure') == []


# --- the state machine's failure path, replayed ------------------------------
#
# FinalizeResults is the only step that ever recorded its own failure. Because
# it re-raised afterwards, the ASL's Catch (FailedAtFinalizeResults ->
# RecordFailure) then wrote the same row again, and the step is retried, so one
# failed document logged the RECORD_FAILURE marker once per attempt plus once
# from the Catch. MonitoringStack's DocumentFailureFilter counts that marker
# and ddb-service's record_failure runs the unredacted-artifact purge, so both
# the failure count and the purge ran up to five times for one document.
#
# These tests replay the real sequence -- every attempt, then the Catch --
# against the REAL ddb-service module, so the marker and the purge are the
# production ones rather than a fixture's idea of them.

DOCUMENTS_TABLE = 'documents-test'
PROFILES_TABLE = 'profiles-test'
METADATA_BUCKET = 'metadata-bucket-test'
UPLOADS_BUCKET = 'iep-uploads-test'
KEY = {'iepId': IEP, 'childId': CHILD}
UPLOAD_KEY = f'{USER}/{CHILD}/{IEP}/report.pdf'
RAW_OCR_KEY = f'iep-data/{IEP}/{CHILD}/ocr_result.json'
# What Step Functions actually puts in $.error.Cause for a failed Lambda task:
# a JSON string, not the bare message the removed inner call passed as str(e).
CATCH_CAUSE = json.dumps({
    'errorType': 'Exception',
    'errorMessage': 'Failed to update progress to completion',
    'stackTrace': [],
})

ASL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'lib', 'chatbot-api', 'state-machines', 'iep-processing.asl.json',
)


def finalize_attempts():
    """How many times Step Functions runs FinalizeResults before its Catch
    fires. MaxAttempts counts the retries AFTER the initial attempt, so the
    lambda runs MaxAttempts + 1 times. Read from the ASL rather than hardcoded:
    if the retry budget changes, the replay below has to change with it or the
    counts it asserts stop describing production.
    """
    with open(ASL_PATH) as f:
        retriers = json.load(f)['States']['FinalizeResults']['Retry']
    states_all = next(r for r in retriers if r['ErrorEquals'] == ['States.ALL'])
    return states_all['MaxAttempts'] + 1


@pytest.fixture()
def rig(monkeypatch):
    """finalize_results wired to the real ddb-service over moto.

    update_progress answers 500 so the step fails the way a real finalize
    failure fails; record_failure, if the step ever makes one again, reaches
    the real service and logs the real marker.
    """
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
        monkeypatch.setenv('DDB_SERVICE_FUNCTION_NAME', DDB_SERVICE)

        ddb_service = load_lambda_module('metadata-handler/ddb-service',
                                         'ddb_service_for_finalize', module_name='handler')
        module = load_lambda_module('metadata-handler/steps/finalize_results',
                                    'finalize_results_handler', module_name='handler')

        def route(payload):
            if payload.get('operation') == 'update_progress':
                return {'statusCode': 500,
                        'body': json.dumps({'error': 'table unavailable'})}
            return ddb_service.lambda_handler(payload, None)

        fake_lambda = FakeLambdaClient(route)
        monkeypatch.setattr(module, 'boto3', ScopedBoto3(fake_lambda))
        try:
            yield SimpleNamespace(module=module, ddb_service=ddb_service,
                                  documents=documents, s3=s3, fake_lambda=fake_lambda)
        finally:
            unload('finalize_results_handler')
            unload('ddb_service_for_finalize')
            unload('s3_content_handler')  # sibling import caches BUCKET at import


def seed(rig):
    """A document at the last step, still holding both unredacted artifacts:
    the original upload and the raw OCR (S3 payload and legacy inline copy)."""
    rig.s3.put_object(Bucket=UPLOADS_BUCKET, Key=UPLOAD_KEY, Body=b'%PDF-1.4 original')
    rig.s3.put_object(Bucket=METADATA_BUCKET, Key=RAW_OCR_KEY,
                      Body=json.dumps({'pages': [{'markdown': 'raw UNREDACTED text'}]}))
    rig.documents.put_item(Item={
        **KEY, 'userId': USER, 'status': 'PROCESSING',
        'documentUrl': f's3://{UPLOADS_BUCKET}/{UPLOAD_KEY}',
        'ocr_result': 'legacy inline raw OCR',
        'ocr_result_s3_ref': {'bucket': METADATA_BUCKET, 's3Key': RAW_OCR_KEY},
    })


def run_every_attempt(rig):
    """The Task itself: the initial attempt plus every retry, all failing."""
    for _ in range(finalize_attempts()):
        with pytest.raises(Exception):
            rig.module.lambda_handler({**IDS}, None)


def run_the_catch(rig):
    """FailedAtFinalizeResults -> RecordFailure, with the parameters the ASL's
    RecordFailure task sends. The state machine invokes the DDB service itself,
    so this does not go through the step's Lambda client."""
    return rig.ddb_service.lambda_handler({
        'operation': 'record_failure',
        'params': {'iep_id': IEP, 'child_id': CHILD, 'user_id': USER,
                   'error_message': CATCH_CAUSE, 'failed_step': 'FinalizeResults'},
    }, None)


def markers(capsys, name):
    return [line for line in capsys.readouterr().out.splitlines() if name in line]


def bucket_keys(rig, bucket):
    return {obj['Key'] for obj in rig.s3.list_objects_v2(Bucket=bucket).get('Contents', [])}


def test_one_failed_document_logs_the_failure_marker_once(rig, capsys):
    # The regression this change exists for. With the step recording its own
    # failure as well, this counted finalize_attempts() + 1 -- five markers for
    # one document -- and every threshold built on
    # MonitoringStack's DocumentFailures metric was reading a number up to five
    # times too big, in exactly the situation the metric exists for.
    seed(rig)

    run_every_attempt(rig)
    # Nothing yet: the retries have not run out, so no document has failed.
    assert markers(capsys, 'RECORD_FAILURE') == []

    run_the_catch(rig)

    recorded = markers(capsys, 'RECORD_FAILURE')
    assert len(recorded) == 1, recorded
    assert f'iep={IEP}' in recorded[0]
    # The Catch's name for the step, not the 'finalize_results' the removed
    # inner call passed: one writer, one spelling.
    assert 'step=FinalizeResults' in recorded[0]


def test_no_failure_is_recorded_while_retries_remain(rig, capsys):
    # Deliberate, not incidental. A retry that has not run out of attempts is
    # not a failed document: the next attempt may succeed. Writing the row
    # early would show the parent a FAILED document the pipeline is still
    # working on, and would run the unredacted-artifact purge underneath a
    # document that is about to try again.
    seed(rig)

    run_every_attempt(rig)

    assert markers(capsys, 'RECORD_FAILURE') == []
    assert rig.documents.get_item(Key=KEY)['Item']['status'] == 'PROCESSING'
    assert rig.fake_lambda.payloads('record_failure') == []


def test_the_catch_is_what_purges_the_unredacted_artifacts(rig):
    # The privacy guarantee, located precisely. _cleanup_unredacted_artifacts
    # lives inside ddb-service's record_failure, not in this step, so dropping
    # the step's own call does not drop the purge: the Catch's invoke of the
    # same function runs it. This test would have caught the opposite mistake
    # -- removing the inner call from a step that was the only thing purging.
    seed(rig)

    run_every_attempt(rig)
    # Still there. The step raises and cleans up nothing.
    assert bucket_keys(rig, UPLOADS_BUCKET) == {UPLOAD_KEY}
    assert bucket_keys(rig, METADATA_BUCKET) == {RAW_OCR_KEY}

    run_the_catch(rig)

    assert bucket_keys(rig, UPLOADS_BUCKET) == set()
    assert bucket_keys(rig, METADATA_BUCKET) == set()
    item = rig.documents.get_item(Key=KEY)['Item']
    assert 'ocr_result' not in item          # legacy inline copy purged too
    assert 'ocr_result_s3_ref' not in item
    assert item['status'] == 'FAILED'


def test_unredacted_artifacts_are_purged_exactly_once(rig, monkeypatch):
    # The other half of the double-write: record_failure purges, so five
    # failure records meant five purges of one document -- five S3 deletes and
    # five REMOVE writes against a row that was already clean after the first.
    # The counter wraps the real function and calls through, so the purge
    # asserted below is the real one.
    seed(rig)
    real_cleanup = rig.ddb_service._cleanup_unredacted_artifacts
    calls = []

    def counting_cleanup(iep_id, child_id):
        calls.append((iep_id, child_id))
        return real_cleanup(iep_id, child_id)

    monkeypatch.setattr(rig.ddb_service, '_cleanup_unredacted_artifacts', counting_cleanup)

    run_every_attempt(rig)
    run_the_catch(rig)

    assert calls == [(IEP, CHILD)]
    assert bucket_keys(rig, UPLOADS_BUCKET) == set()
    assert 'ocr_result' not in rig.documents.get_item(Key=KEY)['Item']


def test_a_retained_artifact_is_reported_once_not_once_per_attempt(rig, capsys):
    # UNREDACTED_ARTIFACTS_RETAINED has its own critical alarm at a threshold
    # of one, so the double-write inflated that count too. Deleting the row
    # first is the loudest retention case there is: the purge can no longer
    # read documentUrl to find the original upload, and the REMOVE of the raw
    # OCR attribute trips _guarded_update, so a child's unredacted upload stays
    # in S3 and the marker is the only thing that says so.
    seed(rig)
    rig.documents.delete_item(Key=KEY)

    run_every_attempt(rig)
    run_the_catch(rig)

    retained = markers(capsys, 'UNREDACTED_ARTIFACTS_RETAINED')
    assert len(retained) == 1, retained
