/**
 * US phone numbers on the sign-in screen: how the field formats what a parent
 * types, and whether the result is a number anyone could actually have.
 *
 * The rule is the North American Numbering Plan, and it mirrors the backend's
 * (lib/chatbot-api/functions/phone-otp-auth/destination.js), which is the one
 * that decides. This copy exists so a parent who mistyped an area code is told
 * on this screen, in their language, instead of after a round trip that could
 * only answer with a generic sentence.
 */

/** A US national significant number, i.e. what is left after the +1. */
export const US_PHONE_DIGITS = 10;

/** The fixed prefix both phone fields are seeded with. */
const US_PREFIX = '+1 ';

// NXX-NXX-XXXX with N = 2-9: neither the area code nor the exchange can start
// with 0 or 1.
const NANP_NUMBER = /^[2-9]\d{2}[2-9]\d{6}$/;
// 211, 311 ... 911 are service codes, never an area code.
const NANP_SERVICE_AREA_CODE = /^[2-9]11/;

/**
 * Area codes behind +1 that are not in the United States: Canada and the
 * Caribbean and Atlantic countries that share the plan. A-IEP only texts US
 * numbers; US territories (787, 939, 340, 671, 670, 684) are deliberately
 * absent. Kept identical to NANP_OUTSIDE_US in destination.js.
 */
export const NANP_OUTSIDE_US: ReadonlySet<string> = new Set([
  // Canada
  '204', '226', '236', '249', '250', '257', '263', '273', '289', '306', '343',
  '354', '365', '367', '368', '382', '403', '416', '418', '428', '431', '437',
  '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584',
  '587', '600', '604', '613', '622', '633', '639', '647', '672', '683', '705',
  '709', '742', '753', '778', '780', '782', '807', '819', '825', '867', '873',
  '879', '902', '905', '942',
  // The Caribbean and Bermuda
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664',
  '721', '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);

/**
 * The digits a parent actually typed, with the fixed '+1 ' prefix the field is
 * seeded with taken off first.
 *
 * Everything about an empty phone field turns on this. The value is never '',
 * so the field's `required` never fires, and counting digits across the whole
 * value reads the country code's own 1 as something the parent entered, which
 * is how a blank field used to be reported as a badly formatted number.
 *
 * A single leading 1 after that is the country code typed or pasted a second
 * time ("+16175551234", "1 617..."), never the start of an area code, because
 * no area code starts with 1. Dropping it is what makes a pasted +16175551234
 * read as (617) 555-1234 rather than (161) 755-5123.
 */
export const typedUsPhoneDigits = (value: string): string => {
  const withoutPrefix = value.startsWith(US_PREFIX) ? value.slice(US_PREFIX.length) : value;
  return withoutPrefix.replace(/\D/g, '').replace(/^1/, '');
};

/** +1 (xxx) xxx-xxxx as the parent types. Shared by both sign-in forms. */
export const formatUsPhoneDisplay = (input: string): string => {
  if (input.length < US_PREFIX.length) return US_PREFIX;
  const digits = typedUsPhoneDigits(input);
  if (digits.length === 0) return US_PREFIX;
  if (digits.length <= 3) return `+1 (${digits}`;
  if (digits.length <= 6) return `+1 (${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
};

/**
 * Could a US carrier ever route this? Ten digits, an area code and exchange
 * that start 2-9, and an area code that is not a service code. The fictional
 * 555-01XX block passes, as it does on the backend: it is a valid shape, and
 * the E2E and smoke numbers live there.
 */
export const isPossibleUsNumber = (digits: string): boolean =>
  NANP_NUMBER.test(digits) && !NANP_SERVICE_AREA_CODE.test(digits);

/** Is a possible NANP number's area code one outside the United States? */
export const isOutsideUs = (digits: string): boolean => NANP_OUTSIDE_US.has(digits.slice(0, 3));

/**
 * What a phone field's value means, or which message to show under it. Told
 * apart with `'messageKey' in reading`: this app compiles without
 * strictNullChecks, which stops a boolean discriminant from narrowing.
 */
export type UsPhoneReading =
  | { e164: string }
  | {
      messageKey:
        | 'auth.errorPhoneRequired'
        | 'auth.errorPhoneFormat'
        | 'auth.errorPhoneNotReal'
        | 'auth.errorPhoneNotUs';
    };

/**
 * Read a phone field. Too few or too many digits is a formatting slip the
 * existing message covers; ten digits that no number could have gets its own
 * message, because "enter a 10-digit number" is baffling to a parent who did.
 */
export const readUsPhone = (value: string): UsPhoneReading => {
  const digits = typedUsPhoneDigits(value);
  if (digits.length === 0) return { messageKey: 'auth.errorPhoneRequired' };
  if (digits.length !== US_PHONE_DIGITS) return { messageKey: 'auth.errorPhoneFormat' };
  if (!isPossibleUsNumber(digits)) return { messageKey: 'auth.errorPhoneNotReal' };
  if (isOutsideUs(digits)) return { messageKey: 'auth.errorPhoneNotUs' };
  return { e164: `+1${digits}` };
};
