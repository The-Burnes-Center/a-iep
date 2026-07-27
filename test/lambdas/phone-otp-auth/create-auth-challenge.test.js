/**
 * create-auth-challenge issues the language-handshake round, then generates
 * and texts the OTP. The AWS SDK v3 modules are provided by the Lambda
 * runtime and not vendored in the repo, so they are mocked as virtual
 * modules here.
 *
 * The error-shape test is the contract from the 2026-07 OTP incident: when
 * SMS delivery fails, publicChallengeParameters.error must carry the exact
 * message the frontend now surfaces (before the fix it was silently
 * swallowed while the UI claimed "code sent").
 */
const mockSnsSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: class {
        send(...args) { return mockSnsSend(...args); }
    },
    PublishCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

// messages.js lazily builds a DynamoDB client for profile-based language
// lookups; keep it inert so no test ever needs (or hits) the network.
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
    GetCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/create-auth-challenge');
const { getMessages } = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');

const PHONE = '+15555550100';

const HANDSHAKE_PASS = {
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: true,
    challengeMetadata: 'LANGUAGE_HANDSHAKE',
};

const baseEvent = (session, extra = {}) => ({
    userName: 'test-user',
    request: { userAttributes: { phone_number: PHONE }, session, ...extra },
    response: {},
});

const otpMetadata = (code, ageMs = 0) => JSON.stringify({
    code,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    phoneNumber: PHONE,
    attempt: 2,
});

const ERROR_SHAPE = {
    error: 'Failed to send verification code. Please try again.',
};

describe('create-auth-challenge', () => {
    beforeEach(() => {
        mockSnsSend.mockResolvedValue({ MessageId: 'msg-1' });
        delete process.env.USER_PROFILES_TABLE;
    });

    test('round 1 is a language handshake and sends no SMS', async () => {
        const event = await handler(baseEvent([]));
        expect(event.response.publicChallengeParameters).toEqual({
            challengeType: 'LANGUAGE_HANDSHAKE',
            phone_number: PHONE,
        });
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('LANGUAGE_HANDSHAKE');
        expect(event.response.challengeMetadata).toBe('LANGUAGE_HANDSHAKE');
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('round 2 generates a 6-digit OTP and texts it once', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS]));

        const code = event.response.privateChallengeParameters.secretLoginCode;
        expect(code).toMatch(/^\d{6}$/);
        expect(mockSnsSend).toHaveBeenCalledTimes(1);

        const publish = mockSnsSend.mock.calls[0][0].input;
        expect(publish.PhoneNumber).toBe(PHONE);
        expect(publish.Message).toContain(code);
        expect(publish.MessageAttributes['AWS.SNS.SMS.SMSType'].StringValue).toBe('Transactional');
        expect(publish.MessageAttributes['AWS.SNS.SMS.MaxPrice'].StringValue).toBe('0.50');

        // Metadata must round-trip for the reuse/expiry logic downstream.
        const metadata = JSON.parse(event.response.challengeMetadata);
        expect(metadata.code).toBe(code);
        expect(metadata.attempt).toBe(2);
        expect(new Date(metadata.timestamp).getTime()).not.toBeNaN();
        expect(event.response.publicChallengeParameters).toEqual({ phone_number: PHONE });
    });

    test('the OTP SMS is localized from RespondToAuthChallenge clientMetadata', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS], { clientMetadata: { language: 'es' } }));
        const code = event.response.privateChallengeParameters.secretLoginCode;
        const expected = getMessages('es').otpLoginSms.replace('{code}', code).replace('{minutes}', 5);
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(expected);
    });

    test('falls back to English when no language is resolvable', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        const code = event.response.privateChallengeParameters.secretLoginCode;
        const expected = getMessages('en').otpLoginSms.replace('{code}', code).replace('{minutes}', 5);
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(expected);
    });

    test('reuses the previous OTP inside the 5-minute window without re-texting', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS, {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: otpMetadata('654321', 60 * 1000),
        }]));
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('654321');
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('generates and texts a fresh OTP once the previous one expired', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS, {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: otpMetadata('654321', 6 * 60 * 1000),
        }]));
        expect(event.response.privateChallengeParameters.secretLoginCode).not.toBe('654321');
        expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
    });

    test('SNS failure produces the error challenge shape instead of throwing', async () => {
        mockSnsSend.mockRejectedValue(new Error('SNS is down'));
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(JSON.parse(event.response.challengeMetadata).error).toBe('SNS is down');
    });

    test('a phone number not in E.164 format is rejected before any SMS', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS], { userAttributes: { phone_number: '5551234567' } }));
        expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('a missing phone number is rejected before any SMS', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS], { userAttributes: {} }));
        expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(mockSnsSend).not.toHaveBeenCalled();
    });
});
