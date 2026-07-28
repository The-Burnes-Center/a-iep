/**
 * create-auth-challenge issues the language-handshake round, then generates
 * and texts the OTP. The AWS SDK v3 modules are provided by the Lambda
 * runtime and not vendored in the repo, so they are mocked as virtual
 * modules here.
 *
 * The error-shape test is the contract from the 2026-07 OTP incident: when
 * SMS delivery fails, publicChallengeParameters.error must carry a message
 * the frontend surfaces (before the fix it was silently swallowed while the
 * UI claimed "code sent").
 *
 * The DynamoDB mock serves two consumers: messages.js resolves the user's
 * language (GetCommand on the profiles table) and the handler counts SMS
 * sends against the hourly per-phone budget (UpdateCommand on the
 * OTP_RATE_LIMIT_TABLE counter).
 */
const mockSnsSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: class {
        send(...args) { return mockSnsSend(...args); }
    },
    PublishCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class GetCommand {
        constructor(input) { this.input = input; }
    }
    class UpdateCommand {
        constructor(input) { this.input = input; }
    }
    return {
        GetCommand,
        UpdateCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
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

const RATE_LIMITED_SHAPE = {
    error: 'Too many verification codes requested. Please wait an hour and try again.',
};

const updateCalls = () => mockDdbSend.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);

describe('create-auth-challenge', () => {
    beforeEach(() => {
        mockSnsSend.mockResolvedValue({ MessageId: 'msg-1' });
        // Profile lookups miss; the rate-limit counter reports a first send.
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 1 } };
            return {};
        });
        process.env.OTP_RATE_LIMIT_TABLE = 'test-otp-rate-limit';
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
        // A round that sends nothing must not consume the SMS budget either.
        expect(mockDdbSend).not.toHaveBeenCalled();
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
        // verify-auth-challenge enforces the 5-minute expiry from this stamp
        // (it never sees the session array, so it must ride here).
        expect(event.response.privateChallengeParameters.issuedAt).toBe(metadata.timestamp);
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
        const previous = otpMetadata('654321', 60 * 1000);
        const event = await handler(baseEvent([HANDSHAKE_PASS, {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: previous,
        }]));
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('654321');
        expect(mockSnsSend).not.toHaveBeenCalled();

        // The reuse round must carry the ORIGINAL issuance stamp: re-stamping
        // would slide the expiry window on every retry. And a round that
        // texts nothing must not consume the SMS budget.
        const originalTimestamp = JSON.parse(previous).timestamp;
        expect(event.response.privateChallengeParameters.issuedAt).toBe(originalTimestamp);
        expect(JSON.parse(event.response.challengeMetadata).timestamp).toBe(originalTimestamp);
        expect(updateCalls()).toHaveLength(0);
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

    test('each fresh OTP counts against the hourly per-phone budget in DynamoDB', async () => {
        await handler(baseEvent([HANDSHAKE_PASS]));

        const updates = updateCalls();
        expect(updates).toHaveLength(1);
        const { TableName, Key, UpdateExpression } = updates[0][0].input;
        expect(TableName).toBe('test-otp-rate-limit');
        expect(UpdateExpression).toContain('ADD smsCount');
        // Keys are sha256(phone) + hour bucket; raw numbers never hit the table.
        expect(Key.pk).toMatch(/^[0-9a-f]{64}#\d+$/);
        expect(Key.pk).not.toContain(PHONE.slice(1));
    });

    test('an exhausted SMS budget blocks the send with the rate-limit error shape', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 6 } };
            return {};
        });
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters).toEqual(RATE_LIMITED_SHAPE);
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
    });

    test('the budget boundary: the 5th send of the hour still goes out', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 5 } };
            return {};
        });
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
    });

    test('a DynamoDB outage fails open: the login SMS still goes out', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) throw new Error('DynamoDB unavailable');
            return {};
        });
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
    });

    test('no rate-limit table configured skips the check but still texts', async () => {
        delete process.env.OTP_RATE_LIMIT_TABLE;
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(updateCalls()).toHaveLength(0);
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
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
