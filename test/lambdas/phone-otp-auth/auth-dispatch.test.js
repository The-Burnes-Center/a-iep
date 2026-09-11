/**
 * The dispatcher: everything /auth/start deliberately does not do while a
 * parent is waiting.
 *
 * The load-bearing assertion in this file is the password rotation. It moved
 * here from signup-endpoint.js and it is the only reason the ~1,030 accounts
 * created by the 2026-09-09 abuse run are unusable: AdminCreateUser fires
 * neither PreSignUp nor PostConfirmation, so nothing rotates on its own, and
 * an account created without it is an account whoever created it can sign
 * into. It has to still happen, and it has to still roll back.
 *
 * Second: SECRET_HASH on EVERY Cognito call. AWS requires it in all challenge
 * responses to a client that has a client secret, and omitting it throws
 * NotAuthorizedException with nothing in the message pointing at why.
 */
const mockCognitoSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
    CognitoIdentityProviderClient: class { send(...args) { return mockCognitoSend(...args); } },
    AdminGetUserCommand: class { constructor(input) { this.input = input; this.kind = 'get-user'; } },
    AdminCreateUserCommand: class { constructor(input) { this.input = input; this.kind = 'create'; } },
    AdminSetUserPasswordCommand: class { constructor(input) { this.input = input; this.kind = 'password'; } },
    AdminDeleteUserCommand: class { constructor(input) { this.input = input; this.kind = 'delete'; } },
    AdminInitiateAuthCommand: class { constructor(input) { this.input = input; this.kind = 'initiate'; } },
    AdminRespondToAuthChallengeCommand: class { constructor(input) { this.input = input; this.kind = 'respond'; } },
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
const HANDLE = 'a-handle';
const CLIENT_ID = 'backend-client';
const CLIENT_SECRET = 'sekrit-client-secret';

const userNotFound = () => Object.assign(new Error('nope'), { name: 'UserNotFoundException' });

const load = () => {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../../lib/chatbot-api/functions/phone-otp-auth/auth-dispatch');
    });
    return mod.handler;
};

const ofKind = (kind) => mockCognitoSend.mock.calls.filter(([cmd]) => cmd.kind === kind).map(([cmd]) => cmd);
const updates = () => mockDdbSend.mock.calls.filter(([cmd]) => cmd.kind === 'update').map(([cmd]) => cmd);

/** Cognito's happy path: describe, [account], initiate, respond. */
function cognitoHappyPath({ userExists = false } = {}) {
    mockCognitoSend.mockImplementation((cmd) => {
        switch (cmd.kind) {
            case 'describe':
                return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            case 'get-user':
                return userExists
                    ? Promise.resolve({ UserStatus: 'CONFIRMED' })
                    : Promise.reject(userNotFound());
            case 'initiate':
                return Promise.resolve({ ChallengeName: 'CUSTOM_CHALLENGE', Session: 'handshake-session' });
            case 'respond':
                return Promise.resolve({
                    ChallengeName: 'CUSTOM_CHALLENGE',
                    Session: 'otp-session',
                    ChallengeParameters: { phone_number: PHONE },
                });
            default:
                return Promise.resolve({});
        }
    });
}

describe('auth dispatch', () => {
    let logged;

    beforeEach(() => {
        jest.resetModules();
        logged = [];
        jest.spyOn(console, 'error').mockImplementation((...a) => logged.push(a.join(' ')));
        jest.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')));

        mockCognitoSend.mockReset();
        mockDdbSend.mockReset().mockResolvedValue({});
        process.env.USER_POOL_ID = 'us-east-1_test';
        process.env.AUTH_CLIENT_ID = CLIENT_ID;
        process.env.AUTH_SESSION_TABLE = 'auth-sessions';
        cognitoHappyPath();
    });

    afterEach(() => jest.restoreAllMocks());

    // ── The rotation, which must survive ─────────────────────────────────
    test('creates the account and IMMEDIATELY replaces its password', async () => {
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        const [create] = ofKind('create');
        const [password] = ofKind('password');
        expect(create).toBeDefined();
        expect(password).toBeDefined();

        // Cognito's own message would be a second code for the same account.
        expect(create.input.MessageAction).toBe('SUPPRESS');
        expect(create.input.UserAttributes).toEqual(expect.arrayContaining([
            { Name: 'phone_number', Value: PHONE },
            { Name: 'phone_number_verified', Value: 'true' },
        ]));

        // Permanent, so the account leaves FORCE_CHANGE_PASSWORD and custom
        // auth can run at all.
        expect(password.input.Permanent).toBe(true);
        expect(password.input.Username).toBe(PHONE);
        // A password nobody has ever seen, from crypto rather than Math.random.
        expect(password.input.Password).toMatch(/^[A-Za-z0-9_-]{32}A9!$/);
    });

    test('an email signup verifies the address, not a phone it does not have', async () => {
        await load()({ handle: HANDLE, username: EMAIL, channel: 'email' });

        const [create] = ofKind('create');
        expect(create.input.UserAttributes).toEqual(expect.arrayContaining([
            { Name: 'email', Value: EMAIL },
            { Name: 'email_verified', Value: 'true' },
        ]));
        expect(JSON.stringify(create.input.UserAttributes)).not.toContain('phone_number');
    });

    test('a failed rotation DELETES the account it just made, and reports failure', async () => {
        // An account created but not secured sits in FORCE_CHANGE_PASSWORD:
        // it can never sign in, and the destination can never sign up again
        // because it is taken. Removing it is the only way out in code.
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.reject(userNotFound());
            if (cmd.kind === 'password') return Promise.reject(Object.assign(new Error('boom'), { name: 'InvalidPasswordException' }));
            return Promise.resolve({});
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        expect(ofKind('delete')).toHaveLength(1);
        expect(ofKind('delete')[0].input.Username).toBe(PHONE);
        // No code was ever sent, and the parent is told so rather than left
        // waiting on a message that is not coming.
        expect(ofKind('initiate')).toHaveLength(0);
        expect(updates()[0].input.ExpressionAttributeValues[':failed']).toBe('failed');
    });

    test('when BOTH the rotation and the rollback fail, it shouts SIGNUP_ORPHANED', async () => {
        // The one outcome here that needs a person tonight: an unsecured
        // account is live. A critical alarm keys on this exact literal, and it
        // is deliberately the same string the older signup endpoint logs so
        // one alarm covers both paths.
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.reject(userNotFound());
            if (cmd.kind === 'password') return Promise.reject(Object.assign(new Error('boom'), { name: 'InvalidPasswordException' }));
            if (cmd.kind === 'delete') return Promise.reject(Object.assign(new Error('boom'), { name: 'InternalErrorException' }));
            return Promise.resolve({});
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        expect(logged.join('\n')).toContain('SIGNUP_ORPHANED');
    });

    test('an existing CONFIRMED account is not created and not re-passworded', async () => {
        cognitoHappyPath({ userExists: true });
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        expect(ofKind('create')).toHaveLength(0);
        // Rotating an existing parent's password would lock the 75 email
        // accounts out of the password path that still works for them today.
        expect(ofKind('password')).toHaveLength(0);
        expect(ofKind('initiate')).toHaveLength(1);
    });

    test('an UNCONFIRMED account is made usable instead of being a dead end', async () => {
        // 34 accounts in the production pool are UNCONFIRMED and CANNOT
        // complete custom auth, so today they are a silent dead end. An
        // UNCONFIRMED account cannot sign in by any route, so replacing its
        // password takes nothing from anyone, and possession is still proved
        // by the code a moment later.
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.resolve({ UserStatus: 'UNCONFIRMED' });
            if (cmd.kind === 'initiate') return Promise.resolve({ Session: 'handshake-session' });
            if (cmd.kind === 'respond') return Promise.resolve({ Session: 'otp-session', ChallengeParameters: {} });
            return Promise.resolve({});
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        expect(ofKind('create')).toHaveLength(0);
        expect(ofKind('password')).toHaveLength(1);
        expect(ofKind('password')[0].input.Permanent).toBe(true);
        expect(logged.join('\n')).toContain('AUTH_ACCOUNT_CONFIRMED');
        expect(ofKind('initiate')).toHaveLength(1);
    });

    // ── SECRET_HASH ──────────────────────────────────────────────────────
    test('every Cognito auth call carries a SECRET_HASH, computed AWS\'s way', async () => {
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        // Base64(HMAC-SHA256(clientSecret, username + clientId)), verified
        // independently in secret-hash.test.js against AWS's own openssl
        // recipe. Recomputed here rather than hard-coded so this test tracks
        // the username actually sent.
        const expected = require('crypto')
            .createHmac('sha256', CLIENT_SECRET).update(PHONE + CLIENT_ID).digest('base64');

        expect(ofKind('initiate')[0].input.AuthParameters.SECRET_HASH).toBe(expected);
        // "You must provide a SECRET_HASH parameter in all challenge responses
        // to an app client that has a client secret." All includes
        // CUSTOM_CHALLENGE, which is every round of this service's login.
        expect(ofKind('respond')[0].input.ChallengeResponses.SECRET_HASH).toBe(expected);
    });

    test('the sign-in runs on the CONFIDENTIAL client, in CUSTOM_AUTH', async () => {
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        const [initiate] = ofKind('initiate');

        expect(initiate.input.ClientId).toBe(CLIENT_ID);
        expect(initiate.input.AuthFlow).toBe('CUSTOM_AUTH');
        expect(initiate.input.AuthParameters.USERNAME).toBe(PHONE);
    });

    test('the language rides on the RespondToAuthChallenge, the only call that carries it', async () => {
        // Cognito does not forward AdminInitiateAuth clientMetadata to
        // create-auth-challenge; only RespondToAuthChallenge metadata reaches
        // it. Put it on the wrong call and every code is in English.
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms', language: 'vi' });

        expect(ofKind('initiate')[0].input.ClientMetadata).toBeUndefined();
        expect(ofKind('respond')[0].input.ClientMetadata).toEqual({ language: 'vi' });
        expect(ofKind('respond')[0].input.ChallengeResponses.ANSWER).toBe('LANGUAGE_HANDSHAKE');
    });

    test('exactly ONE code round: never two messages for one start', async () => {
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        expect(ofKind('initiate')).toHaveLength(1);
        expect(ofKind('respond')).toHaveLength(1);
    });

    // ── Reporting the outcome ────────────────────────────────────────────
    test('on success the Cognito session is stored, and the row goes ready', async () => {
        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        const [update] = updates();
        expect(update.input.TableName).toBe('auth-sessions');
        expect(update.input.ExpressionAttributeValues).toEqual({
            ':ready': 'ready', ':sess': 'otp-session',
        });
        // Never recreates a row the TTL already swept: that row would have no
        // expiresAt and would live forever.
        expect(update.input.ConditionExpression).toBe('attribute_exists(pk)');
        expect(logged.join('\n')).toContain('AUTH_DISPATCH_SENT');
    });

    test.each([
        ['unsupported_destination', 'unsupported_destination'],
        ['budget_exhausted', 'budget_exhausted'],
        ['rate_limited', 'rate_limited'],
    ])('a refused send is recorded as %s, so the parent is told the truth', async (code, expected) => {
        // create-auth-challenge NEVER raises on a refused send: it reports
        // through the challenge parameters, so a successful API call is not a
        // sent code. This is where the difference is noticed.
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.resolve({ UserStatus: 'CONFIRMED' });
            if (cmd.kind === 'initiate') return Promise.resolve({ Session: 's1' });
            if (cmd.kind === 'respond') {
                return Promise.resolve({
                    Session: 's2',
                    ChallengeParameters: { error: 'some parent-facing copy', errorCode: code },
                });
            }
            return Promise.resolve({});
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });

        expect(updates()[0].input.ExpressionAttributeValues[':reason']).toBe(expected);
        expect(logged.join('\n')).toContain(`AUTH_DISPATCH_FAILED channel=sms reason=${expected}`);
    });

    test('an unrecognised refusal code falls back to delivery_failed rather than leaking through', async () => {
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.resolve({ UserStatus: 'CONFIRMED' });
            if (cmd.kind === 'initiate') return Promise.resolve({ Session: 's1' });
            if (cmd.kind === 'respond') {
                return Promise.resolve({ Session: 's2', ChallengeParameters: { error: 'x', errorCode: 'something-new' } });
            }
            return Promise.resolve({});
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        expect(updates()[0].input.ExpressionAttributeValues[':reason']).toBe('delivery_failed');
    });

    test('a Cognito failure is recorded as delivery_failed, never left silent', async () => {
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.resolve({ UserStatus: 'CONFIRMED' });
            return Promise.reject(Object.assign(new Error('boom'), { name: 'InternalErrorException' }));
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        expect(updates()[0].input.ExpressionAttributeValues[':reason']).toBe('delivery_failed');
        expect(logged.join('\n')).toContain('AUTH_DISPATCH_FAILED');
    });

    test('a response with no session is a failure, not a success with nothing behind it', async () => {
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.resolve({ UserStatus: 'CONFIRMED' });
            if (cmd.kind === 'initiate') return Promise.resolve({ Session: 's1' });
            if (cmd.kind === 'respond') return Promise.resolve({ ChallengeParameters: {} });
            return Promise.resolve({});
        });

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        expect(updates()[0].input.ExpressionAttributeValues[':failed']).toBe('failed');
    });

    test('a failure it cannot even record says so: that is a parent with no message at all', async () => {
        mockCognitoSend.mockImplementation((cmd) => {
            if (cmd.kind === 'describe') return Promise.resolve({ UserPoolClient: { ClientSecret: CLIENT_SECRET } });
            if (cmd.kind === 'get-user') return Promise.resolve({ UserStatus: 'CONFIRMED' });
            return Promise.reject(Object.assign(new Error('boom'), { name: 'InternalErrorException' }));
        });
        mockDdbSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'ResourceNotFoundException' }));

        await load()({ handle: HANDLE, username: PHONE, channel: 'sms' });
        expect(logged.join('\n')).toContain('AUTH_DISPATCH_UNREPORTABLE');
    });

    test('a malformed invocation touches nothing', async () => {
        await load()({});
        expect(mockCognitoSend).not.toHaveBeenCalled();
        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(logged.join('\n')).toContain('AUTH_DISPATCH_REFUSED reason=malformed-invocation');
    });

    test('no log line carries the destination', async () => {
        await load()({ handle: HANDLE, username: EMAIL, channel: 'email' });
        expect(logged.join('\n')).not.toContain(EMAIL);
        expect(logged.join('\n')).toContain('AUTH_DISPATCH_SENT channel=email');
    });
});
