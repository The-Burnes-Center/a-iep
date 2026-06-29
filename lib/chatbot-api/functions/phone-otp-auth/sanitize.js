/**
 * Shared log-sanitization helper for the phone OTP Cognito triggers.
 *
 * Cognito custom-auth events carry secrets and PII that must never reach
 * CloudWatch, where any IAM principal with log-read access could harvest them:
 *   - request/response.privateChallengeParameters.secretLoginCode -> the OTP
 *   - request.challengeAnswer                                     -> the code the user typed
 *   - request.userAttributes.phone_number / email                 -> PII
 *   - response.publicChallengeParameters.phone_number             -> PII
 *   - session[].challengeMetadata                                 -> JSON string
 *       embedding the OTP code and phone number from prior rounds
 *
 * sanitizeCognitoEvent returns a deep copy with all of the above redacted,
 * leaving the original event untouched so handlers can still read the secrets.
 */

const REDACTED = '[REDACTED]';

function redactChallengeContainer(container) {
    if (!container || typeof container !== 'object') {
        return;
    }
    // The OTP secret and the user-submitted answer.
    if ('privateChallengeParameters' in container) {
        container.privateChallengeParameters = REDACTED;
    }
    if ('challengeAnswer' in container) {
        container.challengeAnswer = REDACTED;
    }
    // challengeMetadata is a JSON string embedding the OTP code + phone number.
    if ('challengeMetadata' in container) {
        container.challengeMetadata = REDACTED;
    }
    // phone_number / email / name are PII.
    if (container.userAttributes && typeof container.userAttributes === 'object') {
        for (const key of ['phone_number', 'email', 'name']) {
            if (key in container.userAttributes) {
                container.userAttributes[key] = REDACTED;
            }
        }
    }
    // publicChallengeParameters echoes the phone number back to the client.
    if (container.publicChallengeParameters
        && typeof container.publicChallengeParameters === 'object'
        && 'phone_number' in container.publicChallengeParameters) {
        container.publicChallengeParameters.phone_number = REDACTED;
    }
    // Each prior challenge round carries its own challengeMetadata (OTP + phone).
    if (Array.isArray(container.session)) {
        for (const round of container.session) {
            if (round && typeof round === 'object' && 'challengeMetadata' in round) {
                round.challengeMetadata = REDACTED;
            }
        }
    }
}

/**
 * Return a deep copy of a Cognito trigger event that is safe to log, with OTP
 * secrets and PII redacted from both the request and the response. Never
 * mutates the original event.
 */
function sanitizeCognitoEvent(event) {
    let clone;
    try {
        clone = JSON.parse(JSON.stringify(event));
    } catch (err) {
        return { note: 'event omitted from logs (not serializable)' };
    }
    redactChallengeContainer(clone.request);
    redactChallengeContainer(clone.response);
    return clone;
}

module.exports = { sanitizeCognitoEvent, REDACTED };
