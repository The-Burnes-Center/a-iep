"""Referral system handler.

One Lambda behind four kinds of routes:
  POST /referral/click              public: count a link visit
  GET  /referral/me                 caller's personal code + stats
  POST /referral/attribute          stamp the caller's signup attribution
  *    /referral/admin/...          campaign-link CRUD + metrics ('admin' group only)

Data model (REFERRALS_TABLE, PK 'code', SK 'sk'):
  sk 'META'                 the link: type 'campaign'|'user', ownerUserId,
                            name/channel/notes, active, clicks, signups
  sk 'EVT#CLICK#<ts>#<id>'  click event (ttl ~400 days)
  sk 'EVT#SIGNUP#<ts>#<id>' signup event (kept; carries referredUserId)

Privacy: no IP addresses or user agents are stored, click events expire via
TTL, and referrers are shown join dates only, never who joined.
"""

import json
import os
import re
import secrets
import base64
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')
referrals_table = dynamodb.Table(os.environ['REFERRALS_TABLE'])
user_profiles_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])
cognito = boto3.client('cognito-idp')
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
kms_client = boto3.client('kms')

META = 'META'
ADMIN_GROUP = 'admin'

# Campaign slugs are chosen by admins; personal codes are generated. Both live
# in one namespace and must fit in a short shareable path (/r/<code>).
CODE_PATTERN = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$')
# Personal-code alphabet avoids ambiguous characters (0/o, 1/l).
CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
CODE_LENGTH = 6

# Attribution requires the click to have happened at or before signup (the
# client sends when it captured the code); CAPTURE_GRACE_MS only absorbs
# client/server clock skew, not a real gap. Account age alone doesn't prove
# the click caused the signup: an existing user who clicks a link later is
# still "new" by that measure for their first week.
CAPTURE_GRACE_MS = 10 * 60 * 1000
# Defense in depth: the client already discards pending codes older than 30
# days, so a much-older capture reaching here implies tampering, not a slow
# signup.
MAX_CAPTURE_AGE_DAYS = 35
CLICK_EVENT_TTL_DAYS = 400
CHANNELS = ['social', 'conference', 'event', 'print', 'partner', 'other']


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super().default(obj)


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def now_epoch_seconds():
    return int(datetime.now(timezone.utc).timestamp())


def create_response(event, status_code, body):
    headers = event.get('headers') or {}
    origin = next((headers[k] for k in headers if k.lower() == 'origin'), '*')
    return {
        'statusCode': status_code,
        'headers': {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
            'Content-Type': 'application/json',
        },
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def parse_body(event):
    """Parse the request body as JSON. sendBeacon posts text/plain, so this
    never trusts the Content-Type header."""
    raw = event.get('body')
    if raw is None:
        return {}
    if event.get('isBase64Encoded'):
        raw = base64.b64decode(raw).decode('utf-8', errors='replace')
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def get_claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return None


def is_admin(claims):
    """True when the JWT carries the admin group. The HTTP API authorizer
    serializes the cognito:groups claim as '[a b]' or 'a,b' depending on
    shape, so accept lists and both string forms."""
    groups = claims.get('cognito:groups') or []
    if isinstance(groups, str):
        stripped = groups.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            stripped = stripped[1:-1]
        groups = [g for g in re.split(r'[,\s]+', stripped) if g]
    return ADMIN_GROUP in groups


def normalize_code(value):
    """Lowercased, validated code or None."""
    if not isinstance(value, str):
        return None
    code = value.strip().lower()
    return code if CODE_PATTERN.match(code) else None


def get_meta(code):
    response = referrals_table.get_item(Key={'code': code, 'sk': META})
    return response.get('Item')


def put_event(code, kind, extra=None):
    item = {
        'code': code,
        'sk': f"EVT#{kind.upper()}#{now_iso()}#{secrets.token_hex(4)}",
        'kind': kind,
        'at': now_iso(),
    }
    if kind == 'click':
        item['ttl'] = now_epoch_seconds() + CLICK_EVENT_TTL_DAYS * 86400
    if extra:
        item.update(extra)
    referrals_table.put_item(Item=item)


def bump_counter(code, counter):
    referrals_table.update_item(
        Key={'code': code, 'sk': META},
        UpdateExpression=f'ADD {counter} :one',
        ExpressionAttributeValues={':one': 1},
    )


# ---------------------------------------------------------------------------
# Public

def handle_click(event):
    """Count a link visit. Always answers 200 so callers can't probe which
    codes exist; only known active codes are counted."""
    code = normalize_code(parse_body(event).get('code'))
    if code:
        meta = get_meta(code)
        if meta and meta.get('active'):
            bump_counter(code, 'clicks')
            put_event(code, 'click')
    return create_response(event, 200, {'ok': True})


# ---------------------------------------------------------------------------
# Authenticated user

def find_personal_code(user_id):
    response = referrals_table.query(
        IndexName='byOwner',
        KeyConditionExpression=Key('ownerUserId').eq(user_id),
        Limit=1,
    )
    items = response.get('Items') or []
    return items[0]['code'] if items else None


def create_personal_code(user_id):
    for _ in range(8):
        candidate = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        try:
            referrals_table.put_item(
                Item={
                    'code': candidate,
                    'sk': META,
                    'type': 'user',
                    'ownerUserId': user_id,
                    'active': True,
                    'clicks': 0,
                    'signups': 0,
                    'createdAt': now_iso(),
                },
                ConditionExpression='attribute_not_exists(code)',
            )
            return candidate
        except referrals_table.meta.client.exceptions.ConditionalCheckFailedException:
            continue
    raise RuntimeError('could not allocate a personal referral code')


def handle_me(event):
    user_id = get_claims(event)['sub']

    # Profile mirror first (strongly consistent), GSI as fallback, then mint.
    profile = user_profiles_table.get_item(Key={'userId': user_id}).get('Item') or {}
    code = normalize_code(profile.get('referralCode')) or find_personal_code(user_id)
    if not code:
        code = create_personal_code(user_id)
        # Convenience mirror on the profile; the byOwner GSI stays the source
        # of truth, so a missing profile row is fine to ignore here.
        try:
            user_profiles_table.update_item(
                Key={'userId': user_id},
                UpdateExpression='SET referralCode = :c',
                ConditionExpression='attribute_exists(userId)',
                ExpressionAttributeValues={':c': code},
            )
        except user_profiles_table.meta.client.exceptions.ConditionalCheckFailedException:
            pass

    meta = get_meta(code) or {}
    joins = referrals_table.query(
        KeyConditionExpression=Key('code').eq(code) & Key('sk').begins_with('EVT#SIGNUP#'),
        ScanIndexForward=False,
        Limit=50,
    ).get('Items') or []

    return create_response(event, 200, {
        'code': code,
        'clicks': meta.get('clicks', 0),
        'signups': meta.get('signups', 0),
        # Dates only, never identities: joining implies a child with an IEP,
        # which is not the referrer's information to have.
        'joins': [{'joinedAt': item.get('at')} for item in joins],
    })


def handle_attribute(event):
    """Stamp the caller's profile with the referral code they arrived on.
    Rejections return 200 with attributed=false so the client can clear its
    pending code either way."""
    user_id = get_claims(event)['sub']
    body = parse_body(event)

    def rejected(reason):
        print(f"attribution rejected ({reason}) for user {user_id}")
        return create_response(event, 200, {'attributed': False, 'reason': reason})

    code = normalize_code(body.get('code'))
    if not code:
        return rejected('invalid_code')

    captured_at = body.get('capturedAt')
    if not isinstance(captured_at, (int, float)) or captured_at <= 0:
        return rejected('invalid_capture')
    captured_at = int(captured_at)

    meta = get_meta(code)
    if not meta or not meta.get('active'):
        return rejected('invalid_code')
    # Covers both link kinds: a parent's own code (ownerUserId) and a
    # campaign link an admin created and then clicked themselves to test
    # (createdBy) — the latter has no owner but is just as much self-referral.
    if user_id in (meta.get('ownerUserId'), meta.get('createdBy')):
        return rejected('self_referral')

    profile = user_profiles_table.get_item(Key={'userId': user_id}).get('Item')
    if not profile:
        return rejected('no_profile')
    if profile.get('referredBy'):
        return rejected('already_attributed')

    created_ms = int(profile.get('createdAt') or 0)
    if created_ms <= 0:
        return rejected('no_profile')
    if created_ms < 10**12:  # tolerate second-resolution timestamps
        created_ms *= 1000

    # The click must precede signup (small grace for clock skew): this is
    # what actually distinguishes "this link brought in a new user" from "an
    # existing user later clicked a link". Account age alone doesn't do that.
    if captured_at > created_ms + CAPTURE_GRACE_MS:
        return rejected('click_after_signup')
    if created_ms - captured_at > MAX_CAPTURE_AGE_DAYS * 86400000:
        return rejected('capture_too_old')

    try:
        user_profiles_table.update_item(
            Key={'userId': user_id},
            UpdateExpression='SET referredBy = :code, referredAt = :at',
            ConditionExpression='attribute_exists(userId) AND attribute_not_exists(referredBy)',
            ExpressionAttributeValues={':code': code, ':at': now_iso()},
        )
    except user_profiles_table.meta.client.exceptions.ConditionalCheckFailedException:
        return rejected('already_attributed')

    bump_counter(code, 'signups')
    put_event(code, 'signup', {'referredUserId': user_id})
    print(f"attribution recorded: code {code}")
    return create_response(event, 200, {'attributed': True})


# ---------------------------------------------------------------------------
# Admin

def kms_decrypt_string(ciphertext_b64):
    """Decrypt an app-layer-encrypted profile field. Mirrors the helper in
    user-profile-handler: values that are not valid ciphertext (legacy
    plaintext rows, encryption disabled) are returned as-is."""
    if not ciphertext_b64 or not isinstance(ciphertext_b64, str):
        return ciphertext_b64
    try:
        blob = base64.b64decode(ciphertext_b64)
    except Exception:
        return ciphertext_b64
    try:
        return kms_client.decrypt(CiphertextBlob=blob)['Plaintext'].decode('utf-8')
    except Exception as exc:
        print(f"KMS decrypt failed, returning raw value: {exc}")
        return ciphertext_b64


def attach_owner_names(links):
    """Resolve each personal link's owner to the parent's name so admins can
    tell whose link is whose. parentName lives KMS-encrypted on the profile;
    one decrypt call per distinct owner, fine at internal-console scale."""
    owner_ids = list({
        link['ownerUserId'] for link in links
        if link.get('type') == 'user' and link.get('ownerUserId')
    })
    names = {}
    for start in range(0, len(owner_ids), 100):
        chunk = owner_ids[start:start + 100]
        response = dynamodb.batch_get_item(RequestItems={
            user_profiles_table.name: {
                'Keys': [{'userId': uid} for uid in chunk],
                'ProjectionExpression': 'userId, parentName',
            }
        })
        for item in response.get('Responses', {}).get(user_profiles_table.name, []):
            if item.get('parentName'):
                names[item['userId']] = kms_decrypt_string(item['parentName'])
    for link in links:
        if link.get('type') == 'user':
            link['ownerName'] = names.get(link.get('ownerUserId'))


def strip_meta(item):
    return {
        'code': item.get('code'),
        'type': item.get('type'),
        'name': item.get('name'),
        'channel': item.get('channel'),
        'notes': item.get('notes'),
        'active': bool(item.get('active')),
        'clicks': item.get('clicks', 0),
        'signups': item.get('signups', 0),
        'createdAt': item.get('createdAt'),
        'ownerUserId': item.get('ownerUserId'),
        'ownerName': item.get('ownerName'),
    }


def handle_admin_list(event):
    from boto3.dynamodb.conditions import Attr
    items, start_key = [], None
    while True:
        kwargs = {'FilterExpression': Attr('sk').eq(META)}
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        response = referrals_table.scan(**kwargs)
        items.extend(response.get('Items') or [])
        start_key = response.get('LastEvaluatedKey')
        if not start_key:
            break
    links = sorted((strip_meta(i) for i in items),
                   key=lambda x: x.get('createdAt') or '', reverse=True)
    attach_owner_names(links)
    return create_response(event, 200, {'links': links})


def handle_admin_create(event):
    claims = get_claims(event)
    body = parse_body(event)

    code = normalize_code(body.get('code'))
    if not code:
        return create_response(event, 400, {
            'message': 'code must be 1-32 chars: lowercase letters, digits, hyphens'})

    channel = body.get('channel') if body.get('channel') in CHANNELS else 'other'
    item = {
        'code': code,
        'sk': META,
        'type': 'campaign',
        'name': str(body.get('name') or '')[:120],
        'channel': channel,
        'notes': str(body.get('notes') or '')[:500],
        'active': True,
        'clicks': 0,
        'signups': 0,
        'createdAt': now_iso(),
        'createdBy': claims['sub'],
    }
    try:
        referrals_table.put_item(Item=item, ConditionExpression='attribute_not_exists(code)')
    except referrals_table.meta.client.exceptions.ConditionalCheckFailedException:
        return create_response(event, 409, {'message': f"code '{code}' is already taken"})
    return create_response(event, 201, {'link': strip_meta(item)})


def handle_admin_get(event, code):
    code = normalize_code(code)
    meta = get_meta(code) if code else None
    if not meta:
        return create_response(event, 404, {'message': 'not found'})
    events = referrals_table.query(
        KeyConditionExpression=Key('code').eq(code) & Key('sk').begins_with('EVT#'),
        ScanIndexForward=False,
        Limit=200,
    ).get('Items') or []
    # referredUserId stays out of the response: the console needs kinds and
    # dates, not identities.
    link = strip_meta(meta)
    attach_owner_names([link])
    return create_response(event, 200, {
        'link': link,
        'events': [{'kind': e.get('kind'), 'at': e.get('at')} for e in events],
    })


def handle_admin_update(event, code):
    code = normalize_code(code)
    if not code:
        return create_response(event, 400, {'message': 'invalid code'})
    body = parse_body(event)

    parts, names, values = [], {}, {}
    for field, max_len in (('name', 120), ('channel', 40), ('notes', 500)):
        if field in body:
            parts.append(f'#{field} = :{field}')
            names[f'#{field}'] = field
            values[f':{field}'] = str(body[field] or '')[:max_len]
    if 'active' in body:
        parts.append('#active = :active')
        names['#active'] = 'active'
        values[':active'] = bool(body['active'])
    if not parts:
        return create_response(event, 400, {'message': 'nothing to update'})

    try:
        referrals_table.update_item(
            Key={'code': code, 'sk': META},
            UpdateExpression='SET ' + ', '.join(parts),
            ConditionExpression='attribute_exists(code)',
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except referrals_table.meta.client.exceptions.ConditionalCheckFailedException:
        return create_response(event, 404, {'message': 'not found'})
    return create_response(event, 200, {'ok': True})


# ---------------------------------------------------------------------------
# Admin management (admins manage admins; the group can also be edited from
# the Cognito console). Self-removal is blocked so the group can never be
# emptied from the app.

def _cognito_user_summary(user):
    attrs = {a['Name']: a['Value'] for a in user.get('Attributes', [])}
    return {
        'username': user.get('Username'),
        'sub': attrs.get('sub'),
        'phone': attrs.get('phone_number'),
        'email': attrs.get('email'),
        'name': attrs.get('name'),
        'status': user.get('UserStatus'),
    }


def handle_admin_list_admins(event):
    admins, token = [], None
    while True:
        kwargs = {'UserPoolId': USER_POOL_ID, 'GroupName': ADMIN_GROUP, 'Limit': 60}
        if token:
            kwargs['NextToken'] = token
        response = cognito.list_users_in_group(**kwargs)
        admins.extend(response.get('Users') or [])
        token = response.get('NextToken')
        if not token:
            break
    return create_response(event, 200, {'admins': [_cognito_user_summary(u) for u in admins]})


def handle_admin_add_admin(event):
    identifier = str(parse_body(event).get('identifier') or '').strip()
    if not identifier:
        return create_response(event, 400, {'message': 'phone number or email required'})

    if '@' in identifier:
        search_filter = f'email = "{identifier}"'
    else:
        digits = re.sub(r'[^\d+]', '', identifier)
        if digits.startswith('+'):
            phone = digits
        elif len(digits) == 10:  # US number without country code
            phone = '+1' + digits
        else:
            phone = '+' + digits
        search_filter = f'phone_number = "{phone}"'

    users = cognito.list_users(
        UserPoolId=USER_POOL_ID, Filter=search_filter, Limit=10
    ).get('Users') or []
    if not users:
        return create_response(event, 404, {'message': 'no account found for that phone/email'})
    if len(users) > 1:
        return create_response(event, 409, {'message': 'multiple accounts match; use the Cognito console'})

    cognito.admin_add_user_to_group(
        UserPoolId=USER_POOL_ID, GroupName=ADMIN_GROUP, Username=users[0]['Username'])
    return create_response(event, 200, {'admin': _cognito_user_summary(users[0])})


def handle_admin_remove_admin(event, username):
    claims = get_claims(event)
    try:
        user = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username)
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'UserNotFoundException':
            return create_response(event, 404, {'message': 'user not found'})
        raise

    target_sub = next(
        (a['Value'] for a in user.get('UserAttributes', []) if a['Name'] == 'sub'), None)
    caller_ids = {claims.get('sub'), claims.get('cognito:username')}
    if username in caller_ids or (target_sub and target_sub in caller_ids):
        return create_response(event, 400, {'message': 'you cannot remove yourself'})

    cognito.admin_remove_user_from_group(
        UserPoolId=USER_POOL_ID, GroupName=ADMIN_GROUP, Username=username)
    return create_response(event, 200, {'ok': True})


# ---------------------------------------------------------------------------

ADMIN_LINK_PATTERN = re.compile(r'^/referral/admin/links/([^/]+)$')
ADMIN_ADMIN_PATTERN = re.compile(r'^/referral/admin/admins/([^/]+)$')


def lambda_handler(event, context):
    path = event.get('rawPath') or ''
    method = (event.get('requestContext') or {}).get('http', {}).get('method', '')
    print(f"{method} {path}")

    try:
        if path == '/referral/click' and method == 'POST':
            return handle_click(event)

        claims = get_claims(event)
        if not claims:
            return create_response(event, 401, {'message': 'unauthorized'})

        if path == '/referral/me' and method == 'GET':
            return handle_me(event)
        if path == '/referral/attribute' and method == 'POST':
            return handle_attribute(event)

        if path.startswith('/referral/admin/'):
            if not is_admin(claims):
                return create_response(event, 403, {'message': 'forbidden'})
            if path == '/referral/admin/links' and method == 'GET':
                return handle_admin_list(event)
            if path == '/referral/admin/links' and method == 'POST':
                return handle_admin_create(event)
            if path == '/referral/admin/admins' and method == 'GET':
                return handle_admin_list_admins(event)
            if path == '/referral/admin/admins' and method == 'POST':
                return handle_admin_add_admin(event)
            admin_match = ADMIN_ADMIN_PATTERN.match(path)
            if admin_match and method == 'DELETE':
                return handle_admin_remove_admin(event, admin_match.group(1))
            match = ADMIN_LINK_PATTERN.match(path)
            if match and method == 'GET':
                return handle_admin_get(event, match.group(1))
            if match and method == 'PUT':
                return handle_admin_update(event, match.group(1))

        return create_response(event, 404, {'message': 'not found'})
    except Exception as exc:  # pragma: no cover
        # Never log the event: headers carry the bearer token.
        print(f"Error handling {method} {path}: {exc}")
        return create_response(event, 500, {'message': 'internal error'})
