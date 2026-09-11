# A-IEP auth API contract

Status: implemented, 2026-09-11. The normative description of `/auth/start`,
`/auth/verify`, `/auth/token` and `/auth/logout`.

This document is written so a client can be built against it without asking
anybody a question. Where it disagrees with `docs/PASSWORDLESS_AUTH_PLAN.md`,
this document is what shipped.

Base URL: the HTTP API's `apiEndpoint` output (`https://<id>.execute-api.
us-east-1.amazonaws.com`), the same origin every other A-IEP API call uses.
All four routes are `POST`, take `Content-Type: application/json`, and are
**unauthenticated** at the gateway: there is no token to authorize a sign-in
with.

---

## 1. The shape, in one paragraph

A parent types one thing: a US phone number or an email address. The client
posts it to `POST /auth/start` with a Cloudflare Turnstile token and gets back
an opaque **challenge handle**. The service sends exactly one code to that
destination, creating the account first if it does not exist, and the response
body is byte-identical either way. The parent types the code; the client posts
it with the challenge handle to `POST /auth/verify` and gets back an opaque
**session handle**. The real Cognito tokens never reach the browser: they are
held server-side against that handle, and the client exchanges the handle for a
short-lived access token and ID token at `POST /auth/token` whenever it needs
to call the rest of the API. `POST /auth/logout` destroys the session. The
client stores exactly one durable value, the session handle, and nothing else.

---

## 2. `POST /auth/start`

Starts an authentication. Creates the account if the destination is not
already registered. Sends one code, never two.

### Request

```json
{
  "destination": "+15551234567",
  "turnstileToken": "0.PtQ1aR...",
  "language": "es"
}
```

| Field | Required | Notes |
|---|---|---|
| `destination` | yes | A US phone number in E.164 (`+1` followed by 10 digits) **or** an email address. The service decides which it is; the client does not say. Leading and trailing whitespace is stripped. |
| `turnstileToken` | yes | The token from the Turnstile widget. |
| `language` | no | One of `en`, `es`, `zh`, `vi`, `ar`. Anything else is ignored and the code is sent in the language already on the account, or English. |

There is no `mode`, no `isSignup`, and no way for the client to say whether it
expects the account to exist. That is the whole point: the client never asks a
question whose answer is "this person has an account".

### Success — `200`

```json
{"ok":true,"challenge":"IvrPWtNvBOCFSRj-_CD3mA9ZiJ0dtMUk_bYs1xHBOsY","channel":"sms","expiresIn":300}
```

| Field | Notes |
|---|---|
| `challenge` | Opaque, 43 characters, base64url. Pass it to `/auth/verify`. Not a JWT, not decodable, and it carries no information about the parent. |
| `channel` | `"sms"` or `"email"`. Derived only from what the caller just sent, so it reveals nothing the caller did not already know. Use it for the copy on the code screen ("we texted you" vs "we emailed you"). |
| `expiresIn` | Seconds the challenge handle is good for. Always `300`. |

**This body is identical for a brand new destination and for one of the 296
existing accounts.** The same fields, the same order, the same length. The
work is identical too: see §7.

### Failure

Every failure body has the same three fields:

```json
{"ok":false,"code":"rate_limited","message":"Too many attempts. Please try again in a little while."}
```

`code` is the stable, machine-readable value. **Branch on `code`, never on
`message`.** `message` is English and is a fallback for a client that has no
copy for a code it has not seen before.

| HTTP | `code` | When | `message` |
|---|---|---|---|
| 400 | `invalid_request` | Body is not JSON, or `destination` is missing or empty. | `Enter your phone number or email address.` |
| 400 | `invalid_destination` | `destination` is neither a valid E.164 phone number nor a syntactically valid email address. | `Enter a valid phone number or email address.` |
| 400 | `unsupported_destination` | A phone number outside the allowed dialling prefixes (`+1`), or an email address on a disposable or reserved domain. | `A-IEP can only send codes to United States phone numbers and regular email addresses.` |
| 403 | `bot_check_failed` | Turnstile rejected the token, or no token was supplied while the check is switched on. | `We could not verify this request. Please try again.` |
| 429 | `rate_limited` | The per-source or service-wide start budget is spent. | `Too many attempts. Please try again in a little while.` |
| 503 | `unavailable` | A fail-closed dependency is down: the rate-limit table, the Turnstile secret, or the session store. | `Sign-in is temporarily unavailable. Please try again in a little while.` |

A `429` carries one extra field, `retryAfterSeconds` (an integer). Nothing
else does.

Every one of these is logged server-side with a reason before it is returned.
There are no silent 4xx paths.

---

## 3. `POST /auth/verify`

Answers the challenge.

### Request

```json
{"challenge":"IvrPWtNvBOCFSRj-_CD3mA9ZiJ0dtMUk_bYs1xHBOsY","code":"482913"}
```

| Field | Required | Notes |
|---|---|---|
| `challenge` | yes | Exactly the value `/auth/start` returned. |
| `code` | yes | The digits the parent typed. Whitespace is stripped; nothing else is normalised. A-IEP always sends six; four to eight are accepted so a future change to the code length is not a client change. |

No Turnstile token. `/auth/verify` cannot be reached without a challenge
handle, and a challenge handle cannot be obtained without solving Turnstile
once. Asking again would mean a second widget solve in the middle of typing a
code, for no gain.

### Success — `200`

```json
{"ok":true,"session":"m7Kq2s0Xb1fLpA6uVe4tYc9RdN8gHjZwQ3vM5nB7xTk","expiresIn":2592000}
```

| Field | Notes |
|---|---|
| `session` | Opaque, 43 characters, base64url. **This is the only value the client stores durably.** |
| `expiresIn` | Seconds the session handle is good for. Always `2592000` (30 days). |

No access token, no ID token, and above all no refresh token. See §5.

### Still sending — `202`

```json
{"ok":false,"code":"not_ready","retryAfterMs":500}
```

The code is on its way but the send has not finished. This is a normal,
expected state for the first few hundred milliseconds after `/auth/start`,
because the send happens off the request path (§7). **Wait `retryAfterMs` and
post the same request again.** A parent who has read a text message and typed
six digits will essentially never see it.

Retry at most six times (three seconds), then treat it as `unavailable`.

### Failure

| HTTP | `code` | When | `message` |
|---|---|---|---|
| 400 | `invalid_request` | Body is not JSON, or `challenge`/`code` is missing or empty. | `Enter the code we sent you.` |
| 401 | `bad_code` | The code is wrong, **or** the challenge handle is unknown, **or** it has expired, **or** the three attempts Cognito allows in one session are spent. All four collapse into one answer on purpose. | `That code did not work. Check the code and try again, or ask for a new one.` |
| 409 | `send_failed` | The code could never be delivered. Carries `reason` (below). | varies, see `reason` |
| 429 | `too_many_codes` | Ten wrong codes for this destination in one hour. Carries `retryAfterSeconds`. | `You have tried too many codes. Please try again in an hour.` |
| 503 | `unavailable` | The session store could not be read or written. | `Sign-in is temporarily unavailable. Please try again in a little while.` |

On `bad_code`, **keep the challenge handle and let the parent retype**. Cognito
allows three answers per challenge, and the third wrong one ends it: after
that every request with that handle returns `bad_code` for a different
reason, and the client should go back to the start screen. The client cannot
tell which of the four causes it hit, and must not try. Two retries in the UI
and then a fresh start is the right budget.

On `too_many_codes`, tell the parent plainly: they have tried too many codes,
and they can try again in `retryAfterSeconds` (always under an hour). This is
not an enumeration leak — the counter is keyed on the destination whether or
not an account exists there, so a stranger's number and a registered one give
the identical answer. Saying nothing would leave a parent retyping a correct
code into a wall.

`send_failed` reasons:

| `reason` | Meaning | `message` |
|---|---|---|
| `unsupported_destination` | The destination passed the format check but the send path refuses it (a non-`+1` number that slipped through, or a suppressed email address). | `A-IEP cannot send codes to this address. Please try your phone number instead.` |
| `budget_exhausted` | The service-wide SMS or email ceiling is spent. Retrying later works. | `Codes are temporarily unavailable. Please try again in a little while.` |
| `rate_limited` | This destination has asked for too many codes this hour. | `Too many codes requested. Please wait an hour and try again.` |
| `delivery_failed` | The send itself broke. | `We could not send your code. Please try again.` |

A `send_failed` is terminal for that challenge handle: send the parent back to
the start screen. It is returned here rather than from `/auth/start` because
the send happens after `/auth/start` has already answered (§7), and telling a
parent the truth late beats telling them a comfortable lie on time.

---

## 4. `POST /auth/token`

Exchanges the session handle for the short-lived tokens the rest of the API
needs. Call it on app start, and again whenever a call returns `401`.

### Request

```json
{"session":"m7Kq2s0Xb1fLpA6uVe4tYc9RdN8gHjZwQ3vM5nB7xTk"}
```

### Success — `200`

```json
{"ok":true,"accessToken":"eyJra...","idToken":"eyJra...","expiresIn":3600}
```

Both tokens are Cognito user-pool JWTs with a one-hour life. **Keep them in
memory only.** Writing them to `localStorage` re-creates the thing this design
exists to remove.

`expiresIn` is the remaining life in seconds, not always 3600: a handle
presented 50 minutes after the last refresh gets what is left. Refresh when it
drops below 300.

Every other A-IEP API call sends `Authorization: Bearer <idToken>`. The `Bearer
` prefix is required by this contract even though the gateway currently
tolerates its absence.

### Failure

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | `session` missing or empty. |
| 401 | `session_invalid` | Unknown handle, expired handle, or Cognito refused the refresh (the account was disabled, deleted, or globally signed out). Clear the stored handle and go to the start screen. |
| 503 | `unavailable` | The session store could not be read. Do **not** clear the handle; retry. |

The difference between `401` and `503` is load-bearing for the client: one
means sign in again, the other means try again.

---

## 5. `POST /auth/logout`

### Request

```json
{"session":"m7Kq2s0Xb1fLpA6uVe4tYc9RdN8gHjZwQ3vM5nB7xTk"}
```

### Response — `200`, always

```json
{"ok":true}
```

Idempotent, and identical for a valid handle, an expired one and one that never
existed. Deleting the row is immediate: a revoked handle stops working on the
next call rather than waiting out a 30-day token.

`/auth/logout` also calls Cognito's `AdminUserGlobalSignOut`, so the refresh
token held server-side stops working everywhere, not just here.

---

## 6. Where the tokens live, and what would move for a cookie

**Today.** `/auth/verify` returns an opaque handle. The client stores it in
`localStorage` under one key. The Cognito access, ID and refresh tokens are
written to a server-side DynamoDB table (`AuthSessionTable`), encrypted at rest
with the application CMK, keyed by `sha256(handle)` so a read of the table
yields no usable handle, with a TTL that removes the row.

The refresh token is never serialized to the browser in any form.

**What the product owner decided, and what is not built.** The handle sits in
`localStorage` for now rather than an `HttpOnly` cookie. A cookie needs the API
on the same registrable domain as the app (`api.a-iep.org` /
`api.dev.a-iep.org`), which is an ACM certificate, a Cloudflare record and an
API Gateway domain mapping that do not exist yet.

**Exactly what moves when they do.** One module,
`lib/chatbot-api/functions/phone-otp-auth/auth-transport.js`, is the only place
the handle's transport is decided. It has two functions:

- `readHandle(event, field)` — today reads the named field out of the JSON
  body. Becomes: read the `aiep_session` cookie from the `Cookie` header.
- `writeHandle(body, handle, field)` — today writes the named field into the
  JSON body. Becomes: leave the body alone and return a `Set-Cookie` header.

And three things outside it:

1. `corsPreflight` in `lib/chatbot-api/gateway/rest-api.ts` goes from
   `allowOrigins: ['*']` / `allowCredentials: false` to the two real app
   origins with credentials allowed.
2. The client's `/auth/*` fetches gain `credentials: 'include'` and stop
   sending or reading `session`.
3. The API gets a custom domain.

**Nothing else changes.** Not the handle's value, its length, its entropy, its
TTL, the table schema, the lookup, the revocation, or any of the four
endpoints' other fields. The handle's transport is the only thing that moves,
which is the property decision 1 asked for.

---

## 7. Why `/auth/start` answers before the code is sent

An identical response body is defeated by a stopwatch. Creating an account is
`AdminCreateUser` plus `AdminSetUserPassword`; signing an existing one in is
neither. Two extra round trips to Cognito are tens to hundreds of milliseconds,
repeatable, and averaging over a few hundred requests separates a registered
destination from an unregistered one cleanly. OWASP ASVS 5.0 §6.3.8 requires
that valid users cannot be deduced from different response times, and OWASP's
Authentication and Forgot Password cheat sheets prescribe equalising the
**work**, not the clock.

So `/auth/start` does not sleep, and it does not branch. It does the same six
cheap things for every caller — validate, destination policy, per-source limit,
global limit, Turnstile, write the challenge row — then hands the rest to a
second Lambda by asynchronous invocation and answers. Nothing that depends on
whether the account exists happens while the caller is waiting. A new account
and a returning parent are not merely indistinguishable in the body: they run
the same instructions.

The cost is that the send's outcome is not known when `/auth/start` answers,
which is why `not_ready` and `send_failed` exist on `/auth/verify`. That is a
real cost and it is paid deliberately: the alternative was a 1.2-second sleep
on every sign-in by every parent, forever.

---

## 8. The client-visible state machine

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
                 ┌──────┐                                      │
                 │ idle │◀──────────────────────────────┐      │
                 └──┬───┘                               │      │
                    │ POST /auth/start                  │      │
       ┌────────────┼────────────────┐                  │      │
   200 │        4xx/5xx              │                  │      │
       ▼                             ▼                  │      │
┌──────────────┐            show message, stay idle      │      │
│ awaiting_code│                                         │      │
└──┬───────────┘                                         │      │
   │ POST /auth/verify                                   │      │
   ├── 202 not_ready ──▶ wait retryAfterMs, repeat ──────┤      │
   ├── 401 bad_code ───▶ stay, let them retype ──────────┤      │
   ├── 409 send_failed ──────────────────────────────────┘      │
   ├── 429 too_many_codes ──▶ ┌────────────┐                    │
   │                          │ locked_out │────────────────────┘
   │                          └────────────┘  after retryAfterSeconds
   └── 200 ok
        ▼
   ┌───────────┐
   │ signed_in │  hold `session` in localStorage
   └──┬────────┘
      │ POST /auth/token  (on app start, and on any 401 from another API)
      ├── 200 ──▶ hold accessToken/idToken IN MEMORY, expire in `expiresIn`
      ├── 401 session_invalid ──▶ clear the handle, go to idle
      └── 503 unavailable ──▶ keep the handle, retry
      │
      │ POST /auth/logout ──▶ clear the handle, go to idle
```

Five states and nothing else: `idle`, `awaiting_code`, `locked_out`,
`signed_in`, plus the transient token fetch. There is no "is this a signup or a
sign-in" state, because the client never learns which one it did.

**The state belongs to the server, not to a component.** `awaiting_code` is
recoverable from `localStorage`: persist the challenge handle alongside the
session handle so that leaving the page mid-flow and coming back does not
strand a parent who has a code in their hand. The challenge handle is harmless
to persist — it is single-use, expires in five minutes, and is worthless
without the code.

---

## 9. Copy, and who owns it

The backend returns English in `message`. **The client does not display
`message` when it recognises `code`.** Every code above needs a translation key
in all five dictionaries under `app/src/translations/`; `t()` has no English
fallback, so a missing key renders the raw dot-separated key to a parent.

Suggested key shape, matching the existing `auth.*` namespace:

```
auth.error.invalidRequest
auth.error.invalidDestination
auth.error.unsupportedDestination
auth.error.botCheckFailed
auth.error.rateLimited
auth.error.unavailable
auth.error.badCode
auth.error.tooManyCodes          takes {minutes}
auth.error.sendFailed.unsupportedDestination
auth.error.sendFailed.budgetExhausted
auth.error.sendFailed.rateLimited
auth.error.sendFailed.deliveryFailed
auth.error.sessionInvalid
```

`auth.error.tooManyCodes` is the one that must not be generic. Decision 4: tell
the parent plainly that they have tried too many times and when they can try
again. `retryAfterSeconds` divided by 60 and rounded up is the number of
minutes to put in it.

---

## 10. What is deliberately unchanged, and must stay that way for now

**The old login path still works.** The public Cognito app client keeps
`ALLOW_CUSTOM_AUTH`, so the current frontend's direct `InitiateAuth` call
continues to function exactly as it does today. Both paths are live at the same
time, on purpose: removing `ALLOW_CUSTOM_AUTH` the moment these endpoints
landed would have broken sign-in for every parent using the deployed app.

Removing it is the **follow-up step, after the frontend has switched**, and it
is what finally closes the hole where anyone holding the public client id can
call `InitiateAuth` directly and make A-IEP text the 221 production phone
accounts with no bot check in the path. There is a `TODO` at the call site in
`lib/authorization/new-auth.ts` and a test in
`test/infra/gen-ai-mvp-stack.test.ts` that documents the current state and will
need updating in the same change. Until then, Turnstile guards the new path
only.

**`POST /auth/signup` still exists** and is unchanged. It is the route the
deployed frontend posts to. It will be deleted with `ALLOW_CUSTOM_AUTH`.

**The password rotation is unchanged.** An account created by `/auth/start` is
made with `AdminCreateUser` + `MessageAction: SUPPRESS` +
`phone_number_verified: true` (or `email_verified: true`), and then immediately
given a server-generated password nobody ever sees, in a separate `try` with
delete-on-failure rollback. That pair is the only reason the ~1,030 accounts
created by the 2026-09-09 abuse run are unusable. It did not move and it did
not change.

---

## 11. How the frontend should land this

Behind a feature flag, not as a branch. `CLAUDE.md` is explicit: hold a feature
back with `enabledFeatures`
(`lib/user-interface/app/src/common/features.ts`, resolved in
`lib/user-interface/index.ts` and `app/vite.config.ts`, overridable with
`ENABLED_FEATURES`), never by carving code out of one branch. `ALL_FEATURES` is
currently `['tts', 'referrals', 'parentNameGate']`; this needs a fourth entry,
on in `dev` and off in `prod` until it has carried real traffic.

The flag is what makes the rollout reversible. Both backends are live at the
same time (§10), so flipping it back puts every parent on the path they are on
today with no deploy of the backend at all. Carving the old path out instead
forks the tree, forces deleting the tests that cover it, and turns the
promotion into hand surgery.

The 17 `CustomLogin.test.tsx` cases that assert the `auth/signup` URL cover the
state machine that is being replaced. Most of them have no successor. Rewrite
them against the two new routes rather than deleting them and moving on, and
add the one case the repo's own rules ask for: **leave the page mid-flow and
come back.** The bottom nav is a route change, so leaving unmounts the
component, and a challenge handle that only lived in `useState` comes back as
`idle` — a parent holding a code in their hand with nowhere to type it. That is
the same defect `resumeTranslationRequest` exists to fix on the document
screen. Persist the challenge handle (§8) and cover it by leaving and
returning, not by asserting the first render.

## 12. Not built yet

Stated plainly so nobody builds against something that is not there.

- **Handle rotation with reuse detection.** `/auth/token` returns the same
  handle it was given. Rotating on every exchange, and treating a replayed old
  handle as theft, is the property that makes a server-side session strictly
  better than a refresh token in a browser, and it is a follow-up. Revocation
  and the TTL are built; rotation is not.
- **The `HttpOnly` cookie**, for the reasons in §6.
- **Per-route throttling** on `/auth/start` at the gateway. Reserved
  concurrency is set (§13); gateway-level throttling is not.
- **An email E2E journey.** The staging seam it needs exists (a test-address
  allowlist with the same double lock as the phone one), but no journey uses it.

---

## 13. Operational facts a client author may need

| Fact | Value |
|---|---|
| Challenge handle life | 300 s, matching the OTP's own validity and the pool client's `authSessionValidity` |
| Session handle life | 2 592 000 s (30 days), sliding on each `/auth/token` |
| Access / ID token life | 3600 s |
| Answers allowed per challenge | 3; the third wrong one ends the challenge. Enforced by `define-auth-challenge`, not by this service |
| Wrong codes per destination per hour | 10, then `too_many_codes` |
| Codes per destination per hour | 5, enforced on the send path |
| Reserved concurrency | 20 on each of the four auth lambdas (start, verify, session, dispatcher) |
| Retry on `not_ready` | every 500 ms, at most 6 times |

A code is reused within its five-minute window: asking for the same challenge
again does not send a second message, and the count above is a count of
messages, not of requests.
