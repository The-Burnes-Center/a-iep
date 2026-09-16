/**
 * verify-auth-challenge validates the OTP and, on a first successful login,
 * creates the fallback user profile. The profile contract matters: the
 * onboarding gate checks showOnboarding === true strictly, so a profile
 * created here without it would silently skip onboarding (and the consent
 * form). The AWS SDK modules are runtime-provided, hence virtual mocks.
 *
 * Event shape: the VerifyAuthChallengeResponse trigger receives ONLY
 * userAttributes, privateChallengeParameters, challengeAnswer,
 * clientMetadata and userNotFound — never a session array. OTP expiry
 * therefore rides on privateChallengeParameters.issuedAt, stamped by
 * create-auth-challenge at first issuance and preserved across in-session
 * reuse rounds.
 *
 * The identity the profile records comes from request.userAttributes, which
 * AWS documents as the user's standard attributes, and not from event.userName
 * (documented only as "the current user's username"). Fixtures below carry
 * both so the branch is exercised against the real contract.
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

const otpEvent = (overrides = {}, eventOverrides = {}) => ({
    userName: 'new-user-sub',
    triggerSource: 'VerifyAuthChallengeResponse_Authentication',
    request: {
        userAttributes: { phone_number: '+15555550100' },
        privateChallengeParameters: {
            secretLoginCode: '123456',
            issuedAt: new Date().toISOString(),
        },
        challengeAnswer: '123456',
        clientMetadata: { language: 'es' },
        ...overrides,
    },
    response: {},
    ...eventOverrides,
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
        expect(Item).not.toHaveProperty('emailVerified');
        expect(typeof Item.createdAtISO).toBe('string');
        expect(Item.secondaryLanguage).toBe('es');
        expect(Item.children).toHaveLength(1);
        expect(Item.children[0].name).toBe('My Child');
    });

    test('an email identity is never recorded as a verified phone', async () => {
        // userName is deliberately NOT the address: the branch has to read
        // userAttributes, which AWS documents, rather than sniff the username,
        // which AWS documents only as "the current user's username".
        const event = await handler(otpEvent(
            { userAttributes: { email: 'parent@example.invalid' } },
            { userName: 'legacy-email-user-sub' },
        ));
        expect(event.response.answerCorrect).toBe(true);

        const { Item } = putCalls()[0][0].input;
        expect(Item.userId).toBe('legacy-email-user-sub');
        expect(Item.authMethod).toBe('email');
        expect(Item.emailVerified).toBe(true);
        expect(Item).not.toHaveProperty('phoneVerified');
        // The rest of the profile contract is unchanged for email parents.
        expect(Item.showOnboarding).toBe(true);
        expect(Item.consentGiven).toBe(false);
    });

    test('an account carrying both attributes records the channel that sent the code', async () => {
        // create-auth-challenge reads phone_number first and texts the OTP, so
        // when both exist SMS is what possession was actually proved on.
        const event = await handler(otpEvent({
            userAttributes: { phone_number: '+15555550100', email: 'parent@example.invalid' },
        }));
        expect(event.response.answerCorrect).toBe(true);

        const { Item } = putCalls()[0][0].input;
        expect(Item.authMethod).toBe('phone');
        expect(Item.phoneVerified).toBe(true);
        expect(Item).not.toHaveProperty('emailVerified');
    });

    test('an identity with neither attribute claims no verification at all', async () => {
        const event = await handler(otpEvent({ userAttributes: {} }));
        expect(event.response.answerCorrect).toBe(true);

        const { Item } = putCalls()[0][0].input;
        expect(Item).not.toHaveProperty('authMethod');
        expect(Item).not.toHaveProperty('phoneVerified');
        expect(Item).not.toHaveProperty('emailVerified');
        // Silence is the point: the profile still lands, it just asserts nothing.
        expect(Item.userId).toBe('new-user-sub');
        expect(Item.showOnboarding).toBe(true);
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
                userAttributes: { phone_number: '+15555550100' },
                privateChallengeParameters: { secretLoginCode: 'LANGUAGE_HANDSHAKE' },
                challengeAnswer: 'HANDSHAKE_ACK',
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
        const event = await handler(otpEvent({
            privateChallengeParameters: {
                secretLoginCode: '123456',
                issuedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
            },
        }));
        expect(event.response.answerCorrect).toBe(false);
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('a code still inside the 5-minute window verifies', async () => {
        const event = await handler(otpEvent({
            privateChallengeParameters: {
                secretLoginCode: '123456',
                issuedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
            },
        }));
        expect(event.response.answerCorrect).toBe(true);
    });

    test('a missing issuance stamp skips the expiry check (in-flight sessions from older deploys)', async () => {
        const event = await handler(otpEvent({
            privateChallengeParameters: { secretLoginCode: '123456' },
        }));
        expect(event.response.answerCorrect).toBe(true);
    });

    test('a garbled issuance stamp is skipped rather than treated as expired', async () => {
        const event = await handler(otpEvent({
            privateChallengeParameters: { secretLoginCode: '123456', issuedAt: 'not-a-date' },
        }));
        expect(event.response.answerCorrect).toBe(true);
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
