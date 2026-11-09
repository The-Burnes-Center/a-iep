"""Both OpenAI-backed pipeline steps leave no document text at OpenAI.

The Agents SDK's defaults keep it twice over (checked against the real
openai-agents 0.4.2 source): tracing is on and exports every prompt and
output to the OpenAI Traces dashboard using OPENAI_API_KEY, which both
handlers put in the environment; and ModelSettings.store is None, which the
Responses API treats as "store this response for 30 days". These tests pin
both off: tracing disabled at import, and store=False on every Agent.

openai / openai-agents are stubbed (conftest.install_agents_sdk_stubs).
"""
import sys
from types import ModuleType

import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload


class _RecordingModelSettings:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _install(monkeypatch, pick_run_error):
    agents_stub, _ = install_agents_sdk_stubs(monkeypatch)
    run_error = pick_run_error(agents_stub)
    built = []

    class _RecordingAgent:
        def __init__(self, **kwargs):
            built.append(kwargs)

    class _FailingRunner:
        # Stops each run right after its Agent is built: these tests are about
        # how the Agent is configured, not what it returns.
        @staticmethod
        def run_sync(*args, **kwargs):
            raise run_error()

    agents_stub.Agent = _RecordingAgent
    agents_stub.Runner = _FailingRunner
    agents_stub.ModelSettings = _RecordingModelSettings
    return agents_stub, built


@pytest.fixture()
def parsing(monkeypatch):
    agents_stub, built = _install(monkeypatch, lambda stub: stub.exceptions.MaxTurnsExceeded)
    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_retention_under_test',
                                module_name='open_ai_agent')
    try:
        yield module, agents_stub, built
    finally:
        unload('parsing_agent_retention_under_test')
        unload('config')


@pytest.fixture()
def translation(monkeypatch):
    agents_stub, built = _install(monkeypatch, lambda stub: RuntimeError)
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translation_agent_retention_under_test',
                                module_name='translation_agent')
    try:
        yield module, agents_stub, built
    finally:
        unload('translation_agent_retention_under_test')
        unload('config')


def test_parsing_agent_disables_tracing_on_import(parsing):
    _, agents_stub, _ = parsing
    assert agents_stub.tracing_disabled_calls == [True]


def test_parsing_agent_never_stores_responses_at_openai(parsing):
    module, _, built = parsing
    agent = module.OpenAIAgent(ocr_data={'pages': [{'markdown': 'x'}]}, api_key='sk-test')

    assert agent.analyze_document() == {'error': 'Max turns exceeded'}
    (kwargs,) = built
    # `is False`, not falsy: None is the SDK default and means "store".
    assert kwargs['model_settings'].kwargs['store'] is False


def test_translation_agent_disables_tracing_on_import(translation):
    _, agents_stub, _ = translation
    assert agents_stub.tracing_disabled_calls == [True]


def test_translation_agent_never_stores_responses_at_openai(translation):
    module, _, built = translation
    agent = module.OptimizedTranslationAgent(api_key='sk-test')
    # The real prompt reads files from the lambda's working directory.
    agent._get_optimized_prompt = lambda *args: 'prompt'

    agent.translate_content_with_agent({'summary': 'x'}, 'es')
    (kwargs,) = built
    assert kwargs['model_settings'].kwargs['store'] is False
