/**
 * Custom SMS Sender Lambda trigger — STAGING POOL ONLY.
 *
 * Why this exists
 * ---------------
 * The custom-auth OTP already has a staging E2E backdoor: for allowlisted
 * NANP-fictional numbers, phone-otp-auth/create-auth-challenge.js parks the
 * code in SSM Parameter Store instead of texting it, and the Playwright runner
 * reads it back. That only covers codes OUR lambda mints. Cognito itself mints
 * and sends the SIGN-UP verification SMS, so a test can start a signup but can
 * never confirm it — nothing in CI can read a real text message.
 *
 * A CustomSMSSender trigger is the only supported interception point for those
 * Cognito-generated codes. Assigning it turns OFF Cognito's built-in SMS
 * delivery for the whole pool: from then on every message the pool would have
 * texted arrives here instead, and this function owns delivery. Hence two
 * paths, and hence the real-number path must be as solid as the backdoor:
 *
 *   - allowlisted fictional test number -> stash the code in SSM, send no SMS;
 *   - anything else -> a real SNS Publish with the same MessageAttributes
 *     create-auth-challenge uses, so a human tester on staging still gets a
 *     text with the same wording the pool's own templates would have sent.
 *
 * lib/authorization/new-auth.ts wires this trigger only when
 * getEnvironment() !== 'prod'. Production never assigns it and keeps Cognito's
 * native SMS delivery untouched; the infra suite pins both sides.
 *
 * Cognito hands the code over encrypted: event.request.code is a base64 AWS
 * Encryption SDK message encrypted under the pool's customSenderKmsKey, so
 * decryption needs @aws-crypto/client-node. That package is vendored in this
 * directory's package.json and installed at deploy time by the `npm ci`
 * bundling step in new-auth.ts (the Lambda runtime does not provide it; it
 * DOES provide the AWS SDK v3 clients, which is why only this one dependency
 * is vendored).
 *
 * NEVER log the code, on either path — the sanitize.js discipline from
 * phone-otp-auth applies here too, and it applies to failure logs as well.
 */

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

// Initialize AWS clients
const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

// SSM is only touched by the staging E2E test backdoor (see isTestNumber);
// build the client lazily so ordinary deliveries never pay for it.
let ssmClient = null;
function getSsmClient() {
    if (!ssmClient) {
        const { SSMClient } = require('@aws-sdk/client-ssm');
        ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    return ssmClient;
}

// The Encryption SDK client and keyring are built once per container, but
// lazily: constructing the keyring needs KMS_KEY_ARN, and a missing env var
// should fail the invocation with a clear error rather than a cold-start crash.
let decryptFn = null;
let kmsKeyring = null;
function getDecrypter() {
    if (!decryptFn) {
        const keyArn = process.env.KMS_KEY_ARN;
        if (!keyArn) {
            throw new Error('KMS_KEY_ARN is not set; cannot decrypt the Cognito code');
        }
        const { buildDecrypt, CommitmentPolicy, KmsKeyringNode } = require('@aws-crypto/client-node');
        // REQUIRE_ENCRYPT_ALLOW_DECRYPT is the policy the AWS custom-sender
        // docs use: Cognito's ciphertext may predate key commitment, so a
        // decrypt-side requirement would reject legitimate codes.
        ({ decrypt: decryptFn } = buildDecrypt(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT));
        // Decrypt-only keyring: the single key ARN Cognito encrypted under.
        // No generatorKeyId — that is an encrypt-side concern and this
        // function never encrypts.
        kmsKeyring = new KmsKeyringNode({ keyIds: [keyArn] });
    }
    return { decrypt: decryptFn, keyring: kmsKeyring };
}

// NANP reserves the 555-01XX block for fiction: +1 555 555-01XX can never be
// assigned to a real handset. Hard-coding the block here (instead of trusting
// the env var alone) is the second lock on the E2E test backdoor. Kept
// byte-identical to phone-otp-auth/create-auth-challenge.js on purpose.
const FICTIONAL_TEST_NUMBER_REGEX = /^\+155555501\d{2}$/;

// The pool's own SMS copy, duplicated here because assigning this trigger
// stops Cognito from rendering its templates at all — it hands us the raw code
// and expects the message to be composed in this function.
//
// SOURCE OF TRUTH: lib/authorization/new-auth.ts
//   cfnUserPool.smsVerificationMessage  -> SMS_VERIFICATION_MESSAGE
//   cfnUserPool.smsAuthenticationMessage -> SMS_AUTHENTICATION_MESSAGE
// Change the copy there and mirror it here, or staging silently drifts from
// the wording production actually sends.
const SMS_VERIFICATION_MESSAGE =
    'Your OTP from The GovLab AIEP is: {####}. Do not share this code. Msg & data rates may apply.';
const SMS_AUTHENTICATION_MESSAGE =
    'Your login code for The GovLab AIEP is: {####}. Do not share this code.';

// Cognito's placeholder in both templates above.
const CODE_PLACEHOLDER = '{####}';

// Trigger sources that carry an account/attribute verification code, i.e. the
// ones Cognito would have rendered with smsVerificationMessage. Everything
// else (Authentication, ForgotPassword, UpdateUserAttribute, AdminCreateUser)
// falls through to the authentication template, which is the safe default:
// it is the generic "here is your code" wording.
const VERIFICATION_TRIGGER_SOURCES = new Set([
    'CustomSMSSender_SignUp',
    'CustomSMSSender_ResendCode',
    'CustomSMSSender_VerifyUserAttribute',
]);

/**
 * Staging E2E test backdoor gate. A number qualifies only if BOTH hold:
 *   (a) it is listed in the TEST_PHONE_NUMBERS env var (comma-separated,
 *       entries trimmed, exact match) — staging sets this, production never
 *       does, so with no env var there is no backdoor at all; and
 *   (b) it matches FICTIONAL_TEST_NUMBER_REGEX — checked regardless of the
 *       env var, so even a misconfigured or compromised allowlist can never
 *       divert a real subscriber's code away from SMS.
 */
function isTestNumber(phoneNumber) {
    const allowlist = process.env.TEST_PHONE_NUMBERS;
    if (!allowlist) {
        return false;
    }
    const allowlisted = allowlist.split(',').map((entry) => entry.trim()).includes(phoneNumber);
    return allowlisted && FICTIONAL_TEST_NUMBER_REGEX.test(phoneNumber);
}

exports.handler = async (event) => {
    const triggerSource = event.triggerSource;
    const phoneNumber = event.request
        && event.request.userAttributes
        && event.request.userAttributes.phone_number;

    // Deliberately terse: the event body carries the (encrypted) code and the
    // user's attributes, so it is never dumped wholesale the way the
    // custom-auth triggers dump their sanitized events.
    console.log(`Custom SMS Sender invoked (source: ${triggerSource})`);

    // Every failure below rethrows. This function IS the pool's SMS delivery,
    // so swallowing an error would let Cognito report a code as sent when no
    // message exists — the exact silent-failure shape the 2026-07 OTP incident
    // produced. Throwing surfaces the delivery failure to the caller instead.
    try {
        if (!phoneNumber) {
            throw new Error('No phone_number user attribute on the custom SMS sender event');
        }

        const code = await decryptCode(event.request && event.request.code);

        if (isTestNumber(phoneNumber)) {
            await stashTestCode(phoneNumber, code, triggerSource);
            console.log(`test number: Cognito code stashed to SSM (source: ${triggerSource})`);
        } else {
            await sendSMS(phoneNumber, code, triggerSource);
        }
    } catch (error) {
        // error.message never contains the code: nothing above interpolates it.
        console.error(`Custom SMS Sender failed (source: ${triggerSource}):`, error);
        throw error;
    }

    // Cognito expects no additional response fields from a custom sender.
    return event;
};

/**
 * Decrypt the code Cognito encrypted under the pool's customSenderKmsKey.
 *
 * event.request.code is a base64-encoded AWS Encryption SDK message, not raw
 * KMS ciphertext, so it must go through the Encryption SDK's decrypt (a plain
 * kms:Decrypt call cannot read it). This is the idiom from the AWS custom SMS
 * sender docs, narrowed to decrypt-only.
 */
async function decryptCode(encryptedCode) {
    if (!encryptedCode) {
        throw new Error('Custom SMS sender event carried no code to deliver');
    }

    const { decrypt, keyring } = getDecrypter();
    const { plaintext } = await decrypt(keyring, Buffer.from(encryptedCode, 'base64'));
    return Buffer.from(plaintext).toString('utf-8');
}

/**
 * Staging E2E backdoor delivery: instead of texting an isTestNumber() phone,
 * park the code in SSM Parameter Store for the Playwright runner to read.
 * Mirrors phone-otp-auth/create-auth-challenge.js stashTestOtp(), including
 * the parameter naming, so the runner reads both kinds of code the same way.
 * The payload records `source` because a single test number can hold a signup
 * code and a login code minutes apart, and the runner must know which it got.
 */
async function stashTestCode(phoneNumber, code, triggerSource) {
    const prefix = process.env.TEST_OTP_PARAM_PREFIX;
    if (!prefix) {
        // Misconfiguration must be loud: an allowlisted test number with
        // nowhere to stash its code should fail the delivery, not quietly text
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
        Value: JSON.stringify({
            code: code,
            issuedAt: new Date().toISOString(),
            source: `cognito-${triggerSource}`,
        }),
    }));
}

/**
 * Real delivery path: publish the SMS the pool would have sent itself.
 * MessageAttributes are copied from create-auth-challenge.js sendSMS() so both
 * senders share one sender ID and one per-message price ceiling.
 */
async function sendSMS(phoneNumber, code, triggerSource) {
    const template = VERIFICATION_TRIGGER_SOURCES.has(triggerSource)
        ? SMS_VERIFICATION_MESSAGE
        : SMS_AUTHENTICATION_MESSAGE;
    const message = template.replace(CODE_PLACEHOLDER, code);

    const result = await snsClient.send(new PublishCommand({
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
    }));

    console.log(`SMS sent successfully (source: ${triggerSource}). MessageId: ${result && result.MessageId}`);
    return result;
}
