"""s3_content_handler.py: migrate_dynamodb_to_s3's own catch-all.

migrate_dynamodb_to_s3 catches its own exception and returns None rather than
re-raising (a migration failure must not fail the get_document_with_content
read it rides along with; the legacy inline fields are still served). Its
except block used to print str(e) and traceback.format_exc() verbatim: the
content dict being migrated (summaries/sections/document_index/abbreviations)
is exactly what CLAUDE.md says must never reach a log, and a failure while
saving it -- e.g. from save_content_to_s3 -- is one of the few places in this
file that could realistically quote it. traceback.format_exc()'s last line
renders str(e) too, so the traceback matters as much as the summary line.

Loaded by path via conftest.load_lambda_module, same as every other suite
here, rather than imported as a copy.
"""
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

BUCKET = 'metadata-bucket-test'
IEP, CHILD = 'iep-1', 'child-1'
SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'


class _FakeTable:
    """update_item stub: migrate_dynamodb_to_s3 must not reach it once
    save_content_to_s3 has already failed."""
    def update_item(self, **kwargs):
        raise AssertionError('update_item should not run when save_content_to_s3 fails')


class _RecordingTable:
    """Captures the update_item call so a test can assert the row was rewritten."""
    def __init__(self):
        self.updated = {}

    def update_item(self, **kwargs):
        self.updated.update(kwargs)


@pytest.fixture()
def s3_content_handler(monkeypatch):
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        monkeypatch.setenv('BUCKET', BUCKET)
        module = load_lambda_module('metadata-handler/ddb-service',
                                    's3_content_handler_under_test',
                                    module_name='s3_content_handler')
        try:
            yield SimpleNamespace(module=module, s3=s3)
        finally:
            unload('s3_content_handler_under_test')


def test_migration_failure_never_logs_the_content_being_migrated(
        s3_content_handler, monkeypatch, capsys):
    def explode(*args, **kwargs):
        raise Exception(f"S3 put failed for content containing: {SENTINEL}")

    monkeypatch.setattr(s3_content_handler.module, 'save_content_to_s3', explode)

    result = s3_content_handler.module.migrate_dynamodb_to_s3(
        IEP, CHILD, {'summaries': {'en': SENTINEL}}, _FakeTable())

    assert result is None  # failure path is swallowed, not raised
    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Error migrating' in logged
    assert 'Exception' in logged  # the class name survives
    assert 'Traceback (most recent call last)' not in logged  # format_tb, not format_exc


def test_migration_success_is_unaffected(s3_content_handler):
    """Sanity check that the fixture/module wiring is real: a successful
    migration still writes to S3 and updates the row."""
    table = _RecordingTable()

    result = s3_content_handler.module.migrate_dynamodb_to_s3(
        IEP, CHILD, {'summaries': {'en': 'Hello'}}, table)

    assert result['bucket'] == BUCKET
    assert table.updated['Key'] == {'iepId': IEP, 'childId': CHILD}


def _stored_content(s3, iep=IEP, child=CHILD):
    key = f'iep-data/{iep}/{child}/content.json'
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())


def test_migration_unwraps_dynamodb_type_descriptors(s3_content_handler):
    """The oldest rows stored content already serialized. Copying that into
    content.json verbatim is one-way, and every reader afterwards gets an
    object where a string belongs -- which is what blanks the summary screen.

    Fails before the clean_dynamodb_json call in migrate_dynamodb_to_s3:
    summaries['en'] comes back as {'S': 'Plain summary text'}.
    """
    legacy_item = {
        'summaries': {'en': {'S': 'Plain summary text'}, 'zh': {'S': '中文'}},
        'sections': {'en': {'L': [
            {'M': {'title': {'S': 'Goals'}, 'content': {'S': 'Body'},
                   'page_numbers': {'L': [{'N': '3'}]}}},
        ]}},
        'document_index': {'en': {'S': 'Index text'}},
        'abbreviations': {},
    }

    result = s3_content_handler.module.migrate_dynamodb_to_s3(
        IEP, CHILD, legacy_item, _RecordingTable())
    assert result['bucket'] == BUCKET

    content = _stored_content(s3_content_handler.s3)

    # The shapes the frontend actually indexes: a string it can .split, and a
    # list it can .map. Asserting the type is the point -- a truthy object
    # passes every existence check the page makes and then throws on use.
    assert content['summaries']['en'] == 'Plain summary text'
    assert content['summaries']['zh'] == '中文'
    assert isinstance(content['document_index']['en'], str)

    sections = content['sections']['en']
    assert isinstance(sections, list) and len(sections) == 1
    assert sections[0]['title'] == 'Goals'
    assert sections[0]['content'] == 'Body'
    assert sections[0]['page_numbers'] == [3]  # N unwraps to a number, not '3'


def test_migration_leaves_already_plain_content_alone(s3_content_handler):
    """Everything written since the pipeline moved to S3 is already plain.
    Unwrapping must be a no-op on it, not a second pass that mangles it."""
    plain_item = {
        'summaries': {'en': 'Already plain'},
        'sections': {'en': [{'title': 'Goals', 'content': 'Body', 'page_numbers': [3]}]},
        'document_index': {'en': 'Index text'},
        'abbreviations': {'en': [{'abbreviation': 'IEP', 'meaning': 'Individualized...'}]},
    }

    s3_content_handler.module.migrate_dynamodb_to_s3(
        IEP, CHILD, plain_item, _RecordingTable())

    assert _stored_content(s3_content_handler.s3) == plain_item


def test_migration_does_not_mistake_content_for_a_type_descriptor(s3_content_handler):
    """A single-key dict is only a wrapper when the key is a DynamoDB type
    letter. A section legitimately keyed 'content' stays a dict."""
    item = {'summaries': {'en': 'text'}, 'sections': {'en': [{'content': 'Body'}]}}

    s3_content_handler.module.migrate_dynamodb_to_s3(
        IEP, CHILD, item, _RecordingTable())

    assert _stored_content(s3_content_handler.s3)['sections']['en'] == [{'content': 'Body'}]
