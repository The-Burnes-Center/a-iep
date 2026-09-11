/**
 * Keeps the do-not-email list current, from what SES tells us went wrong.
 *
 * Subscribed to the configuration set's failure event topic (Bounce,
 * Complaint, Reject, DeliveryDelay). Only the first two say anything about
 * the ADDRESS; the other two say something about the message or the
 * receiving server, so they are read and discarded here rather than
 * filtered out upstream -- one subscription, one place that decides.
 *
 * The rule this function implements:
 *
 *   permanent bounce  -> suppress now. The mailbox does not exist.
 *   complaint         -> suppress now. They asked us to stop.
 *   transient bounce  -> tally. Suppress on the Nth inside the TTL window.
 *   anything else     -> write nothing.
 *
 * Suppressing a transient bounce on the first one would lock a parent out of
 * their own account because their inbox was full on a Tuesday, which is a
 * worse outcome than one more bounce. Three inside the window is a pattern.
 *
 * ## Two things here are load-bearing and easy to break
 *
 * **A suppression row must never carry a TTL.** The tally rows do, so a
 * transient tally disappears after TRANSIENT_BOUNCE_TTL_DAYS. They share a
 * partition key with the suppression row, so promoting a tally to a
 * suppression has to REMOVE expiresAt. Miss that and the suppression quietly
 * expires 30 days later and the address becomes mailable again, with nothing
 * anywhere saying so.
 *
 * **A write failure must be retried, a malformed payload must not.** SNS
 * retries a failed Lambda invocation and then gives up; a DynamoDB blip is
 * exactly what that retry is for, so a failed write rethrows. A payload we
 * cannot parse will not parse on the third attempt either, so it is logged
 * and dropped.
 *
 * No address is ever logged. The domain is, because "every bounce is one
 * provider" and "every bounce is a different invented domain" are different
 * incidents with different responses, and neither is visible from a hash.
 * Same discipline as phone-otp-auth/sanitize.js.
 */

const { addressKey, addressDomain } = require('./suppression-key');

/**
 * A bounce or complaint we were told about and failed to record.
 *
 * Marker, not prose: a metric filter in email-identity.ts counts this exact
 * string and an alarm reads the count, so rewording the line disarms the
 * alarm without failing anything. Pinned on both sides by tests. Same
 * contract as SMS_REFUSED_DESTINATION and OCR_PURGE_FAILED.
 */
const SUPPRESSION_WRITE_FAILED = 'SES_SUPPRESSION_WRITE_FAILED';

/** Matches the CDK default; used only if the env var is absent or garbage. */
const DEFAULT_TRANSIENT_BOUNCES_BEFORE_SUPPRESSION = 3;
const DEFAULT_TRANSIENT_BOUNCE_TTL_DAYS = 30;

const SECONDS_PER_DAY = 24 * 60 * 60;

// Built lazily so a cold start that turns out to be a Reject event pays for
// nothing, and so the unit tests can mock the SDK as a virtual module.
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

function positiveInteger(raw, fallback) {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Suppress an address, permanently.
 *
 * REMOVE expiresAt is the whole reason this is an update rather than a put:
 * the row may already exist as a transient tally carrying a TTL, and a
 * suppression that expires is a suppression that silently stops working.
 */
async function suppress(tableName, key, domain, reason) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    await getDocClient().send(new UpdateCommand({
        TableName: tableName,
        Key: { addressHash: key },
        UpdateExpression:
            'SET suppressedAt = :now, #reason = :reason, #domain = :domain REMOVE expiresAt',
        ExpressionAttributeNames: { '#reason': 'reason', '#domain': 'domain' },
        ExpressionAttributeValues: {
            ':now': new Date().toISOString(),
            ':reason': reason,
            ':domain': domain,
        },
    }));
}

/**
 * Count one transient bounce, and suppress once there have been enough.
 *
 * The condition is not an optimisation. Without it, `if_not_exists(expiresAt)`
 * on an already-suppressed row would give that row a TTL, and the suppression
 * would expire. A failed condition means the address is already suppressed
 * and there is nothing left to count.
 */
async function tallyTransientBounce(tableName, key, domain, config) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const expiry = Math.floor(Date.now() / 1000) + config.ttlDays * SECONDS_PER_DAY;

    let tally;
    try {
        const result = await getDocClient().send(new UpdateCommand({
            TableName: tableName,
            Key: { addressHash: key },
            UpdateExpression:
                'ADD transientBounces :one '
                + 'SET expiresAt = if_not_exists(expiresAt, :expiry), '
                + '#domain = :domain, lastBounceAt = :now',
            ConditionExpression: 'attribute_not_exists(suppressedAt)',
            ExpressionAttributeNames: { '#domain': 'domain' },
            ExpressionAttributeValues: {
                ':one': 1,
                ':expiry': expiry,
                ':domain': domain,
                ':now': new Date().toISOString(),
            },
            ReturnValues: 'ALL_NEW',
        }));
        tally = (result.Attributes && result.Attributes.transientBounces) || 0;
    } catch (error) {
        if (error && error.name === 'ConditionalCheckFailedException') {
            return 'already-suppressed';
        }
        throw error;
    }

    if (tally >= config.threshold) {
        await suppress(tableName, key, domain, 'transient-bounce-repeated');
        return 'suppressed';
    }
    return `tallied:${tally}`;
}

/** Every address a single SES event says something about, with its verdict. */
function recipientsOf(notification) {
    const eventType = notification.eventType || notification.notificationType;

    if (eventType === 'Bounce' && notification.bounce) {
        // Undetermined is treated as transient on purpose: an ambiguous
        // bounce is not grounds for locking a parent out of their account.
        const permanent = notification.bounce.bounceType === 'Permanent';
        return (notification.bounce.bouncedRecipients || []).map((recipient) => ({
            address: recipient.emailAddress,
            permanent,
            reason: permanent ? 'hard-bounce' : 'transient-bounce',
        }));
    }

    if (eventType === 'Complaint' && notification.complaint) {
        return (notification.complaint.complainedRecipients || []).map((recipient) => ({
            address: recipient.emailAddress,
            permanent: true,
            reason: 'complaint',
        }));
    }

    // Reject and DeliveryDelay arrive on the same subscription and say
    // nothing about whether the address is good. Alarms watch them; this
    // list does not.
    return [];
}

exports.handler = async (event) => {
    const tableName = process.env.EMAIL_SUPPRESSION_TABLE;
    if (!tableName) {
        // Loud and retried: the list cannot be maintained at all, and every
        // event arriving meanwhile is an address we were told about and lost.
        console.error(`${SUPPRESSION_WRITE_FAILED} reason=no-table`);
        throw new Error('EMAIL_SUPPRESSION_TABLE is not set');
    }

    const config = {
        threshold: positiveInteger(
            process.env.TRANSIENT_BOUNCES_BEFORE_SUPPRESSION,
            DEFAULT_TRANSIENT_BOUNCES_BEFORE_SUPPRESSION,
        ),
        ttlDays: positiveInteger(
            process.env.TRANSIENT_BOUNCE_TTL_DAYS,
            DEFAULT_TRANSIENT_BOUNCE_TTL_DAYS,
        ),
    };

    const records = (event && event.Records) || [];
    let writeFailures = 0;

    for (const record of records) {
        let notification;
        try {
            notification = JSON.parse((record.Sns && record.Sns.Message) || '');
        } catch (error) {
            // Not retried: it will not parse on the third attempt either, and
            // SNS would redeliver it until it gave up. Logged because a
            // silently dropped bounce is how the list goes stale.
            console.error('SES event payload could not be parsed; dropping it:', error.message);
            continue;
        }

        for (const { address, permanent, reason } of recipientsOf(notification)) {
            const key = addressKey(address);
            if (!key) {
                console.error('SES event named a recipient with no address; dropping it');
                continue;
            }
            const domain = addressDomain(address);

            try {
                const outcome = permanent
                    ? (await suppress(tableName, key, domain, reason), 'suppressed')
                    : await tallyTransientBounce(tableName, key, domain, config);
                console.log(`SES suppression domain=${domain} reason=${reason} outcome=${outcome}`);
            } catch (error) {
                writeFailures += 1;
                console.error(
                    `${SUPPRESSION_WRITE_FAILED} reason=${reason} domain=${domain} `
                    + `kind=${(error && error.name) || 'Error'} detail=${(error && error.message) || ''}`
                );
            }
        }
    }

    if (writeFailures > 0) {
        // Rethrow so SNS redelivers. A repeated transient tally can overcount
        // on a redelivery, which suppresses one bounce early -- much cheaper
        // than losing a complaint. In practice SES delivers one record per
        // invocation, so the batch is one event.
        throw new Error(`${writeFailures} SES suppression write(s) failed`);
    }

    return { recordsProcessed: records.length };
};

// Exported for tests only; the Lambda runtime uses `handler`.
exports.SUPPRESSION_WRITE_FAILED = SUPPRESSION_WRITE_FAILED;
