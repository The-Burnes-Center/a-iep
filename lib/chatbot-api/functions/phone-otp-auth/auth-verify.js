/**
 * POST /auth/verify -- the code a parent typed.
 *
 * Four different things collapse into one answer here, on purpose: a wrong
 * code, a challenge handle that never existed, one that has expired, and one
 * whose three Cognito attempts are spent all return `bad_code`. A client
 * cannot tell them apart and must not try. Each of them IS distinguished in
 * the log, because CLAUDE.md is right that a silent 4xx is a defect and an
 * unlogged validation rejection made a real failure undiagnosable once before.
 *
 * The one refusal that is deliberately specific is the lockout. Its counter is
 * keyed on the destination whether or not an account exists there, so a
 * stranger's number and a registered one produce the identical message: it
 * leaks nothing, and the alternative leaves a parent retyping a CORRECT code
 * into a wall with no idea why.
 */

const {
    CognitoIdentityProviderClient,
    AdminRespondToAuthChallengeCommand,
    AdminUpdateUserAttributesCommand,
    DescribeUserPoolClientCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const { computeSecretHash, loadClientSecret } = require('./secret-hash');
const { errorResponse, parseBody, respond, SEND_FAILURE_MESSAGES } = require('./auth-http');
const { CHALLENGE_FIELD, SESSION_FIELD, readHandle, writeHandle } = require('./auth-transport');
const {
    SESSION_TTL_SECONDS,
    deleteChallenge,
    getChallenge,
    isDestinationLockedOut,
    putSession,
    recordFailedVerification,
    rotateCognitoSession,
    secondsUntilHourEnds,
} = require('./auth-store');

const cognito = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION || 'us-east-1',
});

// Six digits and nothing else. Bounded before any comparison, because the
// value came from the internet.
const CODE = /^\d{4,8}$/;

exports.handler = async (event) => {
    const body = parseBody(event);
    if (!body) {
        return errorResponse(400, 'invalid_request', {
            marker: 'AUTH_VERIFY_REFUSED', detail: 'malformed-body',
        });
    }

    const handle = readHandle(body, CHALLENGE_FIELD);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!handle || !CODE.test(code)) {
        return errorResponse(400, 'invalid_request', {
            marker: 'AUTH_VERIFY_REFUSED',
            detail: handle ? 'bad-code-format' : 'missing-challenge',
        });
    }

    let challenge;
    try {
        challenge = await getChallenge(handle);
    } catch (error) {
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_VERIFY_REFUSED',
            detail: `session-store-unavailable kind=${error.name || 'Error'}`,
        });
    }
    if (!challenge) {
        // Unknown or expired. Same answer as a wrong code, different log line.
        return errorResponse(401, 'bad_code', {
            marker: 'AUTH_VERIFY_REFUSED', detail: 'unknown-or-expired-challenge',
        });
    }

    // The lockout, BEFORE the code is known good, because it has to be. Fails
    // OPEN: see isDestinationLockedOut for why this one and not the others.
    const lockout = await isDestinationLockedOut(challenge.destinationKey);
    if (lockout.lockedOut) {
        return errorResponse(429, 'too_many_codes', {
            marker: 'AUTH_VERIFY_REFUSED',
            detail: `destination-locked-out failures=${lockout.failures}`,
            extra: { retryAfterSeconds: secondsUntilHourEnds() },
        });
    }

    if (challenge.status === 'pending') {
        // Not an error: /auth/start answers before the send finishes, so that
        // a new account and a returning parent do the same work while the
        // caller waits. Retryable, and effectively never seen by a human who
        // had to read a message first.
        return respond(202, { ok: false, code: 'not_ready', retryAfterMs: 500 });
    }
    if (challenge.status === 'failed') {
        const reason = SEND_FAILURE_MESSAGES[challenge.reason] ? challenge.reason : 'delivery_failed';
        console.error(`AUTH_VERIFY_REFUSED reason=send_failed detail=${reason}`);
        return respond(409, {
            ok: false,
            code: 'send_failed',
            reason,
            message: SEND_FAILURE_MESSAGES[reason],
        });
    }

    const clientId = process.env.AUTH_CLIENT_ID;
    let answered;
    try {
        const clientSecret = await loadClientSecret(
            cognito, DescribeUserPoolClientCommand, process.env.USER_POOL_ID, clientId,
        );
        answered = await cognito.send(new AdminRespondToAuthChallengeCommand({
            UserPoolId: process.env.USER_POOL_ID,
            ClientId: clientId,
            ChallengeName: 'CUSTOM_CHALLENGE',
            Session: challenge.cognitoSession,
            // AWS: "You must provide a SECRET_HASH parameter in all challenge
            // responses to an app client that has a client secret." All
            // includes CUSTOM_CHALLENGE.
            ChallengeResponses: {
                USERNAME: challenge.destination,
                ANSWER: code,
                SECRET_HASH: computeSecretHash(challenge.destination, clientId, clientSecret),
            },
            ...(challenge.language ? { ClientMetadata: { language: challenge.language } } : {}),
        }));
    } catch (error) {
        // NotAuthorizedException is what Cognito returns once
        // define-auth-challenge fails the session, which is after three wrong
        // OTP rounds. The challenge is dead, so it is removed rather than left
        // to TTL, and the parent starts again.
        if (error.name === 'NotAuthorizedException') {
            await recordFailedVerification(challenge.destinationKey);
            await deleteChallenge(handle).catch(() => {});
            return errorResponse(401, 'bad_code', {
                marker: 'AUTH_VERIFY_REFUSED', detail: 'session-failed',
            });
        }
        // Generic to the caller, detail to CloudWatch.
        console.error('AUTH_VERIFY_FAILED', error.name, error.message);
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_VERIFY_REFUSED', detail: `cognito kind=${error.name || 'Error'}`,
        });
    }

    const tokens = answered.AuthenticationResult;
    if (!tokens) {
        // Wrong code, and Cognito has issued another round. Persisting the NEW
        // session is what lets the parent use their remaining attempts: keep
        // the old one and the next try fails for a reason that has nothing to
        // do with the digits they typed.
        await recordFailedVerification(challenge.destinationKey);
        if (answered.Session) {
            await rotateCognitoSession(handle, answered.Session).catch((error) => {
                console.error(`AUTH_VERIFY_SESSION_NOT_ROTATED kind=${error.name || 'Error'}`);
            });
        }
        return errorResponse(401, 'bad_code', {
            marker: 'AUTH_VERIFY_REFUSED', detail: 'wrong-code',
        });
    }

    // A code that arrived at an address is exactly what "this address belongs
    // to this person" means, so record it. 8 of the 75 email accounts in the
    // production pool are email_verified: false and would otherwise stay that
    // way forever. Best effort: a parent who just proved possession must not
    // be turned away because an attribute write failed.
    if (challenge.channel === 'email') {
        await markEmailVerified(challenge.destination);
    }

    // Single use. Deleted rather than left to TTL so a replay of the same
    // handle finds nothing.
    await deleteChallenge(handle).catch((error) => {
        console.error(`AUTH_VERIFY_CHALLENGE_NOT_CLEARED kind=${error.name || 'Error'}`);
    });

    let sessionHandle;
    try {
        sessionHandle = await putSession({ username: challenge.destination, tokens });
    } catch (error) {
        // The parent is authenticated and we cannot give them a way to prove
        // it. Honest 503 rather than a success with no session behind it.
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_VERIFY_REFUSED',
            detail: `session-store-unavailable kind=${error.name || 'Error'}`,
        });
    }

    // Never the handle, never a token, never the destination.
    console.log(`AUTH_VERIFY_ACCEPTED channel=${challenge.channel}`);
    const { body: payload, headers } = writeHandle(
        { ok: true, expiresIn: SESSION_TTL_SECONDS },
        SESSION_FIELD,
        sessionHandle,
    );
    return respond(200, payload, headers);
};

async function markEmailVerified(address) {
    try {
        await cognito.send(new AdminUpdateUserAttributesCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: address,
            UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
        }));
    } catch (error) {
        console.error(`AUTH_EMAIL_NOT_MARKED_VERIFIED kind=${error.name || 'Error'}`);
    }
}
