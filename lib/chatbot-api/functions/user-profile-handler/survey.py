"""The family survey: which answers are valid, and the record each save writes.

Pure functions only. The handlers in lambda_function.py read and write the
profile, encrypt and decrypt; everything here can be tested without AWS.

The questions live in survey_schema.json, which the app's own copy of the
questions is tested against (src/pages/survey/questions.test.ts), so the two
cannot drift: an answer the screen offers is an answer this accepts.

Three phases, each stored on the parent's profile item:

  before     per child, the baseline, asked while the IEP is read. Closed
             for good once the parent first opens that child's summary, so
             every baseline answer was given before the summary was seen.
  after      per child, a few of the same statements again, after the summary.
  household  once per parent: AI use and staying in touch.

Answers are stored encrypted as one JSON blob (answersEnc); status, part,
consent and timestamps stay readable so progress can be counted without
decrypting anything. Nothing here logs an answer: rejection reasons name the
rule, never the value or the key the caller sent.
"""
import json
import os
import re
from typing import Dict, Optional, Tuple

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'survey_schema.json'),
          encoding='utf-8') as _schema_file:
    SCHEMA = json.load(_schema_file)

VERSION = SCHEMA['version']
PHASES = tuple(SCHEMA['phases'])
CHILD_PHASES = ('before', 'after')
EMAIL_MAX_LENGTH = 254
# A phase's answers are encrypted in one KMS Encrypt call, which takes at most
# 4096 bytes. The text caps in the schema keep a real answer set well under
# this in any script; this is the backstop, refused as a 400 the screen can
# explain rather than a KMS error on every retry.
ANSWERS_MAX_BYTES = 4000
# Deliberately loose: one @, something on each side, a dot in the domain. The
# point is to catch a phone number typed into the wrong box, not to second-
# guess a parent's address.
_EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

# (log reason, response message) for every way a save can be refused.
Problem = Tuple[str, str]


def _choices(phase: Dict, key: str):
    allowed = phase['choice'][key]
    return SCHEMA['scale'] if allowed == 'scale' else allowed


def validate_answers(phase_name: str, answers) -> Optional[Problem]:
    """None if every answer is one the screen could have sent, else the problem.

    Every question is optional, so a missing key is fine and an empty object
    is a valid answer set. Unknown keys are refused rather than dropped: the
    app is the only writer, so an unknown key is a version mismatch worth
    seeing in the log, not something to store quietly.
    """
    phase = SCHEMA['phases'][phase_name]
    if not isinstance(answers, dict):
        return 'answers is not an object', 'Answers must be an object'
    for key, value in answers.items():
        if key in phase['choice']:
            if value not in _choices(phase, key):
                return 'a choice answer is not one of its options', 'An answer is not one of its options'
        elif key in phase['multi']:
            options = phase['multi'][key]
            if (not isinstance(value, list) or not all(isinstance(item, str) for item in value)
                    or len(value) != len(set(value)) or any(item not in options for item in value)):
                return 'a checklist answer is not a list of its options', 'An answer is not one of its options'
        elif key in phase['text']:
            if not isinstance(value, str) or len(value) > phase['text'][key]:
                return 'a written answer is not text or is too long', 'A written answer is too long'
        elif key in phase.get('email', []):
            if (not isinstance(value, str) or len(value) > EMAIL_MAX_LENGTH
                    or (value.strip() and not _EMAIL.match(value.strip()))):
                return 'the email answer is not an email address', 'Enter an email address, or leave it blank'
        else:
            return 'an answer key is not a question in this version', 'An answer is for a question we do not ask'
    if len(json.dumps(answers, ensure_ascii=False).encode('utf-8')) > ANSWERS_MAX_BYTES:
        return 'the answers are too large to encrypt in one call', 'Your answers are too long. Please shorten them.'
    return None


def validate_save(body) -> Tuple[Optional[Dict], Optional[Problem]]:
    """The cleaned save request, or the first problem with it.

    Body: {phase, status, part?, answers?, researchConsent?}. Returns new dicts;
    the caller's body is never modified. `answers` is None when the body has
    none, which keeps the stored answers (a reminder must not erase them),
    and {} when it sends an empty set, which clears them.
    """
    if not isinstance(body, dict):
        return None, ('body is not a JSON object', 'Invalid JSON body: expected a JSON object')
    phase_name = body.get('phase')
    if phase_name not in PHASES:
        return None, ('phase is not before, after or household', 'Unknown survey phase')
    phase = SCHEMA['phases'][phase_name]
    if body.get('status') not in phase['statuses']:
        return None, ('status is not one this phase allows', 'Unknown survey status')
    part = body.get('part')
    if part is not None and part not in phase['parts']:
        return None, ('part is not one of this phase\'s parts', 'Unknown survey part')
    consent = body.get('researchConsent')
    if consent is not None and not isinstance(consent, bool):
        return None, ('researchConsent is not a boolean', 'researchConsent must be true or false')
    answers = body.get('answers')
    if answers is not None:
        problem = validate_answers(phase_name, answers)
        if problem:
            return None, problem
    cleaned = {'phase': phase_name, 'status': body['status'], 'part': part,
               'answers': dict(answers) if answers is not None else None, 'researchConsent': consent}
    return cleaned, None


def build_record(save: Dict, answers_enc: Optional[str], previous: Optional[Dict], now: int) -> Dict:
    """The stored record for one phase after this save. A new dict.

    `answers_enc` is the encrypted JSON of save['answers'] (None when there are
    none). A save that sent no answers at all keeps the previous ciphertext. The first save stamps startedAt, the first 'done' stamps
    completedAt, and neither moves afterwards. A consent the save does not
    mention keeps its previous value, so "Save and finish later" cannot
    silently withdraw it.
    """
    previous = previous or {}
    record = {
        'version': VERSION,
        'status': save['status'],
        'startedAt': previous.get('startedAt', now),
        'updatedAt': now,
    }
    part = save['part'] if save['part'] is not None else previous.get('part')
    if part is not None:
        record['part'] = part
    consent = save['researchConsent'] if save['researchConsent'] is not None else previous.get('researchConsent')
    if consent is not None:
        record['researchConsent'] = consent
    if save['answers'] is None and previous.get('answersEnc'):
        record['answersEnc'] = previous['answersEnc']
    elif answers_enc:
        record['answersEnc'] = answers_enc
    completed = previous.get('completedAt')
    if completed is None and save['status'] == 'done':
        completed = now
    if completed is not None:
        record['completedAt'] = completed
    return record


def public_record(record: Optional[Dict], answers: Dict) -> Optional[Dict]:
    """What GET returns for one phase: the record without ciphertext, with answers."""
    if not record:
        return None
    shown = {key: value for key, value in record.items() if key != 'answersEnc'}
    shown['answers'] = answers
    return shown
