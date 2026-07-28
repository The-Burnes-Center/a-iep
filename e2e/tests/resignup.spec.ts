/**
 * THE INCIDENT REPRO, END TO END (PR #51, 2026-07). A user who deletes their
 * account and comes back must be able to sign up again and get back in.
 *
 * Before the fix, the app client's PreventUserExistenceErrors meant
 * Auth.signIn never threw the UserNotFoundException the frontend keyed on:
 * the deleted user's login claimed "code sent", no SMS ever went out, and
 * signup was silently dead for a month. Nothing watched that path, because
 * nothing could: Cognito itself sends the sign-up verification SMS, and the
 * create-auth-challenge backdoor only intercepts our own lambda's sends.
 *
 * Staging's CustomSMSSender trigger closed that hole: Cognito's own sends to
 * an allowlisted fictional number land at the SAME SSM parameter fetchOtp
 * already reads, tagged {"source":"cognito-<triggerSource>"}. So this journey
 * now runs the whole loop on the throwaway number:
 *
 *   heal -> UI login (backdoor OTP) -> onboarding -> UI account deletion
 *   -> login again lands on the SIGN-UP path   <- the incident assertion
 *   -> real Auth.signUp + Cognito's verification code -> confirmSignUp
 *   -> the first login of the new account -> onboarding -> in the app
 *   -> UI deletion again (leaves staging clean)
 *
 * Reaching the app at the end also proves the PostConfirmation trigger wrote
 * the default profile (children + showOnboarding + consentGiven): a brand-new
 * account with no profile row cannot complete onboarding.
 *
 * Retry-safety: the account is healed at the top of the test body (not in
 * global setup, which runs once) and admin-deleted in an afterEach, so every
 * attempt starts from a confirmed user and leaves nothing behind.
 */
import { test, expect, Page } from '@playwright/test';
import {
  EN,
  IN_APP_PATHS,
  StashedOtp,
  deleteAccountThroughUi,
  fetchNextOtp,
  finishLoginAfterOtp,
  loginWithOtp,
  phoneInput,
  startPhoneLogin,
  submitOtpCode,
} from '../helpers/app';
import { deleteTestUserIfExists, ensureTestUser, fetchOtp } from '../helpers/aws';
import { THROWAWAY_USER } from '../helpers/phones';

/**
 * What the app does once confirmSignUp returns (see CustomLogin.tsx,
 * handleSmsCodeVerification): it immediately starts custom auth for the
 * freshly confirmed user and keeps the same code field on screen for the
 * login OTP. The 'authenticated' variant is the branch that handles a
 * signInUserSession coming back straight away.
 */
type PostConfirmOutcome = 'custom-auth-started' | 'authenticated';

const POST_CONFIRM_DEADLINE_MS = 90_000;

async function waitForPostConfirmState(page: Page): Promise<PostConfirmOutcome> {
  const deadline = Date.now() + POST_CONFIRM_DEADLINE_MS;
  const codeInput = page.getByTestId('sms-code-input');
  const errorAlert = page.locator('.alert-danger');
  const confirmedAlert = page
    .locator('.alert-success')
    .filter({ hasText: EN.signUpConfirmedNewCode });

  while (Date.now() < deadline) {
    // The app leaves /login only once it holds a session.
    if (!new URL(page.url()).pathname.startsWith('/login')) return 'authenticated';

    if (await confirmedAlert.isVisible().catch(() => false)) return 'custom-auth-started';

    // Checked before the cleared-field heuristic below: the error branch
    // clears the code field too.
    if (await errorAlert.isVisible().catch(() => false)) {
      const text = (await errorAlert.innerText().catch(() => '')).trim();
      throw new Error(
        `The app reported an error after submitting the sign-up code: "${text}". ` +
        'Either confirmSignUp rejected the code, or the custom-auth sign-in the ' +
        'app starts immediately after confirmation failed. Both are real ' +
        'regressions of the sign-up path, so this fails rather than recovers.'
      );
    }

    // Success alerts self-dismiss after 8s. A code field still on screen but
    // EMPTY, with no error, is the same state seen late: only the success
    // branch clears the field without raising an error.
    if (await codeInput.isVisible().catch(() => false)) {
      if ((await codeInput.inputValue().catch(() => null)) === '') return 'custom-auth-started';
    } else if (await phoneInput(page).isVisible().catch(() => false)) {
      throw new Error(
        'After confirming the sign-up the app fell back to the phone-number ' +
        'form without an error message: it never started the first login.'
      );
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    'The app never left the sign-up confirmation screen within ' +
    `${POST_CONFIRM_DEADLINE_MS / 1000}s of submitting Cognito's verification code.`
  );
}

// Cleanup as an afterEach rather than a try/finally in the test body: hooks
// still run when a test TIMES OUT, which is exactly when a half-finished
// sign-up would otherwise be left behind. A no-op when the journey's own
// final UI deletion already removed the user.
test.afterEach(async () => {
  await deleteTestUserIfExists(THROWAWAY_USER);
});

test('deleted account falls into the sign-up path and can sign up again', async ({ page }) => {
  // Two full logins, two onboardings, two deletions and a real Cognito
  // sign-up: by far the longest journey in the suite.
  test.setTimeout(420_000);

  // Heal the throwaway INSIDE the test (not in global setup): the journey
  // consumes the account, so a retry must rebuild it or it would start
  // user-less. Delete-then-create also clears any UNCONFIRMED leftover from
  // an attempt that died between Auth.signUp and confirmSignUp.
  await deleteTestUserIfExists(THROWAWAY_USER);
  await ensureTestUser(THROWAWAY_USER);

  // ---- Act 1: an existing account, used and then deleted ----------------

  // Fresh account: first login walks the real onboarding (consent + name).
  await loginWithOtp(page, THROWAWAY_USER);
  await expect(page.locator('.mobile-top-navigation')).toBeVisible();

  await deleteAccountThroughUi(page);

  // ---- Act 2: the incident assertion ------------------------------------

  // The same number must now be treated as a NEW user. The sign-up
  // fallback's distinct message ("Account created...") is the signal; the
  // pre-incident bug showed the existing-user "SMS code sent." while nothing
  // was actually sent.
  const signUpSentAt = await startPhoneLogin(page, THROWAWAY_USER);
  await expect(
    page.getByRole('alert').filter({ hasText: EN.smsCodeSentNewUser })
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('sms-code-input')).toBeVisible();

  // ---- Act 3: finish the sign-up Cognito really started -----------------

  // Auth.signUp made Cognito send a verification SMS; for this allowlisted
  // fictional number the CustomSMSSender trigger diverted it to SSM instead.
  // The source tag is what distinguishes it from our login backdoor's
  // stashes, so assert on it: reading a login-backdoor code here would mean
  // the trigger never fired and we are testing the wrong thing.
  const signUpOtp: StashedOtp = await fetchOtp(THROWAWAY_USER, signUpSentAt);
  expect(
    signUpOtp.source ?? '(no source field)',
    "the sign-up code must come from staging's CustomSMSSender trigger " +
    '(source "cognito-<triggerSource>"), not from the create-auth-challenge ' +
    'login backdoor'
  ).toMatch(/^cognito-/);

  // Captured BEFORE the click: confirmSignUp is immediately followed by a
  // custom-auth sign-in whose OTP overwrites the same parameter. This
  // timestamp anchors the freshness check for that second code.
  const confirmStartedAt = Date.now();
  await submitOtpCode(page, signUpOtp.code);

  const outcome = await waitForPostConfirmState(page);

  if (outcome === 'custom-auth-started') {
    // The two sends are seconds apart, closer than fetchOtp's clock-skew
    // allowance, so dedupe against the code we just used.
    const loginOtp = await fetchNextOtp(THROWAWAY_USER, confirmStartedAt, signUpOtp);
    await submitOtpCode(page, loginOtp.code);
  }

  // ---- Act 4: the re-signed-up user is really in the app ----------------

  // Brand-new account, so real onboarding runs again. It can only run if the
  // PostConfirmation trigger created the profile row.
  const landedAt = await finishLoginAfterOtp(page);
  expect(IN_APP_PATHS).toContain(landedAt);
  await expect(page.locator('.mobile-top-navigation')).toBeVisible();

  // Leave staging clean through the product itself (profile row, documents
  // and the Cognito user all go); the afterEach is the backstop.
  await deleteAccountThroughUi(page);
});
