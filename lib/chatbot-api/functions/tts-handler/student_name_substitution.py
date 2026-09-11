"""Putting the child's name into the text before it is read aloud.

Stored content refers to the child as the {{S}} placeholder and keeps doing
so: the pipeline never writes the real name into a summary or a translation.
Every reader substitutes it on the way out, so this is what stands between the
speech provider and a voice spelling out a placeholder.

user-profile-handler carries the same module, one size larger: it walks the
whole content dict, where this one only ever handles the single markdown
string _resolve_text picked. Lambda asset directories are zipped
independently, so neither can import the other. If the two ever drift, the
cost is a placeholder read aloud, not a name going somewhere it should not.
"""
import re

# Kept identical to redact_ocr/student_name.py's constant (each lambda
# directory is zipped on its own, so the token is written out in both).
STUDENT_TOKEN = '{{S}}'

# The token as it comes back from four translation runs. The prompts tell the
# model to copy it verbatim and translate_content fails a run that drops it,
# but a model that reformats it slightly still reaches storage, and this voice
# would read the braces out. Full-width braces are the Chinese run's
# contribution; the spaced forms are everyone's.
_MANGLED_TOKEN = re.compile(r'[{｛]\s*[{｛]?\s*[Ss]\s*[}｝]?\s*[}｝]')

# What the token becomes when the profile has no usable name. Spoken aloud, so
# never a raw token and never the literal 'My Child'.
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
# is, and this lambda falls back to the stored value when a decrypt fails, so
# without this the voice would read a base64 blob aloud as the child's name.
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


def substitute_text(text, replacement):
    """Replace every token in one markdown string.

    Returns (new_text, count). The stored content the caller read is not
    mutated: it is the canonical copy every other reader shares.
    """
    if not isinstance(text, str):
        return text, 0
    count = text.count(STUDENT_TOKEN)
    substituted = text.replace(STUDENT_TOKEN, replacement)
    # After the exact pass, because the exact token matches this pattern too
    # and would otherwise be counted twice.
    substituted, mangled = _MANGLED_TOKEN.subn(replacement, substituted)
    return substituted, count + mangled
