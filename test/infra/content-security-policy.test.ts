/**
 * The web app's Content-Security-Policy (lib/user-interface/content-security-policy.ts).
 *
 * The policy is report-only, so nothing a test asserts here can break a
 * parent's session today. These pins exist for the day it is enforced: each
 * one is a request the app really makes, or a protection that must not be
 * traded away to make a violation go quiet.
 */
import * as path from 'path';
import {
  buildContentSecurityPolicy,
  inlineScriptHashes,
} from '../../lib/user-interface/content-security-policy';

const INDEX_HTML = path.join(__dirname, '../../lib/user-interface/app/index.html');
const BASE = {
  apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
  region: 'us-east-1',
  inlineScriptHashes: ["'sha256-test'"],
};

/** Parse "a x y; b z" into { a: ['x','y'], b: ['z'] }. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]),
  );
}

const staging = directives(buildContentSecurityPolicy({ ...BASE, isProduction: false }));
const production = directives(buildContentSecurityPolicy({ ...BASE, isProduction: true }));

describe.each([['staging', staging], ['production', production]])('%s policy', (_label, policy) => {
  test('locks down the directives that stop injected code and framing', () => {
    expect(policy['default-src']).toEqual(["'self'"]);
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'self'"]);
    expect(policy['form-action']).toEqual(["'self'"]);
    expect(policy['frame-ancestors']).toEqual(["'self'"]);
  });

  test('never allows inline or eval script', () => {
    // Styles may be inline; scripts may not, beyond the hashed ones.
    expect(policy['script-src']).not.toContain("'unsafe-inline'");
    expect(policy['script-src']).not.toContain("'unsafe-eval'");
    expect(policy['script-src']).not.toContain('*');
    expect(policy['script-src']).toContain("'sha256-test'");
  });

  test('allows the origins the app depends on to sign in and work', () => {
    expect(policy['script-src']).toContain('https://challenges.cloudflare.com');
    expect(policy['frame-src']).toEqual(['https://challenges.cloudflare.com']);
    expect(policy['connect-src']).toEqual(expect.arrayContaining([
      BASE.apiUrl,
      'https://cognito-idp.us-east-1.amazonaws.com',
      'https://*.s3.us-east-1.amazonaws.com',
    ]));
    expect(policy['media-src']).toContain('https://*.s3.us-east-1.amazonaws.com');
    expect(policy['style-src']).toContain('https://use.typekit.net');
    expect(policy['font-src']).toContain('https://use.typekit.net');
  });
});

test('Google Analytics is allowed in production only', () => {
  expect(production['script-src']).toContain('https://*.googletagmanager.com');
  expect(production['connect-src']).toContain('https://*.google-analytics.com');
  expect(staging['script-src'].join(' ')).not.toMatch(/google/);
  expect(staging['connect-src'].join(' ')).not.toMatch(/google/);
});

test('hashes the inline script index.html really contains', () => {
  // The hash is computed from the file at synth. Pin that the file still has
  // exactly the one inline script, so a second one cannot be added unhashed
  // without this test noticing, and that the hash has the CSP shape.
  const hashes = inlineScriptHashes(INDEX_HTML);
  expect(hashes).toHaveLength(1);
  expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
});
