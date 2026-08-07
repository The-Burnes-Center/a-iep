/**
 * THE INCIDENT REPRO, END TO END (PR #51, 2026-07), and since the PreSignUp
 * trigger landed also the guard on the ONE-TEXT signup contract.
 *
 * Part one, the incident. A user who deletes their account and comes back must
 * be able to sign up again and get back in. Before the fix, the app client's
 * PreventUserExistenceErrors meant Auth.signIn never threw the
 * UserNotFoundException the frontend keyed on: the deleted user's login claimed
 * "code sent", no SMS ever went out, and signup was silently dead for a month.
 * Nothing watched that path, because nothing could: Cognito itself sent the
 * sign-up verification SMS, and the create-auth-challenge backdoor only
 * intercepts our own lambda's sends. Staging's CustomSMSSender trigger closed
 * that hole by diverting Cognito's own sends for an allowlisted fictional
 * number to the SAME SSM parameter fetchOtp already reads.
 *
 * Part two, the new contract. phone-otp-auth/pre-sign-up.js now auto-confirms
 * phone-only self-service signups (autoConfirmUser + autoVerifyPhone), so
 * Cognito mints NO verification code and the custom-auth login OTP is the only
 * text a new parent receives. That is the whole point of the change, so this
 * journey asserts the COUNT, not just that a code arrived:
 *
 *   1. exactly ONE code is issued between the sign-up click and being inside
 *      the app (SSM's parameter version, read either side, is the tally);
 *   2. that one code is our LOGIN OTP: it carries `language` and no
 *      `source: cognito-...` tag from the CustomSMSSender stash;
 *   3. Cognito really auto-confirmed the account (admin-plane UserStatus and
 *      phone_number_verified, neither visible from the browser);
 *   4. the app never called ConfirmSignUp, i.e. it did not take its two-code
 *      fallback branch.
 *
 * Any one of those failing means the parent is back to two texts. The message
 * on screen cannot carry this weight: CustomLogin shows the same "Account
 * created and SMS code sent!" copy on both branches.
 *
 * The journey:
 *
 *   heal -> UI login (backdoor OTP) -> onboarding -> UI account deletion
 *   -> login again lands on the SIGN-UP path   <- the incident assertion
 *   -> real Auth.signUp, auto-confirmed, ONE login OTP  <- the new contract
 *   -> onboarding -> in the app
 *   -> UI deletion again (leaves staging clean)
 *
 * Deliberately NOT covered: CustomLogin's userConfirmed === false fallback to
 * the old two-code flow. It only runs when the trigger fails to take effect,
 * which is exactly what this spec must fail on, so the fallback belongs to the
 * frontend's unit tests.
 *
 * Retry-safety: the account is healed at the top of the test body (not in
 * global setup, which runs once) and admin-deleted in an afterEach, so every
 * attempt starts from a confirmed user and leaves nothing behind.
 */
import { test, expect, Page } from '@playwright/test';
import {
  EN,
  IN_APP_PATHS,
  completeOnboardingIfShown,
  deleteAccountThroughUi,
  loginWithOtp,
  phoneInput,
  startPhoneLogin,
  submitOtpCode,
} from '../helpers/app';
import {
  OtpPayload,
  deleteTestUserIfExists,
  ensureTestUser,
  fetchOtp,
  readOtpSendCount,
  readTestUserState,
} from '../helpers/aws';
import { THROWAWAY_USER } from '../helpers/phones';

const SINGLE_CODE_DEADLINE_MS = 90_000;

/**
 * Wait for the single code to carry the new parent into the app.
 *
 * Fails fast and legibly on the shapes a two-code regression takes: an error
 * alert (the login OTP submitted to confirmSignUp is rejected as a mismatch),
 * or a silent bounce back to the phone form. Without this, both would surface
 * as an opaque wait-for-URL timeout.
 */
async function waitForTheNewAccountToBeLetIn(page: Page): Promise<void> {
  const deadline = Date.now() + SINGLE_CODE_DEADLINE_MS;
  const errorAlert = page.locator('.alert-danger');

  while (Date.now() < deadline) {
    // The app leaves /login only once it holds a session.
    if (!new URL(page.url()).pathname.startsWith('/login')) return;

    if (await errorAlert.isVisible().catch(() => false)) {
      const text = (await errorAlert.innerText().catch(() => '')).trim();
      throw new Error(
        `The app reported an error after the sign-up code was submitted: "${text}". ` +
        'On the single-SMS flow that code is a custom-auth login OTP, so this ' +
        'means either the OTP was rejected or the app was on the old ' +
        'confirmation screen and fed it to confirmSignUp instead.'
      );
    }

    if (await phoneInput(page).isVisible().catch(() => false)) {
      throw new Error(
        'After submitting the sign-up code the app fell back to the ' +
        'phone-number form without an error message: it never completed the login.'
      );
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    `The app never left /login within ${SINGLE_CODE_DEADLINE_MS / 1000}s of ` +
    'submitting the only code a new parent is sent.'
  );
}

/**
 * THE one-SMS assertion: the stash version moved by exactly one, so exactly
 * one code was issued to this number across the window.
 *
 * A second send (Cognito's sign-up verification coming back) writes the same
 * parameter and bumps the version again, whichever order the two land in and
 * whichever of them fetchOtp happened to read.
 */
function expectExactlyOneCodeIssued(before: number, after: number, when: string): void {
  expect(
    after - before,
    `${when}: a new parent must receive exactly ONE text, and the OTP stash ` +
    `for ${THROWAWAY_USER} recorded ${after - before} sends ` +
    `(parameter version ${before} -> ${after}). More than one means Cognito is ` +
    'minting a sign-up verification code again, so pre-sign-up.js is no longer ' +
    'auto-confirming phone signups.'
  ).toBe(1);
}

// Cleanup as an afterEach rather than a try/finally in the test body: hooks
// still run when a test TIMES OUT, which is exactly when a half-finished
// sign-up would otherwise be left behind. A no-op when the journey's own
// final UI deletion already removed the user.
test.afterEach(async () => {
  await deleteTestUserIfExists(THROWAWAY_USER);
});

test('deleted account signs up again and is sent exactly one code', async ({ page }) => {
  // Two full logins, two onboardings, two deletions and a real Cognito
  // sign-up: by far the longest journey in the suite.
  test.setTimeout(420_000);

  // Every Cognito API call the browser makes, by operation name (Amplify puts
  // it in the X-Amz-Target header). Collected for the whole test because the
  // operations asserted on below (SignUp and ConfirmSignUp) can only occur in
  // Act 3.
  const cognitoOperations: string[] = [];
  page.on('request', (request) => {
    const target = request.headers()['x-amz-target'];
    if (target?.startsWith('AWSCognitoIdentityProviderService.')) {
      cognitoOperations.push(target.split('.')[1]);
    }
  });

  // Heal the throwaway INSIDE the test (not in global setup): the journey
  // consumes the account, so a retry must rebuild it or it would start
  // user-less. Delete-then-create also clears any UNCONFIRMED leftover from
  // an attempt that died mid sign-up.
  await deleteTestUserIfExists(THROWAWAY_USER);
  await ensureTestUser(THROWAWAY_USER);

  // ---- Act 1: an existing account, used and then deleted ----------------

  // Fresh account: first login walks the real onboarding (language pick ->
  // consent -> parent name).
  await loginWithOtp(page, THROWAWAY_USER);
  await expect(page.locator('.mobile-top-navigation')).toBeVisible();

  await deleteAccountThroughUi(page);

  // ---- Act 2: the incident assertion ------------------------------------

  // Read the send tally BEFORE the click that triggers the sign-up: the
  // parameter is overwritten per send and never deleted, so its version is a
  // running total and only the delta across this window means anything.
  const codesBeforeSignUp = await readOtpSendCount(THROWAWAY_USER);

  // The same number must now be treated as a NEW user. The sign-up
  // fallback's distinct message ("Account created...") is the signal; the
  // pre-incident bug showed the existing-user "SMS code sent." while nothing
  // was actually sent.
  const signUpSentAt = await startPhoneLogin(page, THROWAWAY_USER);
  await expect(
    page.getByRole('alert').filter({ hasText: EN.smsCodeSentNewUser })
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('sms-code-input')).toBeVisible();

  // ---- Act 3: one text, and it is the login OTP -------------------------

  // The trigger's own effect, invisible from the browser (the confirmation
  // screen and the login OTP screen are the same screen). UNCONFIRMED here
  // would mean Cognito is still waiting for a verification code it has just
  // texted, i.e. the parent is owed a second message.
  const signedUpState = await readTestUserState(THROWAWAY_USER);
  expect(
    signedUpState.status,
    'pre-sign-up.js must auto-confirm a phone-only self-service signup; an ' +
    'UNCONFIRMED account means it did not, and Cognito sent its own code'
  ).toBe('CONFIRMED');
  expect(
    signedUpState.isPhoneVerified,
    'pre-sign-up.js must also set autoVerifyPhone, or the account is confirmed ' +
    'with an unverified number and Cognito can still demand verification later'
  ).toBe(true);

  const otp: OtpPayload = await fetchOtp(THROWAWAY_USER, signUpSentAt);

  // Which writer stashed it. A `source` tag means the CustomSMSSender trigger
  // wrote it, i.e. this is Cognito's sign-up verification code and not our
  // login OTP: the exact code the auto-confirm exists to abolish.
  expect(
    otp.source,
    'the only code a new parent gets must be the custom-auth LOGIN OTP, but ' +
    `this one was stashed by the CustomSMSSender trigger (source "${otp.source}"), ` +
    'so Cognito minted a sign-up verification code'
  ).toBeUndefined();
  // The positive half of the same check: create-auth-challenge always records
  // the language it localized the SMS with, and the Cognito stash never does.
  expect(
    otp.language,
    'the stashed payload carries no language field, so create-auth-challenge ' +
    'did not write it; the absent `source` above cannot be trusted as proof ' +
    'that this is the login OTP'
  ).toBeTruthy();

  expectExactlyOneCodeIssued(
    codesBeforeSignUp,
    await readOtpSendCount(THROWAWAY_USER),
    'after signing up',
  );

  // One code, one submission, straight into the app: no confirmation screen
  // in between, which is what removing Cognito's code buys the parent.
  await submitOtpCode(page, otp.code);
  await waitForTheNewAccountToBeLetIn(page);

  // ---- Act 4: the re-signed-up user is really in the app ----------------

  // Brand-new account, so real onboarding runs again.
  const landedAt = await completeOnboardingIfShown(page);
  expect(IN_APP_PATHS).toContain(landedAt);
  await expect(page.locator('.mobile-top-navigation')).toBeVisible();

  // Re-read once everything has settled: a late second send (a resend the app
  // fired on its own, say) would show up here and nowhere else.
  expectExactlyOneCodeIssued(
    codesBeforeSignUp,
    await readOtpSendCount(THROWAWAY_USER),
    'once the new parent is inside the app',
  );

  // What the browser did, as the client-side half of the same contract. The
  // SignUp assertion comes first on purpose: it proves the request listener
  // above actually matched something, so the ConfirmSignUp assertion below
  // cannot pass vacuously.
  expect(
    cognitoOperations,
    'the journey never saw a SignUp call, so the request listener matched ' +
    'nothing (header name changed?) and the ConfirmSignUp check is vacuous'
  ).toContain('SignUp');
  expect(
    cognitoOperations,
    'the app called ConfirmSignUp, so it took its two-code fallback branch: ' +
    'Auth.signUp came back with userConfirmed === false'
  ).not.toContain('ConfirmSignUp');

  // Leave staging clean through the product itself (profile row, documents
  // and the Cognito user all go); the afterEach is the backstop.
  await deleteAccountThroughUi(page);
});
