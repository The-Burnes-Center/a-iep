/**
 * Pins the title face (styles/display-type.css): Salford Sans in every
 * language but Vietnamese, which Salford has no letters for and so gets Fjalla
 * One. The face lives in one place: a stylesheet that names Fjalla One itself
 * puts it back in every language, which is how Salford went missing before.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(APP_ROOT, 'src');
const read = (path: string) => readFileSync(resolve(APP_ROOT, path), 'utf8');

const stylesheets = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return /\.(css|scss)$/.test(entry) ? [path] : [];
  });
const sheets = stylesheets(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

// Where a face may be named: its @font-face, the tokens, and the Arabic override.
const MAY_NAME_FACES = ['styles/fonts.css', 'styles/display-type.css', 'styles/rtl.css'];

const block = (css: string, selector: string) => {
  const match = css.match(new RegExp(`(^|\\n)${selector.replace(/[()]/g, '\\$&')}\\s*{([^}]*)}`));
  return match ? match[2] : '';
};
const token = (body: string, name: string) => body.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

describe('the title face follows the language', () => {
  const css = read('src/styles/display-type.css');

  test('Salford Sans first everywhere, with Fjalla One only as its fallback', () => {
    expect(token(block(css, ':root'), 'aiep-font-display')).toBe('"salford-sans-variable", "Fjalla One", sans-serif');
  });

  test('Vietnamese gets Fjalla One for the whole heading, never Salford', () => {
    const vi = block(css, ':lang(vi)');
    expect(token(vi, 'aiep-font-display')).toBe('"Fjalla One", sans-serif');
    expect(token(vi, 'aiep-font-display-adjust')).toBe('none');
    expect(token(vi, 'aiep-font-display-weight')).toBe('400');
  });

  test('Chinese headings are not resized for Salford', () => {
    expect(token(block(css, ':lang(zh)'), 'aiep-font-display-adjust')).toBe('none');
  });

  test('Salford is in the Adobe Fonts kit the page loads', () => {
    expect(read('index.html')).toMatch(/<link rel="stylesheet" href="https:\/\/use\.typekit\.net\/[a-z0-9]+\.css">/);
  });

  test('the tokens load before any component stylesheet', () => {
    const main = read('src/main.tsx');
    expect(main.indexOf("'./styles/display-type.css'")).toBeGreaterThan(-1);
    expect(main.indexOf("'./styles/display-type.css'")).toBeLessThan(main.indexOf("'./styles/app.scss'"));
  });
});

describe('no stylesheet picks the title face itself', () => {
  test('only the font files, the tokens and the Arabic override name Fjalla One or Salford', () => {
    const offenders = sheets
      .filter(({ path, text }) => !MAY_NAME_FACES.includes(path) && /fjalla|salford/i.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  // Salford is set smaller than Fjalla at the same font-size, so a rule that
  // takes the face without the adjustment shrinks its heading.
  test('every rule that takes the face also takes its size adjustment', () => {
    const missing = sheets.flatMap(({ path, text }) =>
      (text.match(/[^{}]*{[^}]*}/g) ?? [])
        .filter((rule) => rule.includes('var(--aiep-font-display)') && !rule.includes('var(--aiep-font-display-adjust)'))
        .map((rule) => `${path}: ${rule.split('{')[0].trim()}`),
    );
    expect(sheets.some(({ text }) => text.includes('var(--aiep-font-display)'))).toBe(true);
    expect(missing).toEqual([]);
  });
});
