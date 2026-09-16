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
/** When the cached "not configured" answer stops being trusted. */
let unconfiguredUntil = 0;

/**
 * How long "there is no secret yet" is cached for.
 *
 * A found secret is cached for the life of the container, because it does not
 * change. A MISSING one must not be, and this is the difference: the secret is
 * created out of band, so there is always a moment where the code is deployed
 * and the SecureString does not exist yet. A container warmed in that window
 * would otherwise go on accepting unverified signups for as long as it lives,
 * with the check sitting fully configured and switched off. Five minutes is
 * the same TTL the SMS policy uses for the same reason.
 */
const UNCONFIGURED_TTL_MS = 5 * 60 * 1000;

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
    // A cached secret is good for the life of the container; a cached "not
    // configured" expires, so the check switches itself on once the secret
    // exists without needing a deploy to clear warm containers.
    if (cachedSecret) {
        return cachedSecret;
    }
    if (cachedSecret === null && Date.now() < unconfiguredUntil) {
        return cachedSecret;
    }
    if (!parameterName) {
        return markUnconfigured('no secret parameter configured');
    }
    try {
        const { GetParameterCommand } = require('@aws-sdk/client-ssm');
        const result = await getSsmClient().send(new GetParameterCommand({
            Name: parameterName,
            WithDecryption: true,
        }));
        if (!result.Parameter?.Value) {
            return markUnconfigured('secret parameter is empty');
        }
        cachedSecret = result.Parameter.Value;
    } catch (error) {
        if (error.name === 'ParameterNotFound') {
            return markUnconfigured('secret parameter does not exist');
        }
        // Deliberately not cached: a transient SSM failure must not disable
        // the check for the whole life of this container.
        throw error;
    }
    return cachedSecret;
}

/**
 * Record that the check is not switched on, and say so out loud.
 *
 * Logged every time rather than once, because this is the marker an alarm
 * counts: a single line at container start would be invisible by the time
 * anyone looked. The TTL bounds how often it repeats.
 */
function markUnconfigured(reason) {
    console.warn(`TURNSTILE_NOT_CONFIGURED: ${reason}, signups are unverified`);
    cachedSecret = null;
    unconfiguredUntil = Date.now() + UNCONFIGURED_TTL_MS;
    return cachedSecret;
}

/** Test seam: drop the cached secret so the next call re-reads it. */
function resetSecretCache() {
    cachedSecret = undefined;
    unconfiguredUntil = 0;
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
