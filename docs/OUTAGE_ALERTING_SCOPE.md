# A-IEP outage alerting to Slack: scope

Status: scoping only, nothing built. Written 2026-09-08.

Goal: when A-IEP breaks, whether that is our API, a lambda, the document
pipeline or a third-party service, someone finds out from Slack rather than
from a parent.

---

## 1. What already exists

Worth establishing first, because two of the four assumptions behind this
request turn out to be wrong, and one of them saves most of the work.

| Thing | Reality |
|---|---|
| SNS to Slack bridge | **Exists.** AWS Chatbot configuration `a-iep-findings` posts to Slack channel `C0BL9QU1L3V`, subscribed to the `inspector-aiep-findings` SNS topic. This is the fiddly part (Slack app install, workspace authorisation, IAM role) and it is already done for A-IEP. |
| Slack from GitHub Actions | **Exists.** `nightly_e2e.yml`, `e2e_staging.yml` and `nightly_residue.yml` post digests with a `SLACK_WEBHOOK_URL` secret and `curl`. |
| A lambda that posts to Slack | **Does not exist.** Every apparent match in `lib/chatbot-api/functions/` is a `node_modules` README. The AWS-side Slack path is AWS Chatbot, not our code. |
| CloudWatch alarms for A-IEP | **None.** The account holds 71 alarms and every one belongs to `ABEStack`, a different project. A-IEP has zero. |
| `lib/chatbot-api/logging/logging.ts` | **Dead code.** It defines three metric filters (`PIIAccessCount`, `DocumentAccessCount`, `AuthFailureCount`, namespace `AI-IEP/Logs`) but is never instantiated by `gen-ai-mvp-stack.ts`, so the metrics do not exist in either environment. Either wire it up or delete it; leaving it looks like coverage that is not there. |

So today: nothing in AWS notices an outage. The only automated signals are the
two nightly GitHub Actions digests, which run once a day against staging.

## 2. The trap: pipeline failures do not look like failures

This is the single most important design constraint, and the naive version of
this project gets it wrong.

Every `Task` in `iep-processing.asl.json` catches into `RecordFailure`.
`RecordFailure` ends with `"End": true`, and the machine contains **no state of
type `Fail`**. So when a document fails, the Step Functions execution
**completes successfully**.

`ExecutionsFailed` will therefore sit at zero while every document in the
system is failing. An alarm on "the pipeline failed" would stay green through a
total OCR outage.

The real signals are:

- **`RecordFailure` invocation rate.** It is invoked once per failed document
  and never otherwise, so it is a direct count of parent-visible failures.
- **Documents landing in `FAILED`** in the IEP documents table.
- Per-step lambda `Errors`, which tell you *which* stage broke.

`ExecutionsTimedOut` is still worth alarming on separately: `TimeoutSeconds` is
21600 (6 hours), and a timeout is not caught by `RecordFailure`.

## 3. The gap: the outage we just had would not have been caught

The Amplify v6 signup regression (PR #66, 2026-09-03) threw
`UserAlreadyAuthenticatedException` **client-side, in the browser, before any
network call**. No lambda ran. No API returned 5xx. No CloudWatch metric moved.

No alarm design based on AWS metrics can see that class of failure, and it is
not a rare class: it covers every frontend crash, every bad deploy of the
bundle, and every third-party JS failure. The honest conclusion is that alarms
cover the backend and something else has to cover the client.

The cheap answer already exists in the repo. `scripts/smoke-test.sh` validates
prod auth **without sending any SMS**: round 1 of the custom-auth handshake
sends no code by design, and the script abandons the session. It also asserts
that an unknown number is rejected, which is the exact 2026-07 incident. It
currently runs only as a post-deploy step.

Running it on a schedule is the highest-value item in this whole scope.

## 4. Failure inventory

What can break, and what would see it.

| # | Failure | Parent impact | Signal |
|---|---|---|---|
| 1 | A pipeline step throws | Document fails, error screen | `RecordFailure` Invocations; per-step lambda `Errors` |
| 2 | Mistral OCR down or rate-limiting | Every upload fails at OCR | `MistralOCR` lambda `Errors` / `Duration`; `RecordFailure` rate |
| 3 | OpenAI down, or a model or schema change | Summaries fail | `ParsingAgent` `Errors`; `RecordFailure` rate |
| 4 | Comprehend down | Redaction fails closed, document fails (correct behaviour) | `RedactOCR` `Errors` |
| 5 | Translate or Polly down | No translation or TTS | Respective lambda `Errors` |
| 6 | SNS SMS delivery failing | **Nobody can log in** | `CreateAuthChallenge` reports send failure through the challenge parameter; SNS delivery-failure metrics |
| 7 | A Cognito trigger crashes | Login or signup broken | Per-trigger lambda `Errors` (5 triggers) |
| 8 | HTTP API 5xx | App cannot read or write profile or documents | API Gateway `5xx` |
| 9 | DynamoDB throttling | Intermittent failures anywhere | `ReadThrottleEvents`, `WriteThrottleEvents` |
| 10 | Lambda concurrency exhausted | Uploads and API stall | `Throttles` |
| 11 | The pending-upload sweep stops | Stalled uploads never fail closed, parents sit on the 24-minute screen forever | EventBridge `FailedInvocations`, plus a heartbeat alarm with `treatMissingData: BREACHING` |
| 12 | Step Function times out (6h) | Document stuck, not marked failed | `ExecutionsTimedOut` |
| 13 | CloudFront or S3 site failure | App unreachable | CloudFront `5xxErrorRate`, `TotalErrorRate` |
| 14 | ACM certificate expiry | Site unreachable | Certificate expiry metric |
| 15 | **Frontend JS crash or bad bundle** | Anything from a dead button to no logins | **Invisible to CloudWatch.** Needs the scheduled smoke test, a synthetic canary, or client error reporting |
| 16 | The alerting itself is broken | Silent outage that looks healthy | `treatMissingData: BREACHING` on heartbeats, plus a deliberate periodic alarm test |

Item 16 is not paranoia. An alarm that never fires is indistinguishable from a
system that never breaks, and this repo has already been bitten by a check that
could not fail (the fabricated Cognito `session` field, and the `timeout:` that
CDK silently ignored).

## 5. Proposed design

```
CloudWatch alarm  ->  SNS topic (new: a-iep-alarms-<env>)  ->  AWS Chatbot  ->  Slack
```

No new lambda, no webhook secret to manage, no code that can itself fail, in
phase 1. AWS Chatbot is free and already authorised for this account.

**Severity tiers, defined by what a human should do:**

| Tier | Means | Examples | Slack treatment |
|---|---|---|---|
| Page | Parents are blocked right now | API 5xx sustained, CloudFront 5xx, SMS sends failing, Cognito trigger errors, `RecordFailure` rate spike | `@here` in the alert channel |
| Notify | Something is wrong, it can wait for morning | Single-document failures, DDB throttles, elevated latency, sweep anomalies | Message, no ping |
| Digest | Trends and counts | Existing nightly E2E and residue audit | Once a day, as now |

**Staging should be Notify-only, never Page.** Otherwise the channel trains
everyone to ignore it, which is the usual way alerting projects fail.

**On message context.** AWS Chatbot's alarm card is thin: alarm name, state,
metric, no runbook and no document id. Two options:

- *Chatbot only.* Zero code, zero secrets, functional but terse. The alarm
  **name** has to carry the meaning, so name them for the human ("a-iep-prod
  document-pipeline-failing" rather than "RecordFailureInvocations").
- *Formatter lambda between SNS and Slack.* Rich messages with the failing
  step, counts and a runbook link, at the cost of new code, a webhook secret,
  and a component whose own failure is silent.

Recommendation: Chatbot only to start. Add a formatter for the two or three
alarms where context actually changes what someone does, not for all of them.

## 6. Phasing

| Phase | Work | Effort |
|---|---|---|
| 1 | SNS topic per env, Chatbot subscription, and roughly 12 alarms: API 5xx, CloudFront 5xx, `RecordFailure` rate, `ExecutionsTimedOut`, per-step `Errors` on the 6 pipeline lambdas, `Errors` on the 5 Cognito triggers, sweep heartbeat. Plus `test/infra` assertions. | ~half a day |
| 2 | Run `scripts/smoke-test.sh` on a 15-minute schedule against prod and staging, alerting on failure. Closes the client-side gap for auth, which is the failure that actually happened. | ~2 hours |
| 3 | Decide `logging.ts`: wire it up (so `AuthFailureCount` becomes real and alarmable) or delete it. | ~1 hour |
| 4 | Formatter lambda for the two or three alarms needing context; runbook doc per alarm. | ~half a day |
| 5 | Optional: CloudWatch Synthetics canary driving the real browser journey, or client-side error reporting. This is the only thing that catches a general frontend crash. | ~1 day, decide later |

## 7. Cost

| Item | Monthly |
|---|---|
| ~30 CloudWatch alarms at $0.10 | $3.00 |
| SNS notifications | pennies |
| AWS Chatbot | free |
| Scheduled smoke test (lambda or GitHub Actions cron) | free to pennies |
| Optional Synthetics canary every 15 min | ~$3.50 |

Under $10/month, and phase 1 plus 2 is roughly $3.

## 8. Tests this needs

Per the repo's rule that infrastructure changes ship with an assertion pinning
the security-relevant property:

- `test/infra/`: every alarm exists with its intended threshold, period,
  `evaluationPeriods` and `treatMissingData`; each is wired to the env's SNS
  topic; both prod and staging templates get them.
- The sweep heartbeat alarm specifically asserts `treatMissingData: BREACHING`,
  because the default (`MISSING`) would make a dead schedule look healthy,
  which is the exact bug this alarm exists to catch.
- Mutation check: change a threshold deliberately, watch the assertion fail,
  restore.
- If a formatter lambda lands in phase 4, unit tests for the happy path and for
  a malformed SNS payload, and it must fail loudly rather than swallow.

## 9. Open questions

1. **Channel.** Reuse the existing `a-iep-findings` channel, or a separate
   `#aiep-alerts`? Inspector findings are low-urgency; outages are not, and
   mixing them dulls both.
2. **Overnight.** Who is on the hook out of hours? If nobody is, the Page tier
   should not `@here`, and we should say so rather than pretend.
3. **Staging noise.** Confirm staging is Notify-only.
4. **Thresholds.** `RecordFailure` fires once per failed document, and some
   documents legitimately fail (a corrupt PDF, an unreadable scan). The alarm
   needs a rate, not a count. Needs a look at the historical failure rate:
   prod currently holds 109 documents, 6 of them `FAILED`, so roughly 5.5%
   lifetime. Suggest alarming on 3 failures in 15 minutes rather than any
   failure at all.
