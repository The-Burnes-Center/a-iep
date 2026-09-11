# Handoff prompts

Six independent workstreams. Each prompt below is self-contained: paste one
into a fresh session in this repo. They are scoped so two sessions do not edit
the same files, **except** that 1 and 2 overlap and should not run together.

`CLAUDE.md` (root) loads automatically in every session, so none of these
repeat its rules. What they carry is state that is not in the repo.

---

## Shared state, true as of the last session

- Branch `staging`, tip `39dbd50`. `main` is production and is **behind**.
- **Prod is running OLD auth code.** `AllowAdminCreateUserOnly=False`, no
  Turnstile enforcement, no signup endpoint, and the state machine has no
  `PurgeRedactedOCR` step. Everything below about "the signup endpoint" is
  staging-only until the next promotion.
- **SMS is still capped.** Month-to-date SNS spend is $49.99 against a $50
  limit, so **zero** login codes are being delivered to real numbers in either
  environment until 1 October or the cap is raised. E2E works because test
  numbers get their code from Parameter Store instead. Do not diagnose a
  "login broken" report without checking this first.
- Turnstile is live in **both** environments (real widget, same key, multiple
  hostnames). The E2E suite gets past it with a staging-only bypass token in
  SSM at `/a-iep/staging/e2e-turnstile-bypass`, gated so production has no env
  var, no IAM grant and no reference to it.
- `lib/chatbot-api/email/email-identity.ts` exists, is **untracked**, and is
  wired into nothing. It is a draft SES construct. Workstream 2 owns it.
- Test commands: `npm test`, `npx tsc --noEmit`, `./.venv-test/bin/pytest -q`,
  and in `lib/user-interface/app`: `npx tsc --noEmit && npm run lint && npm test
  && npm run build`. Last known green: 451 jest, 351 pytest, 187 vitest.
- `cd e2e && npx playwright test` runs against deployed staging and needs AWS
  credentials. Last known green: 25 passed, 11 skipped.

---

## 1. The one true login endpoint

> The A-IEP frontend currently decides whether a person is signing up or
> signing in: `lib/user-interface/app/src/components/CustomLogin.tsx` calls
> Amplify `signIn` first, catches `UserNotFoundException` /
> `NotAuthorizedException`, and only then POSTs to our `/auth/signup` endpoint.
> That means the client learns whether a number is registered, which is the
> account enumeration the backend works hard to avoid, and it puts auth
> branching in code we ship to every visitor.
>
> Design and build ONE backend endpoint that replaces this. Requirements, in
> the product owner's words: "email or phone number, same endpoint behind API
> Gateway, pass Turnstile here, once Turnstile is verified send the OTP to the
> respective place ONCE (never two OTPs), the UI updates with correct errors
> and success, and once the OTP is verified share the Cognito token they need,
> also coming from the backend in its own response."
>
> **Before writing code, write the design to `docs/PASSWORDLESS_AUTH_PLAN.md`
> and raise the decisions that need a human.** The product owner explicitly
> asked "is this how you design a good login backend API, or am I missing
> anything?" Answer that honestly. At minimum think through, and write down a
> position on, each of these:
>
> - **Token handling.** Returning Cognito tokens in a JSON body means the app
>   now owns storage and refresh. Amplify does that today. Decide between
>   returning tokens for Amplify to adopt, or httpOnly cookies (better against
>   XSS, but changes CORS/CSRF and the `Authorization: Bearer` pattern the
>   existing API uses). Say what happens to the refresh token specifically.
> - **Timing-based enumeration.** Identical response bodies are not enough:
>   creating an account does more work than signing an existing one in, and
>   that difference is measurable. Decide how to normalise it.
> - **Brute force on the code.** Six digits is a million combinations. Cap
>   verification attempts per session and per destination, and say what
>   happens when the cap is hit.
> - **Availability.** Today, if the signup endpoint breaks, existing users can
>   still sign in because the browser talks to Cognito directly. Funnelling
>   everything through one lambda makes it a single point of failure for ALL
>   login. Decide how to mitigate (reserved concurrency, alarms) and say so.
> - **Rate limiting**, per destination, per IP and global. Note the existing
>   asymmetry and keep it deliberate: the send limiter in
>   `lib/chatbot-api/functions/phone-otp-auth/create-auth-challenge.js` fails
>   CLOSED, while the login limiter fails OPEN so an outage cannot lock
>   everyone out. Decide which applies where and write down why.
> - **Whether to use Cognito's native passwordless (`USER_AUTH` flow with
>   EMAIL_OTP / SMS_OTP) instead of custom-auth triggers.** It would delete a
>   lot of custom lambda code. Check whether the pools support it and what
>   tier they are on before recommending either way. The backend can still
>   broker it with `AdminInitiateAuth`, keeping the Turnstile gate.
> - **The ~74 existing email+password accounts.** They must not be locked out.
>   Write the migration and the rollback.
>
> Existing pieces to reuse rather than reinvent: the signup endpoint
> (`lib/chatbot-api/functions/phone-otp-auth/signup-endpoint.js`) already does
> cheapest-first checks, per-IP and global rate limiting that fails closed,
> Turnstile verification, `AdminCreateUser` with `MessageAction: SUPPRESS` and
> `phone_number_verified: true`, and an immediate `AdminSetUserPassword` with a
> server-generated password nobody sees. That password rotation is load-bearing
> and must survive the rewrite: it is what kept ~1,030 accounts from a real
> 2026-09-09 abuse run unusable.
>
> Ship the tests in the same change, per CLAUDE.md. Do not commit until
> `npm test`, `npx tsc --noEmit`, `./.venv-test/bin/pytest -q` and the frontend
> suite are all green, and report the real output.

---

## 2. SES safety rails and email OTP delivery

> **Do not run this at the same time as workstream 1; they overlap.**
>
> `lib/chatbot-api/email/email-identity.ts` is an untracked draft SES construct
> wired into nothing. Finish it, wire it into the stack, and ship it with
> tests. Dead CDK never synthesizes, so an unwired construct rots silently:
> either it goes in properly or it is deleted.
>
> Context for why this matters more than it looks. On 2026-09-09 an SMS-pumping
> attack burned the account's entire $50 monthly SNS budget in 13 minutes and
> login has been down for real numbers ever since, because the cap does not
> reset until the calendar month rolls over. Email has the same abuse surface
> and a worse failure mode: **a bad bounce or complaint rate gets the SES
> identity suspended, and that does not self-heal, it needs an appeal to AWS.**
>
> Build:
> - An SES configuration set with event destinations for Bounce, Complaint,
>   Reject and DeliveryDelay.
> - A suppression list (DynamoDB) so a hard-bounced or complained address is
>   never mailed again. Fail CLOSED: if the suppression check cannot run,
>   refuse to send.
> - Alarms on `Reputation.BounceRate` and `Reputation.ComplaintRate`. AWS's
>   enforcement thresholds are 5% and 0.1%; alarm well below both, with a
>   review-level and a critical level. Reason the numbers in a comment rather
>   than picking round ones.
> - Per-destination and global send ceilings mirroring the SMS budget in
>   `create-auth-challenge.js`, which fails closed.
>
> `a-iep.org` is already a verified identity in the account but nothing uses
> SES yet. Verify that with a read-only call before assuming it.
>
> Follow the house alarm pattern in `lib/chatbot-api/monitoring/monitoring.ts`:
> every alarm needs an explicit `severity`, and its `description` is one
> sentence about what a parent experiences, under ~250 characters. Where a
> failure is reported rather than raised, alarm on a **log marker** and pin the
> exact string in tests on BOTH sides (see `OCR_PURGE_FAILED` /
> `UNREDACTED_ARTIFACTS_RETAINED` for the pattern), then mutation-check it:
> rename the marker, watch a test fail, restore, and say you did.

---

## 3. Promote staging to production

> `main` is production and is well behind `staging` (tip `39dbd50`). Production
> is still running old auth code: `AllowAdminCreateUserOnly=False`, no
> Turnstile enforcement, no signup endpoint, and no `PurgeRedactedOCR` step in
> its state machine, so it re-accumulates extracted IEP text that staging now
> deletes automatically.
>
> Prepare the promotion PR. Read `CLAUDE.md`'s "Every promotion to prod is a
> release" section and follow it exactly: write the note from
> `git diff main...HEAD`, never from the commit log, because work landed and
> came back out again during this range and a note written off subjects will
> announce things that do not exist.
>
> This range includes a real security incident response, so the split between
> the two artifacts matters more than usual. The **PR body** carries root
> cause, data and infra risk, ops steps, verification and rollback. The
> **public release note** carries only what shipped, stays neutral about the
> past, and must contain no attack mechanics, no defence thresholds and no
> incident analysis: this is a public repo.
>
> Specific things the PR body must cover:
> - Every durable store the deploy touches. Paste the `cdk diff` lines and
>   confirm no replacement. This row exists because a 2026-06-22 rename deleted
>   half of production's documents and reported success.
> - That `AllowAdminCreateUserOnly` flips to true in prod, closing Cognito's
>   public SignUp API. Account creation moves entirely to the new endpoint, so
>   if that endpoint is broken, **nobody can join at all**. Say how it was
>   verified.
> - That Turnstile begins enforcing on prod signups.
> - Ops steps already run: a redacted-OCR sweep (86 prod documents, 12
>   staging) and an abuse-account purge (prod pool 1,322 to 296).
>
> Bump the root `package.json` version in the PR itself. Do not tag until prod
> is deployed and hand-verified, and put the post-deploy checks in a PR comment
> before tagging. **Do not merge**: open the PR and report the URL.
>
> Blocker to state plainly in the PR: SMS spend is pinned at $49.99 of $50, so
> no real number can receive a login code until 1 October or the cap is raised.
> Prod cannot be hand-verified end to end until that is resolved.

---

## 4. The rest of the codebase audit

> A six-agent audit covered every source file for error handling and alerting.
> The worst findings are fixed and on `staging`. These remain, roughly ranked
> by harm to a family. Work down the list; each is independent. **Verify every
> finding against the code before changing anything** and say so if one turns
> out not to be real.
>
> 1. **Content leaking into CloudWatch.** A pydantic `ValidationError` renders
>    the value it rejected, which here is IEP section text.
>    `steps/parsing_agent/open_ai_agent.py` around lines 208 and 227 returns
>    and logs it; `steps/parsing_agent/handler.py:153` embeds a whole service
>    response in an exception; `steps/translate_content/translation_agent.py`
>    around 190-212 logs translated section text;
>    `tts-handler/providers.py` around 121 and 171 puts up to 300 bytes of a
>    provider's response body into a log. `ddb-service/handler.py` already
>    sanitises this class of error for its own line: follow that pattern.
> 2. **The parent-chosen filename reaches every pipeline log.** `_SAFE_LOG_FIELDS`
>    in all seven `steps/*/handler.py` calls `s3_key` non-sensitive, but it is
>    `userId/childId/iepId/<filename>` and parents routinely name an IEP after
>    their child. `metadata-handler/orchestrator.py` has a `_safe_key` helper
>    that strips the last segment: apply the same idea, and pin
>    `_SAFE_LOG_FIELDS` with a test so the allowlist cannot grow silently.
> 3. **Translation reports success having produced nothing.**
>    `steps/translate_content/handler.py` around 157 skips a failed language
>    and returns `..._translation_completed: True` with whatever succeeded. If
>    every language fails, the document is marked PROCESSED and the parent's
>    language is simply absent. `single-language-translation.asl.json` already
>    added a `VerifyLanguageProduced` choice for exactly this; the upload
>    pipeline never got the same guard.
> 4. **No client timeouts on the AI calls.** `steps/mistral_ocr/mistral_ocr.py`
>    lines 139, 167 and 206 call `requests.post` with no `timeout=`, and
>    `requests` blocks indefinitely, so a hung provider burns the full Lambda
>    timeout four times over the retry policy: roughly 40 minutes per document
>    with the parent watching a progress bar. Same shape in
>    `parsing_agent/open_ai_agent.py` (`Runner.run_sync`, 900s lambda) and
>    `translate_content/translation_agent.py`.
> 5. **No PITR and no deletion protection** on the three FERPA tables in
>    `lib/chatbot-api/tables/tables.ts`. `RETAIN` defends against a
>    CloudFormation-level event; it does nothing about a bad script or a
>    console mistake, and there is currently no restore point at all.
> 6. **Cognito's Lambda trigger budget is 5 seconds and non-adjustable**, but
>    every trigger in `lib/authorization/new-auth.ts` is configured at 30s with
>    no `Duration` alarm. A trigger taking 6 to 30 seconds fails the parent's
>    sign-in while the Lambda completes successfully and `Errors` stays at
>    zero. Verify the 5s figure against AWS docs before acting.
> 7. **The HTTP API has no access logging** (`lib/chatbot-api/gateway/rest-api.ts`
>    sets no `accessLogSettings`), so a request rejected by the JWT authorizer
>    is recorded nowhere and load on the two unauthenticated routes is
>    invisible.
> 8. **`useDocumentFetch.ts` around 165** has an empty catch on the only
>    document fetch, and `setError` is only ever called with `null`. A network
>    blip shows a parent "No summary available" and a **Re-upload your
>    document** button for a document that is fine. Polling also dies
>    permanently after one failed poll.
> 9. The Cognito user pool's logical id is not in `USER_DATA_LOGICAL_IDS` in
>    `test/infra/`. Credentials cannot be exported, so a logical-id change
>    orphans the real pool and locks out every family with no restore path.
>
> Ship tests with each fix, per CLAUDE.md. Where the fix is "report a failure
> that was silent", follow the log-marker pattern and pin the marker on both
> sides.

---

## 5. Plan sheet and secrets inventory

> Two standing obligations from `CLAUDE.md` that have fallen behind. Both are
> browser work against Google Sheets and need care.
>
> **Read `~/Burnes Center Fulltime/project-plan/README.md` first.** Re-running
> a build function WIPES a tab that has hand edits, so edit cells in place once
> a tab is live. Read tabs by exact name: the gviz CSV endpoint silently falls
> back to the first sheet when a name does not match, returning 200 with the
> wrong tab's data. The A-IEP tab is `AIEP - Dhruv`.
>
> **Plan sheet** (Fall 2026 plan, one tab per project): a large amount of
> unplanned work landed on 2026-09-09 and 2026-09-10 and none of it is on the
> tab. It needs rows for: the SMS-pumping incident response, the signup
> endpoint and Turnstile rollout, the codebase-wide error-handling audit and
> its follow-ups, the passwordless/email-OTP work, the data cleanup scripts,
> and the prod promotion. Non-technical work belongs there too. Anything
> blocked on another person gets `Blocked` and names them: the SMS spend cap
> decision is blocked on Ani.
>
> **SECRETS-BY-PROJECT sheet**: the A-IEP tab needs rows for the three
> parameters added on 2026-09-10: the Cloudflare Turnstile secret
> (`/a-iep/<env>/turnstile/secret`, SecureString), the Turnstile site key
> (`/a-iep/<env>/turnstile/site-key`, String, public by design), and the
> staging-only E2E bypass token (`/a-iep/staging/e2e-turnstile-bypass`,
> SecureString). **Masked values only** (`first4***last3`), never real ones.
>
> Show the proposed rows and get confirmation before writing to either sheet.

---

## 6. Turnstile accessibility

> Cloudflare Turnstile now gates account creation on both environments, and it
> has never been checked with assistive technology. A-IEP's users are parents
> of children with disabilities, so a bot check that is unusable with a screen
> reader is a bot check that locks out exactly the families the service exists
> for.
>
> The widget renders in `lib/user-interface/app/src/components/CustomLogin.tsx`
> via the `useTurnstile` hook in `src/common/hooks/use-turnstile.ts`. It is
> mounted inside the Phone tab only, so it attaches and detaches as a parent
> switches tabs; the hook uses a callback ref for that reason and there are
> tests in `use-turnstile.test.tsx` covering the lifecycle. Do not regress
> them.
>
> Check with a real screen reader (VoiceOver on macOS is fine), at minimum:
> is the challenge announced at all; can it be reached and completed by
> keyboard alone; is the failure state (`hasFailed`, which renders
> `auth.errorTurnstileUnavailable`) announced rather than only shown; does
> focus order still make sense with the widget between the phone field and the
> submit button; and does it behave in all five shipped languages, including
> Arabic, which is right-to-left.
>
> Cloudflare publishes a testing site key that forces an interactive challenge
> rather than auto-passing. Use it locally to exercise the path a parent hits
> when the challenge does not resolve on its own; that path currently has no
> test at all. Report findings with a recommendation. Do not weaken the bot
> check to fix an accessibility problem without saying so explicitly.
