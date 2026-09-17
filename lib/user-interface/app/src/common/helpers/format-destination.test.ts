/**
 * Formatting a destination for a parent to read back.
 *
 * The cases that matter are the ones that must NOT be regrouped: the code
 * screen shows whatever this returns, so a rule that reaches too far would
 * print an email address or a foreign number in a shape nobody uses.
 */
import { describe, expect, test } from 'vitest';
import { formatDestination } from './format-destination';

describe('formatDestination', () => {
  test('groups the E.164 number PasswordlessAuthForm holds', () => {
    expect(formatDestination('+18572212618')).toBe('+1-857-221-2618');
  });

  test('groups the already-punctuated number CustomLogin holds, identically', () => {
    // The two forms keep the number in different shapes; a parent comparing
    // screens should not see two different renderings of one number.
    expect(formatDestination('+1 (857) 221-2618')).toBe('+1-857-221-2618');
  });

  test('leaves an email address alone', () => {
    expect(formatDestination('parent@example.com')).toBe('parent@example.com');
  });

  test('leaves a number from outside the NANP alone', () => {
    // Ten digits after a country code is not a reason to apply +1's
    // three-three-four grouping to it.
    expect(formatDestination('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });

  test('leaves a half-typed number alone rather than grouping a prefix', () => {
    expect(formatDestination('+1 (857) 221-26')).toBe('+1 (857) 221-26');
  });

  test('leaves a +1 number with too many digits alone', () => {
    expect(formatDestination('+185722126189')).toBe('+185722126189');
  });

  test('leaves an empty destination alone', () => {
    expect(formatDestination('')).toBe('');
  });
});
