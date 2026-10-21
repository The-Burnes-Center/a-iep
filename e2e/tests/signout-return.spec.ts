/**
 * Signing out leaves nothing for the next sign-in to return to.
 *
 * The sign-in card takes a parent back to the page they were sent from
 * (`state.from`, set by ProtectedRoute). After Sign Out on the account center
 * the guard still set it, a moment after the page's own navigation home, so
 * the next account to sign in on the device opened the previous parent's
 * account screen. Only a real browser shows that order, which is why this is
 * an E2E check and not only a unit test (sign-out-return.test.tsx).
 */
import { test, expect } from '../helpers/fixtures';
import { loginWithOtp, finishLoginAfterOtp, completeOnboardingIfShown } from '../helpers/app';
import { appUrl } from '../helpers/config';
import { STABLE_USER } from '../helpers/phones';

test('Sign Out on the account center leaves no return page behind', async ({ page }) => {
  await loginWithOtp(page, STABLE_USER);
  await finishLoginAfterOtp(page);
  await completeOnboardingIfShown(page);

  await page.goto(appUrl('/account-center'));
  await page.getByTestId('account-center-log-out').click();

  await expect(page).toHaveURL((url) => url.pathname === '/', { timeout: 15_000 });
  // Let the guard's redirect, which arrives after the page's own, settle.
  await page.waitForLoadState('networkidle');
  const returnPath = await page.evaluate(
    () => (history.state?.usr as { from?: { pathname?: string } } | null)?.from?.pathname ?? null,
  );
  expect(returnPath, 'the sign-in card must not remember the signed-out account\'s page').toBeNull();
});
