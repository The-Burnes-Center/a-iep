"""Delete a child's superseded IEP documents once their replacement is ready.

One active IEP per child: when a parent uploads a new one, the previous
document goes. It goes only AFTER the new document has finished processing
(the pipeline's PurgeReplacedDocuments state calls purge_replaced_documents
once FinalizeResults has marked it PROCESSED). Deleting at upload time, as
this used to, left a parent with no IEP whenever the upload was cancelled, the
PUT never landed, or the pipeline failed.

What a failure here means: the new document is already complete and visible,
so nothing is rolled back and nothing is raised. The survivors are reported
with the DELETION_INCOMPLETE marker so an operator can finish the job.
"""
import json
import os

import boto3
from boto3.dynamodb.conditions import Key

from s3_content_handler import delete_every_version

READY_STATUS = 'PROCESSED'

# Stop starting new documents with less than this left on the lambda clock, so
# the marker below is logged rather than the invocation being killed mid-run.
LOW_TIME_MARGIN_MS = 15_000

# Only what the purge reads. Rows can carry large inline summaries.
_PROJECTION = 'iepId, childId, userId, createdAt, contentS3Reference'


class ReplacementNotReady(ValueError):
    """The document that supposedly replaces the others is not finished."""


def _report_incomplete(user_id, child_id, iep_id, superseded, survived):
    """The one line an alarm can count when the cleanup did not finish.

    DELETION_INCOMPLETE is a stable marker, not prose: a metric filter alarms
    on it, and rewording this line would disarm that alarm. Same contract as
    the user-profile-handler emitter (scope differs). Ids and
    artifact kinds only: exception text can quote a filename.
    """
    print(f"DELETION_INCOMPLETE scope=replaced-document essential=yes user={user_id} "
          f"child={child_id} iep={iep_id} superseded={','.join(sorted(set(superseded)))} "
          f"survived={','.join(sorted(set(survived)))}")


def _require_ready_replacement(table, iep_id, child_id, user_id):
    """The replacement's row, or ReplacementNotReady.

    Nothing may be deleted on behalf of a document that is not complete and
    the caller's own: this is the check that keeps a stray or replayed call
    from deleting a family's only IEP.
    """
    row = table.get_item(Key={'iepId': iep_id, 'childId': child_id}).get('Item')
    if not row or row.get('userId') != user_id:
        raise ReplacementNotReady('replacement document not found for this user')
    if row.get('status') != READY_STATUS:
        raise ReplacementNotReady('replacement document is not finished processing')
    if row.get('createdAt') is None:
        raise ReplacementNotReady('replacement document has no creation time')
    return row


def _superseded_documents(table, replacement, user_id):
    """The user's other documents for this child, except any created AFTER the replacement.

    Strict ownership (an explicit userId match), and never the replacement
    itself: that is what the iepId check is for, and it is the only thing
    that protects it. A document created after it is left alone: the parent
    may have uploaded again while this run was in flight, and that newer
    upload is the one they are waiting for. It cleans up after itself when
    it finishes.
    """
    superseded = []
    query = {
        'IndexName': 'byChildId',
        'KeyConditionExpression': Key('childId').eq(replacement['childId']),
        'ProjectionExpression': _PROJECTION,
    }
    while True:
        page = table.query(**query)
        for doc in page.get('Items', []):
            if doc['iepId'] == replacement['iepId']:
                continue
            if doc.get('userId') != user_id:
                continue
            if doc.get('createdAt', 0) > replacement['createdAt']:
                continue
            superseded.append(doc)
        if not page.get('LastEvaluatedKey'):
            return superseded
        query['ExclusiveStartKey'] = page['LastEvaluatedKey']


def _purge_artifacts(s3, bucket, doc, user_id):
    """Every S3 artifact of one document, every version. Returns what survived.

    Mirrors _delete_document_artifacts in user-profile-handler:
    the raw upload prefix, the summary object contentS3Reference points at,
    and the legacy iep-data / cached iep-audio prefixes. Translations live in
    the summary object. Each group is independent, so one failing does not
    abandon the rest.
    """
    iep_id, child_id = doc['iepId'], doc['childId']
    survived = []

    try:
        delete_every_version(s3, bucket, f'{user_id}/{child_id}/{iep_id}/')
    except Exception as error:  # noqa: BLE001 - reported through the marker
        print(f'Replaced-document purge left the raw upload: {type(error).__name__}')
        survived.append('raw-upload')

    try:
        ref = doc.get('contentS3Reference') or {}
        if ref.get('s3Key'):
            delete_every_version(s3, ref.get('bucket') or bucket, ref['s3Key'], exact=True)
        delete_every_version(s3, bucket, f'iep-data/{iep_id}/{child_id}/')
        delete_every_version(s3, bucket, f'iep-audio/{iep_id}/{child_id}/')
    except Exception as error:  # noqa: BLE001 - reported through the marker
        print(f'Replaced-document purge left derived artifacts: {type(error).__name__}')
        survived.append('derived-artifacts')
    return survived


def _purge_document(table, s3, bucket, doc, user_id):
    """Artifacts first, then the row. Returns the kinds that survived.

    The row carries contentS3Reference, the only pointer to the summary, and is
    the retry handle, so it outlives anything that could not be deleted.
    """
    survived = _purge_artifacts(s3, bucket, doc, user_id)
    if survived:
        return survived + ['document-row']
    try:
        table.delete_item(Key={'iepId': doc['iepId'], 'childId': doc['childId']})
    except Exception as error:  # noqa: BLE001 - reported through the marker
        print(f'Replaced-document purge left the document row: {type(error).__name__}')
        return ['document-row']
    return []


def purge_replaced_documents(table, params, context=None):
    """Delete the child's documents older than the one that just finished.

    Raises ReplacementNotReady (a refusal, nothing deleted) when the named
    document is not a finished one of the caller's. Any other trouble is
    reported rather than raised: the replacement is already complete and must
    stay so, which is why a failure is logged with DELETION_INCOMPLETE and the
    result still reports success.
    """
    iep_id = params.get('iep_id')
    child_id = params.get('child_id')
    user_id = params.get('user_id')
    if not (iep_id and child_id and user_id):
        raise ValueError('iep_id, child_id and user_id are required')

    replacement = _require_ready_replacement(table, iep_id, child_id, user_id)

    try:
        superseded = _superseded_documents(table, replacement, user_id)
    except Exception as error:  # noqa: BLE001 - reported through the marker
        print(f'Replaced-document purge could not list the child\'s documents: '
              f'{type(error).__name__}')
        _report_incomplete(user_id, child_id, iep_id, [], ['document-listing'])
        return _result(iep_id, [], ['document-listing'])

    s3 = boto3.client('s3')
    bucket = os.environ.get('BUCKET', '')
    purged, left_behind, survived = [], [], []
    for doc in superseded:
        out_of_time = (context is not None
                       and context.get_remaining_time_in_millis() < LOW_TIME_MARGIN_MS)
        left = ['time-budget'] if out_of_time else _purge_document(table, s3, bucket, doc, user_id)
        if left:
            left_behind.append(doc['iepId'])
            survived.extend(left)
        else:
            purged.append(doc['iepId'])
            print(f"Deleted replaced IEP document {doc['iepId']}")

    if survived:
        _report_incomplete(user_id, child_id, iep_id, left_behind, survived)
    return _result(iep_id, purged, survived, left_behind)


def _result(iep_id, purged, survived, left_behind=()):
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Replaced documents purged' if not survived
                       else 'Replaced documents only partly purged',
            'iep_id': iep_id,
            'purged': purged,
            'incomplete': list(left_behind),
        }),
    }
