"""Putting the child's name into a summary on its way to a parent.

The pipeline replaces every name before the document reaches OpenAI, and the
child's own mentions come back as {{S}}. Stored content keeps that placeholder
permanently: the name is never written into a summary, a translation, or the
content object in S3. It is substituted here, on the way out, every time.

That is what makes adding a language months later safe -- the translating
model reads stored content, which still says {{S}} -- and it is why a parent
who corrects a misspelled name sees the correction in every summary and every
translation they already have, instead of only in documents uploaded after.

tts-handler carries its own string-only copy of this. Lambda asset directories
are zipped independently, so neither can import the other, and the worst a
divergence between them can do is print a placeholder: nothing here can leak a
name that is not already on its way to the parent who owns it.
"""
import re

# Kept identical to redact_ocr/student_name.py's constant (each lambda
# directory is zipped on its own, so the token is written out in both).
STUDENT_TOKEN = '{{S}}'

# The token as it comes back from four translation runs. The prompts tell the
# model to copy it verbatim and translate_content fails a run that drops it,
# but a model that reformats it slightly still reaches storage, and a
# half-mangled token printed to a parent is worse than either. Full-width
# braces are the Chinese run's contribution; the spaced forms are everyone's.
_MANGLED_TOKEN = re.compile(r'[{｛]\s*[{｛]?\s*[Ss]\s*[}｝]?\s*[}｝]')

# What the token becomes when the profile has no usable name: a parent can
# reach a finished document before they have been asked for one, and legacy
# profiles carry the old 'My Child' placeholder. Never a raw token, never the
# literal 'My Child'.
NEUTRAL_CHILD_PHRASES = {
    'en': 'your child',
    'es': 'su hijo o hija',
    'vi': 'con quý vị',
    'zh': '您的孩子',
    'ar': 'طفلك',
}
DEFAULT_LANGUAGE = 'en'

# Same rule as the redaction step: these mean "the parent never gave us one".
_PLACEHOLDER_NAMES = {'', 'my child'}

# No child's name is this long. A KMS ciphertext blob, base64-encoded, always
# is. kms_decrypt_string hands back the ciphertext it was given when a decrypt
# fails, so without this a revoked key or a narrowed policy would print a
# base64 blob to a parent as their child's name.
_MAX_PLAINTEXT_NAME_LENGTH = 100


def usable_student_name(value):
    """The profile name to substitute, or None if there is nothing usable."""
    if not isinstance(value, str):
        return None
    name = value.strip()
    if name.casefold() in _PLACEHOLDER_NAMES or len(name) > _MAX_PLAINTEXT_NAME_LENGTH:
        return None
    return name


def replacement_for(student_name, language):
    """What {{S}} becomes in this language: the name, or the neutral phrase."""
    name = usable_student_name(student_name)
    if name:
        return name
    return NEUTRAL_CHILD_PHRASES.get(language, NEUTRAL_CHILD_PHRASES[DEFAULT_LANGUAGE])


def substitute_in_value(value, replacement):
    """Replace every token in a string, list or dict of content.

    Returns (new_value, count). Nothing is mutated in place: the content read
    from S3 or DynamoDB is handed back untouched, which is the whole point of
    substituting on the read rather than on the write.
    """
    if isinstance(value, str):
        count = value.count(STUDENT_TOKEN)
        substituted = value.replace(STUDENT_TOKEN, replacement)
        # After the exact pass, because the exact token matches this pattern
        # too and would otherwise be counted twice.
        substituted, mangled = _MANGLED_TOKEN.subn(replacement, substituted)
        return substituted, count + mangled
    if isinstance(value, list):
        items, count = [], 0
        for entry in value:
            substituted, entry_count = substitute_in_value(entry, replacement)
            items.append(substituted)
            count += entry_count
        return items, count
    if isinstance(value, dict):
        items, count = {}, 0
        for key, entry in value.items():
            substituted, entry_count = substitute_in_value(entry, replacement)
            items[key] = substituted
            count += entry_count
        return items, count
    return value, 0


def substitute_content(content, student_name):
    """Substitute every language of a document's content dict.

    `content` is {field: {language: value}} -- the shape both the inline row
    and the S3 blob use -- so the language key picks the right neutral phrase
    when there is no name.

    Returns (new_content, count). A count of zero is normal and not an error:
    documents that predate the redaction hold real names and no token at all.
    Counts only in the return, because the values they came from are a child's
    summary.
    """
    substituted = {}
    total = 0
    for field, by_language in (content or {}).items():
        if not isinstance(by_language, dict):
            substituted[field] = by_language
            continue
        substituted_field = {}
        for language, value in by_language.items():
            value, count = substitute_in_value(value, replacement_for(student_name, language))
            substituted_field[language] = value
            total += count
        substituted[field] = substituted_field
    return substituted, total
