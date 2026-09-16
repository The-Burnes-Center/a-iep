r"""What the API will accept as a child's name, and what it does with the rest.

Nothing validated it before this: '123', '!!!' and '.' all stored fine, and the
stored value is what reaches the heading of every summary, every translation,
and the audio a parent listens to.

The same rule runs in the browser
(lib/user-interface/app/src/common/child-name.ts, covered case for case by
child-name.test.ts). The tables below are deliberately the same tables: the two
sides have to answer identically, or a name the screen takes and the API
refuses reaches a parent as a generic "could not save" with nothing on screen
telling them what to change.

Two things only the server can get wrong are pinned here as well: what the
rejection writes to CloudWatch (the reason code, never the name -- it is a
FERPA-protected record of a child with a disability), and what it hands back to
the caller (a generic message, never the value).

The last section covers the crash the missing validation left reachable. A
stored name of '\1' raised re.error out of student_name_substitution, which is
a 500 on every read of that child's document, and '\g<0>' printed the mangled
token to the parent as their child's name.
"""
import base64
import json
import sys
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

PROFILES_TABLE = 'profiles-test'
DOCUMENTS_TABLE = 'documents-test'
KMS_ALIAS = 'alias/aiep/app-test'
USER = 'user-sub-1'

# Several of these look identical to the line above them: a decomposed name
# renders exactly like a precomposed one, and U+2010 / U+2019 render almost
# exactly like the ASCII hyphen and apostrophe. That is what the label on each
# case is for -- without it a failure here is unreadable.
ACCEPTED = [
    ('José', 'Spanish, precomposed'),
    ('José', 'Spanish, decomposed: e + combining acute'),
    ('Nguyễn Minh Anh', 'Vietnamese, precomposed'),
    ('Nguyễn Minh Anh', 'Vietnamese, decomposed: two marks on one letter'),
    ('李伟', 'Chinese'),
    ('أحمد', 'Arabic'),
    ('أَحْمَد', 'Arabic with harakat (combining marks)'),
    ("Mary-Jane O'Brien", 'ASCII hyphen and apostrophe'),
    ('Mary‐Jane O’Brien', 'the Unicode hyphen and curly apostrophe a keyboard produces'),
    ('J. R. Rivera', 'initials'),
    ('A', 'a single letter is a name'),
    ('李', 'one Chinese character is a name'),
    ('van der Berg', 'lower case particles'),
    ('Ana María de la Cruz', 'four words'),
    ('Mary\u00a0Jane', 'a non-breaking space is a space'),
    # A digit ALONGSIDE letters is a name a parent meant to type. Refusing it
    # left a parent distinguishing two children with no way forward but
    # renaming one of them. A digit on its own is still refused, below.
    ('Alex 3', 'a digit alongside letters'),
    ('Anna 2', 'the second Anna'),
    ('E2E Test Child', 'a digit inside a word'),
]

REJECTED = [
    ('', 'required'),
    ('   ', 'required'),
    ('\t\n ', 'required'),
    ('123', 'invalid'),
    ('!!!', 'invalid'),
    ('.', 'invalid'),
    ('-', 'invalid'),
    ("'", 'invalid'),
    ('  .  ', 'invalid'),
    ('...', 'invalid'),
    ('Alex!', 'invalid'),
    ('Alex_Rivera', 'invalid'),
    ('Alex@home', 'invalid'),
    ('<script>', 'invalid'),
    ('Alex \U0001f600', 'invalid'),
    ('\U0001f600', 'invalid'),
    ('Alex\x07', 'invalid'),  # a control character
    ('Alex\u200bRivera', 'invalid'),  # a zero-width space
    ('\\1', 'invalid'),
    ('\\g<0>', 'invalid'),
    ('Alex\\Rivera', 'invalid'),
]


@pytest.fixture()
def api(monkeypatch):
    """The real handler over moto: a profiles table and the CMK it encrypts with.

    Smaller than test_user_profile_api's fixture on purpose -- a rejected name
    never reaches S3, Cognito or the documents table, and the accepted ones
    only need somewhere to be written.
    """
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        profiles = dynamodb.create_table(
            TableName=PROFILES_TABLE,
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        kms = boto3.client('kms', region_name='us-east-1')
        key_id = kms.create_key()['KeyMetadata']['KeyId']
        kms.create_alias(AliasName=KMS_ALIAS, TargetKeyId=key_id)

        monkeypatch.setenv('USER_PROFILES_TABLE', PROFILES_TABLE)
        monkeypatch.setenv('IEP_DOCUMENTS_TABLE', DOCUMENTS_TABLE)
        monkeypatch.setenv('AIEP_KMS_KEY_ALIAS', KMS_ALIAS)

        module = load_lambda_module('user-profile-handler', 'child_name_lambda')
        # router.py lazily re-imports `lambda_function` inside each route
        # method, so the loaded module must also answer to that name.
        sys.modules['lambda_function'] = module
        try:
            yield SimpleNamespace(module=module, profiles=profiles, kms=kms)
        finally:
            unload('lambda_function')
            unload('child_name_lambda')
            unload('router')  # imported as a sibling during module exec
            unload('student_name_substitution')  # both lambdas ship one; do not leak it


@pytest.fixture()
def substitution():
    """The substitution module on its own: no AWS, it is pure string work."""
    module = load_lambda_module('user-profile-handler', 'child_name_substitution',
                                module_name='student_name_substitution')
    yield module
    unload('child_name_substitution')


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


def update_name(api, name):
    return call(api, '/profile', 'PUT',
                body={'children': [{'name': name, 'schoolCity': 'Boston'}]})


def add_name(api, name):
    return call(api, '/profile/children', 'POST',
                body={'name': name, 'schoolCity': 'Boston'})


def stored_profile(api, user=USER):
    return api.profiles.get_item(Key={'userId': user}).get('Item')


def stored_child_name(api, index=0):
    stored = stored_profile(api)['children'][index]
    return api.kms.decrypt(
        CiphertextBlob=base64.b64decode(stored['name']))['Plaintext'].decode()


# ---------------------------------------------------------------------------
# The rule itself


@pytest.mark.parametrize('name,description', ACCEPTED)
def test_a_name_written_in_any_script_we_ship_in_is_accepted(api, name, description):
    """The cases that matter most: this runs in front of every family, and the
    quickest way to lock one out is to decide their child's name is invalid.
    Four of the five languages we ship in are here."""
    assert api.module.validate_child_name(name) is None, description


@pytest.mark.parametrize('name,reason', REJECTED)
def test_a_name_that_is_not_a_name_is_rejected_with_a_reason(api, name, reason):
    assert api.module.validate_child_name(name) == reason


@pytest.mark.parametrize('name', [None, 123, [], {}, True])
def test_a_name_that_is_not_a_string_is_missing_rather_than_a_crash(api, name):
    assert api.module.validate_child_name(name) == 'required'


def test_the_length_boundary(api):
    assert api.module.CHILD_NAME_MAX_LENGTH == 64
    assert api.module.validate_child_name('a' * 64) is None
    assert api.module.validate_child_name('a' * 65) == 'tooLong'


def test_length_is_measured_on_the_collapsed_name_not_the_keystrokes(api):
    # 65 characters sent, 64 stored. Measuring the raw value would refuse a
    # name that then saves fine.
    typed = 'a' * 32 + '  ' + 'a' * 31
    assert len(typed) == 65
    assert api.module.validate_child_name(typed) is None
    assert api.module.validate_child_name('   ' + 'a' * 64 + '   ') is None


def test_an_over_long_name_is_too_long_even_when_it_is_also_invalid(api):
    # The check order is part of the agreement with the screen: both sides
    # must give a parent the same answer for the same input.
    assert api.module.validate_child_name('9' * 65) == 'tooLong'


# ---------------------------------------------------------------------------
# What a parent's request actually gets back


@pytest.mark.parametrize('name,reason,message', [
    ('   ', 'required', 'Child name cannot be blank'),
    ('123', 'invalid', 'Child name must contain a letter, and can only use letters, numbers, spaces, hyphens, apostrophes and periods'),
    ('!!!', 'invalid', 'Child name must contain a letter, and can only use letters, numbers, spaces, hyphens, apostrophes and periods'),
    ('a' * 65, 'tooLong', 'Child name must be 64 characters or fewer'),
])
def test_update_profile_refuses_the_name_and_writes_nothing(api, capsys, name, reason, message):
    api.profiles.put_item(Item={'userId': USER})

    status, body = update_name(api, name)

    assert status == 400
    assert body['message'] == message
    assert stored_profile(api) == {'userId': USER}  # nothing written
    assert 'update_user_profile' in capsys.readouterr().out


@pytest.mark.parametrize('name,message', [
    ('   ', 'Child name cannot be blank'),
    ('123', 'Child name must contain a letter, and can only use letters, numbers, spaces, hyphens, apostrophes and periods'),
    ('!!!', 'Child name must contain a letter, and can only use letters, numbers, spaces, hyphens, apostrophes and periods'),
    ('a' * 65, 'Child name must be 64 characters or fewer'),
])
def test_add_child_refuses_the_name_and_appends_nothing(api, capsys, name, message):
    api.profiles.put_item(Item={
        'userId': USER,
        'children': [{'childId': 'child-1', 'name': 'Kid', 'schoolCity': 'Boston'}],
    })
    before = stored_profile(api)

    status, body = add_name(api, name)

    assert status == 400
    assert body['message'] == message
    assert stored_profile(api) == before  # no child appended
    assert 'add_child' in capsys.readouterr().out


def test_the_blank_name_message_and_log_line_are_unchanged(api, capsys):
    """The wider rule replaced the blank-name check; it must not have changed
    the answer that check already gave. This is the case the screen's
    `required` message is written against."""
    api.profiles.put_item(Item={'userId': USER})

    status, body = update_name(api, '   ')

    assert status == 400
    assert body['message'] == 'Child name cannot be blank'
    assert 'blank or whitespace-only child name' in capsys.readouterr().out


@pytest.mark.parametrize('route', ['update', 'add'])
def test_the_rejection_reaches_cloudwatch_without_the_name(api, capsys, route):
    """A silent 4xx is a defect -- an unlogged rejection already made one real
    failure in this file undiagnosable -- but the name is a FERPA-protected
    record of a child with a disability. So: the reason code, never the value.
    """
    api.profiles.put_item(Item={'userId': USER})
    typed = 'Dhruv 123!!!'

    status, body = update_name(api, typed) if route == 'update' else add_name(api, typed)

    assert status == 400
    logged = capsys.readouterr().out
    assert 'child name holds no letter' in logged  # why it was refused
    assert USER in logged                           # and whose request it was
    for fragment in [typed, 'Dhruv']:
        assert fragment not in logged
        assert fragment not in json.dumps(body)


def test_a_rejection_never_echoes_the_value_back_to_the_caller(api):
    api.profiles.put_item(Item={'userId': USER})
    typed = 'Dhruv<script>alert(1)</script>'

    status, body = update_name(api, typed)

    assert status == 400
    assert 'script' not in json.dumps(body)
    assert 'Dhruv' not in json.dumps(body)


# ---------------------------------------------------------------------------
# The names that must still get through


@pytest.mark.parametrize('name', [
    'Nguyễn Minh Anh',
    '李伟',
    'أحمد',
    "Mary-Jane O'Brien",
    'José',
])
def test_a_real_name_still_saves_on_both_routes(api, name):
    api.profiles.put_item(Item={'userId': USER})

    assert update_name(api, name)[0] == 200
    assert stored_child_name(api) == name

    assert add_name(api, name)[0] == 200
    assert stored_child_name(api, index=1) == name


def test_validation_runs_in_front_of_the_tidying_not_instead_of_it(api):
    # normalize_child_name still collapses the whitespace and capitalises a
    # name typed in lower case; validation only decides whether it gets there.
    api.profiles.put_item(Item={'userId': USER})

    assert update_name(api, '  dhruv   kumar  ')[0] == 200
    assert stored_child_name(api) == 'Dhruv Kumar'


# ---------------------------------------------------------------------------
# The crash the missing validation left reachable
#
# re.sub expands backslash escapes in a replacement STRING, and the replacement
# is the child's name. Passing a callable instead is what stops that: nothing
# in the name is interpreted.


@pytest.mark.parametrize('token', ['{{ S }}', '{ S }', '｛｛S｝｝'])
def test_a_name_holding_a_group_reference_prints_instead_of_raising(substitution, token):
    """'\\1' as a name used to raise re.error('invalid group reference') on the
    mangled-token pass, which is a 500 on every read of that child's document.
    Names stored before validation existed can still be this."""
    value, count = substitution.substitute_in_value(f'Meet {token} today', '\\1')

    assert value == 'Meet \\1 today'
    assert count == 1


def test_a_name_holding_a_whole_match_reference_is_not_expanded(substitution):
    """'\\g<0>' is a VALID replacement escape, which is worse than the crash:
    it expands to the matched token, so the parent reads '{{ S }}' as their
    child's name with nothing failing anywhere."""
    value, count = substitution.substitute_in_value('Meet {{ S }} today', '\\g<0>')

    assert value == 'Meet \\g<0> today'
    assert count == 1


def test_a_name_holding_a_literal_backslash_prints_as_typed(substitution):
    """'\\R' is neither a group reference nor a known escape: re.error('bad
    escape'), again on every read."""
    value, count = substitution.substitute_in_value('Meet {{ S }} today', 'Alex\\Rivera')

    assert value == 'Meet Alex\\Rivera today'
    assert count == 1


def test_a_backslash_n_in_a_name_stays_two_characters(substitution):
    """Silently mangled rather than raised: as a replacement string this became
    a real newline in the middle of a summary."""
    value, _ = substitution.substitute_in_value('Meet {{ S }} today', 'A\\nB')

    assert value == 'Meet A\\nB today'
    assert '\n' not in value


def test_the_exact_token_was_never_the_crashing_path(substitution):
    """str.replace does no escape processing, so '{{S}}' was always fine. The
    mangled-token regex is the one that reached re.sub, which is why the fix
    is there and why these cases use spaced and full-width tokens."""
    value, count = substitution.substitute_in_value('Meet {{S}} today', '\\1')

    assert value == 'Meet \\1 today'
    assert count == 1


def test_a_whole_content_dict_survives_a_name_like_this(substitution):
    """The real entry point: substitute_content walks every field and language
    of a document, so one bad name failed the whole read, not one string."""
    content = {
        'summaries': {'en': 'Meet {{ S }}.', 'es': 'Conoce a {{ S }}.'},
        'sections': {'en': ['{{ S }} reads well', {'note': '{{ S }}'}]},
    }

    substituted, count = substitution.substitute_content(content, '\\1')

    assert substituted['summaries']['en'] == 'Meet \\1.'
    assert substituted['summaries']['es'] == 'Conoce a \\1.'
    assert substituted['sections']['en'] == ['\\1 reads well', {'note': '\\1'}]
    assert count == 4
    # Nothing mutated in place: the caller's copy is what was read from S3.
    assert content['summaries']['en'] == 'Meet {{ S }}.'


@pytest.mark.parametrize('name', ['\\1', '\\g<0>', 'Alex\\Rivera', 'A\\nB'])
def test_no_new_child_can_be_stored_with_a_name_like_that(api, name):
    """The fix above is for records already written. Validation is what stops
    the next one."""
    api.profiles.put_item(Item={'userId': USER})

    assert api.module.validate_child_name(name) == 'invalid'
    assert update_name(api, name)[0] == 400
    assert add_name(api, name)[0] == 400
