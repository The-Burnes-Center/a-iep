"""user-profile-handler tests: the pure router and the log-sanitization
helpers. API Gateway events carry a live bearer token, JWT PII claims, and
child PII in the body; sanitize_event_for_logging is what keeps those out of
CloudWatch, so its contract is pinned field by field.
"""
import json
from decimal import Decimal
from types import SimpleNamespace

import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload


@pytest.fixture()
def router_module():
    module = load_lambda_module('user-profile-handler', 'user_profile_router',
                                module_name='router')
    yield module
    unload('user_profile_router')


@pytest.fixture()
def profile_module(monkeypatch):
    monkeypatch.setenv('USER_PROFILES_TABLE', 'profiles-test')
    monkeypatch.setenv('IEP_DOCUMENTS_TABLE', 'documents-test')
    with mock_aws():
        module = load_lambda_module('user-profile-handler', 'user_profile_lambda')
        yield module
    unload('user_profile_lambda')


# ---------------------------------------------------------------------------
# Router

def test_router_matches_static_and_parameterized_routes(router_module):
    router = router_module.Router()
    profile_handler = lambda event: 'profile'
    documents_handler = lambda event: 'documents'
    router.add_route('/profile', 'GET', profile_handler)
    router.add_route('/profile/children/{childId}/documents', 'GET', documents_handler)

    handler, params = router.match_route('/profile', 'GET')
    assert handler is profile_handler and params == {}

    handler, params = router.match_route('/profile/children/abc-123/documents', 'GET')
    assert handler is documents_handler
    assert params == {'childId': 'abc-123'}


def test_router_rejects_unknown_paths_methods_and_partial_matches(router_module):
    router = router_module.Router()
    router.add_route('/profile', 'GET', lambda event: 'profile')

    with pytest.raises(router_module.RouteNotFoundException):
        router.match_route('/profile', 'DELETE')  # method not registered
    with pytest.raises(router_module.RouteNotFoundException):
        router.match_route('/unknown', 'GET')
    with pytest.raises(router_module.RouteNotFoundException):
        router.match_route('/profile/extra', 'GET')  # pattern is anchored
    with pytest.raises(router_module.RouteNotFoundException):
        router.match_route('/profilex', 'GET')


def test_router_path_params_never_span_segments(router_module):
    router = router_module.Router()
    router.add_route('/profile/children/{childId}/documents', 'DELETE', lambda event: 'x')
    with pytest.raises(router_module.RouteNotFoundException):
        router.match_route('/profile/children/a/b/documents', 'DELETE')


# ---------------------------------------------------------------------------
# Log sanitization

def gateway_event():
    return {
        'headers': {
            'Authorization': 'Bearer live-token',
            'Cookie': 'session=abc',
            'Content-Type': 'application/json',
        },
        'cookies': ['session=abc'],
        'requestContext': {
            'authorizer': {'jwt': {'claims': {
                'sub': 'user-sub-1',
                'email': 'parent@example.org',
                'phone_number': '+16175551234',
            }}},
        },
        'body': json.dumps({'childName': 'A Real Kid'}),
    }


def test_sanitize_event_redacts_token_pii_and_body(profile_module):
    safe = profile_module.sanitize_event_for_logging(gateway_event())
    redacted = profile_module._REDACTED

    assert safe['headers']['Authorization'] == redacted
    assert safe['headers']['Cookie'] == redacted
    assert safe['cookies'] == redacted
    assert safe['body'] == redacted
    claims = safe['requestContext']['authorizer']['jwt']['claims']
    assert claims['email'] == redacted
    assert claims['phone_number'] == redacted
    # Debuggability survives: sub and content-type stay readable.
    assert claims['sub'] == 'user-sub-1'
    assert safe['headers']['Content-Type'] == 'application/json'

    logged = json.dumps(safe)
    for secret in ['live-token', 'session=abc', 'parent@example.org', '+16175551234', 'A Real Kid']:
        assert secret not in logged


def test_sanitize_event_never_mutates_the_original(profile_module):
    event = gateway_event()
    before = json.loads(json.dumps(event))
    profile_module.sanitize_event_for_logging(event)
    assert event == before


def test_sanitize_event_handles_non_dict_input(profile_module):
    assert profile_module.sanitize_event_for_logging(None) is None
    assert profile_module.sanitize_event_for_logging('nope') == 'nope'


def test_get_origin_is_case_insensitive_with_local_default(profile_module):
    assert profile_module.get_origin_from_event(
        {'headers': {'ORIGIN': 'https://aiep.example.org'}}) == 'https://aiep.example.org'
    assert profile_module.get_origin_from_event({'headers': {}}) == 'http://localhost:3000'


def test_create_response_serializes_dynamodb_decimals(profile_module):
    response = profile_module.create_response({'headers': {}}, 200, {
        'count': Decimal('3'), 'score': Decimal('2.5'),
    })
    assert response['statusCode'] == 200
    assert json.loads(response['body']) == {'count': 3, 'score': 2.5}
    assert response['headers']['Access-Control-Allow-Origin'] == '*'
