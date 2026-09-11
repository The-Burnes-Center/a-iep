"""The student-name feature's policy layer: what counts as the child's name,
what the models are told about the placeholder, and what happens to a
translation that loses it.

Every name in an IEP is now redacted before the document reaches OpenAI. The
student's mentions become {{S}} and are restored from the profile once
processing finishes; every other name becomes [NAME] and is never restored.
That makes one decision load-bearing in both directions:

  - a MISS (a real mention the matcher does not recognise) costs nothing but
    precision: it reads [NAME], and the parsing prompt still asks the model to
    write the token from context;
  - a FALSE POSITIVE puts a teacher's name in front of a parent as their
    child's.

So the matcher is strict on purpose, and the tests below pin the refusals as
firmly as the matches.
"""
import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload

CHILD = 'Jordan Smith'


@pytest.fixture()
def matcher():
    module = load_lambda_module('metadata-handler/steps/redact_ocr',
                                'student_name_matcher', module_name='student_name')
    try:
        yield module
    finally:
        unload('student_name_matcher')


# --- what the matcher accepts ------------------------------------------------

@pytest.mark.parametrize('mention', [
    'Jordan Smith',        # as saved
    'jordan smith',        # OCR lowercasing
    'JORDAN SMITH',        # header/caps row
    'Jordan  Smith',       # double space
    'Jordan Smith.',       # sentence punctuation inside the span
    "Jordan Smith's",      # possessive inside the span
    'Smith, Jordan',       # the roster spelling
    'Smith Jordan',        # the roster spelling with the comma lost to OCR
    'Jordan Michael Smith',  # middle name the parent did not type
    'Jordan M. Smith',     # middle initial
])
def test_the_student_is_recognised_in_every_full_name_spelling(matcher, mention):
    assert matcher.is_student_mention(mention, CHILD) is True


def test_an_accented_spelling_matches_its_unaccented_one(matcher):
    assert matcher.is_student_mention('Jose Garcia', 'José García') is True
    assert matcher.is_student_mention('José García', 'Jose Garcia') is True


def test_a_hyphenated_surname_matches_its_spaced_spelling(matcher):
    assert matcher.is_student_mention('Ana Smith-Jones', 'Ana Smith Jones') is True


def test_a_middle_name_in_the_profile_is_not_required_in_the_document(matcher):
    assert matcher.is_student_mention('Jordan Smith', 'Jordan Michael Smith') is True


# --- what it refuses ---------------------------------------------------------

@pytest.mark.parametrize('mention', [
    'Jordan',          # a bare first name: every Jordan in the building
    'Smith',           # a bare surname: the whole family, and any staff
    'Jordan S.',       # first name plus an initial
    'J. Smith',        # initial plus surname
    'Jordy Smith',     # a nickname is a guess, not a match
    'Jordan Smyth',    # one OCR character out is not a match
    'Jordan Brooks',   # shares only the first name -- the teacher case
    'Casey Smith',     # shares only the surname -- a sibling or a parent
    'Jordan Smith Casey Brooks',  # two names Comprehend ran together
])
def test_anything_short_of_a_full_name_is_refused(matcher, mention):
    """Each of these becomes [NAME] instead, which is the safe outcome."""
    assert matcher.is_student_mention(mention, CHILD) is False


@pytest.mark.parametrize('profile_name', ['', '   ', 'My Child', 'my child', None, 'Jordan'])
def test_no_usable_profile_name_means_nothing_is_ever_matched(matcher, profile_name):
    """'My Child' is the placeholder getProfile used to create, a blank name
    is what it creates now, and a single token cannot be matched without
    matching a bare first name. All three mean: singled out nothing."""
    assert matcher.usable_student_name(profile_name) is None
    assert matcher.is_student_mention('Jordan Smith', profile_name) is False


def test_the_token_is_the_short_handlebars_form(matcher):
    """A model translating into Spanish renders [STUDENT_NAME] as
    [NOMBRE_DEL_ESTUDIANTE]; it leaves a word-free handlebars token alone."""
    assert matcher.STUDENT_TOKEN == '{{S}}'


# --- what the parsing model is told ------------------------------------------

@pytest.fixture()
def parsing_config():
    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_config', module_name='config')
    try:
        yield module
    finally:
        unload('parsing_agent_config')


def test_the_parsing_prompt_spells_the_token_out_literally(parsing_config):
    """The prompt is an f-string, so the token has to survive its braces: a
    prompt that told the model to write {S} would produce a placeholder
    nothing restores."""
    prompt = parsing_config.get_english_only_prompt()
    assert '{{S}}' in prompt
    assert 'character for character' in prompt


def test_the_parsing_prompt_forbids_inventing_or_printing_a_name(parsing_config):
    prompt = parsing_config.get_english_only_prompt()
    assert 'never invent' in prompt.lower()
    assert 'Never print `[NAME]`' in prompt


def test_key_people_points_at_the_attendance_page_instead_of_naming_anyone(parsing_config):
    """With every non-student name redacted, the old instruction ("extract the
    names of the Administrator, General Education Teacher, ...") could only
    produce a column of [NAME]. The parent gets the page number of the list
    that is already in their own copy of the IEP."""
    key_people = parsing_config.SECTION_KEY_POINTS['Key People']
    assert 'never the names' in key_people
    assert 'signature' in key_people and 'page number' in key_people
    assert 'extract the names of the Administrator' not in key_people


def test_services_names_providers_by_role(parsing_config):
    services = parsing_config.SECTION_KEY_POINTS['Services']
    assert 'BY ROLE' in services
    assert 'include the name of the service provider' not in services


# --- what the translating model is told, and what is checked afterwards ------

@pytest.fixture()
def translation_agent(monkeypatch):
    install_agents_sdk_stubs(monkeypatch)
    from types import ModuleType
    data_model_stub = ModuleType('data_model')
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(__import__('sys').modules, 'data_model', data_model_stub)
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'translation_agent_prompt', module_name='translation_agent')
    try:
        yield module
    finally:
        unload('translation_agent_prompt')
        unload('config')


def test_the_translation_prompt_spells_the_token_out_literally(translation_agent, monkeypatch):
    # The real language context reads a JSON file from the lambda's working
    # directory, which only exists inside the deployed bundle.
    monkeypatch.setattr(translation_agent, 'get_language_context',
                        lambda target_language: 'language guidelines')
    prompt = translation_agent.OptimizedTranslationAgent()._get_optimized_prompt(
        'es', 'parsing_result')
    assert '{{S}}' in prompt
    assert 'Do NOT translate it' in prompt
    assert 'Leave them exactly as they are' in prompt


@pytest.fixture()
def token_check():
    module = load_lambda_module('metadata-handler/steps/translate_content',
                                'student_token_check', module_name='student_token')
    try:
        yield module
    finally:
        unload('student_token_check')


def _translated(summary):
    return {'summary': summary,
            'sections': [{'title': 'Goals', 'content': 'Metas de {{S}}.',
                          'page_numbers': [3]}],
            'document_index': 'Indice', 'abbreviations': []}


def test_a_translation_that_kept_every_token_passes(token_check):
    token_check.verify_token_survived(2, _translated('{{S}} progresa.'), 'es')


def test_a_translation_that_dropped_the_token_fails_the_step(token_check):
    with pytest.raises(token_check.StudentTokenLost):
        token_check.verify_token_survived(2, _translated('El estudiante progresa.'), 'es')


@pytest.mark.parametrize('mangled', [
    '{{ S }} progresa.',      # spaces added
    '{ {S} } progresa.',      # braces separated
    '{S} progresa.',          # a brace dropped
    '{{s}} progresa.',        # lowercased
    '｛｛S｝｝ 进步了。',          # full-width braces, the Chinese run's version
])
def test_a_mangled_token_fails_even_with_enough_intact_ones(token_check, mangled):
    """Expected is 1 and one intact token is present, so the count alone is
    satisfied: only the sweep for reformatted tokens can fail this. Without
    it a parent reads the braces."""
    content = {'summary': mangled,
               'sections': [{'title': 'Goals', 'content': 'Metas de {{S}}.',
                             'page_numbers': [3]}]}
    assert token_check.count_tokens(content) == 1
    with pytest.raises(token_check.StudentTokenLost):
        token_check.verify_token_survived(1, content, 'zh')


def test_the_failure_message_carries_counts_and_never_content(token_check):
    with pytest.raises(token_check.StudentTokenLost) as exc_info:
        token_check.verify_token_survived(
            2, _translated('El estudiante Jordan Smith progresa.'), 'es')
    assert 'Jordan Smith' not in str(exc_info.value)
    assert 'expected 2' in str(exc_info.value)


def test_content_that_never_had_a_token_is_left_alone(token_check):
    """A document whose parent saved no name (or whose spellings the matcher
    refused) has no token to preserve, and must not fail every translation."""
    token_check.verify_token_survived(0, _translated('El estudiante progresa.'), 'es')
