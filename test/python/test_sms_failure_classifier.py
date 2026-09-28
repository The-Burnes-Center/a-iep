"""The SMS failure classifier: which environment an undelivered code belongs to.

The delivery log is account-wide and carries no sender, so the only thing
that makes the per-environment alarm mean anything is this lookup. These
assert the persisted metric (what the alarm reads), not the calls made.

The logs client is a fake rather than moto, because what matters is the
contract with FilterLogEvents (the pattern, the window, pagination, the
errors it raises) and moto's filter-pattern matching is not CloudWatch's.
CloudWatch itself is moto, so the metric is really written and read back.
"""
import base64
import datetime
import gzip
import json

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from conftest import load_lambda_module, unload

ALIAS = 'sms_failure_classifier_under_test'

PROD_SENDER = '/aws/lambda/AIEPStack-CreateAuthChallenge-abc'
STAGING_SENDERS = [
    '/aws/lambda/AIEPStagingStack-CreateAuthChallenge-def',
    '/aws/lambda/AIEPStagingStack-CustomSmsSender-ghi',
]

PROD_ID = '11111111-2222-5333-8444-555555555555'
STAGING_ID = '66666666-7777-5888-9999-aaaaaaaaaaaa'
NOBODYS_ID = 'bbbbbbbb-cccc-5ddd-8eee-ffffffffffff'

PUBLISHED = datetime.datetime(2026, 9, 9, 19, 2, 4, 541000, tzinfo=datetime.timezone.utc)
PUBLISHED_MS = int(PUBLISHED.timestamp() * 1000)


class FakeLogs:
    """FilterLogEvents over in-memory sender logs, with its real pattern syntax.

    Understands exactly the shape the handler sends (`?"id" ?"id"`), and
    records every call so a test can check the window it searched.
    """

    def __init__(self, groups, page_size=50, error=None):
        # {log_group: [(timestamp_ms, message)]}
        self.groups = groups
        self.page_size = page_size
        self.error = error
        self.calls = []

    def filter_log_events(self, logGroupName, startTime, endTime, filterPattern, nextToken=None):
        self.calls.append({'group': logGroupName, 'start': startTime,
                           'end': endTime, 'pattern': filterPattern})
        if self.error:
            raise self.error
        terms = [t.strip('?"') for t in filterPattern.split()]
        hits = [
            {'timestamp': ts, 'message': message}
            for ts, message in self.groups.get(logGroupName, [])
            if startTime <= ts <= endTime and any(term in message for term in terms)
        ]
        offset = int(nextToken or 0)
        page = {'events': hits[offset:offset + self.page_size]}
        if offset + self.page_size < len(hits):
            page['nextToken'] = str(offset + self.page_size)
        return page


def _sender_line(message_id):
    return f'SMS sent successfully. MessageId: {message_id}'


def _record(message_id, provider='Unknown error attempting to reach phone',
            destination='+15555550100', status='FAILURE', published=PUBLISHED):
    return json.dumps({
        'notification': {
            'messageId': message_id,
            'timestamp': published.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3],
        },
        'delivery': {
            'destination': destination,
            'smsType': 'Transactional',
            'providerResponse': provider,
            'dwellTimeMs': 29,
        },
        'status': status,
    })


def _event(*records, logged_ms=PUBLISHED_MS + 1_000, message_type='DATA_MESSAGE'):
    payload = {
        'messageType': message_type,
        'logGroup': 'sns/us-east-1/123456789012/DirectPublishToPhoneNumber/Failure',
        'logEvents': [
            {'id': str(i), 'timestamp': logged_ms, 'message': record}
            for i, record in enumerate(records)
        ],
    }
    data = base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode()
    return {'awslogs': {'data': data}}


def _load(monkeypatch, environment, senders, alias):
    monkeypatch.setenv('ENVIRONMENT', environment)
    monkeypatch.setenv('SENDER_LOG_GROUPS', ','.join(senders))
    monkeypatch.setenv('METRIC_NAMESPACE', 'AI-IEP/Auth')
    monkeypatch.setenv('COGNITO_SMS_VALIDATION_NUMBER', '+12064350128')
    monkeypatch.setenv('SMS_QUOTA_PROVIDER_RESPONSE', 'No quota left for account')
    return load_lambda_module('sms-failure-classifier', alias, module_name='handler')


# Both environments' sender logs, as they would exist in the shared account.
ACCOUNT_LOGS = {
    PROD_SENDER: [(PUBLISHED_MS, _sender_line(PROD_ID))],
    STAGING_SENDERS[0]: [(PUBLISHED_MS, 'unrelated line')],
    STAGING_SENDERS[1]: [(PUBLISHED_MS, f'SMS sent successfully (source: x). MessageId: {STAGING_ID}')],
}


@pytest.fixture
def prod(monkeypatch):
    with mock_aws():
        module = _load(monkeypatch, 'prod', [PROD_SENDER], ALIAS + '_prod')
        module._logs = FakeLogs(ACCOUNT_LOGS)
        yield module
    unload(ALIAS + '_prod')


@pytest.fixture
def staging(monkeypatch):
    with mock_aws():
        module = _load(monkeypatch, 'dev', STAGING_SENDERS, ALIAS + '_staging')
        module._logs = FakeLogs(ACCOUNT_LOGS)
        yield module
    unload(ALIAS + '_staging')


def _counted(module, environment):
    """What the alarm would read: SmsDeliveryFailed{Environment} summed."""
    stats = module._cloudwatch.get_metric_statistics(
        Namespace='AI-IEP/Auth',
        MetricName='SmsDeliveryFailed',
        Dimensions=[{'Name': 'Environment', 'Value': environment}],
        StartTime=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1),
        EndTime=datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        Period=3600,
        Statistics=['Sum'],
    )
    return sum(point['Sum'] for point in stats['Datapoints'])


# ---------------------------------------------------------------------------
# Attribution.
# ---------------------------------------------------------------------------

def test_a_failure_production_sent_is_counted_by_production(prod):
    result = prod.lambda_handler(_event(_record(PROD_ID)), None)

    assert result == {'counted': 1, 'elsewhere': 0}
    assert _counted(prod, 'prod') == 1


def test_a_failure_staging_sent_is_counted_by_staging_not_production(prod, staging):
    """The bug this exists for: production paged for staging's codes."""
    event = _event(_record(STAGING_ID))

    assert prod.lambda_handler(event, None) == {'counted': 0, 'elsewhere': 1}
    assert staging.lambda_handler(event, None) == {'counted': 1, 'elsewhere': 0}
    assert _counted(staging, 'dev') == 1
    # Nothing written under production's dimension by either of them.
    assert _counted(prod, 'prod') == 0


def test_staging_does_not_count_a_production_failure(staging):
    assert staging.lambda_handler(_event(_record(PROD_ID)), None) == {'counted': 0, 'elsewhere': 1}
    assert _counted(staging, 'dev') == 0


def test_a_failure_nobody_here_sent_is_counted_by_nobody(prod, staging, capsys):
    """Another project in the account, or Cognito texting on its own."""
    event = _event(_record(NOBODYS_ID))

    assert prod.lambda_handler(event, None) == {'counted': 0, 'elsewhere': 1}
    assert staging.lambda_handler(event, None) == {'counted': 0, 'elsewhere': 1}
    assert _counted(prod, 'prod') == 0
    assert _counted(staging, 'dev') == 0
    # Not silent: the id is logged, so a miss can be traced.
    assert f'SMS_FAILURE_NOT_OURS env=prod messageId={NOBODYS_ID}' in capsys.readouterr().out


def test_a_mixed_batch_counts_only_its_own(prod):
    event = _event(_record(PROD_ID), _record(STAGING_ID), _record(NOBODYS_ID))

    assert prod.lambda_handler(event, None) == {'counted': 1, 'elsewhere': 2}
    assert _counted(prod, 'prod') == 1


def test_the_window_is_anchored_on_the_publish_not_the_log_time(prod):
    """SNS logged three 2026-09-09 attack failures 72 hours after the send.

    A window around the log time finds nothing; this is the regression pin
    for the version of this lambda that did exactly that.
    """
    late = PUBLISHED_MS + 72 * 3600 * 1000

    result = prod.lambda_handler(_event(_record(PROD_ID), logged_ms=late), None)

    assert result['counted'] == 1
    call = prod._logs.calls[0]
    assert call['start'] <= PUBLISHED_MS <= call['end']
    assert call['end'] < late


def test_lookups_are_batched_and_follow_pagination(monkeypatch):
    """A burst is one query per sender per 20 ids, not one per record.

    FilterLogEvents is rate-limited account-wide and both stacks share it;
    one call per failure is how a cap outage would throttle this into
    counting nothing.
    """
    with mock_aws():
        module = _load(monkeypatch, 'prod', [PROD_SENDER], ALIAS + '_batch')
        ids = [f'{i:08x}-2222-5333-8444-555555555555' for i in range(25)]
        # Page size 1 forces the handler to follow nextToken to find them all.
        module._logs = FakeLogs({PROD_SENDER: [(PUBLISHED_MS, _sender_line(m)) for m in ids]},
                                page_size=1)
        try:
            result = module.lambda_handler(_event(*[_record(m) for m in ids]), None)

            assert result == {'counted': 25, 'elsewhere': 0}
            assert _counted(module, 'prod') == 25
            patterns = {c['pattern'] for c in module._logs.calls}
            assert len(patterns) == 2  # 20 + 5
            assert all(len(p) <= 1024 for p in patterns)
        finally:
            unload(ALIAS + '_batch')


# ---------------------------------------------------------------------------
# What is not this lambda's to count.
# ---------------------------------------------------------------------------

def test_the_spend_cap_is_left_to_the_account_wide_filter(prod):
    """The cap is account-wide: it is counted once, by a metric filter.

    Attributing it would also cost a lookup per record exactly when records
    arrive in the hundreds.
    """
    result = prod.lambda_handler(_event(_record(PROD_ID, provider='No quota left for account')), None)

    assert result == {'counted': 0, 'elsewhere': 0}
    assert prod._logs.calls == []
    assert _counted(prod, 'prod') == 0


def test_cognitos_validation_number_is_not_a_parent(prod):
    result = prod.lambda_handler(_event(_record(PROD_ID, destination='+12064350128')), None)

    assert result == {'counted': 0, 'elsewhere': 0}
    assert prod._logs.calls == []


def test_a_success_record_is_ignored(prod):
    result = prod.lambda_handler(_event(_record(PROD_ID, status='SUCCESS')), None)

    assert result == {'counted': 0, 'elsewhere': 0}


def test_the_subscription_control_message_is_ignored(prod):
    assert prod.lambda_handler(_event(message_type='CONTROL_MESSAGE'), None) == {
        'counted': 0, 'elsewhere': 0}


def test_a_malformed_id_never_reaches_a_filter_pattern(prod, capsys):
    """The record comes from a log group anything in the account can write."""
    hostile = 'x" ?"'
    result = prod.lambda_handler(_event(_record(hostile), 'not json'), None)

    assert result == {'counted': 0, 'elsewhere': 0}
    assert prod._logs.calls == []
    assert capsys.readouterr().out.count('SMS_FAILURE_UNPARSEABLE') == 2


# ---------------------------------------------------------------------------
# Failure of the lookup itself.
# ---------------------------------------------------------------------------

def test_a_failed_lookup_is_logged_and_counted_rather_than_dropped(prod, capsys):
    """Over-counting pages someone; under-counting is a silent alarm."""
    prod._logs = FakeLogs(ACCOUNT_LOGS, error=ClientError(
        {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
        'FilterLogEvents'))

    result = prod.lambda_handler(_event(_record(NOBODYS_ID)), None)

    assert result == {'counted': 1, 'elsewhere': 0}
    assert _counted(prod, 'prod') == 1
    out = capsys.readouterr().out
    assert f'SMS_ATTRIBUTION_FAILED env=prod error=ClientError messageIds={NOBODYS_ID}' in out


def test_no_line_ever_carries_the_destination(prod, staging, capsys):
    """The delivery record holds a parent's phone number. It must not leak."""
    number = '+15555550199'
    event = _event(_record(PROD_ID, destination=number), _record(NOBODYS_ID, destination=number))
    prod.lambda_handler(event, None)
    staging.lambda_handler(event, None)
    prod._logs = FakeLogs({}, error=RuntimeError(number))
    prod.lambda_handler(event, None)

    out = capsys.readouterr().out
    assert number not in out
    assert '5555550199' not in out


def test_it_refuses_to_start_with_no_senders(monkeypatch):
    """No senders means every failure is "not ours" and the alarm never fires."""
    with mock_aws():
        with pytest.raises(RuntimeError):
            _load(monkeypatch, 'prod', [], ALIAS + '_empty')
    unload(ALIAS + '_empty')
