"""The alert formatter: what a person actually reads in Slack.

These assert the MESSAGE, not the plumbing. AWS Chatbot's own alarm card
delivers reliably; it just says "Threshold Crossed: 1 datapoint [4.0] was
greater than or equal to the threshold (2.0)" under a heading containing the
account id. The formatter replaces it with one fixed shape:

    [PROD] [CRITICAL] Sign-in codes are not being sent
    What is happening / Who is affected / Started, then next steps.

The words come from each alarm's description, written by
lib/chatbot-api/monitoring/alert-copy.ts. The last section of this file runs
EVERY real description from both synthesized stacks (test/fixtures, written by
test/infra/alert-copy.test.ts) through the formatter, so the two languages
cannot drift apart.

Findings from testing against the real Slack channel that are pinned here
because nothing else would catch their loss:

  - metadata.additionalContext renders NOTHING. Chatbot accepts it and drops
    it silently, so every fact has to live in the description or nextSteps.
  - A custom notification gets no timestamp from Chatbot, so the start time
    has to be in the message.
"""
import datetime
import json
import os

import pytest
from moto import mock_aws

from conftest import REPO_ROOT, load_lambda_module, unload

ALERT_TOPIC = 'arn:aws:sns:us-east-1:123456789012:a-iep-alerts-staging'
ALIAS = 'alert_formatter_under_test'
FIXTURE = os.path.join(REPO_ROOT, 'test', 'fixtures', 'alarm-descriptions.json')

RUNBOOK = 'https://github.com/The-Burnes-Center/a-iep/blob/staging/docs/RUNBOOK.md#documents-are-failing-to-process'
PROD_RUNBOOK = 'https://github.com/The-Burnes-Center/a-iep/blob/main/docs/RUNBOOK.md#sign-in-codes-are-not-arriving'


def _description(environment='STAGING', severity='WARNING',
                 symptom='Uploaded documents are failing at the text extraction step',
                 impact='Staging only. No real families are affected.',
                 fires='at least 5 errors in 5 minutes',
                 steps=('Open the logs for this pipeline step and read the latest error.',
                        'Check the status page of the outside provider.'),
                 runbook=RUNBOOK, recovery=None):
    lines = [
        f'[{environment}] [{severity}] {symptom}',
        f'Impact: {impact}',
        f'Fires when: {fires}.',
        'Check first:',
        *[f'{i}. {step}' for i, step in enumerate(steps, 1)],
        f'Runbook: {runbook}',
    ]
    if recovery:
        lines.append(f'Recovery: {recovery}')
    return '\n'.join(lines)


def _alarm(**overrides):
    """A CloudWatch alarm SNS payload, in the shape AWS actually sends."""
    alarm = {
        'AlarmName': 'a-iep-staging pipeline step failing: Mistral OCR',
        'AlarmDescription': _description(),
        'NewStateValue': 'ALARM',
        # CloudWatch always sends this. A fixture that omits a field AWS always
        # sends is how a rule keyed on that field goes untested.
        'OldStateValue': 'OK',
        'NewStateReason': 'Threshold Crossed: 1 datapoint [8.0 (08/09/26 18:14:00)] '
                          'was greater than or equal to the threshold (5.0).',
        'StateChangeTime': '2026-09-08T18:19:58.123+0000',
        'Trigger': {
            'Namespace': 'AWS/Lambda',
            'MetricName': 'Errors',
            'Threshold': 5.0,
            'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
            'Period': 300,
            'EvaluationPeriods': 1,
            'Dimensions': [{'name': 'FunctionName',
                            'value': 'AIEPStagingStack-MistralOCRFunc-XyZ'}],
        },
    }
    alarm.update(overrides)
    return alarm


def _prod_critical(**overrides):
    """A prod CRITICAL alarm, the only kind whose resolution reaches Slack."""
    fields = dict(
        AlarmName='a-iep login codes are not being sent',
        AlarmDescription=_description(
            environment='PROD', severity='CRITICAL',
            symptom='Sign-in codes are not being sent',
            impact='Parents ask for a sign-in code, none arrives, and they cannot get into the app.',
            fires='at least 3 failed code sends in 5 minutes',
            steps=('Open the sign-in code sender logs and search for AUTH_DISPATCH_FAILED.',),
            runbook=PROD_RUNBOOK,
            recovery='Sign-in codes are being sent again'),
        NewStateReason='Threshold Crossed: 1 datapoint [4.0 (08/09/26 18:14:00)] '
                       'was greater than or equal to the threshold (3.0).',
        Trigger={'Namespace': 'AI-IEP/Auth', 'MetricName': 'AuthDispatchFailed',
                 'Threshold': 3.0, 'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
                 'Period': 300, 'EvaluationPeriods': 1, 'Dimensions': []},
    )
    fields.update(overrides)
    return _alarm(**fields)


def _cleared(alarm_factory=_prod_critical, **overrides):
    return alarm_factory(NewStateValue='OK', OldStateValue='ALARM',
                         StateChangeTime='2026-09-08T18:32:10.000+0000', **overrides)


class _Topic:
    """Records what the formatter publishes, so tests read the actual message."""

    def __init__(self):
        self.messages = []

    def publish(self, **kwargs):
        self.messages.append(kwargs)

    def notifications(self):
        return [json.loads(m['Message']) for m in self.messages]


class _History:
    """A CloudWatch client whose alarm history is whatever the test says."""

    def __init__(self, items=None, error=None):
        self.items = items or []
        self.error = error

    def describe_alarm_history(self, **kwargs):
        if self.error:
            raise self.error
        assert kwargs['HistoryItemType'] == 'StateUpdate'
        return {'AlarmHistoryItems': self.items}


def _went_into_alarm_at(timestamp):
    return {'Timestamp': timestamp, 'HistorySummary': 'Alarm updated from OK to ALARM'}


def _event(*alarms):
    return {'Records': [{'Sns': {'Message': json.dumps(a)}} for a in alarms]}


@pytest.fixture
def formatter(monkeypatch):
    monkeypatch.setenv('ALERT_TOPIC_ARN', ALERT_TOPIC)
    monkeypatch.setenv('ENVIRONMENT', 'staging')
    with mock_aws():
        module = load_lambda_module('alert-formatter', ALIAS, module_name='handler')
        module.sns = _Topic()
        module.cloudwatch = _History()
        yield module
    unload(ALIAS)


@pytest.fixture
def prod_formatter(monkeypatch):
    monkeypatch.setenv('ALERT_TOPIC_ARN', ALERT_TOPIC)
    monkeypatch.setenv('ENVIRONMENT', 'prod')
    with mock_aws():
        module = load_lambda_module('alert-formatter', ALIAS + '_prod', module_name='handler')
        module.sns = _Topic()
        module.cloudwatch = _History()
        yield module
    unload(ALIAS + '_prod')


# ---------------------------------------------------------------------------
# The title: environment and severity first, then what is wrong.
# ---------------------------------------------------------------------------

def test_the_title_leads_with_environment_and_severity_as_words(formatter, prod_formatter):
    staging = formatter.build_notification(_alarm())['content']['title']
    prod = prod_formatter.build_notification(_prod_critical())['content']['title']

    assert staging == '[STAGING] [WARNING] Uploaded documents are failing at the text extraction step'
    assert prod == '[PROD] [CRITICAL] Sign-in codes are not being sent'


def test_the_title_has_no_cloudformation_name_and_no_colour_only_signal(formatter):
    title = formatter.build_notification(_alarm())['content']['title']

    assert 'a-iep-staging' not in title
    # Severity is words. A colour or an icon alone fails a screen reader, a
    # push preview and a plain-text export.
    assert ':' not in title.split(']')[0]
    for icon in (':red_circle:', ':large_yellow_circle:', ':white_check_mark:', ':warning:'):
        assert icon not in title


def test_the_push_preview_is_the_title(formatter):
    notification = formatter.build_notification(_alarm())

    # The mobile push preview has to stand alone, so it is the whole title.
    assert notification['metadata']['summary'] == notification['content']['title']


def test_no_alert_ever_tags_the_channel(formatter, prod_formatter):
    """No @channel, @here or any all-member mention, in either environment.

    Whether an alert pushes to a phone is the channel's notification setting,
    which belongs to the person receiving it.
    """
    for fmt, alarms in ((formatter, (_alarm(), _cleared(_alarm))),
                        (prod_formatter, (_prod_critical(), _cleared()))):
        for alarm in alarms:
            blob = json.dumps(fmt.build_notification(alarm))
            for mention in ('<!channel>', '<!here>', '@channel', '@here', '@everyone'):
                assert mention not in blob


# ---------------------------------------------------------------------------
# The body: what is happening, who is affected, since when.
# ---------------------------------------------------------------------------

def test_the_body_says_what_is_happening_who_is_affected_and_since_when(prod_formatter):
    body = prod_formatter.build_notification(_prod_critical())['content']['description']

    assert body.splitlines() == [
        '*What is happening:* Alert condition met: at least 3 failed code sends in 5 minutes '
        '(latest reading: 4).',
        '*Who is affected:* Parents ask for a sign-in code, none arrives, and they cannot '
        'get into the app.',
        '*Started:* 8 Sep 2026, 18:19 UTC',
    ]


def test_staging_says_no_real_family_is_affected(formatter):
    body = formatter.build_notification(_alarm())['content']['description']

    assert '*Who is affected:* Staging only. No real families are affected.' in body


def test_a_threshold_that_is_not_a_count_gets_no_reading_beside_it(prod_formatter):
    """"latest reading: 590" next to "SMS spend above $2 an hour" would be nonsense."""
    alarm = _prod_critical(
        AlarmDescription=_description(
            environment='PROD', severity='CRITICAL', symptom='SMS spending is climbing unusually fast',
            impact='No one yet.', fires='SMS spend above $2 an hour', runbook=PROD_RUNBOOK))
    body = prod_formatter.build_notification(alarm)['content']['description']

    assert 'Alert condition met: SMS spend above $2 an hour.' in body
    assert 'latest reading' not in body


def test_a_missing_timestamp_does_not_break_the_alert(formatter):
    body = formatter.build_notification(_alarm(StateChangeTime=''))['content']['description']

    assert 'Started' not in body
    assert '*What is happening:*' in body


def test_the_facts_are_in_the_description_never_in_additional_context(formatter):
    notification = formatter.build_notification(_alarm())

    # Chatbot renders additionalContext as nothing at all, which is how the
    # resource and the start time went missing the first time.
    assert 'additionalContext' not in notification['metadata']
    assert '8 Sep 2026, 18:19 UTC' in notification['content']['description']


# ---------------------------------------------------------------------------
# What to do next: the steps, the runbook, the logs, the alarm.
# ---------------------------------------------------------------------------

def test_next_steps_are_the_checks_then_runbook_logs_and_alarm(formatter):
    steps = formatter.build_notification(_alarm())['content']['nextSteps']

    assert steps[0] == 'Open the logs for this pipeline step and read the latest error.'
    assert steps[1] == 'Check the status page of the outside provider.'
    assert steps[2] == f'<{RUNBOOK}|Open the runbook>'
    assert steps[3].startswith('<https://console.aws.amazon.com/cloudwatch/home?region=')
    assert 'logsV2:log-groups' in steps[3] and steps[3].endswith('|Open the logs>')
    alarm_link = steps[4]
    assert 'alarmsV2:alarm/a-iep-staging%20pipeline%20step%20failing%3A%20Mistral%20OCR' in alarm_link
    assert alarm_link.endswith('|Open the alarm in CloudWatch>')


def test_a_generated_function_name_is_in_a_link_never_in_visible_text(formatter):
    notification = formatter.build_notification(_alarm())
    visible = notification['content']['title'] + notification['content']['description']
    labels = [step.split('|')[-1] for step in notification['content']['nextSteps']]

    assert 'AIEPStagingStack' not in visible
    assert not any('AIEPStagingStack' in label for label in labels)


@pytest.mark.parametrize('dimension,expected,label', [
    ({'name': 'TableName', 'value': 'iep-documents'}, 'dynamodbv2', 'Open the table metrics'),
    ({'name': 'RuleName', 'value': 'sweep-rule'}, 'events', 'Open the schedule'),
    ({'name': 'ApiId', 'value': 'abc123'}, 'apigateway', 'Open the API logs'),
])
def test_each_resource_type_links_somewhere_useful(formatter, dimension, expected, label):
    alarm = _alarm(Trigger={'MetricName': 'Errors', 'Period': 300, 'Dimensions': [dimension]})
    steps = formatter.build_notification(alarm)['content']['nextSteps']

    link = next(s for s in steps if s.endswith(f'|{label}>'))
    assert expected in link


def test_an_alarm_with_no_resource_still_links_the_runbook_and_the_alarm(formatter):
    """Marker-based alarms carry no dimensions: no link beats a broken one."""
    alarm = _alarm(Trigger={'MetricName': 'DocumentFailures', 'Period': 900, 'Dimensions': []})
    steps = formatter.build_notification(alarm)['content']['nextSteps']

    assert any(s.endswith('|Open the runbook>') for s in steps)
    assert any(s.endswith('|Open the alarm in CloudWatch>') for s in steps)
    assert not any('logsV2' in s for s in steps)


# ---------------------------------------------------------------------------
# An alarm nobody wrote copy for still produces an alert.
# ---------------------------------------------------------------------------

def test_an_alarm_without_written_guidance_is_still_an_alert(prod_formatter):
    """Swallowing an alert is the one failure this function must never have."""
    alarm = _alarm(AlarmName='a-iep something new broke', AlarmDescription='No shape on this one.')
    content = prod_formatter.build_notification(alarm)['content']

    assert content['title'] == '[PROD] [WARNING] Something new broke'
    assert 'no written guidance' in content['description']
    assert any(s.endswith('|Open the alarm in CloudWatch>') for s in content['nextSteps'])


def test_the_old_marker_format_is_treated_as_unwritten_not_shown(prod_formatter):
    alarm = _alarm(AlarmDescription='[medium] Documents are failing.')
    content = prod_formatter.build_notification(alarm)['content']

    # The marker was plumbing; it must not reach a reader.
    assert '[medium]' not in json.dumps(content)


# ---------------------------------------------------------------------------
# Resolution: short, only where it is news, and honest.
# ---------------------------------------------------------------------------

def test_a_prod_critical_resolution_says_what_is_true_now_and_how_long_it_lasted(prod_formatter):
    prod_formatter.cloudwatch = _History([_went_into_alarm_at(
        datetime.datetime(2026, 9, 8, 18, 20, tzinfo=datetime.timezone.utc))])

    content = prod_formatter.build_notification(_cleared())['content']

    assert content['title'] == '[PROD] Resolved: Sign-in codes are being sent again (alert lasted 12 minutes)'
    assert content['description'] == 'The alert cleared at 8 Sep 2026, 18:32 UTC. No action needed.'
    # Next steps on a resolution imply work that is already done.
    assert 'nextSteps' not in content


def test_the_duration_comes_from_the_most_recent_move_into_alarm(prod_formatter):
    stamp = lambda minute: datetime.datetime(2026, 9, 8, 18, minute, tzinfo=datetime.timezone.utc)
    prod_formatter.cloudwatch = _History([
        {'Timestamp': stamp(31), 'HistorySummary': 'Alarm updated from ALARM to OK'},
        _went_into_alarm_at(stamp(27)),
        _went_into_alarm_at(stamp(2)),
    ])

    title = prod_formatter.build_notification(_cleared())['content']['title']

    assert title.endswith('(alert lasted 5 minutes)')


def test_a_failed_history_lookup_loses_the_duration_not_the_resolution(prod_formatter, capsys):
    prod_formatter.cloudwatch = _History(error=RuntimeError('AccessDenied'))

    content = prod_formatter.build_notification(_cleared())['content']

    assert content['title'] == '[PROD] Resolved: Sign-in codes are being sent again'
    # Never a silent swallow: the cause is in the log.
    assert 'ALARM_DURATION_UNAVAILABLE RuntimeError' in capsys.readouterr().out


def test_a_failure_count_going_quiet_is_not_called_resolved(prod_formatter):
    """A delivery alarm clears 15 minutes after the last dropped code.

    That says nothing about whether codes are arriving: nobody may have tried.
    "Resolved" read as "fixed", so these say only what is known.
    """
    alarm = _cleared(
        AlarmDescription=_description(
            environment='PROD', severity='CRITICAL', symptom='Texting a sign-in code is failing',
            impact='Parents get no code.', fires='at least 1 failed texts in 5 minutes',
            runbook=PROD_RUNBOOK, recovery='quiet'),
        Trigger={'MetricName': 'SmsSendFailed', 'Period': 300, 'EvaluationPeriods': 3,
                 'Dimensions': []},
    )

    content = prod_formatter.build_notification(alarm)['content']

    assert content['title'] == '[PROD] Quiet: Texting a sign-in code is failing (no new failures for 15 minutes)'
    assert 'does not confirm the cause is fixed' in content['description']
    for claim in ('Resolved', 'No action needed', 'fixed again'):
        assert claim not in content['title']
    assert 'nextSteps' not in content


def test_a_quiet_alarm_with_no_period_claims_no_window(prod_formatter):
    """Metric-math alarms carry no top-level Period: say less, not wrong."""
    alarm = _cleared(
        AlarmDescription=_description(environment='PROD', severity='CRITICAL', recovery='quiet',
                                      runbook=PROD_RUNBOOK),
        Trigger={'MetricName': 'X', 'Dimensions': []},
    )

    title = prod_formatter.build_notification(alarm)['content']['title']

    assert title.endswith('(no new failures)')
    assert 'minutes' not in title


# ---------------------------------------------------------------------------
# What reaches Slack at all.
# ---------------------------------------------------------------------------

def test_every_alarm_state_posts_in_both_environments(formatter, prod_formatter):
    formatter.lambda_handler(_event(_alarm()), None)
    prod_formatter.lambda_handler(_event(_prod_critical()), None)

    assert len(formatter.sns.messages) == 1
    assert len(prod_formatter.sns.messages) == 1


def test_only_a_prod_critical_alarm_posts_a_resolution(prod_formatter):
    prod_formatter.lambda_handler(_event(_cleared()), None)

    titles = [n['content']['title'] for n in prod_formatter.sns.notifications()]
    assert titles == ['[PROD] Resolved: Sign-in codes are being sent again']


@pytest.mark.parametrize('severity', ['WARNING', 'INFO'])
def test_a_prod_warning_or_info_resolution_is_not_posted(prod_formatter, severity):
    alarm = _cleared(AlarmDescription=_description(
        environment='PROD', severity=severity, runbook=PROD_RUNBOOK))

    result = prod_formatter.lambda_handler(_event(alarm), None)

    assert json.loads(result['body'])['published'] == 0
    assert prod_formatter.sns.messages == []


def test_a_staging_resolution_is_never_posted(formatter):
    result = formatter.lambda_handler(_event(_cleared(_alarm)), None)

    assert json.loads(result['body'])['published'] == 0
    assert formatter.sns.messages == []


def test_an_unwritten_alarms_resolution_is_not_posted(prod_formatter):
    """It cannot be known to be critical."""
    alarm = _alarm(AlarmDescription='no shape', NewStateValue='OK', OldStateValue='ALARM')

    assert json.loads(prod_formatter.lambda_handler(_event(alarm), None)['body'])['published'] == 0


def test_an_alarm_coming_online_is_not_announced_as_a_recovery(prod_formatter):
    """A new alarm goes INSUFFICIENT_DATA -> OK the moment it has data.

    The OK action fires, so a deploy would announce a resolution for problems
    that never happened. Nothing was wrong, so there is no news, and the
    message is dropped rather than reworded. This is what makes recreating an
    alarm on deploy silent.
    """
    alarm = _prod_critical(NewStateValue='OK', OldStateValue='INSUFFICIENT_DATA')

    result = prod_formatter.lambda_handler(_event(alarm), None)

    assert json.loads(result['body'])['published'] == 0
    assert prod_formatter.sns.messages == []


def test_a_new_alarm_that_starts_in_alarm_is_still_announced(prod_formatter):
    """The suppression must not swallow a real breach on a freshly created alarm."""
    alarm = _prod_critical(OldStateValue='INSUFFICIENT_DATA')

    assert json.loads(prod_formatter.lambda_handler(_event(alarm), None)['body'])['published'] == 1


# ---------------------------------------------------------------------------
# Threading and payload shape.
# ---------------------------------------------------------------------------

def test_the_same_alarm_threads_instead_of_filling_the_channel(prod_formatter):
    first = prod_formatter.build_notification(_prod_critical())
    resolved = prod_formatter.build_notification(_cleared())

    # Same thread for the same alarm, so an alert and its resolution are one
    # conversation.
    assert first['metadata']['threadId'] == resolved['metadata']['threadId']
    assert len(first['metadata']['threadId']) <= 64

    other = prod_formatter.build_notification(_prod_critical(AlarmName='a-iep API returning 5xx'))
    assert other['metadata']['threadId'] != first['metadata']['threadId']


def test_prod_and_staging_never_share_a_thread(formatter, prod_formatter):
    same_alarm_name = 'login codes are not being sent'
    staging = formatter.build_notification(_alarm(AlarmName=f'a-iep-staging {same_alarm_name}'))
    prod = prod_formatter.build_notification(_prod_critical(AlarmName=f'a-iep {same_alarm_name}'))

    assert staging['metadata']['threadId'] != prod['metadata']['threadId']


def test_the_payload_is_the_shape_chatbot_renders(formatter):
    notification = formatter.build_notification(_alarm())

    # Without source: "custom" Chatbot ignores the whole thing and renders
    # nothing, so this is the single most load-bearing field.
    assert notification['source'] == 'custom'
    assert notification['version'] == '1.0'
    assert notification['content']['textType'] == 'client-markdown'


# ---------------------------------------------------------------------------
# Never swallow an alert.
# ---------------------------------------------------------------------------

def test_an_alarm_is_forwarded_to_the_alert_topic(formatter):
    result = formatter.lambda_handler(_event(_alarm()), None)

    assert json.loads(result['body'])['published'] == 1
    assert formatter.sns.messages[0]['TopicArn'] == ALERT_TOPIC


def test_a_message_that_is_not_an_alarm_is_passed_through_not_dropped(formatter):
    # A hand-published custom notification, or anything else on the topic.
    for message in ['not json at all', json.dumps({'hello': 'world'})]:
        result = formatter.lambda_handler({'Records': [{'Sns': {'Message': message}}]}, None)
        assert json.loads(result['body'])['published'] == 1
    assert [m['Message'] for m in formatter.sns.messages] == [
        'not json at all', json.dumps({'hello': 'world'})]


def test_every_record_in_a_batch_is_handled(prod_formatter):
    event = {'Records': [
        {'Sns': {'Message': json.dumps(_prod_critical())}},
        {'Sns': {'Message': json.dumps(_cleared())}},
        {'Sns': {'Message': 'junk'}},
    ]}

    assert json.loads(prod_formatter.lambda_handler(event, None)['body'])['published'] == 3


# ---------------------------------------------------------------------------
# The contract with alert-copy.ts: every real description, both environments.
# ---------------------------------------------------------------------------

def _fixture():
    with open(FIXTURE) as handle:
        data = json.load(handle)
    return [(env, row) for env in ('production', 'staging') for row in data[env]]


def _real_alarm(row, state='ALARM'):
    return {
        'AlarmName': row['AlarmName'],
        'AlarmDescription': row['AlarmDescription'],
        'NewStateValue': state,
        'OldStateValue': 'OK' if state == 'ALARM' else 'ALARM',
        'NewStateReason': 'Threshold Crossed: 1 datapoint [7.0 (08/09/26 18:14:00)] '
                          'was greater than or equal to the threshold (1.0).',
        'StateChangeTime': '2026-09-08T18:19:58.123+0000',
        'Trigger': {'MetricName': 'Errors', 'Period': 300, 'EvaluationPeriods': 1,
                    'Dimensions': [{'name': 'FunctionName', 'value': 'some-function'}]},
    }


def test_the_fixture_is_not_empty():
    rows = _fixture()
    # A fixture that quietly held nothing would pass every test below.
    assert len([r for e, r in rows if e == 'production']) > 80
    assert len([r for e, r in rows if e == 'staging']) > 80


def test_the_formatter_understands_every_real_description(prod_formatter):
    for env, row in _fixture():
        parsed = prod_formatter.parse_description(row['AlarmDescription'])
        first_line = row['AlarmDescription'].split('\n')[0]
        assert parsed is not None, row['AlarmName']
        assert first_line == f"[{parsed['environment']}] [{parsed['severity']}] {parsed['symptom']}"
        assert parsed['environment'] == ('PROD' if env == 'production' else 'STAGING')
        assert parsed['impact'], row['AlarmName']
        assert parsed['fires'], row['AlarmName']
        assert 1 <= len(parsed['check']) <= 2, row['AlarmName']
        assert parsed['runbook'].startswith('https://github.com/The-Burnes-Center/a-iep/blob/'), row['AlarmName']


def test_every_real_alert_formats_to_the_same_shape(prod_formatter):
    for env, row in _fixture():
        content = prod_formatter.build_notification(_real_alarm(row))['content']
        label = 'PROD' if env == 'production' else 'STAGING'

        assert content['title'].startswith(f'[{label}] ['), row['AlarmName']
        assert content['title'] == row['AlarmDescription'].split('\n')[0], row['AlarmName']
        assert 'Who is affected' in content['description'], row['AlarmName']
        assert 'no written guidance' not in content['description'], row['AlarmName']
        assert len(content['nextSteps']) >= 3, row['AlarmName']
        # No generated id, no engineering label, no token in anything visible.
        visible = content['title'] + content['description']
        for leak in ('AIEPStack', 'AIEPStagingStack', '${Token', 'Ref'):
            assert leak not in visible, (row['AlarmName'], leak)


def test_every_prod_critical_alarm_resolves_with_its_own_words(prod_formatter):
    resolved = 0
    for env, row in _fixture():
        if env != 'production' or not row['AlarmDescription'].startswith('[PROD] [CRITICAL]'):
            continue
        parsed = prod_formatter.parse_description(row['AlarmDescription'])
        title = prod_formatter.build_notification(_real_alarm(row, 'OK'))['content']['title']
        if parsed['recovery'] == 'quiet':
            assert title.startswith('[PROD] Quiet: '), row['AlarmName']
        else:
            assert title.startswith(f"[PROD] Resolved: {parsed['recovery']}"), row['AlarmName']
        resolved += 1
    assert resolved > 20


def test_no_staging_alert_reads_as_critical(prod_formatter):
    for env, row in _fixture():
        if env == 'staging':
            title = prod_formatter.build_notification(_real_alarm(row))['content']['title']
            assert '[CRITICAL]' not in title, row['AlarmName']
