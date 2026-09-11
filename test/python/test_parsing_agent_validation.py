"""parsing_agent's OpenAIAgent.analyze_document(): a pydantic ValidationError
(or an agents-SDK ModelBehaviorError) must never put the document text it
names into a log line or the returned error string.

pydantic 2's ValidationError.__str__ embeds the rejected input_value for every
failing field (truncated to ~52 chars, not removed), and here the rejected
input is OCR-derived document text -- exactly what CLAUDE.md says must never
reach a log. traceback.format_exc()'s last line renders that same str(e), so
it is an equally real leak if left unguarded.

openai / openai-agents / pydantic are stubbed (see
conftest.install_agents_sdk_stubs): CI's test/python/requirements.txt installs
only boto3 + moto + pytest, and the lambda's own pin (pydantic 2.10.6) has no
wheel for every Python these suites run under -- see
test_parsing_agent_ocr_tools.py for the same constraint. Faking
Runner.run_sync's return value and SingleLanguageIEP.model_validate lets
analyze_document() run its real exception-handling code against a
controlled, realistic ValidationError instead of skipping that code path.
"""
import logging
import sys
from types import ModuleType, SimpleNamespace

import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload

SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'


class _FakeResult:
    def __init__(self, final_output):
        self.final_output = final_output


@pytest.fixture()
def agent_module(monkeypatch):
    agents_stub, pydantic_stub = install_agents_sdk_stubs(monkeypatch)

    class _FakeRunner:
        next_output = {}
        next_exception = None

        @staticmethod
        def run_sync(agent, prompt, max_turns=None):
            if _FakeRunner.next_exception is not None:
                exc, _FakeRunner.next_exception = _FakeRunner.next_exception, None
                raise exc
            return _FakeResult(_FakeRunner.next_output)

    agents_stub.Runner = _FakeRunner

    class _FakeSingleLanguageIEP:
        """Stands in for the real pydantic model: model_validate is
        controllable per test, so analyze_document() sees a real (fake)
        ValidationError without needing pydantic/data_model for real."""
        next_error = None

        @classmethod
        def model_validate(cls, data, strict=False):
            if cls.next_error is not None:
                raise cls.next_error
            return SimpleNamespace(model_dump=lambda: data)

    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = _FakeSingleLanguageIEP
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)

    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_validation_open_ai_agent',
                                module_name='open_ai_agent')
    try:
        yield SimpleNamespace(module=module, runner=_FakeRunner,
                              model=_FakeSingleLanguageIEP, pydantic=pydantic_stub)
    finally:
        unload('parsing_agent_validation_open_ai_agent')
        unload('config')


def _agent(agent_module):
    return agent_module.module.OpenAIAgent(
        ocr_data={'pages': [{'index': 0, 'markdown': 'Body text'}]}, api_key='test-key')


def _validation_error(agent_module, input_value, loc=('sections', 0, 'content')):
    return agent_module.pydantic.ValidationError(
        errors=[{'loc': loc, 'type': 'string_type',
                 'msg': 'Input should be a valid string', 'input': input_value}],
        model_name='SingleLanguageIEP',
    )


def test_validation_error_never_logs_the_rejected_document_text(agent_module, caplog):
    caplog.set_level(logging.INFO)
    agent_module.runner.next_output = {'sections': []}  # shape irrelevant; model_validate is faked
    agent_module.model.next_error = _validation_error(agent_module, {'nested': SENTINEL})

    result = _agent(agent_module).analyze_document()

    assert SENTINEL not in caplog.text
    assert SENTINEL not in str(result)
    assert 'error' in result
    # The class survives: it is what tells an operator whether to look at our
    # schema or a third party, and it cannot itself contain document text.
    assert 'ValidationError' in caplog.text
    assert 'ValidationError' in result['error']


def test_validation_error_summary_names_the_rejected_field(agent_module, caplog):
    caplog.set_level(logging.INFO)
    agent_module.runner.next_output = {'sections': []}
    agent_module.model.next_error = _validation_error(
        agent_module, SENTINEL, loc=('sections', 2, 'content'))

    _agent(agent_module).analyze_document()

    # Triage signal (which field failed) survives; only the value is gone.
    assert "'content'" in caplog.text
    assert SENTINEL not in caplog.text


def test_validation_error_suppresses_the_traceback_not_just_the_summary_line(agent_module, caplog):
    """traceback.format_exc()'s last line renders str(e), which for a
    ValidationError is the same leak the summary line was written to avoid."""
    caplog.set_level(logging.INFO)
    agent_module.runner.next_output = {'sections': []}
    agent_module.model.next_error = _validation_error(agent_module, SENTINEL)

    _agent(agent_module).analyze_document()

    assert SENTINEL not in caplog.text
    assert 'Traceback (most recent call last)' not in caplog.text


def test_non_validation_errors_still_get_a_real_traceback(agent_module, caplog):
    """The traceback suppression is specific to ValidationError; an ordinary
    bug during parsing must still log a real, debuggable traceback."""
    caplog.set_level(logging.INFO)
    agent_module.runner.next_output = {'sections': []}
    agent_module.model.next_error = RuntimeError('boom, not a validation error')

    _agent(agent_module).analyze_document()

    assert 'Traceback (most recent call last)' in caplog.text


def test_model_behavior_error_never_logs_the_models_raw_output(agent_module, caplog):
    caplog.set_level(logging.INFO)
    agent_module.runner.next_exception = agent_module.module.ModelBehaviorError(SENTINEL)

    result = _agent(agent_module).analyze_document()

    assert SENTINEL not in caplog.text
    assert SENTINEL not in str(result)
    assert 'error' in result
    # The class name is the useful triage fact and is safe to keep: it cannot
    # itself contain document text, unlike str(e) on the real exception.
    assert 'ModelBehaviorError' in result['error']
