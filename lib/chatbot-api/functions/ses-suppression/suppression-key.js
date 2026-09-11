/**
 * How an email address becomes a row key on the suppression list.
 *
 * Deliberately tiny, and deliberately duplicated: the send-side check lives
 * in phone-otp-auth/email-suppression.js, which is zipped into a DIFFERENT
 * lambda asset and cannot require this file. The two copies must agree
 * exactly or the list silently stops working -- the write side would record
 * a complaint under one key and the read side would look under another, and
 * nothing would fail loudly. test/lambdas/ses-suppression/suppression-key.test.js
 * loads both modules and asserts they agree. Change one, change both.
 *
 * Normalization is trim and lowercase, and nothing else. It is tempting to
 * strip plus-addressing so a+spam@gmail.com and a@gmail.com share a row, but
 * only some providers treat those as one mailbox, and SES tells us the exact
 * address it tried to deliver to. The key has to be that address.
 *
 * The key is a hash rather than the address itself because this is a list of
 * parents' email addresses in an AWS account shared with other projects, and
 * every question the send path asks is "is THIS one on the list", which a
 * hash answers just as well.
 */

const crypto = require('crypto');

/** Trim and lowercase. See the note above on what is deliberately absent. */
function normalizeAddress(address) {
    return String(address || '').trim().toLowerCase();
}

/** The partition key for an address, or null if there is no address. */
function addressKey(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
        return null;
    }
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * The domain part, for logs.
 *
 * The local part never reaches CloudWatch (see sanitize.js for the same
 * discipline applied to Cognito events), but the domain is what makes a log
 * readable during an incident: "every bounce is one provider" and "every
 * bounce is a different invented domain" are different problems with
 * different responses, and neither is visible from a hash.
 */
function addressDomain(address) {
    const normalized = normalizeAddress(address);
    const at = normalized.lastIndexOf('@');
    return at > 0 ? normalized.slice(at + 1) : 'unknown';
}

module.exports = { normalizeAddress, addressKey, addressDomain };
