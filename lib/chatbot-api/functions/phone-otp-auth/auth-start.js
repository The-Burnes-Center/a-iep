/**
 * POST /auth/start -- the front door.
 *
 * One field on the sign-in screen takes a US phone number or an email address,
 * and this decides which it is, creates the account if there is none, and
 * sends exactly one code. The response body is byte-identical whether or not
 * the destination was already registered, and so is the work done while the
 * caller waits.
 *
 * ## Why this answers before the code is sent
 *
 * An identical body is defeated by a stopwatch. Creating an account is
 * AdminCreateUser plus AdminSetUserPassword; signing an existing one in is
 * neither. Two extra round trips to Cognito are tens to hundreds of
 * milliseconds, repeatable, and averaging over a few hundred requests
 * separates a registered destination from an unregistered one cleanly.
 *
 * The obvious fix is to sleep every request to a fixed floor above the slow
 * branch's p99. That was rejected: OWASP's Authentication and Forgot Password
 * cheat sheets prescribe equalising the WORK, not the clock -- "making sure
 * that the same logic is followed, instead of using a quick exit method" --
 * and a floor taxes every parent's every sign-in by more than a second,
 * forever, while silently reopening the oracle the day AWS's p99 drifts past
 * the number nobody re-measured.
 *
 * So this function does not branch at all. It does the same six cheap things
 * for every caller and hands everything that depends on whether the account
 * exists to auth-dispatch, asynchronously, after the response. A new account
 * and a returning parent are not merely indistinguishable in the body: they
 * execute the same instructions. ASVS 5.0 section 6.3.8 asks that valid users
 * cannot be deduced from different response times; this is how.
 *
 * The cost is that the send's outcome is not known yet, which is why
 * /auth/verify has `not_ready` and `send_failed`. Telling a parent the truth a
 * second late beats telling all of them a comfortable lie on time.
 *
 * ## Order
 *
 * Cheapest first, so an abusive request is refused before it costs anything:
 * shape, destination policy, per-source limit, global limit, then Turnstile
 * last because it is the only step with an external dependency. Same ordering
 * signup-endpoint.js already uses, for the same reason.
 */

const { loadSecret, verifyToken } = require('./turnstile');
const { isE2EBypass } = require('./e2e-bypass');
const { classifyDestination, destinationKey, isTestAddress } = require('./destination');
const { normalizeLanguage } = require('./messages');
const { errorResponse, parseBody, respond } = require('./auth-http');
const { CHALLENGE_FIELD, writeHandle } = require('./auth-transport');
const { CHALLENGE_TTL_SECONDS, bumpCounter, mintHandle, putChallenge } = require('./auth-store');

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Compiled floors, overridable per environment. A parent legitimately starts
// more than once -- a typo, a code that expired, switching from email to
// phone -- so ten an hour from one address is humane and still far below what
// a run needs.
//
// The GLOBAL ceiling is a coarse outer bound rather than the operative
// control: the per-destination and service-wide SMS and email budgets in
// create-auth-challenge and email-suppression.js are tighter and bind first.
// This one exists so that a flood is refused before it reaches the dispatcher
// at all, which is the layer that costs money.
const FLOOR_STARTS_PER_IP_HOUR = 10;
const FLOOR_STARTS_PER_HOUR = 100;

function numericEnv(name, fallback) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Hashed, because a raw client IP is personal data we have no reason to keep. */
const crypto = require('crypto');
const sourceKey = (ip) => crypto.createHash('sha256').update(ip || 'unknown').digest('hex');

exports.handler = async (event) => {
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const sourceIp = event?.requestContext?.http?.sourceIp;

    const body = parseBody(event);
    if (!body) {
        return errorResponse(400, 'invalid_request', {
            marker: 'AUTH_START_REFUSED', detail: 'malformed-body',
        });
    }

    // 1. Shape and destination policy. Free, so first.
    const destination = classifyDestination(body.destination);
    if (!destination.ok) {
        // All three of these are 400: the caller sent something this service
        // will not act on, and which of the three it was is in the `code`
        // rather than in the status, so a client branches on one field.
        return errorResponse(400, destination.code, {
            marker: 'AUTH_START_REFUSED', detail: destination.detail,
        });
    }
    const { channel, value: username } = destination;
    const language = normalizeLanguage(body.language);

    // 2. Per-source, then global. Both FAIL CLOSED.
    //
    // Refusing a start costs one parent one retry. An unmetered start window
    // is what queues an unbounded number of sends, and a thousand accounts in
    // thirteen minutes is what that looked like the last time. The
    // per-destination guess counter in /auth/verify fails OPEN instead, and
    // that asymmetry is deliberate -- see isDestinationLockedOut.
    try {
        const perIp = await bumpCounter(
            `AUTHSTART#IP#${sourceKey(sourceIp)}#${hourBucket}`,
            numericEnv('MAX_AUTH_STARTS_PER_IP_HOUR', FLOOR_STARTS_PER_IP_HOUR),
            2 * 60 * 60,
        );
        if (perIp.over) {
            return errorResponse(429, 'rate_limited', {
                marker: 'AUTH_START_REFUSED',
                detail: 'source-rate-limit',
                extra: { retryAfterSeconds: 3600 },
            });
        }
        const global = await bumpCounter(
            `AUTHSTART#GLOBAL#${hourBucket}`,
            numericEnv('MAX_AUTH_STARTS_PER_HOUR', FLOOR_STARTS_PER_HOUR),
            2 * 60 * 60,
        );
        if (global.over) {
            return errorResponse(429, 'rate_limited', {
                marker: 'AUTH_START_REFUSED',
                detail: 'global-rate-limit',
                extra: { retryAfterSeconds: 3600 },
            });
        }
    } catch (error) {
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_START_REFUSED',
            detail: `rate-limit-unavailable kind=${error.name || 'Error'}`,
        });
    }

    // 3. Turnstile. Last, because it is the only step with an external
    //    dependency, and the first time the OTP-send path has ever had a bot
    //    check in front of it at all: today the browser calls InitiateAuth
    //    directly and nothing stands between an attacker and 221 real phone
    //    numbers. FAILS CLOSED once a secret exists.
    let secret;
    try {
        secret = await loadSecret(process.env.TURNSTILE_SECRET_PARAM);
    } catch (error) {
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_START_REFUSED',
            detail: `secret-unreadable kind=${error.name || 'Error'}`,
        });
    }
    if (secret) {
        const bypassed = await isE2EBypass(
            body.turnstileToken,
            () => isAllowedTestDestination(channel, username),
            'AUTH_START_E2E_BYPASS',
        );
        if (!bypassed) {
            const check = await verifyToken({
                token: body.turnstileToken, secret, remoteIp: sourceIp,
            });
            if (!check.ok) {
                return errorResponse(403, 'bot_check_failed', {
                    marker: 'AUTH_START_REFUSED',
                    detail: `${check.reason} codes=${(check.codes || []).join(',')}`,
                });
            }
        }
    }

    // 4. Reserve the challenge BEFORE anything is sent, so a handle the caller
    //    holds always has a row behind it and /auth/verify can always say
    //    something true about it. FAILS CLOSED: no row, no sign-in.
    const handle = mintHandle();
    try {
        await putChallenge({
            handle,
            destination: username,
            destinationKey: destinationKey(username),
            channel,
            language,
        });
    } catch (error) {
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_START_REFUSED',
            detail: `session-store-unavailable kind=${error.name || 'Error'}`,
        });
    }

    // 5. Hand off everything that depends on whether the account exists.
    //    Event invocation: this call returns as soon as Lambda has accepted
    //    the payload, so nothing below is on the caller's clock.
    try {
        await lambda.send(new InvokeCommand({
            FunctionName: process.env.AUTH_DISPATCH_FUNCTION,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ handle, username, channel, language })),
        }));
    } catch (error) {
        // FAILS CLOSED. A challenge nobody will ever send a code for would
        // leave a parent on a code screen forever, which is worse than an
        // honest refusal they can retry.
        return errorResponse(503, 'unavailable', {
            marker: 'AUTH_START_REFUSED',
            detail: `dispatch-unavailable kind=${error.name || 'Error'}`,
        });
    }

    // Never the destination, never the handle: this line is written on every
    // sign-in and the log group is not the place for either.
    console.log(`AUTH_START_ACCEPTED channel=${channel}`);
    const { body: payload, headers } = writeHandle(
        { ok: true, channel, expiresIn: CHALLENGE_TTL_SECONDS },
        CHALLENGE_FIELD,
        handle,
    );
    return respond(200, payload, headers);
};

/**
 * This endpoint's own second lock on the E2E bypass, passed to the shared
 * gate rather than looked up inside it.
 *
 * Phone: the NANP-fictional 555-01XX block, via the same TEST_PHONE_NUMBERS
 * allowlist create-auth-challenge uses. Email: the reserved a-iep.invalid
 * domain, via TEST_EMAIL_ADDRESSES. Neither env var exists in production.
 */
function isAllowedTestDestination(channel, username) {
    if (channel === 'email') {
        return isTestAddress(username);
    }
    return (process.env.TEST_PHONE_NUMBERS || '')
        .split(',').map((p) => p.trim()).filter(Boolean)
        .includes(username);
}
