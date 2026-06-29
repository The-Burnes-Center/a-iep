# Metadata Handler - IEP Document Processing Pipeline

This document describes the Step Functions-based implementation and architecture of the Metadata Handler in the A-IEP backend, focusing on the document processing pipeline and its multi-agent system.

---

## 1. Pipeline Overview

The document processing pipeline is orchestrated by AWS Step Functions via an `OrchestratorFunction` that starts the state machine on S3 object-created events. The pipeline consists of several key stages:

- **Document Ingestion & OCR**: The document is downloaded from S3 and processed using the Mistral OCR API to extract text.
- **PII Redaction**: The extracted text is scanned for PII (personally identifiable information) using AWS Comprehend, and sensitive data is redacted.
- **S3 Cleanup**: The original file is deleted from S3 after successful OCR processing.
- **Multi-Agent Analysis**: The redacted document is analyzed using OpenAI models to extract structured data (summaries, sections, document index, abbreviations) and IEP meeting notes verbatim.
- **Language Translation**: Content is translated to user's preferred languages (Spanish, Vietnamese, Chinese, Arabic) if needed.
- **Structured Data Storage**: The final structured results are stored in DynamoDB.

---

## 2. Complete Workflow with Progress Tracking

The IEP processing workflow uses comprehensive status tracking with real-time progress updates:

| **Step** | **Progress** | **Current Step** | **Status** | **Description** |
|----------|-------------|------------------|------------|-----------------|
| **InitializeProcessing** | 5% | `"start"` | `PROCESSING` | Initialize processing status and progress tracking |
| **MistralOCR** | 15% | `"ocr_complete"` | `PROCESSING` | Extract text using Mistral OCR API |
| **RedactOCR** | 20% | `"pii_redaction_complete"` | `PROCESSING` | Remove PII using AWS Comprehend |
| **DeleteOriginal** | 22% | `"cleanup_complete"` | `PROCESSING` | Delete uploaded S3 file |
| **ParallelWork** | 65% | `"analysis_complete"` | `PROCESSING` | Run parsing and meeting notes extraction concurrently |
| ├─ **ParsingAgent** | - | - | `PROCESSING` | Generate English summary/sections using OpenAI |
| └─ **MeetingNotesAgent** | - | - | `PROCESSING` | Extract IEP meeting notes verbatim using OpenAI |
| **CheckLanguagePrefs** | - | - | `PROCESSING` | Check user language preferences |
| **TranslationChoice** | - | - | `PROCESSING` | Decide if translations are needed |
| **ParallelTranslations** | 85% | `"translation_complete"` | `PROCESSING` | Translate content (if needed) |
| ├─ **TranslateParsingResult** | - | - | `PROCESSING` | Translate parsing results |
| └─ **TranslateMeetingNotes** | - | - | `PROCESSING` | Translate meeting notes results |
| **FinalizeResults** | 100% | `"completed"` | `PROCESSED` | Mark document as completed |
| **RecordFailure** | 0% | `"error"` | `FAILED` | Record failure state and error details |

### Key Transition Points

1. **Start (5%)**: Document processing begins
2. **OCR Complete (15%)**: Text extraction finished
3. **PII Redaction Complete (20%)**: Sensitive data removed
4. **Cleanup Complete (22%)**: Original file deleted
5. **Analysis Complete (65%)**: English analysis and meeting notes extraction done
6. **Translation Complete (85%)**: Multi-language translations finished (if needed)
7. **Completed (100%)**: All processing finished successfully

### Translation Logic
- If user has language preferences beyond English → translations run
- If user only wants English → skips to finalization
- Progress jumps from 65% to 100% if no translations needed

---

## 3. Multi-Agent Architecture

### Agent Hierarchy and Tools

#### Main Agent ("IEP Document Analyzer")
- **Model**: OpenAI GPT-4.1 (default)
- **Instructions**: Provided by prompts in `steps/parsing_agent/config.py`
- **Tools**:
  - **OCR Tools**:
    - `get_all_ocr_text`: Returns all OCR text
    - `get_ocr_text_for_page`: Returns OCR text for a specific page
    - `get_ocr_text_for_pages`: Returns OCR text for multiple pages
  - **Section Info Tool**:
    - `get_section_info`: Returns key points and descriptions for IEP sections

#### Translation Agent ("OptimizedTranslationAgent")
- **Model**: OpenAI GPT-4.1 (default)
- **Instructions**: Translation-specific prompts in `steps/translate_content/translation_agent.py`
- **Tools**:
  - `get_language_context_for_translation`: Provides language context for translation
  - `get_iep_terminology`: Look up specific IEP term translations

### Agent Execution Flow
- The parsing agent extracts the English structure (summaries, sections, document index, abbreviations)
- The translation agent translates the structured English output into the required non-English languages
- Agents support parallel tool calls via `ModelSettings` for efficiency

### Validation and Output
- Output is validated using Pydantic models in each step module
- The final output is written through the central DDB service

---

## 4. Key Components

### Core Files
- `orchestrator.py`: Starts the Step Functions execution on S3 events
- `state-machines/iep-processing.asl.json`: The state machine definition
- `ddb-service/handler.py`: Centralized DynamoDB operations

### Step Functions
- `steps/update_ddb_start/`: Initialize processing status
- `steps/mistral_ocr/`: Extract text using Mistral OCR API
- `steps/redact_ocr/`: Remove PII using AWS Comprehend
- `steps/delete_original/`: Delete uploaded S3 file
- `steps/parsing_agent/`: Generate English summary/sections using OpenAI
- `steps/extract_meeting_notes/`: Extract IEP meeting notes verbatim using OpenAI
- `steps/check_language_prefs/`: Check user language preferences
- `steps/translate_content/`: Translate content to target languages
- `steps/finalize_results/`: Combine results and mark as completed
- `steps/record_failure/`: Record failure state and error details

---

## 5. Data Flow Summary

**S3 Event → OCR (Mistral) → PII Redaction (Comprehend) → S3 Cleanup → Multi-Agent Analysis (OpenAI) → Language Translation (if needed) → Validation & Formatting → Store Structured Output in DynamoDB**

### Key Output Components
- **Summaries**: Parent-friendly explanations in all supported languages (en, es, vi, zh, ar)
- **Sections**: Detailed IEP sections in Markdown format for all languages
- **Document Index**: Table of contents with page references for all languages  
- **Abbreviations**: Centralized legend of all abbreviations and their full forms for all languages
- **Meeting Notes**: Verbatim extraction of IEP meeting notes section from the document

---

## 6. Abbreviations Feature

The system automatically extracts and organizes abbreviations found throughout IEP documents:

### Key Benefits
- **Centralized**: All abbreviations collected in one place instead of scattered across sections
- **Multi-language**: Abbreviations translated and available in all supported languages
- **Comprehensive**: Extracts from both summaries and all sections
- **Parent-friendly**: Helps parents understand educational terminology and acronyms

### Technical Implementation
- Abbreviations are extracted during document analysis using structured prompts
- Each abbreviation includes the acronym and its full form (e.g., "IEP" → "Individualized Education Program")
- Data is stored in JSON format in DynamoDB for easy frontend consumption
- API responses include the abbreviations field alongside summaries, sections, and document index

---

## 7. Error Handling

- Each step has automatic retry policy: 3 attempts with exponential backoff
- Any unhandled errors route to `RecordFailure` step
- Failure state sets `status="FAILED"`, `current_step="error"`, and `last_error` message
- All errors are logged with detailed context for debugging

---

## 8. Frontend Integration

### Polling Behavior
The existing frontend polling mechanism continues to work unchanged:
- Polls `GET /profile/children/{childId}/documents` every 5 seconds
- Displays progress percentage and current step to users
- Stops polling when `status="PROCESSED"` or `status="FAILED"`

### Progress Display
Frontend should show:
- Progress bar: `progress` field (0-100)
- Status text: `current_step` field mapped to user-friendly messages
- Error state: When `status="FAILED"`, show `last_error` message

Example progress mapping:
```javascript
const stepMessages = {
  "start": "Initializing...",
  "ocr_complete": "Extracting text from document...", 
  "pii_redaction_complete": "Removing sensitive information...",
  "cleanup_complete": "Cleaning up files...",
  "analysis_complete": "Analyzing document content...",
  "translation_complete": "Translating to your preferred languages...",
  "completed": "Processing complete!",
  "error": "Processing failed"
};
```

---

## 9. Environment Variables

### Key Environment Variables
- `BUCKET`: S3 knowledge bucket name
- `IEP_DOCUMENTS_TABLE`: DynamoDB table for document records
- `USER_PROFILES_TABLE`: DynamoDB table for user profiles
- `MISTRAL_API_KEY_PARAMETER_NAME`: SSM parameter for Mistral API key
- `OPENAI_API_KEY_PARAMETER_NAME`: SSM parameter for OpenAI API key
- `STATE_MACHINE_ARN`: Step Functions state machine ARN

---

## 10. File Structure

```
lib/chatbot-api/
├── state-machines/
│   └── iep-processing.asl.json          # Step Functions definition
├── functions/
│   ├── functions.ts                      # CDK infrastructure  
│   └── metadata-handler/
│       ├── orchestrator.py               # S3 event handler
│       ├── ddb-service/
│       │   ├── handler.py               # Centralized DynamoDB operations
│       │   └── requirements.txt
│       └── steps/
│           ├── update_ddb_start/
│           │   ├── handler.py           
│           │   └── requirements.txt
│           ├── mistral_ocr/
│           │   ├── handler.py
│           │   ├── mistral_ocr.py
│           │   └── requirements.txt
│           ├── redact_ocr/
│           │   ├── handler.py  
│           │   ├── comprehend_redactor.py
│           │   └── requirements.txt
│           ├── delete_original/
│           │   ├── handler.py
│           │   └── requirements.txt
│           ├── parsing_agent/
│           │   ├── handler.py
│           │   ├── open_ai_agent.py
│           │   ├── config.py
│           │   ├── data_model.py
│           │   └── requirements.txt
│           ├── extract_meeting_notes/
│           │   ├── handler.py
│           │   ├── prompts.py
│           │   └── requirements.txt
│           ├── check_language_prefs/
│           │   ├── handler.py
│           │   └── requirements.txt
│           ├── translate_content/
│           │   ├── handler.py
│           │   ├── translation_agent.py
│           │   ├── config.py
│           │   ├── data_model.py
│           │   ├── en_es_translations.json
│           │   └── requirements.txt
│           ├── finalize_results/
│           │   ├── handler.py
│           │   └── requirements.txt
│           └── record_failure/
│               ├── handler.py
│               └── requirements.txt
```

---

## 11. Testing

To test the system:
1. Upload a document through the UI
2. Observe progress updates in the document polling API
3. Verify final status transitions from PROCESSING → PROCESSED
4. Check that document summaries and translations are saved correctly
5. Test error scenarios (invalid files, API failures) to ensure proper error handling

---

## 12. Extensibility

- The agent-tool abstraction allows for easy addition of new tools (e.g., new language translation, new section analyzers)
- The multi-agent setup (agents calling agents as tools) supports complex workflows and modularity
- The modular data model supports easy addition of new output components alongside existing summaries, sections, document index, and abbreviations

---

## 13. Business Logic Preservation

⚠️ **Important**: No prompts or business logic have been changed. The refactoring only:
- Broke down the monolithic function into orchestrated steps
- Added progress tracking and better error handling  
- Improved observability and reliability
- All OpenAI prompts, data processing, and translation logic remain identical