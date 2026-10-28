/**
 * The well-known files built at synth (lib/user-interface/site-files.ts).
 *
 * Before these existed the SPA fallback answered /robots.txt with index.html,
 * so the pins that matter are the ones a wrong environment would get wrong:
 * production must be crawlable and point at its sitemap, staging must ask to
 * be left alone, and security.txt must stay inside RFC 9116's one-year window.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  PUBLIC_PATHS,
  buildLlmsTxt,
  buildRobotsTxt,
  buildSecurityTxt,
  buildSitemapXml,
} from '../../lib/user-interface/site-files';

const PROD = { host: 'a-iep.org', isProduction: true };
const STAGING = { host: 'dev.a-iep.org', isProduction: false };
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('robots.txt', () => {
  test('production is crawlable and names its sitemap', () => {
    const robots = buildRobotsTxt(PROD);
    expect(robots).toContain('User-agent: *');
    expect(robots).not.toMatch(/^Disallow: \/$/m);
    expect(robots).toContain('Sitemap: https://a-iep.org/sitemap.xml');
  });

  test('staging disallows everything and names no sitemap', () => {
    const robots = buildRobotsTxt(STAGING);
    expect(robots).toMatch(/^Disallow: \/$/m);
    expect(robots).not.toContain('Sitemap:');
  });
});

describe('sitemap.xml', () => {
  test('lists every public page on the given host, and nothing else', () => {
    const sitemap = buildSitemapXml(PROD);
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PUBLIC_PATHS.map((p) => `https://a-iep.org${p}`));
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  test('every listed path is a real public route', () => {
    // Guards against a sitemap that drifts from the router and sends a
    // crawler to the SPA fallback.
    const routes = fs.readFileSync(
      path.join(__dirname, '../../lib/user-interface/app/src/components/AppRoutes.tsx'),
      'utf8',
    );
    for (const p of PUBLIC_PATHS) {
      expect(routes).toContain(`path="${p}"`);
    }
  });
});

describe('security.txt', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const txt = buildSecurityTxt({ ...PROD, now });
  const field = (name: string) => txt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];

  test('has the two fields RFC 9116 requires', () => {
    expect(field('Contact')).toBe('https://github.com/The-Burnes-Center/a-iep/security/advisories/new');
    expect(field('Expires')).toBeDefined();
  });

  test('expires in the future but less than a year out', () => {
    const expires = Date.parse(field('Expires')!);
    expect(expires).toBeGreaterThan(now.getTime());
    expect(expires - now.getTime()).toBeLessThan(ONE_YEAR_MS);
  });

  test('is canonical on its own host and links the policy', () => {
    expect(field('Canonical')).toBe('https://a-iep.org/.well-known/security.txt');
    expect(field('Policy')).toMatch(/SECURITY\.md$/);
  });

  test('the linked policy exists in the repo', () => {
    expect(fs.existsSync(path.join(__dirname, '../../SECURITY.md'))).toBe(true);
  });
});

describe('llms.txt', () => {
  const prod = buildLlmsTxt(PROD);
  const staging = buildLlmsTxt(STAGING);
  const sections = (txt: string) => [...txt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

  test('follows the llmstxt.org shape: one H1, then a blockquote summary', () => {
    const lines = prod.split('\n');
    expect(lines[0]).toBe('# A-IEP');
    expect(prod.match(/^# /gm)).toHaveLength(1);
    expect(lines.find((l) => l.trim() !== '' && !l.startsWith('# '))).toMatch(/^> .{100,}/);
  });

  test('says when to use the tool, and when not to', () => {
    expect(sections(prod)).toEqual(['When to use A-IEP', 'When not to use A-IEP', 'Pages', 'Optional']);
    // The line that keeps an assistant from acting for the parent.
    expect(prod).toMatch(/Do not upload a document or create an account on a parent's behalf/);
  });

  test('links every public page on its own host, in the words the page uses', () => {
    const en = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../lib/user-interface/app/src/translations/en.json'), 'utf8'));
    const links = [...prod.matchAll(/^- \[([^\]]+)\]\((https:\/\/a-iep\.org[^)]*)\): (.+)$/gm)];
    const pageLinks = links.map((m) => m[2]).filter((u) => !u.endsWith('.xml'));
    expect(pageLinks).toEqual(PUBLIC_PATHS.map((p) => `https://a-iep.org${p}`));
    expect(links[0][1]).toBe(en['meta.home.title']);
    expect(links[0][3]).toBe(en['meta.home.description']);
    // No raw dictionary key leaked through a missing translation.
    expect(prod).not.toMatch(/meta\.[a-z]+\./);
  });

  test('staging says it is staging and points at its own host', () => {
    expect(staging).toContain('This is the staging copy');
    expect(staging).toContain('(https://dev.a-iep.org/faqs)');
    expect(prod).not.toContain('staging');
  });
});
