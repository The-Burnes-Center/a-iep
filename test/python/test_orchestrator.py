"""metadata-handler orchestrator tests.

The orchestrator is the front door of IEP processing: an S3 upload event
either starts the Step Functions pipeline or is filtered out (internal
content.json writes, TTS audio cache, JSON artifacts). A regression here
means uploads silently never process, so the filter and key-parsing rules
are pinned.
"""
import json
import re
from types import SimpleNamespace

import pytest

from conftest import load_lambda_module, unload

STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:iep-processing'
CONTEXT = SimpleNamespace(aws_request_id='deadbeef-0000-4000-8000-000000000000')

# Real Step Functions rejects execution names outside this charset/length
# (e.g. a filename-as-iep_id with a '.' in it), so the fake enforces it too.
EXECUTION_NAME_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')


class FakeStepFunctions:
    def __init__(self):
        self.executions = []

    def start_execution(self, *, stateMachineArn, name, input):
        # Validate like real AWS would, so a bad execution name or a stray
        # ARN fails the test instead of only failing in production.
        if stateMachineArn != STATE_MACHINE_ARN:
            raise AssertionError(f'unexpected stateMachineArn: {stateMachineArn!r}')
        if not EXECUTION_NAME_RE.match(name):
            raise AssertionError(f'invalid Step Functions execution name: {name!r}')
        self.executions.append(
            {'stateMachineArn': stateMachineArn, 'name': name, 'input': input})
        return {'executionArn': f'{STATE_MACHINE_ARN}:exec-{len(self.executions)}'}


@pytest.fixture()
def orchestrator(monkeypatch):
    module = load_lambda_module('metadata-handler', 'metadata_orchestrator',
                                module_name='orchestrator')
    stepfunctions = FakeStepFunctions()
    # Patch the module's own client factory at its point of use; patching
    # boto3.client itself would hijack every AWS client in the process.
    monkeypatch.setattr(module, '_stepfunctions_client', lambda: stepfunctions)
    monkeypatch.setenv('STATE_MACHINE_ARN', STATE_MACHINE_ARN)
    try:
        yield SimpleNamespace(module=module, stepfunctions=stepfunctions)
    finally:
        unload('metadata_orchestrator')


def s3_event(*keys, bucket='iep-uploads'):
    return {'Records': [
        {'s3': {'bucket': {'name': bucket}, 'object': {'key': key}}}
        for key in keys
    ]}


def run(orchestrator, event):
    return orchestrator.module.lambda_handler(event, CONTEXT)


def test_document_upload_starts_the_pipeline(orchestrator):
    response = run(orchestrator, s3_event('user-1/child-1/iep-1/report.pdf'))
    assert response['statusCode'] == 200
    assert len(orchestrator.stepfunctions.executions) == 1

    execution = orchestrator.stepfunctions.executions[0]
    assert execution['stateMachineArn'] == STATE_MACHINE_ARN
    payload = json.loads(execution['input'])
    assert payload['user_id'] == 'user-1'
    assert payload['child_id'] == 'child-1'
    assert payload['iep_id'] == 'iep-1'
    assert payload['s3_bucket'] == 'iep-uploads'
    assert payload['s3_key'] == 'user-1/child-1/iep-1/report.pdf'


def test_s3_keys_are_url_decoded_before_parsing(orchestrator):
    # S3 notifications URL-encode keys; '+' means space in that encoding.
    run(orchestrator, s3_event('user-1/child-1/iep-1/My%20IEP+2026.pdf'))
    payload = json.loads(orchestrator.stepfunctions.executions[0]['input'])
    assert payload['s3_key'] == 'user-1/child-1/iep-1/My IEP 2026.pdf'


@pytest.mark.parametrize('key', [
    'user-1/child-1/iep-1/content.json',   # internal content storage
    'user-1/child-1/iep-1/summary.json',   # any JSON artifact
    'iep-audio/iep-1/en/summary.mp3',      # TTS cache prefix
    'user-1/child-1/iep-1/readaloud.mp3',  # audio by extension
])
def test_internal_artifacts_never_start_the_pipeline(orchestrator, key):
    response = run(orchestrator, s3_event(key))
    assert response['statusCode'] == 200
    assert 'Skipped' in json.loads(response['body'])['message']
    assert orchestrator.stepfunctions.executions == []


@pytest.mark.parametrize('key', [
    'orphan-file.pdf',                # no folder structure at all
    'user-1/orphan.pdf',              # 2 segments
    'user-1/child-1/orphan.pdf',      # 3 segments: iep_id would be a filename
])
def test_short_keys_are_skipped(orchestrator, key):
    # The upload path always writes userId/childId/iepId/filename (see
    # knowledge-management/upload-s3/index.mjs); anything shorter is not a
    # document upload and must be skipped, never fed to Step Functions where
    # a filename-as-iep_id breaks the execution name.
    response = run(orchestrator, s3_event(key))
    assert response['statusCode'] == 200
    assert 'Skipped' in json.loads(response['body'])['message']
    assert orchestrator.stepfunctions.executions == []


def test_multi_record_event_starts_one_execution_per_document(orchestrator):
    # S3 batches notifications; every record must be processed, with the
    # filter rules still applied per record.
    response = run(orchestrator, s3_event(
        'user-1/child-1/iep-1/report.pdf',
        'user-1/child-1/iep-1/content.json',   # filtered out
        'user-2/child-2/iep-2/plan.pdf',
    ))
    assert response['statusCode'] == 200

    executions = orchestrator.stepfunctions.executions
    assert len(executions) == 2
    payloads = [json.loads(execution['input']) for execution in executions]
    assert [payload['iep_id'] for payload in payloads] == ['iep-1', 'iep-2']
    assert [payload['user_id'] for payload in payloads] == ['user-1', 'user-2']

    body = json.loads(response['body'])
    assert '2 execution(s) started' in body['message']
    assert len(body['results']) == 3  # one entry per record, skips included


def test_direct_invocation_requires_all_ids(orchestrator):
    response = run(orchestrator, {
        'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
        's3_bucket': 'iep-uploads', 's3_key': 'user-1/child-1/iep-1/report.pdf',
    })
    assert response['statusCode'] == 200
    assert len(orchestrator.stepfunctions.executions) == 1

    response = run(orchestrator, {'iep_id': 'iep-1', 'user_id': 'user-1'})
    assert response['statusCode'] == 400
    assert len(orchestrator.stepfunctions.executions) == 1


def test_missing_state_machine_arn_fails_loudly(orchestrator, monkeypatch):
    monkeypatch.delenv('STATE_MACHINE_ARN')
    response = run(orchestrator, s3_event('user-1/child-1/iep-1/report.pdf'))
    assert response['statusCode'] == 500
    assert orchestrator.stepfunctions.executions == []
