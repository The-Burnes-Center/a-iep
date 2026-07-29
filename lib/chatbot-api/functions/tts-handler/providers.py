"""
Hot-swappable TTS providers.

The active provider is chosen by the SSM parameter named in
TTS_PROVIDER_PARAMETER_NAME ("elevenlabs" | "openai"), read at runtime with a
short TTL cache so it can be flipped without a redeploy. Voice/model selection
comes from the JSON SSM parameter named in TTS_VOICE_CONFIG_PARAMETER_NAME:

  {"elevenlabs": {"default": "<voiceId>", "byLanguage": {"ar": "<voiceId>"}},
   "openai": {"default": "alloy"}}

Providers are called over plain HTTPS via urllib3 (bundled with the Lambda
runtime) so this function deploys as a plain asset with no dependencies.
"""
import json
import os
import time
import boto3
import urllib3

http = urllib3.PoolManager()

CONFIG_TTL_SECONDS = 60      # provider/voice config: hot-swap within a minute
API_KEY_TTL_SECONDS = 3600   # API keys rotate rarely

_ssm_cache = {}  # parameter name -> (value, fetched_at)


class TTSProviderError(Exception):
    """Raised when a provider is misconfigured or its API call fails."""


def _get_ssm_parameter(env_var: str, default=None, ttl=CONFIG_TTL_SECONDS, decrypt=False):
    param_name = os.environ.get(env_var)
    if not param_name:
        return default
    cached = _ssm_cache.get(param_name)
    if cached and (time.time() - cached[1]) < ttl:
        return cached[0]
    try:
        ssm = boto3.client('ssm')
        resp = ssm.get_parameter(Name=param_name, WithDecryption=decrypt)
        value = resp['Parameter']['Value']
        _ssm_cache[param_name] = (value, time.time())
        return value
    except Exception as e:
        print(f"Error reading SSM parameter {param_name}: {str(e)}")
        # Serve a stale cached value over failing outright
        return cached[0] if cached else default


def _get_voice_config() -> dict:
    raw = _get_ssm_parameter('TTS_VOICE_CONFIG_PARAMETER_NAME')
    if not raw:
        return {}
    try:
        config = json.loads(raw)
        return config if isinstance(config, dict) else {}
    except (ValueError, TypeError) as e:
        print(f"Invalid TTS voice config JSON, using defaults: {str(e)}")
        return {}


class TTSProvider:
    name = 'base'

    def synthesize(self, text: str, language: str) -> tuple:
        """Return (audio bytes, mime type)."""
        raise NotImplementedError

    def fingerprint(self, language: str) -> str:
        """Provider+model+voice identity; part of the S3 cache key."""
        raise NotImplementedError


class ElevenLabsProvider(TTSProvider):
    name = 'elevenlabs'
    DEFAULT_MODEL = 'eleven_flash_v2_5'
    # "Rachel", a multilingual premade voice; override via voice config
    DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'
    # Flash v2.5 accepts ~40k chars per request; stay under it
    MAX_CHARS = 38000

    def __init__(self, voice_config: dict):
        self.model = voice_config.get('model', self.DEFAULT_MODEL)
        self.voice_config = voice_config

    def _voice_for(self, language: str) -> str:
        by_language = self.voice_config.get('byLanguage') or {}
        return by_language.get(language) or self.voice_config.get('default') or self.DEFAULT_VOICE

    def fingerprint(self, language: str) -> str:
        return f'{self.name}|{self.model}|{self._voice_for(language)}'

    def synthesize(self, text: str, language: str) -> tuple:
        from text_utils import chunk_text
        api_key = _get_ssm_parameter(
            'ELEVENLABS_API_KEY_PARAMETER_NAME', ttl=API_KEY_TTL_SECONDS, decrypt=True
        )
        if not api_key:
            raise TTSProviderError('ElevenLabs API key not available from SSM')

        voice_id = self._voice_for(language)
        url = (
            f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}'
            '?output_format=mp3_44100_128'
        )
        audio = b''
        for chunk in chunk_text(text, self.MAX_CHARS):
            body = {'text': chunk, 'model_id': self.model}
            # language_code enforcement is only supported by flash/turbo models
            if 'flash' in self.model or 'turbo' in self.model:
                body['language_code'] = language
            resp = http.request(
                'POST', url,
                body=json.dumps(body).encode('utf-8'),
                headers={'xi-api-key': api_key, 'Content-Type': 'application/json'},
                timeout=urllib3.Timeout(connect=10, read=90),
            )
            if resp.status != 200:
                raise TTSProviderError(
                    f'ElevenLabs returned {resp.status}: {resp.data[:300]!r}'
                )
            audio += resp.data
        return audio, 'audio/mpeg'


class OpenAIProvider(TTSProvider):
    name = 'openai'
    DEFAULT_MODEL = 'gpt-4o-mini-tts'
    DEFAULT_VOICE = 'alloy'
    # API limit is 4096 chars per request; chunk below it at sentence bounds
    MAX_CHARS = 3000

    def __init__(self, voice_config: dict):
        self.model = voice_config.get('model', self.DEFAULT_MODEL)
        self.voice_config = voice_config

    def _voice_for(self, language: str) -> str:
        by_language = self.voice_config.get('byLanguage') or {}
        return by_language.get(language) or self.voice_config.get('default') or self.DEFAULT_VOICE

    def fingerprint(self, language: str) -> str:
        return f'{self.name}|{self.model}|{self._voice_for(language)}'

    def synthesize(self, text: str, language: str) -> tuple:
        from text_utils import chunk_text
        api_key = _get_ssm_parameter(
            'OPENAI_API_KEY_PARAMETER_NAME', ttl=API_KEY_TTL_SECONDS, decrypt=True
        )
        if not api_key:
            raise TTSProviderError('OpenAI API key not available from SSM')

        audio = b''
        # Raw MP3 frame streams concatenate into a playable file
        for chunk in chunk_text(text, self.MAX_CHARS):
            resp = http.request(
                'POST', 'https://api.openai.com/v1/audio/speech',
                body=json.dumps({
                    'model': self.model,
                    'voice': self._voice_for(language),
                    'input': chunk,
                    'response_format': 'mp3',
                }).encode('utf-8'),
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                timeout=urllib3.Timeout(connect=10, read=90),
            )
            if resp.status != 200:
                raise TTSProviderError(
                    f'OpenAI returned {resp.status}: {resp.data[:300]!r}'
                )
            audio += resp.data
        return audio, 'audio/mpeg'


def get_provider() -> TTSProvider:
    """Resolve the active provider from SSM; defaults to ElevenLabs."""
    provider_name = (
        _get_ssm_parameter('TTS_PROVIDER_PARAMETER_NAME', default='elevenlabs')
        or 'elevenlabs'
    ).strip().lower()
    voice_config = _get_voice_config()
    if provider_name == 'openai':
        return OpenAIProvider(voice_config.get('openai') or {})
    if provider_name != 'elevenlabs':
        print(f"Unknown TTS provider '{provider_name}', falling back to elevenlabs")
    return ElevenLabsProvider(voice_config.get('elevenlabs') or {})
