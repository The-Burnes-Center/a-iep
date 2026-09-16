/**
 * The two copies of the key derivation must agree, exactly.
 *
 * ses-suppression/suppression-key.js and phone-otp-auth/email-suppression.js
 * hold the same three functions because they are zipped into different lambda
 * assets and neither can require the other. Nothing at runtime notices if
 * they drift: the bounce handler would record an address under one key and
 * the send-side check would look under another, every write would succeed,
 * every read would come back empty, and the do-not-email list would simply
 * stop working. Silently, and only visibly much later as a suspension.
 *
 * suppression-key.js's own docblock names this file. This is that test.
 */
const write = require('../../../lib/chatbot-api/functions/ses-suppression/suppression-key');
const read = require('../../../lib/chatbot-api/functions/phone-otp-auth/email-suppression');

// Real shapes plus the ones normalization is supposed to collapse, and the
// ones it is deliberately NOT supposed to collapse.
const ADDRESSES = [
    'parent@example.com',
    'PARENT@EXAMPLE.COM',
    '  parent@example.com  ',
    '\tParent@Example.Com\n',
    'parent+iep@example.com',
    'parent+IEP@example.com',
    'first.last@sub.domain.example.org',
    "o'brien@example.co.uk",
    'parent@例え.jp',
    '',
    '   ',
    null,
    undefined,
];

describe('the key derivation is identical on both sides', () => {
    test.each(ADDRESSES.map((a) => [JSON.stringify(a), a]))('addressKey(%s)', (_label, address) => {
        expect(read.addressKey(address)).toEqual(write.addressKey(address));
    });

    test.each(ADDRESSES.map((a) => [JSON.stringify(a), a]))('normalizeAddress(%s)', (_label, address) => {
        expect(read.normalizeAddress(address)).toEqual(write.normalizeAddress(address));
    });

    test.each(ADDRESSES.map((a) => [JSON.stringify(a), a]))('addressDomain(%s)', (_label, address) => {
        expect(read.addressDomain(address)).toEqual(write.addressDomain(address));
    });
});

describe('what normalization does and does not collapse', () => {
    // Case and whitespace collapse: SES reports the address the sending
    // application handed it, and a parent typing PARENT@ at sign-in must hit
    // the row a bounce for parent@ wrote.
    test('case and surrounding whitespace are the same address', () => {
        const key = write.addressKey('parent@example.com');
        expect(write.addressKey('  PARENT@Example.COM \n')).toBe(key);
        expect(read.addressKey('  PARENT@Example.COM \n')).toBe(key);
    });

    // Plus-addressing does NOT collapse, deliberately. Only some providers
    // treat a+b@ and a@ as one mailbox, and SES tells us the exact address it
    // tried to deliver to. Suppressing the wrong one locks out a real parent.
    test('plus-addressing is a different address on both sides', () => {
        expect(write.addressKey('parent+iep@example.com'))
            .not.toBe(write.addressKey('parent@example.com'));
        expect(read.addressKey('parent+iep@example.com'))
            .not.toBe(read.addressKey('parent@example.com'));
    });

    test('an empty address has no key, on both sides', () => {
        expect(write.addressKey('   ')).toBeNull();
        expect(read.addressKey('   ')).toBeNull();
    });
});

describe('the key never contains the address', () => {
    // The list is parents' email addresses in an AWS account shared with two
    // other projects, and every question the send path asks is "is THIS one
    // on the list", which a hash answers just as well.
    test('a key is a sha256 hex digest and nothing else', () => {
        const key = write.addressKey('parent@example.com');
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).not.toContain('parent');
        expect(key).not.toContain('example');
    });

    test('the domain is recoverable for logs, the local part is not', () => {
        expect(write.addressDomain('parent@example.com')).toBe('example.com');
        expect(write.addressDomain('not-an-address')).toBe('unknown');
        expect(write.addressDomain('@leading')).toBe('unknown');
    });
});
