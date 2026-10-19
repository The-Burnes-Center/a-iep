# A-IEP runbook

What to do when a Slack alert arrives. Every alert links to one section here.
The wording of each alert lives in `lib/chatbot-api/monitoring/alert-copy-table.ts`
and `alert-copy-components.ts`; this page says what to do about it.

No section below needs a family's name, a phone number, an email address or any
document text. If a step seems to need one, stop: look up the record by its id
and never paste content into Slack, a ticket or a log.

## Reading an alert

Every alert starts with the environment and the severity, as words:

```
[PROD] [CRITICAL] Sign-in codes are not being sent
```

| Label | Means | Expect |
|---|---|---|
| `[PROD] [CRITICAL]` | Families cannot use the service, or records are exposed, right now. | Act now. A `Resolved` message follows when it clears. |
| `[PROD] [WARNING]` | Degraded, or heading for critical if left. | Look today. No resolution message. |
| `[PROD] [INFO]` | Worth knowing. Nothing is broken. | Read it. No resolution message. |
| `[STAGING] [WARNING]` or `[INFO]` | The test environment. No real families are affected. | Fix at normal pace. No resolution message. |

Two things to know about staging. It never shows CRITICAL, however severe the
same alarm would be in prod. And a few alarms read account-wide signals (SMS
spend, email reputation, AWS call volume): their staging alert says so, because
production is affected too.

Each alert says what is happening and the threshold that fired it, who is
affected, when it started, and the first one or two things to check. It links
this runbook, the logs where there is one place to look, and the alarm itself.

A `Resolved` message (prod, critical only) states what is true now and how long
the alert lasted. A `Quiet` message means the alert counts failures and none
have arrived for a while. That is not proof the cause is fixed: nobody may have
tried to sign in.

The daily health summary posts at 13:00 UTC (9am Eastern) for each
environment. It names anything that needs attention and counts the rest. If it
does not arrive, see [The alerting itself is broken](#the-alerting-itself-is-broken).

Both environments post to the same Slack channel today, so the label on the
first line is the only thing telling them apart.

## Sign-in codes are not arriving

**Alerts:** codes not being sent; codes not being delivered (SMS or email);
provider rejecting codes; codes accepted and then not delivered; the
do-not-email check is down; the sending limit is reached (SMS or email); the
undelivered-code counter is broken.

**Who is affected:** parents trying to sign in. They see the code screen and
nothing arrives, so they cannot get into the app.

**Check first**

1. Find the reason. The sign-in code creation and sending functions log a
   marker for each failure: `AUTH_DISPATCH_FAILED`, `SMS_SEND_FAILED`,
   `SMS_BUDGET_EXHAUSTED`, `EMAIL_SEND_FAILED`, `EMAIL_BUDGET_EXHAUSTED`,
   `EMAIL_SUPPRESSION_UNAVAILABLE`. Search the function's log group for the
   marker named in the alert. The marker line carries a reason, never a
   phone number or address.
2. Check the provider. SMS goes through AWS SNS and email through AWS SES: look
   at the AWS Health dashboard and the SNS and SES consoles.
3. If the reason is "No quota left for account", it is the monthly cap. Go to
   [SMS spend and the monthly cap](#sms-spend-and-the-monthly-cap).

**If a few codes were accepted and not delivered** (a landline, a dead phone), no
action is needed. The alert fires when it is more than a trickle: check whether
the failures share a country or carrier in the SNS delivery failure log group.

**If the do-not-email check is down**, the suppression table cannot be read.
Check it for throttling or a permissions change from a recent deploy. Email
sign-in refuses everyone until it can be read; this is deliberate.

**Escalate** to whoever owns the AWS account if the provider shows an incident
or the account is under review.

## Sign-in is failing or slow

**Alerts:** sign-in is failing at a named step; sign-in is being throttled;
sign-in is running slow; the limit on wrong codes is switched off.

**Who is affected:** parents. Failing and throttled steps stop sign-in
entirely, and parents already signed in are signed out within an hour. Slow
steps fail silently: Cognito gives up on any step after 5 seconds, which this
service cannot change, so a parent can be turned away with no error anywhere.

**Check first**

1. Open the logs for the step named in the alert (the alert links them) and read
   the most recent error.
2. Check for a deploy in the last hour. If the timing lines up, roll back by
   re-deploying the previous release (see the release notes).
3. For a slow step, find which call is slow (DynamoDB, SNS or SES) and check that
   service's health.
4. For a throttled step, compare the volume with the reserved concurrency. A
   flood is [abuse](#suspected-abuse); real demand means raising the limit.

**The wrong-code limit is off:** sign-in still works, and Cognito's own three
tries per code still apply. Check the login rate limiting table for throttling.

Run `scripts/smoke-test.sh` against the environment to confirm sign-in works
once it is fixed. It sends no texts.

## SMS spend and the monthly cap

**Alerts:** SMS spending is climbing fast; spending is close to the cap; the
monthly cap has been reached; the sending limit is reached.

**Who is affected:** at the cap, no parent in either environment can receive a
sign-in code by text until the limit is raised or the month rolls over.

**Check first**

1. Is it abuse or demand? Look at signups and destinations in the sign-in code
   creation logs for the last hour. Real traffic here is cents per day. A
   flood of new accounts, or numbers from countries we do not serve, is an
   attack.
2. Do not raise the cap during an attack: that pays for it. Follow
   [Suspected abuse](#suspected-abuse) first.
3. If the traffic is real, raise the SNS monthly spend limit (an account-level
   SNS setting; above the account default it needs a request to AWS Support)
   and update `SMS_MONTHLY_LIMIT_USD` in `lib/chatbot-api/monitoring/monitoring.ts`
   so the near-cap alert uses the right figure.

## Sign-up is failing

**Alerts:** an account could not be secured; the bot check is switched off.
(Login failures alert under their own names: see the sign-in sections.)

**Who is affected:** new families. Accounts are created by the auth send
function (`/auth/start` hands off to it), so while it fails nobody new can join.

**Check first**

1. Read the latest error in the auth send function logs.
2. Check for a recent change to the user pool or that function.

**An account could not be secured** (`SIGNUP_ORPHANED`): an account exists that
whoever created it may be able to sign into. Find it in the auth send function logs by id,
disable or delete it in Cognito, then find out why the clean-up failed. Treat
accounts created while the alert is active as untrusted until that is done.

**The bot check is off:** the Turnstile secret parameter for the environment is
missing from Parameter Store (see `TURNSTILE_SECRET_PARAM` in
`lib/authorization/new-auth.ts`). Create it as a SecureString. Sign-up keeps
working meanwhile, with only the rate limits protecting it.

## Suspected abuse

**Alerts:** a flood of new accounts; signup volume far above normal; many
sign-ups or sign-ins turned away; codes requested for numbers we do not serve;
codes requested for addresses that bounced before; emails to addresses that do
not exist.

The flood alert counts only signups on real numbers and addresses. Signups on
the fictional test destinations (the 555-01XX phone block and `a-iep.invalid`)
cannot receive anything, so they are counted only by the volume alert, which
sits above a full test run.

**Who is affected:** usually no one yet. These alerts are early warning: each
fake signup sends a text or email, so a run burns the SMS budget and the email
sending reputation, and ends with real parents locked out.

**Check first**

1. Look for one source or pattern: the same country prefix, many addresses from one
   place, a burst inside a few minutes. The logs carry reasons and counts, not
   numbers or addresses.
2. Confirm the bot check is on (see [Sign-up is failing](#sign-up-is-failing)).
3. If the limits are holding (requests are refused and no money is being spent),
   watch it. If spend or bounces are climbing, tighten the per-source limits and
   ask whoever owns the AWS account about blocking at the edge.
4. Afterwards, `scripts/purge-abuse-accounts.py` removes the accounts an abuse run
   created. Read its header first: it states the conditions that stop it from
   ever touching a real family's account. It defaults to a dry run.

**If sign-ins are refused in bulk** and no attack is visible, the limits may be
too tight and real parents are blocked. Test a sign-in yourself.

## The app is returning errors

**Alerts:** the app is returning server errors; errors in a named part of the app;
requests to a named part are being throttled.

**Who is affected:** parents using that part of the app (summaries, profile,
upload, read-aloud, PDF download, translation requests, document deletion).

**Check first**

1. For server errors, find the failing route in the API access logs, then open that
   route's function logs.
2. For a named handler, open its logs from the alert link and read the latest error.
3. Check for a deploy in the last hour and roll back if it lines up.
4. For throttling, the function is at its capacity limit: compare concurrent
   runs with the limit, and look for a flood before raising it.

## Documents are failing to process

**Alerts:** a document failed to process; documents are failing at a named step;
document progress is not being saved; a document has been processing for six
hours; the check for stalled uploads stopped or cannot start; a requested
translation was left out; "Translate it now" requests are failing.

**Who is affected:** the parent who uploaded the document. They see an error, a
progress bar that does not move, or the English summary where they asked for
another language.

**Check first**

1. One failed document is common (an unreadable or unsupported file). Several in a
   short time means a provider: check the status pages for Mistral (text
   extraction), OpenAI (summary) and AWS Comprehend and Translate.
2. The `RECORD_FAILURE` line in the pipeline database writes logs names the step
   that failed, by document id.
3. A step alert links that step's logs. Read the latest error there.

**A document stuck for six hours** was never marked failed, so the parent has no
error. Mark it FAILED in the IEP documents table (the status the pipeline writes
when a step fails) so the parent can retry, then run `scripts/audit-residue.py`
to confirm no unredacted copy was left behind.

**The stalled-upload check stopped:** open the schedule in EventBridge and confirm
it is enabled, then read the sweep function's logs.

**A translation was left out:** the family has the English summary and is offered
"Translate it now". Find the language in the `TRANSLATION_SKIPPED` marker; if it
repeats, test that language with a synthetic document on staging.

## Student records were not removed

**Alerts:** unredacted student information was left in storage after a failed
document; extracted IEP text was not deleted after a summary was made; a deletion
request was only partly carried out.

**Who is affected:** no parent sees anything, which is why these are critical. A
child's records exist that should not, and an administrator has to remove them.

**Check first**

1. Run `scripts/audit-residue.py` (read-only) to list what was left behind. It
   prints ids, not content.
2. Remove it with `scripts/purge-orphaned-artifacts.py` (originals and derived
   artifacts) or `scripts/purge-redacted-ocr.py` (leftover OCR text). Both default
   to a dry run: read the output, then re-run with `--apply`, then run the audit
   again to confirm it is gone.
3. For a deletion request that only partly completed, find the user and step from
   the `DELETION_INCOMPLETE` marker in the document delete or user profile
   function logs. Remove what is left by hand and confirm before telling the
   parent their records are gone.

Never paste a document, a summary or a name into Slack or a ticket while doing this.

## Database throttling

**Alerts:** a named table is throttling requests.

**Who is affected:** parents see random errors rather than a clean outage.

**Check first**

1. Open the table in the DynamoDB console, Monitoring tab, and see whether reads or
   writes are throttled.
2. Look for a traffic spike or a runaway script (the abuse alerts often fire with it).
3. These tables are on demand, so sustained throttling usually means a hot key or a
   flood rather than too little capacity. Do not change a table's capacity mode,
   and never replace a table: they hold families' records.

## Email sending reputation

**Alerts:** bounce rate climbing or near the limit; spam complaint rate climbing or
near the limit; someone marked a code as spam; AWS is refusing to send; emails
arriving late; a bounced address was not recorded; the do-not-email list is not
being maintained.

**Who is affected:** no one yet. AWS pauses an account that bounces about 5% of its
mail or draws complaints on about 0.1%. A pause ends email sign-in for every family,
and getting it back is an appeal to AWS, not a wait. These alerts fire earlier, while
there is room to act. They read an account-wide signal, so staging shows them too.

**Check first**

1. Open the SES console reputation page. Our volume is small, so a single bounce can
   move the rate a lot: look at the counts before the percentage.
2. Look for abuse (see [Suspected abuse](#suspected-abuse)): invented addresses
   typed into the sign-in form is the usual cause of a bounce burst.
3. If the do-not-email list is not being updated, read the bounce handler logs and
   check the suppression table for throttling or a permissions change.
4. If the rate is near the limit, open an AWS Support case early.

## The alerting itself is broken

**Alerts:** alerts are not being formatted; alerts are not being delivered; the daily
health summary did not go out or failed to send.

**Who is affected:** administrators. A quiet channel no longer means everything is
fine, so assume there may be a problem you have not been told about.

**Check first**

1. Open the CloudWatch alarms page for this account and region and look for anything in
   the ALARM state. This is the source of truth while Slack cannot be trusted.
2. Open the alert formatter logs and read the latest error.
3. Confirm the alarm topic still has a subscription to the formatter function and the
   alert topic is still subscribed to the Slack integration in AWS Chatbot.
4. For the daily summary, confirm its schedule rule is enabled and read the summary
   function's logs.

These two alerts skip the formatter on purpose, so they arrive as AWS's plain alarm
card rather than in the format above.

## Unusual AWS API volume

**Alerts:** something is making unusually many calls to AWS.

**Who is affected:** no one. It is usually a script or an automated agent left running.

**Check first:** in CloudTrail, find the identity making the most encryption (KMS)
calls in the last hour. Stop it if it is a script or agent you recognise. If you do
not recognise it, treat it as a possible credential leak: rotate the credential and
tell whoever owns the AWS account.
