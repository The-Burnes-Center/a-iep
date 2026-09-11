/**
 * POST /auth/verify.
 *
 * Three properties carry the weight here.
 *
 * A wrong code, an unknown handle, an expired handle and a spent session must
 * be ONE answer to the caller and FOUR log lines to us. Any difference the
 * client can see is an enumeration oracle; any of them going unlogged is a
 * defect, because an unlogged validation rejection made a real failure
 * undiagnosable once before.
 *
 * The per-destination guess counter FAILS OPEN. It runs on every verify,
 * including the one from a parent who typed their code right first time, so
 * failing closed would turn a DynamoDB blip into a total login outage for 296
 * families. The global send budget still fails closed. That asymmetry is
 * deliberate and has been misread before.
 *
 * And a wrong code must leave the parent their remaining attempts, which means
 * persisting the NEW Cognito session that comes back with the refusal.
 */
const mockCognitoSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
    CognitoIdentityProviderClient: class { send(...args) { return mockCognitoSend(...args); } },
    AdminRespondToAuthChallengeCommand: class { constructor(input) { this.input = input; this.kind = 'respond'; } },
    AdminUpdateUserAttributesCommand: class { constructor(input) { this.input = input; this.kind = 'attributes'; } },
    DescribeUserPoolClientCommand: class { constructor(input) { this.input = input; this.kind = 'describe'; } },
}), { virtual: true });

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

const PHONE = '+15551234567';
const EMAIL = 'parent@example.com';
const HANDLE = 'IvrPWtNvBOCFSRj-_CD3mA9ZiJ0dtMUk_bYs1xHBOsY';
const CLIENT_ID = 'backend-client';
const CLIENT_SECRET = 'sekrit-client-secret';
const DEST_KEY = 'a'.repeat(64);

const TOKENS = {
    AccessToken: 'access.jwt.value',
    IdToken: 'id.jwt.value',
    RefreshToken: 'refresh.jwt.value',
    ExpiresIn: 3600,
};

const now = () => Math.floor(Date.now() / 1000);

const challengeRow = (overrides = {}) => ({
    pk: `C#${'0'.repeat(64)}`,
    kind: 'challenge',
    status: 'ready',
    destination: PHONE,
    destinationKey: DEST_KEY,
    channel: 'sms',
    cognitoSession: 'otp-session',
    expiresAt: now() + 300,
    ...overrides,
});

const request = (body = {}) => ({ body: JSON.stringify({ challenge: HANDLE, code: '482913', ...body }) });

const load = () => {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../../lib/chatbot-api/functions/phone-otp-auth/auth-verify');
    });
    return mod.handler;
};

const ddbOfKind = (kind) => mockDdbSend.mock.calls.filter(([cmd]) => cmd.kind === kind).map(([cmd]) => cmd);
const bodyOf = (response) => JSON.parse(response.body);

/**
 * @param row            the challenge row, or null for "not found"
 * @param failureCount   the AUTHFAIL tally, or 'error' to make the read throw
 */
function store({ row = challengeRow(), failureCount = 0 } = {}) {
    mockDdbSend.mockImplementation((cmd) => {
        if (cmd.kind === 'get' && String(cmd.input.Key.pk).startsWith('C#')) {
            return Promise.resolve({ Item: row || undefined });
        }
        if (cmd.kind === 'get' && String(cmd.input.Key.pk).startsWith('AUTHFAIL#')) {
            if (failureCount === 'error') {
                return Promise.reject(Object.assign(new Error('down'), { name: 'InternalServerError' }));
            }
            return Promise.resolve({ Item: { failures: failureCount } });
        }
        return Promise.resolve({ Attributes: {} });
    });
}

describe('auth verify', () => {
    let logged;

    beforeEach(() => {
        jest.resetModules();
        logged = [];
        jest.spyOn(console, 'error').mockImplementation((...a) => logged.push(a.join(' ')));
        jest.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')));

        mockCognitoSend.mockReset().mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'respond') return Promise.resolve({ AuthenticationResult: TOKENS });
            return Promise.resolve({});
        });
        mockDdbSend.mockReset();
        store();

        process.env.USER_POOL_ID = 'us-east-1_test';
        process.env.AUTH_CLIENT_ID = CLIENT_ID;
        process.env.AUTH_SESSION_TABLE = 'auth-sessions';
        process.env.OTP_RATE_LIMIT_TABLE = 'rate-limits';
    });

    afterEach(() => jest.restoreAllMocks());

    test('a right code returns an opaque session handle and nothing else', async () => {
        const response = await load()(request());
        const body = bodyOf(response);

        expect(response.statusCode).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.expiresIn).toBe(2592000);
        expect(body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // The browser gets a handle, never a token. This is the whole design.
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(TOKENS.AccessToken);
        expect(serialized).not.toContain(TOKENS.IdToken);
        expect(serialized).not.toContain(TOKENS.RefreshToken);
    });

    test('the real tokens are written server-side, keyed on the HASH of the handle', async () => {
        const response = await load()(request());
        const [put] = ddbOfKind('put');

        expect(put.input.TableName).toBe('auth-sessions');
        expect(put.input.Item.refreshToken).toBe(TOKENS.RefreshToken);
        expect(put.input.Item.username).toBe(PHONE);
        expect(put.input.Item.pk).toMatch(/^S#[0-9a-f]{64}$/);
        // The handle itself is never stored, so a read of the table yields the
        // hash of a credential rather than a credential.
        expect(put.input.Item.pk).not.toContain(bodyOf(response).session);
        expect(put.input.Item.expiresAt).toBeGreaterThan(now());
    });

    test('the challenge is deleted on success: a handle is single use', async () => {
        await load()(request());
        expect(ddbOfKind('delete')).toHaveLength(1);
        expect(ddbOfKind('delete')[0].input.Key.pk).toMatch(/^C#/);
    });

    test('the answer carries a SECRET_HASH, because AWS requires it on every challenge response', async () => {
        await load()(request());
        const [respond] = mockCognitoSend.mock.calls.filter(([c]) => c.kind === 'respond').map(([c]) => c);

        const expected = require('crypto')
            .createHmac('sha256', CLIENT_SECRET).update(PHONE + CLIENT_ID).digest('base64');
        expect(respond.input.ChallengeResponses).toEqual({
            USERNAME: PHONE, ANSWER: '482913', SECRET_HASH: expected,
        });
        expect(respond.input.ChallengeName).toBe('CUSTOM_CHALLENGE');
        expect(respond.input.Session).toBe('otp-session');
        // The USERNAME comes from the stored row, never from the caller's body.
        expect(respond.input.ChallengeResponses.USERNAME).toBe(PHONE);
    });

    test('an email sign-in records that the address was proved, phone does not', async () => {
        // 8 of the 75 production email accounts are email_verified: false, and
        // a code that ARRIVED at an address is exactly what verification means.
        store({ row: challengeRow({ channel: 'email', destination: EMAIL }) });
        await load()(request());

        const attrs = mockCognitoSend.mock.calls.filter(([c]) => c.kind === 'attributes');
        expect(attrs).toHaveLength(1);
        expect(attrs[0][0].input.UserAttributes).toEqual([{ Name: 'email_verified', Value: 'true' }]);
    });

    test('an attribute write that fails does not turn away a parent who just proved possession', async () => {
        store({ row: challengeRow({ channel: 'email', destination: EMAIL }) });
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'respond') return Promise.resolve({ AuthenticationResult: TOKENS });
            return Promise.reject(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }));
        });

        const response = await load()(request());
        expect(response.statusCode).toBe(200);
        expect(logged.join('\n')).toContain('AUTH_EMAIL_NOT_MARKED_VERIFIED');
    });

    // ── One answer, four log lines ───────────────────────────────────────
    test('a wrong code, an unknown handle and a spent session are the SAME answer', async () => {
        const bodies = [];

        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.resolve({ ChallengeName: 'CUSTOM_CHALLENGE', Session: 'next-session' })));
        bodies.push(await load()(request()));

        store({ row: null });
        bodies.push(await load()(request()));

        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }))));
        bodies.push(await load()(request()));

        for (const response of bodies) {
            expect(response.statusCode).toBe(401);
            expect(bodyOf(response)).toEqual(bodyOf(bodies[0]));
            expect(bodyOf(response).code).toBe('bad_code');
        }
    });

    test('...but each one logs a DIFFERENT reason', async () => {
        const reasons = [];

        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.resolve({ Session: 'next-session' })));
        logged.length = 0;
        await load()(request());
        reasons.push(logged.join('\n'));

        store({ row: null });
        logged.length = 0;
        await load()(request());
        reasons.push(logged.join('\n'));

        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }))));
        logged.length = 0;
        await load()(request());
        reasons.push(logged.join('\n'));

        expect(reasons[0]).toContain('detail=wrong-code');
        expect(reasons[1]).toContain('detail=unknown-or-expired-challenge');
        expect(reasons[2]).toContain('detail=session-failed');
    });

    test('a wrong code persists the NEW Cognito session, so the next try is not wasted', async () => {
        // Cognito hands back a fresh session with every round, including a
        // failed one. Keep the old one and the parent's second attempt fails
        // for a reason that has nothing to do with the digits they typed.
        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.resolve({ ChallengeName: 'CUSTOM_CHALLENGE', Session: 'round-two' })));

        await load()(request());
        const rotate = ddbOfKind('update').find((c) => c.input.ExpressionAttributeValues[':sess'] === 'round-two');
        expect(rotate).toBeDefined();
        // ...and the challenge is NOT deleted: the parent still has attempts.
        expect(ddbOfKind('delete')).toHaveLength(0);
    });

    test('a spent session deletes the challenge rather than leaving it to TTL', async () => {
        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }))));

        await load()(request());
        expect(ddbOfKind('delete')).toHaveLength(1);
    });

    test('an expired row is treated as gone even before the TTL sweep reaches it', async () => {
        // DynamoDB's TTL is best-effort and can lag by up to 48 hours. A row
        // being present is not the same as a row being live.
        store({ row: challengeRow({ expiresAt: now() - 1 }) });
        const response = await load()(request());
        expect(response.statusCode).toBe(401);
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    // ── The lockout ──────────────────────────────────────────────────────
    test('ten wrong codes for one destination locks it out, plainly', async () => {
        store({ row: challengeRow(), failureCount: 10 });
        const response = await load()(request());
        const body = bodyOf(response);

        expect(response.statusCode).toBe(429);
        expect(body.code).toBe('too_many_codes');
        // Decision 4: plain, not generic. It leaks nothing -- the counter is
        // keyed on the destination whether or not an account exists there --
        // and the generic answer would leave a parent retyping a CORRECT code.
        expect(body.message).toBe('You have tried too many codes. Please try again in an hour.');
        expect(body.retryAfterSeconds).toBeGreaterThan(0);
        expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
        // And the code is never even sent to Cognito.
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('nine wrong codes is still a parent having a bad day', async () => {
        store({ row: challengeRow(), failureCount: 9 });
        const response = await load()(request());
        expect(response.statusCode).toBe(200);
    });

    test('the guess counter FAILS OPEN: a DynamoDB blip does not stop every sign-in', async () => {
        // The asymmetry the critique caught. This check runs on EVERY verify,
        // so failing closed would lock out the families typing their code
        // correctly along with everyone else. Falling back to Cognito's own
        // three-per-session cap still bounds a run to roughly fifteen guesses
        // an hour against a million, because a fresh session costs a send and
        // the send path's limiters are counting those.
        store({ row: challengeRow(), failureCount: 'error' });
        const response = await load()(request());

        expect(response.statusCode).toBe(200);
        // Loud, though: a limiter that is not enforcing must be visible.
        expect(logged.join('\n')).toContain('AUTH_VERIFY_COUNTER_UNAVAILABLE failing-open');
    });

    // ── The deferred send ────────────────────────────────────────────────
    test('a challenge whose code is still going out is retryable, not an error', async () => {
        store({ row: challengeRow({ status: 'pending', cognitoSession: undefined }) });
        const response = await load()(request());

        expect(response.statusCode).toBe(202);
        expect(bodyOf(response)).toEqual({ ok: false, code: 'not_ready', retryAfterMs: 500 });
        expect(mockCognitoSend).not.toHaveBeenCalled();
    });

    test('a send that failed tells the parent why, which is the whole point of deferring it', async () => {
        store({ row: challengeRow({ status: 'failed', reason: 'budget_exhausted' }) });
        const response = await load()(request());
        const body = bodyOf(response);

        expect(response.statusCode).toBe(409);
        expect(body.code).toBe('send_failed');
        expect(body.reason).toBe('budget_exhausted');
        expect(body.message).toContain('temporarily unavailable');
        expect(logged.join('\n')).toContain('reason=send_failed detail=budget_exhausted');
    });

    test('an unrecognised stored reason still produces a valid contract reason', async () => {
        store({ row: challengeRow({ status: 'failed', reason: 'something-else' }) });
        expect(bodyOf(await load()(request())).reason).toBe('delivery_failed');
    });

    // ── Shape and availability ───────────────────────────────────────────
    test.each([
        ['a malformed body', { body: '{' }, 'malformed-body'],
        ['no challenge', { body: JSON.stringify({ code: '123456' }) }, 'missing-challenge'],
        ['no code', { body: JSON.stringify({ challenge: HANDLE }) }, 'bad-code-format'],
        ['a code with letters', { body: JSON.stringify({ challenge: HANDLE, code: '12a456' }) }, 'bad-code-format'],
        ['an absurd code', { body: JSON.stringify({ challenge: HANDLE, code: '1'.repeat(500) }) }, 'bad-code-format'],
    ])('%s is refused before any datastore call, with a logged reason', async (_label, event, detail) => {
        const response = await load()(event);
        expect(response.statusCode).toBe(400);
        expect(bodyOf(response).code).toBe('invalid_request');
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(logged.join('\n')).toContain(`AUTH_VERIFY_REFUSED reason=invalid_request detail=${detail}`);
    });

    test('an unreadable session store is 503, NOT a sign-in failure', async () => {
        // The difference matters to the client: one means sign in again, the
        // other means try again.
        mockDdbSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
        const response = await load()(request());
        expect(response.statusCode).toBe(503);
        expect(bodyOf(response).code).toBe('unavailable');
    });

    test('an unstorable session is an honest 503, not a success with nothing behind it', async () => {
        mockDdbSend.mockImplementation((cmd) => {
            if (cmd.kind === 'put') return Promise.reject(Object.assign(new Error('down'), { name: 'InternalServerError' }));
            if (cmd.kind === 'get' && String(cmd.input.Key.pk).startsWith('C#')) return Promise.resolve({ Item: challengeRow() });
            return Promise.resolve({ Item: { failures: 0 } });
        });

        const response = await load()(request());
        expect(response.statusCode).toBe(503);
        expect(bodyOf(response).session).toBeUndefined();
    });

    test('a Cognito outage is 503, not bad_code: a parent must not be told their code was wrong', async () => {
        store({ row: challengeRow() });
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('boom'), { name: 'InternalErrorException' }))));

        const response = await load()(request());
        expect(response.statusCode).toBe(503);
        expect(logged.join('\n')).toContain('AUTH_VERIFY_FAILED');
    });

    // ── Logging discipline ───────────────────────────────────────────────
    test('no log line carries a token, the destination, the code or a handle', async () => {
        const response = await load()(request());
        const all = logged.join('\n');

        expect(all).toContain('AUTH_VERIFY_ACCEPTED channel=sms');
        expect(all).not.toContain(TOKENS.AccessToken);
        expect(all).not.toContain(TOKENS.RefreshToken);
        expect(all).not.toContain(PHONE);
        expect(all).not.toContain('482913');
        expect(all).not.toContain(HANDLE);
        expect(all).not.toContain(bodyOf(response).session);
    });
});
