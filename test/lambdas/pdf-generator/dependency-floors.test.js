/**
 * The pdf-generator lambda is bundled by `npm ci` against its OWN
 * package-lock.json (see the PDFGeneratorFunction bundling command in
 * functions.ts), so the root package.json `overrides` never reach it. That is
 * how basic-ftp 5.0.5 (critical) and a set of highs in puppeteer-core's
 * transitive tree shipped while the root lock looked patched.
 *
 * This pins every copy of each package in the shipped lock at or above the
 * first patched version. If a floor here needs to move down, the override in
 * pdf-generator/package.json is being weakened: say why in the same change.
 */
const fs = require('fs');
const path = require('path');

const PDF_GENERATOR_DIR = path.join(__dirname, '../../../lib/chatbot-api/functions/pdf-generator');
const lock = JSON.parse(fs.readFileSync(path.join(PDF_GENERATOR_DIR, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(PDF_GENERATOR_DIR, 'package.json'), 'utf8'));

const SECURITY_FLOORS = {
    'basic-ftp': '5.3.1',
    'tar-fs': '3.1.1',
    ws: '8.21.0',
    socks: '2.8.7',
    'ip-address': '10.3.1',
    nanoid: '3.3.18',
    postcss: '8.5.23',
    'follow-redirects': '1.16.0',
};

function parseVersion(version) {
    return version.split('-')[0].split('.').map(Number);
}

function isAtLeast(version, floor) {
    const actual = parseVersion(version);
    const minimum = parseVersion(floor);
    for (let i = 0; i < minimum.length; i += 1) {
        if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
    }
    return true;
}

function installedCopies(name) {
    return Object.entries(lock.packages)
        .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
        .map(([key, entry]) => ({ key, version: entry.version }));
}

describe('isAtLeast', () => {
    test.each([
        ['5.3.1', '5.3.1', true],
        ['5.10.0', '5.3.1', true],
        ['6.0.0', '5.3.1', true],
        ['5.0.5', '5.3.1', false],
        ['5.3.0', '5.3.1', false],
        ['4.9.9', '5.3.1', false],
    ])('%s >= %s is %s', (version, floor, expected) => {
        expect(isAtLeast(version, floor)).toBe(expected);
    });
});

describe('pdf-generator shipped lockfile', () => {
    test('uses lockfile v3, the format npm ci in the bundling image reads', () => {
        expect(lock.lockfileVersion).toBe(3);
    });

    test.each(Object.entries(SECURITY_FLOORS))('every copy of %s is >= %s', (name, floor) => {
        const copies = installedCopies(name);
        expect(copies.length).toBeGreaterThan(0);
        const belowFloor = copies.filter(({ version }) => !isAtLeast(version, floor));
        expect(belowFloor).toEqual([]);
    });

    test('the floors are enforced by overrides in the lambda package itself', () => {
        expect(Object.keys(manifest.overrides || {})).toEqual(
            expect.arrayContaining(Object.keys(SECURITY_FLOORS)),
        );
    });
});
