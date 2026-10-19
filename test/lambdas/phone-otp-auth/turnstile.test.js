/**
 * verifyToken against Cloudflare's server-side validation guidance: a size
 * limit before any call, one retry with a reused idempotency key for
 * Cloudflare's own faults, a loud and distinct answer for our own bad secret,
 * and the response's hostname checked when one is expected.
 *
 * No network: global.fetch is scripted per test.
 */
// turnstile.js builds its SSM client at load, and the SDK comes from the Lambda
// runtime rather than node_modules. verifyToken never touches SSM, so a bare
// stub is enough here.
jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {},
    GetParameterCommand: class {},
}), { virtual: true });

const { verifyToken, UNAVAILABLE_REASONS, MAX_TOKEN_LENGTH } = require(
    '../../../lib/chatbot-api/functions/phone-otp-auth/turnstile');

// Not a real secret: Cloudflare's published always-pass test value.
const SECRET = '1x0000000000000000000000000000000AA';

const answer = (body, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});
const sentBodies = () => global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));

let errors;
beforeEach(() => {
    global.fetch = jest.fn();
    errors = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
    delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;
});
afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
});

describe('before Cloudflare is asked', () => {
    test.each([undefined, '', '   ', 42])('%p is refused without a call', async (token) => {
        await expect(verifyToken({ token, secret: SECRET })).resolves.toMatchObject({ ok: false, reason: 'missing-token' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a token longer than Cloudflare ever issues is refused without a call', async () => {
        const token = 'x'.repeat(MAX_TOKEN_LENGTH + 1);
        await expect(verifyToken({ token, secret: SECRET })).resolves.toMatchObject({ reason: 'missing-token' });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe("Cloudflare's answer", () => {
    test('success passes, and sends the visitor IP when there is one', async () => {
        global.fetch.mockReturnValue(answer({ success: true, hostname: 'a-iep.org' }));
        await expect(verifyToken({ token: 't', secret: SECRET, remoteIp: '203.0.113.9' })).resolves.toEqual({ ok: true });
        expect(sentBodies()[0]).toMatchObject({ secret: SECRET, response: 't', remoteip: '203.0.113.9' });
    });

    test('a rejected token is the caller\'s 403, with Cloudflare\'s codes', async () => {
        global.fetch.mockReturnValue(answer({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
        const result = await verifyToken({ token: 't', secret: SECRET });
        expect(result).toEqual({ ok: false, reason: 'invalid-token', codes: ['timeout-or-duplicate'] });
        expect(UNAVAILABLE_REASONS.has(result.reason)).toBe(false);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('codes Cloudflare does not document are logged as "other"', async () => {
        global.fetch.mockReturnValue(answer({ success: false, 'error-codes': ['something-new'] }));
        await expect(verifyToken({ token: 't', secret: SECRET })).resolves.toMatchObject({ codes: ['other'] });
    });

    test('a bad secret is ours to fix: unavailable, loud, and never retried', async () => {
        global.fetch.mockReturnValue(answer({ success: false, 'error-codes': ['invalid-input-secret'] }));
        const result = await verifyToken({ token: 't', secret: SECRET });
        expect(result.reason).toBe('misconfigured');
        expect(UNAVAILABLE_REASONS.has(result.reason)).toBe(true);
        expect(errors.join('\n')).toContain('TURNSTILE_MISCONFIGURED');
        expect(errors.join('\n')).not.toContain(SECRET);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('retrying Cloudflare\'s own faults', () => {
    test.each([
        ['internal-error', () => answer({ success: false, 'error-codes': ['internal-error'] })],
        ['a 5xx', () => answer({}, 502)],
        ['a network error', () => Promise.reject(new Error('socket hang up'))],
    ])('%s is retried once, with the same idempotency key', async (_label, fault) => {
        global.fetch
            .mockImplementationOnce(fault)
            .mockReturnValueOnce(answer({ success: true }));
        await expect(verifyToken({ token: 't', secret: SECRET })).resolves.toEqual({ ok: true });
        const [first, second] = sentBodies();
        expect(first.idempotency_key).toEqual(expect.any(String));
        expect(second.idempotency_key).toBe(first.idempotency_key);
    });

    test('two faults in a row give up as unavailable, not as a failed check', async () => {
        global.fetch.mockReturnValue(answer({}, 503));
        const result = await verifyToken({ token: 't', secret: SECRET });
        expect(result.reason).toBe('verify-failed');
        expect(UNAVAILABLE_REASONS.has(result.reason)).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('a 4xx is not retried: asking again cannot change it', async () => {
        global.fetch.mockReturnValue(answer({}, 400));
        await expect(verifyToken({ token: 't', secret: SECRET })).resolves.toMatchObject({ reason: 'verify-failed' });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('maxAttempts 1 makes exactly one call, for a caller with no time to retry', async () => {
        global.fetch.mockReturnValue(answer({}, 503));
        await verifyToken({ token: 't', secret: SECRET, maxAttempts: 1 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('each verification gets its own idempotency key', async () => {
        global.fetch.mockReturnValue(answer({ success: true }));
        await verifyToken({ token: 'a', secret: SECRET });
        await verifyToken({ token: 'b', secret: SECRET });
        const [first, second] = sentBodies();
        expect(first.idempotency_key).not.toBe(second.idempotency_key);
    });
});

describe('the hostname a token was solved on', () => {
    test('is not checked when no hostname is expected', async () => {
        global.fetch.mockReturnValue(answer({ success: true, hostname: 'example.com' }));
        await expect(verifyToken({ token: 't', secret: SECRET })).resolves.toEqual({ ok: true });
    });

    test('passes when it is one we serve, whatever its case', async () => {
        process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'a-iep.org, dev.a-iep.org';
        global.fetch.mockReturnValue(answer({ success: true, hostname: 'A-IEP.org' }));
        await expect(verifyToken({ token: 't', secret: SECRET })).resolves.toEqual({ ok: true });
    });

    test('refuses a valid token solved somewhere else', async () => {
        process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'a-iep.org';
        global.fetch.mockReturnValue(answer({ success: true, hostname: 'evil.example' }));
        const result = await verifyToken({ token: 't', secret: SECRET });
        expect(result).toMatchObject({ ok: false, reason: 'hostname-mismatch' });
        expect(UNAVAILABLE_REASONS.has(result.reason)).toBe(false);
    });

    test('refuses a valid token with no hostname at all', async () => {
        process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'a-iep.org';
        global.fetch.mockReturnValue(answer({ success: true }));
        await expect(verifyToken({ token: 't', secret: SECRET })).resolves.toMatchObject({ reason: 'hostname-mismatch' });
    });
});
