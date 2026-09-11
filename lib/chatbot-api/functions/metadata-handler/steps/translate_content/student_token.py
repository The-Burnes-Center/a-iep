"""Checking that the student placeholder survived a translation run.

The English content handed to this step refers to the child as {{S}}: the
child's real name was replaced before the document ever reached a model, and
is put back once, server-side, after every language has been produced. That
only works if the token comes back out of each translation intact.

{{S}} was chosen because it has no translatable word in it -- a model asked
for Spanish renders [STUDENT_NAME] as [NOMBRE_DEL_ESTUDIANTE] and leaves
handlebars alone -- and the prompt tells the model to copy it verbatim. Both
are mitigations, not guarantees, which is what this check is for: a run that
came back without the token would otherwise be saved, and the parent would
read a summary where their child is called nothing, or worse, called whatever
name the model decided to invent.
"""
import re

# Kept identical to redact_ocr/student_name.py's constant (each lambda
# directory is zipped on its own, so the token is written out in both).
STUDENT_TOKEN = '{{S}}'

# Deliberately wider than the token: spaced braces, a lowercased S, a dropped
# brace, and the full-width braces a Chinese run produces. Matching these is
# how a reformatted token is caught here rather than surfacing as a mangled
# placeholder a parent can read.
_MANGLED_TOKEN = re.compile(r'[{｛]\s*[{｛]?\s*[Ss]\s*[}｝]?\s*[}｝]')


class StudentTokenLost(Exception):
    """A translation dropped or mangled the student placeholder."""


def _strings(value):
    """Every string in a nested content structure."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for entry in value:
            yield from _strings(entry)
    elif isinstance(value, dict):
        for entry in value.values():
            yield from _strings(entry)


def count_tokens(content):
    """Occurrences of the exact token."""
    return sum(text.count(STUDENT_TOKEN) for text in _strings(content))


def count_mangled_tokens(content):
    """Occurrences of a token-like string that is NOT the exact token."""
    return sum(len(_MANGLED_TOKEN.findall(text.replace(STUDENT_TOKEN, '')))
               for text in _strings(content))


def verify_token_survived(expected, translated_content, target_language):
    """Raise unless this translation kept every student placeholder intact.

    Raising fails the whole step, which is what the rest of this pipeline
    does with a result it cannot trust: Step Functions retries it (a retry is
    a fresh model run, which usually is enough), and persistent failure routes
    to RecordFailure rather than storing the run.
    """
    if not expected:
        return
    found = count_tokens(translated_content)
    mangled = count_mangled_tokens(translated_content)
    if found >= expected and not mangled:
        return
    # Counts and the language only. The values these counts came from are a
    # translated summary of a child's IEP.
    raise StudentTokenLost(
        f"Translation to {target_language} did not preserve the student "
        f"placeholder: expected {expected}, found {found} intact and "
        f"{mangled} mangled")
