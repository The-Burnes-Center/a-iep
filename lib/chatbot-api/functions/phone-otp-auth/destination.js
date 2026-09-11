/**
 * What a parent typed, and whether A-IEP will send a code to it.
 *
 * One field on the sign-in screen takes either a US phone number or an email
 * address, and the SERVICE decides which it is. That is what kills the
 * enumeration: the client never has to ask a question whose answer is "this
 * person has an account", because it never even says which kind of account it
 * is looking for.
 *
 * Order matters here the same way it does in the endpoint: these checks are
 * free, so they run before anything that costs a round trip.
 */

const crypto = require('crypto');

// E.164, same expression the signup endpoint already uses. Anchored, so a
// number with anything appended is rejected rather than truncated.
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Email syntax, deliberately stricter than RFC 5321 allows.
 *
 * A full RFC-compliant expression accepts quoted local parts, comments and
 * bracketed IP literals, none of which any parent has ever typed and all of
 * which are a way to smuggle punctuation past a downstream check. This is the
 * shape a mail client would accept: one @, a local part with no spaces or
 * angle brackets, and a dotted domain with a two-character-or-longer final
 * label.
 *
 * Length is bounded because the address becomes a Cognito Username.
 */
const EMAIL = /^[^\s@<>,;:"()[\]\\]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

// A-IEP serves families in the United States, so every code goes to a NANP
// number. Same allowlist and same reasoning as create-auth-challenge; kept
// here as well because this check happens before anything is spent.
const DEFAULT_ALLOWED_PREFIXES = ['+1'];

/**
 * RFC 2606 / RFC 6761 reserved top-level domains. These can never be
 * delegated, so mail to them always hard-bounces, and a hard bounce is how the
 * shared SES identity's reputation gets spent. Refused in every environment.
 *
 * The staging E2E allowlist is checked BEFORE this (see isTestAddress), which
 * is why the test addresses can live on `a-iep.invalid`: a reserved domain is
 * exactly the email equivalent of the NANP fictional 555-01XX block, and it is
 * unreachable in production because production sets no allowlist env var.
 */
const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost', 'local'];

/**
 * Domains that exist only to throw an inbox away. Not an abuse control on its
 * own -- the list is endless and anybody determined will find one that is not
 * on it -- but it costs nothing and it stops the casual case, which is the
 * one that generates bounces.
 *
 * Deliberately short and deliberately in source: knowing that A-IEP refuses
 * mailinator helps nobody attack it, and a list nobody can read is a list
 * nobody can correct.
 */
const DISPOSABLE_DOMAINS = [
    '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'sharklasers.com',
    'temp-mail.org', 'tempmail.com', 'throwawaymail.com', 'trashmail.com',
    'yopmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
];

/**
 * Staging-only E2E test addresses, in the shape the phone backdoor already
 * uses, and double-locked for the same reason.
 *
 *   1. TEST_EMAIL_ADDRESSES is set by CDK only when getEnvironment() !== 'prod'.
 *      With no env var there is no allowlist and no path here at all, and
 *      test/infra pins its absence from the production template.
 *   2. The address must ALSO match the hard-coded fictional-domain expression
 *      below, checked regardless of the env var, so even a misconfigured or
 *      compromised allowlist can never divert a real parent's code.
 *
 * `.invalid` is reserved by RFC 2606 and can never be delegated, so these
 * addresses can never reach a real mailbox, exactly like +1 555 555-01XX can
 * never reach a real handset.
 */
const FICTIONAL_TEST_EMAIL = /^e2e-[a-z0-9-]{1,40}@a-iep\.invalid$/;

function isTestAddress(address) {
    const allowlist = process.env.TEST_EMAIL_ADDRESSES;
    if (!allowlist) {
        return false;
    }
    const listed = allowlist.split(',').map((entry) => entry.trim()).includes(address);
    return listed && FICTIONAL_TEST_EMAIL.test(address);
}

/** The domain part, for logs. The local part never reaches CloudWatch. */
function addressDomain(address) {
    const at = String(address || '').lastIndexOf('@');
    return at > 0 ? address.slice(at + 1).toLowerCase() : 'unknown';
}

/**
 * The stable key a counter is kept under. Hashed, because a raw phone number
 * or email address is personal data we have no reason to store, and because
 * the same hash has to be computable from the destination alone whether or not
 * an account exists there -- that is what makes the lockout message safe to
 * show to a stranger.
 */
function destinationKey(destination) {
    return crypto.createHash('sha256').update(String(destination || '')).digest('hex');
}

/**
 * Classify and vet one destination.
 *
 * Returns `{ ok: true, channel, value }` where `value` is the normalized form
 * that becomes the Cognito Username, or `{ ok: false, code, detail }` where
 * `code` is one of the contract's error codes and `detail` is safe to log.
 *
 * Normalization is minimal on purpose: an email is trimmed and lowercased
 * (Cognito's own alias handling is case-insensitive, and a parent who typed a
 * capital must reach the same account), a phone number is trimmed and nothing
 * else. Plus-addressing is NOT stripped -- `a+b@x.com` is a different mailbox
 * from `a@x.com` and pretending otherwise would merge two accounts.
 */
function classifyDestination(raw) {
    const trimmed = String(raw == null ? '' : raw).trim();
    if (!trimmed) {
        return { ok: false, code: 'invalid_request', detail: 'empty' };
    }
    // Length bound before any expression runs: these are anchored but there is
    // no reason to hand a regex engine an unbounded string from the internet.
    if (trimmed.length > 254) {
        return { ok: false, code: 'invalid_destination', detail: 'too-long' };
    }

    // A leading '+' means they meant a phone number. Deciding that first means
    // a mistyped number is told it is a bad NUMBER rather than a bad email.
    if (trimmed.startsWith('+') || /^[\d\s()+-]+$/.test(trimmed)) {
        return classifyPhone(trimmed);
    }
    return classifyEmail(trimmed.toLowerCase());
}

function classifyPhone(value) {
    if (!E164.test(value)) {
        return { ok: false, code: 'invalid_destination', detail: 'bad-phone-format' };
    }
    const configured = (process.env.AUTH_ALLOWED_COUNTRY_CODES || '')
        .split(',').map((p) => p.trim()).filter(Boolean);
    const allowed = configured.length > 0 ? configured : DEFAULT_ALLOWED_PREFIXES;
    if (!allowed.some((prefix) => value.startsWith(prefix))) {
        // Only the dialling prefix is recorded; sanitize.js discipline applies
        // to the rest of the number.
        return {
            ok: false,
            code: 'unsupported_destination',
            detail: `prefix=${value.slice(0, 4)}`,
        };
    }
    return { ok: true, channel: 'sms', value };
}

function classifyEmail(value) {
    if (!EMAIL.test(value)) {
        return { ok: false, code: 'invalid_destination', detail: 'bad-email-format' };
    }
    const domain = addressDomain(value);

    // The staging test allowlist is checked before the reserved-TLD refusal,
    // and only ever passes when BOTH locks hold.
    if (isTestAddress(value)) {
        return { ok: true, channel: 'email', value };
    }

    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    if (RESERVED_TLDS.includes(tld)) {
        return { ok: false, code: 'unsupported_destination', detail: `reserved-tld=${tld}` };
    }
    if (DISPOSABLE_DOMAINS.includes(domain)) {
        return { ok: false, code: 'unsupported_destination', detail: `disposable=${domain}` };
    }
    return { ok: true, channel: 'email', value };
}

module.exports = {
    DISPOSABLE_DOMAINS,
    RESERVED_TLDS,
    FICTIONAL_TEST_EMAIL,
    addressDomain,
    classifyDestination,
    destinationKey,
    isTestAddress,
};
