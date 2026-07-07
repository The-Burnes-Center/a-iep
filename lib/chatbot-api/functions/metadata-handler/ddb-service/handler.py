"""
DynamoDB Service Lambda - Centralized database operations for Step Functions workflow
Handles all DynamoDB read/write operations with standardized interface
"""
import json
import os
import boto3
import traceback
from datetime import datetime
from decimal import Decimal
from s3_content_handler import (
    save_content_to_s3,
    get_content_from_s3,
    delete_content_from_s3,
    migrate_dynamodb_to_s3,
    save_ocr_to_s3,
    get_ocr_s3_key
)

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['IEP_DOCUMENTS_TABLE'])

# The `params` block can carry FERPA-protected document content (OCR text,
# parsed sections, translated content) under keys like `ocr_data`/`content`.
# That must never reach CloudWatch, where any principal with log-read access
# could harvest it, so we log the operation plus only non-sensitive params.
_SENSITIVE_PARAM_FIELDS = {
    'ocr_data',       # save_ocr_data: full (or redacted) OCR text
    'content',        # save_content_to_s3: summaries/sections/meetingNotes/translations
    'results',        # save_results: processing results
    'final_result',   # save_final_results: combined final content
    'field_updates',  # save_api_fields: per-language content fields
    'items',          # append_to_list_field: content list items
}


def sanitize_event_for_logging(event):
    """Return a copy of the DDB service event with content-bearing params redacted.

    Keeps the operation name and non-sensitive scalar params (IDs, status,
    data_type, etc.) so logs stay useful, while never emitting document content.
    """
    if not isinstance(event, dict):
        return {'_type': type(event).__name__}
    safe = {'operation': event.get('operation')}
    params = event.get('params')
    if isinstance(params, dict):
        safe['params'] = {
            k: ('[REDACTED]' if k in _SENSITIVE_PARAM_FIELDS else v)
            for k, v in params.items()
        }
    elif params is not None:
        safe['params'] = '[REDACTED]'
    return safe


def lambda_handler(event, context):
    """
    Central DynamoDB service for all database operations.
    
    Expected event structure:
    {
        "operation": "update_progress|get_user_prefs|save_results|record_failure|get_document|save_ocr_data|get_ocr_data|get_analysis_data|save_final_results",
        "params": {
            // operation-specific parameters
        }
    }
"""
    print(f"DDB Service received: {json.dumps(sanitize_event_for_logging(event), default=str)}")
    
    try:
        operation = event.get('operation')
        params = event.get('params', {})
        
        if operation == 'update_progress':
            return update_progress(params)
        elif operation == 'get_user_prefs':
            return get_user_preferences(params)
        elif operation == 'save_results':
            return save_results(params)
        elif operation == 'record_failure':
            return record_failure(params)
        elif operation == 'get_document':
            return get_document(params)
        elif operation == 'save_ocr_data':
            return save_ocr_data(params)
        elif operation == 'get_ocr_data':
            return get_ocr_data(params)
        elif operation == 'delete_ocr_data':
            return delete_ocr_data(params)
        elif operation == 'get_analysis_data':
            return get_analysis_data(params)
        elif operation == 'save_final_results':
            return save_final_results(params)
        elif operation == 'save_api_fields':
            return save_api_fields(params)
        elif operation == 'append_to_list_field':
            return append_to_list_field(params)
        elif operation == 'get_document_with_content':
            return get_document_with_content(params)
        elif operation == 'save_content_to_s3':
            return save_content_to_s3_operation(params)
        elif operation == 'delete_content_from_s3':
            return delete_content_from_s3_operation(params)
        else:
            raise ValueError(f"Unknown operation: {operation}")
            
    except Exception as e:
        print(f"DDB Service error: {str(e)}")
        print(traceback.format_exc())
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'operation': event.get('operation', 'unknown')
            }, default=str)
        }

def update_progress(params):
    """Update document processing progress and status"""
    iep_id = params['iep_id']
    child_id = params['child_id'] 
    user_id = params['user_id']
    status = params.get('status', 'PROCESSING')
    current_step = params['current_step']
    progress = params['progress']
    error_message = params.get('error_message')
    last_error = params.get('last_error')
    
    update_expression = "SET #status = :status, current_step = :current_step, progress = :progress, updated_at = :updated_at"
    expression_values = {
        ':status': status,
        ':current_step': current_step,
        ':progress': progress,
        ':updated_at': datetime.utcnow().isoformat()
    }
    expression_names = {'#status': 'status'}
    
    if error_message:
        update_expression += ", error_message = :error_message"
        expression_values[':error_message'] = error_message
        
    if last_error:
        update_expression += ", last_error = :last_error"
        expression_values[':last_error'] = last_error
    
    table.update_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        },
        UpdateExpression=update_expression,
        ExpressionAttributeNames=expression_names,
        ExpressionAttributeValues=expression_values
    )
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Progress updated successfully',
            'iep_id': iep_id,
            'status': status,
            'progress': progress,
            'current_step': current_step
        }, default=str)
    }

def get_user_preferences(params):
    """Get user language preferences from profile"""
    user_id = params['user_id']
    
    # Use the user profiles table instead of documents table
    user_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])
    response = user_table.get_item(
        Key={'userId': user_id}
    )
    
    if 'Item' not in response:
        # Default to English only
        return {
            'statusCode': 200,
            'body': json.dumps({
                'languages': ['en'],
                'default_language': 'en'
            })
        }
    
    profile = response['Item']
    languages = profile.get('languages', ['en'])
    default_language = profile.get('default_language', 'en')
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'languages': languages,
            'default_language': default_language
        })
    }

def save_results(params):
    """Save processing results to DynamoDB"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    results = params['results']
    result_type = params.get('result_type', 'analysis')  # 'analysis', 'meeting_notes', 'translations'
    
    update_expression = f"SET {result_type} = :results, updated_at = :updated_at"
    expression_values = {
        ':results': results,
        ':updated_at': datetime.utcnow().isoformat()
    }
    
    table.update_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        },
        UpdateExpression=update_expression,
        ExpressionAttributeValues=expression_values
    )
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': f'{result_type} results saved successfully',
            'iep_id': iep_id
        }, default=str)
    }

def _cleanup_unredacted_artifacts(iep_id, child_id):
    """Delete the original uploaded document and raw OCR for a document.

    Data-retention policy: only redacted content may persist. On the happy
    path the DeleteOriginal step handles this; this runs on failure so a
    FAILED document also retains no unredacted artifacts.
    """
    response = table.get_item(Key={'iepId': iep_id, 'childId': child_id})
    item = response.get('Item', {})

    # Original uploaded file (documentUrl = s3://bucket/key)
    document_url = item.get('documentUrl') or ''
    if document_url.startswith('s3://'):
        bucket, _, key = document_url[len('s3://'):].partition('/')
        if bucket and key:
            delete_content_from_s3(key, bucket)

    # Raw OCR: S3 payload (new format) and/or inline attribute (legacy)
    s3_ref = item.get('ocr_result_s3_ref')
    if s3_ref:
        delete_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
    table.update_item(
        Key={'iepId': iep_id, 'childId': child_id},
        UpdateExpression="REMOVE ocr_result, ocr_result_s3_ref"
    )


def record_failure(params):
    """Record processing failure"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    error_message = params['error_message']
    failed_step = params.get('failed_step', 'unknown')

    # Best-effort purge of unredacted artifacts; must never mask the failure record
    try:
        _cleanup_unredacted_artifacts(iep_id, child_id)
    except Exception as cleanup_error:
        print(f"Cleanup of unredacted artifacts after failure did not complete: {str(cleanup_error)}")

    table.update_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        },
        UpdateExpression="SET #status = :status, error_message = :error_message, last_error = :last_error, failed_step = :failed_step, updated_at = :updated_at",
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'FAILED',
            ':error_message': error_message,
            ':last_error': error_message,
            ':failed_step': failed_step,
            ':updated_at': datetime.utcnow().isoformat()
        }
    )
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Failure recorded successfully',
            'iep_id': iep_id,
            'error': error_message
        }, default=str)
    }

def get_document(params):
    """Get document metadata and current processing status"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    
    response = table.get_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        }
    )
    
    if 'Item' not in response:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Document not found'})
        }
    
    # Convert Decimal types to float for JSON serialization
    item = response['Item']
    
    return {
        'statusCode': 200,
        'body': json.dumps(item, default=str)
    }

# Only these OCR attribute names may appear in update expressions
OCR_DATA_TYPES = {'ocr_result', 'redacted_ocr_result'}


def _validate_ocr_data_type(data_type):
    if data_type not in OCR_DATA_TYPES:
        raise ValueError(f"Invalid OCR data_type: {data_type}")


def save_ocr_data(params):
    """Save OCR data to S3 with a reference on the DynamoDB item.

    OCR payloads for large documents exceed the DynamoDB 400KB item limit
    (raw + redacted copies together broke processing), so the payload goes to
    S3 and the item only carries {data_type}_s3_ref. Any legacy inline
    attribute is removed in the same update.
    """
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    ocr_data = params['ocr_data']
    data_type = params.get('data_type', 'ocr_result')  # 'ocr_result' or 'redacted_ocr_result'
    _validate_ocr_data_type(data_type)

    s3_ref = save_ocr_to_s3(iep_id, child_id, data_type, ocr_data)

    table.update_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        },
        UpdateExpression=f"SET {data_type}_s3_ref = :s3_ref, updated_at = :updated_at REMOVE {data_type}",
        ExpressionAttributeValues={
            ':s3_ref': {'bucket': s3_ref['bucket'], 's3Key': s3_ref['s3Key']},
            ':updated_at': datetime.utcnow().isoformat()
        }
    )

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': f'{data_type} saved successfully',
            'iep_id': iep_id,
            's3_ref': {'bucket': s3_ref['bucket'], 's3Key': s3_ref['s3Key']}
        }, default=str)
    }

def get_ocr_data(params):
    """Get OCR data via its S3 reference (falling back to legacy inline attribute)"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    data_type = params.get('data_type', 'ocr_result')  # 'ocr_result' or 'redacted_ocr_result'
    _validate_ocr_data_type(data_type)

    response = table.get_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        }
    )

    if 'Item' not in response:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Document not found'})
        }

    item = response['Item']

    s3_ref = item.get(f'{data_type}_s3_ref')
    if s3_ref:
        data = get_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
        if data is None:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': f'{data_type} not found in S3'})
            }
        return {
            'statusCode': 200,
            'body': json.dumps({'data': data}, default=str)
        }

    # Legacy documents stored the OCR payload inline on the item
    if data_type not in item:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': f'{data_type} not found'})
        }

    return {
        'statusCode': 200,
        'body': json.dumps({
            'data': item[data_type]
        }, default=str)
    }

def delete_ocr_data(params):
    """Delete an OCR payload: the S3 object plus both item attributes.

    Used to purge the raw (unredacted) OCR once redaction has succeeded, and
    by the failure path so failed documents retain no unredacted content.
    """
    iep_id = params['iep_id']
    child_id = params['child_id']
    data_type = params.get('data_type', 'ocr_result')
    _validate_ocr_data_type(data_type)

    response = table.get_item(Key={'iepId': iep_id, 'childId': child_id})
    item = response.get('Item', {})

    s3_ref = item.get(f'{data_type}_s3_ref')
    if s3_ref:
        delete_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
    else:
        # Delete the conventional key too in case the ref write was lost
        delete_content_from_s3(get_ocr_s3_key(iep_id, child_id, data_type), os.environ.get('BUCKET', ''))

    table.update_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        },
        UpdateExpression=f"REMOVE {data_type}, {data_type}_s3_ref SET updated_at = :updated_at",
        ExpressionAttributeValues={
            ':updated_at': datetime.utcnow().isoformat()
        }
    )

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': f'{data_type} deleted',
            'iep_id': iep_id
        }, default=str)
    }

def save_final_results(params):
    """Save final results to S3 (new format) instead of DynamoDB"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    final_result = params['final_result']
    
    # Extract content components (all languages, all fields)
    content = {
        'summaries': final_result.get('summaries', {}),
        'sections': final_result.get('sections', {}),
        'document_index': final_result.get('document_index', {}),
        'abbreviations': final_result.get('abbreviations', {}),
        'meetingNotes': final_result.get('meetingNotes', {})
    }
    
    try:
        # Save content to S3
        s3_ref = save_content_to_s3(iep_id, child_id, content)
        
        # Update DynamoDB with S3 reference and remove old fields
        table.update_item(
            Key={
                'iepId': iep_id,
                'childId': child_id
            },
            UpdateExpression="""
                SET contentS3Reference = :s3_ref,
                    updated_at = :updated_at
                REMOVE summaries, sections, document_index, abbreviations, meetingNotes
            """,
            ExpressionAttributeValues={
                ':s3_ref': s3_ref,
                ':updated_at': datetime.utcnow().isoformat()
            }
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Final results saved successfully to S3',
                'iep_id': iep_id,
                's3_reference': s3_ref,
                'summaries_languages': list(content['summaries'].keys()),
                'sections_languages': list(content['sections'].keys()),
                'meeting_notes_languages': list(content['meetingNotes'].keys())
            }, default=str)
        }
    except Exception as e:
        print(f"Error saving final results to S3: {str(e)}")
        traceback.print_exc()
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': f'Failed to save final results to S3: {str(e)}',
                'iep_id': iep_id
            }, default=str)
        }

def get_analysis_data(params):
    """Get analysis data from DynamoDB (english_result, meeting_notes_result, etc.)"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    data_type = params.get('data_type', 'english_result')  # 'english_result', 'meeting_notes_result', etc.
    
    response = table.get_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        }
    )
    
    if 'Item' not in response:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Document not found'})
        }
    
    item = response['Item']
    
    if data_type not in item:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': f'{data_type} not found'})
        }
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'data': item[data_type]
        }, default=str)
    }

def save_api_fields(params):
    """Save individual API fields directly to DynamoDB (summaries.en, sections.es, etc.)"""
    iep_id = params['iep_id']
    child_id = params['child_id'] 
    user_id = params['user_id']
    field_updates = params['field_updates']  # Dict of field paths and their values
    
    print(f"Saving API fields for {iep_id}: {list(field_updates.keys())}")
    
    # First, ensure parent maps exist for nested fields
    parent_fields_to_init = set()
    nested_updates = []
    simple_updates = []
    
    for field_path, field_value in field_updates.items():
        if '.' in field_path:
            parts = field_path.split('.')
            if len(parts) == 2:
                parent_field, lang_key = parts
                parent_fields_to_init.add(parent_field)
                nested_updates.append((parent_field, lang_key, field_value))
        else:
            simple_updates.append((field_path, field_value))
    
    # Step 1: Initialize parent maps if they don't exist (if we have nested updates)
    if parent_fields_to_init:
        init_expressions = []
        init_expression_values = {}
        init_expression_names = {}
        
        for parent_field in parent_fields_to_init:
            parent_attr = f"#{parent_field}_init"
            empty_map_ref = f":empty_map_{parent_field}"
            
            init_expression_names[parent_attr] = parent_field
            init_expression_values[empty_map_ref] = {}
            
            init_expressions.append(f"{parent_attr} = if_not_exists({parent_attr}, {empty_map_ref})")
        
        init_expression = "SET " + ", ".join(init_expressions)
        
        print(f"Initializing parent maps: {init_expression}")
        
        try:
            table.update_item(
                Key={
                    'iepId': iep_id,
                    'childId': child_id
                },
                UpdateExpression=init_expression,
                ExpressionAttributeNames=init_expression_names,
                ExpressionAttributeValues=init_expression_values
            )
        except Exception as e:
            print(f"Error initializing parent maps: {str(e)}")
            # Continue anyway - they might already exist
    
    # Step 2: Update the actual values
    update_expressions = []
    expression_values = {}
    expression_names = {}
    value_counter = 0
    
    # Handle nested field updates
    for parent_field, lang_key, field_value in nested_updates:
        parent_attr = f"#{parent_field}_{value_counter}"
        lang_attr = f"#{lang_key}_{value_counter}"
        value_ref = f":val{value_counter}"
        
        expression_names[parent_attr] = parent_field
        expression_names[lang_attr] = lang_key
        expression_values[value_ref] = field_value
        
        update_expressions.append(f"{parent_attr}.{lang_attr} = {value_ref}")
        value_counter += 1
    
    # Handle simple field updates
    for field_path, field_value in simple_updates:
        attr_name = f"#{field_path}_{value_counter}"
        value_ref = f":val{value_counter}"
        
        expression_names[attr_name] = field_path
        expression_values[value_ref] = field_value
        
        update_expressions.append(f"{attr_name} = {value_ref}")
        value_counter += 1
    
    # Always update the timestamp
    expression_names["#updated_at"] = "updated_at"
    expression_values[":updated_at"] = datetime.utcnow().isoformat()
    update_expressions.append("#updated_at = :updated_at")
    
    # Build final update expression
    update_expression = "SET " + ", ".join(update_expressions)
    
    print(f"Saving API fields for {iep_id}: {list(field_updates.keys())}")
    print(f"Update expression: {update_expression}")
    
    try:
        table.update_item(
            Key={
                'iepId': iep_id,
                'childId': child_id
            },
            UpdateExpression=update_expression,
            ExpressionAttributeNames=expression_names,
            ExpressionAttributeValues=expression_values
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'API fields saved successfully: {list(field_updates.keys())}',
                'iep_id': iep_id,
                'fields_updated': list(field_updates.keys())
            }, default=str)
        }
        
    except Exception as e:
        print(f"Error saving API fields: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': f'Failed to save API fields: {str(e)}',
                'iep_id': iep_id,
                'attempted_fields': list(field_updates.keys())
            }, default=str)
        }

def append_to_list_field(params):
    """Append items to a list field in DynamoDB (e.g., sections.es)"""
    iep_id = params['iep_id']
    child_id = params['child_id'] 
    user_id = params['user_id']
    field_path = params['field_path']  # e.g., 'sections.es'
    items_to_append = params['items']  # List of items to append
    
    print(f"Appending {len(items_to_append)} items to {field_path} for {iep_id}")
    
    # Parse field path (e.g., 'sections.es' -> parent='sections', lang='es')
    if '.' not in field_path:
        raise ValueError(f"Invalid field path format: {field_path}. Expected format: 'parent.lang'")
    
    parts = field_path.split('.')
    if len(parts) != 2:
        raise ValueError(f"Invalid field path format: {field_path}. Expected format: 'parent.lang'")
    
    parent_field, lang_key = parts
    
    # First, ensure parent map exists
    try:
        table.update_item(
            Key={
                'iepId': iep_id,
                'childId': child_id
            },
            UpdateExpression="SET #parent = if_not_exists(#parent, :empty_map), #updated_at = :updated_at",
            ExpressionAttributeNames={
                '#parent': parent_field,
                '#updated_at': 'updated_at'
            },
            ExpressionAttributeValues={
                ':empty_map': {},
                ':updated_at': datetime.utcnow().isoformat()
            }
        )
    except Exception as e:
        print(f"Error initializing parent map: {str(e)}")
        # Continue anyway - it might already exist
    
    # Append items to the list using list_append
    # If the list doesn't exist, create it with the items; otherwise append
    try:
        table.update_item(
            Key={
                'iepId': iep_id,
                'childId': child_id
            },
            UpdateExpression="SET #parent.#lang = list_append(if_not_exists(#parent.#lang, :empty_list), :items), #updated_at = :updated_at",
            ExpressionAttributeNames={
                '#parent': parent_field,
                '#lang': lang_key,
                '#updated_at': 'updated_at'
            },
            ExpressionAttributeValues={
                ':empty_list': [],
                ':items': items_to_append,
                ':updated_at': datetime.utcnow().isoformat()
            }
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'Appended {len(items_to_append)} items to {field_path}',
                'iep_id': iep_id,
                'field_path': field_path,
                'items_appended': len(items_to_append)
            }, default=str)
        }
        
    except Exception as e:
        print(f"Error appending to list field: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': f'Failed to append to list field: {str(e)}',
                'iep_id': iep_id,
                'field_path': field_path
            }, default=str)
        }

def get_document_with_content(params):
    """Get document with content (handles lazy migration from DynamoDB to S3)"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    user_id = params['user_id']
    
    response = table.get_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        }
    )
    
    if 'Item' not in response:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Document not found'})
        }
    
    item = response['Item']
    
    # Check if content is in S3 (new format) or DynamoDB (old format)
    if 'contentS3Reference' in item:
        # New format: fetch from S3
        s3_ref = item['contentS3Reference']
        print(f"Found S3 reference for {iep_id}/{child_id}: {s3_ref.get('s3Key', 'N/A')}")
        content = get_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
        
        if content:
            print(f"Successfully retrieved content from S3. Keys: {list(content.keys())}")
            # Merge metadata with content
            result = {k: v for k, v in item.items() if k != 'contentS3Reference'}
            result.update(content)
            return {
                'statusCode': 200,
                'body': json.dumps(result, default=str)
            }
        else:
            # S3 fetch failed, return metadata only
            print(f"Warning: Failed to fetch content from S3 for {iep_id}/{child_id}")
            return {
                'statusCode': 200,
                'body': json.dumps(item, default=str)
            }
    else:
        # Old format: migrate to S3
        print(f"Migrating {iep_id}/{child_id} from DynamoDB to S3 (lazy migration)")
        print(f"Document keys before migration: {list(item.keys())}")
        s3_ref = migrate_dynamodb_to_s3(iep_id, child_id, item, table)
        
        if s3_ref:
            # Re-fetch item to get updated version
            response = table.get_item(
                Key={
                    'iepId': iep_id,
                    'childId': child_id
                }
            )
            item = response['Item']
            
            if 'contentS3Reference' in item:
                s3_ref = item['contentS3Reference']
                content = get_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
                
                if content:
                    result = {k: v for k, v in item.items() if k != 'contentS3Reference'}
                    result.update(content)
                    return {
                        'statusCode': 200,
                        'body': json.dumps(result, default=str)
                    }
        
        # Migration failed or no content, return as-is
        print(f"Warning: Migration failed or no content for {iep_id}/{child_id}")
        return {
            'statusCode': 200,
            'body': json.dumps(item, default=str)
        }

def save_content_to_s3_operation(params):
    """Save content to S3 and update DynamoDB reference - merges with existing content"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    new_content = params['content']  # New content dict with all languages
    
    try:
        # Get existing content from S3 if it exists (for merging)
        response = table.get_item(
            Key={
                'iepId': iep_id,
                'childId': child_id
            }
        )
        
        existing_content = {}
        if 'Item' in response:
            item = response['Item']
            if 'contentS3Reference' in item:
                s3_ref = item['contentS3Reference']
                existing_content = get_content_from_s3(s3_ref['s3Key'], s3_ref['bucket']) or {}
                print(f"Found existing content in S3, merging with new content")
                print(f"Existing meetingNotes keys: {list(existing_content.get('meetingNotes', {}).keys())}")
        
        # Merge existing content with new content (new content takes precedence for non-empty values)
        merged_content = {
            'summaries': existing_content.get('summaries', {}),
            'sections': existing_content.get('sections', {}),
            'document_index': existing_content.get('document_index', {}),
            'abbreviations': existing_content.get('abbreviations', {}),
            'meetingNotes': existing_content.get('meetingNotes', {})
        }
        
        print(f"Before merge - existing meetingNotes keys: {list(merged_content.get('meetingNotes', {}).keys())}")
        print(f"New content meetingNotes keys: {list(new_content.get('meetingNotes', {}).keys()) if isinstance(new_content.get('meetingNotes'), dict) else 'not-a-dict'}")
        
        # Merge new content - only update non-empty values
        for field in ['summaries', 'sections', 'document_index', 'abbreviations', 'meetingNotes']:
            if field in new_content:
                if isinstance(new_content[field], dict):
                    # Merge dictionaries (e.g., {'en': '...', 'es': '...'})
                    # Only merge if the dict has actual content (not empty)
                    if new_content[field]:
                        print(f"Merging {field} - new keys: {list(new_content[field].keys())}")
                        merged_content[field].update(new_content[field])
                    else:
                        print(f"Skipping {field} - empty dict, preserving existing content")
                    # If new_content[field] is empty dict, don't overwrite existing content
                else:
                    # Replace non-dict values only if non-empty
                    if new_content[field]:
                        merged_content[field] = new_content[field]
        
        print(f"After merge - meetingNotes keys: {list(merged_content.get('meetingNotes', {}).keys())}")
        if 'en' in merged_content.get('meetingNotes', {}):
            en_length = len(merged_content['meetingNotes']['en'])
            print(f"English meeting notes length: {en_length} characters")
        
        # Save merged content to S3
        s3_ref = save_content_to_s3(iep_id, child_id, merged_content)
        
        # Update DynamoDB - remove old fields and add S3 reference
        table.update_item(
            Key={
                'iepId': iep_id,
                'childId': child_id
            },
            UpdateExpression="""
                SET contentS3Reference = :s3_ref,
                    updated_at = :updated_at
                REMOVE summaries, sections, document_index, abbreviations, meetingNotes
            """,
            ExpressionAttributeValues={
                ':s3_ref': s3_ref,
                ':updated_at': datetime.utcnow().isoformat()
            }
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Content saved to S3 successfully (merged)',
                's3_reference': s3_ref,
                'iep_id': iep_id,
                'merged_fields': list(merged_content.keys())
            }, default=str)
        }
    except Exception as e:
        print(f"Error saving content to S3: {str(e)}")
        traceback.print_exc()
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': f'Failed to save content to S3: {str(e)}',
                'iep_id': iep_id
            }, default=str)
        }

def delete_content_from_s3_operation(params):
    """Delete content from S3"""
    iep_id = params['iep_id']
    child_id = params['child_id']
    
    # Get S3 reference from DynamoDB
    response = table.get_item(
        Key={
            'iepId': iep_id,
            'childId': child_id
        }
    )
    
    if 'Item' not in response:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Document not found'})
        }
    
    item = response['Item']
    
    if 'contentS3Reference' in item:
        s3_ref = item['contentS3Reference']
        success = delete_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
        
        if success:
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'Content deleted from S3 successfully',
                    'iep_id': iep_id
                })
            }
        else:
            return {
                'statusCode': 500,
                'body': json.dumps({
                    'error': 'Failed to delete content from S3',
                    'iep_id': iep_id
                })
            }
    else:
        # No S3 content to delete
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'No S3 content to delete',
                'iep_id': iep_id
            })
        }