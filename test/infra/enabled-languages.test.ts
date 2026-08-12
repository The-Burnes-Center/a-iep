/**
 * The per-environment language lists are declared THREE times: in
 * lib/user-interface/index.ts (deploy time, written into aws-exports.json), in
 * lib/user-interface/app/vite.config.ts (build time, for local and CI builds)
 * and in lib/user-interface/app/src/common/languages.ts (runtime, the only one
 * that knows what a code actually means). Until now two "kept in sync"
 * comments held the first pair together, and nothing at all pinned the set of
 * languages production ships.
 *
 * That is the same shape as the bucket rename: a value with real user-facing
 * consequences, changed in one place, with no assertion to catch the drift.
 * Arabic is deliberately dark on prod and awaiting rollout, so turning it on
 * for every family should be a decision someone records, and it should never
 * be possible to add or drop a language in one of the two build configs and
 * not the other.
 *
 * The deploy-time lists are imported, so this asserts the values CDK actually
 * writes into aws-exports.json. vite.config.ts is read as TEXT instead, because
 * it compiles under the app's own tsconfig (esModuleInterop) and will not
 * typecheck under the root one that ts-jest uses. Consolidating the two into a
 * shared module is not an option either, because CDK bundles the frontend by
 * copying only lib/user-interface/app/ into the build container, so a config
 * importing anything above that directory would fail at deploy time.
 *
 * These are plain equality assertions on purpose. When you deliberately change
 * the languages an environment offers, this test fails, and updating it is how
 * you record that the change was intended.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_LANGUAGES as CDK_ALL_LANGUAGES,
  PROD_LANGUAGES as CDK_PROD_LANGUAGES,
} from '../../lib/user-interface';
import {
  ALL_LANGUAGES as UI_ALL_LANGUAGES,
  isSupportedLanguage,
} from '../../lib/user-interface/app/src/common/languages';

const VITE_CONFIG = 'lib/user-interface/app/vite.config.ts';

const readSource = (relative: string): string =>
  fs.readFileSync(path.join(__dirname, '../..', relative), 'utf8');

/** Pull a `const NAME ... = ["a", "b"];` array literal out of a config file. */
const readArrayLiteral = (source: string, name: string, file: string): string[] => {
  const match = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`${name} not found in ${file}`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
};

describe('enabled languages per environment', () => {
  const viteSource = readSource(VITE_CONFIG);

  const deployAll = CDK_ALL_LANGUAGES;
  const deployProd = CDK_PROD_LANGUAGES;

  it('ships every language except Arabic in production', () => {
    // Arabic ships on dev/staging and stays dark on prod until it is rolled
    // out there deliberately (see CLAUDE.md and lib/user-interface/index.ts).
    expect(deployProd).toEqual(['en', 'es', 'zh', 'vi']);
  });

  it('declares the same production list at deploy time and at build time', () => {
    expect(readArrayLiteral(viteSource, 'PROD_LANGUAGES', VITE_CONFIG)).toEqual(deployProd);
  });

  it('declares the same master list at deploy time and at build time', () => {
    expect(readArrayLiteral(viteSource, 'ALL_LANGUAGES', VITE_CONFIG)).toEqual(deployAll);
  });

  it('declares a master list the UI can actually render', () => {
    // src/common/languages.ts is the source of truth for what a code means:
    // it carries the display metadata and gates the dictionary that gets
    // fetched. A code in either build config that the UI does not know is
    // dropped silently by resolveEnabledLanguages, which looks like a flag
    // that simply does nothing.
    expect(deployAll).toEqual(UI_ALL_LANGUAGES);
  });

  it('only lists languages the UI recognises', () => {
    // Filtering rather than asserting membership one by one so the failure
    // names the offending code ("cn", "pt-BR", a stray "ar ") instead of just
    // reporting that some element did not match.
    const unrecognised = (codes: string[]): string[] => codes.filter((c) => !isSupportedLanguage(c));

    expect(unrecognised(deployAll)).toEqual([]);
    expect(unrecognised(deployProd)).toEqual([]);
    expect(unrecognised(readArrayLiteral(viteSource, 'ALL_LANGUAGES', VITE_CONFIG))).toEqual([]);
    expect(unrecognised(readArrayLiteral(viteSource, 'PROD_LANGUAGES', VITE_CONFIG))).toEqual([]);
  });

  it('offers production a subset of the master list, English included', () => {
    // A prod-only language would never get a dictionary or a picker entry, and
    // an empty resolved list makes resolveEnabledLanguages fall back to every
    // language — including the ones prod deliberately hides.
    expect(deployAll).toEqual(expect.arrayContaining(deployProd));
    expect(deployProd).toContain('en');
  });
});
