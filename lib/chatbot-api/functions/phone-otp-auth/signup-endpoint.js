/**
 * The only way to create an account.
 *
 * Signup used to go straight from the browser to Cognito's public SignUp API,
 * which is exactly how the 2026-09-09 abuse run worked: it never loaded the
 * site, so every control that lived in the browser was simply not in its
 * path. With AllowAdminCreateUserOnly set on the pool, that API is closed and
 * this is the front door.
 *
 * Checks run cheapest first, so an abusive request is refused before it costs
 * anything: shape, then destination policy, then per-source limit, then global
 * limit, then Turnstile last because it is the only step with an external
 * dependency.
 *
 * SECURITY, load-bearing: this function also does what the PostConfirmation
 * trigger used to. AdminCreateUser fires neither PreSignUp_SignUp nor
 * PostConfirmation_ConfirmSignUp, so the password rotation that kept ~1,030
 * abuse accounts from being usable does not happen on its own any more. It is
 * an explicit step below. Creating an account without it would hand the caller
 * a password that works.
 */

const crypto = require('crypto');
const { loadSecret, verifyToken } = require('./turnstile');

const {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminDeleteUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const cognito = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION || 'us-east-1',
});

let docClient = null;
function getDocClient() {
    if (!docClient) {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        docClient = DynamoDBDocumentClient.from(
            new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })
        );
    }
    return docClient;
}

const E164 = /^\+[1-9]\d{7,14}$/;

// Compiled floors. A real family signs up once, so three attempts from one
// address in an hour already covers mistyping a number twice.
//
// The GLOBAL ceiling is the one that actually bounds an attack, and it is why
// the per-source limit can stay humane: spreading across 293 addresses, as the
// 2026-09-09 run did, defeats a per-source limit entirely but runs straight
// into this one. That run created 1,028 accounts in thirteen minutes.
//
// Overridable per environment because staging runs an E2E suite that signs up
// repeatedly from one CI address, which is indistinguishable from abuse by
// any rule that would also stop abuse.
const FLOOR_SIGNUPS_PER_IP_HOUR = 3;
const FLOOR_SIGNUPS_PER_HOUR = 20;

/** A positive integer override, ignoring anything unparseable. */
function numericEnv(name, fallback) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_ALLOWED_PREFIXES = ['+1'];

/**
 * The success body, byte-identical whether or not an account was created.
 *
 * It used to be `{ created: true }` or `{ created: false }`, which is a clean
 * enumeration oracle on an unauthenticated route with an open CORS header:
 * post a number, read the body, learn whether that person has an account. The
 * comment beside it claimed the opposite, and the test asserting it was named
 * "an existing account is not revealed to the caller".
 *
 * Nothing in the app ever read the field. Both cases mean the same thing to a
 * caller anyway: go to the sign-in screen and ask for a code.
 */
const SIGNUP_ACCEPTED = Object.freeze({ ok: true });

/** An API Gateway response. Bodies stay generic; reasons go to CloudWatch. */
const respond = (statusCode, body) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
});

/**
 * Count one attempt against a window, and say whether it is over.
 *
 * Fails CLOSED. The per-phone limiter in create-auth-challenge fails open so a
 * datastore blip cannot lock everyone out of LOGIN, which is the right call
 * there and the wrong one here: refusing a signup costs one person one retry,
 * and an unmetered signup window is what produced a thousand accounts.
 */
async function overLimit(key, max, ttlSeconds) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await getDocClient().send(new UpdateCommand({
        TableName: process.env.SIGNUP_RATE_LIMIT_TABLE,
        Key: { pk: key },
        UpdateExpression: 'ADD attempts :one SET expiresAt = if_not_exists(expiresAt, :expiry)',
        ExpressionAttributeValues: {
            ':one': 1,
            ':expiry': Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        ReturnValues: 'ALL_NEW',
    }));
    return (result.Attributes?.attempts || 0) > max;
}

/** A password nobody knows, including the person signing up. */
function serverPassword() {
    // Cognito requires a digit; the rest is raw entropy. crypto, not
    // Math.random: this is the only thing standing between an account and
    // whoever created it.
    return `${crypto.randomBytes(24).toString('base64url')}A9!`;
}

/** Hashed, because a raw client IP is personal data we have no reason to keep. */
const sourceKey = (ip) => crypto.createHash('sha256').update(ip || 'unknown').digest('hex');

exports.handler = async (event) => {
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const sourceIp = event.requestContext?.http?.sourceIp;

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        console.error('SIGNUP_REFUSED reason=malformed-body');
        return respond(400, { error: 'Invalid request.' });
    }

    const phoneNumber = (body.phoneNumber || '').trim();
    if (!E164.test(phoneNumber)) {
        // Logged, never silent: an unlogged validation rejection made a real
        // failure undiagnosable once before.
        console.error('SIGNUP_REFUSED reason=bad-phone-format');
        return respond(400, { error: 'Enter a valid phone number.' });
    }

    const prefixes = (process.env.SIGNUP_ALLOWED_COUNTRY_CODES || '')
        .split(',').map((p) => p.trim()).filter(Boolean);
    const allowed = prefixes.length > 0 ? prefixes : DEFAULT_ALLOWED_PREFIXES;
    if (!allowed.some((prefix) => phoneNumber.startsWith(prefix))) {
        console.error(`SIGNUP_REFUSED reason=unsupported-destination prefix=${phoneNumber.slice(0, 4)}`);
        return respond(400, { error: 'This phone number is not supported.' });
    }

    try {
        if (await overLimit(`SIGNUP#IP#${sourceKey(sourceIp)}#${hourBucket}`,
            numericEnv('MAX_SIGNUPS_PER_IP_HOUR', FLOOR_SIGNUPS_PER_IP_HOUR), 2 * 60 * 60)) {
            console.error('SIGNUP_REFUSED reason=source-rate-limit');
            return respond(429, { error: 'Too many attempts. Please try again later.' });
        }
        if (await overLimit(`SIGNUP#GLOBAL#${hourBucket}`,
            numericEnv('MAX_SIGNUPS_PER_HOUR', FLOOR_SIGNUPS_PER_HOUR), 2 * 60 * 60)) {
            console.error('SIGNUP_REFUSED reason=global-rate-limit');
            return respond(429, { error: 'Sign-ups are temporarily paused. Please try again later.' });
        }
    } catch (error) {
        console.error('SIGNUP_REFUSED reason=rate-limit-unavailable', error.message);
        return respond(503, { error: 'Sign-up is temporarily unavailable.' });
    }

    let secret;
    try {
        secret = await loadSecret(process.env.TURNSTILE_SECRET_PARAM);
    } catch (error) {
        console.error('SIGNUP_REFUSED reason=secret-unreadable', error.message);
        return respond(503, { error: 'Sign-up is temporarily unavailable.' });
    }
    if (secret) {
        const check = await verifyToken({ token: body.turnstileToken, secret, remoteIp: sourceIp });
        if (!check.ok) {
            console.error(`SIGNUP_REFUSED reason=${check.reason} codes=${(check.codes || []).join(',')}`);
            return respond(403, { error: 'Could not verify this request. Please try again.' });
        }
    }

    try {
        await cognito.send(new AdminCreateUserCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: phoneNumber,
            // Verified on creation because possession is proven on every
            // sign-in by the OTP, and because Cognito's own signup code would
            // otherwise be a second SMS for the same account.
            UserAttributes: [
                { Name: 'phone_number', Value: phoneNumber },
                { Name: 'phone_number_verified', Value: 'true' },
                ...(body.language ? [{ Name: 'locale', Value: String(body.language).slice(0, 8) }] : []),
            ],
            // No invitation: Cognito's message would be a second text.
            MessageAction: 'SUPPRESS',
        }));
    } catch (error) {
        if (error.name === 'UsernameExistsException') {
            // Not an error for the caller: an existing account should just
            // sign in.
            console.log('Signup for an existing account; the caller proceeds to sign-in');
            return respond(200, SIGNUP_ACCEPTED);
        }
        // Generic to the caller, detail to CloudWatch: returning str(e) leaked
        // table names and AWS error codes once before.
        console.error('SIGNUP_FAILED', error.name, error.message);
        return respond(500, { error: 'Sign-up could not be completed.' });
    }

    // A SEPARATE try, deliberately. These two calls used to share one, and an
    // account created but not secured is the worst state this function can
    // produce: it sits in FORCE_CHANGE_PASSWORD, so custom-auth sign-in never
    // works, while the retry hits UsernameExistsException and is told to go
    // and sign in. That is a phone number permanently unable to either sign
    // up or sign in, with no path out of it in code.
    //
    // So the account is removed and the caller told to try again, which
    // leaves nothing behind and makes the retry succeed.
    try {
        // AdminCreateUser leaves the account in FORCE_CHANGE_PASSWORD with a
        // password the caller could otherwise be told; this replaces it with
        // one nobody knows and moves the account to CONFIRMED so custom-auth
        // sign-in works.
        await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: phoneNumber,
            Password: serverPassword(),
            Permanent: true,
        }));
    } catch (error) {
        console.error('SIGNUP_FAILED password-rotation', error.name, error.message);
        try {
            await cognito.send(new AdminDeleteUserCommand({
                UserPoolId: process.env.USER_POOL_ID,
                Username: phoneNumber,
            }));
        } catch (rollbackError) {
            // Both failed, so an unsecured account is now live. This is the
            // one outcome here that needs a person, tonight: it is the same
            // hole the PostConfirmation rotation closed for the ~1,030
            // accounts of the 2026-09-09 run.
            console.error('SIGNUP_ORPHANED account created but not secured and not removed',
                rollbackError.name);
        }
        return respond(500, { error: 'Sign-up could not be completed.' });
    }

    console.log('SIGNUP_CREATED');
    return respond(200, SIGNUP_ACCEPTED);
};
