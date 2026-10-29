/**
 * The build-time prerender (page-html.ts, render-page.tsx). The pins that
 * matter: a reader without JavaScript gets the page's real text and its own
 * head, and a browser running the app gets exactly the shell it got before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { PUBLIC_PAGE_META } from '../common/page-meta';
import en from '../translations/en.json';
import { NOT_FOUND_FILE, NO_SCRIPT_NOTICE, buildPageHtml, prerenderedFile } from './page-html';
import * as edge from '../../../edge-routing';
import { buildPrerenderedFiles, renderPage } from './render-page';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const dictionary = en as Record<string, string>;
const MIN_TEXT = 500;

/** What a reader that does not run scripts gets as the page's text. */
function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const head = (html: string) => ({
  title: html.match(/<title>([^<]*)<\/title>/)?.[1],
  description: html.match(/<meta name="description" content="([^"]*)"/)?.[1],
  ogUrl: html.match(/<meta property="og:url" content="([^"]*)"/)?.[1],
  canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1],
});

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');

describe('renderPage', () => {
  test.each(Object.keys(PUBLIC_PAGE_META))('%s renders its real copy, with no raw keys', (p) => {
    const markup = renderPage(p);
    expect(visibleText(markup).length).toBeGreaterThan(MIN_TEXT);
    // t() with no English fallback renders the key itself, so a key in the
    // output is a missing or mistyped translation.
    const leaked = Object.keys(dictionary).filter((key) => markup.includes(`>${key}<`));
    expect(leaked).toEqual([]);
  });

  test('the home page has one h1, and it says what the tool is for', () => {
    const h1s = [...renderPage('/').matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
    expect(h1s).toHaveLength(1);
    expect(h1s[0][1]).toBe(dictionary['hero.title'].replace(/'/g, '&#x27;'));
  });

  test('is a signed-out visitor: the sign-in form, not the signed-in card', () => {
    const markup = renderPage('/');
    expect(markup).not.toContain('data-testid="hero-signed-in"');
  });
});

describe('buildPageHtml', () => {
  const html = buildPageHtml(
    TEMPLATE,
    { title: "Kid's page", description: 'A "quoted" <description>', canonicalUrl: 'https://a-iep.org/faqs' },
    '<main><h1>Hello</h1></main>',
  );

  test('gives the page its own title, description and canonical, escaped', () => {
    expect(head(html)).toEqual({
      title: 'Kid&#39;s page',
      description: 'A &quot;quoted&quot; &lt;description&gt;',
      ogUrl: 'https://a-iep.org/faqs',
      canonical: 'https://a-iep.org/faqs',
    });
    expect(html).toContain('<meta property="og:title" content="Kid&#39;s page" />');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  test('puts the markup in <noscript>, ahead of an untouched, empty root', () => {
    expect(html).toContain(`<noscript><p>${escape(NO_SCRIPT_NOTICE)}</p><main><h1>Hello</h1></main></noscript>`);
    expect(html).toContain('<div id="root"></div>');
    expect(html.indexOf('<noscript>')).toBeLessThan(html.indexOf('<div id="root">'));
  });

  test('changes nothing a browser running the app reads', () => {
    // Strip what buildPageHtml is allowed to change; the rest (every script,
    // stylesheet, preload and the JSON-LD) must be byte-for-byte the template.
    const strip = (s: string) => s
      .replace(/<noscript>[\s\S]*?<\/noscript>\n\s*/, '')
      .replace(/<title>[^<]*<\/title>/, '')
      .replace(/<meta (name="description"|property="og:(title|description|url)") content="[^"]*"\s*\/?>/g, '')
      .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, '')
      .replace(/\s+/g, ' ');
    expect(strip(html)).toBe(strip(TEMPLATE));
  });

  test('a page with no canonical drops the tags rather than pointing at home', () => {
    const notFound = buildPageHtml(TEMPLATE, { title: 'Gone', description: 'x', noindex: true }, '');
    expect(head(notFound).canonical).toBeUndefined();
    expect(head(notFound).ogUrl).toBeUndefined();
    expect(notFound).toContain('<meta name="robots" content="noindex" />');
  });

  test('fails the build when the template changes shape', () => {
    expect(() => buildPageHtml(TEMPLATE.replace(/<title>[^<]*<\/title>/, ''), { title: 'a', description: 'b' }, ''))
      .toThrow(/exactly one <title>/);
    expect(() => buildPageHtml(TEMPLATE.replace('<div id="root"></div>', '<div id="app"></div>'), { title: 'a', description: 'b' }, ''))
      .toThrow(/<div id="root">/);
  });
});

test('names each file exactly as the CloudFront Function asks for it', () => {
  for (const p of Object.keys(PUBLIC_PAGE_META)) {
    expect(prerenderedFile(p)).toBe(edge.prerenderedFile(p));
  }
  expect(NOT_FOUND_FILE).toBe(edge.NOT_FOUND_FILE);
});

describe('buildPrerenderedFiles', () => {
  const files = buildPrerenderedFiles(TEMPLATE);

  test('one file per public page, plus 404.html', () => {
    expect(files.map((f) => f.file)).toEqual([
      ...Object.keys(PUBLIC_PAGE_META).map(prerenderedFile),
      '404.html',
    ]);
  });

  test.each(Object.entries(PUBLIC_PAGE_META))('%s carries its own head', (p, keys) => {
    const html = files.find((f) => f.file === prerenderedFile(p))!.html;
    expect(head(html)).toEqual({
      title: escape(dictionary[keys.title]),
      description: escape(dictionary[keys.description]),
      ogUrl: `https://a-iep.org${p}`,
      canonical: `https://a-iep.org${p}`,
    });
    expect(html).not.toContain('name="robots"');
  });

  test('404.html says so, is not indexed, and is still the app for a browser', () => {
    const html = files.find((f) => f.file === '404.html')!.html;
    expect(head(html).title).toBe('Page not found | A-IEP');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('<h1>Page not found</h1>');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
});

// The server render is the same React tree the browser builds, so it shows
// the attributes a browser gets before any image has loaded.
const PUBLIC_DIR = path.join(__dirname, '../../public');

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(src: string): { width: number; height: number } {
  const bytes = fs.readFileSync(path.join(PUBLIC_DIR, decodeURIComponent(src)));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const imgTags = (markup: string) => [...markup.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

describe('images and layout shift', () => {
  test('the home hero reserves its box and loads first', () => {
    // Unsized, it was 0px tall until the file arrived and then pushed the
    // page down by about 400px (layout shift 0.28 on a phone).
    const hero = imgTags(renderPage('/')).find((tag) => tag.includes('hero-section-image'));
    expect(hero).toBeDefined();
    const src = attr(hero!, 'src')!;
    expect({ width: Number(attr(hero!, 'width')), height: Number(attr(hero!, 'height')) }).toEqual(pngSize(src));
    expect(attr(hero!, 'loading')).toBeUndefined();
    expect(attr(hero!, 'fetchpriority')).toBe('high');
  });

  test.each(Object.keys(PUBLIC_PAGE_META))('%s: every sized PNG declares its own proportions', (p) => {
    // A width/height pair that disagrees with the file stretches the image.
    const sized = imgTags(renderPage(p)).filter((tag) => attr(tag, 'width') && attr(tag, 'src')?.endsWith('.png'));
    for (const tag of sized) {
      const file = pngSize(attr(tag, 'src')!);
      const ratio = Number(attr(tag, 'width')) / Number(attr(tag, 'height'));
      expect({ tag, ratio: ratio.toFixed(3) }).toEqual({ tag, ratio: (file.width / file.height).toFixed(3) });
    }
  });
});
