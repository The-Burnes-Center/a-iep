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

## Reserved numbers

All fictional (NANP 555-01XX), none can ever receive SMS.

| Number | Role |
|---|---|
| +15555550101 / 0102 | Phase 2 smoke users (staging / prod). **NOT backdoored, DO NOT TOUCH.** |
| +15555550111 | Stable login user (login, language, upload specs). Persists across runs. |
| +15555550112 | Lockout user (wrong-OTP spec). Persists across runs. |
| +15555550120 | Re-signup journey burner. Healed (delete + admin-create) inside the spec each attempt. |
| +15555550121-0129 | Rest of the throwaway pool, in reserve. |
| +15555550123 | **Claimed by scripts/smoke-test.sh as its unknown-number probe**: excluded from the backdoor allowlist in CDK; never create a user for it. |

Global setup idempotently ensures 0111/0112 exist (admin-create-user +
`MessageAction=SUPPRESS`, `phone_number_verified=true`, permanent random
password, mirroring the smoke users).

## What runs when

- **Per staging deploy:** everything except `@pipeline` (~fast, gates the
  deploy result after the smoke job).
- **Nightly:** the full suite with `RUN_PIPELINE_E2E=1`, including the
  document-pipeline spec (upload a synthetic PDF, wait up to 10 minutes for
  the processed summary). Uploads REPLACE the child's previous document, so
  pipeline runs are self-cleaning.
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

## Deliberate scope cuts

- **Sign-up verification SMS is not completed.** Cognito itself sends that
  SMS (the backdoor only intercepts our own lambda's sends), so
  `resignup.spec.ts` stops at asserting the sign-up path *appears* for a
  deleted account: that assertion alone is the 2026-07 incident repro. The
  UNCONFIRMED leftover account is expected and healed on the next run.
  (Testing plan decision (c); revisit with CustomSMSSender if wanted.)
- **The onboarding survey (a third-party JotForm iframe) is bypassed**, not
  submitted: nightly submissions would pollute the team's real survey data.
  If it appears, `completeOnboardingIfShown` goes straight to
  `/consent-form` and finishes the real onboarding steps from there.
