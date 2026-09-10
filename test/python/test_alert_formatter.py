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
        'AlarmDescription': 'Documents are failing at the Mistral OCR step, so '
                            'every upload reaching this stage is affected.',
        'NewStateValue': 'ALARM',
        'NewStateReason': 'Threshold Crossed: 1 datapoint [8.0 (08/09/26 18:14:00)] '
                          'was greater than or equal to the threshold (5.0).',
        'StateChangeTime': '2026-09-08T18:19:58.123+0000',
        'Trigger': {
            'MetricName': 'Errors',
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


def test_production_alarms_page_the_channel(prod_formatter):
    """A production alarm has to push, not wait to be read.

    The 2026-09-09 outage ran for thirteen hours partly because nothing
    notified anyone; a Slack message with no mention is a message someone
    reads in the morning.
    """
    description = prod_formatter.build_notification(_alarm())['content']['description']

    assert description.startswith('<!channel>')


def test_staging_alarms_do_not_page(formatter):
    """Staging fires the same alarms for broken tests.

    A channel that buzzes for those gets muted, and then the production ones
    are lost with it.
    """
    description = formatter.build_notification(_alarm())['content']['description']

    assert '<!channel>' not in description


def test_recoveries_never_page(prod_formatter):
    """Good news must not wake anyone."""
    recovery = _alarm(NewStateValue='OK')
    description = prod_formatter.build_notification(recovery)['content']['description']

    assert '<!channel>' not in description


def test_footer_names_the_environment_and_claims_nothing_else(formatter):
    """The footer states which environment fired, and no impact claim.

    It used to assert that a staging alarm meant nobody was affected. Some
    alarms watch account-scoped metrics, where that is not something the
    environment label can tell you, and a wrong reassurance in an alert is
    worse than no reassurance.
    """
    description = formatter.build_notification(_alarm())['content']['description']

    # The footer is the ' · '-joined context line, not the alarm prose above
    # it: an alarm description may legitimately say a stage is affected.
    footer = next(line for line in description.splitlines() if ' · ' in line)

    assert footer.endswith('staging')
    assert 'families' not in footer
    assert 'affected' not in footer


def test_prod_and_staging_are_visibly_different(formatter, prod_formatter):
    staging = formatter.build_notification(_alarm())['content']['title']
    prod = prod_formatter.build_notification(_alarm())['content']['title']

    assert 'staging' in staging and ':large_orange_circle:' in staging
    # Red only for production: a staging alarm that looks identical to a prod
    # one is how a channel gets ignored.
    assert 'prod' in prod and ':red_circle:' in prod


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
        _alarm(NewStateValue='OK',
               NewStateReason='Threshold Crossed: 1 datapoint [0.0 (08/09/26 18:40:00)] '
                              'was not greater than or equal to the threshold (5.0).'),
    )['content']

    assert 'Recovered' in content['title']
    assert ':large_green_circle:' in content['title']
    # Next steps on a recovery imply work that is already done.
    assert 'nextSteps' not in content
    assert 'No action needed' in content['description']


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
        {'Sns': {'Message': json.dumps(_alarm(NewStateValue='OK'))}},
        {'Sns': {'Message': 'junk'}},
    ]}
    assert json.loads(formatter.lambda_handler(event, None)['body'])['published'] == 3
