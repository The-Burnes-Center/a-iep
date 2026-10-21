"""Referral-system handler tests (lib/chatbot-api/functions/referral-handler).

Runs the real handler against moto-backed DynamoDB/Cognito/KMS so conditional
writes, the byOwner GSI, and group membership behave like production. Covers
the click -> attribute -> stats loop, every attribution rejection reason, the
admin CRUD + admin-management routes, and route auth (401/403/404).
"""
import base64
import json
import time
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

REFERRALS_TABLE = 'referrals-test'
PROFILES_TABLE = 'profiles-test'
META = 'META'

USER = 'user-sub-1'
OTHER_USER = 'user-sub-2'
ADMIN = 'admin-sub-1'
ADMIN_CLAIMS = {'sub': ADMIN, 'cognito:groups': ['admin']}


@pytest.fixture()
def referral(monkeypatch):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        referrals = dynamodb.create_table(
            TableName=REFERRALS_TABLE,
            KeySchema=[
                {'AttributeName': 'code', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'code', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
                {'AttributeName': 'ownerUserId', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[{
                'IndexName': 'byOwner',
                'KeySchema': [{'AttributeName': 'ownerUserId', 'KeyType': 'HASH'}],
                'Projection': {'ProjectionType': 'ALL'},
            }],
            BillingMode='PAY_PER_REQUEST',
        )
        profiles = dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        cognito = boto3.client('cognito-idp', region_name='us-east-1')
        pool_id = cognito.create_user_pool(PoolName='test-pool')['UserPool']['Id']
        cognito.create_group(GroupName='admin', UserPoolId=pool_id)

        monkeypatch.setenv('REFERRALS_TABLE', REFERRALS_TABLE)
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('USER_POOL_ID', pool_id)

        module = load_lambda_module('referral-handler', 'referral_lambda')
        try:
            yield SimpleNamespace(
                module=module,
                referrals=referrals,
                profiles=profiles,
                cognito=cognito,
                pool_id=pool_id,
            )
        finally:
            unload('referral_lambda')


def api_event(path, method, body=None, claims=None, origin='https://staging.example.org', b64=False):
    event = {
        'rawPath': path,
        'requestContext': {'http': {'method': method}},
        'headers': {'Origin': origin} if origin else {},
    }
    if claims is not None:
        event['requestContext']['authorizer'] = {'jwt': {'claims': claims}}
    if body is not None:
        raw = body if isinstance(body, str) else json.dumps(body)
        if b64:
            event['body'] = base64.b64encode(raw.encode()).decode()
            event['isBase64Encoded'] = True
        else:
            event['body'] = raw
    return event


def call(referral, *args, **kwargs):
    response = referral.module.lambda_handler(api_event(*args, **kwargs), None)
    return response['statusCode'], json.loads(response['body'])


def put_campaign(referral, code='launch', active=True, created_by=ADMIN):
    referral.referrals.put_item(Item={
        'code': code, 'sk': META, 'type': 'campaign', 'active': active,
        'clicks': 0, 'signups': 0, 'createdAt': referral.module.now_iso(),
        'createdBy': created_by,
    })
    return code


def put_profile(referral, user_id=USER, created_seconds_ago=60, **extra):
    item = {'userId': user_id, 'createdAt': int(time.time()) - created_seconds_ago, **extra}
    referral.profiles.put_item(Item=item)
    return item


def get_meta(referral, code):
    return referral.referrals.get_item(Key={'code': code, 'sk': META}).get('Item')


# ---------------------------------------------------------------------------
# Pure helpers

def test_normalize_code(referral):
    normalize = referral.module.normalize_code
    assert normalize('Launch-24') == 'launch-24'
    assert normalize('  abc  ') == 'abc'
    assert normalize('a') == 'a'
    assert normalize('a' * 32) == 'a' * 32
    for bad in ['', '-abc', 'abc-', 'a b', 'a_b', 'a' * 33, None, 5, ['x']]:
        assert normalize(bad) is None, bad


def test_is_admin_accepts_every_claim_shape(referral):
    is_admin = referral.module.is_admin
    assert is_admin({'cognito:groups': ['admin', 'other']}) is True
    assert is_admin({'cognito:groups': '[admin other]'}) is True
    assert is_admin({'cognito:groups': 'admin,other'}) is True
    assert is_admin({'cognito:groups': '[other]'}) is False
    assert is_admin({'cognito:groups': 'administrator'}) is False
    assert is_admin({}) is False


def test_parse_body_variants(referral):
    parse_body = referral.module.parse_body
    assert parse_body({'body': '{"code": "abc"}'}) == {'code': 'abc'}
    # sendBeacon posts text/plain, sometimes base64-encoded by API Gateway
    encoded = base64.b64encode(b'{"code": "abc"}').decode()
    assert parse_body({'body': encoded, 'isBase64Encoded': True}) == {'code': 'abc'}
    assert parse_body({'body': None}) == {}
    assert parse_body({}) == {}
    assert parse_body({'body': 'not json'}) == {}
    assert parse_body({'body': '[1, 2]'}) == {}


def test_create_response_echoes_origin(referral):
    response = referral.module.create_response(
        {'headers': {'origin': 'https://aiep.example.org'}}, 200, {'ok': True})
    assert response['headers']['Access-Control-Allow-Origin'] == 'https://aiep.example.org'
    assert json.loads(response['body']) == {'ok': True}
    no_origin = referral.module.create_response({'headers': {}}, 200, {})
    assert no_origin['headers']['Access-Control-Allow-Origin'] == '*'


def test_decimal_encoder(referral):
    from decimal import Decimal
    encoded = json.dumps({'a': Decimal('5'), 'b': Decimal('5.5')}, cls=referral.module.DecimalEncoder)
    assert json.loads(encoded) == {'a': 5, 'b': 5.5}


# ---------------------------------------------------------------------------
# Routing and auth boundaries

def test_click_is_public_me_needs_auth_admin_needs_group(referral):
    assert call(referral, '/referral/click', 'POST', body={'code': 'nope'})[0] == 200
    assert call(referral, '/referral/me', 'GET')[0] == 401
    assert call(referral, '/referral/attribute', 'POST', claims=None)[0] == 401
    non_admin = {'sub': USER, 'cognito:groups': '[parents]'}
    assert call(referral, '/referral/admin/links', 'GET', claims=non_admin)[0] == 403
    assert call(referral, '/referral/nope', 'GET', claims={'sub': USER})[0] == 404


def test_admin_group_string_form_reaches_admin_routes(referral):
    claims = {'sub': ADMIN, 'cognito:groups': '[admin]'}
    status, body = call(referral, '/referral/admin/links', 'GET', claims=claims)
    assert status == 200
    assert body == {'links': []}


# ---------------------------------------------------------------------------
# Clicks

CLICK_ID = 'c1ick-id-abcdefgh-0001'


def click_records(referral, code):
    return referral.referrals.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('code').eq(code)
        & boto3.dynamodb.conditions.Key('sk').begins_with('CLICK#'),
    )['Items']


def test_click_counts_only_known_active_codes(referral):
    put_campaign(referral, 'live', active=True)
    put_campaign(referral, 'paused', active=False)

    for code in ['live', 'paused', 'ghost']:
        status, body = call(referral, '/referral/click', 'POST', body={'code': code})
        assert status == 200
        # Same shape for every code, so the answer never says which exist.
        assert set(body) == {'ok', 'clickId'}
        assert body['ok'] is True

    assert get_meta(referral, 'live')['clicks'] == 1
    assert get_meta(referral, 'paused')['clicks'] == 0

    events = referral.referrals.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('code').eq('live')
        & boto3.dynamodb.conditions.Key('sk').begins_with('EVT#CLICK#'),
    )['Items']
    assert len(events) == 1
    assert 'ttl' in events[0]  # click events expire; signups are kept

    # Only a known active code leaves a server-side click record.
    assert len(click_records(referral, 'live')) == 1
    assert click_records(referral, 'paused') == []
    assert click_records(referral, 'ghost') == []


def test_click_returns_the_clients_id_and_stores_the_servers_time(referral):
    put_campaign(referral)
    before = int(time.time() * 1000)
    status, body = call(referral, '/referral/click', 'POST',
                        body={'code': 'launch', 'clickId': CLICK_ID})
    after = int(time.time() * 1000)

    assert status == 200
    assert body['clickId'] == CLICK_ID
    [record] = click_records(referral, 'launch')
    assert record['sk'] == f'CLICK#{CLICK_ID}'
    assert before <= int(record['atMs']) <= after
    assert 'ttl' in record  # the record expires with the click events


def test_click_mints_an_id_when_the_client_sends_none_or_a_bad_one(referral):
    put_campaign(referral)
    ids = set()
    for body in [{'code': 'launch'}, {'code': 'launch', 'clickId': 'short'},
                 {'code': 'launch', 'clickId': 'has spaces and a / slash!!'},
                 {'code': 'launch', 'clickId': 12345}]:
        status, response = call(referral, '/referral/click', 'POST', body=body)
        assert status == 200
        assert referral.module.CLICK_ID_PATTERN.match(response['clickId'])
        ids.add(response['clickId'])
    assert len(ids) == 4  # each got its own fresh id
    assert len(click_records(referral, 'launch')) == 4


def test_replaying_a_click_id_neither_counts_twice_nor_moves_its_time(referral):
    put_campaign(referral)
    call(referral, '/referral/click', 'POST', body={'code': 'launch', 'clickId': CLICK_ID})
    first = click_records(referral, 'launch')[0]['atMs']
    time.sleep(0.01)

    status, body = call(referral, '/referral/click', 'POST',
                        body={'code': 'launch', 'clickId': CLICK_ID})
    assert (status, body['clickId']) == (200, CLICK_ID)

    assert get_meta(referral, 'launch')['clicks'] == 1
    [record] = click_records(referral, 'launch')
    assert record['atMs'] == first  # the first server timestamp stands


# ---------------------------------------------------------------------------
# Personal codes (/referral/me)

def test_me_mints_a_code_once_and_mirrors_it(referral):
    put_profile(referral)
    status, body = call(referral, '/referral/me', 'GET', claims={'sub': USER})
    assert status == 200
    code = body['code']
    assert len(code) == referral.module.CODE_LENGTH
    assert body['clicks'] == 0 and body['signups'] == 0 and body['joins'] == []

    meta = get_meta(referral, code)
    assert meta['type'] == 'user' and meta['ownerUserId'] == USER
    profile = referral.profiles.get_item(Key={'userId': USER})['Item']
    assert profile['referralCode'] == code

    # Second call must return the same code, not mint another.
    assert call(referral, '/referral/me', 'GET', claims={'sub': USER})[1]['code'] == code


def test_me_recovers_code_from_gsi_when_profile_mirror_is_missing(referral):
    put_profile(referral)
    referral.referrals.put_item(Item={
        'code': 'k3pt42', 'sk': META, 'type': 'user', 'ownerUserId': USER,
        'active': True, 'clicks': 3, 'signups': 1,
        'createdAt': referral.module.now_iso(),
    })
    status, body = call(referral, '/referral/me', 'GET', claims={'sub': USER})
    assert status == 200
    assert body['code'] == 'k3pt42'
    assert body['clicks'] == 3


# ---------------------------------------------------------------------------
# Attribution

def put_click(referral, code='launch', click_id=CLICK_ID, ago_ms=30_000):
    """The server's record of a click that arrived `ago_ms` ago, written the
    way /referral/click writes it (tests need to place it in the past)."""
    referral.referrals.put_item(Item={
        'code': code, 'sk': f'CLICK#{click_id}', 'kind': 'clickid',
        'at': referral.module.now_iso(),
        'atMs': int(time.time() * 1000) - ago_ms,
    })
    return click_id


def attribute(referral, code='launch', user=USER, ago_ms=30_000, click_id=CLICK_ID, **body_extra):
    """Attribute `user` with a click the server recorded `ago_ms` ago."""
    put_click(referral, code, click_id, ago_ms)
    return call(referral, '/referral/attribute', 'POST', claims={'sub': user},
                body={'code': code, 'clickId': click_id, **body_extra})


def test_attribution_happy_path_stamps_profile_and_counts(referral):
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=10)

    status, body = attribute(referral, ago_ms=30_000)
    assert (status, body) == (200, {'attributed': True})

    profile = referral.profiles.get_item(Key={'userId': USER})['Item']
    assert profile['referredBy'] == 'launch'
    assert 'referredAt' in profile
    assert get_meta(referral, 'launch')['signups'] == 1

    signups = referral.referrals.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('code').eq('launch')
        & boto3.dynamodb.conditions.Key('sk').begins_with('EVT#SIGNUP#'),
    )['Items']
    assert len(signups) == 1
    assert signups[0]['referredUserId'] == USER
    assert 'ttl' not in signups[0]


def test_attribution_tolerates_second_resolution_created_at(referral):
    # cognito_trigger writes createdAt in epoch seconds; the handler must
    # normalize it to ms before comparing against the click time.
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=10)
    status, body = attribute(referral)
    assert body == {'attributed': True}


@pytest.mark.parametrize('setup,body_override,reason', [
    # code fails validation entirely
    (lambda r: put_profile(r), {'code': 'NO SPACES'}, 'invalid_code'),
    # code passes validation but doesn't exist
    (lambda r: put_profile(r), {'code': 'ghost'}, 'invalid_code'),
    # link exists but is deactivated
    (lambda r: (put_campaign(r, active=False), put_profile(r)), None, 'invalid_code'),
    # clickId missing / malformed
    (lambda r: (put_campaign(r), put_profile(r)), {'clickId': None}, 'invalid_click'),
    (lambda r: (put_campaign(r), put_profile(r)), {'clickId': 'short'}, 'invalid_click'),
    (lambda r: (put_campaign(r), put_profile(r)), {'clickId': 123456789012345678}, 'invalid_click'),
    # well-formed id the server never recorded
    (lambda r: (put_campaign(r), put_profile(r)), {'clickId': 'never-recorded-0123456789'}, 'unknown_click'),
    # signer has no profile row yet
    (lambda r: put_campaign(r), None, 'no_profile'),
])
def test_attribution_rejections(referral, setup, body_override, reason):
    setup(referral)
    put_click(referral)
    body = {'code': 'launch', 'clickId': CLICK_ID}
    if body_override:
        body.update(body_override)
    status, response = call(referral, '/referral/attribute', 'POST',
                            claims={'sub': USER}, body=body)
    assert status == 200
    assert response == {'attributed': False, 'reason': reason}


def test_attribution_rejects_self_referral_for_both_link_kinds(referral):
    # A parent clicking their own personal link...
    referral.referrals.put_item(Item={
        'code': 'mine42', 'sk': META, 'type': 'user', 'ownerUserId': USER,
        'active': True, 'clicks': 0, 'signups': 0,
        'createdAt': referral.module.now_iso(),
    })
    put_profile(referral)
    assert attribute(referral, code='mine42')[1]['reason'] == 'self_referral'
    # ...and an admin test-clicking a campaign they created.
    put_campaign(referral, 'own-campaign', created_by=USER)
    assert attribute(referral, code='own-campaign')[1]['reason'] == 'self_referral'


def test_attribution_is_once_only(referral):
    put_campaign(referral)
    put_campaign(referral, 'second')
    put_profile(referral, created_seconds_ago=10)
    assert attribute(referral)[1] == {'attributed': True}
    status, body = attribute(referral, code='second')
    assert body == {'attributed': False, 'reason': 'already_attributed'}
    assert get_meta(referral, 'second')['signups'] == 0


def test_attribution_requires_click_before_signup(referral):
    put_campaign(referral)
    # Account created 1 hour ago; the server saw the click just now, i.e. an
    # existing user clicking a link long after signing up.
    put_profile(referral, created_seconds_ago=3600)
    status, body = attribute(referral, ago_ms=1_000)
    assert body == {'attributed': False, 'reason': 'click_after_signup'}
    assert get_meta(referral, 'launch')['signups'] == 0


def test_a_forged_capturedAt_is_ignored(referral):
    """The old bypass: a client claiming an earlier capture time. The click is
    made for real through /referral/click (so the server stamps it NOW), after
    which the caller attributes with a capturedAt from before their signup."""
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=3600)  # signed up an hour ago
    forged = int(time.time() * 1000) - 2 * 3600 * 1000  # "clicked" before that

    _, clicked = call(referral, '/referral/click', 'POST', body={'code': 'launch'})
    status, body = call(referral, '/referral/attribute', 'POST', claims={'sub': USER},
                        body={'code': 'launch', 'clickId': clicked['clickId'], 'capturedAt': forged})

    assert (status, body) == (200, {'attributed': False, 'reason': 'click_after_signup'})
    assert 'referredBy' not in referral.profiles.get_item(Key={'userId': USER})['Item']
    assert get_meta(referral, 'launch')['signups'] == 0


def test_capturedAt_alone_no_longer_attributes(referral):
    # What a client from before this change sends: a code and a time, no id.
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=3600)
    forged = int(time.time() * 1000) - 2 * 3600 * 1000

    status, body = call(referral, '/referral/attribute', 'POST', claims={'sub': USER},
                        body={'code': 'launch', 'capturedAt': forged})

    assert (status, body) == (200, {'attributed': False, 'reason': 'invalid_click'})
    assert get_meta(referral, 'launch')['signups'] == 0


def test_a_capturedAt_beside_a_valid_click_does_not_change_the_outcome(referral):
    # A click the server recorded well before signup attributes, whatever the
    # client claims alongside it.
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=10)
    status, body = attribute(referral, ago_ms=60_000, capturedAt=int(time.time() * 1000) + 10**9)
    assert body == {'attributed': True}


def test_an_id_cannot_be_used_against_a_different_code(referral):
    put_campaign(referral)
    put_campaign(referral, 'second')
    put_profile(referral, created_seconds_ago=10)
    put_click(referral, 'launch', CLICK_ID, ago_ms=60_000)

    # launch's id offered against another code: no such record under it.
    status, body = call(referral, '/referral/attribute', 'POST', claims={'sub': USER},
                        body={'code': 'second', 'clickId': CLICK_ID})
    assert body == {'attributed': False, 'reason': 'unknown_click'}
    assert get_meta(referral, 'second')['signups'] == 0


def test_the_click_to_attribute_loop_end_to_end(referral):
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=0)
    _, clicked = call(referral, '/referral/click', 'POST',
                      body={'code': 'launch', 'clickId': CLICK_ID})
    # The parent signs up just after clicking.
    referral.profiles.update_item(
        Key={'userId': USER}, UpdateExpression='SET createdAt = :c',
        ExpressionAttributeValues={':c': int(time.time()) + 5},
    )

    status, body = call(referral, '/referral/attribute', 'POST', claims={'sub': USER},
                        body={'code': 'launch', 'clickId': clicked['clickId']})

    assert (status, body) == (200, {'attributed': True})
    assert get_meta(referral, 'launch')['signups'] == 1


def test_attribution_rejects_implausibly_old_captures(referral):
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=0)
    days = referral.module.MAX_CAPTURE_AGE_DAYS + 1
    status, body = attribute(referral, ago_ms=days * 86_400_000)
    assert body == {'attributed': False, 'reason': 'capture_too_old'}


# ---------------------------------------------------------------------------
# Admin: campaign links

def test_admin_create_list_get_update_roundtrip(referral):
    status, body = call(referral, '/referral/admin/links', 'POST', claims=ADMIN_CLAIMS,
                        body={'code': 'Fall-Expo', 'name': 'Fall expo', 'channel': 'event'})
    assert status == 201
    assert body['link']['code'] == 'fall-expo'
    assert body['link']['channel'] == 'event'
    assert body['link']['active'] is True

    # Duplicate slug is a conflict, invalid slug a 400, bad channel coerced.
    assert call(referral, '/referral/admin/links', 'POST', claims=ADMIN_CLAIMS,
                body={'code': 'fall-expo'})[0] == 409
    assert call(referral, '/referral/admin/links', 'POST', claims=ADMIN_CLAIMS,
                body={'code': 'bad slug!'})[0] == 400
    status, body = call(referral, '/referral/admin/links', 'POST', claims=ADMIN_CLAIMS,
                        body={'code': 'radio-spot', 'channel': 'radio'})
    assert body['link']['channel'] == 'other'

    status, body = call(referral, '/referral/admin/links', 'GET', claims=ADMIN_CLAIMS)
    assert status == 200
    assert {link['code'] for link in body['links']} == {'fall-expo', 'radio-spot'}

    # Update, then read back through the detail route (code normalized).
    assert call(referral, '/referral/admin/links/fall-expo', 'PUT', claims=ADMIN_CLAIMS,
                body={'name': 'Fall Expo 2026', 'active': False})[0] == 200
    status, body = call(referral, '/referral/admin/links/FALL-EXPO', 'GET', claims=ADMIN_CLAIMS)
    assert status == 200
    assert body['link']['name'] == 'Fall Expo 2026'
    assert body['link']['active'] is False
    assert body['events'] == []

    assert call(referral, '/referral/admin/links/ghost', 'GET', claims=ADMIN_CLAIMS)[0] == 404
    assert call(referral, '/referral/admin/links/ghost', 'PUT', claims=ADMIN_CLAIMS,
                body={'name': 'x'})[0] == 404
    assert call(referral, '/referral/admin/links/fall-expo', 'PUT', claims=ADMIN_CLAIMS,
                body={})[0] == 400


def test_admin_detail_events_hide_identities(referral):
    put_campaign(referral)
    put_profile(referral, created_seconds_ago=10)
    call(referral, '/referral/click', 'POST', body={'code': 'launch'})
    attribute(referral)

    status, body = call(referral, '/referral/admin/links/launch', 'GET', claims=ADMIN_CLAIMS)
    assert status == 200
    kinds = sorted(event['kind'] for event in body['events'])
    assert kinds == ['click', 'signup']
    for event in body['events']:
        assert set(event.keys()) == {'kind', 'at'}  # never referredUserId


def test_admin_list_resolves_owner_names_via_kms(referral):
    kms = boto3.client('kms', region_name='us-east-1')
    key_id = kms.create_key()['KeyMetadata']['KeyId']
    ciphertext = kms.encrypt(KeyId=key_id, Plaintext=b'Jane P.')['CiphertextBlob']
    put_profile(referral, parentName=base64.b64encode(ciphertext).decode())

    call(referral, '/referral/me', 'GET', claims={'sub': USER})  # mints personal link
    status, body = call(referral, '/referral/admin/links', 'GET', claims=ADMIN_CLAIMS)
    assert status == 200
    personal = next(link for link in body['links'] if link['type'] == 'user')
    assert personal['ownerName'] == 'Jane P.'


# ---------------------------------------------------------------------------
# Admin: admin-group management

def make_pool_user(referral, username, phone=None, email=None, in_admin_group=False):
    attrs = []
    if phone:
        attrs.append({'Name': 'phone_number', 'Value': phone})
    if email:
        attrs.append({'Name': 'email', 'Value': email})
    referral.cognito.admin_create_user(
        UserPoolId=referral.pool_id, Username=username, UserAttributes=attrs,
        MessageAction='SUPPRESS')
    if in_admin_group:
        referral.cognito.admin_add_user_to_group(
            UserPoolId=referral.pool_id, GroupName='admin', Username=username)
    user = referral.cognito.admin_get_user(UserPoolId=referral.pool_id, Username=username)
    return next(a['Value'] for a in user['UserAttributes'] if a['Name'] == 'sub')


def admins_in_group(referral):
    users = referral.cognito.list_users_in_group(
        UserPoolId=referral.pool_id, GroupName='admin')['Users']
    return {user['Username'] for user in users}


def test_admin_add_admin_by_phone_normalizes_us_numbers(referral):
    make_pool_user(referral, 'parent-1', phone='+16175551234')
    status, body = call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                        body={'identifier': '(617) 555-1234'})
    assert status == 200
    assert body['admin']['username'] == 'parent-1'
    assert admins_in_group(referral) == {'parent-1'}


def test_admin_add_admin_by_email_and_error_cases(referral):
    make_pool_user(referral, 'parent-2', email='p2@example.org')
    status, body = call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                        body={'identifier': 'p2@example.org'})
    assert status == 200 and body['admin']['username'] == 'parent-2'

    assert call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                body={'identifier': 'ghost@example.org'})[0] == 404
    assert call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                body={'identifier': '  '})[0] == 400


def test_admin_remove_admin_but_never_self(referral):
    admin_sub = make_pool_user(referral, 'the-admin', in_admin_group=True)
    make_pool_user(referral, 'other-admin', in_admin_group=True)
    claims = {'sub': admin_sub, 'cognito:groups': ['admin']}

    assert call(referral, '/referral/admin/admins/the-admin', 'DELETE', claims=claims)[0] == 400
    assert admins_in_group(referral) == {'the-admin', 'other-admin'}

    assert call(referral, '/referral/admin/admins/other-admin', 'DELETE', claims=claims)[0] == 200
    assert admins_in_group(referral) == {'the-admin'}

    assert call(referral, '/referral/admin/admins/ghost', 'DELETE', claims=claims)[0] == 404


def test_admin_list_admins(referral):
    make_pool_user(referral, 'the-admin', phone='+16175550000', in_admin_group=True)
    status, body = call(referral, '/referral/admin/admins', 'GET', claims=ADMIN_CLAIMS)
    assert status == 200
    assert [admin['username'] for admin in body['admins']] == ['the-admin']
    assert body['admins'][0]['phone'] == '+16175550000'


# ---------------------------------------------------------------------------
# Hardening: every 4xx says why, nothing identifying reaches the log, AWS
# faults are generic 503s, and the admin lookup cannot be steered by its input.

def test_every_refusal_logs_a_reason_and_never_the_identifier(referral, capsys):
    make_pool_user(referral, 'the-admin', in_admin_group=True)
    capsys.readouterr()

    assert call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                body={'identifier': 'ghost@example.org'})[0] == 404
    assert call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                body={'identifier': 'sneaky@example.org" OR x = "y'})[0] == 400
    assert call(referral, '/referral/admin/admins/x%40example.org', 'DELETE',
                claims={'sub': 'someone', 'cognito:groups': []})[0] == 403
    assert call(referral, '/referral/nope', 'GET', claims={'sub': USER})[0] == 404

    out = capsys.readouterr().out
    assert 'lookup matched no account' in out
    assert 'neither a valid email nor a phone number' in out
    # The admin route is logged with its username replaced, not the address.
    assert 'admin route DELETE /referral/admin/admins/{id} without the admin group' in out
    assert 'no route for GET /referral/nope' in out
    for leaked in ('ghost', 'sneaky', 'x%40', 'x@', 'example.org'):
        assert leaked not in out, leaked


def test_an_admin_lookup_value_that_could_steer_the_filter_is_refused_before_cognito(referral, monkeypatch):
    """Cognito's filter has no bound parameters. A quote in the value is what
    would let an identifier add a clause, so it never reaches the filter."""
    seen = []

    class RecordingCognito:
        def list_users(self, **kwargs):
            seen.append(kwargs)
            return {'Users': []}

    monkeypatch.setattr(referral.module, 'cognito', RecordingCognito())
    for hostile in ('a"b@example.org', 'a\\b@example.org', '+1617" OR "1"="1',
                    'x@example', ' @example.org'):
        status, _ = call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                         body={'identifier': hostile})
        assert status == 400, hostile
    assert seen == []


def test_an_admin_lookup_for_a_valid_email_uses_the_quoted_filter(referral, monkeypatch):
    seen = []

    class RecordingCognito:
        def list_users(self, **kwargs):
            seen.append(kwargs['Filter'])
            return {'Users': []}

    monkeypatch.setattr(referral.module, 'cognito', RecordingCognito())
    status, _ = call(referral, '/referral/admin/admins', 'POST', claims=ADMIN_CLAIMS,
                     body={'identifier': 'p2@example.org'})
    assert status == 404
    assert seen == ['email = "p2@example.org"']


def test_a_percent_encoded_admin_username_is_decoded_before_the_lookup(referral):
    make_pool_user(referral, 'the-admin', in_admin_group=True)
    make_pool_user(referral, 'other@example.org', in_admin_group=True)
    claims = {'sub': ADMIN, 'cognito:groups': ['admin']}

    status, _ = call(referral, '/referral/admin/admins/other%40example.org', 'DELETE', claims=claims)

    assert status == 200
    assert admins_in_group(referral) == {'the-admin'}


def test_malformed_json_on_an_admin_write_is_a_400_with_the_reason_logged(referral, capsys):
    for raw in ('{nope', '["code"]'):
        capsys.readouterr()
        status, _ = call(referral, '/referral/admin/links', 'POST', claims=ADMIN_CLAIMS, body=raw)
        assert status == 400, raw
        assert 'body is not' in capsys.readouterr().out
    assert call(referral, '/referral/admin/links', 'GET', claims=ADMIN_CLAIMS)[1]['links'] == []


def test_click_stays_lenient_on_a_malformed_body(referral):
    """sendBeacon can post anything; the public counter answers 200 regardless."""
    status, body = call(referral, '/referral/click', 'POST', body='{nope')
    assert status == 200
    assert body['ok'] is True
    assert referral.module.CLICK_ID_PATTERN.match(body['clickId'])


def test_a_missing_table_setting_is_a_logged_500(referral, monkeypatch, capsys):
    monkeypatch.delenv('REFERRALS_TABLE')
    status, body = call(referral, '/referral/click', 'POST', body={'code': 'launch'})
    assert status == 500
    assert body == {'message': 'internal error'}
    assert 'REFERRALS_TABLE' in capsys.readouterr().out


def test_a_dynamodb_throttle_is_a_generic_503(referral, monkeypatch, capsys):
    from botocore.exceptions import ClientError

    class ThrottledTable:
        def get_item(self, **_kwargs):
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException',
                                         'Message': f'on {PROFILES_TABLE}'}}, 'GetItem')

    monkeypatch.setattr(referral.module, 'user_profiles_table', ThrottledTable())

    status, body = call(referral, '/referral/me', 'GET', claims={'sub': USER})

    assert status == 503
    assert PROFILES_TABLE not in json.dumps(body)
    assert 'ProvisionedThroughputExceededException' in capsys.readouterr().out


def test_every_response_says_no_store(referral):
    ok = referral.module.lambda_handler(api_event('/referral/click', 'POST', body={'code': 'x'}), None)
    refused = referral.module.lambda_handler(api_event('/referral/me', 'GET'), None)
    assert ok['headers']['Cache-Control'] == 'no-store'
    assert refused['headers']['Cache-Control'] == 'no-store'


def test_an_owner_name_kms_cannot_decrypt_is_withheld_not_returned_as_ciphertext(referral, capsys):
    """A value that decodes as base64 but is not a KMS ciphertext used to come
    back to the admin UI as the ciphertext itself. It is now withheld."""
    blob = base64.b64encode(b'not-a-real-kms-ciphertext-blob').decode()
    put_profile(referral, parentName=blob)
    call(referral, '/referral/me', 'GET', claims={'sub': USER})  # mints personal link

    status, body = call(referral, '/referral/admin/links', 'GET', claims=ADMIN_CLAIMS)

    assert status == 200
    personal = next(link for link in body['links'] if link['type'] == 'user')
    assert personal['ownerName'] is None
    assert blob not in json.dumps(body)
    out = capsys.readouterr().out
    assert 'owner name withheld' in out
    assert blob not in out


def test_a_legacy_plaintext_owner_name_is_still_shown(referral):
    """Rows written before name encryption hold plaintext. A value that is not
    base64 is returned unchanged, as before."""
    put_profile(referral, parentName='Jane P.')
    call(referral, '/referral/me', 'GET', claims={'sub': USER})

    status, body = call(referral, '/referral/admin/links', 'GET', claims=ADMIN_CLAIMS)

    personal = next(link for link in body['links'] if link['type'] == 'user')
    assert personal['ownerName'] == 'Jane P.'
