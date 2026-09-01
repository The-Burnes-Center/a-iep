import json
import os
import boto3
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Optional, Literal
from router import Router, UserProfileRouter, RouteNotFoundException
import base64
import copy
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')
user_profiles_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])
iep_documents_table = dynamodb.Table(os.environ['IEP_DOCUMENTS_TABLE'])

# Initialize KMS client using Lambda's region from AWS_REGION (provided by runtime)
region = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'))
kms_client = boto3.client('kms', region_name=region)
kms_key_alias = os.environ.get('AIEP_KMS_KEY_ALIAS', 'alias/aiep/app')

print(f"KMS client initialized for region: {region}, using key alias: {kms_key_alias}")

SUPPORTED_LANGUAGES = ['en', 'zh', 'es', 'vi', 'ar']
DEFAULT_LANGUAGE = 'en'

# Document processing statuses
DocumentStatus = Literal['PROCESSING', 'PROCESSING_TRANSLATIONS', 'PROCESSED', 'FAILED']
DOCUMENT_STATUSES: List[DocumentStatus] = ['PROCESSING', 'PROCESSING_TRANSLATIONS', 'PROCESSED', 'FAILED']

class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder to handle Decimal types from DynamoDB."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super(DecimalEncoder, self).default(obj)

# --- Log sanitization -------------------------------------------------------
# API Gateway events carry a JWT bearer token (Authorization header), the
# Cognito JWT claims carry PII (email, phone_number), and the request body
# carries user/child PII. None of these may be written to CloudWatch, where any
# IAM principal with log-read access could harvest a live token and impersonate
# the user. The helpers below redact those fields before logging, without ever
# mutating the original event (the handlers still need the real values).
_SENSITIVE_HEADERS = {'authorization', 'cookie', 'x-api-key', 'x-amz-security-token'}
_SENSITIVE_CLAIMS = {'email', 'phone_number', 'phone', 'name', 'cognito:username'}
_REDACTED = '[REDACTED]'


def _redact_sensitive_headers(headers: Dict) -> Dict:
    """Return a copy of an HTTP headers dict with auth/token headers redacted."""
    if not isinstance(headers, dict):
        return headers
    return {
        key: (_REDACTED if key.lower() in _SENSITIVE_HEADERS else value)
        for key, value in headers.items()
    }


def sanitize_event_for_logging(event: Dict) -> Dict:
    """Return a deep copy of an API Gateway event that is safe to log.

    Redacts the JWT bearer token (Authorization header / cookies), PII in the
    Cognito JWT claims (email, phone_number), and the request body, which
    carries user/child PII. Never mutates the original event.
    """
    if not isinstance(event, dict):
        return event
    try:
        sanitized = copy.deepcopy(event)
    except Exception:
        return {'_note': 'event omitted from logs (not serializable)'}

    if isinstance(sanitized.get('headers'), dict):
        sanitized['headers'] = _redact_sensitive_headers(sanitized['headers'])

    # HTTP API (v2) delivers cookies in a top-level list; they can hold tokens.
    if 'cookies' in sanitized:
        sanitized['cookies'] = _REDACTED

    try:
        claims = sanitized['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        claims = None
    if isinstance(claims, dict):
        for claim in _SENSITIVE_CLAIMS:
            if claim in claims:
                claims[claim] = _REDACTED

    # The request body carries user/child PII (names, phone, city, etc.).
    if sanitized.get('body') is not None:
        sanitized['body'] = _REDACTED

    return sanitized


def get_origin_from_event(event: Dict) -> str:
    """
    Extract origin from event headers in a case-insensitive way.
    
    Args:
        event (Dict): The API Gateway event object
        
    Returns:
        str: The origin header value or default localhost
    """
    headers = event.get('headers', {})
    print("Request headers:", json.dumps(_redact_sensitive_headers(headers), indent=2))
    
    # Case-insensitive search for origin header
    origin_header = next(
        (headers[key] for key in headers if key.lower() == 'origin'),
        'http://localhost:3000'
    )
    print("Found origin:", origin_header)
    return origin_header

def create_response(event: Dict, status_code: int, body: Dict) -> Dict:
    """
    Create a standardized API response with CORS headers.
    
    Args:
        event (Dict): The API Gateway event object
        status_code (int): HTTP status code
        body (Dict): Response body to be JSON serialized
        
    Returns:
        Dict: API Gateway response object with CORS headers
    """
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
        },
        'body': json.dumps(body, cls=DecimalEncoder)
    }

def handle_options(event: Dict) -> Dict:
    """
    Handle OPTIONS requests for CORS preflight.
    
    Args:
        event (Dict): The API Gateway event object
        
    Returns:
        Dict: API Gateway response with CORS headers
    """
    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
        },
        'body': ''
    }

def validate_language(lang: str) -> bool:
    """
    Validate if the provided language code is supported.
    
    Args:
        lang (str): Language code to validate
        
    Returns:
        bool: True if language is supported, False otherwise
    """
    return lang in SUPPORTED_LANGUAGES

class FieldEncryptionError(RuntimeError):
    """Raised when a PII field cannot be encrypted with KMS.

    We fail the operation rather than silently storing PII in plaintext.
    """


def kms_encrypt_string(plaintext: str) -> str:
    if not plaintext:
        return plaintext
    try:
        resp = kms_client.encrypt(
            KeyId=kms_key_alias,
            Plaintext=plaintext.encode('utf-8'),
        )
        encrypted = base64.b64encode(resp['CiphertextBlob']).decode('utf-8')
        print("Successfully encrypted field with KMS")
        return encrypted
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        # CRITICAL: Do not silently fall back to plaintext. If KMS is misconfigured
        # or unavailable, fail loudly so PII is never persisted unencrypted.
        print(f"CRITICAL: KMS encrypt failed with {error_code}: {str(e)}")
        raise FieldEncryptionError(
            f"Field encryption failed: {error_code}"
        ) from e
    except Exception as e:
        print(f"CRITICAL: KMS encrypt failed with unexpected error: {str(e)}")
        raise FieldEncryptionError(
            f"Field encryption failed: {type(e).__name__}"
        ) from e

def kms_decrypt_string(ciphertext_b64: str) -> str:
    if not ciphertext_b64:
        return ciphertext_b64
    
    # Quick check if this looks like base64 (encrypted data)
    try:
        base64.b64decode(ciphertext_b64)
    except:
        # Not base64, probably plaintext
        return ciphertext_b64
        
    try:
        blob = base64.b64decode(ciphertext_b64)
        resp = kms_client.decrypt(CiphertextBlob=blob)
        decrypted = resp['Plaintext'].decode('utf-8')
        print(f"Successfully decrypted field with KMS")
        return decrypted
    except ClientError as e:
        error_code = e.response['Error']['Code']
        print(f"KMS decrypt failed with {error_code}: {str(e)}")
        if error_code in ['UnrecognizedClientException', 'AccessDeniedException', 'InvalidCiphertextException']:
            print("Assuming plaintext data (encryption may be disabled)")
        return ciphertext_b64
    except Exception as e:
        print(f"KMS decrypt failed with unexpected error: {str(e)}")
        return ciphertext_b64

def get_timestamps() -> Dict[str, any]:
    """
    Generate both Unix timestamp in milliseconds and human-readable ISO format.
    
    Returns:
        Dict containing both timestamp formats
    """
    now = datetime.utcnow()
    return {
        'timestamp': int(now.timestamp() * 1000),  # Unix timestamp in milliseconds
        'datetime': now.isoformat() + 'Z'  # ISO 8601 format with Z suffix for UTC
    }

def get_user_profile(event: Dict) -> Dict:
    """
    Get user profile information. If profile doesn't exist, creates a default one.
    
    Args:
        event (Dict): API Gateway event object containing user context
        
    Returns:
        Dict: API Gateway response containing user profile or error
        
    Raises:
        Exception: If there's an error accessing DynamoDB
    """
    try:
        claims = event['requestContext']['authorizer']['jwt']['claims']
        # Do not log full Cognito claims: they contain PII (email, phone_number).
        
        user_id = claims['sub']
        print(f"Retrieved from Cognito - userId: {user_id}")
        
        response = user_profiles_table.get_item(
            Key={'userId': user_id}
        )
        
        times = get_timestamps()
        
        if 'Item' not in response:
            print(f"No existing profile found for userId: {user_id}, creating new profile")
            
            # Create default child for IEP document functionality
            default_child = {
                'childId': str(uuid.uuid4()),
                'name': 'My Child',
                'schoolCity': 'Not specified',
                'createdAt': times['timestamp'],
                'updatedAt': times['timestamp']
            }
            
            new_profile = {
                'userId': user_id,
                'createdAt': times['timestamp'],
                'createdAtISO': times['datetime'],
                'updatedAt': times['timestamp'],
                'updatedAtISO': times['datetime'],
                'children': [default_child],  # Initialize with default child
                'consentGiven': False,
                'showOnboarding': True
            }
            user_profiles_table.put_item(Item=new_profile)
            return create_response(event, 200, {'profile': new_profile})
        
        existing_profile = response['Item']

        # Decrypt selected PII fields before returning
        for pii_field in ['phone', 'city', 'parentName']:
            if pii_field in existing_profile and isinstance(existing_profile[pii_field], str):
                existing_profile[pii_field] = kms_decrypt_string(existing_profile[pii_field])
        
        # Check if existing profile has no children and add default child if needed
        if 'children' not in existing_profile or not existing_profile['children']:
            print(f"Existing profile found but no children, adding default child for userId: {user_id}")
            
            default_child = {
                'childId': str(uuid.uuid4()),
                'name': 'My Child',
                'schoolCity': 'Not specified',
                'createdAt': times['timestamp'],
                'updatedAt': times['timestamp']
            }
            
            # Update the profile with default child
            user_profiles_table.update_item(
                Key={'userId': user_id},
                UpdateExpression='SET children = :children, updatedAt = :updatedAt, updatedAtISO = :updatedAtISO',
                ExpressionAttributeValues={
                    ':children': [default_child],
                    ':updatedAt': times['timestamp'],
                    ':updatedAtISO': times['datetime']
                }
            )
            
            # Update the existing profile object to return
            existing_profile['children'] = [default_child]
            existing_profile['updatedAt'] = times['timestamp']
            existing_profile['updatedAtISO'] = times['datetime']
        
        return create_response(event, 200, {'profile': existing_profile})
        
    except Exception as e:
        print(f"Error in get_user_profile: {str(e)}")
        print(f"Event data: {json.dumps(sanitize_event_for_logging(event), default=str)}")
        return create_response(event, 500, {'message': 'Could not load your profile. Please try again later.'})

def update_user_profile(event: Dict) -> Dict:
    """
    Update user profile information. Supports partial updates - only provided fields will be updated.
    Email cannot be updated directly as it is managed by Cognito.
    
    Args:
        event (Dict): API Gateway event object containing user context and profile data
        
    Returns:
        Dict: API Gateway response indicating success or error
        
    Raises:
        Exception: If there's an error accessing DynamoDB
    """
    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
        # A malformed (or missing) JSON body is the client's fault: catch it
        # here so it maps to 400 instead of falling through to the broad
        # except below as a 500 (same treatment as the tts/delete-s3 handlers).
        try:
            body = json.loads(event['body']) if event.get('body') else {}
        except (TypeError, ValueError):
            return create_response(event, 400, {'message': 'Invalid JSON body'})
        if not isinstance(body, dict):
            return create_response(event, 400, {'message': 'Invalid JSON body: expected a JSON object'})
        times = get_timestamps()

        # Start building update expression and values
        update_parts = []
        expr_values = {
            ':updatedAt': times['timestamp'],
            ':updatedAtISO': times['datetime']
        }
        update_parts.append('updatedAt = :updatedAt')
        update_parts.append('updatedAtISO = :updatedAtISO')
        
        # Handle optional fields
        optional_fields = {
            'phone': 'phone',
            'city': 'city',
            'primaryLanguage': 'primaryLanguage',
            'secondaryLanguage': 'secondaryLanguage',
            'consentGiven': 'consentGiven',
            'parentName': 'parentName',
            'showOnboarding': 'showOnboarding'
        }

        # If email is in the request, return an error
        if 'email' in body:
            return create_response(event, 400, {
                'message': 'Email cannot be updated directly. Please update your email through account settings.'
            })
        
        for field, attr_name in optional_fields.items():
            if field in body:
                # Special validation for language fields
                if field in ['primaryLanguage', 'secondaryLanguage']:
                    if body[field] and not validate_language(body[field]):
                        return create_response(event, 400, {
                            'message': f'Unsupported language for {field}. Supported languages: {SUPPORTED_LANGUAGES}'
                        })
                
                # Validation for consentGiven boolean field
                if field == 'consentGiven' and not isinstance(body[field], bool):
                    return create_response(event, 400, {
                        'message': 'consentGiven must be a boolean value (true or false)'
                    })
                
                # Validation for showOnboarding boolean field
                if field == 'showOnboarding' and not isinstance(body[field], bool):
                    return create_response(event, 400, {
                        'message': 'showOnboarding must be a boolean value (true or false)'
                    })
                
                # Encrypt selected PII fields at rest
                value_to_store = body[field]
                if field in ['phone', 'city', 'parentName'] and isinstance(value_to_store, str):
                    value_to_store = kms_encrypt_string(value_to_store)
                update_parts.append(f'{attr_name} = :{field}')
                expr_values[f':{field}'] = value_to_store
            
        # Handle children array if present
        if 'children' in body:
            # Validate child data
            for child in body['children']:
                if 'name' not in child or 'schoolCity' not in child:
                    return create_response(event, 400, {'message': 'Each child must have name and schoolCity'})
                if 'childId' not in child:
                    child['childId'] = str(uuid.uuid4())
            
            update_parts.append('children = :children')
            expr_values[':children'] = body['children']
        
        # If no fields to update (the first two parts are always the
        # updatedAt/updatedAtISO timestamps)
        if len(update_parts) == 2:
            return create_response(event, 400, {'message': 'No fields to update provided'})
            
        # Construct final update expression
        update_expr = 'SET ' + ', '.join(update_parts)
            
        user_profiles_table.update_item(
            Key={'userId': user_id},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values
        )

        # Mirror the language preference into the Cognito 'locale' attribute.
        # Cognito does NOT forward InitiateAuth clientMetadata to the
        # CreateAuthChallenge/CustomMessage triggers, so user attributes are
        # the only reliable way to localize the first login SMS. Best-effort:
        # a failure here must not fail the profile update.
        if body.get('secondaryLanguage'):
            try:
                cognito = boto3.client('cognito-idp')
                cognito.admin_update_user_attributes(
                    UserPoolId=os.environ.get('USER_POOL_ID', ''),
                    Username=user_id,
                    UserAttributes=[{'Name': 'locale', 'Value': body['secondaryLanguage']}]
                )
                print(f"Synced Cognito locale attribute for userId: {user_id}")
            except Exception as locale_error:
                print(f"Could not sync Cognito locale attribute: {str(locale_error)}")

        return create_response(event, 200, {'message': 'Profile updated successfully'})

    except FieldEncryptionError as e:
        # Encryption failure must not silently degrade to plaintext storage.
        print(f"Refusing to update profile due to field encryption failure: {str(e)}")
        return create_response(event, 503, {
            'message': 'Profile update temporarily unavailable: encryption service error. Please try again later.'
        })
    except Exception as e:
        print(f"Error in update_user_profile: {str(e)}")
        return create_response(event, 500, {'message': 'Could not update your profile. Please try again later.'})

def add_child(event: Dict) -> Dict:
    """
    Add a new child to user's profile.
    
    Args:
        event (Dict): API Gateway event object containing user context and child data
        
    Returns:
        Dict: API Gateway response containing new childId or error
        
    Raises:
        Exception: If there's an error accessing DynamoDB
    """
    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
        # Malformed JSON is a client error: 400, not the broad except's 500.
        try:
            body = json.loads(event['body']) if event.get('body') else {}
        except (TypeError, ValueError):
            return create_response(event, 400, {'message': 'Invalid JSON body'})
        if not isinstance(body, dict):
            return create_response(event, 400, {'message': 'Invalid JSON body: expected a JSON object'})
        times = get_timestamps()

        # Validate required fields
        if 'name' not in body or 'schoolCity' not in body:
            return create_response(event, 400, {'message': 'Missing required fields: name and schoolCity required'})
            
        # Generate new childId
        child_id = str(uuid.uuid4())
        new_child = {
            'childId': child_id,
            'name': body['name'],
            'schoolCity': body['schoolCity'],
            'createdAt': times['timestamp'],
            'createdAtISO': times['datetime'],
            'updatedAt': times['timestamp'],
            'updatedAtISO': times['datetime']
        }
        
        # Add child to user's profile and update timestamps
        user_profiles_table.update_item(
            Key={'userId': user_id},
            UpdateExpression='SET #children = list_append(if_not_exists(#children, :empty_list), :new_child), updatedAt = :updatedAt, updatedAtISO = :updatedAtISO',
            ExpressionAttributeNames={'#children': 'children'},
            ExpressionAttributeValues={
                ':empty_list': [],
                ':new_child': [new_child],
                ':updatedAt': times['timestamp'],
                ':updatedAtISO': times['datetime']
            }
        )
        
        return create_response(event, 200, {
            'message': 'Child added successfully',
            'childId': child_id,
            'createdAt': times['timestamp'],
            'createdAtISO': times['datetime'],
        })
        
    except Exception as e:
        print(f"Error in add_child: {str(e)}")
        return create_response(event, 500, {'message': 'Could not add the child. Please try again later.'})

def clean_dynamodb_json(data):
    """Recursively convert DynamoDB JSON to plain JSON."""
    if isinstance(data, dict):
        # If this is a DynamoDB type wrapper
        if set(data.keys()) == {'S'}:
            return data['S']
        if set(data.keys()) == {'N'}:
            n = data['N']
            try:
                return int(n)
            except ValueError:
                try:
                    return float(n)
                except ValueError:
                    return n
        if set(data.keys()) == {'L'}:
            return [clean_dynamodb_json(item) for item in data['L']]
        if set(data.keys()) == {'M'}:
            return {k: clean_dynamodb_json(v) for k, v in data['M'].items()}
        # Otherwise, recursively clean all keys
        return {k: clean_dynamodb_json(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [clean_dynamodb_json(item) for item in data]
    else:
        return data

def _user_owns_child(user_id: str, child_id: str) -> bool:
    """
    Verify the given childId belongs to the authenticated user's profile.
    Returns True only if the user has a child with the matching childId.
    """
    if not user_id or not child_id:
        return False
    try:
        profile_response = user_profiles_table.get_item(Key={'userId': user_id})
    except Exception as e:
        print(f"Error loading profile for ownership check (user {user_id}): {str(e)}")
        return False

    profile = profile_response.get('Item')
    if not profile:
        return False

    children = profile.get('children') or []
    if not isinstance(children, list):
        return False

    return any(
        isinstance(child, dict) and child.get('childId') == child_id
        for child in children
    )


def get_child_documents(event: Dict) -> Dict:
    """
    Get document associated with a specific child.
    
    Args:
        event (Dict): API Gateway event object containing user context and childId
        
    Returns:
        Dict: API Gateway response containing the document or error.
        Only returns the most recent document for the child.
        
    Raises:
        Exception: If there's an error accessing DynamoDB
    """
    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
        child_id = event['pathParameters']['childId']
        
        print(f"Getting documents for childId: {child_id}, userId: {user_id}")

        # Authorization: the authenticated user must own the requested child.
        if not _user_owns_child(user_id, child_id):
            print(f"Access denied: user {user_id} does not own child {child_id}")
            return create_response(event, 403, {'message': 'Access denied'})

        # Query documents by childId
        response = iep_documents_table.query(
            IndexName='byChildId',
            KeyConditionExpression='childId = :childId',
            ExpressionAttributeValues={':childId': child_id}
        )
        
        # Find the latest document
        latest_doc = None
        latest_timestamp = 0
        
        for doc in response['Items']:
            # Strict ownership: require an explicit userId match. Documents without
            # a userId field are not returned to avoid IDOR via missing fields.
            if doc.get('userId') == user_id:
                # Find the document with the latest createdAt timestamp
                created_at = doc.get('createdAt', 0)
                if created_at > latest_timestamp:
                    latest_timestamp = created_at
                    
                    # PENDING_UPLOAD (and, for rows written before that status
                    # existed, no status at all) means the upload handler wrote
                    # this row but the pipeline has not started yet. Surface it
                    # as PROCESSING: that is the value the frontend already
                    # polls and renders a spinner for, and the real value stays
                    # in DynamoDB so ddb-service's pending-upload sweep can
                    # tell a stalled upload apart from real in-flight work.
                    # Construct the base document
                    latest_doc = {
                        'iepId': doc['iepId'],
                        'documentId': doc['iepId'],  # Also include documentId for frontend compatibility
                        'childId': doc['childId'],
                        'documentUrl': doc.get('documentUrl', f"s3://{os.environ.get('BUCKET', '')}/{doc['iepId']}"),
                        'status': 'PROCESSING' if doc.get('status') in (None, 'PENDING_UPLOAD') else doc['status'],
                        'progress': doc.get('progress', 0),
                        'current_step': doc.get('current_step', 'initializing'),
                        'createdAt': doc.get('createdAt', ''),
                        'updatedAt': doc.get('updatedAt', '')
                    }
                    
                    # Check if content is in S3 (new format) or DynamoDB (old format)
                    if 'contentS3Reference' in doc:
                        # New format: fetch content from S3
                        s3_ref = doc['contentS3Reference']
                        try:
                            s3 = boto3.client('s3')
                            response = s3.get_object(Bucket=s3_ref['bucket'], Key=s3_ref['s3Key'])
                            content_json = response['Body'].read().decode('utf-8')
                            content = json.loads(content_json)
                            
                            # Merge content into latest_doc
                            latest_doc.update({
                                'summaries': content.get('summaries', {}),
                                'sections': content.get('sections', {}),
                                'document_index': content.get('document_index', {}),
                                'abbreviations': content.get('abbreviations', {})
                            })
                            print(f"Successfully fetched content from S3 for {doc['iepId']}")
                        except Exception as e:
                            print(f"Error fetching content from S3 for {doc['iepId']}: {str(e)}")
                            # Fallback to empty content
                            latest_doc.update({
                                'summaries': {},
                                'sections': {},
                                'document_index': {},
                                'abbreviations': {}
                            })
                    else:
                        # Old format: migrate to S3 (lazy migration)
                        print(f"Migrating {doc['iepId']}/{doc['childId']} to S3 (lazy migration)")
                        try:
                            # Call DDB service to migrate
                            lambda_client = boto3.client('lambda')
                            ddb_service_name = os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')
                            
                            migrate_payload = {
                                'operation': 'get_document_with_content',
                                'params': {
                                    'iep_id': doc['iepId'],
                                    'child_id': doc['childId'],
                                    'user_id': user_id
                                }
                            }
                            
                            migrate_response = lambda_client.invoke(
                                FunctionName=ddb_service_name,
                                InvocationType='RequestResponse',
                                Payload=json.dumps(migrate_payload)
                            )
                            
                            migrate_result = json.loads(migrate_response['Payload'].read())
                            
                            if migrate_result.get('statusCode') == 200:
                                migrated_doc = json.loads(migrate_result['body'])
                                # Update latest_doc with migrated content
                                latest_doc.update({
                                    'summaries': migrated_doc.get('summaries', {}),
                                    'sections': migrated_doc.get('sections', {}),
                                    'document_index': migrated_doc.get('document_index', {}),
                                    'abbreviations': migrated_doc.get('abbreviations', {})
                                })
                                print(f"Successfully migrated {doc['iepId']} to S3")
                            else:
                                # Migration failed, use old format
                                print(f"Migration failed for {doc['iepId']}, using old format")
                                latest_doc.update({
                                    'summaries': clean_dynamodb_json(doc.get('summaries', {})),
                                    'sections': clean_dynamodb_json(doc.get('sections', {})),
                                    'document_index': clean_dynamodb_json(doc.get('document_index', {})),
                                    'abbreviations': clean_dynamodb_json(doc.get('abbreviations', {}))
                                })
                        except Exception as e:
                            print(f"Error migrating document {doc['iepId']}: {str(e)}")
                            # Fallback to old format
                            latest_doc.update({
                                'summaries': clean_dynamodb_json(doc.get('summaries', {})),
                                'sections': clean_dynamodb_json(doc.get('sections', {})),
                                'document_index': clean_dynamodb_json(doc.get('document_index', {})),
                                'abbreviations': clean_dynamodb_json(doc.get('abbreviations', {}))
                            })
        
        # If no document found
        if not latest_doc:
            return create_response(event, 200, {'documents': [], 'message': 'No document found for this child'})
        
        return create_response(event, 200, latest_doc)
        
    except Exception as e:
        print(f"Error retrieving documents: {str(e)}")
        return create_response(event, 500, {'message': 'Could not load your documents. Please try again later.'})

def _delete_object_if_present(s3, bucket: str, key: str) -> int:
    """Delete one key, reporting whether it was actually there.

    S3 DeleteObject succeeds on a key that never existed, so counting every
    call would report phantom deletions back to the client. head_object first
    keeps the deletion summary honest.
    """
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        code = e.response['Error']['Code']
        if code in ('404', 'NoSuchKey'):
            return 0
        # Never read an ambiguous head_object failure as "already gone". A 403
        # from a missing ListBucket grant is indistinguishable from absent, and
        # swallowing it would report a clean purge while FERPA content stayed
        # in the bucket. Say so in the log, then delete anyway.
        print(f"head_object on {key} failed ({code}); attempting delete anyway")
    s3.delete_object(Bucket=bucket, Key=key)
    print(f"Deleted S3 object: {key}")
    return 1


def _delete_prefix(s3, bucket: str, prefix: str) -> int:
    """Delete every object under a prefix, returning the count removed."""
    deleted = 0
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            s3.delete_object(Bucket=bucket, Key=obj['Key'])
            print(f"Deleted S3 object: {obj['Key']}")
            deleted += 1
    return deleted


def _delete_document_artifacts(s3, bucket_name: str, doc: Dict) -> int:
    """Purge every S3 artifact derived from one IEP document record.

    Must run BEFORE the DynamoDB row is deleted: contentS3Reference is the
    only pointer to the summary object, so dropping the row first strands it
    in S3 with nothing left to find it by. Deleting an account used to sweep
    only the userId/ prefix, which covers the raw upload and nothing else,
    and that left 17 orphaned content directories in production.

    Three artifact shapes exist: contentS3Reference (current), the
    iep-data/... key (legacy layout), and iep-audio/... holding the cached
    TTS mp3s, one per language and section.
    """
    iep_id = doc.get('iepId')
    child_id = doc.get('childId')
    deleted = 0

    s3_ref = doc.get('contentS3Reference') or {}
    if s3_ref.get('s3Key'):
        deleted += _delete_object_if_present(
            s3, s3_ref.get('bucket') or bucket_name, s3_ref['s3Key'])

    if iep_id and child_id:
        # Sweep the whole iep-data prefix, not just content.json. Three file
        # names live there and only one of them is the summary: production
        # holds 138 content.json versions, 73 redacted_ocr_result.json, and 7
        # ocr_result.json. Naming content.json alone left the redacted OCR
        # text behind on every account deletion, and the raw unredacted OCR
        # too whenever the pipeline died before DeleteOriginal ran. A prefix
        # sweep also survives the next file type someone adds here.
        # Any key already removed above is simply not listed, so the count
        # stays accurate.
        deleted += _delete_prefix(s3, bucket_name, f"iep-data/{iep_id}/{child_id}/")
        deleted += _delete_prefix(s3, bucket_name, f"iep-audio/{iep_id}/{child_id}/")

    return deleted


def _purge_referral_data(user_id: str) -> Dict:
    """Remove a deleted user's referral footprint.

    Two shapes, handled differently on purpose:

    - Links the user OWNS (sk 'META' with ownerUserId, plus that code's event
      items) are theirs outright and are deleted.
    - Signup events recording that the user joined via SOMEONE ELSE'S link sit
      under the referrer's code. Deleting them would silently decrement that
      referrer's signup count, so the personal reference is redacted instead:
      the event survives for counting, referredUserId does not.

    The second case needs a Scan because there is no GSI on referredUserId.
    The table is small (one item collection per link) and account deletion is
    rare, so a scan here is cheaper than an index nobody else would use.

    Best-effort: a failure here must not abort the rest of the deletion.
    """
    result = {'linksDeleted': 0, 'eventsDeleted': 0, 'referencesRedacted': 0}
    table_name = os.environ.get('REFERRALS_TABLE')
    if not table_name:
        print('REFERRALS_TABLE is not configured; skipping referral cleanup')
        return result

    referrals_table = dynamodb.Table(table_name)

    # 1. Links this user owns, found via the byOwner GSI.
    owned_codes = set()
    start_key = None
    while True:
        kwargs = {
            'IndexName': 'byOwner',
            'KeyConditionExpression': 'ownerUserId = :owner',
            'ExpressionAttributeValues': {':owner': user_id},
        }
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        page = referrals_table.query(**kwargs)
        for item in page.get('Items', []):
            owned_codes.add(item['code'])
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            break

    # Delete the whole item collection for each owned code: the META link and
    # every event recorded against it.
    for code in owned_codes:
        start_key = None
        while True:
            kwargs = {
                'KeyConditionExpression': 'code = :code',
                'ExpressionAttributeValues': {':code': code},
                'ProjectionExpression': 'code, sk',
            }
            if start_key:
                kwargs['ExclusiveStartKey'] = start_key
            page = referrals_table.query(**kwargs)
            for item in page.get('Items', []):
                referrals_table.delete_item(Key={'code': item['code'], 'sk': item['sk']})
                if item['sk'] == 'META':
                    result['linksDeleted'] += 1
                else:
                    result['eventsDeleted'] += 1
            start_key = page.get('LastEvaluatedKey')
            if not start_key:
                break

    # 2. Events elsewhere that name this user as the person referred.
    start_key = None
    while True:
        kwargs = {
            'FilterExpression': 'referredUserId = :uid',
            'ExpressionAttributeValues': {':uid': user_id},
            'ProjectionExpression': 'code, sk',
        }
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        page = referrals_table.scan(**kwargs)
        for item in page.get('Items', []):
            if item['code'] in owned_codes:
                continue  # already deleted with the owned collection
            referrals_table.update_item(
                Key={'code': item['code'], 'sk': item['sk']},
                UpdateExpression='REMOVE referredUserId SET redactedAt = :now',
                ExpressionAttributeValues={':now': get_timestamps()['datetime']},
            )
            result['referencesRedacted'] += 1
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            break

    print(f"Referral cleanup: {result['linksDeleted']} link(s), "
          f"{result['eventsDeleted']} event(s) deleted, "
          f"{result['referencesRedacted']} reference(s) redacted")
    return result


def _query_all_documents(index_name: str, key_expression: str, values: Dict) -> List[Dict]:
    """Every matching document row, following LastEvaluatedKey.

    A single query page caps at 1MB. These rows can carry inline summaries, so
    a family with enough documents overflows one page, and an unpaginated read
    silently left the overflow rows (and their S3 artifacts) behind on delete.
    """
    items: List[Dict] = []
    start_key = None
    while True:
        kwargs = {
            'IndexName': index_name,
            'KeyConditionExpression': key_expression,
            'ExpressionAttributeValues': values,
        }
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        response = iep_documents_table.query(**kwargs)
        items.extend(response.get('Items', []))
        start_key = response.get('LastEvaluatedKey')
        if not start_key:
            return items


def delete_child_documents(event: Dict) -> Dict:
    """
    Delete all IEP-related data for a specific child.
    This includes:
    1. S3 files (actual IEP documents)
    2. Records in IEP documents table
    3. IEP references in the user's profile
    
    Args:
        event (Dict): API Gateway event object containing user context and childId
        
    Returns:
        Dict: API Gateway response indicating success or error
        
    Raises:
        Exception: If there's an error during deletion process
    """
    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
        child_id = event['pathParameters']['childId']
        
        print(f"Processing request to delete IEP documents for childId: {child_id} by userId: {user_id}")

        # Authorization: only allow deletion if the authenticated user owns the child.
        if not _user_owns_child(user_id, child_id):
            print(f"Access denied: user {user_id} does not own child {child_id}")
            return create_response(event, 403, {'message': 'Access denied'})

        # Delete all IEP-related data
        try:
            # Initialize clients
            s3 = boto3.client('s3')
            bucket_name = os.environ.get('BUCKET', '')
            
            # 1. First delete files from S3
            try:
                # Create the S3 key prefix for this child (all objects under userId/childId/)
                prefix = f"{user_id}/{child_id}/"
                
                print(f"Listing S3 objects with prefix: {prefix} in bucket: {bucket_name}")
                
                # List all objects with this prefix
                paginator = s3.get_paginator('list_objects_v2')
                objects_deleted = 0
                
                for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
                    if 'Contents' in page:
                        for obj in page['Contents']:
                            s3.delete_object(Bucket=bucket_name, Key=obj['Key'])
                            print(f"Deleted S3 object: {obj['Key']}")
                            objects_deleted += 1
                
                print(f"Deleted {objects_deleted} S3 objects for childId: {child_id}")
                
            except Exception as s3_error:
                print(f"Error deleting S3 objects: {str(s3_error)}")
                # Continue with other deletions even if S3 deletion fails
            
            # 2. Delete records from IEP documents table
            try:
                # Query documents by childId
                documents = _query_all_documents(
                    'byChildId', 'childId = :childId', {':childId': child_id})

                documents_deleted = 0

                # Delete each document record that belongs to this user.
                # Strict ownership: require an explicit userId match.
                for doc in documents:
                    if doc.get('userId') == user_id:
                        # Summary content and cached TTS audio, before the row
                        # that points at them.
                        try:
                            _delete_document_artifacts(s3, bucket_name, doc)
                        except Exception as artifact_error:
                            print(f"Error deleting S3 artifacts for {doc.get('iepId')}: {str(artifact_error)}")

                        # Check for document_index field before deletion
                        if 'document_index' in doc:
                            print(f"Deleting document with document_index field: {doc['iepId']}")

                        iep_documents_table.delete_item(
                            Key={
                                'iepId': doc['iepId'],
                                'childId': doc['childId']
                            }
                        )
                        print(f"Deleted IEP document record with iepId: {doc['iepId']} for childId: {child_id}")
                        documents_deleted += 1
                
                print(f"Deleted {documents_deleted} IEP document records for childId: {child_id}")
                
            except Exception as ddb_error:
                print(f"Error deleting document records: {str(ddb_error)}")
            
            # 3. Update the user profile to remove any IEP document references for this child
            try:
                # First get the current user profile
                user_profile_response = user_profiles_table.get_item(
                    Key={'userId': user_id}
                )
                
                if 'Item' in user_profile_response:
                    user_profile = user_profile_response['Item']
                    updated_profile = False
                    
                    # Check if there are children in the profile
                    if 'children' in user_profile and isinstance(user_profile['children'], list):
                        children = user_profile['children']
                        
                        # Find the child and remove any IEP document references
                        for i, child in enumerate(children):
                            if child.get('childId') == child_id:
                                # Remove any IEP document data if present
                                if 'iepDocument' in child:
                                    del children[i]['iepDocument']
                                    updated_profile = True
                                    print(f"Removed IEP document reference from child {child_id} in user profile")
                        
                        # Update the profile if changes were made
                        if updated_profile:
                            times = get_timestamps()
                            user_profiles_table.update_item(
                                Key={'userId': user_id},
                                UpdateExpression='SET #children = :children, updatedAt = :updatedAt, updatedAtISO = :updatedAtISO',
                                ExpressionAttributeNames={'#children': 'children'},
                                ExpressionAttributeValues={
                                    ':children': children,
                                    ':updatedAt': times['timestamp'],
                                    ':updatedAtISO': times['datetime']
                                }
                            )
                            print(f"Updated user profile to remove IEP document references")
                
            except Exception as profile_error:
                print(f"Error updating user profile: {str(profile_error)}")
                # Continue even if profile update fails
        except Exception as e:
            print(f"Error during deletion process: {str(e)}")
            
        # Return success response
        return create_response(event, 200, {
            'message': 'IEP documents successfully deleted',
            'childId': child_id
        })
        
    except Exception as e:
        print(f"Error in delete_child_documents: {str(e)}")
        return create_response(event, 500, {'message': 'Could not delete the documents. Please try again later.'})

def delete_user_profile(event: Dict) -> Dict:
    """
    Delete all user data and account completely.
    This includes:
    1. All S3 files for the user (all folders under userId/)
    2. All IEP document records in IEP documents table
    3. User profile record in user profiles table
    4. Cognito user account
    
    Args:
        event (Dict): API Gateway event object containing user context
        
    Returns:
        Dict: API Gateway response indicating success or error
        
    Raises:
        Exception: If there's an error during deletion process
    """
    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
        
        print(f"Processing request to delete complete user profile for userId: {user_id}")
        
        # Initialize result tracking
        result = {
            's3ObjectsDeleted': 0,
            'documentsDeleted': 0,
            'profileDeleted': False,
            'cognitoUserDeleted': False
        }
        
        # Hoisted: step 2 purges S3 artifacts too, so these must exist even if
        # the raw-upload sweep below raises.
        s3 = boto3.client('s3')
        bucket_name = os.environ.get('BUCKET', '')

        # 1. Delete the user's raw uploads (originals live under userId/).
        #    Derived artifacts are NOT under this prefix; step 2 handles those.
        try:
            # Create the S3 key prefix for this user (all objects under userId/)
            prefix = f"{user_id}/"
            
            print(f"Listing S3 objects with prefix: {prefix} in bucket: {bucket_name}")
            
            # List all objects with this prefix
            paginator = s3.get_paginator('list_objects_v2')
            
            for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
                if 'Contents' in page:
                    for obj in page['Contents']:
                        s3.delete_object(Bucket=bucket_name, Key=obj['Key'])
                        print(f"Deleted S3 object: {obj['Key']}")
                        result['s3ObjectsDeleted'] += 1
            
            print(f"Deleted {result['s3ObjectsDeleted']} S3 objects for userId: {user_id}")
            
        except Exception as s3_error:
            print(f"Error deleting S3 objects: {str(s3_error)}")
            # Continue with other deletions even if S3 deletion fails
        
        # 2. Delete ALL IEP document records for the user, and the S3 artifacts
        #    derived from each one. Order matters: contentS3Reference is the
        #    only pointer to the summary object, so the row has to be read (and
        #    its artifacts purged) before it is deleted.
        try:
            # Query documents by userId using the GSI
            documents = _query_all_documents(
                'byUserId', 'userId = :userId', {':userId': user_id})

            # Delete each document record
            for doc in documents:
                try:
                    result['s3ObjectsDeleted'] += _delete_document_artifacts(
                        s3, bucket_name, doc)
                except Exception as artifact_error:
                    print(f"Error deleting S3 artifacts for {doc.get('iepId')}: {str(artifact_error)}")

                iep_documents_table.delete_item(
                    Key={
                        'iepId': doc['iepId'],
                        'childId': doc['childId']
                    }
                )
                print(f"Deleted IEP document record with iepId: {doc['iepId']}")
                result['documentsDeleted'] += 1
            
            print(f"Deleted {result['documentsDeleted']} IEP document records for userId: {user_id}")
            
        except Exception as ddb_error:
            print(f"Error deleting document records: {str(ddb_error)}")
            # Continue with profile deletion even if document deletion fails
        
        # 3. Remove their referral footprint. Before the profile goes, because
        #    a failure here should still leave the account recoverable-looking
        #    rather than half-deleted with no profile to explain it.
        try:
            result['referrals'] = _purge_referral_data(user_id)
        except Exception as referral_error:
            print(f"Error purging referral data: {str(referral_error)}")
            # Continue: a stuck referral row must not block account deletion

        # 4. Delete the user profile record
        try:
            user_profiles_table.delete_item(
                Key={'userId': user_id}
            )
            result['profileDeleted'] = True
            print(f"Deleted user profile for userId: {user_id}")
            
        except Exception as profile_error:
            print(f"Error deleting user profile: {str(profile_error)}")
            # Continue with Cognito deletion even if profile deletion fails
        
        # 5. Delete the Cognito user account
        try:
            cognito = boto3.client('cognito-idp')
            user_pool_id = os.environ.get('USER_POOL_ID', '')
            
            # Delete the user from Cognito User Pool
            cognito.admin_delete_user(
                UserPoolId=user_pool_id,
                Username=user_id
            )
            result['cognitoUserDeleted'] = True
            print(f"Deleted Cognito user for userId: {user_id}")
            
        except Exception as cognito_error:
            print(f"Error deleting Cognito user: {str(cognito_error)}")
            # This is not a critical failure - user data is already deleted
        
        # Return success response with deletion summary
        return create_response(event, 200, {
            'message': 'User profile and all associated data successfully deleted',
            'userId': user_id,
            'deletionSummary': result
        })
        
    except Exception as e:
        print(f"Error in delete_user_profile: {str(e)}")
        return create_response(event, 500, {'message': 'Could not delete your account. Please try again later.'})

def lambda_handler(event: Dict, context) -> Dict:
    """
    Main Lambda handler function that routes requests to appropriate handlers using the router.
    
    Args:
        event (Dict): API Gateway event object
        context: Lambda context object
        
    Returns:
        Dict: API Gateway response
    """
    print(f"Lambda handler invoked with event: {json.dumps(sanitize_event_for_logging(event), default=str)}")
    
    try:
        # Handle OPTIONS request for CORS
        if event['requestContext']['http']['method'] == 'OPTIONS':
            print("Handling OPTIONS request for CORS")
            return handle_options(event)

        # Get path and method
        path = event['rawPath']
        method = event['requestContext']['http']['method']
        print(f"Processing {method} request for path: {path}")

        # Initialize router
        router = Router()
        profile_router = UserProfileRouter()

        # Register routes from UserProfileRouter
        for attr_name in dir(profile_router):
            attr = getattr(profile_router, attr_name)
            if hasattr(attr, 'path') and hasattr(attr, 'method'):
                router.add_route(attr.path, attr.method, getattr(profile_router, attr_name))
                
        print(f"Attempting to match route for path: {path}, method: {method}")
        # Match and execute route
        handler, path_params = router.match_route(path, method)
        print(f"Route matched. Handler: {handler.__name__}, Path params: {path_params}")
        
        # Update path parameters
        if not event.get('pathParameters'):
            event['pathParameters'] = {}
        event['pathParameters'].update(path_params)
        
        print(f"Invoking handler: {handler.__name__} with updated pathParameters: {event.get('pathParameters')}")
        return handler(event)

    except RouteNotFoundException as e:
        print(f"Route not found: {path} with method {method}")
        return create_response(event, 404, {'message': str(e)})
    except Exception as e:
        error_message = f"Error processing request: {str(e)}, Type: {type(e).__name__}"
        print(error_message)
        import traceback
        print(f"Traceback: {traceback.format_exc()}")
        return create_response(event, 500, {'message': 'Internal server error. Please try again later.'}) 