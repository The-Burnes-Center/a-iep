"""translation-request-handler tests.

POST /profile/children/{childId}/documents/{iepId}/translations adds ONE
language to an already-processed IEP. Three things make it worth pinning
tightly:

  * it is an authorization boundary — the caller must own both the child and
    the document, and a hole here hands one family's IEP to another,
  * it spends real OpenAI money per accepted call, so the in-flight guard and
    the attempt budget are load-bearing, not hygiene,
  * a 500 must never carry the underlying exception text; returning str(e)
    from a handler previously leaked table names and AWS error codes.

The Step Functions client is faked at the module's own factory (the pattern
from test_orchestrator.py) so the fake can validate the execution name and the
state machine ARN the way real AWS would.
"""
import json
import re
from types import SimpleNamespace

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from conftest import load_lambda_module, unload

PROFILES_TABLE = 'profiles-test'
DOCUMENTS_TABLE = 'documents-test'
BUCKET = 'translation-bucket-test'
STATE_MACHINE_ARN = ('arn:aws:states:us-east-1:123456789012:stateMachine:'
                     'single-language-translation')
USER = 'user-sub-1'
CHILD = 'child-1'
IEP = 'iep-1'
CONTENT_KEY = f'iep-data/{IEP}/{CHILD}/content.json'
CONTEXT = SimpleNamespace(aws_request_id='deadbeef-0000-4000-8000-000000000000')

# English present, Spanish missing: the shape this endpoint exists for.
ENGLISH_ONLY = {
    'summaries': {'en': 'A summary of the IEP.'},
    'sections': {'en': [{'title': 'Goals', 'content': 'Reading goals.'}]},
    'document_index': {'en': 'Table of contents'},
    'abbreviations': {'en': []},
}

# Real Step Functions rejects execution names outside this charset/length.
EXECUTION_NAME_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')


class FakeStepFunctions:
    def __init__(self):
        self.executions = []
        self.error = None

    def start_execution(self, *, stateMachineArn, name, input):
        if self.error is not None:
            raise self.error
        # Validate like real AWS would, so a bad execution name or a stray ARN
        # fails the test instead of only failing in production.
        if stateMachineArn != STATE_MACHINE_ARN:
            raise AssertionError(f'unexpected stateMachineArn: {stateMachineArn!r}')
        if not EXECUTION_NAME_RE.match(name):
            raise AssertionError(f'invalid Step Functions execution name: {name!r}')
        self.executions.append(
            {'stateMachineArn': stateMachineArn, 'name': name, 'input': input})
        return {'executionArn': f'{STATE_MACHINE_ARN}:exec-{len(self.executions)}'}


@pytest.fixture()
def translations(monkeypatch):
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
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)

        # Set before loading: the handler builds its table resources and reads
        # BUCKET at import time.
        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('BUCKET', BUCKET)
        monkeypatch.setenv('TRANSLATION_STATE_MACHINE_ARN', STATE_MACHINE_ARN)

        module = load_lambda_module('translation-request-handler', 'translation_request')
        stepfunctions = FakeStepFunctions()
        monkeypatch.setattr(module, '_stepfunctions_client', lambda: stepfunctions)
        try:
            yield SimpleNamespace(module=module, profiles=profiles,
                                  documents=documents, s3=s3,
                                  stepfunctions=stepfunctions)
        finally:
            unload('translation_request')


def seed(translations, *, content=ENGLISH_ONLY, owner=USER, child_in_profile=CHILD,
         status='PROCESSED', with_document=True, attempts=None):
    translations.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': child_in_profile, 'name': 'Kid'}],
    })
    if not with_document:
        return
    item = {'iepId': IEP, 'childId': CHILD, 'userId': owner,
            'status': status, 'progress': 100}
    if attempts is not None:
        item['translationRequestCount'] = attempts
    if content is not None:
        translations.s3.put_object(Bucket=BUCKET, Key=CONTENT_KEY,
                                   Body=json.dumps(content).encode())
        item['contentS3Reference'] = {'bucket': BUCKET, 's3Key': CONTENT_KEY}
    translations.documents.put_item(Item=item)


def request_event(body={'language': 'es'}, child_id=CHILD, iep_id=IEP, authed=True,
                  raw_body=None):
    event = {
        'rawPath': f'/profile/children/{child_id}/documents/{iep_id}/translations',
        'requestContext': {'http': {'method': 'POST'}},
        'pathParameters': {},
    }
    if child_id:
        event['pathParameters']['childId'] = child_id
    if iep_id:
        event['pathParameters']['iepId'] = iep_id
    if authed:
        event['requestContext']['authorizer'] = {'jwt': {'claims': {'sub': USER}}}
    if raw_body is not None:
        event['body'] = raw_body
    elif body is not None:
        event['body'] = json.dumps(body)
    return event


def call(translations, **kwargs):
    response = translations.module.lambda_handler(request_event(**kwargs), CONTEXT)
    return response['statusCode'], json.loads(response['body'])


def document(translations):
    return translations.documents.get_item(
        Key={'iepId': IEP, 'childId': CHILD}).get('Item') or {}


# ---------------------------------------------------------------------------
# Happy path

def test_starts_one_execution_and_flips_status(translations):
    seed(translations)
    status, body = call(translations)

    assert status == 202
    assert body == {'status': 'PROCESSING_TRANSLATIONS', 'language': 'es',
                    'iepId': IEP, 'alreadyExists': False}

    # The execution carries exactly the event translate_content expects, with a
    # single-element target_languages — that is what makes this an append.
    assert len(translations.stepfunctions.executions) == 1
    execution = translations.stepfunctions.executions[0]
    assert json.loads(execution['input']) == {
        'iep_id': IEP, 'child_id': CHILD, 'user_id': USER,
        'target_languages': ['es'], 'content_type': 'parsing_result',
    }

    # Persisted state, not the mock: the frontend polls on exactly this.
    doc = document(translations)
    assert doc['status'] == 'PROCESSING_TRANSLATIONS'
    assert int(doc['progress']) == 70
    assert doc['current_step'] == 'translation_requested'
    assert int(doc['translationRequestCount']) == 1


def test_already_translated_is_a_free_no_op(translations):
    seed(translations, content={
        'summaries': {'en': 'English', 'es': 'Espanol'},
        'sections': {'en': [{'title': 'Goals'}], 'es': [{'title': 'Metas'}]},
    })
    status, body = call(translations)

    assert status == 200
    assert body['status'] == 'PROCESSED'
    assert body['alreadyExists'] is True
    # No money spent and the document was left exactly as it was.
    assert translations.stepfunctions.executions == []
    doc = document(translations)
    assert doc['status'] == 'PROCESSED'
    assert 'translationRequestCount' not in doc


# ---------------------------------------------------------------------------
# Validation

def test_unauthenticated_request_is_401(translations):
    seed(translations)
    assert call(translations, authed=False)[0] == 401
    assert translations.stepfunctions.executions == []


@pytest.mark.parametrize('body', [
    {'language': 'fr'},     # not a supported language
    {'language': 'ES'},     # codes are lowercase; no silent normalization
    {'language': ''},       # empty
    {},                     # missing entirely
    None,                   # no body at all
])
def test_bad_language_is_400(translations, body):
    seed(translations)
    status, payload = call(translations, body=body)
    assert status == 400
    assert 'error' in payload
    assert translations.stepfunctions.executions == []


def test_english_is_rejected_because_it_is_the_source(translations):
    # English is what the pipeline translates FROM; accepting it would ask
    # translate_content to overwrite the source with a translation of itself.
    seed(translations)
    status, payload = call(translations, body={'language': 'en'})
    assert status == 400
    assert translations.stepfunctions.executions == []
    assert document(translations)['status'] == 'PROCESSED'


def test_malformed_json_body_is_400(translations):
    seed(translations)
    assert call(translations, raw_body='{not json')[0] == 400
    assert call(translations, raw_body='"just a string"')[0] == 400
    assert translations.stepfunctions.executions == []


def test_missing_path_parameters_is_400(translations):
    seed(translations)
    assert call(translations, iep_id=None)[0] == 400
    assert call(translations, child_id=None)[0] == 400
    assert translations.stepfunctions.executions == []


# ---------------------------------------------------------------------------
# Authorization

def test_child_not_on_the_callers_profile_is_403(translations):
    # THE OWNERSHIP PIN. Mutation-checked: removing the _user_owns_child gate
    # in the handler turns this into a 202 and fails here.
    seed(translations, child_in_profile='someone-elses-child')
    status, payload = call(translations)
    assert status == 403
    assert payload == {'error': 'Access denied'}
    assert translations.stepfunctions.executions == []
    # And nothing was spent or mutated on the way to the refusal.
    assert document(translations)['status'] == 'PROCESSED'
    assert 'translationRequestCount' not in document(translations)


def test_document_owned_by_another_user_is_403(translations):
    # Owning the child is not enough: the document row carries its own owner.
    seed(translations, owner='someone-else')
    status, payload = call(translations)
    assert status == 403
    assert payload == {'error': 'Access denied'}
    assert translations.stepfunctions.executions == []


def test_missing_document_is_404(translations):
    seed(translations, with_document=False)
    status, payload = call(translations)
    assert status == 404
    assert translations.stepfunctions.executions == []
    # UpdateItem is an upsert: a 404 must not leave a stub row behind.
    assert document(translations) == {}


# ---------------------------------------------------------------------------
# State guards

def test_no_english_content_is_409(translations):
    # translate_content hard-raises without summaries.en / sections.en, so
    # accepting this would burn a paid execution to fail.
    seed(translations, content={'summaries': {}, 'sections': {}})
    status, _ = call(translations)
    assert status == 409
    assert translations.stepfunctions.executions == []


def test_missing_content_object_is_409(translations):
    seed(translations, content=None)
    assert call(translations)[0] == 409
    assert translations.stepfunctions.executions == []


def test_english_summary_without_sections_is_not_a_source(translations):
    # A usable language needs both halves; a summary alone would send
    # translate_content into its sections.en check and raise.
    seed(translations, content={'summaries': {'en': 'English'}, 'sections': {}})
    assert call(translations)[0] == 409


@pytest.mark.parametrize('status', ['PROCESSING', 'PROCESSING_TRANSLATIONS'])
def test_work_already_in_flight_is_409(translations, status):
    seed(translations, status=status)
    code, _ = call(translations)
    assert code == 409
    assert translations.stepfunctions.executions == []
    # The in-flight status is left alone, so the running work is not disturbed.
    assert document(translations)['status'] == status


def test_double_tap_starts_only_one_execution(translations):
    # The concurrency case this guard exists for: the first call flips the
    # document in-flight, so the second is refused instead of racing a second
    # execution over the same content.json.
    seed(translations)
    assert call(translations)[0] == 202
    assert call(translations)[0] == 409
    assert len(translations.stepfunctions.executions) == 1
    assert int(document(translations)['translationRequestCount']) == 1


def test_conditional_write_is_what_actually_blocks_the_race(translations):
    # Prove the ConditionExpression, not just the read-side check. Two
    # concurrent invocations both read PROCESSED and both reach the claim; only
    # the write can separate them, so the claim is exercised directly here.
    seed(translations)
    claim = translations.module._claim_translation_slot
    assert claim(IEP, CHILD) is True
    assert claim(IEP, CHILD) is False
    assert int(document(translations)['translationRequestCount']) == 1


def test_conditional_write_refuses_a_document_deleted_mid_request(translations):
    # UpdateItem is an upsert. Without attribute_exists(iepId) a document
    # deleted between the read and the claim would be resurrected as a stub row
    # that no upload ever created.
    seed(translations)
    translations.documents.delete_item(Key={'iepId': IEP, 'childId': CHILD})
    assert translations.module._claim_translation_slot(IEP, CHILD) is False
    assert document(translations) == {}


def test_conditional_write_refuses_a_document_with_no_status(translations):
    # Guards the OR-branch in the condition: a document that somehow carries no
    # status attribute is not in flight, so it must still be claimable rather
    # than permanently refused.
    seed(translations)
    translations.documents.update_item(
        Key={'iepId': IEP, 'childId': CHILD},
        UpdateExpression='REMOVE #s',
        ExpressionAttributeNames={'#s': 'status'},
    )
    assert translations.module._claim_translation_slot(IEP, CHILD) is True


def test_attempt_budget_is_429_and_spends_nothing(translations):
    seed(translations, attempts=translations.module.MAX_TRANSLATION_ATTEMPTS)
    status, payload = call(translations)
    assert status == 429
    assert 'error' in payload
    assert translations.stepfunctions.executions == []
    doc = document(translations)
    assert doc['status'] == 'PROCESSED'
    assert int(doc['translationRequestCount']) == \
        translations.module.MAX_TRANSLATION_ATTEMPTS


def test_budget_allows_the_last_attempt(translations):
    # Vacuity guard on the test above: one below the cap must still be accepted,
    # or the 429 test would pass with a permanently closed endpoint.
    seed(translations, attempts=translations.module.MAX_TRANSLATION_ATTEMPTS - 1)
    assert call(translations)[0] == 202
    assert len(translations.stepfunctions.executions) == 1


# ---------------------------------------------------------------------------
# Failure handling: generic bodies, no stranded documents

SENTINEL = 'ai-iep-secret-table-name-9f3c'


def test_document_read_failure_is_a_generic_500(translations, monkeypatch):
    def boom(**kwargs):
        raise ClientError(
            {'Error': {'Code': 'AccessDeniedException',
                       'Message': f'User is not authorized on {SENTINEL}'}},
            'GetItem')
    monkeypatch.setattr(translations.module.iep_documents_table, 'get_item', boom)
    seed(translations)

    status, payload = call(translations)
    assert status == 500
    # The cause goes to CloudWatch, never to the caller.
    assert SENTINEL not in json.dumps(payload)
    assert 'AccessDenied' not in json.dumps(payload)
    assert payload == {'error': 'Could not load document'}


def test_start_execution_failure_is_generic_and_releases_the_slot(translations):
    seed(translations)
    translations.stepfunctions.error = ClientError(
        {'Error': {'Code': 'StateMachineDoesNotExist',
                   'Message': f'no state machine {SENTINEL}'}},
        'StartExecution')

    status, payload = call(translations)
    assert status == 500
    assert SENTINEL not in json.dumps(payload)
    assert payload == {'error': 'Could not start translation'}

    # THE THING THAT MUST NOT HAPPEN: a document left at
    # PROCESSING_TRANSLATIONS with nothing running behind it would poll forever.
    doc = document(translations)
    assert doc['status'] == 'PROCESSED'
    assert int(doc['progress']) == 100
    # No OpenAI call was made, so the attempt is refunded.
    assert int(doc['translationRequestCount']) == 0

    # And the document is immediately requestable again once the fault clears.
    translations.stepfunctions.error = None
    assert call(translations)[0] == 202


def test_missing_state_machine_arn_fails_without_stranding(translations, monkeypatch):
    seed(translations)
    monkeypatch.delenv('TRANSLATION_STATE_MACHINE_ARN')
    status, payload = call(translations)
    assert status == 500
    assert payload == {'error': 'Could not start translation'}
    assert translations.stepfunctions.executions == []
    assert document(translations)['status'] == 'PROCESSED'


def test_no_error_body_anywhere_carries_exception_text(translations, monkeypatch):
    # Sweep every reachable rejection and assert none of them echoes an
    # underlying cause. A single str(e) here would leak table names.
    seed(translations, child_in_profile='not-this-child')
    bodies = [call(translations)[1]]
    seed(translations)
    for kwargs in ({'body': {'language': 'fr'}}, {'body': {'language': 'en'}},
                   {'raw_body': '{nope'}, {'authed': False}):
        bodies.append(call(translations, **kwargs)[1])

    joined = json.dumps(bodies)
    for leak in ['Traceback', 'ClientError', 'botocore', PROFILES_TABLE,
                 DOCUMENTS_TABLE, BUCKET, STATE_MACHINE_ARN]:
        assert leak not in joined, leak


def test_options_preflight_needs_no_auth(translations):
    event = request_event(authed=False)
    event['requestContext']['http']['method'] = 'OPTIONS'
    response = translations.module.lambda_handler(event, CONTEXT)
    assert response['statusCode'] == 200
    assert translations.stepfunctions.executions == []


def test_execution_name_survives_a_hostile_iep_id(translations):
    # iepId comes from the URL path. It has to match a real document to get
    # this far, but a stray character must not turn a valid request into a 500.
    name = translations.module._execution_name('iep/1.pdf 2026', 'es', CONTEXT)
    assert EXECUTION_NAME_RE.match(name)
    assert 'es' in name
