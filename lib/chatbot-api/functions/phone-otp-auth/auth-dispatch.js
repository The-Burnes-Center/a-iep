/**
 * Everything /auth/start deliberately does NOT do while a parent is waiting.
 *
 * Invoked asynchronously (InvocationType: 'Event'), never from API Gateway, so
 * nothing in here is on anybody's clock. That is the whole reason it exists:
 * creating an account is two more Cognito round trips than signing an existing
 * one in, and doing that difference on the request path is a timing oracle
 * that tells an attacker which destinations are registered. Off the request
 * path it is free to branch as much as it likes.
 *
 * SECURITY, load-bearing: the password rotation below is the same pair
 * signup-endpoint.js has, moved rather than reinvented. AdminCreateUser fires
 * neither PreSignUp_SignUp nor PostConfirmation_ConfirmSignUp, so nothing
 * rotates the password on its own, and an account created without it is an
 * account whoever created it can sign into. That pair is the only reason the
 * ~1,030 accounts made by the 2026-09-09 abuse run are unusable. It stays a
 * SEPARATE try with delete-on-failure rollback, and it does not get folded
 * back into the create.
 */

const {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminDeleteUserCommand,
    AdminInitiateAuthCommand,
    AdminRespondToAuthChallengeCommand,
    DescribeUserPoolClientCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const crypto = require('crypto');
const { computeSecretHash, loadClientSecret } = require('./secret-hash');
const { markChallengeReady, markChallengeFailed } = require('./auth-store');

const cognito = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION || 'us-east-1',
});

/** A password nobody knows, including the person signing in. */
function serverPassword() {
    // Cognito requires a digit; the rest is raw entropy. crypto, not
    // Math.random: this is the only thing standing between an account and
    // whoever created it.
    return `${crypto.randomBytes(24).toString('base64url')}A9!`;
}

/**
 * A deliberate refusal from create-auth-challenge, as a contract reason.
 *
 * That trigger reports a refused or failed send through
 * publicChallengeParameters rather than raising, so the AdminRespondToAuthChallenge
 * call SUCCEEDS and the failure arrives as a field. errorCode is the machine
 * half of that field; the message beside it is the parent-facing copy in their
 * own language, which this function is not the right place to choose.
 */
const SEND_REASONS = new Set([
    'unsupported_destination', 'budget_exhausted', 'rate_limited', 'delivery_failed',
]);

exports.handler = async (event) => {
    const { handle, username, channel, language } = event || {};
    if (!handle || !username) {
        // Nothing to update and nothing to send: an invocation this malformed
        // is a bug in the caller, not a parent's problem.
        console.error('AUTH_DISPATCH_REFUSED reason=malformed-invocation');
        return;
    }

    try {
        const created = await ensureAccount(username, channel, language);
        const session = await sendCode(username, language);
        await markChallengeReady(handle, session);
        console.log(`AUTH_DISPATCH_SENT channel=${channel} created=${created}`);
    } catch (error) {
        const reason = SEND_REASONS.has(error.reason) ? error.reason : 'delivery_failed';
        // Loud on purpose: a parent is sitting on a code screen and this is
        // the only line that says why nothing arrived.
        console.error(
            `AUTH_DISPATCH_FAILED channel=${channel} reason=${reason} kind=${error.name || 'Error'}`,
        );
        try {
            await markChallengeFailed(handle, reason);
        } catch (writeError) {
            // Now the parent waits out the five-minute TTL with no
            // explanation. Worth its own line: it is the difference between a
            // bad message and no message.
            console.error(
                `AUTH_DISPATCH_UNREPORTABLE kind=${(writeError && writeError.name) || 'Error'}`,
            );
        }
    }
};

/**
 * Make sure there is a usable account at this destination.
 *
 * Three cases, and the third is the one that is easy to miss:
 *   - absent        create it, then rotate the password.
 *   - CONFIRMED     nothing to do.
 *   - UNCONFIRMED   34 accounts in the production pool are in this state and
 *                   CANNOT complete custom auth, so today they are a silent
 *                   dead end with no path out of it in code. AdminSetUserPassword
 *                   with Permanent: true is AWS's documented way to confirm an
 *                   account, and it is safe here because an UNCONFIRMED
 *                   account cannot sign in by any route at all, so replacing
 *                   whatever password it holds takes nothing away from anyone.
 *                   Possession is still proved by the OTP a moment later.
 */
async function ensureAccount(username, channel, language) {
    let status = null;
    try {
        const user = await cognito.send(new AdminGetUserCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: username,
        }));
        status = user.UserStatus;
    } catch (error) {
        if (error.name !== 'UserNotFoundException') {
            throw error;
        }
    }

    if (status === 'UNCONFIRMED') {
        await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: username,
            Password: serverPassword(),
            Permanent: true,
        }));
        console.log('AUTH_ACCOUNT_CONFIRMED an unconfirmed account was made usable');
        return false;
    }
    if (status) {
        return false;
    }

    // Verified on creation because possession is proven on every sign-in by
    // the OTP, and because Cognito's own signup code would otherwise be a
    // second message for the same account.
    const verifiedAttribute = channel === 'email'
        ? [{ Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' }]
        : [{ Name: 'phone_number', Value: username }, { Name: 'phone_number_verified', Value: 'true' }];

    await cognito.send(new AdminCreateUserCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: username,
        UserAttributes: [
            ...verifiedAttribute,
            ...(language ? [{ Name: 'locale', Value: String(language).slice(0, 8) }] : []),
        ],
        // No invitation: Cognito's message would be a second code.
        MessageAction: 'SUPPRESS',
    }));

    // A SEPARATE try, deliberately. These two calls must not share one: an
    // account created but not secured is the worst state this function can
    // produce. It sits in FORCE_CHANGE_PASSWORD, so custom-auth sign-in never
    // works, while a retry finds the account already there and does nothing --
    // a destination permanently unable to either sign up or sign in. So the
    // account is removed and the whole attempt reported as failed, which
    // leaves nothing behind and makes the retry succeed.
    try {
        // AdminCreateUser leaves the account in FORCE_CHANGE_PASSWORD with a
        // password the caller could otherwise be told; this replaces it with
        // one nobody knows and moves the account to CONFIRMED so custom-auth
        // sign-in works.
        await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: username,
            Password: serverPassword(),
            Permanent: true,
        }));
    } catch (error) {
        console.error('AUTH_DISPATCH_FAILED password-rotation', error.name, error.message);
        try {
            await cognito.send(new AdminDeleteUserCommand({
                UserPoolId: process.env.USER_POOL_ID,
                Username: username,
            }));
        } catch (rollbackError) {
            // Both failed, so an unsecured account is now live. This is the
            // one outcome here that needs a person, tonight: it is the same
            // hole the PostConfirmation rotation closed for the ~1,030
            // accounts of the 2026-09-09 run. SIGNUP_ORPHANED is the marker a
            // critical alarm counts, and it is deliberately the SAME string
            // the older signup endpoint logs so one alarm covers both paths.
            console.error('SIGNUP_ORPHANED account created but not secured and not removed',
                rollbackError.name);
        }
        throw error;
    }

    return true;
}

/**
 * Two Cognito calls, because this service's custom auth has two rounds.
 *
 * Round 1 is a language handshake that sends NOTHING: Cognito does not forward
 * AdminInitiateAuth clientMetadata to create-auth-challenge, so the first
 * round exists only to get a session that a RespondToAuthChallenge can carry
 * the language on. Round 2 is the one that sends the code, in that language.
 * verify-auth-challenge auto-passes round 1 and define-auth-challenge never
 * issues tokens for it.
 *
 * Both rounds carry SECRET_HASH. AWS: "You must provide a SECRET_HASH
 * parameter in all challenge responses to an app client that has a client
 * secret." All includes CUSTOM_CHALLENGE.
 */
async function sendCode(username, language) {
    const clientId = process.env.AUTH_CLIENT_ID;
    const clientSecret = await loadClientSecret(
        cognito, DescribeUserPoolClientCommand, process.env.USER_POOL_ID, clientId,
    );
    const secretHash = computeSecretHash(username, clientId, clientSecret);

    const initiated = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: process.env.USER_POOL_ID,
        ClientId: clientId,
        AuthFlow: 'CUSTOM_AUTH',
        AuthParameters: {
            USERNAME: username,
            SECRET_HASH: secretHash,
        },
    }));

    const answered = await cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId: process.env.USER_POOL_ID,
        ClientId: clientId,
        ChallengeName: 'CUSTOM_CHALLENGE',
        Session: initiated.Session,
        ChallengeResponses: {
            USERNAME: username,
            ANSWER: 'LANGUAGE_HANDSHAKE',
            SECRET_HASH: secretHash,
        },
        // The ONLY channel from the sign-in screen's language picker to the
        // message: RespondToAuthChallenge metadata reaches create-auth-challenge,
        // InitiateAuth metadata does not.
        ...(language ? { ClientMetadata: { language } } : {}),
    }));

    // create-auth-challenge never raises on a refused or failed send -- it
    // reports through the challenge parameters, which is why its Lambda Errors
    // metric stays at zero through a total outage. So a successful API call is
    // not a sent code, and this is where the difference is noticed.
    const failure = answered.ChallengeParameters && answered.ChallengeParameters.error;
    if (failure) {
        const error = new Error('the code could not be sent');
        error.name = 'SendRefusedError';
        error.reason = answered.ChallengeParameters.errorCode || 'delivery_failed';
        throw error;
    }
    if (!answered.Session) {
        const error = new Error('Cognito returned no session for the code round');
        error.name = 'NoSessionError';
        error.reason = 'delivery_failed';
        throw error;
    }
    return answered.Session;
}
