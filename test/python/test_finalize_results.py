"""finalize_results step tests: the pipeline's last step, which restores the
child's name and marks the document PROCESSED via the centralized ddb-service.

No dedicated suite existed for this handler before this change. Coverage here
is deliberately minimal (just enough to prove the fixture's mocking is real)
plus the outer catch-all's safe-logging guarantee: this is the last uncovered
path by which a rejected value could reach CloudWatch after f48b08f's fixes
to the other six step handlers.
"""
import json
from types import SimpleNamespace

import pytest

from conftest import FakeLambdaClient, ScopedBoto3, load_lambda_module, unload

IDS = {'iep_id': 'iep-1', 'user_id': 'user-sub-1', 'child_id': 'child-1'}
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
    # The name goes back in first: everything downstream of PROCESSED (the
    # API, the PDF, the TTS voice) reads the stored summary.
    assert [p['operation'] for _, p in fake.invocations] == [
        'restore_student_name', 'update_progress']
    assert {name for name, _ in fake.invocations} == {DDB_SERVICE}
    assert fake.payloads('update_progress')[0]['params']['status'] == 'PROCESSED'


def test_the_restore_call_carries_ids_and_nothing_else(step, monkeypatch):
    """Step Functions keeps execution history for 90 days, outside every
    deletion path this project has, so the name is read inside the ddb-service
    from the profile rather than passed to it."""
    fake = wire(step, monkeypatch, lambda payload: OK_UPDATE)

    step.module.lambda_handler({**IDS}, None)

    restore_payload, = fake.payloads('restore_student_name')
    assert restore_payload['params'] == IDS


def test_a_failed_restore_stops_short_of_marking_the_document_processed(
        step, monkeypatch):
    """A document whose summary still says "{{S}} is making progress" has not
    finished. Raising sends it back through the step's retries and then to
    RecordFailure, rather than showing a parent a placeholder."""
    def handler(payload):
        if payload['operation'] == 'restore_student_name':
            return {'statusCode': 500, 'body': json.dumps({'error': 'S3 read failed'})}
        return OK_UPDATE
    fake = wire(step, monkeypatch, handler)

    with pytest.raises(Exception):
        step.module.lambda_handler({**IDS}, None)

    assert fake.payloads('update_progress') == []


def test_a_document_with_no_tokens_left_still_completes(step, monkeypatch):
    """Nothing to restore is a normal outcome, not a failure: a parent may
    have saved no name, or the strict matcher may have recognised no spelling
    and the model emitted no token."""
    def handler(payload):
        if payload['operation'] == 'restore_student_name':
            return {'statusCode': 200,
                    'body': json.dumps({'tokens_restored': 0,
                                        'mangled_tokens_restored': 0,
                                        'name_available': False})}
        return OK_UPDATE
    wire(step, monkeypatch, handler)

    assert step.module.lambda_handler({**IDS}, None)['status'] == 'PROCESSED'


def test_outer_catch_all_never_logs_the_rejected_value(step, monkeypatch, capsys):
    """The outermost catch-all used to print(str(e)) and
    traceback.format_exc() verbatim -- the last uncovered path by which a
    rejected value could reach CloudWatch after f48b08f's fixes elsewhere in
    the pipeline. The same fake handler also fails the inner record_failure
    invoke this except block makes; that inner call is already guarded by a
    bare `except:` that only ever prints a fixed, safe string, so it cannot
    itself leak the sentinel."""
    def _boom(payload):
        raise Exception(SENTINEL)
    wire(step, monkeypatch, _boom)

    with pytest.raises(Exception):
        step.module.lambda_handler({**IDS}, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives
    assert 'Failed to record error in DDB' in logged  # inner catch still ran
