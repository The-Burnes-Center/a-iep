"""Pins the upload pipeline's translation-failure guard directly on the ASL
JSON (lib/chatbot-api/state-machines/iep-processing.asl.json).

translate_content/handler.py can return languages_processed: [] (every
requested language failed) while still reporting success -- see
test_translate_content.py for that half of the fix. This machine's
TranslateParsingResult task used to discard its own output entirely
(ResultPath: null), so even a state-machine-level guard had nothing to read.
single-language-translation.asl.json already had a VerifyLanguageProduced
Choice state for exactly this failure shape; this pins the upload pipeline's
copy of it.

This lives in test/python/ rather than test/infra/ (the usual home for CDK
template assertions) because the ASL is read and asserted on directly here,
not synthesized from CDK -- test/infra/ is out of scope for this change.
"""
import json
import os

import pytest

ASL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'lib', 'chatbot-api', 'state-machines', 'iep-processing.asl.json',
)


@pytest.fixture()
def states():
    with open(ASL_PATH) as f:
        definition = json.load(f)
    return definition['States']


def test_translate_parsing_result_keeps_its_own_output(states):
    # ResultPath: null (the pre-fix value) throws the task's output away
    # entirely, so languages_processed never reaches the execution state and
    # no guard downstream can see it.
    task = states['TranslateParsingResult']
    assert task['ResultPath'] == '$.translation_result'


def test_translate_parsing_result_narrows_to_languages_processed_only(states):
    # Without a ResultSelector, the FULL translated content (every language's
    # summaries/sections) would land in $.translation_result -- and Step
    # Functions keeps state history for 90 days, so that would put
    # FERPA-protected document content in the console. Only the one field the
    # guard needs is kept, mirroring single-language-translation.asl.json's
    # TranslateRequestedLanguage state.
    task = states['TranslateParsingResult']
    assert task['ResultSelector'] == {'languages_processed.$': '$.languages_processed'}


def test_translate_parsing_result_routes_through_the_verification_gate(states):
    # UpdateTranslationProgress must not be reachable directly from
    # TranslateParsingResult: that would be the re-wiring that silently
    # bypasses the guard.
    assert states['TranslateParsingResult']['Next'] == 'VerifyLanguageProduced'
    assert states['TranslateParsingResult']['Next'] != 'UpdateTranslationProgress'


def test_verify_language_produced_gate_exists_and_is_wired_correctly(states):
    gate = states['VerifyLanguageProduced']
    assert gate['Type'] == 'Choice'

    choices = gate['Choices']
    assert len(choices) == 1
    assert choices[0]['Variable'] == '$.translation_result.languages_processed[0]'
    assert choices[0]['IsPresent'] is True
    assert choices[0]['Next'] == 'UpdateTranslationProgress'

    # A total failure must route to record_failure, not quietly proceed.
    assert gate['Default'] != 'UpdateTranslationProgress'


def test_the_failure_path_reaches_record_failure_with_a_named_step(states):
    gate = states['VerifyLanguageProduced']
    failure_entry = gate['Default']

    # Walk Pass states until RecordFailure, collecting ResultPath targets, so
    # this test does not hardcode the exact intermediate state names.
    result_paths = []
    current = failure_entry
    for _ in range(5):  # generous bound; real chain is 2 hops
        state = states[current]
        assert state['Type'] == 'Pass', (
            f"expected a Pass state synthesizing $.error/$.failed_step, got {state['Type']}")
        result_paths.append(state.get('ResultPath'))
        current = state['Next']
        if current == 'RecordFailure':
            break
    else:
        pytest.fail('Default branch of VerifyLanguageProduced never reaches RecordFailure')

    assert current == 'RecordFailure'
    # RecordFailure reads error_message.$: $.error.Cause and failed_step.$:
    # $.failed_step (see the RecordFailure task's own Parameters) -- both
    # must be synthesized somewhere along this chain, since nothing raised an
    # exception for a real Catch to populate them.
    assert '$.error' in result_paths
    assert '$.failed_step' in result_paths


def test_record_failure_task_reads_the_same_paths_this_guard_relies_on(states):
    # Documents this pin's dependency on RecordFailure's own contract, so a
    # future change to RecordFailure's Parameters is forced to reconsider it.
    record_failure = states['RecordFailure']
    params = record_failure['Parameters']['params']
    assert params['error_message.$'] == '$.error.Cause'
    assert params['failed_step.$'] == '$.failed_step'


def test_mistral_ocr_retries_a_permanent_client_error_zero_times(states):
    # OcrClientError (mistral_ocr/handler.py) means Mistral rejected the FILE
    # -- a password-protected PDF is the incident this was written for -- so
    # retrying an unchanged request is guaranteed to fail the same way three
    # more times. This retrier must be listed BEFORE the States.ALL one:
    # Step Functions uses the first Retry entry whose ErrorEquals matches.
    retriers = states['MistralOCR']['Retry']
    assert retriers[0]['ErrorEquals'] == ['OcrClientError']
    assert retriers[0]['MaxAttempts'] == 0


def test_mistral_ocr_still_retries_everything_else_three_times(states):
    # 5xx, 429, and a timeout/connection error (no status code at all) must
    # keep the original policy: these are transient, and the file may still
    # succeed on a later attempt.
    retriers = states['MistralOCR']['Retry']
    fallback = next(r for r in retriers if r['ErrorEquals'] == ['States.ALL'])
    assert fallback['MaxAttempts'] == 3


def test_mistral_ocr_permanent_failure_still_reaches_record_failure(states):
    # The zero-retry path must still fall into the same Catch as everything
    # else: a document rejected outright must be recorded FAILED, not left
    # PROCESSING with no execution failure Step Functions or RecordFailure
    # ever sees.
    catchers = states['MistralOCR']['Catch']
    assert any(c['ErrorEquals'] == ['States.ALL'] for c in catchers)


def test_a_partial_translation_success_is_not_caught_by_this_narrow_guard(states):
    # Documented, known limitation (matches the single-language machine's own
    # precedent): the Choice only checks languages_processed[0], i.e. "at
    # least one language succeeded." A partial failure (3 of 4 languages)
    # still passes. This test pins that the guard is exactly this narrow, so
    # widening it later is a deliberate choice, not an accidental regression
    # discovered in production.
    gate = states['VerifyLanguageProduced']
    assert gate['Choices'][0]['Variable'] == '$.translation_result.languages_processed[0]'
    assert 'target_languages' not in json.dumps(gate['Choices'])
