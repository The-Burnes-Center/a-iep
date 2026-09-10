/**
 * The signup endpoint is the front door once the public SignUp API is closed.
 *
 * Two properties carry the most weight here. The password rotation MUST run:
 * AdminCreateUser fires neither trigger, so the control that kept ~1,030 abuse
 * accounts unusable is now an explicit step in this function and nothing else
 * would notice if it disappeared. And the checks must run cheapest-first, so
 * an abusive request is refused before it costs an external call.
 *
 * AWS SDK v3 modules come from the Lambda runtime and are not vendored, so
 * they are mocked as virtual modules.
 */
const mockCognitoSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
    CognitoIdentityProviderClient: class {
        send(...args) { return mockCognitoSend(...args); }
    },
    AdminCreateUserCommand: class {
        constructor(input) { this.input = input; this.kind = 'create'; }
    },
    AdminSetUserPasswordCommand: class {
        constructor(input) { this.input = input; this.kind = 'password'; }
    },
    AdminDeleteUserCommand: class {
        constructor(input) { this.input = input; this.kind = 'delete'; }
    },
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class UpdateCommand {
        constructor(input) { this.input = input; }
    }
    return {
        UpdateCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {
        send(...args) { return mockSsmSend(...args); }
    },
    GetParameterCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

const PHONE = '+15551234567';

const request = (body = {}, sourceIp = '203.0.113.10') => ({
    body: JSON.stringify({ phoneNumber: PHONE, turnstileToken: 'tok', ...body }),
    requestContext: { http: { sourceIp } },
});

const load = () => {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../../lib/chatbot-api/functions/phone-otp-auth/signup-endpoint');
    });
    return mod.handler;
};

const commandsOfKind = (kind) =>
    mockCognitoSend.mock.calls.filter(([cmd]) => cmd.kind === kind);

describe('signup endpoint', () => {
    beforeEach(() => {
        jest.resetModules();
        mockCognitoSend.mockReset().mockResolvedValue({});
        mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: 'sec' } });
        mockDdbSend.mockReset().mockResolvedValue({ Attributes: { attempts: 1 } });
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
        process.env.USER_POOL_ID = 'us-east-1_test';
        process.env.SIGNUP_RATE_LIMIT_TABLE = 'signup-limits';
        process.env.TURNSTILE_SECRET_PARAM = '/a-iep/test/turnstile/secret';
        delete process.env.SIGNUP_ALLOWED_COUNTRY_CODES;
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('creates the account and immediately replaces its password', async () => {
        // The load-bearing assertion in this file. AdminCreateUser leaves the
        // account with a password the caller could be told; without this step
        // that password works.
        const response = await load()(request());

        expect(response.statusCode).toBe(200);
        expect(commandsOfKind('create')).toHaveLength(1);

        const [[passwordCommand]] = commandsOfKind('password');
        expect(passwordCommand.input.Permanent).toBe(true);
        expect(passwordCommand.input.Password.length).toBeGreaterThan(24);
    });

    test('the account is created verified, and Cognito sends nothing', async () => {
        await load()(request());

        const [[create]] = commandsOfKind('create');
        // SUPPRESS, or Cognito's own invitation is a second SMS for one signup.
        expect(create.input.MessageAction).toBe('SUPPRESS');
        const verified = create.input.UserAttributes
            .find((a) => a.Name === 'phone_number_verified');
        expect(verified.Value).toBe('true');
    });

    test('two identical calls never reuse a password', async () => {
        await load()(request());
        await load()(request());

        const passwords = commandsOfKind('password').map(([c]) => c.input.Password);
        expect(new Set(passwords).size).toBe(2);
    });

    test('a malformed number is refused before anything else runs', async () => {
        const response = await load()(request({ phoneNumber: 'not-a-number' }));

        expect(response.statusCode).toBe(400);
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('a destination we do not serve is refused', async () => {
        const response = await load()(request({ phoneNumber: '+255712345678' }));

        expect(response.statusCode).toBe(400);
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('one source cannot sign up repeatedly', async () => {
        // The signal the Cognito trigger could never see: it receives no
        // client IP, which is why 293 addresses were invisible to us.
        mockDdbSend.mockResolvedValue({ Attributes: { attempts: 99 } });

        const response = await load()(request());

        expect(response.statusCode).toBe(429);
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('rate limits are checked BEFORE the external call', async () => {
        // Cheapest first: an abusive request must not cost us a round trip to
        // Cloudflare, or the limiter just moves where the load lands.
        mockDdbSend.mockResolvedValue({ Attributes: { attempts: 99 } });

        await load()(request());

        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a datastore failure fails CLOSED', async () => {
        // Opposite of the per-phone limiter on LOGIN, which fails open so an
        // outage cannot lock everyone out. Refusing a signup costs one retry.
        mockDdbSend.mockRejectedValue(new Error('DynamoDB unavailable'));

        const response = await load()(request());

        expect(response.statusCode).toBe(503);
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('a failed anti-abuse check refuses the signup', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
        });

        const response = await load()(request());

        expect(response.statusCode).toBe(403);
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('an unreachable Cloudflare fails CLOSED', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

        const response = await load()(request());

        expect(response.statusCode).toBe(403);
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('no secret configured yet still creates the account', async () => {
        // The rollout state: the SecureString is created out of band, and
        // refusing every signup until someone remembers would be downtime we
        // inflicted on ourselves.
        const notFound = new Error('missing');
        notFound.name = 'ParameterNotFound';
        mockSsmSend.mockRejectedValue(notFound);

        const response = await load()(request());

        expect(response.statusCode).toBe(200);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('an existing account is not revealed to the caller', async () => {
        // This test is named for a property it did not check. It asserted
        // `{ created: false }`, which IS the disclosure: post a number to an
        // unauthenticated route with an open CORS header, read the body,
        // learn whether that person has an account. The body must be
        // byte-identical either way, and that is what is asserted now.
        const exists = new Error('exists');
        exists.name = 'UsernameExistsException';
        mockCognitoSend.mockRejectedValueOnce(exists);

        const existing = await load()(request());

        mockCognitoSend.mockReset().mockResolvedValue({});
        const fresh = await load()(request());

        expect(existing.statusCode).toBe(fresh.statusCode);
        expect(existing.body).toBe(fresh.body);
        expect(JSON.parse(existing.body)).not.toHaveProperty('created');
    });

    test('an account that cannot be secured is removed, not left behind', async () => {
        // The worst state this function can produce. AdminCreateUser
        // succeeds, AdminSetUserPassword fails, and the account is left in
        // FORCE_CHANGE_PASSWORD: custom-auth sign-in never works, while a
        // retry hits UsernameExistsException and is told to go and sign in.
        // That is a phone number permanently unable to sign up OR sign in.
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'password') {
                return Promise.reject(new Error('rotation unavailable'));
            }
            return Promise.resolve({});
        });

        const response = await load()(request());

        expect(response.statusCode).toBe(500);
        expect(commandsOfKind('delete')).toHaveLength(1);
        expect(commandsOfKind('delete')[0][0].input.Username).toBe(PHONE);
    });

    test('an account left both unsecured and undeleted raises the marker', async () => {
        // Both calls failed, so an account exists that whoever created it can
        // sign into. This is the hole the PostConfirmation rotation closed
        // for the ~1,030 accounts of the 2026-09-09 run, and it needs a
        // person rather than a retry.
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'create') return Promise.resolve({});
            return Promise.reject(new Error('cognito unavailable'));
        });

        const response = await load()(request());

        expect(response.statusCode).toBe(500);
        const out = logged.mock.calls.map((a) => a.join(' ')).join('\n');
        expect(out).toContain('SIGNUP_ORPHANED');
        logged.mockRestore();
    });

    test('a successful signup does not delete the account it just made', async () => {
        // Mutation guard for the rollback above: if the delete ever escaped
        // its catch, every new family would be created and then removed.
        await load()(request());

        expect(commandsOfKind('delete')).toHaveLength(0);
    });

    test('an internal failure tells the caller nothing useful', async () => {
        mockCognitoSend.mockRejectedValue(new Error('Table a-iep-prod-users not found'));

        const response = await load()(request());

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('a-iep-prod-users');
    });

    test('the caller IP is hashed, never stored raw', async () => {
        await load()(request({}, '198.51.100.7'));

        const keys = mockDdbSend.mock.calls.map(([cmd]) => cmd.input.Key.pk);
        expect(keys.some((k) => k.startsWith('SIGNUP#IP#'))).toBe(true);
        for (const key of keys) {
            expect(key).not.toContain('198.51.100.7');
        }
    });

    test('the bot check being switched off is logged, never silent', async () => {
        // "Deployed" and "switched on" are different states: the secret is
        // created out of band. Without this marker the difference between
        // Turnstile protecting signup and Turnstile being absent is
        // invisible from everywhere, and it is what the alarm counts.
        const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const notFound = new Error('missing');
        notFound.name = 'ParameterNotFound';
        mockSsmSend.mockRejectedValue(notFound);

        await load()(request());

        const out = warned.mock.calls.map((a) => a.join(' ')).join('\n');
        expect(out).toContain('TURNSTILE_NOT_CONFIGURED');
        warned.mockRestore();
    });

    test('every refusal is logged with a reason', async () => {
        // A silent 4xx is a defect: an unlogged validation rejection made a
        // real failure undiagnosable once before.
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        await load()(request({ phoneNumber: 'bad' }));

        const out = logged.mock.calls.map((a) => a.join(' ')).join('\n');
        expect(out).toContain('SIGNUP_REFUSED');
        logged.mockRestore();
    });
});

describe('the staging-only Turnstile bypass', () => {
    // Turnstile refuses automated browsers by design, so the real widget and
    // an automated signup cannot both work. Staging keeps the real widget for
    // people; only the E2E runner has a way past it. Every assertion here is
    // about that door staying shut everywhere else.
    const BYPASS = 'bypass-token-value';
    const TEST_NUMBER = '+15555550120';

    const withBypass = (extra = {}) => ({
        body: JSON.stringify({ phoneNumber: TEST_NUMBER, turnstileToken: BYPASS, ...extra }),
        requestContext: { http: { sourceIp: '203.0.113.10' } },
    });

    beforeEach(() => {
        jest.resetModules();
        mockCognitoSend.mockReset().mockResolvedValue({});
        mockDdbSend.mockReset().mockResolvedValue({ Attributes: { attempts: 1 } });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ success: true }),
        });
        process.env.USER_POOL_ID = 'us-east-1_test';
        process.env.SIGNUP_RATE_LIMIT_TABLE = 'signup-limits';
        process.env.TURNSTILE_SECRET_PARAM = '/a-iep/test/turnstile/secret';
        process.env.E2E_BYPASS_PARAM = '/a-iep/staging/e2e-turnstile-bypass';
        process.env.TEST_PHONE_NUMBERS = TEST_NUMBER;
        // The secret exists, so the real check WOULD run without the bypass.
        mockSsmSend.mockReset().mockImplementation((cmd) =>
            Promise.resolve({
                Parameter: {
                    Value: cmd.input.Name === process.env.E2E_BYPASS_PARAM ? BYPASS : 'real-secret',
                },
            }));
    });

    afterEach(() => {
        delete process.env.E2E_BYPASS_PARAM;
        delete process.env.TEST_PHONE_NUMBERS;
        delete global.fetch;
    });

    test('a test number with the bypass token skips Cloudflare entirely', async () => {
        const response = await load()(withBypass());

        expect(response.statusCode).toBe(200);
        // The point of the whole mechanism: no call to siteverify.
        expect(global.fetch).not.toHaveBeenCalled();
        expect(commandsOfKind('create')).toHaveLength(1);
    });

    test('the bypass does nothing for a real phone number', async () => {
        // The guard that makes a leaked token worthless: it can only ever
        // create an account on a number no handset can receive a text on.
        // Cloudflare rejects it, as it would any string that is not one of
        // its own tokens.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
        });

        const response = await load()({
            body: JSON.stringify({ phoneNumber: '+15551234567', turnstileToken: BYPASS }),
            requestContext: { http: { sourceIp: '203.0.113.10' } },
        });

        // Falls through to the real check, and is refused by it.
        expect(global.fetch).toHaveBeenCalled();
        expect(response.statusCode).toBe(403);
        expect(commandsOfKind('create')).toHaveLength(0);
    });

    test('production has no bypass at all, so a test number is still checked', async () => {
        // CDK sets E2E_BYPASS_PARAM only when the environment is not prod.
        delete process.env.E2E_BYPASS_PARAM;

        await load()(withBypass());

        expect(global.fetch).toHaveBeenCalled();
    });

    test('a wrong token does not open the door', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
        });

        const response = await load()(withBypass({ turnstileToken: 'not-the-token' }));

        expect(global.fetch).toHaveBeenCalled();
        expect(response.statusCode).toBe(403);
    });

    test('using the bypass is recorded, never silent', async () => {
        const logged = jest.spyOn(console, 'log').mockImplementation(() => {});

        await load()(withBypass());

        const out = logged.mock.calls.map((a) => a.join(' ')).join('\n');
        expect(out).toContain('SIGNUP_E2E_BYPASS');
        logged.mockRestore();
    });
});
