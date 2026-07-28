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

/**
 * The delete-account-then-re-signup journey burns this identity every run
 * (UI deletion removes the Cognito user; the re-signup attempt leaves an
 * UNCONFIRMED leftover). The spec heals it (delete + admin-create) at the
 * start of every attempt, so a fixed number from the 0120-0129 throwaway
 * pool is enough; the rest of the pool stays in reserve.
 */
export const THROWAWAY_USER = '+15555550120';
