/**
 * pdf-generator handler: the request contract (400 / 413 / 500 bodies), the
 * rendering path (setContent, never a data: navigation) and the request guard
 * that keeps the rendered page from reaching internal hosts.
 *
 * Chromium cannot run under jest, so puppeteer-core and @sparticuz/chromium
 * are mocked virtually, the same way content-safety.test.js does. The page
 * records what the handler asked it to do.
 */
const mockPage = {
    setRequestInterception: jest.fn(async () => {}),
    on: jest.fn(),
    setContent: jest.fn(async () => {}),
    goto: jest.fn(async () => {
        throw new Error('goto must not be used: the document is rendered with setContent');
    }),
    evaluateHandle: jest.fn(async () => {}),
    waitForTimeout: jest.fn(async () => {}),
    pdf: jest.fn(async () => Buffer.from('%PDF-1.4 fake')),
};
const mockBrowser = {
    newPage: jest.fn(async () => mockPage),
    close: jest.fn(async () => {}),
};
const mockLaunch = jest.fn(async () => mockBrowser);

jest.mock('puppeteer-core', () => ({ launch: (...args) => mockLaunch(...args) }), { virtual: true });
jest.mock('@sparticuz/chromium', () => ({
    args: [],
    defaultViewport: {},
    headless: true,
    executablePath: async () => '/fake/chromium',
    setGraphicsMode: true,
}), { virtual: true });

const {
    handler,
    MAX_BODY_BYTES,
} = require('../../../lib/chatbot-api/functions/pdf-generator/index');

const sampleDocument = {
    summaries: { en: 'A **warm** summary.' },
    sections: { en: [{ name: 'Goals', content: 'Reach the goal.', pageNumbers: [1] }] },
};

const event = (body) => ({ body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('body cap', () => {
    test('the cap is 5 MiB, the size at which a real family\'s PDF still renders', () => {
        expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    });
});

describe('successful render', () => {
    test('renders with setContent, returns a no-store PDF, and keeps the 2 s font wait', async () => {
        const response = await handler(event({ document: sampleDocument, preferredLanguage: 'en', fileName: 'Summary' }));

        expect(response.statusCode).toBe(200);
        expect(response.isBase64Encoded).toBe(true);
        expect(response.headers['Content-Type']).toBe('application/pdf');
        expect(response.headers['Cache-Control']).toBe('no-store');
        expect(Buffer.from(response.body, 'base64').toString()).toBe('%PDF-1.4 fake');

        // The markup is handed to the page directly, not through a data: URL.
        expect(mockPage.setContent).toHaveBeenCalledTimes(1);
        expect(mockPage.setContent.mock.calls[0][0]).toContain('<html');
        expect(mockPage.goto).not.toHaveBeenCalled();

        // The 2 s wait is deliberately still there: rendering in ar/zh/vi has
        // not been checked by a person yet.
        expect(mockPage.waitForTimeout).toHaveBeenCalledWith(2000);
        expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });

    test('the request guard lets only data:, about: and the font CDN through', async () => {
        await handler(event({ document: sampleDocument }));

        const [, requestHandler] = mockPage.on.mock.calls.find(([name]) => name === 'request');
        const requestFor = (url) => {
            const request = { url: () => url, continue: jest.fn(), abort: jest.fn() };
            requestHandler(request);
            return request;
        };

        expect(requestFor('http://169.254.169.254/latest/meta-data').abort).toHaveBeenCalled();
        expect(requestFor('data:image/png;base64,AAAA').continue).toHaveBeenCalled();
        expect(requestFor('https://fonts.googleapis.com/css2?family=Inter').continue).toHaveBeenCalled();
    });
});

describe('request contract', () => {
    test.each([
        ['malformed JSON', '{not json'],
        ['an array', '[1, 2]'],
        ['a string', '"document"'],
        ['null', 'null'],
    ])('a body that is %s -> 400 with the reason logged, and no browser launched', async (_label, raw) => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const response = await handler(event(raw));

            expect(response.statusCode).toBe(400);
            expect(response.headers['Cache-Control']).toBe('no-store');
            expect(JSON.parse(response.body).error).toMatch(/JSON/);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(mockLaunch).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('an absent body -> 400, not a TypeError', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const response = await handler({});
            expect(response.statusCode).toBe(400);
        } finally {
            warn.mockRestore();
        }
    });

    test('a request without a document -> 400 with the reason logged', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const response = await handler(event({ preferredLanguage: 'en' }));
            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body)).toEqual({ error: 'IEP document is required' });
            expect(warn.mock.calls.flat().join(' ')).toMatch(/document is missing/);
            expect(mockLaunch).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('a body one byte over the cap -> 413 before any browser is launched', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const overhead = Buffer.byteLength(JSON.stringify({ document: { summaries: { en: '' } } }), 'utf8');
            const oversize = JSON.stringify({ document: { summaries: { en: 'x'.repeat(MAX_BODY_BYTES - overhead + 1) } } });

            const response = await handler(event(oversize));

            expect(response.statusCode).toBe(413);
            expect(JSON.parse(response.body)).toEqual({ error: 'The document is too large to render' });
            expect(mockLaunch).not.toHaveBeenCalled();
            expect(warn.mock.calls.flat().join(' ')).toMatch(/limit is/);
        } finally {
            warn.mockRestore();
        }
    });

    test('a body exactly at the cap is still rendered', async () => {
        const overhead = Buffer.byteLength(JSON.stringify({ document: { summaries: { en: '' } } }), 'utf8');
        const atLimit = JSON.stringify({ document: { summaries: { en: 'x'.repeat(MAX_BODY_BYTES - overhead) } } });
        expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_BODY_BYTES);

        const response = await handler(event(atLimit));

        expect(response.statusCode).toBe(200);
    });
});

describe('failures', () => {
    test('a render failure is a generic 500: the error name is logged, the message never returned', async () => {
        mockPage.pdf.mockRejectedValueOnce(
            Object.assign(new Error('Protocol error: SECRET_CHILD_NAME in page'), { name: 'ProtocolError' }));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await handler(event({ document: sampleDocument }));

            expect(response.statusCode).toBe(500);
            expect(JSON.parse(response.body)).toEqual({ error: 'Failed to generate PDF' });
            expect(response.body).not.toContain('SECRET_CHILD_NAME');
            const logged = error.mock.calls.flat().join(' ');
            expect(logged).toContain('ProtocolError');
            expect(logged).not.toContain('SECRET_CHILD_NAME');
            expect(mockBrowser.close).toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });

    test('a browser that will not launch is a generic 500', async () => {
        mockLaunch.mockRejectedValueOnce(new Error('spawn /fake/chromium ENOENT'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await handler(event({ document: sampleDocument }));

            expect(response.statusCode).toBe(500);
            expect(response.body).not.toContain('ENOENT');
            expect(JSON.parse(response.body)).toEqual({ error: 'Failed to generate PDF' });
        } finally {
            error.mockRestore();
        }
    });
});
