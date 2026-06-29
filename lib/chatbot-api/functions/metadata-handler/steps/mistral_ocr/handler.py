"""
Process document with Mistral OCR API - Core business logic only
"""
import json
import os
import traceback
import boto3
from mistral_ocr import process_document_with_mistral_ocr

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
    Extract text from document using Mistral OCR API.
    Core OCR logic only - DDB operations handled by centralized service.
    """
    print(f"MistralOCR handler received: {json.dumps(_safe_event_meta(event))}")
    
    try:
        s3_bucket = event['s3_bucket']
        s3_key = event['s3_key']
        iep_id = event['iep_id']
        user_id = event['user_id']
        child_id = event['child_id']
        
        # Validate that this is a document file, not a JSON content file
        if s3_key.endswith('content.json') or '/content.json' in s3_key or s3_key.lower().endswith('.json'):
            error_message = f"Cannot process JSON file as document: {s3_key}. Only PDF/image files can be processed with OCR."
            print(error_message)
            raise Exception(error_message)
        
        # Process document with Mistral OCR
        print(f"Processing document: s3://{s3_bucket}/{s3_key}")
        ocr_result = process_document_with_mistral_ocr(s3_bucket, s3_key)
        
        # Check if OCR was successful
        if "error" in ocr_result:
            error_message = f"OCR processing failed: {ocr_result['error']}"
            print(error_message)
            raise Exception(error_message)
        
        print(f"OCR completed successfully. Found {len(ocr_result.get('pages', []))} pages")
        
        # Save OCR result to DynamoDB via centralized DDB service
        lambda_client = boto3.client('lambda')
        ddb_service_name = event.get('ddb_service_arn') or os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')
        
        ddb_payload = {
            'operation': 'save_ocr_data',
            'params': {
                'iep_id': iep_id,
                'user_id': user_id,
                'child_id': child_id,
                'ocr_data': ocr_result,
                'data_type': 'ocr_result'
            }
        }
        
        ddb_response = lambda_client.invoke(
            FunctionName=ddb_service_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(ddb_payload)
        )
        
        ddb_result = json.loads(ddb_response['Payload'].read())
        print(f"DDB save result: {ddb_result}")
        
        if ddb_result.get('statusCode') != 200:
            raise Exception(f"Failed to save OCR data to DDB: {ddb_result}")
        
        print(f"Successfully saved OCR data to DynamoDB for iepId: {iep_id}")
        
        # Return minimal metadata (no large OCR data in Step Functions)
        # Note: Don't pass through progress/current_step as they're managed by state machine
        event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
        return {
            **event_copy,  # Pass through input data except progress tracking
            'ocr_status': 'completed',
            'page_count': len(ocr_result.get('pages', [])),
            'ddb_save_result': ddb_result
        }
        
    except Exception as e:
        print(f"MistralOCR error: {str(e)}")
        print(traceback.format_exc())
        raise  # Let Step Functions retry policy handle the error