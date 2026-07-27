/**
 * messages.js owns SMS/email localization for the auth flow. The template
 * checks guard against a translation edit dropping a placeholder (which
 * would text users a code-less SMS); the resolveLanguage checks pin the
 * documented precedence: clientMetadata -> profile (loginLanguage >
 * secondaryLanguage > primaryLanguage) -> locale attribute -> English.
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    GetCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

const {
    SUPPORTED_LANGUAGES,
    getMessages,
    normalizeLanguage,
    resolveLanguage,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');

const authEvent = ({ language, locale, userName = 'user-1' } = {}) => ({
    userName,
    request: {
        userAttributes: locale ? { locale } : {},
        ...(language ? { clientMetadata: { language } } : {}),
    },
    response: {},
});

describe('normalizeLanguage', () => {
    test.each([
        ['es', 'es'],
        ['ES ', 'es'],
        [' EN', 'en'],
        ['zh', 'zh'],
        ['fr', null],
        ['', null],
        [42, null],
        [null, null],
        [undefined, null],
    ])('normalizeLanguage(%p) -> %p', (input, expected) => {
        expect(normalizeLanguage(input)).toBe(expected);
    });
});

describe('message templates', () => {
    test('every supported language has every template of the English set', () => {
        const englishKeys = Object.keys(getMessages('en')).sort();
        for (const lang of SUPPORTED_LANGUAGES) {
            expect(Object.keys(getMessages(lang)).sort()).toEqual(englishKeys);
        }
    });

    test('placeholders survive in every translation', () => {
        for (const lang of SUPPORTED_LANGUAGES) {
            const messages = getMessages(lang);
            expect(messages.otpLoginSms).toContain('{code}');
            expect(messages.otpLoginSms).toContain('{minutes}');
            expect(messages.verificationSms).toContain('{####}');
            expect(messages.authenticationSms).toContain('{####}');
            expect(messages.signUpEmailBody).toContain('{####}');
            expect(messages.forgotPasswordEmailBody).toContain('{####}');
        }
    });

    test('an unknown language falls back to English', () => {
        expect(getMessages('fr')).toBe(getMessages('en'));
        expect(getMessages(undefined)).toBe(getMessages('en'));
    });
});

describe('resolveLanguage', () => {
    beforeEach(() => {
        process.env.USER_PROFILES_TABLE = 'test-profiles-table';
        mockDdbSend.mockResolvedValue({});
    });

    test('clientMetadata wins without touching DynamoDB', async () => {
        const language = await resolveLanguage(authEvent({ language: 'vi', locale: 'es' }));
        expect(language).toBe('vi');
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('profile loginLanguage beats secondaryLanguage and primaryLanguage', async () => {
        mockDdbSend.mockResolvedValue({
            Item: { loginLanguage: 'ar', secondaryLanguage: 'zh', primaryLanguage: 'es' },
        });
        expect(await resolveLanguage(authEvent())).toBe('ar');
    });

    test('profile secondaryLanguage is used when loginLanguage is absent', async () => {
        mockDdbSend.mockResolvedValue({ Item: { secondaryLanguage: 'zh', primaryLanguage: 'es' } });
        expect(await resolveLanguage(authEvent())).toBe('zh');
    });

    test('a profile with no language fields falls back to the locale attribute', async () => {
        mockDdbSend.mockResolvedValue({ Item: { userId: 'user-1' } });
        expect(await resolveLanguage(authEvent({ locale: 'es' }))).toBe('es');
    });

    test('no profile row falls back to the locale attribute', async () => {
        mockDdbSend.mockResolvedValue({});
        expect(await resolveLanguage(authEvent({ locale: 'zh' }))).toBe('zh');
    });

    test('a DynamoDB failure falls back instead of blocking auth', async () => {
        mockDdbSend.mockRejectedValue(new Error('boom'));
        expect(await resolveLanguage(authEvent({ locale: 'es' }))).toBe('es');
        expect(await resolveLanguage(authEvent())).toBe('en');
    });

    test('without a profiles table configured, locale then English', async () => {
        delete process.env.USER_PROFILES_TABLE;
        expect(await resolveLanguage(authEvent({ locale: 'ar' }))).toBe('ar');
        expect(await resolveLanguage(authEvent())).toBe('en');
        expect(mockDdbSend).not.toHaveBeenCalled();
    });
});
