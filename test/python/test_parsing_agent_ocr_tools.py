"""parsing_agent OCR retrieval tools: the page-number convention.

The parsing agent shows the model the whole document as blocks labelled
"Page 1:", "Page 2:", ... and then lets it pull single pages back by number.
Those two halves disagreed: the labels counted from 1, the lookups matched
Mistral's raw `pages[].index`, which counts from 0. Asking for the page the
label called 5 returned page 6, and asking for the last page returned "not
found" while page 0 quietly returned the first page.

That matters past the model's own reading: the `page_numbers` it emits into
each section are printed to parents as "Found in pages N" so they can turn to
that page in their own copy of the IEP. So the property pinned here is a round
trip - the number shown in the full text is the number the lookups accept and
the number a person counting pages would use.
"""
import sys
from types import ModuleType, SimpleNamespace

import pytest

from conftest import load_lambda_module, unload


def _install_import_stubs(monkeypatch):
    """Stand in for the parsing agent's third-party imports.

    open_ai_agent pulls in openai, openai-agents and a pydantic data model.
    CI's pytest job installs boto3 + moto + pytest only, and pydantic 2.10.6
    (the pin the agents SDK is matched against) has no wheel for the Python the
    local venv runs, so importing them for real is not an option in either
    place. None of them is reachable from the retrieval tools under test.

    function_tool is stubbed as identity on purpose: the real decorator returns
    a FunctionTool whose description is built from the docstring, so returning
    the plain function keeps both the behaviour and that docstring callable
    from a test. Everything else in the module is the deployed code.
    """
    openai_stub = ModuleType('openai')
    openai_stub.OpenAI = object

    agents_stub = ModuleType('agents')
    agents_stub.Agent = object
    agents_stub.Runner = object
    agents_stub.ModelSettings = object
    agents_stub.function_tool = lambda *args, **kwargs: (lambda fn: fn)

    exceptions_stub = ModuleType('agents.exceptions')

    class MaxTurnsExceeded(Exception):
        pass

    class ModelBehaviorError(Exception):
        pass

    exceptions_stub.MaxTurnsExceeded = MaxTurnsExceeded
    exceptions_stub.ModelBehaviorError = ModelBehaviorError
    agents_stub.exceptions = exceptions_stub

    data_model_stub = ModuleType('data_model')
    data_model_stub.SingleLanguageIEP = object

    for name, module in (('openai', openai_stub), ('agents', agents_stub),
                         ('agents.exceptions', exceptions_stub),
                         ('data_model', data_model_stub)):
        monkeypatch.setitem(sys.modules, name, module)


@pytest.fixture()
def agent_module(monkeypatch):
    _install_import_stubs(monkeypatch)
    module = load_lambda_module('metadata-handler/steps/parsing_agent',
                                'parsing_agent_open_ai_agent',
                                module_name='open_ai_agent')
    try:
        yield module
    finally:
        unload('parsing_agent_open_ai_agent')
        unload('config')  # open_ai_agent imported the real one by path


def ocr_data(page_count=4, blank=()):
    """Mistral-shaped OCR: `index` counts from 0, as the API returns it."""
    return {'pages': [{'index': i,
                       'markdown': '' if (i + 1) in blank else f'Body of page {i + 1}'}
                      for i in range(page_count)]}


def build(agent_module, data):
    agent = agent_module.OpenAIAgent(ocr_data=data, api_key='test-key')
    return SimpleNamespace(page=agent.ocr_page_tool,
                           pages=agent.ocr_multiple_pages_tool,
                           full_text=agent.ocr_text_tool)


# --- single-page lookup -----------------------------------------------------

def test_page_one_is_the_first_page(agent_module):
    tools = build(agent_module, ocr_data())
    assert tools.page(1) == 'Body of page 1'


def test_last_page_is_reachable(agent_module):
    # The 0-based lookup had no page whose index was 4, so the last page of
    # every document answered "not found".
    tools = build(agent_module, ocr_data(page_count=4))
    assert tools.page(4) == 'Body of page 4'


@pytest.mark.parametrize('page_number', [1, 2, 3, 4])
def test_every_page_matches_the_label_the_model_was_shown(agent_module, page_number):
    """The round trip: read "Page N:" in the full text, ask for N, get that."""
    tools = build(agent_module, ocr_data())
    blocks = dict(block.split(':\n', 1)
                  for block in tools.full_text().split('\n\nTotal pages:')[0].split('\n\n'))
    assert tools.page(page_number) == blocks[f'Page {page_number}']


def test_blank_pages_do_not_shift_the_numbering(agent_module):
    # Blank pages are dropped from the full text but still occupy their slot,
    # so page 4 is the 4th sheet of paper either way.
    tools = build(agent_module, ocr_data(page_count=4, blank=(2,)))
    assert 'Page 2:' not in tools.full_text()
    assert tools.page(3) == 'Body of page 3'
    assert tools.page(4) == 'Body of page 4'


@pytest.mark.parametrize('page_number', [0, -1, 5, 99])
def test_out_of_range_page_fails_cleanly(agent_module, page_number):
    # Page 0 is the one that mattered: it used to return the first page's text,
    # so an off-by-one request looked like a successful read.
    tools = build(agent_module, ocr_data(page_count=4))
    result = tools.page(page_number)
    assert result.startswith('ERROR:')
    assert 'Body of page' not in result
    assert '4 pages' in result  # tells the model the real range


def test_missing_ocr_data_reports_an_error(agent_module):
    tools = build(agent_module, {})
    assert tools.page(1).startswith('ERROR:')
    assert tools.pages([1]).startswith('ERROR:')


# --- multi-page lookup ------------------------------------------------------

def test_multiple_pages_come_back_in_the_order_asked_for(agent_module):
    tools = build(agent_module, ocr_data())
    assert tools.pages([3, 1]) == (
        'Page 3:\nBody of page 3\n\n'
        'Page 1:\nBody of page 1'
    )


def test_multiple_pages_label_each_block_with_the_number_requested(agent_module):
    tools = build(agent_module, ocr_data())
    for page_number in (1, 2, 3, 4):
        assert f'Page {page_number}:\nBody of page {page_number}' in tools.pages([page_number])


def test_out_of_range_page_in_a_batch_is_reported_not_skipped(agent_module):
    # Skipping silently handed the model fewer pages than it asked for with
    # nothing to say which ones were missing.
    tools = build(agent_module, ocr_data(page_count=4))
    result = tools.pages([1, 9])
    assert result.startswith('Page 1:\nBody of page 1')
    assert 'Page 9:\nERROR:' in result


# --- what the model is told -------------------------------------------------

def test_tool_docstrings_state_the_convention(agent_module):
    """The docstring is the tool description the model reads, so it is the
    only place the 1-based rule can be stated where the caller will see it."""
    tools = build(agent_module, ocr_data())
    for tool in (tools.page, tools.pages, tools.full_text):
        assert tool.__doc__, f'{tool.__name__} has no description for the model'
        assert '1' in tool.__doc__ and 'first page' in tool.__doc__


def test_the_prompt_states_the_convention(agent_module):
    prompt = sys.modules['config'].get_english_only_prompt()
    assert '1-based' in prompt
    assert 'first page of the document is page 1' in prompt
