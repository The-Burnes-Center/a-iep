"""Count an undelivered SMS against the environment that sent it.

SNS delivery-status logging writes every failed direct publish to one
account-wide log group, shared by staging, production and anything else in
the account that texts. The record carries `notification.messageId` and no
sender, so a metric filter on it can only count the account. That paged
production for staging's codes and gave staging no signal about its own.

Both A-IEP senders log the MessageId SNS returned when they published
(create-auth-challenge, and staging's custom-sms-sender). So for each failed
record this looks the id up in THIS environment's sender log groups, and
counts it only if it is there:

    Failure log group -> subscription filter -> this -> SmsDeliveryFailed{Environment}

Each stack runs its own copy, reading only its own senders' logs.

The subscription filter already drops the spend cap ("No quota left") and
Cognito's validation number. They are checked again here so the counting
rule lives in code that has tests, not only in a filter string.

FERPA and privacy: a delivery record contains the destination phone number.
Nothing here logs it, or any message content. Log lines carry the messageId
and the environment, and nothing else from the record.
"""
import base64
import datetime
import gzip
import json
import os
import re

import boto3
from botocore.config import Config

ENVIRONMENT = os.environ['ENVIRONMENT']
SENDER_LOG_GROUPS = [g for g in os.environ.get('SENDER_LOG_GROUPS', '').split(',') if g]
# With no senders to search, every failure would be "not ours" and the alarm
# would sit green forever. Refuse to start instead, which the Errors alarm
# on this function does see.
if not SENDER_LOG_GROUPS:
    raise RuntimeError('SENDER_LOG_GROUPS is empty: nothing to attribute failures against')
METRIC_NAMESPACE = os.environ.get('METRIC_NAMESPACE', 'AI-IEP/Auth')
COGNITO_SMS_VALIDATION_NUMBER = os.environ.get('COGNITO_SMS_VALIDATION_NUMBER', '')
SMS_QUOTA_PROVIDER_RESPONSE = os.environ.get(
    'SMS_QUOTA_PROVIDER_RESPONSE', 'No quota left for account')

# How far either side of the PUBLISH time to look for the send. The sender
# logs the id the instant Publish returns, and `notification.timestamp` is
# SNS's record of that same moment, so they are normally within a second;
# ten minutes covers clock skew and a slow sender with room to spare.
LOOKUP_WINDOW_MS = 10 * 60 * 1000

# `notification.timestamp`, e.g. "2026-09-09 19:02:04.541", in UTC.
#
# Anchoring on this and not on the log event's own timestamp is load-bearing.
# SNS writes the FAILURE record when the carrier gives up, which can be days
# later: three records from the 2026-09-09 attack were published at 19:02
# and logged on 2026-09-12, 72 hours on. A window around the log time missed
# every one of them; a window around the publish time finds all three.
_PUBLISH_TIME_FORMAT = '%Y-%m-%d %H:%M:%S.%f'

# FilterLogEvents caps a filter pattern at 1024 characters. Each id costs 40
# (`?"<36-char uuid>" `), so 20 per query stays well inside it.
IDS_PER_QUERY = 20

# Only a well-formed SNS id is ever put into a filter pattern. The record is
# data from a log group anything in the account can write to, and a quote in
# it would otherwise rewrite the query.
_MESSAGE_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

# FilterLogEvents is rate-limited per account and both stacks share it. A cap
# outage delivers failures in the hundreds, so back off rather than fail.
_logs = boto3.client('logs', config=Config(retries={'mode': 'adaptive', 'max_attempts': 8}))
_cloudwatch = boto3.client('cloudwatch')


def _decode(event):
    """The CloudWatch Logs subscription payload: base64, gzipped JSON."""
    raw = base64.b64decode(event['awslogs']['data'])
    return json.loads(gzip.decompress(raw))


def _counted_failures(log_events):
    """`[(messageId, timestamp_ms)]` for the records that may be ours.

    Skips everything that is not a delivery failure a parent experienced:
    successes, the spend cap (counted account-wide elsewhere) and Cognito's
    validation number (not a parent). A record that does not parse, or has
    an id that is not an SNS id, is skipped and said so.
    """
    failures = []
    for log_event in log_events:
        try:
            record = json.loads(log_event.get('message') or '')
        except ValueError:
            print(f'SMS_FAILURE_UNPARSEABLE env={ENVIRONMENT} id={log_event.get("id")}')
            continue
        if not isinstance(record, dict) or record.get('status') != 'FAILURE':
            continue
        delivery = record.get('delivery') or {}
        if COGNITO_SMS_VALIDATION_NUMBER and delivery.get('destination') == COGNITO_SMS_VALIDATION_NUMBER:
            continue
        if str(delivery.get('providerResponse') or '').startswith(SMS_QUOTA_PROVIDER_RESPONSE):
            continue
        message_id = str((record.get('notification') or {}).get('messageId') or '')
        if not _MESSAGE_ID.match(message_id):
            print(f'SMS_FAILURE_UNPARSEABLE env={ENVIRONMENT} id={log_event.get("id")}')
            continue
        failures.append((message_id, _published_ms(record, log_event)))
    return failures


def _published_ms(record, log_event):
    """When SNS accepted the publish, in epoch ms. See _PUBLISH_TIME_FORMAT.

    Falls back to the log event's time if the field is missing or reshaped,
    which finds a prompt failure and misses a late one: worse, but not
    silent, since the miss is logged as SMS_FAILURE_NOT_OURS with its id.
    """
    raw = str((record.get('notification') or {}).get('timestamp') or '')
    try:
        published = datetime.datetime.strptime(raw, _PUBLISH_TIME_FORMAT)
    except ValueError:
        return int(log_event.get('timestamp') or 0)
    return int(published.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def _search(log_group, message_ids, start_ms, end_ms):
    """The subset of `message_ids` that appears in `log_group`."""
    pattern = ' '.join(f'?"{message_id}"' for message_id in message_ids)
    found = set()
    kwargs = {
        'logGroupName': log_group,
        'startTime': start_ms,
        'endTime': end_ms,
        'filterPattern': pattern,
    }
    while True:
        page = _logs.filter_log_events(**kwargs)
        for log_event in page.get('events', []):
            text = log_event.get('message') or ''
            found.update(m for m in message_ids if m in text)
        token = page.get('nextToken')
        # FilterLogEvents can return an empty page with a token; follow it.
        if not token or found.issuperset(message_ids):
            return found
        kwargs['nextToken'] = token


def _ours(failures):
    """The ids among `failures` that this environment sent.

    A lookup that errors counts its ids as ours. That can over-count, and the
    other stack may count the same record; it cannot hide an outage. Over-
    counting pages someone who then finds nothing. Under-counting is an alarm
    that stays green through the thing it watches, which is the worse way
    to be wrong.
    """
    # Chunked in publish order, each chunk searching only its own time span,
    # so one late record in a batch does not stretch every query to days.
    by_time = sorted(failures, key=lambda failure: failure[1])
    ours = set()
    for offset in range(0, len(by_time), IDS_PER_QUERY):
        batch = by_time[offset:offset + IDS_PER_QUERY]
        chunk = sorted({message_id for message_id, _ in batch})
        start_ms = batch[0][1] - LOOKUP_WINDOW_MS
        end_ms = batch[-1][1] + LOOKUP_WINDOW_MS
        for log_group in SENDER_LOG_GROUPS:
            remaining = [m for m in chunk if m not in ours]
            if not remaining:
                break
            try:
                ours |= _search(log_group, remaining, start_ms, end_ms)
            except Exception as error:  # noqa: BLE001 - see docstring
                print(f'SMS_ATTRIBUTION_FAILED env={ENVIRONMENT} '
                      f'error={type(error).__name__} messageIds={",".join(remaining)}')
                ours |= set(remaining)
    return ours


def lambda_handler(event, context):
    payload = _decode(event)
    # CloudWatch Logs sends one CONTROL_MESSAGE when the subscription is
    # created, to check the destination is reachable. Nothing to count.
    if payload.get('messageType') != 'DATA_MESSAGE':
        return {'counted': 0, 'elsewhere': 0}

    failures = _counted_failures(payload.get('logEvents') or [])
    ours = _ours(failures)

    counted = 0
    elsewhere = 0
    for message_id, _ in failures:
        if message_id in ours:
            counted += 1
            print(f'SMS_FAILURE_ATTRIBUTED env={ENVIRONMENT} messageId={message_id}')
        else:
            elsewhere += 1
            print(f'SMS_FAILURE_NOT_OURS env={ENVIRONMENT} messageId={message_id}')

    if counted:
        # Deliberately not caught. If this fails the lambda errors, its
        # Errors alarm fires, and Lambda retries the batch: nothing above has
        # a side effect a retry would repeat.
        _cloudwatch.put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[{
                'MetricName': 'SmsDeliveryFailed',
                'Dimensions': [{'Name': 'Environment', 'Value': ENVIRONMENT}],
                'Value': counted,
                'Unit': 'Count',
            }],
        )
    return {'counted': counted, 'elsewhere': elsewhere}
