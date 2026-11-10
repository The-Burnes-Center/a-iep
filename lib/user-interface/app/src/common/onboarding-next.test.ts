/**
 * Every screen onboarding can route a new parent to after consent has to be
 * one the E2E walker (e2e/helpers/app.ts, completeOnboardingIfShown) knows
 * how to get past. A screen it does not know spins the walker out to its
 * deadline, and every journey that signs up fails at once, 28 minutes after
 * the deploy. That has happened three times; this links the two.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterChildCount, afterConsent } from './onboarding-next';
import { ALL_FEATURES, Feature } from './features';

const walker = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../e2e/helpers/app.ts'),
  'utf8',
);
const walked = (path: string) => walker.includes(`path === '${path}'`);

const PROFILES = [
  { children: [{ name: '' }] },
  { children: [{ name: 'Maya' }] },
  { children: [{ name: 'Maya' }], iepChildCount: 2 },
] as never[];
const FLAG_SETS: Feature[][] = [[], ALL_FEATURES, ['onboardingSurvey'], ['studentNameGate']];

describe('the E2E walker knows every screen onboarding routes to', () => {
  const destinations = new Set<string>();
  for (const profile of PROFILES) {
    for (const flags of FLAG_SETS) {
      const isOn = (feature: Feature) => flags.includes(feature);
      destinations.add(afterConsent(profile, isOn).path);
      destinations.add(afterChildCount(profile, isOn).path);
    }
  }

  test.each([...destinations])('%s', (path) => {
    expect(walked(path), `add a branch for ${path} to completeOnboardingIfShown`).toBe(true);
  });
});
