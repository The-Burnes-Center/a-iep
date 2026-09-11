/**
 * Login-language plumbing, end to end. Cognito does not forward sign-in
 * clientMetadata to the SMS lambda, so the flow smuggles the UI language
 * through a handshake round (a round-1 answer of { language } on the legacy
 * screen, RespondToAuthChallenge ClientMetadata on the passwordlessAuth one
 * -- see auth-dispatch.js); create-auth-challenge then localizes the OTP
 * SMS. The backdoor stashes the resolved language next to the code in SSM,
 * which lets this spec pin the WHOLE chain: picker -> context -> handshake
 * metadata -> resolveLanguage -> (would-be) SMS copy, on whichever screen is
 * live.
 *
 * This spec drives the Spanish UI inline instead of using the English-only
 * helpers in helpers/app.ts, but still detects the screen the same way they
 * do (gotoLogin's return value, backed by detectLoginScreen), since the send
 * button and the send-succeeded signal are both different strings on each
 * screen, in both languages.
 */
import { test, expect } from '@playwright/test';
import { gotoLogin, fillPhone, EN_PASSWORDLESS } from '../helpers/app';
import { fetchOtp } from '../helpers/aws';
import { STABLE_USER } from '../helpers/phones';

/** Spanish copy this spec keys on, mirroring EN / EN_PASSWORDLESS in
 * helpers/app.ts (values from src/translations/es.json). */
const ES = {
  sendSmsCode: 'Enviar Código SMS',
  sendCode: 'Enviar código',
  smsCodeSent: 'Código SMS enviado',
  codeSentTo: 'Ingrese el código de 6 dígitos enviado a',
} as const;

test('login screen localizes and the OTP send carries the picked language', async ({ page }) => {
  const screen = await gotoLogin(page);
  const sendButtonEn = screen === 'legacy' ? 'Send SMS Code' : EN_PASSWORDLESS.sendCode;
  const sendButtonEs = screen === 'legacy' ? ES.sendSmsCode : ES.sendCode;

  // Baseline: a fresh browser context boots the app in English.
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: sendButtonEn, exact: true })).toBeVisible();

  // Switch to Spanish via the login screen's language picker (the toggle is
  // labeled with the CURRENT language). Only visible below 1025px width,
  // hence the suite's mobile viewport.
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Español', exact: true }).click();

  // Visible strings localize in place. The heading is shared markup
  // (AuthHeader, rendered outside the flag's ternary) so this assertion
  // does not need the screen branch above.
  await expect(page.getByRole('heading', { name: 'Iniciar Sesión' })).toBeVisible();
  await expect(page.getByRole('button', { name: sendButtonEs, exact: true })).toBeVisible();

  // Start a login so the backend actually resolves a language for the OTP.
  await fillPhone(page, STABLE_USER);
  const sendStartedAt = Date.now();
  await page.getByRole('button', { name: sendButtonEs, exact: true }).click();

  if (screen === 'legacy') {
    await expect(
      page.getByRole('alert').filter({ hasText: ES.smsCodeSent })
    ).toBeVisible({ timeout: 30_000 });
  } else {
    // No new-vs-existing alert to key on here by design (contract 2, 11);
    // the code screen itself, still localized, is the signal.
    await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(ES.codeSentTo)).toBeVisible();
  }

  // The stashed payload's language field is what the SMS copy would have
  // been localized with; 'es' here means the whole chain held.
  const otp = await fetchOtp(STABLE_USER, sendStartedAt);
  expect(otp.language).toBe('es');

  // Deliberately abandon the session: no tokens were issued, the session
  // simply expires, and the next spec's sign-in starts a fresh one.
});
