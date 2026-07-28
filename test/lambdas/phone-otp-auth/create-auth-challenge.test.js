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
 *
 * The SSM mock serves the staging-only E2E backdoor: allowlisted
 * NANP-fictional numbers get their OTP written to Parameter Store instead
 * of texted (see the 'staging test-number backdoor' describe).
 */
const mockSnsSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: class {
        send(...args) { return mockSnsSend(...args); }
    },
    PublishCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {
        send(...args) { return mockSsmSend(...args); }
    },
    PutParameterCommand: class {
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
const { PutParameterCommand } = require('@aws-sdk/client-ssm');
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
        mockSsmSend.mockResolvedValue({ Version: 1 });
        // Profile lookups miss; the rate-limit counter reports a first send.
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 1 } };
            return {};
        });
        process.env.OTP_RATE_LIMIT_TABLE = 'test-otp-rate-limit';
        delete process.env.USER_PROFILES_TABLE;
        // The backdoor must not exist unless a test opts in explicitly.
        delete process.env.TEST_PHONE_NUMBERS;
        delete process.env.TEST_OTP_PARAM_PREFIX;
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

    describe('staging test-number backdoor', () => {
        // Staging (lib/authorization/new-auth.ts) allowlists NANP-fictional
        // numbers whose OTPs are stashed in SSM Parameter Store for the E2E
        // runner instead of texted. Both locks are exercised here: the env
        // var allowlist AND the hard-coded fictional-block regex. The
        // allowlist below carries stray spaces on purpose (entries must be
        // trimmed) and omits the smoke user +15555550101 (smoke asserts the
        // real, non-backdoored SMS contract).
        const TEST_PHONE = '+15555550111';
        const PARAM_PREFIX = '/a-iep/staging/test-otp';

        const armBackdoor = () => {
            process.env.TEST_PHONE_NUMBERS = ' +15555550111 , +15555550112';
            process.env.TEST_OTP_PARAM_PREFIX = PARAM_PREFIX;
        };

        const eventFor = (phone, extra = {}) =>
            baseEvent([HANDSHAKE_PASS], { userAttributes: { phone_number: phone }, ...extra });

        test('an allowlisted fictional number gets its OTP stashed in SSM, never texted', async () => {
            armBackdoor();
            const event = await handler(eventFor(TEST_PHONE, { clientMetadata: { language: 'es' } }));

            // No SMS, and no draw on the hourly SMS budget: the rate-limit
            // counter meters SMS spend and nothing was transmitted.
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(updateCalls()).toHaveLength(0);

            expect(mockSsmSend).toHaveBeenCalledTimes(1);
            const put = mockSsmSend.mock.calls[0][0];
            expect(put).toBeInstanceOf(PutParameterCommand);
            // SSM parameter names forbid '+', so the E.164 prefix is
            // stripped; the E2E runner reads the same '+'-less name.
            expect(put.input.Name).toBe(`${PARAM_PREFIX}/15555550111`);
            expect(put.input.Type).toBe('String');
            expect(put.input.Overwrite).toBe(true);

            // The stash must carry the exact code the verify round will
            // accept, plus the resolved language and the issuance stamp.
            const payload = JSON.parse(put.input.Value);
            expect(payload.code).toBe(event.response.privateChallengeParameters.secretLoginCode);
            expect(payload.code).toMatch(/^\d{6}$/);
            expect(payload.language).toBe('es');
            expect(payload.issuedAt).toBe(event.response.privateChallengeParameters.issuedAt);
        });

        test('an allowlisted but NON-fictional number is still texted (the regex is the second lock)', async () => {
            // A lying/compromised allowlist must never divert a real
            // subscriber's OTP into Parameter Store.
            process.env.TEST_PHONE_NUMBERS = '+15551234567';
            process.env.TEST_OTP_PARAM_PREFIX = PARAM_PREFIX;
            const event = await handler(eventFor('+15551234567'));

            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(mockSnsSend.mock.calls[0][0].input.PhoneNumber).toBe('+15551234567');
            // The real send pays the SMS budget as usual.
            expect(updateCalls()).toHaveLength(1);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('a fictional number outside the allowlist takes the normal SMS path (the smoke users)', async () => {
            armBackdoor();
            // +15555550101 is the permanent staging smoke user: fictional but
            // deliberately not allowlisted, so smoke exercises the real path.
            const event = await handler(eventFor('+15555550101'));

            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('with no backdoor env vars (production) even a fictional number is texted normally', async () => {
            // beforeEach deleted both env vars; this is the production shape.
            const event = await handler(eventFor(TEST_PHONE));

            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(updateCalls()).toHaveLength(1);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('an allowlisted number with no TEST_OTP_PARAM_PREFIX fails loud with the error shape', async () => {
            process.env.TEST_PHONE_NUMBERS = TEST_PHONE;
            // TEST_OTP_PARAM_PREFIX deliberately unset: misconfiguration must
            // fail the round, not silently text a fictional number.
            const event = await handler(eventFor(TEST_PHONE));

            expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(mockSsmSend).not.toHaveBeenCalled();
        });

        test('an SSM write failure surfaces the same error shape as an SNS failure', async () => {
            armBackdoor();
            mockSsmSend.mockRejectedValue(new Error('SSM is down'));
            const event = await handler(eventFor(TEST_PHONE));

            expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
            expect(mockSnsSend).not.toHaveBeenCalled();
        });
    });
});
