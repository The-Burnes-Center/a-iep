"""The family survey routes on user-profile-handler, through lambda_handler.

What must hold:
  - only the caller's child, and only answers the questions allow;
  - answers are encrypted at rest and never logged;
  - the baseline closes for good once the summary is opened, even in a race;
  - removing a child removes its answers; GET /profile carries none of them.
"""
import json

import pytest
from botocore.exceptions import ClientError

from test_user_profile_api import (USER, api, call, call_raw_body,  # noqa: F401 (api is a fixture)
                                   profile_with_child, stored_profile)

SURVEY = '/profile/children/child-1/survey'
VIEWED = '/profile/children/child-1/survey/summary-viewed'
# Distinctive values, so a test can prove they never reach the item or the log.
SECRET_WHY = 'the team rushed the meeting zq7'
ABOUT = {'k12': 'yes', 'englishLearner': 'unsure', 'u1': 'agree', 'speakWhy': SECRET_WHY}


def save(api, body, path=SURVEY):
    return call(api, path, 'PUT', body)


def two_children(api):
    api.profiles.put_item(Item={'userId': USER, 'children': [
        {'childId': 'child-1', 'name': 'Kid', 'schoolCity': 'Boston'},
        {'childId': 'child-2', 'name': 'Sib', 'schoolCity': 'Boston'},
    ]})


# --- reading -----------------------------------------------------------------

def test_a_child_with_nothing_saved_reads_as_empty(api):
    profile_with_child(api)
    status, body = call(api, SURVEY, 'GET')
    assert status == 200
    assert body == {'version': 1, 'before': None, 'after': None, 'household': None,
                    'summaryFirstViewedAt': None, 'iepChildCount': None}


def test_another_parents_child_is_not_found_and_nothing_is_written(api):
    profile_with_child(api, user='someone-else')
    profile_with_child(api)
    status, _ = call(api, '/profile/children/child-1/survey', 'GET', user='a-third-parent')
    assert status == 404
    status, _ = save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT})
    assert status == 200  # their own child-1 is fine
    status, _ = call(api, SURVEY, 'PUT', {'phase': 'before', 'status': 'started'}, user='a-third-parent')
    assert status == 404
    assert stored_profile(api, user='a-third-parent') is None


# --- saving ------------------------------------------------------------------

def test_answers_round_trip_and_are_encrypted_at_rest(api, capsys):
    profile_with_child(api)
    status, body = save(api, {'phase': 'before', 'status': 'started', 'part': 'about',
                              'answers': ABOUT, 'researchConsent': True})
    assert status == 200
    assert body['before']['answers'] == ABOUT

    item = stored_profile(api)
    record = item['surveys']['child-1']['before']
    assert record['status'] == 'started' and record['part'] == 'about'
    assert record['researchConsent'] is True and record['version'] == 1
    assert 'answers' not in record
    assert SECRET_WHY not in json.dumps(item, default=str)  # ciphertext only
    assert SECRET_WHY not in capsys.readouterr().out          # and never logged

    status, body = call(api, SURVEY, 'GET')
    assert status == 200 and body['before']['answers'] == ABOUT
    assert 'answersEnc' not in body['before']


@pytest.mark.parametrize('answers, reason', [
    ({'notAQuestion': 'yes'}, 'an answer key is not a question in this version'),
    ({'k12': 'unsure'}, 'a choice answer is not one of its options'),
    ({'u1': 3}, 'a choice answer is not one of its options'),
    ({'reflectParts': ['goals', 'goals']}, 'a checklist answer is not a list of its options'),
    ({'reflectParts': ['recess']}, 'a checklist answer is not a list of its options'),
    ({'reflectParts': [{'a': 1}]}, 'a checklist answer is not a list of its options'),
    ({'speakWhy': 'x' * 501}, 'a written answer is not text or is too long'),
    ('not an object', 'answers is not an object'),
])
def test_an_answer_the_questions_do_not_allow_is_refused_with_its_reason(api, capsys, answers, reason):
    profile_with_child(api)
    status, body = save(api, {'phase': 'before', 'status': 'started', 'answers': answers})
    assert status == 400
    log = capsys.readouterr().out
    assert reason in log
    assert 'notAQuestion' not in log and 'recess' not in log  # the rule, never what was sent
    assert 'surveys' not in stored_profile(api)


@pytest.mark.parametrize('body', [
    {'phase': 'during', 'status': 'started'},
    {'phase': 'before', 'status': 'finished'},
    {'phase': 'after', 'status': 'remind'},
    {'phase': 'before', 'status': 'started', 'part': 'followUp'},
    {'phase': 'before', 'status': 'started', 'researchConsent': 'yes'},
])
def test_an_unknown_phase_status_part_or_consent_is_refused(api, body):
    profile_with_child(api)
    status, _ = save(api, body)
    assert status == 400


def test_a_body_that_is_not_json_is_a_400(api):
    profile_with_child(api)
    status, _ = call_raw_body(api, SURVEY, 'PUT', '{not json')
    assert status == 400


def test_consent_survives_a_save_that_does_not_mention_it_and_completedAt_stamps_once(api):
    profile_with_child(api)
    save(api, {'phase': 'before', 'status': 'started', 'part': 'about', 'researchConsent': True})
    save(api, {'phase': 'before', 'status': 'done', 'part': 'reflect'})
    first = stored_profile(api)['surveys']['child-1']['before']
    assert first['researchConsent'] is True
    assert first['completedAt'] >= first['startedAt']

    save(api, {'phase': 'before', 'status': 'done', 'part': 'reflect', 'researchConsent': False})
    second = stored_profile(api)['surveys']['child-1']['before']
    assert second['researchConsent'] is False
    assert second['completedAt'] == first['completedAt']
    assert second['startedAt'] == first['startedAt']


def test_household_answers_are_stored_once_for_the_parent(api):
    two_children(api)
    status, _ = save(api, {'phase': 'household', 'status': 'done', 'part': 'you',
                           'answers': {'aiUse': 'weekly', 'stayInTouch': 'yes', 'email': 'a@b.org'}})
    assert status == 200
    item = stored_profile(api)
    assert item['surveyHousehold']['status'] == 'done'
    assert 'a@b.org' not in json.dumps(item, default=str)

    _, body = call(api, '/profile/children/child-2/survey', 'GET')
    assert body['household']['status'] == 'done'
    assert body['household']['answers']['aiUse'] == 'weekly'


@pytest.mark.parametrize('email, ok', [('a@b.org', True), ('', True), ('5551234567', False), ('a@b', False)])
def test_the_email_answer_must_look_like_one_or_be_blank(api, email, ok):
    profile_with_child(api)
    status, _ = save(api, {'phase': 'household', 'status': 'started', 'answers': {'email': email}})
    assert (status == 200) is ok


def test_a_save_that_cannot_be_encrypted_stores_nothing(api, monkeypatch):
    profile_with_child(api)
    monkeypatch.setattr(api.module, 'kms_key_alias', 'alias/does-not-exist')
    status, _ = save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT})
    assert status == 503
    assert 'surveys' not in stored_profile(api)


# --- the baseline closes when the summary is opened --------------------------

def test_opening_the_summary_closes_the_baseline_but_not_the_follow_up(api):
    profile_with_child(api)
    assert save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT})[0] == 200

    status, body = call(api, VIEWED, 'POST')
    assert status == 200
    viewed_at = body['summaryFirstViewedAt']

    status, body = save(api, {'phase': 'before', 'status': 'done', 'answers': {'u2': 'agree'}})
    assert status == 409 and body['code'] == 'baseline_closed'
    stored = stored_profile(api)['surveys']['child-1']['before']
    assert stored['status'] == 'started'  # the late answer did not land

    status, _ = save(api, {'phase': 'after', 'status': 'done', 'answers': {'u3': 'agree'}})
    assert status == 200

    # Idempotent: the first open is the one that counts.
    _, again = call(api, VIEWED, 'POST')
    assert again['summaryFirstViewedAt'] == viewed_at


def test_the_summary_can_be_marked_before_any_answer_exists(api):
    two_children(api)
    assert call(api, '/profile/children/child-2/survey/summary-viewed', 'POST')[0] == 200
    assert call(api, VIEWED, 'POST')[0] == 200
    surveys = stored_profile(api)['surveys']
    assert set(surveys) == {'child-1', 'child-2'}
    status, body = save(api, {'phase': 'before', 'status': 'started'})
    assert status == 409 and body['code'] == 'baseline_closed'


def test_a_baseline_write_racing_the_summary_open_is_refused_by_the_condition(api):
    """The read saw the baseline open; by the write, the summary was opened."""
    profile_with_child(api)
    save(api, {'phase': 'before', 'status': 'started'})
    stale_read = stored_profile(api)
    call(api, VIEWED, 'POST')
    with pytest.raises(ClientError) as raised:
        api.module._set_child_survey_field(USER, stale_read, 'child-1', 'before',
                                           {'status': 'done'}, baseline_must_be_open=True)
    assert raised.value.response['Error']['Code'] == 'ConditionalCheckFailedException'


def test_marking_another_parents_child_is_not_found(api):
    profile_with_child(api, user='someone-else')
    status, _ = call(api, VIEWED, 'POST')
    assert status == 404


# --- the rest of the profile -------------------------------------------------

def test_get_profile_carries_no_survey_data(api):
    profile_with_child(api)
    save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT})
    save(api, {'phase': 'household', 'status': 'done', 'answers': {'aiUse': 'never'}})
    status, body = call(api, '/profile', 'GET')
    assert status == 200
    assert 'surveys' not in body['profile'] and 'surveyHousehold' not in body['profile']


def test_removing_a_child_removes_its_answers_and_keeps_the_others(api):
    two_children(api)
    save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT})
    save(api, {'phase': 'before', 'status': 'started'}, path='/profile/children/child-2/survey')

    status, _ = call(api, '/profile/children/child-1', 'DELETE')
    assert status == 200
    assert set(stored_profile(api)['surveys']) == {'child-2'}


def test_removing_a_child_with_no_answers_still_works(api):
    two_children(api)
    assert call(api, '/profile/children/child-2', 'DELETE')[0] == 200


@pytest.mark.parametrize('count, ok', [(1, True), (4, True), (10, True), (0, False),
                                       (11, False), (True, False), ('2', False), (2.5, False)])
def test_iep_child_count_is_a_whole_number_from_1_to_10(api, count, ok):
    profile_with_child(api)
    status, _ = call(api, '/profile', 'PUT', {'iepChildCount': count})
    assert (status == 200) is ok
    if ok:
        assert stored_profile(api)['iepChildCount'] == count


# --- review fixes --------------------------------------------------------------

def test_the_longest_answers_in_a_three_byte_script_still_save(api):
    """KMS Encrypt takes 4096 bytes; the text caps keep a full phase under it."""
    profile_with_child(api)
    answers = {'p1': 'disagree', 'r1': 'disagree', 'speakWhy': '\u5b66' * 500,
               'reflectParts': ['other', 'goals', 'services'], 'reflectOther': '\u5b66' * 500,
               **{f'u{i}': 'somewhat_disagree' for i in range(1, 7)}}
    assert len(json.dumps(answers, ensure_ascii=False).encode('utf-8')) <= api.module.survey.ANSWERS_MAX_BYTES
    status, body = save(api, {'phase': 'before', 'status': 'started', 'answers': answers})
    assert status == 200 and body['before']['answers'] == answers


def test_answers_too_large_for_one_encrypt_call_are_a_400_not_a_kms_error(api, monkeypatch, capsys):
    profile_with_child(api)
    monkeypatch.setattr(api.module.survey, 'ANSWERS_MAX_BYTES', 10)
    status, _ = save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT})
    assert status == 400
    assert 'too large to encrypt' in capsys.readouterr().out


def test_a_reminder_keeps_the_answers_already_given(api):
    profile_with_child(api)
    save(api, {'phase': 'before', 'status': 'started', 'answers': ABOUT, 'researchConsent': True})
    status, body = save(api, {'phase': 'before', 'status': 'remind'})
    assert status == 200 and body['before']['answers'] == ABOUT
    _, read = call(api, SURVEY, 'GET')
    assert read['before']['answers'] == ABOUT and read['before']['status'] == 'remind'


def test_saying_no_thanks_can_withdraw_consent(api):
    profile_with_child(api)
    save(api, {'phase': 'before', 'status': 'started', 'researchConsent': True})
    save(api, {'phase': 'before', 'status': 'declined', 'researchConsent': False})
    assert stored_profile(api)['surveys']['child-1']['before']['researchConsent'] is False


def test_a_child_removed_between_the_read_and_the_write_gets_no_survey_back(api):
    two_children(api)
    save(api, {'phase': 'before', 'status': 'started'})
    stale_read = stored_profile(api)
    assert call(api, '/profile/children/child-1', 'DELETE')[0] == 200
    with pytest.raises(ClientError) as raised:
        api.module._set_child_survey_field(USER, stale_read, 'child-1', 'before',
                                           {'status': 'done'}, baseline_must_be_open=True)
    assert raised.value.response['Error']['Code'] == 'ConditionalCheckFailedException'
    assert 'child-1' not in stored_profile(api).get('surveys', {})
