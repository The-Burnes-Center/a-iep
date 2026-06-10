# Minimal config for translate_content Lambda function
# This Lambda only does simple translation, not full IEP analysis

import json

def get_en_to_es_translations():
    """Load the English to Spanish translation dictionary."""
    with open('en_es_translations.json', 'r', encoding='utf-8-sig') as f:
        return json.load(f)

def get_en_to_vi_translations():
    """Load the English to Vietnamese translation dictionary."""
    with open('en_vi_translations.json', 'r', encoding='utf-8-sig') as f:
        return json.load(f)

def get_en_to_zh_translations():
    """Load the English to Chinese translation dictionary."""
    with open('en_zh_translations.json', 'r', encoding='utf-8-sig') as f:
        return json.load(f)

def get_en_to_ar_translations():
    """Load the English to Arabic translation dictionary."""
    with open('en_ar_translations.json', 'r', encoding='utf-8-sig') as f:
        return json.load(f)

def get_language_context(target_language):
    """Get the complete language context including translation guidelines."""
    if target_language in ['es', 'spanish']:
        translations = get_en_to_es_translations()
        return f'Use Latin American Spanish. Write at an 8th-grade reading level. Explain technical terms in simple words while preserving their legal/educational meaning. Use the following json of english to spanish translations: {translations}'
    elif target_language in ['vi', 'vietnamese']:
        translations = get_en_to_vi_translations()
        return f'Use standard Vietnamese. Write at an 8th-grade reading level. Explain technical terms in simple words while preserving their legal/educational meaning. Use the following json of english to vietnamese translations: {translations}'
    elif target_language in ['zh', 'chinese']:
        translations = get_en_to_zh_translations()
        return f'Use Simplified Chinese (Mandarin). Write at an 8th-grade reading level. Explain technical terms in simple words while preserving their legal/educational meaning. Use the following json of english to chinese translations: {translations}'
    elif target_language in ['ar', 'arabic']:
        translations = get_en_to_ar_translations()
        return f'Use Modern Standard Arabic. Write at an 8th-grade reading level. Explain technical terms in simple words while preserving their legal/educational meaning. Keep acronyms (IEP, ADHD, ABA, etc.) in Latin script, and keep all numbers, dates, and page references in Western digits (1, 2, 3), not Eastern Arabic numerals. Use the following json of english to arabic translations: {translations}'
    else:
        return f'target language {target_language} not supported. Please use one of the following: "es", "vi", "zh", "ar"'
