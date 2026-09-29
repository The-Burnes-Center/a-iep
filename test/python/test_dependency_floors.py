"""Security floors for the pinned Python lambda dependencies.

The lambda-deps CI job proves each requirements file installs and imports;
it does not notice a pin sliding back to a vulnerable release. cryptography
49.0.0 carried the highs that Amazon Inspector flagged on every pipeline
lambda, and 50.0.0 is the first release that clears them. The five files that
pin it are bundled into separate lambdas, so each one is checked, and they
must agree so no single step ships an older copy.
"""
import os
import re

import pytest

from conftest import FUNCTIONS_DIR

METADATA_HANDLER_DIR = os.path.join(FUNCTIONS_DIR, 'metadata-handler')
CRYPTOGRAPHY_FLOOR = (50, 0, 0)
PIN_PATTERN = re.compile(r'^cryptography==(\d+)\.(\d+)\.(\d+)\s*(#.*)?$')


def _requirements_files():
    found = []
    for root, _dirs, files in os.walk(METADATA_HANDLER_DIR):
        if 'requirements.txt' in files:
            found.append(os.path.join(root, 'requirements.txt'))
    return sorted(found)


def _cryptography_lines(path):
    with open(path, encoding='utf-8') as handle:
        return [line.strip() for line in handle if line.strip().lower().startswith('cryptography')]


def _pinning_files():
    return [path for path in _requirements_files() if _cryptography_lines(path)]


def test_the_known_pinning_files_are_all_found():
    relative = {os.path.relpath(path, METADATA_HANDLER_DIR) for path in _pinning_files()}
    assert relative == {
        'requirements.txt',
        os.path.join('steps', 'delete_original', 'requirements.txt'),
        os.path.join('steps', 'parsing_agent', 'requirements.txt'),
        os.path.join('steps', 'redact_ocr', 'requirements.txt'),
        os.path.join('steps', 'translate_content', 'requirements.txt'),
    }


@pytest.mark.parametrize('path', _pinning_files(), ids=lambda p: os.path.relpath(p, METADATA_HANDLER_DIR))
def test_cryptography_is_pinned_exactly_at_or_above_the_floor(path):
    lines = _cryptography_lines(path)
    assert len(lines) == 1, f'expected one cryptography pin, found {lines}'
    match = PIN_PATTERN.match(lines[0])
    assert match, f'cryptography must be an exact == pin, found {lines[0]!r}'
    version = tuple(int(part) for part in match.groups()[:3])
    assert version >= CRYPTOGRAPHY_FLOOR


def test_every_lambda_pins_the_same_cryptography():
    pins = {_cryptography_lines(path)[0].split('#')[0].strip() for path in _pinning_files()}
    assert len(pins) == 1, f'lambdas disagree on cryptography: {sorted(pins)}'
