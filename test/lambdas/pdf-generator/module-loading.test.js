/**
 * pdf-generator must start on a Node that cannot require() an ES module.
 *
 * puppeteer-core 25 and @sparticuz/chromium 153 ship as ES modules only. The
 * handler is CommonJS, and loading them with require() passed every test here
 * (CI's Node 22.23 supports require(esm)) while the deployed nodejs22.x
 * runtime refused it at init with ERR_REQUIRE_ESM. Every PDF download on
 * staging failed from 2026-10-19 until this test.
 *
 * handler.test.js mocks both packages as CommonJS, which is exactly why it
 * could not see this. So this suite runs the real handler file in a child
 * Node process with require(esm) switched off, against two ESM-only stand-ins
 * for the packages. CI does not install the lambda's own node_modules, so the
 * stand-ins are generated here rather than read from it.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HANDLER = path.join(REPO_ROOT, 'lib/chatbot-api/functions/pdf-generator/index.js');

/** An ESM-only package, the shape puppeteer-core 25 and chromium 153 have. */
const writeEsmPackage = (root, name, source) => {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '0.0.0-test', type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
};

/** The two CommonJS dependencies are the real ones, linked from the root install. */
const linkRealPackage = (root, name) => {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules', name),
        path.join(root, 'node_modules', name), 'dir');
};

const PUPPETEER_STANDIN = `
const page = {
    setRequestInterception: async () => {},
    on: () => {},
    setContent: async () => {},
    evaluateHandle: async () => {},
    pdf: async () => new Uint8Array([37, 80, 68, 70]),
};
export default {
    launch: async () => ({ newPage: async () => page, close: async () => {} }),
};
`;

const CHROMIUM_STANDIN = `
export default { args: [], executablePath: async () => '/fake/chromium', setGraphicsMode: true };
`;

// Runs in the child: load the handler, render one document, print the result.
const RUNNER = `
const { handler } = require(process.argv[1]);
const realSetTimeout = setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0); // skip the 2 s font wait
handler({ body: JSON.stringify({ document: {
    summaries: { en: 'A **warm** summary.' },
    sections: { en: [{ name: 'Goals', content: 'Reach the goal.', pageNumbers: [1] }] },
} }) }).then((response) => {
    // Tagged: the handler logs to stdout too.
    process.stdout.write('\\nRESULT ' + JSON.stringify({ statusCode: response.statusCode, body: response.body }));
});
`;

let workdir;
let handlerCopy;

beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-generator-esm-'));
    writeEsmPackage(workdir, 'puppeteer-core', PUPPETEER_STANDIN);
    writeEsmPackage(workdir, '@sparticuz/chromium', CHROMIUM_STANDIN);
    linkRealPackage(workdir, 'marked');
    linkRealPackage(workdir, 'sanitize-html');
    // A copy beside the stand-ins, so its require()/import() resolve to them.
    handlerCopy = path.join(workdir, 'index.js');
    fs.copyFileSync(HANDLER, handlerCopy);
});

afterAll(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
});

const runWithoutRequireEsm = () => execFileSync(
    process.execPath,
    ['--no-experimental-require-module', '-e', RUNNER, handlerCopy],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
);

describe('loading puppeteer-core and chromium (ES modules only)', () => {
    test('the stand-ins really are unloadable by require() in this mode', () => {
        // Guards the test itself: if the flag stopped disabling require(esm),
        // the next test would pass against the broken handler.
        expect(() => execFileSync(
            process.execPath,
            ['--no-experimental-require-module', '-e', "require('puppeteer-core')"],
            { cwd: workdir, stdio: 'pipe' },
        )).toThrow(/ERR_REQUIRE_ESM|require\(\) of ES Module/);
    });

    test('the handler starts and renders a PDF where require(esm) is unavailable', () => {
        let output;
        try {
            output = runWithoutRequireEsm();
        } catch (error) {
            throw new Error(`the handler could not run without require(esm):\n${error.stderr || error.message}`);
        }
        const resultLine = output.split('\n').find((line) => line.startsWith('RESULT '));
        if (!resultLine) throw new Error(`the handler produced no result:\n${output}`);
        const response = JSON.parse(resultLine.slice('RESULT '.length));
        expect(response.statusCode).toBe(200);
        expect(Buffer.from(response.body, 'base64').toString('latin1')).toBe('%PDF');
    });
});
