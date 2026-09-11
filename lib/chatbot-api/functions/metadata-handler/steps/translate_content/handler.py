"""
Minimal translation handler for both parsing results and missing info
"""
import json
import os
import boto3
import traceback
from translation_agent import OptimizedTranslationAgent, _safe_error_summary
from student_token import count_tokens, verify_token_survived

# Only non-sensitive metadata is safe to log. These events can carry
# FERPA-protected document content (OCR text, parsed sections, translated
# content) as the workflow evolves; dumping the whole event would expose it
# to anyone with CloudWatch log access.
# s3_key is deliberately NOT in this allowlist: the key is
# userId/childId/iepId/<filename>, and parents routinely name an IEP after
# their child, so the filename is student data. It is logged separately below
# with the filename stripped (see _safe_key).
_SAFE_LOG_FIELDS = (
    'iep_id', 'child_id', 'user_id', 's3_bucket', 'current_step',
    'progress', 'status', 'content_type', 'target_languages', 'translation_needed',
)


def _safe_key(key):
    """An S3 key with the parent-chosen filename removed.

    The key is userId/childId/iepId/filename, and only the last segment is
    typed by a human. Mirrors metadata-handler/orchestrator.py's helper of the
    same name.
    """
    if not isinstance(key, str):
        return '<no key>'
    head, sep, _filename = key.rpartition('/')
    return f'{head}/...' if sep else '...'


def _safe_event_meta(event):
    """Return only the allowlisted, non-sensitive fields from the event."""
    if not isinstance(event, dict):
        return {'_type': type(event).__name__}
    meta = {k: event[k] for k in _SAFE_LOG_FIELDS if k in event}
    if 's3_key' in event:
        meta['s3_key'] = _safe_key(event['s3_key'])
    return meta


def lambda_handler(event, context):
    """
    Unified translation handler that can translate both parsing results and missing info.
    
    Expected event parameters:
    - content_type: 'parsing_result' or 'missing_info'
    - target_languages: list of language codes
    - Other standard parameters (iep_id, user_id, child_id)
    """
    print(f"TranslateContent handler received: {json.dumps(_safe_event_meta(event))}")
    
    try:
        iep_id = event['iep_id']
        user_id = event['user_id'] 
        child_id = event['child_id']
        target_languages = event['target_languages']
        content_type = event.get('content_type', 'parsing_result')

        if not target_languages:
            print("No target languages provided, skipping translation")
            event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
            return {
                **event_copy,
                f'{content_type}_translations': {},
                'translation_skipped': True
            }
        
        print(f"Translating {content_type} to languages: {target_languages}")
        
        # Get source data from DynamoDB/S3 - use get_document_with_content to handle S3 storage
        lambda_client = boto3.client('lambda')
        ddb_service_name = os.environ.get('DDB_SERVICE_FUNCTION_NAME', 'DDBService')
        
        # Get the document with content (handles S3 storage and lazy migration).
        # Stored content refers to the child as {{S}} and keeps doing so, here
        # and on the on-demand add-a-language path: the name is substituted by
        # whichever lambda serves a read, so this step never sees it.
        source_payload = {
            'operation': 'get_document_with_content',
            'params': {
                'iep_id': iep_id,
                'user_id': user_id,
                'child_id': child_id
            }
        }
        
        source_response = lambda_client.invoke(
            FunctionName=ddb_service_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(source_payload)
        )
        
        source_payload_response = source_response['Payload'].read()
        
        if not source_payload_response:
            raise Exception("Empty response from DDB service")
        
        try:
            source_ddb_result = json.loads(source_payload_response)
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse DDB service response as JSON: {e}")
        
        if source_ddb_result.get('statusCode') != 200:
            # Same shape as the get_content_result check below: pull just the
            # error out of the body rather than interpolating the whole
            # ddb-service response, which for get_document_with_content is a
            # document read and can carry more than a status message.
            source_error_body = source_ddb_result.get('body', '')
            source_error_msg = source_error_body
            try:
                source_error_data = json.loads(source_error_body)
                source_error_msg = source_error_data.get('error', source_error_body)
            except:
                pass
            raise Exception(f"Failed to get document from DDB: {source_error_msg}")
        
        document = json.loads(source_ddb_result['body'])
        print(f"Retrieved document for {content_type} translation")
        print(f"Document keys: {list(document.keys())}")
        
        # Extract English content based on content type from new API field structure
        if content_type == 'parsing_result':
            # Get English content from API fields: summaries.en, sections.en, etc.
            summaries = document.get('summaries', {})
            sections = document.get('sections', {})
            document_index = document.get('document_index', {})
            abbreviations = document.get('abbreviations', {})
            
            print(f"Content structure - summaries keys: {list(summaries.keys()) if isinstance(summaries, dict) else 'not a dict'}, sections keys: {list(sections.keys()) if isinstance(sections, dict) else 'not a dict'}")
            
            if 'en' not in summaries or 'en' not in sections:
                print(f"Error: summaries.en exists: {'en' in summaries}, sections.en exists: {'en' in sections}")
                print(f"summaries keys: {list(summaries.keys()) if isinstance(summaries, dict) else type(summaries).__name__}")
                print(f"sections keys: {list(sections.keys()) if isinstance(sections, dict) else type(sections).__name__}")
                raise Exception("English parsing data not found - summaries.en or sections.en missing")
            
            # Reconstruct the format expected by translation agent
            source_result = {
                'summary': summaries.get('en', ''),
                'sections': sections.get('en', []),
                'document_index': document_index.get('en', ''),
                'abbreviations': abbreviations.get('en', [])
            }
        else:
            raise ValueError(f"Unsupported content_type: {content_type}")
        
        print(f"Extracted {content_type} English data for translation")
        
        # Create optimized agent for translation with SSM fallback
        api_key = os.environ.get('OPENAI_API_KEY')
        
        # If encrypted or missing, fetch from SSM
        if not api_key or api_key.startswith('AQICA'):
            param_name = os.environ.get('OPENAI_API_KEY_PARAMETER_NAME')
            if param_name:
                try:
                    ssm = boto3.client('ssm')
                    response = ssm.get_parameter(Name=param_name, WithDecryption=True)
                    api_key = response['Parameter']['Value']
                    # Cache in environment for future use
                    os.environ['OPENAI_API_KEY'] = api_key
                    print("Successfully retrieved OPENAI_API_KEY from SSM")
                except Exception as e:
                    print(f"Error retrieving OPENAI_API_KEY from SSM: {str(e)}")
                    raise Exception("Failed to retrieve OPENAI_API_KEY from SSM")
        
        if not api_key:
            raise Exception("OPENAI_API_KEY not available from environment or SSM")
        
        optimized_agent = OptimizedTranslationAgent()

        # Translate content to target languages using agent framework
        translations = {}

        # The child is referred to as {{S}} throughout the English content and
        # the real name is restored once, after this step. Count the
        # placeholders going in so each translation can be checked coming out.
        expected_student_tokens = count_tokens(source_result)
        print(f"Student placeholders in source content: {expected_student_tokens}")

        for lang in target_languages:
            print(f"Translating {content_type} to {lang} using optimized agent framework")
            
            # Use optimized agent-based translation for better quality and tool usage
            translated_content = optimized_agent.translate_content_with_agent(
                source_result, 
                lang, 
                content_type=content_type
            )
            
            if "error" in translated_content:
                print(f"Translation to {lang} failed: {translated_content['error']}")
                continue

            # Raises, so a run that lost the placeholder is never stored. Not
            # treated like the model error above (skip the language, carry on):
            # a skipped language is missing, which the state machine can see,
            # while a translation with the placeholder gone is a summary that
            # silently calls the child by no name or an invented one.
            verify_token_survived(expected_student_tokens, translated_content, lang)

            translations[lang] = translated_content
            print(f"Translation to {lang} completed successfully using optimized agent framework")
        
        print(f"{content_type} translation completed for {len(translations)} languages")
        
        # Get existing content (from S3 or DynamoDB) to merge translations
        get_content_payload = {
            'operation': 'get_document_with_content',
            'params': {
                'iep_id': iep_id,
                'child_id': child_id,
                'user_id': user_id
            }
        }
        
        get_content_response = lambda_client.invoke(
            FunctionName=ddb_service_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(get_content_payload)
        )
        
        get_content_payload_response = get_content_response['Payload'].read()
        
        if not get_content_payload_response:
            raise Exception("Empty response when getting existing content")
        
        get_content_result = json.loads(get_content_payload_response)

        if get_content_result.get('statusCode') != 200:
            # Mirror the save-path shape below: pull just the error out of the
            # body rather than interpolating the whole ddb-service response,
            # which for get_document_with_content is a document read and can
            # carry more than a status message.
            error_body = get_content_result.get('body', '')
            error_msg = error_body
            try:
                error_data = json.loads(error_body)
                error_msg = error_data.get('error', error_body)
            except:
                pass
            raise Exception(f"Failed to get existing content: {error_msg}")
        
        existing_doc = json.loads(get_content_result['body'])
        
        # Build content structure with existing data and new translations
        content = {
            'summaries': existing_doc.get('summaries', {}),
            'sections': existing_doc.get('sections', {}),
            'document_index': existing_doc.get('document_index', {}),
            'abbreviations': existing_doc.get('abbreviations', {})
        }
        
        # Merge new translations into content
        if content_type == 'parsing_result':
            for lang, translated_content in translations.items():
                # Update summaries
                if 'summary' in translated_content:
                    content['summaries'][lang] = translated_content['summary']
                
                # Update sections
                if 'sections' in translated_content:
                    content['sections'][lang] = translated_content['sections']
                
                # Update document_index
                if 'document_index' in translated_content:
                    content['document_index'][lang] = translated_content['document_index']
                
                # Update abbreviations
                if 'abbreviations' in translated_content:
                    content['abbreviations'][lang] = translated_content['abbreviations']
        
        # Save complete content to S3
        save_content_payload = {
            'operation': 'save_content_to_s3',
            'params': {
                'iep_id': iep_id,
                'child_id': child_id,
                'content': content
            }
        }
        
        save_content_response = lambda_client.invoke(
            FunctionName=ddb_service_name,
            InvocationType='RequestResponse',
            Payload=json.dumps(save_content_payload)
        )
        
        save_content_payload_response = save_content_response['Payload'].read()
        
        if not save_content_payload_response:
            raise Exception("Empty response when saving content to S3")
        
        save_content_result = json.loads(save_content_payload_response)
        
        if save_content_result.get('statusCode') != 200:
            error_body = save_content_result.get('body', '')
            error_msg = error_body
            try:
                error_data = json.loads(error_body)
                error_msg = error_data.get('error', error_body)
            except:
                pass
            raise Exception(f"Failed to save content to S3: {error_msg}")
        
        print(f"{content_type} translations saved successfully to S3")
        
        # Set the result key based on content type
        if content_type == 'parsing_result':
            result_key = 'parsing_translations'
        else:
            result_key = f'{content_type}_translations'
        
        # Return result. "completed" means at least one language actually came
        # back: every language can fail (each is caught and skipped above), and
        # claiming completion with an empty result is what let a document be
        # marked PROCESSED with the parent's language silently missing and no
        # failure recorded anywhere. VerifyLanguageProduced in the state
        # machine is the other half of this fix: it reads languages_processed
        # to fail the run when this is False.
        event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
        return {
            **event_copy,
            result_key: translations,
            f'{content_type}_translation_completed': bool(translations),
            'languages_processed': list(translations.keys())
        }
        
    except Exception as e:
        print(f"TranslateContent error: {_safe_error_summary(e)}")
        # NOT traceback.format_exc(): its last line renders str(e), which is
        # exactly what the summary above (the same helper translation_agent.py
        # uses for a pydantic ValidationError) was built to avoid.
        print(''.join(traceback.format_tb(e.__traceback__)))
        raise
