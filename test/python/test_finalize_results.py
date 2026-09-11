"""finalize_results step tests: the pipeline's last step, which marks a
document PROCESSED via the centralized ddb-service.

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
    (function_name, payload), = fake.invocations
    assert function_name == DDB_SERVICE
    assert payload['operation'] == 'update_progress'
    assert payload['params']['status'] == 'PROCESSED'


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
