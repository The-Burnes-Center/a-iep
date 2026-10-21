"""The pre-warm invoke: ParsingAgent and TranslateContent return at once on it.

iep-processing.asl.json invokes both functions asynchronously with the constant
payload {"warmup": true} while a document is still being OCR'd, so the cold
start (14 of 15 prod invocations were cold; ~4s of module imports each) is paid
off the critical path. The payload carries no document data, and the handlers
must treat it as inert: no AWS client, no table, no key lookup, no model call.
Anything else, including a real event that merely happens to contain the key,
must still run the real work.

openai / openai-agents / pydantic are stubbed (see
conftest.install_agents_sdk_stubs).
"""
import sys
from types import ModuleType

import boto3
import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload

WARMUP = {'warmup': True}


class _Untouchable:
    """Raises on any use, so a warm-up that reaches for a client fails loudly."""

    def __init__(self, what):
        self.what = what

    def __call__(self, *args, **kwargs):
        raise AssertionError(f'warm-up touched {self.what}')

    def __getattr__(self, name):
        raise AssertionError(f'warm-up touched {self.what}.{name}')


@pytest.fixture()
def parsing_handler(monkeypatch):
    agents_stub, _ = install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_warmup_under_test', module_name='handler')
    _forbid_everything(monkeypatch, agents_stub)
    try:
        yield module
    finally:
        unload('parsing_agent_warmup_under_test')
        unload('open_ai_agent')
        unload('config')


@pytest.fixture()
def translate_handler(monkeypatch):
    agents_stub, _ = install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translate_content_warmup_under_test', module_name='handler')
    _forbid_everything(monkeypatch, agents_stub)
    try:
        yield module
    finally:
        unload('translate_content_warmup_under_test')
        unload('translation_agent')
        unload('config')
        unload('student_token')


def _forbid_everything(monkeypatch, agents_stub):
    # After import, as a real warm container would be: from here on any AWS or
    # model access is a failure of the warm path.
    for attr in ('client', 'resource', 'Session'):
        monkeypatch.setattr(boto3, attr, _Untouchable(f'boto3.{attr}'))
    monkeypatch.setattr(agents_stub, 'Runner', _Untouchable('agents.Runner'), raising=False)
    monkeypatch.setattr(agents_stub, 'Agent', _Untouchable('agents.Agent'), raising=False)
    for name in ('OPENAI_API_KEY', 'OPENAI_API_KEY_PARAMETER_NAME', 'DDB_SERVICE_FUNCTION_NAME'):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize('fixture_name', ['parsing_handler', 'translate_handler'])
def test_the_warmup_event_returns_without_touching_any_client(fixture_name, request, capsys):
    handler = request.getfixturevalue(fixture_name)

    assert handler.lambda_handler(dict(WARMUP), None) == {'warmed': True}

    # And says nothing: there is nothing in the event worth logging.
    assert capsys.readouterr().out == ''


@pytest.mark.parametrize('fixture_name', ['parsing_handler', 'translate_handler'])
def test_the_warmup_does_not_depend_on_the_environment_being_configured(fixture_name, request):
    # A warm container has no event data and, in the worst case, no key yet.
    handler = request.getfixturevalue(fixture_name)

    assert handler.lambda_handler(WARMUP, object()) == {'warmed': True}


@pytest.mark.parametrize('fixture_name', ['parsing_handler', 'translate_handler'])
@pytest.mark.parametrize('event', [
    {},
    {'warmup': False},
    {'warmup': 'true'},
    # A real event is never mistaken for a warm-up, whatever else it carries.
    {'warmup': True, 'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1',
     'target_languages': ['es']},
])
def test_anything_but_the_exact_warmup_payload_still_does_the_real_work(fixture_name, request, event):
    handler = request.getfixturevalue(fixture_name)

    # With every client forbidden the real path cannot succeed, so it must
    # raise; returning the warm-up answer instead is the failure.
    with pytest.raises(Exception):
        handler.lambda_handler(event, None)
