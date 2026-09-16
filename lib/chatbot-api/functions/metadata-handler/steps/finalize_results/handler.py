"""
Simplified final step: Mark document as completed
All data is already saved in API format by individual steps
"""
import json
import os
import traceback
import boto3

# Only non-sensitive metadata is safe to log. These events can carry
# FERPA-protected document content (OCR text, parsed sections, translated
# content) as the workflow evolves; dumping the whole event would expose it
# to anyone with CloudWatch log access.
# s3_key is deliberately NOT in this allowlist: the key is
# userId/childId/iepId/<filename>, and parents routinely name an IEP after
# their child, so the filename is student data. It is logged separately below
# with the filename stripped (see _safe_key).
_SAFE_LOG_FIELDS = (
    'iep_id', 'child_id', 'user_id', 's3_bucket', 'current_step',
    'progress', 'status', 'content_type', 'target_languages', 'translation_needed',
)


def _safe_key(key):
    """An S3 key with the parent-chosen filename removed.

    The key is userId/childId/iepId/filename, and only the last segment is
    typed by a human. Mirrors metadata-handler/orchestrator.py's helper of the
    same name.
    """
    if not isinstance(key, str):
        return '<no key>'
    head, sep, _filename = key.rpartition('/')
    return f'{head}/...' if sep else '...'


def _safe_event_meta(event):
    """Return only the allowlisted, non-sensitive fields from the event."""
    if not isinstance(event, dict):
        return {'_type': type(event).__name__}
    meta = {k: event[k] for k in _SAFE_LOG_FIELDS if k in event}
    if 's3_key' in event:
        meta['s3_key'] = _safe_key(event['s3_key'])
    return meta


def _safe_error_summary(e):
    """Content-free triage string for the outermost catch-all.

    This is the last uncovered path by which a rejected value could reach
    CloudWatch: every step re-raises, so whatever this catches is about to be
    logged (and the Lambda runtime logs it again, unhandled, on top of that).
    Reduced to the exception class only -- unlike a message string, a class
    name cannot itself carry document text.
    """
    return type(e).__name__


def lambda_handler(event, context):
    """
    Simplified final step that only marks the document as PROCESSED with 100% progress.
    No data combination needed since all agents save directly to API-compatible fields.
    """
    print(f"FinalizeResults handler received: {json.dumps(_safe_event_meta(event))}")
    
    try:
        iep_id = event['iep_id']
        user_id = event['user_id']
        child_id = event['child_id']
        
        # Mark document as completed using centralized DDB service
        lambda_client = boto3.client('lambda')
        ddb_service_name = os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')

        print(f"Marking document {iep_id} as PROCESSED with 100% progress")
        
        # Update status to PROCESSED with 100% completion
        progress_payload = {
            'operation': 'update_progress',
            'params': {
                'iep_id': iep_id,
                'user_id': user_id,
                'child_id': child_id,
                'status': 'PROCESSED',
                'current_step': 'completed',
                'progress': 100
            }
        }
        
        progress_response = lambda_client.invoke(
            FunctionName=ddb_service_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(progress_payload)
        )
        
        # Handle Lambda invoke response safely
        progress_payload_response = progress_response['Payload'].read()
        
        if not progress_payload_response:
            raise Exception("Empty response from DDB service during progress update")
        
        try:
            progress_result = json.loads(progress_payload_response)
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse progress update response: {e}")
        
        if not progress_result or progress_result.get('statusCode') != 200:
            raise Exception(f"Failed to update progress to completion: {progress_result}")
        
        print(f"Document {iep_id} successfully marked as PROCESSED")
        
        # Return success result
        return {
            'iep_id': iep_id,
            'user_id': user_id, 
            'child_id': child_id,
            'status': 'PROCESSED',
            'progress': 100,
            'current_step': 'completed',
            'finalized': True,
            'message': 'Document processing completed successfully'
        }
        
    except Exception as e:
        print(f"FinalizeResults error: {_safe_error_summary(e)}")
        # NOT traceback.format_exc(): its last line renders str(e), which is
        # exactly what the summary above was built to avoid.
        print(''.join(traceback.format_tb(e.__traceback__)))

        # Raise and record nothing. The state machine's Catch on FinalizeResults
        # (FailedAtFinalizeResults -> RecordFailure in
        # state-machines/iep-processing.asl.json) is the single writer of the
        # failure row, exactly as it is for every other step in the pipeline.
        #
        # This step used to invoke record_failure itself and THEN re-raise, so
        # the Catch wrote the same row a second time. FinalizeResults retries
        # three times, so one failing document logged the RECORD_FAILURE marker
        # up to five times: once per attempt, plus once from the Catch.
        # MonitoringStack's DocumentFailureFilter counts that marker, so one
        # failed document was reported as five, and ddb-service's
        # _cleanup_unredacted_artifacts (which record_failure runs) purged the
        # same document five times over.
        #
        # Nothing is lost by dropping the inner call. Cleanup lives inside
        # record_failure in ddb-service, not here, so the Catch's invocation
        # runs it; and the Catch's error_message ($.error.Cause) contains the
        # errorMessage this used to pass as str(e), plus the type and stack.
        #
        # It also means no failure row is written on a non-final attempt, which
        # is the point: a retry that has not run out of attempts is not a failed
        # document. Writing one would show the parent a FAILED document the
        # pipeline is still working on, and would run the unredacted-artifact
        # purge on a document that is about to try again.
        raise