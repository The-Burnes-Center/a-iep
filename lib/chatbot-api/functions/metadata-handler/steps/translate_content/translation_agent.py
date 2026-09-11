"""
Optimized Translation Agent for New Pipeline
Combines the power of the old pipeline's agents with new pipeline efficiency
"""
import logging
import json
from pydantic import ValidationError
from agents import Agent, Runner, function_tool, ModelSettings
from config import get_language_context
from data_model import TranslationSectionContent, AbbreviationLegend

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _safe_error_summary(e):
    """Content-free triage string for an exception raised while validating a
    translated section or abbreviation.

    str(e) on a pydantic ValidationError quotes `input_value` for every
    failing field (truncated to ~50 chars, not removed), and here that value
    is translated document text -- the very thing CLAUDE.md says must never
    reach a log. `.errors()` carries the same triage signal (field path +
    error type) without the `input` key each entry also carries. Every other
    exception here is reduced to its class name only.
    """
    if isinstance(e, ValidationError):
        locations = [err.get('loc') for err in e.errors()]
        return f"{type(e).__name__}: {e.error_count()} error(s) at {locations}"
    return type(e).__name__

class OptimizedTranslationAgent:
    def __init__(self):
        """
        Initialize optimized translation agent for new pipeline.
        Designed for single-language, high-performance translation.
        """
        self.language_context_tool = self._create_language_context_tool()
        self.terminology_tool = self._create_terminology_tool()

    def _create_language_context_tool(self):
        """Create tool to get language-specific translation context"""
        @function_tool()
        def get_language_context_for_translation(target_language: str) -> str:
            """Get comprehensive translation guidelines for target language"""
            return get_language_context(target_language)
        return get_language_context_for_translation

    def _create_terminology_tool(self):
        """Create tool to access IEP-specific terminology translations"""
        @function_tool()
        def get_iep_terminology(term: str, target_language: str) -> str:
            """Get IEP-specific terminology translation"""
            try:
                if target_language == 'es':
                    # Load Spanish translations
                    with open('en_es_translations.json', 'r', encoding='utf-8-sig') as f:
                        translations = json.load(f)
                    return translations.get(term.lower(), f"No translation found for '{term}'")
                elif target_language == 'vi':
                    # Load Vietnamese translations
                    with open('en_vi_translations.json', 'r', encoding='utf-8-sig') as f:
                        translations = json.load(f)
                    return translations.get(term.lower(), f"No translation found for '{term}'")
                elif target_language == 'zh':
                    # Load Chinese translations
                    with open('en_zh_translations.json', 'r', encoding='utf-8-sig') as f:
                        translations = json.load(f)
                    return translations.get(term.lower(), f"No translation found for '{term}'")
                elif target_language == 'ar':
                    # Load Arabic translations
                    with open('en_ar_translations.json', 'r', encoding='utf-8-sig') as f:
                        translations = json.load(f)
                    return translations.get(term.lower(), f"No translation found for '{term}'")
                else:
                    return f"Terminology lookup not available for {target_language}"
            except:
                return f"Could not access terminology for {term}"
        return get_iep_terminology

    def translate_content_with_agent(self, content, target_language, content_type="parsing_result", model="gpt-4.1"):
        """
        High-performance single-language translation using agent framework.
        Optimized for new pipeline's distributed architecture.
        """
        try:
            # Create optimized translation prompt
            system_prompt = self._get_optimized_prompt(target_language, content_type)
            
            # Create specialized translation agent
            translation_agent = Agent(
                name=f"IEP Translator ({target_language.upper()})",
                model=model,
                instructions=system_prompt,
                tools=[
                    self.language_context_tool,
                    self.terminology_tool
                ],
                model_settings=ModelSettings(
                    parallel_tool_calls=True,
                )
            )

            # Prepare translation request
            content_json = json.dumps(content, indent=2)
            translation_request = f"Translate this {content_type} content to {target_language}:\n\n{content_json}"
            
            # Execute translation with optimized settings
            result = Runner.run_sync(
                translation_agent,
                translation_request,
                max_turns=10  # Reduced from 50 for efficiency
            )
            
            # Parse and validate result
            translated_content = self._parse_translation_result(result.final_output, content_type)
            
            logger.info(f"Successfully translated {content_type} to {target_language}")
            return translated_content
            
        except Exception as e:
            # _safe_error_summary, like every other except in this file. These
            # two were missed when it was introduced. The returned dict matters
            # as much as the log line: callers surface it, and it reaches the
            # document row as error_message, so a raw str(e) here persists
            # translated document text rather than merely printing it.
            logger.error(f"Agent-based translation failed: {_safe_error_summary(e)}")
            return {"error": f"Translation failed: {_safe_error_summary(e)}"}

    def _get_optimized_prompt(self, target_language, content_type):
        """Generate optimized prompt for single-language translation"""
        language_context = get_language_context(target_language)
        
        # Content-specific guidance
        content_description = "IEP document content including summaries, sections, document index, and abbreviations"
        tone_guidance = """
- Use warm, supportive tone appropriate for parents reading about their child's IEP
- For abbreviations: translate full forms, keep abbreviation codes in English
- Maintain educational accuracy while being parent-friendly
- Use simple language while preserving legal/educational meaning"""
        output_format = "Structured JSON with summaries, sections, document_index, and abbreviations"

        return f'''
You are an expert IEP translator using advanced tools for accuracy and consistency.

TRANSLATION TASK:
Translate English {content_description} to {target_language} while preserving JSON structure.

TOOLS AVAILABLE:
1. get_language_context_for_translation() - Get comprehensive guidelines for target language
2. get_iep_terminology() - Look up specific IEP term translations

WORKFLOW:
1. FIRST: Call get_language_context_for_translation("{target_language}") to get language guidelines
2. For any IEP-specific terms, use get_iep_terminology(term, "{target_language}")
3. Apply language guidelines consistently throughout translation
4. Maintain exact JSON structure and field names

QUALITY GUIDELINES:
{tone_guidance}

TECHNICAL REQUIREMENTS:
- Do NOT translate JSON keys, field names, or section titles
- Maintain exact data structure and hierarchy
- Preserve page numbers, dates, IDs unchanged
- Keep structural elements (arrays, objects) in same format
- Output ONLY valid JSON

OUTPUT FORMAT: {output_format}

LANGUAGE CONTEXT: {language_context}

Remember: Use tools to ensure translation accuracy and consistency!
        '''

    def _parse_translation_result(self, raw_output, content_type):
        """Parse and validate agent translation result"""
        try:
            if isinstance(raw_output, str):
                # Clean JSON formatting
                cleaned = raw_output.replace('```json', '').replace('```', '').strip()
                translated_content = json.loads(cleaned)
            elif isinstance(raw_output, dict):
                translated_content = raw_output
            else:
                # Handle agent framework output types
                translated_content = raw_output.model_dump() if hasattr(raw_output, 'model_dump') else dict(raw_output)
            
            # Validate based on content type
            if content_type == 'parsing_result':
                return self._validate_parsing_result(translated_content)
            else:
                return translated_content
                
        except json.JSONDecodeError as e:
            summary = _safe_error_summary(e)
            logger.error(f"Failed to parse agent translation: {summary}")
            return {"error": f"Translation parsing failed: {summary}"}
        except Exception as e:
            summary = _safe_error_summary(e)
            logger.error(f"Translation validation error: {summary}")
            return {"error": f"Translation validation failed: {summary}"}

    def _validate_parsing_result(self, content):
        """Validate parsing result translation structure"""
        try:
            # Validate sections if present
            if 'sections' in content and isinstance(content['sections'], list):
                validated_sections = []
                for section in content['sections']:
                    try:
                        validated_section = TranslationSectionContent.model_validate(section)
                        validated_sections.append(validated_section.model_dump())
                    except Exception as e:
                        logger.warning(f"Section validation failed: {_safe_error_summary(e)}")
                        validated_sections.append(section)
                content['sections'] = validated_sections
            
            # Validate abbreviations if present
            if 'abbreviations' in content and isinstance(content['abbreviations'], list):
                validated_abbreviations = []
                for abbrev in content['abbreviations']:
                    try:
                        validated_abbrev = AbbreviationLegend.model_validate(abbrev)
                        validated_abbreviations.append(validated_abbrev.model_dump())
                    except Exception as e:
                        logger.warning(f"Abbreviation validation failed: {_safe_error_summary(e)}")
                        validated_abbreviations.append(abbrev)
                content['abbreviations'] = validated_abbreviations

            logger.info("Parsing result translation validation completed")
            return content

        except Exception as e:
            logger.warning(f"Validation failed, returning original content: {_safe_error_summary(e)}")
            return content
