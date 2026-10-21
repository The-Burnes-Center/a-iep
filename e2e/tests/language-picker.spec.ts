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

  await test.step('the language step shows none', async () => {
    await page.goto(appUrl('/preferred-language'));
    await expect(page.locator('.onboarding-choice').first()).toBeVisible({ timeout: 30_000 });
    await expect(pickers(page)).toHaveCount(0);
  });
});
