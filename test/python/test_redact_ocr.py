"""redact_ocr step tests: the pipeline's PII firewall.

Everything downstream (parsing agents, translation, the parent-facing API)
reads redacted_ocr_result, and the very next step purges the raw OCR and the
uploaded PDF, so whatever this step writes is the only copy that persists.
Two properties carry that weight: the offset splice must remove every
non-allowlisted entity Comprehend reports, and a Comprehend failure must fail
the step (Step Functions retries, then RecordFailure purges the unredacted
artifacts) instead of passing the original text through as "redacted".

NAME used to be on the allowlist, so every name in the document -- the child's,
both parents', every teacher's and therapist's -- reached OpenAI intact. It is
not anymore: the student's mentions become {{S}} (restored from the profile
after processing) and every other name becomes [NAME], restored never. The
absence of the real name in what this step writes is the property that matters
most here, so it is asserted directly rather than via the presence of a token.
"""
import json
import sys
from types import SimpleNamespace

import pytest

from conftest import FakeLambdaClient, ScopedBoto3, load_lambda_module, unload

IDS = {'iep_id': 'iep-1', 'user_id': 'user-sub-1', 'child_id': 'child-1'}
DDB_SERVICE = 'DDBServiceTest'
OK_SAVE = {'statusCode': 200, 'body': json.dumps({'message': 'ok'})}
SENTINEL = 'Sentinel-Jordan-Smith-9f3c-do-not-log-this'


class FakeComprehend:
    """Scripted detect_pii_entities: per-text entity lists, optional errors."""

    def __init__(self):
        self.entities_by_text = {}
        self.failing_texts = set()
        self.fail_always = False
        self.calls = []

    def detect_pii_entities(self, Text, LanguageCode):
        self.calls.append((Text, LanguageCode))
        if self.fail_always or Text in self.failing_texts:
            raise RuntimeError('Comprehend unavailable')
        return {'Entities': self.entities_by_text.get(Text, [])}


def entity(text, needle, entity_type):
    """Entity at the offsets of `needle` in `text`. Comprehend offsets count
    Unicode code points, which is exactly Python string indexing."""
    begin = text.index(needle)
    return {'Type': entity_type, 'Score': 0.99,
            'BeginOffset': begin, 'EndOffset': begin + len(needle)}


@pytest.fixture()
def redact(monkeypatch):
    module = load_lambda_module('metadata-handler/steps/redact_ocr',
                                'redact_ocr_handler', module_name='handler')
    redactor = sys.modules['comprehend_redactor']  # the copy handler.py imported
    comprehend = FakeComprehend()
    monkeypatch.setattr(redactor, 'comprehend', comprehend)
    try:
        yield SimpleNamespace(module=module, redactor=redactor, comprehend=comprehend)
    finally:
        unload('redact_ocr_handler')
        unload('comprehend_redactor')
        # comprehend_redactor imports it as a sibling, and ddb-service ships a
        # module of its own for the other half of this feature.
        unload('student_name')


# --- redact_single_text: the offset splice ---------------------------------

def redact_text(redact, text, entities):
    redact.comprehend.entities_by_text[text] = entities
    return redact.redactor.redact_single_text(text)


def test_non_allowlisted_entities_are_replaced_at_their_offsets(redact):
    text = 'Maria Lopez, SSN 123-45-6789, at 12 Oak St, phone (415) 555-0100.'
    redacted, entity_counter, redacted_count = redact_text(redact, text, [
        entity(text, 'Maria Lopez', 'NAME'),
        entity(text, '123-45-6789', 'SSN'),
        entity(text, '12 Oak St', 'ADDRESS'),
        entity(text, '(415) 555-0100', 'PHONE'),
    ])
    assert redacted == '[NAME], SSN [SSN], at [ADDRESS], phone [PHONE].'
    assert redacted_count == 4
    assert dict(entity_counter) == {'NAME': 1, 'SSN': 1, 'ADDRESS': 1, 'PHONE': 1}


def test_dates_survive_but_names_do_not(redact):
    """DATE_TIME is what is left on the allowlist: an IEP is a calendar of
    evaluations, meetings and service dates, and a parent cannot act on a
    summary that redacts them. A name is not in that category."""
    text = 'Maria Lopez was evaluated on March 3, 2026.'
    redacted, entity_counter, redacted_count = redact_text(redact, text, [
        entity(text, 'Maria Lopez', 'NAME'),
        entity(text, 'March 3, 2026', 'DATE_TIME'),
    ])
    assert redacted == '[NAME] was evaluated on March 3, 2026.'
    assert 'Maria' not in redacted and 'Lopez' not in redacted
    assert redacted_count == 1
    assert dict(entity_counter) == {'NAME': 1, 'DATE_TIME': 1}


def test_adjacent_entities_are_both_replaced(redact):
    text = 'x123-45-6789(415) 555-0100y'
    redacted, _, redacted_count = redact_text(redact, text, [
        entity(text, '123-45-6789', 'SSN'),
        entity(text, '(415) 555-0100', 'PHONE'),
    ])
    assert redacted == 'x[SSN][PHONE]y'
    assert redacted_count == 2


def test_replacement_longer_than_the_span_still_lands_later_entities(redact):
    # '[EMAIL]' is longer than 'a@b.c', shifting everything after it right;
    # the SSN must still be spliced at its shifted position.
    text = 'mail a@b.c then 123-45-6789 end'
    redacted, _, _ = redact_text(redact, text, [
        entity(text, 'a@b.c', 'EMAIL'),
        entity(text, '123-45-6789', 'SSN'),
    ])
    assert redacted == 'mail [EMAIL] then [SSN] end'


def test_overlapping_entities_leave_no_pii_characters_behind(redact):
    # Comprehend should not return overlapping spans, but if it ever does the
    # splice may garble the replacement tags. What must hold regardless: no
    # character of either entity's text survives.
    text = 'id 415-555-0100-99 x'
    phone = {'Type': 'PHONE', 'Score': 0.9, 'BeginOffset': 3, 'EndOffset': 15}
    ssn = {'Type': 'SSN', 'Score': 0.9, 'BeginOffset': 7, 'EndOffset': 18}
    redacted, _, redacted_count = redact_text(redact, text, [phone, ssn])
    assert redacted_count == 2
    assert not any(digit in redacted for digit in '0123456789')


def test_multibyte_text_splices_at_code_point_offsets(redact):
    # Comprehend offsets count code points (not bytes, not UTF-16 units), so
    # accented characters and astral-plane emoji before an entity must not
    # shift the splice.
    text = 'niño José 🎉 llamó: 123-45-6789 fin'
    redacted, _, _ = redact_text(redact, text, [
        entity(text, 'José', 'NAME'),
        entity(text, '123-45-6789', 'SSN'),
    ])
    assert redacted == 'niño [NAME] 🎉 llamó: [SSN] fin'


def test_empty_and_whitespace_pages_skip_comprehend(redact):
    for text in ('', '   \n\t'):
        redacted, entity_counter, redacted_count = redact.redactor.redact_single_text(text)
        assert (redacted, redacted_count) == (text, 0)
        assert not entity_counter
    assert redact.comprehend.calls == []


def test_comprehend_error_fails_closed(redact):
    """The decision this suite exists to pin: a Comprehend error must raise.

    The old behavior returned the original text with a zero counter, so the
    handler stored raw PII as redacted_ocr_result, the pipeline reported
    success, and DeleteOriginal purged the only copies marked as raw. Failing
    loudly is safe: the state machine retries the step 3x and then routes to
    RecordFailure, which marks the document FAILED and purges the unredacted
    artifacts.
    """
    redact.comprehend.fail_always = True
    with pytest.raises(RuntimeError):
        redact.redactor.redact_single_text('SSN 123-45-6789')


# --- redact_pii_from_texts: the page batch ----------------------------------

def test_batch_preserves_page_order_and_aggregates_stats(redact):
    page_one = 'Maria Lopez, SSN 123-45-6789.'
    page_two = 'Call (415) 555-0100 or (415) 555-0199.'
    redact.comprehend.entities_by_text = {
        page_one: [entity(page_one, 'Maria Lopez', 'NAME'),
                   entity(page_one, '123-45-6789', 'SSN')],
        page_two: [entity(page_two, '(415) 555-0100', 'PHONE'),
                   {'Type': 'PHONE', 'Score': 0.9,
                    'BeginOffset': page_two.index('(415) 555-0199'),
                    'EndOffset': page_two.index('(415) 555-0199') + len('(415) 555-0199')}],
    }
    redacted, stats = redact.redactor.redact_pii_from_texts([page_one, '', page_two])

    assert redacted == ['[NAME], SSN [SSN].', '', 'Call [PHONE] or [PHONE].']
    assert stats['total_entities'] == 4
    assert stats['redacted_entities'] == 4
    assert stats['allowed_entities'] == 0
    assert stats['student_tokens'] == 0  # no profile name was supplied
    assert stats['entity_types'] == {'NAME': 1, 'SSN': 1, 'PHONE': 2}
    # Empty pages never reach Comprehend, and pages go out with LanguageCode en.
    assert sorted(call[0] for call in redact.comprehend.calls) == sorted([page_one, page_two])
    assert {call[1] for call in redact.comprehend.calls} == {'en'}


def test_one_failing_page_fails_the_whole_batch(redact):
    # The second fail-open layer, also closed: a page-level error must not
    # fall back to that page's original unredacted text.
    redact.comprehend.failing_texts = {'bad page'}
    with pytest.raises(RuntimeError):
        redact.redactor.redact_pii_from_texts(['good page', 'bad page'])


# --- lambda_handler: the ddb-service round trip ------------------------------

def scripted_ddb(get=None, save=None, student_name=''):
    """Canned ddb-service responses keyed by operation."""
    def handle(payload):
        if payload['operation'] == 'get_student_name':
            if isinstance(student_name, dict):  # a scripted failure response
                return student_name
            return {'statusCode': 200, 'body': json.dumps({'name': student_name})}
        return {'get_ocr_data': get, 'save_ocr_data': save}[payload['operation']]
    return handle


def wire(redact, monkeypatch, get=None, save=OK_SAVE, student_name=''):
    fake = FakeLambdaClient(scripted_ddb(get=get, save=save, student_name=student_name))
    monkeypatch.setattr(redact.module, 'boto3', ScopedBoto3(fake))
    return fake


def ok_get(ocr_data):
    return {'statusCode': 200, 'body': json.dumps({'data': ocr_data})}


def test_handler_round_trip_saves_redacted_pages(redact, monkeypatch):
    page = 'Maria Lopez, SSN 123-45-6789.'
    redact.comprehend.entities_by_text[page] = [
        entity(page, 'Maria Lopez', 'NAME'), entity(page, '123-45-6789', 'SSN')]
    fake = wire(redact, monkeypatch, get=ok_get({'pages': [{'markdown': page}]}))

    result = redact.module.lambda_handler(
        {**IDS, 'ddb_service_arn': DDB_SERVICE, 'progress': 20,
         'current_step': 'ocr_complete', 's3_bucket': 'iep-uploads'}, None)

    assert [name for name, _ in fake.invocations] == [DDB_SERVICE] * 3
    get_payload, = fake.payloads('get_ocr_data')
    assert get_payload['params'] == {**IDS, 'data_type': 'ocr_result'}
    name_payload, = fake.payloads('get_student_name')
    # IDs only: the name is read inside the ddb-service, never carried in an
    # event that Step Functions would keep for 90 days.
    assert name_payload['params'] == {'user_id': IDS['user_id'],
                                      'child_id': IDS['child_id']}
    save_payload, = fake.payloads('save_ocr_data')
    assert save_payload['params']['data_type'] == 'redacted_ocr_result'
    saved = save_payload['params']['ocr_data']
    assert saved['pages'][0]['markdown'] == '[NAME], SSN [SSN].'

    assert result['redaction_status'] == 'completed'
    assert result['redacted_pages'] == 1
    assert result['redaction_stats']['redacted_entities'] == 2  # the name too
    assert result['s3_bucket'] == 'iep-uploads'  # inputs pass through
    # progress/current_step belong to the state machine and must be stripped
    assert 'progress' not in result
    assert 'current_step' not in result


def test_handler_redacts_single_text_documents(redact, monkeypatch):
    text = 'SSN 123-45-6789'
    redact.comprehend.entities_by_text[text] = [entity(text, '123-45-6789', 'SSN')]
    fake = wire(redact, monkeypatch, get=ok_get({'text': text}))

    redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)

    save_payload, = fake.payloads('save_ocr_data')
    assert save_payload['params']['ocr_data'] == {'text': 'SSN [SSN]'}


def test_comprehend_failure_never_stores_a_redacted_result(redact, monkeypatch):
    # End to end fail-closed: the lambda raises (so Step Functions retries
    # and eventually records the failure) and, crucially, nothing gets
    # written back as redacted_ocr_result.
    redact.comprehend.fail_always = True
    fake = wire(redact, monkeypatch,
                get=ok_get({'pages': [{'content': 'SSN 123-45-6789'}]}))
    with pytest.raises(Exception):
        redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)
    assert fake.payloads('save_ocr_data') == []


@pytest.mark.parametrize('get_response', [
    {'statusCode': 500, 'body': json.dumps({'error': 'boom'})},
    {'body': json.dumps({'data': {}})},          # shape drift: no statusCode
    {'statusCode': 200, 'body': json.dumps({})},  # shape drift: no data key
])
def test_handler_fails_loudly_when_the_ocr_fetch_breaks(redact, monkeypatch, get_response):
    fake = wire(redact, monkeypatch, get=get_response)
    with pytest.raises(Exception):
        redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)
    assert fake.payloads('save_ocr_data') == []


def test_handler_fails_when_the_save_is_rejected(redact, monkeypatch):
    page = 'SSN 123-45-6789'
    redact.comprehend.entities_by_text[page] = [entity(page, '123-45-6789', 'SSN')]
    wire(redact, monkeypatch, get=ok_get({'pages': [{'content': page}]}),
         save={'statusCode': 500, 'body': json.dumps({'error': 'boom'})})
    with pytest.raises(Exception):
        redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)


def test_handler_rejects_an_unrecognized_ocr_shape(redact, monkeypatch):
    fake = wire(redact, monkeypatch, get=ok_get({'summary_snippet': 'short'}))
    with pytest.raises(Exception):
        redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)
    assert fake.payloads('save_ocr_data') == []


def test_outer_catch_all_never_logs_the_rejected_value(redact, monkeypatch, capsys):
    """The outermost catch-all used to print(str(e)) and
    traceback.format_exc() verbatim -- the last uncovered path by which a
    rejected value could reach CloudWatch after f48b08f's fixes elsewhere in
    the pipeline. The ddb-service invoke is made to fail directly (rather
    than routing the sentinel through Comprehend) so this pins only the
    outer handler.py catch-all rather than comprehend_redactor.py's own
    internal catches, which have their own coverage below."""
    def _boom(payload):
        raise Exception(SENTINEL)
    fake = FakeLambdaClient(_boom)
    monkeypatch.setattr(redact.module, 'boto3', ScopedBoto3(fake))

    with pytest.raises(Exception):
        redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'Traceback (most recent call last)' not in logged
    assert 'Exception' in logged  # the class name survives


# --- comprehend_redactor's own catches --------------------------------------
#
# This module's input IS OCR text -- redacting it is the whole job -- so an
# exception raised in here is a direct route for a child's document into
# CloudWatch. boto3 and threading exceptions both quote the value they choked
# on. Both sites printed it verbatim until this was fixed; the two tests below
# are what stop it coming back.

def _comprehend_raises_sentinel(redact):
    """Make the next detect_pii_entities blow up carrying the sentinel."""
    def _boom(Text, LanguageCode):
        raise RuntimeError(SENTINEL)
    redact.comprehend.detect_pii_entities = _boom


def test_single_text_failure_never_logs_the_text_it_choked_on(redact, capsys):
    _comprehend_raises_sentinel(redact)

    with pytest.raises(RuntimeError):
        redact.redactor.redact_single_text('SSN 123-45-6789')

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    # The class name is the triage signal that must survive: without it the
    # line says a redaction failed and nothing about why.
    assert 'RuntimeError' in logged


def test_page_failure_never_logs_the_text_it_choked_on(redact, capsys):
    _comprehend_raises_sentinel(redact)

    with pytest.raises(RuntimeError):
        redact.redactor.redact_pii_from_texts(['page one', 'page two'])

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'RuntimeError' in logged
    # The page index is safe and worth keeping -- it is how you tell a
    # one-page glitch from a document-wide failure.
    assert 'page 0' in logged


# --- the student token -------------------------------------------------------
#
# Which NAME becomes {{S}} and which becomes [NAME] is the one judgement call
# in this step. {{S}} is restored to the child's real name after processing;
# [NAME] never is. So a mention wrongly singled out tells a parent their
# child's IEP is about somebody else, and these tests pin the refusals as
# hard as the matches.

CHILD_NAME = 'Jordan Smith'


def redact_for_student(redact, text, entities, student_name=CHILD_NAME):
    redact.comprehend.entities_by_text[text] = entities
    return redact.redactor.redact_single_text(text, 'en', student_name)


def test_the_student_is_tokenized_and_every_other_name_is_not(redact):
    """The whole feature in one page: the child, a teacher who happens to
    share her first name, and a therapist who does not."""
    text = ('Jordan Smith met the goal. Teacher Jordan Brooks reported it, '
            'and Dana Whitfield provides speech therapy.')
    redacted, _, redacted_count = redact_for_student(redact, text, [
        entity(text, 'Jordan Smith', 'NAME'),
        entity(text, 'Jordan Brooks', 'NAME'),
        entity(text, 'Dana Whitfield', 'NAME'),
    ])
    assert redacted == ('{{S}} met the goal. Teacher [NAME] reported it, '
                        'and [NAME] provides speech therapy.')
    assert redacted_count == 3
    # The teacher's first name is the child's. It must not come back as the
    # child at the end of the pipeline.
    assert redacted.count('{{S}}') == 1


@pytest.mark.parametrize('spelling', [
    'Jordan Smith', 'JORDAN SMITH', 'Smith, Jordan', 'Jordan M. Smith',
])
def test_every_full_name_spelling_becomes_the_student_token(redact, spelling):
    text = f'{spelling} will receive services.'
    redacted, _, _ = redact_for_student(
        redact, text, [entity(text, spelling, 'NAME')])
    assert redacted == '{{S}} will receive services.'


@pytest.mark.parametrize('partial', ['Jordan', 'Smith', 'Jordan S.'])
def test_a_partial_name_is_withheld_rather_than_guessed(redact, partial):
    """These read [NAME] to the model, which the parsing prompt handles: the
    document is about one child, so it writes the token from context. Guessing
    here would be how a teacher's name reaches a parent as their child's."""
    text = f'{partial} attended the meeting.'
    redacted, _, _ = redact_for_student(
        redact, text, [entity(text, partial, 'NAME')])
    assert redacted == '[NAME] attended the meeting.'


def test_without_a_profile_name_every_name_is_still_redacted(redact):
    """No name saved means no mention is singled out. It does NOT mean names
    survive: that difference is the whole point of dropping NAME from the
    allowlist rather than matching the child's name and stopping there."""
    text = 'Jordan Smith and Dana Whitfield attended.'
    redacted, _, redacted_count = redact_for_student(redact, text, [
        entity(text, 'Jordan Smith', 'NAME'),
        entity(text, 'Dana Whitfield', 'NAME'),
    ], student_name=None)
    assert redacted == '[NAME] and [NAME] attended.'
    assert redacted_count == 2
    assert '{{S}}' not in redacted


@pytest.mark.parametrize('placeholder', ['', 'My Child'])
def test_the_legacy_placeholder_name_is_not_matched(redact, placeholder):
    """'My Child' is what getProfile used to create for every new parent, and
    real production profiles still carry it."""
    text = 'My Child and Jordan Smith attended.'
    redacted, _, _ = redact_for_student(redact, text, [
        entity(text, 'My Child', 'NAME'),
        entity(text, 'Jordan Smith', 'NAME'),
    ], student_name=placeholder)
    assert redacted == '[NAME] and [NAME] attended.'


def test_the_batch_counts_the_tokens_it_emitted(redact):
    page_one = 'Jordan Smith reads at grade level.'
    page_two = 'Smith, Jordan is supported by Dana Whitfield.'
    redact.comprehend.entities_by_text = {
        page_one: [entity(page_one, 'Jordan Smith', 'NAME')],
        page_two: [entity(page_two, 'Smith, Jordan', 'NAME'),
                   entity(page_two, 'Dana Whitfield', 'NAME')],
    }
    redacted, stats = redact.redactor.redact_pii_from_texts(
        [page_one, page_two], student_name=CHILD_NAME)

    assert redacted == ['{{S}} reads at grade level.',
                        '{{S}} is supported by [NAME].']
    # 0 here on a document whose parent saved a name is the signal that the
    # strict match recognised no spelling: safe, but worth seeing.
    assert stats['student_tokens'] == 2
    assert stats['redacted_entities'] == 3


def test_no_spelling_of_the_child_name_reaches_what_the_parsing_step_reads(
        redact, monkeypatch):
    """The property that matters, asserted as an absence.

    redacted_ocr_result is what the parsing agent reads and what every
    translation is built from, and DeleteOriginal purges the raw copies right
    after this step, so this payload is the only text about the child that
    persists.
    """
    page = ('JORDAN SMITH (Smith, Jordan) met with Jordan Brooks. '
            'Jordan Smith will continue speech therapy.')
    redact.comprehend.entities_by_text[page] = [
        entity(page, 'JORDAN SMITH', 'NAME'),
        entity(page, 'Smith, Jordan', 'NAME'),
        entity(page, 'Jordan Brooks', 'NAME'),
        {'Type': 'NAME', 'Score': 0.99,
         'BeginOffset': page.rindex('Jordan Smith'),
         'EndOffset': page.rindex('Jordan Smith') + len('Jordan Smith')},
    ]
    fake = wire(redact, monkeypatch, get=ok_get({'pages': [{'markdown': page}]}),
                student_name=CHILD_NAME)

    redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)

    save_payload, = fake.payloads('save_ocr_data')
    stored = json.dumps(save_payload['params']['ocr_data'])
    for fragment in ('Jordan', 'JORDAN', 'Smith', 'SMITH', 'Brooks'):
        assert fragment not in stored
    assert stored.count('{{S}}') == 3
    assert '[NAME]' in stored


def test_a_failed_name_lookup_degrades_instead_of_failing_the_document(
        redact, monkeypatch, capsys):
    """Failing here would delete a parent's original document over a lookup
    that only ever improves precision: every name is redacted with or without
    it, and the parsing prompt still asks for the token from context."""
    page = 'Jordan Smith met the goal.'
    redact.comprehend.entities_by_text[page] = [entity(page, 'Jordan Smith', 'NAME')]
    fake = wire(redact, monkeypatch, get=ok_get({'pages': [{'markdown': page}]}),
                student_name={'statusCode': 500,
                              'body': json.dumps({'error': 'profile table throttled'})})

    result = redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)

    save_payload, = fake.payloads('save_ocr_data')
    stored = json.dumps(save_payload['params']['ocr_data'])
    assert 'Jordan' not in stored and 'Smith' not in stored
    assert '{{S}}' not in stored  # nothing singled out
    assert result['redaction_status'] == 'completed'
    assert 'without a targeted token' in capsys.readouterr().out


def test_a_raising_name_lookup_never_logs_what_it_choked_on(redact, monkeypatch, capsys):
    """This call's RESPONSE carries the child's name, so an exception from it
    is a direct route for that name into CloudWatch."""
    page = 'Jordan Smith met the goal.'
    redact.comprehend.entities_by_text[page] = [entity(page, 'Jordan Smith', 'NAME')]

    def handle(payload):
        if payload['operation'] == 'get_student_name':
            raise RuntimeError(SENTINEL)
        return {'get_ocr_data': ok_get({'pages': [{'markdown': page}]}),
                'save_ocr_data': OK_SAVE}[payload['operation']]
    fake = FakeLambdaClient(handle)
    monkeypatch.setattr(redact.module, 'boto3', ScopedBoto3(fake))

    redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)

    logged = capsys.readouterr().out
    assert SENTINEL not in logged
    assert 'RuntimeError' in logged  # the class name survives for triage


def test_the_step_output_never_carries_the_child_name(redact, monkeypatch):
    """Step Functions keeps execution input and output for 90 days, outside
    every deletion path this project has."""
    page = 'Jordan Smith met the goal.'
    redact.comprehend.entities_by_text[page] = [entity(page, 'Jordan Smith', 'NAME')]
    wire(redact, monkeypatch, get=ok_get({'pages': [{'markdown': page}]}),
         student_name=CHILD_NAME)

    result = redact.module.lambda_handler({**IDS, 'ddb_service_arn': DDB_SERVICE}, None)

    assert 'Jordan' not in json.dumps(result) and 'Smith' not in json.dumps(result)
    assert result['redaction_stats']['student_tokens'] == 1
