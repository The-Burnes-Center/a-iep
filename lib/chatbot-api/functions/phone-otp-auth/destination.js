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

// E.164. Anchored, so a number with anything appended is rejected rather
// than truncated. Necessary but not sufficient for a +1 number: see
// phoneNumberProblem below.
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The North American Numbering Plan, which is everything behind +1.
 *
 * E.164 alone says "a plus and eight to fifteen digits", and that let a +1
 * number with an area code starting 0 create a confirmed account and spend a
 * text on a number no carrier can route. A NANP number is exactly ten digits,
 * NXX-NXX-XXXX, where N is 2-9 in both the area code and the exchange, and an
 * N11 area code (211, 411, 911...) is a service code, never a region.
 *
 * The fictional 555-01XX block is deliberately NOT refused here. It is a valid
 * shape, and the smoke test targets 555-01XX numbers that are not on the E2E
 * allowlist, in production as well as staging.
 */
const NANP_COUNTRY_CODE = '+1';
const NANP_NATIONAL_DIGITS = 10;
const NANP_LEADING_DIGIT = /^[2-9]$/;
const NANP_SERVICE_CODE = /^[2-9]11$/;

/**
 * Area codes behind +1 that are not in the United States: Canada (including
 * its non-geographic codes) and the Caribbean and Atlantic countries that
 * share the plan. A-IEP serves US families, so a code is only sent to a US
 * number. Canada is refused along with the rest: IEPs here are US special
 * education documents, every other sentence the service shows says "United
 * States phone numbers", and email sign-in stays open to anyone.
 *
 * US territories stay allowed and are deliberately absent: Puerto Rico (787,
 * 939), the US Virgin Islands (340), Guam (671), the Northern Mariana Islands
 * (670) and American Samoa (684).
 *
 * A list of what is refused rather than of what is allowed, so a new US area
 * code works the day it opens. Mirrored in the frontend's us-phone.ts.
 */
const NANP_OUTSIDE_US = new Set([
    // Canada
    '204', '226', '236', '249', '250', '257', '263', '273', '289', '306', '343',
    '354', '365', '367', '368', '382', '403', '416', '418', '428', '431', '437',
    '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584',
    '587', '600', '604', '613', '622', '633', '639', '647', '672', '683', '705',
    '709', '742', '753', '778', '780', '782', '807', '819', '825', '867', '873',
    '879', '902', '905', '942',
    // The Caribbean and Bermuda
    '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664',
    '721', '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);
const OUTSIDE_US = 'nanp-outside-us';

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

/**
 * Why a phone number can never receive a text, or null if it can.
 *
 * The one definition every entry point shares: /auth/start, /auth/signup, the
 * PreSignUp trigger and the send path in create-auth-challenge. The result is
 * a reason marker that is safe to log. It names the rule that failed and never
 * quotes a digit of the number.
 *
 * A non-+1 number is only judged as E.164 here. Whether it is served at all is
 * the country-code allowlist's decision, which each caller makes after this.
 */
function phoneNumberProblem(value) {
    if (typeof value !== 'string' || !E164.test(value)) {
        return 'bad-phone-format';
    }
    if (!value.startsWith(NANP_COUNTRY_CODE)) {
        return null;
    }
    const national = value.slice(NANP_COUNTRY_CODE.length);
    if (national.length !== NANP_NATIONAL_DIGITS) {
        return 'nanp-length';
    }
    if (!NANP_LEADING_DIGIT.test(national[0])) {
        return 'nanp-area-code';
    }
    if (NANP_SERVICE_CODE.test(national.slice(0, 3))) {
        return 'nanp-service-code';
    }
    if (!NANP_LEADING_DIGIT.test(national[3])) {
        return 'nanp-exchange';
    }
    if (NANP_OUTSIDE_US.has(national.slice(0, 3))) {
        return OUTSIDE_US;
    }
    return null;
}

function classifyPhone(value) {
    const problem = phoneNumberProblem(value);
    if (problem === OUTSIDE_US) {
        // A real number, just not one this service texts.
        return { ok: false, code: 'unsupported_destination', detail: problem };
    }
    if (problem) {
        return { ok: false, code: 'invalid_destination', detail: problem };
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
    NANP_OUTSIDE_US,
    OUTSIDE_US,
    addressDomain,
    classifyDestination,
    destinationKey,
    isTestAddress,
    // The one definition of a phone number this service can text. Exported so
    // every entry point judges a destination by the same rule /auth/start
    // vetted it with: two expressions that mean "a real number" drift, and the
    // looser of the two decides what reaches the carrier.
    phoneNumberProblem,
};
