import os
import logging
import json
import traceback
from data_model import SingleLanguageIEP
from openai import OpenAI
from agents import Agent, Runner, function_tool, ModelSettings
from config import get_english_only_prompt, IEP_SECTIONS, SECTION_KEY_POINTS
from agents.exceptions import MaxTurnsExceeded
try:
    from agents.exceptions import ModelBehaviorError
except ImportError:
    # ModelBehaviorError might not exist in all versions
    ModelBehaviorError = Exception

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class OpenAIAgent:
    def __init__(self, ocr_data=None, api_key=None):
        """
        Initialize the OpenAIAgent with optional OCR data.
        Args:
            ocr_data (dict, optional): OCR data from Mistral OCR API
            api_key (str, optional): Pre-fetched OpenAI API key to avoid SSM calls
        """
        self.ocr_data = ocr_data
        self.api_key = api_key or self._get_openai_api_key()
        # Tools
        self.ocr_text_tool = self._create_ocr_text_tool()
        self.ocr_page_tool = self._create_ocr_page_tool()
        self.ocr_multiple_pages_tool = self._create_ocr_multiple_pages_tool()
        self.section_info_tool = self._create_section_info_tool()

    def _get_openai_api_key(self):
        """
        Retrieve the OpenAI API key from environment variable (direct access).
        Returns:
            str: The OpenAI API key.
        """
        key = os.environ.get('OPENAI_API_KEY')
        if not key:
            logger.error("OPENAI_API_KEY environment variable not set")
        return key

    # --- OCR retrieval tools ---
    # Pages are 1-based everywhere the model can see them: the "Page N:" labels
    # in get_all_ocr_text, the arguments these lookups take, and the
    # page_numbers the model emits into SectionContent. Those page numbers are
    # shown to parents so they can find the passage in their own copy of the
    # IEP, so the convention has to be the one a person counting pages would
    # use. Position in the pages list is the single source of truth: Mistral's
    # raw pages[].index is 0-based, and matching on it while labelling 1-based
    # handed the model the page after the one it asked for.
    def _page_count(self):
        return len((self.ocr_data or {}).get('pages') or [])

    def _get_page_markdown(self, page_number):
        """Markdown for a 1-based page number, or None if out of range."""
        pages = (self.ocr_data or {}).get('pages') or []
        if page_number < 1 or page_number > len(pages):
            return None
        return pages[page_number - 1].get('markdown', '')

    def _create_ocr_text_tool(self):
        @function_tool()
        def get_all_ocr_text() -> str:
            """Get the full OCR text of the document, one labelled block per
            page. Pages are numbered from 1: the first page of the document is
            "Page 1". Use those numbers with get_ocr_text_for_page and
            get_ocr_text_for_pages, and in the page_numbers you report."""
            if not self.ocr_data or 'pages' not in self.ocr_data:
                return None
            text_content = []
            for page_number, page in enumerate(self.ocr_data['pages'], 1):
                md = page.get('markdown')
                if md:
                    text_content.append(f"Page {page_number}:\n{md}")
            combined = "\n\n".join(text_content)
            return f"{combined}\n\nTotal pages: {len(self.ocr_data['pages'])}"
        return get_all_ocr_text

    def _create_ocr_page_tool(self):
        @function_tool()
        def get_ocr_text_for_page(page_number: int) -> str:
            """Get the OCR text of a single page. page_number is 1-based: pass
            1 for the first page of the document, matching the "Page N:" labels
            get_all_ocr_text prints."""
            if not self.ocr_data or 'pages' not in self.ocr_data:
                return "ERROR: No OCR data"
            markdown = self._get_page_markdown(page_number)
            if markdown is None:
                logger.warning(f"Page {page_number} requested but document has {self._page_count()} pages")
                return f"ERROR: Page {page_number} not found. This document has {self._page_count()} pages, numbered 1 to {self._page_count()}"
            return markdown
        return get_ocr_text_for_page

    def _create_ocr_multiple_pages_tool(self):
        @function_tool()
        def get_ocr_text_for_pages(page_numbers: list[int]) -> str:
            """Get the OCR text of several pages, returned in the order asked
            for and labelled "Page N:". Page numbers are 1-based: pass 1 for the
            first page of the document, matching the labels get_all_ocr_text
            prints."""
            if not self.ocr_data or 'pages' not in self.ocr_data:
                return "ERROR: No OCR data"
            parts = []
            for page_number in page_numbers:
                markdown = self._get_page_markdown(page_number)
                if markdown is None:
                    # Reported, not skipped: dropping the page silently handed
                    # the model fewer pages than it asked for with nothing to
                    # say which ones were missing.
                    logger.warning(f"Page {page_number} requested but document has {self._page_count()} pages")
                    parts.append(f"Page {page_number}:\nERROR: Page {page_number} not found. This document has {self._page_count()} pages, numbered 1 to {self._page_count()}")
                    continue
                parts.append(f"Page {page_number}:\n{markdown}")
            return "\n\n".join(parts)
        return get_ocr_text_for_pages


    def _create_section_info_tool(self):
        sections_list = ', '.join(IEP_SECTIONS.keys())
        doc = f"Get key points for a section. Valid names: {sections_list}"
        @function_tool()
        def get_section_info(section_name: str) -> dict:
            if section_name not in IEP_SECTIONS:
                return {"error": f"Unknown section", "available_sections": list(IEP_SECTIONS.keys())}
            return {"section_name": section_name,
                    "description": IEP_SECTIONS[section_name],
                    "key_points": SECTION_KEY_POINTS.get(section_name, [])}
        get_section_info.__doc__ = doc
        return get_section_info

    def analyze_document(self, model="gpt-4.1"):
        """
        Analyze an IEP document in English only using GPT-4.1.
        Returns a dict matching SingleLanguageIEP schema.
        """
        if not self.api_key:
            return {"error": "API key missing"}
        if not self.ocr_data or 'pages' not in self.ocr_data:
            return {"error": "No OCR data"}

        prompt = get_english_only_prompt()

        # English-only analysis agent
        agent = Agent(
            name="IEP Document Analyzer",
            model=model,
            instructions=prompt,
            model_settings=ModelSettings(parallel_tool_calls=True),
            tools=[
                self.ocr_text_tool, 
                self.ocr_page_tool,
                self.ocr_multiple_pages_tool,
                self.section_info_tool
            ],
            output_type=SingleLanguageIEP
        )
            
        try:
            result = Runner.run_sync(
                agent, 
                "Analyze IEP document in English only according to instructions.",
                max_turns=150
            )
            raw_output = result.final_output
        except MaxTurnsExceeded as e:
            logger.error(f"Max turns exceeded: {str(e)}")
            return {"error": "Max turns exceeded"}
        except ModelBehaviorError as e:
            logger.error(f"Model behavior error (likely validation failure): {str(e)}")
            # Try to extract partial output if available
            if hasattr(e, 'final_output') and e.final_output:
                logger.info("Attempting to recover from partial output")
                raw_output = e.final_output
            elif hasattr(e, 'result') and hasattr(e.result, 'final_output'):
                logger.info("Attempting to recover from result object")
                raw_output = e.result.final_output
            else:
                # If we can't recover, try to parse the error message for JSON
                error_str = str(e)
                logger.warning(f"Could not recover output, error: {error_str}")
                return {"error": f"Model behavior error: {error_str}"}

        # Parse & validate
        try:
            if isinstance(raw_output, str):
                cleaned = raw_output.replace('```json','').replace('```','').strip()
                parsed_data = json.loads(cleaned)
                parsed_data = self._ensure_complete_english_sections(parsed_data)
                data = SingleLanguageIEP.model_validate(parsed_data, strict=False)
            elif isinstance(raw_output, dict):
                raw_output = self._ensure_complete_english_sections(raw_output)
                data = SingleLanguageIEP.model_validate(raw_output, strict=False)
            elif isinstance(raw_output, SingleLanguageIEP):
                logger.info("Output is already a SingleLanguageIEP instance")
                # Convert to dict, ensure complete sections, then re-validate
                parsed_dict = raw_output.model_dump()
                parsed_dict = self._ensure_complete_english_sections(parsed_dict)
                data = SingleLanguageIEP.model_validate(parsed_dict, strict=False)
            else:
                output_type = type(raw_output).__name__
                logger.error(f"Unexpected output type: {output_type}")
                if raw_output is not None:
                    logger.error(f"Output preview: {str(raw_output)[:200]}")
                return {"error": f"Unexpected output type: {output_type}"}
            return data.model_dump()
        except Exception as e:
            logger.error(f"Validation error: {str(e)}")
            # Log what sections were actually present
            if isinstance(raw_output, (dict, SingleLanguageIEP)):
                try:
                    if isinstance(raw_output, SingleLanguageIEP):
                        sections_data = raw_output.model_dump().get('sections', [])
                    else:
                        sections_data = raw_output.get('sections', [])
                    if sections_data:
                        present_titles = [s.get('title') if isinstance(s, dict) else getattr(s, 'title', '') for s in sections_data]
                        logger.error(f"Present sections: {present_titles}")
                        logger.error(f"Total sections found: {len(sections_data)}")
                except Exception as log_err:
                    logger.error(f"Error logging section info: {log_err}")
            logger.error(traceback.format_exc(limit=3))
            return {"error": f"Validation failed: {str(e)}"}


    def _ensure_complete_english_sections(self, data):
        """
        Ensure all required IEP sections are present in English data.
        If a section is missing, add it with appropriate placeholder content.
        """
        required_sections = set(IEP_SECTIONS.keys())
        
        if 'sections' not in data:
            logger.warning("No 'sections' key found in data, initializing empty list")
            data['sections'] = []
        
        # Get existing section titles - handle both dict and object formats
        existing_titles = set()
        for section in data['sections']:
            if isinstance(section, dict):
                title = section.get('title', '')
            else:
                # Handle Pydantic model instances
                title = getattr(section, 'title', '')
            if title:
                existing_titles.add(title)
        
        logger.info(f"Found {len(existing_titles)} existing sections: {existing_titles}")
        
        # Find missing sections
        missing_sections = required_sections - existing_titles
        
        if missing_sections:
            logger.warning(f"Missing {len(missing_sections)} required sections: {missing_sections}")
        
        # Add missing sections
        for missing_section in missing_sections:
            logger.warning(f"Adding missing section '{missing_section}' for English")
            placeholder_content = f"This section (_{missing_section}_) was not found in the provided IEP document."
            
            data['sections'].append({
                'title': missing_section,
                'content': placeholder_content,
                # No citation: the model never found this section, so there is no
                # page to send the parent to. The app and the PDF both skip the
                # "Found in pages" line when this is empty. A default of [1] would
                # print a page reference under text saying the section was not found.
                'page_numbers': []
            })
        
        logger.info(f"Final section count: {len(data['sections'])}")
        return data

    def _ensure_complete_sections(self, data):
        """
        Ensure all required IEP sections are present in all languages.
        If a section is missing, add it with appropriate placeholder content.
        """
        required_sections = set(IEP_SECTIONS.keys())
        
        if 'sections' not in data:
            data['sections'] = {}
            
        for lang in ['en', 'es', 'vi', 'zh']:
            if lang not in data['sections']:
                data['sections'][lang] = []
            
            # Get existing section titles for this language
            existing_titles = {section.get('title', '') for section in data['sections'][lang]}
            
            # Find missing sections
            missing_sections = required_sections - existing_titles
            
            # Add missing sections
            for missing_section in missing_sections:
                logger.warning(f"Adding missing section '{missing_section}' for language '{lang}'")
                placeholder_content = f"This section (_{missing_section}_) was not found in the provided IEP document."
                
                data['sections'][lang].append({
                    'title': missing_section,
                    'content': placeholder_content,
                    'page_numbers': []
                })
        
        return data
