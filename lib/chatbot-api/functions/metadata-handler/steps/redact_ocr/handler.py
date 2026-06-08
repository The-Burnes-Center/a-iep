"""
Redact PII from OCR text using AWS Comprehend - Core business logic only
"""
import json
import os
import traceback
import boto3
from comprehend_redactor import redact_pii_from_texts

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
    Redact PII from OCR text using AWS Comprehend.
    Core redaction logic only - DDB operations handled by centralized service.
    """
    print(f"RedactOCR handler received: {json.dumps(_safe_event_meta(event))}")
    
    try:
        iep_id = event['iep_id']
        user_id = event['user_id']
        child_id = event['child_id']
        
        print("Starting PII redaction")
        print(f"Getting OCR data from DynamoDB for iepId: {iep_id}")
        
        # Get OCR result from DynamoDB via centralized DDB service
        lambda_client = boto3.client('lambda')
        ddb_service_name = event.get('ddb_service_arn') or os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')
        
        ddb_payload = {
            'operation': 'get_ocr_data',
            'params': {
                'iep_id': iep_id,
                'user_id': user_id,
                'child_id': child_id,
                'data_type': 'ocr_result'
            }
        }
        
        ddb_response = lambda_client.invoke(
            FunctionName=ddb_service_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(ddb_payload)
        )
        
        # Handle Lambda invoke response safely
        payload_response = ddb_response['Payload'].read()
        print(f"DDB raw response: {len(payload_response)} bytes")
        
        if not payload_response:
            raise Exception("Empty response from DDB service")
        
        try:
            ddb_result = json.loads(payload_response)
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse DDB service response as JSON: {e}. Response length: {len(payload_response)} bytes")
        
        print(f"DDB parsed result status: {ddb_result.get('statusCode') if isinstance(ddb_result, dict) else type(ddb_result).__name__}")
        
        if not ddb_result or ddb_result.get('statusCode') != 200:
            raise Exception(f"Failed to get OCR data from DDB: {ddb_result}")
        
        # Extract OCR data from DDB response
        response_body = json.loads(ddb_result['body'])
        actual_ocr_result = response_body['data']
        
        print(f"Retrieved OCR data from DynamoDB: {len(actual_ocr_result.get('pages', []))} pages")
        print(f"OCR result keys: {list(actual_ocr_result.keys()) if isinstance(actual_ocr_result, dict) else 'Not a dict'}")
        
        # Handle different OCR result formats
        page_texts = []
        
        # Format 1: OCR format with 'pages' array (Mistral and legacy)
        if actual_ocr_result and 'pages' in actual_ocr_result and isinstance(actual_ocr_result['pages'], list):
            print(f"Processing OCR format with {len(actual_ocr_result['pages'])} pages")
            
            for page in actual_ocr_result['pages']:
                # Follow original monolithic lambda priority: content → text → markdown → fallback
                if 'content' in page and page.get('content'):
                    page_texts.append(page.get('content', ''))
                elif 'text' in page and page.get('text'):
                    page_texts.append(page.get('text', ''))
                elif 'markdown' in page and page.get('markdown'):
                    page_texts.append(page.get('markdown', ''))
                else:
                    # Fallback: find any string field with substantial content
                    text_fields = [v for k, v in page.items() 
                                  if isinstance(v, str) and len(v) > 20]
                    if text_fields:
                        page_texts.append(text_fields[0])
                    else:
                        page_texts.append('')
        
        # Format 2: Mistral OCR format with 'document' structure
        elif actual_ocr_result and 'document' in actual_ocr_result:
            print("Processing Mistral OCR format")
            document = actual_ocr_result['document']
            
            if 'pages' in document and isinstance(document['pages'], list):
                print(f"Found {len(document['pages'])} pages in document format")
                for page in document['pages']:
                    if 'content' in page and page.get('content'):
                        page_texts.append(page.get('content', ''))
                    elif 'text' in page and page.get('text'):
                        page_texts.append(page.get('text', ''))
                    elif 'markdown' in page and page.get('markdown'):
                        page_texts.append(page.get('markdown', ''))
                    else:
                        # Fallback
                        text_fields = [v for k, v in page.items() 
                                      if isinstance(v, str) and len(v) > 20]
                        if text_fields:
                            page_texts.append(text_fields[0])
                        else:
                            page_texts.append('')
            elif 'text' in document:
                # Single text field for entire document
                print("Found single text field in Mistral document")
                page_texts.append(document['text'])
        
        # Format 3: Direct text content (fallback)
        elif actual_ocr_result and 'text' in actual_ocr_result:
            print("Processing direct text format")
            page_texts.append(actual_ocr_result['text'])
        
        # Format 4: Check if it's a string directly
        elif isinstance(actual_ocr_result, str):
            print("Processing string format")
            page_texts.append(actual_ocr_result)
        
        else:
            print(f"Unrecognized OCR format. Available keys: {list(actual_ocr_result.keys()) if isinstance(actual_ocr_result, dict) else 'N/A'}")
            print(f"OCR result type: {type(actual_ocr_result).__name__}")
            raise Exception("Invalid OCR result format for redaction")
        
        if page_texts:
            print(f"Redacting PII from {len(page_texts)} pages of text")
            
            # Use Comprehend to redact PII
            redacted_texts, stats = redact_pii_from_texts(page_texts)
            
            if redacted_texts:
                # Create redacted OCR result maintaining original structure
                redacted_ocr_result = {**actual_ocr_result}  # Copy original structure
                
                # Get reference to the actual OCR data to update
                target_ocr_result = redacted_ocr_result
                if 'ocr_result' in redacted_ocr_result:
                    target_ocr_result = redacted_ocr_result['ocr_result']
                
                # Update based on detected format
                if 'pages' in actual_ocr_result and isinstance(actual_ocr_result['pages'], list):
                    # Follow original monolithic lambda priority: content → text → markdown
                    for i, page in enumerate(target_ocr_result['pages']):
                        if i < len(redacted_texts):
                            if 'content' in page:
                                page['content'] = redacted_texts[i]
                            elif 'text' in page:
                                page['text'] = redacted_texts[i]
                            elif 'markdown' in page:
                                page['markdown'] = redacted_texts[i]
                elif 'document' in actual_ocr_result:
                    # Document format
                    if 'pages' in actual_ocr_result['document']:
                        for i, page in enumerate(target_ocr_result['document']['pages']):
                            if i < len(redacted_texts):
                                if 'content' in page:
                                    page['content'] = redacted_texts[i]
                                elif 'text' in page:
                                    page['text'] = redacted_texts[i]
                                elif 'markdown' in page:
                                    page['markdown'] = redacted_texts[i]
                    elif 'text' in actual_ocr_result['document']:
                        target_ocr_result['document']['text'] = redacted_texts[0]
                elif 'text' in actual_ocr_result:
                    # Direct text format
                    target_ocr_result['text'] = redacted_texts[0]
                elif isinstance(actual_ocr_result, str):
                    # String format - this case is more complex with nested structure
                    if 'ocr_result' in redacted_ocr_result:
                        redacted_ocr_result['ocr_result'] = redacted_texts[0]
                    else:
                        redacted_ocr_result = redacted_texts[0]
                
                print(f"PII redaction completed successfully. Stats: {stats}")
                
                # Save redacted OCR result to DynamoDB via centralized DDB service
                ddb_save_payload = {
                    'operation': 'save_ocr_data',
                    'params': {
                        'iep_id': iep_id,
                        'user_id': user_id,
                        'child_id': child_id,
                        'ocr_data': redacted_ocr_result,
                        'data_type': 'redacted_ocr_result'
                    }
                }
                
                ddb_save_response = lambda_client.invoke(
                    FunctionName=ddb_service_name,
                    InvocationType='RequestResponse',
                    Payload=json.dumps(ddb_save_payload)
                )
                
                ddb_save_result = json.loads(ddb_save_response['Payload'].read())
                print(f"DDB save redacted result: {ddb_save_result}")
                
                if ddb_save_result.get('statusCode') != 200:
                    raise Exception(f"Failed to save redacted OCR data to DDB: {ddb_save_result}")
                
                print(f"Successfully saved redacted OCR data to DynamoDB for iepId: {iep_id}")
                
                # Return minimal metadata (no large data in Step Functions)
                # Note: Don't pass through progress/current_step as they're managed by state machine
                event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
                return {
                    **event_copy,  # Pass through input data except progress tracking
                    'redaction_status': 'completed',
                    'page_count': len(actual_ocr_result.get('pages', [])),
                    'redacted_pages': len(redacted_texts),
                    'redaction_stats': stats,
                    'ddb_save_result': ddb_save_result
                }
            else:
                raise Exception("PII redaction failed - no redacted text returned")
        else:
            raise Exception("No text found in OCR result for redaction")
            
    except Exception as e:
        print(f"RedactOCR error: {str(e)}")
        print(traceback.format_exc())
        raise  # Let Step Functions retry policy handle the error