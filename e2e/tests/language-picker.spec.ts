/**
 * One language picker, in the same place, on every signed-in screen.
 *
 * Before: Support, Rights and Account drew one, the summary drew its own,
 * onboarding drew a third in a different place, and every other screen had
 * none. Now the top bar owns the spot (NavLanguageSlot.tsx): the parent's
 * preference by default, the summary's own picker on the summary, and
 * nothing on the language step, which is itself a language picker.
 *
 * Read-only: it signs in and looks, and changes nothing on the account.
 */
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginWithOtp, finishLoginAfterOtp, completeOnboardingIfShown } from '../helpers/app';
import { appUrl } from '../helpers/config';
import { STABLE_USER } from '../helpers/phones';

const SCREENS = [
  '/support-center',
  '/parent-rights',
  '/account-center',
  '/account-center/profile',
  '/view-resources',
  '/frequently-asked-questions',
  '/summary-and-translations',
];

/** Every language picker toggle on the page, wherever it is. */
const pickers = (page: Page) =>
  page.locator('[data-testid="language-preference-toggle"], #language-dropdown');

test('every signed-in screen has exactly one language picker, in the top bar', async ({ page }) => {
  test.setTimeout(180_000);
  await loginWithOtp(page, STABLE_USER);
  await finishLoginAfterOtp(page);
  await completeOnboardingIfShown(page);

  for (const path of SCREENS) {
    await test.step(path, async () => {
      await page.goto(appUrl(path));
      const bar = page.locator('nav.mobile-top-navigation');
      await expect(bar.locator('.nav-language-slot').locator('button').first()).toBeVisible({ timeout: 30_000 });
      await expect(pickers(page), `${path} shows one picker`).toHaveCount(1);
      await expect(bar.locator('.nav-language-slot')).toContainText(/./);
      // Named for what it is, with the language it shows (WCAG 2.5.3).
      await expect(pickers(page)).toHaveAccessibleName(/: /);
    });
  }
  // The language step, which empties the spot, is pinned by
  // PreferredLanguage.test.tsx: an onboarded parent only reaches it through
  // in-app navigation state this suite cannot set.
});

test('on a phone the picker is a button inside the top bar, not over the page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 700 });
  await loginWithOtp(page, STABLE_USER);
  await finishLoginAfterOtp(page);
  await completeOnboardingIfShown(page);
  await page.goto(appUrl('/support-center'));

  const bar = page.locator('nav.mobile-top-navigation');
  const toggle = pickers(page);
  await expect(toggle).toBeVisible({ timeout: 30_000 });

  const barBox = (await bar.boundingBox())!;
  const box = (await toggle.boundingBox())!;
  // Inside the bar's box, at its trailing edge (SC 2.4.11: nothing floats
  // over the content).
  expect(box.y).toBeGreaterThanOrEqual(barBox.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(barBox.y + barBox.height + 1);
  expect(box.x + box.width).toBeGreaterThan(barBox.x + barBox.width - 60);
  // SC 2.5.8, and the 44 px the nav items have.
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  // SC 1.4.10 for the bar: at 320 px it fits, with the button on screen.
  // (The page as a whole is held at 360 px by AIEPFooter.css, separately.)
  expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.x).toBeGreaterThanOrEqual(0);
  // The visible short code is part of the name (SC 2.5.3).
  await expect(toggle).toHaveAccessibleName(/: .+ [A-Z]{2}$/);
});
