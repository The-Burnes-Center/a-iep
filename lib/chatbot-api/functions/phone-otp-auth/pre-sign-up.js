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
const { loadSecret, verifyToken } = require('./turnstile');

// Self-service signup. PreSignUp_AdminCreateUser and PreSignUp_ExternalProvider
// are deliberately excluded.
const SELF_SERVICE_SIGNUP = 'PreSignUp_SignUp';

// E.164, as Cognito itself requires for phone_number. Checked here so a
// malformed value falls back to the confirmation flow rather than producing a
// confirmed account whose number could never receive an OTP.
const E164 = /^\+[1-9]\d{7,14}$/;

const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

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

/** A signup this trigger refuses. Cognito surfaces the message to the caller. */
function rejected(reason) {
    const error = new Error(`Sign-up could not be completed: ${reason}.`);
    error.name = 'TurnstileRejected';
    return error;
}

/**
 * Refuse a self-service signup that cannot prove it came from a real browser.
 *
 * A belt-and-braces guard, and deliberately kept after the signup endpoint
 * took over. Once AllowAdminCreateUserOnly is set, PreSignUp_SignUp can no
 * longer happen, so this cannot fire; if that pool setting is ever reverted,
 * the public API reopens and this is the only thing standing in it. A guard
 * that is unreachable under the current config but correct if the config
 * changes is worth its lines. test/infra pins the pool setting so the two
 * cannot drift apart silently.
 *
 * Fails CLOSED on a missing or invalid token and on a verification error.
 * Scope is self-service signup only: admin-created and federated users never
 * reach a browser challenge and must not be blocked by one.
 */
async function enforceTurnstile(event) {
    if (event.triggerSource !== SELF_SERVICE_SIGNUP) {
        return;
    }
    let secret;
    try {
        secret = await loadSecret(process.env.TURNSTILE_SECRET_PARAM);
    } catch (error) {
        console.error('TURNSTILE_REJECTED reason=secret-unreadable', error.message);
        throw rejected('the anti-abuse check could not be run');
    }
    if (!secret) {
        return;
    }

    const result = await verifyToken({
        token: event.request?.clientMetadata?.turnstileToken,
        secret,
    });
    if (result.ok) {
        return;
    }
    console.error(`TURNSTILE_REJECTED reason=${result.reason} codes=${(result.codes || []).join(',')}`);
    throw rejected(result.reason === 'missing-token'
        ? 'the anti-abuse check was not completed'
        : result.reason === 'invalid-token'
            ? 'the anti-abuse check did not pass'
            : 'the anti-abuse check could not be run');
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
