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
 * it logs in, deletes the account through the UI, signs up again for real
 * (Cognito's own verification SMS is diverted to SSM by staging's
 * CustomSMSSender trigger), lands back in the app and deletes it once more.
 *
 * So this number is the only one that exercises Auth.signUp, confirmSignUp
 * and the PostConfirmation profile trigger on a schedule: the path that was
 * silently broken for a month in the 2026-07 incident.
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
