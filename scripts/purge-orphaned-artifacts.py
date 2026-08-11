#!/usr/bin/env python3
"""
Delete pipeline residue that audit-residue.py reports: FERPA-protected data
that outlived the record pointing at it.

Two target classes, both reported separately and purgeable independently:

  orphans   Derived artifacts (iep-data/{iepId}/..., iep-audio/{iepId}/...)
            with no row in the documents table. Nothing in the app can reach
            them; they are retained PII and nothing else. Created by the two
            delete paths that swept only the {userId}/ prefix (fixed in
            4d56e0b for account/child deletion and in the upload replace path).

  originals Unredacted uploaded documents still in the bucket. The pipeline
            deletes these on success (DeleteOriginal) and on failure
            (RecordFailure's purge), so any that remain predate those fixes.
            These are the highest-sensitivity objects in the system: the raw
            IEP, unredacted, with the student's name in the key.

Dry run is the default. Nothing is deleted without --apply.

Usage:
    scripts/purge-orphaned-artifacts.py --env staging
    scripts/purge-orphaned-artifacts.py --env staging --apply
    scripts/purge-orphaned-artifacts.py --env prod --targets originals --apply
    scripts/purge-orphaned-artifacts.py --env prod --limit 3 --apply

Recoverability: both buckets are versioned, so a delete writes a delete marker
and the bytes survive as a noncurrent version until the lifecycle rule expires
them. That window is the safety net, and it is not infinite: plan on hours,
not days, and verify before assuming a mistake can be undone.

PII discipline: prints iepIds, counts and sizes. Never object keys for raw
uploads (the final segment is the uploaded filename, which carries the
student's name) and never document content.
"""
import argparse
import sys

import boto3
from botocore.exceptions import ClientError

REGION = 'us-east-1'

STACK_PREFIX = {'staging': 'AIEPStagingStack', 'prod': 'AIEPStack'}
LIVE_BUCKET = {
    'staging': 'ai-iep-knowledge-source-dev',
    'prod': 'ai-iep-knowledge-source-prod',
}
DERIVED_PREFIXES = ('iep-data/', 'iep-audio/')

dynamodb = boto3.resource('dynamodb', region_name=REGION)
s3 = boto3.client('s3', region_name=REGION)


def find_one(names, *must_contain, forbid=()):
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


def discover(env):
    prefix = STACK_PREFIX[env]
    # Prod names must not contain 'staging', or a prod run could delete from
    # staging (or, far worse, judge prod objects against staging's rows).
    forbid = () if env == 'staging' else ('Staging', 'staging')
    names = []
    for page in dynamodb.meta.client.get_paginator('list_tables').paginate():
        names.extend(page['TableNames'])
    return {
        'documents_table': find_one(names, prefix, 'IepDocumentsTable', forbid=forbid),
        'bucket': LIVE_BUCKET[env],
    }


def scan_document_rows(table_name):
    """Every (iepId, childId, status, documentUrl). Metadata only."""
    table = dynamodb.Table(table_name)
    rows, start_key = [], None
    while True:
        kwargs = {'ProjectionExpression': 'iepId,childId,#s,documentUrl,contentS3Reference',
                  'ExpressionAttributeNames': {'#s': 'status'}}
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        page = table.scan(**kwargs)
        rows.extend(page.get('Items', []))
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            return rows


def list_all(bucket):
    keys = []
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket):
        keys.extend(page.get('Contents', []))
    return keys


HIGH_RATIO = 0.75


def group_orphans(objects, rows, allow_high_ratio=False):
    """Derived-artifact keys grouped by iepId, for iepIds with no row.

    Guarded, because this function feeds a delete. An empty or failed table
    scan would otherwise make every artifact in the bucket look orphaned.
    """
    live = {r['iepId'] for r in rows}
    if not live:
        # Never bypassable: an empty scan is always a broken read, never a
        # bucket where every single document genuinely lost its row.
        raise SystemExit(
            'the documents table returned no rows at all; refusing to treat '
            'every artifact in the bucket as orphaned'
        )

    # The authoritative pointer is contentS3Reference, not the iepId embedded
    # in the key. A live row whose reference points at some other iepId's path
    # would look orphaned by key alone, and deleting it would blank a real
    # family's summary. Recovering from the 2026-06-22 bucket loss rewrote
    # these pointers, so a row and its content path need not agree.
    referenced = {
        (r.get('contentS3Reference') or {}).get('s3Key')
        for r in rows
        if (r.get('contentS3Reference') or {}).get('s3Key')
    }

    by_iep = {}
    for o in objects:
        key = o['Key']
        if not key.startswith(DERIVED_PREFIXES):
            continue
        parts = key.split('/')
        if len(parts) < 3:
            continue
        by_iep.setdefault(parts[1], []).append((key, o['Size']))

    orphans = {}
    for iep_id, items in by_iep.items():
        if iep_id in live:
            continue
        kept = [(k, size) for k, size in items if k not in referenced]
        if len(kept) != len(items):
            print(f"  keeping {len(items) - len(kept)} object(s) under {iep_id}: "
                  'still referenced by a live row')
        if kept:
            orphans[iep_id] = kept

    # Second guard: in prod, residue is a backlog of stragglers, so nearly
    # everything looking orphaned means the comparison is wrong rather than the
    # data. Staging legitimately trips this (it is mostly test residue: 40 of
    # 50 groups on 2026-08-10), so it is overridable, but only deliberately.
    # Never widen the threshold to make a run pass; confirm the numbers and
    # pass the flag.
    if by_iep and len(orphans) > len(by_iep) * HIGH_RATIO and not allow_high_ratio:
        raise SystemExit(
            f'{len(orphans)} of {len(by_iep)} artifact groups look orphaned '
            f'({len(orphans) / len(by_iep):.0%}, over the {HIGH_RATIO:.0%} guard). '
            'That is either real (staging, which is mostly residue) or a broken '
            'comparison. Check the table name and row count printed above, then '
            're-run with --allow-high-orphan-ratio if it is real.'
        )
    return orphans


def find_leftover_originals(objects, rows):
    """Raw uploads still present, annotated with their row's status.

    Reported by iepId. The key's final segment is the uploaded filename and
    must not be printed.
    """
    status_by_iep = {r['iepId']: (r.get('status') or 'NO_STATUS') for r in rows}
    leftovers = []
    for o in objects:
        key = o['Key']
        if key.startswith(DERIVED_PREFIXES):
            continue
        parts = key.split('/')
        iep_id = parts[2] if len(parts) > 3 else '(unrecognized key shape)'
        leftovers.append({
            'iepId': iep_id,
            'key': key,  # never printed; needed for the delete call
            'size': o['Size'],
            'rowStatus': status_by_iep.get(iep_id, '(no row)'),
        })
    return leftovers


def delete_keys(bucket, keys):
    """Delete up to 1000 keys per call, then verify each one is gone."""
    deleted, failed = 0, []
    for chunk_start in range(0, len(keys), 1000):
        chunk = keys[chunk_start:chunk_start + 1000]
        response = s3.delete_objects(
            Bucket=bucket, Delete={'Objects': [{'Key': k} for k in chunk]})
        deleted += len(response.get('Deleted', []))
        for err in response.get('Errors', []):
            failed.append((err.get('Key'), err.get('Code')))

    # Verify rather than trust the response: this is the step that makes a
    # partial failure visible instead of silently reported as success.
    still_there = []
    for key in keys:
        try:
            s3.head_object(Bucket=bucket, Key=key)
            still_there.append(key)
        except ClientError as e:
            if e.response['Error']['Code'] not in ('404', 'NoSuchKey'):
                raise
    return deleted, failed, still_there


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', required=True, choices=('staging', 'prod'))
    parser.add_argument('--targets', default='all',
                        choices=('all', 'orphans', 'originals'))
    parser.add_argument('--apply', action='store_true',
                        help='actually delete (default is a dry run)')
    parser.add_argument('--limit', type=int,
                        help='only act on the first N groups/objects')
    parser.add_argument('--allow-high-orphan-ratio', action='store_true',
                        help='proceed when most artifact groups look orphaned '
                             '(true for staging; verify the row count first)')
    args = parser.parse_args()

    res = discover(args.env)
    rows = scan_document_rows(res['documents_table'])
    objects = list_all(res['bucket'])
    mode = 'APPLY' if args.apply else 'DRY RUN'
    print(f"{mode}  env={args.env}  bucket={res['bucket']}  "
          f"rows={len(rows)}  objects={len(objects)}")

    planned = []

    if args.targets in ('all', 'orphans'):
        orphans = group_orphans(objects, rows, args.allow_high_orphan_ratio)
        groups = sorted(orphans.items())
        if args.limit:
            groups = groups[:args.limit]
        total_bytes = sum(size for _, items in groups for _, size in items)
        print(f"\norphaned derived artifacts: {len(groups)} group(s), "
              f"{sum(len(v) for _, v in groups)} object(s), {total_bytes / 1024:.0f} KiB")
        for iep_id, items in groups:
            kinds = sorted({k.split('/')[0] for k, _ in items})
            print(f"  {iep_id}  {len(items)} object(s)  {'+'.join(kinds)}")
            planned.extend(k for k, _ in items)

    if args.targets in ('all', 'originals'):
        leftovers = find_leftover_originals(objects, rows)
        if args.limit:
            leftovers = leftovers[:args.limit]
        print(f"\nunredacted originals: {len(leftovers)} object(s)")
        for item in leftovers:
            print(f"  {item['iepId']}  {item['size'] / 1024:.0f} KiB  "
                  f"row status={item['rowStatus']}")
            planned.append(item['key'])

    if not planned:
        print('\nnothing to purge.')
        return 0

    if not args.apply:
        print(f"\n{len(planned)} object(s) would be deleted. "
              'Re-run with --apply to do it.')
        return 0

    print(f"\ndeleting {len(planned)} object(s)...")
    deleted, failed, still_there = delete_keys(res['bucket'], planned)
    print(f"  reported deleted: {deleted}")
    if failed:
        print(f"  errors: {len(failed)}")
        for key, code in failed[:10]:
            print(f"    {code} on an object under {key.split('/')[0]}/")
    if still_there:
        print(f"  STILL PRESENT after delete: {len(still_there)}")
        return 1
    print('  verified: every targeted object is gone.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
