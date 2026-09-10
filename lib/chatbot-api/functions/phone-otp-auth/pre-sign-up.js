/**
 * Pre Sign-up Lambda Trigger: collapse phone signup to a SINGLE SMS.
 *
 * Before this trigger, a new phone user received two texts and typed two
 * codes. They are different codes from different mints:
 *
 *   1. Cognito's own signup verification code, sent because the pool requires
 *      a new account to be confirmed (smsVerificationMessage);
 *   2. our custom-auth login OTP from create-auth-challenge, sent immediately
 *      afterwards because confirming an account does not sign anyone in.
 *
 * Auto-confirming the account here removes code 1 entirely, leaving the login
 * OTP as the only text. Nothing goes unverified: phone possession is still
 * proven by that OTP on this and every later sign-in, and the account holds no
 * data until the user has passed it.
 *
 * Scope, deliberately narrow:
 *   - self-service signup only (PreSignUp_SignUp). Admin-created and federated
 *     users keep Cognito's default handling.
 *   - phone-only signups. An email signup must keep real email verification,
 *     since for those the emailed code is the ONLY proof of address ownership
 *     (there is no later per-login challenge to fall back on), so this trigger
 *     must never set autoVerifyEmail.
 *
 * SECURITY, load-bearing: auto-confirming makes the account immediately
 * usable, and the client picks its own password at Auth.signUp. Without a
 * second change, anyone could sign up a phone number they do not own and then
 * sign in to it with USER_PASSWORD_AUTH using the password they chose. The
 * companion fix is in user-profile-handler/cognito_trigger.py, which rotates
 * every phone-only account's password to a server-generated secret in
 * PostConfirmation. Both halves must stay in place: this trigger is only safe
 * because a phone account's client-chosen password is dead on arrival.
 *
 * On anything unexpected this trigger leaves the response untouched, which
 * means Cognito falls back to the old two-code confirmation flow. Degrading to
 * an extra SMS is always preferable to failing the signup.
 */

const { sanitizeCognitoEvent } = require('./sanitize');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Cloudflare's own guidance. A signup is interactive, so a caller is waiting.
const TURNSTILE_TIMEOUT_MS = 5000;

// SSM is only read on self-service signups, which are rare; build the client
// lazily so admin-created and federated signups never pay for it.
let ssmClient = null;
function getSsmClient() {
    if (!ssmClient) {
        const { SSMClient } = require('@aws-sdk/client-ssm');
        ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    return ssmClient;
}

// The secret outlives a single invocation and never changes between them.
let cachedSecret;

// Self-service signup. PreSignUp_AdminCreateUser and PreSignUp_ExternalProvider
// are deliberately excluded.
const SELF_SERVICE_SIGNUP = 'PreSignUp_SignUp';

// E.164, as Cognito itself requires for phone_number. Checked here so a
// malformed value falls back to the confirmation flow rather than producing a
// confirmed account whose number could never receive an OTP.
const E164 = /^\+[1-9]\d{7,14}$/;

const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * The Turnstile secret, or null when the check is not switched on yet.
 *
 * Enforcement turns on the moment the parameter exists, with no deploy: CDK
 * always passes the NAME, and this reads the VALUE. That split is deliberate.
 * A secret cannot live in a public repo, so the parameter has to be created
 * out of band, and the alternative (fail closed on a parameter that does not
 * exist yet) would break every signup between the deploy and someone
 * remembering to create it.
 *
 * ParameterNotFound therefore means "not configured yet" and allows the
 * signup. EVERY other failure fails closed: once the secret exists, an SSM
 * outage or a permissions mistake must not quietly reopen the door.
 */
async function turnstileSecret() {
    if (cachedSecret !== undefined) {
        return cachedSecret;
    }
    const parameterName = process.env.TURNSTILE_SECRET_PARAM;
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
        // Not cached: a transient SSM failure must not disable the check for
        // the life of this container.
        throw rejected('the anti-abuse check could not be run');
    }
    return cachedSecret;
}

/** A signup this trigger refuses. Cognito surfaces the message to the caller. */
function rejected(reason) {
    const error = new Error(`Sign-up could not be completed: ${reason}.`);
    error.name = 'TurnstileRejected';
    return error;
}

/**
 * Refuse a self-service signup that cannot prove it came from a real browser.
 *
 * This is the control that stops automated signup abuse, and it only works
 * because it runs HERE. The equivalent check in the browser is advisory: the
 * 2026-09-09 run never loaded the site, it called the public SignUp API
 * directly, so anything enforced client-side was simply not in its path.
 *
 * Fails CLOSED on a missing or invalid token, and on a verification error.
 * Signup is roughly a daily event here, so refusing one costs a parent a
 * retry; letting an unverified one through costs a cleanup of thousands of
 * accounts. Those are not comparable, which is why this is the one place in
 * this file that throws.
 *
 * Scope is self-service signup only. Admin-created and federated users never
 * reach a browser challenge and must not be blocked by one.
 */
async function enforceTurnstile(event) {
    if (event.triggerSource !== SELF_SERVICE_SIGNUP) {
        return;
    }
    const secret = await turnstileSecret();
    if (!secret) {
        return;
    }

    const token = event.request?.clientMetadata?.turnstileToken;
    if (!isNonEmpty(token)) {
        console.error('TURNSTILE_REJECTED reason=missing-token');
        throw rejected('the anti-abuse check was not completed');
    }

    let outcome;
    try {
        const response = await fetch(TURNSTILE_VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret, response: token }),
            signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`siteverify returned ${response.status}`);
        }
        outcome = await response.json();
    } catch (error) {
        // Cloudflare unreachable or slow. Failing closed means a Cloudflare
        // outage stops new signups; failing open means anyone who can cause
        // one walks straight through, which is the hole this closes.
        console.error('TURNSTILE_REJECTED reason=verify-failed', error.message);
        throw rejected('the anti-abuse check could not be run');
    }

    if (!outcome.success) {
        // Cloudflare's codes name the cause and carry no personal data.
        console.error(`TURNSTILE_REJECTED reason=invalid-token codes=${(outcome['error-codes'] || []).join(',')}`);
        throw rejected('the anti-abuse check did not pass');
    }
}

/**
 * A phone-only self-service signup is the one case we auto-confirm: there is a
 * usable phone number to text the login OTP to, and no email address whose
 * verification we would be skipping.
 */
function shouldAutoConfirm(event) {
    if (event.triggerSource !== SELF_SERVICE_SIGNUP) {
        return { ok: false, reason: `trigger source ${event.triggerSource} is not self-service signup` };
    }

    const attributes = event.request?.userAttributes || {};

    if (isNonEmpty(attributes.email)) {
        return { ok: false, reason: 'signup carries an email address, which needs real verification' };
    }

    const phone = attributes.phone_number;
    if (!isNonEmpty(phone)) {
        return { ok: false, reason: 'signup has no phone number' };
    }
    if (!E164.test(phone.trim())) {
        return { ok: false, reason: 'phone number is not E.164' };
    }

    return { ok: true };
}

exports.handler = async (event) => {
    console.log('Pre Sign-up Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));

    // Outside the try below on purpose. That catch exists so an unexpected
    // fault degrades to Cognito's two-code flow rather than failing a signup,
    // which is right for the auto-confirm decision and wrong here: a refusal
    // that gets swallowed is not a refusal.
    await enforceTurnstile(event);

    try {
        const decision = shouldAutoConfirm(event);

        if (!decision.ok) {
            // Logged, not silent: a signup that unexpectedly still sends two
            // codes should be diagnosable from the logs alone.
            console.log(`Not auto-confirming (${decision.reason}); using the standard confirmation flow`);
            return event;
        }

        event.response.autoConfirmUser = true;
        event.response.autoVerifyPhone = true;
        console.log(`Auto-confirmed phone signup for user: ${event.userName}`);
    } catch (error) {
        // Throwing here would fail the signup outright. Falling through leaves
        // Cognito's defaults, i.e. the old two-code flow.
        console.error('Error in Pre Sign-up, falling back to standard confirmation:', error);
    }

    return event;
};
