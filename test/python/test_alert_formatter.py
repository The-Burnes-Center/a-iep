"""The alert formatter: what a person actually reads in Slack.

These assert the MESSAGE, not the plumbing, because the plumbing was never
the problem. AWS Chatbot's own alarm card already delivers reliably; it just
says "Threshold Crossed: 1 datapoint [4.0] was greater than or equal to the
threshold (2.0)" under a heading containing the account id, and truncates the
description around 250 characters.

Two findings from testing this against the real Slack channel are pinned here
because nothing else would catch their loss:

  - metadata.additionalContext renders NOTHING. Chatbot accepts it and drops
    it silently, so the resource and timestamp have to live in the description.
    A refactor that "tidies" them back into fields would make them invisible
    while every test about their content still passed.
  - The observed value is meaningless without its unit and window. "8" was
    genuinely unreadable; "8 errors in 5 min" is not.
"""
import json

import pytest
from moto import mock_aws

from conftest import load_lambda_module, unload

ALERT_TOPIC = 'arn:aws:sns:us-east-1:123456789012:a-iep-alerts-staging'
ALIAS = 'alert_formatter_under_test'


def _alarm(**overrides):
    """A CloudWatch alarm SNS payload, in the shape AWS actually sends."""
    alarm = {
        'AlarmName': 'a-iep-staging pipeline step failing: Mistral OCR',
        # MonitoringStack prefixes every description with its tier; the
        # formatter strips it. A fixture without one would not exercise that.
        'AlarmDescription': '[medium] Documents are failing at the Mistral OCR step, '
                            'so every upload reaching this stage is affected.',
        'NewStateValue': 'ALARM',
        # CloudWatch always sends this. It was missing here, and a fixture
        # that omits a field AWS always sends is how a rule keyed on that
        # field goes untested.
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
            'Dimensions': [{'name': 'FunctionName',
                            'value': 'AIEPStagingStack-MistralOCRFunc-XyZ'}],
        },
    }
    alarm.update(overrides)
    return alarm


@pytest.fixture
def formatter(monkeypatch):
    monkeypatch.setenv('ALERT_TOPIC_ARN', ALERT_TOPIC)
    monkeypatch.setenv('ENVIRONMENT', 'staging')
    with mock_aws():
        module = load_lambda_module('alert-formatter', ALIAS, module_name='handler')
        yield module
    unload(ALIAS)


@pytest.fixture
def prod_formatter(monkeypatch):
    monkeypatch.setenv('ALERT_TOPIC_ARN', ALERT_TOPIC)
    monkeypatch.setenv('ENVIRONMENT', 'prod')
    with mock_aws():
        module = load_lambda_module('alert-formatter', ALIAS + '_prod', module_name='handler')
        yield module
    unload(ALIAS + '_prod')


# ---------------------------------------------------------------------------
# The headline: is this real, and what broke.
# ---------------------------------------------------------------------------

def test_the_headline_says_what_broke_and_where(formatter):
    content = formatter.build_notification(_alarm())['content']

    assert 'pipeline step failing: Mistral OCR' in content['title']
    # Environment on the headline: "is this real" must not need a click.
    assert 'staging' in content['title']
    # The resource-name prefix is noise in a headline.
    assert 'a-iep-staging ' not in content['title']


def test_no_alert_ever_tags_the_channel(formatter, prod_formatter):
    """No @channel, @here or any all-member mention, in either environment.

    Whether an alert pushes to a phone is the channel's notification setting,
    which belongs to the person receiving it. An alert must not impose that on
    everyone in the room.
    """
    for fmt in (formatter, prod_formatter):
        for alarm in (_alarm(), _alarm(NewStateValue='OK', OldStateValue='ALARM')):
            content = fmt.build_notification(alarm)['content']
            blob = json.dumps(content)
            for mention in ('<!channel>', '<!here>', '@channel', '@here', '@everyone'):
                assert mention not in blob


def test_footer_names_the_environment_and_claims_nothing_else(formatter):
    """The footer states which environment fired, and no impact claim.

    It used to assert that a staging alarm meant nobody was affected. Some
    alarms watch account-scoped metrics, where that is not something the
    environment label can tell you, and a wrong reassurance in an alert is
    worse than no reassurance.
    """
    description = formatter.build_notification(_alarm())['content']['description']

    # The environment detail line, not the alarm prose above it: an alarm
    # description may legitimately say a stage is affected.
    line = next(l for l in description.splitlines() if l.startswith('• environment:'))

    assert line == '• environment: staging'
    assert 'families' not in line
    assert 'affected' not in line


def test_the_body_is_scannable_fields_not_prose(prod_formatter):
    """One fact per line, "• key: value", after the impact sentence.

    Modelled on the InnovateUS cron-monitoring channel, which reads well at
    2am because every alert has the same shape and the facts are in the same
    place every time.
    """
    description = prod_formatter.build_notification(_alarm())['content']['description']
    lines = description.splitlines()

    # Impact sentence first, then a blank line, then only bullets.
    assert lines[0].startswith('Documents are failing')
    assert lines[1] == ''
    assert all(l.startswith('• ') for l in lines[2:])

    keys = [l.split(':')[0].removeprefix('• ') for l in lines[2:]]
    assert keys == ['observed', 'since', 'environment', 'resource', 'trigger']


def test_the_trigger_line_shows_the_bar_that_was_crossed(prod_formatter):
    """A surprising alarm is often a threshold problem, not an outage.

    Without this the reader cannot tell the difference from Slack.
    """
    description = prod_formatter.build_notification(_alarm())['content']['description']

    assert '• trigger: AWS/Lambda Errors >= 5' in description


def test_a_recovery_carries_no_trigger_or_count(prod_formatter):
    """Nothing crossed anything; showing a threshold would imply it had."""
    description = prod_formatter.build_notification(
        _alarm(NewStateValue='OK', OldStateValue='ALARM'),
    )['content']['description']

    assert '• trigger:' not in description
    assert '• observed:' not in description
    assert '• environment: prod' in description


def test_colour_is_severity_not_environment(prod_formatter):
    """Red critical, yellow medium, green low. The tier decides the colour.

    39 alarms previously arrived looking identical, so a total auth outage
    read the same as one throttled write.
    """
    for tier, icon in (('critical', ':red_circle:'),
                       ('medium', ':large_yellow_circle:'),
                       ('low', ':large_green_circle:')):
        title = prod_formatter.build_notification(
            _alarm(AlarmDescription=f'[{tier}] Something happened.'),
        )['content']['title']
        assert icon in title, tier


def test_staging_never_goes_red(formatter):
    """Staging fires the same alarms for broken tests.

    A red that sometimes means "a test broke" is a red nobody trusts at 3am,
    so staging caps at yellow however critical the alarm is.
    """
    title = formatter.build_notification(
        _alarm(AlarmDescription='[critical] Nobody can sign in.'),
    )['content']['title']

    assert ':red_circle:' not in title
    assert ':large_yellow_circle:' in title
    assert 'staging' in title


def test_the_tier_marker_never_reaches_a_reader(prod_formatter):
    """It is plumbing, not prose."""
    content = prod_formatter.build_notification(
        _alarm(AlarmDescription='[critical] Nobody can sign in.'),
    )['content']

    assert content['description'].startswith('Nobody can sign in.')
    for tier in ('[critical]', '[medium]', '[low]'):
        assert tier not in json.dumps(content)


def test_an_alarm_with_no_tier_still_formats(prod_formatter):
    """An alarm created outside MonitoringStack must not break the formatter.

    It lands in the middle tier rather than being dropped or shown untiered:
    swallowing an alert is the one failure this function must never have.
    """
    content = prod_formatter.build_notification(
        _alarm(AlarmDescription='No tier on this one.'),
    )['content']

    assert ':large_yellow_circle:' in content['title']
    assert content['description'].startswith('No tier on this one.')


def test_a_cleared_alarm_is_not_confusable_with_a_low_priority_one(prod_formatter):
    """Green means "not urgent", so a recovery needs its own mark."""
    cleared = prod_formatter.build_notification(
        _alarm(NewStateValue='OK', OldStateValue='ALARM'),
    )['content']['title']
    low = prod_formatter.build_notification(
        _alarm(AlarmDescription='[low] Nothing is broken.'),
    )['content']['title']

    assert ':white_check_mark:' in cleared
    assert ':large_green_circle:' not in cleared
    assert ':large_green_circle:' in low


# ---------------------------------------------------------------------------
# The number. "Observed: 8" was unreadable; this is the fix.
# ---------------------------------------------------------------------------

def test_the_count_carries_its_unit_and_window(formatter):
    body = formatter.build_notification(_alarm())['content']['description']

    assert '8 errors in 5 min' in body
    # The bare value with no unit is the thing being replaced.
    assert 'Observed' not in body


def test_each_metric_gets_words_a_person_would_use(formatter):
    cases = {
        'DocumentFailures': 'documents failed',
        '5xx': 'server errors',
        'Throttles': 'throttled requests',
        'ExecutionsTimedOut': 'executions timed out',
    }
    for metric, phrase in cases.items():
        alarm = _alarm(Trigger={'MetricName': metric, 'Period': 900, 'Dimensions': []})
        body = formatter.build_notification(alarm)['content']['description']
        assert phrase in body, metric
        assert 'in 15 min' in body


def test_an_unmapped_metric_still_says_something_sane(formatter):
    alarm = _alarm(Trigger={'MetricName': 'SomethingNew', 'Period': 60, 'Dimensions': []})
    body = formatter.build_notification(alarm)['content']['description']
    # Never a bare number, even for a metric nobody has named yet.
    assert '8 events in 1 min' in body


# ---------------------------------------------------------------------------
# The resource and the timestamp. Both were invisible once already.
# ---------------------------------------------------------------------------

def test_the_failing_resource_is_in_the_message_body(formatter):
    notification = formatter.build_notification(_alarm())
    body = notification['content']['description']

    # In the description, NOT in additionalContext: Chatbot renders that as
    # nothing at all, which is how this went missing the first time.
    assert 'AIEPStagingStack-MistralOCRFunc-XyZ' in body
    assert 'additionalContext' not in notification['metadata']


def test_the_start_time_is_in_the_message_body(formatter):
    body = formatter.build_notification(_alarm())['content']['description']

    # A custom notification gets no timestamp from Chatbot, unlike the default
    # alarm card, so without this you cannot tell a 5-minute outage from a
    # 5-hour one.
    assert '8 Sep 18:19 UTC' in body


def test_a_missing_timestamp_does_not_break_the_alert(formatter):
    body = formatter.build_notification(_alarm(StateChangeTime=''))['content']['description']
    assert '8 errors in 5 min' in body


# ---------------------------------------------------------------------------
# Where to look next: linked, never pasted.
# ---------------------------------------------------------------------------

def test_the_alert_links_the_logs_rather_than_quoting_them(formatter):
    content = formatter.build_notification(_alarm())['content']

    assert len(content['nextSteps']) == 1
    assert 'logsV2:log-groups' in content['nextSteps'][0]
    assert 'AIEPStagingStack-MistralOCRFunc-XyZ' in content['nextSteps'][0]


@pytest.mark.parametrize('dimension,expected', [
    ({'name': 'TableName', 'value': 'iep-documents'}, 'dynamodbv2'),
    ({'name': 'RuleName', 'value': 'sweep-rule'}, 'events'),
    ({'name': 'ApiId', 'value': 'abc123'}, 'apigateway'),
])
def test_each_resource_type_links_somewhere_useful(formatter, dimension, expected):
    alarm = _alarm(Trigger={'MetricName': 'Errors', 'Period': 300,
                            'Dimensions': [dimension]})
    content = formatter.build_notification(alarm)['content']
    assert expected in content['nextSteps'][0]


def test_an_alarm_with_no_resource_still_produces_an_alert(formatter):
    # DocumentFailures comes from a metric filter and carries no dimensions.
    alarm = _alarm(Trigger={'MetricName': 'DocumentFailures', 'Period': 900,
                            'Dimensions': []})
    content = formatter.build_notification(alarm)['content']

    assert content['title']
    assert 'documents failed' in content['description']
    # No link is better than a broken one.
    assert 'nextSteps' not in content


# ---------------------------------------------------------------------------
# Recovery, and noise control.
# ---------------------------------------------------------------------------

def test_recovery_is_quiet_and_asks_for_nothing(formatter):
    content = formatter.build_notification(
        _alarm(NewStateValue='OK', OldStateValue='ALARM',
               NewStateReason='Threshold Crossed: 1 datapoint [0.0 (08/09/26 18:40:00)] '
                              'was not greater than or equal to the threshold (5.0).'),
    )['content']

    # The alarm name must not appear bare in a recovery title: the names are
    # present-tense problem statements, so "Cleared · login codes are not
    # being delivered" still reads as a claim that they are not arriving.
    assert content['title'] == ':white_check_mark: Back to normal · staging'
    # It belongs in the description instead, quoted, so it reads as the name
    # of an alert rather than a statement about right now.
    assert '"pipeline step failing: Mistral OCR" alert has cleared' in content['description']
    # Next steps on a recovery imply work that is already done.
    assert 'nextSteps' not in content
    assert 'No action needed' in content['description']


def test_an_alarm_coming_online_is_not_announced_as_a_recovery(formatter):
    """A new alarm goes INSUFFICIENT_DATA -> OK the moment it has data.

    The OK action fires, so a deploy announced four "Recovered" messages for
    problems that never happened. Nothing was wrong, so there is no news, and
    the message is dropped rather than reworded.
    """
    sns = formatter.sns
    topic = sns.create_topic(Name='a-iep-alerts-staging')['TopicArn']
    formatter.ALERT_TOPIC_ARN = topic

    event = {'Records': [
        {'Sns': {'Message': json.dumps(
            _alarm(NewStateValue='OK', OldStateValue='INSUFFICIENT_DATA'))}},
    ]}

    assert json.loads(formatter.lambda_handler(event, None)['body'])['published'] == 0


def test_a_real_recovery_is_still_announced(formatter):
    """The suppression must not swallow the end of an actual outage."""
    sns = formatter.sns
    topic = sns.create_topic(Name='a-iep-alerts-staging')['TopicArn']
    formatter.ALERT_TOPIC_ARN = topic

    event = {'Records': [
        {'Sns': {'Message': json.dumps(
            _alarm(NewStateValue='OK', OldStateValue='ALARM'))}},
    ]}

    assert json.loads(formatter.lambda_handler(event, None)['body'])['published'] == 1


def test_the_same_alarm_threads_instead_of_filling_the_channel(formatter):
    first = formatter.build_notification(_alarm())
    recovery = formatter.build_notification(_alarm(NewStateValue='OK'))

    # Same thread for the same alarm, so a flapping alarm is one conversation.
    assert first['metadata']['threadId'] == recovery['metadata']['threadId']
    assert len(first['metadata']['threadId']) <= 64

    other = formatter.build_notification(_alarm(AlarmName='a-iep-staging API returning 5xx'))
    assert other['metadata']['threadId'] != first['metadata']['threadId']


def test_the_payload_is_the_shape_chatbot_renders(formatter):
    notification = formatter.build_notification(_alarm())

    # Without source: "custom" Chatbot ignores the whole thing and renders
    # nothing, so this is the single most load-bearing field.
    assert notification['source'] == 'custom'
    assert notification['version'] == '1.0'
    assert notification['content']['textType'] == 'client-markdown'
    # The mobile push preview has to stand alone.
    assert 'Mistral OCR' in notification['metadata']['summary']


# ---------------------------------------------------------------------------
# Never swallow an alert.
# ---------------------------------------------------------------------------

def test_an_alarm_is_forwarded_to_the_alert_topic(formatter):
    sns = formatter.sns
    topic = sns.create_topic(Name='a-iep-alerts-staging')['TopicArn']
    formatter.ALERT_TOPIC_ARN = topic

    event = {'Records': [{'Sns': {'Message': json.dumps(_alarm())}}]}
    result = formatter.lambda_handler(event, None)

    assert json.loads(result['body'])['published'] == 1


def test_a_message_that_is_not_an_alarm_is_passed_through_not_dropped(formatter):
    # A hand-published custom notification, or anything else on the topic.
    # Swallowing it is the one failure this function must never have.
    sns = formatter.sns
    topic = sns.create_topic(Name='a-iep-alerts-staging')['TopicArn']
    formatter.ALERT_TOPIC_ARN = topic

    for message in ['not json at all', json.dumps({'hello': 'world'})]:
        result = formatter.lambda_handler(
            {'Records': [{'Sns': {'Message': message}}]}, None)
        assert json.loads(result['body'])['published'] == 1


def test_every_record_in_a_batch_is_handled(formatter):
    sns = formatter.sns
    topic = sns.create_topic(Name='a-iep-alerts-staging')['TopicArn']
    formatter.ALERT_TOPIC_ARN = topic

    event = {'Records': [
        {'Sns': {'Message': json.dumps(_alarm())}},
        {'Sns': {'Message': json.dumps(
            _alarm(NewStateValue='OK', OldStateValue='ALARM'))}},
        {'Sns': {'Message': 'junk'}},
    ]}
    assert json.loads(formatter.lambda_handler(event, None)['body'])['published'] == 3
