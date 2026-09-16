/**
 * The reserved fictional test numbers (NANP 555-01XX: reserved for fiction,
 * can never receive SMS). Only the numbers below are allowlisted by the
 * staging OTP backdoor in create-auth-challenge; using anything else here
 * would make the lambda attempt a real SNS publish.
 *
 * DO NOT TOUCH:
 *   +15555550101 / +15555550102 are the permanent Phase 2 smoke-test users
 *   (staging / production). They are NOT backdoored and the smoke script
 *   depends on their exact state; this suite must never sign them in.
 *   +15555550123 is claimed by scripts/smoke-test.sh as its guaranteed
 *   UNKNOWN number (it must keep getting NotAuthorizedException). It is
 *   excluded from the backdoor allowlist in CDK, and no spec may ever
 *   create a user for it.
 */

/** Permanent login user. Persists across runs; its profile keeps onboarding
 * done (consent given, name set) after the first ever run completes. */
export const STABLE_USER = '+15555550111';

/** Dedicated to the wrong-OTP lockout journey. Persists across runs like the
 * stable user; kept separate so a lockout gone wrong (e.g. a future
 * account-level lock feature) can never strand the login spec. */
export const LOCKOUT_USER = '+15555550112';

/** Persistent user for the profile / account-center journey. Kept off the
 * login users so a half-edited profile can never break them. */
export const PROFILE_USER = '+15555550113';

/** Persistent user for the documents journey (upload / replace / delete).
 * Its documents are that spec's own churn; nothing else may sign it in. */
export const DOCUMENTS_USER = '+15555550114';

/**
 * The delete-account-then-re-signup journey burns this identity every run:
 * it logs in, deletes the account through the UI, signs up again for real,
 * lands back in the app on the single login OTP, and deletes it once more.
 *
 * So this number is the only one that exercises Auth.signUp, the PreSignUp
 * auto-confirm and the PostConfirmation trigger on a schedule: the path that
 * was silently broken for a month in the 2026-07 incident. It is also the only
 * number whose SMS count is asserted, which is why nothing else may send it a
 * code: an extra send would read as the two-text regression.
 *
 * The spec heals it (delete + admin-create) at the start of every attempt
 * and admin-deletes it in an afterEach, so a fixed number from the 0120-0129
 * throwaway pool is enough; the rest of the pool stays in reserve.
 */
export const THROWAWAY_USER = '+15555550120';

/** Persistent referrer for the referral journey: owns a personal invite code
 * whose click/signup counters accumulate across runs (the spec asserts
 * deltas, never absolute values). Nothing else may sign it in. */
export const REFERRER_USER = '+15555550121';

/**
 * The invited-parent burner for the referral journey. Healed (delete +
 * admin-create) at the start of every attempt and admin-deleted in an
 * afterEach, exactly like THROWAWAY_USER: attribution requires the profile
 * row to be YOUNGER than the link click, so a leftover account from a dead
 * run would poison the next one with 'click_after_signup' rejections.
 */
export const REFERRAL_SIGNUP_USER = '+15555550122';

/**
 * Persistent user for the encrypted-PDF upload journey.
 *
 * Kept off DOCUMENTS_USER deliberately, even though that journey also drives
 * the upload page: asking the real backend for an upload URL DELETES the
 * child's existing document before it answers (upload-s3/index.mjs), so
 * sharing the number would destroy the processed document documents.spec.ts
 * and tts.spec.ts both depend on. The encrypted-PDF journey stubs that
 * endpoint (see the spec's docblock), so this account's only real state is
 * its profile and the child consent creates.
 *
 * Taken from the 0120-0129 block, which new-auth.ts's TEST_PHONE_NUMBERS
 * describes as the re-signup journey's throwaway pool: 0126 is allowlisted
 * there and unclaimed, and this journey holds it persistently (like
 * 0111-0114) rather than burning it, so a run pays for onboarding only the
 * first time.
 */
export const ENCRYPTED_PDF_USER = '+15555550126';

/**
 * Dedicated to the passwordlessAuth wrong-code journey (a single bad code,
 * then a successful retry). Kept off PASSWORDLESS_LOCKOUT_USER so a stray
 * failed-verification count from this spec can never shorten the number of
 * wrong codes the lockout journey needs.
 */
export const PASSWORDLESS_WRONG_CODE_USER = '+15555550124';

/**
 * Dedicated to the passwordlessAuth lockout journey. auth-store.js counts
 * failed /auth/verify submissions per DESTINATION per CALENDAR HOUR
 * (MAX_FAILED_VERIFICATIONS_PER_HOUR = 10), a different mechanism from the
 * legacy screen's per-Cognito-session limit that LOCKOUT_USER exercises, so
 * this journey needs its own number: reusing LOCKOUT_USER would not conflict
 * technically (the legacy screen never calls /auth/verify), but a dedicated
 * number keeps the two lockouts, and their very different retry budgets,
 * from ever being read together by mistake.
 */
export const PASSWORDLESS_LOCKOUT_USER = '+15555550125';
