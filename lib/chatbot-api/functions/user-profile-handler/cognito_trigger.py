import json
import os
import boto3
import secrets
import string
import uuid
from datetime import datetime
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')
user_profiles_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])

# Built lazily so importing this module (and the existing tests) needs no
# Cognito stub, and so the client can be monkeypatched at its point of use.
_cognito_idp_client = None


def _cognito_idp():
    global _cognito_idp_client
    if _cognito_idp_client is None:
        _cognito_idp_client = boto3.client('cognito-idp')
    return _cognito_idp_client


# Only a fresh signup gets its password rotated. ConfirmForgotPassword fires
# this same trigger, and there the user has just deliberately chosen a new
# password -- rotating it would lock them straight back out.
SIGNUP_TRIGGER = 'PostConfirmation_ConfirmSignUp'

# Comfortably above the pool's 8-character minimum; the alphabet plus the
# forced final digit always satisfies requireDigits.
GENERATED_PASSWORD_LENGTH = 40


def _is_phone_only_account(user_attributes):
    """
    Mirror of the gate in phone-otp-auth/pre-sign-up.js: an account with a
    phone number and no email address signs in exclusively through the
    custom-auth OTP flow, so it has no legitimate use for a password.
    """
    email = (user_attributes.get('email') or '').strip()
    phone = (user_attributes.get('phone_number') or '').strip()
    return bool(phone) and not email


def _generate_password():
    alphabet = string.ascii_letters + string.digits
    body = ''.join(secrets.choice(alphabet) for _ in range(GENERATED_PASSWORD_LENGTH - 1))
    return body + secrets.choice(string.digits)


def _neutralize_client_chosen_password(event):
    """
    Replace a phone-only account's password with a server-generated secret
    that nobody holds.

    SECURITY, load-bearing. pre-sign-up.js auto-confirms phone signups so the
    parent receives only one SMS, which means the account is usable the instant
    SignUp returns -- while still carrying the password the CLIENT chose at
    Auth.signUp. Without this rotation anyone could sign up a phone number they
    do not own and then sign straight in with USER_PASSWORD_AUTH using their own
    password, never needing the OTP. Rotating here leaves the OTP texted to the
    real handset as the only way into a phone account.

    This runs inside the SignUp API call, so the caller cannot exploit the gap:
    SignUp does not return to them until this trigger has finished.
    """
    user_pool_id = event.get('userPoolId')
    user_name = event.get('userName')
    if not user_pool_id or not user_name:
        raise ValueError('Cognito event is missing userPoolId or userName')

    _cognito_idp().admin_set_user_password(
        UserPoolId=user_pool_id,
        Username=user_name,
        Password=_generate_password(),
        Permanent=True,
    )
    print(f"Rotated the client-chosen password for phone user {user_name}")


def _revoke_sessions_opened_during_signup(event):
    """
    Defence in depth for a narrow race. Cognito marks the account CONFIRMED
    before it invokes this trigger, so for the few hundred milliseconds between
    those two events the caller's chosen password still works. A caller racing
    a USER_PASSWORD_AUTH call against their own SignUp could obtain a refresh
    token that would outlive the rotation and keep working after the real parent
    starts uploading documents. A global sign-out invalidates it.

    Best-effort ON PURPOSE: the rotation above is the primary control, so a
    failure here must not trip the fail-closed disable path and lock a real
    parent out over a race nobody ran.
    """
    try:
        _cognito_idp().admin_user_global_sign_out(
            UserPoolId=event['userPoolId'],
            Username=event['userName'],
        )
    except Exception as e:
        print(f"Could not revoke signup-window sessions (password is already rotated): {str(e)}")


def _rotate_password_or_disable(event):
    """
    Fail CLOSED. If the rotation cannot be completed the account is disabled
    rather than left reachable with a caller-known password: a parent locked out
    by a transient AWS error is recoverable, a hijacked account is not.
    """
    try:
        _neutralize_client_chosen_password(event)
        _revoke_sessions_opened_during_signup(event)
    except Exception as e:
        print(f"Password rotation FAILED, disabling the account to fail closed: {str(e)}")
        try:
            _cognito_idp().admin_disable_user(
                UserPoolId=event['userPoolId'],
                Username=event['userName'],
            )
            print(f"Disabled {event.get('userName')} after failed password rotation")
        except Exception as disable_error:
            # Nothing left to try in-band. Logged loudly so an operator (and
            # the log metric filters) can catch it.
            print(
                'CRITICAL: could not rotate OR disable a phone account; it '
                f"remains reachable with a caller-chosen password: {str(disable_error)}"
            )


def lambda_handler(event, context):
    """
    Cognito Post Confirmation Lambda Trigger.
    Creates a default user profile after user confirms their account.
    Only creates profile if one doesn't already exist.

    Also rotates away the client-chosen password on phone-only signups -- see
    _neutralize_client_chosen_password, which is what makes the single-SMS
    auto-confirm in pre-sign-up.js safe.

    Args:
        event: Cognito trigger event containing user data
        context: Lambda context

    Returns:
        event: Returns the event object back to Cognito
    """
    # Deliberately ahead of profile creation and outside its error handling: a
    # missing profile is recoverable later, an un-rotated password is a
    # standing account-takeover vector.
    if event.get('triggerSource') == SIGNUP_TRIGGER and _is_phone_only_account(
        event.get('request', {}).get('userAttributes', {})
    ):
        _rotate_password_or_disable(event)

    try:
        # Get user attributes from the event
        user_id = event['userName']
        
        # Check if profile already exists
        try:
            existing_profile = user_profiles_table.get_item(
                Key={'userId': user_id}
            )
            
            if 'Item' in existing_profile:
                print(f"Profile already exists for user {user_id}, skipping creation")
                return event
                
        except ClientError as e:
            print(f"Error checking existing profile: {str(e)}")
            # Continue with profile creation if check fails
        
        # Create timestamp
        current_time = int(datetime.now().timestamp())
        
        # Create default child for IEP document functionality
        default_child = {
            'childId': str(uuid.uuid4()),
            'name': 'My Child',
            'schoolCity': 'Not specified',
            'createdAt': current_time,
            'updatedAt': current_time
        }
        
        # Create default profile only if one doesn't exist
        new_profile = {
            'userId': user_id,
            'createdAt': current_time,
            'updatedAt': current_time,
            'children': [default_child],  # Initialize with default child
            'consentGiven': False,  # Add new field with default value of false
            'showOnboarding': True  # Add new field with default value of true
        }
        
        # Use put_item with condition to prevent overwriting
        user_profiles_table.put_item(
            Item=new_profile,
            ConditionExpression='attribute_not_exists(userId)'
        )
        
        print(f"Created default profile for user {user_id}")
        
        # Return the event back to Cognito
        return event
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            print(f"Profile already exists for user {user_id}, no action needed")
        else:
            print(f"Error creating user profile: {str(e)}")
        # Still return event to allow user creation even if profile creation fails
        return event
    except Exception as e:
        print(f"Error creating user profile: {str(e)}")
        # Still return event to allow user creation even if profile creation fails
        return event 