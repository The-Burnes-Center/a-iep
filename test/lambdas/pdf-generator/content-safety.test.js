/**
 * The pdf-generator renders user-controlled IEP content in headless Chromium,
 * so processContent/escapeHtml/isAllowedFontRequest are a security boundary:
 * they must strip script/event-handler/network-triggering markup (HTML
 * injection -> SSRF) while keeping the markdown formatting the PDF styles.
 *
 * puppeteer-core and @sparticuz/chromium are deploy-time dependencies
 * (installed by the CDK bundling container), so they are mocked virtually;
 * marked and sanitize-html are real (root devDependencies, version-matched
 * to pdf-generator/package.json).
 */
jest.mock('puppeteer-core', () => ({}), { virtual: true });
jest.mock('@sparticuz/chromium', () => ({}), { virtual: true });

const {
    escapeHtml,
    processContent,
    isAllowedFontRequest,
} = require('../../../lib/chatbot-api/functions/pdf-generator/index');

describe('escapeHtml', () => {
    test('escapes every HTML metacharacter', () => {
        expect(escapeHtml(`<img src=x onerror="pwn('&')">`))
            .toBe('&lt;img src=x onerror=&quot;pwn(&#39;&amp;&#39;)&quot;&gt;');
    });

    test('null and undefined become empty strings', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('processContent', () => {
    test('renders markdown structure the PDF template styles', () => {
        const html = processContent('# Goals\n\n**bold** and *italic*\n\n- item one\n- item two');
        expect(html).toContain('<h1>Goals</h1>');
        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<em>italic</em>');
        expect(html).toContain('<li>item one</li>');
    });

    test('renders GFM tables', () => {
        const html = processContent('| Service | Minutes |\n| --- | --- |\n| Speech | 30 |');
        expect(html).toContain('<table>');
        expect(html).toContain('<th>Service</th>');
        expect(html).toContain('<td>30</td>');
    });

    test('strips scripts and event handlers from raw HTML in the content', () => {
        const html = processContent('Hello <script>fetch("https://evil.example")</script><b onclick="pwn()">there</b>');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('fetch(');
        expect(html).not.toContain('onclick');
        expect(html).toContain('<b>there</b>');
    });

    test('strips network-triggering elements and inline styles', () => {
        const html = processContent(
            '<img src="https://evil.example/x.png"><iframe src="https://evil.example"></iframe>'
            + '<div style="background:url(https://evil.example)">styled</div>');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<iframe');
        expect(html).not.toContain('style=');
        expect(html).toContain('styled');
    });

    test('blocks javascript: links but keeps safe ones', () => {
        const html = processContent('[safe](https://example.org) [evil](javascript:alert(1))');
        expect(html).toContain('href="https://example.org"');
        expect(html).not.toContain('javascript:');
    });

    test('empty content renders to an empty string', () => {
        expect(processContent('')).toBe('');
        expect(processContent(null)).toBe('');
    });
});

describe('isAllowedFontRequest', () => {
    test.each([
        ['https://fonts.googleapis.com/css2?family=Inter', true],
        ['https://fonts.gstatic.com/s/inter/v12/x.woff2', true],
        ['https://evil.example/steal', false],
        ['http://fonts.googleapis.com/css2', false], // https only
        ['https://fonts.googleapis.com.evil.example/css2', false],
        ['file:///etc/passwd', false],
        ['not a url', false],
    ])('%s -> %p', (url, allowed) => {
        expect(isAllowedFontRequest(url)).toBe(allowed);
    });
});
