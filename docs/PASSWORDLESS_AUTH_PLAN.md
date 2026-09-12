# Passwordless auth, and closing the public signup API

Status: design, 2026-09-10. Supersedes nothing; extends the phone OTP flow.

## Why now

Two things arrived together: the 2026-09-09 signup abuse run, and the decision
to drop passwords entirely. They belong in one change because building the new
signup path around passwords and then removing passwords means writing it
twice.

## What the attack actually taught, as constraints

These are not general principles. Each one is a thing that went wrong.

1. **Anything the browser can call, an attacker calls directly.** The run never
   loaded the site. It called Cognito's public `SignUp` API. Every control that
   lived in the browser, including the `+1` lock, was simply not in its path.
   → The API endpoint is worthless unless the public `SignUp` path is closed at
   the same time. Half of this change is `AllowAdminCreateUserOnly`.

2. **Per-recipient limits do not bound spend.** 1,024 phone numbers, each used
   exactly once, walked past a limiter keyed on one number.
   → Every limit here is global and per-source first, per-recipient second.

3. **Our ceiling must bind before the provider's.** SNS accepted messages and
   dropped them, so the app reported success while nothing arrived.
   → The endpoint refuses before SES would, and says so honestly.

4. **Email carries a worse failure than SMS did.** SMS abuse cost $50 and
   stopped. Spraying signups at invented addresses produces bounces and
   complaints, and a bad enough reputation gets the SES identity suspended.
   That breaks ALL email for a-iep.org, not just OTP, and it is not fixed by
   waiting for the month to roll over.
   → Bounce and complaint handling is part of this change, not a follow-up.

5. **Alarms only counted because they were in production.** The alerting built
   the day before existed only on staging, so nothing fired for thirteen hours.
   → Alarms ship with the feature, to both environments.

6. **Calibration does not go in a public repo.** Thresholds live in Parameter
   Store; the code carries tighter floors.

## Target shape

    browser ──POST /auth/signup──▶ signup endpoint ──▶ Cognito AdminCreateUser
                                        │                    + AdminSetUserPassword
                                        ├── Turnstile verify
                                        ├── per-IP limit
                                        ├── global limit
                                        └── address/number validation

    browser ──InitiateAuth CUSTOM_AUTH──▶ Cognito ──▶ create-auth-challenge
                                                          ├── phone → SNS
                                                          └── email → SES

Self-service `SignUp` is disabled at the pool. `ALLOW_USER_PASSWORD_AUTH` and
`ALLOW_USER_SRP_AUTH` come off the app client, so no password is accepted
anywhere, by anyone, ever.

## The hole the shape above still leaves

This is a disagreement with the section above, argued rather than quietly
edited, because the rest of that section is right.

The second arrow has the browser calling `InitiateAuth CUSTOM_AUTH` directly.
That is what happens today and it is the same class of opening as constraint 1,
one step further down. Closing self-service `SignUp` stops an attacker
**creating** accounts. It does not stop them making us **send** to accounts
that already exist. The app client id ships in the bundle, `ALLOW_CUSTOM_AUTH`
is on it, and `InitiateAuth` is a public unauthenticated API. Anyone who knows
a registered number can loop it and we will text that number, with no Turnstile
anywhere in the path.

Measured, not assumed: 221 of the 296 accounts in the production pool are
phone accounts. The only things bounding an SMS-pumping run against them today
are the per-recipient limiter, which is five an hour and **fails open**, and
the global ceiling, which is 50 an hour and 100 a day and fails closed. So the
global ceiling is doing all of the work, and the cost of it doing that work is
that login stops for everybody once it binds. That is the 2026-09-09 outage
shape again, at a hundredth of the cost.

The fix is not another limiter. It is that the browser should not be able to
start an authentication at all.

**Two app clients.** A confidential client, with a secret, which the backend
uses and which is the only client carrying `ALLOW_CUSTOM_AUTH`. And the public
client the browser holds, which carries no auth flow it can initiate. Then
`InitiateAuth` from a browser fails at Cognito regardless of what the caller
knows, and Turnstile is genuinely in front of every OTP rather than in front of
account creation only.

This costs a client secret in Secrets Manager and a second `UserPoolClient` in
`new-auth.ts`. It buys the property the whole document is trying to establish:
that there is one door.

It also makes the product owner's "one endpoint" literally true rather than
nearly true, which is the next section.

## Is this how you design a good login backend API

Asked directly, so answered directly. The stated shape is:

> email or phone number, same endpoint behind API Gateway, pass Turnstile
> here, once Turnstile is verified send the OTP to the respective place ONCE
> (never two OTPs), the UI updates with correct errors and success, and once
> the OTP is verified share the Cognito token they need, also coming from the
> backend in its own response.

Most of that is right, and two parts of it are righter than they look.

**Right, and worth saying why.** One endpoint for both destinations is the
thing that kills the enumeration, because the client never has to ask a
question whose answer is "this person exists". Turnstile before the send is
correct and is the ordering the existing endpoint already uses. "Never two
OTPs" is not a nicety: today a new parent gets one text from the signup path
and would get a second from Cognito's own confirmation if `MessageAction:
SUPPRESS` were ever dropped, and `e2e/tests/resignup.spec.ts` already asserts
the count by reading send-count deltas rather than by trusting the UI. Keep
that test; it is the one that proves the requirement.

**Incomplete in four places.**

1. **It is two endpoints, not one.** Starting an authentication and finishing
   one are different operations with different inputs, different rate limits
   and different failure modes. `POST /auth/start` and `POST /auth/verify`.
   Collapsing them into one route with a mode field means every request pays
   both sets of validation and the log line cannot say which thing failed.
   "One endpoint" should mean "one endpoint the client chooses between signup
   and signin with", and that is satisfied: the client never chooses.

2. **"Share the Cognito token they need" needs to say which tokens and where
   they live.** The next section does. The short version is that the refresh
   token should not be one of them.

3. **Identical bodies are not identical responses.** Creating an account is
   three Cognito calls; signing an existing one in is one. The difference is
   measurable from a browser. Covered below.

4. **It does not say what happens when the endpoint is down.** Today a broken
   signup endpoint is survivable because existing parents talk to Cognito
   directly. After this change nobody does. Covered below.

None of those make the shape wrong. They make it unfinished.

## Tokens, and what happens to the refresh token

Where the tokens live is the decision with the longest tail, because it is the
one that is hard to change later.

**What is true today.** Amplify v6, configured once in `app-configured.tsx`,
with no storage override. So all three tokens sit in `localStorage`, readable
by any script on the origin. Every API client then calls `fetchAuthSession()`
and sends the **ID** token as the credential, and four of the eight clients
send it without the `Bearer` prefix. That inconsistency is survivable only
because the JWT authorizer is lenient about it. It is worth fixing in this
change, since every one of those call sites is being touched anyway.

**The option that does not exist.** "Return tokens for Amplify to adopt" has
no supported form in Amplify v6. There is no API that takes externally
obtained user-pool tokens and installs them as the current session. Doing it
means writing to Amplify's internal token-store keys, which is an undocumented
contract that moves on minor versions. Rejected, and worth writing down
because it is the obvious first idea.

So the real choice is between the browser holding a refresh token and the
browser not holding one.

**Decision: it does not hold one.** `POST /auth/verify` returns the access and
ID tokens in the body, for the app to keep in memory. The refresh token is
never serialized to the browser at all. It is stored server-side, encrypted
under the application CMK, in a sessions table, and the browser gets an opaque
handle to it in an `HttpOnly` cookie.

The cookie is workable, and it was worth checking rather than assuming,
because the usual objection is that the API and the app are on different
sites. They are on different **origins**: the app is a CloudFront distribution
aliased to `a-iep.org` in production and `dev.a-iep.org` on staging, and the
API is a raw `execute-api` URL. `amazonaws.com` and `cloudfront.net` are both
public suffixes, so today a cookie cannot be scoped across them and would be a
third-party cookie that Safari drops outright.

That is a prerequisite, not a blocker. Give the API a custom domain on the
same registrable domain as the app, `api.a-iep.org` and `api.dev.a-iep.org`,
and the cookie becomes same-site. Then:

    Set-Cookie: aiep_session=<handle>; HttpOnly; Secure; SameSite=Strict;
                Path=/auth; Max-Age=2592000

Host-only, with no `Domain` attribute, deliberately. A cookie on `.a-iep.org`
would be shared between production and staging, which is the kind of thing
that is discovered by a staging session working in production.

Two things change with it. `corsPreflight` in `rest-api.ts` is currently
`allowOrigins: ['*']` with `allowCredentials: false`, which cannot carry a
cookie; it becomes the two real origins with credentials allowed. And the
`/auth/*` fetches use `credentials: 'include'`.

**What the handle buys over just sending the refresh token.** Rotation with
reuse detection. Every `/auth/refresh` issues a new handle and invalidates the
old one. If an old handle is ever presented again, that is either a stolen
copy or a replay, and the response is to delete the whole family and call
`AdminUserGlobalSignOut` on the user. A refresh token in `localStorage` cannot
do that, because there is nothing server-side that knows it was used twice.
Revocation also becomes one `DeleteItem` rather than waiting out a 30-day
token.

The honest cost: an opaque handle in a cookie is still stealable by an
attacker who can run script on the origin, and the access and ID tokens in
memory are stealable too. This is better than today, not immune. What it
removes is the 30-day offline-usable credential sitting in `localStorage`.

**Access and ID token lifetimes** are currently unset, so they are Cognito's
one-hour default. Leave them. An hour is short enough that a stolen access
token expires before most things can be done with it, and long enough that
refresh is not constant.

## Making both branches take the same time

Identical bodies are necessary and not sufficient. The unknown-destination
branch does `AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword` and then
`AdminInitiateAuth`. The known branch does `AdminGetUser` and
`AdminInitiateAuth`. Two extra round trips to Cognito is tens to hundreds of
milliseconds, repeatable, and averaging over a few hundred requests separates
the two cleanly. The `{ ok: true }` body that
`signup-endpoint.js` was carefully fixed to return is defeated by a stopwatch.

Normalize with a floor, not a pad. Stamp the start, do the work, and before
responding sleep until a fixed elapsed time has passed. The floor has to sit
above the p99 of the **slow** branch or it does nothing for the tail, and it
should carry a small random component so the floor itself is not a signal.
Start at 1200ms with 0 to 150ms of jitter, and pin it as a named constant with
the reasoning next to it, because the first person to see a login endpoint
deliberately sleeping will try to delete it.

The floor also has to apply to the refusals. A Turnstile rejection that
returns in 40ms while a real attempt takes 1200ms tells an attacker which of
their tokens are working, which is a cheaper oracle than the one we are
closing. Every response from `/auth/start` leaves at the same time, including
the 429s.

This does make login feel slower by about a second. That is the cost and it
should be stated to the product owner rather than absorbed silently: see the
open decisions.

## Guessing the code

Six digits is a million combinations, and the current bound is better than it
first looks but is not written down anywhere.

`define-auth-challenge.js` fails the session at three wrong answers, counting
only OTP rounds and excluding the language handshake. Within a session, a
retry reuses the same code and sends no new message. Starting a fresh session
costs a new send, which the per-recipient limiter caps at five an hour. So the
ceiling today is roughly fifteen guesses an hour against a million, which is
fine.

It is fine for the wrong reason. The per-recipient limiter **fails open**, so
during a DynamoDB problem the send cap disappears and the only remaining bound
is three per session with unlimited sessions. That is not a realistic break of
a six-digit code, but it is an unbounded SMS bill, which is the failure we
already had.

So: keep the three-per-session rule exactly as it is, and add a per-destination
failure counter in the new endpoint, outside the Cognito session, keyed on
`sha256(destination)` and an hour bucket.

**Ten failed verifications for one destination in an hour, and that
destination stops being able to start a new authentication for the rest of the
hour.** Ten because a parent mistyping a six-digit code three times in one
session and then again in a second session is a real person having a bad day
at six; ten leaves room for that and still stops a run three orders of
magnitude short of the keyspace.

What the parent sees when the cap is hit: "Too many incorrect codes. Please
try again in an hour." Plainly, and in their language. This is not an
enumeration leak, because the counter is keyed on the destination whether or
not an account exists there, so the message is identical for a stranger's
number and a registered one. Saying nothing, or returning the generic "that
code did not work", would leave a parent retyping a correct code into a wall,
which is worse for them and no better for us.

The counter fails **closed**, and the reason is the asymmetry below.

## When the endpoint is down

Today, a broken `/auth/signup` costs new accounts and nothing else: everyone
who already has one talks to Cognito directly and signs in fine. After this
change that is no longer true, and it is the strongest argument against the
whole design. It deserves an answer rather than a shrug.

**Reserved concurrency, set to 20, on the start and verify functions.**
Nothing in this repo sets reserved concurrency on anything today, which means
every lambda competes for one account-wide pool. That cuts both ways and both
of them matter here: a document-pipeline burst can starve login, and a login
flood can starve the pipeline. Twenty is far above real demand, which is a few
dozen sign-ins a day, and far below the account limit.

**Alarms, in both environments.** `SignupEndpointErrorsAlarm` and
`SignupEndpointThrottledAlarm` already exist and are `critical`. They extend
to cover the new functions unchanged. Add one for the API's own 5xx on the
`/auth/*` routes specifically, because the existing `ApiServerErrorAlarm` is
API-wide and a login outage should not have to be inferred from a rate.

**Throttling, which does not exist at all today.** There are no
`throttlingRateLimit` or `throttlingBurstLimit` settings anywhere in the repo,
on any route or stage; the HTTP API runs on the account default. A login
endpoint that is the only way in should not. Per-route throttling on
`/auth/start` is cheap and is the layer that keeps a flood from reaching the
lambda at all.

**No fallback path, deliberately.** The tempting answer is to leave the direct
Cognito route enabled and switch to it if the endpoint breaks. That reopens
the un-Turnstiled send path permanently in exchange for a contingency, which
is trading a certain weakness for an occasional convenience. The
`auth_healthcheck.yml` workflow already runs every fifteen minutes against
both environments and exercises the flow to the language handshake without
sending anything; extend it to cover the new endpoint, and treat that as the
detection mechanism instead.

## Which limiter fails which way

The existing asymmetry is real but is usually described one level too
coarsely, and getting it wrong in the new code would be easy. Precisely:

| Limiter | Where | On failure |
|---|---|---|
| Global SMS budget, hourly and daily | `create-auth-challenge.js`, `enforceGlobalSmsBudget` | **Closed** |
| Per-recipient SMS, five an hour | `create-auth-challenge.js`, `enforceSmsRateLimit` | **Open** |
| Per-IP signups | `signup-endpoint.js`, `overLimit` | **Closed** |
| Global signups | `signup-endpoint.js`, `overLimit` | **Closed** |
| Turnstile | both | **Closed** |

Both SMS limiters live on the send path, so the split is not "send fails
closed, login fails open". It is **global fails closed, per-recipient fails
open**, and the reasoning is that a broken global counter means we cannot see
spend at all, while a broken per-recipient counter means we cannot see one
inbox. One of those is a bill and the other is an annoyance.

Carry that rule into the new endpoint unchanged, and place the new limits by
the same test: does failing open cost money or cost one person a retry?

| New limiter | Fails |
|---|---|
| Per-IP starts | **Closed.** Same reasoning as signup: a refusal costs one retry. |
| Global starts | **Closed.** This is the one that bounds an attack. |
| Per-destination failed verifications | **Closed.** If it cannot count, it cannot tell a typo from a run, and the cost of being wrong is unbounded guessing. |
| Turnstile | **Closed.** Unchanged. |
| Email suppression check | **Closed.** Sending to a known-bad address is how the identity gets suspended. |

Nothing new fails open. The per-recipient SMS limiter stays as it is, in the
trigger, where it already is.

## Native passwordless, and why not

Cognito has a managed passwordless flow now, `USER_AUTH` with `EMAIL_OTP` and
`SMS_OTP` as first factors. It would delete a lot of the custom lambda code
here, so it is worth more than a sentence. Checked against the live pools
rather than reasoned about:

| | AIEP - Staging | AIEP - Prod |
|---|---|---|
| `UserPoolTier` | `ESSENTIALS` | `ESSENTIALS` |
| `AllowedFirstAuthFactors` | `PASSWORD`, `SMS_OTP` | `PASSWORD`, `SMS_OTP` |
| `ExplicitAuthFlows` on the client | no `ALLOW_USER_AUTH` | no `ALLOW_USER_AUTH` |
| `EmailConfiguration` | `COGNITO_DEFAULT` | `COGNITO_DEFAULT` |

So the tier supports it. Essentials is the plan that carries choice-based
authentication; that was the thing that could have decided this on its own and
it does not.

Two facts are worth noticing anyway. `SMS_OTP` is **already** an allowed first
factor on both pools, and `ALLOW_USER_AUTH` is **not** on either app client,
so the flow is enabled at the pool and unreachable from the client. Neither
`featurePlan` nor `signInPolicy` is set anywhere in `new-auth.ts`. That
configuration was made out of band and this repo does not know about it, which
is the same category of surprise as the CloudFront aliases that `index.ts`
also does not declare.

**Recommendation: stay on the custom-auth triggers.** Three reasons, in order
of weight.

1. **Native email OTP cannot be gated on our suppression list.** Cognito
   builds and sends the message itself. There is no hook between deciding to
   send and sending, so the fail-closed check that the whole SES design is
   built around has nowhere to run. With `COGNITO_DEFAULT` it is worse still:
   the mail goes out through Cognito's shared sender, capped around 50 a day,
   with no configuration set, no bounce routing, and none of the alarms. Using
   it would mean choosing a delivery path that is invisible to every control
   we are building.
2. **It cannot send in the parent's language.** The whole point of the
   language handshake round is that the code arrives in the language the
   parent is using. Native flows have per-pool message templates, not
   per-user ones.
3. **The measured state of the directory does not fit it.** Native `SMS_OTP`
   needs a verified phone number, and `phone_number_verified` is not set on
   any of the 221 phone accounts in production. Native `EMAIL_OTP` needs a
   verified email, and 8 of the 75 email accounts have
   `email_verified: false`. Custom auth lets us decide what possession proves;
   native does not.

The fourth reason is smaller but not nothing: the E2E suite works because
`create-auth-challenge.js` can stash a code in Parameter Store for fictional
test numbers. Native flows have no such seam, so adopting them means deleting
the coverage, which is the trade the repo has already decided it does not
make.

What to do instead: **pin `featurePlan` and `signInPolicy` in `new-auth.ts`**
so the live values stop being invisible, and set `AllowedFirstAuthFactors` to
what we actually intend. Leaving a supported passwordless path enabled at the
pool and unreachable only by omission from the client is exactly the shape of
gap this document exists to close.

## The endpoint, in order

Order matters: each step is cheaper than the one after it, so an abusive
request is rejected before it costs anything.

1. Shape and format validation. Rejects malformed input for free.
2. Destination policy. `+1` for phone, as today. For email, a syntactic check
   plus a disposable-domain refusal.
3. Per-IP limit. The endpoint sees the caller IP; the Cognito trigger never
   did, which is why the run's 293 addresses were invisible to us.
4. Global limit. Bounds total damage regardless of how the source is spread.
5. Turnstile. Last, because it is the only step with an external dependency
   and the slowest.
6. Create the user, suppressing Cognito's own message, then set a
   server-generated password immediately.

Steps 3 and 4 fail closed. Step 5 fails closed. A signup is roughly a daily
event, so a refusal costs a parent a retry.

### The same order, as two routes

`POST /auth/start` keeps all six steps above and adds three:

7. `AdminGetUser`. If absent, create and rotate as in step 6. If present, do
   nothing.
8. `AdminInitiateAuth` with `CUSTOM_AUTH` on the confidential client. This is
   what sends the code, exactly once, through `create-auth-challenge`.
9. Store Cognito's `Session` server-side against a random handle, five-minute
   TTL, and return the handle.

`POST /auth/verify` takes the handle and the code:

1. Shape validation.
2. Per-destination failed-verification count.
3. Look up the Cognito session by handle. An unknown or expired handle is the
   same generic refusal as a wrong code.
4. `AdminRespondToAuthChallenge`.
5. On success, mint the session handle cookie and return access and ID tokens.
   On failure, increment the counter and delete nothing: the handle stays
   usable for the remaining attempts, because Cognito is counting those.

Turnstile is on `start` only. Requiring it again on `verify` would mean a
second widget solve in the middle of typing a code, for no gain: `verify`
cannot be reached without a handle, and a handle cannot be obtained without
solving it once.

### What moves, what is reused, what dies

`signup-endpoint.js` is not replaced. It is the skeleton of `/auth/start`, and
most of it survives verbatim.

| Piece | Fate |
|---|---|
| Cheapest-first ordering | **Reused**, extended with the three steps above. |
| `overLimit()`, fail-closed | **Reused as-is**, one more key shape for the per-destination counter. |
| `sourceKey()`, hashed IP | **Reused as-is.** |
| Turnstile verify + `loadSecret` | **Reused as-is**, now covering the email path too, which has no bot check at all today. |
| `serverPassword()` and the `AdminSetUserPassword` step | **Reused, unchanged, and this is the load-bearing one.** It is what kept the ~1,030 accounts of the run unusable. It stays a separate `try` with the delete-on-failure rollback and the `SIGNUP_ORPHANED` marker. Do not fold it back into the create. |
| `SIGNUP_ACCEPTED`, the byte-identical body | **Reused**, and now needs the timing floor to be worth anything. |
| `isE2EBypass()` | **Reused**, with the allowlist extended to test email addresses. Both locks stay: the SSM parameter that only exists outside production, and the destination allowlist. |
| `E164` and the `+1` prefix policy | **Reused** for the phone branch; the email branch gets its own syntactic check plus the disposable-domain refusal. |
| The `UsernameExistsException` "proceed to sign-in" branch | **Dies.** With `AdminGetUser` first, it becomes a race-only path, not the normal one. |
| The frontend's signIn-then-catch branching | **Dies entirely**, which is the point. |

Note that there are currently **two** implementations of the password
rotation: this one, and the PostConfirmation trigger in Python
(`test/python/test_cognito_trigger.py`, 19 tests). Once the endpoint is the
only way an account is created, PostConfirmation's rotation is unreachable.
Leave it in place through the rollout and delete it in a separate change, with
its tests, once the pool has been admin-create-only in production for a full
release. Deleting a security control on the same day you start relying on its
replacement is how the replacement's gaps get found in production.

## Why the password rotation moves

`AdminCreateUser` fires neither `PreSignUp_SignUp` nor
`PostConfirmation_ConfirmSignUp`, so both the auto-confirm and the password
rotation stop happening on their own. That rotation is the control that
prevented account takeover on ~1,030 accounts during the attack, so it does
not get to be an accident of trigger routing. It becomes an explicit step in
the endpoint: create, then set a permanent server-generated secret, in the
same function, where it can be read.

## Email OTP

Reuses the existing custom-auth triggers rather than Cognito's managed
passwordless flow, for the reasons set out above. `create-auth-challenge`
gains an email branch that sends via SES instead of SNS. The language
handshake, the expiry, the attempt limit and the rate limiting all apply
unchanged, which is the point.

Two corrections to the claim that the other two triggers need no change.

`define-auth-challenge` genuinely needs none. It never looks at a
destination.

`verify-auth-challenge` does. Its fallback profile creator hardcodes
`authMethod: 'phone'` and `phoneVerified: true` on every profile it writes, so
an email parent's first sign-in would produce a profile asserting a verified
phone they do not have. It needs to branch on which attribute the username is.
Small, but it writes a durable record, so it is not cosmetic.

`create-auth-challenge` also reads `event.request.userAttributes.phone_number`
before anything else and throws when it is missing. That guard is correct
today and becomes the first thing an email user hits.

## Bounces and complaints

Scoped separately and in more depth, because it is a workstream of its own:
the SES configuration set, the DynamoDB suppression list, the bounce handler,
the reputation and count alarms, and the send-side ceilings. See
`lib/chatbot-api/email/email-identity.ts`, which already implements most of
the CDK side.

**It lands before this does.** The email branch above cannot be written until
`wireSender()` exists, because that is what grants `ses:SendEmail` and sets
`SES_CONFIGURATION_SET`, `SES_FROM_ADDRESS` and `EMAIL_SUPPRESSION_TABLE`. And
the rails should exist before the first send rather than after the first
incident, which is constraint 4.

Facts from the account, checked rather than assumed: `a-iep.org` is verified
and DKIM-signed, the account has production access with a 50,000 a day quota,
and `EnforcementStatus` is `HEALTHY`. So there is no sandbox to escape. The
account is shared with other projects' verified identities, and SES
reputation is per-account, so an abuse run against A-IEP's login can stop
another project's mail and vice versa.

One thing that is not as the draft construct assumes: the `a-iep.org` identity
**already has a default configuration set**, `my-first-configuration-set`, and
that set has no event destinations at all. So a send that forgets to name our
configuration set does not fall back to plain SES. It succeeds, counts against
the shared reputation, and has its bounces discarded. The unit test pinning
`ConfigurationSetName` on every send is therefore not belt-and-braces; it is
the control.

## Migration

Measured against the production pool, not estimated. 296 accounts: **221 with
a phone number only, 75 with an email address only.** No account has both. Of
the 75 email accounts, **67 are `email_verified: true` and 8 are false**. 34
accounts across the pool are still `UNCONFIRMED`.

Email users need no data migration: removing password auth does not delete
their account, and email OTP works against the same identity. They do need
telling, because their password will simply stop being asked for.

The 8 unverified addresses are the group that needs a decision rather than a
notice. Under custom auth we can treat receiving the code at that address as
the proof, and set `email_verified` on first successful verification, which is
exactly what possession means. That is the recommendation. It is also the
thing native `EMAIL_OTP` would not let us do.

**Before step 5, send one mail to all 75 and read the bounces.** This is the
only chance to find a dead or mistyped address while those parents still have
a password to fall back on. Any address that hard-bounces keeps a password
path and gets contacted out of band. Doing this after passwords are gone means
discovering the problem as a locked-out parent with no way to tell us.

**Rollback.** Steps 1 to 4 revert by redeploying: no record is migrated and no
credential is destroyed. Step 5 is different in kind, and the rollback is not
symmetric.

- Re-adding `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_USER_SRP_AUTH` restores the
  flow, and the 67 verified accounts still hold working passwords, because
  nothing in this plan changes their password. So step 5 is reversible for
  them.
- It is **not** reversible for anyone created by the endpoint after step 1.
  Those accounts hold a server-generated password nobody has ever seen, by
  design. They have no password path to fall back to, ever. That is not a
  regression, it is the control working, but it means the rollback restores
  password auth for the old accounts only.
- So the real rollback for step 5 is "put passwords back for the 75 and leave
  everyone else on OTP", and the thing that must not break is OTP itself.
  Which is why step 5 comes last and why the endpoint should have carried real
  traffic for a full release before it is taken.

## Rollout order

1. Endpoint deployed, self-service signup still enabled. Nothing changes yet.
2. Frontend switched to the endpoint. Both paths work.
3. `AllowAdminCreateUserOnly` set. Public signup closed.
4. Email OTP shipped, email+password still accepted.
5. Password auth flows removed from the app client. Passwords gone.

Each step is independently reversible. Step 3 is the one that closes the hole;
step 5 is the one that cannot be undone quietly, because it changes how 75
people sign in.

Step 3 is already done on staging and is **not** done in production:
`selfSignUpEnabled: false` is in `new-auth.ts`, the staging pool reads
`AllowAdminCreateUserOnly: true`, and the production pool still reads `false`
because `main` is behind. Production is running the pre-Turnstile,
pre-endpoint auth code. Nothing in this document is live for families yet.

Two steps are missing from the list and belong in it:

- **0.** The two app clients, before anything else. Retrofitting a
  confidential client after the frontend has been switched means switching it
  twice.
- **2a.** The API custom domain, before the frontend switch, if the cookie
  decision goes the way this document recommends.

## Tests that ship with it

The existing coverage is substantial and most of it is a tripwire this change
will trip on purpose. That is the point of it, so the work is to move each pin
rather than relax it.

**What breaks, and should.**

| Pinned today | Why it breaks | What it becomes |
|---|---|---|
| `user pool client keeps the custom-auth contract`: `ExplicitAuthFlows` contains `ALLOW_CUSTOM_AUTH` | The public client loses it | Two assertions: the confidential client has it, the public client does **not** |
| `the signup endpoint can create a user AND replace its password, on one pool`: sorted actions **exactly** `AdminCreateUser, AdminDeleteUser, AdminSetUserPassword` | `AdminGetUser`, `AdminInitiateAuth`, `AdminRespondToAuthChallenge` and `AdminUserGlobalSignOut` join it | Same exact-match shape with the new list. Keep it exact; an exact-match IAM assertion is the only kind that catches a permission creeping in. |
| `signup is reachable without a token, because there cannot be one yet` | Two routes now, not one | `PUBLIC_ROUTE_KEYS` gains `POST /auth/start` and `POST /auth/verify`, and the "exactly these and no others" test does the rest |
| `CustomLogin.test.tsx`, 17 tests, asserts the `auth/signup` URL | The branching it tests is being deleted | Rewritten against the two new routes. Most of the assertions have no successor because the state machine they cover is going away. |
| `resignup.spec.ts` | The signup path changes shape | **Keep the assertion, change the plumbing.** Its send-count delta check is the only proof of "never two OTPs" and it must survive intact. |
| `e2e/helpers/app.ts`, `allowSignupPastTurnstile` routes `**/auth/signup` | Route renamed | Point it at `/auth/start` |
| `no production lambda can bypass the signup bot check` | New function | Extend the offender sweep to it; this is the one that must not be allowed to go stale |

**What must not be weakened.** The production-synth suite, which pays for a
second full synth to prove the staging backdoors are absent, gains a function
and loses nothing. `TEST_PHONE_NUMBERS`, `TEST_OTP_PARAM_PREFIX` and
`E2E_BYPASS_PARAM` are pinned by exact string in both the presence and absence
directions, and the email test destinations need the same treatment on both
sides before the email branch ships.

**New unit coverage.**

- `/auth/start`: each refusal path, each fail-closed path, the cheapest-first
  ordering asserted by call counts, one send and never two, the identical body
  on both branches, and the timing floor applied to refusals as well as
  successes.
- `/auth/verify`: wrong code, expired handle, unknown handle, the
  per-destination cap tripping, and the cap producing the lockout copy rather
  than the generic one.
- Refresh: rotation issues a new handle, the old handle is rejected, and a
  replayed handle triggers family revocation and `AdminUserGlobalSignOut`.
  **Mutation-check this one**: disable the reuse detection, watch it fail,
  restore, and say so.
- `turnstile.js` gets the dedicated test file it has never had. It is covered
  only indirectly today, through the mocks in two other suites, so a change to
  its export shape breaks those suites for a reason unrelated to what they
  test.

**New infra assertions.**

- Reserved concurrency is set on the auth functions, with the value pinned.
  Nothing in this repo asserts reserved concurrency anywhere today.
- Per-route throttling exists on `/auth/start`. Also a first.
- CORS on the auth routes names explicit origins and not `*`, if the cookie
  decision lands.
- The sessions table is `RETAIN`, CMK-encrypted, and TTL'd.
- The confidential client's secret is not in the template in plaintext.

**New E2E.** An email OTP journey mirroring the phone one, which needs a test
email destination with the same double-lock the phone backdoor has: an
allowlist the code checks independently of the environment variable, and a
stash location that only exists outside production. Do not ship the email
branch before that seam exists, or the journey gets skipped and then deleted.

**Bug-fix discipline.** The `verify-auth-challenge` profile bug above
(`authMethod: 'phone'` hardcoded) gets a test that fails before the fix and
passes after, run both ways, and said so.

## Open decisions for a human

Everything above is a recommendation with the reasoning attached. These five
genuinely need the product owner, because each one trades something a user
feels against something only we feel.

**1. Login gets about a second slower, for everybody, forever.**
Recommended: accept it. The timing floor is what makes the identical response
body mean anything, and without it the enumeration this whole change exists to
close stays open to anyone with a stopwatch.
Cost of the alternative: skip the floor and the endpoint is the same
enumeration oracle as the frontend, just harder to notice. Half-measures do
not exist here; a partial floor is a smaller signal, not no signal.

**2. The API needs a custom domain, or the refresh token stays in the
browser.**
Recommended: add `api.a-iep.org` and `api.dev.a-iep.org` and put the session
handle in an `HttpOnly` cookie. It is an ACM certificate, a Cloudflare record
and an API Gateway domain mapping.
Cost of the alternative: the handle goes in `localStorage` instead. That is
still better than today, because it is revocable and rotating, but it is
readable by any script that gets onto the page. If the answer is "not now",
build the server-side session anyway and move the handle into a cookie later;
that migration is a header change, whereas moving off a browser-held refresh
token later is a re-auth for everybody.

**3. What a parent sees when the per-destination cap trips.**
Recommended: tell them plainly, "Too many incorrect codes. Please try again in
an hour", in their language. The cap is keyed on the destination whether or
not an account exists, so it leaks nothing.
Cost of the alternative: the generic "that code did not work" leaves a parent
retyping a correct code into a wall with no idea why. That is a support
burden and a bad experience bought for no security gain.

**4. Whether to pin the pool's feature plan and sign-in policy in CDK.**
Recommended: yes, and set `AllowedFirstAuthFactors` to what we intend.
Production currently allows `SMS_OTP` as a first auth factor at the pool, put
there out of band, reachable only because no app client requests it.
Cost of the alternative: leave it. It is not exploitable today. It is,
however, exactly one `ExplicitAuthFlows` edit away from being an OTP send path
with no Turnstile in front of it, and nobody would be reviewing that edit
against a document that mentions it.

**5. When the ~1,030-account cleanup and the 34 `UNCONFIRMED` accounts get
dealt with.**
Recommended: before step 5, not after. An `UNCONFIRMED` account cannot
complete custom auth, so after passwords are gone those parents have no path
at all, and we will not be able to tell the real ones from the leftovers of
the abuse run.
Cost of the alternative: 34 accounts that quietly stop being able to sign in,
discovered one support message at a time.

There is a sixth thing that is not a decision but should be said out loud: at
1,242 lines, `CustomLogin.tsx` is well past the repo's own 800-line ceiling,
and roughly a third of its `auth.*` translation keys are dead. This change
deletes most of what makes it that long. Treat the shrink as part of the work
rather than as a follow-up that never comes.
