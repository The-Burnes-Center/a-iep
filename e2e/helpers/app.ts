/**
 * UI flow helpers. Everything drives the real deployed frontend the way a
 * parent would: selectors prefer roles and visible copy; the one testid
 * (sms-code-input) exists because the OTP field has no associated label and
 * a localized placeholder.
 *
 * Two login screens are live behind the `passwordlessAuth` feature flag (see
 * lib/user-interface/app/src/common/features.ts and
 * docs/AUTH_API_CONTRACT.md): the legacy Amplify signIn/signUp screen, and
 * PasswordlessAuthForm's identifier -> /auth/start -> /auth/verify flow. Every
 * helper below DETECTS which one is rendered and drives whichever it finds,
 * rather than assuming one -- that is what lets this suite keep working
 * whichever way the flag is set in the environment under test, needs no
 * change when the flag flips back, and does not silently start testing the
 * wrong screen. detectLoginScreen() and EN_PASSWORDLESS are exported so a
 * spec that asserts screen-specific copy (lockout.spec.ts, language.spec.ts,
 * resignup.spec.ts) can branch the same way.
 *
 * These helpers assume the default UI language (English): every Playwright
 * test gets a fresh browser context, and the app boots in English when
 * localStorage holds no preference. language.spec.ts drives its own
 * Spanish flow inline instead of using these.
 */
import { Locator, Page, expect } from '@playwright/test';
import { appUrl } from './config';
import { fetchOtp, fetchTurnstileBypassToken } from './aws';

/** The English copy the flows key on (single place to update when the
 * translation files change; values mirror src/translations/en.json).
 * Legacy-screen-only: see EN_PASSWORDLESS for the passwordlessAuth screen's
 * own copy, which differs on every button and error string below. */
export const EN = {
  sendSmsCode: 'Send SMS Code',
  verifySmsCode: 'Verify Code',
  backToLogin: 'Back to Login',
  smsCodeSentExisting: 'SMS code sent. Please enter the verification code.',
  // The new-account message. Note it is NOT evidence of the single-SMS flow:
  // CustomLogin shows the same key on its two-code fallback, so proving "one
  // text" needs the send-count assertions in resignup.spec.ts.
  smsCodeSentNewUser: 'Account created and SMS code sent!',
  wrongCodeInSession: 'An error occurred. Please try again.',
  sessionFailed: 'Invalid verification code. Please try again.',
  preferEnglish: 'I prefer English',
  agreeAndContinue: 'AGREE AND CONTINUE',
  saveAndContinue: 'Save & Continue',
  welcomeContinue: 'Continue',
  updateProfile: 'Update Profile',
  navigateToAccount: 'Navigate to Account',
  deleteYourAccount: 'Delete your account',
  deleteMyAccount: 'Delete My Account',
} as const;

/**
 * The passwordlessAuth screen's own copy (PasswordlessAuthForm.tsx / the
 * `auth.*` keys in src/translations/en.json). Deliberately NOT a drop-in
 * replacement for EN above: several legacy strings have no equivalent here by
 * design (AUTH_API_CONTRACT.md 2 and 11: the new screen never shows a
 * new-vs-existing-user distinction at all), and some that look similar are
 * genuinely different strings ("Send code" vs "Send SMS Code", "Verify" vs
 * "Verify Code").
 */
export const EN_PASSWORDLESS = {
  sendCode: 'Send code',
  verify: 'Verify',
  codeSentTo: 'Enter the 6-digit code sent to',
  badCode: 'That code did not work. Check the code and try again, or ask for a new one.',
  sessionExpired: 'Session expired. Please start over.',
  /** {minutes} is not substituted here; assert with a regex or .replace() it yourself. */
  tooManyCodes: 'You have tried too many codes. Please try again in {minutes} minutes.',
} as const;

export type LoginScreen = 'legacy' | 'passwordless';

/** Once one of these is reached, login + onboarding are behind us. */
export const IN_APP_PATHS = ['/summary-and-translations', '/iep-documents'];

/**
 * Put the staging bypass token on every /auth/start or /auth/signup request
 * this page makes -- the legacy screen posts to the latter, PasswordlessAuthForm
 * to the former, and e2e-bypass.js (shared by both endpoints' lambdas, see
 * auth-start.js and signup-endpoint.js) accepts the same token on either.
 *
 * Done at the NETWORK layer, deliberately, rather than by teaching the app a
 * test mode. The browser cannot solve a real Turnstile challenge, so something
 * has to substitute the token; doing it here means no bypass code exists in
 * the shipped frontend at all, and the only thing that can be misconfigured is
 * a staging-only server-side check that production is never given.
 *
 * The endpoint additionally requires one of TEST_PHONE_NUMBERS, so this
 * rewrite cannot create an account on a number a person could receive a text
 * on, even if the token leaked.
 */
export async function allowAuthPastTurnstile(page: Page): Promise<void> {
  const token = await fetchTurnstileBypassToken();
  await page.route(
    (url) => url.pathname.endsWith('/auth/signup') || url.pathname.endsWith('/auth/start'),
    async (route) => {
      const request = route.request();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.postData() ?? '{}');
      } catch {
        // Leave a malformed body alone: the endpoint's own 400 path is a thing
        // worth being able to test.
        await route.continue();
        return;
      }
      await route.continue({
        postData: JSON.stringify({ ...body, turnstileToken: token }),
      });
    }
  );
}

export async function gotoLogin(page: Page): Promise<LoginScreen> {
  // Before the first navigation, so the route is in place for any signup the
  // page makes. Harmless on flows that never sign up.
  await allowAuthPastTurnstile(page);
  await page.goto(appUrl('/login'));
  await expect(phoneInput(page)).toBeVisible();
  return detectLoginScreen(page);
}

/** The one phone field on the login screen; it formats itself as you type.
 * Shared markup between both screens (same `input[type="tel"]`, same inline
 * +1 formatting), so this needs no per-screen branch. */
export function phoneInput(page: Page) {
  return page.locator('input[type="tel"]');
}

export async function fillPhone(page: Page, phone: string): Promise<void> {
  // '+15555550111' -> '5555550111'; the field re-adds the +1 and formatting
  await phoneInput(page).fill(phone.slice(2));
}

/** The phone tab's submit button, whichever screen is live: "Send SMS Code"
 * (legacy) or "Send code" (passwordlessAuth). `exact: true` on both sides
 * because otherwise Playwright's default substring match would need care not
 * to collide ("Send code" is not a substring of "Send SMS Code", but exact
 * keeps that true by construction rather than by coincidence). */
function sendButton(page: Page): Locator {
  return page
    .getByRole('button', { name: EN.sendSmsCode, exact: true })
    .or(page.getByRole('button', { name: EN_PASSWORDLESS.sendCode, exact: true }));
}

/** The code screen's submit button: "Verify Code" (legacy) or "Verify"
 * (passwordlessAuth). exact: true matters here more than anywhere else --
 * "Verify" IS a substring of "Verify Code", so a non-exact match would hit
 * both screens' buttons at once. */
function verifyButton(page: Page): Locator {
  return page
    .getByRole('button', { name: EN.verifySmsCode, exact: true })
    .or(page.getByRole('button', { name: EN_PASSWORDLESS.verify, exact: true }));
}

/**
 * Which login screen is currently rendered, decided by whichever of the two
 * mutually-exclusive send/verify button pairs is visible (see sendButton /
 * verifyButton above). Works from either the identifier screen or the code
 * screen, on either login screen, so it is safe to call right after gotoLogin
 * OR right after a send, before deciding how to read the result.
 *
 * Gated behind the `passwordlessAuth` feature flag (see
 * lib/user-interface/app/src/common/features.ts), so which one this resolves
 * to depends on ENABLED_FEATURES for the environment under test -- currently
 * on outside prod (lib/user-interface/index.ts's DARK_EVERYWHERE), legacy in
 * prod.
 */
export async function detectLoginScreen(page: Page): Promise<LoginScreen> {
  const newScreenSignal = page
    .getByRole('button', { name: EN_PASSWORDLESS.sendCode, exact: true })
    .or(page.getByRole('button', { name: EN_PASSWORDLESS.verify, exact: true }));
  const legacyScreenSignal = page
    .getByRole('button', { name: EN.sendSmsCode, exact: true })
    .or(page.getByRole('button', { name: EN.verifySmsCode, exact: true }));
  await expect(newScreenSignal.or(legacyScreenSignal)).toBeVisible();
  return (await newScreenSignal.isVisible()) ? 'passwordless' : 'legacy';
}

/**
 * Enter the phone and click send. Returns the timestamp captured BEFORE the
 * click: that instant anchors fetchOtp's freshness check, so a stale SSM
 * payload from an earlier send can never be mistaken for this one.
 */
export async function startPhoneLogin(page: Page, phone: string): Promise<number> {
  return (await beginPhoneLogin(page, phone)).sentAt;
}

/** Shared by startPhoneLogin (which only ever needed the timestamp) and
 * loginWithOtp (which also needs to know which screen it just submitted on,
 * to pick the right "send succeeded" signal below). */
async function beginPhoneLogin(
  page: Page, phone: string
): Promise<{ sentAt: number; screen: LoginScreen }> {
  const screen = await gotoLogin(page);
  await fillPhone(page, phone);
  const sentAt = Date.now();
  await sendButton(page).click();
  return { sentAt, screen };
}

export async function submitOtpCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('sms-code-input').fill(code);
  await verifyButton(page).click();
}

/**
 * Full UI login via the OTP backdoor, ending inside the app (onboarding
 * completed if this account had not been through it yet).
 */
export async function loginWithOtp(page: Page, phone: string): Promise<void> {
  const { sentAt, screen } = await beginPhoneLogin(page, phone);

  if (screen === 'passwordless') {
    // No known-vs-new-user distinction to check here: by design
    // (AUTH_API_CONTRACT.md 2, 11) the passwordlessAuth screen shows the same
    // code entry step either way. Reaching it at all is the milestone.
    await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
  } else {
    await waitForLegacyExistingUserAlert(page);
  }

  const otp = await fetchOtp(phone, sentAt);
  await submitOtpCode(page, otp.code);
  await finishLoginAfterOtp(page);
}

/**
 * Known-user path only, legacy screen only. Seeing the sign-up fallback here
 * ('Account created and SMS code sent!') would mean the account evaporated;
 * the exact-message assertion makes that failure mode legible.
 */
async function waitForLegacyExistingUserAlert(page: Page): Promise<void> {
  await expect(
    page.getByRole('alert').filter({ hasText: EN.smsCodeSentExisting })
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * The tail of every successful OTP submit: the app parks on /login for ~1s
 * (success flash), routes to /preferred-language, and that page decides
 * where the user belongs. Returns the in-app path finally reached.
 */
export async function finishLoginAfterOtp(page: Page): Promise<string> {
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  return completeOnboardingIfShown(page);
}

const ONBOARDING_DEADLINE_MS = 120_000;

/**
 * Walk whatever onboarding screens appear until an in-app page is reached.
 *
 * Implemented as a URL-keyed state machine polled in a loop rather than a
 * fixed click script, because how much onboarding appears depends on the
 * account's history: a fresh account sees language pick -> consent ->
 * student name -> parent name, an account whose parent name is already on
 * file gets a welcome screen in place of that last step, the stable user
 * usually sees nothing, and an account that died mid-onboarding on a
 * previous run resumes somewhere in the middle.
 *
 * The two name steps are flag-dependent, not dead code: `studentNameGate`
 * and `parentNameGate` (lib/user-interface/app/src/common/features.ts) are
 * on outside prod and dark in prod, so a run against staging sees both
 * screens and one against production sees neither. Every branch below keys
 * on the URL plus an isVisible() check and never on the flags, which is what
 * lets one helper drive either configuration.
 *
 * (Until 2026-07-29 this also had to bypass a third-party JotForm survey
 * that /preferred-language showed to profiles with neither a language nor
 * consent. That survey was removed from the product, so the language pick
 * is now the unconditional first screen.)
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
      } else if (path === '/view-update-add-child') {
        // The student-name step (ViewAndAddChild), which both onboarding
        // routes into ahead of the parent-name step when studentNameGate is
        // on. Nothing here reads the flag: where it is dark the screen never
        // appears and this branch simply never fires.
        const childNameInput = page.locator('#formChildName');
        if (await childNameInput.isVisible()) {
          await childNameInput.fill('E2E Test Child');
          // Save & Continue stays disabled until BOTH fields hold something.
          // Consent auto-creates the child with a school city, but a profile
          // whose child predates that, or whose creation failed, has it
          // blank, and the loop would then spin on a permanently dead button.
          await page.locator('#formSchoolCity').fill('E2E Test City');
          await page.getByRole('button', { name: EN.saveAndContinue }).click();
          // Saving chains the child write, showOnboarding=false and the
          // parent-name check before it routes; wait the navigation out so
          // the loop cannot double-submit.
          await page.waitForURL((url) => url.pathname !== '/view-update-add-child', { timeout: 30_000 });
          continue;
        }
      } else if (path === '/welcome-intro') {
        // Where the student-name step lands an account that owes no parent
        // name and has no document yet, so it arrived with that step. Its
        // Continue writes showOnboarding=false and routes to /iep-documents.
        // exact: true because 'Continue' is a substring of two other
        // onboarding buttons, and a case-insensitive substring match would
        // make this locator claim them.
        const welcomeContinue = page.getByRole('button', { name: EN.welcomeContinue, exact: true });
        if (await welcomeContinue.isVisible()) {
          await welcomeContinue.click();
          await page.waitForURL((url) => url.pathname !== '/welcome-intro', { timeout: 30_000 });
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

/**
 * Delete the signed-in account the way a parent would: app nav -> Account
 * Center -> Delete your account -> Delete My Account.
 *
 * The backend deletes the S3 documents, the document rows, the profile row
 * and the Cognito user, then the app signs out and lands on the public
 * landing page. Reaching '/' proves the DELETE call resolved (the app only
 * navigates after it returns), not just that time passed.
 */
export async function deleteAccountThroughUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: EN.navigateToAccount }).click();
  await page.waitForURL((url) => url.pathname === '/account-center');
  await page.getByRole('button', { name: EN.deleteYourAccount }).click();
  await page.waitForURL((url) => url.pathname === '/account-center/delete-account');
  await page.getByRole('button', { name: EN.deleteMyAccount }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 60_000 });
}
