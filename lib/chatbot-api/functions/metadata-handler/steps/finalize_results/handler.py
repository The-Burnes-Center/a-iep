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
_SAFE_LOG_FIELDS = (
    'iep_id', 'child_id', 'user_id', 's3_bucket', 's3_key', 'current_step',
    'progress', 'status', 'content_type', 'target_languages', 'translation_needed',
)


def _safe_event_meta(event):
    """Return only the allowlisted, non-sensitive fields from the event."""
    if not isinstance(event, dict):
        return {'_type': type(event).__name__}
    return {k: event[k] for k in _SAFE_LOG_FIELDS if k in event}


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
        print(f"FinalizeResults error: {str(e)}")
        print(traceback.format_exc())
        
        # Record failure
        try:
            failure_payload = {
                'operation': 'record_failure',
                'params': {
                    'iep_id': event.get('iep_id', ''),
                    'user_id': event.get('user_id', ''),
                    'child_id': event.get('child_id', ''),
                    'error_message': str(e),
                    'failed_step': 'finalize_results'
                }
            }
            
            lambda_client = boto3.client('lambda')
            ddb_service_name = os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')
            
            lambda_client.invoke(
                FunctionName=ddb_service_name,
                InvocationType='RequestResponse',
                Payload=json.dumps(failure_payload)
            )
        except:
            print("Failed to record error in DDB")
        
        raise