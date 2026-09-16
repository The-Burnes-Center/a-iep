import json
import boto3
import os

dynamodb = boto3.resource('dynamodb')


def _cors_response(status_code, message, extra=None):
    body = {'message': message}
    if extra:
        body.update(extra)
    return {
        'statusCode': status_code,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
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


def _delete_prefix(s3, bucket, prefix):
    """Delete every object under a prefix, returning the count removed."""
    deleted = 0
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            s3.delete_object(Bucket=bucket, Key=obj['Key'])
            print(f"Deleted S3 object: {obj['Key']}")
            deleted += 1
    return deleted


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
        s3.delete_object(Bucket=ref.get('bucket') or bucket, Key=ref['s3Key'])
        print(f"Deleted S3 object: {ref['s3Key']}")
        deleted += 1

    # Any key already removed above is simply not listed, so the count stays
    # accurate.
    deleted += _delete_prefix(s3, bucket, f"iep-data/{doc['iepId']}/{doc['childId']}/")
    deleted += _delete_prefix(s3, bucket, f"iep-audio/{doc['iepId']}/{doc['childId']}/")
    return deleted


def lambda_handler(event, context):
    try:
        payload = json.loads(event['body']) if event.get('body') else {}
    except (TypeError, ValueError):
        # Logged rather than silent: a rejection with no log line is
        # undiagnosable, and a 4xx is the only trace a bad request leaves.
        print('Rejected delete request: body is not valid JSON')
        return _cors_response(400, 'Invalid JSON body')

    key = payload.get('KEY')
    if not key or not isinstance(key, str):
        print(f"Rejected delete request: KEY missing or not a string (type={type(key).__name__})")
        return _cors_response(400, 'KEY is required')

    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        print('Rejected delete request: no JWT sub claim on the event')
        return _cors_response(401, 'Unauthorized')

    # Ownership check: S3 keys are stored under `{userId}/{childId}/{iepId}/{filename}`.
    # Reject any attempt to delete keys that don't belong to the authenticated user,
    # including path-traversal-style attempts (e.g. `userId/../other/...`).
    expected_prefix = f"{user_id}/"
    if not key.startswith(expected_prefix) or '..' in key.split('/'):
        print(f"Access denied: user {user_id} attempted to delete key {key}")
        return _cors_response(403, 'Access denied: cannot delete files belonging to other users')

    # childId and iepId come from the caller, so they are not trusted until the
    # document row confirms this user owns that document: a key can carry the
    # caller's own prefix and still name another family's iepId, and the sweeps
    # below are keyed on iepId alone.
    segments = key.split('/')
    child_id, iep_id = (segments[1], segments[2]) if len(segments) >= 4 else (None, None)

    table_name = os.environ.get('IEP_DOCUMENTS_TABLE')
    if not table_name:
        # Fail closed. Without the table this route can only delete the raw
        # upload, which is exactly the orphaning it used to do; refusing is
        # better than reporting a deletion that leaves the summary behind.
        print('IEP_DOCUMENTS_TABLE is not configured; refusing to half-delete')
        _report_deletion_incomplete(user_id, iep_id,
                                    ['raw-upload', 'derived-artifacts', 'document-row'])
        return _cors_response(500, 'Could not delete the document. Please try again later.')

    s3 = boto3.client('s3')
    bucket = os.environ['BUCKET']
    documents_table = dynamodb.Table(table_name)

    doc = None
    if iep_id and child_id:
        try:
            doc = documents_table.get_item(
                Key={'iepId': iep_id, 'childId': child_id}).get('Item')
        except Exception as e:
            print(f"Error reading document row for iepId {iep_id}: {str(e)}")
            _report_deletion_incomplete(user_id, iep_id,
                                        ['raw-upload', 'derived-artifacts', 'document-row'])
            return _cors_response(500, 'Could not delete the document. Please try again later.')

        if doc and doc.get('userId') != user_id:
            # The key prefix is theirs, the document is not.
            print(f"Access denied: user {user_id} does not own document {iep_id}")
            return _cors_response(403, 'Access denied: cannot delete files belonging to other users')

    survived = []
    objects_deleted = 0

    # Order: the raw upload, then the artifacts derived from it, then the row
    # that points at them. Every pointer outlives the thing it points at, so a
    # retry after a partial failure can still find whatever survived: the row
    # carries contentS3Reference and is also the proof that this caller owns
    # the document. Both steps are idempotent (DeleteObject and DeleteItem
    # succeed on something already gone), so a retry converges instead of
    # failing on work the first attempt finished.
    try:
        s3.delete_object(Bucket=bucket, Key=key)
        objects_deleted += 1
        print(f"Deleted S3 object: {key}")
    except Exception as e:
        print(f"Error deleting S3 object {key}: {str(e)}")
        survived.append('raw-upload')

    if doc:
        try:
            objects_deleted += _delete_document_artifacts(s3, bucket, doc)
        except Exception as e:
            print(f"Error deleting S3 artifacts for iepId {iep_id}: {str(e)}")
            # Keep the row: it is the only pointer to the artifacts that
            # survived, so deleting it here would strand them where nothing
            # but scripts/purge-orphaned-artifacts.py could reach them.
            survived.extend(['derived-artifacts', 'document-row'])
        else:
            try:
                documents_table.delete_item(Key={'iepId': iep_id, 'childId': child_id})
                print(f"Deleted IEP document record with iepId: {iep_id}")
            except Exception as e:
                print(f"Error deleting IEP document record {iep_id}: {str(e)}")
                survived.append('document-row')
    elif iep_id:
        # No row: either it is already gone or this key never had one. The
        # derived artifacts are not swept here, because without a row there is
        # nothing that proves the caller owns this iepId; the orphan sweep
        # (scripts/purge-orphaned-artifacts.py) is what collects those.
        print(f"No document row for iepId {iep_id}; deleted the object only")

    if survived:
        _report_deletion_incomplete(user_id, iep_id, survived)
        return _cors_response(500, 'Could not delete the document. Please try again later.')

    return _cors_response(200, 'Deleted', {
        'key': key,
        'objectsDeleted': objects_deleted,
        'documentDeleted': doc is not None,
    })
