/**
 * POST /auth/token and POST /auth/logout: what an opaque handle is FOR.
 *
 * Three properties carry the weight.
 *
 * The refresh token never leaves this service. If it ever appears in a
 * response body the whole design is undone, so that is asserted directly.
 *
 * A dead session and an unreadable datastore must be DIFFERENT answers. 401
 * means sign in again and 503 means try again, and conflating them signs every
 * parent out on a DynamoDB blip -- which is the same class of mistake as
 * making the guess counter fail closed.
 *
 * And the REFRESH_TOKEN_AUTH secret hash is keyed on the user's `sub`, not on
 * their phone number. AWS: when the pool does not have `username` as a sign-in
 * attribute -- this one is UsernameAttributes: ['email', 'phone_number'] --
 * the secret hash username value comes from the sub claim. Using the
 * destination instead produces NotAuthorizedException, which looks exactly
 * like an expired session and would sign parents out an hour after every
 * login.
 */
const mockCognitoSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
    CognitoIdentityProviderClient: class { send(...args) { return mockCognitoSend(...args); } },
    AdminInitiateAuthCommand: class { constructor(input) { this.input = input; this.kind = 'initiate'; } },
    AdminUserGlobalSignOutCommand: class { constructor(input) { this.input = input; this.kind = 'signout'; } },
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
const HANDLE = 'm7Kq2s0Xb1fLpA6uVe4tYc9RdN8gHjZwQ3vM5nB7xTk';
const CLIENT_ID = 'backend-client';
const CLIENT_SECRET = 'sekrit-client-secret';
const SUB = 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111';

/** A real-shaped Cognito ID token: header.payload.signature, payload carries sub. */
const idTokenFor = (sub) => [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub, aud: CLIENT_ID, token_use: 'id' })).toString('base64url'),
    'not-a-real-signature',
].join('.');

const now = () => Math.floor(Date.now() / 1000);

const sessionRow = (overrides = {}) => ({
    pk: `S#${'0'.repeat(64)}`,
    kind: 'session',
    username: PHONE,
    accessToken: 'stored.access.token',
    idToken: idTokenFor(SUB),
    refreshToken: 'stored.refresh.token',
    tokenExpiresAt: now() + 3000,
    expiresAt: now() + 2592000,
    ...overrides,
});

const tokenRequest = (body = {}) => ({
    routeKey: 'POST /auth/token',
    body: JSON.stringify({ session: HANDLE, ...body }),
});
const logoutRequest = (body = {}) => ({
    routeKey: 'POST /auth/logout',
    body: JSON.stringify({ session: HANDLE, ...body }),
});

const load = () => {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../../lib/chatbot-api/functions/phone-otp-auth/auth-session');
    });
    return mod.handler;
};

const ddbOfKind = (kind) => mockDdbSend.mock.calls.filter(([cmd]) => cmd.kind === kind).map(([cmd]) => cmd);
const cognitoOfKind = (kind) => mockCognitoSend.mock.calls.filter(([cmd]) => cmd.kind === kind).map(([cmd]) => cmd);
const bodyOf = (response) => JSON.parse(response.body);

function store(row = sessionRow()) {
    mockDdbSend.mockImplementation((cmd) => (cmd.kind === 'get'
        ? Promise.resolve({ Item: row || undefined })
        : Promise.resolve({})));
}

describe('auth session', () => {
    let logged;

    beforeEach(() => {
        jest.resetModules();
        logged = [];
        jest.spyOn(console, 'error').mockImplementation((...a) => logged.push(a.join(' ')));
        jest.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')));

        mockCognitoSend.mockReset().mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'initiate') {
                return Promise.resolve({
                    AuthenticationResult: {
                        AccessToken: 'fresh.access.token',
                        IdToken: idTokenFor(SUB),
                        ExpiresIn: 3600,
                    },
                });
            }
            return Promise.resolve({});
        });
        mockDdbSend.mockReset();
        store();

        process.env.USER_POOL_ID = 'us-east-1_test';
        process.env.AUTH_CLIENT_ID = CLIENT_ID;
        process.env.AUTH_SESSION_TABLE = 'auth-sessions';
        process.env.OTP_RATE_LIMIT_TABLE = 'rate-limits';
        delete process.env.MAX_AUTH_SESSION_CALLS_PER_IP_HOUR;
    });

    afterEach(() => jest.restoreAllMocks());

    // ── /auth/token ──────────────────────────────────────────────────────
    test('a live handle returns the stored short-lived tokens, and no refresh token', async () => {
        const response = await load()(tokenRequest());
        const body = bodyOf(response);

        expect(response.statusCode).toBe(200);
        expect(body.accessToken).toBe('stored.access.token');
        expect(body.expiresIn).toBeGreaterThan(300);
        // THE assertion. A refresh token in the body would put a thirty-day
        // offline-usable credential back in the browser.
        expect(JSON.stringify(body)).not.toContain('stored.refresh.token');
        expect(body.refreshToken).toBeUndefined();
        // No Cognito call at all while the token is still good.
        expect(cognitoOfKind('initiate')).toHaveLength(0);
    });

    test('a token near expiry is refreshed, and the new one persisted with a pushed-out session', async () => {
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        const response = await load()(tokenRequest());

        expect(bodyOf(response).accessToken).toBe('fresh.access.token');
        // The first update is the per-source counter; the one under test is
        // the write to the session row.
        const update = ddbOfKind('update').find((cmd) => cmd.input.TableName === 'auth-sessions');
        expect(update.input.ExpressionAttributeValues[':a']).toBe('fresh.access.token');
        // Sliding expiry: an active parent is never signed out mid-use.
        expect(update.input.ExpressionAttributeValues[':e']).toBeGreaterThan(now() + 2592000 - 60);
        expect(update.input.ConditionExpression).toBe('attribute_exists(pk)');
    });

    test('the refresh secret hash is keyed on the SUB, not on the phone number', async () => {
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        await load()(tokenRequest());

        const [initiate] = cognitoOfKind('initiate');
        const expected = require('crypto')
            .createHmac('sha256', CLIENT_SECRET).update(SUB + CLIENT_ID).digest('base64');
        const wrong = require('crypto')
            .createHmac('sha256', CLIENT_SECRET).update(PHONE + CLIENT_ID).digest('base64');

        expect(initiate.input.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
        expect(initiate.input.AuthParameters.REFRESH_TOKEN).toBe('stored.refresh.token');
        expect(initiate.input.AuthParameters.SECRET_HASH).toBe(expected);
        expect(initiate.input.AuthParameters.SECRET_HASH).not.toBe(wrong);
    });

    test('a rejected refresh is 401 AND removes the row: that handle can never work again', async () => {
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }))));

        const response = await load()(tokenRequest());
        expect(response.statusCode).toBe(401);
        expect(bodyOf(response).code).toBe('session_invalid');
        expect(ddbOfKind('delete')).toHaveLength(1);
    });

    test('a refresh that returns no tokens is treated as a dead session, not a success', async () => {
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.resolve({})));

        expect((await load()(tokenRequest())).statusCode).toBe(401);
    });

    test('a stored id token with no sub is a dead session, not an outage', async () => {
        // There is no refresh that can ever succeed for that row.
        store(sessionRow({ tokenExpiresAt: now() + 60, idToken: 'not.a.jwt' }));
        expect((await load()(tokenRequest())).statusCode).toBe(401);
    });

    test('an unknown or expired handle is 401', async () => {
        store(null);
        const response = await load()(tokenRequest());
        expect(response.statusCode).toBe(401);
        expect(bodyOf(response).code).toBe('session_invalid');
        expect(logged.join('\n')).toContain('detail=unknown-or-expired-session');
    });

    test('an expired row is gone even before the TTL sweep reaches it', async () => {
        store(sessionRow({ expiresAt: now() - 1 }));
        expect((await load()(tokenRequest())).statusCode).toBe(401);
    });

    test('an unreadable store is 503, NOT 401: a blip must not sign everybody out', async () => {
        mockDdbSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
        const response = await load()(tokenRequest());

        expect(response.statusCode).toBe(503);
        expect(bodyOf(response).code).toBe('unavailable');
        // And nothing was deleted, so the handle still works once it recovers.
        expect(ddbOfKind('delete')).toHaveLength(0);
    });

    test('a Cognito outage during refresh is 503, and keeps the session', async () => {
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('boom'), { name: 'InternalErrorException' }))));

        const response = await load()(tokenRequest());
        expect(response.statusCode).toBe(503);
        expect(ddbOfKind('delete')).toHaveLength(0);
    });

    test('a write that fails after a good refresh still returns the tokens', async () => {
        // They are valid regardless; failing here would sign a parent out over
        // a write that only affects the next hour.
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        mockDdbSend.mockImplementation((cmd) => {
            if (cmd.kind === 'get') return Promise.resolve({ Item: sessionRow({ tokenExpiresAt: now() + 60 }) });
            // Only the session-row write fails: the per-source counter has to
            // succeed or the route is refused before a refresh is attempted.
            if (cmd.input.TableName === 'rate-limits') return Promise.resolve({ Attributes: { attempts: 1 } });
            return Promise.reject(Object.assign(new Error('down'), { name: 'InternalServerError' }));
        });

        const response = await load()(tokenRequest());
        expect(response.statusCode).toBe(200);
        expect(bodyOf(response).accessToken).toBe('fresh.access.token');
        expect(logged.join('\n')).toContain('AUTH_SESSION_NOT_PERSISTED');
    });

    test.each([
        ['a malformed body', { routeKey: 'POST /auth/token', body: '{' }, 'malformed-body'],
        ['no handle', { routeKey: 'POST /auth/token', body: '{}' }, 'missing-session'],
        ['a blank handle', { routeKey: 'POST /auth/token', body: '{"session":"   "}' }, 'missing-session'],
    ])('%s is refused before any datastore call, with a logged reason', async (_l, event, detail) => {
        const response = await load()(event);
        expect(response.statusCode).toBe(400);
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(logged.join('\n')).toContain(`AUTH_SESSION_REFUSED reason=invalid_request detail=${detail}`);
    });

    // ── /auth/logout ─────────────────────────────────────────────────────
    test('logout deletes the row and revokes the refresh token everywhere', async () => {
        const response = await load()(logoutRequest());

        expect(response.statusCode).toBe(200);
        expect(bodyOf(response)).toEqual({ ok: true });
        expect(ddbOfKind('delete')).toHaveLength(1);
        // Global sign-out is what makes the stored refresh token dead rather
        // than merely unreachable.
        expect(cognitoOfKind('signout')).toHaveLength(1);
        expect(cognitoOfKind('signout')[0].input.Username).toBe(PHONE);
    });

    test('the route is read from requestContext too, so one lambda can serve two routes', async () => {
        // HTTP API payload 2.0 carries routeKey in both places. Guessing wrong
        // would silently turn every logout into a token fetch.
        const response = await load()({
            requestContext: { routeKey: 'POST /auth/logout' },
            body: JSON.stringify({ session: HANDLE }),
        });
        expect(bodyOf(response)).toEqual({ ok: true });
        expect(ddbOfKind('delete')).toHaveLength(1);
    });

    test('logout is identical for a handle that never existed: no free oracle', async () => {
        store(null);
        const response = await load()(logoutRequest());

        expect(response.statusCode).toBe(200);
        expect(bodyOf(response)).toEqual({ ok: true });
        expect(cognitoOfKind('signout')).toHaveLength(0);
    });

    test('a global sign-out that fails still deletes the local session', async () => {
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'signout'
            ? Promise.reject(Object.assign(new Error('nope'), { name: 'NotAuthorizedException' }))
            : Promise.resolve({})));

        const response = await load()(logoutRequest());
        expect(response.statusCode).toBe(200);
        expect(ddbOfKind('delete')).toHaveLength(1);
        expect(logged.join('\n')).toContain('AUTH_LOGOUT_GLOBAL_SIGNOUT_FAILED');
    });

    test('a logout that did not actually revoke shouts about it', async () => {
        // "Logged out" that did not log out is the worst lie this endpoint can
        // tell, and nothing else would ever notice.
        mockDdbSend.mockImplementation((cmd) => (cmd.kind === 'delete'
            ? Promise.reject(Object.assign(new Error('down'), { name: 'InternalServerError' }))
            : Promise.resolve({ Item: sessionRow() })));

        const response = await load()(logoutRequest());
        expect(response.statusCode).toBe(200);
        expect(logged.join('\n')).toContain('AUTH_LOGOUT_NOT_REVOKED');
    });

    test('no log line carries a token, a handle or the destination', async () => {
        await load()(tokenRequest());
        await load()(logoutRequest());
        const all = logged.join('\n');

        expect(all).not.toContain('stored.refresh.token');
        expect(all).not.toContain('stored.access.token');
        expect(all).not.toContain(HANDLE);
        expect(all).not.toContain(PHONE);
    });

    // ── Response headers ─────────────────────────────────────────────────
    test('token bodies are never cacheable, on success or refusal', async () => {
        const ok = await load()(tokenRequest());
        expect(bodyOf(ok).accessToken).toBeDefined();
        expect(ok.headers['Cache-Control']).toBe('no-store');

        store(null);
        const refused = await load()(tokenRequest());
        expect(refused.statusCode).toBe(401);
        expect(refused.headers['Cache-Control']).toBe('no-store');

        const logout = await load()(logoutRequest());
        expect(logout.headers['Cache-Control']).toBe('no-store');
    });

    test.each([
        ['a malformed body', { routeKey: 'POST /auth/token', body: '{' }],
        ['no handle', { routeKey: 'POST /auth/logout', body: '{}' }],
    ])('%s gets a message about the session, not about a phone number', async (_l, event) => {
        const response = await load()(event);
        expect(bodyOf(response).code).toBe('invalid_request');
        expect(bodyOf(response).message).toBe('This request could not be read. Please sign in again.');
        expect(bodyOf(response).message).not.toMatch(/phone|email/i);
    });

    // ── Per-source limit ─────────────────────────────────────────────────
    describe('per-source limit', () => {
        const counterRows = () => ddbOfKind('update').filter((cmd) => cmd.input.TableName === 'rate-limits');

        const countingAt = (attempts) => mockDdbSend.mockImplementation((cmd) => {
            if (cmd.kind === 'update' && cmd.input.TableName === 'rate-limits') {
                return Promise.resolve({ Attributes: { attempts } });
            }
            return Promise.resolve(cmd.kind === 'get' ? { Item: sessionRow() } : {});
        });

        const withSource = (event, sourceIp = '203.0.113.7') => ({
            ...event, requestContext: { http: { sourceIp } },
        });

        test.each([['token', tokenRequest], ['logout', logoutRequest]])(
            '%s is counted per source, keyed on a hash and never the raw address', async (_l, build) => {
                countingAt(1);
                await load()(withSource(build(), '203.0.113.7'));

                const [row] = counterRows();
                expect(row.input.Key.pk).toMatch(/^AUTHSESSION#IP#[0-9a-f]{64}#\d+$/);
                expect(row.input.Key.pk).not.toContain('203.0.113.7');
                expect(JSON.stringify(logged)).not.toContain('203.0.113.7');
            },
        );

        test.each([['token', tokenRequest], ['logout', logoutRequest]])(
            'over the ceiling, %s is a 429 with Retry-After matching the body, and costs nothing', async (_l, build) => {
                countingAt(301); // the floor is 300 an hour

                const response = await load()(withSource(build()));
                const body = bodyOf(response);

                expect(response.statusCode).toBe(429);
                expect(body.code).toBe('rate_limited');
                expect(Number.isInteger(body.retryAfterSeconds)).toBe(true);
                expect(body.retryAfterSeconds).toBeGreaterThan(0);
                expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
                expect(response.headers['Retry-After']).toBe(String(body.retryAfterSeconds));
                // Refused before the session is even read, and before Cognito.
                expect(ddbOfKind('get')).toHaveLength(0);
                expect(mockCognitoSend).not.toHaveBeenCalled();
                expect(logged.join('\n')).toContain('AUTH_SESSION_REFUSED reason=rate_limited detail=source-rate-limit');
            },
        );

        test('at the ceiling is still allowed: a real parent is not the one counted out', async () => {
            countingAt(300);
            const response = await load()(withSource(tokenRequest()));
            expect(response.statusCode).toBe(200);
        });

        test('the ceiling is overridable per environment', async () => {
            process.env.MAX_AUTH_SESSION_CALLS_PER_IP_HOUR = '2';
            countingAt(3);
            expect((await load()(withSource(tokenRequest()))).statusCode).toBe(429);
            countingAt(2);
            expect((await load()(withSource(tokenRequest()))).statusCode).toBe(200);
        });

        test('an unreadable counter fails CLOSED: 503, no session read, no Cognito call', async () => {
            mockDdbSend.mockImplementation((cmd) => (cmd.kind === 'update'
                ? Promise.reject(Object.assign(new Error('down'), { name: 'ProvisionedThroughputExceededException' }))
                : Promise.resolve({ Item: sessionRow() })));

            const response = await load()(withSource(tokenRequest()));

            expect(response.statusCode).toBe(503);
            expect(bodyOf(response).code).toBe('unavailable');
            expect(ddbOfKind('get')).toHaveLength(0);
            expect(mockCognitoSend).not.toHaveBeenCalled();
            expect(logged.join('\n')).toContain('rate-limit-unavailable');
        });

        test('malformed requests are refused before the counter is touched', async () => {
            await load()({ routeKey: 'POST /auth/token', body: '{' });
            expect(mockDdbSend).not.toHaveBeenCalled();
        });
    });

    test('a failed delete after a dead refresh token is logged, and the answer is still 401', async () => {
        store(sessionRow({ tokenExpiresAt: now() + 60 }));
        mockCognitoSend.mockImplementation((cmd) => (cmd.kind === 'describe'
            ? Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } })
            : Promise.reject(Object.assign(new Error('revoked'), { name: 'NotAuthorizedException' }))));
        mockDdbSend.mockImplementation((cmd) => {
            if (cmd.kind === 'get') return Promise.resolve({ Item: sessionRow({ tokenExpiresAt: now() + 60 }) });
            if (cmd.kind === 'delete') return Promise.reject(Object.assign(new Error('down'), { name: 'InternalServerError' }));
            return Promise.resolve({ Attributes: { attempts: 1 } });
        });

        const response = await load()(tokenRequest());

        expect(response.statusCode).toBe(401);
        expect(logged.join('\n')).toContain('AUTH_SESSION_NOT_DELETED kind=InternalServerError');
        expect(logged.join('\n')).not.toContain(HANDLE);
    });
});
