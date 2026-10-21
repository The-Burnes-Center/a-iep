/**
 * The Content-Security-Policy as a parent's browser meets it: through the
 * public hostname, past Cloudflare.
 *
 * Every other journey reaches staging through its CloudFront address (the
 * stack output global-setup resolves), which skips Cloudflare. Cloudflare's
 * proxy injects a Web Analytics beacon into the HTML it serves to browsers,
 * so a policy that passed every other spec still reported that beacon the
 * first time it was loaded through dev.a-iep.org. This spec closes that gap
 * for the signed-out pages; the CSP watch itself lives in helpers/fixtures.ts.
 *
 * It signs nobody in and sends nothing, so it is safe on every run.
 */
import { test, expect } from '../helpers/fixtures';

const PUBLIC_SITE_URL = process.env.E2E_PUBLIC_SITE_URL ?? 'https://dev.a-iep.org';

// The signed-out pages, matching PUBLIC_PATHS in lib/user-interface/site-files.ts,
// plus the login screen, which is where Turnstile loads.
const PAGES = ['/', '/faqs', '/about-the-project', '/public-privacy-policy', '/aiep-hub', '/login'];

test.describe('Content-Security-Policy through the public hostname', () => {
  for (const path of PAGES) {
    test(`${path} loads with no policy violations`, async ({ page }) => {
      const response = await page.goto(new URL(path, PUBLIC_SITE_URL).toString());
      expect(response?.ok()).toBe(true);
      // Cloudflare's beacon and the lazy route chunks load after the first
      // paint; let them, or the watch has nothing to see.
      await page.waitForLoadState('networkidle');
      // Vacuity floor: the policy has to be on the response for "no
      // violations" to mean anything.
      expect(response?.headers()['content-security-policy-report-only']).toContain("default-src 'self'");
    });
  }
});
