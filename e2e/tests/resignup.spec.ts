/**
 * THE INCIDENT REPRO (PR #51, 2026-07). A user who deletes their account
 * and comes back must fall into the sign-up path. Before the fix, the app
 * client's PreventUserExistenceErrors meant Auth.signIn never threw the
 * UserNotFoundException the frontend keyed on: the deleted user's login
 * claimed "code sent", no SMS ever went out, and signup was silently dead
 * for a month. The sign-up fallback message appearing IS the fixed
 * behavior; this spec keeps it fixed.
 *
 * Scope cut, per the testing plan's decision (c): the journey stops at the
 * sign-up confirmation screen. Completing it would need the verification
 * SMS that Cognito itself sends (the backdoor only intercepts our own
 * create-auth-challenge sends), so the UNCONFIRMED leftover account is
 * expected; the heal step below cleans it on the next attempt.
 */
import { test, expect } from '@playwright/test';
import {
  loginWithOtp,
  gotoLogin,
  fillPhone,
  EN,
} from '../helpers/app';
import { deleteTestUserIfExists, ensureTestUser } from '../helpers/aws';
import { THROWAWAY_USER } from '../helpers/phones';

test('deleted account falls into the sign-up path on the next login', async ({ page }) => {
  // Login + full onboarding + deletion + re-login: more real round trips
  // than any other journey, so it gets headroom over the suite default.
  test.setTimeout(300_000);

  // Heal the throwaway INSIDE the test (not in global setup): the journey
  // consumes the account, so a retry must rebuild it or it would start
  // user-less. Delete-then-create also clears the UNCONFIRMED leftover the
  // previous attempt's sign-up fallback created.
  await deleteTestUserIfExists(THROWAWAY_USER);
  await ensureTestUser(THROWAWAY_USER);

  // Fresh account: first login walks the real onboarding (consent + name).
  await loginWithOtp(page, THROWAWAY_USER);

  // Delete the account through the real UI: app nav -> Account Center ->
  // Delete your account -> Delete My Account. The backend deletes S3 docs,
  // document rows, the profile row and the Cognito user, then the app signs
  // out and lands on the public landing page.
  await page.getByRole('button', { name: EN.navigateToAccount }).click();
  await page.waitForURL((url) => url.pathname === '/account-center');
  await page.getByRole('button', { name: EN.deleteYourAccount }).click();
  await page.waitForURL((url) => url.pathname === '/account-center/delete-account');
  await page.getByRole('button', { name: EN.deleteMyAccount }).click();
  // Reaching '/' proves the DELETE API call resolved (the app only
  // navigates after it returns), not just that time passed.
  await page.waitForURL((url) => url.pathname === '/', { timeout: 60_000 });

  // The incident assertion: the same number must now be treated as a NEW
  // user. The sign-up fallback's distinct message ("Account created...")
  // is the signal; the pre-incident bug showed the existing-user "SMS code
  // sent." while nothing was actually sent.
  await gotoLogin(page);
  await fillPhone(page, THROWAWAY_USER);
  await page.getByRole('button', { name: EN.sendSmsCode }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: EN.smsCodeSentNewUser })
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('sms-code-input')).toBeVisible();

  // Stop here on purpose: see the scope-cut note in the header.
});
