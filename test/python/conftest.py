"""Shared fixtures for the Python lambda test suites.

The handlers create their boto3 resources at import time from environment
variables, so each suite loads its module through load_lambda_module AFTER
moto is active and the fake tables exist. Every handler folder also ships a
file literally named lambda_function.py; loading by path under a unique
alias keeps them from colliding in sys.modules.
"""
import importlib.util
import os
import sys

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
