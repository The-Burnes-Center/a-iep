/**
 * Create Auth Challenge Lambda Trigger for Phone OTP Authentication
 * This function generates a random OTP and sends it via SMS using AWS SNS
 * 
 * Based on AWS Cognito Custom Authentication Challenge best practices:
 * - Implement rate limiting and abuse protection
 * - Use secure OTP generation
 * - Proper error handling and logging
 * - SMS delivery via SNS for verified numbers
 */

const crypto = require('crypto');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { sanitizeCognitoEvent } = require('./sanitize');
const { getMessages, resolveLanguage } = require('./messages');
const {
    assertNotSuppressed,
    enforceGlobalEmailBudget,
    enforceEmailRateLimit,
    buildOtpEmailParams,
    isDeliberateEmailRefusal,
    reportEmailSendFailure,
} = require('./email-suppression');
const { FICTIONAL_TEST_EMAIL } = require('./destination');

// Initialize AWS clients
const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

// The rate-limit counter lives in DynamoDB; build the client lazily so the
// handshake round (and environments without the table) never pays for it.
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

// SSM is only touched by the staging E2E test backdoor (see isTestNumber);
// build the client lazily so production invocations never pay for it.
let ssmClient = null;
function getSsmClient() {
    if (!ssmClient) {
        const { SSMClient } = require('@aws-sdk/client-ssm');
        ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    return ssmClient;
}

// Configuration constants
const OTP_LENGTH = 6;
// Also the code's real validity: verify-auth-challenge rejects answers older
// than this (via privateChallengeParameters.issuedAt), the pool client's
// authSessionValidity matches it, and the SMS copy in messages.js quotes it.
const OTP_EXPIRY_MINUTES = 5;
const MAX_SMS_PER_HOUR = 5; // Per phone number, across auth sessions

// Service-wide SMS ceilings, counted across all recipients. MAX_SMS_PER_HOUR
// is per-recipient and so bounds one inbox rather than total spend; these
// bound total spend, and are sized to bind before the provider's own account
// ceiling, because the provider accepts and drops a message rather than
// failing the call once that ceiling is reached.
//
// These are FLOORS, not the deployed values. The operational numbers live in
// Parameter Store outside this repo (see resolveSmsPolicy). Anything
// unreadable falls back to these, which are deliberately TIGHTER than the
// values in use: a config failure must narrow the service, never widen it.
const FLOOR_SMS_PER_HOUR_GLOBAL = 50;
const FLOOR_SMS_PER_DAY_GLOBAL = 100;

// SNS declines to send when a message would cost more than this. Comfortably
// clears every destination we serve, and is a second lock independent of the
// destination allowlist below.
const SMS_MAX_PRICE_USD = '0.05';

// NANP reserves the 555-01XX block for fiction: +1 555 555-01XX can never be
// assigned to a real handset. Hard-coding the block here (instead of trusting
// the env var alone) is the second lock on the E2E test backdoor.
const FICTIONAL_TEST_NUMBER_REGEX = /^\+155555501\d{2}$/;

// A-IEP serves families in the United States, so every OTP goes to a NANP
// (+1) number. Anything else is not a destination this service has a reason
// to text, and refusing it is a load-bearing abuse control rather than a
// nicety. Overridable per environment; see the deployment config.
const DEFAULT_ALLOWED_SMS_PREFIXES = ['+1'];

/**
 * Staging E2E test backdoor gate. A number qualifies only if BOTH hold:
 *   (a) it is listed in the TEST_PHONE_NUMBERS env var (comma-separated,
 *       entries trimmed, exact match) — staging sets this, production never
 *       does, so with no env var there is no backdoor at all; and
 *   (b) it matches FICTIONAL_TEST_NUMBER_REGEX — checked regardless of the
 *       env var, so even a misconfigured or compromised allowlist can never
 *       divert a real subscriber's OTP away from SMS.
 */
function isTestNumber(phoneNumber) {
    const allowlist = process.env.TEST_PHONE_NUMBERS;
    if (!allowlist) {
        return false;
    }
    const allowlisted = allowlist.split(',').map((entry) => entry.trim()).includes(phoneNumber);
    return allowlisted && FICTIONAL_TEST_NUMBER_REGEX.test(phoneNumber);
}

/**
 * The email half of the staging E2E backdoor, double-locked exactly like
 * isTestNumber above. An address qualifies only if BOTH hold:
 *   (a) it is listed in TEST_EMAIL_ADDRESSES, which staging sets and
 *       production never does; and
 *   (b) it matches the hard-coded fictional-domain expression in
 *       destination.js, checked regardless of the env var, so even a
 *       misconfigured allowlist can never divert a real parent's code away
 *       from their inbox.
 *
 * `a-iep.invalid` is reserved by RFC 2606 and can never be delegated, which
 * makes it the email equivalent of the NANP 555-01XX block.
 */
function isTestEmail(address) {
    const allowlist = process.env.TEST_EMAIL_ADDRESSES;
    if (!allowlist) {
        return false;
    }
    const allowlisted = allowlist.split(',').map((entry) => entry.trim()).includes(address);
    return allowlisted && FICTIONAL_TEST_EMAIL.test(address);
}

/**
 * Where a backdoored code is parked, as an SSM parameter name fragment.
 *
 * SSM names only allow a-zA-Z0-9_.- plus / for hierarchy, so neither the
 * E.164 leading '+' nor an address's '@' can appear. A phone number drops the
 * '+'; an address keeps only its local part, which is unique inside the one
 * fictional domain the allowlist permits. The E2E runner builds the same name.
 */
function testStashName(channel, phoneNumber, emailAddress) {
    return channel === 'sms'
        ? phoneNumber.replace(/^\+/, '')
        : emailAddress.slice(0, emailAddress.lastIndexOf('@'));
}

/** Parsed policy plus the time it was read, so it can be re-read periodically. */
let smsPolicyCache = null;
const SMS_POLICY_TTL_MS = 5 * 60 * 1000;

const parsePrefixList = (raw) => {
    const entries = String(raw || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    // Every entry must look like a dialling prefix. One malformed entry
    // invalidates the whole list rather than being dropped quietly, because a
    // half-applied allowlist is a policy nobody wrote.
    return entries.length > 0 && entries.every((entry) => /^\+\d{1,4}$/.test(entry)) ? entries : null;
};

const parseCeiling = (raw) => {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * The SMS policy actually in force: allowed destinations and the two global
 * ceilings.
 *
 * Read from Parameter Store rather than compiled in, so the deployed
 * calibration is not published in a public repo. Precedence is
 * Parameter Store, then the matching env var, then the compiled floor above.
 * Every layer fails CLOSED: an absent, empty or unparseable value falls back
 * to the tighter setting rather than to an open one, so no configuration
 * mistake can widen the service.
 *
 * Cached for SMS_POLICY_TTL_MS so a ceiling can be changed during an incident
 * without a redeploy, and so a warm container is not paying for a read on
 * every login.
 */
async function resolveSmsPolicy() {
    if (smsPolicyCache && Date.now() - smsPolicyCache.readAt < SMS_POLICY_TTL_MS) {
        return smsPolicyCache.policy;
    }

    const fromEnv = {
        prefixes: parsePrefixList(process.env.SMS_ALLOWED_COUNTRY_CODES),
        maxPerHour: parseCeiling(process.env.MAX_SMS_PER_HOUR_GLOBAL),
        maxPerDay: parseCeiling(process.env.MAX_SMS_PER_DAY_GLOBAL),
    };

    let fromStore = {};
    const prefix = process.env.SMS_POLICY_PARAM_PREFIX;
    if (prefix) {
        const names = {
            prefixes: `${prefix}/allowed-country-codes`,
            maxPerHour: `${prefix}/max-per-hour-global`,
            maxPerDay: `${prefix}/max-per-day-global`,
        };
        try {
            const { GetParametersCommand } = require('@aws-sdk/client-ssm');
            const result = await getSsmClient().send(new GetParametersCommand({
                Names: Object.values(names),
            }));
            const values = Object.fromEntries((result.Parameters || []).map((p) => [p.Name, p.Value]));
            fromStore = {
                prefixes: parsePrefixList(values[names.prefixes]),
                maxPerHour: parseCeiling(values[names.maxPerHour]),
                maxPerDay: parseCeiling(values[names.maxPerDay]),
            };
        } catch (error) {
            // Not fatal: the floors below still bound spend. Logged because a
            // silently ignored policy source is how calibration drifts.
            console.error('SMS policy unreadable from Parameter Store; falling back:', error);
        }
    }

    const policy = {
        prefixes: fromStore.prefixes || fromEnv.prefixes || DEFAULT_ALLOWED_SMS_PREFIXES,
        maxPerHour: fromStore.maxPerHour || fromEnv.maxPerHour || FLOOR_SMS_PER_HOUR_GLOBAL,
        maxPerDay: fromStore.maxPerDay || fromEnv.maxPerDay || FLOOR_SMS_PER_DAY_GLOBAL,
    };
    smsPolicyCache = { readAt: Date.now(), policy };
    return policy;
}

/** Test seam: drop the cached policy so the next call re-reads it. */
function resetSmsPolicyCache() {
    smsPolicyCache = null;
}

/**
 * A refusal this code made on purpose, as opposed to something breaking.
 *
 * These carry their own reason to the caller instead of the generic retry
 * copy, which would be a lie: retrying an unsupported destination never
 * succeeds. They are also excluded from the SMS_SEND_FAILED marker, so the
 * "delivery is broken" alarm does not fire every time a control does its job.
 */
function isDeliberateRefusal(error) {
    return (
        error.name === 'RateLimitError' ||
        error.name === 'UnsupportedDestinationError' ||
        error.name === 'SmsBudgetError' ||
        isDeliberateEmailRefusal(error)
    );
}

/**
 * The same refusal, as a stable code a caller can branch on.
 *
 * The `error` challenge parameter beside it is copy for a parent, in their
 * own language, and copy gets reworded. auth-dispatch needs to tell "this
 * destination will never work" from "try again in a minute" without reading
 * English prose, so it reads this instead. The values are the `reason` set in
 * docs/AUTH_API_CONTRACT.md; anything unmapped is a send that broke rather
 * than a control that fired.
 */
const REFUSAL_CODES = Object.freeze({
    UnsupportedDestinationError: 'unsupported_destination',
    EmailSuppressedError: 'unsupported_destination',
    RateLimitError: 'rate_limited',
    EmailRateLimitError: 'rate_limited',
    SmsBudgetError: 'budget_exhausted',
    EmailBudgetError: 'budget_exhausted',
    EmailSuppressionUnavailableError: 'budget_exhausted',
});

const refusalCode = (error) => REFUSAL_CODES[error && error.name] || 'delivery_failed';

/**
 * Refuse to text a destination we do not serve, before any spend is incurred.
 */
function enforceAllowedDestination(phoneNumber, prefixes) {
    if (prefixes.some((prefix) => phoneNumber.startsWith(prefix))) {
        return;
    }

    // Logged rather than silent, so a refusal is diagnosable. Only the
    // dialling prefix is recorded; the sanitize.js discipline applies to the
    // rest of the number.
    // SMS_REFUSED_DESTINATION is a stable marker, not prose: a metric filter
    // alarms on it, and rewording a sentence must not silently disarm an
    // alarm. Same contract as RECORD_FAILURE in the pipeline.
    console.error(
        `SMS_REFUSED_DESTINATION prefix=${phoneNumber.slice(0, 4)} allowed=${prefixes.join(',')}`
    );
    const error = new Error('This phone number is not supported. A-IEP can only send codes to United States numbers.');
    error.name = 'UnsupportedDestinationError';
    throw error;
}

exports.handler = async (event) => {
    console.log('Create Auth Challenge Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));
    
    const phoneNumber = event.request.userAttributes.phone_number;
    const emailAddress = event.request.userAttributes.email;
    // Phone wins when an account somehow has both, matching the rule
    // verify-auth-challenge already uses to decide what a completed round
    // proved: the code went by SMS, so SMS is the channel possession was
    // proved on. No account in either pool currently has both.
    const channel = phoneNumber ? 'sms' : (emailAddress ? 'email' : null);
    const userName = event.userName;
    const session = event.request.session || [];

    try {
        // Validate required parameters. This guard used to be phone-only and
        // was the first thing an email parent would hit.
        if (!channel) {
            console.error('Neither a phone number nor an email address in user attributes');
            throw new Error('A phone number or email address is required for OTP authentication');
        }

        // Basic E.164 format validation
        if (channel === 'sms') {
            validatePhoneNumberFormat(phoneNumber);
        }

        // Round 1 is a language handshake, not an SMS: Cognito doesn't
        // forward sign-in (InitiateAuth) clientMetadata to this trigger, so
        // the first round sends nothing and asks the client to answer with
        // its UI language. The client's RespondToAuthChallenge metadata DOES
        // reach the next round, which sends the OTP in that language.
        // verify-auth-challenge auto-passes this round and
        // define-auth-challenge never issues tokens for it.
        if (session.length === 0) {
            event.response.publicChallengeParameters = {
                challengeType: 'LANGUAGE_HANDSHAKE',
                // phone_number stays exactly where it was for a phone account:
                // the deployed frontend still reads it, and this flow has to
                // keep working until that frontend is replaced.
                ...(channel === 'sms' ? { phone_number: phoneNumber } : { email: emailAddress })
            };
            event.response.privateChallengeParameters = {
                secretLoginCode: 'LANGUAGE_HANDSHAKE'
            };
            event.response.challengeMetadata = 'LANGUAGE_HANDSHAKE';
            console.log('Issued language handshake round (no SMS)');
            return event;
        }

        let secretLoginCode;
        let issuedAt;

        // Check if this is a retry of the same session
        if (session.length > 0) {
            const lastChallenge = session[session.length - 1];
            if (lastChallenge.challengeMetadata) {
                try {
                    const metadata = JSON.parse(lastChallenge.challengeMetadata);
                    const timeDiff = new Date() - new Date(metadata.timestamp);

                    // Reuse OTP if within expiry window (5 minutes)
                    if (timeDiff < OTP_EXPIRY_MINUTES * 60 * 1000 && metadata.code) {
                        secretLoginCode = metadata.code;
                        // Keep the original issuance stamp: re-stamping a
                        // reuse round would slide the expiry window on every
                        // retry, and the SMS already promised a fixed window.
                        issuedAt = metadata.timestamp;
                        console.log(`Reusing existing OTP for user: ${userName}`);
                    }
                } catch (parseError) {
                    console.log('Could not parse previous challenge metadata, generating new OTP');
                }
            }
        }

        // Generate new OTP if not reusing
        if (!secretLoginCode) {
            const isTestDestination = channel === 'sms'
                ? isTestNumber(phoneNumber)
                : isTestEmail(emailAddress);

            if (channel === 'sms') {
                // Ahead of both the backdoor branch and the rate limiter: an
                // unservable destination must never reach SNS, never write a
                // counter row, and never stash a code. Checked unconditionally
                // so the allowlist holds regardless of the branches below.
                const policy = await resolveSmsPolicy();
                enforceAllowedDestination(phoneNumber, policy.prefixes);

                // Neither counter meters a backdoored send: it transmits no
                // SMS, so it draws on no budget.
                if (!isTestDestination) {
                    await enforceGlobalSmsBudget(policy);
                    await enforceSmsRateLimit(phoneNumber);
                }
            } else if (!isTestDestination) {
                // Suppression FIRST, and before either ceiling: mailing an
                // address SES has already told us is bad is how the identity
                // gets suspended, and a suspension ends email sign-in for
                // every family until AWS accepts an appeal. Fails CLOSED.
                //
                // Skipped for a test address because nothing is ever mailed to
                // one. The double lock on isTestEmail is what makes that safe:
                // an address only qualifies if it is BOTH on the staging-only
                // allowlist AND on the reserved a-iep.invalid domain.
                await assertNotSuppressed(emailAddress);
                await enforceGlobalEmailBudget();
                await enforceEmailRateLimit(emailAddress);
            }
            secretLoginCode = generateSecureOTP();
            issuedAt = new Date().toISOString();
            console.log(`Generated new OTP for user: ${userName}`);

            // Resolve the user's language either way (clientMetadata ->
            // profile -> English): the E2E runner asserts localization too.
            const language = await resolveLanguage(event);
            if (isTestDestination) {
                await stashTestOtp(
                    testStashName(channel, phoneNumber, emailAddress),
                    secretLoginCode, language, issuedAt,
                );
                console.log(`test destination: OTP stashed to SSM, nothing sent (language: ${language})`);
            } else if (channel === 'sms') {
                await sendSMS(phoneNumber, secretLoginCode, language);
                console.log(`SMS sent successfully (language: ${language})`);
            } else {
                await sendEmail(emailAddress, secretLoginCode, language);
                console.log(`Email sent successfully (language: ${language})`);
            }
        }

        // Set challenge parameters
        event.response.publicChallengeParameters = channel === 'sms'
            ? { phone_number: phoneNumber }
            : { email: emailAddress };

        // issuedAt rides along because verify-auth-challenge never receives
        // the session array: privateChallengeParameters is the only channel
        // that can carry the issuance time to the expiry check there.
        event.response.privateChallengeParameters = {
            secretLoginCode: secretLoginCode,
            issuedAt: issuedAt
        };

        // Store metadata for retry logic and expiry
        event.response.challengeMetadata = JSON.stringify({
            code: secretLoginCode,
            timestamp: issuedAt,
            phoneNumber: phoneNumber,
            attempt: session.length + 1
        });
        
        console.log('Create Auth Challenge Response successful');
        
    } catch (error) {
        console.error('Error in Create Auth Challenge:', error);

        // A refusal is this code working. Anything else means the send path
        // itself broke, which is the case no alarm could previously see:
        // failures are reported through the challenge parameter rather than
        // raised, so the trigger's Lambda Errors metric stays at zero through
        // a total outage. SMS_SEND_FAILED is what a metric filter watches.
        if (!isDeliberateRefusal(error)) {
            if (channel === 'email') {
                // EMAIL_SEND_FAILED is the email half's own marker and has its
                // own alarm on the sender's log group; counting this as an SMS
                // failure too would page twice for one event.
                reportEmailSendFailure(error);
            } else {
                console.error(`SMS_SEND_FAILED kind=${error.name || 'Error'}`);
            }
        }

        // Set error response that will be handled by the client.
        //
        // errorCode is the machine half, added for auth-dispatch: `error` is
        // parent-facing copy in their own language and copy gets reworded, so
        // a caller deciding "will this destination ever work" must not be
        // reading English prose to find out.
        event.response.publicChallengeParameters = {
            error: isDeliberateRefusal(error)
                ? error.message
                : 'Failed to send verification code. Please try again.',
            errorCode: refusalCode(error)
        };
        
        // Still need to set private parameters to avoid Lambda errors
        event.response.privateChallengeParameters = {
            secretLoginCode: 'ERROR'
        };
        
        event.response.challengeMetadata = JSON.stringify({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
    
    return event;
};

/**
 * Count one SMS send against the service-wide hourly AND daily budgets.
 *
 * Fails closed on a missing table and on a DynamoDB error. Refusing to text
 * during a DynamoDB outage costs little in practice, because DynamoDB also
 * holds the profiles and documents the app runs on and is unusable meanwhile;
 * an unmetered send window costs considerably more and for far longer.
 *
 * Counters live in separate rows from the per-recipient ones on the same
 * table and TTL, so this needs no schema change.
 */
async function enforceGlobalSmsBudget(policy) {
    const tableName = process.env.OTP_RATE_LIMIT_TABLE;
    if (!tableName) {
        console.error('SMS_BUDGET_EXHAUSTED window=all reason=unmetered');
        throw budgetExhausted('the SMS budget cannot be metered');
    }

    const hourMs = 60 * 60 * 1000;
    const windows = [
        { pk: `GLOBAL#H#${Math.floor(Date.now() / hourMs)}`, max: policy.maxPerHour, ttlSeconds: 2 * 60 * 60, label: 'hourly' },
        { pk: `GLOBAL#D#${Math.floor(Date.now() / (24 * hourMs))}`, max: policy.maxPerDay, ttlSeconds: 48 * 60 * 60, label: 'daily' },
    ];

    for (const { pk, max, ttlSeconds, label } of windows) {
        let count;
        try {
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const result = await getDocClient().send(new UpdateCommand({
                TableName: tableName,
                Key: { pk },
                UpdateExpression: 'ADD smsCount :one SET expiresAt = if_not_exists(expiresAt, :expiry)',
                ExpressionAttributeValues: {
                    ':one': 1,
                    ':expiry': Math.floor(Date.now() / 1000) + ttlSeconds
                },
                ReturnValues: 'ALL_NEW'
            }));
            count = result.Attributes && result.Attributes.smsCount;
        } catch (error) {
            console.error(`SMS_BUDGET_EXHAUSTED window=${label} reason=unmeterable`, error);
            throw budgetExhausted('the SMS budget cannot be metered');
        }

        if (count > max) {
            // Loud on purpose: alarms key on this line.
            console.error(`SMS_BUDGET_EXHAUSTED window=${label} reason=ceiling`);
            throw budgetExhausted(`the service-wide ${label} SMS limit is reached`);
        }
    }
}

/**
 * The caller did nothing wrong and retrying shortly may well work, so the
 * copy says "temporarily" and never blames the number. The operational
 * reason stays in CloudWatch.
 */
function budgetExhausted(reason) {
    const error = new Error('Text messaging is temporarily unavailable. Please try again in a little while.');
    error.name = 'SmsBudgetError';
    error.reason = reason;
    return error;
}

/**
 * Count one SMS send against the phone's hourly budget, throwing once spent.
 *
 * The counter must live outside the auth session: Cognito issues a fresh
 * session on every InitiateAuth, so an in-session tally sees at most one
 * send and can never cap per-phone volume (SMS bombing just loops
 * InitiateAuth). Rows are keyed by sha256(phone) + hour bucket, so no raw
 * phone numbers are stored, and expire via TTL. DynamoDB trouble fails
 * open: an outage must not lock every user out of login (the SNS MaxPrice
 * attribute still bounds worst-case SMS spend).
 */
async function enforceSmsRateLimit(phoneNumber) {
    const tableName = process.env.OTP_RATE_LIMIT_TABLE;
    if (!tableName) {
        console.warn('OTP_RATE_LIMIT_TABLE not set; skipping SMS rate limit');
        return;
    }

    let smsCount;
    try {
        const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
        const hashedPhone = crypto.createHash('sha256').update(phoneNumber).digest('hex');
        const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
        const result = await getDocClient().send(new UpdateCommand({
            TableName: tableName,
            Key: { pk: `${hashedPhone}#${hourBucket}` },
            UpdateExpression: 'ADD smsCount :one SET expiresAt = if_not_exists(expiresAt, :expiry)',
            ExpressionAttributeValues: {
                ':one': 1,
                ':expiry': Math.floor(Date.now() / 1000) + 2 * 60 * 60
            },
            ReturnValues: 'ALL_NEW'
        }));
        smsCount = result.Attributes && result.Attributes.smsCount;
    } catch (error) {
        console.error('SMS rate limit check failed (failing open):', error);
        return;
    }

    if (smsCount > MAX_SMS_PER_HOUR) {
        console.error('SMS rate limit exceeded; refusing to send');
        const rateLimitError = new Error('Too many verification codes requested. Please wait an hour and try again.');
        rateLimitError.name = 'RateLimitError';
        throw rateLimitError;
    }
}

/**
 * Generate a cryptographically secure OTP
 */
function generateSecureOTP() {
    // Use crypto.randomInt for better security than Math.random
    const min = Math.pow(10, OTP_LENGTH - 1);
    const max = Math.pow(10, OTP_LENGTH) - 1;
    return crypto.randomInt(min, max + 1).toString();
}

/**
 * Basic phone number format validation for E.164 format
 */
function validatePhoneNumberFormat(phoneNumber) {
    // Basic E.164 format validation
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(phoneNumber)) {
        throw new Error('Phone number must be in E.164 format (e.g., +1234567890)');
    }
    
    console.log('Phone number format validation passed');
}

/**
 * Staging E2E backdoor delivery: instead of texting an isTestNumber() phone,
 * park the code in SSM Parameter Store for the Playwright runner to read.
 * A PutParameter failure propagates to the handler's catch and surfaces the
 * same error challenge shape as an SNS failure. Never log the code itself
 * (the sanitize.js discipline applies to backdoored codes too).
 */
async function stashTestOtp(stashKey, otpCode, language, issuedAt) {
    const prefix = process.env.TEST_OTP_PARAM_PREFIX;
    if (!prefix) {
        // Misconfiguration must be loud: an allowlisted test destination with
        // nowhere to stash its code should fail the round, not quietly send a
        // message to a fictional destination into the void.
        throw new Error('this destination is allowlisted but TEST_OTP_PARAM_PREFIX is not set');
    }

    const paramName = `${prefix}/${stashKey}`;

    const { PutParameterCommand } = require('@aws-sdk/client-ssm');
    await getSsmClient().send(new PutParameterCommand({
        Name: paramName,
        Type: 'String',
        Overwrite: true,
        Value: JSON.stringify({ code: otpCode, language: language, issuedAt: issuedAt })
    }));
}

/**
 * Send SMS using AWS SNS with enhanced security
 */
async function sendSMS(phoneNumber, otpCode, language = 'en') {
    const message = getMessages(language).otpLoginSms
        .replace('{code}', otpCode)
        .replace('{minutes}', OTP_EXPIRY_MINUTES);

    const publishParams = {
        Message: message,
        PhoneNumber: phoneNumber,
        MessageAttributes: {
            'AWS.SNS.SMS.SenderID': {
                DataType: 'String',
                StringValue: 'GovLab-AIEP'
            },
            'AWS.SNS.SMS.SMSType': {
                DataType: 'String',
                StringValue: 'Transactional'
            },
            'AWS.SNS.SMS.MaxPrice': {
                DataType: 'String',
                StringValue: SMS_MAX_PRICE_USD
            }
        }
    };
    
    const command = new PublishCommand(publishParams);
    const result = await snsClient.send(command);
    
    console.log(`SMS sent successfully. MessageId: ${result.MessageId}`);
    return result;
}

/**
 * Send the code by email, through the configuration set and nothing else.
 *
 * ConfigurationSetName is NOT a formality here and is why every send goes
 * through buildOtpEmailParams rather than an object literal: `a-iep.org`
 * already carries a DEFAULT configuration set belonging to another project in
 * this shared AWS account, and that set has no event destinations. A send that
 * omits our set therefore does not fail and does not fall back to plain SES.
 * It succeeds, counts against the shared reputation, and has its bounces and
 * complaints discarded, so nothing ever reaches the suppression list and
 * nothing says so. IAM cannot close this -- ses:SendEmail has no condition key
 * for the configuration set -- so one function every send goes through, and a
 * test pinning ConfigurationSetName on its output, IS the control.
 *
 * SESv2, built lazily so an SMS-only invocation never pays to load the client.
 */
let sesClient = null;
async function sendEmail(address, otpCode, language = 'en') {
    const messages = getMessages(language);
    const fill = (template) => template
        .replace('{code}', otpCode)
        .replace('{minutes}', OTP_EXPIRY_MINUTES);

    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    if (!sesClient) {
        sesClient = new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });
    }

    const result = await sesClient.send(new SendEmailCommand(buildOtpEmailParams({
        to: address,
        subject: messages.otpLoginEmailSubject,
        text: fill(messages.otpLoginEmailText),
        html: fill(messages.otpLoginEmailHtml),
    })));

    // The message id, never the address and never the code.
    console.log(`Email sent successfully. MessageId: ${result.MessageId}`);
    return result;
}

/** Test seam: drop the memoized SES client so a fresh mock is picked up. */
function resetSesClient() {
    sesClient = null;
}

// Exported for tests only; the Lambda runtime uses `handler`.
exports.resetSmsPolicyCache = resetSmsPolicyCache;
exports.resetSesClient = resetSesClient;
