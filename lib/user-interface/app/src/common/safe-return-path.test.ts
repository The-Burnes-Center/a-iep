import { describe, expect, test } from 'vitest';
import { safeReturnPath } from './safe-return-path';

const DEFAULT = '/preferred-language';

describe('safeReturnPath', () => {
  test.each([
    '/summary',
    '/profile/children/abc/documents',
    '/iep-documents?lang=es',
    '/welcome#top',
  ])('keeps the in-app path %s', (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  test.each([
    ['another site, written without a scheme', '//example.org/summary'],
    ['a backslash in place of the second slash', '/\\example.org'],
    ['a backslash later in the path', '/summary\\..\\x'],
    ['a full URL', 'https://example.org/summary'],
    ['a script URL', 'javascript:alert(1)'],
    ['a relative path', 'summary'],
    ['an empty string', ''],
    ['a tab hidden in the slashes', '/\t/example.org'],
    ['a newline', '/summary\n'],
    ['a space', '/ /example.org'],
  ])('falls back to the default for %s', (_name, path) => {
    expect(safeReturnPath(path)).toBe(DEFAULT);
  });

  test.each([undefined, null, 42, { pathname: '/summary' }])('falls back when the value is not a string: %s', (value) => {
    expect(safeReturnPath(value)).toBe(DEFAULT);
  });

  test('falls back for an absurdly long path', () => {
    expect(safeReturnPath(`/${'a'.repeat(5000)}`)).toBe(DEFAULT);
  });

  test('uses the caller\'s fallback when given one', () => {
    expect(safeReturnPath('//example.org', '/home')).toBe('/home');
  });
});
