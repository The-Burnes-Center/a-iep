/**
 * custom-message localizes the SMS/email Cognito itself sends (signup
 * verification, forgot password, SMS MFA). Contract: pick the right template
 * for each trigger source in the user's language, leave unknown sources
 * untouched (pool defaults), and never let a localization failure block the
 * auth flow.
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    GetCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/custom-message');
const { getMessages } = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');

const messageEvent = (triggerSource, { language, locale } = {}) => ({
    userName: 'user-1',
    triggerSource,
    request: {
        userAttributes: locale ? { locale } : {},
        ...(language ? { clientMetadata: { language } } : {}),
        codeParameter: '{####}',
    },
    response: {},
});

describe('custom-message', () => {
    beforeEach(() => {
        delete process.env.USER_PROFILES_TABLE;
        mockDdbSend.mockResolvedValue({});
    });

    test.each(['CustomMessage_SignUp', 'CustomMessage_ResendCode'])(
        '%s sets localized verification SMS and signup email', async (triggerSource) => {
            const event = await handler(messageEvent(triggerSource, { language: 'es' }));
            const es = getMessages('es');
            expect(event.response.smsMessage).toBe(es.verificationSms);
            expect(event.response.emailSubject).toBe(es.signUpEmailSubject);
            expect(event.response.emailMessage).toBe(es.signUpEmailBody);
        });

    test('forgot password uses the reset templates', async () => {
        const event = await handler(messageEvent('CustomMessage_ForgotPassword', { language: 'zh' }));
        const zh = getMessages('zh');
        expect(event.response.smsMessage).toBe(zh.verificationSms);
        expect(event.response.emailSubject).toBe(zh.forgotPasswordEmailSubject);
        expect(event.response.emailMessage).toBe(zh.forgotPasswordEmailBody);
    });

    test('SMS authentication sets only the sms message', async () => {
        const event = await handler(messageEvent('CustomMessage_Authentication', { language: 'vi' }));
        expect(event.response.smsMessage).toBe(getMessages('vi').authenticationSms);
        expect(event.response.emailMessage).toBeUndefined();
        expect(event.response.emailSubject).toBeUndefined();
    });

    test('the locale attribute localizes when no clientMetadata arrives', async () => {
        // Cognito does not forward InitiateAuth clientMetadata to this
        // trigger, so the signup-time locale attribute is the fallback.
        const event = await handler(messageEvent('CustomMessage_SignUp', { locale: 'ar' }));
        expect(event.response.smsMessage).toBe(getMessages('ar').verificationSms);
    });

    test('an unhandled trigger source leaves the response untouched', async () => {
        const event = await handler(messageEvent('CustomMessage_AdminCreateUser', { language: 'es' }));
        expect(event.response).toEqual({});
    });

    test('a language-lookup failure falls back to English, never throws', async () => {
        process.env.USER_PROFILES_TABLE = 'test-profiles-table';
        mockDdbSend.mockRejectedValue(new Error('DynamoDB down'));
        const event = await handler(messageEvent('CustomMessage_SignUp'));
        expect(event.response.smsMessage).toBe(getMessages('en').verificationSms);
    });
});
