"""The OpenAI client both agents use carries explicit time limits.

The Agents SDK's own defaults are a 600s read timeout and two retries. A
request OpenAI never answers therefore held a lambda for up to 30 minutes,
longer than the state machine's per-state TimeoutSeconds (240s for
ParsingAgent and TranslateParsingResult) and with only the lambda's own
900s/600s limit behind it. Step Functions stops waiting at its timeout but does
not cancel the lambda, so the limit that actually frees the lambda has to be on
the client.

openai / openai-agents are stubbed (see conftest.install_agents_sdk_stubs); the
stub records the client it was handed, which is all these tests need.
"""
import sys
from types import ModuleType

import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload

# The state machine's TimeoutSeconds for both OpenAI-backed steps
# (iep-processing.asl.json); the worst case on the client must fit inside it,
# or the state times out first and the client's own limit never gets a say.
STATE_TIMEOUT_SECONDS = 240


@pytest.fixture()
def parsing_module(monkeypatch):
    install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_client_under_test',
                                module_name='open_ai_agent')
    try:
        yield module
    finally:
        unload('parsing_agent_client_under_test')
        unload('config')


@pytest.fixture()
def translation_module(monkeypatch):
    install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translation_agent_client_under_test',
                                module_name='translation_agent')
    try:
        yield module
    finally:
        unload('translation_agent_client_under_test')
        unload('config')


def _default_clients():
    return sys.modules['agents'].default_clients


def _assert_bounded(client, use_for_tracing):
    kwargs = client.kwargs
    assert kwargs['api_key'] == 'sk-test'
    timeout = kwargs['timeout']
    # The SDK default is 600: anything near it is no bound at all.
    assert 0 < timeout.timeout <= 120
    assert 0 < timeout.connect <= 10
    assert kwargs['max_retries'] <= 1
    # Every attempt, retries included, ends before the state's own timeout.
    assert (kwargs['max_retries'] + 1) * timeout.timeout < STATE_TIMEOUT_SECONDS
    # Tracing keeps reading OPENAI_API_KEY from the environment, as before.
    assert use_for_tracing is False


def test_parsing_agent_installs_a_client_with_time_limits(parsing_module):
    parsing_module.OpenAIAgent(ocr_data={'pages': []}, api_key='sk-test')

    (client, use_for_tracing), = _default_clients()
    _assert_bounded(client, use_for_tracing)


def test_parsing_agent_reuses_the_client_for_the_same_key(parsing_module):
    # A warm container builds a new OpenAIAgent per invocation; one client per
    # key, not one per invocation.
    parsing_module.OpenAIAgent(ocr_data={'pages': []}, api_key='sk-test')
    parsing_module.OpenAIAgent(ocr_data={'pages': []}, api_key='sk-test')

    assert len(_default_clients()) == 1


def test_parsing_agent_without_a_key_installs_nothing_and_still_reports_it(parsing_module):
    agent = parsing_module.OpenAIAgent(ocr_data={'pages': [{'markdown': 'x'}]}, api_key=None)

    assert _default_clients() == []
    assert agent.analyze_document() == {'error': 'API key missing'}


def test_translation_agent_installs_a_client_with_time_limits(translation_module):
    translation_module.OptimizedTranslationAgent(api_key='sk-test')

    (client, use_for_tracing), = _default_clients()
    _assert_bounded(client, use_for_tracing)


def test_translation_agent_reuses_the_client_for_the_same_key(translation_module):
    translation_module.OptimizedTranslationAgent(api_key='sk-test')
    translation_module.OptimizedTranslationAgent(api_key='sk-test')

    assert len(_default_clients()) == 1


def test_translation_agent_without_a_key_still_constructs(translation_module):
    # test_student_name.py builds the agent bare to read its prompt.
    translation_module.OptimizedTranslationAgent()

    assert _default_clients() == []
