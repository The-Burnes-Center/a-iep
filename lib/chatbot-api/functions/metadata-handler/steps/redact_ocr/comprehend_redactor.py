import boto3
import time
from typing import List, Dict, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

# Allowed PII entity types (only these types are allowed, everything else is redacted)
ALLOWED_PII_ENTITY_TYPES = {"NAME", "DATE_TIME"}

# Initialize AWS Comprehend client
comprehend = boto3.client("comprehend")


def redact_single_text(text, language_code="en"):
    """
    Redact PII from a single text string using AWS Comprehend.
    Args:
        text (str): Text to redact (content of one page)
        language_code (str): Language code for Comprehend
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
            replacement = f"[{entity_type}]"
            redacted = redacted[:begin] + replacement + redacted[end:]
            offset += len(replacement) - (end - begin)
            
        return redacted, entity_counter, redacted_counter
    except Exception as e:
        # Fail closed. Returning the original text here would let the handler
        # store unredacted PII as redacted_ocr_result while DeleteOriginal
        # purges the raw copies right after. Raising fails the step instead:
        # Step Functions retries it, and persistent failure routes to
        # RecordFailure, which purges every unredacted artifact.
        print(f"Comprehend detect_pii_entities failed: {str(e)}")
        raise


def redact_pii_from_texts(texts: List[str], language_code: str = "en") -> Tuple[List[str], Dict]:
    """
    Redact all PII except names from a list of texts using AWS Comprehend.
    Each item in the list represents one page from the OCR output.
    Uses ThreadPoolExecutor to process multiple pages in parallel.
    
    Args:
        texts (List[str]): List of page texts (OCR output), one item per page
        language_code (str): Language code for Comprehend (default: 'en')
    Returns:
        Tuple[List[str], Dict]: (List of redacted texts, stats dictionary)
    """
    if not texts:
        return [], {"total_entities": 0, "redacted_entities": 0, "entity_types": {}}
    
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
                future = executor.submit(redact_single_text, text, language_code)
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
                print(f"PII redaction failed for page {idx}: {e}")
                raise
    
    elapsed_time = time.time() - start_time
    
    # Calculate statistics
    total_entities = sum(total_entity_counter.values())
    
    # Create a stats dictionary for reporting
    stats = {
        "total_entities": total_entities,
        "redacted_entities": total_redacted,
        "allowed_entities": total_entities - total_redacted,
        "entity_types": dict(total_entity_counter),
        "processing_time_seconds": round(elapsed_time, 2)
    }
    
    # Log concise PII statistics
    print(f"PII redaction: found {total_entities} entities, redacted {total_redacted} in {elapsed_time:.2f}s")
    
    return redacted_texts, stats 