"""A once-a-day statement that the service is working, not just not alarming.

Alarms answer "did something break". They cannot answer "is anything still
happening", and those are different questions: a pipeline that stops being
invoked at all raises no errors, so every alarm stays green while nothing
works. The 2026-09-09 SMS outage was visible in exactly this way for hours
before any threshold moved.

So this reports positively. Every monitored component, whether it ran, how
often, and how many errors, plus a line about what each one is for so a reader
who did not build it can still tell whether "0 runs" is normal. Modelled on
the InnovateUS cron-monitoring brief, which works because the shape never
changes and "all green" is a claim someone actually made rather than an
absence of messages.

FERPA: every value here is a name, a count or a timestamp. Nothing is sourced
from a log message, a document or a request body, and nothing may be added
that is.
"""
import datetime
import json
import os

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
WINDOW_HOURS = 24

OK = ':white_check_mark:'
IDLE = ':zzz:'
PROBLEM = ':rotating_light:'
WARN = ':warning:'


def _components():
    """`(components, could_not_read)`.

    An unreadable manifest degrades to a brief that reports the firing alarms
    and nothing else, which is worse than the full brief but far better than
    no brief: silence is the one outcome this whole thing exists to remove.

    The second element exists because degrading quietly was worse than not
    degrading at all. With an empty manifest and nothing firing, this reported
    `all green (0 ran, 0 idle)` -- a green tick for a brief that had measured
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
    """Alarms currently firing, so the brief cannot claim green over a red."""
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
            firing.append(alarm['AlarmName'])
    return firing


def _component_lines(components, totals):
    lines, problems, ran, idle = [], 0, 0, 0
    # Problems first: a reader scanning on a phone should not have to pass
    # nine green lines to reach the one that matters.
    ordered = sorted(
        range(len(components)),
        key=lambda i: (totals[i][1] == 0, components[i]['label'].lower()),
    )
    for index in ordered:
        component = components[index]
        invocations, errors = totals[index]
        if errors:
            icon, problems = PROBLEM, problems + 1
        elif invocations:
            icon, ran = OK, ran + 1
        else:
            icon, idle = IDLE, idle + 1
        lines.append(
            f"{icon} {component['label']} — {invocations} runs, {errors} errors"
            f" · {component['purpose']}"
        )
    return lines, problems, ran, idle


def build_brief(now=None):
    """The whole message, as a Chatbot custom notification."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    start = now - datetime.timedelta(hours=WINDOW_HOURS)
    day = now.date().isoformat()
    env_label = 'prod' if IS_PROD else 'staging'

    components, manifest_unreadable = _components()
    totals = _totals(components, start, now) if components else {}
    lines, problems, ran, idle = _component_lines(components, totals)
    firing = _alarms_now()

    count = problems + len(firing)
    if count:
        # Problems lead, whether or not the manifest read. A firing alarm is
        # the thing someone has to act on.
        icon = WARN
        headline = f'A-IEP daily brief — {day} — {count} problem(s) in the last 24h'
    elif manifest_unreadable:
        # Never green. This brief checked nothing, and "all green" here would
        # be the most misleading line the channel can carry: a daily assurance
        # that nothing is wrong, issued by something that did not look.
        icon = WARN
        headline = f'A-IEP daily brief — {day} — could not read what it is meant to check'
    else:
        icon = OK
        headline = f'A-IEP daily brief — {day} — all green ({ran} ran, {idle} idle)'

    body = list(lines)
    if manifest_unreadable:
        body.append(
            'The list of things to check could not be read, so nothing below '
            'was measured. Any alarms firing right now are still listed.'
        )
    if firing:
        # Named, not counted: "2 alarms firing" sends someone to a console to
        # find out which, which is the thing this is supposed to save.
        body.append('')
        body.append('Alarms firing right now:')
        body.extend(f'{PROBLEM} {name}' for name in firing)

    return {
        'version': '1.0',
        'source': 'custom',
        'content': {
            'textType': 'client-markdown',
            'title': f'{icon} {headline} · {env_label}',
            'description': '\n'.join(body) if body else 'Nothing is configured to report.',
        },
    }


def lambda_handler(event, context):
    notification = build_brief()
    sns.publish(TopicArn=ALERT_TOPIC_ARN, Message=json.dumps(notification))
    print(f"Published daily brief: {notification['content']['title']}")
    return {'statusCode': 200}
