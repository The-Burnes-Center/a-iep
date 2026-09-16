"""parsing_agent/handler.py's own outer catch-all (as opposed to
open_ai_agent.py's, covered by test_parsing_agent_validation.py). This is the
last uncovered path by which a rejected value could reach CloudWatch after
f48b08f's fixes to the other six step handlers and to open_ai_agent.py itself.

openai / openai-agents / pydantic are stubbed (see
conftest.install_agents_sdk_stubs): handler.py imports OpenAIAgent from
open_ai_agent.py at module scope, so loading handler.py at all requires the
same stubs those tests use.

boto3.client is patched directly (module-level, not via ScopedBoto3 on the
handler module) because lambda_handler does a second, local `import boto3`
right before its first `boto3.client('lambda')` call: a local import always
resolves through sys.modules, so it would bypass a monkeypatch.setattr(module,
'boto3', ...) patch on the handler module's own attribute.
"""
import sys
from types import ModuleType, SimpleNamespace

import boto3
import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload

SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'


@pytest.fixture()
def handler_module(monkeypatch):
    install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_handler_under_test',
                                module_name='handler')
    try:
        yield module
    finally:
        unload('parsing_agent_handler_under_test')
        unload('open_ai_agent')
        unload('config')


def test_outer_catch_all_never_logs_the_rejected_value(handler_module, monkeypatch, capsys):
    class _ExplodingLambdaClient:
        def invoke(self, **kwargs):
            raise Exception(SENTINEL)

    real_client = boto3.client

    def fake_client(service_name, **kwargs):
        if service_name == 'lambda':
            return _ExplodingLambdaClient()
        return real_client(service_name, **kwargs)

    monkeypatch.setattr(boto3, 'client', fake_client)

    with pytest.raises(Exception):
        handler_module.lambda_handler(
            {'iep_id': 'iep-1', 'user_id': 'user-1', 'child_id': 'child-1'}, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives
