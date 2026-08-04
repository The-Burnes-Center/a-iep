/**
 * The per-environment feature lists are declared TWICE: once in
 * lib/user-interface/index.ts (deploy time, written into aws-exports.json) and
 * once in lib/user-interface/app/vite.config.ts (build time, for local and CI
 * builds). Until now only a "kept in sync" comment held them together, and
 * nothing at all pinned what production actually ships.
 *
 * That is the same shape as the bucket rename: a value with real user-facing
 * consequences, changed in one place, with no assertion to catch the drift.
 * Turning a feature on for every family in production should not be possible
 * by accident, and it should never be possible to turn it on in one of the two
 * lists and not the other.
 *
 * The vite config is read as text rather than imported: it compiles under the
 * app's own tsconfig (esModuleInterop) and will not typecheck under the root
 * one that ts-jest uses. Consolidating the two lists into a shared module is
 * not an option either, because CDK bundles the frontend by copying only
 * lib/user-interface/app/ into the build container, so a config importing
 * anything above that directory would fail at deploy time.
 *
 * These are plain equality assertions on purpose. When you deliberately change
 * what prod ships, this test fails, and updating it is how you record that the
 * change was intended.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_FEATURES as CDK_ALL_FEATURES,
  PROD_FEATURES as CDK_PROD_FEATURES,
} from '../../lib/user-interface';
import { ALL_FEATURES as UI_ALL_FEATURES } from '../../lib/user-interface/app/src/common/features';

const VITE_CONFIG = path.join(__dirname, '../../lib/user-interface/app/vite.config.ts');

/** Pull a `const NAME ... = ["a", "b"];` array literal out of the vite config. */
const readArrayLiteral = (source: string, name: string): string[] => {
  const match = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`${name} not found in vite.config.ts`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
};

describe('enabled features per environment', () => {
  const viteSource = fs.readFileSync(VITE_CONFIG, 'utf8');

  it('ships exactly referrals in production', () => {
    // TTS and the parent-name gate are deliberately dark in prod. Referrals
    // went live 2026-08-04.
    expect(CDK_PROD_FEATURES).toEqual(['referrals']);
  });

  it('declares the same production list at deploy time and at build time', () => {
    expect(readArrayLiteral(viteSource, 'PROD_FEATURES')).toEqual(CDK_PROD_FEATURES);
  });

  it('declares the same master list in all three places', () => {
    // The UI's own list is the source of truth for what a feature name means;
    // a name in either build config that the UI does not know is dropped
    // silently by resolveEnabledFeatures, which would look like a flag that
    // simply does nothing.
    expect(readArrayLiteral(viteSource, 'ALL_FEATURES')).toEqual(CDK_ALL_FEATURES);
    expect(CDK_ALL_FEATURES).toEqual(UI_ALL_FEATURES);
  });

  it('only lists production features the UI recognises', () => {
    for (const feature of CDK_PROD_FEATURES) {
      expect(UI_ALL_FEATURES).toContain(feature);
    }
  });
});
