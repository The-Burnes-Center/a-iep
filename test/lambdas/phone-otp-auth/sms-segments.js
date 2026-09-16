/**
 * How many SMS segments a message costs, and in which encoding.
 *
 * Not a *.test.js file on purpose: jest's `lambdas` project matches
 * `**\/*.test.js`, so this is a helper the suites require, not a suite.
 *
 * Why this exists at all. A carrier bills per segment, not per message, and
 * the segment size depends on the alphabet: a message made entirely of
 * GSM 03.38 characters fits 160 of them, and a message containing even ONE
 * character outside that alphabet is re-encoded as UCS-2 and fits 70. Every
 * language A-IEP sends in except English is over that line, so the login text
 * to a Spanish-speaking parent can silently cost several times what the
 * English one costs, for copy that reads the same length.
 *
 * The failure is silent, which is why it needs a test and not a comment:
 * nothing errors when a message spills into a second segment, and the handset
 * reassembles it, so nobody notices until the bill.
 *
 * Sources for the numbers below: GSM 03.38 (3GPP TS 23.038) for the default
 * alphabet and its escape-coded extension; TS 23.040 for the 6-byte
 * concatenation header that takes a multipart GSM-7 segment from 160 septets
 * to 153 and a multipart UCS-2 segment from 70 characters to 67.
 */

/**
 * The GSM 03.38 default alphabet. One septet each.
 *
 * Written out rather than computed so that it is reviewable: the question a
 * reader actually has is "is e-acute in here, and is o-acute not", and a table
 * answers that and a codepoint range does not.
 */
const GSM_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/**
 * The GSM 03.38 extension table. TWO septets each: the character is sent as
 * an escape followed by the code, so a message full of them fits half as much.
 */
const GSM_EXTENDED = '^{}\\[~]|€\f';

/** Septets in a single-part GSM-7 message, and in each part of a multipart. */
const GSM7_SINGLE = 160;
const GSM7_CONCATENATED = 153;

/** Characters in a single-part UCS-2 message, and in each part of a multipart. */
const UCS2_SINGLE = 70;
const UCS2_CONCATENATED = 67;

/**
 * The characters in `text` that force the whole message to UCS-2.
 *
 * Returned rather than just counted because the useful half of a failure is
 * *which* character did it. A Spanish message costs double for one `ó`, and a
 * test that says "expected 1, got 2" sends the reader hunting.
 */
function nonGsmCharacters(text) {
    const offenders = [...text].filter(
        (char) => !GSM_BASIC.includes(char) && !GSM_EXTENDED.includes(char),
    );
    return [...new Set(offenders)];
}

/**
 * Segment count and encoding for a rendered message.
 *
 * `units` is septets for GSM-7 and UTF-16 code units for UCS-2, which is what
 * the air interface actually counts. An astral character (an emoji) is two
 * UTF-16 code units and is charged as two, so it is counted as two here.
 */
function smsSegments(text) {
    const nonGsm = nonGsmCharacters(text);

    if (nonGsm.length === 0) {
        let septets = 0;
        for (const char of text) {
            septets += GSM_EXTENDED.includes(char) ? 2 : 1;
        }
        return {
            encoding: 'GSM-7',
            units: septets,
            segments: septets <= GSM7_SINGLE ? 1 : Math.ceil(septets / GSM7_CONCATENATED),
            nonGsm,
        };
    }

    let codeUnits = 0;
    for (const char of text) {
        codeUnits += char.codePointAt(0) > 0xffff ? 2 : 1;
    }
    return {
        encoding: 'UCS-2',
        units: codeUnits,
        segments: codeUnits <= UCS2_SINGLE ? 1 : Math.ceil(codeUnits / UCS2_CONCATENATED),
        nonGsm,
    };
}

module.exports = {
    GSM_BASIC,
    GSM_EXTENDED,
    GSM7_SINGLE,
    GSM7_CONCATENATED,
    UCS2_SINGLE,
    UCS2_CONCATENATED,
    nonGsmCharacters,
    smsSegments,
};
