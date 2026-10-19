import json
import boto3
import os

dynamodb = boto3.resource('dynamodb')

# Keys under these prefixes are built from ids alone (iep-data/<iepId>/<childId>/
# content.json and the like), so they are safe to log whole.
_ID_ONLY_PREFIXES = ('iep-data/', 'iep-audio/')

# S3 DeleteObjects accepts at most 1000 keys per request.
DELETE_BATCH_SIZE = 1000

_GENERIC_FAILURE = 'Could not delete the document. Please try again later.'


def _safe_key(key):
    """An S3 key fit for CloudWatch: an upload's filename removed.

    An original upload is userId/childId/iepId/<filename>, and parents
    routinely name the file after their child, so the filename is student
    data. Mirrors _safe_key in metadata-handler/orchestrator.py, extended to
    keep the ids-only derived keys readable.
    """
    if not isinstance(key, str):
        return '<no key>'
    if key.startswith(_ID_ONLY_PREFIXES):
        return key
    head, sep, _filename = key.rpartition('/')
    return f'{head}/...' if sep else '...'


def _cors_response(status_code, message, extra=None):
    body = {'message': message}
    if extra:
        body.update(extra)
    return {
        'statusCode': status_code,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
        'body': json.dumps(body),
    }


def _report_deletion_incomplete(user_id, iep_id, survived):
    """Log the one line an alarm can count when a deletion did not finish.

    DELETION_INCOMPLETE is a stable marker, not prose: a metric filter alarms
    on it, and rewording this line would disarm that alarm. Same contract as
    RECORD_FAILURE in the pipeline and SMS_REFUSED_DESTINATION in the OTP
    trigger. The other two delete paths in user-profile-handler emit the same
    marker with a different scope.

    Ids and artifact kinds only. The exception text goes in the per-step lines
    above this one: it can quote table and bucket names, and an uploaded
    filename routinely carries the child's name.
    """
    print(f"DELETION_INCOMPLETE scope=document essential=yes user={user_id} "
          f"iep={iep_id or 'unknown'} survived={','.join(sorted(set(survived)))}")


def _delete_batch(s3, bucket, entries):
    """One DeleteObjects call. Per-key failures come back in a successful
    response, so they are raised here: a version that was not deleted must
    never be counted as deleted. The message carries the S3 error code only,
    because the key can hold a filename."""
    response = s3.delete_objects(
        Bucket=bucket,
        Delete={
            'Objects': [{'Key': e['Key'], 'VersionId': e['VersionId']} for e in entries],
            'Quiet': True,
        },
    )
    errors = response.get('Errors', [])
    if errors:
        raise RuntimeError(f"DeleteObjects left {len(errors)} version(s) in place "
                           f"(first error code: {errors[0].get('Code')})")


def _delete_every_version(s3, bucket, prefix, exact=False):
    """Permanently delete every version and delete marker under a prefix.

    The bucket is versioned, so DeleteObject without a VersionId only writes a
    delete marker: the bytes stay retrievable by version id until the 1-day
    noncurrent lifecycle rule reaches them, which measured 1 to 3 days on
    staging (2026-10-14). Deleting each version by id is immediate and final.
    Entries go out in DeleteObjects batches of up to 1000 keys.
    Duplicated in each lambda that deletes from the bucket (each folder is
    its own asset); deleteEveryVersion in upload-s3/utils is the JS twin.

    exact=True takes only the one key named by prefix. Version listing is by
    prefix, so report.pdf would otherwise also take report.pdf2.

    Returns the keys that had a current version, so callers count and log
    real deletions rather than markers and superseded versions.
    """
    visible = []
    for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
        versions = page.get('Versions', [])
        entries = [e for e in versions + page.get('DeleteMarkers', [])
                   if not exact or e['Key'] == prefix]
        for start in range(0, len(entries), DELETE_BATCH_SIZE):
            _delete_batch(s3, bucket, entries[start:start + DELETE_BATCH_SIZE])
        visible.extend(v['Key'] for v in versions
                       if v.get('IsLatest') and (not exact or v['Key'] == prefix))
    return visible


def _delete_prefix(s3, bucket, prefix):
    """Delete every object under a prefix, returning the count removed."""
    deleted = _delete_every_version(s3, bucket, prefix)
    for key in deleted:
        print(f"Deleted S3 object: {_safe_key(key)}")
    return len(deleted)


def _delete_document_artifacts(s3, bucket, doc):
    """Purge every S3 artifact derived from one IEP document record.

    Mirrors _delete_document_artifacts in user-profile-handler and
    deleteDocumentArtifacts in upload-s3/utils/iep-document-utils.mjs: the
    three delete paths must strip the same artifact shapes. This one used to
    delete the raw upload alone, which left the summary, the redacted OCR text
    and every cached mp3 in the bucket, plus a row pointing at an object that
    was no longer there.

    The iep-data sweep is a prefix, not content.json by name: three file names
    live there and only one of them is the summary. The others are the
    redacted OCR text and, when the pipeline died before DeleteOriginal ran,
    the raw OCR.
    """
    deleted = 0

    ref = doc.get('contentS3Reference') or {}
    if ref.get('s3Key'):
        _delete_every_version(s3, ref.get('bucket') or bucket, ref['s3Key'], exact=True)
        print(f"Deleted S3 object: {_safe_key(ref['s3Key'])}")
        deleted += 1

    # Any key already removed above is simply not listed, so the count stays
    # accurate.
    deleted += _delete_prefix(s3, bucket, f"iep-data/{doc['iepId']}/{doc['childId']}/")
    deleted += _delete_prefix(s3, bucket, f"iep-audio/{doc['iepId']}/{doc['childId']}/")
    return deleted


def _read_key(event):
    """The KEY from the JSON body, or (None, 400 response) with the reason logged."""
    try:
        payload = json.loads(event['body']) if event.get('body') else {}
    except (TypeError, ValueError):
        # Logged rather than silent: a rejection with no log line is
        # undiagnosable, and a 4xx is the only trace a bad request leaves.
        print('Rejected delete request: body is not valid JSON')
        return None, _cors_response(400, 'Invalid JSON body')

    if not isinstance(payload, dict):
        print(f"Rejected delete request: body is not a JSON object (type={type(payload).__name__})")
        return None, _cors_response(400, 'Request body must be a JSON object')

    key = payload.get('KEY')
    if not key or not isinstance(key, str):
        print(f"Rejected delete request: KEY missing or not a string (type={type(key).__name__})")
        return None, _cors_response(400, 'KEY is required')
    return key, None


def _user_sub(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return None


def _load_document(documents_table, iep_id, child_id, user_id):
    """(doc or None, error response or None) for the row the key names.

    A row owned by someone else is answered exactly like a missing row, so the
    response never says which iepIds exist. The reason is logged.
    """
    try:
        doc = documents_table.get_item(Key={'iepId': iep_id, 'childId': child_id}).get('Item')
    except Exception as e:
        print(f"Error reading document row for iepId {iep_id}: {type(e).__name__}")
        _report_deletion_incomplete(user_id, iep_id,
                                    ['raw-upload', 'derived-artifacts', 'document-row'])
        return None, _cors_response(503, _GENERIC_FAILURE)

    if doc and doc.get('userId') != user_id:
        print(f"Refused delete: user {user_id} does not own document {iep_id}")
        return None, _cors_response(404, 'Not found')
    return doc, None


def _delete_document(s3, bucket, key, documents_table, iep_id, child_id, doc):
    """Delete the raw upload, then the derived artifacts, then the row.

    Returns (objects_deleted, survived). Every pointer outlives the thing it
    points at, so a retry after a partial failure can still find whatever
    survived: the row carries contentS3Reference and is also the proof that
    this caller owns the document. Each step is idempotent (DeleteObject and
    DeleteItem succeed on something already gone), so a retry converges.
    """
    survived = []
    objects_deleted = 0

    try:
        _delete_every_version(s3, bucket, key, exact=True)
        objects_deleted += 1
        print(f"Deleted S3 object: {_safe_key(key)}")
    except Exception as e:
        print(f"Error deleting S3 object {_safe_key(key)}: {type(e).__name__}")
        survived.append('raw-upload')

    if doc:
        try:
            objects_deleted += _delete_document_artifacts(s3, bucket, doc)
        except Exception as e:
            print(f"Error deleting S3 artifacts for iepId {iep_id}: {type(e).__name__}")
            # Keep the row: it is the only pointer to the artifacts that
            # survived, so deleting it here would strand them where nothing
            # but scripts/purge-orphaned-artifacts.py could reach them.
            survived.extend(['derived-artifacts', 'document-row'])
        else:
            try:
                documents_table.delete_item(Key={'iepId': iep_id, 'childId': child_id})
                print(f"Deleted IEP document record with iepId: {iep_id}")
            except Exception as e:
                print(f"Error deleting IEP document record {iep_id}: {type(e).__name__}")
                survived.append('document-row')
    elif iep_id:
        # No row: either it is already gone or this key never had one. The
        # derived artifacts are not swept here, because without a row there is
        # nothing that proves the caller owns this iepId; the orphan sweep
        # (scripts/purge-orphaned-artifacts.py) is what collects those.
        print(f"No document row for iepId {iep_id}; deleted the object only")
    return objects_deleted, survived


def lambda_handler(event, context):
    key, error = _read_key(event)
    if error:
        return error

    user_id = _user_sub(event)
    if not user_id:
        print('Rejected delete request: no JWT sub claim on the event')
        return _cors_response(401, 'Unauthorized')

    # Ownership check: S3 keys are stored under `{userId}/{childId}/{iepId}/{filename}`.
    # A key outside the caller's prefix, or with a '..' segment, is answered as
    # not found: the response must not reveal which keys exist.
    if not key.startswith(f"{user_id}/") or '..' in key.split('/'):
        print(f"Refused delete for {_safe_key(key)} (user {user_id}): "
              "key is outside the caller's prefix or has a '..' segment")
        return _cors_response(404, 'Not found')

    # childId and iepId come from the caller, so they are not trusted until the
    # document row confirms this user owns that document: a key can carry the
    # caller's own prefix and still name another family's iepId, and the sweeps
    # below are keyed on iepId alone.
    segments = key.split('/')
    child_id, iep_id = (segments[1], segments[2]) if len(segments) >= 4 else (None, None)

    table_name = os.environ.get('IEP_DOCUMENTS_TABLE')
    bucket = os.environ.get('BUCKET')
    if not table_name or not bucket:
        # Fail closed. Without the table this route can only delete the raw
        # upload, which is exactly the orphaning it used to do; refusing is
        # better than reporting a deletion that leaves the summary behind.
        print('BUCKET or IEP_DOCUMENTS_TABLE is not configured; refusing to half-delete')
        _report_deletion_incomplete(user_id, iep_id,
                                    ['raw-upload', 'derived-artifacts', 'document-row'])
        return _cors_response(500, _GENERIC_FAILURE)

    documents_table = dynamodb.Table(table_name)
    doc = None
    if iep_id and child_id:
        doc, error = _load_document(documents_table, iep_id, child_id, user_id)
        if error:
            return error

    s3 = boto3.client('s3')
    objects_deleted, survived = _delete_document(
        s3, bucket, key, documents_table, iep_id, child_id, doc)

    if survived:
        _report_deletion_incomplete(user_id, iep_id, survived)
        return _cors_response(503, _GENERIC_FAILURE)

    return _cors_response(200, 'Deleted', {
        'key': key,
        'objectsDeleted': objects_deleted,
        'documentDeleted': doc is not None,
    })
