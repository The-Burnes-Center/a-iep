/**
 * Failure paths that only exist on the passwordlessAuth screen
 * (PasswordlessAuthForm.tsx, docs/AUTH_API_CONTRACT.md 3): a single wrong
 * code, and the destination-wide lockout after too many of them.
 *
 * Neither has an equivalent on the legacy screen. lockout.spec.ts exercises
 * Cognito's own three-answers-per-SESSION rule (define-auth-challenge.js),
 * which still sits underneath this flow too (use-passwordless-auth's own
 * MAX_CODE_ATTEMPTS mirrors it), but the lockout below is a different,
 * outer mechanism: /auth/verify's ten-wrong-codes-per-DESTINATION-per-HOUR
 * counter (auth-store.js, MAX_FAILED_VERIFICATIONS_PER_HOUR), which survives
 * across Cognito sessions and is what actually bounds a guessing run
 * (contract 13).
 *
 * Both tests skip themselves if the legacy screen is what a deploy actually
 * shows (a manual revert of the passwordlessAuth flag, say): there is
 * nothing of this file's subject to exercise there, and lockout.spec.ts
 * already covers that screen's own wrong-code behaviour.
 */
import { test, expect, Page } from '@playwright/test';
import {
  EN_PASSWORDLESS,
  detectLoginScreen,
  fillPhone,
  finishLoginAfterOtp,
  IN_APP_PATHS,
  startPhoneLogin,
  submitOtpCode,
} from '../helpers/app';
import { fetchOtp } from '../helpers/aws';
import { PASSWORDLESS_LOCKOUT_USER, PASSWORDLESS_WRONG_CODE_USER } from '../helpers/phones';

// Real codes come from crypto.randomInt(100000, 1000000) in
// create-auth-challenge.js, so a code below 100000 is wrong by construction,
// never by luck.
const WRONG_CODE = '000000';

const sendCodeButton = (page: Page) =>
  page.getByRole('button', { name: EN_PASSWORDLESS.sendCode, exact: true });

test('a wrong code is rejected and a correct retry still succeeds', async ({ page }) => {
  const sentAt = await startPhoneLogin(page, PASSWORDLESS_WRONG_CODE_USER);
  await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
  test.skip(
    (await detectLoginScreen(page)) !== 'passwordless',
    'passwordlessAuth is dark on this deploy; nothing in this file to exercise.'
  );

  await submitOtpCode(page, WRONG_CODE);
  await expect(
    page.getByRole('alert').filter({ hasText: EN_PASSWORDLESS.badCode })
  ).toBeVisible();
  // Still on the code screen: the contract's "keep the challenge handle and
  // let the parent retype" (AUTH_API_CONTRACT.md 3), not a reset to idle.
  await expect(page.getByTestId('sms-code-input')).toBeVisible();

  const otp = await fetchOtp(PASSWORDLESS_WRONG_CODE_USER, sentAt);
  await submitOtpCode(page, otp.code);
  await finishLoginAfterOtp(page);
  expect(IN_APP_PATHS).toContain(new URL(page.url()).pathname);
});

type WrongCodeOutcome = 'stayed' | 'reset' | 'locked_out';

/**
 * Submit one wrong code and classify what the screen did, without asserting
 * which is "correct": the caller decides that, since it depends on which
 * attempt number (within a Cognito session) and which cumulative failure
 * count (within the hour) this submission landed on.
 */
async function submitWrongCodeAndClassify(page: Page): Promise<WrongCodeOutcome> {
  await submitOtpCode(page, WRONG_CODE);
  const lockedOut = page.getByTestId('passwordless-locked-out');
  const codeInput = page.getByTestId('sms-code-input');
  await expect(lockedOut.or(codeInput).or(sendCodeButton(page))).toBeVisible({ timeout: 15_000 });
  if (await lockedOut.isVisible()) return 'locked_out';
  if (await codeInput.isVisible()) return 'stayed';
  return 'reset';
}

test(
  'ten wrong codes for one destination lock it out for the rest of the hour',
  { tag: '@destructive-session' },
  async ({ page }) => {
    // Worst case (a completely fresh hour, nothing recorded for this
    // destination yet) needs 3+3+3+2 = 11 wrong submissions across 4 fresh
    // challenges: Cognito ends each challenge at its own 3rd wrong answer
    // (use-passwordless-auth's MAX_CODE_ATTEMPTS resets to idle then), and
    // the destination-wide counter only trips on the submission that finds
    // 10 already recorded. Rounds 1-2 login and OTP-polling take a while, so
    // budget generously.
    test.setTimeout(240_000);

    // The timestamp startPhoneLogin returns is deliberately never fetched
    // against SSM: every code submitted below is wrong on purpose.
    await startPhoneLogin(page, PASSWORDLESS_LOCKOUT_USER);
    await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
    test.skip(
      (await detectLoginScreen(page)) !== 'passwordless',
      'passwordlessAuth is dark on this deploy; nothing in this file to exercise.'
    );

    // 5 rounds, not 4: a fifth /auth/start for this destination this hour
    // still lands exactly on create-auth-challenge.js's MAX_SMS_PER_HOUR
    // ceiling of 5 (it refuses only the 6th), so this keeps one full round
    // of margin over the 4 rounds the math above requires, in case a
    // previous run this same hour already left a few failures recorded.
    const MAX_ROUNDS = 5;
    let outcome: WrongCodeOutcome = 'stayed';

    for (let round = 0; round < MAX_ROUNDS && outcome !== 'locked_out'; round += 1) {
      if (round > 0) {
        // Back at the identifier screen: the previous round's 3rd wrong
        // code reset it. Re-fill rather than assume the field kept its
        // value; either way this is cheap.
        await fillPhone(page, PASSWORDLESS_LOCKOUT_USER);
        await sendCodeButton(page).click();
        await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
      }

      outcome = 'stayed';
      while (outcome === 'stayed') {
        outcome = await submitWrongCodeAndClassify(page);
      }
    }

    expect(
      outcome,
      `never saw the locked_out screen after ${MAX_ROUNDS} rounds of wrong codes for ` +
      `${PASSWORDLESS_LOCKOUT_USER}. Either MAX_FAILED_VERIFICATIONS_PER_HOUR in ` +
      'auth-store.js changed, or something is resetting the per-destination counter.'
    ).toBe('locked_out');

    await expect(page.getByTestId('passwordless-locked-out')).toHaveText(
      /You have tried too many codes\. Please try again in \d+ minutes\./
    );
  }
);
