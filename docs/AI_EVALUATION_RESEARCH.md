# Evaluating and Improving A-IEP's AI Pipeline

**Research report — July 2026**

This report answers one question: *how do we know whether A-IEP's AI outputs are any good, and how do we make them better?* It combines a full audit of this codebase, current (2025–2026) industry standards for evaluating LLM systems, and the market/regulatory landscape for AI in special education. It ends with a phased, repo-specific roadmap. **This document proposes work; it changes no code.**

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Current state: audit of the AI pipeline](#2-current-state-audit-of-the-ai-pipeline)
3. [Gap analysis vs. industry standards](#3-gap-analysis-vs-industry-standards)
4. [Market & domain landscape](#4-market--domain-landscape)
5. [Recommended evaluation framework](#5-recommended-evaluation-framework)
6. [Phased roadmap](#6-phased-roadmap)
7. [Sources](#7-sources)

---

## 1. Executive summary

**Core finding: the pipeline has exactly one automated quality gate — a Pydantic schema check that verifies the model returned all 9 IEP sections in the right shape. Nothing anywhere checks whether any output is *correct*.** There is no faithfulness/hallucination check on summaries, no accuracy measurement for extraction, no quality assessment of the four translations, no readability verification, no user feedback capture, no golden test data, and no metrics on LLM latency/cost/failure. Because the system (correctly, for FERPA) never persists LLM inputs/outputs, there is also no historical data to mine — evaluation must be built deliberately.

This is fixable with modest effort, and the codebase is unusually well positioned for it: the parsing and meeting-notes agents can already be invoked locally with zero refactoring, output lands in a single well-defined `content.json` schema that maps 1:1 onto a golden-dataset format, and detailed per-section extraction instructions already exist to derive scoring rubrics from.

### Top 5 recommendations

1. **Build an offline eval harness on golden datasets** (synthetic + de-identified IEPs, 20–50 cases per stage/language) scored with DeepEval + an LLM judge (Claude via Amazon Bedrock, so data never leaves the AWS account and the judge is a different model family than the GPT-4.1 generator). This is Phase 1 of the roadmap and the foundation for everything else.
2. **Pin generation temperature and version prompts.** The parsing and translation agents run at default (nondeterministic) temperature; regression evaluation against a moving target is noise. Pin `temperature=0.0` and add `PROMPT_VERSION` constants so quality can be tied to specific prompt/model versions.
3. **Adopt a documented, MQM-style translation QA process with periodic human review.** Federal IDEA/OCR guidance requires *competent* translation for limited-English-proficient (LEP) families; a scored human-review rubric per language is both a compliance shield and a differentiator against district tools that use raw machine translation.
4. **Add content-free production quality metrics + a per-section feedback button.** Latency, token cost, "section not found" placeholder rates, redaction stats (already computed, only logged today), and parent thumbs-up/down per section — none of which require persisting document content. Thumbs-down items become new golden test cases.
5. **Publish trust artifacts and pursue certification.** A plain-language model/system card (anchored to the NIST AI RMF Generative AI Profile and the U.S. Dept. of Education developer guide), published eval numbers, and the Digital Promise "Responsibly Designed AI" certification. Almost no competitor publishes quantified accuracy claims — doing so is A-IEP's clearest differentiation opportunity.

---

## 2. Current state: audit of the AI pipeline

### 2.1 Pipeline map

Document processing is a linear Step Functions state machine ([iep-processing.asl.json](../lib/chatbot-api/state-machines/iep-processing.asl.json), STANDARD, 30-min timeout) triggered by S3 upload via [orchestrator.py](../lib/chatbot-api/functions/metadata-handler/orchestrator.py). An accurate design doc already exists at [metadata-handler/README.md](../lib/chatbot-api/functions/metadata-handler/README.md).

```
Upload (presigned PUT, upload-s3/index.mjs)
  → InitializeProcessing (5%)
  → MistralOCR (15%)              steps/mistral_ocr/          "mistral-ocr-latest"
  → RedactOCR (20%)               steps/redact_ocr/           AWS Comprehend PII
  → DeleteOriginal (22%)          steps/delete_original/      purge raw upload
  → ParallelWork (65%)
      ├─ Parsing agent            steps/parsing_agent/        GPT-4.1 (openai-agents SDK)
      └─ Meeting notes            steps/extract_meeting_notes/ GPT-4.1 (temperature=0.0)
  → CheckLanguagePrefs            steps/check_language_prefs/
  → ParallelTranslations (85%)    steps/translate_content/    GPT-4.1 per language (es/vi/zh/ar)
  → FinalizeResults (100%)        steps/finalize_results/
```

All pipeline Lambdas are Python 3.12 under [lib/chatbot-api/functions/metadata-handler/](../lib/chatbot-api/functions/metadata-handler/); every step has 3× exponential-backoff retries and a `Catch → RecordFailure` route. Steps exchange only IDs; content is read/written through a centralized DDB-service Lambda ([ddb-service/handler.py](../lib/chatbot-api/functions/metadata-handler/ddb-service/handler.py)).

**Models in use (all hardcoded, not configurable):**

| Model | Where | Notes |
|---|---|---|
| `mistral-ocr-latest` | [mistral_ocr.py:198](../lib/chatbot-api/functions/metadata-handler/steps/mistral_ocr/mistral_ocr.py) | Mistral OCR API; returns per-page markdown |
| `gpt-4.1` (openai-agents SDK) | [open_ai_agent.py:100](../lib/chatbot-api/functions/metadata-handler/steps/parsing_agent/open_ai_agent.py) | Structured output (`SingleLanguageIEP`), `max_turns=150`, 4 OCR-paging tools, **no temperature set → nondeterministic** |
| `gpt-4.1` (chat.completions) | [extract_meeting_notes/handler.py:74](../lib/chatbot-api/functions/metadata-handler/steps/extract_meeting_notes/handler.py) | Verbatim meeting-notes extraction, `temperature=0.0` |
| `gpt-4.1` (openai-agents SDK) | [translation_agent.py:64](../lib/chatbot-api/functions/metadata-handler/steps/translate_content/translation_agent.py) | One invocation per language per content type; glossary + language-context tools; **no temperature set** |
| ElevenLabs `eleven_flash_v2_5` / OpenAI `gpt-4o-mini-tts` | [tts-handler/providers.py](../lib/chatbot-api/functions/tts-handler/providers.py) | On-demand TTS, provider via SSM |

**Prompts live in four places:**
- Master analysis prompt `get_english_only_prompt()` and the very detailed per-section extraction instructions `SECTION_KEY_POINTS` — [steps/parsing_agent/config.py](../lib/chatbot-api/functions/metadata-handler/steps/parsing_agent/config.py) (9 canonical sections at lines 5–15: Present Levels, Eligibility, Placement, Goals, Services, Informed Consent, Accommodations, Key People, Strengths).
- Verbatim-extraction instructions — [steps/extract_meeting_notes/prompts.py](../lib/chatbot-api/functions/metadata-handler/steps/extract_meeting_notes/prompts.py).
- Translation prompt `_get_optimized_prompt()` — [translation_agent.py](../lib/chatbot-api/functions/metadata-handler/steps/translate_content/translation_agent.py) (lines 108–161).
- Per-language style guidance + embedded glossaries `get_language_context()` — [steps/translate_content/config.py](../lib/chatbot-api/functions/metadata-handler/steps/translate_content/config.py) with glossary JSONs (`en_es_translations.json`, `en_vi_translations.json`, `en_zh_translations.json`, `en_ar_translations.json`).

**Output schema (the evaluation target).** Everything lands in one S3 object, `iep-data/{iepId}/{childId}/content.json` ([s3_content_handler.py](../lib/chatbot-api/functions/metadata-handler/ddb-service/s3_content_handler.py)), each field keyed by language:

```json
{
  "summaries":      { "en": "...", "es": "...", "vi": "...", "zh": "...", "ar": "..." },
  "sections":       { "en": [ { "title": "...", "content": "markdown", "page_numbers": [3] } ] },
  "document_index": { "en": "..." },
  "abbreviations":  { "en": [ { "abbreviation": "FAPE", "full_form": "..." } ] },
  "meetingNotes":   { "en": "verbatim text" }
}
```

A golden dataset built in exactly this shape lets eval metrics map 1:1 onto production output.

### 2.2 Quality machinery that exists today

- **Pydantic schema validation** — [steps/parsing_agent/data_model.py](../lib/chatbot-api/functions/metadata-handler/steps/parsing_agent/data_model.py): `SingleLanguageIEP` rejects output missing or adding any of the 9 sections (`extra="forbid"`). This is the *only* hard quality gate in the system. Translation-side validation ([translate_content/data_model.py](../lib/chatbot-api/functions/metadata-handler/steps/translate_content/data_model.py)) is best-effort — on failure it logs a warning and keeps the untranslated original.
- **Placeholder backfill** — sections the model omits are silently filled with "This section was not found…" ([open_ai_agent.py](../lib/chatbot-api/functions/metadata-handler/steps/parsing_agent/open_ai_agent.py) lines 194–236). Note: this converts extraction *failures* into normal-looking output; the rate is currently invisible.
- **PII redaction** — [comprehend_redactor.py](../lib/chatbot-api/functions/metadata-handler/steps/redact_ocr/comprehend_redactor.py) redacts every Comprehend PII entity type except `NAME` and `DATE_TIME`, and computes a stats dict (lines 127–134) that is **only printed, never emitted as a metric**.
- **Error handling** — Step Functions retries; the parsing agent recovers partial output on `MaxTurnsExceeded`/`ModelBehaviorError`; failures are recorded to DynamoDB with `failed_step`/`last_error`.
- **Prompt-level mitigation only** — "Do not hallucinate, generalize or include information not explicitly present" appears in the master prompt. There is no post-hoc check that the model complied.

### 2.3 What is missing

- **No faithfulness/groundedness check** on summaries or sections against the source OCR text.
- **No extraction-accuracy measurement** (did it find all services? are minutes/frequencies right?).
- **No translation QA** — no automated scoring, no documented human review process, despite the glossaries.
- **No readability measurement**, despite "parent-friendly" being the core product promise.
- **No golden datasets, no sample IEPs, no AI-output tests.** (State when written; by 2026-07-28 the commented-out CDK scaffold had become a real assertion suite in `test/infra/`, and the dead 2-cell RAGAS stub notebook left over from the forked template was deleted. Still true: no AI-output evals exist, which is the gap this document is about.)
- **No LLM observability.** The only CloudWatch metrics are three compliance log filters — `PIIAccessCount`, `DocumentAccessCount`, `AuthFailureCount` ([logging/logging.ts](../lib/chatbot-api/logging/logging.ts) lines 104–127). No latency, token, cost, retry, or quality metrics exist.
- **No user feedback surface.** The live API ([lib/chatbot-api/index.ts](../lib/chatbot-api/index.ts) routes at lines 93–172) has no rating/feedback endpoint. The frontend contains *dead* template scaffolding pointing at nonexistent backends — [evaluations-client.ts](../lib/user-interface/app/src/common/api-client/evaluations-client.ts) and [user-feedback-client.ts](../lib/user-interface/app/src/common/api-client/user-feedback-client.ts) — plus, when this was written, a `/survey-form` route wrapping a third-party JotForm; that survey was removed from the product on 2026-07-29, so no feedback surface remains at all.

### 2.4 Operational facts that shape any eval design

- **No LLM I/O is persisted anywhere — by design.** Handlers use `_SAFE_LOG_FIELDS` allowlists (e.g., [parsing_agent/handler.py](../lib/chatbot-api/functions/metadata-handler/steps/parsing_agent/handler.py) lines 14–24) that strip document content before logging. This is a FERPA strength to preserve: evaluation must run on golden inputs (or add carefully-scoped in-account capture later), not on mined logs. The redacted OCR (`iep-data/{iepId}/{childId}/redacted_ocr_result.json`) and `content.json` do persist in-account, so any specific production document *is* reconstructable for review with AWS access.
- **Nondeterminism.** Parsing and translation run at SDK-default temperature. Until pinned, evals must average multiple runs; even at `temperature=0.0`, GPT-4.1 is not bit-identical, so prose metrics should use score thresholds rather than exact match.
- **Model IDs are hardcoded** (see table above) — A/B-testing a model change currently requires code edits in four files.
- **A dead-but-present Bedrock IAM grant** exists at [functions.ts](../lib/chatbot-api/functions/functions.ts) (lines ~272–283): pipeline Lambdas may invoke `anthropic.claude-3-5-sonnet-20240620-v1:0` — and, problematically, resource `'*'`. Nothing uses it today (vestigial from the template). Two implications: (a) there is no policy obstacle to using Claude-on-Bedrock as an eval judge; (b) the `'*'` should be tightened whenever the grant becomes live.
- **Local hygiene note (verified):** the repo working directory contains a local `.env` with a plaintext `MISTRAL_API_KEY`. It is **not tracked by git** (no history leak), and deployed Lambdas read keys from SSM (`/ai-iep/OPENAI_API_KEY`, `/ai-iep/MISTRAL_API_KEY`) — but the local file is worth deleting or vaulting as a precaution. Per project convention, any *new* SSM parameters should use the `/a-iep/` prefix.
- **Each step Lambda is bundled from its own directory** (`createStepFunctionLambda` in [functions.ts](../lib/chatbot-api/functions/functions.ts)), and step directories collide on module names (`config.py`, `data_model.py` exist in both `parsing_agent/` and `translate_content/`) — any local harness importing multiple stages must isolate `sys.path` per stage.

---

## 3. Gap analysis vs. industry standards

What each stage has today versus what production LLM teams treat as standard practice in 2025–2026 (sources in [§7](#7-sources)):

| Pipeline stage | Current control | 2025–2026 standard practice | Gap |
|---|---|---|---|
| **OCR** (Mistral) | None — output trusted as-is | Task-specific unit tests (field presence, reading order, table integrity — OlmOCR-Bench style) rather than raw character-error-rate; IEPs are form/table-heavy so this matters more than CER | **Total** |
| **PII redaction** (Comprehend) | Stats computed but only logged; entity allowlist (NAME/DATE_TIME kept) | Span-level precision/recall on seeded-PII test docs, with **recall weighted heaviest** (one missed identifier can expose a child); redaction metrics dashboarded | **Total** (data exists, unmeasured) |
| **Extraction** (9 sections) | Pydantic shape check; silent "not found" backfill | Per-field precision/recall/F1 vs. golden annotations using an LLM semantic aligner (ExtractBench pattern); exact-match on structured values (service minutes, dates); placeholder rate monitored | **Near-total** (shape only) |
| **Summarization** | Prompt says "do not hallucinate" | LLM-judge groundedness rubric on every output or a sample (G-Eval / Bedrock Guardrails contextual grounding); FactScore-style per-claim verification offline; SummaC as a cheap regression tripwire | **Total** |
| **Meeting notes (verbatim)** | Pydantic shape check | Edit-distance / fuzzy-substring verification that output text actually appears in source OCR | **Total** (cheap to close) |
| **Translation** (es/vi/zh/ar) | Glossaries injected into prompts; best-effort validation that keeps English on failure | Reference-free quality estimation (GEMBA-MQM-style LLM judge, CometKiwi); glossary-adherence and structure-preservation checks; **per-language human calibration** (judge reliability degrades in non-English, especially vi/ar); documented human MQM review | **Total** |
| **Readability** ("parent-friendly") | None | Flesch-Kincaid grade-level gate for English; language-appropriate or LM-based scorers for others (classical formulas don't transfer); LLM readability rubric | **Total** |
| **Regression safety** (prompt/model changes) | None — changes ship unmeasured | Golden-dataset eval suite in CI gating prompt/model changes (DeepEval/promptfoo pattern); report-only first, gate after variance is baselined | **Total** |
| **Production monitoring** | 3 compliance metrics | Per-stage latency/tokens/cost/failure metrics, drift detection on quality-signal distributions, OpenTelemetry GenAI tracing conventions | **Near-total** |
| **User feedback** | None (dead template code) | Per-artifact thumbs-up/down feeding the golden dataset; feedback-shift as a drift signal | **Total** |

Two structural strengths worth naming: the fixed 9-section enum plus `SECTION_KEY_POINTS` amounts to a **ready-made annotation guide** for golden datasets, and `page_numbers` on every section is the seed of a **source-citation/verifiability story** most competitors lack.

---

## 4. Market & domain landscape

### 4.1 Who else is in this space

**Parent-facing IEP understanding (closest competitors):**
- **Undivided — IEP Assistant** ([undivided.io](https://undivided.io/resources/undivideds-new-iep-assistant-common-parent-questions-3609)): membership platform pairing an AI IEP assistant with human "Navigators." Trust claims: not trained on uploaded documents, per-family data isolation.
- **KidvoKit** ([kidvokit.com](https://kidvokit.com/)): organizes emails/evaluations/IEPs into a case-history timeline — organization, not summarization/translation.
- **IEP Says** ([iepsays.com](https://www.iepsays.com/); added July 2026, post-dating the original scan): $39.99-per-document AI IEP analysis for parents — upload PDF/photo, plain-English breakdown of goals/services/gaps reorganized into "Five Dimensions," meeting-prep guide, chat over the uploaded IEP, follow-up email drafting — plus 50-state rules content hubs (~74 articles/state; publisher undisclosed). Trust claims: 256-bit encryption, row-level security, "Zero AI Training," "FERPA Aware." Advertises a **"98%+ accuracy target"** with no published methodology, dataset, or measured results; English-only (no translation). Positioned against advocate/attorney hourly rates.

**AI IEP-writing tools for teachers (adjacent, large):**
- **MagicSchool AI** ([overview](https://www.avid.org/digital-tools/MagicSchool-AI)): 80+ teacher tools including IEP generation and *family-friendly IEP summaries*; 5M+ educators; FERPA/COPPA posture and a 95% Common Sense Media privacy rating — the most credibility-signal-heavy player whose parent-summary feature overlaps A-IEP's core.
- **Playground IEP** ([playgroundiep.com](https://www.playgroundiep.com/)), **Monsha** ([monsha.ai](https://monsha.ai/tools/iep-generator)), **Colleague.ai**, Varsity Tutors' free generator — goal-writing and compliance tools for educators.

**District translation services (the incumbent "compliance" channel):**
- **TransACT** (certified human translators + LanguageLine interpretation), **TalkingPoints** (AI translation *supported by human translators*, 150+ languages), **ParentSquare** (pure Google Translate MT), **Pairaphrase**, **Argo Translation** — Argo [argues explicitly](https://www.argotranslation.com/blog/delivering-iep-translations-that-families-understand) that word-for-word translation preserves complexity rather than meaning, which is precisely A-IEP's plain-language thesis.

**The strategic insight:** credible players converge on three trust claims — human-in-the-loop, privacy posture, third-party badges. **Almost nobody publishes quantified accuracy numbers.** (Nuance, July 2026: IEP Says *advertises* a "98%+ accuracy target," but as a marketing figure without published methodology, data, or measured results. Project stance: A-IEP is free public-interest tech — this landscape is read for learning, not market positioning. The field-wide gap worth closing *publicly* is verifiable, methodology-backed accuracy reporting, which would benefit every tool in the space.) An A-IEP that can say "X% of summary claims verified faithful against expert-annotated documents; translation quality scored per language with published methodology" would occupy empty ground. A-IEP also already holds a credibility asset most competitors lack: a peer-reviewed co-design study ([DIS 2025, ACM](https://doi.org/10.1145/3715336.3735778)) and public co-design documentation ([RebootDemocracy](https://rebootdemocracy.ai/blog/co-designing-ai-for-ieps), [press coverage](https://thefrisc.com/this-ai-software-translates-special-education-plans-for-sf-parents/)).

### 4.2 Domain risk: why accuracy is not optional here

- **CDT policy brief, "From Personalized to Programmed" (Oct 2025)** ([cdt.org](https://cdt.org/insights/from-personalized-to-programmed-the-use-of-generative-ai-to-develop-individualized-education-programs-for-students-with-disabilities/)): 57% of teachers used AI for an IEP/504 in 2024–25; recommends human oversight requirements, parent disclosure of AI use, and pre-/post-deployment audits. **Ed Week (Oct 2025)** ([edweek.org](https://www.edweek.org/teaching-learning/teachers-are-using-ai-to-help-write-ieps-advocates-have-concerns/2025/10)) documents advocate concerns: bias from under-representation of disability experience, fabricated content, loss of individualization; Georgia discourages AI for high-stakes IEP content.
- **Hallucinated translation is a documented failure mode** that *invents content absent from the source* and delivers it confidently ([MultiLingual, Mar 2026](https://multilingual.com/magazine/march-2026/mitigating-hallucinations-in-ai-powered-translation/)); an adjacent-field cautionary case: AI transcription tools [fabricating statements in child-welfare case notes](https://aicommission.org/2026/02/social-workers-report-hallucinations-found-in-ai-transcriptions-of-accounts-from-children-all-these-words-have-not-been-said/).
- **Oversimplification risk:** health-literacy practice targets roughly 3rd–5th-grade reading level for lay materials ([CHCS](https://www.chcs.org/resource/improving-written-communication-to-promote-health-literacy/)), but IEPs contain legally load-bearing terms (least restrictive environment, specially designed instruction, service minutes) where simplification can strip enforceable meaning. The eval rubric must reward *meaning preserved in plain language*, not just low grade-level.

### 4.3 The legal context for translation (IDEA / OCR / DOJ)

- **34 CFR §300.322(e)**: districts must take "whatever action is necessary" so parents understand IEP proceedings, including interpretation.
- **OSEP guidance (June 2016)** ([ed.gov](https://sites.ed.gov/idea/idea-files/iep-translation-communication-from-osep/)): procedural notices must be in the parent's native language unless clearly not feasible; the IEP's content must be conveyed so the parent understands it.
- **OCR/DOJ Title VI guidance**: translation for LEP families must be *timely, complete, and competent* — districts may not rely on children, friends, or untrained bilingual staff ([example state articulation, ISBE](https://www.isbe.net/Documents/Communicating-in-Parents-Native-Language-Requirements%20.pdf)).

Implication: unedited machine translation of high-stakes content sits in tension with the "competent translator" standard. A-IEP's positioning ("support parents' understanding, don't replace official translation") plus a **documented, scored human translation-review process** (see §5.4) is both the compliant and the differentiated posture. A pure-MT competitor is legally exposed; A-IEP shouldn't be.

### 4.4 Governance frameworks to anchor to

- **U.S. Dept. of Education, "Designing for Education with AI: An Essential Guide for Developers" (July 2024)** ([ed.gov](https://www.ed.gov/about/ed-overview/artificial-intelligence-ai-guidance)): five expectations — design for education, provide evidence of impact, advance equity, ensure safety/security, earn trust through transparency. The most directly citable "we align with federal guidance" anchor.
- **NIST AI RMF + Generative AI Profile (NIST-AI-600-1, July 2024)** ([nist.gov](https://www.nist.gov/itl/ai-risk-management-framework), [PDF](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)): the Confabulation, Data Privacy, Information Integrity, and Human-AI Configuration risk categories map directly onto A-IEP.
- **FERPA/COPPA:** IEP-derived records are FERPA education records; ensure LLM providers contractually do not train on inputs, and keep the redact-before-API step prominent. See [FPF, "Vetting Generative AI Tools for Use in Schools" (Oct 2024)](https://fpf.org/wp-content/uploads/2024/10/Ed_AI_legal_compliance.pdf_FInal_OCT24.pdf).
- **Certifications/rubrics:** **Digital Promise "Responsibly Designed AI"** ([program](https://digitalpromise.org/product-certifications/responsibly-designed-ai/)) — five criteria (privacy transparency, data security, bias mitigation with a user reporting channel, AI-content labeling, user agency/override), valid 2 years, and likely largely attainable already; **EdSAFE AI Alliance SAFE benchmarks** ([edsafeai.org](https://www.edsafeai.org/safe)); the **Five Quality Indicators** coalition ([ISTE](https://iste.org/news/coalition-of-leading-education-organizations-introduces-five-quality-indicators-for-edtech-and-ai-products)); **CDT's edtech transparency rubric** ([cdt.org](https://cdt.org/insights/opening-the-book-a-rubric-to-support-effective-transparency-for-edtech-products-that-incorporate-ai/)).
- **Efficacy evidence:** ESSA evidence tiers are the district-procurement lingua franca; an IRB-approved pilot converting A-IEP's existing co-design work into measured outcomes (parent comprehension, meeting-prep confidence) would put it ahead of the ~75% of top edtech products that [meet no research standard](https://districtadministration.com/briefing/only-25-of-the-top-100-edtech-products-meet-research-standards/).
- **Accessibility:** WCAG 2.1/2.2 AA (the Section 508 baseline) — especially relevant given TTS/RTL users.

---

## 5. Recommended evaluation framework

### 5.1 Architecture: two layers, one constraint

Industry practice has converged on **(1) an offline, code-versioned regression eval suite run in CI against golden datasets, plus (2) lightweight online monitoring** — with user feedback bridging the two. The binding constraint for A-IEP: **FERPA — no third-party eval SaaS may receive student data.** Everything below respects that: golden data is synthetic/de-identified, judging runs in-account, and production metrics are content-free numbers.

**Recommended stack (small team, nonprofit budget, AWS serverless):**

| Layer | Choice | Why |
|---|---|---|
| Offline evals | **DeepEval** (open source, pytest-native) | Free; Python like the Lambdas; richest metric library (G-Eval custom rubrics, faithfulness, hallucination); runs in CI. Telemetry opt-out; no cloud dependency. |
| Judge model | **Claude via Amazon Bedrock** | Different model family than the GPT-4.1 generator (avoids self-preference bias); data stays in-account; pay-per-use; an IAM grant for Claude-on-Bedrock already exists in `functions.ts` (dead today). One-time prerequisite: enable Anthropic model access in the Bedrock console. |
| Managed layer (optional) | **Amazon Bedrock Evaluations** (bring-your-own-responses + custom metrics) and **Bedrock Guardrails contextual grounding check** | Managed LLM-as-judge on golden sets regardless of which models generated the output; contextual grounding is a low-effort real-time hallucination gate for summaries vs. redacted OCR. ([AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html)) |
| Observability | **CloudWatch EMF metrics now; OpenTelemetry GenAI conventions if/when tracing is added** | Matches the repo's existing log→metric-filter posture; numbers only, never content. ([OTel GenAI spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)) |

Alternatives considered and set aside: promptfoo (excellent, language-agnostic, native Bedrock provider — a fine substitute if YAML-over-pytest is preferred; see the flagged acquisition report in §7), LangSmith/Braintrust (strong but hosted SaaS — data-governance friction), Langfuse self-hosted (good future option if full tracing is wanted; adds infra to run).

### 5.2 Metrics per stage

| Stage | Deterministic checks (free, every PR) | LLM-judged checks (smoke on PR, full weekly) |
|---|---|---|
| **Parsing/extraction** | Schema validity; placeholder ("not found") false-positive/negative vs. golden `present_in_doc`; `page_numbers` within page count; exact-match on structured values (service minutes, frequencies, dates); Flesch-Kincaid ≤ target grade on English summary | **Faithfulness**: G-Eval rubric — every summary claim grounded in source OCR; **key-fact recall**: one judge call per golden claim ("is this fact present in the output?") |
| **Meeting notes** | Normalized edit-distance / fuzzy-substring: output must appear verbatim in source OCR; recall of golden note spans | — |
| **Translation** | Structure preservation (section count/titles/keys unchanged); glossary adherence (target term used where source term appears — reusing the step's own glossary JSONs); numbers/dates preserved | **Adequacy**: GEMBA-MQM-style pointwise judge per language (1–5, error-span reasoning, "Unknown" escape hatch); readability rubric per language. Optionally CometKiwi as a second reference-free signal. |
| **Redaction** | Recall on seeded-PII spans — **hard gate, recall-weighted**; NAME/DATE_TIME preservation check | — |
| **OCR** | Field-presence/reading-order unit tests on golden PDFs (deferred until golden PDFs exist) | — |

### 5.3 LLM-as-judge practices to follow

Distilled from Anthropic's and OpenAI's eval guidance and 2025 judge-bias research (links in §7):

1. **Pointwise analytic rubrics** for the regression suite (score each dimension separately); pairwise comparison only when choosing between prompt/model candidates.
2. **One dimension per judge call** — don't ask one judge for faithfulness + readability + completeness at once.
3. **Give the judge an escape hatch** ("Unknown") so it never guesses.
4. **Cross-family judging**: Claude judges GPT-4.1 output (mitigates self-preference bias). Watch the converse contamination: if Claude also *generates* synthetic IEPs, keep human-authored golden annotations and de-identified real documents in the mix.
5. **Calibrate against humans, per language.** Judge reliability measurably degrades in non-English — especially expected for Vietnamese and Arabic. Collect a small human-rated set per language, track judge–human agreement, and recalibrate the rubric when divergence exceeds ~20–25%.
6. **Read the transcripts.** No metric substitutes for periodically reading judge reasoning and raw outputs.
7. **Thresholds report-only first**; flip to CI-gating only after a few weekly runs establish score variance (necessary because even temperature-0 GPT-4.1 is not bit-identical).

### 5.4 Human translation QA (the compliance-critical piece)

Automated QE is necessary but not sufficient given the IDEA/OCR "competent translation" context. Recommended: an **MQM-lite rubric** (the industry-standard [MQM error taxonomy](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00437/108866/), trimmed): accuracy (mistranslation / omission / addition / untranslated), terminology (glossary adherence, legal terms of art preserved), fluency, audience appropriateness; severities minor/major/critical; a documented pass threshold. Quarterly sampling (e.g., 2 documents per language) by qualified reviewers, results stored as calibration labels for the LLM judge. Publish the process — it is a differentiator no MT-only competitor can match.

### 5.5 Golden dataset strategy

- **Format mirrors production**: per-case directory of `ocr.json` (same shape as `redacted_ocr_result.json`), `expected.json` (annotations: per-section key facts with page numbers and exact values, `present_in_doc` flags, must-not-contain traps, verbatim meeting-note spans, expected abbreviations, per-language glossary terms in scope), and `meta.json` (provenance: synthetic vs. de-identified, version, author, review date).
- **Sizing** (practitioner consensus): 20–50 cases detects large regressions; ~200 gives confidence on 3–5% changes. Start: ~20 English cases (≈10 synthetic + 10 de-identified real), 5 per translation language, 10 seeded-PII pages for redaction — **separate mini-sets per stage and language**, because a blended set hides stage/language-specific failures.
- **Synthetic IEPs via parallel agents** (the approach already envisioned for this project): agents generate realistic OCR-markdown IEPs *plus draft annotations*, grounded in real IEP structure (the 9-section framework and `SECTION_KEY_POINTS` in `parsing_agent/config.py` are effectively the spec). **Every case is human-reviewed before commit.** Known caveat from the literature: synthetic documents tend to be "too clean" and under-test hard extraction cases — which is why the de-identified-real component matters.
- **Open questions to resolve before building** (flagged per project decision): how to validate synthetic realism (e.g., a special-ed practitioner reviews a sample against real IEPs); template diversity across districts/states (IEP formats vary widely); whether an existing de-identified dataset is available to the team, and under what terms. Note that **no public IEP benchmark exists** — publishing one (synthetic, expert-reviewed) would be a field-defining contribution for a civic-tech project.
- **Governance**: only synthetic/de-identified data is ever committed; provenance recorded in `meta.json`; annotations versioned like code with inter-annotator agreement measured on a sample; a single missed identifier makes a document unsafe, so de-identification review weights recall.

---

## 6. Phased roadmap

Future work, each phase independently shippable. Paths are repo-relative; verified enabling facts are noted so implementation can start without re-auditing.

### Phase 1 — Offline eval harness MVP

**Goal:** `pytest evals/tests -m smoke` runs green locally against committed golden cases; a weekly full run produces a scored report.

- New top-level `evals/` directory (kept out of Lambda bundles, own `requirements.txt`): `harness/` (stage loader, runners, Bedrock judge wrapper, deterministic checks, rubrics), `datasets/golden/<case_id>/{ocr,expected,meta}.json` + JSON schema, `generators/` (synthetic-IEP agent + seeded-PII generator), `tests/` (structural / redaction / parsing / meeting-notes / translation), `tools/run_report.py`, gitignored `results/`.
- **Verified: the agents already run locally with near-zero refactoring.** `OpenAIAgent(ocr_data=..., api_key=...)` takes the OCR dict directly ([open_ai_agent.py](../lib/chatbot-api/functions/metadata-handler/steps/parsing_agent/open_ai_agent.py)); `_extract_meeting_notes(ocr_text)` is directly callable ([extract_meeting_notes/handler.py](../lib/chatbot-api/functions/metadata-handler/steps/extract_meeting_notes/handler.py)); all AWS coupling lives in the step handlers, not the agent classes.
- Only two production changes, both small: make glossary paths `__file__`-relative in [translation_agent.py](../lib/chatbot-api/functions/metadata-handler/steps/translate_content/translation_agent.py) (lines 40–56; behavior-identical in Lambda), and **pin `temperature=0.0`** in `open_ai_agent.py` and `translation_agent.py` before baselining (verify with a before/after golden run + one dev-stack document).
- One harness subtlety: a `sys.path`-isolating stage loader, because step directories collide on `config.py`/`data_model.py`.
- Judge: `DeepEvalBaseLLM` wrapper around Bedrock `Converse` (Claude), judge model ID via env; `DEEPEVAL_TELEMETRY_OPT_OUT=1`; no third-party eval SaaS.
- CI (`.github/workflows/evals.yml`): deterministic + redaction tests on PRs touching `lib/chatbot-api/functions/metadata-handler/**` or `evals/**`; LLM smoke subset on manual dispatch; full run weekly. Thresholds report-only until variance is baselined.

### Phase 2 — Instrumentation & observability (content-free)

**Goal:** a CloudWatch dashboard shows per-stage health for every processed document, with zero document content in any log or metric.

- Emit **CloudWatch Embedded Metric Format (EMF)** from each step via stdout (consistent with the existing log→metric-filter posture; no new IAM): per-stage `LatencyMs`, `InputTokens`/`OutputTokens` (available from `result.context_wrapper.usage` / `resp.usage`), `EstimatedCostUSD`, `ValidationFailure`, `MaxTurnsExceeded`; parsing `MissingSectionCount` (already computed by `_ensure_complete_english_sections`); translation `GlossaryAdherenceRate`; redaction stats (already computed at [comprehend_redactor.py](../lib/chatbot-api/functions/metadata-handler/steps/redact_ocr/comprehend_redactor.py) lines 127–134). Namespace `A-IEP/Pipeline`, dimensioned by stage and language. Step Functions' built-in `ExecutionsFailed`/`ExecutionTime` cover retries/failures for free.
- New CDK construct `lib/chatbot-api/observability/` — dashboard + alarms (validation-failure rate, missing-section spike, daily cost budget, execution failures).
- Stamp `processingMetadata` (model IDs, prompt version, processedAt) onto document records via the DDB service — needed to interpret metrics and Phase 3 feedback.
- Optional stretch, off by default: Bedrock Guardrails contextual-grounding score on the English summary in `finalize_results`, emitted as a shadow metric (never blocking).

### Phase 3 — Human feedback loop

**Goal:** parents can rate any section in any language; negative feedback becomes reviewed golden cases.

- New `FeedbackTable` in [tables.ts](../lib/chatbot-api/tables/tables.ts) (copy the existing KMS + resource-policy pattern), storing rating + target refs + `processingMetadata` — **no content copies**; a rated item is reconstructable in-account from `content.json` + redacted OCR.
- `POST/GET /documents/{iepId}/feedback` on the existing user-profile router ([user-profile-handler/](../lib/chatbot-api/functions/user-profile-handler/)); routes registered in [index.ts](../lib/chatbot-api/index.ts) beside the existing document routes; `FeedbackSubmitted`/`ThumbsDown` EMF metrics feed the Phase 2 dashboard.
- Frontend: replace the dead [user-feedback-client.ts](../lib/user-interface/app/src/common/api-client/user-feedback-client.ts) with a real client; delete dead `evaluations-client.ts`; compact thumbs-up/down + optional comment per section card in [IEPSummarizationAndTranslation.tsx](../lib/user-interface/app/src/pages/iep-folder/IEPSummarizationAndTranslation.tsx). Treat comment text as sensitive (never logged).
- `evals/tools/harvest_feedback.py`: engineer-run (never automated export) — pull thumbs-down items, fetch in-account content, de-identify with human review, commit as golden cases with `provenance: user_feedback`.

### Phase 4 — Trust & governance artifacts

**Goal:** an outside reader can answer "what does the AI do, how is it checked, what are its limits" from public docs.

- `docs/model-card.md` — plain-language system card (pipeline, models, data flow and retention, per-language limitations, eval methodology + latest scores), cross-referenced to the NIST GenAI Profile risk categories and the Dept. of Ed developer guide.
- `docs/translation-qa.md` — the MQM-lite rubric (§5.4), quarterly sampling plan, and the judge-vs-human calibration loop per language.
- README "Quality & evaluation" section embedding real eval numbers from `evals/results`.
- Digital Promise "Responsibly Designed AI" gap checklist → application.
- `PROMPT_VERSION` constants in `parsing_agent/config.py`, `extract_meeting_notes/prompts.py`, `translate_content/config.py`, surfaced in `processingMetadata` — prompts versioned like code, baselines tied to prompt versions.
- Longer-term: IRB-approved district pilot converting the existing co-design work into an ESSA evidence tier; consider publishing the synthetic IEP benchmark.

### Cross-cutting risks

- **Residual nondeterminism even at temperature 0** → rubric-score thresholds and median-of-3 runs for gates; deterministic checks are the hard gates.
- **Judge/generator contamination** (Claude generates synthetic IEPs *and* judges) → keep de-identified real cases and human-authored annotations in the mix.
- **Multilingual judge unreliability (vi/ar especially)** → per-language human calibration before trusting scores.
- **Eval cost creep** (the parsing agent can burn many tool-call turns per case) → smoke subsets on PR, full runs weekly, cost alarm.
- **Over-broad Bedrock IAM resource (`'*'`)** in `functions.ts` → tighten when the grant becomes live for judging/grounding.

---

## 7. Sources

**Evaluation methodology & tooling**
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Jan 2026) — rubric design, judge escape hatches, dataset sizing, "read the transcripts."
- OpenAI, [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
- [DeepEval](https://github.com/confident-ai/deepeval) (open source) · [promptfoo](https://github.com/promptfoo/promptfoo) · [Ragas](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/) · [Langfuse/observability comparison](https://medium.com/@kanerika/llmops-observability-langsmith-vs-arize-vs-langfuse-vs-w-b-f1baeabd1bbf) · [Comet Opik](https://www.comet.com/docs/opik/) · [Braintrust pricing](https://www.braintrust.dev/pricing).
- G-Eval: [the definitive guide (Confident AI)](https://www.confident-ai.com/blog/g-eval-the-definitive-guide).
- Judge bias: ["Am I More Pointwise or Pairwise?"](https://arxiv.org/html/2602.02219) · ["How Reliable is Multilingual LLM-as-a-Judge?"](https://arxiv.org/pdf/2505.12201) · [frontier-judge bias analysis (Adaline)](https://www.adaline.ai/blog/llm-as-a-judge-reliability-bias).
- Faithfulness: [review of faithfulness metrics](https://www.researchgate.net/publication/387670376_A_review_of_faithfulness_metrics_for_hallucination_assessment_in_Large_Language_Models) · [NAACL 2025 Findings](https://aclanthology.org/2025.findings-naacl.433.pdf).
- Extraction: [ExtractBench](https://arxiv.org/html/2602.12247v2) · [LongRecall](https://arxiv.org/abs/2508.15085).
- Translation: [GEMBA-MQM (WMT 2023)](https://aclanthology.org/anthology-files/pdf/wmt/2023.wmt-1.64.pdf) · [GEMBA V2 (WMT25)](https://aclanthology.org/2025.wmt-1.67/) · [MetricX-25](https://aclanthology.org/2025.wmt-1.70.pdf) · [COMET for low-resource MT eval (LREC 2024)](https://aclanthology.org/2024.lrec-main.315/) · [MQM human-eval study (TACL)](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00437/108866/) · [PhoMT (EN–VI)](https://arxiv.org/pdf/2110.12199).
- Readability: [ReadMe++ multilingual readability](https://pmc.ncbi.nlm.nih.gov/articles/PMC12225862/) · [crowdsourced eval of LLM plain-language summaries](https://www.researchgate.net/publication/391776023_Are_LLM-generated_plain_language_summaries_truly_understandable_A_large-scale_crowdsourced_evaluation).
- OCR: [OlmOCR-Bench](https://www.emergentmind.com/topics/olmocr-bench) · [2025 OCR accuracy benchmark](https://sparkco.ai/blog/2025-ocr-accuracy-benchmark-results-a-deep-dive-analysis).
- Golden/synthetic data: [golden dataset guide (qaskills)](https://qaskills.sh/blog/golden-dataset-llm-evaluation-guide) · ["De-identification is not enough" (Nature Sci Reports 2024)](https://www.nature.com/articles/s41598-024-81170-y) · [synthetic clinical notes at scale](https://arxiv.org/html/2605.17775).
- AWS: [Bedrock Evaluations (LLM-as-judge GA)](https://aws.amazon.com/blogs/aws/new-rag-evaluation-and-llm-as-a-judge-capabilities-in-amazon-bedrock/) · [custom metrics](https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-bedrock-rag-model-evaluations-custom-metrics/) · [Guardrails contextual grounding](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html) · [Automated Reasoning checks](https://aws.amazon.com/blogs/aws/minimize-ai-hallucinations-and-deliver-up-to-99-verification-accuracy-with-automated-reasoning-checks-now-available/) · [CloudWatch GenAI observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/GenAI-observability.html) · [drift monitoring guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/gen-ai-lifecycle-operational-excellence/prod-monitoring-drift.html).
- Tracing: [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/).

**Domain, market & governance**
- CDT, [From Personalized to Programmed (Oct 2025)](https://cdt.org/insights/from-personalized-to-programmed-the-use-of-generative-ai-to-develop-individualized-education-programs-for-students-with-disabilities/) · [edtech AI transparency rubric](https://cdt.org/insights/opening-the-book-a-rubric-to-support-effective-transparency-for-edtech-products-that-incorporate-ai/).
- Ed Week, [Teachers Are Using AI to Help Write IEPs (Oct 2025)](https://www.edweek.org/teaching-learning/teachers-are-using-ai-to-help-write-ieps-advocates-have-concerns/2025/10).
- OSEP, [IEP translation guidance (2016)](https://sites.ed.gov/idea/idea-files/iep-translation-communication-from-osep/) · [ISBE native-language requirements](https://www.isbe.net/Documents/Communicating-in-Parents-Native-Language-Requirements%20.pdf).
- U.S. Dept. of Education, [AI guidance hub / developer guide](https://www.ed.gov/about/ed-overview/artificial-intelligence-ai-guidance).
- NIST, [AI RMF](https://www.nist.gov/itl/ai-risk-management-framework) · [Generative AI Profile (AI-600-1)](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf).
- FPF, [Vetting Generative AI Tools for Use in Schools (Oct 2024)](https://fpf.org/wp-content/uploads/2024/10/Ed_AI_legal_compliance.pdf_FInal_OCT24.pdf).
- Digital Promise, [Responsibly Designed AI certification](https://digitalpromise.org/product-certifications/responsibly-designed-ai/) · EdSAFE AI Alliance, [SAFE benchmarks](https://www.edsafeai.org/safe) · ISTE, [Five Quality Indicators](https://iste.org/news/coalition-of-leading-education-organizations-introduces-five-quality-indicators-for-edtech-and-ai-products).
- Market: [Undivided IEP Assistant](https://undivided.io/resources/undivideds-new-iep-assistant-common-parent-questions-3609) · [MagicSchool AI](https://www.avid.org/digital-tools/MagicSchool-AI) · [Playground IEP](https://www.playgroundiep.com/) · [TalkingPoints](https://talkingpts.org/translations/) · [TransACT](https://www.transact.com/blog/parent-communications-and-translations-machine-vs.-human-translation-whats-the-difference) · [Argo Translation on IEPs](https://www.argotranslation.com/blog/delivering-iep-translations-that-families-understand) · [KidvoKit](https://kidvokit.com/).
- Risk reporting: [MultiLingual on MT hallucination (Mar 2026)](https://multilingual.com/magazine/march-2026/mitigating-hallucinations-in-ai-powered-translation/) · [AI transcription hallucinations in child-welfare notes (Feb 2026)](https://aicommission.org/2026/02/social-workers-report-hallucinations-found-in-ai-transcriptions-of-accounts-from-children-all-these-words-have-not-been-said/) · [Nature HSSC hallucination taxonomy (2024)](https://www.nature.com/articles/s41599-024-03811-x).
- A-IEP's own record: [DIS 2025 ACM paper](https://doi.org/10.1145/3715336.3735778) · [RebootDemocracy co-design blog](https://rebootdemocracy.ai/blog/co-designing-ai-for-ieps) · [The Frisc coverage](https://thefrisc.com/this-ai-software-translates-special-education-plans-for-sf-parents/).

**⚠️ Unverified post-cutoff claims** (surfaced during research but not confirmed by primary sources — verify before relying on them):
1. A reported **OpenAI acquisition of promptfoo** (March 2026). If true and it matters, prefer DeepEval (already the recommendation here).
2. A reported **deprecation of OpenAI's hosted Evals platform** (read-only Oct 2026, shutdown Nov 2026). Affects only the hosted product, not the open-source registry; does not affect this report's recommendations.
