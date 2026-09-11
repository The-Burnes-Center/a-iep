"""mistral_ocr: request timeouts (Item 4) plus the filename/key leaks fixed
alongside them in the same file (Item 1 and Item 2).

requests has no default timeout -- an unresponsive Mistral endpoint hangs the
call indefinitely -- and with MistralOCRFunction's 600s Lambda timeout plus
the state machine's MaxAttempts: 3, that used to mean up to ~40 minutes of a
parent's progress bar per document. Every requests.post/get call must carry
an explicit (connect, read) timeout tuple.
"""
import json
import logging
from types import SimpleNamespace

import boto3
import pytest
import requests
from moto import mock_aws

from conftest import load_lambda_module, unload

BUCKET = 'iep-uploads-test'
STUDENT_NAME = 'Jordan Smith'
KEY = f'user-1/child-1/iep-1/{STUDENT_NAME} IEP 2026.pdf'
SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'


class _FakeResponse:
    def __init__(self, json_data=None, status_code=200):
        self._json_data = json_data if json_data is not None else {}
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f'{self.status_code} error')

    def json(self):
        return self._json_data


class _RecordingRequests:
    """Stand-in for the `requests` module: records every post/get call's
    kwargs (specifically `timeout`) and returns scripted responses in the
    order calls are made. A response that is an Exception instance is raised
    instead of returned, so a test can script a mid-sequence timeout."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []
        # process_document_with_mistral_ocr also references these directly.
        self.exceptions = requests.exceptions

    def _next(self, method, url, **kwargs):
        self.calls.append({'method': method, 'url': url, 'kwargs': kwargs})
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def post(self, url, **kwargs):
        return self._next('POST', url, **kwargs)

    def get(self, url, **kwargs):
        return self._next('GET', url, **kwargs)


SUCCESSFUL_SEQUENCE = [
    _FakeResponse({'id': 'file-1'}),                       # upload
    _FakeResponse({'url': 'https://signed.example/x'}),    # signed url
    _FakeResponse({'pages': [{'index': 0, 'markdown': 'hi'}]}),  # ocr
]


@pytest.fixture()
def mistral_ocr_module(monkeypatch):
    monkeypatch.setenv('MISTRAL_API_KEY', 'test-mistral-key')
    module = load_lambda_module('metadata-handler/steps/mistral_ocr',
                                'mistral_ocr_under_test', module_name='mistral_ocr')
    try:
        yield module
    finally:
        unload('mistral_ocr_under_test')


def _wire_s3_object(bucket=BUCKET, key=KEY, body=b'%PDF-1.4 fake pdf bytes'):
    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket=bucket)
    s3.put_object(Bucket=bucket, Key=key, Body=body)
    return s3


def test_every_request_call_carries_an_explicit_timeout(mistral_ocr_module, monkeypatch):
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests(list(SUCCESSFUL_SEQUENCE))
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        result = mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert 'error' not in result
    assert len(fake_requests.calls) == 3
    for call in fake_requests.calls:
        timeout = call['kwargs'].get('timeout')
        assert timeout is not None, f"{call['method']} {call['url']} had no timeout"
        connect, read = timeout  # unpacking alone proves this is a 2-tuple,
        assert connect > 0       # not the single scalar requests also accepts
        assert read > 0          # (and which would misapply one bound to both phases)
    # Every call stays comfortably under the Lambda's own 600s timeout so a
    # hung provider is caught by this code, not by Lambda's SIGKILL.
    assert all(sum(call['kwargs']['timeout']) < 600 for call in fake_requests.calls)


def test_a_provider_timeout_is_returned_as_a_clean_error_not_an_unhandled_exception(
        mistral_ocr_module, monkeypatch):
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests([
            requests.exceptions.ReadTimeout('Mistral did not respond in time'),
        ])
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        result = mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert 'error' in result
    assert len(fake_requests.calls) == 1  # failed on the first call (upload); did not proceed


# ---------------------------------------------------------------------------
# Item 2 (same file): the S3 key / filename must not reach these log lines.
# ---------------------------------------------------------------------------

def test_download_and_encoding_logs_never_carry_the_filename(mistral_ocr_module, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    with mock_aws():
        # An already-URL-safe key (no re-encoding branch) still exercises the
        # "Downloading document from S3" log line.
        _wire_s3_object()
        fake_requests = _RecordingRequests(list(SUCCESSFUL_SEQUENCE))
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert STUDENT_NAME not in caplog.text
    assert 'user-1/child-1/iep-1' in caplog.text  # ids still present and useful


def test_upload_and_download_logs_never_carry_the_filename_either(mistral_ocr_module, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests(list(SUCCESSFUL_SEQUENCE))
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    # "Successfully downloaded file" and "Uploading file to Mistral" used to
    # interpolate the bare filename split off the key.
    assert STUDENT_NAME not in caplog.text


# ---------------------------------------------------------------------------
# Item 1 (handler.py, same lambda): the JSON-rejection message must carry the
# file extension only, never the key -- it is raised and ends up as
# error_message on the document row via $.error.Cause, not just printed.
# ---------------------------------------------------------------------------

@pytest.fixture()
def handler_module():
    module = load_lambda_module('metadata-handler/steps/mistral_ocr',
                                'mistral_ocr_handler_under_test', module_name='handler')
    try:
        yield module
    finally:
        unload('mistral_ocr_handler_under_test')


def test_json_file_rejection_message_carries_no_key_or_filename(handler_module, capsys):
    event = {
        'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
        's3_bucket': BUCKET, 's3_key': KEY,  # KEY ends in .pdf; force the json branch instead
    }
    event['s3_key'] = f'user-1/child-1/iep-1/{STUDENT_NAME} content.json'

    with pytest.raises(Exception) as exc_info:
        handler_module.lambda_handler(event, None)

    message = str(exc_info.value)
    assert STUDENT_NAME not in message
    assert 'content.json' not in message
    assert 'user-1/child-1/iep-1' not in message

    logged = capsys.readouterr().out
    assert STUDENT_NAME not in logged


def test_outer_catch_all_never_logs_the_rejected_value(handler_module, monkeypatch, capsys):
    """The outermost catch-all used to print(str(e)) and
    traceback.format_exc() verbatim -- the last uncovered path by which a
    rejected value could reach CloudWatch after f48b08f's fixes elsewhere in
    the pipeline."""
    def _boom(bucket, key):
        raise Exception(SENTINEL)
    monkeypatch.setattr(handler_module, 'process_document_with_mistral_ocr', _boom)

    event = {
        'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
        's3_bucket': BUCKET, 's3_key': KEY,
    }
    with pytest.raises(Exception):
        handler_module.lambda_handler(event, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives
