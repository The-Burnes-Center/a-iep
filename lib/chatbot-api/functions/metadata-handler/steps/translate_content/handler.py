"""
Minimal translation handler for both parsing results and missing info
"""
import json
import os
import boto3
import traceback
from translation_agent import OptimizedTranslationAgent

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
        
        # Get the document with content (handles S3 storage and lazy migration)
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
            if content_type == 'meeting_notes':
                print("Document not found, skipping translation")
                event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
                return {
                    **event_copy,
                    'meeting_notes_translations': {},
                    f'{content_type}_translation_skipped': True
                }
            else:
                raise Exception("Empty response from DDB service")
        
        try:
            source_ddb_result = json.loads(source_payload_response)
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse DDB service response as JSON: {e}")
        
        if source_ddb_result.get('statusCode') != 200:
            if content_type == 'meeting_notes':
                print("Document not found, skipping translation")
                event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
                return {
                    **event_copy,
                    'meeting_notes_translations': {},
                    f'{content_type}_translation_skipped': True
                }
            else:
                raise Exception(f"Failed to get document from DDB: {source_ddb_result}")
        
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
            
        elif content_type == 'meeting_notes':
            # Get English meeting notes from API fields: meetingNotes.en
            meeting_notes_raw = document.get('meetingNotes')
            
            # Debug logging
            print(f"meetingNotes type: {type(meeting_notes_raw)}")
            print(f"meetingNotes keys: {list(meeting_notes_raw.keys()) if isinstance(meeting_notes_raw, dict) else 'not-a-dict'}")
            
            # Handle different data types
            source_result = None
            if meeting_notes_raw is None:
                meeting_notes = {}
            elif isinstance(meeting_notes_raw, dict):
                meeting_notes = meeting_notes_raw
            elif isinstance(meeting_notes_raw, str):
                # If it's a string, treat it as English content
                print("meetingNotes is a string, treating as English content")
                source_result = {
                    'meeting_notes': meeting_notes_raw
                }
            else:
                print(f"Unexpected meetingNotes type: {type(meeting_notes_raw)}, defaulting to empty dict")
                meeting_notes = {}
            
            # If we haven't set source_result yet (dict case), check for English content
            if source_result is None:
                # Check for English meeting notes in dict structure
                if not isinstance(meeting_notes, dict) or 'en' not in meeting_notes or not meeting_notes.get('en'):
                    print(f"English meeting notes not found. meetingNotes keys: {list(meeting_notes.keys()) if isinstance(meeting_notes, dict) else type(meeting_notes).__name__}")
                    print(f"meetingNotes is dict: {isinstance(meeting_notes, dict)}")
                    if isinstance(meeting_notes, dict):
                        print(f"meetingNotes keys: {list(meeting_notes.keys())}")
                        print(f"meetingNotes['en'] present: {'en' in meeting_notes}, length: {len(meeting_notes.get('en') or '')}")
                    event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
                    return {
                        **event_copy,
                        'meeting_notes_translations': {},
                        f'{content_type}_translation_skipped': True
                    }
                
                # Reconstruct the format expected by translation agent (simple string)
                source_result = {
                    'meeting_notes': meeting_notes.get('en', '')
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
            raise Exception(f"Failed to get existing content: {get_content_result}")
        
        existing_doc = json.loads(get_content_result['body'])
        
        # Build content structure with existing data and new translations
        content = {
            'summaries': existing_doc.get('summaries', {}),
            'sections': existing_doc.get('sections', {}),
            'document_index': existing_doc.get('document_index', {}),
            'abbreviations': existing_doc.get('abbreviations', {}),
            'meetingNotes': existing_doc.get('meetingNotes', {})
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
        
        elif content_type == 'meeting_notes':
            for lang, translated_content in translations.items():
                # Handle meeting notes structure (should be simple string)
                if isinstance(translated_content, dict) and 'meeting_notes' in translated_content:
                    content['meetingNotes'][lang] = translated_content['meeting_notes']
                elif isinstance(translated_content, str):
                    content['meetingNotes'][lang] = translated_content
                else:
                    content['meetingNotes'][lang] = ''
        
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
        elif content_type == 'meeting_notes':
            result_key = 'meeting_notes_translations'
        else:
            result_key = f'{content_type}_translations'
        
        # Return result
        event_copy = {k: v for k, v in event.items() if k not in ['progress', 'current_step']}
        return {
            **event_copy,
            result_key: translations,
            f'{content_type}_translation_completed': True,
            'languages_processed': list(translations.keys())
        }
        
    except Exception as e:
        print(f"TranslateContent error: {str(e)}")
        print(traceback.format_exc())
        raise
