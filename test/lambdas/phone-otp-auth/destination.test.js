/**
 * One field takes a phone number or an email address and the SERVICE decides
 * which. Everything downstream trusts that decision, so this is where a
 * destination A-IEP will not send to has to be stopped: it is the only check
 * that costs nothing, and every later one costs a round trip.
 */
const {
    classifyDestination,
    destinationKey,
    isTestAddress,
    FICTIONAL_TEST_EMAIL,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/destination');

describe('classifyDestination', () => {
    beforeEach(() => {
        delete process.env.AUTH_ALLOWED_COUNTRY_CODES;
        delete process.env.TEST_EMAIL_ADDRESSES;
    });

    test.each([
        ['+15551234567'],
        [' +15551234567 '],
    ])('a US number in E.164 is an SMS destination (%s)', (input) => {
        expect(classifyDestination(input)).toEqual({
            ok: true, channel: 'sms', value: '+15551234567',
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
        expect(classifyDestination('+15551234567').ok).toBe(true);
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
        const key = destinationKey('+15551234567');
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).not.toContain('5551234567');
    });

    test('is computable from the destination alone, account or no account', () => {
        // This is what makes the lockout message safe to show to a stranger:
        // the counter is keyed the same way whether or not the destination is
        // registered, so the answer cannot be read as "this person exists".
        expect(destinationKey('+15550000000')).toBe(destinationKey('+15550000000'));
        expect(destinationKey('+15550000000')).not.toBe(destinationKey('+15550000001'));
    });
});
