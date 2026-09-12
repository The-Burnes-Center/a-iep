/**
 * What A-IEP actually sends a parent, rendered, in all five languages.
 *
 * messages.test.js covers the plumbing: key parity, placeholder survival and
 * how a language is resolved. This file covers the thing that plumbing
 * delivers, because every defect these assertions exist for is invisible in a
 * template and only appears once the placeholders are filled in.
 *
 * Three of them have a cost attached:
 *
 *  - **Segments.** A carrier bills per segment. One non-GSM-7 character drops
 *    the budget from 160 characters to 70, and Spanish crosses that line on
 *    the `ó` in "código". Nothing errors when a message needs a second
 *    segment and the handset reassembles it, so the bill is the only other
 *    signal there is.
 *  - **The code, exactly once.** Twice is a second thing to get wrong; zero
 *    times is a parent who cannot sign in, which is what a `replace` rather
 *    than a `replaceAll` produces the moment a template names a placeholder
 *    twice.
 *  - **Nothing but the code.** These strings leave our systems. A child's
 *    name or a document title in one of them is a disclosure, so the bodies
 *    are pinned to their own copy plus a code and a number.
 */
const {
    getMessages,
    SUPPORTED_LANGUAGES,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');
const {
    buildOtpEmailHtml,
    buildOtpEmailText,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/email-template');
const { smsSegments, nonGsmCharacters } = require('./sms-segments');

const CODE = '123456';
const MINUTES = 5;

/** Fill every placeholder the way the senders do: replaceAll, never replace. */
const render = (template) => template
    .replaceAll('{code}', CODE)
    .replaceAll('{####}', CODE)
    .replaceAll('{minutes}', String(MINUTES));

const SMS_KEYS = ['otpLoginSms', 'verificationSms', 'authenticationSms'];

/** The three emails, each as (subject, html, optional plain-text twin). */
const EMAILS = [
    { name: 'login code', subject: 'otpLoginEmailSubject', html: 'otpLoginEmailHtml', text: 'otpLoginEmailText' },
    { name: 'sign-up verification', subject: 'signUpEmailSubject', html: 'signUpEmailBody' },
    { name: 'password reset', subject: 'forgotPasswordEmailSubject', html: 'forgotPasswordEmailBody' },
];

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// ── The segment budget ──────────────────────────────────────────────────

describe('every text fits in one segment, in every language', () => {
    test.each(
        SUPPORTED_LANGUAGES.flatMap((lang) => SMS_KEYS.map((key) => [lang, key])),
    )('%s %s', (lang, key) => {
        const message = render(getMessages(lang)[key]);
        const { segments, encoding, units } = smsSegments(message);

        // The failure message has to name the cost, because the reader's next
        // question is always "by how much".
        expect({ lang, key, encoding, units, segments })
            .toEqual({ lang, key, encoding, units, segments: 1 });
    });

    test('the non-Latin languages really are being measured as UCS-2', () => {
        // Guards the guard. If a future edit replaced the encoding detection
        // with something that always answered GSM-7, every assertion above
        // would still pass on a 150-character Chinese message that actually
        // costs three segments.
        for (const lang of ['es', 'zh', 'vi', 'ar']) {
            const message = render(getMessages(lang).otpLoginSms);
            expect(smsSegments(message).encoding).toBe('UCS-2');
            expect(nonGsmCharacters(message).length).toBeGreaterThan(0);
        }
        expect(smsSegments(render(getMessages('en').otpLoginSms)).encoding).toBe('GSM-7');
    });

    test('Spanish is one accent away from costing double', () => {
        // Not decoration: this is the whole reason the budget test exists, and
        // it documents WHY the Spanish copy is terser than the English.
        expect(nonGsmCharacters('codigo')).toEqual([]);
        expect(nonGsmCharacters('código')).toEqual(['ó']);
        expect(smsSegments('a'.repeat(80)).segments).toBe(1);
        expect(smsSegments(`${'a'.repeat(79)}ó`).segments).toBe(2);
    });
});

describe('the segment counter can fail', () => {
    // A budget assertion is worthless if the counter says 1 for everything.
    test.each([
        ['160 GSM-7 characters', 'a'.repeat(160), 'GSM-7', 1],
        ['161 GSM-7 characters', 'a'.repeat(161), 'GSM-7', 2],
        ['70 UCS-2 characters', '登'.repeat(70), 'UCS-2', 1],
        ['71 UCS-2 characters', '登'.repeat(71), 'UCS-2', 2],
        ['an extension-table character costs two septets', `${'a'.repeat(159)}€`, 'GSM-7', 2],
    ])('%s', (_label, text, encoding, segments) => {
        expect(smsSegments(text)).toMatchObject({ encoding, segments });
    });
});

// ── The code, and nothing else ──────────────────────────────────────────

describe('the code appears exactly once, everywhere', () => {
    test.each(
        SUPPORTED_LANGUAGES.flatMap((lang) => SMS_KEYS.map((key) => [lang, key])),
    )('%s %s (sms)', (lang, key) => {
        expect(occurrences(render(getMessages(lang)[key]), CODE)).toBe(1);
    });

    test.each(
        SUPPORTED_LANGUAGES.flatMap((lang) => EMAILS.map((email) => [lang, email.name, email])),
    )('%s %s (email)', (lang, _name, email) => {
        const messages = getMessages(lang);
        expect(occurrences(render(messages[email.html]), CODE)).toBe(1);
        if (email.text) {
            expect(occurrences(render(messages[email.text]), CODE)).toBe(1);
        }
    });
});

describe('no placeholder survives rendering', () => {
    // The bug this catches: a template naming {minutes} twice, filled with
    // `replace`, texting a parent the literal string "{minutes}".
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        const messages = getMessages(lang);
        for (const [key, value] of Object.entries(messages)) {
            expect({ key, leftover: render(value).match(/\{[^}]*\}/g) })
                .toEqual({ key, leftover: null });
        }
    });
});

describe('every message says who it is from', () => {
    // US carriers ignore the alphanumeric sender ID, so the recipient sees a
    // bare number. The body is the only place the sender is named.
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        const messages = getMessages(lang);
        for (const key of [...SMS_KEYS, ...EMAILS.map((e) => e.html), ...EMAILS.map((e) => e.subject)]) {
            expect(messages[key]).toContain('A-IEP');
        }
    });
});

describe('a duration is promised only where it is enforced', () => {
    // Five minutes is ours: create-auth-challenge issues it and
    // verify-auth-challenge enforces it. The Cognito-rendered messages expire
    // on Cognito's schedule, which this codebase does not configure, so they
    // must not quote a number at all.
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        const messages = getMessages(lang);
        expect(messages.otpLoginSms).toContain('{minutes}');
        expect(messages.otpLoginEmailHtml).toContain('{minutes}');
        expect(messages.otpLoginEmailText).toContain('{minutes}');

        for (const key of ['verificationSms', 'authenticationSms', 'signUpEmailBody', 'forgotPasswordEmailBody']) {
            expect({ key, quotesADuration: messages[key].includes('{minutes}') })
                .toEqual({ key, quotesADuration: false });
        }
    });
});

describe('nothing in a message is clickable', () => {
    // Carriers filter texts containing links, and a sign-in message that
    // teaches a parent to tap something is a phishing lesson.
    test.each(SUPPORTED_LANGUAGES)('%s sms', (lang) => {
        for (const key of SMS_KEYS) {
            expect(getMessages(lang)[key]).not.toMatch(/https?:|www\.|:\/\//);
        }
    });

    test.each(SUPPORTED_LANGUAGES)('%s email', (lang) => {
        for (const email of EMAILS) {
            const html = getMessages(lang)[email.html];
            expect(html).not.toMatch(/<a[\s>]/i);
            expect(html).not.toMatch(/href=/i);
        }
    });
});

// ── The email document ──────────────────────────────────────────────────

describe('the email carries no image, of any kind', () => {
    // Base64 does not render in Gmail on any surface or in Outlook on
    // Windows; cid: does not resolve in Gmail web or Yahoo web and can show
    // an attachment indicator, which is the shape a phishing message takes;
    // a remote image is blocked by default in Outlook desktop and leaves a
    // broken box in the middle of the one email a parent needs to read. The
    // wordmark is live text instead.
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        for (const email of EMAILS) {
            const html = getMessages(lang)[email.html];
            expect(html).not.toMatch(/<img[\s>]/i);
            expect(html).not.toMatch(/cid:/i);
            expect(html).not.toMatch(/data:image/i);
            expect(html).not.toMatch(/background-image/i);
            // The wordmark that replaces the image.
            expect(html).toContain('>A-IEP</td>');
        }
    });
});

describe('the email is a real document', () => {
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        for (const email of EMAILS) {
            const html = getMessages(lang)[email.html];

            expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
            expect(html).toContain('<meta charset="utf-8">');
            // Screen readers need the language to pick a voice, and Arabic
            // needs the direction to lay the page out at all.
            expect(html).toContain(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`);
            // Layout tables must not be announced as data grids.
            expect(html).not.toMatch(/<table(?![^>]*role="presentation")/i);
            // Gmail clips around 102KB; a clipped code email is a broken one.
            expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(20 * 1024);
        }
    });

    test.each(SUPPORTED_LANGUAGES)('%s keeps the digits left-to-right', (lang) => {
        // Without the explicit direction, a run of digits inside an Arabic
        // paragraph can be laid out in an order the parent cannot read back.
        for (const email of EMAILS) {
            expect(getMessages(lang)[email.html]).toMatch(/<span dir="ltr"/);
        }
    });

    test.each(SUPPORTED_LANGUAGES)('%s spaces the digits with CSS, not characters', (lang) => {
        // WCAG 2.2 SC 3.3.8 wants a code that can be copied rather than
        // transcribed. Inserted spaces land on the clipboard and in the
        // screen reader; letter-spacing does not. The unit must be px:
        // Outlook 2007-2019 on Windows renders em letter-spacing wrong.
        for (const email of EMAILS) {
            const html = getMessages(lang)[email.html];
            const rendered = render(html);
            expect(rendered).toContain(`>${CODE}</span>`);
            expect(html).toMatch(/letter-spacing:\d+px/);
            expect(html).not.toMatch(/letter-spacing:[\d.]+em/);
        }
    });
});

describe('the preview line is set, and the code stays out of it', () => {
    // The subject and the inbox preview are the most exposed parts of an
    // email: they render on a lock screen, survive a forward, and reach mail
    // server logs that the body does not. The code belongs in neither. The
    // preheader exists precisely so the client does not pull the code up into
    // the preview for us.
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        const messages = getMessages(lang);

        for (const email of EMAILS) {
            expect(render(messages[email.subject])).not.toContain(CODE);

            const preheader = render(messages[email.html]).match(/mso-hide:all;">([^<]*)</);
            expect(preheader).not.toBeNull();
            expect(preheader[1].trim().length).toBeGreaterThan(0);
            expect(preheader[1]).not.toContain(CODE);
        }
    });

    test.each(SUPPORTED_LANGUAGES)('%s pads the preview so body copy cannot leak in', (lang) => {
        // Without the filler the client tops the preview up with whatever
        // comes next, which is the code we just kept out of the subject.
        for (const email of EMAILS) {
            expect(getMessages(lang)[email.html]).toContain('&#847;&zwnj;&nbsp;&#8199;&shy;');
        }
    });
});

describe('the plain-text part is real', () => {
    // It is what a lock screen, a watch and a low-bandwidth client show, so
    // it has to carry the same code and the same expiry as the HTML. A
    // divergent or nominal text part is itself a spam signal.
    test.each(SUPPORTED_LANGUAGES)('%s', (lang) => {
        const messages = getMessages(lang);
        const text = render(messages.otpLoginEmailText);

        expect(text).toContain(CODE);
        expect(text).toContain(String(MINUTES));
        expect(text).not.toMatch(/[<>]/);
        expect(text.length).toBeGreaterThan(80);

        // Every sentence in the text part appears in the HTML twin.
        for (const line of text.split('\n').filter((l) => l.trim() && l.trim() !== CODE)) {
            expect(render(messages.otpLoginEmailHtml)).toContain(line.trim());
        }
    });
});

describe('no record detail can reach a message', () => {
    // These strings leave our systems, so the question is not "is the copy
    // safe" but "what could ever be substituted into it".
    //
    // Two things, and they are checked separately because they fail
    // differently. The templates are built once at module load, so the only
    // values a SENDER puts in are whatever the placeholders name; and the
    // builder escapes every field it is handed, so a future caller that
    // composes a heading or a subject out of data cannot reach the markup.
    test('the templates name nothing but a code and a duration', () => {
        // A template that grew a third placeholder -- {childName}, say --
        // fails here, and would fail the "no placeholder survives" test too.
        for (const lang of SUPPORTED_LANGUAGES) {
            for (const [key, value] of Object.entries(getMessages(lang))) {
                const placeholders = [...new Set(value.match(/\{[^}]*\}/g) || [])];
                const unexpected = placeholders.filter(
                    (p) => !['{code}', '{####}', '{minutes}'].includes(p),
                );
                expect({ lang, key, unexpected }).toEqual({ lang, key, unexpected: [] });
            }
        }
    });

    test('the builder escapes every field it is given', () => {
        const hostile = '<script>alert(1)</script>';
        const fields = ['title', 'preheader', 'heading', 'code', 'validity', 'ignore', 'footer'];

        for (const field of fields) {
            const html = buildOtpEmailHtml({
                lang: 'en',
                title: 'x',
                preheader: 'x',
                heading: 'x',
                code: 'x',
                validity: 'x',
                ignore: 'x',
                footer: 'x',
                [field]: hostile,
            });
            expect({ field, escaped: !html.includes('<script>') }).toEqual({ field, escaped: true });
            expect(html).toContain('&lt;script&gt;');
        }
    });

    test('the plain-text builder emits no markup at all', () => {
        const text = buildOtpEmailText({
            heading: 'Your login code',
            code: CODE,
            validity: 'It expires soon.',
            ignore: 'Ignore this if it was not you.',
            footer: 'A-IEP sent this message.',
        });
        expect(text).not.toMatch(/[<>]/);
        expect(text).toContain(CODE);
    });
});
