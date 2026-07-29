#!/usr/bin/env python3
"""
Rebuild the summaries of documents whose stored content was destroyed by the
2026-06-22 bucket rename.

Background: e1df452 made the knowledge bucket's name interpolate
getEnvironment(); edc7d2d then changed the Environment type from
'production'|'staging'|'development' to 'dev'|'prod' to tidy up tag values.
That renamed both buckets, and because the bucket was DESTROY +
autoDeleteObjects, CloudFormation deleted the old bucket and its objects. The
affected documents still say status=PROCESSED, but their contentS3Reference
points at a bucket that no longer exists, so the app shows a parent an empty
summary.

What survives is the redacted OCR text, stored inline on the DynamoDB item.
That is the expensive input, so recovery re-runs only the cheap tail of the
pipeline: ParsingAgent (regenerates summary/sections and writes content to the
CURRENT bucket, repairing the pointer), then CheckLanguagePrefs and
TranslateContent when the family reads a non-English language.

The original PDF is gone by design (delete_original purges it), so the OCR
step cannot and need not be re-run.

Usage (dry run is the default; nothing is invoked without --apply):
    scripts/recover-orphaned-documents.py --env staging
    scripts/recover-orphaned-documents.py --env staging --apply
    scripts/recover-orphaned-documents.py --env prod --iep-id iep-123 --apply
    scripts/recover-orphaned-documents.py --env prod --limit 5 --apply

Costs real LLM calls per document, so start with --iep-id or --limit and
confirm the result in the UI before running the rest.

PII discipline: this script prints ids, counts and sizes only. It never prints
document content, OCR text, or generated summaries.
"""
import argparse
import json
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = 'us-east-1'

# Parsing a real IEP takes 70-130s, well past botocore's 60s default read
# timeout. Left at the default, the client gives up while the lambda is still
# working and then SILENTLY RETRIES: the first prod attempt ran the same
# expensive LLM parse four times before surfacing an error. Wait longer than
# the lambda's own 300s ceiling, and never retry, so one document is one parse.
LAMBDA_INVOKE_CONFIG = Config(
    connect_timeout=15,
    read_timeout=600,
    retries={'max_attempts': 0},
)

# Stack prefixes tell the two environments apart; both live in one account.
STACK_PREFIX = {'staging': 'AIEPStagingStack-', 'prod': 'AIEPStack-'}

# The bucket each environment writes to TODAY. A document pointing anywhere
# else is orphaned. Kept explicit (rather than derived) so a future rename
# cannot silently make this script treat healthy documents as broken.
LIVE_BUCKET = {
    'staging': 'ai-iep-knowledge-source-dev',
    'prod': 'ai-iep-knowledge-source-prod',
}

lambda_client = boto3.client('lambda', region_name=REGION, config=LAMBDA_INVOKE_CONFIG)
dynamodb = boto3.resource('dynamodb', region_name=REGION)
s3 = boto3.client('s3', region_name=REGION)


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


def discover(env):
    """Resolve the table and lambdas for this environment at runtime."""
    prefix = STACK_PREFIX[env]
    # The staging stack's names contain 'staging'; prod's must not, or a prod
    # run could act on staging data (and vice versa).
    forbid = () if env == 'staging' else ('Staging', 'staging')

    table_names = []
    paginator = dynamodb.meta.client.get_paginator('list_tables')
    for page in paginator.paginate():
        table_names.extend(page['TableNames'])

    fn_names = []
    fn_paginator = lambda_client.get_paginator('list_functions')
    for page in fn_paginator.paginate():
        fn_names.extend(f['FunctionName'] for f in page['Functions'])

    resolved = {
        'documents_table': find_one(table_names, prefix, 'IepDocumentsTable', forbid=forbid),
        # CloudFormation truncates generated names, so match on prefixes short
        # enough to survive it ('CheckLanguagePrefsFunction' arrives as
        # 'CheckLanguagePre-<suffix>').
        'parsing_agent': find_one(fn_names, prefix, 'ParsingAgent', forbid=forbid),
        'language_prefs': find_one(fn_names, prefix, 'CheckLanguagePre', forbid=forbid),
        'translate': find_one(fn_names, prefix, 'TranslateContent', forbid=forbid),
        'live_bucket': LIVE_BUCKET[env],
    }

    # Refuse to run if the target bucket is missing: every write would fail.
    try:
        s3.head_bucket(Bucket=resolved['live_bucket'])
    except ClientError as err:
        raise SystemExit(
            f"live bucket {resolved['live_bucket']} is not reachable ({err}); "
            'aborting rather than rebuilding content with nowhere to put it'
        )
    return resolved


def scan_documents(table_name):
    table = dynamodb.Table(table_name)
    items, kwargs = [], {
        'ProjectionExpression': 'iepId, childId, userId, #s, contentS3Reference, redacted_ocr_result',
        'ExpressionAttributeNames': {'#s': 'status'},
    }
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get('Items', []))
        if 'LastEvaluatedKey' not in page:
            return items
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']


def classify(items, live_bucket):
    """Split documents into orphaned-recoverable, orphaned-lost, and healthy."""
    recoverable, lost, healthy = [], [], []
    for item in items:
        ref = item.get('contentS3Reference') or {}
        bucket = ref.get('bucket')
        if bucket and bucket != live_bucket:
            # OCR text is what makes a rebuild possible.
            if item.get('redacted_ocr_result'):
                recoverable.append(item)
            else:
                lost.append(item)
        else:
            healthy.append(item)
    return recoverable, lost, healthy


def invoke(function_name, payload, timeout_note):
    """Invoke a pipeline lambda synchronously and surface failures."""
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType='RequestResponse',
        Payload=json.dumps(payload).encode(),
    )
    raw = response['Payload'].read()
    if response.get('FunctionError'):
        # Truncated: a lambda error payload can echo document content.
        raise RuntimeError(f'{timeout_note} failed: {raw[:300]!r}')
    return json.loads(raw or b'{}')


def recover_one(item, res, verbose=True):
    """Rebuild one document. Returns (ok, message)."""
    iep_id = item['iepId']
    child_id = item['childId']
    user_id = item.get('userId')
    if not user_id:
        return False, 'item has no userId, cannot drive the pipeline'

    base = {'iep_id': iep_id, 'child_id': child_id, 'user_id': user_id}

    # 1. Regenerate the English analysis. This is what rewrites
    #    contentS3Reference to the live bucket.
    if verbose:
        print('    parsing...', flush=True)
    invoke(res['parsing_agent'], base, 'ParsingAgent')

    # 2. Ask what languages this family reads. The state machine passes these
    #    passthrough fields, so mirror them rather than inventing a shape.
    if verbose:
        print('    language prefs...', flush=True)
    prefs = invoke(
        res['language_prefs'],
        {**base, 's3_bucket': res['live_bucket'], 's3_key': '', 'progress': 90,
         'current_step': 'recovery', 'status': 'PROCESSING'},
        'CheckLanguagePrefs',
    )
    targets = prefs.get('target_languages') or []
    if prefs.get('translation_needed') and targets:
        if verbose:
            print(f'    translating {targets}...', flush=True)
        invoke(
            res['translate'],
            {**base, 'target_languages': targets, 'content_type': 'parsing_result'},
            'TranslateContent',
        )

    # 3. Confirm the pointer actually moved: the whole point of the exercise.
    table = dynamodb.Table(res['documents_table'])
    fresh = table.get_item(
        Key={'iepId': iep_id, 'childId': child_id},
        ProjectionExpression='contentS3Reference',
    ).get('Item') or {}
    new_bucket = (fresh.get('contentS3Reference') or {}).get('bucket')
    if new_bucket != res['live_bucket']:
        return False, f'content pointer still says {new_bucket!r}'

    key = (fresh.get('contentS3Reference') or {}).get('s3Key')
    try:
        head = s3.head_object(Bucket=res['live_bucket'], Key=key)
    except ClientError as err:
        return False, f'pointer moved but object unreadable: {err}'
    return True, f'rebuilt, {head["ContentLength"]} bytes, languages={targets or ["en"]}'


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', required=True, choices=('staging', 'prod'))
    parser.add_argument('--apply', action='store_true',
                        help='actually rebuild (default is a dry run)')
    parser.add_argument('--iep-id', help='recover only this document')
    parser.add_argument('--limit', type=int, help='recover at most N documents')
    args = parser.parse_args()

    res = discover(args.env)
    print(f'env={args.env}  bucket={res["live_bucket"]}')
    print(f'table={res["documents_table"]}')

    items = scan_documents(res['documents_table'])
    recoverable, lost, healthy = classify(items, res['live_bucket'])

    print(f'\n{len(items)} documents: {len(healthy)} healthy, '
          f'{len(recoverable)} orphaned+recoverable, {len(lost)} orphaned+unrecoverable')
    if lost:
        print('  unrecoverable (no redacted OCR survives; the parent must re-upload):')
        for item in lost:
            print(f'    {item["iepId"]}')

    targets = recoverable
    if args.iep_id:
        targets = [i for i in recoverable if i['iepId'] == args.iep_id]
        if not targets:
            raise SystemExit(
                f'{args.iep_id} is not in the orphaned+recoverable set; '
                'nothing to do (it may be healthy already, or unrecoverable)'
            )
    if args.limit:
        targets = targets[:args.limit]

    if not args.apply:
        print(f'\nDRY RUN. Would rebuild {len(targets)} document(s):')
        for item in targets:
            print(f'    {item["iepId"]}  (child {item["childId"]})')
        print('\nRe-run with --apply to do it. Each document costs LLM calls.')
        return 0

    print(f'\nRebuilding {len(targets)} document(s)...')
    failures = []
    for index, item in enumerate(targets, start=1):
        iep_id = item['iepId']
        print(f'  [{index}/{len(targets)}] {iep_id}', flush=True)
        started = time.time()
        try:
            ok, message = recover_one(item, res)
        except Exception as err:  # noqa: BLE001 - report and continue
            ok, message = False, str(err)[:300]
        elapsed = time.time() - started
        print(f'    {"OK" if ok else "FAILED"} ({elapsed:.0f}s): {message}', flush=True)
        if not ok:
            failures.append((iep_id, message))

    print(f'\ndone: {len(targets) - len(failures)} rebuilt, {len(failures)} failed')
    for iep_id, message in failures:
        print(f'  FAILED {iep_id}: {message}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
