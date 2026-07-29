/**
 * Wrong-OTP lockout. define-auth-challenge counts failed OTP rounds (the
 * language handshake is exempt) and fails the whole auth session at three,
 * which surfaces to the client as NotAuthorizedException. The UI must show
 * that failure instead of looping forever, and a brand-new session
 * afterwards must still work: the lockout is per-session, not per-account.
 *
 * Tagged @destructive-session: it deliberately burns an auth session for
 * the lockout user (but leaves the account itself untouched).
 */
import { test, expect } from '@playwright/test';
import {
  startPhoneLogin,
  submitOtpCode,
  loginWithOtp,
  EN,
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

    // Rounds 1-2: still inside the session, the backend issues another
    // challenge round and the UI shows its in-session error. The alert text
    // does not change between these rounds, so per-round assertions would
    // be satisfied by round 1's leftover alert; correctness of the count is
    // instead proven by round 3 below, which can only show the session-
    // failure message if BOTH earlier submissions registered (otherwise the
    // backend would just have issued another round with the generic error).
    await submitOtpCode(page, WRONG_CODE);
    await expect(
      page.getByRole('alert').filter({ hasText: EN.wrongCodeInSession })
    ).toBeVisible();
    await submitOtpCode(page, WRONG_CODE);

    // Round 3: define-auth-challenge fails the session, the client receives
    // NotAuthorizedException, and the UI maps it to the invalid-code error.
    await submitOtpCode(page, WRONG_CODE);
    await expect(
      page.getByRole('alert').filter({ hasText: EN.sessionFailed })
    ).toBeVisible();

    // The account is not locked, only that session died: a fresh sign-in
    // creates a new session and a NEW code (the SSM freshness check inside
    // loginWithOtp guarantees we read the new one, not the burned one).
    await loginWithOtp(page, LOCKOUT_USER);
    expect(IN_APP_PATHS).toContain(new URL(page.url()).pathname);
  }
);
