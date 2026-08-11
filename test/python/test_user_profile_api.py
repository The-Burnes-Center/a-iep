"""user-profile-handler API endpoint tests, driven through lambda_handler so
routing, path params, and response shaping are exercised exactly as API
Gateway invokes them. moto provides DynamoDB (profiles + documents with the
byChildId/byUserId GSIs), S3 for content.json, KMS for the PII field
encryption, and Cognito for account deletion.
"""
import base64
import json
import sys
from types import SimpleNamespace

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from conftest import load_lambda_module, unload

PROFILES_TABLE = 'profiles-test'
DOCUMENTS_TABLE = 'documents-test'
BUCKET = 'iep-bucket-test'
REFERRALS_TABLE = 'referrals-test'
KMS_ALIAS = 'alias/aiep/app-test'
USER = 'user-sub-1'


@pytest.fixture()
def api(monkeypatch):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        profiles = dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        documents = dynamodb.create_table(
            TableName=DOCUMENTS_TABLE,
            KeySchema=[
                {'AttributeName': 'iepId', 'KeyType': 'HASH'},
                {'AttributeName': 'childId', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'iepId', 'AttributeType': 'S'},
                {'AttributeName': 'childId', 'AttributeType': 'S'},
                {'AttributeName': 'userId', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'byChildId',
                    'KeySchema': [{'AttributeName': 'childId', 'KeyType': 'HASH'}],
                    'Projection': {'ProjectionType': 'ALL'},
                },
                {
                    'IndexName': 'byUserId',
                    'KeySchema': [{'AttributeName': 'userId', 'KeyType': 'HASH'}],
                    'Projection': {'ProjectionType': 'ALL'},
                },
            ],
            BillingMode='PAY_PER_REQUEST',
        )
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
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        kms = boto3.client('kms', region_name='us-east-1')
        key_id = kms.create_key()['KeyMetadata']['KeyId']
        kms.create_alias(AliasName=KMS_ALIAS, TargetKeyId=key_id)

        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('REFERRALS_TABLE', REFERRALS_TABLE)
        monkeypatch.setenv('BUCKET', BUCKET)
        monkeypatch.setenv('AIEP_KMS_KEY_ALIAS', KMS_ALIAS)
        monkeypatch.delenv('USER_POOL_ID', raising=False)

        module = load_lambda_module('user-profile-handler', 'user_profile_api')
        # router.py lazily re-imports `lambda_function` inside each route
        # method, so the loaded module must also answer to that name.
        sys.modules['lambda_function'] = module
        try:
            yield SimpleNamespace(module=module, profiles=profiles,
                                  documents=documents, s3=s3, kms=kms,
                                  referrals=referrals)
        finally:
            unload('lambda_function')
            unload('user_profile_api')
            unload('router')  # imported as a sibling during module exec


def api_event(path, method, body=None, user=USER):
    event = {
        'rawPath': path,
        'requestContext': {
            'http': {'method': method},
            'authorizer': {'jwt': {'claims': {'sub': user}}},
        },
        'headers': {'Origin': 'https://staging.example.org'},
    }
    if body is not None:
        event['body'] = json.dumps(body)
    return event


def call(api, *args, **kwargs):
    response = api.module.lambda_handler(api_event(*args, **kwargs), None)
    return response['statusCode'], json.loads(response['body'])


def call_raw_body(api, path, method, raw_body):
    """Send a body exactly as given (api_event would json.dumps it)."""
    event = api_event(path, method)
    event['body'] = raw_body
    response = api.module.lambda_handler(event, None)
    return response['statusCode'], json.loads(response['body'])


def encrypt(api, plaintext):
    blob = api.kms.encrypt(KeyId=KMS_ALIAS, Plaintext=plaintext.encode())['CiphertextBlob']
    return base64.b64encode(blob).decode()


def stored_profile(api, user=USER):
    return api.profiles.get_item(Key={'userId': user}).get('Item')


def put_document(api, iep_id='iep-1', child_id='child-1', user=USER,
                 created_at=1000, content=None, **extra):
    item = {'iepId': iep_id, 'childId': child_id, 'userId': user,
            'createdAt': created_at, 'status': 'PROCESSED', **extra}
    if content is not None:
        key = f'iep-data/{iep_id}/{child_id}/content.json'
        api.s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(content).encode())
        item['contentS3Reference'] = {'bucket': BUCKET, 's3Key': key}
    api.documents.put_item(Item=item)
    return item


def profile_with_child(api, child_id='child-1', user=USER):
    api.profiles.put_item(Item={
        'userId': user,
        'children': [{'childId': child_id, 'name': 'Kid', 'schoolCity': 'Boston'}],
    })


def put_audio(api, iep_id='iep-1', child_id='child-1', langs=('en', 'es')):
    """Seed cached TTS mp3s the way tts-handler keys them."""
    keys = []
    for lang in langs:
        key = f'iep-audio/{iep_id}/{child_id}/{lang}/summary-deadbeef.mp3'
        api.s3.put_object(Bucket=BUCKET, Key=key, Body=b'ID3fake')
        keys.append(key)
    return keys


def key_exists(api, key):
    try:
        api.s3.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError:
        return False


# ---------------------------------------------------------------------------
# GET /profile

def test_get_profile_creates_default_when_missing(api):
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    profile = body['profile']
    assert profile['consentGiven'] is False
    assert profile['showOnboarding'] is True
    assert len(profile['children']) == 1
    assert profile['children'][0]['name'] == 'My Child'
    assert stored_profile(api) is not None  # persisted, not just returned


def test_get_profile_decrypts_pii_fields(api):
    api.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'c1', 'name': 'Kid', 'schoolCity': 'x'}],
        'phone': encrypt(api, '+16175551234'),
        'parentName': encrypt(api, 'Jane P.'),
        'city': encrypt(api, 'Boston'),
    })
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert body['profile']['phone'] == '+16175551234'
    assert body['profile']['parentName'] == 'Jane P.'
    assert body['profile']['city'] == 'Boston'
    # At rest the fields stay ciphertext
    assert stored_profile(api)['phone'] != '+16175551234'


def test_get_profile_backfills_default_child(api):
    api.profiles.put_item(Item={'userId': USER, 'children': []})
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert body['profile']['children'][0]['name'] == 'My Child'
    assert stored_profile(api)['children'][0]['name'] == 'My Child'


# ---------------------------------------------------------------------------
# PUT /profile

def test_update_profile_encrypts_pii_at_rest(api):
    api.profiles.put_item(Item={'userId': USER})
    status, body = call(api, '/profile', 'PUT', body={
        'parentName': 'Jane P.', 'city': 'Boston', 'consentGiven': True,
    })
    assert status == 200

    stored = stored_profile(api)
    assert stored['consentGiven'] is True
    assert stored['parentName'] != 'Jane P.'  # ciphertext at rest
    decrypted = api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['parentName']))['Plaintext'].decode()
    assert decrypted == 'Jane P.'


@pytest.mark.parametrize('body,fragment', [
    ({'email': 'x@y.org'}, 'Email cannot be updated'),
    ({'primaryLanguage': 'fr'}, 'Unsupported language'),
    ({'secondaryLanguage': 'klingon'}, 'Unsupported language'),
    ({'consentGiven': 'yes'}, 'must be a boolean'),
    ({'showOnboarding': 1}, 'must be a boolean'),
    ({}, 'No fields to update'),
    ({'children': [{'name': 'No City Kid'}]}, 'name and schoolCity'),
])
def test_update_profile_validation(api, body, fragment):
    api.profiles.put_item(Item={'userId': USER})
    status, response = call(api, '/profile', 'PUT', body=body)
    assert status == 400
    assert fragment in response['message']


def test_update_profile_assigns_child_ids(api):
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': 'Kid', 'schoolCity': 'Boston'}],
    })
    assert status == 200
    assert stored_profile(api)['children'][0]['childId']


def test_update_profile_kms_outage_returns_503_not_plaintext(api, monkeypatch):
    api.profiles.put_item(Item={'userId': USER})
    monkeypatch.setattr(api.module, 'kms_key_alias', 'alias/does-not-exist')
    status, body = call(api, '/profile', 'PUT', body={'parentName': 'Jane P.'})
    assert status == 503
    # The profile must not have been written with plaintext PII.
    assert 'parentName' not in (stored_profile(api) or {})


@pytest.mark.parametrize('raw_body', [
    '{"parentName": "Jane P."',   # truncated JSON
    'not json at all',
    '[1, 2, 3]',                  # valid JSON but not an object
])
def test_update_profile_malformed_body_is_a_client_error(api, raw_body):
    # A bad payload is the caller's fault: 400, never a 500 from the broad
    # exception handler, and nothing may be written to the profile.
    api.profiles.put_item(Item={'userId': USER, 'consentGiven': False})
    before = stored_profile(api)
    status, body = call_raw_body(api, '/profile', 'PUT', raw_body)
    assert status == 400
    assert 'Invalid JSON' in body['message']
    assert stored_profile(api) == before


def test_server_errors_do_not_leak_internals_to_the_caller(api, monkeypatch):
    # A 2026-07-28 security review found handlers returning str(e) in the
    # response body, which hands an authenticated caller real table names and
    # AWS error codes. The detail belongs in CloudWatch, not in the payload:
    # the body must stay generic while the operator still gets the cause.
    secret = 'AIEPStagingStack-SecretTableName-XYZ'

    def explode(*args, **kwargs):
        raise ClientError(
            {'Error': {'Code': 'ValidationException',
                       'Message': f'Requested resource not found: {secret}'}},
            'UpdateItem',
        )

    monkeypatch.setattr(api.module.user_profiles_table, 'update_item', explode)
    monkeypatch.setattr(api.module.user_profiles_table, 'put_item', explode)
    api.profiles.put_item(Item={'userId': USER, 'consentGiven': True})

    status, body = call(api, '/profile', 'PUT', {'parentName': 'Jane P.'})

    assert status == 500
    assert secret not in json.dumps(body)
    assert 'ValidationException' not in json.dumps(body)
    assert body['message'] == 'Could not update your profile. Please try again later.'


def test_update_profile_language_sync_failure_is_non_blocking(api):
    # No USER_POOL_ID configured: the Cognito locale mirror fails, the
    # profile update itself must still succeed.
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={'secondaryLanguage': 'es'})
    assert status == 200
    assert stored_profile(api)['secondaryLanguage'] == 'es'


# ---------------------------------------------------------------------------
# POST /profile/children

def test_add_child_appends(api):
    profile_with_child(api)
    status, body = call(api, '/profile/children', 'POST',
                        body={'name': 'Second Kid', 'schoolCity': 'Cambridge'})
    assert status == 200
    assert body['childId']
    children = stored_profile(api)['children']
    assert [child['name'] for child in children] == ['Kid', 'Second Kid']


def test_add_child_requires_fields(api):
    profile_with_child(api)
    status, body = call(api, '/profile/children', 'POST', body={'name': 'Kid'})
    assert status == 400


def test_add_child_malformed_body_is_a_client_error(api):
    profile_with_child(api)
    before = stored_profile(api)
    status, body = call_raw_body(api, '/profile/children', 'POST', '{"name": ')
    assert status == 400
    assert 'Invalid JSON' in body['message']
    assert stored_profile(api) == before  # no child appended


# ---------------------------------------------------------------------------
# GET /profile/children/{childId}/documents

def test_get_documents_denies_unowned_child(api):
    profile_with_child(api, child_id='child-1')
    status, body = call(api, '/profile/children/child-9/documents', 'GET')
    assert status == 403


def test_get_documents_empty(api):
    profile_with_child(api)
    status, body = call(api, '/profile/children/child-1/documents', 'GET')
    assert status == 200
    assert body['documents'] == []


def test_get_documents_returns_latest_with_s3_content(api):
    profile_with_child(api)
    put_document(api, iep_id='iep-old', created_at=1000,
                 content={'summaries': {'en': 'Old summary'}})
    put_document(api, iep_id='iep-new', created_at=2000,
                 content={'summaries': {'en': 'New summary'},
                          'sections': {'en': [{'title': 'Goals', 'content': 'G'}]}})

    status, body = call(api, '/profile/children/child-1/documents', 'GET')
    assert status == 200
    assert body['iepId'] == 'iep-new'
    assert body['summaries']['en'] == 'New summary'
    assert body['sections']['en'][0]['title'] == 'Goals'
    assert body['status'] == 'PROCESSED'


def test_get_documents_never_returns_other_users_docs(api):
    # Same childId in the index but owned by someone else: strict userId
    # match must hide it (IDOR guard).
    profile_with_child(api)
    put_document(api, user='someone-else', content={'summaries': {'en': 'Not yours'}})
    status, body = call(api, '/profile/children/child-1/documents', 'GET')
    assert status == 200
    assert body['documents'] == []


# ---------------------------------------------------------------------------
# DELETE /profile/children/{childId}/documents

def test_delete_documents_denies_unowned_child(api):
    profile_with_child(api, child_id='child-1')
    assert call(api, '/profile/children/child-9/documents', 'DELETE')[0] == 403


def test_delete_documents_removes_s3_and_records(api):
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    api.s3.put_object(Bucket=BUCKET, Key=f'{USER}/child-1/iep-1/original.pdf', Body=b'pdf')

    status, body = call(api, '/profile/children/child-1/documents', 'DELETE')
    assert status == 200

    remaining = api.s3.list_objects_v2(Bucket=BUCKET, Prefix=f'{USER}/child-1/')
    assert remaining.get('KeyCount', 0) == 0
    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is None


# ---------------------------------------------------------------------------
# DELETE /profile

def test_delete_profile_wipes_user_data_even_without_cognito(api):
    profile_with_child(api)
    put_document(api)
    api.s3.put_object(Bucket=BUCKET, Key=f'{USER}/child-1/iep-1/original.pdf', Body=b'pdf')

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200
    summary = body['deletionSummary']
    assert summary['profileDeleted'] is True
    assert summary['documentsDeleted'] == 1
    assert summary['s3ObjectsDeleted'] == 1
    # Documented quirk (plan section 9): Cognito deletion is best-effort;
    # with no pool configured the response is still 200 and the flag False.
    assert summary['cognitoUserDeleted'] is False
    assert stored_profile(api) is None


def test_delete_profile_purges_every_file_under_iep_data(api):
    """content.json is not the only file there.

    Production holds three names under iep-data/{iepId}/{childId}/:
    content.json, redacted_ocr_result.json and ocr_result.json. Deleting only
    content.json by name left the redacted OCR text behind on every account
    deletion, and the raw unredacted OCR too whenever the pipeline died before
    DeleteOriginal ran. Found by reading the delete markers a real prod upload
    left at 2026-08-11T17:35:06Z.
    """
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    extra = {
        'iep-data/iep-1/child-1/redacted_ocr_result.json': b'{"redacted": "text"}',
        'iep-data/iep-1/child-1/ocr_result.json': b'{"raw": "unredacted text"}',
    }
    for key, body in extra.items():
        api.s3.put_object(Bucket=BUCKET, Key=key, Body=body)

    assert call(api, '/profile', 'DELETE')[0] == 200

    for key in extra:
        assert key_exists(api, key) is False, f'FERPA content left behind: {key}'
    assert key_exists(api, 'iep-data/iep-1/child-1/content.json') is False


def test_delete_child_documents_purges_every_file_under_iep_data(api):
    """Same gap, same fix, on the per-child path."""
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    api.s3.put_object(Bucket=BUCKET,
                      Key='iep-data/iep-1/child-1/redacted_ocr_result.json',
                      Body=b'{"redacted": "text"}')

    assert call(api, '/profile/children/child-1/documents', 'DELETE')[0] == 200

    assert key_exists(api, 'iep-data/iep-1/child-1/redacted_ocr_result.json') is False


def test_delete_profile_purges_derived_artifacts_not_just_raw_uploads(api):
    """Account deletion must not strand the summary or the cached audio.

    Regression: the sweep only covered the userId/ prefix, which holds the raw
    upload. iep-data/ and iep-audio/ live outside it, and the rows that point
    at them were deleted first, so 17 orphaned content directories accumulated
    in production. All three classes must be gone, and the row with them.
    """
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    audio_keys = put_audio(api)
    raw_key = f'{USER}/child-1/iep-1/original.pdf'
    api.s3.put_object(Bucket=BUCKET, Key=raw_key, Body=b'pdf')

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200

    assert key_exists(api, raw_key) is False, 'raw upload survived'
    assert key_exists(api, 'iep-data/iep-1/child-1/content.json') is False, \
        'redacted summary orphaned in S3'
    for key in audio_keys:
        assert key_exists(api, key) is False, f'cached audio orphaned: {key}'

    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is None
    assert stored_profile(api) is None
    # 1 raw + 1 content.json + 2 mp3s, counted only for keys that existed.
    assert body['deletionSummary']['s3ObjectsDeleted'] == 4
    assert body['deletionSummary']['documentsDeleted'] == 1


def test_delete_profile_purges_every_document_across_query_pages(api, monkeypatch):
    """A single query page caps at 1MB; the overflow rows must not survive."""
    for n in range(3):
        put_document(api, iep_id=f'iep-{n}', content={'summaries': {'en': 'S'}})
        put_audio(api, iep_id=f'iep-{n}')

    # Force the GSI read to hand back one row per page.
    real_query = api.documents.query
    pages = {'count': 0}

    def paged_query(**kwargs):
        kwargs['Limit'] = 1
        pages['count'] += 1
        return real_query(**kwargs)

    monkeypatch.setattr(api.module.iep_documents_table, 'query', paged_query)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200
    assert pages['count'] > 1, 'pagination never exercised; test proves nothing'
    assert body['deletionSummary']['documentsDeleted'] == 3
    for n in range(3):
        assert api.documents.get_item(
            Key={'iepId': f'iep-{n}', 'childId': 'child-1'}).get('Item') is None
        assert key_exists(api, f'iep-data/iep-{n}/child-1/content.json') is False
        assert key_exists(api, f'iep-audio/iep-{n}/child-1/en/summary-deadbeef.mp3') is False


def test_delete_child_documents_purges_cached_audio(api):
    """The per-child path purged content but left iep-audio/ behind."""
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    audio_keys = put_audio(api)

    assert call(api, '/profile/children/child-1/documents', 'DELETE')[0] == 200

    for key in audio_keys:
        assert key_exists(api, key) is False, f'cached audio orphaned: {key}'
    assert key_exists(api, 'iep-data/iep-1/child-1/content.json') is False


def test_delete_profile_keeps_going_when_one_artifact_delete_fails(api, monkeypatch):
    """An S3 failure must not abort the account deletion."""
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})

    def boom(*args, **kwargs):
        raise ClientError({'Error': {'Code': 'InternalError'}}, 'HeadObject')

    monkeypatch.setattr(api.module, '_delete_document_artifacts', boom)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200
    assert body['deletionSummary']['documentsDeleted'] == 1
    assert stored_profile(api) is None


def test_delete_profile_deletes_cognito_account_when_configured(api, monkeypatch):
    cognito = boto3.client('cognito-idp', region_name='us-east-1')
    pool_id = cognito.create_user_pool(PoolName='pool')['UserPool']['Id']
    cognito.admin_create_user(UserPoolId=pool_id, Username=USER, MessageAction='SUPPRESS')
    monkeypatch.setenv('USER_POOL_ID', pool_id)
    profile_with_child(api)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200
    assert body['deletionSummary']['cognitoUserDeleted'] is True
    with pytest.raises(cognito.exceptions.UserNotFoundException):
        cognito.admin_get_user(UserPoolId=pool_id, Username=USER)


# ---------------------------------------------------------------------------
# Routing

def test_options_and_unknown_routes(api):
    options_event = api_event('/profile', 'OPTIONS')
    assert api.module.lambda_handler(options_event, None)['statusCode'] == 200
    assert call(api, '/profile/unknown', 'GET')[0] == 404


# ---------------------------------------------------------------------------
# Account deletion and referral data
#
# Rule: deleting an account removes everything about them. A user's own link
# is theirs and goes. A signup event under SOMEONE ELSE'S link records that
# they joined, so deleting it would silently decrement that referrer's count;
# the personal reference is redacted instead and the event survives to be
# counted.

def test_account_delete_removes_the_users_own_referral_link_and_events(api):
    api.referrals.put_item(Item={'code': 'MINE', 'sk': 'META',
                                 'ownerUserId': USER, 'type': 'user',
                                 'clicks': 3, 'signups': 1})
    api.referrals.put_item(Item={'code': 'MINE', 'sk': 'EVT#CLICK#1#a'})
    api.referrals.put_item(Item={'code': 'MINE', 'sk': 'EVT#SIGNUP#2#b',
                                 'referredUserId': 'someone-else'})
    profile_with_child(api)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200

    remaining = api.referrals.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('code').eq('MINE'))
    assert remaining['Items'] == [], 'the user kept their referral link'
    assert body['deletionSummary']['referrals']['linksDeleted'] == 1
    assert body['deletionSummary']['referrals']['eventsDeleted'] == 2


def test_account_delete_redacts_but_keeps_a_referrers_signup_event(api):
    """The referrer's count must survive; the identifier must not."""
    api.referrals.put_item(Item={'code': 'THEIRS', 'sk': 'META',
                                 'ownerUserId': 'other-user', 'signups': 1})
    api.referrals.put_item(Item={'code': 'THEIRS', 'sk': 'EVT#SIGNUP#9#z',
                                 'referredUserId': USER})
    profile_with_child(api)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200

    event = api.referrals.get_item(
        Key={'code': 'THEIRS', 'sk': 'EVT#SIGNUP#9#z'})['Item']
    assert 'referredUserId' not in event, 'personal reference survived deletion'
    assert 'redactedAt' in event
    # The referrer's own link and counter are untouched
    meta = api.referrals.get_item(Key={'code': 'THEIRS', 'sk': 'META'})['Item']
    assert meta['ownerUserId'] == 'other-user' and meta['signups'] == 1
    assert body['deletionSummary']['referrals']['referencesRedacted'] == 1


def test_account_delete_leaves_other_users_referrals_alone(api):
    api.referrals.put_item(Item={'code': 'OTHER', 'sk': 'META',
                                 'ownerUserId': 'other-user'})
    api.referrals.put_item(Item={'code': 'OTHER', 'sk': 'EVT#CLICK#1#q'})
    profile_with_child(api)

    assert call(api, '/profile', 'DELETE')[0] == 200

    kept = api.referrals.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('code').eq('OTHER'))
    assert len(kept['Items']) == 2, "another user's referral data was deleted"


def test_account_delete_survives_referrals_table_not_being_configured(api, monkeypatch):
    """Missing env must skip cleanup, not abort the account deletion."""
    monkeypatch.delenv('REFERRALS_TABLE', raising=False)
    profile_with_child(api)
    status, body = call(api, '/profile', 'DELETE')
    assert status == 200
    assert body['deletionSummary']['profileDeleted'] is True
    assert body['deletionSummary']['referrals']['linksDeleted'] == 0
