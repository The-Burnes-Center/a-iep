# A-IEP working agreements

A-IEP helps parents understand their child's IEP. The documents it handles are
FERPA-protected records of children with disabilities, so correctness and
privacy outrank speed here.

## Ship tests with the change, always

**Anything we build gets the tests it needs, in the same change.** Not "later",
not a follow-up ticket. If a change is worth shipping it is worth proving, and
a change that lands without its tests is unfinished work.

This is not a style preference. It comes from two incidents:

- A phone-signup bug shipped broken and stayed broken for **over a month**
  because nothing exercised the path. The backend reported the failure on every
  attempt and the frontend never read it.
- A tag-standardization commit renamed an S3 bucket as a side effect and
  **deleted half of production's document content**. The deploy reported
  success. There was no assertion on the bucket's retention policy or its name.

Both were cheap to catch and expensive to miss.

### What "necessary tests" means, by change type

| You changed | Write |
|---|---|
| A lambda handler | Unit tests for the happy path **and** the error paths, driven through the real handler (see below) |
| CDK / infrastructure | An assertion in `test/infra/` pinning the security-relevant property (auth on a route, a retention policy, an IAM action, a runtime) |
| A user-facing flow | An E2E journey in `e2e/`, or extend an existing one |
| A bug fix | A test that **fails before the fix and passes after**. State that you ran it both ways. |
| A dependency pin | Confirm the lambda still imports; `lambda-deps` in CI does this, so keep it passing |

### Rules that make the tests worth having

- **A test that cannot fail is worse than no test**, because it buys false
  confidence. Mutation-check anything security-relevant: break the code on
  purpose, watch the test fail, restore it, and say so.
- **Assert behaviour, not the mock.** Check persisted state, response bodies,
  and the negative case (the thing that must *not* happen).
- **Match the real contract.** A test built on an invented event shape pins
  fiction. This happened: a test fabricated a Cognito `session` field that the
  trigger never receives, so it green-stamped dead code for weeks.
- **Never encode a bug as expected behaviour** without saying so out loud.
- Don't weaken or delete an existing test to make a change pass. If a pin is
  genuinely wrong, fix the pin in the same change and explain why.

## Where tests live and how to run them

```bash
npm test                       # jest: test/lambdas (node) + test/infra (CDK assertions)
pytest -q                      # python lambdas: test/python
cd e2e && npx playwright test   # E2E against DEPLOYED staging (needs AWS creds)
```

- **Tests must never live inside `lib/chatbot-api/functions/`.** Those
  directories are zipped verbatim into lambda assets, so a colocated test ships
  to production and churns the deploy cache.
- Jest runs via `npm test`, not bare `npx jest`: the wrapper passes
  `--experimental-vm-modules`, which the `.mjs` suites need.
- Python suites load the **real deployed module** by path via
  `conftest.load_lambda_module` with moto active. Follow that pattern rather
  than importing a copy.
- E2E drives the real staging site. Fixtures must be synthetic: failures upload
  screenshots and traces as artifacts, so a real record would leak into them.

## Before you say it's done

Run what CI runs, not a subset:

```bash
npm test && npx tsc --noEmit
pytest -q
cd lib/user-interface/app && npx tsc --noEmit && npm run lint && npm run build
ENVIRONMENT=staging npx cdk synth AIEPStagingStack --no-staging --quiet
ENVIRONMENT=production npx cdk synth AIEPStack --no-staging --quiet
```

Use the full `npm run lint`, not `eslint` on the files you touched: the gate is
`--max-warnings 0` with `--report-unused-disable-directives`, so an unnecessary
`eslint-disable` is itself an error. Verifying per-file has already let a lint
failure reach CI.

Report results honestly. If a test fails, say so with the output. If you
skipped a step, say that.

## Environments

- `staging` accepts direct pushes and is the dev instance. `main` is
  production, promoted by PR.
- Both deploys are gated on CI: a red suite cannot deploy.
- Prod and staging are **one codebase**. Hold a feature back with the
  `enabledFeatures` flag (see `lib/user-interface/app/src/common/features.ts`),
  never by carving code out of one branch. Carving forks the tree and forces
  deleting the tests that cover it.
- Staging-only test hooks (the OTP backdoor, `CustomSMSSender`) are gated in
  CDK and their **absence from the production template is asserted** in
  `test/infra/`. Keep it that way.
