/**
 * Wrong-OTP lockout. define-auth-challenge counts failed OTP rounds (the
 * language handshake is exempt) and fails the whole auth session at three.
 * That rule sits underneath BOTH login screens (docs/AUTH_API_CONTRACT.md
 * 13: "Cognito's own three-answers-per-session rule sits underneath" the
 * passwordlessAuth screen's own destination-wide counter too), but what a
 * parent SEES differs, so this test detects which screen is live and
 * asserts accordingly rather than picking one:
 *
 *   - legacy: the UI stays on the code screen throughout. Rounds 1-2 show
 *     the generic in-session error; round 3 (Cognito fails the session, the
 *     client receives NotAuthorizedException) shows the invalid-code error.
 *   - passwordlessAuth: rounds 1-2 show auth.error.badCode and stay on the
 *     code screen; round 3 is use-passwordless-auth's own MAX_CODE_ATTEMPTS
 *     reacting to the same session failure, and it returns to the
 *     identifier screen with auth.errorSessionExpired instead.
 *
 * Either way, the UI must show a visible failure instead of looping forever,
 * and a brand-new session afterwards must still work: the lockout is
 * per-session, not per-account. (The passwordlessAuth screen also has an
 * outer, per-destination lockout with no legacy equivalent --
 * passwordless-login.spec.ts.)
 *
 * Tagged @destructive-session: it deliberately burns an auth session for
 * the lockout user (but leaves the account itself untouched).
 */
import { test, expect } from '@playwright/test';
import {
  startPhoneLogin,
  submitOtpCode,
  loginWithOtp,
  detectLoginScreen,
  EN,
  EN_PASSWORDLESS,
  IN_APP_PATHS,
} from '../helpers/app';
import { LOCKOUT_USER } from '../helpers/phones';

// Real codes come from crypto.randomInt(100000, 1000000), so a code below
// 100000 is wrong by construction, never by luck.
const WRONG_CODE = '000000';

test(
  'three wrong OTPs fail the session with a visible error, and a fresh login still works',
  { tag: '@destructive-session' },
  async ({ page }) => {
    await startPhoneLogin(page, LOCKOUT_USER);
    await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
    const screen = await detectLoginScreen(page);

    if (screen === 'legacy') {
      // Rounds 1-2: still inside the session, the backend issues another
      // challenge round and the UI shows its in-session error. The alert
      // text does not change between these rounds, so per-round assertions
      // would be satisfied by round 1's leftover alert; correctness of the
      // count is instead proven by round 3 below, which can only show the
      // session-failure message if BOTH earlier submissions registered
      // (otherwise the backend would just have issued another round with
      // the generic error).
      await submitOtpCode(page, WRONG_CODE);
      await expect(
        page.getByRole('alert').filter({ hasText: EN.wrongCodeInSession })
      ).toBeVisible();
      await submitOtpCode(page, WRONG_CODE);

      // Round 3: define-auth-challenge fails the session, the client
      // receives NotAuthorizedException, and the UI maps it to the
      // invalid-code error.
      await submitOtpCode(page, WRONG_CODE);
      await expect(
        page.getByRole('alert').filter({ hasText: EN.sessionFailed })
      ).toBeVisible();
    } else {
      // Rounds 1-2: bad_code, same text both times, still on the code
      // screen -- the contract's "keep the challenge handle and let the
      // parent retype".
      await submitOtpCode(page, WRONG_CODE);
      await expect(
        page.getByRole('alert').filter({ hasText: EN_PASSWORDLESS.badCode })
      ).toBeVisible();
      await submitOtpCode(page, WRONG_CODE);
      await expect(
        page.getByRole('alert').filter({ hasText: EN_PASSWORDLESS.badCode })
      ).toBeVisible();

      // Round 3: the same Cognito session failure, but use-passwordless-
      // auth's own MAX_CODE_ATTEMPTS reacts to it locally rather than
      // showing whatever the server said: it abandons the challenge and
      // returns to the identifier screen with a session-expired message.
      await submitOtpCode(page, WRONG_CODE);
      await expect(
        page.getByRole('alert').filter({ hasText: EN_PASSWORDLESS.sessionExpired })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: EN_PASSWORDLESS.sendCode, exact: true })
      ).toBeVisible();
    }

    // The account is not locked, only that session died: a fresh sign-in
    // creates a new session and a NEW code (the SSM freshness check inside
    // loginWithOtp guarantees we read the new one, not the burned one).
    await loginWithOtp(page, LOCKOUT_USER);
    expect(IN_APP_PATHS).toContain(new URL(page.url()).pathname);
  }
);
