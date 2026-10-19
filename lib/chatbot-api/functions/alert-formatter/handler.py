"""Turn a CloudWatch alarm into an alert a person can act on.

AWS Chatbot's default alarm card is a metric dump. It leads with the account
id, buries the description under Namespace / Metric / Timestamp, truncates it
around 250 characters, and states the problem as "Threshold Crossed: 1
datapoint [4.0] was greater than or equal to the threshold (2.0)". Nobody
reads that at 2am and knows what to do.

Chatbot renders a custom notification instead when the SNS payload carries
source: "custom", which gives us the whole message. This function is the
translation step:

    alarm -> ALARM_TOPIC -> this -> ALERT_TOPIC -> Chatbot -> Slack

## The message

Written to the usual alerting guidance (actionable, symptom-based, says who is
affected and what to do first), and identical in shape every time:

    [PROD] [CRITICAL] Sign-in codes are not being sent
    What is happening: at least 3 failed code sends in 5 minutes (latest reading: 4)
    Who is affected: Parents ask for a sign-in code, none arrives...
    Started: 12 Oct 2026, 14:03 UTC
    Check first: 1. ... 2. ...   (plus the runbook, the logs and the alarm)

Environment and severity are the first two words, as words rather than colours,
so the message reads the same in a push notification, a screen reader and a
plain-text export. Staging is capped at WARNING and says no real families are
affected.

## Where the words come from

Not from here. Every alarm's description is written by
lib/chatbot-api/monitoring/alert-copy.ts in a fixed shape, and this function
parses it (`parse_description`). Adding or rewording an alarm is an edit to
that file and needs no change here. An alarm that does not follow the shape
(one created outside that file) still produces an alert, built from its name.

## What is posted

- Every ALARM, in both environments.
- A resolution ("Resolved: ...") only for CRITICAL alarms in prod. A warning
  that clears needs no announcement, and staging resolutions are noise: the
  channel is shared, and a resolved test failure is not news to anyone.
- Never an OK that is an alarm starting up (INSUFFICIENT_DATA to OK).

Nothing shown can carry FERPA content: every value is an alarm name, copy
written in the repo, a resource id, a count or a timestamp. Never add a field
sourced from a log message or a request body.
"""
import datetime
import json
import os
import re
import urllib.parse

import boto3

sns = boto3.client('sns')
cloudwatch = boto3.client('cloudwatch')

ALERT_TOPIC_ARN = os.environ['ALERT_TOPIC_ARN']
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'unknown')
REGION = os.environ.get('AWS_REGION', 'us-east-1')

IS_PROD = ENVIRONMENT in ('prod', 'production')
ENV_LABEL = 'PROD' if IS_PROD else 'STAGING'

_CONSOLE = f'https://console.aws.amazon.com/cloudwatch/home?region={REGION}'

# The first line of every description written by alert-copy.ts.
_TITLE_LINE = re.compile(r'^\[(PROD|STAGING)\] \[(CRITICAL|WARNING|INFO)\] (.+)$')
_SECTION_LINE = re.compile(r'^(Impact|Fires when|Runbook|Recovery): (.*)$')
_CHECK_STEP = re.compile(r'^\d+\. (.+)$')

# What to say when an alarm does not follow the shape above.
_FALLBACK_SEVERITY = 'WARNING'

# "at least 3 failed code sends in 5 minutes": the only shape of threshold
# phrase that a latest reading can sensibly sit next to.
_COUNT_CONDITION = re.compile(r'^at least \d+ ')

_QUIET = 'quiet'


def parse_description(text):
    """Split an alert-copy.ts description into its parts, or None.

    Returns a dict with environment, severity, symptom, impact, fires,
    check (list), runbook and recovery. The last four may be None or empty.
    None means the text is not in the expected shape.
    """
    lines = (text or '').strip().splitlines()
    if not lines:
        return None
    match = _TITLE_LINE.match(lines[0].strip())
    if not match:
        return None

    parsed = {
        'environment': match.group(1),
        'severity': match.group(2),
        'symptom': match.group(3).strip(),
        'impact': None,
        'fires': None,
        'check': [],
        'runbook': None,
        'recovery': None,
    }
    key_by_label = {'Impact': 'impact', 'Fires when': 'fires',
                    'Runbook': 'runbook', 'Recovery': 'recovery'}
    for line in lines[1:]:
        line = line.strip()
        section = _SECTION_LINE.match(line)
        if section:
            label, value = section.group(1), section.group(2).strip()
            # "Fires when" ends in a full stop that the body adds back itself.
            parsed[key_by_label[label]] = value.rstrip('.') if label == 'Fires when' else value
            continue
        step = _CHECK_STEP.match(line)
        if step:
            parsed['check'].append(step.group(1).strip())
    return parsed


def _fallback(alarm):
    """An alert for an alarm that was not written by alert-copy.ts.

    Better a plain alert than none: swallowing an alarm is the one failure
    this function must never have.
    """
    name = alarm.get('AlarmName', 'unknown alarm')
    symptom = re.sub(r'^a-iep(-staging)?\s+', '', name).strip() or name
    return {
        'environment': ENV_LABEL,
        'severity': _FALLBACK_SEVERITY,
        'symptom': symptom[:1].upper() + symptom[1:],
        'impact': None,
        'fires': None,
        'check': [],
        'runbook': None,
        'recovery': None,
        'fallback': True,
    }


def _resource(dimensions):
    """The logs or console page for the resource this alarm is about, or (None, None)."""
    dims = {d.get('name'): d.get('value') for d in dimensions or []}

    function_name = dims.get('FunctionName')
    if function_name:
        encoded = f'/aws/lambda/{function_name}'.replace('/', '$252F')
        return f'{_CONSOLE}#logsV2:log-groups/log-group/{encoded}', 'Open the logs'

    table_name = dims.get('TableName')
    if table_name:
        return (f'https://console.aws.amazon.com/dynamodbv2/home?region={REGION}'
                f'#table?name={table_name}&tab=monitoring'), 'Open the table metrics'

    rule_name = dims.get('RuleName')
    if rule_name:
        return (f'https://console.aws.amazon.com/events/home?region={REGION}'
                f'#/eventbus/default/rules/{rule_name}'), 'Open the schedule'

    api_id = dims.get('ApiId')
    if api_id:
        return (f'https://console.aws.amazon.com/apigateway/main/monitor/logs'
                f'?api={api_id}&region={REGION}'), 'Open the API logs'

    return None, None


def _alarm_link(name):
    return f'{_CONSOLE}#alarmsV2:alarm/{urllib.parse.quote(name, safe="")}'


_MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def _when(raw):
    """'12 Oct 2026, 14:03 UTC' from CloudWatch's timestamp, or None.

    A custom notification gets no timestamp from Chatbot, so without this the
    reader cannot tell a five-minute-old outage from a five-hour-old one.
    """
    match = re.match(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})', raw or '')
    if not match:
        return None
    year, month, day, hour, minute = match.groups()
    return f'{int(day)} {_MONTHS[int(month)]} {year}, {hour}:{minute} UTC'


def _latest_reading(alarm):
    """The number that crossed the threshold, or None.

    CloudWatch states it as "Threshold Crossed: 1 datapoint [8.0 (08/09/26
    18:14:00)] was greater than or equal to the threshold (5.0)". The value is
    the only part worth showing.
    """
    match = re.search(r'\[([0-9.]+)\s', alarm.get('NewStateReason') or '')
    if not match:
        return None
    value = float(match.group(1))
    return str(int(value)) if value.is_integer() else str(value)


def _quiet_minutes(alarm):
    """How long the alarm has been quiet when it clears, or None.

    Period x EvaluationPeriods is the window that has to be clean for an
    event-count alarm to leave ALARM. Metric-math alarms carry no top-level
    Period, so they get no number rather than a wrong one.
    """
    trigger = alarm.get('Trigger') or {}
    period = trigger.get('Period')
    periods = trigger.get('EvaluationPeriods') or 1
    if not isinstance(period, (int, float)) or period <= 0:
        return None
    return int(period * periods // 60) or None


def _parse_time(raw):
    """A CloudWatch timestamp as an aware datetime, or None."""
    match = re.match(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})', raw or '')
    if not match:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.groups())
    return datetime.datetime(year, month, day, hour, minute, second,
                             tzinfo=datetime.timezone.utc)


def _alert_duration_minutes(alarm):
    """How long the alarm was in ALARM before this OK, or None.

    The OK payload carries no start time, so this asks CloudWatch for the
    alarm's history and takes the most recent move into ALARM. Best effort and
    only used for the resolution line: if the lookup fails the resolution is
    still posted, just without the duration, and the failure is logged.
    """
    cleared = _parse_time(alarm.get('StateChangeTime'))
    if cleared is None:
        return None
    try:
        history = cloudwatch.describe_alarm_history(
            AlarmName=alarm['AlarmName'],
            HistoryItemType='StateUpdate',
            MaxRecords=20,
            ScanBy='TimestampDescending',
        )
    except Exception as error:  # noqa: BLE001 - never lose a resolution over a lookup
        print(f'ALARM_DURATION_UNAVAILABLE {type(error).__name__}')
        return None
    for item in history.get('AlarmHistoryItems', []):
        summary = item.get('HistorySummary') or ''
        timestamp = item.get('Timestamp')
        if not summary.endswith('to ALARM') or timestamp is None:
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=datetime.timezone.utc)
        seconds = (cleared - timestamp).total_seconds()
        if seconds < 0:
            continue
        return max(1, int(round(seconds / 60)))
    return None


def _plural_minutes(minutes):
    return '1 minute' if minutes == 1 else f'{minutes} minutes'


def _title(parsed, recovered, quiet, alarm):
    label = parsed['environment']
    if not recovered:
        return f"[{label}] [{parsed['severity']}] {parsed['symptom']}"
    if quiet:
        minutes = _quiet_minutes(alarm)
        window = f' for {_plural_minutes(minutes)}' if minutes else ''
        return f"[{label}] Quiet: {parsed['symptom']} (no new failures{window})"
    phrase = parsed['recovery'] or f'the "{parsed["symptom"]}" alert has cleared'
    duration = _alert_duration_minutes(alarm)
    lasted = f' (alert lasted {_plural_minutes(duration)})' if duration else ''
    return f'[{label}] Resolved: {phrase}{lasted}'


def _firing_body(parsed, alarm):
    lines = []
    if parsed['fires']:
        reading = _latest_reading(alarm)
        suffix = f' (latest reading: {reading})' if reading and _COUNT_CONDITION.match(parsed['fires']) else ''
        lines.append(f"*What is happening:* Alert condition met: {parsed['fires']}{suffix}.")
    if parsed['impact']:
        lines.append(f"*Who is affected:* {parsed['impact']}")
    started = _when(alarm.get('StateChangeTime'))
    if started:
        lines.append(f'*Started:* {started}')
    return lines


def _resolved_body(parsed, quiet, alarm):
    cleared = _when(alarm.get('StateChangeTime'))
    when = f' at {cleared}' if cleared else ''
    if quiet:
        return [f'The alert cleared{when} because failures stopped arriving. '
                'That does not confirm the cause is fixed.']
    return [f'The alert cleared{when}. No action needed.']


def build_notification(alarm, parsed=None):
    """Shape one alarm into a Chatbot custom notification."""
    name = alarm.get('AlarmName', 'unknown alarm')
    recovered = alarm.get('NewStateValue') == 'OK'
    parsed = parsed or parse_description(alarm.get('AlarmDescription')) or _fallback(alarm)
    quiet = recovered and parsed['recovery'] == _QUIET

    title = _title(parsed, recovered, quiet, alarm)
    content = {'textType': 'client-markdown', 'title': title}

    if recovered:
        content['description'] = '\n'.join(_resolved_body(parsed, quiet, alarm))
    else:
        body = _firing_body(parsed, alarm)
        if parsed.get('fallback'):
            body.insert(0, 'This alarm has no written guidance. Open the alarm for details.')
        content['description'] = '\n'.join(body)

        steps = list(parsed['check'])
        if parsed['runbook']:
            steps.append(f"<{parsed['runbook']}|Open the runbook>")
        resource_link, resource_label = _resource((alarm.get('Trigger') or {}).get('Dimensions'))
        if resource_link:
            steps.append(f'<{resource_link}|{resource_label}>')
        steps.append(f'<{_alarm_link(name)}|Open the alarm in CloudWatch>')
        content['nextSteps'] = steps

    return {
        'version': '1.0',
        'source': 'custom',
        'content': content,
        'metadata': {
            # The mobile push preview, so it must stand alone.
            'summary': title,
            # The same alarm flapping, or clearing, threads under its first
            # message instead of filling the channel.
            'threadId': re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:64],
            # No additionalContext: Chatbot accepts it and renders nothing, so
            # anything put there is silently invisible. Verified with a test
            # notification carrying extra fields, which showed only title,
            # description and nextSteps.
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


def _should_post(alarm, parsed):
    """Whether this state change reaches Slack at all.

    Every ALARM does. An OK does only for a CRITICAL alarm in prod, because
    that is the one case where "is it fixed" is a question somebody is
    waiting on. Staging never posts one, and an alarm without written guidance
    cannot be known to be critical.
    """
    if alarm.get('NewStateValue') != 'OK':
        return True
    return (
        parsed is not None
        and parsed['environment'] == 'PROD'
        and parsed['severity'] == 'CRITICAL'
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
            # fires all the same, so a deploy would announce a "recovery" for
            # something that never broke. Dropped, not reworded: no news here.
            print(f"Suppressing coming-online OK for {alarm.get('AlarmName')} "
                  f"(was {alarm.get('OldStateValue')})")
            continue

        parsed = parse_description(alarm.get('AlarmDescription'))
        if not _should_post(alarm, parsed):
            print(f"Not posting the resolution of {alarm.get('AlarmName')}: "
                  'resolutions post for CRITICAL alarms in prod only')
            continue

        notification = build_notification(alarm, parsed)
        print(f"Formatted alert for {alarm.get('AlarmName')} "
              f"-> {alarm.get('NewStateValue')}")
        sns.publish(TopicArn=ALERT_TOPIC_ARN, Message=json.dumps(notification))
        published += 1

    return {'statusCode': 200, 'body': json.dumps({'published': published})}
