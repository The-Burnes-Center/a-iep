/**
 * Pins the font self-hosting: no Google Fonts origin in the page or the
 * stylesheet, every font file the stylesheet names exists on disk, and every
 * face is limited by a unicode-range. The range is what keeps the Arabic
 * faces off the wire for English visitors, so a face without one fails here.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath: string) => readFileSync(resolve(APP_ROOT, relativePath), 'utf8');
const GOOGLE_FONT_ORIGINS = /fonts\.(googleapis|gstatic)\.com/;
const FONT_STYLESHEET = 'src/styles/fonts.css';
const FONT_DIR = 'public';

const fontUrls = (css: string) =>
  [...css.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);
const fontFaces = (css: string) => css.match(/@font-face\s*{[^}]*}/g) ?? [];

describe('self-hosted Google Fonts', () => {
  test('index.html loads no font from Google', () => {
    expect(read('index.html')).not.toMatch(GOOGLE_FONT_ORIGINS);
  });

  test('the font stylesheet points only at files in public/fonts', () => {
    const css = read(FONT_STYLESHEET);
    const urls = fontUrls(css);

    expect(urls.length).toBe(fontFaces(css).length);
    expect(css).not.toMatch(GOOGLE_FONT_ORIGINS);
    for (const url of urls) {
      expect(url).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(resolve(APP_ROOT, FONT_DIR, url.slice(1)))).toBe(true);
    }
  });

  test('every @font-face uses font-display: swap and a unicode-range', () => {
    const faces = fontFaces(read(FONT_STYLESHEET));

    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toContain('font-display: swap');
      expect(face).toMatch(/unicode-range:\s*U\+/);
    }
  });
});
