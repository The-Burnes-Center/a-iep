"""A once-a-day statement that the service is working, not just not alarming.

Alarms answer "did something break". They cannot answer "is anything still
happening", and those are different questions: a pipeline that stops being
invoked at all raises no errors, so every alarm stays green while nothing
works. The 2026-09-09 SMS outage was visible in exactly this way for hours
before any threshold moved.

So this reports positively: every monitored component, whether it ran, and
how many errors.

The message follows the same shape as every alert (see the alert formatter):
environment and severity first, as words, then only what needs attention.
Components that ran normally are counted, not listed: a reader scanning on a
phone should not pass twenty healthy lines to reach the one that matters.
Components that did NOT run are listed with their purpose, because "0 runs"
cannot be judged without knowing whether the thing was meant to run.

FERPA: every value here is a name, a count or a timestamp. Nothing is sourced
from a log message, a document or a request body, and nothing may be added
that is.
"""
import datetime
import json
import os
import re

import boto3

cloudwatch = boto3.client('cloudwatch')
sns = boto3.client('sns')
ssm = boto3.client('ssm')

ALERT_TOPIC_ARN = os.environ['ALERT_TOPIC_ARN']
ENVIRONMENT = os.environ.get('ENVIRONMENT', 'unknown')
# What to report on: [{label, functionName, purpose}], built in CDK so this
# lambda never needs editing when a component is added.
#
# Read from Parameter Store rather than an environment variable, because
# Lambda caps all environment variables at 4KB combined and this manifest is
# already larger than that. Read once per cold start, not per invocation: it
# runs daily, so every run is a cold start anyway.
BRIEF_COMPONENTS_PARAM = os.environ.get('BRIEF_COMPONENTS_PARAM', '')
ALARM_PREFIX = os.environ.get('ALARM_PREFIX', '')

IS_PROD = ENVIRONMENT in ('prod', 'production')
ENV_LABEL = 'PROD' if IS_PROD else 'STAGING'
WINDOW_HOURS = 24

# The first line of every alarm description written by alert-copy.ts:
# "[PROD] [CRITICAL] Sign-in codes are not being sent".
_ALARM_TITLE = re.compile(r'^\[(?:PROD|STAGING)\] \[(CRITICAL|WARNING|INFO)\] (.+)$')
_SEVERITY_ORDER = {'CRITICAL': 0, 'WARNING': 1, 'INFO': 2}

_MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def _components():
    """`(components, could_not_read)`.

    An unreadable manifest degrades to a brief that reports the firing alarms
    and nothing else, which is worse than the full brief but far better than
    no brief: silence is the one outcome this whole thing exists to remove.

    The second element exists because degrading quietly was worse than not
    degrading at all. With an empty manifest and nothing firing, this reported
    "all green (0 ran, 0 idle)", a green tick for a brief that had measured
    nothing whatsoever. A brief that cannot read its own manifest has to say
    so in the headline, or it is a daily assurance that nothing is wrong,
    issued by something that did not look.
    """
    if not BRIEF_COMPONENTS_PARAM:
        return [], True
    try:
        value = ssm.get_parameter(Name=BRIEF_COMPONENTS_PARAM)['Parameter']['Value']
        return json.loads(value), False
    except Exception as error:  # noqa: BLE001 - see docstring
        print(f'BRIEF_MANIFEST_UNREADABLE {type(error).__name__}')
        return [], True


def _metric_queries(components):
    """One Invocations and one Errors query per component."""
    queries = []
    for index, component in enumerate(components):
        for stat_name, metric in (('inv', 'Invocations'), ('err', 'Errors')):
            queries.append({
                'Id': f'{stat_name}{index}',
                'MetricStat': {
                    'Metric': {
                        'Namespace': 'AWS/Lambda',
                        'MetricName': metric,
                        'Dimensions': [
                            {'Name': 'FunctionName', 'Value': component['functionName']},
                        ],
                    },
                    # One datapoint for the whole window: the brief reports a
                    # total, and a per-minute series would be 1,440 points to
                    # sum here for no extra information.
                    'Period': WINDOW_HOURS * 3600,
                    'Stat': 'Sum',
                },
                'ReturnData': True,
            })
    return queries


def _totals(components, start, end):
    """{index: (invocations, errors)} for the window."""
    totals = {index: [0, 0] for index in range(len(components))}
    queries = _metric_queries(components)
    # GetMetricData takes at most 500 queries per call.
    for chunk_start in range(0, len(queries), 500):
        chunk = queries[chunk_start:chunk_start + 500]
        paginator = cloudwatch.get_paginator('get_metric_data')
        for page in paginator.paginate(MetricDataQueries=chunk, StartTime=start, EndTime=end):
            for result in page.get('MetricDataResults', []):
                identifier = result['Id']
                index = int(identifier[3:])
                value = sum(result.get('Values') or [])
                totals[index][0 if identifier.startswith('inv') else 1] = int(value)
    return totals


def _alarms_now():
    """Alarms currently firing, as [{'severity', 'headline'}], worst first.

    The headline is the alarm's own first line, so the brief says "Sign-in
    codes are not being sent" rather than naming a CloudWatch alarm. An alarm
    that was not written by alert-copy.ts falls back to its name at WARNING.
    """
    firing = []
    # Prefixed so a staging brief never reports production's alarms, and vice
    # versa: they share an account and the names are the only thing that
    # separates them.
    kwargs = {'StateValue': 'ALARM'}
    if ALARM_PREFIX:
        kwargs['AlarmNamePrefix'] = ALARM_PREFIX
    paginator = cloudwatch.get_paginator('describe_alarms')
    for page in paginator.paginate(**kwargs):
        for alarm in page.get('MetricAlarms', []):
            first_line = (alarm.get('AlarmDescription') or '').strip().split('\n')[0]
            match = _ALARM_TITLE.match(first_line.strip())
            if match:
                firing.append({'severity': match.group(1), 'headline': match.group(2)})
            else:
                firing.append({'severity': 'WARNING', 'headline': alarm['AlarmName']})
    firing.sort(key=lambda item: (_SEVERITY_ORDER[item['severity']], item['headline']))
    return firing


def _plural(count, noun):
    return f'{count} {noun}' if count == 1 else f'{count} {noun}s'


def _component_summary(components, totals):
    """Split the components into (broken, idle, healthy_count).

    broken: [(label, invocations, errors, purpose)], most errors first.
    idle:   [(label, purpose)], alphabetical.
    """
    broken, idle, healthy = [], [], 0
    for index, component in enumerate(components):
        invocations, errors = totals[index]
        if errors:
            broken.append((component['label'], invocations, errors, component['purpose']))
        elif invocations:
            healthy += 1
        else:
            idle.append((component['label'], component['purpose']))
    broken.sort(key=lambda item: (-item[2], item[0].lower()))
    idle.sort(key=lambda item: item[0].lower())
    return broken, idle, healthy


def _headline(problems, manifest_unreadable):
    """`(severity, sentence)`. Never INFO when something needs attention or was not checked."""
    if problems:
        verb = 'needs' if problems == 1 else 'need'
        return 'WARNING', f'{_plural(problems, "problem")} {verb} attention'
    if manifest_unreadable:
        # Never reassuring. This brief checked nothing, and "no problems"
        # here would be the most misleading line the channel can carry: a
        # daily assurance that nothing is wrong, issued by something that did
        # not look.
        return 'WARNING', 'could not read what it is meant to check'
    return 'INFO', f'no problems in the last {WINDOW_HOURS} hours'


def build_brief(now=None):
    """The whole message, as a Chatbot custom notification."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    start = now - datetime.timedelta(hours=WINDOW_HOURS)

    components, manifest_unreadable = _components()
    totals = _totals(components, start, now) if components else {}
    broken, idle, healthy = _component_summary(components, totals)
    firing = _alarms_now()

    problems = len(broken) + len(firing)
    severity, sentence = _headline(problems, manifest_unreadable)
    title = f'[{ENV_LABEL}] [{severity}] Daily health check: {sentence}'

    lines = []
    if firing or broken:
        lines.append('*Needs attention*')
        # Named, not counted: "2 alarms firing" sends someone to a console to
        # find out which, which is the thing this is supposed to save.
        lines.extend(f"• [{item['severity']}] {item['headline']} (alert active now)"
                     for item in firing)
        lines.extend(
            f'• {label}: {_plural(errors, "error")} in {_plural(invocations, "run")}'
            f' ({purpose})'
            for label, invocations, errors, purpose in broken)
    if manifest_unreadable:
        lines.append('The list of things to check could not be read, so nothing below '
                     'was measured. Any alerts active right now are still listed above.')
    elif components:
        lines.append(f'*Ran normally:* {_plural(healthy, "component")}, no errors.')
        if idle:
            lines.append('*Did not run in the last 24 hours* (expected for features that '
                         'only run when a parent uses them):')
            lines.extend(f'• {label}: {purpose}' for label, purpose in idle)
        lines.append(f'Checked {_plural(len(components), "component")} for the '
                     f'{WINDOW_HOURS} hours to {now.hour:02d}:{now.minute:02d} UTC on '
                     f'{now.day} {_MONTHS[now.month]} {now.year}.')

    return {
        'version': '1.0',
        'source': 'custom',
        'content': {
            'textType': 'client-markdown',
            'title': title,
            'description': '\n'.join(lines) if lines else 'Nothing is configured to report.',
        },
        'metadata': {'summary': title},
    }


def lambda_handler(event, context):
    notification = build_brief()
    sns.publish(TopicArn=ALERT_TOPIC_ARN, Message=json.dumps(notification))
    print(f"Published daily brief: {notification['content']['title']}")
    return {'statusCode': 200}
