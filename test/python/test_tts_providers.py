"""tts-handler providers.py tests: provider selection, fingerprints, and the
synthesis chunking loop. The active provider is flipped via an SSM parameter
at runtime (no redeploy), so the selection rules and every fallback path are
pinned here; the fingerprint feeds the S3 audio cache key, so its exact
composition is pinned too. moto supplies SSM and a fake urllib3 pool stands in
for the provider APIs: zero network.
"""
import json
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

PROVIDER_PARAM = '/test/tts/provider'
VOICE_CONFIG_PARAM = '/test/tts/voice-config'
API_KEY_PARAM = '/test/tts/api-key'


class FakeHTTP:
    """urllib3.PoolManager stand-in: records requests, returns canned audio."""

    def __init__(self, status=200, data=b'MP3'):
        self.status = status
        self.data = data
        self.requests = []

    def request(self, method, url, body=None, headers=None, timeout=None):
        self.requests.append(SimpleNamespace(
            method=method, url=url, body=json.loads(body), headers=headers))
        return SimpleNamespace(status=self.status, data=self.data)


@pytest.fixture()
def providers(monkeypatch):
    with mock_aws():
        ssm = boto3.client('ssm', region_name='us-east-1')
        module = load_lambda_module('tts-handler', 'tts_providers',
                                    module_name='providers')
        # synthesize() lazily does `from text_utils import chunk_text`, so the
        # real sibling must be importable under exactly that name.
        load_lambda_module('tts-handler', 'text_utils', module_name='text_utils')
        try:
            yield SimpleNamespace(module=module, ssm=ssm)
        finally:
            unload('tts_providers')
            unload('text_utils')


def arm_api_key(providers, monkeypatch, env_var):
    monkeypatch.setenv(env_var, API_KEY_PARAM)
    providers.ssm.put_parameter(Name=API_KEY_PARAM, Value='sk-test',
                                Type='SecureString')


# ---------------------------------------------------------------------------
# get_provider selection

def test_get_provider_reads_ssm_and_selects_openai(providers, monkeypatch):
    monkeypatch.setenv('TTS_PROVIDER_PARAMETER_NAME', PROVIDER_PARAM)
    monkeypatch.setenv('TTS_VOICE_CONFIG_PARAMETER_NAME', VOICE_CONFIG_PARAM)
    # Whitespace/case must be tolerated: the parameter is hand-edited in the
    # console when flipping providers during an incident.
    providers.ssm.put_parameter(Name=PROVIDER_PARAM, Value=' OpenAI ', Type='String')
    providers.ssm.put_parameter(Name=VOICE_CONFIG_PARAM, Type='String', Value=json.dumps({
        'openai': {'default': 'nova'},
        'elevenlabs': {'default': 'el-voice'},
    }))

    provider = providers.module.get_provider()
    assert isinstance(provider, providers.module.OpenAIProvider)
    # The provider receives its own voice-config section, not elevenlabs'.
    assert provider.fingerprint('en') == 'openai|gpt-4o-mini-tts|nova'


def test_get_provider_fallbacks_all_land_on_elevenlabs(providers, monkeypatch):
    module = providers.module

    # No parameter name configured at all: compiled-in default.
    assert isinstance(module.get_provider(), module.ElevenLabsProvider)

    # Parameter names an unknown provider: fall back, don't crash.
    monkeypatch.setenv('TTS_PROVIDER_PARAMETER_NAME', PROVIDER_PARAM)
    providers.ssm.put_parameter(Name=PROVIDER_PARAM, Value='polly', Type='String')
    assert isinstance(module.get_provider(), module.ElevenLabsProvider)

    # Parameter name configured but absent in SSM: the read fails and the
    # default must win (a bad deploy must not take TTS down).
    monkeypatch.setenv('TTS_PROVIDER_PARAMETER_NAME', '/test/tts/never-created')
    assert isinstance(module.get_provider(), module.ElevenLabsProvider)


def test_invalid_voice_config_json_falls_back_to_default_voices(providers, monkeypatch):
    monkeypatch.setenv('TTS_VOICE_CONFIG_PARAMETER_NAME', VOICE_CONFIG_PARAM)
    providers.ssm.put_parameter(Name=VOICE_CONFIG_PARAM, Value='{not json', Type='String')
    provider = providers.module.get_provider()
    assert isinstance(provider, providers.module.ElevenLabsProvider)
    assert provider.fingerprint('en') == (
        f'elevenlabs|{provider.DEFAULT_MODEL}|{provider.DEFAULT_VOICE}')


# ---------------------------------------------------------------------------
# Fingerprints (part of the S3 cache key: a silent change here would orphan
# every cached MP3, so the exact composition is pinned)

def test_fingerprint_composition_and_language_overrides(providers):
    eleven = providers.module.ElevenLabsProvider({
        'model': 'eleven_multilingual_v2',
        'default': 'voice-default',
        'byLanguage': {'ar': 'voice-ar'},
    })
    assert eleven.fingerprint('en') == 'elevenlabs|eleven_multilingual_v2|voice-default'
    assert eleven.fingerprint('ar') == 'elevenlabs|eleven_multilingual_v2|voice-ar'

    # Empty config: built-in defaults all the way down.
    openai = providers.module.OpenAIProvider({})
    assert openai.fingerprint('es') == 'openai|gpt-4o-mini-tts|alloy'


# ---------------------------------------------------------------------------
# Synthesis (fake HTTP pool; chunking is what keeps long IEP summaries under
# each provider's per-request character limit)

def test_openai_synthesize_chunks_long_text_and_concatenates(providers, monkeypatch):
    arm_api_key(providers, monkeypatch, 'OPENAI_API_KEY_PARAMETER_NAME')
    fake = FakeHTTP()
    monkeypatch.setattr(providers.module, 'http', fake)

    provider = providers.module.OpenAIProvider({})
    provider.MAX_CHARS = 12  # force chunking without megabytes of text

    audio, mime = provider.synthesize('First one. Second two.', 'en')
    assert mime == 'audio/mpeg'
    assert audio == b'MP3MP3'  # one response body per chunk, concatenated

    assert [r.body['input'] for r in fake.requests] == ['First one.', 'Second two.']
    assert all(r.url == 'https://api.openai.com/v1/audio/speech' for r in fake.requests)
    assert all(r.headers['Authorization'] == 'Bearer sk-test' for r in fake.requests)


def test_elevenlabs_sends_language_code_only_for_flash_turbo(providers, monkeypatch):
    arm_api_key(providers, monkeypatch, 'ELEVENLABS_API_KEY_PARAMETER_NAME')
    fake = FakeHTTP()
    monkeypatch.setattr(providers.module, 'http', fake)

    flash = providers.module.ElevenLabsProvider({'default': 'v-1'})
    flash.synthesize('Hola.', 'es')
    request = fake.requests[-1]
    assert '/text-to-speech/v-1' in request.url
    assert request.headers['xi-api-key'] == 'sk-test'
    # The default model is a flash model, so language enforcement applies.
    assert request.body == {'text': 'Hola.', 'model_id': 'eleven_flash_v2_5',
                            'language_code': 'es'}

    # Classic models reject language_code; it must be omitted.
    classic = providers.module.ElevenLabsProvider({'model': 'eleven_multilingual_v2'})
    classic.synthesize('Hola.', 'es')
    assert 'language_code' not in fake.requests[-1].body


def test_synthesize_failures_raise_provider_error(providers, monkeypatch):
    module = providers.module
    monkeypatch.setattr(module, 'http', FakeHTTP())

    # No API key parameter configured: fail before any HTTP call.
    with pytest.raises(module.TTSProviderError, match='API key'):
        module.OpenAIProvider({}).synthesize('Hi.', 'en')

    # Provider API rejects the call: surface the status, never return audio.
    arm_api_key(providers, monkeypatch, 'OPENAI_API_KEY_PARAMETER_NAME')
    monkeypatch.setattr(module, 'http', FakeHTTP(status=429))
    with pytest.raises(module.TTSProviderError, match='429'):
        module.OpenAIProvider({}).synthesize('Hi.', 'en')
