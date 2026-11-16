"""The daily brief is the answer to "is anything still happening".

Alarms only fire when something errors, so a component that stops being
invoked at all keeps every alarm green while doing nothing. These tests pin
the properties that make the brief worth reading: it distinguishes idle from
broken, it cannot claim "all green" while an alarm is firing or while it
could not read what to check, and it says what an idle component is for so a
reader can judge "0 runs" for themselves. The title carries the status in
words after its icon, as every alert does.
"""
import datetime
import json

import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

ALIAS = 'daily_brief_under_test'


COMPONENTS = [
    {'label': 'Mistral OCR', 'functionName': 'fn-ocr', 'purpose': 'reads the text out of an upload'},
    {'label': 'TTS', 'functionName': 'fn-tts', 'purpose': 'reads a summary aloud'},
    {'label': 'referrals', 'functionName': 'fn-ref', 'purpose': 'invite links'},
]


@pytest.fixture
def brief(monkeypatch):
    monkeypatch.setenv('ALERT_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789012:alerts')
    monkeypatch.setenv('ENVIRONMENT', 'production')
    monkeypatch.setenv('BRIEF_COMPONENTS_PARAM', '/a-iep/prod/daily-brief/components')
    monkeypatch.setenv('ALARM_PREFIX', 'a-iep ')
    with mock_aws():
        yield load_lambda_module('daily-brief', ALIAS, module_name='handler')
    unload(ALIAS)


def _stub(module, totals, firing=(), components=None, manifest_unreadable=False):
    """totals: {functionName: (invocations, errors)}; firing: [{'severity', 'headline'}].

    _components returns (components, could_not_read). The second element is
    what stops an unreadable manifest from publishing a green tick for a brief
    that measured nothing.
    """
    module._components = lambda: (
        list(COMPONENTS if components is None else components), manifest_unreadable)
    module._totals = lambda comps, start, end: {
        i: list(totals.get(c['functionName'], (0, 0))) for i, c in enumerate(comps)
    }
    module._alarms_now = lambda: list(firing)


NOW = datetime.datetime(2026, 9, 10, 13, 0, tzinfo=datetime.timezone.utc)

SIGN_IN = {'severity': 'CRITICAL', 'headline': 'Sign-in codes are not being sent'}


def test_no_problems_title_is_green_and_says_so_in_words(brief):
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 0)})

    content = brief.build_brief(now=NOW)['content']

    assert content['title'] == ':white_check_mark: A-IEP daily brief — 2026-09-10 — all green (2 ran, 1 idle) · prod'
    assert 'problem' not in content['title']


def test_every_component_is_listed_problems_first_then_ran_then_idle(brief):
    """A reader on a phone meets the red before the green, and every line says what it is."""
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 2)})

    lines = brief.build_brief(now=NOW)['content']['description'].splitlines()

    assert lines == [
        ':rotating_light: TTS — 11 runs, 2 errors · reads a summary aloud',
        ':white_check_mark: Mistral OCR — 4 runs, 0 errors · reads the text out of an upload',
        ':zzz: referrals — 0 runs, 0 errors · invite links',
        'Window: 24h to 13:00 UTC.',
    ]


def test_an_idle_component_is_listed_with_its_purpose_and_is_not_a_problem(brief):
    """Several only run when a parent acts, so 0 is often correct.

    It is listed with what it is for because "0 runs" cannot be judged without
    knowing whether the thing was meant to run.
    """
    _stub(brief, {'fn-ocr': (4, 0)})

    content = brief.build_brief(now=NOW)['content']

    assert content['title'].endswith('all green (1 ran, 2 idle) · prod')
    assert ':zzz: TTS — 0 runs, 0 errors · reads a summary aloud' in content['description']
    assert ':zzz: referrals — 0 runs, 0 errors · invite links' in content['description']
    assert ':rotating_light:' not in content['description']
    assert '*Needs attention*' not in content['description']


def test_errored_components_sort_most_errors_first_and_singular_counts_read_singular(brief):
    _stub(brief, {'fn-ocr': (4, 1), 'fn-tts': (11, 2), 'fn-ref': (1, 1)})

    lines = brief.build_brief(now=NOW)['content']['description'].splitlines()

    assert lines[0] == ':rotating_light: TTS — 11 runs, 2 errors · reads a summary aloud'
    assert lines[1] == ':rotating_light: Mistral OCR — 4 runs, 1 error · reads the text out of an upload'
    assert lines[2] == ':rotating_light: referrals — 1 run, 1 error · invite links'


def test_errors_are_a_problem_in_the_title_and_not_repeated_under_needs_attention(brief):
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 2), 'fn-ref': (1, 0)})

    content = brief.build_brief(now=NOW)['content']

    assert content['title'] == ':warning: A-IEP daily brief — 2026-09-10 — 1 problem(s) need attention · prod'
    # Needs attention holds firing alarms only; errored components sit at the top of the list.
    assert '*Needs attention*' not in content['description']


def test_the_problem_count_is_the_errored_components_plus_firing_alarms(brief):
    _stub(brief, {'fn-tts': (11, 2), 'fn-ref': (1, 1)}, firing=[SIGN_IN])

    assert '3 problem(s) need attention' in brief.build_brief(now=NOW)['content']['title']


def test_a_firing_alarm_prevents_an_all_green_claim(brief):
    """The worst failure this could have is saying all is well over a live outage."""
    _stub(brief, {'fn-ocr': (4, 0)}, firing=[SIGN_IN])

    content = brief.build_brief(now=NOW)['content']

    assert content['title'].startswith(':warning:')
    assert 'all green' not in content['title']
    assert '1 problem(s) need attention' in content['title']
    # Named by its headline, not counted and not a CloudWatch alarm name.
    assert content['description'].startswith(
        '*Needs attention*\n:rotating_light: Sign-in codes are not being sent (alert active now)')


def test_the_alarms_firing_come_from_their_headlines_worst_first(brief):
    """Alarm descriptions are written by alert-copy.ts; the brief reads their first line."""
    class _Paginator:
        def paginate(self, **kwargs):
            assert kwargs['StateValue'] == 'ALARM'
            assert kwargs['AlarmNamePrefix'] == 'a-iep '
            return [{'MetricAlarms': [
                {'AlarmName': 'a-iep b', 'AlarmDescription': '[PROD] [WARNING] Document progress is not being saved\nImpact: x'},
                {'AlarmName': 'a-iep a', 'AlarmDescription': '[PROD] [CRITICAL] Sign-in codes are not being sent\nImpact: x'},
                {'AlarmName': 'a-iep c', 'AlarmDescription': 'no shape at all'},
            ]}]

    brief.cloudwatch = type('C', (), {'get_paginator': lambda self, name: _Paginator()})()

    assert brief._alarms_now() == [
        {'severity': 'CRITICAL', 'headline': 'Sign-in codes are not being sent'},
        {'severity': 'WARNING', 'headline': 'Document progress is not being saved'},
        {'severity': 'WARNING', 'headline': 'a-iep c'},
    ]


def test_the_brief_carries_no_content_only_names_and_counts(brief):
    """FERPA: nothing here may come from a document, log or request body."""
    _stub(brief, {'fn-ocr': (4, 1)}, firing=[SIGN_IN])

    blob = json.dumps(brief.build_brief(now=NOW))

    # Everything present is a label, a purpose, a count, a date or a headline.
    assert 'Mistral OCR' in blob
    assert 'error_message' not in blob and 'Cause' not in blob


def test_it_publishes_as_a_custom_notification(brief):
    """Chatbot only renders the readable card when source is "custom"."""
    _stub(brief, {'fn-ocr': (1, 0)})
    published = []
    brief.sns = type('S', (), {'publish': lambda self, **kw: published.append(kw)})()

    brief.lambda_handler({}, None)

    assert len(published) == 1
    payload = json.loads(published[0]['Message'])
    assert payload['source'] == 'custom'
    assert payload['content']['textType'] == 'client-markdown'
    assert payload['metadata']['summary'] == payload['content']['title']


def test_staging_is_marked_staging(brief, monkeypatch):
    monkeypatch.setattr(brief, 'IS_PROD', False)
    _stub(brief, {'fn-ocr': (4, 0)})

    title = brief.build_brief(now=NOW)['content']['title']

    assert title.startswith(':white_check_mark: A-IEP daily brief')
    assert title.endswith('· staging')


def test_the_window_line_says_what_was_covered(brief):
    _stub(brief, {'fn-ocr': (4, 0)})

    description = brief.build_brief(now=NOW)['content']['description']

    assert description.splitlines()[-1] == 'Window: 24h to 13:00 UTC.'


def test_an_unreadable_manifest_still_produces_a_brief(brief, monkeypatch):
    """Degrading to a thinner brief beats degrading to silence.

    The manifest lives in Parameter Store because it outgrew the 4KB Lambda
    environment limit. If that read fails, the components cannot be listed,
    but a firing alarm still must reach someone: no news is the exact outcome
    this whole thing exists to remove.
    """
    def explode(**kwargs):
        raise RuntimeError('Parameter Store unavailable')

    brief.ssm = type('S', (), {'get_parameter': staticmethod(explode)})()
    brief._alarms_now = lambda: [SIGN_IN]

    content = brief.build_brief(now=NOW)['content']

    assert '1 problem(s) need attention' in content['title']
    assert ':rotating_light: Sign-in codes are not being sent (alert active now)' in content['description']


def test_the_manifest_is_read_from_the_configured_parameter(brief):
    """And from nowhere else: it is environment-scoped."""
    asked = []
    brief.ssm = type('S', (), {
        'get_parameter': staticmethod(
            lambda **kw: asked.append(kw['Name']) or {'Parameter': {'Value': json.dumps(COMPONENTS)}}),
    })()
    brief._totals = lambda comps, start, end: {i: [1, 0] for i in range(len(comps))}
    brief._alarms_now = lambda: []

    brief.build_brief(now=NOW)

    assert asked == ['/a-iep/prod/daily-brief/components']


def test_an_unreadable_manifest_is_never_reported_as_all_green(brief):
    """The failure this was found by: nothing firing, nothing measured.

    With an empty manifest and no alarms, the brief used to publish
    "all green (0 ran, 0 idle)". Every word of that is true and the message is
    false: it had measured nothing at all. A reassurance from a check that did
    not run is worse than no brief, because it tells someone to stop looking.
    """
    _stub(brief, {}, components=[], manifest_unreadable=True)

    content = brief.build_brief(now=NOW)['content']

    assert 'all green' not in content['title']
    assert content['title'] == ':warning: A-IEP daily brief — 2026-09-10 — could not read what it is meant to check · prod'
    # And it says which way it is broken, so the reader knows the components
    # are missing rather than healthy.
    assert 'nothing below was measured' in content['description']
