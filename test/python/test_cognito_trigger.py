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


# --- Password rotation on phone signups -------------------------------------
#
# pre-sign-up.js auto-confirms phone-only signups so a new parent gets ONE SMS
# instead of two. That makes the account usable the instant SignUp returns,
# while it still carries the password the CLIENT chose at Auth.signUp. These
# tests pin the rotation that closes the resulting hole: without it, anyone
# could sign up a phone number they do not own and then sign straight in with
# USER_PASSWORD_AUTH using their own password, never needing the OTP.

USER_POOL_ID = 'us-east-1_Test000'
PHONE = '+15555550111'


class FakeCognitoIdp:
    """Records admin calls, and can be told to fail like the real API would."""

    def __init__(self, set_password_error=None, disable_error=None, sign_out_error=None):
        self.set_password_calls = []
        self.disable_calls = []
        self.sign_out_calls = []
        self._set_password_error = set_password_error
        self._disable_error = disable_error
        self._sign_out_error = sign_out_error

    def admin_set_user_password(self, **kwargs):
        self.set_password_calls.append(kwargs)
        if self._set_password_error:
            raise self._set_password_error
        return {}

    def admin_disable_user(self, **kwargs):
        self.disable_calls.append(kwargs)
        if self._disable_error:
            raise self._disable_error
        return {}

    def admin_user_global_sign_out(self, **kwargs):
        self.sign_out_calls.append(kwargs)
        if self._sign_out_error:
            raise self._sign_out_error
        return {}


def phone_signup_event(user_id='phone-user-sub', phone=PHONE, **attributes):
    return {
        'userName': user_id,
        'userPoolId': USER_POOL_ID,
        'triggerSource': 'PostConfirmation_ConfirmSignUp',
        'request': {'userAttributes': {'phone_number': phone, **attributes}},
    }


def use_fake_cognito(trigger, monkeypatch, **kwargs):
    # Patch the module's own client factory at its point of use; patching
    # boto3.client would hijack every AWS client in the process.
    fake = FakeCognitoIdp(**kwargs)
    monkeypatch.setattr(trigger.module, '_cognito_idp', lambda: fake)
    return fake


def test_phone_signup_password_is_rotated_permanently(trigger, monkeypatch):
    fake = use_fake_cognito(trigger, monkeypatch)

    event = phone_signup_event()
    assert trigger.module.lambda_handler(event, None) is event

    assert len(fake.set_password_calls) == 1
    call = fake.set_password_calls[0]
    assert call['UserPoolId'] == USER_POOL_ID
    assert call['Username'] == 'phone-user-sub'
    # Permanent=True matters: a temporary password would leave the account in
    # FORCE_CHANGE_PASSWORD and hand the caller a reset opportunity.
    assert call['Permanent'] is True
    assert fake.disable_calls == []


def test_rotated_password_satisfies_the_pool_policy_and_is_unpredictable(trigger, monkeypatch):
    fake = use_fake_cognito(trigger, monkeypatch)

    trigger.module.lambda_handler(phone_signup_event('user-a'), None)
    trigger.module.lambda_handler(phone_signup_event('user-b'), None)

    first, second = (c['Password'] for c in fake.set_password_calls)
    # The pool requires 8+ chars including a digit (lib/authorization/new-auth.ts).
    for password in (first, second):
        assert len(password) >= 8
        assert any(ch.isdigit() for ch in password)
    # Two signups must not share a password, or knowing one would open others.
    assert first != second


def test_rotation_still_creates_the_user_profile(trigger, monkeypatch):
    use_fake_cognito(trigger, monkeypatch)

    trigger.module.lambda_handler(phone_signup_event(), None)

    profile = trigger.profiles.get_item(Key={'userId': 'phone-user-sub'})['Item']
    assert profile['showOnboarding'] is True
    assert profile['consentGiven'] is False


def test_email_signup_password_is_left_alone(trigger, monkeypatch):
    # An email user legitimately owns their password; rotating it would lock
    # them out of the account they just created.
    fake = use_fake_cognito(trigger, monkeypatch)

    event = {
        'userName': 'email-user-sub',
        'userPoolId': USER_POOL_ID,
        'triggerSource': 'PostConfirmation_ConfirmSignUp',
        'request': {'userAttributes': {'email': 'parent@example.com'}},
    }
    trigger.module.lambda_handler(event, None)

    assert fake.set_password_calls == []
    assert fake.disable_calls == []


def test_account_with_both_phone_and_email_is_left_alone(trigger, monkeypatch):
    fake = use_fake_cognito(trigger, monkeypatch)

    trigger.module.lambda_handler(
        phone_signup_event(email='parent@example.com'), None)

    assert fake.set_password_calls == []


def test_forgot_password_confirmation_does_not_rotate(trigger, monkeypatch):
    # THE important negative case. ConfirmForgotPassword fires this same
    # trigger, and the user has just deliberately chosen a new password;
    # rotating it here would lock every password reset back out.
    fake = use_fake_cognito(trigger, monkeypatch)

    event = phone_signup_event()
    event['triggerSource'] = 'PostConfirmation_ConfirmForgotPassword'
    trigger.module.lambda_handler(event, None)

    assert fake.set_password_calls == []
    assert fake.disable_calls == []


def test_failed_rotation_disables_the_account(trigger, monkeypatch):
    # Fail CLOSED: an account we could not rotate is still reachable with the
    # caller's chosen password, so it must not be left enabled. A parent locked
    # out by a transient AWS error is recoverable; a hijacked account is not.
    fake = use_fake_cognito(
        trigger, monkeypatch, set_password_error=RuntimeError('throttled'))

    event = phone_signup_event()
    assert trigger.module.lambda_handler(event, None) is event

    assert len(fake.set_password_calls) == 1
    assert fake.disable_calls == [
        {'UserPoolId': USER_POOL_ID, 'Username': 'phone-user-sub'}]


def test_rotation_and_disable_both_failing_still_returns_the_event(trigger, monkeypatch, capsys):
    # Nothing left to try in-band, but Cognito must still get its event back,
    # and the operator must be able to find this in the logs.
    use_fake_cognito(
        trigger,
        monkeypatch,
        set_password_error=RuntimeError('throttled'),
        disable_error=RuntimeError('also throttled'),
    )

    event = phone_signup_event()
    assert trigger.module.lambda_handler(event, None) is event
    assert 'CRITICAL' in capsys.readouterr().out


def test_sessions_opened_during_the_signup_window_are_revoked(trigger, monkeypatch):
    # Cognito marks the account CONFIRMED before invoking this trigger, so the
    # caller's chosen password briefly still works. A caller racing a login
    # against their own SignUp could bank a refresh token that outlives the
    # rotation; the global sign-out kills it.
    fake = use_fake_cognito(trigger, monkeypatch)

    trigger.module.lambda_handler(phone_signup_event(), None)

    assert fake.sign_out_calls == [
        {'UserPoolId': USER_POOL_ID, 'Username': 'phone-user-sub'}]


def test_revocation_runs_after_the_password_is_rotated(trigger, monkeypatch):
    # Order matters: signing out first would leave a window where the caller
    # can log straight back in with the password they still know.
    order = []
    fake = FakeCognitoIdp()
    fake.admin_set_user_password = lambda **kw: order.append('rotate')
    fake.admin_user_global_sign_out = lambda **kw: order.append('sign_out')
    monkeypatch.setattr(trigger.module, '_cognito_idp', lambda: fake)

    trigger.module.lambda_handler(phone_signup_event(), None)

    assert order == ['rotate', 'sign_out']


def test_a_failed_revocation_does_not_disable_the_account(trigger, monkeypatch):
    # The rotation is the primary control and it succeeded, so a best-effort
    # revocation failure must NOT lock a real parent out over a race nobody ran.
    fake = use_fake_cognito(
        trigger, monkeypatch, sign_out_error=RuntimeError('throttled'))

    event = phone_signup_event()
    assert trigger.module.lambda_handler(event, None) is event

    assert len(fake.set_password_calls) == 1
    assert fake.disable_calls == []


def test_an_email_signup_is_not_signed_out(trigger, monkeypatch):
    fake = use_fake_cognito(trigger, monkeypatch)

    trigger.module.lambda_handler({
        'userName': 'email-user-sub',
        'userPoolId': USER_POOL_ID,
        'triggerSource': 'PostConfirmation_ConfirmSignUp',
        'request': {'userAttributes': {'email': 'parent@example.com'}},
    }, None)

    assert fake.sign_out_calls == []


def test_the_generated_password_is_never_logged(trigger, monkeypatch, capsys):
    fake = use_fake_cognito(trigger, monkeypatch)

    trigger.module.lambda_handler(phone_signup_event(), None)

    assert fake.set_password_calls[0]['Password'] not in capsys.readouterr().out


def test_event_missing_the_pool_id_is_not_silently_skipped(trigger, monkeypatch, capsys):
    # A malformed event must not quietly bypass the rotation and leave the
    # account reachable; the failure has to be loud.
    fake = use_fake_cognito(trigger, monkeypatch)

    event = phone_signup_event()
    del event['userPoolId']
    assert trigger.module.lambda_handler(event, None) is event

    assert fake.set_password_calls == []
    assert 'rotation FAILED' in capsys.readouterr().out
