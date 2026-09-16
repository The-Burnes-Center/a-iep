/**
 * POST /auth/token and POST /auth/logout -- what an opaque handle is FOR.
 *
 * The browser holds a handle and nothing else. It cannot call any of the
 * FERPA-scoped routes with a handle, because those are behind a JWT
 * authorizer, so this is where a handle becomes a short-lived access and ID
 * token that live in memory for an hour and are never written down.
 *
 * The refresh token stays here. That is the entire point: today all three
 * tokens sit in localStorage, readable by any script on the origin, and the
 * refresh token among them is a thirty-day offline-usable credential that
 * nothing server-side even knows was taken. Moving it behind a handle makes
 * revocation one DeleteItem instead of waiting out a month.
 *
 * Honest about what this is not: a handle in localStorage is still stealable
 * by an attacker who can run script on the origin, and so are the tokens in
 * memory. This is better than today, not immune. What it removes is the
 * long-lived credential.
 */

const {
    CognitoIdentityProviderClient,
    AdminInitiateAuthCommand,
    AdminUserGlobalSignOutCommand,
    DescribeUserPoolClientCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const { computeSecretHash, loadClientSecret } = require('./secret-hash');
const { errorResponse, parseBody, respond } = require('./auth-http');
const { SESSION_FIELD, readHandle } = require('./auth-transport');
const { deleteSession, getSession, refreshSessionTokens } = require('./auth-store');

const cognito = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION || 'us-east-1',
});

// Refresh when the access token has less than this left, so a call made
// moments after a token fetch cannot arrive at the API already expired.
const REFRESH_THRESHOLD_SECONDS = 300;

exports.handler = async (event) => {
    // HTTP API payload format 2.0 puts routeKey at the top level AND inside
    // requestContext. Both are read because one lambda serves two routes and
    // guessing wrong here would silently turn every logout into a token fetch.
    const routeKey = (event && event.routeKey)
        || (event && event.requestContext && event.requestContext.routeKey);
    const body = parseBody(event);
    if (!body) {
        return errorResponse(400, 'invalid_request', {
            marker: 'AUTH_SESSION_REFUSED', detail: 'malformed-body',
        });
    }
    const handle = readHandle(body, SESSION_FIELD);
    if (!handle) {
        return errorResponse(400, 'invalid_request', {
            marker: 'AUTH_SESSION_REFUSED', detail: 'missing-session',
        });
    }

    if (routeKey === 'POST /auth/logout') {
        return logout(handle);
    }
    return token(handle);
};

async function token(handle) {
    let session;
    try {
        session = await getSession(handle);
    } catch (error) {
        // NOT session_invalid. The difference matters to the client: one means
        // sign in again, the other means try again, and getting it wrong signs
        // every parent out on a DynamoDB blip.
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_SESSION_REFUSED',
            detail: `session-store-unavailable kind=${error.name || 'Error'}`,
        });
    }
    if (!session) {
        return errorResponse(401, 'session_invalid', {
            marker: 'AUTH_SESSION_REFUSED', detail: 'unknown-or-expired-session',
        });
    }

    const remaining = (session.tokenExpiresAt || 0) - Math.floor(Date.now() / 1000);
    if (remaining > REFRESH_THRESHOLD_SECONDS) {
        return respond(200, {
            ok: true,
            accessToken: session.accessToken,
            idToken: session.idToken,
            expiresIn: remaining,
        });
    }

    let refreshed;
    try {
        refreshed = await refreshTokens(session);
    } catch (error) {
        if (error.name === 'NotAuthorizedException' || error.name === 'UserNotFoundException') {
            // The refresh token is dead: the account was disabled, deleted, or
            // globally signed out. Remove the row so the handle stops costing
            // a Cognito call on every retry.
            await deleteSession(handle).catch(() => {});
            return errorResponse(401, 'session_invalid', {
                marker: 'AUTH_SESSION_REFUSED', detail: `refresh-rejected kind=${error.name}`,
            });
        }
        console.error('AUTH_SESSION_FAILED', error.name, error.message);
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_SESSION_REFUSED', detail: `cognito kind=${error.name || 'Error'}`,
        });
    }

    try {
        await refreshSessionTokens(handle, refreshed);
    } catch (error) {
        // The tokens below are good regardless; failing the call would sign a
        // parent out over a write that only affects the NEXT hour.
        console.error(`AUTH_SESSION_NOT_PERSISTED kind=${error.name || 'Error'}`);
    }

    return respond(200, {
        ok: true,
        accessToken: refreshed.AccessToken,
        idToken: refreshed.IdToken,
        expiresIn: refreshed.ExpiresIn || 3600,
    });
}

/**
 * New tokens from the stored refresh token.
 *
 * The SECRET_HASH username element is NOT the phone number or address here.
 * AWS: "When your app requests new tokens in an authentication operation with
 * REFRESH_TOKEN_AUTH, the value of the username element depends on your
 * sign-in attributes. When your user pool doesn't have `username` as a sign-in
 * attribute, set the secret hash username value from the user's `sub` claim."
 * This pool is UsernameAttributes: ['email', 'phone_number'], so `username` is
 * not a sign-in attribute and the sub is what goes in. Using the destination
 * here instead produces NotAuthorizedException, which looks exactly like an
 * expired session and would sign parents out an hour after every login.
 */
async function refreshTokens(session) {
    const clientId = process.env.AUTH_CLIENT_ID;
    const clientSecret = await loadClientSecret(
        cognito, DescribeUserPoolClientCommand, process.env.USER_POOL_ID, clientId,
    );
    const subject = subjectOf(session);
    const result = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: process.env.USER_POOL_ID,
        ClientId: clientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: {
            REFRESH_TOKEN: session.refreshToken,
            SECRET_HASH: computeSecretHash(subject, clientId, clientSecret),
        },
    }));
    if (!result.AuthenticationResult) {
        const error = new Error('refresh returned no tokens');
        error.name = 'NotAuthorizedException';
        throw error;
    }
    // A refresh does not re-issue the refresh token, so the stored one stays.
    return result.AuthenticationResult;
}

/**
 * The `sub` claim out of the stored ID token.
 *
 * Read, not verified. The token was handed to us by Cognito over TLS inside
 * this same service and written straight to the row; it never passed through a
 * browser, so there is no attacker in the path to have forged it. Verifying a
 * signature here would be ceremony, and the failure mode of getting it wrong
 * is an immediate NotAuthorizedException rather than a silent acceptance.
 */
function subjectOf(session) {
    const parts = String(session.idToken || '').split('.');
    if (parts.length !== 3) {
        throw missingSubject();
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        throw missingSubject();
    }
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
        throw missingSubject();
    }
    return claims.sub;
}

function missingSubject() {
    // Treated as a dead session rather than an outage: without a sub there is
    // no refresh that can ever succeed for this row.
    const error = new Error('stored id token carries no sub claim');
    error.name = 'NotAuthorizedException';
    return error;
}

/**
 * Destroy a session.
 *
 * `{ ok: true }` for a valid handle, an expired one and one that never
 * existed, because a logout that reports whether the handle was real is a
 * free oracle on a route that needs no authentication.
 */
async function logout(handle) {
    let session = null;
    try {
        session = await getSession(handle);
    } catch (error) {
        console.error(`AUTH_LOGOUT_LOOKUP_FAILED kind=${error.name || 'Error'}`);
    }

    // Global sign-out first: it is the part that revokes the refresh token
    // everywhere rather than just here, and it needs the row that the delete
    // below removes.
    if (session && session.username) {
        try {
            await cognito.send(new AdminUserGlobalSignOutCommand({
                UserPoolId: process.env.USER_POOL_ID,
                Username: session.username,
            }));
        } catch (error) {
            console.error(`AUTH_LOGOUT_GLOBAL_SIGNOUT_FAILED kind=${error.name || 'Error'}`);
        }
    }

    try {
        await deleteSession(handle);
    } catch (error) {
        // The parent is told they are signed out and the row survives. Loud,
        // because "logged out" that did not log out is the worst kind of lie
        // this endpoint can tell.
        console.error(`AUTH_LOGOUT_NOT_REVOKED kind=${error.name || 'Error'}`);
    }

    console.log('AUTH_LOGOUT_ACCEPTED');
    return respond(200, { ok: true });
}
