"""The translation prompt carries the glossary itself, and no tool call is needed to get it.

translate_content/translation_agent.py used to embed the language context (the
guidelines plus the whole English-to-X glossary) in the system prompt AND tell
the model to FIRST call get_language_context_for_translation, a tool that
returned the very same text. That forced call was a full extra model round trip
(request, tool call, tool result, request again) for nothing, on every
translation, in front of the one call that does the work.

The glossary now goes in once, in the prompt. get_iep_terminology stays: it is
the model's optional lookup for a single term, not a precondition.
"""
import json
import os
import sys
from types import ModuleType, SimpleNamespace

import pytest

from conftest import FUNCTIONS_DIR, install_agents_sdk_stubs, load_lambda_module, unload

STEP_DIR = os.path.join(FUNCTIONS_DIR, 'metadata-handler', 'steps', 'translate_content')
GLOSSARY_FILES = {
    'es': 'en_es_translations.json',
    'vi': 'en_vi_translations.json',
    'zh': 'en_zh_translations.json',
    'ar': 'en_ar_translations.json',
}


@pytest.fixture()
def translation_agent(monkeypatch):
    install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)
    # The glossaries are read from the lambda's working directory, which is the
    # bundle root when deployed. Pointing at the real files, not a stand-in, is
    # the point: the test is about what the model is actually sent.
    monkeypatch.chdir(STEP_DIR)
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translation_agent_prompt_glossary',
                                module_name='translation_agent')
    try:
        yield module
    finally:
        unload('translation_agent_prompt_glossary')
        unload('config')


@pytest.mark.parametrize('language', sorted(GLOSSARY_FILES))
def test_the_prompt_still_contains_the_whole_glossary(translation_agent, language):
    with open(os.path.join(STEP_DIR, GLOSSARY_FILES[language]), encoding='utf-8-sig') as f:
        glossary = json.load(f)
    assert len(glossary) > 100  # a real glossary, not an empty file passing vacuously

    prompt = translation_agent.OptimizedTranslationAgent()._get_optimized_prompt(
        language, 'parsing_result')

    # Same content as before: the exact context string get_language_context
    # builds (guidelines + glossary), sent once.
    assert translation_agent.get_language_context(language) in prompt
    assert prompt.count(str(glossary)) == 1


@pytest.mark.parametrize('language', sorted(GLOSSARY_FILES))
def test_the_prompt_no_longer_tells_the_model_to_fetch_what_it_was_given(translation_agent, language):
    prompt = translation_agent.OptimizedTranslationAgent()._get_optimized_prompt(
        language, 'parsing_result')

    assert 'get_language_context_for_translation' not in prompt
    assert 'FIRST: Call' not in prompt
    # The other instructions the prompt carries are untouched.
    assert '{{S}}' in prompt
    assert 'Do NOT translate it' in prompt
    assert 'Output ONLY valid JSON' in prompt
    assert 'get_iep_terminology' in prompt


def test_the_agent_is_built_without_a_language_context_tool_and_runs_once(translation_agent, monkeypatch):
    built = []
    runs = []

    class RecordingAgent:
        def __init__(self, **kwargs):
            built.append(kwargs)

    class RecordingRunner:
        @staticmethod
        def run_sync(agent, request, max_turns=None):
            runs.append(request)
            return SimpleNamespace(final_output=json.dumps(
                {'summary': 'Resumen de {{S}}', 'sections': [], 'document_index': '',
                 'abbreviations': []}))

    monkeypatch.setattr(translation_agent, 'Agent', RecordingAgent)
    monkeypatch.setattr(translation_agent, 'Runner', RecordingRunner)

    translated = translation_agent.OptimizedTranslationAgent().translate_content_with_agent(
        {'summary': 'Summary for {{S}}', 'sections': [], 'document_index': '',
         'abbreviations': []}, 'es')

    # No tool call is required to translate: the only tool left is the
    # optional single-term lookup, and the prompt (not a tool result) carries
    # the language context.
    (kwargs,) = built
    assert [tool.__name__ for tool in kwargs['tools']] == ['get_iep_terminology']
    assert translation_agent.get_language_context('es') in kwargs['instructions']
    assert len(runs) == 1
    assert translated['summary'] == 'Resumen de {{S}}'


def test_the_terminology_lookup_still_works(translation_agent):
    agent = translation_agent.OptimizedTranslationAgent()
    with open(os.path.join(STEP_DIR, 'en_es_translations.json'), encoding='utf-8-sig') as f:
        term, expected = next(iter(json.load(f).items()))

    assert agent.terminology_tool(term, 'es') == expected
