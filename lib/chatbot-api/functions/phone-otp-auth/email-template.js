/**
 * The HTML shell every code email is poured into.
 *
 * One builder rather than five hand-written documents, because the five
 * languages have to stay structurally identical and a copy-paste of a 40-line
 * document into five dictionary entries guarantees they will not. The words
 * differ per language; the markup does not.
 *
 * Everything below is a deliberate choice, and the reasons are the kind that
 * get edited away by someone tidying up, so they are written down.
 *
 * **No images, of any kind.** The wordmark is live text in a table cell. An
 * image in this specific email is all cost and no benefit:
 *
 *   - Base64 data URIs do not render in Gmail on any surface (web, iOS,
 *     Android, mobile web) or in Outlook on Windows, which are the two places
 *     a fallback would have to work.
 *   - `cid:` attachments do not resolve in Gmail web or Yahoo web, and they
 *     can surface an attachment indicator. An unexpected attachment on a
 *     sign-in email is the exact shape a phishing message takes.
 *   - A remote image is blocked by default in Outlook desktop and behind many
 *     corporate gateways, and leaves a broken-image box in the middle of the
 *     one message a parent needs in order to get into their account.
 *   - It buys no anti-phishing value: anyone can hotlink the same file from
 *     the same URL. A recognisable sender domain and DMARC alignment are what
 *     authenticate this message.
 *
 * Live text also scales with the reader's font settings, survives image
 * blocking, and reads identically in the plain-text part.
 *
 * **No links.** Nothing to click is the point. A sign-in email that trains a
 * parent to click something is a phishing lesson, and link-free mail scores
 * better besides.
 *
 * **The code is plain, selectable, unbroken text.** WCAG 2.2 SC 3.3.8 wants a
 * code a reader can copy rather than transcribe, so it is never an image and
 * never split across cells. Spacing between the digits is CSS `letter-spacing`
 * and never inserted space characters: inserted characters land on the
 * clipboard and in the screen reader, which is the burden 3.3.8 exists to
 * remove. The unit is `px`, not `em`, because Outlook 2007-2019 on Windows
 * renders `em` letter-spacing smaller than specified.
 */

/**
 * Layout tables get `role="presentation"` so a screen reader reads the copy as
 * prose instead of announcing a grid.
 */
const TABLE_ATTRS = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

/** From the app's own palette: warm paper, near-black ink, the deep green. */
const PAPER = '#F5F3EE';
const CARD = '#FFFFFF';
const RULE = '#CBC6BC';
const INK = '#1E1E1E';
const BRAND = '#014620';
const QUIET = '#5C5A55';

const BODY_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Tabular faces first, so 0/O and 1/l cannot be confused in a code. */
const CODE_FONT = "'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";

/**
 * Invisible filler for the preview line.
 *
 * Without it the client tops the preheader up with whatever body copy comes
 * next, which here is the code itself: the thing we just moved out of the
 * subject line to keep it off lock screens and out of mail logs. The five
 * characters are U+034F, U+200C, U+00A0, U+2007 and U+00AD; the older
 * two-character `&zwnj;&nbsp;` form fails in Yahoo and iOS 16.4+.
 */
const PREVIEW_FILLER = '&#847;&zwnj;&nbsp;&#8199;&shy;'.repeat(12);

/**
 * `display:none` alone is not enough: it is partial in Outlook 2007-2019 on
 * Windows and unsupported in Gmail's mobile webmail, so the zero box and
 * `overflow:hidden` carry the load where it is ignored.
 */
const HIDDEN = 'display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;';

/** The five characters that would otherwise change the meaning of the markup. */
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build the HTML part of a code email.
 *
 * `code` is passed through as given, so callers may hand it a literal code or
 * a placeholder (`{code}`, or Cognito's `{####}`) and interpolate later. It is
 * escaped either way: this function must not be the place where a value
 * reaches the markup unescaped, whatever a future caller decides to pass.
 *
 * @param {object} content
 * @param {string} content.lang      BCP 47 tag for the <html lang> attribute.
 * @param {boolean} [content.isRtl]  Right-to-left script (Arabic).
 * @param {string} content.title     Document title; the subject line.
 * @param {string} content.preheader One line, shown in the inbox preview.
 * @param {string} content.heading   What the code is for.
 * @param {string} content.code      The code, or a placeholder for one.
 * @param {string} content.validity  How long it lasts, and not to share it.
 * @param {string} content.ignore    What to do if they did not ask for it.
 * @param {string} content.footer    Who sent it.
 */
function buildOtpEmailHtml({ lang, isRtl = false, title, preheader, heading, code, validity, ignore, footer }) {
    const dir = isRtl ? 'rtl' : 'ltr';
    const align = isRtl ? 'right' : 'left';
    const cell = `font-family:${BODY_FONT};font-size:16px;line-height:24px;color:${INK};text-align:${align};`;

    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAPER};">
<div style="${HIDDEN}">${escapeHtml(preheader)}</div>
<div style="${HIDDEN}">${PREVIEW_FILLER}</div>
<table ${TABLE_ATTRS} style="background-color:${PAPER};">
<tr><td align="center" style="padding:24px 12px;">
<table ${TABLE_ATTRS} style="max-width:480px;background-color:${CARD};border:1px solid ${RULE};border-radius:8px;">
<tr><td style="padding:24px 24px 0;font-family:${BODY_FONT};font-size:18px;font-weight:700;letter-spacing:1px;color:${BRAND};text-align:${align};">A-IEP</td></tr>
<tr><td style="padding:20px 24px 0;${cell}">${escapeHtml(heading)}</td></tr>
<tr><td style="padding:12px 24px 0;text-align:${align};"><span dir="ltr" style="font-family:${CODE_FONT};font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;color:${INK};">${escapeHtml(code)}</span></td></tr>
<tr><td style="padding:20px 24px 0;${cell}">${escapeHtml(validity)}</td></tr>
<tr><td style="padding:12px 24px 24px;${cell}">${escapeHtml(ignore)}</td></tr>
</table>
<table ${TABLE_ATTRS} style="max-width:480px;">
<tr><td style="padding:16px 24px 0;font-family:${BODY_FONT};font-size:12px;line-height:18px;color:${QUIET};text-align:${align};">${escapeHtml(footer)}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

/**
 * Build the plain-text part.
 *
 * Not an afterthought, and not "view this in a browser": this is what a lock
 * screen, a watch and a low-bandwidth client show, which is exactly where a
 * parent reads a code. It also has to carry the same code and the same expiry
 * as the HTML, because a text part that diverges from its HTML twin is itself
 * a spam signal, and a nominal one gets treated as no text part at all.
 */
function buildOtpEmailText({ heading, code, validity, ignore, footer }) {
    return `${heading}\n\n${code}\n\n${validity}\n\n${ignore}\n\n${footer}`;
}

module.exports = { buildOtpEmailHtml, buildOtpEmailText, escapeHtml };
