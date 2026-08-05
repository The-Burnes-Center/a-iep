# E2E journeys (Phase 3)

Playwright suite that drives the **deployed staging site** through the
critical user journeys. It runs after every staging deploy (behind the
smoke checks, via `.github/workflows/e2e_staging.yml`) and nightly with the
slow pipeline spec enabled (`nightly_e2e.yml`, `RUN_PIPELINE_E2E=1`).

## The OTP backdoor contract

SMS is the hard part of testing this app, so staging's
`create-auth-challenge` has a test backdoor: for the **allowlisted fictional
numbers below** it sends no SMS and instead writes the code to SSM as a
String parameter, overwritten on every send:

```
/a-iep/staging/test-otp/<E.164 number without the '+'>   (SSM names forbid '+')
value: {"code":"123456","language":"en","issuedAt":"<ISO timestamp>"}
```

`helpers/aws.ts#fetchOtp` polls that parameter and only accepts a payload
whose `issuedAt` is **newer than a timestamp captured before triggering the
send**: parameters persist between runs, so without the freshness check a
test would happily log in with last night's code. The `language` field is
the language the SMS copy would have been localized with (pinned end to end
by `language.spec.ts`). Production never gets the backdoor.

### The other writer: Cognito's own SMS

Our lambda only sends the *login* OTP. The **sign-up verification** code is
sent by Cognito itself, which is why the re-signup journey used to stop
short. Staging now also has a **`CustomSMSSender` trigger** that intercepts
every SMS Cognito sends to an allowlisted number and stashes it at the *same*
parameter, tagged with its origin and with no `language` field:

```
value: {"code":"123456","issuedAt":"<ISO timestamp>","source":"cognito-<triggerSource>"}
```

`fetchOtp` reads both shapes (it only judges `issuedAt`); `source` is how a
spec tells them apart, and `resignup.spec.ts` asserts on it so a silently
absent trigger cannot be mistaken for a passing sign-up. When two sends land
seconds apart (sign-up code, then the login OTP the app requests the moment
`confirmSignUp` returns) use `helpers/app.ts#fetchNextOtp`, which dedupes
against the payload just consumed: the gap between them is narrower than
`fetchOtp`'s clock-skew allowance.

## Reserved numbers

All fictional (NANP 555-01XX), none can ever receive SMS.

| Number | Role |
|---|---|
| +15555550101 / 0102 | Phase 2 smoke users (staging / prod). **NOT backdoored, DO NOT TOUCH.** |
| +15555550111 | Stable login user (login, language specs). Persists across runs. |
| +15555550112 | Lockout user (wrong-OTP spec). Persists across runs. |
| +15555550113 | Profile / account-center user. Persists across runs. |
| +15555550114 | Documents user (upload, translations, PDF export, replace) and the TTS spec's source of a processed document. Persists across runs; left holding a processed Spanish-preference document. |
| +15555550120 | Re-signup journey burner: the only number that runs a real Cognito sign-up. Healed (delete + admin-create) inside the spec each attempt, admin-deleted in its `afterEach`. |
| +15555550121 | Referral journey's referrer: owns the personal invite code, stats accumulate across runs. Persists. |
| +15555550122 | Referral journey's invited-parent burner: healed (delete + admin-create) each attempt, admin-deleted in `afterEach`. |
| +15555550124-0129 | Rest of the throwaway pool, in reserve. |
| +15555550123 | **Claimed by scripts/smoke-test.sh as its unknown-number probe**: excluded from the backdoor allowlist in CDK; never create a user for it. |

Global setup idempotently ensures the persistent users exist
(admin-create-user + `MessageAction=SUPPRESS`, `phone_number_verified=true`,
permanent random password, mirroring the smoke users).

## What runs when

- **Per staging deploy:** everything except `@pipeline` (~fast, gates the
  deploy result after the smoke job).
- **Nightly:** the full suite with `RUN_PIPELINE_E2E=1`, including the
  document lifecycle spec (upload a synthetic PDF, wait up to 12 minutes for
  the processed summary, then deliberately replace it and wait again, which
  both pins the replace path and leaves a processed document behind for
  `tts.spec.ts`). Uploads REPLACE the child's previous document, so pipeline
  runs are self-cleaning.
- Runs are serialized (one worker here, a shared concurrency group in CI)
  because the journeys share stateful users.

## Running locally

```bash
cd e2e
npm ci
npx playwright install chromium
# AWS credentials for the staging account must be in the environment
# (resolves the site URL + user pool from AIEPStagingStack, reads SSM OTPs)
npx playwright test                     # fast journeys
RUN_PIPELINE_E2E=1 npx playwright test  # include the pipeline spec
npx playwright show-report              # after a failure
```

`SITE_URL` (and optionally `USER_POOL_ID`) override the CloudFormation
lookup, e.g. to point at a branch preview.

## The re-signup journey (`resignup.spec.ts`)

The 2026-07 incident: `PreventUserExistenceErrors` kept `Auth.signIn` from
throwing the error the frontend keyed on, so a returning deleted user was
told "code sent" while nothing was sent, and **sign-up was silently dead for
a month**. Nobody noticed because nothing could watch it.

The spec now runs that whole loop on +15555550120, every deploy and every
night:

1. heal the account (admin delete + admin create, so retries start clean);
2. UI login with the backdoor OTP, walking real onboarding;
3. delete the account through the UI (this really removes the Cognito user);
4. log in again and assert the app falls into the **sign-up path** ("Account
   created and SMS code sent!"): the original incident assertion, kept
   verbatim;
5. finish that sign-up for real: read Cognito's verification code from the
   `CustomSMSSender` stash (asserting `source` starts with `cognito-`),
   submit it, then answer the login OTP the app requests the instant
   `confirmSignUp` returns;
6. land in the app after a second onboarding, which can only happen if the
   **PostConfirmation** trigger wrote the new profile row;
7. delete the account again through the UI, with an `afterEach` admin delete
   as the backstop (it also runs when the test times out).

So `Auth.signUp` -> `confirmSignUp` -> PostConfirmation -> first login now
gets a pulse on every run instead of being the silent path it was during the
incident.

## Deliberate scope cuts

- **The onboarding survey is gone, and so is the bypass it needed.** The
  third-party JotForm iframe that `/preferred-language` used to show first
  (which CI had to route around, since submitting it nightly would have
  polluted the team's real survey data) was removed from the product on
  2026-07-29. `completeOnboardingIfShown` now walks only real app screens:
  language pick -> consent -> parent name.
