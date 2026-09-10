"""The daily brief is the answer to "is anything still happening".

Alarms only fire when something errors, so a component that stops being
invoked at all keeps every alarm green while doing nothing. These tests pin
the three properties that make the brief worth reading: it distinguishes idle
from broken, it cannot claim green while an alarm is firing, and it says what
each component is for so a reader can judge "0 runs" for themselves.
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


def _stub(module, totals, firing=(), components=None):
    """totals: {functionName: (invocations, errors)}."""
    module._components = lambda: list(COMPONENTS if components is None else components)
    module._totals = lambda comps, start, end: {
        i: list(totals.get(c['functionName'], (0, 0))) for i, c in enumerate(comps)
    }
    module._alarms_now = lambda: list(firing)


NOW = datetime.datetime(2026, 9, 10, 13, 0, tzinfo=datetime.timezone.utc)


def test_all_green_counts_what_ran_and_what_was_idle(brief):
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 0)})

    content = brief.build_brief(now=NOW)['content']

    assert content['title'].startswith(':white_check_mark:')
    assert 'all green (2 ran, 1 idle)' in content['title']
    assert '2026-09-10' in content['title']


def test_an_idle_component_is_not_reported_as_a_problem(brief):
    """Several of these only run when a parent acts, so 0 is often correct."""
    _stub(brief, {})

    content = brief.build_brief(now=NOW)['content']

    assert ':rotating_light:' not in content['description']
    assert content['description'].count(':zzz:') == 3
    assert 'all green (0 ran, 3 idle)' in content['title']


def test_errors_are_counted_as_problems_and_listed_first(brief):
    """A reader on a phone must not scroll past green lines to find the red."""
    _stub(brief, {'fn-ocr': (4, 0), 'fn-tts': (11, 2), 'fn-ref': (1, 0)})

    content = brief.build_brief(now=NOW)['content']
    lines = content['description'].splitlines()

    assert content['title'].startswith(':warning:')
    assert '1 problem(s)' in content['title']
    assert lines[0].startswith(':rotating_light: TTS')
    assert '11 runs, 2 errors' in lines[0]


def test_a_firing_alarm_prevents_an_all_green_claim(brief):
    """The worst failure this could have is saying green over a live outage."""
    _stub(brief, {'fn-ocr': (4, 0)}, firing=['a-iep login codes are not being delivered'])

    content = brief.build_brief(now=NOW)['content']

    assert 'all green' not in content['title']
    assert '1 problem(s)' in content['title']
    # Named, not counted: a count sends someone to a console to find out which.
    assert 'a-iep login codes are not being delivered' in content['description']


def test_every_line_says_what_the_component_is_for(brief):
    """Without it, "0 runs" is unreadable and a green line is decoration."""
    _stub(brief, {'fn-ocr': (4, 0)})

    description = brief.build_brief(now=NOW)['content']['description']

    for component in COMPONENTS:
        assert component['purpose'] in description


def test_the_brief_carries_no_content_only_names_and_counts(brief):
    """FERPA: nothing here may come from a document, log or request body."""
    _stub(brief, {'fn-ocr': (4, 1)}, firing=['a-iep something'])

    blob = json.dumps(brief.build_brief(now=NOW))

    # Everything present is a label, a purpose, a count, a date or an icon.
    for component in COMPONENTS:
        assert component['label'] in blob
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
    brief._alarms_now = lambda: ['a-iep login codes are not being delivered']

    content = brief.build_brief(now=NOW)['content']

    assert '1 problem(s)' in content['title']
    assert 'a-iep login codes are not being delivered' in content['description']


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
