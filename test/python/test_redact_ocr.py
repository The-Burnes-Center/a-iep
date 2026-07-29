"""redact_ocr step tests: the pipeline's PII firewall.

Everything downstream (parsing agents, translation, the parent-facing API)
reads redacted_ocr_result, and the very next step purges the raw OCR and the
uploaded PDF, so whatever this step writes is the only copy that persists.
Two properties carry that weight: the offset splice must remove every
non-allowlisted entity Comprehend reports, and a Comprehend failure must fail
the step (Step Functions retries, then RecordFailure purges the unredacted
artifacts) instead of passing the original text through as "redacted".
"""
import json
import sys
from types import SimpleNamespace

import pytest

from conftest import FakeLambdaClient, ScopedBoto3, load_lambda_module, unload

IDS = {'iep_id': 'iep-1', 'user_id': 'user-sub-1', 'child_id': 'child-1'}
DDB_SERVICE = 'DDBServiceTest'
OK_SAVE = {'statusCode': 200, 'body': json.dumps({'message': 'ok'})}


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
    assert redacted == 'Maria Lopez, SSN [SSN], at [ADDRESS], phone [PHONE].'
    assert redacted_count == 3
    assert dict(entity_counter) == {'NAME': 1, 'SSN': 1, 'ADDRESS': 1, 'PHONE': 1}


def test_allowlisted_name_and_date_survive_untouched(redact):
    text = 'Maria Lopez was evaluated on March 3, 2026.'
    redacted, entity_counter, redacted_count = redact_text(redact, text, [
        entity(text, 'Maria Lopez', 'NAME'),
        entity(text, 'March 3, 2026', 'DATE_TIME'),
    ])
    assert redacted == text
    assert redacted_count == 0
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
    assert redacted == 'niño José 🎉 llamó: [SSN] fin'


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

    assert redacted == ['Maria Lopez, SSN [SSN].', '', 'Call [PHONE] or [PHONE].']
    assert stats['total_entities'] == 4
    assert stats['redacted_entities'] == 3
    assert stats['allowed_entities'] == 1
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

def scripted_ddb(get=None, save=None):
    """Canned ddb-service responses keyed by operation."""
    def handle(payload):
        response = {'get_ocr_data': get, 'save_ocr_data': save}[payload['operation']]
        return response
    return handle


def wire(redact, monkeypatch, get=None, save=OK_SAVE):
    fake = FakeLambdaClient(scripted_ddb(get=get, save=save))
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

    assert [name for name, _ in fake.invocations] == [DDB_SERVICE, DDB_SERVICE]
    get_payload, = fake.payloads('get_ocr_data')
    assert get_payload['params'] == {**IDS, 'data_type': 'ocr_result'}
    save_payload, = fake.payloads('save_ocr_data')
    assert save_payload['params']['data_type'] == 'redacted_ocr_result'
    saved = save_payload['params']['ocr_data']
    assert saved['pages'][0]['markdown'] == 'Maria Lopez, SSN [SSN].'

    assert result['redaction_status'] == 'completed'
    assert result['redacted_pages'] == 1
    assert result['redaction_stats']['redacted_entities'] == 1
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
