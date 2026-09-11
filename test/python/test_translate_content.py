"""translate_content: two independent fixes sharing one file.

1. (Item 1 -- content in logs) OptimizedTranslationAgent._validate_parsing_result
   validates each translated section/abbreviation with pydantic and, on
   failure, used to log str(e) verbatim -- which for a ValidationError quotes
   the translated document text it rejected.

2. (Item 3 -- silent translation failure) translate_content/handler.py used to
   return `{content_type}_translation_completed: True` even when every
   language failed, so a document could be marked PROCESSED with the parent's
   language simply missing and no failure recorded anywhere. This pins the
   handler's half of the fix: `_translation_completed` now reflects whether
   anything actually came back. The state machine's half (VerifyLanguageProduced
   reading languages_processed) is pinned in test_iep_processing_state_machine.py,
   since test/infra is out of scope for this change and the ASL has no CDK
   template of its own to synth against here.

openai / openai-agents / pydantic are stubbed throughout (see
conftest.install_agents_sdk_stubs): CI's test/python/requirements.txt installs
only boto3 + moto + pytest, and the lambda's own pydantic pin has no wheel for
every Python these suites run under.
"""
import json
import logging
from types import ModuleType, SimpleNamespace

import pytest

from conftest import (FakeLambdaClient, ScopedBoto3, install_agents_sdk_stubs,
                      load_lambda_module, unload)

SENTINEL = 'Sentinel-Avery-Chen-4b21-do-not-log-this'


# ---------------------------------------------------------------------------
# Item 1: translation_agent.py's per-section/abbreviation validation logging
# ---------------------------------------------------------------------------

class _FakeModelWithControllableValidation:
    next_error = None

    @classmethod
    def model_validate(cls, data):
        if cls.next_error is not None:
            raise cls.next_error
        return SimpleNamespace(model_dump=lambda: data)


@pytest.fixture()
def translation_module(monkeypatch):
    agents_stub, pydantic_stub = install_agents_sdk_stubs(monkeypatch)

    section_model = type('FakeTranslationSectionContent',
                         (_FakeModelWithControllableValidation,), {'next_error': None})
    abbrev_model = type('FakeAbbreviationLegend',
                        (_FakeModelWithControllableValidation,), {'next_error': None})
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = section_model
    data_model_stub.AbbreviationLegend = abbrev_model
    monkeypatch.setitem(__import__('sys').modules, 'data_model', data_model_stub)

    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translate_content_validation_agent',
                                module_name='translation_agent')
    try:
        yield SimpleNamespace(module=module, pydantic=pydantic_stub,
                              section_model=section_model, abbrev_model=abbrev_model)
    finally:
        unload('translate_content_validation_agent')
        unload('config')


def _validation_error(translation_module, input_value, loc):
    return translation_module.pydantic.ValidationError(
        errors=[{'loc': loc, 'type': 'string_type',
                 'msg': 'Input should be a valid string', 'input': input_value}],
        model_name='TranslationSectionContent',
    )


def test_section_validation_failure_never_logs_the_translated_text(translation_module, caplog):
    caplog.set_level(logging.INFO)
    translation_module.section_model.next_error = _validation_error(
        translation_module, SENTINEL, loc=('content',))
    agent = translation_module.module.OptimizedTranslationAgent()

    result = agent._validate_parsing_result(
        {'sections': [{'title': 'Goals', 'content': SENTINEL, 'page_numbers': [1]}]})

    assert SENTINEL not in caplog.text
    assert 'ValidationError' in caplog.text
    # The fallback keeps the untouched section in the DATA (it is, after all,
    # the actual translated content) -- only the LOG line is redacted.
    assert result['sections'][0]['content'] == SENTINEL


def test_abbreviation_validation_failure_never_logs_the_translated_text(translation_module, caplog):
    caplog.set_level(logging.INFO)
    translation_module.abbrev_model.next_error = _validation_error(
        translation_module, SENTINEL, loc=('full_form',))
    agent = translation_module.module.OptimizedTranslationAgent()

    result = agent._validate_parsing_result(
        {'abbreviations': [{'abbreviation': 'IEP', 'full_form': SENTINEL}]})

    assert SENTINEL not in caplog.text
    assert 'ValidationError' in caplog.text
    assert result['abbreviations'][0]['full_form'] == SENTINEL


# ---------------------------------------------------------------------------
# Item 3: translate_content/handler.py's languages_processed / completed contract
# ---------------------------------------------------------------------------

IDS = {'iep_id': 'iep-1', 'user_id': 'user-sub-1', 'child_id': 'child-1'}
DDB_SERVICE = 'DDBServiceTest'

ENGLISH_DOCUMENT = {
    'summaries': {'en': 'Summary text'},
    'sections': {'en': [{'title': 'Goals', 'content': 'Goal text', 'page_numbers': [1]}]},
    'document_index': {'en': 'Index'},
    'abbreviations': {'en': []},
}
OK_GET_DOCUMENT = {'statusCode': 200, 'body': json.dumps(ENGLISH_DOCUMENT)}
OK_SAVE = {'statusCode': 200, 'body': json.dumps({'message': 'ok'})}


def _scripted_ddb(get_document=OK_GET_DOCUMENT, save=OK_SAVE):
    def handle(payload):
        op = payload['operation']
        if op == 'get_document_with_content':
            return get_document
        if op == 'save_content_to_s3':
            return save
        raise AssertionError(f'unexpected ddb-service operation in this test: {op}')
    return handle


@pytest.fixture()
def handler_module(monkeypatch):
    install_agents_sdk_stubs(monkeypatch)
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key-not-encrypted')
    # translation_agent.py (imported by handler.py) imports the real
    # data_model.py, which needs pydantic's BaseModel/Field -- not provided by
    # the ValidationError-only stub above. These tests replace
    # translate_content_with_agent wholesale, so real validation is never
    # exercised; the stub only needs to let the import succeed.
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(__import__('sys').modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translate_content_handler_under_test',
                                module_name='handler')
    try:
        yield module
    finally:
        unload('translate_content_handler_under_test')
        unload('translation_agent')
        unload('config')


def _wire(handler_module, monkeypatch, get_document=OK_GET_DOCUMENT, save=OK_SAVE):
    fake = FakeLambdaClient(_scripted_ddb(get_document=get_document, save=save))
    monkeypatch.setattr(handler_module, 'boto3', ScopedBoto3(fake))
    return fake


def _stub_translation_results(handler_module, monkeypatch, results_by_lang):
    def fake_translate(self, content, target_language, content_type='parsing_result', model='gpt-4.1'):
        return results_by_lang[target_language]
    monkeypatch.setattr(handler_module.OptimizedTranslationAgent,
                        'translate_content_with_agent', fake_translate)


def test_when_every_language_fails_completion_is_false_and_none_are_processed(
        handler_module, monkeypatch):
    _wire(handler_module, monkeypatch)
    _stub_translation_results(handler_module, monkeypatch, {
        'es': {'error': 'model timeout'},
        'vi': {'error': 'model timeout'},
    })

    result = handler_module.lambda_handler(
        {**IDS, 'target_languages': ['es', 'vi'], 'content_type': 'parsing_result'}, None)

    # This is the contract VerifyLanguageProduced in the state machine reads:
    # total failure must be visible in languages_processed being empty...
    assert result['languages_processed'] == []
    # ...and, independently, the handler itself must stop claiming completion
    # it did not achieve. Before this fix this was hardcoded True.
    assert result['parsing_result_translation_completed'] is False


def test_when_at_least_one_language_succeeds_completion_is_true(handler_module, monkeypatch):
    _wire(handler_module, monkeypatch)
    _stub_translation_results(handler_module, monkeypatch, {
        'es': {'summary': 'Resumen', 'sections': [], 'document_index': '', 'abbreviations': []},
        'vi': {'error': 'model timeout'},
    })

    result = handler_module.lambda_handler(
        {**IDS, 'target_languages': ['es', 'vi'], 'content_type': 'parsing_result'}, None)

    assert result['languages_processed'] == ['es']
    assert result['parsing_result_translation_completed'] is True


def test_get_document_failure_does_not_dump_the_whole_ddb_response(handler_module, monkeypatch):
    """Both get_document_with_content call sites in this handler used to (or,
    for the second, still could without this fix) interpolate the entire
    ddb-service response into a raised Exception rather than pulling out just
    its 'error' field. Pins the first (source-fetch) site; the second
    (existing-content-fetch, before saving) is the one Item 1's site list
    named directly."""
    error_body = {'error': 'Document not found', 'operation': 'get_document_with_content'}
    _wire(handler_module, monkeypatch,
         get_document={'statusCode': 404, 'body': json.dumps(error_body)})

    with pytest.raises(Exception) as exc_info:
        handler_module.lambda_handler(
            {**IDS, 'target_languages': ['es'], 'content_type': 'parsing_result'}, None)

    message = str(exc_info.value)
    assert message == "Failed to get document from DDB: Document not found"
    # The old shape (str(the whole dict)) would have included this literally.
    assert "'operation': 'get_document_with_content'" not in message


def test_when_every_language_succeeds_completion_is_true(handler_module, monkeypatch):
    _wire(handler_module, monkeypatch)
    _stub_translation_results(handler_module, monkeypatch, {
        'es': {'summary': 'Resumen', 'sections': [], 'document_index': '', 'abbreviations': []},
    })

    result = handler_module.lambda_handler(
        {**IDS, 'target_languages': ['es'], 'content_type': 'parsing_result'}, None)

    assert result['languages_processed'] == ['es']
    assert result['parsing_result_translation_completed'] is True


def test_outer_catch_all_never_logs_the_rejected_value(handler_module, monkeypatch, capsys):
    """The outermost catch-all used to print(str(e)) and
    traceback.format_exc() verbatim -- the last uncovered path by which a
    rejected value could reach CloudWatch after f48b08f's fixes elsewhere in
    the pipeline. The ddb-service invoke is made to fail directly so this
    reaches the outer handler.py catch before any translation runs."""
    def _boom(payload):
        raise Exception(SENTINEL)
    fake = FakeLambdaClient(_boom)
    monkeypatch.setattr(handler_module, 'boto3', ScopedBoto3(fake))

    with pytest.raises(Exception):
        handler_module.lambda_handler(
            {**IDS, 'target_languages': ['es'], 'content_type': 'parsing_result'}, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives
