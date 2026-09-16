# Student name redaction

Scheduled: sprint 1, build starts Wed Sep 2 2026. Owner: Dhruv.
Ships behind `studentNameGate` in `enabledFeatures`, tested in the sprint 1
dev-team week (Sep 28), live in production with the sprint 1 promotion (Oct 9).

## What changes

Today no name is redacted. `ALLOWED_PII_ENTITY_TYPES = {"NAME", "DATE_TIME"}` in
`lib/chatbot-api/functions/metadata-handler/steps/redact_ocr/comprehend_redactor.py:8`
lets every name Comprehend finds pass through untouched, so the child's name,
both parents' names and every teacher, therapist and administrator named in the
IEP go to OpenAI twice: once in the parsing agent, again in each translation
run.

After this change every name is replaced with a placeholder before the document
reaches OpenAI. The student's name is swapped back once the pipeline finishes.
No other name is restored, and no name reaches the summarizing or translating
model.

Mistral OCR still sees the whole document, name included. It has to: redaction
runs on OCR output, and OCR is what produces that output. The claim this feature
supports is "the student's name never reaches the model that writes or
translates the summary", not "no vendor ever sees it". Say it that way in the
release note.

We hold an enterprise contract with Mistral under which they do not train on or
otherwise use our data. That governs what they may do with what they receive; it
does not change what they receive. Keep the two separate when describing this:
the contract is a legal control on use, the redaction is a technical control on
exposure, and only the second is something the pipeline itself enforces. A
release note that leans on the contract to imply the name is not sent would be
wrong, and a parent reading it could not check it either way.

## Why every name, not only the student's

The request was scoped to the student's name. Redacting only that name means
matching it in OCR text that writes it four different ways: `Rivera, Alex`,
`Alex R.`, `ALEX RIVERA`, `Alex's goals`. Anything the matcher misses reaches
the model, and a redaction step that quietly half-works is worse than one that
does not exist, because nobody goes looking for the leak.

So redaction is fail closed and covers every `NAME` entity, matching how PII
redaction already behaves in this step. That is a decision with a cost, handled
next.

## What the parent gets instead of names

An IEP's `Key People` section is a list of names by role, and its whole job is
telling a parent who to call (`steps/parsing_agent/config.py:13`, `:34`). Redact
every name and restore nothing, and it becomes six rows of `[NAME]` with roles
attached, which is a worse product than we have now.

So the section stops listing people and starts pointing at the page that already
lists them. Every IEP meeting produces an attendance or signature page: everyone
who was in the room, with their role, in one place. The parent already has that
page in their copy of the document. The summary says which page it is, and the
parent reads the names off the paper in their hand.

That removes the need to keep a name map anywhere. Nothing is restored after the
pipeline except the student's name, which comes from the profile. No other name
is ever written back into a summary, a section, an audio file or a PDF.

Prompt changes that follow:

- `Key People` stops asking for names. It asks for the page number of the
  attendance or signature page and the roles that were present.
- `Services` names each provider today (`config.py:28`). It refers to them by
  role instead and points at the same page.
- Every section is told that `[NAME]` marks a withheld name, that it must never
  be printed, and that people are named by role.

This is the prompt change the in-progress "Page number for every key person" row
was already down to, so the two land in one edit.

### Token shape

Only the student's name needs a distinguishable token, because nothing else is
swapped back. `{{S}}` for the student. Every other name keeps the step's existing
`[TYPE]` replacement and becomes `[NAME]`.

`{{S}}`, not `[STUDENT_NAME]`. The token has to survive four translation runs,
and a model asked to translate a document into Spanish will happily render
`[STUDENT_NAME]` as `[NOMBRE_DEL_ESTUDIANTE]`. A short handlebars token with no
translatable word inside it is the most stable thing to hand a model.

That is a mitigation, not a guarantee, so it gets checked:

- The parsing and translation prompts state that `{{S}}` is a placeholder, must
  be copied verbatim, and must never be replaced with an invented name.
- `translate_content` counts `{{S}}` before and after each translation. A run
  that drops or mangles it fails the step, which is the behaviour the rest of
  this pipeline already has.
- Swap-back sweeps for mangled variants (`{{ S }}`, `{ {S} }`, full-width
  brackets from the Chinese run) and logs a count, so a new failure mode shows
  up in CloudWatch instead of on a parent's screen.


### Never put the name in the state machine payload

Step Functions keeps execution input and output in execution history for 90
days. A name in the event is a name in that history, outside every deletion
path we have. `finalize_results` reads the child name from the profile itself.
The existing `_SAFE_LOG_FIELDS` allowlist in each step handler stays as it is.

## Where the swap happens

**Superseded 2026-09-11 (`8303344`).** The plan below put the swap in
`finalize_results`, which wrote the real name into stored content. That is what
made the on-demand add-a-language path a leak: it re-reads the stored English,
so every language a parent added sent the name to the model this feature exists
to keep it away from.

Stored content now keeps `{{S}}` permanently and **every reader substitutes on
the way out**: `user-profile-handler` for the documents API and `tts-handler`
before synthesis, each with its own `student_name_substitution.py`. The
on-demand path needs no special case as a result, and correcting a misspelled
name fixes every summary a parent already has. Documents written before the
redaction hold real names and no token, so substitution is a no-op on them.

The rest of this section describes the original design and is kept for the
reasoning about where content lives, which still holds.

In `finalize_results`, via a new `restore_student_name` operation on the DDB service
(`metadata-handler/ddb-service/handler.py:114`), invoked before the row is
marked `PROCESSED`.

The DDB service owns this rather than the finalize lambda because summaries and
sections live in one of two places: inline on the document row, or in an S3 blob
under `iep-data/` once the row approaches DynamoDB's 1MB limit
(`ddb-service/s3_content_handler.py:129`). The DDB service already handles both
paths. Anything else would have to learn them.

Swapping at the end rather than on every read means TTS and the PDF generator
need no changes: both read stored summaries after the pipeline is done, so they
see the child's name. It also means a name correction never reaches an
already-processed document. That is the accepted trade for one code path
instead of three.

## Mandatory student name in onboarding

The name is now load-bearing: it is what `{{S}}` becomes. Three things stand in
the way.

**The default child.** `getProfile` auto-creates a child named `'My Child'` with
`schoolCity: 'Not specified'` (`user-profile-handler/lambda_function.py:277`
and `:309`). Real production profiles carry that value today. Keep creating the
child row, since `children[0]` is assumed all over the app, but create it with
an empty name, and treat both `''` and the literal `'My Child'` as "no name
given" so existing parents get asked once.

**Blank names pass validation.** `addChild` and the child branch of
`updateProfile` check `'name' not in body` only
(`lambda_function.py:423`, `:499`), so `name: ""` is accepted. Reject blank and
whitespace-only names, and log the reason: an unlogged validation rejection
already made one real failure undiagnosable here.

**The gate.** A redirect that sends a parent with no saved child name to the
child form before they reach the app, modelled on `parentNameGate` in
`lib/user-interface/app/src/common/features.ts`. `ViewAndAddChild.tsx` already
disables its save button on a blank name, so the form itself needs only the
copy for the new required-field message, in all five dictionaries.

New feature name: `studentNameGate`. Dark in production until the pipeline half
is verified there, then a config flip.

**Encrypt the child name.** It is stored plaintext today: the decrypt list is
`['phone', 'city', 'parentName']` (`lambda_function.py:299`) and the child name
is not in it, while every other piece of family PII is. Making it mandatory and
load-bearing is the moment to fix that. `kms_decrypt_string` already falls
through to plaintext on a decrypt failure, so existing rows keep reading.

## When there is no name

A parent can reach a processed document without a usable child name: the gate is
dark in production at first, and legacy profiles say `'My Child'`. In that case
`{{S}}` is replaced with a neutral phrase, localized, one string per language
("your child", "su hijo o hija", and so on). It is not left as a raw token and
it is not left as `'My Child'`.

## Tests, in the same change

| Area | Test |
|---|---|
| `comprehend_redactor` | Student name in all four OCR spellings becomes `{{S}}`; every other name becomes `[NAME]`; no name survives in the output |
| `comprehend_redactor` | Comprehend error still fails the step. Mutation-check it: break the raise, watch the test fail, restore, say so |
| read-time substitution | Both readers substitute; all five languages; missing token; mangled token; no profile name falls back to the localized phrase; stored content unchanged; TTS substitutes before the cache key is derived, so a corrected name misses the cache |
| `translate_content` | A dropped or mangled `{{S}}` fails the step |
| `user-profile-handler` | Blank and whitespace-only child name rejected with a logged reason; child name encrypted on write; plaintext legacy row still decrypts |
| `test/infra/` | KMS decrypt granted to the DDB service and no wider; `studentNameGate` absent from the production `enabledFeatures` |
| `app/src/common/i18n.test.ts` | New copy keys present and non-empty in all five dictionaries |
| `e2e/` | Onboarding: blank name blocks the save and the gate redirects. Document journey: the synthetic fixture's child name appears in the finished summary, and neither `{{` nor `[NAME]` does; Key People carries a page number |

Existing documents keep the real names already written into their summaries.
There is no backfill and no need for one.
