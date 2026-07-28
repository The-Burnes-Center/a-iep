import { defineConfig } from '@playwright/test';

/**
 * The document pipeline (OCR -> LLM analysis -> translations) legitimately
 * takes several minutes; upload.spec.ts sets this for itself. Budget: login
 * and onboarding (~2 min) + upload (~2 min) + processing appears (~3 min) +
 * summary appears (~10 min max) with headroom.
 */
export const PIPELINE_TEST_TIMEOUT_MS = 18 * 60 * 1000;

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup',

  // The journeys share stateful users (+1555555011x/0120): two workers could
  // interleave OTP sends for the same phone and each would fish the other's
  // code out of SSM. One worker, strictly serial, matches the CI concurrency
  // group that already serializes whole runs against staging.
  workers: 1,
  fullyParallel: false,

  // One retry: these tests ride a real CDN, a real Cognito pool and a real
  // backend, so a single network blip should not fail a deploy. Every spec
  // is written to be retry-safe (fresh sign-in per attempt; the re-signup
  // spec re-heals its user inside the test body).
  retries: 1,

  // Real-site journeys: each one does a full OTP login (SSM polling included)
  // before it gets to its actual subject, so the default is generous.
  timeout: 180_000,
  expect: { timeout: 15_000 },

  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    // Mobile-ish viewport on purpose: this is a mobile-first parent-facing
    // app, and the login screen's language picker is CSS-hidden at >=1025px
    // (the desktop picker lives in a nav that is itself hidden <992px).
    viewport: { width: 414, height: 896 },
  },

  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
