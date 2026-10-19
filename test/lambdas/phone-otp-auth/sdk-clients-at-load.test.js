/**
 * The sign-in lambdas build their AWS SDK clients when the module loads.
 *
 * A cold /auth/start measured 5 s, and about 3.4 s of it was the SDK being
 * required and the first connections being opened inside the handler, on a
 * CPU share the Init phase does not impose. Constructing at load moves that
 * into Init. This pins the behaviour a refactor could quietly undo: a client
 * built per request (or per module, which opens a connection each) shows up
 * here as a constructor count.
 *
 * The SDK is mocked as virtual modules, as in the handler suites, because the
 * Lambda runtime provides it and node_modules does not.
 */
const mockCounts = { ddb: 0, ssm: 0 };

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class { constructor() { mockCounts.ddb += 1; } },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class Command { constructor(input) { this.input = input; } }
    return {
        DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Attributes: { smsCount: 1 } }) }) },
        PutCommand: Command, UpdateCommand: Command, GetCommand: Command, DeleteCommand: Command,
    };
}, { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {
        constructor() { mockCounts.ssm += 1; }
        async send() { return { Parameters: [], Parameter: { Value: 'secret' } }; }
    },
    GetParameterCommand: class { constructor(input) { this.input = input; } },
    GetParametersCommand: class { constructor(input) { this.input = input; } },
    PutParameterCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });
jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: class { async send() { return { MessageId: 'm' }; } },
    PublishCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });

const DIR ='../../../lib/chatbot-api/functions/phone-otp-auth';

describe('SDK clients are built at module load', () => {
    beforeEach(() => {
        jest.resetModules();
        mockCounts.ddb = 0;
        mockCounts.ssm = 0;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('loading the module constructs each client before any request', () => {
        expect(mockCounts).toEqual({ ddb: 0, ssm: 0 });

        require(`${DIR}/create-auth-challenge`);

        // Both exist already, with no handler having run.
        expect(mockCounts).toEqual({ ddb: 1, ssm: 1 });
    });

    test('every module shares one client of each kind, so one connection each', () => {
        for (const name of [
            'auth-store', 'messages', 'email-suppression', 'pre-authentication',
            'turnstile', 'e2e-bypass', 'create-auth-challenge',
        ]) {
            require(`${DIR}/${name}`);
        }

        // Eight modules, one DynamoDB client and one SSM client between them.
        expect(mockCounts).toEqual({ ddb: 1, ssm: 1 });
    });

    test('running the handler does not construct another client', async () => {
        const { handler } = require(`${DIR}/create-auth-challenge`);
        process.env.OTP_RATE_LIMIT_TABLE = 'limits';
        process.env.SMS_POLICY_PARAM_PREFIX = '/a-iep/test/sms-policy';
        const before = { ...mockCounts };
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Round 2 of the sign-in, which is the one that sends and so touches
        // SSM (policy) and DynamoDB (budgets) on a cold container.
        const event = () => ({
            userName: 'u',
            request: {
                userAttributes: { phone_number: '+15555550100' },
                session: [{ challengeMetadata: 'LANGUAGE_HANDSHAKE' }],
            },
            response: {},
        });
        await handler(event());
        await handler(event());

        expect(mockCounts).toEqual(before);
    });
});
