---
name: test-round-doc
description: Generate the shareable DOCX guide for a round of manual A-IEP testing, for a named environment and scope, plus the synthetic IEP testers upload. Use when asked for a tester doc, a testing round doc, QA instructions for teammates, or a UAT guide.
---

# Test-round doc

Produces two files a teammate can be handed with no other context:

1. `<Name>-Test-Guide.docx` — one to two pages: how to get in, what to walk
   through, what should happen, and a feedback table to fill in and send back.
2. `Sample-IEP-for-Testing.pdf` — a copy of `e2e/fixtures/synthetic-iep.pdf`,
   the fully invented IEP for "Alex Example".

**The sample PDF is the only document testers may upload.** `docs/sample-ieps/`
holds redacted real student records: never ship those to a tester, and never
put them through the pipeline. See CLAUDE.md, "Handling real data".

## Ask for two things

Both come from the user; do not guess them.

| Input | Example |
|---|---|
| **Environment** | production (`https://a-iep.org`) or staging (`https://d1tznne4kof6ph.cloudfront.net`) |
| **Scope** | "full end to end", "just the upload pipeline", "the new referral flow", "translations only" |

Everything else is derived. If the user names only a scope, ask which
environment before writing anything: the dark-feature list depends on it.

## Derive the environment's dark features before writing steps

A tester reporting a deliberately disabled feature as a bug wastes their round
and yours. Read the current truth, do not trust this file's memory of it:

- `lib/user-interface/index.ts` — `PROD_FEATURES` / `ALL_FEATURES` and
  `PROD_LANGUAGES` / `ALL_LANGUAGES`.
- `lib/user-interface/app/src/common/features.ts` — what each flag actually
  hides in the UI.

As of the last check, production runs with `enabledFeatures: []`, so TTS
("Listen" buttons), the invite/referral entry point and the parent-name
onboarding prompt are all dark, and Arabic is off. Staging has all of them on.
List whatever is dark under "Read this first" as "do not report these".

## Derive the flow from the app, not from this file

Routes and page names drift. Before writing the steps, skim:

- `lib/user-interface/app/src/components/AppRoutes.tsx` — public vs protected
  routes, and what the `ConsentGate` wraps.
- `lib/user-interface/app/src/pages/iep-folder/` — upload constraints
  (`UploadIEPDocument.tsx`: `.pdf`, `.doc`, `.docx`, 100MB) and the summary
  page's sections, language tabs and PDF download.
- `e2e/tests/*.spec.ts` — the journeys already automated. The manual doc should
  cover what those cannot: judgement about the summary's quality, translation
  that reads naturally, and how the thing feels on a real phone.

## Build it

```bash
ROUND="docs/testing/<YYYY-MM-DD>-<env>-<scope>"
mkdir -p "$ROUND"
cp e2e/fixtures/synthetic-iep.pdf "$ROUND/Sample-IEP-for-Testing.pdf"

# The renderer needs the `docx` npm package, which is not a repo dependency.
# Install it somewhere scratch and point NODE_PATH at it (node resolves from
# the script's own directory otherwise, and .claude/skills has no node_modules).
cd /tmp/scratch && npm install docx
export NODE_PATH="/tmp/scratch/node_modules"

cd "$REPO"
node .claude/skills/test-round-doc/build-doc.js \
  "$ROUND/round.json" "$ROUND/AIEP-<Env>-Test-Guide.docx"
```

Copy the previous round's `round.json` as the starting point:
`docs/testing/2026-08-04-prod-e2e/round.json` is the worked example.

## round.json schema

```jsonc
{
  "title": "A-IEP Production Test Round",
  "creator": "A-IEP / Burnes Center",
  // Each line is a list of [label, value] pairs, rendered inline under the title.
  "meta": [[["Site", "https://a-iep.org"], ["Scope", "..."]]],
  "theme": { "accent": "00682F" },        // optional; brand green by default
  "blocks": [ /* in order */ ]
}
```

A **run** is a string, or `{ "t": "text", "b": bold, "i": italic, "c": "RRGGBB" }`.
Anywhere text is accepted you may pass a single run or an array of runs, which
is how you bold the lead-in of a step.

| Block | Fields |
|---|---|
| `heading` | `text` — green, rule underneath |
| `paragraph` | `text` (run or runs), `after` |
| `bullets` | `items[]` — each a run or runs |
| `steps` | `items[]` — auto-numbered 1, 2, 3 |
| `table` | `widths[]` (relative, scaled to the page), `header[]`, `rows[][]`, `labelColumn` (shade column 0), `blankRows`, `numberBlanks` |
| `spacer` | `after` |
| `note` | `text` — small, grey, italic |

A table cell takes a string, a run array, or an array of run arrays (one
paragraph each).

## Shape of a good round doc

Keep it to two pages. A tester who has to scroll a fifth page stops testing.

1. **Title + meta** — site, scope, time needed, who to ask.
2. **Read this first** — the sample-PDF rule, test on a phone, real SMS,
   processing takes minutes, the dark features, log everything.
3. **Getting in** — a three-column table: the two account states side by side
   (no account / has an account), with rows for "Do this", "Should happen" and
   "Also try". Both paths must be covered every round: signup and sign-in break
   independently, and phone signup has broken before without anyone noticing
   for a month.
4. **Onboarding** — new accounts only, so mark it that way.
5. **The main journey** — numbered steps scoped to the round. Each step says
   what to do *and* what should happen, in a parent's language, not the
   codebase's. No route paths, no component names, no `data-testid`.
6. **Feedback** — a who/when/device block, a blank issue table (`#`, step,
   what happened, what you expected, severity), and two or three open
   questions that ask for judgement rather than pass/fail.

Write for a colleague on a phone, not an engineer at a desk. Say "the Listen
buttons", not "the TTS feature"; "your documents page", not `/iep-documents`.

## Verify before handing it over

Render it and look at it. A guide that spills to three pages, or whose table
columns collapse, will not get used:

```bash
python3 <docx-skill>/scripts/office/soffice.py --headless --convert-to pdf guide.docx
pdftoppm -jpeg -r 100 guide.pdf page && ls page-*.jpg   # then read the images
```

Check: two pages, no column collapsed to a sliver, no orphaned heading at a
page break, the feedback table intact.

## House style

- No em dashes. Use a colon, a comma, parentheses, or two sentences.
- No AI attribution anywhere in the document or in any commit that ships it.
