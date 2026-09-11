/**
 * SECRET_HASH, checked against AWS's own answer rather than against itself.
 *
 * The two expected values below were produced by AWS's documented shell
 * one-liner, run outside this process:
 *
 *   echo -n "{username}{clientId}" \
 *     | openssl dgst -sha256 -hmac {clientSecret} -binary \
 *     | openssl enc -base64 -A
 *
 * (Amazon Cognito Developer Guide, "Computing secret hash values".) That
 * matters more than usual here: a hash computed with the arguments the wrong
 * way round is still a hash, still 44 characters, still base64, and Cognito
 * rejects it with exactly the same NotAuthorizedException as no hash at all.
 * A test that recomputed the value the same way the code does would agree with
 * a wrong implementation forever.
 */
const {
    computeSecretHash,
    loadClientSecret,
    resetClientSecretCache,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/secret-hash');

const CLIENT_ID = '1example23456789';
const CLIENT_SECRET = 'sekrit-client-secret';

describe('computeSecretHash', () => {
    test('matches the value AWS\'s own openssl recipe produces, for a phone username', () => {
        expect(computeSecretHash('+15551234567', CLIENT_ID, CLIENT_SECRET))
            .toBe('5nAkRgUw5Vx7SIUEmv6HrgEXPK/SwtnH5F8rxZL+71w=');
    });

    test('matches it for an email username too', () => {
        // A-IEP passes the destination as USERNAME, and AWS permits "the value
        // of any user pool sign-in attribute" there, so both kinds have to work.
        expect(computeSecretHash('parent@example.com', CLIENT_ID, CLIENT_SECRET))
            .toBe('HIXtaYtZOkzfsWGhiBx1+hJu84lE1YVmNrghIRyy49k=');
    });

    test('the message is username THEN client id, not the other way round', () => {
        // The usual mistake, and it fails identically to omitting the hash.
        expect(computeSecretHash('+15551234567', CLIENT_ID, CLIENT_SECRET))
            .not.toBe(computeSecretHash(CLIENT_ID, '+15551234567', CLIENT_SECRET));
    });

    test('the KEY is the client secret, not the client id', () => {
        const keyedOnSecret = computeSecretHash('+15551234567', CLIENT_ID, CLIENT_SECRET);
        const keyedOnClientId = require('crypto')
            .createHmac('sha256', CLIENT_ID)
            .update('+15551234567' + CLIENT_SECRET)
            .digest('base64');
        expect(keyedOnSecret).not.toBe(keyedOnClientId);
    });

    test('standard base64, not base64url', () => {
        // base64url would silently rewrite + and / and Cognito would refuse it.
        const hash = computeSecretHash('+15551234567', CLIENT_ID, CLIENT_SECRET);
        expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
        expect(hash).toHaveLength(44);
    });

    test.each([
        ['no username', [null, CLIENT_ID, CLIENT_SECRET]],
        ['no client id', ['+15551234567', null, CLIENT_SECRET]],
        ['no client secret', ['+15551234567', CLIENT_ID, null]],
    ])('throws rather than producing a wrong hash when there is %s', (_label, args) => {
        // Loud, because a wrong hash and a missing one fail identically at
        // Cognito: the only chance to tell them apart is here.
        expect(() => computeSecretHash(...args)).toThrow(/username, a client id and a client secret/);
    });
});

describe('loadClientSecret', () => {
    class DescribeUserPoolClientCommand {
        constructor(input) { this.input = input; }
    }

    beforeEach(() => resetClientSecretCache());

    test('reads the secret from Cognito, scoped to the pool and client asked for', async () => {
        const send = jest.fn().mockResolvedValue({ UserPoolClient: { ClientSecret: 'from-cognito' } });
        const secret = await loadClientSecret(
            { send }, DescribeUserPoolClientCommand, 'us-east-1_pool', 'client-1',
        );

        expect(secret).toBe('from-cognito');
        expect(send.mock.calls[0][0].input)
            .toEqual({ UserPoolId: 'us-east-1_pool', ClientId: 'client-1' });
    });

    test('caches for the life of the container: the login path does not re-read it', async () => {
        const send = jest.fn().mockResolvedValue({ UserPoolClient: { ClientSecret: 'from-cognito' } });
        await loadClientSecret({ send }, DescribeUserPoolClientCommand, 'pool', 'client');
        await loadClientSecret({ send }, DescribeUserPoolClientCommand, 'pool', 'client');
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('a client with NO secret is a security regression, and says so', async () => {
        // Not a transient fault: it means the two-client split has been undone
        // and the browser's client could do what only the backend should.
        const send = jest.fn().mockResolvedValue({ UserPoolClient: {} });
        await expect(loadClientSecret({ send }, DescribeUserPoolClientCommand, 'pool', 'client'))
            .rejects.toThrow('AUTH_CLIENT_MISCONFIGURED');
    });

    test('a read failure propagates rather than being cached as "no secret"', async () => {
        // Caching a transient failure would disable signing for the whole life
        // of the container, which looks exactly like a wrong secret.
        const send = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }))
            .mockResolvedValue({ UserPoolClient: { ClientSecret: 'from-cognito' } });

        await expect(loadClientSecret({ send }, DescribeUserPoolClientCommand, 'pool', 'client'))
            .rejects.toThrow('throttled');
        await expect(loadClientSecret({ send }, DescribeUserPoolClientCommand, 'pool', 'client'))
            .resolves.toBe('from-cognito');
    });
});
