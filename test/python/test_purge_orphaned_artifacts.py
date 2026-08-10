"""scripts/purge-orphaned-artifacts.py tests.

This script deletes FERPA-protected data, so the tests exist mainly to prove
the guards hold. The failure mode that matters is not "missed an orphan", it is
"deleted a live family's summary", and every guard below is what stands between
those two.
"""
import importlib.util
import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO_ROOT, 'scripts', 'purge-orphaned-artifacts.py')


@pytest.fixture(scope='module')
def purge():
    spec = importlib.util.spec_from_file_location('purge_orphaned_artifacts', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules['purge_orphaned_artifacts'] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop('purge_orphaned_artifacts', None)


def obj(key, size=100):
    return {'Key': key, 'Size': size}


def row(iep_id, child_id='child-1', status='PROCESSED', content_key=None):
    item = {'iepId': iep_id, 'childId': child_id, 'status': status}
    if content_key:
        item['contentS3Reference'] = {'bucket': 'b', 's3Key': content_key}
    return item


# ---------------------------------------------------------------------------
# Guards

def test_empty_table_scan_never_orphans_the_whole_bucket(purge):
    """An empty scan is always a broken read. Not overridable, even with the flag."""
    objects = [obj('iep-data/iep-1/child-1/content.json')]
    with pytest.raises(SystemExit, match='no rows at all'):
        purge.group_orphans(objects, [])
    with pytest.raises(SystemExit, match='no rows at all'):
        purge.group_orphans(objects, [], allow_high_ratio=True)


def test_high_orphan_ratio_blocks_until_explicitly_allowed(purge):
    """Staging legitimately trips this; prod tripping it means a broken read."""
    objects = [obj(f'iep-data/iep-{n}/child-1/content.json') for n in range(10)]
    rows = [row('iep-0')]  # 9 of 10 groups orphaned

    with pytest.raises(SystemExit, match='over the 75% guard'):
        purge.group_orphans(objects, rows)

    allowed = purge.group_orphans(objects, rows, allow_high_ratio=True)
    assert len(allowed) == 9
    assert 'iep-0' not in allowed


def test_artifacts_of_a_live_row_are_never_targeted(purge):
    objects = [obj('iep-data/iep-live/child-1/content.json'),
               obj('iep-audio/iep-live/child-1/en/summary-a.mp3'),
               obj('iep-data/iep-gone/child-1/content.json')]
    orphans = purge.group_orphans(objects, [row('iep-live'), row('iep-other')])
    assert list(orphans) == ['iep-gone']


def test_a_key_referenced_by_a_live_row_survives_even_without_its_own_row(purge):
    """contentS3Reference is the authority, not the iepId in the key.

    The 2026-06-22 bucket recovery rewrote these pointers, so a row's content
    can legitimately sit under a different iepId's path. Judging by key alone
    would blank a real family's summary.
    """
    referenced = 'iep-data/iep-orphan-looking/child-1/content.json'
    objects = [obj(referenced),
               obj('iep-data/iep-orphan-looking/child-1/stale.json'),
               obj('iep-data/iep-truly-gone/child-1/content.json')]
    # Enough groups with live rows to stay under the ratio guard, so this test
    # exercises the reference protection rather than tripping a different one.
    objects += [obj(f'iep-data/iep-live-{n}/child-1/content.json') for n in range(6)]
    rows = [row('iep-live', content_key=referenced)]
    rows += [row(f'iep-live-{n}') for n in range(6)]

    orphans = purge.group_orphans(objects, rows)

    flat = [k for items in orphans.values() for k, _ in items]
    assert referenced not in flat, 'deleted content a live row still points at'
    assert 'iep-data/iep-truly-gone/child-1/content.json' in flat
    assert 'iep-data/iep-orphan-looking/child-1/stale.json' in flat


# ---------------------------------------------------------------------------
# Leftover unredacted originals

def test_leftover_originals_exclude_derived_artifacts(purge):
    objects = [obj('iep-data/iep-1/child-1/content.json'),
               obj('iep-audio/iep-1/child-1/en/s.mp3'),
               obj('user-9/child-1/iep-7/Psych eval SURNAME, B.doc', size=2048)]
    found = purge.find_leftover_originals(objects, [row('iep-7', status='FAILED')])
    assert len(found) == 1
    assert found[0]['iepId'] == 'iep-7'
    assert found[0]['rowStatus'] == 'FAILED'


def test_leftover_original_with_no_row_is_still_reported(purge):
    objects = [obj('user-9/child-1/iep-nobody/file.pdf')]
    found = purge.find_leftover_originals(objects, [row('iep-other')])
    assert found[0]['rowStatus'] == '(no row)'


def test_a_statusless_row_reports_as_no_status_not_as_missing(purge):
    objects = [obj('user-9/child-1/iep-7/file.pdf')]
    found = purge.find_leftover_originals(objects, [{'iepId': 'iep-7', 'childId': 'c'}])
    assert found[0]['rowStatus'] == 'NO_STATUS'


def test_reported_fields_never_carry_the_upload_filename(purge):
    """The final key segment is the student's filename."""
    objects = [obj('user-9/child-1/iep-7/Psych eval SURNAME, B.doc')]
    found = purge.find_leftover_originals(objects, [row('iep-7')])
    printed = {k: v for k, v in found[0].items() if k != 'key'}
    assert 'SURNAME' not in json.dumps(printed)
    assert '.doc' not in json.dumps(printed)
    # The key is retained for the delete call, but is not a printed field.
    assert found[0]['key'].endswith('.doc')


# ---------------------------------------------------------------------------
# Environment isolation

def test_prod_discovery_rejects_staging_tables(purge, monkeypatch):
    """A prod run resolving staging's table would judge prod objects against
    staging's rows and delete nearly all of them."""
    monkeypatch.setattr(purge, 'find_one', purge.find_one)
    names = ['AIEPStagingStack-ChatbotAPIstagingIepDocumentsTable-x']
    with pytest.raises(SystemExit):
        purge.find_one(names, 'AIEPStack', 'IepDocumentsTable',
                       forbid=('Staging', 'staging'))
    # staging resolves fine against the same list
    assert purge.find_one(names, 'AIEPStagingStack', 'IepDocumentsTable') == names[0]
