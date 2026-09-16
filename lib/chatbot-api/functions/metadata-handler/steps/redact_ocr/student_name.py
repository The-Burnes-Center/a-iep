"""Deciding which of a document's names belong to the student.

Comprehend says where the names are; this module says which of them are the
child's. Every NAME entity is replaced either way -- the only question is
whether a mention becomes the student token (restored to the real name once
processing finishes) or the generic [NAME] (never restored, never printed).

That asymmetry sets the strictness. A miss costs a mention that reads
[NAME] to the model, which the parsing prompt already handles: the document is
about one child, so the model writes the token from context. A false positive
puts a teacher's name in front of a parent as their child's, which is the
failure this whole feature exists to prevent. So the match needs a full name,
in the document, and refuses everything short of one.
"""
import re
import unicodedata

# The student placeholder. Short, and with no translatable word inside it, so
# it survives four translation runs: a model asked for Spanish renders
# [STUDENT_NAME] as [NOMBRE_DEL_ESTUDIANTE] and a bare {{S}} unchanged.
# ddb-service/student_name.py holds the matching sweep that restores it, and
# translate_content/student_token.py the count that fails a run which drops it.
STUDENT_TOKEN = '{{S}}'

# A profile name that means "the parent never gave us one". getProfile creates
# the child row before the parent has typed anything, and every profile
# created before the name became mandatory carries the old placeholder.
_PLACEHOLDER_NAMES = {'', 'my child'}

# Possessive endings, stripped before tokenizing so "Jordan Smith's goals"
# matches whether or not Comprehend includes the 's in the span.
_POSSESSIVE = re.compile(r"[’']s\b|[’'](?=\s|$)")
_APOSTROPHE = re.compile(r"[’']")
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")


def _fold(value):
    """Casefolded, accent-stripped text: OCR writes Jose for José."""
    decomposed = unicodedata.normalize('NFKD', value)
    without_marks = ''.join(c for c in decomposed if not unicodedata.combining(c))
    return without_marks.casefold()


def name_tokens(value):
    """The comparable word tokens of a written name.

    Punctuation becomes a space rather than disappearing, so Smith-Jones and
    "Smith Jones" tokenize the same way, and apostrophes are dropped so
    O'Brien stays one token on both sides of a comparison.
    """
    if not isinstance(value, str):
        return []
    folded = _fold(value)
    folded = _POSSESSIVE.sub('', folded)
    folded = _APOSTROPHE.sub('', folded)
    folded = _NON_WORD.sub(' ', folded)
    return [token for token in _WHITESPACE.split(folded) if token]


def usable_student_name(value):
    """The profile name to match on, or None if the parent never gave one.

    A single-token name is unusable too: matching on it would mean matching a
    bare first name, and every teacher who shares it would be swapped back as
    the child.
    """
    if not isinstance(value, str):
        return None
    if value.strip().casefold() in _PLACEHOLDER_NAMES:
        return None
    return value if len(name_tokens(value)) >= 2 else None


def is_student_mention(mention, student_name):
    """True when this NAME entity is the student, under a strict full-name match.

    Matched:
      - the full name in any case, with any punctuation ("JORDAN SMITH",
        "Jordan Smith.", possessives, accented/unaccented spellings)
      - an added or dropped middle name or initial ("Jordan M. Smith")
      - the same tokens in any order, which is how an IEP writes
        "Smith, Jordan"

    Not matched, deliberately:
      - a bare first name ("Jordan") or bare surname ("Smith")
      - first name with an initial ("Jordan S.", "J. Smith"), which would put
        every Jordan S. on the team at risk of being restored as the child
      - nicknames, and anything OCR garbled beyond one of the forms above

    Each refusal turns into [NAME], which is safe.
    """
    name = usable_student_name(student_name)
    if not name:
        return False
    mention_tokens = name_tokens(mention)
    if len(mention_tokens) < 2:
        return False
    profile = name_tokens(name)
    same_ends = (mention_tokens[0] == profile[0]
                 and mention_tokens[-1] == profile[-1])
    return same_ends or sorted(mention_tokens) == sorted(profile)
