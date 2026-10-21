/**
 * The login SMS ends in a domain-bound code line: a blank line, then
 * `@<host> #<code>`, last, with one space before the `#` and nothing after
 * the code. That is what Apple's domain-bound codes and the W3C WebOTP API
 * read, and getting it subtly wrong (a trailing newline, a second space, the
 * line not last) makes the phone ignore it with no error anywhere.
 *
 * The body copy above the line is not touched; the existing message-copy
 * suite keeps pinning that against the bare template.
 */
// messages.js builds its DynamoDB client at load. This suite never reads a
// profile, so stub the SDK rather than constructing the real client here.
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
    GetCommand: class {},
}), { virtual: true });

const {
    getMessages,
    getOtpLoginSms,
    SUPPORTED_LANGUAGES,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');
const { smsSegments } = require('./sms-segments');

const CODE = '482913';
const MINUTES = 5;

const fill = (template) => template
    .replaceAll('{code}', CODE)
    .replaceAll('{minutes}', String(MINUTES));

describe('getOtpLoginSms with OTP_SMS_DOMAIN set', () => {
    beforeEach(() => { process.env.OTP_SMS_DOMAIN = 'a-iep.org'; });
    afterEach(() => { delete process.env.OTP_SMS_DOMAIN; });

    test.each(SUPPORTED_LANGUAGES)('%s ends with exactly "@a-iep.org #<code>"', (lang) => {
        const message = fill(getOtpLoginSms(lang));

        // The whole tail, exact: no trailing newline or space, one space
        // before the #, a blank line ahead of it.
        expect(message.endsWith(`\n\n@a-iep.org #${CODE}`)).toBe(true);
        const lines = message.split('\n');
        expect(lines[lines.length - 1]).toBe(`@a-iep.org #${CODE}`);
        expect(lines[lines.length - 2]).toBe('');
        expect(message).not.toMatch(/\s$/);
    });

    test.each(SUPPORTED_LANGUAGES)('%s keeps its existing wording above the line', (lang) => {
        const bare = getMessages(lang).otpLoginSms;
        expect(getOtpLoginSms(lang).startsWith(bare)).toBe(true);
        expect(getOtpLoginSms(lang)).toBe(`${bare}\n\n@a-iep.org #{code}`);
    });

    test('the staging host is used as given', () => {
        process.env.OTP_SMS_DOMAIN = 'dev.a-iep.org';
        expect(fill(getOtpLoginSms('en')).endsWith(`\n\n@dev.a-iep.org #${CODE}`)).toBe(true);
    });

    test.each([
        'a-iep.org #1',
        'a-iep.org\n',
        '@a-iep.org',
        'https://a-iep.org',
        'a-iep',
        ' a-iep.org',
    ])('a value that is not a hostname (%j) is ignored and logged, never sent', (bad) => {
        process.env.OTP_SMS_DOMAIN = bad;
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect(getOtpLoginSms('en')).toBe(getMessages('en').otpLoginSms);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('OTP_SMS_DOMAIN'));
        errors.mockRestore();
    });
});

describe('getOtpLoginSms with OTP_SMS_DOMAIN unset', () => {
    beforeEach(() => { delete process.env.OTP_SMS_DOMAIN; });

    test.each(SUPPORTED_LANGUAGES)('%s is the bare template: no line at all', (lang) => {
        expect(getOtpLoginSms(lang)).toBe(getMessages(lang).otpLoginSms);
        expect(getOtpLoginSms(lang)).not.toContain('@');
    });

    test('an empty value counts as unset', () => {
        process.env.OTP_SMS_DOMAIN = '';
        expect(getOtpLoginSms('en')).toBe(getMessages('en').otpLoginSms);
        delete process.env.OTP_SMS_DOMAIN;
    });
});

// The extra line costs characters, and a carrier bills per segment. These are
// pinned so the cost is a decision and not a surprise: English is GSM-7 and
// stays at one segment; Spanish, Vietnamese and Arabic (UCS-2, 70 characters
// a segment) go to two; Chinese is short enough to stay at one.
describe('what the domain-bound line costs in segments', () => {
    afterEach(() => { delete process.env.OTP_SMS_DOMAIN; });

    const EXPECTED = { en: 1, es: 2, zh: 1, vi: 2, ar: 2 };

    test.each([['a-iep.org'], ['dev.a-iep.org']])('on %s', (domain) => {
        process.env.OTP_SMS_DOMAIN = domain;
        for (const lang of SUPPORTED_LANGUAGES) {
            const { segments } = smsSegments(fill(getOtpLoginSms(lang)));
            expect({ lang, segments }).toEqual({ lang, segments: EXPECTED[lang] });
        }
    });
});
