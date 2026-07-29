"""tts-handler tests: the pure markdown->speech text utilities, and the
POST /documents/{iepId}/audio endpoint with a fake provider (the real ones
call ElevenLabs/OpenAI over HTTPS). The endpoint's contract matters because
it reads content server-side (it must not be usable as a free TTS proxy) and
caches synthesized audio by content hash.
"""
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
