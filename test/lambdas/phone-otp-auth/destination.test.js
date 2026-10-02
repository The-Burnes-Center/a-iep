/**
 * One field takes a phone number or an email address and the SERVICE decides
 * which. Everything downstream trusts that decision, so this is where a
 * destination A-IEP will not send to has to be stopped: it is the only check
 * that costs nothing, and every later one costs a round trip.
 */
const fs = require('fs');
const path = require('path');
const {
    classifyDestination,
    destinationKey,
    isTestAddress,
    phoneNumberProblem,
    FICTIONAL_TEST_EMAIL,
    NANP_OUTSIDE_US,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/destination');

/**
 * A +1 number has to be one the North American Numbering Plan could assign:
 * ten digits, NXX-NXX-XXXX, N being 2-9, and no N11 service code as the area
 * code. E.164 alone let an area code starting 0 create a confirmed account in
 * production and spend a text on it.
 */
describe('phoneNumberProblem: the NANP rule for +1 numbers', () => {
    beforeEach(() => {
        delete process.env.AUTH_ALLOWED_COUNTRY_CODES;
    });

    test.each([
        ['an ordinary Boston number', '+16175551234'],
        ['the lowest possible area code and exchange', '+12002000000'],
        ['the highest possible area code and exchange', '+19999999999'],
        // 555 is an ordinary NXX in both positions. The E2E and smoke numbers
        // live here, so if this ever fails the staging suite goes with it.
        ['the E2E login user', '+15555550111'],
        ['the staging smoke user', '+15555550101'],
        ['the production smoke user', '+15555550102'],
        ['the smoke test unknown-number probe', '+15555550123'],
        ['the delete/re-signup pool', '+15555550129'],
        // N11 is only refused as an AREA code, where it is a service code.
        ['an exchange of 411', '+16174111234'],
    ])('%s is a number (%s)', (_label, value) => {
        expect(phoneNumberProblem(value)).toBeNull();
    });

    test.each([
        // The production signup that prompted this rule.
        ['an area code starting 0', '+10185551234', 'nanp-area-code'],
        ['an area code starting 1', '+11175551234', 'nanp-area-code'],
        ['the 911 area code', '+19115551234', 'nanp-service-code'],
        ['the 411 area code', '+14115551234', 'nanp-service-code'],
        ['the 211 area code', '+12115551234', 'nanp-service-code'],
        ['an exchange starting 0', '+12020551234', 'nanp-exchange'],
        ['an exchange starting 1', '+12021551234', 'nanp-exchange'],
        ['nine national digits', '+1617555123', 'nanp-length'],
        ['eleven national digits', '+161755512345', 'nanp-length'],
        ['a doubled country code', '+116175551234', 'nanp-length'],
    ])('%s is refused (%s)', (_label, value, reason) => {
        expect(phoneNumberProblem(value)).toBe(reason);
    });

    test.each([
        ['no leading plus', '16175551234'],
        ['letters', '+1617555abcd'],
        ['a leading zero country code', '+06175551234'],
        ['not a string', 16175551234],
        ['undefined', undefined],
    ])('%s is not E.164 at all', (_label, value) => {
        expect(phoneNumberProblem(value)).toBe('bad-phone-format');
    });

    test('a non-+1 number is judged as E.164 only; the allowlist refuses it', () => {
        // Outside NANP there is no fixed length to hold a number to, so this
        // rule stays out of the way and the country-code allowlist decides.
        expect(phoneNumberProblem('+442071234567')).toBeNull();
        expect(classifyDestination('+442071234567').code).toBe('unsupported_destination');
    });

    test('the reason marker never carries a digit of the number', () => {
        for (const value of ['+10185551234', '+19115551234', '+12020551234', '+1617555123']) {
            expect(phoneNumberProblem(value)).not.toMatch(/\d/);
        }
    });

    test('classifyDestination refuses an impossible +1 number as invalid_destination', () => {
        // invalid, not unsupported: the country is served, the number is not a
        // number. The caller sees the same generic sentence either way.
        expect(classifyDestination('+10185551234')).toEqual({
            ok: false, code: 'invalid_destination', detail: 'nanp-area-code',
        });
        expect(classifyDestination(' +12020551234 ')).toEqual({
            ok: false, code: 'invalid_destination', detail: 'nanp-exchange',
        });
    });

    test('the E2E numbers still classify as SMS destinations', () => {
        for (const value of ['+15555550111', '+15555550120', '+15555550123']) {
            expect(classifyDestination(value)).toEqual({ ok: true, channel: 'sms', value });
        }
    });
});

/**
 * A-IEP texts US numbers only. +1 also covers Canada and the Caribbean, so the
 * area code decides, and US territories must keep working.
 */
describe('phoneNumberProblem: +1 numbers outside the United States', () => {
    beforeEach(() => {
        delete process.env.AUTH_ALLOWED_COUNTRY_CODES;
    });

    test.each([
        ['Jamaica', '+18765551234'],
        ['Trinidad and Tobago', '+18685551234'],
        ['Saint Lucia', '+17585551234'],
        ['the Bahamas', '+12425551234'],
        ['the Dominican Republic', '+18095551234'],
        ['Bermuda', '+14415551234'],
        ['Toronto', '+14165551234'],
        ['Vancouver', '+16045551234'],
        ['a Canadian non-geographic code', '+16005551234'],
    ])('%s is refused (%s)', (_label, value) => {
        expect(phoneNumberProblem(value)).toBe('nanp-outside-us');
    });

    test.each([
        ['Puerto Rico', '+17875551234'],
        ['Puerto Rico overlay', '+19395551234'],
        ['the US Virgin Islands', '+13405551234'],
        ['Guam', '+16715551234'],
        ['the Northern Mariana Islands', '+16705551234'],
        ['American Samoa', '+16845551234'],
        ['Boston', '+16175551234'],
        ['Washington, DC', '+12025551234'],
    ])('%s is a US number (%s)', (_label, value) => {
        expect(phoneNumberProblem(value)).toBeNull();
        expect(classifyDestination(value)).toEqual({ ok: true, channel: 'sms', value });
    });

    test('no US territory is on the refused list', () => {
        for (const code of ['787', '939', '340', '671', '670', '684']) {
            expect(NANP_OUTSIDE_US.has(code)).toBe(false);
        }
    });

    test('the frontend refuses exactly the same area codes', () => {
        // us-phone.ts mirrors this list so a parent is told on the sign-in
        // screen. If the two drift, a parent is either refused locally for a
        // number the service would text, or sent to a server error instead.
        const source = fs.readFileSync(path.join(__dirname, '../../../lib/user-interface/app/src/common/us-phone.ts'), 'utf8');
        const literal = source.match(/NANP_OUTSIDE_US[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
        expect(literal).not.toBeNull();
        const frontend = literal[1].match(/'(\d{3})'/g).map((code) => code.slice(1, -1));
        expect(frontend).toHaveLength(new Set(frontend).size);
        expect([...frontend].sort()).toEqual([...NANP_OUTSIDE_US].sort());
    });

    test('every refused code is a well-formed area code', () => {
        for (const code of NANP_OUTSIDE_US) {
            expect(code).toMatch(/^[2-9]\d{2}$/);
            expect(code).not.toMatch(/^[2-9]11$/);
        }
    });

    test('classifyDestination calls it unsupported, not invalid: the number is real', () => {
        expect(classifyDestination('+18765551234')).toEqual({
            ok: false, code: 'unsupported_destination', detail: 'nanp-outside-us',
        });
    });

    test('the reason marker never carries a digit of the number', () => {
        expect(phoneNumberProblem('+18765551234')).not.toMatch(/\d/);
    });
});

describe('classifyDestination', () => {
    beforeEach(() => {
        delete process.env.AUTH_ALLOWED_COUNTRY_CODES;
        delete process.env.TEST_EMAIL_ADDRESSES;
    });

    test.each([
        ['+16175551234'],
        [' +16175551234 '],
    ])('a US number in E.164 is an SMS destination (%s)', (input) => {
        expect(classifyDestination(input)).toEqual({
            ok: true, channel: 'sms', value: '+16175551234',
        });
    });

    test('an address is an email destination, lowercased', () => {
        // Cognito's alias handling is case-insensitive, so a parent who typed a
        // capital has to reach the same account they created.
        expect(classifyDestination('  Parent@Example.COM ')).toEqual({
            ok: true, channel: 'email', value: 'parent@example.com',
        });
    });

    test('plus-addressing is NOT stripped', () => {
        // a+b@x.com is a different mailbox from a@x.com. Normalising them
        // together would merge two accounts.
        expect(classifyDestination('a+b@example.com').value).toBe('a+b@example.com');
    });

    test.each([
        ['nothing at all', ''],
        ['whitespace', '   '],
        ['undefined', undefined],
        ['null', null],
    ])('%s is invalid_request, not invalid_destination', (_label, input) => {
        expect(classifyDestination(input).code).toBe('invalid_request');
    });

    test.each([
        ['a number with letters in it', '+1555abc4567'],
        ['a bare local number', '5551234567'],
        ['a number with a leading zero country code', '+05551234567'],
        ['an address with no domain', 'parent@'],
        ['an address with no at sign', 'parent.example.com'],
        ['an address with a space', 'par ent@example.com'],
        ['an address with two at signs', 'a@b@example.com'],
        ['an address with a one-letter tld', 'parent@example.c'],
        ['angle brackets smuggled in', '<parent@example.com>'],
    ])('%s is refused as invalid_destination', (_label, input) => {
        expect(classifyDestination(input).code).toBe('invalid_destination');
    });

    test('an absurdly long value is refused before any expression runs', () => {
        expect(classifyDestination(`${'a'.repeat(300)}@example.com`))
            .toEqual({ ok: false, code: 'invalid_destination', detail: 'too-long' });
    });

    test('a non-+1 number is unsupported, and only its prefix is logged', () => {
        const result = classifyDestination('+255712345678');
        expect(result.code).toBe('unsupported_destination');
        // The detail goes to CloudWatch: it must carry the dialling prefix and
        // not the subscriber's number.
        expect(result.detail).toBe('prefix=+255');
        expect(result.detail).not.toContain('712345678');
    });

    test('an unset allowlist fails CLOSED to +1, it does not allow everything', () => {
        delete process.env.AUTH_ALLOWED_COUNTRY_CODES;
        expect(classifyDestination('+441632960001').code).toBe('unsupported_destination');
        expect(classifyDestination('+16175551234').ok).toBe(true);
    });

    test('a reserved TLD is refused: mail to it always hard-bounces', () => {
        // A hard bounce is how the shared SES identity's reputation is spent,
        // and that identity carries two other Burnes Center projects.
        for (const tld of ['invalid', 'test', 'example', 'localhost', 'local']) {
            const result = classifyDestination(`parent@somewhere.${tld}`);
            expect(result.code).toBe('unsupported_destination');
            expect(result.detail).toBe(`reserved-tld=${tld}`);
        }
    });

    test('a disposable-inbox domain is refused, and the domain is logged, never the local part', () => {
        const result = classifyDestination('SomeName@mailinator.com');
        expect(result.code).toBe('unsupported_destination');
        expect(result.detail).toBe('disposable=mailinator.com');
        expect(result.detail).not.toContain('somename');
    });

    test('a leading + always means "phone", so a mistyped number is told so', () => {
        // Deciding phone-vs-email on the + first is what makes the error copy
        // right: "enter a valid phone number", not "that is not an email".
        expect(classifyDestination('+1555').detail).toBe('bad-phone-format');
    });
});

describe('the staging E2E email allowlist', () => {
    afterEach(() => {
        delete process.env.TEST_EMAIL_ADDRESSES;
    });

    test('with no env var there is no allowlist at all', () => {
        // Production sets nothing, so the branch is unreachable rather than
        // merely unused.
        delete process.env.TEST_EMAIL_ADDRESSES;
        expect(isTestAddress('e2e-login@a-iep.invalid')).toBe(false);
    });

    test('an allowlisted fictional address qualifies, and skips the reserved-TLD refusal', () => {
        process.env.TEST_EMAIL_ADDRESSES = 'e2e-login@a-iep.invalid';
        expect(isTestAddress('e2e-login@a-iep.invalid')).toBe(true);
        expect(classifyDestination('e2e-login@a-iep.invalid'))
            .toEqual({ ok: true, channel: 'email', value: 'e2e-login@a-iep.invalid' });
    });

    test('a REAL address on the allowlist still fails the hard-coded domain lock', () => {
        // The second lock, and the one that matters: even a compromised or
        // fat-fingered allowlist cannot divert a real parent's code.
        process.env.TEST_EMAIL_ADDRESSES = 'parent@gmail.com,e2e-login@a-iep.invalid';
        expect(isTestAddress('parent@gmail.com')).toBe(false);
        expect(FICTIONAL_TEST_EMAIL.test('parent@gmail.com')).toBe(false);
    });

    test('a fictional-looking address NOT on the allowlist does not qualify', () => {
        process.env.TEST_EMAIL_ADDRESSES = 'e2e-login@a-iep.invalid';
        expect(isTestAddress('e2e-other@a-iep.invalid')).toBe(false);
        // And without the allowlist entry it is refused as a reserved TLD.
        expect(classifyDestination('e2e-other@a-iep.invalid').code).toBe('unsupported_destination');
    });

    test('the hard-coded expression only accepts the one reserved domain', () => {
        expect(FICTIONAL_TEST_EMAIL.test('e2e-login@a-iep.invalid')).toBe(true);
        expect(FICTIONAL_TEST_EMAIL.test('e2e-login@a-iep.org')).toBe(false);
        expect(FICTIONAL_TEST_EMAIL.test('e2e-login@a-iep.invalid.evil.com')).toBe(false);
        expect(FICTIONAL_TEST_EMAIL.test('other@a-iep.invalid')).toBe(false);
    });
});

describe('destinationKey', () => {
    test('is a sha256, so no raw destination is ever stored in a counter row', () => {
        const key = destinationKey('+16175551234');
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).not.toContain('6175551234');
    });

    test('is computable from the destination alone, account or no account', () => {
        // This is what makes the lockout message safe to show to a stranger:
        // the counter is keyed the same way whether or not the destination is
        // registered, so the answer cannot be read as "this person exists".
        expect(destinationKey('+15550000000')).toBe(destinationKey('+15550000000'));
        expect(destinationKey('+15550000000')).not.toBe(destinationKey('+15550000001'));
    });
});
