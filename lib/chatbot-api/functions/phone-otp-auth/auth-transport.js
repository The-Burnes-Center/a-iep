/**
 * How an opaque handle travels between the browser and this service.
 *
 * THE ONLY PLACE THAT DECIDES THIS. Today a handle is a field in a JSON body
 * and lives in localStorage. The product owner's decision is that it moves to
 * an HttpOnly cookie once the API has a custom domain on the same registrable
 * domain as the app, and that moving it must be a configuration change rather
 * than a rewrite.
 *
 * That property is only real if exactly one module knows about the transport,
 * so nothing else in this directory may read `body.session` or write a
 * Set-Cookie header. When the cookie lands, the two functions below change and
 * nothing else does: not the handle's value, its length, its entropy, its TTL,
 * the table schema, the lookup, or the revocation. See docs/AUTH_API_CONTRACT.md
 * section 6 for the three things outside this file that also move (CORS, the
 * client's `credentials: 'include'`, and the custom domain itself).
 */

/** The field and, later, the cookie name. Host-only when it becomes a cookie:
 *  a cookie on `.a-iep.org` would be shared between production and staging,
 *  which is the kind of thing found by a staging session working in prod. */
const SESSION_FIELD = 'session';
const CHALLENGE_FIELD = 'challenge';

/**
 * Read a handle out of a request.
 *
 * Becomes: parse the `Cookie` header for `aiep_session`. The signature does
 * not change, so no caller does.
 */
function readHandle(body, field) {
    const value = body && body[field];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Put a handle into a response.
 *
 * Returns the body to send, and the headers to send with it, because the
 * cookie version needs a header and this version does not. Callers spread
 * both, so the day one of them becomes empty nothing at the call site moves.
 */
function writeHandle(body, field, handle) {
    return { body: { ...body, [field]: handle }, headers: {} };
}

module.exports = { SESSION_FIELD, CHALLENGE_FIELD, readHandle, writeHandle };
