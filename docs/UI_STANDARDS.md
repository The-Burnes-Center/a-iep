# A-IEP UI standards

What every screen is built from, and the rule each piece follows. The parents
who use A-IEP are mostly on phones, many read English as a second language,
and some use a screen reader or a magnifier. The rules below come from WCAG
2.2 AA and from the GOV.UK Design System, which public services use because
it is tested with exactly that range of people.

The home screen and the invite page set the look: a dark-green grid-paper
hero with the four-colour stripe, then white cards on the cream page. Colours
come only from `lib/user-interface/app/src/styles/palette.css`
(`color-contrast.test.tsx` fails on anything else).

Why this exists: a whole-app audit on 2026-11-09 found five column widths,
nine button styles, three field corner radii, a 16px checkbox, ten screens
with no `h1`, and a breadcrumb pointing a first-time parent at a summary that
did not exist.

## Page

| Rule | Why |
|---|---|
| Every signed-in screen is a `PageShell` (`components/page`). | One column width, one gutter, the trail on the content's own edge. |
| Every screen has exactly one `h1`, usually in a `PageHero`. | A screen reader user lands on it; a sighted parent knows where they are. |
| The trail names where the parent is, never a screen that does not exist for them yet. | "Summary" on a first upload sent parents to an empty page. |
| One primary action per screen, or per card. | The parent should never have to choose which green button is "the" button. |
| `task` width (40rem) for forms and lists; `reading` (48rem) for long text. | Line length stays readable; forms stay one column. |

## Buttons

One `Button` component with four variants. Nothing else looks like a button.

| Variant | Use | Look |
|---|---|---|
| `primary` | The one main action | Filled brand green, cream text |
| `secondary` | Other actions | Cream fill, ink text, 1px border |
| `danger` | Irreversible actions (remove, delete) | Error red, used only after a confirmation step |
| `text` | Low-emphasis actions inside a card | Ink text, no fill; never blue-underlined |

- **Size:** at least 48px tall, on every screen. Targets under 24px fail WCAG 2.2 (2.5.8); 44–48px is what thumbs need.
- **Shape and type:** 24px pill radius, the condensed brand face, uppercase with 0.05em letter-spacing, as the existing primary buttons have.
- **Labels:** verb first, saying what happens ("Upload for Maya", "Save changes", "Remove Sam"), never "Submit", "OK" or "Click here". Use the same verb for the same action everywhere: "Continue" between onboarding steps, "Save changes" for edits.
- **Disabled:** avoid it. If a button must be disabled, the reason is on screen and linked with `aria-describedby`. Prefer an enabled button that explains what is missing on press.
- **Links that look like buttons** are `Button` rendered as a link (`as={Link}`), so they share every rule above.
- **Hover:** a colour change only, no movement.

## Fields

One `TextField`, one `Checkbox`, one `Radios`.

- **Label** above the field, always visible, never only a placeholder. Mark optional fields "(optional)"; don't mark required ones with an asterisk.
- **Hint** text under the label when the parent needs to know the format or why we ask, linked with `aria-describedby`.
- **Errors:** say what to do ("Enter your child's name"), appear above the field in the error red with an icon, are linked with `aria-describedby`, and set `aria-invalid`. On a form with more than one field, an error summary at the top links to each one.
- **Size:** at least 48px tall, 8px radius, a 1px `--aiep-border` edge (3:1 against the page).
- **Checkboxes and radios:** 24px boxes, and the whole label is the target.
- **Never** clear what the parent typed when an error appears.

## Content blocks

| Piece | Rule |
|---|---|
| `page-card` | White, 16px radius, one job per card, at most one primary button. |
| `page-list` | A white card of whole-row links with a chevron (Account, Support, Rights). |
| `StatusTag` | Status in words and an icon, never colour alone: Ready, Reading, Couldn't read it, No IEP yet. |
| `Notice` | Information, success, warning or error, with an icon and a heading. Errors use `role="alert"`; the rest are not live regions unless they appear after an action. |
| Confirmation | Anything that deletes says what is lost and that it can't be undone, and moves focus to the decision. |

## Words

- Plain language, at the reading level of the summaries: short sentences, everyday words, the child's name where we know it.
- Every string goes through `t()` and exists in all five dictionaries, with `{name}`-style placeholders, never English possessives built in code.
- Breadcrumb and button text is written in sentence case in the dictionaries; uppercase is a style, not the text.
