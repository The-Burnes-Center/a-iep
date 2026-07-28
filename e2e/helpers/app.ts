/**
 * UI flow helpers. Everything drives the real deployed frontend the way a
 * parent would: selectors prefer roles and visible copy; the one testid
 * (sms-code-input) exists because the OTP field has no associated label and
 * a localized placeholder.
 *
 * These helpers assume the default UI language (English): every Playwright
 * test gets a fresh browser context, and the app boots in English when
 * localStorage holds no preference. language.spec.ts drives its own
 * Spanish flow inline instead of using these.
 */
import { Page, expect } from '@playwright/test';
import { appUrl } from './config';
import { fetchOtp } from './aws';

/** The English copy the flows key on (single place to update when the
 * translation files change; values mirror src/translations/en.json). */
export const EN = {
  sendSmsCode: 'Send SMS Code',
  verifySmsCode: 'Verify Code',
  backToLogin: 'Back to Login',
  smsCodeSentExisting: 'SMS code sent. Please enter the verification code.',
  smsCodeSentNewUser: 'Account created and SMS code sent!',
  wrongCodeInSession: 'An error occurred. Please try again.',
  sessionFailed: 'Invalid verification code. Please try again.',
  preferEnglish: 'I prefer English',
  agreeAndContinue: 'AGREE AND CONTINUE',
  updateProfile: 'Update Profile',
  navigateToAccount: 'Navigate to Account',
  deleteYourAccount: 'Delete your account',
  deleteMyAccount: 'Delete My Account',
  uploadDocument: 'Upload Document',
} as const;

/** Once one of these is reached, login + onboarding are behind us. */
export const IN_APP_PATHS = ['/summary-and-translations', '/iep-documents'];

export async function gotoLogin(page: Page): Promise<void> {
  await page.goto(appUrl('/login'));
  await expect(phoneInput(page)).toBeVisible();
}

/** The one phone field on the login screen; it formats itself as you type. */
export function phoneInput(page: Page) {
  return page.locator('input[type="tel"]');
}

export async function fillPhone(page: Page, phone: string): Promise<void> {
  // '+15555550111' -> '5555550111'; the field re-adds the +1 and formatting
  await phoneInput(page).fill(phone.slice(2));
}

/**
 * Enter the phone and click send. Returns the timestamp captured BEFORE the
 * click: that instant anchors fetchOtp's freshness check, so a stale SSM
 * payload from an earlier send can never be mistaken for this one.
 */
export async function startPhoneLogin(page: Page, phone: string): Promise<number> {
  await gotoLogin(page);
  await fillPhone(page, phone);
  const sendStartedAt = Date.now();
  await page.getByRole('button', { name: EN.sendSmsCode }).click();
  return sendStartedAt;
}

export async function submitOtpCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('sms-code-input').fill(code);
  await page.getByRole('button', { name: EN.verifySmsCode }).click();
}

/**
 * Full UI login via the OTP backdoor, ending inside the app (onboarding
 * completed if this account had not been through it yet).
 */
export async function loginWithOtp(page: Page, phone: string): Promise<void> {
  const sentAt = await startPhoneLogin(page, phone);

  // Known-user path only. Seeing the sign-up fallback here ('Account
  // created and SMS code sent!') would mean the account evaporated; the
  // exact-message assertion makes that failure mode legible.
  await expect(
    page.getByRole('alert').filter({ hasText: EN.smsCodeSentExisting })
  ).toBeVisible({ timeout: 30_000 });

  const otp = await fetchOtp(phone, sentAt);
  await submitOtpCode(page, otp.code);

  // On success the app parks on /login for ~1s (success flash) and then
  // routes to /preferred-language, which decides where the user belongs.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  await completeOnboardingIfShown(page);
}

const ONBOARDING_DEADLINE_MS = 120_000;

/**
 * Walk whatever onboarding screens appear until an in-app page is reached.
 *
 * Implemented as a URL-keyed state machine polled in a loop rather than a
 * fixed click script, because how much onboarding appears depends on the
 * account's history: a fresh account sees language pick -> consent -> name,
 * the stable user usually sees nothing, and an account that died mid-
 * onboarding on a previous run resumes somewhere in the middle.
 *
 * One deliberate bypass: when the profile has neither a language nor
 * consent, /preferred-language embeds a third-party JotForm survey with no
 * skip control. Submitting it from CI would pollute the team's real survey
 * data every night, so the helper navigates straight to /consent-form (a
 * real app route) and finishes onboarding from there. In practice the
 * survey should not appear at all for these users: verify-auth-challenge
 * seeds secondaryLanguage on first successful phone login.
 */
export async function completeOnboardingIfShown(page: Page): Promise<string> {
  const deadline = Date.now() + ONBOARDING_DEADLINE_MS;
  let lastPath = '';

  while (Date.now() < deadline) {
    const path = new URL(page.url()).pathname;
    lastPath = path;

    if (IN_APP_PATHS.includes(path)) return path;

    try {
      if (path === '/preferred-language') {
        if (await page.locator('.jotform-container').isVisible()) {
          await page.goto(appUrl('/consent-form')); // survey bypass, see above
          continue;
        }
        const english = page.getByRole('button', { name: EN.preferEnglish });
        if (await english.isVisible()) {
          await english.click(); // saves the preference and routes to consent
          continue;
        }
        // Otherwise the page is still loading the profile or auto-routing.
      } else if (path === '/consent-form') {
        const checkbox = page.getByRole('checkbox');
        if (await checkbox.isVisible()) {
          await checkbox.check();
          await page.getByRole('button', { name: EN.agreeAndContinue }).click();
          // The click chains several profile API calls before routing on
          // (consent save, default child, showOnboarding=false); wait out
          // the navigation so the loop cannot double-submit.
          await page.waitForURL((url) => url.pathname !== '/consent-form', { timeout: 30_000 });
          continue;
        }
      } else if (path === '/account-center/profile') {
        // The parent-name step (routed here with onboardingContinue state).
        const nameInput = page.locator('#formParentName');
        if (await nameInput.isVisible()) {
          await nameInput.fill('E2E Test Parent');
          await page.getByRole('button', { name: EN.updateProfile }).click();
          await page.waitForURL((url) => url.pathname !== '/account-center/profile', { timeout: 30_000 });
          continue;
        }
      }
    } catch {
      // A state can dissolve mid-action when the app auto-routes (element
      // detaches, click races a navigation). That is not a failure, just a
      // transition; the next loop iteration re-reads the URL. Persistent
      // trouble still fails through the deadline below.
    }

    await page.waitForTimeout(400);
  }

  throw new Error(
    `Onboarding never reached ${IN_APP_PATHS.join(' or ')} within ` +
    `${ONBOARDING_DEADLINE_MS / 1000}s (stuck at: ${lastPath})`
  );
}
