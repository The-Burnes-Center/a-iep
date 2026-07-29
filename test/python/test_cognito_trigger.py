"""PostConfirmation trigger tests (user-profile-handler/cognito_trigger.py).

This lambda is the signup heartbeat: its invocation count is the canary that
would have caught the 2026-07 OTP incident, and its profile write decides
whether a new email/password user sees onboarding at all.
"""
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

PROFILES_TABLE = 'profiles-test'


@pytest.fixture()
def trigger(monkeypatch):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        profiles = dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        module = load_lambda_module('user-profile-handler', 'cognito_trigger_lambda',
                                    module_name='cognito_trigger')
        try:
            yield SimpleNamespace(module=module, profiles=profiles)
        finally:
            unload('cognito_trigger_lambda')


def confirm_event(user_id='new-user-sub'):
    return {'userName': user_id, 'request': {'userAttributes': {}}}


def test_creates_default_profile_on_first_confirmation(trigger):
    event = confirm_event()
    returned = trigger.module.lambda_handler(event, None)
    assert returned is event  # Cognito requires the event back

    profile = trigger.profiles.get_item(Key={'userId': 'new-user-sub'})['Item']
    assert profile['consentGiven'] is False
    assert profile['showOnboarding'] is True
    assert len(profile['children']) == 1
    assert profile['children'][0]['name'] == 'My Child'
    assert profile['children'][0]['childId']
    assert int(profile['createdAt']) > 0


def test_existing_profile_is_never_overwritten(trigger):
    trigger.profiles.put_item(Item={
        'userId': 'new-user-sub',
        'consentGiven': True,
        'children': [{'childId': 'kept', 'name': 'Kept Child'}],
    })
    trigger.module.lambda_handler(confirm_event(), None)

    profile = trigger.profiles.get_item(Key={'userId': 'new-user-sub'})['Item']
    assert profile['consentGiven'] is True
    assert profile['children'][0]['childId'] == 'kept'


def test_losing_a_create_race_is_quietly_tolerated(trigger, monkeypatch):
    # Two concurrent confirmations can both see no profile on the get_item
    # check; the loser's conditional put then raises
    # ConditionalCheckFailedException. That guard must swallow the error,
    # hand the event back to Cognito, and never clobber the winner's write.
    trigger.profiles.put_item(Item={
        'userId': 'new-user-sub',
        'consentGiven': True,
        'children': [{'childId': 'winner', 'name': 'Winner Child'}],
    })
    real_table = trigger.module.user_profiles_table
    racing_table = SimpleNamespace(
        get_item=lambda **kwargs: {},       # the read raced: profile not seen
        put_item=real_table.put_item,       # real conditional put -> fails
    )
    monkeypatch.setattr(trigger.module, 'user_profiles_table', racing_table)

    event = confirm_event()
    assert trigger.module.lambda_handler(event, None) is event

    profile = trigger.profiles.get_item(Key={'userId': 'new-user-sub'})['Item']
    assert profile['consentGiven'] is True
    assert profile['children'][0]['childId'] == 'winner'


def test_profile_failure_still_returns_event_to_cognito(trigger):
    # If the write blows up, user creation must not be blocked.
    trigger.profiles.delete()
    event = confirm_event()
    assert trigger.module.lambda_handler(event, None) is event
