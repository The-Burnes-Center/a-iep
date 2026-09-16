/**
 * The wire shape of every /auth/* response, in one file.
 *
 * The codes and the copy below ARE docs/AUTH_API_CONTRACT.md. A client
 * branches on `code` and never on `message`, so `code` is a stable identifier
 * that may not be reworded, while `message` is an English fallback for a
 * client that meets a code it has no translation for.
 *
 * Bodies stay generic about causes; the reason goes to CloudWatch. Returning
 * str(e) leaked table names and AWS error codes to callers once before.
 */

/**
 * Every refusal a caller can see, and the English a client falls back to.
 *
 * Keep this map exhaustive: an `errorResponse` for a code that is not here
 * throws, so a new refusal cannot ship with no copy behind it.
 */
const ERROR_MESSAGES = Object.freeze({
    invalid_request: 'Enter your phone number or email address.',
    invalid_destination: 'Enter a valid phone number or email address.',
    unsupported_destination:
        'A-IEP can only send codes to United States phone numbers and regular email addresses.',
    bot_check_failed: 'We could not verify this request. Please try again.',
    rate_limited: 'Too many attempts. Please try again in a little while.',
    unavailable: 'Sign-in is temporarily unavailable. Please try again in a little while.',
    bad_code: 'That code did not work. Check the code and try again, or ask for a new one.',
    // Decision 4, and the one refusal that is deliberately NOT generic. The
    // counter is keyed on the destination whether or not an account exists
    // there, so a stranger's number and a registered one produce the identical
    // message and it leaks nothing. Saying "that code did not work" instead
    // would leave a parent retyping a CORRECT code into a wall.
    too_many_codes: 'You have tried too many codes. Please try again in an hour.',
    not_ready: 'Your code is on its way.',
    send_failed: 'We could not send your code. Please try again.',
    session_invalid: 'Please sign in again.',
});

/** The `reason` values that ride along with a send_failed. */
const SEND_FAILURE_MESSAGES = Object.freeze({
    unsupported_destination:
        'A-IEP cannot send codes to this address. Please try your phone number instead.',
    budget_exhausted: 'Codes are temporarily unavailable. Please try again in a little while.',
    rate_limited: 'Too many codes requested. Please wait an hour and try again.',
    delivery_failed: 'We could not send your code. Please try again.',
});

/**
 * An API Gateway response.
 *
 * `Access-Control-Allow-Origin: '*'` matches every other handler in this repo
 * and is correct while the handle travels in a JSON body. It is one of the
 * three things outside auth-transport.js that change when the handle becomes
 * an HttpOnly cookie, because a wildcard origin cannot carry credentials.
 */
function respond(statusCode, body, headers = {}) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...headers,
        },
        body: JSON.stringify(body),
    };
}

/**
 * A refusal, with its reason logged before it is returned.
 *
 * The log line is not optional. CLAUDE.md: silent 4xx paths are defects, and
 * an unlogged validation rejection made a real failure undiagnosable once
 * before. `marker` is what a metric filter counts, `detail` is free text that
 * must never contain a phone number, an address, a code or a token.
 */
function errorResponse(statusCode, code, { marker, detail, extra } = {}) {
    const message = ERROR_MESSAGES[code];
    if (!message) {
        throw new Error(`errorResponse: no copy for code "${code}"`);
    }
    if (marker) {
        // `reason=` is the contract code a client saw; `detail=` is the one
        // that distinguishes the four different things collapsed into it. Both
        // are key=value so a CloudWatch Insights query can group on either.
        console.error(`${marker} reason=${code}${detail ? ` detail=${detail}` : ''}`);
    }
    return respond(statusCode, { ok: false, code, message, ...(extra || {}) });
}

/** Parse a request body, or null when it is not JSON. */
function parseBody(event) {
    try {
        const parsed = JSON.parse(event && event.body ? event.body : '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

module.exports = {
    ERROR_MESSAGES,
    SEND_FAILURE_MESSAGES,
    respond,
    errorResponse,
    parseBody,
};
