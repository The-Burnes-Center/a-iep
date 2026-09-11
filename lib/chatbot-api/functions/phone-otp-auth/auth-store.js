/**
 * The server-side session store, and the counters that bound the auth path.
 *
 * Two different stores with two different lifetimes, and they are deliberately
 * not the same table:
 *
 *   AUTH_SESSION_TABLE   durable, RETAIN, CMK-encrypted. Holds the in-flight
 *                        Cognito auth session for five minutes, and the real
 *                        Cognito tokens for thirty days. This is the thing
 *                        that keeps the refresh token out of the browser.
 *
 *   OTP_RATE_LIMIT_TABLE throwaway hourly counters that TTL themselves out.
 *                        Same table and same schema the SMS limiters already
 *                        use, different key prefixes. Losing it costs one hour
 *                        of history and nothing else, which is why it is
 *                        DESTROY and the session table is not.
 *
 * ## Handles
 *
 * A handle is 32 bytes from crypto.randomBytes, base64url, 43 characters. It
 * is opaque: it is not a JWT, it decodes to nothing, and it says nothing about
 * the parent holding it.
 *
 * The table is keyed on sha256(handle), never on the handle. A read of this
 * table -- a backup, an export, a support query, a mistake -- therefore yields
 * no usable credential, only the hash of one. That costs one hash per request
 * and it is the difference between "somebody saw the session table" and
 * "somebody can sign in as 296 families".
 */

const crypto = require('crypto');

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

/** Test seam: drop the memoized client so a fresh mock is picked up. */
function resetDocClient() {
    docClient = null;
}

// Matches the OTP's own five-minute validity, the SMS copy that promises it,
// and the pool client's authSessionValidity. A challenge handle that outlived
// the Cognito session behind it would be a handle that can only ever fail.
const CHALLENGE_TTL_SECONDS = 5 * 60;

// Thirty days, matching the refresh token Cognito issues. Sliding: every
// /auth/token pushes it out, so an active parent is never signed out and an
// abandoned session disappears on its own.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const HOUR_SECONDS = 60 * 60;

// Ten wrong codes for one destination in an hour and that destination stops
// being able to answer for the rest of the hour.
//
// Ten, not three: a parent mistyping a six-digit code twice in one session and
// then again in a second session is a real person having a bad day at six.
// Ten leaves room for that and still stops a run three orders of magnitude
// short of a million-value keyspace. Cognito's own three-answers-per-session
// rule sits underneath it and is what actually bounds a single session.
const MAX_FAILED_VERIFICATIONS_PER_HOUR = 10;

const CHALLENGE_PREFIX = 'C#';
const SESSION_PREFIX = 'S#';

/** 32 bytes of entropy, base64url, 43 characters. */
function mintHandle() {
    return crypto.randomBytes(32).toString('base64url');
}

/** What actually goes in the table. Never the handle itself. */
function handleKey(prefix, handle) {
    return prefix + crypto.createHash('sha256').update(String(handle || '')).digest('hex');
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ── The challenge row ───────────────────────────────────────────────────

/**
 * Reserve a challenge before anything is sent.
 *
 * Written by /auth/start with status 'pending', updated by the dispatcher to
 * 'ready' or 'failed'. Writing it FIRST, before the dispatcher is invoked, is
 * what makes the response honest: a handle the caller holds always has a row
 * behind it, so /auth/verify can always say something true about it.
 */
async function putChallenge({ handle, destination, destinationKey, channel, language }) {
    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    await getDocClient().send(new PutCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Item: {
            pk: handleKey(CHALLENGE_PREFIX, handle),
            kind: 'challenge',
            status: 'pending',
            // The destination is the Cognito Username, so it has to be here:
            // /auth/verify needs it for the SECRET_HASH and the counter, and
            // the caller must not be trusted to send it back.
            destination,
            destinationKey,
            channel,
            ...(language ? { language } : {}),
            createdAt: nowSeconds(),
            expiresAt: nowSeconds() + CHALLENGE_TTL_SECONDS,
        },
    }));
}

/** The dispatcher's result: the code went out and here is the Cognito session. */
async function markChallengeReady(handle, cognitoSession) {
    await updateChallenge(handle, {
        UpdateExpression: 'SET #s = :ready, cognitoSession = :sess',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':ready': 'ready', ':sess': cognitoSession },
    });
}

/** The dispatcher's other result: the code could not be sent, and why. */
async function markChallengeFailed(handle, reason) {
    await updateChallenge(handle, {
        UpdateExpression: 'SET #s = :failed, reason = :reason',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed', ':reason': reason },
    });
}

/**
 * Cognito hands back a NEW session on every round, including a failed one.
 * Persisting it is what lets a parent get their three answers: keep the old
 * one and the second attempt fails for a reason that has nothing to do with
 * the digits they typed.
 */
async function rotateCognitoSession(handle, cognitoSession) {
    await updateChallenge(handle, {
        UpdateExpression: 'SET cognitoSession = :sess',
        ExpressionAttributeValues: { ':sess': cognitoSession },
    });
}

async function updateChallenge(handle, params) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    await getDocClient().send(new UpdateCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Key: { pk: handleKey(CHALLENGE_PREFIX, handle) },
        // Only ever updates a row that already exists. Without this a
        // dispatcher running after the TTL swept the row would recreate it
        // with no expiresAt, and that row would live forever.
        ConditionExpression: 'attribute_exists(pk)',
        ...params,
    }));
}

/**
 * The challenge behind a handle, or null.
 *
 * Consistent read on purpose. The dispatcher writes 'ready' milliseconds
 * before a parent's first /auth/verify, and an eventually-consistent read
 * there would report 'pending' for a challenge that is finished -- which is
 * indistinguishable to a client from a slow send, and would have it wait for
 * nothing.
 */
async function getChallenge(handle) {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await getDocClient().send(new GetCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Key: { pk: handleKey(CHALLENGE_PREFIX, handle) },
        ConsistentRead: true,
    }));
    const item = result && result.Item;
    if (!item) {
        return null;
    }
    // DynamoDB's TTL sweep is best-effort and can lag by up to 48 hours, so
    // the expiry is enforced here as well. The row being present is not the
    // same as the row being live.
    if (item.expiresAt && item.expiresAt <= nowSeconds()) {
        return null;
    }
    return item;
}

/** A spent challenge is deleted rather than left to TTL: it is single use. */
async function deleteChallenge(handle) {
    const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    await getDocClient().send(new DeleteCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Key: { pk: handleKey(CHALLENGE_PREFIX, handle) },
    }));
}

// ── The app session row ─────────────────────────────────────────────────

/**
 * Store the tokens a successful sign-in produced, and return the handle.
 *
 * The refresh token is written here and NOWHERE else. It is never serialized
 * to the browser in any form, which is the single property that makes this
 * better than today: a refresh token in localStorage is a thirty-day,
 * offline-usable credential readable by any script on the origin, and nothing
 * server-side even knows it was taken.
 */
async function putSession({ username, tokens }) {
    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const handle = mintHandle();
    await getDocClient().send(new PutCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Item: {
            pk: handleKey(SESSION_PREFIX, handle),
            kind: 'session',
            username,
            accessToken: tokens.AccessToken,
            idToken: tokens.IdToken,
            refreshToken: tokens.RefreshToken,
            tokenExpiresAt: nowSeconds() + (tokens.ExpiresIn || 3600),
            createdAt: nowSeconds(),
            expiresAt: nowSeconds() + SESSION_TTL_SECONDS,
        },
    }));
    return handle;
}

async function getSession(handle) {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await getDocClient().send(new GetCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Key: { pk: handleKey(SESSION_PREFIX, handle) },
        ConsistentRead: true,
    }));
    const item = result && result.Item;
    if (!item || (item.expiresAt && item.expiresAt <= nowSeconds())) {
        return null;
    }
    return item;
}

/** Refreshed tokens, and a pushed-out expiry so an active parent stays in. */
async function refreshSessionTokens(handle, tokens) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    await getDocClient().send(new UpdateCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Key: { pk: handleKey(SESSION_PREFIX, handle) },
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression:
            'SET accessToken = :a, idToken = :i, tokenExpiresAt = :te, expiresAt = :e',
        ExpressionAttributeValues: {
            ':a': tokens.AccessToken,
            ':i': tokens.IdToken,
            ':te': nowSeconds() + (tokens.ExpiresIn || 3600),
            ':e': nowSeconds() + SESSION_TTL_SECONDS,
        },
    }));
}

/** Revocation is one DeleteItem, not waiting out a thirty-day token. */
async function deleteSession(handle) {
    const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    await getDocClient().send(new DeleteCommand({
        TableName: requireTable('AUTH_SESSION_TABLE'),
        Key: { pk: handleKey(SESSION_PREFIX, handle) },
    }));
}

// ── The counters ────────────────────────────────────────────────────────

/**
 * Add one to a windowed counter and say whether it is now over.
 *
 * Throws on any DynamoDB trouble. Each CALLER decides what that means, because
 * the right answer is not the same at every site, and the asymmetry is
 * deliberate rather than an accident: see enforceStartLimits (CLOSED) and
 * isDestinationLockedOut (OPEN).
 */
async function bumpCounter(key, max, ttlSeconds, attribute = 'attempts') {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await getDocClient().send(new UpdateCommand({
        TableName: requireTable('OTP_RATE_LIMIT_TABLE'),
        Key: { pk: key },
        UpdateExpression: `ADD ${attribute} :one SET expiresAt = if_not_exists(expiresAt, :expiry)`,
        ExpressionAttributeValues: { ':one': 1, ':expiry': nowSeconds() + ttlSeconds },
        ReturnValues: 'ALL_NEW',
    }));
    const count = (result.Attributes && result.Attributes[attribute]) || 0;
    return { count, over: count > max };
}

/**
 * Read the failed-verification tally for a destination WITHOUT adding to it.
 *
 * FAILS OPEN, and this is the asymmetry the critique caught. --------------
 *
 * This check runs on EVERY /auth/verify, including the one from a parent who
 * typed their code correctly on the first try. Failing closed would therefore
 * turn a routine DynamoDB blip into a total login outage for all 296 families,
 * which is a worse failure than the one it prevents: falling back to Cognito's
 * own three-answers-per-session cap still bounds a guessing run to roughly
 * fifteen attempts an hour against a million-value keyspace, because starting
 * a fresh session costs a new send and the send path's own limiters are
 * counting those.
 *
 * The GLOBAL send budget in create-auth-challenge and the start limits below
 * fail CLOSED, and that is not an inconsistency. The test is "does failing
 * open cost money, or cost one person a retry". An unmetered send window is
 * unbounded spend and unbounded messages; an unenforced guess counter is one
 * control degrading while another still holds. Do not "make these consistent".
 */
async function isDestinationLockedOut(destinationKey) {
    const key = `AUTHFAIL#${destinationKey}#${Math.floor(Date.now() / (HOUR_SECONDS * 1000))}`;
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    try {
        const result = await getDocClient().send(new GetCommand({
            TableName: requireTable('OTP_RATE_LIMIT_TABLE'),
            Key: { pk: key },
            // Consistent, because this counter IS the brute-force bound above
            // Cognito's three-per-session rule. An eventually-consistent read
            // gives a run a window of parallel attempts that the tally has not
            // caught up with yet, which is exactly the shape it exists to stop.
            ConsistentRead: true,
        }));
        const failures = (result.Item && result.Item.failures) || 0;
        return { lockedOut: failures >= MAX_FAILED_VERIFICATIONS_PER_HOUR, failures };
    } catch (error) {
        // FAIL OPEN. Logged, never silent: a limiter that is not enforcing is
        // a thing an operator has to be able to see.
        console.error(
            `AUTH_VERIFY_COUNTER_UNAVAILABLE failing-open kind=${(error && error.name) || 'Error'}`,
        );
        return { lockedOut: false, failures: 0, degraded: true };
    }
}

/** One more wrong code for this destination. Best effort, same reasoning. */
async function recordFailedVerification(destinationKey) {
    const key = `AUTHFAIL#${destinationKey}#${Math.floor(Date.now() / (HOUR_SECONDS * 1000))}`;
    try {
        await bumpCounter(key, Number.MAX_SAFE_INTEGER, 2 * HOUR_SECONDS, 'failures');
    } catch (error) {
        console.error(
            `AUTH_VERIFY_COUNTER_UNAVAILABLE failing-open kind=${(error && error.name) || 'Error'}`,
        );
    }
}

/** Seconds until the current hour bucket rolls over. */
function secondsUntilHourEnds() {
    return HOUR_SECONDS - Math.floor((Date.now() / 1000) % HOUR_SECONDS);
}

function requireTable(name) {
    const table = process.env[name];
    if (!table) {
        throw new Error(`${name} is not configured`);
    }
    return table;
}

module.exports = {
    CHALLENGE_TTL_SECONDS,
    SESSION_TTL_SECONDS,
    MAX_FAILED_VERIFICATIONS_PER_HOUR,
    mintHandle,
    handleKey,
    bumpCounter,
    putChallenge,
    getChallenge,
    deleteChallenge,
    markChallengeReady,
    markChallengeFailed,
    rotateCognitoSession,
    putSession,
    getSession,
    refreshSessionTokens,
    deleteSession,
    isDestinationLockedOut,
    recordFailedVerification,
    secondsUntilHourEnds,
    resetDocClient,
};
