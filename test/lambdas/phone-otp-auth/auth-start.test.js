/**
 * POST /auth/start.
 *
 * Two properties carry the most weight. The checks must run cheapest-first, so
 * an abusive request is refused before it costs an external call. And the
 * function must do the SAME WORK for a brand new destination and for one of
 * the 296 existing accounts -- not merely return the same body, which a
 * stopwatch defeats. Everything that depends on whether the account exists is
 * handed to the dispatcher after the response, and the tests below assert that
 * this function makes no Cognito call at all.
 *
 * AWS SDK v3 modules come from the Lambda runtime and are not vendored, so
 * they are mocked as virtual modules.
 */
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class PutCommand { constructor(input) { this.input = input; this.kind = 'put'; } }
    class UpdateCommand { constructor(input) { this.input = input; this.kind = 'update'; } }
    class GetCommand { constructor(input) { this.input = input; this.kind = 'get'; } }
    class DeleteCommand { constructor(input) { this.input = input; this.kind = 'delete'; } }
    return {
        PutCommand, UpdateCommand, GetCommand, DeleteCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class { send(...args) { return mockSsmSend(...args); } },
    GetParameterCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
    LambdaClient: class { send(...args) { return mockLambdaSend(...args); } },
    InvokeCommand: class { constructor(input) { this.input = input; } },
}), { virtual: true });

const PHONE = '+15551234567';
const EMAIL = 'parent@example.com';

const request = (body = {}, sourceIp = '203.0.113.10') => ({
    body: JSON.stringify({ destination: PHONE, turnstileToken: 'tok', ...body }),
    requestContext: { http: { sourceIp } },
});

const load = () => {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../../lib/chatbot-api/functions/phone-otp-auth/auth-start');
    });
    return mod.handler;
};

const putCalls = () => mockDdbSend.mock.calls.filter(([cmd]) => cmd.kind === 'put');
const bodyOf = (response) => JSON.parse(response.body);

describe('auth start', () => {
    let errors;

    beforeEach(() => {
        jest.resetModules();
        errors = [];
        jest.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
        jest.spyOn(console, 'log').mockImplementation((...args) => errors.push(args.join(' ')));

        mockDdbSend.mockReset().mockResolvedValue({ Attributes: { attempts: 1 } });
        mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: 'real-secret' } });
        mockLambdaSend.mockReset().mockResolvedValue({ StatusCode: 202 });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ success: true }),
        });

        process.env.OTP_RATE_LIMIT_TABLE = 'rate-limits';
        process.env.AUTH_SESSION_TABLE = 'auth-sessions';
        process.env.TURNSTILE_SECRET_PARAM = '/a-iep/test/turnstile/secret';
        process.env.AUTH_DISPATCH_FUNCTION = 'auth-dispatch';
        delete process.env.AUTH_ALLOWED_COUNTRY_CODES;
        delete process.env.E2E_BYPASS_PARAM;
        delete process.env.TEST_PHONE_NUMBERS;
        delete process.env.TEST_EMAIL_ADDRESSES;
        delete process.env.MAX_AUTH_STARTS_PER_IP_HOUR;
        delete process.env.MAX_AUTH_STARTS_PER_HOUR;
    });

    afterEach(() => {
        delete global.fetch;
        jest.restoreAllMocks();
    });

    test('accepts a phone number, reserves a challenge, and asks for exactly one send', async () => {
        const response = await load()(request());

        expect(response.statusCode).toBe(200);
        const body = bodyOf(response);
        expect(body.ok).toBe(true);
        expect(body.channel).toBe('sms');
        expect(body.expiresIn).toBe(300);
        // Opaque: 32 bytes of entropy, base64url, 43 characters. Not a JWT and
        // not decodable into anything about the parent.
        expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // ONE challenge row, ONE dispatch. "Never two OTPs" starts here.
        expect(putCalls()).toHaveLength(1);
        expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    });

    test('accepts an email address and says so, because the caller already knows', async () => {
        const body = bodyOf(await load()(request({ destination: EMAIL })));
        expect(body.ok).toBe(true);
        expect(body.channel).toBe('email');
    });

    test('the challenge row carries the destination, so the caller cannot supply it later', async () => {
        await load()(request());
        const item = putCalls()[0][0].input.Item;

        expect(item.TableName).toBeUndefined();
        expect(putCalls()[0][0].input.TableName).toBe('auth-sessions');
        expect(item.destination).toBe(PHONE);
        expect(item.channel).toBe('sms');
        expect(item.status).toBe('pending');
        // Keyed on the HASH of the handle, never the handle: a read of this
        // table must yield the hash of a credential, not a credential.
        expect(item.pk).toMatch(/^C#[0-9a-f]{64}$/);
        expect(item.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    test('the dispatcher is invoked as an EVENT, so nothing after this is on the caller\'s clock', async () => {
        await load()(request());
        const input = mockLambdaSend.mock.calls[0][0].input;

        expect(input.FunctionName).toBe('auth-dispatch');
        // RequestResponse here would put the account creation back on the
        // request path and reopen the timing oracle this design closes.
        expect(input.InvocationType).toBe('Event');
        expect(JSON.parse(Buffer.from(input.Payload).toString()))
            .toMatchObject({ username: PHONE, channel: 'sms' });
    });

    // ── The property the whole design exists for ─────────────────────────
    test('a registered and an unregistered destination are indistinguishable, in body AND in work', async () => {
        const handler = load();
        const first = await handler(request({ destination: '+15550000001' }));
        const callsAfterFirst = mockDdbSend.mock.calls.length + mockLambdaSend.mock.calls.length
            + global.fetch.mock.calls.length;

        const second = await handler(request({ destination: '+15550000002' }));
        const callsAfterSecond = mockDdbSend.mock.calls.length + mockLambdaSend.mock.calls.length
            + global.fetch.mock.calls.length;

        // Same fields, same values, except the one random handle.
        const strip = (r) => { const b = bodyOf(r); delete b.challenge; return b; };
        expect(strip(first)).toEqual(strip(second));
        expect(first.statusCode).toBe(second.statusCode);
        // Same number of calls, both times. There is no branch to time.
        expect(callsAfterSecond - callsAfterFirst).toBe(callsAfterFirst);
    });

    test('it never calls Cognito at all: account creation is not on this path', async () => {
        // The strongest form of the timing assertion. If this function ever
        // acquires a Cognito call, requiring the module fails here, because
        // the SDK is not mocked in this file and is not installed.
        const source = require('fs').readFileSync(
            require.resolve('../../../lib/chatbot-api/functions/phone-otp-auth/auth-start'),
            'utf8',
        );
        // Comments stripped: the docblock explains WHY these calls are absent,
        // so a naive substring search would match its own explanation.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toContain('client-cognito-identity-provider');
        expect(code).not.toContain('AdminGetUser');
        expect(code).not.toContain('AdminCreateUser');
        expect(code).not.toContain('AdminSetUserPassword');
    });

    // ── Ordering: cheapest first ─────────────────────────────────────────
    test('a malformed body is refused before any datastore call', async () => {
        const response = await load()({ body: 'not json', requestContext: {} });
        expect(response.statusCode).toBe(400);
        expect(bodyOf(response).code).toBe('invalid_request');
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('AUTH_START_REFUSED reason=invalid_request');
    });

    test('a bad destination is refused before any datastore call', async () => {
        const response = await load()(request({ destination: 'nonsense' }));
        expect(response.statusCode).toBe(400);
        expect(bodyOf(response).code).toBe('invalid_destination');
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('an unsupported destination is refused before any datastore call', async () => {
        const response = await load()(request({ destination: '+255712345678' }));
        expect(response.statusCode).toBe(400);
        expect(bodyOf(response).code).toBe('unsupported_destination');
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a rate-limited request never reaches Cloudflare', async () => {
        // Turnstile is the only step with an external dependency, so it must
        // be last: an abusive request should cost us nothing.
        mockDdbSend.mockResolvedValue({ Attributes: { attempts: 99 } });
        const response = await load()(request());

        expect(response.statusCode).toBe(429);
        expect(bodyOf(response).code).toBe('rate_limited');
        expect(bodyOf(response).retryAfterSeconds).toBe(3600);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockLambdaSend).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('source-rate-limit');
    });

    test('the global ceiling refuses after the per-source one passes', async () => {
        let call = 0;
        mockDdbSend.mockImplementation(() => {
            call += 1;
            return Promise.resolve({ Attributes: { attempts: call === 1 ? 1 : 999 } });
        });
        const response = await load()(request());

        expect(response.statusCode).toBe(429);
        expect(errors.join('\n')).toContain('global-rate-limit');
    });

    // ── Fail-closed ──────────────────────────────────────────────────────
    test('an unreadable limiter fails CLOSED: no send is queued', async () => {
        // Refusing a start costs one parent one retry. An unmetered start
        // window is what queues an unbounded number of sends.
        mockDdbSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'ProvisionedThroughputExceededException' }));
        const response = await load()(request());

        expect(response.statusCode).toBe(503);
        expect(bodyOf(response).code).toBe('unavailable');
        expect(mockLambdaSend).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('rate-limit-unavailable');
    });

    test('an unreadable Turnstile secret fails CLOSED', async () => {
        mockSsmSend.mockRejectedValue(Object.assign(new Error('ssm down'), { name: 'InternalServerError' }));
        const response = await load()(request());

        expect(response.statusCode).toBe(503);
        expect(mockLambdaSend).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('secret-unreadable');
    });

    test('a failed bot check refuses, writes no challenge and queues no send', async () => {
        global.fetch.mockResolvedValue({
            ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
        });
        const response = await load()(request());

        expect(response.statusCode).toBe(403);
        expect(bodyOf(response).code).toBe('bot_check_failed');
        expect(putCalls()).toHaveLength(0);
        expect(mockLambdaSend).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('invalid-token');
    });

    test('a missing token is refused, not waved through', async () => {
        const response = await load()(request({ turnstileToken: undefined }));
        expect(response.statusCode).toBe(403);
        expect(errors.join('\n')).toContain('missing-token');
    });

    test('an unwritable session store fails CLOSED: no send for a handle nobody can use', async () => {
        mockDdbSend.mockImplementation((cmd) => (cmd.kind === 'put'
            ? Promise.reject(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }))
            : Promise.resolve({ Attributes: { attempts: 1 } })));
        const response = await load()(request());

        expect(response.statusCode).toBe(503);
        expect(mockLambdaSend).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('session-store-unavailable');
    });

    test('a dispatcher that cannot be invoked fails CLOSED rather than stranding a parent', async () => {
        // A challenge nobody will ever send a code for leaves a parent on a
        // code screen forever, which is worse than an honest refusal.
        mockLambdaSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'TooManyRequestsException' }));
        const response = await load()(request());

        expect(response.statusCode).toBe(503);
        expect(bodyOf(response).code).toBe('unavailable');
        expect(errors.join('\n')).toContain('dispatch-unavailable');
    });

    test('when the bot check is not configured yet, starts still work', async () => {
        // There is always a window between deploying the code and creating the
        // SecureString. Failing closed on a parameter nobody has created would
        // be self-inflicted downtime.
        mockSsmSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'ParameterNotFound' }));
        const response = await load()(request());

        expect(response.statusCode).toBe(200);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    // ── Logging discipline ───────────────────────────────────────────────
    test('no log line carries the destination or the handle', async () => {
        const response = await load()(request({ destination: EMAIL }));
        const logged = errors.join('\n');

        expect(logged).toContain('AUTH_START_ACCEPTED channel=email');
        expect(logged).not.toContain(EMAIL);
        expect(logged).not.toContain(bodyOf(response).challenge);
    });

    test('every refusal is logged with a reason: no silent 4xx', async () => {
        const handler = load();
        for (const [input, marker] of [
            [{ body: '{', requestContext: {} }, 'invalid_request'],
            [request({ destination: 'x' }), 'invalid_destination'],
            [request({ destination: '+441632960001' }), 'unsupported_destination'],
        ]) {
            errors.length = 0;
            await handler(input);
            expect(errors.join('\n')).toContain(`AUTH_START_REFUSED reason=${marker}`);
        }
    });
});

describe('the staging-only Turnstile bypass', () => {
    const BYPASS = 'bypass-token-value';
    const TEST_NUMBER = '+15555550111';
    const TEST_EMAIL = 'e2e-login@a-iep.invalid';

    beforeEach(() => {
        jest.resetModules();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        mockDdbSend.mockReset().mockResolvedValue({ Attributes: { attempts: 1 } });
        mockLambdaSend.mockReset().mockResolvedValue({ StatusCode: 202 });
        // The secret EXISTS, so the real check would run without the bypass.
        mockSsmSend.mockReset().mockImplementation((cmd) => Promise.resolve({
            Parameter: { Value: cmd.input.Name === process.env.E2E_BYPASS_PARAM ? BYPASS : 'real-secret' },
        }));
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['bad'] }),
        });

        process.env.OTP_RATE_LIMIT_TABLE = 'rate-limits';
        process.env.AUTH_SESSION_TABLE = 'auth-sessions';
        process.env.TURNSTILE_SECRET_PARAM = '/a-iep/test/turnstile/secret';
        process.env.AUTH_DISPATCH_FUNCTION = 'auth-dispatch';
        process.env.E2E_BYPASS_PARAM = '/a-iep/staging/e2e-turnstile-bypass';
        process.env.TEST_PHONE_NUMBERS = TEST_NUMBER;
        process.env.TEST_EMAIL_ADDRESSES = TEST_EMAIL;
    });

    afterEach(() => {
        delete global.fetch;
        delete process.env.E2E_BYPASS_PARAM;
        delete process.env.TEST_PHONE_NUMBERS;
        delete process.env.TEST_EMAIL_ADDRESSES;
        jest.restoreAllMocks();
    });

    test.each([
        ['a fictional phone number', TEST_NUMBER],
        ['a fictional email address', TEST_EMAIL],
    ])('%s with the bypass token skips Cloudflare entirely', async (_label, destination) => {
        const response = await load()(request({ destination, turnstileToken: BYPASS }));
        expect(response.statusCode).toBe(200);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('the bypass does nothing for a real phone number', async () => {
        const response = await load()(request({ destination: PHONE, turnstileToken: BYPASS }));
        expect(response.statusCode).toBe(403);
        expect(global.fetch).toHaveBeenCalled();
    });

    test('the bypass does nothing for a real email address', async () => {
        const response = await load()(request({ destination: EMAIL, turnstileToken: BYPASS }));
        expect(response.statusCode).toBe(403);
        expect(global.fetch).toHaveBeenCalled();
    });

    test('production has no bypass at all, so a test number is still checked', async () => {
        // CDK sets E2E_BYPASS_PARAM only when the environment is not prod.
        delete process.env.E2E_BYPASS_PARAM;
        const response = await load()(request({ destination: TEST_NUMBER, turnstileToken: BYPASS }));
        expect(response.statusCode).toBe(403);
        expect(global.fetch).toHaveBeenCalled();
    });

    test('a wrong bypass token does not open the door', async () => {
        const response = await load()(request({ destination: TEST_NUMBER, turnstileToken: 'not-it-at-all' }));
        expect(response.statusCode).toBe(403);
    });

    test('using the bypass is recorded, never silent', async () => {
        const logged = [];
        console.log.mockImplementation((...args) => logged.push(args.join(' ')));
        await load()(request({ destination: TEST_NUMBER, turnstileToken: BYPASS }));
        expect(logged.join('\n')).toContain('AUTH_START_E2E_BYPASS');
    });
});
