/**
 * Login-language plumbing, end to end. Cognito does not forward sign-in
 * clientMetadata to the SMS lambda, so the flow smuggles the UI language
 * through a handshake round (CustomLogin answers HANDSHAKE_ACK with
 * { language }); create-auth-challenge then localizes the OTP SMS. The
 * backdoor stashes the resolved language next to the code in SSM, which
 * lets this spec pin the WHOLE chain: picker -> context -> handshake
 * metadata -> resolveLanguage -> (would-be) SMS copy.
 *
 * This spec drives the Spanish UI inline instead of using the English-only
 * helpers in helpers/app.ts.
 */
import { test, expect } from '@playwright/test';
import { gotoLogin, fillPhone } from '../helpers/app';
import { fetchOtp } from '../helpers/aws';
import { STABLE_USER } from '../helpers/phones';

test('login screen localizes and the OTP send carries the picked language', async ({ page }) => {
  await gotoLogin(page);

  // Baseline: a fresh browser context boots the app in English.
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send SMS Code' })).toBeVisible();

  // Switch to Spanish via the login screen's language picker (the toggle is
  // labeled with the CURRENT language). Only visible below 1025px width,
  // hence the suite's mobile viewport.
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Español', exact: true }).click();

  // Visible strings localize in place.
  await expect(page.getByRole('heading', { name: 'Iniciar Sesión' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar Código SMS' })).toBeVisible();

  // Start a login so the backend actually resolves a language for the OTP.
  await fillPhone(page, STABLE_USER);
  const sendStartedAt = Date.now();
  await page.getByRole('button', { name: 'Enviar Código SMS' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Código SMS enviado' })
  ).toBeVisible({ timeout: 30_000 });

  // The stashed payload's language field is what the SMS copy would have
  // been localized with; 'es' here means the whole chain held.
  const otp = await fetchOtp(STABLE_USER, sendStartedAt);
  expect(otp.language).toBe('es');

  // Deliberately abandon the session: no tokens were issued, the session
  // simply expires, and the next spec's sign-in starts a fresh one.
});
