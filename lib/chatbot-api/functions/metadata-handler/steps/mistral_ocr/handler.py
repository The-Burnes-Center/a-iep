"""
Process document with Mistral OCR API - Core business logic only
"""
import json
import os
import traceback
import boto3
from mistral_ocr import process_document_with_mistral_ocr, _safe_key

# Only non-sensitive metadata is safe to log. These events can carry
# FERPA-protected document content (OCR text, parsed sections, translated
# content) as the workflow evolves; dumping the whole event would expose it
# to anyone with CloudWatch log access.
#
# s3_key is deliberately NOT in this allowlist: the key is
# userId/childId/iepId/<filename>, and parents routinely name an IEP after
# their child, so the filename is student data. It is logged separately below
# with the filename stripped (see _safe_key).
_SAFE_LOG_FIELDS = (
    'iep_id', 'child_id', 'user_id', 's3_bucket', 'current_step',
    'progress', 'status', 'content_type', 'target_languages', 'translation_needed',
)


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
            # The filename (student data) must not reach this message: it is
            # raised, caught by the state machine's Catch, and persisted as
            # error_message on the document row (not just printed).
            error_message = "Cannot process a JSON file as a document. Only PDF/image files can be processed with OCR."
            print(error_message)
            raise Exception(error_message)

        # Process document with Mistral OCR
        print(f"Processing document: s3://{s3_bucket}/{_safe_key(s3_key)}")
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
        print(f"MistralOCR error: {_safe_error_summary(e)}")
        # NOT traceback.format_exc(): its last line renders str(e), which is
        # exactly what the summary above was built to avoid.
        print(''.join(traceback.format_tb(e.__traceback__)))
        raise  # Let Step Functions retry policy handle the error