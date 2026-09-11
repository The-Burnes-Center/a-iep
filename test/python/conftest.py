"""Shared fixtures for the Python lambda test suites.

The handlers create their boto3 resources at import time from environment
variables, so each suite loads its module through load_lambda_module AFTER
moto is active and the fake tables exist. Every handler folder also ships a
file literally named lambda_function.py; loading by path under a unique
alias keeps them from colliding in sys.modules.
"""
import importlib.util
import io
import json
import os
import sys
from types import ModuleType

import boto3
import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FUNCTIONS_DIR = os.path.join(REPO_ROOT, 'lib', 'chatbot-api', 'functions')


@pytest.fixture(autouse=True)
def aws_test_env(monkeypatch):
    """Fake credentials and region so moto never falls through to real AWS."""
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'testing')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'testing')
    monkeypatch.setenv('AWS_SECURITY_TOKEN', 'testing')
    monkeypatch.setenv('AWS_SESSION_TOKEN', 'testing')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')


def load_lambda_module(handler_dir, alias, module_name='lambda_function'):
    """Import a lambda's module by path under a unique sys.modules alias.

    The handler folder sits on sys.path only while the module executes, so
    sibling imports (`from router import ...`) resolve without leaking into
    other suites. Callers are responsible for popping the alias when their
    fixture tears down.
    """
    folder = os.path.join(FUNCTIONS_DIR, handler_dir)
    path = os.path.join(folder, f'{module_name}.py')
    spec = importlib.util.spec_from_file_location(alias, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    sys.path.insert(0, folder)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(folder)
    return module


def unload(alias):
    sys.modules.pop(alias, None)


class FakeLambdaClient:
    """In-memory stand-in for boto3's Lambda client (cross-lambda invokes).

    `handler` receives the parsed payload and returns the invoked lambda's
    result. Wiring it to another handler module loaded by load_lambda_module
    (e.g. the real ddb-service) turns a step's invoke into a contract test:
    drift in the service's operations, params, or response shape fails here
    instead of in production. Every call is recorded on `invocations` as
    (function_name, payload).
    """

    def __init__(self, handler):
        self.handler = handler
        self.invocations = []

    def invoke(self, FunctionName, Payload, InvocationType='RequestResponse'):
        payload = json.loads(Payload)
        self.invocations.append((FunctionName, payload))
        result = self.handler(payload)
        return {'Payload': io.BytesIO(json.dumps(result, default=str).encode('utf-8'))}

    def payloads(self, operation):
        return [p for _, p in self.invocations if p.get('operation') == operation]


def install_agents_sdk_stubs(monkeypatch):
    """Stub the third-party SDKs that parsing_agent/open_ai_agent.py and
    translate_content/translation_agent.py import: openai, openai-agents
    (`agents`) and pydantic's ValidationError.

    test/python/requirements.txt installs only boto3 + moto + pytest (CI
    mirrors this), and pydantic 2.10.6 -- the exact pin those lambdas
    deploy with -- has no wheel for every Python these suites may run
    under, so real imports of any of these are not an option here. Every
    test that loads a module which transitively imports them must install
    these stubs first via monkeypatch.setitem(sys.modules, ...), which
    pytest reverts automatically at the end of the test.

    Returns the fake `agents` module so a test can further replace
    `.Agent` / `.Runner` / `.ModelSettings` with a purpose-built fake before
    loading the lambda module under test, and the fake `pydantic` module so
    a test can construct instances of the exact `ValidationError` class the
    lambda's own `isinstance(e, ValidationError)` checks will see.
    """
    class _PermissiveClass:
        """Accepts and ignores any constructor args; stands in for Agent /
        Runner / ModelSettings when a test does not need to control them."""
        def __init__(self, *args, **kwargs):
            pass

    class _FakeValidationError(Exception):
        """Minimal stand-in for pydantic.ValidationError: real pydantic's
        .errors() returns a list of {loc, type, msg, input, ...} dicts and
        str(e) quotes input_value for each. This mirrors both shapes closely
        enough to test code that must extract loc/type without ever calling
        str(e) or reading the 'input' key."""
        def __init__(self, errors=None, model_name='Model'):
            self._errors = errors or []
            self._model_name = model_name
            lines = [f"{len(self._errors)} validation error(s) for {model_name}"]
            for err in self._errors:
                loc = '.'.join(str(p) for p in err.get('loc', ()))
                lines.append(
                    f"{loc}\n  {err.get('msg', '')} [type={err.get('type', '')}, "
                    f"input_value={err.get('input')!r}, input_type={type(err.get('input')).__name__}]"
                )
            super().__init__('\n'.join(lines))

        def errors(self):
            return self._errors

        def error_count(self):
            return len(self._errors)

    openai_stub = ModuleType('openai')
    openai_stub.OpenAI = object

    agents_stub = ModuleType('agents')
    agents_stub.Agent = _PermissiveClass
    agents_stub.Runner = _PermissiveClass
    agents_stub.ModelSettings = _PermissiveClass
    agents_stub.function_tool = lambda *args, **kwargs: (lambda fn: fn)

    exceptions_stub = ModuleType('agents.exceptions')

    class MaxTurnsExceeded(Exception):
        pass

    class ModelBehaviorError(Exception):
        pass

    exceptions_stub.MaxTurnsExceeded = MaxTurnsExceeded
    exceptions_stub.ModelBehaviorError = ModelBehaviorError
    agents_stub.exceptions = exceptions_stub

    pydantic_stub = ModuleType('pydantic')
    pydantic_stub.ValidationError = _FakeValidationError

    for name, module in (
        ('openai', openai_stub),
        ('agents', agents_stub),
        ('agents.exceptions', exceptions_stub),
        ('pydantic', pydantic_stub),
    ):
        monkeypatch.setitem(sys.modules, name, module)

    return agents_stub, pydantic_stub


class ScopedBoto3:
    """boto3 stand-in for a single handler module's namespace.

    client('lambda') returns the given fake so cross-lambda invokes stay
    in-process; every other service goes through the real boto3 (moto-backed
    when the test runs under mock_aws). Install it with
    monkeypatch.setattr(module, 'boto3', ScopedBoto3(fake)): that rebinds the
    name only inside that module, unlike patching boto3.client itself, which
    would hijack every client in the process.
    """

    def __init__(self, lambda_client):
        self.lambda_client = lambda_client

    def client(self, service_name, **kwargs):
        if service_name == 'lambda':
            return self.lambda_client
        return boto3.client(service_name, **kwargs)

    def __getattr__(self, name):
        return getattr(boto3, name)
