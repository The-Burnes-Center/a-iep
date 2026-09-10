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

// NANP reserves the 555-01XX block for fiction: +1 555 555-01XX can never be
// assigned to a real handset. Hard-coding the block here (instead of trusting
// the env var alone) is the second lock on the E2E test backdoor.
const FICTIONAL_TEST_NUMBER_REGEX = /^\+155555501\d{2}$/;

// A-IEP serves families in the United States, so every OTP goes to a NANP
// (+1) number. Restricting the destination is what actually stops SMS-pumping
// fraud, and MAX_SMS_PER_HOUR cannot: that counter keys on one phone number,
// and a pumping run never reuses one.
//
// On 2026-09-09 an attacker signed up 1,024 numbers in 13 minutes, each used
// exactly once, and drained the account's $50 monthly SNS budget. Because the
// spend cap is account-level, that took login down for every real family in
// production AND staging. 1,023 of those 1,024 numbers were non-+1, and the
// only non-+1 accounts in the pool were the attacker's own reconnaissance.
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
 * Allowed SMS destinations, as E.164 dialling prefixes. Country codes are a
 * prefix code, so a plain startsWith is the whole test.
 *
 * SMS_ALLOWED_COUNTRY_CODES overrides the default (comma-separated, entries
 * trimmed) so a new country never needs a code change. Unlike
 * enforceSmsRateLimit below, this list fails CLOSED: an unset, empty or
 * all-whitespace value falls back to +1 rather than allowing everything,
 * because a missing env var must not silently reopen the hole that took
 * production down.
 */
function allowedSmsPrefixes() {
    const configured = (process.env.SMS_ALLOWED_COUNTRY_CODES || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return configured.length > 0 ? configured : DEFAULT_ALLOWED_SMS_PREFIXES;
}

/**
 * Refuse to text a destination we do not serve, before any spend is incurred.
 */
function enforceAllowedDestination(phoneNumber) {
    const prefixes = allowedSmsPrefixes();
    if (prefixes.some((prefix) => phoneNumber.startsWith(prefix))) {
        return;
    }

    // Loud, and safe to log: the country code alone is what identifies a
    // pumping run in CloudWatch, and it cannot rebuild the target list. The
    // sanitize.js discipline still applies to the rest of the number.
    console.error(
        `Refusing SMS to unsupported destination ${phoneNumber.slice(0, 4)}...; allowed prefixes: ${prefixes.join(',')}`
    );
    const error = new Error('This phone number is not supported. A-IEP can only send codes to United States numbers.');
    error.name = 'UnsupportedDestinationError';
    throw error;
}

exports.handler = async (event) => {
    console.log('Create Auth Challenge Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));
    
    const phoneNumber = event.request.userAttributes.phone_number;
    const userName = event.userName;
    const session = event.request.session || [];
    
    try {
        // Validate required parameters
        if (!phoneNumber) {
            console.error('Phone number not found in user attributes');
            throw new Error('Phone number is required for SMS authentication');
        }
        
        // Basic E.164 format validation
        validatePhoneNumberFormat(phoneNumber);

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
                phone_number: phoneNumber
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
            const testNumber = isTestNumber(phoneNumber);

            // Ahead of both the backdoor branch and the rate limiter: an
            // unservable destination must never reach SNS, never write a
            // rate-limit row, and never stash a code. Checked unconditionally
            // rather than inside the !testNumber arm so that the allowlist
            // still holds if FICTIONAL_TEST_NUMBER_REGEX ever widens.
            enforceAllowedDestination(phoneNumber);

            // The rate-limit counter meters SMS spend; a backdoored send
            // transmits no SMS, so it doesn't draw on that budget.
            if (!testNumber) {
                await enforceSmsRateLimit(phoneNumber);
            }
            secretLoginCode = generateSecureOTP();
            issuedAt = new Date().toISOString();
            console.log(`Generated new OTP for user: ${userName}`);

            // Resolve the user's language either way (clientMetadata ->
            // profile -> English): the E2E runner asserts localization too.
            const language = await resolveLanguage(event);
            if (testNumber) {
                await stashTestOtp(phoneNumber, secretLoginCode, language, issuedAt);
                console.log(`test number: OTP stashed to SSM, no SMS sent (language: ${language})`);
            } else {
                await sendSMS(phoneNumber, secretLoginCode, language);
                console.log(`SMS sent successfully (language: ${language})`);
            }
        }

        // Set challenge parameters
        event.response.publicChallengeParameters = {
            phone_number: phoneNumber
        };

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

        // Set error response that will be handled by the client
        // Both named errors are deliberate refusals with an accurate reason.
        // "Please try again" would be a lie for either: retrying an
        // unsupported country never succeeds.
        const isDeliberateRefusal =
            error.name === 'RateLimitError' || error.name === 'UnsupportedDestinationError';
        event.response.publicChallengeParameters = {
            error: isDeliberateRefusal
                ? error.message
                : 'Failed to send verification code. Please try again.'
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
async function stashTestOtp(phoneNumber, otpCode, language, issuedAt) {
    const prefix = process.env.TEST_OTP_PARAM_PREFIX;
    if (!prefix) {
        // Misconfiguration must be loud: an allowlisted test number with
        // nowhere to stash its code should fail the round, not quietly text
        // a fictional number into the void.
        throw new Error('TEST_PHONE_NUMBERS lists this number but TEST_OTP_PARAM_PREFIX is not set');
    }

    // SSM parameter names only allow a-zA-Z0-9_.- (plus / for hierarchy),
    // so the E.164 leading '+' can't appear in the name. The E2E runner must
    // strip it the same way when it reads the parameter back.
    const paramName = `${prefix}/${phoneNumber.replace(/^\+/, '')}`;

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
                StringValue: '0.50' // Prevent high-cost SMS abuse
            }
        }
    };
    
    const command = new PublishCommand(publishParams);
    const result = await snsClient.send(command);
    
    console.log(`SMS sent successfully. MessageId: ${result.MessageId}`);
    return result;
} 