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
  DARK_EVERYWHERE as CDK_DARK_EVERYWHERE,
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

  it('ships everything but TTS in production', () => {
    // Referrals went live 2026-08-04; the other three go live with the
    // promotion that carries this list. TTS is the only one still dark.
    //
    // Asserted as an exact list, in order, rather than a membership check:
    // this is the line that decides what every family sees, and a widening
    // should have to be written here deliberately rather than slipping in
    // behind a toContain.
    expect(CDK_PROD_FEATURES).toEqual([
      'referrals',
      'studentNameGate',
      'passwordlessAuth',
    ]);
    // TTS specifically, so removing it from the list above cannot quietly
    // light it: prod has no automated journey coverage to catch that.
    expect(CDK_PROD_FEATURES).not.toContain('tts');
  });

  it('keeps the student-name gate on wherever the redaction runs', () => {
    // The pipeline's redaction is not behind this flag: redact_ocr's
    // ALLOWED_PII_ENTITY_TYPES runs in every environment. So a build that
    // redacts names but never asks for the child's name has nothing to
    // substitute back, and every new summary calls the child "your child".
    // The two have to ship together, and this is the only place that can say
    // so, since nothing in the pipeline reads enabledFeatures at all.
    expect(CDK_PROD_FEATURES).toContain('studentNameGate');
    expect(CDK_ALL_FEATURES).toContain('studentNameGate');
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

  it('ships the passwordless login outside production now that e2e/ drives it', () => {
    // 2026-09-11: e2e/helpers/app.ts was taught to detect which login screen
    // is live and drive either (detectLoginScreen), so enabling the new flow
    // on staging no longer takes prod's only end-to-end login coverage with
    // it -- the thing that kept this dark in dev and staging, not just prod,
    // since the flag shipped. Production is unaffected either way: it reads
    // PROD_FEATURES directly (pinned above), which never included this name.
    //
    // Putting the name back in DARK_EVERYWHERE is how you would silently
    // undo the flip without undoing the e2e/ change that made it safe -- if
    // that is ever done deliberately, e2e/'s screen detection means the
    // suite keeps working either way, which was the point of building it
    // that way rather than hard-switching e2e/ to the new screen.
    expect(CDK_DARK_EVERYWHERE).not.toContain('passwordlessAuth');
    expect(readArrayLiteral(viteSource, 'DARK_EVERYWHERE')).toEqual(CDK_DARK_EVERYWHERE);
  });

  it('never lets a dark feature reach an environment through the default list', () => {
    for (const feature of CDK_DARK_EVERYWHERE) {
      expect(CDK_PROD_FEATURES).not.toContain(feature);
      // It stays in the master list: the name still has to be one the UI
      // recognises, or turning it on later would do nothing at all.
      expect(UI_ALL_FEATURES).toContain(feature);
    }
  });
});
