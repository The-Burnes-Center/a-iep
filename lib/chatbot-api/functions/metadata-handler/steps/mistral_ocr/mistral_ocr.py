import os
import boto3
import logging
import requests
import json
import urllib.parse
from datetime import datetime, timedelta

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# requests has no default timeout: an unresponsive Mistral endpoint hangs the
# call indefinitely (see requests docs, "Advanced Usage > Timeouts"). Those
# same docs recommend a (connect, read) tuple over a single scalar, because
# the two phases mean different things here: CONNECT is the TCP/TLS handshake
# to a known, presumably-healthy API host, so a few seconds is generous; READ
# is the gap between bytes once connected, which for the OCR call is however
# long Mistral spends actually processing the document. Each budget below
# stays well under MistralOCRFunction's own 600s Lambda timeout (functions.ts)
# so a hung provider is caught and reported by this code -- a clean
# {"error": ...} the state machine can retry -- before Lambda's runtime kills
# the invocation outright with no such shape.
CONNECT_TIMEOUT_SECONDS = 10
UPLOAD_READ_TIMEOUT_SECONDS = 60
METADATA_READ_TIMEOUT_SECONDS = 30
OCR_READ_TIMEOUT_SECONDS = 300

# Global cache for API key (reused across Lambda invocations)
_cached_mistral_api_key = None

# Mistral takes the uploaded file's type from the multipart part below, not by
# sniffing the bytes, so this has to match what the parent actually picked. It
# was hardcoded to 'application/pdf', while the uploader offers .doc and .docx
# too (UploadIEPDocument.tsx's fileExtensions), which made every Word upload a
# guaranteed permanent failure: Mistral answers 422, and handler.py -- correctly
# -- treats a non-429 4xx as "this file will never be accepted" and retries it
# zero times. One such .doc is the 422 in scripts/audit-residue.py's docblock.
#
# Word is not a format Mistral has to be talked into: its Document AI OCR FAQ
# ("What document types are supported?") lists Word Documents (.docx, .doc)
# next to PDF. Only the declared type was wrong.
#
# Keyed by extension rather than guessed with mimetypes.guess_type, whose table
# is assembled partly from the host's /etc/mime.types and so is not the same on
# a developer's Mac as in the Lambda image. These three are the ones the
# uploader offers, spelled exactly as its own mimeTypes map spells them.
_CONTENT_TYPE_BY_EXTENSION = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

# For an extension the uploader does not offer, which should be unreachable.
# Deliberately not 'application/pdf': declaring a type the bytes are not is the
# entire defect above, and a generic "some bytes" at least says nothing false.
_DEFAULT_CONTENT_TYPE = 'application/octet-stream'


def _content_type_for(filename):
    """The MIME type to declare for `filename` when posting it to Mistral."""
    _stem, _dot, extension = str(filename).rpartition('.')
    return _CONTENT_TYPE_BY_EXTENSION.get(f'.{extension}'.lower(), _DEFAULT_CONTENT_TYPE)


def _http_status_code(exc):
    """The provider's HTTP status code, if this exception carries one.

    Only requests.exceptions.HTTPError -- raised by Response.raise_for_status()
    -- carries a response object. A connection error or a timeout never got a
    response at all, and correctly reports None here, which handler.py treats
    as transient (see OcrClientError there): those failures say nothing about
    whether the FILE is acceptable, only that this attempt did not complete.
    """
    response = getattr(exc, 'response', None)
    return getattr(response, 'status_code', None) if response is not None else None


def _safe_key(key):
    """An S3 key (or filename) with the parent-chosen name removed.

    Mirrors metadata-handler/orchestrator.py's helper of the same name: the
    key is userId/childId/iepId/filename, and parents routinely name an IEP
    after their child, so only the ids in front of the last path segment are
    safe to log.
    """
    if not isinstance(key, str):
        return '<no key>'
    head, sep, _filename = key.rpartition('/')
    return f'{head}/...' if sep else '...'

def get_mistral_api_key():
    """
    Retrieves the Mistral API key with caching for performance.
    First checks environment variables, then falls back to SSM Parameter Store.
    Returns:
        str: The Mistral API key.
    """
    global _cached_mistral_api_key
    
    # Return cached key if available
    if _cached_mistral_api_key:
        logger.info("Using cached MISTRAL_API_KEY")
        return _cached_mistral_api_key
    
    # First try direct environment variable (for backwards compatibility)
    mistral_api_key = os.environ.get('MISTRAL_API_KEY')
    
    if mistral_api_key and not mistral_api_key.startswith('AQICA'):
        logger.info(f"MISTRAL_API_KEY found in environment (length: {len(mistral_api_key)})")
        _cached_mistral_api_key = mistral_api_key
        return mistral_api_key
    
    # Fetch from SSM Parameter Store with decryption
    param_name = os.environ.get('MISTRAL_API_KEY_PARAMETER_NAME')
    if param_name:
        try:
            logger.info(f"Fetching MISTRAL_API_KEY from SSM: {param_name}")
            ssm = boto3.client('ssm')
            response = ssm.get_parameter(Name=param_name, WithDecryption=True)
            mistral_api_key = response['Parameter']['Value']
            
            # Cache for future invocations
            _cached_mistral_api_key = mistral_api_key
            logger.info(f"Successfully retrieved and cached MISTRAL_API_KEY from SSM (length: {len(mistral_api_key)})")
            return mistral_api_key
            
        except Exception as e:
            logger.error(f"Error retrieving MISTRAL_API_KEY from SSM: {str(e)}")
    
    logger.error("MISTRAL_API_KEY not available from environment or SSM")
    return None

def process_document_with_mistral_ocr(bucket, key):
    """
    Process a document from S3 using Mistral's OCR API.
    
    Args:
        bucket (str): S3 bucket name
        key (str): S3 object key for the document
        
    Returns:
        dict: OCR processing results from Mistral
    """
    api_key = get_mistral_api_key()
    if not api_key:
        logger.error("Mistral API key not available, cannot process document")
        return {"error": "Mistral API key not available"}
    
    # Ensure the key is properly URL decoded
    try:
        # The key might already be decoded from the lambda_function.py
        # Let's make sure it's encoded properly for S3 access
        decoded_key = urllib.parse.unquote_plus(key)
        
        # Check if the key and decoded key are different
        if key != decoded_key:
            logger.info(f"Key was URL encoded. Original: {_safe_key(key)}, Decoded: {_safe_key(decoded_key)}")
            key = decoded_key

        logger.info(f"Downloading document from S3: s3://{bucket}/{_safe_key(key)}")
        s3_client = boto3.client('s3')
        
        # Try with the key as is
        try:
            response = s3_client.get_object(Bucket=bucket, Key=key)
            file_content = response['Body'].read()
        except s3_client.exceptions.NoSuchKey:
            # If original key fails, try with the encoded version
            logger.info(f"Key not found, trying with URL encoded version")
            encoded_key = urllib.parse.quote_plus(key)
            logger.info(f"Trying encoded key: {encoded_key}")
            try:
                response = s3_client.get_object(Bucket=bucket, Key=encoded_key)
                file_content = response['Body'].read()
                # If this works, update the key for later use
                key = encoded_key
            except s3_client.exceptions.NoSuchKey:
                # If that fails too, try with just the filename
                logger.info(f"Encoded key not found, trying just with filename")
                filename = key.split('/')[-1]
                try:
                    response = s3_client.get_object(Bucket=bucket, Key=filename)
                    file_content = response['Body'].read()
                    # If this works, update the key for later use
                    key = filename
                except:
                    # If all attempts fail, raise the original error
                    raise
        
        # Get the file name from the key
        filename = key.split('/')[-1]
        logger.info(f"Successfully downloaded file ({len(file_content)} bytes)")
    except Exception as e:
        logger.error(f"Error downloading file from S3: {str(e)}")
        return {"error": f"Error downloading file from S3: {str(e)}"}
    
    # Set up headers for Mistral API requests
    headers = {
        "Authorization": f"Bearer {api_key}"
    }
    
    # Step 1: Upload the file to Mistral
    try:
        # The declared type, not the filename: the filename is the parent's own
        # and can carry a child's name (see _safe_key). A value from the fixed
        # map above is safe to log and is the first thing to check when Mistral
        # rejects a file, since a mismatch here is a permanent, unretried 422.
        content_type = _content_type_for(filename)
        logger.info(f"Uploading file to Mistral as {content_type}")

        upload_url = "https://api.mistral.ai/v1/files"
        files = {
            'file': (filename, file_content, content_type)
        }
        data = {
            'purpose': 'ocr'
        }

        upload_response = requests.post(
            upload_url,
            headers=headers,
            files=files,
            data=data,
            timeout=(CONNECT_TIMEOUT_SECONDS, UPLOAD_READ_TIMEOUT_SECONDS)
        )
        upload_response.raise_for_status()
        upload_result = upload_response.json()
        
        file_id = upload_result.get('id')
        if not file_id:
            logger.error(f"File upload failed: {upload_result}")
            return {"error": "Failed to get file ID from upload response"}
        
        logger.info(f"File successfully uploaded to Mistral with ID: {file_id}")
    except Exception as e:
        logger.error(f"Error uploading file to Mistral: {str(e)}")
        return {"error": f"Error uploading file to Mistral: {str(e)}", "status_code": _http_status_code(e)}
    
    # Step 2: Get a signed URL for the uploaded file
    try:
        logger.info(f"Getting signed URL for file ID: {file_id}")
        
        signed_url_endpoint = f"https://api.mistral.ai/v1/files/{file_id}/url"
        params = {
            'expiry': 24  # URL expiry in hours
        }
        
        signed_url_response = requests.get(
            signed_url_endpoint,
            headers=headers,
            params=params,
            timeout=(CONNECT_TIMEOUT_SECONDS, METADATA_READ_TIMEOUT_SECONDS)
        )
        signed_url_response.raise_for_status()
        signed_url_result = signed_url_response.json()
        
        signed_url = signed_url_result.get('url')
        if not signed_url:
            logger.error(f"Failed to get signed URL: {signed_url_result}")
            return {"error": "Failed to get signed URL from response"}
        
        logger.info(f"Successfully obtained signed URL for file ID: {file_id}")
    except Exception as e:
        logger.error(f"Error getting signed URL from Mistral: {str(e)}")
        return {"error": f"Error getting signed URL from Mistral: {str(e)}", "status_code": _http_status_code(e)}
    
    # Step 3: Process the document with Mistral OCR API using the signed URL
    try:
        logger.info(f"Processing document with Mistral OCR API using signed URL")
        
        ocr_endpoint = "https://api.mistral.ai/v1/ocr"
        ocr_headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        
        # Create request payload for Mistral OCR API
        ocr_payload = {
            "model": "mistral-ocr-latest",
            "document": {
                "type": "document_url",
                "document_url": signed_url
            },
            "include_image_base64": False  # Set to true if you need images
        }
        
        ocr_response = requests.post(
            ocr_endpoint,
            headers=ocr_headers,
            json=ocr_payload,
            timeout=(CONNECT_TIMEOUT_SECONDS, OCR_READ_TIMEOUT_SECONDS)
        )
        
        ocr_response.raise_for_status()
        ocr_result = ocr_response.json()
        
        logger.info(f"Successfully processed document with Mistral OCR API")
        return ocr_result
    except Exception as e:
        logger.error(f"Error calling Mistral OCR API: {str(e)}")
        return {"error": str(e), "status_code": _http_status_code(e)}

