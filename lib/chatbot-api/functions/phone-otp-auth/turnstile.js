/**
 * Cloudflare Turnstile verification, shared by the signup endpoint and the
 * PreSignUp trigger.
 *
 * One implementation on purpose. Two copies of a security check drift, and the
 * copy that drifts is the one nobody is looking at.
 *
 * Returns a result rather than throwing, because the two callers need
 * different shapes: the endpoint answers with an HTTP status, the trigger
 * throws so Cognito refuses the signup. Deciding that here would force one of
 * them to unpick it.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Signup is interactive, so somebody is watching a spinner.
const TIMEOUT_MS = 5000;

let ssmClient = null;
function getSsmClient() {
    if (!ssmClient) {
        const { SSMClient } = require('@aws-sdk/client-ssm');
        ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    return ssmClient;
}

// The secret outlives an invocation and never changes between them.
let cachedSecret;

/**
 * The configured secret, or null when the check is not switched on yet.
 *
 * `null` and a thrown error mean different things and callers must treat them
 * differently. Null is "no secret parameter exists", i.e. nobody has turned
 * this on, which is the state between deploying the code and creating the
 * SecureString. A secret cannot live in a public repo, so that gap is real and
 * refusing every signup during it would be self-inflicted downtime.
 *
 * Anything else throws, and callers fail closed: once a secret exists, an SSM
 * outage or a permissions mistake must not quietly reopen the door.
 */
async function loadSecret(parameterName) {
    if (cachedSecret !== undefined) {
        return cachedSecret;
    }
    if (!parameterName) {
        cachedSecret = null;
        return cachedSecret;
    }
    try {
        const { GetParameterCommand } = require('@aws-sdk/client-ssm');
        const result = await getSsmClient().send(new GetParameterCommand({
            Name: parameterName,
            WithDecryption: true,
        }));
        cachedSecret = result.Parameter?.Value || null;
    } catch (error) {
        if (error.name === 'ParameterNotFound') {
            console.warn('TURNSTILE_NOT_CONFIGURED: no secret parameter, signups are unverified');
            cachedSecret = null;
            return cachedSecret;
        }
        // Deliberately not cached: a transient SSM failure must not disable
        // the check for the whole life of this container.
        throw error;
    }
    return cachedSecret;
}

/** Test seam: drop the cached secret so the next call re-reads it. */
function resetSecretCache() {
    cachedSecret = undefined;
}

/**
 * Verify one token.
 *
 * `remoteIp` is optional and only improves Cloudflare's own scoring. It is
 * never logged here: the caller decides what it records about a client.
 */
async function verifyToken({ token, secret, remoteIp }) {
    if (typeof token !== 'string' || token.trim().length === 0) {
        return { ok: false, reason: 'missing-token' };
    }
    let outcome;
    try {
        const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret,
                response: token,
                ...(remoteIp ? { remoteip: remoteIp } : {}),
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            return { ok: false, reason: 'verify-failed', detail: `status ${response.status}` };
        }
        outcome = await response.json();
    } catch (error) {
        return { ok: false, reason: 'verify-failed', detail: error.message };
    }
    if (!outcome.success) {
        // Cloudflare's codes name the cause and carry no personal data.
        return { ok: false, reason: 'invalid-token', codes: outcome['error-codes'] || [] };
    }
    return { ok: true };
}

module.exports = { loadSecret, verifyToken, resetSecretCache };
