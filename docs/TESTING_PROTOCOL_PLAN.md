# A-IEP Testing Protocol: Findings and Implementation Plan

**Working plan, July 24, 2026.** Written at the end of the phone-OTP incident session so a fresh session can pick this up with zero context. **This document proposes work; it changes no code.** Verified facts below were checked live against the repo, GitHub, and AWS on 2026-07-24.

## Implementation status (updated 2026-07-27)

**Phases 1 and 2 are implemented and pushed to staging.**

- **Unit tests, 100 total, all green.** Jest (`npx jest`, config in `jest.config.js`): 51 tests under `test/lambdas/phone-otp-auth/` covering define/create/verify auth challenge (Appendices A+B checked in and extended), messages.js localization/placeholders, and sanitize.js log redaction. Pytest (`pytest`, config in `pytest.ini`, deps in `test/python/requirements.txt`): 49 tests under `test/python/` covering the referral handler end to end on moto (clicks, attribution matrix, admin CRUD, admin-group management), the user-profile router and log sanitizers, the PostConfirmation trigger, and the metadata orchestrator's S3 filter/parsing rules. Tests live under `test/`, NOT inside function dirs: `Code.fromAsset` zips those verbatim and the deploy asset cache keys on `hashFiles('lib/chatbot-api/functions/**')`.
- **CI gate:** `.github/workflows/ci.yml` on `pull_request` + push to `staging`, four parallel jobs (auth-lambda jest, python pytest on 3.12, frontend tsc + changed-file eslint, root tsc + both cdk synths).
- **Post-deploy smoke:** `scripts/smoke-test.sh` (shared) appended as a `smoke-test` job to both deploy workflows; resolves client id/API/site URL from stack outputs by key pattern (verified against both live stacks 2026-07-27). Checks: unknown number gets NotAuthorizedException (the PR #51 regression), optional test-user handshake via SSM `/a-iep/<env>/smoke-test-phone` (SKIPs until the test user + parameter exist), CloudFront index + hashed bundle 200, API answers 401 on `/profile`.
- **Found along the way:** frontend `npm run lint` had been crashing (blanket `ajv@^8` override vs eslint 8's ajv6 API). Fixed by carving `eslint`/`@eslint/eslintrc` back to ajv 6.12.6 in `lib/user-interface/app/package.json` overrides. That unmasked 158 pre-existing lint problems in 41 files. **Backlog cleared 2026-07-27 (wave 3):** all problems fixed with zero runtime behavior change (unused code removed, `any` replaced with real types, 17 documented exhaustive-deps disables preserving effect timing, one stable-setter dep added); verified via full lint, tsc, and a vite production build; ci.yml frontend job runs the full `npm run lint` again (changed-files carve-out removed).
- **Smoke-test users live (2026-07-27):** permanent confirmed Cognito users with fictional, undeliverable numbers: +15555550101 (staging) and +15555550102 (production), created via admin-create-user + permanent random password (never used; the flow is OTP-only), phone_number_verified=true, no SMS ever sent (round 1 is the no-SMS handshake and smoke abandons the session). Numbers stored at SSM `/a-iep/staging/smoke-test-phone` and `/a-iep/production/smoke-test-phone`. Check 2 verified PASSing live on both environments. Smoke runs create no profile rows and send no SMS.
- **Still open (needs DB):** alarm destination for Phase 5, and Phase 4 prod-gating style. Phase 5 not started. RESOLVED 2026-07-28: ~~branch protection + required checks on main~~ (done, see "Deploy gating"); ~~staging strictness~~ (DB: staging stays open for direct pushes, it is the dev instance); ~~Phase 3 signup strategy~~ (shipped CustomSMSSender, option (a)); ~~Phase 3 itself~~ (shipped, see Wave 7).

### Wave 2 (2026-07-27, same day): full backend API coverage

181 unit tests total (79 jest + 102 pytest). Added on top of the incident-critical wave 1:

- **user-profile-handler endpoints** (`test/python/test_user_profile_api.py`), driven through `lambda_handler`: default-profile creation, PII KMS encryption round-trip (encrypt-at-rest verified against the raw item), all PUT validation 400s, KMS-outage 503 (never store plaintext), best-effort Cognito locale sync, children ops, child-document GET/DELETE incl. the userId IDOR guard, full account deletion incl. the best-effort-Cognito quirk (pinned) and the real-pool success path. Found+fixed: the "No fields to update" 400 was unreachable (`len == 1` check against a list seeded with 2 timestamp entries); an empty PUT used to 200.
- **tts-handler** (`test_tts_handler.py`): markdown->speech text utils, endpoint auth/validation/ownership, content-hash cache hit/miss, provider-failure 502s (fake provider; real ones are HTTPS calls).
- **metadata ddb-service** (`test_ddb_service.py`): progress/status writes, OCR payloads to S3 with allowlisted data_type, FAILED-document purge of unredacted artifacts (retention rule), content merge semantics (empty dicts never clobber translations), lazy DynamoDB->S3 migration, log redaction of FERPA content params.
- **knowledge-management delete-s3** (`test_knowledge_delete_s3.py`): own-prefix-only deletion, traversal rejection.
- **remaining auth triggers** (`custom-message.test.js`, `pre-authentication.test.js`): per-trigger-source template localization; loginLanguage stamping, condition on existing rows, every failure mode non-blocking.
- **pdf-generator sanitizer** (`content-safety.test.js`): processContent/escapeHtml/isAllowedFontRequest exported from index.js and tested (XSS/SSRF boundary: scripts, event handlers, network-triggering tags, javascript: links, font-host allowlist). marked+sanitize-html added as root devDependencies (version-matched); puppeteer/chromium virtually mocked.
- **pdf-generator deploys now reproducible (wave 3):** package-lock.json vendored (marked 9.1.6, sanitize-html 2.17.4, htmlparser2 10.1.0, puppeteer-core 21.11.0, chromium 119.0.2), bundling switched to `npm ci`, node_modules excluded from the asset hash, .gitignore's global package-lock rule negated for this lambda (and its broken merged yarn.lock/DocumentAI line split). Verified via a real Docker-bundled synth.
- **Known remaining gap:** metadata pipeline steps (mistral_ocr/parsing_agent/translate_content are external-API glue; covered indirectly via ddb-service, properly via future Phase 3 E2E).
- **ESM handlers covered (2026-07-27, wave 3):** upload-s3 and get-s3 now have jest suites (`test/lambdas/knowledge-management/*.test.mjs`, 15 tests: request validation, JWT-sub key layout, replace-before-put with foreign-record survival, presigned URL contents, prefix-scoped listing, 401/403/500 paths). Jest runs with `--experimental-vm-modules` via `npm test` (plain `npx jest` can't load .mjs suites); AWS SDK v3 clients are prototype-mocked with aws-sdk-client-mock (root devDeps), and getSignedUrl runs the real presigner offline. 94 jest + 102 pytest = 196 total.

### Wave 4 (2026-07-28): OTP dead-code fixes from the four-agent test review

204 unit tests total (102 jest + 102 pytest). The 2026-07-28 review found two dead security controls in the OTP lambdas, one pinned by a test built on a fabricated Cognito contract; both are now real, with tests rewritten against the actual trigger shapes:

- **SMS rate limiting now works (was unreachable):** the old in-session filter read `.timestamp` off `challengeMetadata` (always a string), so the MAX_SMS_PER_HOUR throw could never fire; a per-session tally can never cap volume anyway (Cognito resets the session on every InitiateAuth, so SMS bombing just loops it). create-auth-challenge now counts each actual send in a TTL'd DynamoDB counter table (`OtpRateLimitTable` in new-auth.ts; keys are sha256(phone) + hour bucket, no raw numbers at rest), refuses past 5/hour with a distinct message through `publicChallengeParameters.error` (frontend already surfaces any error there presence-based), and fails open on DynamoDB trouble so an outage can't lock out logins. Handshake and reuse rounds (which send no SMS) consume no budget.
- **OTP expiry now enforced where the data exists (was dead code):** verify-auth-challenge read `event.request.session`, a field the VerifyAuthChallengeResponse trigger never receives, so its expiry block never ran; the old test fabricated a session field and pinned the dead path. create-auth-challenge now stamps `issuedAt` into privateChallengeParameters and carries the ORIGINAL stamp through in-session reuse (the old code re-stamped, sliding the window); verify rejects correct-but-stale answers past 5 minutes from that stamp (missing/garbled stamps skip the check so in-flight sessions from an older deploy aren't locked out). The pool client now sets `authSessionValidity: 5 minutes` explicitly (was the implicit 3-minute default), so the SMS copy "expires in 5 minutes" is finally true.
- **pre-authentication contract fixed:** removed the handler's `clientMetadata` fallback (a field this trigger never carries; ClientMetadata arrives as validationData) and replaced the test that canonized the fabricated shape with one pinning the opposite (clientMetadata alone stamps nothing); the near-vacuous `toBeDefined()` assertion got real assertions.
- **Untouched:** define-auth-challenge and its userNotFound fail-fast (the PR #51 incident fix); suite passes unchanged. Deploy note: the counter table and session validity ship with the next `cdk deploy`; until then the lambda logs "OTP_RATE_LIMIT_TABLE not set" and skips the limiter (fail-open by design).

### Wave 5 (2026-07-28): first pipeline-step suites, redactor fails closed

242 unit tests total (102 jest + 140 pytest), pushed as commit f55df3a. Three of the nine Step Functions step lambdas now have suites (built in a spun-off session, merged here): `test_redact_ocr.py` (offset-splice replacement, NAME/DATE_TIME allowlist, multibyte text), `test_delete_original.py` (original-PDF delete + raw-OCR purge, contract-tested by invoking the real ddb-service module through a fake Lambda client in conftest), `test_check_language_prefs.py` (primary/secondary language combinations). Behavior change shipped with it: `comprehend_redactor.py` now FAILS CLOSED (a Comprehend error used to return the original text with counter 0, storing unredacted PII as the "redacted" result right before delete_original purged the raw copies; it now raises, so Step Functions retries and persistent failure routes to RecordFailure, which purges every unredacted artifact). check_language_prefs' English-only fallback on profile-read errors is pinned by a test but deliberately unchanged (open decision). Remaining untested steps are external-API glue (mistral_ocr, parsing_agent, translate_content, finalize_results): Phase 3 territory.

### Wave 6 (2026-07-28): the review's remaining findings, closed in one batch

280 unit tests total (126 jest + 154 pytest), pushed as 7 commits ending 49901a9 (five parallel agents + integration). What landed:

- **CDK assertion suite** (`test/infra/`, 11 tests, ~20s, jest split into `lambdas`/`infra` projects): every HTTP API route must carry the JWT authorizer except the public `/referral/click` beacon (route-count floor prevents vacuous passes); five custom-auth triggers, PreventUserExistenceErrors, 5-min session validity, OTP table TTL, bucket public-access blocks, per-stage RecordFailure catches, and runtime pins. Mutation-checked (dropped authorizer, new public route, downgraded runtime all fail).
- **Backend fixes:** malformed JSON to PUT /profile and add_child now 400 (was 500); orchestrator processes every S3 record (was Records[0] only) and requires the 4-segment key layout; test_orchestrator's global boto3.client monkeypatch replaced with a point-of-use factory patch and a fake that validates execution names.
- **New tests:** tts providers.py (7, SSM selection/fingerprint/chunking, offline), PostConfirmation conditional-put race, messages.js DDB call-arg + translations-differ pins, custom-message VerifyUserAttribute/UpdateUserAttribute branches, sanitizer bypass pins (data: URI, protocol-relative, images: all verified actually blocked by the shipped config), upload-s3 fileName guard (new 400 for path separators/.. segments) + presign-failure 500 path.
- **Deploy hardening:** npm ci everywhere; stack outputs no longer cat'ed into public logs or uploaded as artifacts; configure-aws-credentials v4; ALL eleven metadata-handler requirements files exact-pinned (dry-run verified under the manylinux2014/cp312 bundling constraints: mistralai/openai-agents held to the pydantic-2.10.6-compatible line, pillow 12.2.0 as the newest bundleable) plus test/python/requirements.txt; smoke-test retries transient failures and FAILs (not SKIPs) on a missing smoke-phone SSM param.
- **Dead code:** six caller-less ddb-service ops + dead test removed, testfile.txt / package-lock-old.json / RAGAS stub notebook deleted, orphan websocket-api.js and iep-document-utils.js removed from lambda assets, .gitignore lockfile trap fixed.
- **Frontend fix (user-reported):** TTS play buttons no longer show two simultaneous "playing" states; each button now tracks its own audio element's pause event (also fixes OS media-key pauses). Verified via harness; tsc+lint clean.

Still deliberately open: OIDC for deploy credentials (needs an AWS-side decision), frontend test framework (Phase 3), datetime.utcnow cleanup (timestamp-format sensitive), Phases 3-5.

### Wave 7 (2026-07-28/29): Phase 3 shipped, and it immediately paid for itself

**Phase 3 is live.** 15 Playwright tests across 7 specs in `e2e/` (own npm project, pinned deps) run against the deployed staging site: `login`, `lockout`, `language`, `resignup`, `profile` on every deploy (after the smoke job, via a reusable `e2e_staging.yml` called from `deploy_staging.yml`), plus `documents` (9-stage lifecycle) and `tts` nightly at 09:00 UTC with `RUN_PIPELINE_E2E=1`. Runs are serialized (one worker, CI concurrency group) because journeys share stateful users. Verified green both in CI and headed locally.

Two staging-only backdoors make it possible, both double-gated (a number must be in `TEST_PHONE_NUMBERS` **and** match a hard-coded NANP-fictional regex, so a misconfigured allowlist can never divert a real subscriber's code) and both pinned absent from the production template by the infra suite:
- `create-auth-challenge` stashes our sign-in OTP at SSM `/a-iep/staging/test-otp/<phone without '+'>`.
- a `CustomSMSSender` trigger (staging-only KMS key) stashes the codes **Cognito** mints, tagged `source: cognito-<triggerSource>`. This is what upgraded decision (c) to (a) and let the re-signup journey complete a real sign-up.

Reserved numbers: 0101/0102 smoke (never backdoored), 0111 login, 0112 lockout, 0113 profile, 0114 documents, 0120 re-signup burner, 0123 the smoke unknown-number probe (deliberately NOT allowlisted).

**The first nightly-class run caught a live regression, which is the whole point of this phase.** The document pipeline had been failing on staging since 17:39 on 2026-07-28: wave 6's dependency pinning set `openai==2.49.0`, whose 2.45.0 release made `InputTokensDetails.cache_write_tokens` required, while `openai-agents 0.4.2` (the newest the deliberate `pydantic==2.10.6` pin allows) constructs it without that field. Every upload raised a pydantic `ValidationError` at the parsing step and routed to `RecordFailure`; the Step Functions execution still reported SUCCEEDED, which is why nothing else noticed. Bisected in the Lambda runtime to `openai==2.44.0` as the newest compatible version, now pinned with the ceiling explained in-file. **The hazard was latent, not created by pinning:** the old `>=` floors would resolve the same broken pair on any deploy that missed the `cdk.out` asset cache, including in production. New `lambda-deps` CI job installs each distinct metadata-handler requirements file on the runner and constructs the exact object that broke (mutation-tested: fails on the old pin).

**Security review fixes (same window):** the knowledge-management lambdas held `s3:*` on the bucket holding every family's IEP documents; get-s3 now holds `s3:ListBucket` alone and upload-s3 holds `PutObject`/`GetObject`/`DeleteObject` + `ListBucket` (the reported remediation was short: the replace-before-put flow in `utils/iep-document-utils.mjs` lists and deletes, and presigned URLs authorize against the lambda's role). The profile handler returned `str(e)` in seven response bodies, leaking table names and AWS error codes to authenticated callers; responses are now generic per endpoint, two sites that lacked any server-side log gained one, and the 404 route echo stays (it only repeats the caller's own path). Both are pinned by mutation-tested guards: infra assertions reject any Allow statement with `s3:*` (and pin each lambda's exact action set), and a pytest forces a `ClientError` carrying a fake table name and asserts it never reaches the body.

Also removed the frontend's dead second route table (`src/app.tsx` and its exclusive dependents `global-header.tsx`/`.css` and `AboutTheProject.tsx`); `WelcomePage.tsx` deliberately kept, since AppRoutes parks its route with a "remove once we're sure" note.

Product gaps surfaced while writing the specs (not test gaps, worth deciding on): there is **no document-deletion UI** at all (`iep-document-client.ts#deleteFile` has zero callers, so a parent's only deletion path is deleting their whole account); ~~**meeting notes are extracted but never rendered**~~ (RESOLVED 2026-07-29: the whole meeting-notes extraction feature was deleted, pipeline step included); and `pages/profile/City.tsx` is unrouted, so the KMS-encrypted `city` field has no UI.

### Deploy gating (2026-07-28): the review's #1 finding, closed

The four-agent review's critical finding: both deploy workflows fired on push in parallel with CI (no `needs:`, no required status checks anywhere), so a red suite deployed anyway, and ci.yml never ran on main at all. Fixed on two independent layers:

- **Structural gate (pushed to staging 2026-07-28, commit c1d22c5):** ci.yml now also triggers on push to main and exposes `workflow_call`; both deploy workflows run it as their first job (`ci: uses: ./.github/workflows/ci.yml`) with `deploy: needs: ci`, so a deploy is impossible on a commit whose jest/pytest/frontend/synth jobs fail, at the same SHA by construction, including `workflow_dispatch` deploys of arbitrary refs. Local-path reusable calls use the same commit's copy of ci.yml, so this works from staging without waiting for a main merge (a `workflow_run` gate would not: those only honor the default branch's workflow file). Cost accepted: on each staging/main push the four CI jobs run twice (standalone run + embedded gate); ci.yml's concurrency group now keys on `github.workflow` so the two runs can never cancel each other. Both deploy workflows also gained `concurrency` groups keyed per stack with `cancel-in-progress: false` (no concurrent `cdk deploy` against one stack, never cancel mid-update, newest queued run supersedes older queued runs), `timeout-minutes: 60` on the deploy jobs, and `permissions: contents: read` (ci.yml too).
- **Branch protection (applied live via gh api, admin token):** main now requires all four CI job contexts ("Auth lambda unit tests", "Python lambda unit tests", "Frontend typecheck and lint", "CDK typecheck and synth", strict=false) before a PR can merge; the pre-existing settings were mirrored exactly (1 approving review, lock_branch=true kept, enforce_admins kept OFF deliberately: with lock_branch on, enforcing admins would make main read-only for everyone and freeze the release path). Staging was left unprotected ON PURPOSE: required status checks reject direct pushes outright, which would end the push-to-staging workflow; that strictness call is DB's (section 8). If wanted later:
  `gh api --method PUT repos/The-Burnes-Center/a-iep/branches/staging/protection --input <file>` with `required_status_checks.checks` = the four contexts, `enforce_admins: false`, `required_pull_request_reviews: null`, `restrictions: null`.
- **Live test:** the next push to staging should show a two-stage graph in the deploy run (CI (4 jobs) -> deploy -> smoke-test) plus the standalone CI run; a deliberately red test would leave the deploy job skipped.

---

## 1. Why this exists: what the OTP incident revealed

On 2026-07-24 we diagnosed and fixed a bug where any phone number without an existing Cognito account (brand-new users, or returning users who had deleted their account) never received an SMS OTP. Full writeup in [PR #51](https://github.com/The-Burnes-Center/a-iep/pull/51). Root cause in one line: the Cognito app client has `PreventUserExistenceErrors: ENABLED`, so `Auth.signIn` never throws the `UserNotFoundException` the frontend relied on to trigger sign-up; the custom-auth triggers ran with `userNotFound: true`, produced a challenge that could never send an SMS, and the frontend showed "code sent" anyway.

The incident matters for testing because of how it stayed invisible:

- **Signup was broken in prod and staging for at least a month** (zero `PostConfirmation` ConfirmSignUp invocations in 30+ days of CloudWatch logs on either environment) and nobody noticed until a manual delete-and-retry.
- **The backend reported the failure on every attempt** (`ChallengeParameters.error: "Failed to send verification code..."`) and the frontend never read that field, so the error was swallowed silently.
- **The sign-up fallback was unreachable dead code** for as long as the pool client has had existence-error prevention enabled. No test exercised the "new user" path.
- **Nothing gates a deploy.** Both workflows go checkout, install, `cdk deploy`. A merge to `main` is an immediate prod deploy with no checks of any kind.

Every layer proposed below would have either prevented this bug, caught it within minutes of deploy, or flagged it within days of it existing.

## 2. Current state (verified 2026-07-24)

- **Tests:** none. [test/gen-ai-mvp.test.ts](../test/gen-ai-mvp.test.ts) is the commented-out CDK scaffold. Root `package.json` has `"test": "jest"` configured but nothing to run. No frontend tests, no Python tests, no integration tests.
- **CI:** two workflows only. [deploy.yml](../.github/workflows/deploy.yml) deploys `AIEPStack` on every push to `main` with `ENVIRONMENT=production`. [deploy_staging.yml](../.github/workflows/deploy_staging.yml) deploys `AIEPStagingStack` on every push to `staging` with `ENVIRONMENT=staging`. There is no `pull_request` workflow, so PRs show no checks.
- **Branch protection:** effectively none in practice (PR #51 was mergeable instantly with no required checks). Merged head branches are not auto-deleted (repo target state per DB: only `staging` and `main` branches).
- **Static checks that exist but only run locally:** frontend `tsc` (via `npm run build`) and eslint (`npm run lint`, `--max-warnings 0`); root CDK `tsc`.
- **Verification tooling proven this session** (reusable): `tsc --noEmit` on both roots, `ENVIRONMENT=production npx cdk synth AIEPStack --no-staging`, translation JSON validation, a 5-case unit test for `define-auth-challenge` (Appendix A), and a live Cognito contract check (section 4).

## 3. Target: five layers, in order of value

Industry-standard shape (test pyramid plus gated continuous deployment): many fast unit checks before merge, a small smoke suite after every deploy, a handful of E2E journeys, gated promotion, and scheduled canaries so breakage surfaces without waiting for a push. Phases 1 and 2 are about a day of combined work and cover most of the risk.

## 4. Phase 1: PR CI gate (highest value, ~half day)

New `.github/workflows/ci.yml` triggered on `pull_request` (and optionally `push` to `staging`). Jobs, all parallel:

1. **frontend**: `npm ci` in `lib/user-interface/app`, then `npx tsc --noEmit` and `npm run lint`. Add Vitest later; typecheck plus lint alone would have flagged nothing for this bug but catch the everyday breakage class.
2. **auth-lambda unit tests**: check in Appendix A as `lib/chatbot-api/functions/phone-otp-auth/__tests__/define-auth-challenge.test.js` (jest already configured at root; point jest at it or run with `node --test`). This permanently guards: `userNotFound` fails auth, first round issues a challenge, the language handshake never issues tokens, a passed OTP round issues tokens, three failed OTP rounds lock the session.
3. **python lambdas**: start minimal, pytest on pure functions (e.g. `user-profile-handler` routing, metadata-handler text utils). Grow opportunistically; do not block Phase 1 on coverage.
4. **infra**: root `npm ci`, `npx tsc --noEmit`, then `ENVIRONMENT=production npx cdk synth AIEPStack --no-staging --quiet` and the staging equivalent. Catches broken construct wiring before any deploy. (Verified today this runs fine without AWS credentials or the ACM/DOMAIN secrets.)

Then in GitHub repo settings (needs admin): protect `main` (and ideally `staging`), require the CI checks and one approving review to merge, and enable "Automatically delete head branches" (matches DB's two-branch policy).

**Acceptance:** a PR that breaks any of the above cannot be merged; a PR shows green checks within ~5 minutes.

## 5. Phase 2: post-deploy smoke tests (~half day)

Append a `smoke-test` job to both deploy workflows (`needs: deploy`), so every deploy verifies itself and the workflow goes red on failure. Checks, each a few lines of AWS CLI/bash, all read-only and SMS-free:

1. **The regression that started all this:** `aws cognito-idp initiate-auth --auth-flow CUSTOM_AUTH --client-id <client> --auth-parameters USERNAME=+15555550123` must fail with `NotAuthorizedException`. If it instead returns a `CUSTOM_CHALLENGE` (the pre-fix behavior: a challenge whose `ChallengeParameters` contain an `error` key), fail the build.
2. **Existing-user flow up to the SMS boundary:** same call with a permanent test user's number must return `ChallengeName: CUSTOM_CHALLENGE` with `challengeType: LANGUAGE_HANDSHAKE` and no `error` param. Round 1 deliberately sends no SMS (the language handshake), so this is free and side-effect-light. Requires creating one permanent, confirmed test user per environment (admin-create-user, phone_number_verified) and documenting it.
3. **Frontend actually shipped:** fetch the CloudFront index, extract the hashed bundle path, assert HTTP 200 and (optionally) assert a marker string from the new release. Resolve URLs at runtime from stack outputs (`aws cloudformation describe-stacks --stack-name <stack> --query "Stacks[0].Outputs"`) rather than hardcoding.
4. **API is up:** hit a cheap API Gateway route. Note: check whether a health route exists; if not, add `GET /health` to the profile handler as part of this phase.

The deploy job already has AWS credentials, so no new secrets are needed. Environment IDs for these scripts are in section 9.

**Acceptance:** deploy workflow fails loudly if auth contracts, the site bundle, or the API are broken, within ~2 minutes of the deploy finishing.

## 6. Phase 3: E2E journeys with an OTP backdoor (~2-3 days)

Playwright suite run against staging after each staging deploy, and nightly. Keep it to the critical journeys: log in (existing user), wrong-OTP lockout, delete account, **re-signup after deletion** (the incident repro), upload IEP and see the summary, switch language.

The hard part is SMS. Two-part standard approach:

- **Login OTP (our lambda sends it):** allowlist test numbers via a `TEST_PHONE_NUMBERS` env var on `create-auth-challenge` (staging only, set from CDK). For allowlisted numbers, skip the SNS publish and write the OTP to SSM Parameter Store instead (per project convention new params use the `a-iep` prefix, e.g. `/a-iep/staging/test-otp/<phone>`); the test runner reads the parameter and completes login. Small, contained change; production never sets the env var.
- **Signup verification SMS (Cognito itself sends it):** the backdoor above cannot intercept it. Options: (a) run signup E2E only with Cognito's `CustomSMSSender` trigger, which intercepts all pool SMS including verification codes (bigger lift, KMS involved); (b) rent one real number (e.g. Twilio) the runner can poll; (c) skip true-signup E2E and rely on the Phase 2 contract checks plus pre-confirmed test users. Recommendation: start with (c), revisit (a) when there's appetite. **RESOLVED 2026-07-28: shipped (a).** DB asked for the real re-signup journey, so staging got a CustomSMSSender trigger (staging-only KMS key, same double-gated allowlist, same SSM stash tagged `source: cognito-<triggerSource>`). The full loop now runs: delete account -> sign-up path -> Cognito's real verification code -> confirm -> PostConfirmation profile -> logged in.

**Acceptance:** the delete-account-then-re-signup journey (today's incident) runs green on staging nightly without a human or a phone.

## 7. Phase 4: gated prod promotion (~1 hour)

Keep prod deploying from `main` only, but wrap the deploy job in a GitHub **Environment** named `production` with a required reviewer (DB). Merging a PR then queues the deploy until a human approves it in the Actions UI, which decouples "merge when reviewed" from "ship when ready" with zero workflow-logic changes. Optional stricter variant: make deploy.yml `workflow_dispatch`-only. Decision for DB (see section 8).

## 8. Phase 5: canaries and alarms (~half day)

- **Scheduled canary:** run the Phase 2 smoke suite on cron (e.g. every 6 hours) against **both** environments via a scheduled GitHub Action. This is the layer that catches "broken with no deploy" (exactly the OTP bug's failure mode, which shipped long before it was noticed).
- **CloudWatch alarms:**
  - Signup heartbeat: `PostConfirmation` lambda invocations sum < 1 over 7 days (7 daily datapoints). This alone would have caught the incident within a week.
  - Errors > 0 on the five auth trigger lambdas (define/create/verify/pre-auth/custom-message).
  - SNS: `NumberOfNotificationsFailed` and `SMSMonthToDateSpentUSD` approaching the account limit (an exhausted SMS budget silently kills all OTP delivery, same symptom as the incident).
- Route alarms to an SNS topic with DB's email; upgrade to Slack later.

### Open decisions for DB

- [ ] Protect `staging` with the same required checks as `main`, or keep staging low-friction?
- [ ] Prod gating: GitHub Environment approval (recommended) vs keep pure auto-deploy vs `workflow_dispatch` only?
- [x] Test-number strategy for signup E2E: **CustomSMSSender** (decided and shipped 2026-07-28; see Phase 3 above).
- [ ] Where do alarm notifications go (email now, Slack later)?

## 9. Reference facts for implementation (verified 2026-07-24)

| Thing | Value |
|---|---|
| Region | `us-east-1` |
| Staging pool / client | in the stack outputs |
| Prod pool / client | in the stack outputs |
| Stacks | `AIEPStagingStack` (staging branch), `AIEPStack` (main, `ENVIRONMENT=production`) |
| Staging site | the distribution hostname in the stack outputs |
| Auth trigger log groups | `/aws/lambda/AIEPStagingStack-NewAuthorizationstaging{DefineAuth,CreateAuth,VerifyAuth,PreAuthent,CustomMess}-*` and the `AIEPStack-NewAuthorization*` prod equivalents |
| Signup-heartbeat lambda | `AIEPStagingStack-ChatbotAPIstagingCognitoTriggerFu-*` / `AIEPStack-ChatbotAPICognitoTriggerFunctionBF558261-*` (PostConfirmation) |
| Pool client behavior | `PreventUserExistenceErrors: ENABLED` on both clients; keep it (protects the email/password flow); the triggers now handle `userNotFound` explicitly |
| Custom auth flow shape | Round 1 is a no-SMS `LANGUAGE_HANDSHAKE` (client answers `HANDSHAKE_ACK` with language metadata), round 2 sends the OTP, `verify-auth-challenge` checks it; 3 failed OTP rounds fail the session |
| Related changes | Fix: PR #51 (merged, live in both envs). Remaining staging-to-prod sync minus TTS: PR #52 (`prod-sync-2026-07-24`, delete branch after merge). TTS (590b600) intentionally staging-only for now |
| Known repo quirks | `delete_user_profile` in [lambda_function.py](../lib/chatbot-api/functions/user-profile-handler/lambda_function.py) still returns 200 even if the Cognito `admin_delete_user` step fails (errors swallowed); worth a hardening ticket. Stale local branches exist on DB's machine (`ayush-*`, `staging-to-main*`, etc.), cleanup offered but not done |

Smoke-check exit criteria used to verify the fix live (reuse verbatim in scripts): unknown number returns `NotAuthorizedException`; before the fix it returned `ChallengeName: CUSTOM_CHALLENGE` with `ChallengeParameters.error = "Failed to send verification code. Please try again."`.

## Appendix A: unit tests to check in with Phase 1

Written and passing 2026-07-24 against the fixed `define-auth-challenge.js` (adjust the require path when placing under `__tests__/`):

```js
const assert = require('assert');
const { handler } = require('../define-auth-challenge.js');

const base = (session, extra = {}) => ({
    userName: 'test-user',
    request: { userAttributes: { phone_number: '+15555550100' }, session, ...extra },
    response: {}
});

(async () => {
    // 1. userNotFound -> fail auth immediately, no challenge
    let e = await handler(base([], { userNotFound: true, userAttributes: {} }));
    assert.strictEqual(e.response.failAuthentication, true, 'userNotFound must fail auth');
    assert.strictEqual(e.response.issueTokens, false, 'userNotFound must not issue tokens');
    assert.strictEqual(e.response.challengeName, undefined, 'userNotFound must not issue a challenge');

    // 2. normal first round -> CUSTOM_CHALLENGE
    e = await handler(base([], { userNotFound: false }));
    assert.strictEqual(e.response.challengeName, 'CUSTOM_CHALLENGE');
    assert.strictEqual(e.response.failAuthentication, false);

    // 3. handshake passed -> next round is a challenge, no tokens
    e = await handler(base([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: 'LANGUAGE_HANDSHAKE' }]));
    assert.strictEqual(e.response.challengeName, 'CUSTOM_CHALLENGE');
    assert.strictEqual(e.response.issueTokens, false, 'handshake alone must not issue tokens');

    // 4. OTP round passed -> tokens
    e = await handler(base([
        { challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: 'LANGUAGE_HANDSHAKE' },
        { challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: '{"code":"123456"}' }
    ]));
    assert.strictEqual(e.response.issueTokens, true, 'passed OTP must issue tokens');

    // 5. three failed OTP rounds -> fail auth
    const fail = { challengeName: 'CUSTOM_CHALLENGE', challengeResult: false, challengeMetadata: '{"code":"123456"}' };
    e = await handler(base([
        { challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: 'LANGUAGE_HANDSHAKE' },
        fail, fail, fail
    ]));
    assert.strictEqual(e.response.failAuthentication, true, '3 failed OTPs must fail auth');

    console.log('ALL DEFINE-AUTH-CHALLENGE TESTS PASSED');
})();
```

Next tests to add in the same suite: `create-auth-challenge` (handshake round sends no SMS; OTP reuse inside the 5-minute window; the error-challenge shape on SNS failure, mock the SNS client).

## Appendix B: verify-auth-challenge tests (written and passing 2026-07-24)

Covers the fallback profile creator (commit fe62302: `showOnboarding: true` + `createdAtISO`), the handshake auto-pass, and that failed OTPs create nothing. The AWS SDK is not vendored in the repo (the Lambda runtime provides it), so the test stubs both SDK modules at the loader level; under jest, replace the `Module._load` patching with `jest.mock`.

```js
const assert = require('assert');
const path = require('path');

const FN_DIR = '/Users/db/Burnes Center Fulltime/A-IEP/ai-iep/lib/chatbot-api/functions/phone-otp-auth';

// The AWS SDK isn't vendored in the repo (the Lambda runtime provides it),
// so stub both SDK modules at the loader level BEFORE requiring the handler,
// which builds its client at module load time.
const Module = require('module');
const captured = { puts: [], gets: [] };
class GetCommand { constructor(input) { this.input = input; } }
class PutCommand { constructor(input) { this.input = input; } }
const stubs = {
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': {
        GetCommand,
        PutCommand,
        DynamoDBDocumentClient: {
            from: () => ({
                send: async (cmd) => {
                    if (cmd instanceof GetCommand) {
                        captured.gets.push(cmd.input);
                        return {}; // no existing profile
                    }
                    if (cmd instanceof PutCommand) {
                        captured.puts.push(cmd.input);
                        return {};
                    }
                    throw new Error('unexpected command');
                }
            })
        }
    }
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (stubs[request]) return stubs[request];
    return realLoad.call(this, request, ...rest);
};

process.env.USER_PROFILES_TABLE = 'test-profiles-table';
const { handler } = require(path.join(FN_DIR, 'verify-auth-challenge.js'));

(async () => {
    // Successful OTP round for a first-time user -> profile gets created
    const event = {
        userName: 'new-user-sub',
        request: {
            privateChallengeParameters: { secretLoginCode: '123456' },
            challengeAnswer: '123456',
            clientMetadata: { language: 'es' },
            session: [{
                challengeName: 'CUSTOM_CHALLENGE',
                challengeResult: true,
                challengeMetadata: JSON.stringify({ code: '123456', timestamp: new Date().toISOString() })
            }]
        },
        response: {}
    };

    const out = await handler(event);
    assert.strictEqual(out.response.answerCorrect, true, 'correct OTP must pass');
    assert.strictEqual(captured.puts.length, 1, 'profile must be created once');

    const item = captured.puts[0].Item;
    assert.strictEqual(item.showOnboarding, true, 'fallback profile must set showOnboarding=true (strict === true gate in PreferredLanguage)');
    assert.strictEqual(item.consentGiven, false);
    assert.strictEqual(typeof item.createdAtISO, 'string', 'createdAtISO present');
    assert.strictEqual(item.authMethod, 'phone');
    assert.strictEqual(item.secondaryLanguage, 'es', 'language seeded from clientMetadata');
    assert.strictEqual(captured.puts[0].ConditionExpression, 'attribute_not_exists(userId)');

    // Handshake round: passes, creates nothing
    captured.puts.length = 0;
    const hs = await handler({
        userName: 'new-user-sub',
        request: { privateChallengeParameters: { secretLoginCode: 'LANGUAGE_HANDSHAKE' }, challengeAnswer: 'HANDSHAKE_ACK', session: [] },
        response: {}
    });
    assert.strictEqual(hs.response.answerCorrect, true);
    assert.strictEqual(captured.puts.length, 0, 'handshake must not create a profile');

    // Wrong OTP: fails, creates nothing
    const bad = await handler({
        userName: 'new-user-sub',
        request: {
            privateChallengeParameters: { secretLoginCode: '123456' },
            challengeAnswer: '999999',
            session: [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: JSON.stringify({ code: '123456', timestamp: new Date().toISOString() }) }]
        },
        response: {}
    });
    assert.strictEqual(bad.response.answerCorrect, false);
    assert.strictEqual(captured.puts.length, 0, 'failed OTP must not create a profile');

    console.log('ALL VERIFY-AUTH-CHALLENGE TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
```

