import json
import os
import boto3
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Literal, Tuple
from router import Router, UserProfileRouter, RouteNotFoundException
from student_name_substitution import substitute_content, usable_student_name
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import re
import unicodedata
from botocore.exceptions import BotoCoreError, ClientError
from functools import partial

dynamodb = boto3.resource('dynamodb')
user_profiles_table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])
iep_documents_table = dynamodb.Table(os.environ['IEP_DOCUMENTS_TABLE'])

# Initialize KMS client using Lambda's region from AWS_REGION (provided by runtime)
region = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'))
kms_client = boto3.client('kms', region_name=region)
kms_key_alias = os.environ.get('AIEP_KMS_KEY_ALIAS', 'alias/aiep/app')

print(f"KMS client initialized for region: {region}, using key alias: {kms_key_alias}")

# Clients are built once per container, not once per request: constructing one
# loads the service model from disk and costs tens of milliseconds, and a warm
# invocation should pay none of it. dynamodb and kms are created above because
# every request needs them. s3, lambda and cognito-idp are built on first use
# and then kept: building them at import would add their cost to every cold
# start, including GET /profile, which touches none of them.
_clients = {}


def _aws_client(service: str):
    if service not in _clients:
        _clients[service] = boto3.client(service)
    return _clients[service]


SUPPORTED_LANGUAGES = ['en', 'zh', 'es', 'vi', 'ar']
DEFAULT_LANGUAGE = 'en'

# Where a document's content lives, whether inline on the row or in the S3
# object. Every shape get_child_documents can return fills all four.
CONTENT_FIELDS = ('summaries', 'sections', 'document_index', 'abbreviations')

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


# Every response here is one family's records or a refusal about them. A shared
# cache or the browser's back/forward cache must never replay one to the next
# person on the device, so nothing from this handler is storable.
NO_STORE = 'no-store'


def get_origin_from_event(event: Dict) -> str:
    """
    Extract origin from event headers in a case-insensitive way.
    
    Args:
        event (Dict): The API Gateway event object
        
    Returns:
        str: The origin header value or default localhost
    """
    headers = event.get('headers', {})
    # Case-insensitive search for origin header
    return next(
        (headers[key] for key in headers if key.lower() == 'origin'),
        'http://localhost:3000'
    )

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
            'Cache-Control': NO_STORE,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
        },
        'body': json.dumps(body, cls=DecimalEncoder)
    }

def not_found(event: Dict) -> Dict:
    """The one 404, for an unknown route and for a child that is not the caller's.

    Not 403 for the second, and not different from a child that does not exist:
    "this id exists but is not yours" tells a caller which ids are real. The
    reason is logged by the caller; the body says nothing about it, and never
    echoes the path or the exception text.
    """
    return create_response(event, 404, {'message': 'Not found'})


# What a fault in AWS itself looks like to boto3. Only these become a 503: a
# bug in this code (a KeyError, a TypeError) is still our 500, and neither is
# ever a 403 or a 404, which would tell a parent something about their records
# that is not true.
AWS_FAULTS = (ClientError, BotoCoreError)


def service_unavailable(event: Dict, operation: str, error: Exception) -> Dict:
    """503 for a fault in DynamoDB, KMS or S3, with the reason in the log.

    Generic body: the cause (a table name, an AWS error code) goes to
    CloudWatch only. The logged reason is the exception class and, for a
    service error, its code; never its message, which can quote a key.
    """
    code = error.response.get('Error', {}).get('Code', '') if isinstance(error, ClientError) else ''
    print(f"{operation}: unavailable, {type(error).__name__} {code}".rstrip())
    return create_response(event, 503, {
        'message': 'This service is temporarily unavailable. Please try again in a moment.'
    })


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
            'Cache-Control': NO_STORE,
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

# --- What counts as a child's name ------------------------------------------
# The same rule the screen applies in
# lib/user-interface/app/src/common/child-name.ts, and the two have to stay
# identical: a name the screen accepts and this rejects reaches the parent as a
# generic "could not save", with nothing on the page telling them what to fix.
#
# Nothing validated this before. '123', '!!!' and '.' all stored fine, and the
# stored value is what goes into the heading of every summary, every
# translation, and the audio a parent listens to.
CHILD_NAME_MAX_LENGTH = 64

# What a name may hold besides letters (Unicode category L*) and combining
# marks (M*, which is what makes Vietnamese and Arabic work at all): a space,
# both hyphens, both apostrophes, and the period that ends an initial.
_CHILD_NAME_PUNCTUATION = frozenset(" -\u2010'\u2019.")

# (log reason, response message) per refusal. Only the code's log reason
# reaches CloudWatch and only the message reaches the caller: the name itself
# is a FERPA-protected record of a child with a disability, so it is in neither,
# nor in any exception raised along the way.
CHILD_NAME_REJECTIONS = {
    'required': (
        'blank or whitespace-only child name',
        'Child name cannot be blank',
    ),
    'tooLong': (
        f'child name longer than {CHILD_NAME_MAX_LENGTH} characters',
        f'Child name must be {CHILD_NAME_MAX_LENGTH} characters or fewer',
    ),
    'invalid': (
        'child name holds no letter, or a character that is not name punctuation',
        'Child name must contain a letter, and can only use letters, numbers, '
        'spaces, hyphens, apostrophes and periods',
    ),
}


def validate_child_name(name) -> Optional[str]:
    """Which rule the name breaks, or None when it breaks none.

    Checked in the order the messages are written, so an over-long run of
    digits is reported as too long here and on the screen both.

    Deliberately not a regex over an ASCII range: four of the five languages
    this ships in are Spanish, Chinese, Vietnamese and Arabic, and a name is
    whatever a family's script writes one with.
    """
    collapsed = ' '.join(name.split()) if isinstance(name, str) else ''
    if not collapsed:
        return 'required'
    if len(collapsed) > CHILD_NAME_MAX_LENGTH:
        return 'tooLong'
    has_letter = False
    for character in collapsed:
        category = unicodedata.category(character)
        if category.startswith('L'):
            has_letter = True
        # Nd alongside M: a digit is allowed in a name that also has letters,
        # so a parent telling two children apart as "Anna 2" is not refused.
        elif (not category.startswith('M') and category != 'Nd'
                and character not in _CHILD_NAME_PUNCTUATION):
            return 'invalid'
    # "123", "." and "-" are not names: something has to be a letter.
    return None if has_letter else 'invalid'


def bad_request(event: Dict, operation: str, user_id: str, reason: str, message: str) -> Dict:
    """400 with the reason in CloudWatch. Every 4xx in this handler goes
    through here so none is silent.

    `reason` is a fixed phrase naming the rule that was broken, never the value
    that broke it: values are a parent's and a child's details.
    """
    print(f"Rejecting {operation} for userId {user_id}: {reason}")
    return create_response(event, 400, {'message': message})


def reject_child_name(event: Dict, operation: str, user_id: str, reason: str) -> Dict:
    """400 for a name we will not store, with the reason code in CloudWatch.

    The reason, never the value: a silent 4xx made one real failure in this
    file undiagnosable, and a logged child's name would be a FERPA disclosure
    to anyone with log-read access.
    """
    log_reason, message = CHILD_NAME_REJECTIONS[reason]
    return bad_request(event, operation, user_id, log_reason, message)


# Word starts, for capitalising a name: the beginning of the string, or the
# character after a space, a hyphen, or either apostrophe. So "mary-jane" and
# "o'brien" get both halves, not just the first.
_NAME_WORD_START = re.compile(r"(^|[\s\-'\u2019])(\w)", re.UNICODE)


# The fields a child object holds, which is every field this app writes or reads
# back: childId and the timestamps are server-issued (default child, add_child)
# and the screen sends the whole object back when it renames a child, so
# dropping any of them would lose data on the next save. Nothing else is stored.
CHILD_FIELDS = ('childId', 'name', 'schoolCity',
                'createdAt', 'createdAtISO', 'updatedAt', 'updatedAtISO')
_CHILD_INT_FIELDS = ('createdAt', 'updatedAt')
_CHILD_STRING_FIELDS = ('schoolCity', 'createdAtISO', 'updatedAtISO')
CHILD_ID_MAX_LENGTH = 128


def clean_children(children) -> Tuple[Optional[List[Dict]], Optional[Tuple[str, str]]]:
    """Validate the `children` of a profile update and keep only known fields.

    Returns (children, None) with new dicts holding CHILD_FIELDS only (the name
    not yet normalized or encrypted), or (None, (log reason, response message))
    for the first problem. Never raises on any JSON a caller can send.
    """
    if not isinstance(children, list):
        return None, ('children is not a list', 'children must be a list of child objects')

    cleaned = []
    seen_ids = set()
    for child in children:
        if not isinstance(child, dict):
            return None, ('a child is not an object', 'Each child must be an object')
        if 'name' not in child or 'schoolCity' not in child:
            return None, ('a child has no name or schoolCity',
                          'Each child must have name and schoolCity')
        if not isinstance(child['name'], str):
            return None, ('child name is not a string', 'Child name must be text')
        reason = validate_child_name(child['name'])
        if reason:
            return None, CHILD_NAME_REJECTIONS[reason]
        for field in _CHILD_STRING_FIELDS:
            if field in child and not isinstance(child[field], str):
                return None, (f'child {field} is not a string', f'Child {field} must be text')
        for field in _CHILD_INT_FIELDS:
            value = child.get(field)
            if field in child and (isinstance(value, bool) or not isinstance(value, int)):
                return None, (f'child {field} is not a whole number',
                              f'Child {field} must be a whole number')
        child_id = child['childId'] if 'childId' in child else str(uuid.uuid4())
        if (not isinstance(child_id, str) or not child_id.strip()
                or len(child_id) > CHILD_ID_MAX_LENGTH):
            return None, ('child childId is not a usable string', 'Child childId must be text')
        if child_id in seen_ids:
            return None, ('two children share a childId', 'Each child must have its own childId')
        seen_ids.add(child_id)

        kept = {field: child[field] for field in CHILD_FIELDS if field in child}
        kept['childId'] = child_id
        dropped = len(child) - len([field for field in child if field in CHILD_FIELDS])
        if dropped:
            print(f"Dropped {dropped} unrecognised child field(s) from a profile update")
        cleaned.append(kept)
    return cleaned, None


def normalize_child_name(name: str) -> str:
    """Tidy the name a parent typed, without ever overruling a choice they made.

    A parent typing "dhruv" gets "Dhruv" in the heading of every summary, in
    five languages, and today has no way to go back and fix it. So the lower
    case case is worth correcting on the way in.

    The rule is deliberately narrow: capitalise ONLY when the parent typed no
    capital at all. The moment there is one, the whole value is left exactly as
    given, because every clever rule beyond this point gets somebody's name
    wrong:

      AJ -> Aj             McDonald -> Mcdonald
      van der Berg -> Van Der Berg      JOSE -> Jose

    Those are real names, and getting a child's name wrong is not a neutral
    error in a product about their disability. An all-capitals name is left
    alone for the same reason: "AJ" and a stuck caps lock are indistinguishable
    from here, and only one of the two guesses is recoverable by the parent.

    Scripts without case are unaffected by construction, since str.upper() is a
    no-op on them: Chinese, Arabic and the unaccented parts of Vietnamese all
    pass through untouched, and Python's upper() is Unicode-aware, so
    "nguyễn" -> "Nguyễn" and "josé" -> "José" both come out right.

    Runs of whitespace are collapsed as well, so the redaction matcher, which
    splits the name on whitespace, sees the same tokens the parent meant.
    """
    collapsed = ' '.join((name or '').split())
    if any(character.isupper() for character in collapsed):
        return collapsed
    return _NAME_WORD_START.sub(
        lambda match: match.group(1) + match.group(2).upper(), collapsed)


class KmsUnavailable(RuntimeError):
    """KMS could not answer, as opposed to the field not being ciphertext."""


def kms_decrypt_string(ciphertext_b64: str, strict: bool = False) -> str:
    """Decrypt a field, or hand it back if it was never ciphertext.

    Fields written before encryption existed are plaintext, and some of those
    happen to look like base64, so a decrypt that fails because the bytes are
    not ciphertext (InvalidCiphertextException) hands the value back.

    strict=True is for callers that would otherwise show the result to a
    parent: any OTHER failure (throttling, an outage, a revoked key) raises
    KmsUnavailable instead of returning the ciphertext, which would print a
    blob where their phone number or their child's name belongs. Callers that
    can live without the value (the child's name inside a summary) leave it
    off and keep the lenient behaviour.
    """
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
        if strict and error_code != 'InvalidCiphertextException':
            raise KmsUnavailable(error_code) from e
        if error_code in ['UnrecognizedClientException', 'AccessDeniedException', 'InvalidCiphertextException']:
            print("Assuming plaintext data (encryption may be disabled)")
        return ciphertext_b64
    except Exception as e:
        print(f"KMS decrypt failed with unexpected error: {str(e)}")
        if strict:
            raise KmsUnavailable(type(e).__name__) from e
        return ciphertext_b64

# KMS Decrypt is a network call (~10-20ms). A profile holds up to three PII
# fields plus one name per child, and they were decrypted one after another.
# Four workers cover the usual profile in a single round trip's time. The pool
# is module level so threads are created once, on first use, not per request.
_DECRYPT_WORKERS = 4
_decrypt_pool = ThreadPoolExecutor(max_workers=_DECRYPT_WORKERS)
_PROFILE_PII_FIELDS = ('phone', 'city', 'parentName')


def _decrypt_profile_fields(profile: Dict) -> None:
    """Decrypt, in place and concurrently, every encrypted string on a profile.

    Result is identical to decrypting each field in turn: the same fields, each
    through kms_decrypt_string, written back to the same place. A field that is
    not ciphertext at all (legacy plaintext) is handed back as it was; a KMS
    that cannot answer raises KmsUnavailable for the caller to turn into a 503.
    """
    targets = []
    for field in _PROFILE_PII_FIELDS:
        if isinstance(profile.get(field), str):
            targets.append((profile, field))
    for child in profile.get('children') or []:
        if isinstance(child, dict) and isinstance(child.get('name'), str):
            targets.append((child, 'name'))
    targets = [(holder, key) for holder, key in targets if holder[key]]
    if not targets:
        return
    ciphertexts = [holder[key] for holder, key in targets]
    decrypt = partial(kms_decrypt_string, strict=True)
    if len(ciphertexts) == 1:
        plaintexts = [decrypt(ciphertexts[0])]
    else:
        plaintexts = list(_decrypt_pool.map(decrypt, ciphertexts))
    for (holder, key), plaintext in zip(targets, plaintexts):
        holder[key] = plaintext


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
        
        try:
            response = user_profiles_table.get_item(
                Key={'userId': user_id}
            )
        except AWS_FAULTS as e:
            return service_unavailable(event, 'get_user_profile read', e)
        
        times = get_timestamps()
        
        if 'Item' not in response:
            print(f"No existing profile found for userId: {user_id}, creating new profile")

            # Create default child for IEP document functionality, with NO
            # name. 'My Child' used to go here, but the redaction pipeline
            # restores this value verbatim into the summary, so a placeholder
            # would land in a parent's document. An empty name is what the
            # frontend's studentNameGate (common/features.ts) checks for, so
            # onboarding asks every parent for it exactly once.
            default_child = {
                'childId': str(uuid.uuid4()),
                'name': '',
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

        # Check if existing profile has no children and add default child if needed
        if 'children' not in existing_profile or not existing_profile['children']:
            print(f"Existing profile found but no children, adding default child for userId: {user_id}")

            # Empty name, same reasoning as the fresh-profile branch above.
            default_child = {
                'childId': str(uuid.uuid4()),
                'name': '',
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

        # Decrypt the PII fields and each child's name. The parent's phone,
        # city and name, and every child's name (see kms_encrypt_string in
        # add_child and in the children branch of update_user_profile for where
        # they are written encrypted). Each is an independent KMS round trip,
        # so they run together rather than one after another. A default
        # child's name is '' and decrypting that is a no-op.
        try:
            _decrypt_profile_fields(existing_profile)
        except KmsUnavailable as e:
            return service_unavailable(event, 'get_user_profile decrypt', e)

        return create_response(event, 200, {'profile': existing_profile})
        
    except Exception as e:
        print(f"Error in get_user_profile: {str(e)}")
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
            return bad_request(event, 'update_user_profile', user_id,
                               'body is not valid JSON', 'Invalid JSON body')
        if not isinstance(body, dict):
            return bad_request(event, 'update_user_profile', user_id,
                               'body is not a JSON object',
                               'Invalid JSON body: expected a JSON object')
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
            return bad_request(
                event, 'update_user_profile', user_id, 'email is not updatable here',
                'Email cannot be updated directly. Please update your email through account settings.')
        
        for field, attr_name in optional_fields.items():
            if field in body:
                # Special validation for language fields
                if field in ['primaryLanguage', 'secondaryLanguage']:
                    if body[field] and not validate_language(body[field]):
                        return bad_request(
                            event, 'update_user_profile', user_id,
                            f'unsupported language for {field}',
                            f'Unsupported language for {field}. Supported languages: {SUPPORTED_LANGUAGES}')
                
                # Validation for consentGiven boolean field
                if field == 'consentGiven' and not isinstance(body[field], bool):
                    return bad_request(
                        event, 'update_user_profile', user_id, 'consentGiven is not a boolean',
                        'consentGiven must be a boolean value (true or false)')
                
                # Validation for showOnboarding boolean field
                if field == 'showOnboarding' and not isinstance(body[field], bool):
                    return bad_request(
                        event, 'update_user_profile', user_id, 'showOnboarding is not a boolean',
                        'showOnboarding must be a boolean value (true or false)')
                
                # Encrypt selected PII fields at rest
                value_to_store = body[field]
                if field in ['phone', 'city', 'parentName'] and isinstance(value_to_store, str):
                    value_to_store = kms_encrypt_string(value_to_store)
                update_parts.append(f'{attr_name} = :{field}')
                expr_values[f':{field}'] = value_to_store
            
        # Handle children array if present
        if 'children' in body:
            # A blank, over-long or non-name value is refused and logged with
            # its reason (an unlogged validation rejection already made one
            # real failure in this file undiagnosable), and so is anything
            # that is not the list of child objects the screen sends.
            children, problem = clean_children(body['children'])
            if problem:
                return bad_request(event, 'update_user_profile', user_id, *problem)

            # Encrypt at rest, same as phone/city/parentName above.
            update_parts.append('children = :children')
            expr_values[':children'] = [
                {**child, 'name': kms_encrypt_string(normalize_child_name(child['name']))}
                for child in children
            ]

        # If no fields to update (the first two parts are always the
        # updatedAt/updatedAtISO timestamps)
        if len(update_parts) == 2:
            return bad_request(event, 'update_user_profile', user_id,
                               'no updatable fields in the body', 'No fields to update provided')
            
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
                cognito = _aws_client('cognito-idp')
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
            return bad_request(event, 'add_child', user_id,
                               'body is not valid JSON', 'Invalid JSON body')
        if not isinstance(body, dict):
            return bad_request(event, 'add_child', user_id, 'body is not a JSON object',
                               'Invalid JSON body: expected a JSON object')
        times = get_timestamps()

        # Validate required fields
        if 'name' not in body or 'schoolCity' not in body:
            return bad_request(event, 'add_child', user_id, 'name or schoolCity missing',
                               'Missing required fields: name and schoolCity required')
        if not isinstance(body['schoolCity'], str):
            return bad_request(event, 'add_child', user_id, 'schoolCity is not a string',
                               'schoolCity must be text')

        # Blank, over-long, or not a name at all: same rule, same reason and
        # the same reason codes as the children branch of update_user_profile.
        # Two write paths, one definition of what we will store.
        reason = validate_child_name(body['name'])
        if reason:
            return reject_child_name(event, 'add_child', user_id, reason)

        # Generate new childId
        child_id = str(uuid.uuid4())
        new_child = {
            'childId': child_id,
            'name': kms_encrypt_string(normalize_child_name(body['name'])),
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
        
    except FieldEncryptionError as e:
        # Same rule as update_user_profile: never fall back to storing the
        # child's name in plaintext.
        print(f"Refusing to add child due to field encryption failure: {str(e)}")
        return create_response(event, 503, {
            'message': 'Could not add the child right now: encryption service error. Please try again later.'
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

def _find_child(profile: Optional[Dict], child_id: str) -> Optional[Dict]:
    """The profile's child with this childId, or None.

    None covers every way a child can be missing: no profile, no children, a
    children attribute of the wrong type, or no match. Ownership is exactly
    "this returns a child".
    """
    if not profile or not child_id:
        return None
    children = profile.get('children') or []
    if not isinstance(children, list):
        return None
    for child in children:
        if isinstance(child, dict) and child.get('childId') == child_id:
            return child
    return None


def _owned_child(user_id: str, child_id: str) -> Optional[Dict]:
    """The caller's child with this childId, or None if it is not theirs.

    Raises an AWS_FAULTS error if the profile cannot be read: "could not check"
    is not "not yours", and callers answer the first with a 503 and only the
    second with a 404.
    """
    if not user_id or not child_id:
        return None
    profile = user_profiles_table.get_item(Key={'userId': user_id}).get('Item')
    return _find_child(profile, child_id)


def _child_name(child: Optional[Dict]) -> Optional[str]:
    """A child's name from its profile entry, decrypted, or None.

    None is a complete answer rather than a failure: the parent may not have
    been asked for a name yet, and the caller falls back to the neutral phrase
    for the language being read. Nothing here raises. A decrypt that fails
    costs a parent the name inside their summary, which is not worth a 500 on
    a document they could otherwise read.

    kms_decrypt_string hands back the ciphertext it was given when a decrypt
    fails; usable_student_name's length guard is what stops that base64 blob
    being printed to a parent as their child's name.
    """
    try:
        if child:
            return usable_student_name(kms_decrypt_string(child.get('name')))
    except Exception as e:
        # Class name only: this function's result is a child's name.
        print(f"Could not read the child's name for substitution: {type(e).__name__}")
    return None


def _epoch_seconds(value) -> Optional[int]:
    """`value` as epoch seconds, or None if it is not a timestamp we can read.

    Handles the two shapes a document row's timestamps come in: a DynamoDB
    number (Decimal) already in epoch seconds, and an ISO 8601 string.

    Never raises. This feeds one line of prose under a parent's summary, which
    is not worth a 500 on a document they could otherwise read.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, (int, float, Decimal)):
        return int(value)

    if isinstance(value, str) and value.strip():
        try:
            # The pipeline writes datetime.utcnow().isoformat(): UTC, but with
            # no offset on it. A naive datetime's .timestamp() is read as LOCAL
            # time, which is only UTC in the lambda by accident of TZ, so the
            # zone is attached explicitly. A trailing Z is normalized because
            # fromisoformat only accepts one from Python 3.11.
            parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())

    return None


def _document_updated_at(doc: Dict):
    """The last time anything touched this document, in epoch seconds.

    Two attributes carry this and they are not interchangeable:

    - `updatedAt` is written ONCE, by upload-s3, at the moment the row is
      created, in epoch seconds. Nothing ever writes it again.
    - `updated_at` is what every writer since then uses -- ddb-service's
      update_progress and record_failure, the S3 content migration, and
      translation-request-handler's claim/release -- as an ISO string.

    So reading `updatedAt` alone, which is what this endpoint used to do,
    reported the moment the parent pressed upload and called it the last
    update: a document that took four minutes to summarize, and one that had a
    language added weeks later, both showed the original upload time.

    The later of the two is the answer, rather than `updated_at` outright, so
    that rows predating it keep the only timestamp they have.

    Normalized to seconds here rather than passed through: the frontend's
    TextHelper.formatUnixTimestamp multiplies by 1000, so an ISO string
    reaches a parent as "Invalid Date" -- and the `document.updatedAt &&`
    guard in front of it does not catch that, because a non-empty string is
    truthy.
    """
    known = [
        seconds for seconds in (
            _epoch_seconds(doc.get('updated_at')),
            _epoch_seconds(doc.get('updatedAt')),
        )
        if seconds is not None
    ]
    # '' rather than None to match the createdAt line beside it. Both are
    # falsy, which is what the frontend checks before rendering the line.
    return max(known) if known else ''


# What S3 answers for a key that is not there.
S3_MISSING_CODES = ('NoSuchKey', '404', 'NotFound')


def _has_inline_content(doc: Dict) -> bool:
    """Whether a row still carries its content inline (the pre-S3 layout).

    That is the only thing the lazy migration can act on: ddb-service's
    migrate_dynamodb_to_s3 returns "no content to migrate" for a row without
    any, whatever its status.
    """
    return any(doc.get(field) for field in CONTENT_FIELDS)


class DocumentContentUnavailable(RuntimeError):
    """S3 did not answer when a document's content was read."""

    def __init__(self, cause: Exception):
        super().__init__(type(cause).__name__)
        self.cause = cause


# Statuses at which a document's content is complete and readable as it stands.
# PROCESSING_TRANSLATIONS is an add-on translation running on a finished
# document (the upload pipeline never uses it), so it still reads.
READABLE_STATUSES = ('PROCESSED', 'PROCESSING_TRANSLATIONS')


def _newest_document(documents: List[Dict]) -> Optional[Dict]:
    """The row with the latest createdAt, or None. A row needs a creation time
    to be the latest, so one without is never chosen."""
    newest = None
    newest_created_at = 0
    for doc in documents:
        created_at = doc.get('createdAt', 0)
        if created_at > newest_created_at:
            newest, newest_created_at = doc, created_at
    return newest


def _display_status(doc: Dict) -> str:
    """The status the frontend is told: PENDING_UPLOAD (and no status at all,
    on rows older than that value) read as PROCESSING."""
    return 'PROCESSING' if doc.get('status') in (None, 'PENDING_UPLOAD') else doc['status']


def _document_with_content(doc: Dict, user_id: str) -> Dict:
    """The API shape of one document row, with its four content fields filled.

    Raises DocumentContentUnavailable if S3 is not answering; every other
    failure to read content falls back to empty or inline content, as before.
    """
    # PENDING_UPLOAD (and, for rows written before that status
    # existed, no status at all) means the upload handler wrote
    # this row but the pipeline has not started yet. Surface it
    # as PROCESSING: that is the value the frontend already
    # polls and renders a spinner for, and the real value stays
    # in DynamoDB so ddb-service's pending-upload sweep can
    # tell a stalled upload apart from real in-flight work.
    latest_doc = {
        'iepId': doc['iepId'],
        'documentId': doc['iepId'],  # Also include documentId for frontend compatibility
        'childId': doc['childId'],
        'documentUrl': doc.get('documentUrl', f"s3://{os.environ.get('BUCKET', '')}/{doc['iepId']}"),
        'status': _display_status(doc),
        'progress': doc.get('progress', 0),
        'current_step': doc.get('current_step', 'initializing'),
        'createdAt': doc.get('createdAt', ''),
        'updatedAt': _document_updated_at(doc)
    }

    # Check if content is in S3 (new format) or DynamoDB (old format)
    if 'contentS3Reference' in doc:
        # New format: fetch content from S3
        s3_ref = doc['contentS3Reference']
        try:
            s3_response = _aws_client('s3').get_object(Bucket=s3_ref['bucket'], Key=s3_ref['s3Key'])
            content = json.loads(s3_response['Body'].read().decode('utf-8'))

            # Merge content into latest_doc
            latest_doc.update({
                'summaries': content.get('summaries', {}),
                'sections': content.get('sections', {}),
                'document_index': content.get('document_index', {}),
                'abbreviations': content.get('abbreviations', {})
            })
            print(f"Successfully fetched content from S3 for {doc['iepId']}")
        except AWS_FAULTS as e:
            # A missing object is a fact about this document
            # (the row outlived its content): keep the empty
            # fallback below. Anything else is S3 not
            # answering, and an empty summary served as if it
            # were the document is the wrong reply to that.
            if not (isinstance(e, ClientError)
                    and e.response.get('Error', {}).get('Code') in S3_MISSING_CODES):
                raise DocumentContentUnavailable(e) from e
            print(f"Content object missing in S3 for {doc['iepId']}")
            latest_doc.update({field: {} for field in CONTENT_FIELDS})
        except Exception as e:
            print(f"Error fetching content from S3 for {doc['iepId']}: {str(e)}")
            # Fallback to empty content
            latest_doc.update({field: {} for field in CONTENT_FIELDS})
    elif not _has_inline_content(doc):
        # No content anywhere yet, which is the normal state of
        # a row in PENDING_UPLOAD or PROCESSING: the pipeline
        # has not written any. The migration has nothing to
        # move (ddb-service answers "no content to migrate"),
        # so invoking it is a synchronous call to a cold
        # lambda (~1s) that hands back the same empty content.
        # 42% of document reads took that detour.
        latest_doc.update({field: {} for field in CONTENT_FIELDS})
    else:
        # Old format: migrate to S3 (lazy migration)
        print(f"Migrating {doc['iepId']}/{doc['childId']} to S3 (lazy migration)")
        try:
            # Call DDB service to migrate
            lambda_client = _aws_client('lambda')
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
                latest_doc.update(_inline_content(doc))
        except Exception as e:
            print(f"Error migrating document {doc['iepId']}: {str(e)}")
            # Fallback to old format
            latest_doc.update(_inline_content(doc))

    return latest_doc


def _inline_content(doc: Dict) -> Dict:
    """The four content fields as a row holds them inline, unwrapped from
    DynamoDB's typed JSON."""
    return {field: clean_dynamodb_json(doc.get(field, {})) for field in CONTENT_FIELDS}


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
        # The profile is read once: the same item answers ownership here and
        # supplies the child's name for the substitution below.
        try:
            profile = user_profiles_table.get_item(Key={'userId': user_id}).get('Item')
        except AWS_FAULTS as e:
            return service_unavailable(event, 'get_child_documents ownership check', e)
        owned_child = _find_child(profile, child_id)
        if owned_child is None:
            print(f"Access denied: user {user_id} does not own child {child_id}")
            return not_found(event)

        # Every document row for the child, across query pages: one page caps
        # at 1MB and these rows can carry inline summaries, so an unpaginated
        # read could miss the newest document.
        try:
            documents = _query_all_documents(
                'byChildId', 'childId = :childId', {':childId': child_id})
        except AWS_FAULTS as e:
            return service_unavailable(event, 'get_child_documents query', e)

        # Strict ownership: require an explicit userId match. Documents without
        # a userId field are not returned to avoid IDOR via missing fields.
        owned = [doc for doc in documents if doc.get('userId') == user_id]
        latest_row = _newest_document(owned)
        replacement_row = None

        # A parent who replaces their IEP keeps the old one until the new one
        # is ready (the pipeline deletes it only once the new one is PROCESSED).
        # So while the newest document is still being processed, or failed, the
        # parent is shown the newest one they can already read, and the newer
        # one is only reported alongside it. Without an older readable
        # document (a first upload) nothing changes: the newest is returned
        # whatever its status, which is what drives the processing screen.
        if latest_row is not None and latest_row.get('status') not in READABLE_STATUSES:
            # Every readable row is older than latest_row, which is the newest.
            readable_before = _newest_document([
                doc for doc in owned if doc.get('status') in READABLE_STATUSES])
            if readable_before is not None:
                replacement_row, latest_row = latest_row, readable_before

        # Only the winner's content is fetched. Each newer-than-so-far row used
        # to be read from S3 (or migrated) as the loop met it, so a child with
        # several documents paid for every one of them to return one.
        latest_doc = None
        if latest_row is not None:
            try:
                latest_doc = _document_with_content(latest_row, user_id)
            except DocumentContentUnavailable as e:
                return service_unavailable(event, 'get_child_documents content read', e.cause)
        if latest_doc is not None and replacement_row is not None:
            # Id and status only, never anything from the row's content.
            latest_doc['replacement'] = {
                'iepId': replacement_row['iepId'],
                'status': _display_status(replacement_row),
            }
            print(f"Showing {latest_doc['iepId']} while {replacement_row['iepId']} is "
                  f"{latest_doc['replacement']['status']}")

        # If no document found
        if not latest_doc:
            return create_response(event, 200, {'documents': [], 'message': 'No document found for this child'})

        # The child's name is never written into stored content: it keeps the
        # {{S}} placeholder and every reader substitutes on the way out. That
        # is why the on-demand translation can re-read this same content
        # without handing the model a name, and why correcting a misspelled
        # name fixes every summary a parent already has.
        #
        # One site, after the branches above have converged on one dict,
        # rather than one per branch: a return shape added later cannot skip
        # it. Documents that predate the redaction hold real names and no
        # token, and pass through unchanged.
        try:
            stored = {field: latest_doc[field] for field in CONTENT_FIELDS if field in latest_doc}
            substituted, count = substitute_content(stored, _child_name(owned_child))
            latest_doc = {**latest_doc, **substituted}
            print(f"Substituted the student token in {count} place(s) for {latest_doc['iepId']}")
        except Exception as e:
            # A placeholder on screen is bad; losing a readable document to a
            # 500 is worse. Class name only, never the content.
            print(f"Student name substitution failed: {type(e).__name__}")

        return create_response(event, 200, latest_doc)
        
    except Exception as e:
        print(f"Error retrieving documents: {str(e)}")
        return create_response(event, 500, {'message': 'Could not load your documents. Please try again later.'})

def _delete_every_version(s3, bucket, prefix, exact=False):
    """Permanently delete every version and delete marker under a prefix.

    The bucket is versioned, so DeleteObject without a VersionId only writes a
    delete marker: the bytes stay retrievable by version id until the 1-day
    noncurrent lifecycle rule reaches them, which measured 1 to 3 days on
    staging (2026-10-14). Deleting each version by id is immediate and final.
    Duplicated in each lambda that deletes from the bucket (each folder is
    its own asset).

    exact=True takes only the one key named by prefix. Version listing is by
    prefix, so report.pdf would otherwise also take report.pdf2.

    Returns the keys that had a current version, so callers count and log
    real deletions rather than markers and superseded versions.
    """
    visible = []
    for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
        versions = page.get('Versions', [])
        for entry in versions + page.get('DeleteMarkers', []):
            if exact and entry['Key'] != prefix:
                continue
            s3.delete_object(Bucket=bucket, Key=entry['Key'], VersionId=entry['VersionId'])
        visible.extend(v['Key'] for v in versions
                       if v.get('IsLatest') and (not exact or v['Key'] == prefix))
    return visible


def _delete_object_if_present(s3, bucket: str, key: str) -> int:
    """Delete one key, reporting whether it was actually there.

    S3 DeleteObject succeeds on a key that never existed, so counting every
    call would report phantom deletions back to the client. Counting only
    keys that had a current version keeps the deletion summary honest, and a
    failed version listing raises rather than reading as "already gone".
    """
    if not _delete_every_version(s3, bucket, key, exact=True):
        return 0
    print(f"Deleted S3 object: {_safe_key(key)}")
    return 1

# Keys under these prefixes are built from ids alone (iep-data/<iepId>/<childId>/
# content.json and the like), so they are safe to log whole.
_ID_ONLY_PREFIXES = ('iep-data/', 'iep-audio/')


def _safe_key(key):
    """An S3 key fit for CloudWatch: an upload's filename removed.

    An original upload is userId/childId/iepId/<filename>, and parents
    routinely name the file after their child, so the filename is student
    data. Mirrors _safe_key in metadata-handler/orchestrator.py, extended to
    keep the ids-only derived keys readable.
    """
    if not isinstance(key, str):
        return '<no key>'
    if key.startswith(_ID_ONLY_PREFIXES):
        return key
    head, sep, _filename = key.rpartition('/')
    return f'{head}/...' if sep else '...'


def _delete_prefix(s3, bucket: str, prefix: str) -> int:
    """Delete every object under a prefix, returning the count removed."""
    deleted = _delete_every_version(s3, bucket, prefix)
    for key in deleted:
        print(f"Deleted S3 object: {_safe_key(key)}")
    return len(deleted)


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


# --- Deletion outcome -------------------------------------------------------
# A deletion that reports a success it did not achieve is the worst failure
# shape in this handler: the parent is told their child's records are gone,
# stops asking, and the FERPA content is still in the bucket. Both handlers
# below therefore record what survived each step and derive the response from
# that record, rather than from having reached the end of the function.
#
# Essential vs best-effort is decided by what is left behind when a step
# fails, not by how the step failed:
#
#   essential   - the child's record or the account itself survives. Raw
#                 uploads, the derived artifacts (summary, redacted OCR,
#                 cached audio), the document rows, the profile, the Cognito
#                 login. Cached audio counts: an mp3 is the child's summary
#                 read aloud, so leaving one behind is the same disclosure as
#                 leaving the summary behind.
#   best-effort - nothing of the child's record survives, only bookkeeping
#                 that carries no document content (the referral footprint).
#                 A failure there is logged and alarmed but does not turn the
#                 parent's deletion into an error, because there is nothing
#                 for them to retry and a stuck referral row must not strand a
#                 half-deleted account.

def _report_deletion_incomplete(scope: str, survived: List[str],
                                essential: bool, **ids) -> None:
    """Log the one line an alarm can count when a deletion did not finish.

    DELETION_INCOMPLETE is a stable marker, not prose: a metric filter alarms
    on it, and rewording this line would disarm that alarm. Same contract as
    RECORD_FAILURE in the pipeline. knowledge-management/delete-s3 emits it
    too, with scope=document.

    `essential` says whether the parent was told the deletion failed, so one
    filter can page on real data survival and another can merely ticket a
    stuck referral row.

    Ids and artifact kinds only. Exception text stays in the per-step lines
    above this one: it can quote table and bucket names, and an uploaded
    filename routinely carries the child's name.
    """
    detail = ' '.join(f'{name}={value}' for name, value in ids.items())
    print(f"DELETION_INCOMPLETE scope={scope} essential={'yes' if essential else 'no'} "
          f"{detail} survived={','.join(sorted(set(survived)))}")


def delete_child_documents(event: Dict) -> Dict:
    """
    Delete all IEP-related data for a specific child.
    This includes:
    1. S3 files (actual IEP documents)
    2. Records in IEP documents table
    3. IEP references in the user's profile

    Every step is essential here: each one leaves either the child's records
    or a profile pointing at documents that no longer exist. A step that fails
    is reported to the parent as a failure, not swallowed.

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
        try:
            owned_child = _owned_child(user_id, child_id)
        except AWS_FAULTS as e:
            return service_unavailable(event, 'delete_child_documents ownership check', e)
        if owned_child is None:
            print(f"Access denied: user {user_id} does not own child {child_id}")
            return not_found(event)

        # Delete all IEP-related data
        # Initialize clients
        s3 = _aws_client('s3')
        bucket_name = os.environ.get('BUCKET', '')
        survived: List[str] = []

        # Order: S3 objects first, then the rows that point at them, then
        # the profile reference. Every pointer outlives what it points at,
        # so a retry can still find whatever survived. Each step is
        # idempotent (a deleted object is simply not listed the second
        # time, DeleteItem succeeds on a row already gone, and the profile
        # update is a rewrite of the same list), so a retry after a
        # partial failure converges instead of compounding.

        # 1. First delete files from S3
        try:
            # Create the S3 key prefix for this child (all objects under userId/childId/)
            prefix = f"{user_id}/{child_id}/"

            print(f"Listing S3 objects with prefix: {prefix} in bucket: {bucket_name}")

            objects_deleted = _delete_prefix(s3, bucket_name, prefix)

            print(f"Deleted {objects_deleted} S3 objects for childId: {child_id}")

        except Exception as s3_error:
            print(f"Error deleting S3 objects: {str(s3_error)}")
            # Continue with the other steps: one stuck object must not
            # leave the rows and the profile reference behind too.
            survived.append('raw-uploads')

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
                        # Keep the row. contentS3Reference is the only
                        # pointer to what survived, so dropping it here
                        # would strand the summary and the audio where
                        # only an ops sweep could reach them, and a retry
                        # would report a clean deletion over the top.
                        survived.extend(['derived-artifacts', 'document-rows'])
                        continue

                    # Check for document_index field before deletion
                    if 'document_index' in doc:
                        print(f"Deleting document with document_index field: {doc['iepId']}")

                    try:
                        iep_documents_table.delete_item(
                            Key={
                                'iepId': doc['iepId'],
                                'childId': doc['childId']
                            }
                        )
                    except Exception as row_error:
                        print(f"Error deleting IEP document record {doc.get('iepId')}: {str(row_error)}")
                        survived.append('document-rows')
                        continue

                    print(f"Deleted IEP document record with iepId: {doc['iepId']} for childId: {child_id}")
                    documents_deleted += 1

            print(f"Deleted {documents_deleted} IEP document records for childId: {child_id}")

        except Exception as ddb_error:
            print(f"Error deleting document records: {str(ddb_error)}")
            survived.append('document-rows')

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
            # Left behind: a child still pointing at documents that are gone.
            survived.append('profile-reference')

        if survived:
            _report_deletion_incomplete('child-documents', survived, True,
                                        user=user_id, child=child_id)
            return create_response(event, 500, {
                'message': 'Could not delete the documents. Please try again later.',
                'childId': child_id
            })

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

    Anything that survives an essential step makes this an error response, not
    a 200 with the truth buried in deletionSummary. See the classification
    above _report_deletion_incomplete for which steps are which.

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
        # What is still in place when we answer. `survived` is essential and
        # makes the response an error; `best_effort_survived` is named in the
        # marker but does not, per the classification above.
        survived: List[str] = []
        best_effort_survived: List[str] = []

        # Hoisted: step 2 purges S3 artifacts too, so these must exist even if
        # the raw-upload sweep below raises.
        s3 = _aws_client('s3')
        bucket_name = os.environ.get('BUCKET', '')

        # The five steps run data first and credentials last, and every step
        # runs even when an earlier one failed: one stuck object must not leave
        # the rest of the account behind too. The order is what makes a retry
        # converge. Each pointer outlives what it points at (the row over its
        # artifacts, the profile over the documents, the login over all of it),
        # so whatever survived is still reachable on the next attempt, and
        # every step is idempotent.

        # 1. Delete the user's raw uploads (originals live under userId/).
        #    Derived artifacts are NOT under this prefix; step 2 handles those.
        try:
            # Create the S3 key prefix for this user (all objects under userId/)
            prefix = f"{user_id}/"

            print(f"Listing S3 objects with prefix: {prefix} in bucket: {bucket_name}")

            result['s3ObjectsDeleted'] += _delete_prefix(s3, bucket_name, prefix)

            print(f"Deleted {result['s3ObjectsDeleted']} S3 objects for userId: {user_id}")

        except Exception as s3_error:
            print(f"Error deleting S3 objects: {str(s3_error)}")
            # Continue with other deletions even if S3 deletion fails
            survived.append('raw-uploads')

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
                    # Keep the row: it is the only pointer to what survived,
                    # and the next attempt needs it to find those artifacts
                    # again. Deleting it here would turn a retryable partial
                    # failure into a permanent orphan reported as success.
                    survived.extend(['derived-artifacts', 'document-rows'])
                    continue

                try:
                    iep_documents_table.delete_item(
                        Key={
                            'iepId': doc['iepId'],
                            'childId': doc['childId']
                        }
                    )
                except Exception as row_error:
                    print(f"Error deleting IEP document record {doc.get('iepId')}: {str(row_error)}")
                    survived.append('document-rows')
                    continue

                print(f"Deleted IEP document record with iepId: {doc['iepId']}")
                result['documentsDeleted'] += 1

            print(f"Deleted {result['documentsDeleted']} IEP document records for userId: {user_id}")

        except Exception as ddb_error:
            print(f"Error deleting document records: {str(ddb_error)}")
            # Continue with profile deletion even if document deletion fails
            survived.append('document-rows')

        # 3. Remove their referral footprint. Before the profile goes, because
        #    a failure here should still leave the account recoverable-looking
        #    rather than half-deleted with no profile to explain it.
        try:
            result['referrals'] = _purge_referral_data(user_id)
        except Exception as referral_error:
            print(f"Error purging referral data: {str(referral_error)}")
            # Continue: a stuck referral row must not block account deletion.
            # Best-effort by classification: a link code and a userId reference
            # carry no document content, and the parent has nothing to retry.
            best_effort_survived.append('referrals')

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
            survived.append('profile')

        # 5. Delete the Cognito user account, last and only if the records are
        #    actually gone. The login is the parent's only way back in, so
        #    deleting it while their child's documents survive would strand
        #    those documents where nothing they can do reaches them: no token,
        #    no retry, an ops script or nothing. Leaving the account alive
        #    costs them one more tap on Delete and converges.
        if survived:
            print('Keeping the Cognito account: data survived and the login is '
                  'the only way to retry')
            survived.append('cognito-account')
        else:
            # Built outside the try: the except clause below names an
            # exception class off this client, and evaluating that clause with
            # `cognito` unbound would raise NameError over the real error.
            cognito = _aws_client('cognito-idp')
            try:
                user_pool_id = os.environ.get('USER_POOL_ID', '')

                # Delete the user from Cognito User Pool
                cognito.admin_delete_user(
                    UserPoolId=user_pool_id,
                    Username=user_id
                )
                result['cognitoUserDeleted'] = True
                print(f"Deleted Cognito user for userId: {user_id}")

            except cognito.exceptions.UserNotFoundException:
                # Already gone. A retry after a partial deletion must converge,
                # not report a failure for work an earlier attempt finished.
                result['cognitoUserDeleted'] = True
                print(f"Cognito user already absent for userId: {user_id}")

            except Exception as cognito_error:
                print(f"Error deleting Cognito user: {str(cognito_error)}")
                # The account still exists, so the deletion did not happen. It
                # was reported as success for as long as this was swallowed.
                survived.append('cognito-account')

        if survived or best_effort_survived:
            # The marker names everything that survived so an alarm sees the
            # whole picture; only the essential kinds set the status code.
            _report_deletion_incomplete('account', survived + best_effort_survived,
                                        bool(survived), user=user_id)

        if survived:
            return create_response(event, 500, {
                'message': 'Could not delete your account. Please try again later.',
                'userId': user_id,
                'deletionSummary': result
            })

        # Return success response with deletion summary
        return create_response(event, 200, {
            'message': 'User profile and all associated data successfully deleted',
            'userId': user_id,
            'deletionSummary': result
        })

    except Exception as e:
        print(f"Error in delete_user_profile: {str(e)}")
        return create_response(event, 500, {'message': 'Could not delete your account. Please try again later.'})

def _build_router() -> Router:
    """The route table, from the @route-decorated methods of UserProfileRouter."""
    router = Router()
    profile_router = UserProfileRouter()
    for attr_name in dir(profile_router):
        attr = getattr(profile_router, attr_name)
        if hasattr(attr, 'path') and hasattr(attr, 'method'):
            router.add_route(attr.path, attr.method, attr)
    return router


# Built at import, not per request: the table never changes.
_router = _build_router()


def lambda_handler(event: Dict, context) -> Dict:
    """
    Main Lambda handler function that routes requests to appropriate handlers using the router.

    Writes one log line per request: method, route template and status. Never
    the event (a bearer token, JWT claims and the body's PII travel in it) and
    never the raw path (it carries a child's id).

    Args:
        event (Dict): API Gateway event object
        context: Lambda context object

    Returns:
        Dict: API Gateway response
    """
    method = path = None
    route_template = '<unrouted>'
    try:
        method = event['requestContext']['http']['method']

        # Handle OPTIONS request for CORS
        if method == 'OPTIONS':
            return handle_options(event)

        path = event['rawPath']
        route_template, handler, path_params = _router.resolve(path, method)

        # Update path parameters
        if not event.get('pathParameters'):
            event['pathParameters'] = {}
        event['pathParameters'].update(path_params)

        response = handler(event)
        print(f"{method} {route_template} -> {response['statusCode']}")
        return response

    except RouteNotFoundException as e:
        print(f"{method} {route_template} -> 404 (no route)")
        return not_found(event)
    except Exception as e:
        print(f"{method} {route_template} -> 500 unhandled {type(e).__name__}: {str(e)}")
        import traceback
        print(f"Traceback: {traceback.format_exc()}")
        return create_response(event, 500, {'message': 'Internal server error. Please try again later.'})
