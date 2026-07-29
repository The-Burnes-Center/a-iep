"""
Helper functions for S3 content storage and retrieval
Handles storing IEP content (all languages, all fields) in S3
"""
import json
import os
import boto3
from datetime import datetime
from typing import Dict, Optional

s3_client = boto3.client('s3')
BUCKET_NAME = os.environ.get('BUCKET', '')

def get_s3_key(iep_id: str, child_id: str) -> str:
    """Generate S3 key for IEP content"""
    return f"iep-data/{iep_id}/{child_id}/content.json"

def save_content_to_s3(iep_id: str, child_id: str, content: Dict) -> Dict:
    """
    Save IEP content (all languages, all fields) to S3
    
    Args:
        iep_id: IEP document ID
        child_id: Child ID
        content: Dictionary containing summaries, sections, document_index, abbreviations
    
    Returns:
        Dict with s3Key, bucket, size, lastUpdated
    """
    s3_key = get_s3_key(iep_id, child_id)
    content_json = json.dumps(content, default=str, ensure_ascii=False)
    content_bytes = content_json.encode('utf-8')
    
    print(f"Saving content to S3: {s3_key} (size: {len(content_bytes)} bytes)")
    
    s3_client.put_object(
        Bucket=BUCKET_NAME,
        Key=s3_key,
        Body=content_bytes,
        ContentType='application/json',
        ServerSideEncryption='aws:kms'  # Use KMS encryption
    )
    
    return {
        's3Key': s3_key,
        'bucket': BUCKET_NAME,
        'size': len(content_bytes),
        'lastUpdated': datetime.utcnow().isoformat() + 'Z'
    }

def get_ocr_s3_key(iep_id: str, child_id: str, data_type: str) -> str:
    """Generate S3 key for OCR payloads (raw or redacted)"""
    return f"iep-data/{iep_id}/{child_id}/{data_type}.json"

def save_ocr_to_s3(iep_id: str, child_id: str, data_type: str, ocr_data) -> Dict:
    """
    Save an OCR payload to S3. OCR text routinely exceeds the DynamoDB 400KB
    item limit (large documents store two copies: raw and redacted), so the
    payload lives in S3 and only a reference is kept on the item.

    Returns:
        Dict with s3Key, bucket, size, lastUpdated
    """
    s3_key = get_ocr_s3_key(iep_id, child_id, data_type)
    body = json.dumps(ocr_data, default=str, ensure_ascii=False).encode('utf-8')

    print(f"Saving {data_type} to S3: {s3_key} (size: {len(body)} bytes)")

    s3_client.put_object(
        Bucket=BUCKET_NAME,
        Key=s3_key,
        Body=body,
        ContentType='application/json',
        ServerSideEncryption='aws:kms'
    )

    return {
        's3Key': s3_key,
        'bucket': BUCKET_NAME,
        'size': len(body),
        'lastUpdated': datetime.utcnow().isoformat() + 'Z'
    }

def get_content_from_s3(s3_key: str, bucket: str) -> Optional[Dict]:
    """
    Retrieve IEP content from S3
    
    Args:
        s3_key: S3 object key
        bucket: S3 bucket name
    
    Returns:
        Content dictionary or None if error
    """
    try:
        print(f"Retrieving content from S3: {bucket}/{s3_key}")
        response = s3_client.get_object(Bucket=bucket, Key=s3_key)
        content_json = response['Body'].read().decode('utf-8')
        content = json.loads(content_json)
        print(f"Successfully retrieved content from S3 (size: {len(content_json)} bytes)")
        return content
    except s3_client.exceptions.NoSuchKey:
        print(f"Content not found in S3: {s3_key}")
        return None
    except Exception as e:
        print(f"Error retrieving content from S3: {str(e)}")
        return None

def delete_content_from_s3(s3_key: str, bucket: str) -> bool:
    """
    Delete IEP content from S3
    
    Args:
        s3_key: S3 object key
        bucket: S3 bucket name
    
    Returns:
        True if successful, False otherwise
    """
    try:
        print(f"Deleting content from S3: {bucket}/{s3_key}")
        s3_client.delete_object(Bucket=bucket, Key=s3_key)
        print(f"Successfully deleted content from S3")
        return True
    except Exception as e:
        print(f"Error deleting content from S3: {str(e)}")
        return False

def migrate_dynamodb_to_s3(iep_id: str, child_id: str, ddb_item: Dict, table) -> Optional[Dict]:
    """
    Migrate content from DynamoDB (old format) to S3 (new format)
    
    Args:
        iep_id: IEP document ID
        child_id: Child ID
        ddb_item: DynamoDB item containing old format data
        table: DynamoDB table resource
    
    Returns:
        S3 reference dict if successful, None otherwise
    """
    # Extract content fields
    content = {
        'summaries': ddb_item.get('summaries', {}),
        'sections': ddb_item.get('sections', {}),
        'document_index': ddb_item.get('document_index', {}),
        'abbreviations': ddb_item.get('abbreviations', {})
    }
    
    # Check if there's any content to migrate
    has_content = bool(
        content.get('summaries') or 
        content.get('sections') or 
        content.get('document_index') or 
        content.get('abbreviations')
    )
    
    if not has_content:
        print(f"No content to migrate for {iep_id}/{child_id}")
        return None
    
    try:
        # Save to S3
        s3_ref = save_content_to_s3(iep_id, child_id, content)
        
        # Update DynamoDB to remove old fields and add S3 reference
        table.update_item(
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
        
        print(f"Successfully migrated {iep_id}/{child_id} to S3")
        return s3_ref
        
    except Exception as e:
        print(f"Error migrating {iep_id}/{child_id} to S3: {str(e)}")
        import traceback
        print(traceback.format_exc())
        return None

