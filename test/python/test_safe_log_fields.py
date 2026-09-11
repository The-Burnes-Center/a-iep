"""Pins _SAFE_LOG_FIELDS across every step handler, and proves the s3_key it
deliberately excludes never reaches a log line with the parent-chosen
filename intact.

The key is userId/childId/iepId/<filename>, and parents routinely name an IEP
after their child (orchestrator.py's _safe_key docstring says so explicitly).
_SAFE_LOG_FIELDS used to list s3_key as safe, which meant every step's very
first log line -- "<Step> handler received: ..." -- printed
json.dumps(_safe_event_meta(event)), filename intact, on every successful
document. This suite is the allowlist pin the fix promises: it fails on ANY
future addition to the tuple, not just a re-added s3_key.
"""
import json
import sys
from types import ModuleType

import pytest

from conftest import install_agents_sdk_stubs, load_lambda_module, unload

# The allowlist every step handler.py is expected to share, byte for byte.
# s3_key is deliberately absent: _safe_event_meta injects it separately, run
# through _safe_key, so this tuple growing to include it again must fail here.
EXPECTED_SAFE_LOG_FIELDS = (
    'iep_id', 'child_id', 'user_id', 's3_bucket', 'current_step',
    'progress', 'status', 'content_type', 'target_languages', 'translation_needed',
)

# (directory under steps/, extra sibling modules it imports that must be
# unloaded afterwards so the next parametrized case doesn't inherit a stale
# same-named module cached from a DIFFERENT step's directory -- parsing_agent
# and translate_content each have their own real config.py/data_model.py).
STEP_HANDLERS = [
    ('check_language_prefs', ()),
    ('delete_original', ()),
    ('finalize_results', ()),
    ('mistral_ocr', ('mistral_ocr',)),
    ('parsing_agent', ('open_ai_agent', 'config')),
    ('redact_ocr', ('comprehend_redactor',)),
    ('translate_content', ('translation_agent', 'config')),
]
STEP_IDS = [name for name, _ in STEP_HANDLERS]

STUDENT_NAME = 'Jordan Smith'
FILENAME = f'{STUDENT_NAME} IEP 2026.pdf'
S3_KEY = f'user-1/child-1/iep-1/{FILENAME}'


@pytest.fixture()
def stubbed_handler(monkeypatch):
    """Loads a step handler with the third-party SDKs it may transitively
    import stubbed out (see conftest.install_agents_sdk_stubs), and a
    permissive data_model stub covering both parsing_agent's and
    translate_content's real (different) data_model.py exports -- this test
    only needs _SAFE_LOG_FIELDS and _safe_event_meta, never real validation
    behaviour.
    """
    install_agents_sdk_stubs(monkeypatch)
    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = object
    data_model_stub.SectionContent = object
    data_model_stub.TranslationSectionContent = object
    data_model_stub.AbbreviationLegend = object
    monkeypatch.setitem(sys.modules, 'data_model', data_model_stub)

    loaded = []

    def _load(step_dir, siblings):
        alias = f'safe_log_fields_{step_dir}'
        module = load_lambda_module(f'metadata-handler/steps/{step_dir}', alias,
                                    module_name='handler')
        loaded.append((alias, siblings))
        return module

    yield _load

    for alias, siblings in loaded:
        unload(alias)
        for sibling in siblings:
            unload(sibling)


@pytest.mark.parametrize('step_dir,siblings', STEP_HANDLERS, ids=STEP_IDS)
def test_safe_log_fields_allowlist_is_pinned(stubbed_handler, step_dir, siblings):
    module = stubbed_handler(step_dir, siblings)
    assert module._SAFE_LOG_FIELDS == EXPECTED_SAFE_LOG_FIELDS
    assert 's3_key' not in module._SAFE_LOG_FIELDS


@pytest.mark.parametrize('step_dir,siblings', STEP_HANDLERS, ids=STEP_IDS)
def test_safe_event_meta_redacts_the_filename_but_keeps_the_ids(stubbed_handler, step_dir, siblings):
    module = stubbed_handler(step_dir, siblings)
    event = {
        'iep_id': 'iep-1', 'child_id': 'child-1', 'user_id': 'user-1',
        's3_bucket': 'iep-uploads', 's3_key': S3_KEY,
    }

    # This is exactly what every handler's first log line prints:
    # print(f"<Step> handler received: {json.dumps(_safe_event_meta(event))}")
    logged = json.dumps(module._safe_event_meta(event))

    assert STUDENT_NAME not in logged
    assert FILENAME not in logged
    # The ids in front of the filename are exactly what an operator needs and
    # must survive -- this is a redaction, not a blanket drop of the field.
    assert 'user-1/child-1/iep-1' in logged


@pytest.mark.parametrize('step_dir,siblings', STEP_HANDLERS, ids=STEP_IDS)
def test_safe_event_meta_tolerates_a_missing_s3_key(stubbed_handler, step_dir, siblings):
    # Not every event carries s3_key (e.g. a direct invocation with only ids);
    # _safe_event_meta must not raise when it is absent.
    module = stubbed_handler(step_dir, siblings)
    meta = module._safe_event_meta({'iep_id': 'iep-1'})
    assert 's3_key' not in meta
