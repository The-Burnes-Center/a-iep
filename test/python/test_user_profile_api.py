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

from conftest import (FakeLambdaClient, ScopedBoto3, load_lambda_module,
                      unload)

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
        # A signed-in user always has a Cognito account behind them, and CDK
        # always passes USER_POOL_ID, so the fixture provides both. It used to
        # provide neither, which was fine while a surviving login was reported
        # as a successful account deletion; now that it is reported as a
        # failure, "no pool configured" has to be an explicit case (see
        # test_delete_profile_wipes_user_data_even_without_cognito) rather
        # than the default every test runs under.
        cognito = boto3.client('cognito-idp', region_name='us-east-1')
        pool_id = cognito.create_user_pool(PoolName='api-fixture-pool')['UserPool']['Id']
        cognito.admin_create_user(UserPoolId=pool_id, Username=USER,
                                  MessageAction='SUPPRESS')

        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('REFERRALS_TABLE', REFERRALS_TABLE)
        monkeypatch.setenv('BUCKET', BUCKET)
        monkeypatch.setenv('AIEP_KMS_KEY_ALIAS', KMS_ALIAS)
        monkeypatch.setenv('USER_POOL_ID', pool_id)

        module = load_lambda_module('user-profile-handler', 'user_profile_api')
        # router.py lazily re-imports `lambda_function` inside each route
        # method, so the loaded module must also answer to that name.
        sys.modules['lambda_function'] = module
        try:
            yield SimpleNamespace(module=module, profiles=profiles,
                                  documents=documents, s3=s3, kms=kms,
                                  referrals=referrals, cognito=cognito,
                                  pool_id=pool_id)
        finally:
            unload('lambda_function')
            unload('user_profile_api')
            unload('router')  # imported as a sibling during module exec
            unload('student_name_substitution')  # both lambdas ship one; do not leak it


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
    # NOT 'My Child': that placeholder used to go here, but the redaction
    # pipeline restores this value verbatim into the summary, so onboarding's
    # studentNameGate must see a genuinely empty name until a parent supplies
    # one (docs/STUDENT_NAME_REDACTION_PLAN.md).
    assert profile['children'][0]['name'] == ''
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


def test_get_profile_decrypts_child_name(api):
    api.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'c1', 'name': encrypt(api, 'Alex Rivera'), 'schoolCity': 'Boston'}],
    })
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert body['profile']['children'][0]['name'] == 'Alex Rivera'
    # At rest the field stays ciphertext
    assert stored_profile(api)['children'][0]['name'] != 'Alex Rivera'


def test_get_profile_reads_a_legacy_plaintext_child_name(api):
    # Every row written before this change has a plaintext name; the decrypt
    # helper must fall through to it rather than fail the whole profile read.
    api.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'c1', 'name': 'Kid', 'schoolCity': 'x'}],
    })
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert body['profile']['children'][0]['name'] == 'Kid'


def test_get_profile_reads_a_legacy_plaintext_name_shaped_like_base64(api):
    # 'Alex' is 4 characters of base64 alphabet, so base64.b64decode('Alex')
    # succeeds where 'Kid' (odd length) would raise -- this drives the
    # decrypt attempt past the initial "does this even look like base64"
    # check and into a real (failing) KMS call on garbage ciphertext, which
    # must still fall back to the plaintext rather than surface an error or
    # drop the name.
    assert len(base64.b64decode('Alex')) > 0  # sanity: this name IS base64-shaped
    api.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'c1', 'name': 'Alex', 'schoolCity': 'x'}],
    })
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert body['profile']['children'][0]['name'] == 'Alex'


def test_get_profile_backfills_default_child(api):
    api.profiles.put_item(Item={'userId': USER, 'children': []})
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert body['profile']['children'][0]['name'] == ''
    assert stored_profile(api)['children'][0]['name'] == ''


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
    ({'children': [{'name': '', 'schoolCity': 'Boston'}]}, 'blank'),
    ({'children': [{'name': '   ', 'schoolCity': 'Boston'}]}, 'blank'),
])
def test_update_profile_validation(api, body, fragment):
    api.profiles.put_item(Item={'userId': USER})
    status, response = call(api, '/profile', 'PUT', body=body)
    assert status == 400
    assert fragment in response['message']


def test_update_profile_rejects_blank_child_name_and_logs_it(api, capsys):
    # Same rule as add_child, and the same reason: a present-but-blank name
    # used to pass ('name' in child was the whole check), which is exactly
    # the value the redaction pipeline has nothing to restore from. An
    # unlogged validation rejection already made one real failure in this
    # file undiagnosable, so the reason must reach CloudWatch.
    api.profiles.put_item(Item={'userId': USER})
    status, body = call(api, '/profile', 'PUT', body={
        'children': [{'name': '   ', 'schoolCity': 'Boston'}],
    })
    assert status == 400
    assert body['message'] == 'Child name cannot be blank'
    assert 'blank or whitespace-only child name' in capsys.readouterr().out
    assert stored_profile(api) == {'userId': USER}  # nothing written


def test_update_profile_assigns_child_ids(api):
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': 'Kid', 'schoolCity': 'Boston'}],
    })
    assert status == 200
    assert stored_profile(api)['children'][0]['childId']


def test_update_profile_encrypts_child_name_at_rest(api):
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': 'Alex Rivera', 'schoolCity': 'Boston'}],
    })
    assert status == 200
    stored = stored_profile(api)['children'][0]
    assert stored['name'] != 'Alex Rivera'  # ciphertext at rest
    decrypted = api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['name']))['Plaintext'].decode()
    assert decrypted == 'Alex Rivera'


def test_update_profile_trims_child_name_before_storing(api):
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': '  Alex Rivera  ', 'schoolCity': 'Boston'}],
    })
    assert status == 200
    stored = stored_profile(api)['children'][0]
    decrypted = api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['name']))['Plaintext'].decode()
    assert decrypted == 'Alex Rivera'


def test_update_profile_children_kms_outage_returns_503_not_plaintext(api, monkeypatch):
    api.profiles.put_item(Item={'userId': USER})
    monkeypatch.setattr(api.module, 'kms_key_alias', 'alias/does-not-exist')
    status, body = call(api, '/profile', 'PUT', body={
        'children': [{'name': 'Alex Rivera', 'schoolCity': 'Boston'}],
    })
    assert status == 503
    assert 'children' not in (stored_profile(api) or {})


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


def test_update_profile_language_sync_failure_is_non_blocking(api, monkeypatch):
    # No USER_POOL_ID configured: the Cognito locale mirror fails, the
    # profile update itself must still succeed.
    monkeypatch.delenv('USER_POOL_ID')
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={'secondaryLanguage': 'es'})
    assert status == 200
    assert stored_profile(api)['secondaryLanguage'] == 'es'


# ---------------------------------------------------------------------------
# POST /profile/children

def test_add_child_appends(api):
    profile_with_child(api)  # seeds 'Kid' directly, plaintext, bypassing add_child
    status, body = call(api, '/profile/children', 'POST',
                        body={'name': 'Second Kid', 'schoolCity': 'Cambridge'})
    assert status == 200
    assert body['childId']
    children = stored_profile(api)['children']
    assert children[0]['name'] == 'Kid'
    # The new child went through add_child, which now encrypts at rest.
    assert children[1]['name'] != 'Second Kid'
    decrypted = api.kms.decrypt(
        CiphertextBlob=base64.b64decode(children[1]['name']))['Plaintext'].decode()
    assert decrypted == 'Second Kid'


def test_add_child_requires_fields(api):
    profile_with_child(api)
    status, body = call(api, '/profile/children', 'POST', body={'name': 'Kid'})
    assert status == 400


@pytest.mark.parametrize('name', ['', '   ', '\t\n'])
def test_add_child_rejects_blank_name(api, name, capsys):
    # A present-but-blank name used to pass ('name' in body was the whole
    # check), which is exactly the value the redaction pipeline has nothing
    # to restore from. This also pins that the rejection is logged: an
    # unlogged validation rejection already made one real failure in this
    # file undiagnosable.
    profile_with_child(api)
    before = stored_profile(api)
    status, body = call(api, '/profile/children', 'POST',
                        body={'name': name, 'schoolCity': 'Cambridge'})
    assert status == 400
    assert body['message'] == 'Child name cannot be blank'
    assert stored_profile(api) == before  # no child appended
    assert 'blank or whitespace-only child name' in capsys.readouterr().out


def test_add_child_encrypts_name_at_rest(api):
    profile_with_child(api)
    status, body = call(api, '/profile/children', 'POST',
                        body={'name': 'Second Kid', 'schoolCity': 'Cambridge'})
    assert status == 200
    stored = stored_profile(api)['children'][1]
    assert stored['name'] != 'Second Kid'  # ciphertext at rest
    decrypted = api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['name']))['Plaintext'].decode()
    assert decrypted == 'Second Kid'


def test_add_child_trims_the_name_before_storing(api):
    profile_with_child(api)
    status, _ = call(api, '/profile/children', 'POST',
                     body={'name': '  Second Kid  ', 'schoolCity': 'Cambridge'})
    assert status == 200
    stored = stored_profile(api)['children'][1]
    decrypted = api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['name']))['Plaintext'].decode()
    assert decrypted == 'Second Kid'


def test_add_child_kms_outage_returns_503_not_plaintext(api, monkeypatch):
    profile_with_child(api)
    monkeypatch.setattr(api.module, 'kms_key_alias', 'alias/does-not-exist')
    status, body = call(api, '/profile/children', 'POST',
                        body={'name': 'Second Kid', 'schoolCity': 'Cambridge'})
    assert status == 503
    # No second child appended with a plaintext name.
    assert len(stored_profile(api)['children']) == 1


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


# A dropped upload (closed tab, network drop) leaves its row at PENDING_UPLOAD
# forever, or with no status at all for rows written before that value
# existed. The frontend only knows how to render PROCESSING, and the real
# value stays internal so ddb-service's pending-upload sweep can tell a
# stalled upload apart from real in-flight work.

def test_get_documents_reports_pending_upload_as_processing(api):
    profile_with_child(api)
    put_document(api, status='PENDING_UPLOAD', content={'summaries': {}})
    status, body = call(api, '/profile/children/child-1/documents', 'GET')
    assert status == 200
    assert body['status'] == 'PROCESSING'


def test_get_documents_reports_legacy_missing_status_as_processing(api):
    profile_with_child(api)
    key = 'iep-data/iep-1/child-1/content.json'
    api.s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'summaries': {}}).encode())
    api.documents.put_item(Item={
        'iepId': 'iep-1', 'childId': 'child-1', 'userId': USER, 'createdAt': 1000,
        'contentS3Reference': {'bucket': BUCKET, 's3Key': key},
    })
    status, body = call(api, '/profile/children/child-1/documents', 'GET')
    assert status == 200
    assert body['status'] == 'PROCESSING'


def test_get_documents_never_returns_other_users_docs(api):
    # Same childId in the index but owned by someone else: strict userId
    # match must hide it (IDOR guard).
    profile_with_child(api)
    put_document(api, user='someone-else', content={'summaries': {'en': 'Not yours'}})
    status, body = call(api, '/profile/children/child-1/documents', 'GET')
    assert status == 200
    assert body['documents'] == []


# ---------------------------------------------------------------------------
# The child's name, substituted on the way out
#
# Stored content never holds the child's name. The models are handed {{S}} and
# the content object keeps that placeholder permanently, so the name only
# exists in the profile: it is substituted here, on every read, for whichever
# language is being returned.
#
# Two things follow, and both are the reason the design is this way rather
# than a swap at write time. The on-demand add-a-language path re-reads this
# same stored content, so the translating model never sees a name no matter
# how long after the upload a parent asks. And a parent who corrects a
# misspelling fixes every summary and every translation they already have.
#
# get_child_documents has four ways of filling those fields (S3 object,
# migrated document, inline row after a failed migration, inline row after a
# migration error). Missing one prints a literal {{S}} to a parent, so the
# substitution is one site after they converge and the tests below walk all
# four.

TOKEN_CONTENT = {
    'summaries': {'en': '{{S}} is making progress.', 'es': '{{S}} progresa.'},
    'sections': {'en': [{'title': 'Goals', 'content': 'Goals for {{S}}.'}]},
    'document_index': {'en': 'Page 1: {{S}}'},
    'abbreviations': {'en': [{'abbreviation': 'IEP', 'full_form': 'Individualized Education Program'}]},
}
CHILD_NAME = 'Jordan Smith'


def profile_with_named_child(api, name, child_id='child-1', user=USER):
    """A profile whose child name is stored the way add_child stores it."""
    api.profiles.put_item(Item={
        'userId': user,
        'children': [{'childId': child_id, 'name': name, 'schoolCity': 'Boston'}],
    })


def fake_ddb_service(api, monkeypatch, handler):
    """Stand in for the ddb-service invoke the lazy-migration branch makes."""
    fake = FakeLambdaClient(handler)
    monkeypatch.setattr(api.module, 'boto3', ScopedBoto3(fake))
    return fake


def test_the_summary_reaches_a_parent_with_their_childs_name_in_it(api):
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, content=TOKEN_CONTENT)

    status, body = call(api, '/profile/children/child-1/documents', 'GET')

    assert status == 200
    assert body['summaries']['en'] == 'Jordan Smith is making progress.'
    assert body['sections']['en'][0]['content'] == 'Goals for Jordan Smith.'
    assert body['document_index']['en'] == 'Page 1: Jordan Smith'
    # The absence is the assertion: one field still holding a token would mean
    # the walk stopped somewhere, and a parent reads the braces.
    assert '{{S}}' not in json.dumps(body)


def test_every_language_gets_the_name_not_only_the_one_being_read(api):
    """The response carries all of them and the frontend picks; substituting
    only the preferred language would leak a token on the language switch."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, content=TOKEN_CONTENT)

    body = call(api, '/profile/children/child-1/documents', 'GET')[1]

    assert body['summaries']['es'] == 'Jordan Smith progresa.'


def test_the_stored_content_object_is_left_exactly_as_it_was(api):
    """The whole point of substituting on the read. The stored copy is what
    the on-demand translation re-reads, so a name written back into it is a
    name sent to OpenAI the next time a parent adds a language."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, content=TOKEN_CONTENT)

    call(api, '/profile/children/child-1/documents', 'GET')

    stored = json.loads(api.s3.get_object(
        Bucket=BUCKET, Key='iep-data/iep-1/child-1/content.json')['Body'].read())
    assert stored == TOKEN_CONTENT
    assert CHILD_NAME not in json.dumps(stored)


def test_the_migrated_document_shape_is_substituted_too(api, monkeypatch):
    """A row with no contentS3Reference is migrated through the ddb-service,
    and the content comes back from there rather than from S3."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api)  # no contentS3Reference: takes the migration branch
    fake_ddb_service(api, monkeypatch, lambda payload: {
        'statusCode': 200, 'body': json.dumps(TOKEN_CONTENT)})

    body = call(api, '/profile/children/child-1/documents', 'GET')[1]

    assert body['summaries']['en'] == 'Jordan Smith is making progress.'
    assert '{{S}}' not in json.dumps(body)


def test_the_inline_row_a_failed_migration_falls_back_to_is_substituted_too(api, monkeypatch):
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, **TOKEN_CONTENT)
    fake_ddb_service(api, monkeypatch, lambda payload: {
        'statusCode': 500, 'body': json.dumps({'error': 'migration failed'})})

    body = call(api, '/profile/children/child-1/documents', 'GET')[1]

    assert body['summaries']['en'] == 'Jordan Smith is making progress.'
    assert body['sections']['en'][0]['content'] == 'Goals for Jordan Smith.'
    assert '{{S}}' not in json.dumps(body)


def test_the_inline_row_a_migration_error_falls_back_to_is_substituted_too(api, monkeypatch):
    """The except branch, which is a different `latest_doc.update` from the
    one above and would be missed by a per-branch substitution."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, **TOKEN_CONTENT)

    def explode(payload):
        raise RuntimeError('ddb-service unreachable')
    fake_ddb_service(api, monkeypatch, explode)

    body = call(api, '/profile/children/child-1/documents', 'GET')[1]

    assert body['summaries']['en'] == 'Jordan Smith is making progress.'
    assert '{{S}}' not in json.dumps(body)


def test_a_document_written_before_the_redaction_is_returned_unchanged(api):
    """Its summary holds real names and no token at all. Substitution is a
    no-op on it: there is nothing to fail closed about, and nothing to fix."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    legacy = {'summaries': {'en': 'Jordan Smith met with Ms. Alvarez.'},
              'sections': {'en': [{'title': 'Goals', 'content': 'Read more.'}]}}
    put_document(api, content=legacy)

    status, body = call(api, '/profile/children/child-1/documents', 'GET')

    assert status == 200
    assert body['summaries']['en'] == 'Jordan Smith met with Ms. Alvarez.'
    assert body['sections']['en'][0]['content'] == 'Read more.'


@pytest.mark.parametrize('stored_name', ['', 'My Child'])
def test_no_usable_name_reads_as_the_neutral_phrase_in_each_language(api, stored_name):
    """A parent can reach a finished document before onboarding asks for a
    name, and older profiles carry the 'My Child' placeholder. Neither may
    print as the child's name, and neither may print as a raw token."""
    profile_with_named_child(api, stored_name)
    put_document(api, content=TOKEN_CONTENT)

    body = call(api, '/profile/children/child-1/documents', 'GET')[1]

    assert body['summaries']['en'] == 'your child is making progress.'
    assert body['summaries']['es'] == 'su hijo o hija progresa.'
    assert '{{S}}' not in json.dumps(body)
    assert 'My Child' not in json.dumps(body)


def test_a_kms_failure_degrades_to_the_neutral_phrase_rather_than_a_500(api, monkeypatch):
    """If the CMK is revoked or kms:Decrypt narrowed, kms_decrypt_string hands
    back the base64 ciphertext it was given. Printing that to a parent as
    their child's name is worse than the neutral phrase, and failing the whole
    request is worse than both: the summary itself is still readable."""
    ciphertext = encrypt(api, CHILD_NAME)
    profile_with_named_child(api, ciphertext)
    put_document(api, content=TOKEN_CONTENT)

    def denied(**kwargs):
        raise RuntimeError('AccessDeniedException')
    monkeypatch.setattr(api.module.kms_client, 'decrypt', denied)

    status, body = call(api, '/profile/children/child-1/documents', 'GET')

    assert status == 200
    assert body['summaries']['en'] == 'your child is making progress.'
    assert ciphertext[:24] not in json.dumps(body)
    assert '{{S}}' not in json.dumps(body)


def test_a_profile_read_failure_degrades_to_the_neutral_phrase(api, monkeypatch):
    """The ownership check reads the profile first and must still succeed; it
    is the second read, the one for the name, that fails here."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, content=TOKEN_CONTENT)

    real_get_item = api.module.user_profiles_table.get_item
    calls = []

    def flaky(**kwargs):
        calls.append(kwargs)
        if len(calls) > 1:
            raise RuntimeError('ProvisionedThroughputExceededException')
        return real_get_item(**kwargs)
    monkeypatch.setattr(api.module.user_profiles_table, 'get_item', flaky)

    status, body = call(api, '/profile/children/child-1/documents', 'GET')

    assert status == 200
    assert body['summaries']['en'] == 'your child is making progress.'
    assert '{{S}}' not in json.dumps(body)


@pytest.mark.parametrize('mangled', ['{{ S }}', '{ {S} }', '{S}', '{{s}}', '｛｛S｝｝'])
def test_a_token_a_translation_reformatted_is_still_swept(api, mangled):
    """translate_content fails a run that drops the token outright, but a
    model that merely reshapes it still reaches storage. This read is the last
    thing between that and a parent seeing braces."""
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, content={'summaries': {'zh': f'{mangled} 正在进步。'}})

    body = call(api, '/profile/children/child-1/documents', 'GET')[1]

    assert body['summaries']['zh'] == 'Jordan Smith 正在进步。'


def test_the_substitution_logs_counts_and_never_the_name_or_the_content(api, capsys):
    profile_with_named_child(api, encrypt(api, CHILD_NAME))
    put_document(api, content=TOKEN_CONTENT)

    call(api, '/profile/children/child-1/documents', 'GET')

    logged = capsys.readouterr().out
    assert 'Substituted the student token in 4 place(s)' in logged
    assert CHILD_NAME not in logged
    assert 'is making progress' not in logged


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

def test_delete_profile_wipes_user_data_even_without_cognito(api, monkeypatch):
    """The data goes even when the login cannot, and the parent is told.

    Pin changed 2026-09-10. This asserted 200 with cognitoUserDeleted False,
    which is the account-deletion request answered "done" while the account
    the parent asked us to delete is still there and still able to sign in.
    The data wipe is unchanged; only the honesty of the answer is.
    """
    monkeypatch.delenv('USER_POOL_ID')
    profile_with_child(api)
    put_document(api)
    api.s3.put_object(Bucket=BUCKET, Key=f'{USER}/child-1/iep-1/original.pdf', Body=b'pdf')

    status, body = call(api, '/profile', 'DELETE')
    assert status == 500
    summary = body['deletionSummary']
    assert summary['profileDeleted'] is True
    assert summary['documentsDeleted'] == 1
    assert summary['s3ObjectsDeleted'] == 1
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
    """An S3 failure must not abort the account deletion, or be called success.

    Pin changed 2026-09-10: this asserted 200 with documentsDeleted == 1, so a
    parent whose summary and cached audio were still in the bucket was told
    their child's records were gone. The rest of the deletion still runs (the
    profile goes), but the row whose artifacts survived is deliberately kept:
    it is the only pointer to them.
    """
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})

    def boom(*args, **kwargs):
        raise ClientError({'Error': {'Code': 'InternalError'}}, 'HeadObject')

    monkeypatch.setattr(api.module, '_delete_document_artifacts', boom)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 500
    assert body['deletionSummary']['documentsDeleted'] == 0
    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is not None
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
# A deletion says what actually happened
#
# Both handlers used to catch every step into a print and then return 200
# unconditionally, so a parent whose documents were still in the bucket was
# told they were gone. These pin the three things that fixes: the status is
# derived from what survived, DELETION_INCOMPLETE gives an alarm something to
# count, and the ordering leaves every partial failure retryable.

def markers(capsys):
    return [line for line in capsys.readouterr().out.splitlines()
            if line.startswith('DELETION_INCOMPLETE')]


def failing_prefix_sweep(api, monkeypatch, only_prefix):
    """Break _delete_prefix for one prefix, leaving the other sweeps working."""
    real = api.module._delete_prefix

    def selective(s3, bucket, prefix):
        if prefix.startswith(only_prefix):
            raise ClientError({'Error': {'Code': 'InternalError'}}, 'ListObjectsV2')
        return real(s3, bucket, prefix)

    monkeypatch.setattr(api.module, '_delete_prefix', selective)
    return real


def test_delete_child_documents_does_not_report_success_when_files_survive(api, monkeypatch, capsys):
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    raw_key = f'{USER}/child-1/iep-1/original.pdf'
    api.s3.put_object(Bucket=BUCKET, Key=raw_key, Body=b'pdf')
    failing_prefix_sweep(api, monkeypatch, f'{USER}/')

    status, body = call(api, '/profile/children/child-1/documents', 'DELETE')

    assert status == 500
    assert 'InternalError' not in json.dumps(body), 'internals leaked to the caller'
    assert key_exists(api, raw_key) is True, 'test proves nothing: the file was deleted'

    marker = markers(capsys)
    assert marker, 'nothing for an alarm to count'
    assert 'scope=child-documents' in marker[0] and 'essential=yes' in marker[0]
    assert 'survived=raw-uploads' in marker[0]
    assert 'child=child-1' in marker[0]
    # Ids and kinds only: no key names, no child name, no exception text.
    assert 'original.pdf' not in marker[0] and 'InternalError' not in marker[0]


def test_delete_child_documents_keeps_the_row_when_its_artifacts_survive(api, monkeypatch):
    """The row is the only pointer to the summary and the audio."""
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    failing_prefix_sweep(api, monkeypatch, 'iep-data/')

    assert call(api, '/profile/children/child-1/documents', 'DELETE')[0] == 500
    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is not None


def test_delete_child_documents_retry_converges(api, monkeypatch):
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    audio_keys = put_audio(api)
    raw_key = f'{USER}/child-1/iep-1/original.pdf'
    api.s3.put_object(Bucket=BUCKET, Key=raw_key, Body=b'pdf')

    real = failing_prefix_sweep(api, monkeypatch, f'{USER}/')
    assert call(api, '/profile/children/child-1/documents', 'DELETE')[0] == 500

    # S3 healthy again: the second attempt finishes the job rather than
    # tripping over the work the first one already did.
    monkeypatch.setattr(api.module, '_delete_prefix', real)
    assert call(api, '/profile/children/child-1/documents', 'DELETE')[0] == 200

    assert key_exists(api, raw_key) is False
    assert key_exists(api, 'iep-data/iep-1/child-1/content.json') is False
    for key in audio_keys:
        assert key_exists(api, key) is False
    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is None


def test_a_clean_account_deletion_returns_200_and_stays_quiet(api, capsys):
    """The happy path still removes everything, and must not trip the alarm."""
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    audio_keys = put_audio(api)
    raw_key = f'{USER}/child-1/iep-1/original.pdf'
    api.s3.put_object(Bucket=BUCKET, Key=raw_key, Body=b'pdf')

    status, body = call(api, '/profile', 'DELETE')

    assert status == 200
    assert body['deletionSummary']['cognitoUserDeleted'] is True
    assert key_exists(api, raw_key) is False
    assert key_exists(api, 'iep-data/iep-1/child-1/content.json') is False
    for key in audio_keys:
        assert key_exists(api, key) is False
    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is None
    assert stored_profile(api) is None
    with pytest.raises(api.cognito.exceptions.UserNotFoundException):
        api.cognito.admin_get_user(UserPoolId=api.pool_id, Username=USER)
    assert markers(capsys) == [], 'a clean deletion must not fire the alarm'


def test_account_deletion_keeps_the_login_when_data_survived(api, monkeypatch, capsys):
    """The JWT is the parent's only way to retry.

    Deleting the login while their child's documents are still in the bucket
    would strand those documents where no request they can make reaches them.
    """
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    failing_prefix_sweep(api, monkeypatch, 'iep-data/')

    status, body = call(api, '/profile', 'DELETE')

    assert status == 500
    assert body['deletionSummary']['cognitoUserDeleted'] is False
    api.cognito.admin_get_user(UserPoolId=api.pool_id, Username=USER)  # raises if gone

    marker = markers(capsys)[0]
    assert 'scope=account' in marker and 'essential=yes' in marker
    assert 'survived=cognito-account,derived-artifacts,document-rows' in marker


def test_account_deletion_retry_converges(api, monkeypatch):
    profile_with_child(api)
    put_document(api, content={'summaries': {'en': 'S'}})
    audio_keys = put_audio(api)

    real = failing_prefix_sweep(api, monkeypatch, 'iep-data/')
    assert call(api, '/profile', 'DELETE')[0] == 500

    monkeypatch.setattr(api.module, '_delete_prefix', real)
    status, body = call(api, '/profile', 'DELETE')

    assert status == 200
    assert body['deletionSummary']['cognitoUserDeleted'] is True
    assert key_exists(api, 'iep-data/iep-1/child-1/content.json') is False
    for key in audio_keys:
        assert key_exists(api, key) is False
    assert api.documents.get_item(
        Key={'iepId': 'iep-1', 'childId': 'child-1'}).get('Item') is None


def test_account_deletion_converges_when_the_login_is_already_gone(api):
    """A retry must not fail on work the previous attempt finished."""
    api.cognito.admin_delete_user(UserPoolId=api.pool_id, Username=USER)
    profile_with_child(api)

    status, body = call(api, '/profile', 'DELETE')
    assert status == 200
    assert body['deletionSummary']['cognitoUserDeleted'] is True


def test_a_stuck_referral_row_is_alarmed_but_not_the_parents_problem(api, monkeypatch, capsys):
    """Best-effort by classification: a link code carries no document content,
    the account is fully deleted, and there is nothing for a parent to retry."""
    profile_with_child(api)

    def boom(*args, **kwargs):
        raise ClientError({'Error': {'Code': 'InternalError'}}, 'Scan')

    monkeypatch.setattr(api.module, '_purge_referral_data', boom)

    status, _ = call(api, '/profile', 'DELETE')
    assert status == 200
    assert stored_profile(api) is None
    with pytest.raises(api.cognito.exceptions.UserNotFoundException):
        api.cognito.admin_get_user(UserPoolId=api.pool_id, Username=USER)

    marker = markers(capsys)[0]
    assert 'essential=no' in marker and 'survived=referrals' in marker


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


def test_account_delete_actually_removes_the_profile_row(api):
    """The row is the only pointer to a family's documents.

    Left behind, it is unreachable (nothing can authenticate as a deleted
    Cognito user) and therefore undeletable through the product, while still
    holding the child's details. Staging accumulated 128 of these before
    anyone looked, though from the E2E teardown calling AdminDeleteUser
    directly rather than from this path.

    Nothing asserted this until now: the suite checked referrals and documents
    and never the row itself.
    """
    profile_with_child(api)
    assert 'Item' in api.profiles.get_item(Key={'userId': USER}), 'fixture did not seed a profile'

    status, body = call(api, '/profile', 'DELETE')

    assert status == 200
    assert 'Item' not in api.profiles.get_item(Key={'userId': USER}), \
        'the profile row survived the account deletion'
    assert body['deletionSummary']['profileDeleted'] is True


def test_account_delete_does_not_claim_success_when_the_profile_row_survives(api, monkeypatch):
    """A parent told "deleted" while their child's details are still stored.

    This is the shape the whole deletion rewrite exists to remove: every step
    was wrapped in its own try/except that printed and continued, and the
    handler returned 200 regardless.
    """
    profile_with_child(api)

    def refuse(**_kwargs):
        raise RuntimeError('DynamoDB unavailable')

    # Patch the MODULE's handle, not the fixture's: the handler closes over
    # user_profiles_table, and patching api.profiles leaves it untouched (the
    # first version of this test did exactly that and passed vacuously).
    monkeypatch.setattr(api.module.user_profiles_table, 'delete_item', refuse)

    status, _ = call(api, '/profile', 'DELETE')

    assert status != 200, 'a surviving profile row was reported as a successful deletion'


# ---------------------------------------------------------------------------
# Capitalising the name a parent typed
# ---------------------------------------------------------------------------
#
# The name goes into the heading of every summary and every translation, and
# is read aloud by TTS. A parent typing "dhruv" sees it that way everywhere,
# in five languages, with no way today to go back and change it.


def _stored_child_name(api):
    stored = stored_profile(api)['children'][0]
    return api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['name']))['Plaintext'].decode()


@pytest.mark.parametrize('typed,stored', [
    ('dhruv', 'Dhruv'),
    ('dhruv kumar', 'Dhruv Kumar'),
    ('mary-jane', 'Mary-Jane'),       # both halves, not just the first
    ("o'brien", "O'Brien"),
    ('josé', 'José'),                  # upper() is Unicode-aware
    ('nguyễn', 'Nguyễn'),
    ('dhruv   kumar', 'Dhruv Kumar'),  # the matcher splits on whitespace
])
def test_a_name_typed_in_lower_case_is_capitalised_on_save(api, typed, stored):
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': typed, 'schoolCity': 'Boston'}],
    })
    assert status == 200
    assert _stored_child_name(api) == stored


@pytest.mark.parametrize('typed', [
    'AJ',             # initials, not a mis-typed "Aj"
    'McDonald',       # would become "Mcdonald"
    'van der Berg',   # would become "Van Der Berg"
    'JOSÉ',           # a stuck caps lock and a deliberate choice look identical
    'Dhruv',          # already right; must not be touched
])
def test_a_name_holding_any_capital_is_left_exactly_as_typed(api, typed):
    """The narrow rule is the point.

    Every cleverer rule gets somebody's name wrong, and getting a child's name
    wrong is not a neutral error in a product about their disability. The
    moment a parent has typed a capital, they have made a choice.
    """
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': typed, 'schoolCity': 'Boston'}],
    })
    assert status == 200
    assert _stored_child_name(api) == typed


@pytest.mark.parametrize('typed', ['张伟', 'محمد'])
def test_a_script_without_case_passes_through_untouched(api, typed):
    """No-op by construction: str.upper() does nothing to these."""
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile', 'PUT', body={
        'children': [{'name': typed, 'schoolCity': 'Boston'}],
    })
    assert status == 200
    assert _stored_child_name(api) == typed


def test_add_child_capitalises_the_same_way_as_update(api):
    """Both write paths, or a parent gets different answers on the two routes."""
    api.profiles.put_item(Item={'userId': USER})
    status, _ = call(api, '/profile/children', 'POST',
                     body={'name': 'dhruv', 'schoolCity': 'Boston'})
    assert status in (200, 201), status
    assert _stored_child_name(api) == 'Dhruv'
