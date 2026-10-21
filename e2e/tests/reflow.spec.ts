/**
 * WCAG 2.2 SC 1.4.10 Reflow: at 320 CSS px wide no page scrolls sideways.
 *
 * Why this exists: a min-width: 360px on the footer (and another on the
 * landing banner) made every page 360px wide, so on a 320px phone each one
 * scrolled 40px sideways. Nothing measured it, so it shipped. Arabic is
 * checked as well as English because right-to-left overflow is worse: the
 * extra width opens on the left, and the page loads shifted.
 *
 * Read-only: it signs in and looks.
 */
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginWithOtp, finishLoginAfterOtp, completeOnboardingIfShown } from '../helpers/app';
import { appUrl } from '../helpers/config';
import { STABLE_USER } from '../helpers/phones';
import { LANGUAGE_STORAGE_KEY } from '../helpers/profile';

const WIDTH = 320;
const PUBLIC_PAGES = ['/', '/faqs', '/about-the-project', '/public-privacy-policy', '/aiep-hub'];
const SIGNED_IN_PAGES = ['/support-center', '/account-center', '/parent-rights', '/summary-and-translations'];
// The screen's language only, through the browser's stored copy; the
// account's saved preference is never written.
const LANGUAGES = ['en', 'ar'];

/** How far the page scrolls sideways, and what sticks out, for the message. */
async function overflowAt(page: Page, path: string, lang: string) {
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [LANGUAGE_STORAGE_KEY, lang]);
  await page.goto(appUrl(path));
  await page.waitForLoadState('networkidle');
  // Lazy images below the fold have no size until they load, so a page could
  // pass here and still scroll once a parent reaches the footer's logos.
  await page.evaluate(async () => {
    const lazy = Array.from(document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]'));
    lazy.forEach((img) => { img.loading = 'eager'; });
    await Promise.all(lazy.map((img) => (img.complete && img.naturalWidth ? null : img.decode().catch(() => null))));
  });
  return page.evaluate(() => {
    const width = window.innerWidth;
    const wide = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.right > width + 1 || box.left < -1;
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
    return { overflow: document.documentElement.scrollWidth - width, wide };
  });
}

test.describe('no sideways scroll at 320px', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: WIDTH, height: 700 });
  });

  test('public pages', async ({ page }) => {
    await page.goto(appUrl('/'));
    for (const lang of LANGUAGES) {
      for (const path of PUBLIC_PAGES) {
        const { overflow, wide } = await overflowAt(page, path, lang);
        expect.soft(overflow, `${path} (${lang}) scrolls sideways; too wide: ${wide.join(', ')}`).toBeLessThanOrEqual(0);
      }
    }
    await page.evaluate((key) => window.localStorage.removeItem(key), LANGUAGE_STORAGE_KEY);
  });

  test('signed-in pages', async ({ page }) => {
    test.setTimeout(180_000);
    await loginWithOtp(page, STABLE_USER);
    await finishLoginAfterOtp(page);
    await completeOnboardingIfShown(page);
    for (const lang of LANGUAGES) {
      for (const path of SIGNED_IN_PAGES) {
        const { overflow, wide } = await overflowAt(page, path, lang);
        expect.soft(overflow, `${path} (${lang}) scrolls sideways; too wide: ${wide.join(', ')}`).toBeLessThanOrEqual(0);
      }
    }
    await page.evaluate((key) => window.localStorage.removeItem(key), LANGUAGE_STORAGE_KEY);
  });
});
