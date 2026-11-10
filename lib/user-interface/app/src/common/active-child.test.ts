import { describe, expect, test } from 'vitest';
import { isMultiChildFamily, pathForChild, resolveActiveChild, fillTemplate } from './active-child';

const maya = { childId: 'c-maya', name: 'Maya' };
const leo = { childId: 'c-leo', name: 'Leo' };

describe('resolveActiveChild', () => {
  test('is the child the URL names, when the feature is on and it is on the profile', () => {
    expect(resolveActiveChild([maya, leo], 'c-leo', true)).toEqual({ child: leo, index: 1, requestedMissing: false });
  });

  test('ignores the URL with the feature off, so prod keeps reading the first child', () => {
    expect(resolveActiveChild([maya, leo], 'c-leo', false)?.child).toBe(maya);
  });

  test('falls back to the first child, and says so, for an id not on this profile', () => {
    expect(resolveActiveChild([maya, leo], 'someone-else', true)).toEqual({ child: maya, index: 0, requestedMissing: true });
  });

  test('is the first child when the URL names none', () => {
    expect(resolveActiveChild([maya, leo], null, true)?.child).toBe(maya);
  });

  test('is null for a profile with no children yet', () => {
    expect(resolveActiveChild([], 'c-leo', true)).toBeNull();
    expect(resolveActiveChild(undefined, null, true)).toBeNull();
  });
});

describe('isMultiChildFamily', () => {
  test('needs both the feature and a second child', () => {
    expect(isMultiChildFamily([maya, leo], true)).toBe(true);
    expect(isMultiChildFamily([maya], true)).toBe(false);
    expect(isMultiChildFamily([maya, leo], false)).toBe(false);
  });
});

describe('pathForChild', () => {
  test('carries the child for a multi-child family', () => {
    expect(pathForChild('/iep-documents', 'c-leo', true)).toBe('/iep-documents?child=c-leo');
  });

  test('leaves single-child URLs exactly as production has them', () => {
    expect(pathForChild('/iep-documents', 'c-maya', false)).toBe('/iep-documents');
  });

  test('encodes the id', () => {
    expect(pathForChild('/x', 'a b&c', true)).toBe('/x?child=a%20b%26c');
  });
});

describe('fillTemplate', () => {
  test('puts each value where the dictionary asks, every time it asks', () => {
    expect(fillTemplate('IEP de {name}', { name: 'Leo' })).toBe('IEP de Leo');
    expect(fillTemplate('{name}: {name}', { name: 'Ana' })).toBe('Ana: Ana');
    expect(fillTemplate('Child {n} of {total}', { n: '2', total: '3' })).toBe('Child 2 of 3');
  });

  test('does not treat the name as a replacement pattern', () => {
    expect(fillTemplate('{name}', { name: '$&' })).toBe('$&');
  });
});

describe('a link that names no child', () => {
  const kids = [{ childId: 'a' }, { childId: 'b' }, { childId: 'c' }];

  test('opens the child last opened in this tab, not the first', () => {
    expect(resolveActiveChild(kids, null, true, 'b')?.child.childId).toBe('b');
  });

  test('opens the first when nothing is remembered, or the remembered child is gone', () => {
    expect(resolveActiveChild(kids, null, true, null)?.child.childId).toBe('a');
    const gone = resolveActiveChild(kids, null, true, 'removed');
    expect(gone?.child.childId).toBe('a');
    expect(gone?.requestedMissing).toBe(false);
  });

  test('a child the URL names still wins over the remembered one', () => {
    expect(resolveActiveChild(kids, 'c', true, 'b')?.child.childId).toBe('c');
  });

  test('with multiChild off, every screen is about the first child as before', () => {
    expect(resolveActiveChild(kids, null, false, 'b')?.child.childId).toBe('a');
  });
});
