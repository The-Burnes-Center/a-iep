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

  // Fetch the real code FIRST, before ever submitting a wrong one, and keep
  // it for the correct retry below.
  //
  // /auth/start hands account creation and the actual send to
  // auth-dispatch.js asynchronously (Event invocation) and answers before
  // that has necessarily run. Until it has, the challenge sits `pending`
  // (auth-store.js) and /auth/verify answers 202 not_ready for it
  // (auth-verify.js), which the client retries transparently for up to ~3s
  // (MAX_NOT_READY_RETRIES, passwordless-auth.ts) before giving up and
  // showing the generic auth.error.unavailable ("Sign-in is temporarily
  // unavailable...") instead of a real answer. sms-code-input being visible
  // only proves /auth/start's OWN response rendered the form; it says
  // nothing about whether dispatch has run. fetchOtp polls until the real
  // code is actually stashed, which cannot happen before dispatch has, so it
  // doubles as a deterministic wait for exactly that -- the same gate
  // resignup.spec.ts uses (waitForTestUserState in helpers/aws.ts) for the
  // equivalent race against the Cognito user. Skipping it is what let the
  // wrong-code submission below occasionally spend the whole not_ready
  // budget instead of getting auth.error.badCode.
  const otp = await fetchOtp(PASSWORDLESS_WRONG_CODE_USER, sentAt);

  await submitOtpCode(page, WRONG_CODE);
  await expect(
    page.getByRole('alert').filter({ hasText: EN_PASSWORDLESS.badCode })
  ).toBeVisible();
  // Still on the code screen: the contract's "keep the challenge handle and
  // let the parent retype" (AUTH_API_CONTRACT.md 3), not a reset to idle.
  await expect(page.getByTestId('sms-code-input')).toBeVisible();

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

  // Wait for an OUTCOME, never for the code input. The code input is already
  // on screen the instant the click returns and stays there for the whole
  // round trip, so racing it against the other two resolves immediately and
  // always reports 'stayed' -- including on the submission that actually
  // locks the destination out. The loop then called this again, and
  // submitOtpCode timed out clicking a Verify button the locked-out screen
  // does not have. Each of the three below only appears once the server has
  // answered, so exactly one of them is true per submission.
  const lockedOut = page.getByTestId('passwordless-locked-out');
  const badCode = page.getByRole('alert').filter({ hasText: EN_PASSWORDLESS.badCode });
  const identifierScreen = sendCodeButton(page);
  await expect(lockedOut.or(badCode).or(identifierScreen)).toBeVisible({ timeout: 15_000 });

  if (await lockedOut.isVisible()) return 'locked_out';
  // Cognito ended the challenge at its third wrong answer, so the hook reset
  // to the identifier screen rather than showing another bad-code error.
  if (await identifierScreen.isVisible()) return 'reset';
  return 'stayed';
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

    // sentAt IS fetched against SSM below, even though every code submitted
    // in this test is wrong on purpose: see the comment on the wrong-code
    // test above for why a submission cannot safely happen before that
    // resolves (the same auth-dispatch.js race resignup.spec.ts polls for on
    // the Cognito-user side). The fetched code itself is still never used.
    let sentAt = await startPhoneLogin(page, PASSWORDLESS_LOCKOUT_USER);
    await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
    test.skip(
      (await detectLoginScreen(page)) !== 'passwordless',
      'passwordlessAuth is dark on this deploy; nothing in this file to exercise.'
    );
    await fetchOtp(PASSWORDLESS_LOCKOUT_USER, sentAt);

    // 5 rounds, not 4: a fifth /auth/start for this destination this hour
    // still lands exactly on create-auth-challenge.js's MAX_SMS_PER_HOUR
    // ceiling of 5 (it refuses only the 6th), so this keeps one full round
    // of margin over the 4 rounds the math above requires, in case a
    // previous run this same hour already left a few failures recorded.
    const MAX_ROUNDS = 5;
    let outcome: WrongCodeOutcome = 'stayed';

    for (let round = 0; round < MAX_ROUNDS && outcome !== 'locked_out'; round += 1) {
      if (round > 0) {
        // A fresh navigation, not a re-fill on the same page. CustomLogin
        // mounts useTurnstile() once per page load (see its own docblock),
        // so re-filling the identifier field in place would carry the SAME
        // Turnstile widget through every round of this loop, each round
        // tearing it down and recreating it once already via the
        // awaiting_code <-> idle transition below. Starting over from
        // /login instead gives each round the one fresh widget a real
        // parent reloading the page would get, rather than stacking
        // MAX_ROUNDS worth of widget teardown/recreate into a single page
        // load and risking the real Cloudflare check itself, not just our
        // own code, into a failure state. Still one /auth/start per round,
        // so the budget above is unchanged.
        sentAt = await startPhoneLogin(page, PASSWORDLESS_LOCKOUT_USER);
        await expect(page.getByTestId('sms-code-input')).toBeVisible({ timeout: 30_000 });
        // Same gate as the initial round: a fresh /auth/start means a fresh
        // pending challenge, so this round's own dispatch race has to be
        // waited out again too.
        await fetchOtp(PASSWORDLESS_LOCKOUT_USER, sentAt);
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
