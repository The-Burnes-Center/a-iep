/**
 * The send side of the email login code: everything that has to be true
 * before SES is called, and the one thing that has to be said if it fails.
 *
 * create-auth-challenge's email branch calls these in order. They are here
 * rather than inline in that file because each one is a control with its own
 * alarm, and a control nobody can unit-test on its own is a control nobody
 * trusts.
 *
 * ## Which way each one fails, and why they differ
 *
 * The SMS path already made these choices and this mirrors them deliberately,
 * because a parent should not get different behaviour depending on which
 * kind of address they signed up with:
 *
 *   suppression check      fails CLOSED  refuse to send
 *   global ceiling         fails CLOSED  refuse to send
 *   per-recipient ceiling  fails OPEN    send anyway
 *
 * The asymmetry in the middle is the point. A DynamoDB blip must not be able
 * to lock every family out of login, so the per-recipient limiter lets a send
 * through when it cannot count -- one extra code to one inbox. The global
 * ceiling cannot do that: an unmetered window is unbounded, and unbounded is
 * what an abuse run needs. Refusing to send during a DynamoDB outage costs
 * little in practice, because DynamoDB also holds the profiles and documents
 * the app runs on and is unusable meanwhile.
 *
 * The suppression check fails closed regardless of any of that. Mailing an
 * address that has already hard-bounced or already complained is how the
 * identity gets suspended, and a suspension ends email sign-in for every
 * family until AWS accepts an appeal. That is not a risk worth taking to save
 * one parent one retry.
 *
 * ## Ceilings are compiled, not configured
 *
 * The SMS path reads its ceilings from Parameter Store with compiled floors
 * behind them. That subtree was never created in either environment, so the
 * floors have been the policy since the day it shipped. Rather than add a
 * second never-populated subtree and an SSM grant that reads nothing, the
 * numbers below ARE the policy. They are publishable: an attacker who learns
 * that the service refuses past 50 codes an hour learns only that it refuses.
 */

const crypto = require('crypto');

/**
 * The markers, in one place.
 *
 * Each of these is counted by a metric filter created in
 * lib/chatbot-api/email/email-identity.ts and read by an alarm. The string is
 * the contract between the two, and nothing else connects them: reword one
 * end and the alarm goes quiet while every test still passes. Tests pin each
 * literal on both sides. Same arrangement as SMS_SEND_FAILED and
 * OCR_PURGE_FAILED.
 */
const EMAIL_MARKERS = Object.freeze({
    SUPPRESSED_DESTINATION: 'EMAIL_SUPPRESSED_DESTINATION',
    SUPPRESSION_UNAVAILABLE: 'EMAIL_SUPPRESSION_UNAVAILABLE',
    BUDGET_EXHAUSTED: 'EMAIL_BUDGET_EXHAUSTED',
    SEND_FAILED: 'EMAIL_SEND_FAILED',
});

// Per recipient, across auth sessions. Matches MAX_SMS_PER_HOUR: the same
// parent asking for the same thing, so the same allowance.
const MAX_EMAILS_PER_RECIPIENT_PER_HOUR = 5;

// Service-wide, counted across all recipients. The per-recipient limit bounds
// one inbox; these bound the reputation of a domain shared with two other
// projects, which is the thing that cannot be bought back.
const MAX_EMAILS_PER_HOUR_GLOBAL = 50;
const MAX_EMAILS_PER_DAY_GLOBAL = 100;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── The key, duplicated on purpose ──────────────────────────────────────
//
// ses-suppression/suppression-key.js holds the same three functions. It is a
// different lambda asset, zipped separately, so this file cannot require it
// and there is no shared layer to put it in. The two must agree exactly or
// the list silently stops working: the bounce handler would record an
// address under one key and this would look under another, and nothing would
// fail loudly. test/lambdas/ses-suppression/suppression-key.test.js loads
// both and asserts they agree. Change one, change both.

/** Trim and lowercase, and nothing else. Plus-addressing is NOT stripped. */
function normalizeAddress(address) {
    return String(address || '').trim().toLowerCase();
}

/** The partition key for an address, or null if there is no address. */
function addressKey(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
        return null;
    }
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** The domain part, for logs. The local part never reaches CloudWatch. */
function addressDomain(address) {
    const normalized = normalizeAddress(address);
    const at = normalized.lastIndexOf('@');
    return at > 0 ? normalized.slice(at + 1) : 'unknown';
}

// ── Shared client ───────────────────────────────────────────────────────

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

// ── Refusals ────────────────────────────────────────────────────────────

function refusal(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
}

/**
 * A refusal this code made on purpose, as opposed to the send itself
 * breaking.
 *
 * These carry their own copy to the parent instead of the generic retry line,
 * and they are excluded from EMAIL_SEND_FAILED so the "email delivery is
 * broken" alarm does not fire every time a control does its job.
 *
 * EmailSuppressionUnavailableError is in this list even though it is a
 * failure rather than a decision. It has its own critical alarm on
 * EMAIL_SUPPRESSION_UNAVAILABLE, which says something more specific than
 * "a send failed"; counting it twice would mean two pages for one event.
 */
function isDeliberateEmailRefusal(error) {
    return (
        error.name === 'EmailSuppressedError'
        || error.name === 'EmailSuppressionUnavailableError'
        || error.name === 'EmailBudgetError'
        || error.name === 'EmailRateLimitError'
    );
}

// ── The suppression check ───────────────────────────────────────────────

/**
 * Refuse to email an address SES has already told us is bad.
 *
 * Called BEFORE SendEmail, never after: SES's own account suppression list
 * refuses inside SES, which means the API call succeeds, a Send is counted,
 * the message is dropped, and the app tells a parent a code is on its way
 * that will never arrive. That is the exact failure mode of the 2026-09-09
 * SMS outage. Refusing here lets the app say something true.
 *
 * Throws EmailSuppressedError if the address is on the list, and
 * EmailSuppressionUnavailableError if the question could not be asked.
 */
async function assertNotSuppressed(address) {
    const tableName = process.env.EMAIL_SUPPRESSION_TABLE;
    const domain = addressDomain(address);

    if (!tableName) {
        console.error(`${EMAIL_MARKERS.SUPPRESSION_UNAVAILABLE} reason=no-table`);
        throw suppressionUnavailable();
    }

    const key = addressKey(address);
    if (!key) {
        // No address at all is not a suppression question; it is a caller
        // bug, and it must not reach SES.
        throw refusal('EmailSuppressedError', 'A-IEP needs an email address to send a code to.');
    }

    let item;
    try {
        const { GetCommand } = require('@aws-sdk/lib-dynamodb');
        const result = await getDocClient().send(new GetCommand({
            TableName: tableName,
            Key: { addressHash: key },
            // The list is the authority on whether we may mail somebody, and
            // a stale read here is a message we promised never to send.
            ConsistentRead: true,
        }));
        item = result.Item;
    } catch (error) {
        console.error(
            `${EMAIL_MARKERS.SUPPRESSION_UNAVAILABLE} reason=lookup-failed domain=${domain} `
            + `kind=${(error && error.name) || 'Error'}`
        );
        throw suppressionUnavailable();
    }

    // A row exists for every transient-bounce tally too. Only suppressedAt
    // means "never mail this again"; a tally is a count, not a decision.
    if (item && item.suppressedAt) {
        console.error(
            `${EMAIL_MARKERS.SUPPRESSED_DESTINATION} domain=${domain} reason=${item.reason || 'unknown'}`
        );
        throw refusal(
            'EmailSuppressedError',
            'A-IEP cannot send codes to this email address. Please sign in with your phone number instead.',
        );
    }
}

/**
 * The copy a parent sees when the check itself is broken.
 *
 * It says "temporarily" and does not mention their address, because their
 * address is not the problem and we do not currently know whether it is fine.
 */
function suppressionUnavailable() {
    return refusal(
        'EmailSuppressionUnavailableError',
        'Email sign-in is temporarily unavailable. Please try again in a little while.',
    );
}

// ── The ceilings ────────────────────────────────────────────────────────

/**
 * Add one to a windowed counter and return the new total.
 *
 * Rows live on the existing OTP rate-limit table, keyed apart from the SMS
 * ones by an EMAIL# prefix and counted in their own attribute, so email and
 * SMS budgets never draw on each other and no schema change is needed. TTL is
 * the table's own expiresAt.
 */
async function bumpCounter(tableName, pk, ttlSeconds) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await getDocClient().send(new UpdateCommand({
        TableName: tableName,
        Key: { pk },
        UpdateExpression: 'ADD emailCount :one SET expiresAt = if_not_exists(expiresAt, :expiry)',
        ExpressionAttributeValues: {
            ':one': 1,
            ':expiry': Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        ReturnValues: 'ALL_NEW',
    }));
    return (result.Attributes && result.Attributes.emailCount) || 0;
}

/**
 * Count one email against the service-wide hourly AND daily budgets.
 *
 * Fails CLOSED on a missing table and on a DynamoDB error: see the module
 * docblock.
 */
async function enforceGlobalEmailBudget() {
    const tableName = process.env.OTP_RATE_LIMIT_TABLE;
    if (!tableName) {
        console.error(`${EMAIL_MARKERS.BUDGET_EXHAUSTED} window=all reason=unmetered`);
        throw budgetExhausted();
    }

    const windows = [
        {
            pk: `EMAIL#GLOBAL#H#${Math.floor(Date.now() / HOUR_MS)}`,
            max: MAX_EMAILS_PER_HOUR_GLOBAL,
            ttlSeconds: 2 * 60 * 60,
            label: 'hourly',
        },
        {
            pk: `EMAIL#GLOBAL#D#${Math.floor(Date.now() / DAY_MS)}`,
            max: MAX_EMAILS_PER_DAY_GLOBAL,
            ttlSeconds: 48 * 60 * 60,
            label: 'daily',
        },
    ];

    for (const { pk, max, ttlSeconds, label } of windows) {
        let count;
        try {
            count = await bumpCounter(tableName, pk, ttlSeconds);
        } catch (error) {
            console.error(
                `${EMAIL_MARKERS.BUDGET_EXHAUSTED} window=${label} reason=unmeterable `
                + `kind=${(error && error.name) || 'Error'}`
            );
            throw budgetExhausted();
        }

        if (count > max) {
            // Loud on purpose: an alarm keys on this line, and by the time it
            // fires a real parent has already been turned away.
            console.error(`${EMAIL_MARKERS.BUDGET_EXHAUSTED} window=${label} reason=ceiling`);
            throw budgetExhausted();
        }
    }
}

/** The caller did nothing wrong, so the copy never blames their address. */
function budgetExhausted() {
    return refusal(
        'EmailBudgetError',
        'Email sign-in is temporarily unavailable. Please try again in a little while.',
    );
}

/**
 * Count one email against this recipient's hourly budget.
 *
 * Fails OPEN, matching enforceSmsRateLimit: a DynamoDB blip must not lock
 * every family out of login, and the global ceiling above is still counting.
 *
 * The counter lives outside the auth session because Cognito issues a fresh
 * session on every InitiateAuth, so an in-session tally would see at most one
 * send and could never cap per-recipient volume.
 */
async function enforceEmailRateLimit(address) {
    const tableName = process.env.OTP_RATE_LIMIT_TABLE;
    if (!tableName) {
        console.warn('OTP_RATE_LIMIT_TABLE not set; skipping per-recipient email rate limit');
        return;
    }

    const key = addressKey(address);
    if (!key) {
        return;
    }

    let count;
    try {
        count = await bumpCounter(
            tableName,
            `EMAIL#${key}#${Math.floor(Date.now() / HOUR_MS)}`,
            2 * 60 * 60,
        );
    } catch (error) {
        console.error('Per-recipient email rate limit check failed (failing open):', error.name);
        return;
    }

    if (count > MAX_EMAILS_PER_RECIPIENT_PER_HOUR) {
        console.error(`Email rate limit exceeded for domain=${addressDomain(address)}; refusing to send`);
        throw refusal(
            'EmailRateLimitError',
            'Too many verification codes requested. Please wait an hour and try again.',
        );
    }
}

// ── The SendEmail parameters ────────────────────────────────────────────

/**
 * Build the SendEmail input, with the configuration set named.
 *
 * This exists as a function, rather than an object literal at the call site,
 * because naming the configuration set is a control and not a formality.
 * `a-iep.org` already carries a DEFAULT configuration set belonging to
 * another project in this shared AWS account, and that set has no event
 * destinations. A send that omits ConfigurationSetName therefore does not
 * fail and does not fall back to plain SES: it succeeds, counts against the
 * shared account's reputation, and has its bounces and complaints discarded.
 * Nothing would ever reach the suppression list and nothing would say so.
 *
 * IAM cannot close this. ses:SendEmail has no condition key for the
 * configuration set, so the grant in email-identity.ts can scope the
 * configuration-set ARN but cannot require it. One function every send goes
 * through, and a test that pins ConfigurationSetName on its output, is the
 * control.
 *
 * Refuses rather than sending unconfigured, for the same reason.
 *
 * SESv2 shape (@aws-sdk/client-sesv2 SendEmailCommand).
 */
function buildOtpEmailParams({ to, subject, text, html }) {
    const configurationSetName = process.env.SES_CONFIGURATION_SET;
    const fromAddress = process.env.SES_FROM_ADDRESS;

    if (!configurationSetName || !fromAddress) {
        // Not a deliberate refusal: this is the service misconfigured, and it
        // should reach EMAIL_SEND_FAILED like any other broken send.
        throw refusal(
            'EmailConfigurationError',
            'Failed to send verification code. Please try again.',
        );
    }

    return {
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: configurationSetName,
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: {
                    Text: { Data: text, Charset: 'UTF-8' },
                    ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
                },
            },
        },
    };
}

// ── Reporting a send that broke ─────────────────────────────────────────

/**
 * Say, in the one string an alarm can see, that sending a code failed.
 *
 * create-auth-challenge reports a failed send through publicChallengeParameters
 * rather than raising, so the trigger's Lambda Errors metric stays at zero
 * through a total outage and every "login broken" alarm stays green. The
 * marker is the only signal there is. Its SMS twin exists for exactly this
 * reason.
 *
 * Deliberate refusals are excluded: they are controls working, not delivery
 * breaking, and each already has its own alarm.
 */
function reportEmailSendFailure(error) {
    if (isDeliberateEmailRefusal(error)) {
        return false;
    }
    console.error(`${EMAIL_MARKERS.SEND_FAILED} kind=${(error && error.name) || 'Error'}`);
    return true;
}

module.exports = {
    EMAIL_MARKERS,
    MAX_EMAILS_PER_RECIPIENT_PER_HOUR,
    MAX_EMAILS_PER_HOUR_GLOBAL,
    MAX_EMAILS_PER_DAY_GLOBAL,
    normalizeAddress,
    addressKey,
    addressDomain,
    assertNotSuppressed,
    enforceGlobalEmailBudget,
    enforceEmailRateLimit,
    buildOtpEmailParams,
    isDeliberateEmailRefusal,
    reportEmailSendFailure,
};
