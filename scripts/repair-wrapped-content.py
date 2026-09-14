#!/usr/bin/env python3
"""
Unwrap DynamoDB type descriptors left inside content.json by a lazy migration.

Background: the oldest documents stored their content already serialized, so
the DynamoDB attribute reads back as {'en': {'S': '...'}} rather than
{'en': '...'}. Every read path that served a still-inline document unwrapped
that on the way out, which hid it for as long as the document stayed in
DynamoDB. migrate_dynamodb_to_s3 then copied the attribute into content.json
verbatim, and the wrapper became permanent: the summary page treats the object
as present (it is truthy), renders the summary card, calls .split on it and
throws. With no ErrorBoundary above it the parent got a blank page and a
healthy 200 in the network tab.

s3_content_handler.py now cleans before writing, so no NEW file can be
damaged. This repairs the files written before that fix.

Safe to re-run: a file that is already plain is counted and skipped, so the
second run of a clean bucket reports zero repairs and writes nothing.

Usage (dry run is the default; nothing is written without --apply):
    scripts/repair-wrapped-content.py --env staging
    scripts/repair-wrapped-content.py --env staging --apply
    scripts/repair-wrapped-content.py --env prod --iep-id iep-123 --apply

PII discipline: this script prints keys, ids, counts and sizes only. It never
prints summaries, sections or any other document content, including in the
diff it reports -- only which FIELDS changed shape.
"""
import argparse
import json
import sys

import boto3
from botocore.exceptions import ClientError

REGION = 'us-east-1'

LIVE_BUCKET = {
    'staging': 'ai-iep-knowledge-source-dev',
    'prod': 'ai-iep-knowledge-source-prod',
}

CONTENT_FIELDS = ('summaries', 'sections', 'document_index', 'abbreviations')

# The type letters DynamoDB uses. A single-key dict is only a wrapper when its
# key is one of these: a section legitimately keyed 'content' must survive.
DDB_TYPE_KEYS = {'S', 'N', 'L', 'M', 'BOOL', 'NULL', 'SS', 'NS', 'BS'}


def clean_dynamodb_json(data):
    """Recursively unwrap DynamoDB type descriptors into plain JSON.

    Same contract as clean_dynamodb_json in user-profile-handler and
    s3_content_handler, deliberately: this script must produce byte-for-byte
    what the fixed migration would have produced.
    """
    if isinstance(data, dict):
        if set(data.keys()) == {'S'}:
            return data['S']
        if set(data.keys()) == {'N'}:
            n = data['N']
            try:
                return int(n)
            except ValueError:
                try:
                    return float(n)
                except ValueError:
                    return n
        if set(data.keys()) == {'L'}:
            return [clean_dynamodb_json(item) for item in data['L']]
        if set(data.keys()) == {'M'}:
            return {k: clean_dynamodb_json(v) for k, v in data['M'].items()}
        return {k: clean_dynamodb_json(v) for k, v in data.items()}
    if isinstance(data, list):
        return [clean_dynamodb_json(item) for item in data]
    return data


def wrapped_fields(content):
    """Which content fields carry a type descriptor, by name only.

    Names, never values: the caller prints this.
    """
    found = []
    for field in CONTENT_FIELDS:
        value = content.get(field)
        if not isinstance(value, dict):
            continue
        for language_value in value.values():
            if (isinstance(language_value, dict)
                    and len(language_value) == 1
                    and next(iter(language_value)) in DDB_TYPE_KEYS):
                found.append(field)
                break
    return found


def iter_content_keys(s3, bucket, iep_id=None):
    prefix = f'iep-data/{iep_id}/' if iep_id else 'iep-data/'
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            if obj['Key'].endswith('/content.json'):
                yield obj['Key']


def repair_one(s3, bucket, key, apply_changes):
    """Returns 'clean', 'repaired', 'would-repair', or 'error'."""
    try:
        body = s3.get_object(Bucket=bucket, Key=key)['Body'].read()
        content = json.loads(body)
    except (ClientError, ValueError) as e:
        print(f'  ERROR reading {key}: {type(e).__name__}')
        return 'error'

    damaged = wrapped_fields(content)
    if not damaged:
        return 'clean'

    cleaned = clean_dynamodb_json(content)
    new_body = json.dumps(cleaned, default=str, ensure_ascii=False).encode('utf-8')

    print(f'  {key}')
    print(f'    fields to unwrap: {", ".join(damaged)}')
    print(f'    size {len(body)} -> {len(new_body)} bytes')

    if not apply_changes:
        return 'would-repair'

    # ServerSideEncryption matches save_content_to_s3: the bucket's default
    # would apply anyway, but an explicit value keeps a repaired object
    # indistinguishable from a freshly written one.
    s3.put_object(Bucket=bucket, Key=key, Body=new_body,
                  ContentType='application/json', ServerSideEncryption='aws:kms')

    # Verify by re-reading rather than trusting the put. A repair that
    # silently did nothing is the failure mode that matters here, because the
    # next run would report the bucket clean.
    check = json.loads(s3.get_object(Bucket=bucket, Key=key)['Body'].read())
    still = wrapped_fields(check)
    if still:
        print(f'    FAILED: still wrapped after write: {", ".join(still)}')
        return 'error'

    print('    repaired and verified')
    return 'repaired'


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', required=True, choices=('staging', 'prod'))
    parser.add_argument('--iep-id', help='Repair a single document instead of the whole bucket')
    parser.add_argument('--apply', action='store_true',
                        help='Actually write. Without it nothing is modified.')
    args = parser.parse_args()

    bucket = LIVE_BUCKET[args.env]
    s3 = boto3.client('s3', region_name=REGION)

    mode = 'APPLY' if args.apply else 'DRY RUN'
    print(f'{mode}: scanning s3://{bucket}/iep-data/ '
          f'{"for " + args.iep_id if args.iep_id else "(all documents)"}\n')

    counts = {'clean': 0, 'repaired': 0, 'would-repair': 0, 'error': 0}
    for key in iter_content_keys(s3, bucket, args.iep_id):
        counts[repair_one(s3, bucket, key, args.apply)] += 1

    total = sum(counts.values())
    print(f'\nScanned {total} content.json file(s) in {args.env}:')
    print(f'  already plain: {counts["clean"]}')
    if args.apply:
        print(f'  repaired:      {counts["repaired"]}')
    else:
        print(f'  would repair:  {counts["would-repair"]}')
    print(f'  errors:        {counts["error"]}')

    if not args.apply and counts['would-repair']:
        print('\nRe-run with --apply to write these.')

    return 1 if counts['error'] else 0


if __name__ == '__main__':
    sys.exit(main())
