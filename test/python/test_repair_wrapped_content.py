"""scripts/repair-wrapped-content.py tests.

This script rewrites FERPA-protected content in place, so the guards that
matter are: it must not touch a file that is already fine, it must not write
anything at all without --apply, and a repair it reports must actually be a
repair (it re-reads to check, because a no-op write would make the next run
report the bucket clean).

The detector is the other half: a section legitimately keyed 'content' must
not be mistaken for a DynamoDB {'S': ...} wrapper and flattened.
"""
import importlib.util
import json
import os
import sys

import boto3
import pytest
from moto import mock_aws

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO_ROOT, 'scripts', 'repair-wrapped-content.py')

BUCKET = 'ai-iep-knowledge-source-dev'
KEY = 'iep-data/iep-1/child-1/content.json'

SUMMARY = 'The English summary paragraph.'


@pytest.fixture(scope='module')
def repair():
    spec = importlib.util.spec_from_file_location('repair_wrapped_content', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules['repair_wrapped_content'] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop('repair_wrapped_content', None)


WRAPPED = {
    'summaries': {'en': {'S': SUMMARY}},
    'sections': {'en': {'L': [
        {'M': {'title': {'S': 'Goals'}, 'content': {'S': 'Body'},
               'page_numbers': {'L': [{'N': '3'}]}}},
    ]}},
    'document_index': {'en': {'S': 'Index text'}},
    'abbreviations': {},
}

PLAIN = {
    'summaries': {'en': SUMMARY},
    'sections': {'en': [{'title': 'Goals', 'content': 'Body', 'page_numbers': [3]}]},
    'document_index': {'en': 'Index text'},
    'abbreviations': {},
}


@pytest.fixture()
def s3(repair):
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        yield client


def put(s3, content, key=KEY):
    s3.put_object(Bucket=BUCKET, Key=key,
                  Body=json.dumps(content, ensure_ascii=False).encode('utf-8'))


def stored(s3, key=KEY):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())


# ---------------------------------------------------------------------------
# The detector

def test_spots_every_wrapped_content_field(repair):
    assert sorted(repair.wrapped_fields(WRAPPED)) == ['document_index', 'sections', 'summaries']


def test_reports_nothing_for_content_that_is_already_plain(repair):
    assert repair.wrapped_fields(PLAIN) == []


def test_a_section_key_named_content_is_not_a_type_descriptor(repair):
    """'content' is a real field name in a section. A single-key dict is only
    a wrapper when the key is a DynamoDB type letter."""
    assert repair.wrapped_fields({'sections': {'en': [{'content': 'Body'}]}}) == []


def test_unwrapping_produces_the_shape_the_page_indexes(repair):
    assert repair.clean_dynamodb_json(WRAPPED) == PLAIN


# ---------------------------------------------------------------------------
# Guards

def test_dry_run_writes_nothing(repair, s3):
    put(s3, WRAPPED)
    before = s3.head_object(Bucket=BUCKET, Key=KEY)['ETag']

    assert repair.repair_one(s3, BUCKET, KEY, apply_changes=False) == 'would-repair'

    assert s3.head_object(Bucket=BUCKET, Key=KEY)['ETag'] == before
    assert stored(s3) == WRAPPED  # untouched, wrapper and all


def test_apply_rewrites_the_object_and_verifies_it(repair, s3):
    put(s3, WRAPPED)

    assert repair.repair_one(s3, BUCKET, KEY, apply_changes=True) == 'repaired'

    assert stored(s3) == PLAIN


def test_an_already_plain_file_is_skipped_not_rewritten(repair, s3):
    put(s3, PLAIN)
    before = s3.head_object(Bucket=BUCKET, Key=KEY)['ETag']

    assert repair.repair_one(s3, BUCKET, KEY, apply_changes=True) == 'clean'

    assert s3.head_object(Bucket=BUCKET, Key=KEY)['ETag'] == before


def test_running_twice_is_a_no_op_the_second_time(repair, s3):
    put(s3, WRAPPED)
    assert repair.repair_one(s3, BUCKET, KEY, apply_changes=True) == 'repaired'
    assert repair.repair_one(s3, BUCKET, KEY, apply_changes=True) == 'clean'
    assert stored(s3) == PLAIN


def test_a_write_that_did_not_take_is_reported_as_an_error(repair, s3, monkeypatch):
    """The failure that would otherwise hide: a put that silently does
    nothing leaves the next run reporting the bucket clean."""
    put(s3, WRAPPED)
    monkeypatch.setattr(s3, 'put_object', lambda **kwargs: {})

    assert repair.repair_one(s3, BUCKET, KEY, apply_changes=True) == 'error'


def test_never_prints_document_content(repair, s3, capsys):
    put(s3, WRAPPED)
    repair.repair_one(s3, BUCKET, KEY, apply_changes=True)

    logged = capsys.readouterr().out
    assert SUMMARY not in logged
    assert 'Index text' not in logged
    assert 'summaries' in logged  # the FIELD name is what gets reported
    assert KEY in logged


# ---------------------------------------------------------------------------
# Listing

def test_only_content_json_is_considered(repair, s3):
    """The prefix also holds OCR payloads, which this script must not rewrite."""
    put(s3, WRAPPED)
    s3.put_object(Bucket=BUCKET, Key='iep-data/iep-1/child-1/redacted_ocr_result.json',
                  Body=b'{}')

    assert list(repair.iter_content_keys(s3, BUCKET)) == [KEY]


def test_a_single_iep_id_scopes_the_scan(repair, s3):
    put(s3, WRAPPED)
    put(s3, WRAPPED, key='iep-data/iep-2/child-9/content.json')

    assert list(repair.iter_content_keys(s3, BUCKET, iep_id='iep-2')) == [
        'iep-data/iep-2/child-9/content.json']
