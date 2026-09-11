"""Putting the child's name back into finished content.

The pipeline sends the summarizing and translating model a placeholder,
{{S}}, in place of the student's name. This is the one place it becomes a
name again: after every translation has run, before the document is marked
PROCESSED, and never on the way out to a reader. TTS and the PDF generator
both read the stored summary, so a swap done at read time would leave the
voice reading the letters of a placeholder aloud.

The cost of swapping once, here, is that a name corrected after a document
finished will not reach it. That is the accepted trade for one code path.
"""
import re

# Kept identical to redact_ocr/student_name.py's constant (each lambda
# directory is zipped on its own, so the token is written out in both).
STUDENT_TOKEN = '{{S}}'

# The token as it comes back from four translation runs. The prompts tell the
# model to copy it verbatim and translate_content fails a run that drops it,
# but a model that reformats it slightly still gets here, and a half-mangled
# token printed to a parent is worse than either. Full-width braces are the
# Chinese run's contribution; the spaced forms are everyone's.
_MANGLED_TOKEN = re.compile(r'[{｛]\s*[{｛]?\s*[Ss]\s*[}｝]?\s*[}｝]')

# What the token becomes when the profile has no usable name: a parent can
# reach a finished document before the name gate is on in their environment,
# and legacy profiles carry the old 'My Child' placeholder. Never a raw
# token, never the literal 'My Child'.
NEUTRAL_CHILD_PHRASES = {
    'en': 'your child',
    'es': 'su hijo o hija',
    'vi': 'con quý vị',
    'zh': '您的孩子',
    'ar': 'طفلك',
}
_DEFAULT_LANGUAGE = 'en'

# Same rule as the redaction step: these mean "the parent never gave us one".
_PLACEHOLDER_NAMES = {'', 'my child'}


def usable_student_name(value):
    """The profile name to restore, or None if there is nothing usable."""
    if not isinstance(value, str) or value.strip().casefold() in _PLACEHOLDER_NAMES:
        return None
    return value.strip()


def replacement_for(student_name, language):
    """What {{S}} becomes in this language: the name, or the neutral phrase."""
    name = usable_student_name(student_name)
    if name:
        return name
    return NEUTRAL_CHILD_PHRASES.get(language, NEUTRAL_CHILD_PHRASES[_DEFAULT_LANGUAGE])


def restore_in_value(value, replacement):
    """Replace every token in a string, list or dict of translated content.

    Returns (new_value, exact_count, mangled_count). Nothing is mutated in
    place: content read from S3 is handed straight back to the caller on the
    paths where nothing changed.
    """
    if isinstance(value, str):
        exact = value.count(STUDENT_TOKEN)
        restored = value.replace(STUDENT_TOKEN, replacement)
        mangled = len(_MANGLED_TOKEN.findall(restored))
        if mangled:
            restored = _MANGLED_TOKEN.sub(replacement, restored)
        return restored, exact, mangled
    if isinstance(value, list):
        items, exact, mangled = [], 0, 0
        for entry in value:
            restored, entry_exact, entry_mangled = restore_in_value(entry, replacement)
            items.append(restored)
            exact += entry_exact
            mangled += entry_mangled
        return items, exact, mangled
    if isinstance(value, dict):
        items, exact, mangled = {}, 0, 0
        for key, entry in value.items():
            restored, entry_exact, entry_mangled = restore_in_value(entry, replacement)
            items[key] = restored
            exact += entry_exact
            mangled += entry_mangled
        return items, exact, mangled
    return value, 0, 0


def restore_content(content, student_name):
    """Restore every language of a document's content dict.

    `content` is {field: {language: value}} -- the shape both the inline row
    and the S3 blob use -- so the language key picks the neutral phrase when
    there is no name to restore.

    Returns (new_content, stats) with stats counting exact and mangled tokens
    replaced. Counts only: they go to CloudWatch, and the values they came
    from are a child's summary.
    """
    restored = {}
    exact = mangled = 0
    for field, by_language in (content or {}).items():
        if not isinstance(by_language, dict):
            restored[field] = by_language
            continue
        restored_field = {}
        for language, value in by_language.items():
            value, value_exact, value_mangled = restore_in_value(
                value, replacement_for(student_name, language))
            restored_field[language] = value
            exact += value_exact
            mangled += value_mangled
        restored[field] = restored_field
    return restored, {'tokens_restored': exact, 'mangled_tokens_restored': mangled}
