#!/usr/bin/env python3
"""
Sweep the redacted OCR text that accumulated on documents processed before the
PurgeRedactedOCR step existed.

The pipeline kept redacted_ocr_result forever: RedactOCR wrote it, ParsingAgent
read it, and nothing ever removed it. PurgeRedactedOCR (the last state in
iep-processing.asl.json, after FinalizeResults) now deletes it as soon as the
summary exists, so every NEW document self-cleans. This script is the backfill
for everything already on disk, in both prod and staging.

Redaction is best-effort, not a guarantee: Comprehend misses names it does not
recognise, so a retained "redacted" OCR blob is a retained FERPA record. The
summary, sections and translations are the product. This text is an
intermediate with no reader left.

## Is redacted_ocr_result still needed after a document reaches PROCESSED?

No. Every reader was traced, and the only live one runs BEFORE the document is
PROCESSED. The full set:

  WRITE   steps/redact_ocr/handler.py
          -> ddb-service save_ocr_data(data_type='redacted_ocr_result')

  READ    steps/parsing_agent/handler.py
          -> ddb-service get_ocr_data(data_type='redacted_ocr_result')
          THE ONLY LIVE READER. It is the ParsingAgent state, which runs at
          progress 65 while status is PROCESSING. By the time FinalizeResults
          has set PROCESSED, this read has already happened and will not
          happen again for that document.

  DELETE  iep-processing.asl.json / PurgeRedactedOCR (after FinalizeResults)
          steps/delete_original/handler.py deletes only the RAW ocr_result.
          ddb-service record_failure's purge also touches only the raw copy.
          user-profile-handler deletes the S3 object on account / child
          deletion; it never reads it.

  NOT READ BY
          translation-request-handler/lambda_function.py  - reads content.json
            through contentS3Reference, never the OCR.
          single-language-translation.asl.json / translate_content - same,
            content_type='parsing_result' means content.json.
          tts-handler, referral-handler, user-profile-handler - no read.
          The frontend - `grep -r redacted lib/user-interface/app/src` is
            empty. Nothing parent-facing has ever seen this attribute.

So a PROCESSED document does not need it, and this script only ever targets
PROCESSED documents. PROCESSING and PROCESSING_TRANSLATIONS are refused
outright and listed, because a PROCESSING document is exactly the one
ParsingAgent is about to read.

ONE REAL COST, and it is not a blocker but you should know it before --apply:
scripts/recover-orphaned-documents.py rebuilds an orphaned document by feeding
its surviving redacted OCR back through ParsingAgent. After this sweep that
rebuild is impossible and an affected parent has to re-upload. PurgeRedactedOCR
already made that true for every document processed since it shipped, so this
only aligns the backlog with the decision already taken. It is also worth
knowing that recover-orphaned-documents.py checks the INLINE attribute only, so
it already under-reports documents that hold their OCR through the S3
reference.

## The two shapes, confirmed from the code not guessed

ddb-service/handler.py::save_ocr_data writes the payload to S3 and stores only
a reference, removing any legacy inline copy in the same update:

    SET redacted_ocr_result_s3_ref = {'bucket': ..., 's3Key': ...}
    REMOVE redacted_ocr_result

so a document carries EITHER form, never both:

    inline      attribute `redacted_ocr_result`            (legacy, pre-S3)
    S3-backed   attribute `redacted_ocr_result_s3_ref`     -> an S3 object at
                s3_content_handler.py::get_ocr_s3_key, i.e.
                iep-data/{iepId}/{childId}/redacted_ocr_result.json

Both are handled. delete_ocr_data also sweeps the conventional key when the
reference is missing (a lost ref write strands the object), so this script
reports those strays too.

Usage (dry run is the default; nothing is deleted without --apply):
    scripts/purge-redacted-ocr.py --environment staging
    scripts/purge-redacted-ocr.py --environment prod
    scripts/purge-redacted-ocr.py --environment staging --apply
    scripts/purge-redacted-ocr.py --environment prod --limit 5 --apply
    scripts/purge-redacted-ocr.py --environment prod --include-failed --apply

--environment is required and has no default, so nobody points a purge at the
wrong account by leaving a flag off.

Recoverability: both buckets are versioned, so an S3 delete writes a delete
marker and the bytes survive as a noncurrent version until the lifecycle rule
expires them (hours, not days). The DynamoDB attribute removal has no such net
and is final.

PII discipline: prints iepIds, counts, statuses and byte sizes. The inline OCR
payload is never even fetched (presence is established with a FilterExpression
and a projection that excludes it) so redacted OCR text never reaches the
operator's machine, let alone the terminal.
"""
import argparse
import sys

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

INLINE_ATTR = 'redacted_ocr_result'
S3_REF_ATTR = 'redacted_ocr_result_s3_ref'

# The only status a purge may target by default. PROCESSING and
# PROCESSING_TRANSLATIONS are the states in which ParsingAgent still reads this
# attribute, so they are refused no matter what flags are passed.
SAFE_STATUS = 'PROCESSED'
NEVER_PURGE_STATUSES = ('PROCESSING', 'PROCESSING_TRANSLATIONS')

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


def discover(environment):
    prefix = STACK_PREFIX[environment]
    # Prod names must not contain 'staging', or a prod run could delete from
    # staging (and a staging run judge prod rows).
    forbid = () if environment == 'staging' else ('Staging', 'staging')

    names = []
    for page in dynamodb.meta.client.get_paginator('list_tables').paginate():
        names.extend(page['TableNames'])

    resolved = {
        'documents_table': find_one(names, prefix, 'IepDocumentsTable', forbid=forbid),
        'bucket': LIVE_BUCKET[environment],
    }

    try:
        s3.head_bucket(Bucket=resolved['bucket'])
    except ClientError as err:
        raise SystemExit(f"bucket {resolved['bucket']} is not reachable ({err}); aborting")
    return resolved


def scan(table_name, **extra):
    """Paginated scan. Callers always pass a payload-free ProjectionExpression."""
    table = dynamodb.Table(table_name)
    items, kwargs = [], dict(extra)
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get('Items', []))
        if 'LastEvaluatedKey' not in page:
            return items
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']


def inventory(table_name):
    """
    Every document, with its status and its S3 reference, plus the set of keys
    that carry an INLINE payload.

    Two passes on purpose. The inline attribute is the redacted OCR text
    itself, so it is never projected: presence is established server-side with
    attribute_exists and only the keys come back. A projection that included it
    would pull FERPA-protected text onto whatever laptop runs this.
    """
    projection = 'iepId, childId, userId, #s, ' + S3_REF_ATTR
    names = {'#s': 'status'}

    documents = scan(table_name, ProjectionExpression=projection,
                     ExpressionAttributeNames=names)
    inline_rows = scan(table_name, ProjectionExpression='iepId, childId',
                       FilterExpression=f'attribute_exists({INLINE_ATTR})')
    inline_keys = {(r['iepId'], r['childId']) for r in inline_rows}
    return documents, inline_keys


def conventional_key(iep_id, child_id):
    """s3_content_handler.py::get_ocr_s3_key, mirrored."""
    return f'iep-data/{iep_id}/{child_id}/{INLINE_ATTR}.json'


def object_size(bucket, key):
    """ContentLength, or None when the object is not there."""
    try:
        return s3.head_object(Bucket=bucket, Key=key)['ContentLength']
    except ClientError:
        return None


def classify(documents, inline_keys, bucket):
    """
    Split documents into targets, refusals and untouched, and price the S3 side.

    Returns (carriers, refused, strays) where a carrier is a dict of the facts
    the purge and the report both need.
    """
    carriers, refused, strays = [], [], []
    for doc in documents:
        iep_id, child_id = doc['iepId'], doc['childId']
        status = doc.get('status')
        ref = doc.get(S3_REF_ATTR) or {}
        has_inline = (iep_id, child_id) in inline_keys
        has_ref = bool(ref)

        if not (has_inline or has_ref):
            # No reference, but delete_ocr_data sweeps the conventional key for
            # exactly this case: a ref write that was lost leaves the object
            # with nothing pointing at it. Worth reporting.
            size = object_size(bucket, conventional_key(iep_id, child_id))
            if size is not None:
                strays.append({'iepId': iep_id, 'childId': child_id,
                               'status': status, 'bytes': size})
            continue

        record = {
            'iepId': iep_id,
            'childId': child_id,
            'status': status,
            'inline': has_inline,
            's3Ref': ref or None,
            'strayKey': None,
            'bytes': 0,
            'objectMissing': False,
        }
        if has_ref:
            size = object_size(ref.get('bucket'), ref.get('s3Key'))
            if size is None:
                record['objectMissing'] = True
            else:
                record['bytes'] = size
        else:
            # Inline-only rows can still have an object at the conventional key
            # if a reference write was lost. delete_ocr_data sweeps it, so this
            # does too, rather than leaving OCR text behind with the attribute
            # that named it gone.
            key = conventional_key(iep_id, child_id)
            size = object_size(bucket, key)
            if size is not None:
                record['strayKey'] = key
                record['bytes'] = size

        (carriers if status not in NEVER_PURGE_STATUSES else refused).append(record)
    return carriers, refused, strays


def purge_one(record, table_name, bucket_name):
    """
    Delete the S3 object and remove both attributes, then re-read to prove it.

    The update is conditional on attribute_exists(iepId), mirroring
    ddb-service's _guarded_update: DynamoDB's update_item is an upsert, and a
    REMOVE against an absent item RECREATES it. Without the condition this
    script would resurrect documents a parent had deleted, as rows carrying
    nothing but updated_at, invisible to the byUserId GSI and therefore immune
    to account deletion forever.
    """
    iep_id, child_id = record['iepId'], record['childId']
    table = dynamodb.Table(table_name)

    ref = record['s3Ref']
    if ref:
        bucket, key = ref.get('bucket'), ref.get('s3Key')
    elif record['strayKey']:
        # No reference, but an object is sitting at the conventional key: a ref
        # write that was lost. delete_ocr_data sweeps this case; so does this.
        bucket, key = bucket_name, record['strayKey']
    else:
        bucket, key = None, None

    if bucket and key:
        try:
            s3.delete_object(Bucket=bucket, Key=key)
        except ClientError as err:
            return False, f'S3 delete failed: {err.response["Error"]["Code"]}'

    try:
        table.update_item(
            Key={'iepId': iep_id, 'childId': child_id},
            UpdateExpression=f'REMOVE {INLINE_ATTR}, {S3_REF_ATTR}',
            ConditionExpression='attribute_exists(iepId)',
        )
    except ClientError as err:
        if err.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False, 'document row disappeared mid-run; not recreating it'
        return False, f'attribute removal failed: {err.response["Error"]["Code"]}'

    # Verify, because a purge that reports success without checking is how the
    # bucket rename reported success.
    fresh = table.get_item(
        Key={'iepId': iep_id, 'childId': child_id},
        ProjectionExpression=f'{INLINE_ATTR}, {S3_REF_ATTR}',
    ).get('Item') or {}
    leftovers = [name for name in (INLINE_ATTR, S3_REF_ATTR) if name in fresh]
    if leftovers:
        return False, f'attributes still present after removal: {leftovers}'

    if bucket and key and object_size(bucket, key) is not None:
        return False, 'S3 object still readable after delete'

    parts = []
    if record['inline']:
        parts.append('inline attribute')
    if record['s3Ref']:
        parts.append(f'S3 object ({record["bytes"]} bytes)')
    if record['strayKey']:
        parts.append(f'stray S3 object ({record["bytes"]} bytes)')
    return True, 'purged ' + ' + '.join(parts)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--environment', '--env', dest='environment', required=True,
                        choices=('prod', 'staging'),
                        help='required, no default: naming the environment out loud is '
                             'what stops a purge landing in the wrong one')
    parser.add_argument('--apply', action='store_true',
                        help='actually delete (default is a dry run)')
    parser.add_argument('--limit', type=int, help='purge at most N documents')
    parser.add_argument('--iep-id', help='purge only this document')
    parser.add_argument('--include-failed', action='store_true',
                        help='also purge FAILED documents. Nothing reads their redacted '
                             'OCR either (RecordFailure purges only the raw copy), so it '
                             'is retained PII, but it is off by default because a FAILED '
                             'document is the one an operator is most likely to be '
                             'looking at')
    args = parser.parse_args()

    resolved = discover(args.environment)
    print(f'environment={args.environment}  bucket={resolved["bucket"]}')
    print(f'table={resolved["documents_table"]}')

    documents, inline_keys = inventory(resolved['documents_table'])
    carriers, refused, strays = classify(documents, inline_keys, resolved['bucket'])

    inline_count = sum(1 for c in carriers if c['inline'])
    ref_count = sum(1 for c in carriers if c['s3Ref'])
    both_count = sum(1 for c in carriers if c['inline'] and c['s3Ref'])
    stray_on_carrier = sum(1 for c in carriers if c['strayKey'])
    total_bytes = sum(c['bytes'] for c in carriers)
    missing = [c for c in carriers if c['objectMissing']]

    print(f'\n{len(documents)} documents scanned')
    print(f'{len(carriers) + len(refused)} carry redacted OCR: '
          f'{inline_count} inline, {ref_count} S3-backed, {both_count} both')
    print(f'S3 bytes reclaimable: {total_bytes} ({total_bytes / 1048576:.2f} MiB)')
    if missing:
        print(f'  {len(missing)} reference an S3 object that is already gone '
              '(attribute removal still applies)')
    if stray_on_carrier:
        print(f'  {stray_on_carrier} inline-only row(s) also have an object at the '
              'conventional key (a lost reference write); those are purged too')

    by_status = {}
    for record in carriers + refused:
        by_status[record['status']] = by_status.get(record['status'], 0) + 1
    print('by document status: ' + (
        ', '.join(f'{k}={v}' for k, v in sorted(by_status.items(), key=lambda kv: str(kv[0])))
        or '(none)'))

    if refused:
        print(f'\nREFUSED, still in flight ({len(refused)}). ParsingAgent reads this '
              'attribute at exactly these statuses, so they are never purged:')
        for record in refused:
            print(f'    {record["iepId"]}  status={record["status"]}')

    if strays:
        stray_bytes = sum(s['bytes'] for s in strays)
        print(f'\n{len(strays)} S3 object(s) sitting at the conventional redacted-OCR key '
              f'with no reference on the row ({stray_bytes} bytes). These are lost-ref '
              'writes; they are reported but NOT purged by this script:')
        for record in strays[:20]:
            print(f'    {record["iepId"]}  status={record["status"]}  {record["bytes"]} bytes')

    allowed = {SAFE_STATUS} | ({'FAILED'} if args.include_failed else set())
    targets = [c for c in carriers if c['status'] in allowed]
    out_of_scope = [c for c in carriers if c['status'] not in allowed]
    if out_of_scope:
        print(f'\n{len(out_of_scope)} carrier(s) skipped by status filter '
              f'(allowed: {sorted(allowed)}):')
        for record in out_of_scope:
            print(f'    {record["iepId"]}  status={record["status"]}')

    if args.iep_id:
        targets = [c for c in targets if c['iepId'] == args.iep_id]
    if args.limit:
        targets = targets[:args.limit]

    if not targets:
        print('\nnothing to purge.')
        return 0

    if not args.apply:
        target_bytes = sum(t['bytes'] for t in targets)
        print(f'\nDRY RUN. Would purge redacted OCR from {len(targets)} document(s), '
              f'freeing {target_bytes} S3 bytes ({target_bytes / 1048576:.2f} MiB):')
        for record in targets:
            form = 'inline' if record['inline'] else f'S3 {record["bytes"]}B'
            if record['strayKey']:
                form += f' + stray S3 {record["bytes"]}B'
            print(f'    {record["iepId"]}  status={record["status"]}  {form}')
        print('\nRe-run with --apply to delete. The DynamoDB attribute removal is '
              'not reversible; the S3 delete survives as a noncurrent version only '
              'until the lifecycle rule expires it.')
        return 0

    print(f'\nPurging {len(targets)} document(s)...')
    verified, failures = 0, []
    for index, record in enumerate(targets, start=1):
        print(f'  [{index}/{len(targets)}] {record["iepId"]}', flush=True)
        try:
            ok, message = purge_one(record, resolved['documents_table'], resolved['bucket'])
        except Exception as err:  # noqa: BLE001 - report and continue
            ok, message = False, f'{type(err).__name__}: {str(err)[:200]}'
        print(f'    {"VERIFIED" if ok else "FAILED"}: {message}', flush=True)
        if ok:
            verified += 1
        else:
            failures.append((record['iepId'], message))

    print(f'\ndone: {verified} verified deleted, {len(failures)} failed')
    for iep_id, message in failures:
        print(f'  FAILED {iep_id}: {message}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
