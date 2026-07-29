/**
 * The bread-and-butter journey: an existing user logs in with their phone
 * number through the real UI, the OTP arrives via the staging backdoor
 * (SSM instead of SMS), and the user lands inside the app.
 *
 * This is the UI-level twin of smoke check 2 (which only proves the
 * language-handshake round): it exercises the full round trip the smoke
 * test deliberately stops short of, including verify-auth-challenge and the
 * post-login profile routing.
 */
import { test, expect } from '@playwright/test';
import { loginWithOtp, IN_APP_PATHS } from '../helpers/app';
import { STABLE_USER } from '../helpers/phones';

test('stable user logs in via phone OTP and reaches the app', async ({ page }) => {
  await loginWithOtp(page, STABLE_USER);

  // Inside the app: on one of the main pages, with the signed-in app chrome
  // (the sticky top navigation only renders on authenticated pages).
  expect(IN_APP_PATHS).toContain(new URL(page.url()).pathname);
  await expect(page.locator('.mobile-top-navigation')).toBeVisible();
});
