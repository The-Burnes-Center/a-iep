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
    updated = {}

    class _RecordingTable:
        def update_item(self, **kwargs):
            updated.update(kwargs)

    result = s3_content_handler.module.migrate_dynamodb_to_s3(
        IEP, CHILD, {'summaries': {'en': 'Hello'}}, _RecordingTable())

    assert result['bucket'] == BUCKET
    assert updated['Key'] == {'iepId': IEP, 'childId': CHILD}
