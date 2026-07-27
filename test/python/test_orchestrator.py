"""metadata-handler orchestrator tests.

The orchestrator is the front door of IEP processing: an S3 upload event
either starts the Step Functions pipeline or is filtered out (internal
content.json writes, TTS audio cache, JSON artifacts). A regression here
means uploads silently never process, so the filter and key-parsing rules
are pinned.
"""
import json
from types import SimpleNamespace

import pytest

from conftest import load_lambda_module, unload

STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:iep-processing'
CONTEXT = SimpleNamespace(aws_request_id='deadbeef-0000-4000-8000-000000000000')


class FakeStepFunctions:
    def __init__(self):
        self.executions = []

    def start_execution(self, **kwargs):
        self.executions.append(kwargs)
        return {'executionArn': f'{STATE_MACHINE_ARN}:exec-{len(self.executions)}'}


@pytest.fixture()
def orchestrator(monkeypatch):
    module = load_lambda_module('metadata-handler', 'metadata_orchestrator',
                                module_name='orchestrator')
    stepfunctions = FakeStepFunctions()
    monkeypatch.setattr(module.boto3, 'client',
                        lambda service, **kwargs: stepfunctions)
    monkeypatch.setenv('STATE_MACHINE_ARN', STATE_MACHINE_ARN)
    try:
        yield SimpleNamespace(module=module, stepfunctions=stepfunctions)
    finally:
        unload('metadata_orchestrator')


def s3_event(key, bucket='iep-uploads'):
    return {'Records': [{'s3': {'bucket': {'name': bucket}, 'object': {'key': key}}}]}


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


def test_malformed_key_is_a_client_error(orchestrator):
    response = run(orchestrator, s3_event('orphan-file.pdf'))
    assert response['statusCode'] == 400
    assert orchestrator.stepfunctions.executions == []


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
