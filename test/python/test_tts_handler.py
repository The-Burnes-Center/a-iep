"""tts-handler tests: the pure markdown->speech text utilities, and the
POST /documents/{iepId}/audio endpoint with a fake provider (the real ones
call ElevenLabs/OpenAI over HTTPS). The endpoint's contract matters because
it reads content server-side (it must not be usable as a free TTS proxy) and
caches synthesized audio by content hash.
"""
import base64
import hashlib
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import FUNCTIONS_DIR, load_lambda_module, unload

import importlib.util
import os
import sys

PROFILES_TABLE = 'profiles-test'
DOCUMENTS_TABLE = 'documents-test'
BUCKET = 'tts-bucket-test'
USER = 'user-sub-1'
CONTENT = {
    'summaries': {'en': 'A **summary** of the IEP.', 'es': 'Un **resumen** del IEP.'},
    'sections': {'en': [{'title': 'Goals', 'content': 'Reading goals.'}]},
}


def load_text_utils():
    path = os.path.join(FUNCTIONS_DIR, 'tts-handler', 'text_utils.py')
    spec = importlib.util.spec_from_file_location('tts_text_utils', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['tts_text_utils'] = module
    spec.loader.exec_module(module)
    return module


text_utils = load_text_utils()


# ---------------------------------------------------------------------------
# text_utils

def test_markdown_to_text_strips_formatting_keeps_words():
    md = ('# Goals\n\n'
          'The student will get **speech therapy** and *counseling*.\n\n'
          '- 30 minutes weekly\n'
          '1. First goal\n\n'
          '[full plan](https://example.org/plan) ![chart](https://example.org/c.png)\n\n'
          '`inline code` and\n\n```\nblock code\n```\n\n'
          '| Service | Minutes |\n| --- | --- |\n| Speech | 30 |')
    text = text_utils.markdown_to_text(md)
    for kept in ['Goals', 'speech therapy', 'counseling', '30 minutes weekly',
                 'First goal', 'full plan', 'inline code', 'Speech . 30']:
        assert kept in text, kept
    for gone in ['#', '**', '](', 'block code', '|', '```']:
        assert gone not in text, gone


def test_markdown_to_text_handles_empty():
    assert text_utils.markdown_to_text('') == ''
    assert text_utils.markdown_to_text(None) == ''


def test_chunk_text_passthrough_and_boundaries():
    assert text_utils.chunk_text('short', 100) == ['short']
    assert text_utils.chunk_text('', 100) == []

    paragraphs = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.'
    chunks = text_utils.chunk_text(paragraphs, 50)
    assert all(len(chunk) <= 50 for chunk in chunks)
    assert 'First paragraph here.' in chunks[0]
    # No content lost
    rejoined = ' '.join(chunks).replace('\n\n', ' ')
    for word in ['First', 'Second', 'Third']:
        assert word in rejoined


def test_chunk_text_hard_splits_oversized_sentences():
    long_sentence = 'x' * 250
    chunks = text_utils.chunk_text(long_sentence, 100)
    assert all(len(chunk) <= 100 for chunk in chunks)
    assert sum(len(chunk) for chunk in chunks) == 250


def test_chunk_text_splits_cjk_sentences():
    zh = ('这是第一句话。' * 12)  # no spaces; relies on full-width punctuation
    chunks = text_utils.chunk_text(zh, 40)
    assert all(len(chunk) <= 40 for chunk in chunks)
    assert len(chunks) >= 2


# ---------------------------------------------------------------------------
# The audio endpoint

class FakeProvider:
    name = 'fake'

    def __init__(self):
        self.synth_calls = []

    def fingerprint(self, language):
        return f'fake|voice-{language}'

    def synthesize(self, text, language):
        self.synth_calls.append((text, language))
        return b'FAKE-MP3-BYTES', 'audio/mpeg'


@pytest.fixture()
def tts(monkeypatch):
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

        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('BUCKET', BUCKET)

        module = load_lambda_module('tts-handler', 'tts_lambda')
        provider = FakeProvider()
        monkeypatch.setattr(module, 'get_provider', lambda: provider)
        try:
            yield SimpleNamespace(module=module, profiles=profiles,
                                  documents=documents, s3=s3, provider=provider)
        finally:
            unload('tts_lambda')
            unload('providers')
            unload('text_utils')
            unload('student_name_substitution')  # both lambdas ship one; do not leak it


def seed_document(tts, user=USER, with_content=True):
    tts.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'child-1', 'name': 'Kid'}],
    })
    item = {'iepId': 'iep-1', 'childId': 'child-1', 'userId': user}
    if with_content:
        key = 'iep-data/iep-1/child-1/content.json'
        tts.s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(CONTENT).encode())
        item['contentS3Reference'] = {'bucket': BUCKET, 's3Key': key}
    tts.documents.put_item(Item=item)


def audio_event(body=None, iep_id='iep-1', authed=True):
    event = {
        'rawPath': f'/documents/{iep_id}/audio',
        'requestContext': {'http': {'method': 'POST'}},
        'pathParameters': {'iepId': iep_id} if iep_id else {},
    }
    if authed:
        event['requestContext']['authorizer'] = {'jwt': {'claims': {'sub': USER}}}
    if body is not None:
        event['body'] = json.dumps(body)
    return event


GOOD_BODY = {'childId': 'child-1', 'language': 'es', 'target': 'summary'}


def call(tts, body=GOOD_BODY, **kwargs):
    response = tts.module.lambda_handler(audio_event(body=body, **kwargs), None)
    return response['statusCode'], json.loads(response['body'])


def test_audio_requires_auth_and_valid_request(tts):
    seed_document(tts)
    assert call(tts, authed=False)[0] == 401
    assert call(tts, body={**GOOD_BODY, 'language': 'fr'})[0] == 400
    assert call(tts, body={**GOOD_BODY, 'target': 'whole-doc'})[0] == 400
    assert call(tts, body={'language': 'es', 'target': 'summary'})[0] == 400  # no childId
    assert call(tts, body={**GOOD_BODY, 'target': 'section'})[0] == 400  # no sectionName

    status, _ = call(tts, body={**GOOD_BODY, 'childId': 'child-9'})
    assert status == 403  # not the caller's child


def test_audio_denies_documents_of_other_users(tts):
    seed_document(tts, user='someone-else')
    assert call(tts)[0] == 403


def test_audio_404_when_content_missing_or_language_absent(tts):
    seed_document(tts, with_content=False)
    assert call(tts)[0] == 404

    seed_document(tts, with_content=True)
    status, body = call(tts, body={**GOOD_BODY, 'language': 'vi'})
    assert status == 404  # content exists but has no vi summary


def test_audio_synthesizes_caches_and_presigns(tts):
    seed_document(tts)
    status, body = call(tts)
    assert status == 200
    assert body['status'] == 'ready'
    assert body['cached'] is False
    assert body['provider'] == 'fake'
    assert 'https://' in body['url'] and 'X-Amz-Signature' in body['url']

    # Exactly one synthesis, of the plain (markdown-stripped) Spanish text
    assert len(tts.provider.synth_calls) == 1
    text, language = tts.provider.synth_calls[0]
    assert language == 'es'
    assert 'resumen' in text and '**' not in text

    # The MP3 landed in the cache under the fingerprint+text hash
    expected_hash = hashlib.sha256(
        f'fake|voice-es|{text}'.encode()).hexdigest()[:16]
    key = f'iep-audio/iep-1/child-1/es/summary-{expected_hash}.mp3'
    obj = tts.s3.get_object(Bucket=BUCKET, Key=key)
    assert obj['Body'].read() == b'FAKE-MP3-BYTES'

    # Second request: cache hit, no new synthesis
    status, body = call(tts)
    assert status == 200
    assert body['cached'] is True
    assert len(tts.provider.synth_calls) == 1


def test_audio_section_target(tts):
    seed_document(tts)
    status, body = call(tts, body={'childId': 'child-1', 'language': 'en',
                                   'target': 'section', 'sectionName': 'Goals'})
    assert status == 200
    text, language = tts.provider.synth_calls[-1]
    assert text == 'Reading goals.'


def test_audio_provider_failure_is_502(tts, monkeypatch):
    seed_document(tts)

    def boom(text, language):
        raise tts.module.TTSProviderError('provider down')
    monkeypatch.setattr(tts.provider, 'synthesize', boom)
    assert call(tts)[0] == 502

    monkeypatch.setattr(tts.provider, 'synthesize', lambda text, language: (b'', 'audio/mpeg'))
    assert call(tts)[0] == 502  # empty audio is also a failure


# ---------------------------------------------------------------------------
# The child's name, substituted before synthesis
#
# Stored content calls the child {{S}} and keeps doing so; the name lives only
# in the profile and is substituted by whichever lambda serves a read. Here
# that has to happen before markdown_to_text and before the cache key is
# derived from the text, for two separate reasons: the provider would
# otherwise read the braces out loud, and the cached mp3 would be keyed by a
# hash that does not know whose name is in it.

CHILD_NAME = 'Jordan Smith'
TOKEN_CONTENT = {
    'summaries': {'en': '{{S}} is making **progress**.', 'es': '{{S}} progresa.'},
    'sections': {'en': [{'title': 'Goals', 'content': 'Reading goals for {{S}}.'}]},
}


def encrypted(name):
    """A name as user-profile-handler stores it: KMS ciphertext, base64."""
    kms = boto3.client('kms', region_name='us-east-1')
    key_id = kms.create_key()['KeyMetadata']['KeyId']
    blob = kms.encrypt(KeyId=key_id, Plaintext=name.encode('utf-8'))['CiphertextBlob']
    return base64.b64encode(blob).decode('utf-8')


def seed_named_document(tts, name, content=None):
    tts.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'child-1', 'name': name}],
    })
    key = 'iep-data/iep-1/child-1/content.json'
    tts.s3.put_object(Bucket=BUCKET, Key=key,
                      Body=json.dumps(content or TOKEN_CONTENT).encode())
    tts.documents.put_item(Item={
        'iepId': 'iep-1', 'childId': 'child-1', 'userId': USER,
        'contentS3Reference': {'bucket': BUCKET, 's3Key': key},
    })


def spoken(tts):
    """What the provider was actually asked to say, not what it returned."""
    return tts.provider.synth_calls[-1][0]


def test_the_provider_is_given_the_childs_name_never_the_placeholder(tts):
    seed_named_document(tts, encrypted(CHILD_NAME))

    assert call(tts)[0] == 200

    assert spoken(tts) == 'Jordan Smith progresa.'
    assert '{{S}}' not in spoken(tts)


def test_a_section_read_aloud_is_substituted_too(tts):
    seed_named_document(tts, encrypted(CHILD_NAME))

    status, _ = call(tts, body={'childId': 'child-1', 'language': 'en',
                                'target': 'section', 'sectionName': 'Goals'})

    assert status == 200
    assert spoken(tts) == 'Reading goals for Jordan Smith.'


def test_the_stored_content_object_is_left_exactly_as_it_was(tts):
    seed_named_document(tts, encrypted(CHILD_NAME))

    call(tts)

    stored = json.loads(tts.s3.get_object(
        Bucket=BUCKET, Key='iep-data/iep-1/child-1/content.json')['Body'].read())
    assert stored == TOKEN_CONTENT
    assert CHILD_NAME not in json.dumps(stored)


@pytest.mark.parametrize('stored_name', ['', 'My Child'])
def test_no_usable_name_is_spoken_as_the_neutral_phrase(tts, stored_name):
    seed_named_document(tts, stored_name)

    assert call(tts)[0] == 200

    assert spoken(tts) == 'su hijo o hija progresa.'
    assert '{{S}}' not in spoken(tts)


def test_a_kms_failure_is_spoken_as_the_neutral_phrase_not_a_blob(tts, monkeypatch):
    """_decrypt_profile_field hands back the ciphertext when a decrypt fails.
    Reading base64 aloud for a minute and a half is worse than saying "su hijo
    o hija", and failing the request is worse than both."""
    ciphertext = encrypted(CHILD_NAME)
    seed_named_document(tts, ciphertext)

    def denied(**kwargs):
        raise RuntimeError('AccessDeniedException')
    monkeypatch.setattr(tts.module.kms_client, 'decrypt', denied)

    status, _ = call(tts)

    assert status == 200
    assert spoken(tts) == 'su hijo o hija progresa.'
    assert ciphertext[:24] not in spoken(tts)


def test_a_profile_read_failure_is_spoken_as_the_neutral_phrase(tts, monkeypatch):
    """The ownership check reads the profile first and must still succeed; it
    is the second read, the one for the name, that fails here."""
    seed_named_document(tts, encrypted(CHILD_NAME))
    real_get_item = tts.module.user_profiles_table.get_item
    calls = []

    def flaky(**kwargs):
        calls.append(kwargs)
        if len(calls) > 1:
            raise RuntimeError('ProvisionedThroughputExceededException')
        return real_get_item(**kwargs)
    monkeypatch.setattr(tts.module.user_profiles_table, 'get_item', flaky)

    status, _ = call(tts)

    assert status == 200
    assert spoken(tts) == 'su hijo o hija progresa.'


@pytest.mark.parametrize('mangled', ['{{ S }}', '{ {S} }', '{S}', '{{s}}', '｛｛S｝｝'])
def test_a_token_a_translation_reformatted_is_never_read_aloud(tts, mangled):
    seed_named_document(tts, encrypted(CHILD_NAME),
                        content={'summaries': {'es': f'{mangled} progresa.'}})

    assert call(tts)[0] == 200

    assert spoken(tts) == 'Jordan Smith progresa.'


def test_a_corrected_name_does_not_replay_the_old_audio(tts):
    """The cache key is a hash of the text handed to the provider, and the
    name is in that text by then, so a corrected name misses the cache instead
    of playing the misspelling back. This is what the substitution ordering
    buys: put it after the hash and the parent hears the old name forever."""
    seed_named_document(tts, encrypted('Jorden Smith'))
    assert call(tts)[0] == 200
    assert spoken(tts) == 'Jorden Smith progresa.'

    tts.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'child-1', 'name': encrypted(CHILD_NAME)}],
    })
    status, body = call(tts)

    assert status == 200
    assert body['cached'] is False
    assert len(tts.provider.synth_calls) == 2
    assert spoken(tts) == 'Jordan Smith progresa.'


def test_the_same_name_twice_still_hits_the_cache(tts):
    """The corrected-name miss above must not have cost every repeat play a
    paid synthesis."""
    seed_named_document(tts, encrypted(CHILD_NAME))

    assert call(tts)[1]['cached'] is False
    assert call(tts)[1]['cached'] is True
    assert len(tts.provider.synth_calls) == 1


def test_the_substitution_logs_counts_and_never_the_name_or_the_content(tts, capsys):
    seed_named_document(tts, encrypted(CHILD_NAME))

    call(tts)

    logged = capsys.readouterr().out
    assert 'Substituted the student token in 1 place(s)' in logged
    assert CHILD_NAME not in logged
    assert 'progresa' not in logged
