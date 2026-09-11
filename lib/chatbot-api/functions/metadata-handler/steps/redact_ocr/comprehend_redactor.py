import boto3
import time
from typing import List, Dict, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
from student_name import STUDENT_TOKEN, is_student_mention

# Allowed PII entity types (only these types are allowed, everything else is redacted)
# NAME is NOT allowed: it used to be, which meant the child's name, both
# parents' names and every teacher, therapist and administrator named in the
# IEP reached OpenAI twice -- once in the parsing agent, again in each
# translation run. Every name is now replaced before the document leaves this
# step. The student's mentions become STUDENT_TOKEN and are restored from the
# profile after processing (ddb-service restore_student_name); every other
# name becomes [NAME] and is never restored.
ALLOWED_PII_ENTITY_TYPES = {"DATE_TIME"}

# Initialize AWS Comprehend client
comprehend = boto3.client("comprehend")


def redact_single_text(text, language_code="en", student_name=None):
    """
    Redact PII from a single text string using AWS Comprehend.
    Args:
        text (str): Text to redact (content of one page)
        language_code (str): Language code for Comprehend
        student_name (str): The child's name from their profile, used only to
            decide which NAME entities become STUDENT_TOKEN instead of [NAME].
            None (no name saved, or the lookup failed) simply means no mention
            is singled out: every name still gets replaced.
    Returns:
        tuple: (redacted_text, entity_counter, redacted_counter)
    Raises:
        Any Comprehend error, so the step fails instead of passing
        unredacted text downstream.
    """
    # Skip empty or whitespace-only text
    if not text or not text.strip():
        return text, Counter(), 0

    try:
        response = comprehend.detect_pii_entities(Text=text, LanguageCode=language_code)
        entities = response.get("Entities", [])
        
        # Count entities by type
        entity_counter = Counter()
        for entity in entities:
            entity_counter[entity["Type"]] += 1
            
        # Track how many we actually redact
        redacted_counter = 0
        
        redacted = text
        offset = 0
        for entity in sorted(entities, key=lambda e: e["BeginOffset"]):
            entity_type = entity["Type"]
            if entity_type in ALLOWED_PII_ENTITY_TYPES:
                continue
                
            redacted_counter += 1
            begin = entity["BeginOffset"] + offset
            end = entity["EndOffset"] + offset
            # Offsets index the ORIGINAL text; `offset` only shifts them for
            # the splice into the partially rewritten copy.
            mention = text[entity["BeginOffset"]:entity["EndOffset"]]
            replacement = f"[{entity_type}]"
            if entity_type == "NAME" and is_student_mention(mention, student_name):
                replacement = STUDENT_TOKEN
            redacted = redacted[:begin] + replacement + redacted[end:]
            offset += len(replacement) - (end - begin)
            
        return redacted, entity_counter, redacted_counter
    except Exception as e:
        # Fail closed. Returning the original text here would let the handler
        # store unredacted PII as redacted_ocr_result while DeleteOriginal
        # purges the raw copies right after. Raising fails the step instead:
        # Step Functions retries it, and persistent failure routes to
        # RecordFailure, which purges every unredacted artifact.
        # Class name only. This function's input IS OCR text, so an exception
        # raised while redacting it is a direct route for that text into
        # CloudWatch -- boto3 and threading exceptions both quote the value
        # they choked on. Same reduction as the step handlers' outer catch-alls
        # (delete_original/handler.py); no pydantic here, so no richer summary
        # is available or needed for triage.
        print(f"Comprehend detect_pii_entities failed: {type(e).__name__}")
        raise


def redact_pii_from_texts(texts: List[str], language_code: str = "en",
                          student_name: str = None) -> Tuple[List[str], Dict]:
    """
    Redact all PII, names included, from a list of texts using AWS Comprehend.
    Each item in the list represents one page from the OCR output.
    Uses ThreadPoolExecutor to process multiple pages in parallel.

    Args:
        texts (List[str]): List of page texts (OCR output), one item per page
        language_code (str): Language code for Comprehend (default: 'en')
        student_name (str): The child's profile name (see redact_single_text)
    Returns:
        Tuple[List[str], Dict]: (List of redacted texts, stats dictionary)
    """
    if not texts:
        return [], {"total_entities": 0, "redacted_entities": 0, "entity_types": {},
                    "student_tokens": 0}
    
    # Count non-empty pages for logging
    valid_count = sum(1 for text in texts if text and text.strip())
    
    print(f"Starting parallel PII redaction for {valid_count} non-empty pages out of {len(texts)} total pages")
    start_time = time.time()
    
    # Use 8 workers for parallel processing
    MAX_WORKERS = 8
    
    # Adjust workers if we have fewer pages
    workers = min(MAX_WORKERS, len(texts))
    
    # Initialize result list with same length as input
    redacted_texts = [None] * len(texts)
    
    # Track PII statistics
    total_entity_counter = Counter()
    total_redacted = 0
    
    with ThreadPoolExecutor(max_workers=workers) as executor:
        # Create a mapping of futures to their page indices
        future_to_idx = {}
        
        # Submit only non-empty pages for processing
        for idx, text in enumerate(texts):
            if text and text.strip():
                future = executor.submit(redact_single_text, text, language_code,
                                         student_name)
                future_to_idx[future] = idx
            else:
                # Keep empty pages as-is
                redacted_texts[idx] = texts[idx]
        
        # Process each future as it completes
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                redacted_text, entity_counter, redacted_count = future.result()
                redacted_texts[idx] = redacted_text
                
                # Update global counters
                total_entity_counter.update(entity_counter)
                total_redacted += redacted_count
                
            except Exception as e:
                # Fail closed (see redact_single_text): a page that cannot be
                # redacted fails the whole step rather than falling back to
                # the original unredacted text.
                # Class name only; see redact_single_text. The page index is
                # safe and is the one thing worth keeping for triage.
                print(f"PII redaction failed for page {idx}: {type(e).__name__}")
                raise
    
    elapsed_time = time.time() - start_time
    
    # Calculate statistics
    total_entities = sum(total_entity_counter.values())
    
    # How many mentions were singled out as the student's. Counted from the
    # output rather than threaded back out of each worker, which keeps
    # redact_single_text's return shape as it was. A count of 0 on a document
    # whose parent saved a name means the matcher never recognised the
    # spelling: the run is still safe (those mentions read [NAME]) and the
    # parsing prompt still asks the model for the token, but it is the signal
    # that the strict match missed, and the only one that reaches CloudWatch.
    student_tokens = sum(text.count(STUDENT_TOKEN)
                         for text in redacted_texts if isinstance(text, str))

    # Create a stats dictionary for reporting
    stats = {
        "total_entities": total_entities,
        "redacted_entities": total_redacted,
        "allowed_entities": total_entities - total_redacted,
        "entity_types": dict(total_entity_counter),
        "student_tokens": student_tokens,
        "processing_time_seconds": round(elapsed_time, 2)
    }

    # Log concise PII statistics
    print(f"PII redaction: found {total_entities} entities, redacted {total_redacted} in {elapsed_time:.2f}s")
    print(f"Student-name mentions tokenized: {student_tokens}")
    
    return redacted_texts, stats 