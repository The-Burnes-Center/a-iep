/**
 * verify-auth-challenge validates the OTP and, on a first successful login,
 * creates the fallback user profile. The profile contract matters: the
 * onboarding gate checks showOnboarding === true strictly, so a profile
 * created here without it would silently skip onboarding (and the consent
 * form). The AWS SDK modules are runtime-provided, hence virtual mocks.
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class GetCommand {
        constructor(input) { this.input = input; }
    }
    class PutCommand {
        constructor(input) { this.input = input; }
    }
    return {
        GetCommand,
        PutCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

const { GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/verify-auth-challenge');

const freshOtpSession = (code = '123456') => [{
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: true,
    challengeMetadata: JSON.stringify({ code, timestamp: new Date().toISOString() }),
}];

const otpEvent = (overrides = {}) => ({
    userName: 'new-user-sub',
    request: {
        privateChallengeParameters: { secretLoginCode: '123456' },
        challengeAnswer: '123456',
        clientMetadata: { language: 'es' },
        session: freshOtpSession(),
        ...overrides,
    },
    response: {},
});

const putCalls = () => mockDdbSend.mock.calls.filter(([cmd]) => cmd instanceof PutCommand);

describe('verify-auth-challenge', () => {
    beforeEach(() => {
        process.env.USER_PROFILES_TABLE = 'test-profiles-table';
        // Default: no existing profile, writes succeed.
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof GetCommand) return {};
            if (cmd instanceof PutCommand) return {};
            throw new Error(`unexpected command: ${cmd.constructor.name}`);
        });
    });

    test('correct OTP passes and creates the fallback profile once', async () => {
        const event = await handler(otpEvent());
        expect(event.response.answerCorrect).toBe(true);

        const puts = putCalls();
        expect(puts).toHaveLength(1);
        const { Item, ConditionExpression, TableName } = puts[0][0].input;

        expect(TableName).toBe('test-profiles-table');
        expect(ConditionExpression).toBe('attribute_not_exists(userId)');
        expect(Item.userId).toBe('new-user-sub');
        expect(Item.showOnboarding).toBe(true);
        expect(Item.consentGiven).toBe(false);
        expect(Item.authMethod).toBe('phone');
        expect(Item.phoneVerified).toBe(true);
        expect(typeof Item.createdAtISO).toBe('string');
        expect(Item.secondaryLanguage).toBe('es');
        expect(Item.children).toHaveLength(1);
        expect(Item.children[0].name).toBe('My Child');
    });

    test('an unsupported UI language is dropped rather than stored', async () => {
        const event = await handler(otpEvent({ clientMetadata: { language: 'xx' } }));
        expect(event.response.answerCorrect).toBe(true);
        expect(putCalls()[0][0].input.Item).not.toHaveProperty('secondaryLanguage');
    });

    test('the language handshake round auto-passes and touches nothing', async () => {
        const event = await handler({
            userName: 'new-user-sub',
            request: {
                privateChallengeParameters: { secretLoginCode: 'LANGUAGE_HANDSHAKE' },
                challengeAnswer: 'HANDSHAKE_ACK',
                session: [],
            },
            response: {},
        });
        expect(event.response.answerCorrect).toBe(true);
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('a wrong OTP fails and creates no profile', async () => {
        const event = await handler(otpEvent({ challengeAnswer: '999999' }));
        expect(event.response.answerCorrect).toBe(false);
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('surrounding whitespace in the typed code is tolerated', async () => {
        const event = await handler(otpEvent({ challengeAnswer: ' 123456 ' }));
        expect(event.response.answerCorrect).toBe(true);
    });

    test('a correct but expired OTP fails', async () => {
        const staleSession = [{
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: true,
            challengeMetadata: JSON.stringify({
                code: '123456',
                timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
            }),
        }];
        const event = await handler(otpEvent({ session: staleSession }));
        expect(event.response.answerCorrect).toBe(false);
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('the ERROR sentinel from a failed create round never verifies', async () => {
        const event = await handler(otpEvent({
            privateChallengeParameters: { secretLoginCode: 'ERROR' },
            challengeAnswer: 'ERROR',
        }));
        expect(event.response.answerCorrect).toBe(false);
    });

    test('a missing answer fails', async () => {
        const event = await handler(otpEvent({ challengeAnswer: undefined }));
        expect(event.response.answerCorrect).toBe(false);
    });

    test('an existing profile is never overwritten', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof GetCommand) return { Item: { userId: 'new-user-sub', consentGiven: true } };
            throw new Error('should not write');
        });
        const event = await handler(otpEvent());
        expect(event.response.answerCorrect).toBe(true);
        expect(putCalls()).toHaveLength(0);
    });

    test('a DynamoDB outage must not block a valid login', async () => {
        mockDdbSend.mockRejectedValue(new Error('DynamoDB unavailable'));
        const event = await handler(otpEvent());
        expect(event.response.answerCorrect).toBe(true);
    });
});
