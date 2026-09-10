"""Turn a CloudWatch alarm into an alert a person can act on.

AWS Chatbot's default alarm card is a metric dump. It leads with the account
id and region, buries the description under Namespace / Metric / Timestamp,
truncates it around 250 characters, and states the problem as
"Threshold Crossed: 1 datapoint [4.0] was greater than or equal to the
threshold (2.0)". Nobody reads that at 2am and knows what to do.

Chatbot renders a custom notification instead when the SNS payload carries
source: "custom", which gives us the whole message. This function is the
translation step:

    alarm -> ALARM_TOPIC -> this -> ALERT_TOPIC -> Chatbot -> Slack

Following the alerting guidance rather than taste: concise and scannable, no
walls of text, structured fields instead of prose, the runbook linked rather
than embedded, and repeat alerts threaded rather than filling the channel.

Everything shown is derived from the alarm itself, so there is no second copy
of the wording to drift: the alarm name is the headline, its description is
the single impact line, and its dimensions produce the log link. Adding an
alarm in monitoring.ts needs no change here.
"""
import json
import os
import re

import boto3

sns = boto3.client('sns')

ALERT_TOPIC_ARN = os.environ['ALERT_TOPIC_ARN']
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'unknown')
REGION = os.environ.get('AWS_REGION', 'us-east-1')

# Production alarms mean real families are affected right now; staging alarms
# mean a test broke. Saying which, on the headline, is the difference between
# an alert someone acts on and one they have to investigate to triage.
IS_PROD = ENVIRONMENT in ('prod', 'production')

_CONSOLE = f'https://console.aws.amazon.com/cloudwatch/home?region={REGION}'

# No @channel, @here or any all-member mention, ever, in either environment.
# Getting an alert to push is the channel's notification settings, which is a
# choice for the person receiving them rather than something an alert imposes
# on everyone in the room.


def _resource(dimensions):
    """Which AWS resource this alarm is about, and where to look at it.

    Returns (name, url, link_label). The name goes in a field because it is
    what someone pastes into a console search; the url is linked rather than
    pasted, because the alert says what broke and the logs say why.
    """
    dims = {d.get('name'): d.get('value') for d in dimensions or []}

    function_name = dims.get('FunctionName')
    if function_name:
        encoded = f'/aws/lambda/{function_name}'.replace('/', '$252F')
        return function_name, f'{_CONSOLE}#logsV2:log-groups/log-group/{encoded}', 'Logs'

    table_name = dims.get('TableName')
    if table_name:
        return table_name, (f'https://console.aws.amazon.com/dynamodbv2/home?region={REGION}'
                            f'#table?name={table_name}&tab=monitoring'), 'Table metrics'

    rule_name = dims.get('RuleName')
    if rule_name:
        return rule_name, (f'https://console.aws.amazon.com/events/home?region={REGION}'
                           f'#/eventbus/default/rules/{rule_name}'), 'Schedule'

    api_id = dims.get('ApiId')
    if api_id:
        return api_id, (f'https://console.aws.amazon.com/apigateway/main/monitor/logs'
                        f'?api={api_id}&region={REGION}'), 'API logs'

    # Metric-filter alarms (DocumentFailures) carry no dimensions: the alarm
    # is about the pipeline as a whole, so the ddb-service log is the place to
    # start and the caller supplies it.
    return None, None, None


def _started(alarm):
    """When this started, in a form someone can compare to their clock.

    A custom notification gets no timestamp from Chatbot, unlike the default
    alarm card, so it has to be a field here or the reader cannot tell a
    five-minute-old outage from a five-hour-old one.
    """
    raw = alarm.get('StateChangeTime') or ''
    match = re.match(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})', raw)
    if not match:
        return None
    _, month, day, hour, minute = match.groups()
    months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return f'{int(day)} {months[int(month)]} {hour}:{minute} UTC'


def _headline(alarm_name):
    """Strip the resource prefix; monitoring.ts already names alarms for humans."""
    return re.sub(r'^a-iep(-staging)?\s+', '', alarm_name).strip() or alarm_name


# What the metric counts, said the way a person would say it. Without this the
# card reads "Observed: 8", which is 8 of nothing in particular.
_UNITS = {
    'Errors': 'errors',
    '5xx': 'server errors',
    'DocumentFailures': 'documents failed',
    'Throttles': 'throttled requests',
    'ExecutionsTimedOut': 'executions timed out',
    'FailedInvocations': 'failed invocations',
}


def _observed_phrase(alarm):
    """'8 errors in 5 min', or None when there is no useful number.

    CloudWatch states this as "Threshold Crossed: 1 datapoint [8.0
    (08/09/26 18:14:00)] was greater than or equal to the threshold (5.0)".
    The value is the only part worth showing, and it is meaningless without
    both its unit and the window it was counted over.
    """
    match = re.search(r'\[([0-9.]+)\s', alarm.get('NewStateReason') or '')
    if not match:
        return None
    value = float(match.group(1))
    count = str(int(value)) if value.is_integer() else str(value)

    trigger = alarm.get('Trigger') or {}
    unit = _UNITS.get(trigger.get('MetricName'), 'events')

    period = trigger.get('Period')
    window = ''
    if isinstance(period, (int, float)) and period > 0:
        minutes = int(period // 60)
        window = f' in {minutes} min' if minutes else f' in {int(period)}s'
    return f'{count} {unit}{window}'


def build_notification(alarm):
    """Shape one alarm into a Chatbot custom notification."""
    name = alarm.get('AlarmName', 'unknown alarm')
    state = alarm.get('NewStateValue', 'ALARM')
    recovered = state == 'OK'
    headline = _headline(name)

    # Environment on the headline, because "is this real" is the first
    # question and it should not need a click to answer.
    env_label = 'prod' if IS_PROD else 'staging'
    icon = ':large_green_circle:' if recovered else (
        ':red_circle:' if IS_PROD else ':large_orange_circle:')
    # Alarm names are present-tense problem statements, which is right when
    # one fires and wrong in every recovery: "Cleared · login codes are not
    # being delivered" still reads as a claim that codes are not arriving.
    #
    # So a recovery leads with the state and demotes the name into the
    # description, in quotes. The quotes are what stop it being read as a
    # sentence: it becomes the name of an alert rather than an assertion
    # about right now.
    title = (
        f'{icon} Back to normal · {env_label}' if recovered
        else f'{icon} {headline} · {env_label}'
    )

    # One line. The alarm description is written as the impact statement, so
    # it is used as-is rather than wrapped in more words.
    description = (alarm.get('AlarmDescription') or '').strip()
    observed = _observed_phrase(alarm)
    if recovered:
        description = f'The "{headline}" alert has cleared. No action needed.'

    trigger = alarm.get('Trigger') or {}
    resource, link, link_label = _resource(trigger.get('Dimensions'))

    content = {
        'textType': 'client-markdown',
        'title': title,
        'description': description,
    }
    # Recovery needs no next steps; adding them implies work that is done.
    if link and not recovered:
        content['nextSteps'] = [f'<{link}|{link_label}>']

    # The context line: how much, when, where, and which resource.
    #
    # These belong in metadata.additionalContext by the guidance (fields, not
    # prose), and that is where they started. Chatbot does not render it: a
    # test notification carrying environment/resource/started showed the title,
    # description and nextSteps only, with the fields silently dropped. So they
    # go in the description, still as a scannable line of separated values
    # rather than a sentence.
    #
    # A custom notification also gets no timestamp from Chatbot, unlike the
    # default alarm card, so without this a reader cannot tell a five-minute
    # outage from a five-hour one.
    context = []
    if observed and not recovered:
        context.append(observed)
    started = _started(alarm)
    if started:
        context.append(started)
    # Environment only, and deliberately no claim about who was affected.
    # Some alarms watch account-scoped metrics, so a staging-named alarm can
    # be reporting damage that is not staging's. Naming the environment is a
    # fact this function has; impact is not, and asserting it wrongly is worse
    # than leaving it out.
    context.append('prod' if IS_PROD else 'staging')

    lines = [description, ' · '.join(context)]
    # Resource on its own line: the names are long enough to wrap and push the
    # numbers out of view, and it is the string someone pastes into a console.
    if resource:
        lines.append(f'`{resource}`')
    content['description'] = '\n\n'.join(lines[:1]) + '\n' + '\n'.join(lines[1:])

    return {
        'version': '1.0',
        'source': 'custom',
        'content': content,
        'metadata': {
            # The mobile push preview, so it must stand alone.
            'summary': f'{headline} ({env_label})',
            # Same alarm flapping threads under its first message instead of
            # filling the channel.
            'threadId': re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:64],
            # No additionalContext: Chatbot accepts it and renders nothing, so
            # anything put there is silently invisible. Verified with a test
            # notification carrying environment/resource/started, which showed
            # only title, description and nextSteps. Those values are in the
            # description's context line instead.
        },
    }


def _is_alarm_coming_online(alarm):
    """True for an OK that is an alarm starting up, not an outage ending.

    A recovery is only news if something was actually wrong, which means the
    previous state was ALARM. Every other route into OK is an alarm gaining
    enough data to evaluate.
    """
    return (
        alarm.get('NewStateValue') == 'OK'
        and alarm.get('OldStateValue') != 'ALARM'
    )


def lambda_handler(event, context):
    published = 0
    for record in event.get('Records', []):
        raw = (record.get('Sns') or {}).get('Message')
        try:
            alarm = json.loads(raw)
        except (TypeError, ValueError):
            # Not an alarm (a hand-published custom notification, say). Pass it
            # through untouched rather than dropping it: swallowing an alert is
            # the one failure this function must never have.
            print('Passing through a non-alarm message unchanged')
            sns.publish(TopicArn=ALERT_TOPIC_ARN, Message=raw or '')
            published += 1
            continue

        if not isinstance(alarm, dict) or 'AlarmName' not in alarm:
            print('Passing through a message that is not a CloudWatch alarm')
            sns.publish(TopicArn=ALERT_TOPIC_ARN, Message=raw)
            published += 1
            continue

        if _is_alarm_coming_online(alarm):
            # A brand-new alarm starts in INSUFFICIENT_DATA and moves to OK as
            # soon as it has data. That is not a recovery, but the OK action
            # fires all the same, so a deploy announces "Recovered: login codes
            # are not being delivered" for something that never broke. Four of
            # those arrived at 2am on 2026-09-10 and read as a real outage.
            #
            # Dropped rather than reworded: there is no news here at all.
            print(f"Suppressing coming-online OK for {alarm.get('AlarmName')} "
                  f"(was {alarm.get('OldStateValue')})")
            continue

        notification = build_notification(alarm)
        print(f"Formatted alert for {alarm.get('AlarmName')} "
              f"-> {alarm.get('NewStateValue')}")
        sns.publish(TopicArn=ALERT_TOPIC_ARN, Message=json.dumps(notification))
        published += 1

    return {'statusCode': 200, 'body': json.dumps({'published': published})}
