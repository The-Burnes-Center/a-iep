"""
Delete the original uploaded file from S3 - Core business logic only
"""
import json
import os
import traceback
import boto3

def delete_s3_object(bucket, key):
    """Delete an object from S3"""
    try:
        s3 = boto3.client('s3')
        # Check if object exists before deleting
        try:
            s3.head_object(Bucket=bucket, Key=key)
            s3.delete_object(Bucket=bucket, Key=key)
            print(f"Deleted S3 object: {bucket}/{key}")
        except s3.exceptions.ClientError as e:
            if e.response['Error']['Code'] == '404':
                print(f"S3 object does not exist, no need to delete: {bucket}/{key}")
            else:
                raise
    except Exception as e:
        print(f"Failed to delete S3 object: {bucket}/{key} - {e}")
        raise

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


def delete_raw_ocr(event):
    """Delete the raw (unredacted) OCR payload via the centralized DDB service."""
    lambda_client = boto3.client('lambda')
    ddb_service_name = event.get('ddb_service_arn') or os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')

    ddb_payload = {
        'operation': 'delete_ocr_data',
        'params': {
            'iep_id': event['iep_id'],
            'user_id': event.get('user_id'),
            'child_id': event['child_id'],
            'data_type': 'ocr_result'
        }
    }

    ddb_response = lambda_client.invoke(
        FunctionName=ddb_service_name,
        InvocationType='RequestResponse',
        Payload=json.dumps(ddb_payload)
    )

    ddb_result = json.loads(ddb_response['Payload'].read())
    if not ddb_result or ddb_result.get('statusCode') != 200:
        raise Exception(f"Failed to delete raw OCR data: {ddb_result}")

    print("Successfully deleted raw OCR data")


def lambda_handler(event, context):
    """
    Delete the original uploaded file from S3.
    Core deletion logic only - DDB operations handled by centralized service.
    """
    print(f"DeleteOriginal handler received: {json.dumps(_safe_event_meta(event))}")
    
    try:
        s3_bucket = event['s3_bucket']
        s3_key = event['s3_key']
        
        print(f"Deleting original file: s3://{s3_bucket}/{s3_key}")

        # Delete the original file from S3
        delete_s3_object(s3_bucket, s3_key)

        print("Successfully deleted original file")

        # Data-retention: redaction has succeeded by this point and every
        # downstream step reads redacted_ocr_result only, so the raw
        # (unredacted) OCR must be purged along with the original document.
        delete_raw_ocr(event)

        return event  # Pass through all input data unchanged
        
    except Exception as e:
        print(f"DeleteOriginal error: {str(e)}")
        print(traceback.format_exc())
        raise  # Let Step Functions retry policy handle the error