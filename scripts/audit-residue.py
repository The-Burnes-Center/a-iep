#!/usr/bin/env python3
"""
Audit an environment for pipeline residue: data that should have been cleaned
up and was not.

Every check here exists because the thing it looks for actually happened:

- An unredacted original survived a failed run for three weeks (a .doc that
  Mistral rejected with a 422, before RecordFailure purged artifacts).
- A noncurrent version of a raw upload outlived the 1-day lifecycle rule by two
  weeks, so the object was deleted but still retrievable.
- Account deletion swept only the userId/ prefix, stranding 19 redacted
  summaries in prod with no row pointing at them.
- A document row was written without a status and stayed that way, because the
  pipeline died between the upload handler's write and InitializeProcessing.
- An execution timeout runs no Catch, so RecordFailure never fires and the
  document sits at PROCESSING forever behind a spinner.

Read-only: this script never deletes or writes anything. It is safe to run
against prod. Pair it with recover-orphaned-documents.py, which is the tool
that actually fixes what this reports.

Usage:
    scripts/audit-residue.py --env staging
    scripts/audit-residue.py --env prod --json
    scripts/audit-residue.py --env staging --strict   # exit 1 on any error

PII discipline: prints ids, counts and timestamps only. Never object keys
(upload filenames carry student names), document content, or error bodies.
"""
import argparse
import json
import sys
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

REGION = 'us-east-1'

STACK_PREFIX = {'staging': 'AIEPStagingStack', 'prod': 'AIEPStack'}

# Kept explicit rather than derived from an environment label: interpolating a
# label into a durable resource name is what deleted half of prod's documents
# on 2026-06-22.
LIVE_BUCKET = {
    'staging': 'ai-iep-knowledge-source-dev',
    'prod': 'ai-iep-knowledge-source-prod',
}

DERIVED_PREFIXES = ('iep-data/', 'iep-audio/')
IN_FLIGHT = ('PROCESSING', 'PROCESSING_TRANSLATIONS')

# A run finishing in minutes is normal; MistralOCR alone can legitimately burn
# ~10 minutes on a big scan, and the ASL allows 4 attempts. 45 minutes means
# something is wedged, not slow.
STUCK_AFTER_MIN = 45
# The lifecycle rule is NoncurrentVersionExpiration: 1 day. S3 sweeps
# asynchronously, so allow generous slack before calling it a failure.
NONCURRENT_GRACE_DAYS = 3
# Long enough that a healthy row has certainly been given a status.
STATUSLESS_AFTER_MIN = 15
RECENT_FAILURE_HOURS = 24

ERROR, WARN = 'error', 'warn'


def now_utc():
    return datetime.now(timezone.utc)


def age_minutes(stamp, reference=None):
    """Minutes since an ISO stamp, or None if it cannot be parsed."""
    if not stamp:
        return None
    try:
        t = datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except ValueError:
        return None
    if t.tzinfo is None:  # the pipeline writes naive utcnow()
        t = t.replace(tzinfo=timezone.utc)
    return ((reference or now_utc()) - t).total_seconds() / 60


def find_one(names, *must_contain, forbid=()):
    """Resolve exactly one AWS resource name, or fail loudly."""
    matches = [
        n for n in names
        if all(frag in n for frag in must_contain)
        and not any(bad in n for bad in forbid)
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"expected exactly one resource matching {must_contain} "
            f"(excluding {forbid}), found {len(matches)}: {matches}"
        )
    return matches[0]


def discover(env, dynamodb, sfn):
    """Resolve this environment's table, bucket and state machine."""
    prefix = STACK_PREFIX[env]
    # Prod's resource names must not contain 'staging', or a prod audit would
    # silently read staging's data and report it clean.
    forbid = () if env == 'staging' else ('Staging', 'staging')

    table_names = []
    for page in dynamodb.meta.client.get_paginator('list_tables').paginate():
        table_names.extend(page['TableNames'])

    machines = []
    for page in sfn.get_paginator('list_state_machines').paginate():
        machines.extend((m['name'], m['stateMachineArn']) for m in page['stateMachines'])
    machine_names = [n for n, _ in machines]
    machine_name = find_one(machine_names, 'IEPProcessingStateMachine',
                            *(('staging',) if env == 'staging' else ()),
                            forbid=forbid)

    return {
        'documents_table': find_one(table_names, prefix, 'IepDocumentsTable', forbid=forbid),
        'bucket': LIVE_BUCKET[env],
        'state_machine': dict(machines)[machine_name],
    }


def scan_documents(dynamodb, table_name):
    """Every document row, metadata only. No content attributes are read."""
    table = dynamodb.Table(table_name)
    projection = ('iepId,childId,userId,createdAt,updated_at,#s,current_step,'
                  'contentS3Reference')
    items, start_key = [], None
    while True:
        kwargs = {'ProjectionExpression': projection,
                  'ExpressionAttributeNames': {'#s': 'status'}}
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        page = table.scan(**kwargs)
        items.extend(page.get('Items', []))
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            return items


def list_objects(s3, bucket):
    keys = []
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket):
        keys.extend(page.get('Contents', []))
    return keys


def list_versions(s3, bucket):
    versions, markers = [], []
    for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket):
        versions.extend(page.get('Versions', []))
        markers.extend(page.get('DeleteMarkers', []))
    return versions, markers


def iep_id_of(key):
    """The iepId segment of a derived-artifact key, or None.

    iep-data/{iepId}/{childId}/content.json
    iep-audio/{iepId}/{childId}/{lang}/{section}-{hash}.mp3
    """
    parts = key.split('/')
    return parts[1] if len(parts) > 2 else None


def raw_upload_iep_id(key):
    """The iepId segment of a raw-upload key: {userId}/{childId}/{iepId}/{file}.

    Returns the id only. The final segment is the uploaded filename, which
    carries the student's name, so it must never reach a log or Slack.
    """
    parts = key.split('/')
    return parts[2] if len(parts) > 3 else '(unrecognized key shape)'


def check_unredacted_originals(objects, findings):
    """Raw uploads still in the bucket.

    The pipeline deletes the original on success (DeleteOriginal) and on
    failure (RecordFailure's purge), so a steady state of anything above zero
    means a run did not finish either path.
    """
    raw = [o for o in objects if not o['Key'].startswith(DERIVED_PREFIXES)]
    findings.append({
        'check': 'unredacted_originals',
        'level': ERROR if raw else None,
        'count': len(raw),
        'detail': [raw_upload_iep_id(o['Key']) for o in raw][:10],
        'message': (f"{len(raw)} unredacted original(s) still in the bucket"
                    if raw else 'no unredacted originals in the bucket'),
    })


def stamp_of(value):
    """Normalize an S3 timestamp (str or datetime) to an ISO string."""
    return value if isinstance(value, str) else value.isoformat()


def check_stale_noncurrent_originals(versions, markers, findings, reference=None):
    """Deleted originals whose bytes outlived the 1-day expiry rule.

    The clock starts when the version became NONCURRENT, not when it was
    uploaded. Measuring from the version's own LastModified reports a
    just-deleted year-old document as a year overdue: purging prod on
    2026-08-10 immediately produced a bogus '26.8 days' finding for an object
    that had been noncurrent for seconds. The newest delete marker on the key
    is when it stopped being current, so that is the reference.
    """
    newest_marker = {}
    for m in markers or []:
        key, when = m['Key'], stamp_of(m['LastModified'])
        if when > newest_marker.get(key, ''):
            newest_marker[key] = when

    stale = []
    for v in versions:
        if v['Key'].startswith(DERIVED_PREFIXES) or v.get('IsLatest'):
            continue
        # Fall back to the version's own timestamp only when no marker exists
        # (superseded by a newer upload rather than deleted).
        became_noncurrent = newest_marker.get(v['Key']) or stamp_of(v['LastModified'])
        age = age_minutes(became_noncurrent, reference)
        if age is not None and age > NONCURRENT_GRACE_DAYS * 24 * 60:
            stale.append(round(age / 1440, 1))
    findings.append({
        'check': 'stale_noncurrent_originals',
        'level': ERROR if stale else None,
        'count': len(stale),
        'detail': sorted(stale, reverse=True)[:10],
        'message': (f"{len(stale)} deleted original(s) still retrievable past the "
                    f"{NONCURRENT_GRACE_DAYS}-day grace (ages in days)"
                    if stale else 'no overdue noncurrent originals'),
    })


def check_stuck_documents(docs, findings, reference=None):
    """In-flight documents that stopped moving.

    Idle time comes from updated_at, not createdAt: a re-translation of an old
    document re-enters an in-flight status with a createdAt weeks in the past.
    """
    stuck = []
    for d in docs:
        if d.get('status') not in IN_FLIGHT:
            continue
        idle = age_minutes(d.get('updated_at'), reference)
        if idle is not None and idle > STUCK_AFTER_MIN:
            stuck.append({'iepId': d['iepId'], 'idleMin': round(idle),
                          'step': d.get('current_step', '?')})
    findings.append({
        'check': 'stuck_documents',
        'level': ERROR if stuck else None,
        'count': len(stuck),
        'detail': stuck[:10],
        'message': (f"{len(stuck)} document(s) in flight with no progress for "
                    f"over {STUCK_AFTER_MIN}m"
                    if stuck else 'no stuck documents'),
    })


def check_statusless_documents(docs, findings, reference=None):
    """Rows that never got a status.

    The upload handler writes the row, then InitializeProcessing writes the
    status. A row still statusless well past that window means the pipeline
    died in between, and nothing will ever move it.
    """
    orphaned = []
    for d in docs:
        if d.get('status'):
            continue
        created = d.get('createdAt')
        if created is None:
            orphaned.append(d['iepId'])
            continue
        age = ((reference or now_utc()).timestamp() - float(created)) / 60
        if age > STATUSLESS_AFTER_MIN:
            orphaned.append(d['iepId'])
    findings.append({
        'check': 'statusless_documents',
        'level': WARN if orphaned else None,
        'count': len(orphaned),
        'detail': orphaned[:10],
        'message': (f"{len(orphaned)} row(s) never received a status"
                    if orphaned else 'every row has a status'),
    })


def check_orphaned_artifacts(objects, docs, findings):
    """Derived artifacts whose document row is gone.

    Account deletion used to sweep only the userId/ prefix, so the redacted
    summary and cached audio outlived the account that owned them.
    """
    live = {d['iepId'] for d in docs}
    data, audio = set(), set()
    for o in objects:
        key = o['Key']
        target = data if key.startswith('iep-data/') else audio if key.startswith('iep-audio/') else None
        if target is not None:
            found = iep_id_of(key)
            if found:
                target.add(found)
    orphan_data, orphan_audio = sorted(data - live), sorted(audio - live)
    total = len(orphan_data) + len(orphan_audio)
    findings.append({
        'check': 'orphaned_artifacts',
        'level': WARN if total else None,
        'count': total,
        'detail': {'content': orphan_data[:10], 'audio': orphan_audio[:10]},
        'message': (f"{len(orphan_data)} content and {len(orphan_audio)} audio "
                    'directory(ies) outlive their document row'
                    if total else 'no orphaned derived artifacts'),
    })


def check_recent_failures(docs, findings, reference=None):
    """Documents that failed in the last day. Informational, not a defect."""
    recent = []
    for d in docs:
        if d.get('status') != 'FAILED':
            continue
        age = age_minutes(d.get('updated_at'), reference)
        if age is not None and age < RECENT_FAILURE_HOURS * 60:
            recent.append({'iepId': d['iepId'], 'agoMin': round(age)})
    findings.append({
        'check': 'recent_failures',
        'level': WARN if recent else None,
        'count': len(recent),
        'detail': recent[:10],
        'message': (f"{len(recent)} document(s) failed in the last "
                    f"{RECENT_FAILURE_HOURS}h"
                    if recent else f'no failures in the last {RECENT_FAILURE_HOURS}h'),
    })


def check_long_running_executions(sfn, machine_arn, findings, reference=None):
    """Executions running far past any legitimate duration.

    An execution timeout runs no Catch, so RecordFailure never fires: the
    document stays PROCESSING and only this and the ExecutionsTimedOut metric
    will ever show it.
    """
    long_running = []
    try:
        for page in sfn.get_paginator('list_executions').paginate(
                stateMachineArn=machine_arn, statusFilter='RUNNING'):
            for e in page.get('executions', []):
                start = e['startDate']
                age = age_minutes(start if isinstance(start, str) else start.isoformat(),
                                  reference)
                if age is not None and age > STUCK_AFTER_MIN:
                    long_running.append({'name': e['name'], 'runningMin': round(age)})
    except ClientError as err:
        findings.append({
            'check': 'long_running_executions', 'level': WARN, 'count': 0,
            'detail': [], 'message': f'could not list executions ({err.response["Error"]["Code"]})',
        })
        return
    findings.append({
        'check': 'long_running_executions',
        'level': ERROR if long_running else None,
        'count': len(long_running),
        'detail': long_running[:10],
        'message': (f"{len(long_running)} execution(s) running over {STUCK_AFTER_MIN}m"
                    if long_running else 'no long-running executions'),
    })


def audit(env, dynamodb=None, s3=None, sfn=None, reference=None):
    """Run every check. Returns the findings list; performs no writes."""
    dynamodb = dynamodb or boto3.resource('dynamodb', region_name=REGION)
    s3 = s3 or boto3.client('s3', region_name=REGION)
    sfn = sfn or boto3.client('stepfunctions', region_name=REGION)

    res = discover(env, dynamodb, sfn)
    docs = scan_documents(dynamodb, res['documents_table'])
    objects = list_objects(s3, res['bucket'])
    versions, markers = list_versions(s3, res['bucket'])

    findings = []
    check_unredacted_originals(objects, findings)
    check_stale_noncurrent_originals(versions, markers, findings, reference)
    check_stuck_documents(docs, findings, reference)
    check_statusless_documents(docs, findings, reference)
    check_orphaned_artifacts(objects, docs, findings)
    check_recent_failures(docs, findings, reference)
    check_long_running_executions(sfn, res['state_machine'], findings, reference)
    return findings


def render(env, findings):
    """Human/Slack-readable summary. Clean checks collapse to one line."""
    flagged = [f for f in findings if f['level']]
    lines = []
    if not flagged:
        lines.append(f"No residue in {env}: all {len(findings)} checks clean.")
    else:
        for f in flagged:
            icon = ':rotating_light:' if f['level'] == ERROR else ':warning:'
            lines.append(f"{icon} {f['message']}")
            if f['detail']:
                lines.append(f"    {json.dumps(f['detail'], default=str)}")
        clean = len(findings) - len(flagged)
        lines.append(f"({clean} of {len(findings)} checks clean)")
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', required=True, choices=('staging', 'prod'))
    parser.add_argument('--json', action='store_true',
                        help='emit machine-readable findings on stdout')
    parser.add_argument('--strict', action='store_true',
                        help='exit 1 when any check is at error level')
    args = parser.parse_args()

    findings = audit(args.env)

    if args.json:
        print(json.dumps({'env': args.env, 'findings': findings}, default=str))
    else:
        print(render(args.env, findings))

    if args.strict and any(f['level'] == ERROR for f in findings):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
