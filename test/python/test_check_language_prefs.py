"""check_language_prefs step tests.

This step decides whether a parent gets translated output at all: it reads
primaryLanguage/secondaryLanguage from the user profile and emits
target_languages for the translation branch. The error path is pinned
deliberately: today ANY profile-read failure silently downgrades a
non-English-speaking parent to English-only output while the pipeline still
reports success, so if that tradeoff ever changes it must change on purpose.
"""
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

PROFILES_TABLE = 'profiles-test'
USER = 'user-sub-1'


@pytest.fixture()
def step(monkeypatch):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        profiles = dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        module = load_lambda_module('metadata-handler/steps/check_language_prefs',
                                    'check_language_prefs_handler', module_name='handler')
        try:
            yield SimpleNamespace(module=module, profiles=profiles)
        finally:
            unload('check_language_prefs_handler')


def run(step, **event_extra):
    return step.module.lambda_handler({'user_id': USER, **event_extra}, None)


@pytest.mark.parametrize('profile, expected', [
    ({'primaryLanguage': 'es'}, {'es'}),
    ({'primaryLanguage': 'en'}, set()),
    ({'primaryLanguage': 'es', 'secondaryLanguage': 'vi'}, {'es', 'vi'}),
    ({'primaryLanguage': 'zh', 'secondaryLanguage': 'zh'}, {'zh'}),  # deduped
    ({'secondaryLanguage': 'pt'}, {'pt'}),
    ({'primaryLanguage': 'en', 'secondaryLanguage': 'en'}, set()),
    ({'primaryLanguage': '', 'secondaryLanguage': 'es'}, {'es'}),  # falsy skipped
    ({}, set()),
])
def test_language_combinations(step, profile, expected):
    step.profiles.put_item(Item={'userId': USER, **profile})
    result = run(step)
    assert set(result['target_languages']) == expected
    assert result['translation_needed'] is (len(expected) > 0)


def test_missing_profile_means_english_only(step):
    result = run(step)
    assert result['target_languages'] == []
    assert result['translation_needed'] is False


def test_profile_read_error_silently_downgrades_to_english_only(step, monkeypatch):
    """KNOWN FAIL-OPEN, pinned on purpose.

    A DynamoDB error is swallowed and the parent gets English-only output
    while the document still completes successfully; nothing retries and
    nothing alarms. The state machine already retries this step and routes
    persistent errors to RecordFailure, so raising instead would be the
    stricter option; until that call is made, this test keeps the silent
    downgrade visible.
    """
    step.profiles.put_item(Item={'userId': USER, 'primaryLanguage': 'es'})
    monkeypatch.setenv('USER_PROFILES_TABLE', 'no-such-table')
    result = run(step)
    assert result['target_languages'] == []
    assert result['translation_needed'] is False


def test_missing_user_id_fails_the_step(step):
    # Without user_id the step cannot know the parent's languages; the outer
    # handler re-raises so Step Functions retries and records the failure
    # rather than defaulting anyone to English.
    with pytest.raises(KeyError):
        step.module.lambda_handler({'iep_id': 'iep-1'}, None)


def test_event_passthrough_keeps_progress_tracking(step):
    # Unlike redact_ocr, this step intentionally preserves progress and
    # current_step (the state machine reads them back after the branch).
    step.profiles.put_item(Item={'userId': USER, 'primaryLanguage': 'vi'})
    result = run(step, progress=65, current_step='analysis_complete',
                 s3_bucket='iep-uploads', iep_id='iep-1')
    assert result['progress'] == 65
    assert result['current_step'] == 'analysis_complete'
    assert result['s3_bucket'] == 'iep-uploads'
    assert result['iep_id'] == 'iep-1'
    assert result['target_languages'] == ['vi']
