/**
 * Bootstrap control overrides belong in src/styles/, nowhere else.
 *
 * Vite bundles every stylesheet into the page, so a bare `.btn-primary { … }`
 * in a component's CSS restyles every primary button in the app, not just that
 * component's. CustomLogin.css did exactly that: its "login" button rules were
 * the app-wide button style, and their 5px margin pushed the invite page's
 * Copy button into the link field and Share past the card on iOS. Those rules
 * now live in styles/controls.css, where global is the stated intent.
 *
 * This test fails when a component or page stylesheet declares a selector
 * whose first compound is only Bootstrap control classes or bare form
 * elements. Scope it under a class the component owns, or give the component
 * its own variant (InvitePage's "invite"), or, if it really is app-wide, put
 * it in src/styles/.
 *
 * KNOWN lists the overrides that predate this rule, each still global. A
 * stale entry fails too, so the list only ever shrinks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL_DIR = join(SRC, 'styles');

/** Bootstrap's own control classes, plus the bare elements they style. */
const CONTROL_TOKEN =
  /^(\.btn(-[a-z]+)*|\.form-(control|select|check-input|check-label|label|range|text)|\.input-group(-text)?|\.alert(-[a-z]+)*|input|select|textarea|button)$/;

/** Global overrides that predate this test. Remove an entry by scoping it. */
const KNOWN: Record<string, string[]> = {
  // The vendor alert palette, reproduced on purpose for contrast.
  'components/AlertMessages.css': ['.alert', '.alert-danger', '.alert-info', '.alert-success'],
  'pages/profile/ProfileForms.css': [
    '.btn-primary .language-name',
    '.form-check-input:checked',
    '.form-control::placeholder',
    '.form-label',
  ],
  'pages/iep-folder/UploadIEPDocument.css': [
    '.form-control[type="file"]',
    '.form-control[type="file"]::file-selector-button',
    '.form-control[type="file"]::file-selector-button:hover',
  ],
};

const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });

/** Every selector in a stylesheet, including those inside @media blocks. */
const selectorsIn = (css: string): string[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)]
    .map(([, head]) => head.trim())
    .filter((head) => !head.startsWith('@') && !/^(from|to|\d+%)/.test(head))
    .flatMap((head) => head.split(',').map((part) => part.trim()));

/** True when the selector's first compound targets only Bootstrap controls. */
export const isBareControlSelector = (selector: string): boolean => {
  const first = selector.split(/\s+|>|~|\+/)[0];
  const tokens = first
    .replace(/::?[a-z-]+(\([^)]*\))?/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .split(/(?=\.)/)
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => CONTROL_TOKEN.test(token));
};

const bareOverrides = () => {
  const found: Record<string, string[]> = {};
  for (const file of cssFiles(SRC)) {
    if (file.startsWith(GLOBAL_DIR)) continue;
    const bare = selectorsIn(readFileSync(file, 'utf8')).filter(isBareControlSelector);
    if (bare.length > 0) found[relative(SRC, file)] = [...new Set(bare)].sort();
  }
  return found;
};

describe('global Bootstrap overrides', () => {
  it('recognises a bare override and lets a scoped one through', () => {
    expect(isBareControlSelector('.btn-primary')).toBe(true);
    expect(isBareControlSelector('.btn-primary[type="submit"]:hover')).toBe(true);
    expect(isBareControlSelector('input[type="tel"]')).toBe(true);
    expect(isBareControlSelector('.btn:focus')).toBe(true);
    expect(isBareControlSelector('.login-container .btn-primary')).toBe(false);
    expect(isBareControlSelector('.btn-primary.language-button')).toBe(false);
    expect(isBareControlSelector('.invite-page .invite-action.btn')).toBe(false);
    expect(isBareControlSelector('.form-label-bold')).toBe(false);
  });

  it('declares none outside src/styles beyond the known, older ones', () => {
    const found = bareOverrides();
    const unexpected = Object.entries(found).flatMap(([file, selectors]) =>
      selectors
        .filter((selector) => !(KNOWN[file] ?? []).includes(selector))
        .map((selector) => `${file}  ${selector}`),
    );
    expect(
      unexpected,
      `global Bootstrap overrides in a component stylesheet; scope them or move them to src/styles/:\n  ${unexpected.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the known list honest: every entry is still there', () => {
    const found = bareOverrides();
    const stale = Object.entries(KNOWN).flatMap(([file, selectors]) =>
      selectors
        .filter((selector) => !(found[file] ?? []).includes(selector))
        .map((selector) => `${file}  ${selector}`),
    );
    expect(stale, `scoped already; delete from KNOWN:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('keeps the login stylesheet to the login screens', () => {
    expect(bareOverrides()['components/CustomLogin.css']).toBeUndefined();
  });
});
