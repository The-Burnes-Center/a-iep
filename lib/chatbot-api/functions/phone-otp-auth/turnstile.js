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

const crypto = require('crypto');

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

/** Cloudflare's documented maximum. Anything longer cannot be a real token. */
const MAX_TOKEN_LENGTH = 2048;
/** One retry, the same budget as every other outbound call in this service. */
const DEFAULT_MAX_ATTEMPTS = 2;
/** Cloudflare's own fault: worth one more try with the same idempotency key. */
const RETRYABLE_CODES = new Set(['internal-error']);
/** Our fault: the secret is wrong. Never the parent's, so never a 403. */
const MISCONFIGURED_CODES = new Set(['missing-input-secret', 'invalid-input-secret']);
/** Codes we pass to logs as they are; anything else is logged as `other`. */
const KNOWN_CODES = new Set([
    'missing-input-secret', 'invalid-input-secret', 'missing-input-response',
    'invalid-input-response', 'bad-request', 'timeout-or-duplicate', 'internal-error',
]);

/**
 * Reasons a caller should answer as "try again later" (503), not as a failed
 * check (403). A parent refused for Cloudflare's outage or our own bad secret
 * did nothing wrong, and telling them the check failed would send them round
 * a loop they cannot get out of.
 */
const UNAVAILABLE_REASONS = new Set(['verify-failed', 'misconfigured']);

function safeCodes(outcome) {
    const codes = Array.isArray(outcome?.['error-codes']) ? outcome['error-codes'] : [];
    return [...new Set(codes.filter((c) => typeof c === 'string').map((c) => (KNOWN_CODES.has(c) ? c : 'other')))].sort();
}

/**
 * The hostnames a token may have been solved on, from
 * TURNSTILE_EXPECTED_HOSTNAMES, or null when the check is off.
 *
 * Off by default because Cloudflare's always-pass test keys answer with a
 * placeholder hostname, so only an environment with an enforcing widget can
 * set it. The widget's own hostname list already stops a token being minted
 * anywhere else; this is the server-side half Cloudflare recommends, so a
 * hostname added to the widget by mistake does not silently become a way in.
 */
function expectedHostnames() {
    const raw = process.env.TURNSTILE_EXPECTED_HOSTNAMES || '';
    const list = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    return list.length ? new Set(list) : null;
}

/** One siteverify call. Throws only for a transport-level failure. */
async function postVerify(payload) {
    const response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        return { transient: `status ${response.status}`, retryable: response.status >= 500 };
    }
    try {
        return { outcome: await response.json() };
    } catch {
        return { transient: 'unreadable response', retryable: true };
    }
}

/**
 * Verify one token.
 *
 * `remoteIp` is optional and only improves Cloudflare's own scoring. It is
 * never logged here: the caller decides what it records about a client.
 *
 * `maxAttempts` exists for the PreSignUp trigger, which Cognito gives five
 * seconds in total, so it cannot afford a retry. Everything else retries once
 * on a network error, a 5xx or Cloudflare's `internal-error`, reusing one
 * idempotency key so the retry is not treated as a second use of the token.
 *
 * Reasons: `missing-token` (absent or not a plausible token), `invalid-token`
 * (Cloudflare said no), `hostname-mismatch` (solved somewhere we do not
 * serve), `verify-failed` (could not get an answer) and `misconfigured` (our
 * secret is wrong). See UNAVAILABLE_REASONS for which are the parent's fault.
 */
async function verifyToken({ token, secret, remoteIp, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
    if (typeof token !== 'string' || token.trim().length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: 'missing-token' };
    }
    const payload = {
        secret,
        response: token,
        idempotency_key: crypto.randomUUID(),
        ...(remoteIp ? { remoteip: remoteIp } : {}),
    };

    let detail = 'no attempt made';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let result;
        try {
            result = await postVerify(payload);
        } catch (error) {
            detail = error.name === 'TimeoutError' ? 'timeout' : error.message;
            continue;
        }
        if (result.transient) {
            detail = result.transient;
            if (!result.retryable) break;
            continue;
        }
        const { outcome } = result;
        const codes = safeCodes(outcome);
        if (outcome?.success === true) {
            const allowed = expectedHostnames();
            const hostname = String(outcome.hostname || '').toLowerCase();
            if (allowed && !allowed.has(hostname)) {
                return { ok: false, reason: 'hostname-mismatch', codes: [] };
            }
            return { ok: true };
        }
        if (codes.some((c) => MISCONFIGURED_CODES.has(c))) {
            // Every signup and sign-in is refused until someone fixes the
            // secret, so this must be loud. Never logs the secret itself.
            console.error(`TURNSTILE_MISCONFIGURED codes=${codes.join(',')}`);
            return { ok: false, reason: 'misconfigured', codes };
        }
        if (codes.some((c) => RETRYABLE_CODES.has(c))) {
            detail = 'internal-error';
            continue;
        }
        // Cloudflare's codes name the cause and carry no personal data.
        return { ok: false, reason: 'invalid-token', codes };
    }
    return { ok: false, reason: 'verify-failed', detail };
}

module.exports = { loadSecret, verifyToken, resetSecretCache, UNAVAILABLE_REASONS, MAX_TOKEN_LENGTH };
