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

Our lambda only sends the *login* OTP. Codes Cognito itself mints (sign-up
verification, resend, forgot-password) never reach it, which is why the
re-signup journey used to stop short. Staging therefore also has a
**`CustomSMSSender` trigger** that intercepts every SMS Cognito sends to an
allowlisted number and stashes it at the *same* parameter, tagged with its
origin and with no `language` field:

```
value: {"code":"123456","issuedAt":"<ISO timestamp>","source":"cognito-<triggerSource>"}
```

`fetchOtp` reads both shapes (it only judges `issuedAt`) and `source` is how a
spec tells them apart. Since the **PreSignUp auto-confirm** landed, a phone
signup must produce **no Cognito-minted code at all**, so for that flow a
`source` payload is no longer something to read: it is the regression, and
`resignup.spec.ts` fails on it.

### Counting the codes

Reading the parameter's *value* can only ever show the LAST code: every send
overwrites it. To assert **how many** texts a number received, use
`helpers/aws.ts#readOtpSendCount`, which returns the parameter's SSM
**version**. Both writers `PutParameter(Overwrite)` on every send and the
payload always differs (fresh `issuedAt`, random code), so the version is a
running total; read it either side of a flow and the delta is the number of
codes issued. `resignup.spec.ts` pins that delta at exactly 1 for a signup,
which is what makes "one text, not two" a test rather than a claim.

## Reserved numbers

All fictional (NANP 555-01XX), none can ever receive SMS.

| Number | Role |
|---|---|
| +15555550101 / 0102 | Phase 2 smoke users (staging / prod). **NOT backdoored, DO NOT TOUCH.** |
| +15555550111 | Stable login user (login, language specs). Persists across runs. |
| +15555550112 | Lockout user (wrong-OTP spec). Persists across runs. |
| +15555550113 | Profile / account-center user. Persists across runs. |
| +15555550114 | Documents user (upload, translations, PDF export, replace, on-demand translation) and the TTS spec's source of a processed document. Persists across runs; left holding a processed Spanish-preference document. Its nightly document also spends one of its 12 on-demand translation attempts; each upload mints a new document, so the count never accumulates. |
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
  `tts.spec.ts`, then ask that document for a third language on demand and
  wait up to 10 more). Uploads REPLACE the child's previous document, so
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

## The re-signup journey (`resignup.spec.ts`)

The 2026-07 incident: `PreventUserExistenceErrors` kept `Auth.signIn` from
throwing the error the frontend keyed on, so a returning deleted user was
told "code sent" while nothing was sent, and **sign-up was silently dead for
a month**. Nobody noticed because nothing could watch it.

The spec runs that whole loop on +15555550120, every deploy and every night:

1. heal the account (admin delete + admin create, so retries start clean);
2. UI login with the backdoor OTP, walking real onboarding;
3. delete the account through the UI (this really removes the Cognito user);
4. log in again and assert the app falls into the **sign-up path** ("Account
   created and SMS code sent!"): the original incident assertion, kept
   verbatim;
5. finish that sign-up for real, on **one code** (see below);
6. land in the app after a second onboarding;
7. delete the account again through the UI, with an `afterEach` admin delete
   as the backstop (it also runs when the test times out).

### The one-text contract

`phone-otp-auth/pre-sign-up.js` auto-confirms phone-only self-service signups
(`autoConfirmUser` + `autoVerifyPhone`), so Cognito mints no verification code
and the custom-auth **login OTP is the only text a new parent gets**. The
message on screen cannot prove that (`CustomLogin` shows the same "Account
created and SMS code sent!" copy on its two-code fallback), so step 5 asserts
it four ways, any one of which failing means two texts:

- **the count**: `readOtpSendCount` either side of the sign-up shows exactly
  one code issued, re-checked once the parent is inside the app so a late
  second send is caught too;
- **which writer sent it**: the payload has a `language` field and no
  `source: cognito-...`, i.e. it came from `create-auth-challenge` and not from
  a Cognito mint diverted through `CustomSMSSender`;
- **Cognito's own view**: `readTestUserState` shows the fresh account
  `CONFIRMED` with `phone_number_verified` true, which is invisible from the
  browser (the confirmation screen and the OTP screen are the same screen);
- **what the browser did**: no `ConfirmSignUp` call, asserted after a positive
  `SignUp` assertion so the check cannot pass vacuously.

So `Auth.signUp` -> PreSignUp auto-confirm -> PostConfirmation (default profile
row, phone password rotated away) -> first login gets a pulse on every run,
instead of being the silent path it was during the incident.

## Deliberate scope cuts

- **The two-code signup fallback is not exercised.** `CustomLogin` still falls
  back to the old confirmation screen when `Auth.signUp` returns
  `userConfirmed === false`, but that only happens when the PreSignUp trigger
  did not take effect, which is exactly what `resignup.spec.ts` must fail on. A
  journey cannot assert both, so the fallback branch belongs to the frontend's
  unit tests.
- **The onboarding survey is gone, and so is the bypass it needed.** The
  third-party JotForm iframe that `/preferred-language` used to show first
  (which CI had to route around, since submitting it nightly would have
  polluted the team's real survey data) was removed from the product on
  2026-07-29. `completeOnboardingIfShown` now walks only real app screens:
  language pick -> consent -> parent name.
