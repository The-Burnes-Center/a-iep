"""
DynamoDB Service Lambda - Centralized database operations for Step Functions workflow
Handles all DynamoDB read/write operations with standardized interface
"""
import json
import os
import boto3
import traceback
from botocore.exceptions import ClientError
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


class DocumentDeleted(Exception):
    """The document row was deleted while the pipeline was still running."""


def _guarded_update(**kwargs):
    """update_item that refuses to recreate a row somebody deleted.

    DynamoDB's update_item is an upsert, so every write in this module used to
    resurrect a document that had already been deleted. That is not a rare
    race: one active IEP per child means the upload path replaces (and deletes)
    the previous document, so re-uploading while a run is still in flight hits
    it directly.

    A resurrected row carries only the attributes of the single write that
    recreated it. It has no userId, and DynamoDB does not index items missing
    the key, so the row is invisible to the byUserId GSI and therefore immune
    to account deletion forever. Production holds exactly one:
    iep-1779204464686-sphdqh6kagq, whose attributes are precisely the set
    record_failure writes, with no userId, documentUrl or createdAt.

    REMOVE-only updates need the guard just as much as SET: removing an
    attribute from an absent item still creates it.
    """
    condition = 'attribute_exists(iepId)'
    existing = kwargs.get('ConditionExpression')
    kwargs['ConditionExpression'] = f'({existing}) AND {condition}' if existing else condition
    try:
        return table.update_item(**kwargs)
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            raise DocumentDeleted(
                f"document {kwargs.get('Key', {}).get('iepId')} was deleted while "
                'the pipeline was running; refusing to recreate it'
            ) from e
        raise

# The `params` block can carry FERPA-protected document content (OCR text,
# parsed sections, translated content) under keys like `ocr_data`/`content`.
# That must never reach CloudWatch, where any principal with log-read access
# could harvest it, so we log the operation plus only non-sensitive params.
_SENSITIVE_PARAM_FIELDS = {
    'ocr_data',       # save_ocr_data: full (or redacted) OCR text
    'content',        # save_content_to_s3: summaries/sections/translations
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
        "operation": "update_progress|record_failure|get_document|save_ocr_data|get_ocr_data",
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
        elif operation == 'get_document_with_content':
            return get_document_with_content(params)
        elif operation == 'save_content_to_s3':
            return save_content_to_s3_operation(params)
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
    
    _guarded_update(
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
    _guarded_update(
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

    # A document deleted mid-run has no failure left to record, and writing one
    # anyway is what created production's single phantom row. This is the one
    # caller that treats a vanished document as success: it is the terminal
    # state, so raising here would only fail the execution over a row the user
    # deliberately removed.
    try:
        _guarded_update(
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
    except DocumentDeleted as deleted:
        print(f"Not recording a failure: {deleted}")
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Document was deleted mid-run; no failure recorded',
                'iep_id': iep_id,
                'documentDeleted': True
            }, default=str)
        }

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

    # The S3 write lands before the row update, so a row deleted in between
    # leaves the object with nothing pointing at it. Roll it back rather than
    # strand OCR text (the unredacted variant included) in the bucket.
    try:
        _guarded_update(
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
    except DocumentDeleted:
        delete_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
        print(f"Rolled back {data_type} object for a document deleted mid-run")
        raise

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

    _guarded_update(
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
        
        # Merge existing content with new content (new content takes precedence for non-empty values)
        merged_content = {
            'summaries': existing_content.get('summaries', {}),
            'sections': existing_content.get('sections', {}),
            'document_index': existing_content.get('document_index', {}),
            'abbreviations': existing_content.get('abbreviations', {})
        }
        
        # Merge new content - only update non-empty values
        for field in ['summaries', 'sections', 'document_index', 'abbreviations']:
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
        
        # Save merged content to S3
        s3_ref = save_content_to_s3(iep_id, child_id, merged_content)

        # The object lands before the row update. If the row was deleted in
        # between (a re-upload replaces the child's previous IEP, and a
        # translation can still be running against it), this object would be
        # left with nothing pointing at it, which is precisely how the orphaned
        # summaries accumulated. Roll it back instead.
        # Update DynamoDB - remove old fields and add S3 reference
        _write_content_reference(iep_id, child_id, s3_ref)

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


def _write_content_reference(iep_id, child_id, s3_ref):
    """Point the row at the merged content object, or roll the object back."""
    try:
        _guarded_update(
            Key={
                'iepId': iep_id,
                'childId': child_id
            },
            # meetingNotes is listed purely as legacy cleanup: the feature was
            # removed on 2026-07-29, but documents written before that still
            # carry the attribute inline, and it holds verbatim IEP meeting
            # content. Migrating an item is the one moment we can drop it, so
            # keep removing it even though nothing writes it anymore.
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
    except DocumentDeleted:
        # Nothing points at the object now, and nothing ever will. Leaving it
        # is how the orphaned summaries accumulated in the first place.
        delete_content_from_s3(s3_ref['s3Key'], s3_ref['bucket'])
        print('Rolled back the content object for a document deleted mid-run')
        raise
