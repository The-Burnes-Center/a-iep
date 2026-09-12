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
import os
import re
from types import SimpleNamespace

import boto3
import pytest
import requests
from moto import mock_aws

from conftest import REPO_ROOT, load_lambda_module, unload

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
            # response=self matches the real requests.Response.raise_for_status,
            # which is how _http_status_code (mistral_ocr.py) recovers the
            # status code from the exception. Omitting it here would make every
            # test pass while the real 4xx/5xx split (handler.py's
            # OcrClientError) went unexercised.
            raise requests.exceptions.HTTPError(f'{self.status_code} error', response=self)

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
# Stop retrying a permanent OCR failure: a password-protected PDF gets a 400
# from Mistral's OCR call every time, so all three of the state machine's
# retries were guaranteed to fail. process_document_with_mistral_ocr's half
# of the fix is surfacing the HTTP status code so handler.py can tell a
# permanent 4xx apart from a transient failure (see test_handler below, and
# iep-processing.asl.json's MistralOCR Retry).
# ---------------------------------------------------------------------------

def test_a_4xx_from_the_ocr_call_surfaces_its_status_code(mistral_ocr_module, monkeypatch):
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests([
            _FakeResponse({'id': 'file-1'}),                    # upload succeeds
            _FakeResponse({'url': 'https://signed.example/x'}),  # signed url succeeds
            _FakeResponse({}, status_code=400),                  # OCR call itself is rejected
        ])
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        result = mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert result['status_code'] == 400
    assert 'error' in result


def test_a_5xx_from_the_ocr_call_surfaces_its_status_code_too(mistral_ocr_module, monkeypatch):
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests([
            _FakeResponse({'id': 'file-1'}),
            _FakeResponse({'url': 'https://signed.example/x'}),
            _FakeResponse({}, status_code=503),
        ])
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        result = mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert result['status_code'] == 503


def test_a_timeout_carries_no_status_code_at_all(mistral_ocr_module, monkeypatch):
    # No response was ever received, so there is no status to extract. This is
    # what keeps a hung provider on the transient (retryable) path.
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests([
            requests.exceptions.ReadTimeout('Mistral did not respond in time'),
        ])
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        result = mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert result['status_code'] is None


def test_a_4xx_at_the_upload_step_also_surfaces_its_status_code(mistral_ocr_module, monkeypatch):
    # The reasoning ("this file will never be accepted") applies just as much
    # to a rejection at upload as at the final OCR call.
    with mock_aws():
        _wire_s3_object()
        fake_requests = _RecordingRequests([_FakeResponse({}, status_code=413)])
        monkeypatch.setattr(mistral_ocr_module, 'requests', fake_requests)

        result = mistral_ocr_module.process_document_with_mistral_ocr(BUCKET, KEY)

    assert result['status_code'] == 413


# ---------------------------------------------------------------------------
# The content type declared to Mistral must follow the file the parent picked.
#
# It was hardcoded to 'application/pdf'. The uploader offers .doc and .docx as
# well (UploadIEPDocument.tsx), and Mistral's OCR processor supports both, so
# the only thing wrong with a Word upload was the lie in the multipart part --
# which Mistral answers with a 422, which is a non-429 4xx, which handler.py
# retries zero times. Every Word document a parent uploaded failed permanently
# after a full wait on the processing screen; one of them is the 422 recorded
# in scripts/audit-residue.py's docblock.
# ---------------------------------------------------------------------------

DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def _content_type_sent_to_mistral(module, monkeypatch, filename):
    """Run an upload for `filename` and return the multipart part's MIME type."""
    key = f'user-1/child-1/iep-1/{filename}'
    with mock_aws():
        _wire_s3_object(key=key, body=b'fake document bytes')
        fake_requests = _RecordingRequests(list(SUCCESSFUL_SEQUENCE))
        monkeypatch.setattr(module, 'requests', fake_requests)

        result = module.process_document_with_mistral_ocr(BUCKET, key)

    assert 'error' not in result
    upload_call = fake_requests.calls[0]
    assert upload_call['url'] == 'https://api.mistral.ai/v1/files'
    _sent_filename, _sent_bytes, content_type = upload_call['kwargs']['files']['file']
    return content_type


@pytest.mark.parametrize('filename, expected', [
    (f'{STUDENT_NAME} IEP 2026.pdf', 'application/pdf'),
    (f'{STUDENT_NAME} IEP 2026.doc', 'application/msword'),
    (f'{STUDENT_NAME} IEP 2026.docx', DOCX_CONTENT_TYPE),
])
def test_the_upload_declares_the_type_of_the_file_the_parent_actually_picked(
        mistral_ocr_module, monkeypatch, filename, expected):
    assert _content_type_sent_to_mistral(mistral_ocr_module, monkeypatch, filename) == expected


def test_the_extension_is_matched_regardless_of_its_case(mistral_ocr_module, monkeypatch):
    # A parent's file picker hands over whatever the file is actually named,
    # and Windows still writes .DOC/.DOCX. Case must not decide whether the
    # document is processed or permanently rejected.
    assert _content_type_sent_to_mistral(
        mistral_ocr_module, monkeypatch, 'IEP 2026.DOCX') == DOCX_CONTENT_TYPE


@pytest.mark.parametrize('filename', ['IEP 2026.rtf', 'IEP 2026'])
def test_an_unrecognised_file_is_never_announced_as_a_pdf(
        mistral_ocr_module, monkeypatch, filename):
    # Nothing the uploader offers lands here, but if something ever does, the
    # fallback must not repeat the original defect by asserting a type the
    # bytes are not. It says "unknown bytes" instead, which is true.
    content_type = _content_type_sent_to_mistral(mistral_ocr_module, monkeypatch, filename)
    assert content_type == 'application/octet-stream'


def test_every_extension_the_uploader_offers_has_a_content_type(mistral_ocr_module):
    """The pin that would have caught this when .doc was added to the picker.

    The two halves live in different languages and different directories, so
    nothing else stops the file picker from gaining a format this step cannot
    name. Read the uploader's own allowlist and require an entry for each.
    """
    uploader = os.path.join(REPO_ROOT, 'lib', 'user-interface', 'app', 'src',
                            'pages', 'iep-folder', 'UploadIEPDocument.tsx')
    with open(uploader, encoding='utf-8') as handle:
        source = handle.read()

    match = re.search(r'fileExtensions\s*=\s*new Set\(\[(.*?)\]\)', source, re.S)
    # Not a soft skip: a test that quietly passes when it can no longer find
    # what it checks is worse than no test at all.
    assert match, ('Could not find fileExtensions in UploadIEPDocument.tsx. If the '
                   'file picker was refactored, point this test at the new allowlist '
                   'rather than deleting it.')
    offered = re.findall(r'["\']([^"\']+)["\']', match.group(1))
    assert offered, 'fileExtensions parsed as empty; the regex above needs updating'

    missing = [ext for ext in offered
               if ext.lower() not in mistral_ocr_module._CONTENT_TYPE_BY_EXTENSION]
    assert not missing, (
        f'The uploader accepts {missing} but mistral_ocr.py has no content type for '
        'them, so they would be uploaded as application/octet-stream. Add them to '
        '_CONTENT_TYPE_BY_EXTENSION, or stop offering them at the file picker.')


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


# ---------------------------------------------------------------------------
# handler.py's half of "stop retrying a permanent OCR failure": which
# exception class it raises for a given status_code, which is what
# iep-processing.asl.json's MistralOCR Retry actually matches on.
# ---------------------------------------------------------------------------

def _ocr_result_with_status(status_code):
    return {'error': '400 Client Error: Bad Request for url: https://api.mistral.ai/v1/ocr',
            'status_code': status_code}


@pytest.mark.parametrize('status_code', [400, 401, 403, 404, 413, 422, 499])
def test_a_4xx_other_than_429_raises_ocr_client_error(handler_module, monkeypatch, status_code):
    monkeypatch.setattr(
        handler_module, 'process_document_with_mistral_ocr',
        lambda bucket, key: _ocr_result_with_status(status_code))

    event = {
        'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
        's3_bucket': BUCKET, 's3_key': KEY,
    }
    with pytest.raises(handler_module.OcrClientError):
        handler_module.lambda_handler(event, None)


@pytest.mark.parametrize('status_code', [429, 500, 502, 503, None])
def test_429_and_5xx_and_no_status_all_stay_on_the_retryable_path(
        handler_module, monkeypatch, status_code):
    monkeypatch.setattr(
        handler_module, 'process_document_with_mistral_ocr',
        lambda bucket, key: _ocr_result_with_status(status_code))

    event = {
        'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
        's3_bucket': BUCKET, 's3_key': KEY,
    }
    with pytest.raises(Exception) as exc_info:
        handler_module.lambda_handler(event, None)

    # A bare Exception, specifically NOT the permanent-failure subclass: the
    # state machine's States.ALL retrier (not the zero-attempt one) must
    # catch this.
    assert type(exc_info.value) is Exception
    assert not isinstance(exc_info.value, handler_module.OcrClientError)


def test_ocr_client_error_message_stays_content_free(handler_module, monkeypatch):
    # Same content-free contract as every other error this pipeline raises
    # (f48b08f): the message is built from ocr_result['error'], which is
    # already just the provider's HTTP error text (status + a fixed Mistral
    # URL), never document content -- confirmed here so the new raise site
    # does not regress it.
    monkeypatch.setattr(
        handler_module, 'process_document_with_mistral_ocr',
        lambda bucket, key: _ocr_result_with_status(400))

    event = {
        'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
        's3_bucket': BUCKET, 's3_key': KEY,
    }
    with pytest.raises(handler_module.OcrClientError) as exc_info:
        handler_module.lambda_handler(event, None)

    assert STUDENT_NAME not in str(exc_info.value)
    assert KEY not in str(exc_info.value)
