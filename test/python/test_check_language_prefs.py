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
SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'


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
        # The same decision, as the OCR step now makes it (language_prefs.py).
        folded = load_lambda_module('metadata-handler/steps/mistral_ocr',
                                    'ocr_language_prefs', module_name='language_prefs')
        try:
            yield SimpleNamespace(module=module, profiles=profiles, folded=folded)
        finally:
            unload('check_language_prefs_handler')
            unload('ocr_language_prefs')


def run(step, **event_extra):
    return step.module.lambda_handler({'user_id': USER, **event_extra}, None)


PROFILE_CASES = [
    ({'primaryLanguage': 'es'}, {'es'}),
    ({'primaryLanguage': 'en'}, set()),
    ({'primaryLanguage': 'es', 'secondaryLanguage': 'vi'}, {'es', 'vi'}),
    ({'primaryLanguage': 'zh', 'secondaryLanguage': 'zh'}, {'zh'}),  # deduped
    ({'secondaryLanguage': 'pt'}, {'pt'}),
    ({'primaryLanguage': 'en', 'secondaryLanguage': 'en'}, set()),
    ({'primaryLanguage': '', 'secondaryLanguage': 'es'}, {'es'}),  # falsy skipped
    ({}, set()),
]


@pytest.mark.parametrize('profile, expected', PROFILE_CASES)
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


def test_outer_catch_all_never_logs_the_rejected_value(step, monkeypatch, capsys):
    """The outermost catch-all used to print(str(e)) and
    traceback.format_exc() verbatim -- the last uncovered path by which a
    rejected value could reach CloudWatch after f48b08f's fixes elsewhere in
    the pipeline. boto3.resource is patched (rather than table.get_item,
    which the inner try/except already swallows without re-raising) so the
    sentinel-bearing exception reaches the OUTER handler instead."""
    def _boom(*a, **kw):
        raise Exception(SENTINEL)
    monkeypatch.setattr(step.module, 'boto3', SimpleNamespace(resource=_boom))

    with pytest.raises(Exception):
        run(step)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives


def test_event_passthrough_keeps_progress_tracking(step):
    # Unlike redact_ocr, this step intentionally preserves progress and
    # current_step (the state machine reads them back after the branch).
    step.profiles.put_item(Item={'userId': USER, 'primaryLanguage': 'vi'})
    result = run(step, progress=75, current_step='analysis_complete',
                 s3_bucket='iep-uploads', iep_id='iep-1')
    assert result['progress'] == 75
    assert result['current_step'] == 'analysis_complete'
    assert result['s3_bucket'] == 'iep-uploads'
    assert result['iep_id'] == 'iep-1'
    assert result['target_languages'] == ['vi']


# ---------------------------------------------------------------------------
# The same decision, made inside the OCR step (mistral_ocr/language_prefs.py).
#
# Every step lambda is bundled separately, so the OCR step carries its own copy
# of this logic. These run both against the same profiles and require the same
# answer, so the two cannot drift apart while this step remains deployed.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('profile, expected', PROFILE_CASES)
def test_the_ocr_step_decides_exactly_as_this_step_does(step, profile, expected):
    step.profiles.put_item(Item={'userId': USER, **profile})

    from_step = run(step)
    from_ocr = step.folded.target_languages_for(USER)

    assert set(from_ocr) == expected
    assert set(from_ocr) == set(from_step['target_languages'])
    assert len(from_ocr) == len(set(from_ocr))  # no duplicates
    assert (len(from_ocr) > 0) is from_step['translation_needed']


def test_the_ocr_step_has_no_profile_means_english_only(step):
    assert step.folded.target_languages_for(USER) == []


def test_the_ocr_step_keeps_the_pinned_fail_open_on_a_read_error(step, monkeypatch, capsys):
    step.profiles.put_item(Item={'userId': USER, 'primaryLanguage': 'es'})
    monkeypatch.setenv('USER_PROFILES_TABLE', 'no-such-table')

    assert step.folded.target_languages_for(USER) == []
    # The SDK's message carries table names and request ids; the class is enough.
    assert 'no-such-table' not in capsys.readouterr().out


def test_the_ocr_step_still_fails_loudly_when_the_table_is_not_configured(step, monkeypatch):
    # Configuration, not a read failure: silently defaulting every parent to
    # English because an env var was dropped would be far worse than the pinned
    # fail-open above.
    monkeypatch.delenv('USER_PROFILES_TABLE')

    with pytest.raises(KeyError):
        step.folded.target_languages_for(USER)


def test_the_ocr_step_treats_a_malformed_profile_as_no_translation(step):
    # A language attribute that is not a string (a list, say) used to land in
    # the same swallow-and-default-to-English path as a failed read.
    step.profiles.put_item(Item={'userId': USER, 'primaryLanguage': ['es']})

    assert step.folded.target_languages_for(USER) == []
