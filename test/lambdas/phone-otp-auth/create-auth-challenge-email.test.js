/**
 * The email branch of create-auth-challenge.
 *
 * Its own file rather than more cases in create-auth-challenge.test.js,
 * because it needs an SESv2 mock that the SMS suite deliberately does not have:
 * a test that can quietly reach SES is a test that cannot prove a send did not
 * happen.
 *
 * The load-bearing assertion here is ConfigurationSetName. `a-iep.org` already
 * carries a DEFAULT configuration set belonging to another project in this
 * shared AWS account, and that set has no event destinations, so a send that
 * forgets to name OUR set does not fail and does not fall back to plain SES:
 * it succeeds, counts against the shared reputation, and has its bounces and
 * complaints discarded. Nothing would ever reach the suppression list and
 * nothing would say so. IAM cannot close this -- ses:SendEmail has no
 * condition key for the configuration set -- so this test IS the control.
 */
const mockSnsSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
const mockSesSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: class { send(...args) { return mockSnsSend(...args); } },
    PublishCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });

jest.mock('@aws-sdk/client-sesv2', () => ({
    SESv2Client: class { send(...args) { return mockSesSend(...args); } },
    SendEmailCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class { send(...args) { return mockSsmSend(...args); } },
    PutParameterCommand: class { constructor(input) { this.input = input; this.kind = 'put-param'; } },
    GetParametersCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class GetCommand { constructor(input) { this.input = input; this.kind = 'get'; } }
    class UpdateCommand { constructor(input) { this.input = input; this.kind = 'update'; } }
    return {
        GetCommand,
        UpdateCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

const {
    handler,
    resetSesClient,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/create-auth-challenge');
const { getMessages } = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');

const EMAIL = 'parent@example.com';
const TEST_EMAIL = 'e2e-login@a-iep.invalid';

const HANDSHAKE_PASS = {
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: true,
    challengeMetadata: 'LANGUAGE_HANDSHAKE',
};

const emailEvent = (session, extra = {}) => ({
    userName: 'test-user',
    request: { userAttributes: { email: EMAIL }, session, ...extra },
    response: {},
});

const sesCalls = () => mockSesSend.mock.calls.map(([cmd]) => cmd.input);
const ddbOfKind = (kind) => mockDdbSend.mock.calls.filter(([cmd]) => cmd.kind === kind).map(([cmd]) => cmd);

describe('create-auth-challenge, email branch', () => {
    let logged;

    beforeEach(() => {
        logged = [];
        jest.spyOn(console, 'error').mockImplementation((...a) => logged.push(a.join(' ')));
        jest.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')));

        resetSesClient();
        mockSesSend.mockReset().mockResolvedValue({ MessageId: 'ses-1' });
        mockSnsSend.mockReset().mockResolvedValue({ MessageId: 'sns-1' });
        mockSsmSend.mockReset().mockResolvedValue({ Version: 1 });
        // Suppression lookups miss; the counters report a first send.
        mockDdbSend.mockReset().mockImplementation(async (cmd) => (
            cmd.kind === 'update' ? { Attributes: { emailCount: 1 } } : {}
        ));

        process.env.OTP_RATE_LIMIT_TABLE = 'test-otp-rate-limit';
        process.env.EMAIL_SUPPRESSION_TABLE = 'test-suppression';
        process.env.SES_CONFIGURATION_SET = 'a-iep-auth-staging';
        process.env.SES_FROM_ADDRESS = 'no-reply@a-iep.org';
        delete process.env.USER_PROFILES_TABLE;
        delete process.env.TEST_EMAIL_ADDRESSES;
        delete process.env.TEST_PHONE_NUMBERS;
        delete process.env.TEST_OTP_PARAM_PREFIX;
    });

    afterEach(() => jest.restoreAllMocks());

    test('round 1 is a language handshake and sends nothing', async () => {
        const event = await handler(emailEvent([]));
        expect(event.response.publicChallengeParameters).toEqual({
            challengeType: 'LANGUAGE_HANDSHAKE',
            email: EMAIL,
        });
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(mockSnsSend).not.toHaveBeenCalled();
        // A round that sends nothing must not consume the budget either.
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('round 2 emails a six-digit code, once, and never texts', async () => {
        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        const code = event.response.privateChallengeParameters.secretLoginCode;

        expect(code).toMatch(/^\d{6}$/);
        expect(mockSesSend).toHaveBeenCalledTimes(1);
        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters).toEqual({ email: EMAIL });

        const [sent] = sesCalls();
        expect(sent.Destination.ToAddresses).toEqual([EMAIL]);
        expect(sent.Content.Simple.Body.Text.Data).toContain(code);
        expect(sent.Content.Simple.Body.Html.Data).toContain(code);
        expect(sent.Content.Simple.Subject.Data).toBe(getMessages('en').otpLoginEmailSubject);
    });

    // THE control. See the file docblock.
    test('every send names OUR configuration set and OUR from address', async () => {
        await handler(emailEvent([HANDSHAKE_PASS]));
        const [sent] = sesCalls();

        expect(sent.ConfigurationSetName).toBe('a-iep-auth-staging');
        expect(sent.FromEmailAddress).toBe('no-reply@a-iep.org');
    });

    test('with no configuration set configured it refuses to send at all', async () => {
        delete process.env.SES_CONFIGURATION_SET;
        const event = await handler(emailEvent([HANDSHAKE_PASS]));

        expect(mockSesSend).not.toHaveBeenCalled();
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(event.response.publicChallengeParameters.errorCode).toBe('delivery_failed');
        expect(logged.join('\n')).toContain('EMAIL_SEND_FAILED');
    });

    test('the code is localized from RespondToAuthChallenge clientMetadata', async () => {
        const event = await handler(emailEvent([HANDSHAKE_PASS], { clientMetadata: { language: 'vi' } }));
        const [sent] = sesCalls();

        expect(sent.Content.Simple.Subject.Data).toBe(getMessages('vi').otpLoginEmailSubject);
        expect(sent.Content.Simple.Body.Text.Data)
            .toContain(event.response.privateChallengeParameters.secretLoginCode);
        expect(sent.Content.Simple.Body.Text.Data).not.toBe(getMessages('en').otpLoginEmailText);
    });

    test('the expiry the copy promises is the expiry the code actually has', async () => {
        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        expect(sesCalls()[0].Content.Simple.Body.Text.Data).toContain('5 minutes');
        expect(event.response.privateChallengeParameters.issuedAt).toBeDefined();
    });

    // ── Fail-closed controls ─────────────────────────────────────────────
    test('a suppressed address is refused BEFORE SES is called', async () => {
        // SES's own suppression refuses INSIDE SES: the API call succeeds, a
        // Send is counted, the message is dropped, and the app tells a parent
        // a code is coming that never will. That is the 2026-09-09 SMS outage
        // shape. Refusing here lets the app say something true.
        mockDdbSend.mockImplementation(async (cmd) => (
            cmd.kind === 'get' && cmd.input.TableName === 'test-suppression'
                ? { Item: { addressHash: 'x', suppressedAt: 1, reason: 'hard-bounce' } }
                : { Attributes: { emailCount: 1 } }
        ));

        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters.errorCode).toBe('unsupported_destination');
        expect(logged.join('\n')).toContain('EMAIL_SUPPRESSED_DESTINATION');
        // A control working is not a delivery outage: it must not fire the
        // "email is broken" alarm.
        expect(logged.join('\n')).not.toContain('EMAIL_SEND_FAILED');
    });

    test('an unreadable suppression list fails CLOSED', async () => {
        // Mailing an address SES already told us is bad is how the identity
        // gets suspended, which ends email sign-in for every family until AWS
        // accepts an appeal.
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd.kind === 'get' && cmd.input.TableName === 'test-suppression') {
                throw Object.assign(new Error('down'), { name: 'InternalServerError' });
            }
            return { Attributes: { emailCount: 1 } };
        });

        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters.errorCode).toBe('budget_exhausted');
        expect(logged.join('\n')).toContain('EMAIL_SUPPRESSION_UNAVAILABLE');
    });

    test('the suppression check runs before the ceilings, so a bad address costs nothing', async () => {
        mockDdbSend.mockImplementation(async (cmd) => (
            cmd.kind === 'get' && cmd.input.TableName === 'test-suppression'
                ? { Item: { suppressedAt: 1 } }
                : { Attributes: { emailCount: 1 } }
        ));

        await handler(emailEvent([HANDSHAKE_PASS]));
        expect(ddbOfKind('update')).toHaveLength(0);
    });

    test('an exhausted global ceiling refuses the send', async () => {
        mockDdbSend.mockImplementation(async (cmd) => (
            cmd.kind === 'update' ? { Attributes: { emailCount: 9999 } } : {}
        ));

        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters.errorCode).toBe('budget_exhausted');
        expect(logged.join('\n')).toContain('EMAIL_BUDGET_EXHAUSTED');
    });

    test('an SES failure surfaces as a failed send rather than throwing', async () => {
        // The trigger reports failures through the challenge parameters, which
        // is why its Lambda Errors metric cannot see a delivery outage and why
        // the marker exists at all.
        mockSesSend.mockRejectedValue(Object.assign(new Error('boom'), { name: 'MessageRejected' }));

        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(event.response.publicChallengeParameters.errorCode).toBe('delivery_failed');
        expect(logged.join('\n')).toContain('EMAIL_SEND_FAILED kind=MessageRejected');
    });

    test('an account with neither a phone number nor an address is refused, not crashed', async () => {
        const event = await handler({
            userName: 'test-user', request: { userAttributes: {}, session: [HANDSHAKE_PASS] }, response: {},
        });
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('an account with BOTH goes by SMS, matching what verify-auth-challenge records', async () => {
        const event = await handler({
            userName: 'test-user',
            request: { userAttributes: { phone_number: '+15555550100', email: EMAIL }, session: [HANDSHAKE_PASS] },
            response: {},
        });
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters).toEqual({ phone_number: '+15555550100' });
    });

    test('the code is never logged, and neither is the address', async () => {
        const event = await handler(emailEvent([HANDSHAKE_PASS]));
        const code = event.response.privateChallengeParameters.secretLoginCode;
        const all = logged.join('\n');

        expect(all).not.toContain(code);
        expect(all).not.toContain(EMAIL);
    });
});

describe('the staging email test backdoor', () => {
    const PARAM_PREFIX = '/a-iep/staging/test-otp';

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        resetSesClient();
        mockSesSend.mockReset().mockResolvedValue({ MessageId: 'ses-1' });
        mockSsmSend.mockReset().mockResolvedValue({ Version: 1 });
        mockDdbSend.mockReset().mockImplementation(async (cmd) => (
            cmd.kind === 'update' ? { Attributes: { emailCount: 1 } } : {}
        ));
        process.env.OTP_RATE_LIMIT_TABLE = 'test-otp-rate-limit';
        process.env.EMAIL_SUPPRESSION_TABLE = 'test-suppression';
        process.env.SES_CONFIGURATION_SET = 'a-iep-auth-staging';
        process.env.SES_FROM_ADDRESS = 'no-reply@a-iep.org';
        process.env.TEST_EMAIL_ADDRESSES = TEST_EMAIL;
        process.env.TEST_OTP_PARAM_PREFIX = PARAM_PREFIX;
    });

    afterEach(() => {
        delete process.env.TEST_EMAIL_ADDRESSES;
        delete process.env.TEST_OTP_PARAM_PREFIX;
        jest.restoreAllMocks();
    });

    const testEvent = (session, extra = {}) => ({
        userName: 'test-user',
        request: { userAttributes: { email: TEST_EMAIL }, session, ...extra },
        response: {},
    });

    test('an allowlisted fictional address gets its code stashed in SSM, never mailed', async () => {
        const event = await handler(testEvent([HANDSHAKE_PASS]));
        const code = event.response.privateChallengeParameters.secretLoginCode;

        expect(mockSesSend).not.toHaveBeenCalled();
        const [put] = mockSsmSend.mock.calls.map(([cmd]) => cmd).filter((c) => c.kind === 'put-param');
        // SSM names allow no '@', so the local part is the key. The E2E runner
        // has to build the same name.
        expect(put.input.Name).toBe(`${PARAM_PREFIX}/e2e-login`);
        expect(JSON.parse(put.input.Value).code).toBe(code);
    });

    test('a backdoored send draws on no budget: nothing was transmitted', async () => {
        await handler(testEvent([HANDSHAKE_PASS]));
        expect(ddbOfKind('update')).toHaveLength(0);
    });

    test('a REAL address is mailed even while the allowlist exists', async () => {
        // The second lock: being on the allowlist is not enough, the address
        // must also be on the reserved fictional domain.
        process.env.TEST_EMAIL_ADDRESSES = `${EMAIL},${TEST_EMAIL}`;
        await handler({
            userName: 'test-user',
            request: { userAttributes: { email: EMAIL }, session: [HANDSHAKE_PASS] },
            response: {},
        });
        expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    test('with no allowlist env var there is no backdoor: production mails the address', async () => {
        delete process.env.TEST_EMAIL_ADDRESSES;
        await handler(testEvent([HANDSHAKE_PASS]));
        expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    test('an allowlisted address with nowhere to stash fails loud rather than silently', async () => {
        delete process.env.TEST_OTP_PARAM_PREFIX;
        const event = await handler(testEvent([HANDSHAKE_PASS]));
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(mockSesSend).not.toHaveBeenCalled();
    });
});
