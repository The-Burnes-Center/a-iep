"""The daily brief is the answer to "is anything still happening".

Alarms only fire when something errors, so a component that stops being
invoked at all keeps every alarm green while doing nothing. These tests pin
the properties that make the brief worth reading: it distinguishes idle from
broken, it cannot claim "no problems" while an alarm is firing or while it
could not read what to check, and it says what an idle component is for so a
reader can judge "0 runs" for themselves. It follows the same shape as every
alert: environment and severity first, as words.
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


def test_no_problems_leads_with_environment_and_severity_as_words(brief):
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 0)})

    content = brief.build_brief(now=NOW)['content']

    assert content['title'] == '[PROD] [INFO] Daily health check: no problems in the last 24 hours'
    # Words, not icons: the title must read in a push preview and a screen reader.
    assert ':' not in content['title'].split(']')[0]
    assert 'problem(s)' not in content['title']


def test_healthy_components_are_counted_not_listed(brief):
    """A reader on a phone must not pass twenty green lines to reach the red."""
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 0)})

    description = brief.build_brief(now=NOW)['content']['description']

    assert '*Ran normally:* 2 components, no errors.' in description
    assert 'Mistral OCR' not in description


def test_an_idle_component_is_listed_with_its_purpose_and_is_not_a_problem(brief):
    """Several only run when a parent acts, so 0 is often correct.

    It is listed with what it is for because "0 runs" cannot be judged without
    knowing whether the thing was meant to run.
    """
    _stub(brief, {'fn-ocr': (4, 0)})

    content = brief.build_brief(now=NOW)['content']

    assert '[INFO]' in content['title']
    assert '\u2022 TTS: reads a summary aloud' in content['description']
    assert '\u2022 referrals: invite links' in content['description']
    assert '*Needs attention*' not in content['description']


def test_errors_are_a_problem_and_listed_first_with_their_counts(brief):
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 2), 'fn-ref': (1, 0)})

    content = brief.build_brief(now=NOW)['content']
    lines = content['description'].splitlines()

    assert content['title'] == '[PROD] [WARNING] Daily health check: 1 problem needs attention'
    assert lines[0] == '*Needs attention*'
    assert lines[1] == '\u2022 TTS: 2 errors in 11 runs (reads a summary aloud)'


def test_the_problem_count_is_plural_when_it_should_be(brief):
    _stub(brief, {'fn-tts': (11, 2), 'fn-ref': (1, 1)}, firing=[SIGN_IN])

    assert '3 problems need attention' in brief.build_brief(now=NOW)['content']['title']


def test_a_firing_alarm_prevents_a_no_problems_claim(brief):
    """The worst failure this could have is saying all is well over a live outage."""
    _stub(brief, {'fn-ocr': (4, 0)}, firing=[SIGN_IN])

    content = brief.build_brief(now=NOW)['content']

    assert 'no problems' not in content['title']
    assert '1 problem needs attention' in content['title']
    # Named by its headline, not counted and not a CloudWatch alarm name.
    assert '\u2022 [CRITICAL] Sign-in codes are not being sent (alert active now)' in content['description']


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
    monkeypatch.setattr(brief, 'ENV_LABEL', 'STAGING')
    _stub(brief, {'fn-ocr': (4, 0)})

    title = brief.build_brief(now=NOW)['content']['title']

    assert title.startswith('[STAGING] [INFO] Daily health check')


def test_the_checked_line_says_what_was_covered(brief):
    _stub(brief, {'fn-ocr': (4, 0)})

    description = brief.build_brief(now=NOW)['content']['description']

    assert 'Checked 3 components for the 24 hours to 13:00 UTC on 10 Sep 2026.' in description


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

    assert '1 problem needs attention' in content['title']
    assert 'Sign-in codes are not being sent' in content['description']


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


def test_an_unreadable_manifest_is_never_reported_as_no_problems(brief):
    """The failure this was found by: nothing firing, nothing measured.

    With an empty manifest and no alarms, the brief used to publish
    "all green (0 ran, 0 idle)". Every word of that is true and the message is
    false: it had measured nothing at all. A reassurance from a check that did
    not run is worse than no brief, because it tells someone to stop looking.
    """
    _stub(brief, {}, components=[], manifest_unreadable=True)

    content = brief.build_brief(now=NOW)['content']

    assert 'no problems' not in content['title']
    assert content['title'] == '[PROD] [WARNING] Daily health check: could not read what it is meant to check'
    # And it says which way it is broken, so the reader knows the components
    # are missing rather than healthy.
    assert 'nothing below was measured' in content['description']
