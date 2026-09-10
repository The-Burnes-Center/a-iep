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
passwordless flow. `define-auth-challenge` and `verify-auth-challenge` need no
change at all; `create-auth-challenge` gains an email branch that sends via
SES instead of SNS. The language handshake, the expiry, the attempt limit and
the rate limiting all apply unchanged, which is the point.

## Bounces and complaints

An SES configuration set with an SNS destination for bounces and complaints,
feeding a metric filter and an alarm. Hard bounces are recorded per address so
a repeatedly-invalid address stops being retried. This is the email equivalent
of the delivery-status logging that finally made undelivered SMS visible.

## Migration

74 accounts have an email address; ~217 real accounts have a phone. Email
users need no data migration: removing password auth does not delete their
account, and email OTP works against the same identity. They do need telling,
because their password will simply stop being asked for.

## Rollout order

1. Endpoint deployed, self-service signup still enabled. Nothing changes yet.
2. Frontend switched to the endpoint. Both paths work.
3. `AllowAdminCreateUserOnly` set. Public signup closed.
4. Email OTP shipped, email+password still accepted.
5. Password auth flows removed from the app client. Passwords gone.

Each step is independently reversible. Step 3 is the one that closes the hole;
step 5 is the one that cannot be undone quietly, because it changes how 74
people sign in.
