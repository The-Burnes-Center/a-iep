import { describe, expect, test } from 'vitest';
import { formatUsPhoneDisplay, isOutsideUs, isPossibleUsNumber, readUsPhone, typedUsPhoneDigits } from './us-phone';

/**
 * The same NANP rule the backend enforces in phone-otp-auth/destination.js,
 * checked here so a parent hears about an impossible number before a request
 * is spent on it. The backend's cases are mirrored on purpose: if the two
 * disagree, a parent is either told a real number is fake or sent to an error
 * the app cannot explain.
 */
describe('isPossibleUsNumber', () => {
  test.each([
    ['6175551234', 'an ordinary Boston number'],
    ['2002000000', 'the lowest area code and exchange'],
    ['9999999999', 'the highest area code and exchange'],
    ['5555550111', 'the E2E login user'],
    ['5555550123', 'the smoke test unknown-number probe'],
    ['6174111234', 'an exchange of 411'],
  ])('%s (%s) is possible', (digits) => {
    expect(isPossibleUsNumber(digits)).toBe(true);
  });

  test.each([
    ['0185551234', 'an area code starting 0'],
    ['1175551234', 'an area code starting 1'],
    ['9115551234', 'the 911 area code'],
    ['2115551234', 'the 211 area code'],
    ['2020551234', 'an exchange starting 0'],
    ['2021551234', 'an exchange starting 1'],
    ['617555123', 'nine digits'],
    ['61755512345', 'eleven digits'],
  ])('%s (%s) is not', (digits) => {
    expect(isPossibleUsNumber(digits)).toBe(false);
  });
});

/** Same cases as destination.test.js: +1 covers more than the United States. */
describe('isOutsideUs', () => {
  test.each([
    ['8765551234', 'Jamaica'],
    ['8685551234', 'Trinidad and Tobago'],
    ['7585551234', 'Saint Lucia'],
    ['2425551234', 'the Bahamas'],
    ['8095551234', 'the Dominican Republic'],
    ['4415551234', 'Bermuda'],
    ['4165551234', 'Toronto'],
    ['6045551234', 'Vancouver'],
  ])('%s (%s) is outside the US', (digits) => {
    expect(isOutsideUs(digits)).toBe(true);
  });

  test.each([
    ['7875551234', 'Puerto Rico'],
    ['9395551234', 'Puerto Rico overlay'],
    ['3405551234', 'the US Virgin Islands'],
    ['6715551234', 'Guam'],
    ['6705551234', 'the Northern Mariana Islands'],
    ['6845551234', 'American Samoa'],
    ['6175551234', 'Boston'],
    ['5555550111', 'the E2E login user'],
  ])('%s (%s) is a US number', (digits) => {
    expect(isOutsideUs(digits)).toBe(false);
    expect(readUsPhone(digits)).toEqual({ e164: `+1${digits}` });
  });
});

describe('readUsPhone', () => {
  test('the seeded prefix alone is blank, not badly formatted', () => {
    expect(readUsPhone('+1 ')).toEqual({ messageKey: 'auth.errorPhoneRequired' });
  });

  test('too few digits is a format problem', () => {
    expect(readUsPhone('+1 (617) 55')).toEqual({ messageKey: 'auth.errorPhoneFormat' });
  });

  test('too many digits is a format problem, not silently truncated', () => {
    // The old reader took the LAST ten digits of whatever it was given.
    expect(readUsPhone('+1 61755512345')).toEqual({ messageKey: 'auth.errorPhoneFormat' });
  });

  test('ten digits no number could have gets its own message', () => {
    expect(readUsPhone('+1 (018) 555-1234')).toEqual({ messageKey: 'auth.errorPhoneNotReal' });
    expect(readUsPhone('+1 (911) 555-1234')).toEqual({ messageKey: 'auth.errorPhoneNotReal' });
    expect(readUsPhone('+1 (202) 055-1234')).toEqual({ messageKey: 'auth.errorPhoneNotReal' });
  });

  test('a real number outside the US says so, rather than calling it fake', () => {
    expect(readUsPhone('+1 (876) 555-1234')).toEqual({ messageKey: 'auth.errorPhoneNotUs' });
    expect(readUsPhone('+1 (416) 555-1234')).toEqual({ messageKey: 'auth.errorPhoneNotUs' });
  });

  test.each([
    ['+1 (617) 555-1234', 'the formatted field'],
    ['(617) 555-1234', 'a bare formatted number'],
    ['+1 617 555 1234', 'spaced digits after the prefix'],
    ['+16175551234', 'E.164 pasted whole'],
    ['1-617-555-1234', 'a leading 1 with dashes'],
  ])('%s (%s) reads as +16175551234', (value) => {
    expect(readUsPhone(value)).toEqual({ e164: '+16175551234' });
  });
});

describe('formatUsPhoneDisplay', () => {
  test.each([
    ['', '+1 '],
    ['+1', '+1 '],
    ['+1 6', '+1 (6'],
    ['+1 6175', '+1 (617) 5'],
    ['+1 6175551234', '+1 (617) 555-1234'],
    ['(617) 555-1234', '+1 (617) 555-1234'],
    ['+1 (617) 555-1234', '+1 (617) 555-1234'],
    // Anything past ten digits is dropped as the parent types.
    ['+1 617555123499', '+1 (617) 555-1234'],
  ])('%j formats as %j', (input, expected) => {
    expect(formatUsPhoneDisplay(input)).toBe(expected);
  });

  test.each([
    ['+16175551234', 'E.164 pasted over the whole field'],
    ['+1 16175551234', 'the country code typed again after the prefix'],
    ['16175551234', 'eleven digits starting 1'],
  ])('a repeated country code is not read as an area code: %s (%s)', (input) => {
    expect(formatUsPhoneDisplay(input)).toBe('+1 (617) 555-1234');
  });

  test('an area code starting 0 is kept as typed, so the parent can see what is wrong', () => {
    expect(formatUsPhoneDisplay('+1 0185551234')).toBe('+1 (018) 555-1234');
    expect(typedUsPhoneDigits('+1 (018) 555-1234')).toBe('0185551234');
  });
});
