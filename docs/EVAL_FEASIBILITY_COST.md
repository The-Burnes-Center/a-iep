# Evaluation Techniques: Feasibility Study & Cost Estimate

Responds to the July 2026 eval meeting action item (cost analysis, Dhruv) and the proposed technique mapping (HDGSR / Atomic Facts / G-Eval / COMET-Kiwi). Companion to Diane's methodology research [S23 in RESEARCH_LOG.md] and [AI_EVALUATION_RESEARCH.md](AI_EVALUATION_RESEARCH.md).

**Assumptions used throughout** (verify at implementation): average document = ~15k tokens of redacted OCR source; English output (summary + 9 sections) ≈ 4k tokens; each translation ≈ 4k tokens; ~60 atomic facts per document; volume ≈ 100-200 docs/month (375 processed since launch, growing with Arabic/TTS rollout). API prices assumed: GPT-4.1 $2/$8 per M tokens (in/out), GPT-4.1-mini $0.40/$1.60, Claude Sonnet on Bedrock $3/$15, Claude Haiku $1/$5. All evaluation is background/admin-side; parent-facing latency is untouched.

---

## 0. Recommended stack at a glance

| Category (from team meeting) | Recommended technique | Cost/doc |
|---|---|---|
| Hallucinations | Derived from atomic facts (facts failing source validation); no separate HDGSR system | $0 (derived) |
| Factual accuracy | **Atomic facts** with page-scoped dual validation (vs summary AND source), single cross-family judge | ~$0.07-0.13 |
| Per-section summary quality | **G-Eval**-style anchored rubric, cross-family judge, escape hatch | ~$0.05-0.10 |
| Citation (page-number) validation | Derived from page-scoped fact validation + deterministic sanity | $0 (derived) |
| Omission/coverage (added; highest-stakes risk) | Source→output presence check, services grid first | ~$0.02-0.05 |
| Translation accuracy | **MQM-style LLM judge per language (primary)** + free deterministic checks (glossary, digits, structure) + quarterly human MQM-lite calibration; CometKiwi optional later as an LLM-independent drift tripwire | ~$0.10-0.20 |
| Everything above rests on | Free deterministic layer shipped first + calibration on golden set and the 4-5 real IEPs; report-only until variance is baselined | ~$0 |

**Total: ~$0.25-0.55 per document; $25-110/month at current volume.** Build order in §5.

## 1. Verdicts on the proposed mapping

| Proposal | Verdict | Summary |
|---|---|---|
| HDGSR → hallucination | **Fold into atomic facts** | As *detection*, it duplicates what atomic-fact source-validation already measures. As *self-refinement*, it changes the pipeline (adds generation-loop latency) and belongs later as a measured mitigation experiment, not as the measurement. Define the hallucination score as a derived view of atomic-fact results instead of a second system. |
| Atomic Fact Generation & Evaluation → factual accuracy | **Yes, make it the workhorse** | Matches the meeting design (facts from summary/sections only; dual validation vs summary AND source). With page-scoped validation it also produces the citation-validation metric for free. Anjith has an in-house precedent (Cantwell). |
| G-Eval → summary quality | **Yes, with guardrails** | Rubric + chain-of-thought judging per section. Use a cross-family judge (Claude-on-Bedrock judging GPT-4.1 output), fixed anchored rubrics, escape hatch ("cannot judge"), median of 3 samples on weekly/golden runs (1 sample per production doc). Calibrate against the real-IEP experiment before trusting numbers. |
| COMET-Kiwi → translation | **Secondary only; the MQM LLM judge is primary** (decision + reasons in §1.1) | License (verified on model card): **CC-BY-NC-SA-4.0** for `wmt22-cometkiwi-da` (COMET *code* is Apache-2.0); free-nonprofit use is defensible but needs a deliberate sign-off. Languages: all four A-IEP languages (es/vi/zh/ar) are inside the encoder's 94-language coverage, so scores are legitimate for all four (the model card's "unreliable" warning applies only to languages outside the list). Finer print: the quality-scoring head was fitted on human judgments for a limited pair set (en→vi/ar/es are not supervised pairs), so calibrate per language and use relative, within-language thresholds. Infra: PyTorch model (0.6B-3.5B), nightly batch, plus source-target segment alignment work. |

### 1.1 Translation decision: MQM LLM judge vs CometKiwi

**Decision: MQM-style LLM judging is the primary translation metric. CometKiwi is an optional later add-on. If only one is built, build the judge.**

1. **Actionability.** CometKiwi returns a bare score per segment. The MQM judge returns error spans with categories and severities ("omitted the ESY eligibility sentence"; "mistranslated 'least restrictive environment', major"). That output debugs prompts, briefs human reviewers, and stands up in front of experts; a number alone does not, in a domain where "competent translation" is a legal standard.
2. **Domain awareness.** The judge prompt carries our actual glossaries (~298 terms/language), the Arabic Western-digit and Latin-acronym rules, and the legal-educational register. CometKiwi was trained on general/news MT judgments and cannot be told any of this.
3. **No alignment tax.** CometKiwi needs aligned source-target segment pairs (engineering + noise over markdown sections). The judge takes whole sections as-is.
4. **Same human-calibration burden either way.** Both need per-language anchoring against the quarterly human MQM-lite reviews; the judge's output is already in MQM vocabulary, so judge-vs-human calibration is apples-to-apples.
5. **Cost is a wash.** Judge ~$0.10-0.20/doc with zero infra; CometKiwi is cheap per score but adds model hosting, a batch job, and the license sign-off.

**What CometKiwi is genuinely for (later):** it is the only non-LLM signal in the stack, so it cannot share the judge's family biases or drift. As a nightly, near-free tripwire ("Vietnamese scores moved this week, go look") it earns its keep once the judge + deterministic checks are live and the license is signed off. It is a monitor for the monitor, not the monitor.

## 2. What's missing (add these)

1. **Citation validation** (the meeting's fifth category, absent from the list). Nearly free: validate each atomic fact against *its cited page only*; a fact that validates against the document but not its cited page is a citation error. Plus deterministic sanity (pages within range).
2. **Omission/coverage** (the risk the team rated highest alongside misrepresentation). Additions are caught by output→source checking; *missing services* are not. Add source→output direction: extract the services grid (and other high-stakes values) from the source pages, check presence in output. Scoped to services + placement, this is ~$0.02-0.05/doc.
3. **The free deterministic layer, shipped first.** Placeholder-section rate ("not found" backfills are currently invisible), glossary adherence (~298-term dictionaries already exist per language), numbers/dates preservation in translations (incl. Arabic Western-digit rule), structure preservation, English readability grade (Flesch-Kincaid), per-stage latency/token/cost metrics. Zero LLM cost, one-time engineering, instant dashboard baseline.
4. **Calibration & thresholds via the golden dataset + real-IEP experiment.** Every metric above needs to be run on documents with known answers (synthetic golden set) and on the 4-5 real IEPs (partners verify what scores mean) before any threshold or flag goes live. Report-only until variance is baselined.

## 3. What's NOT needed (v1)

- **A separate HDGSR stack** (fold into atomic facts, above).
- **AMR/FactGraph**: heaviest infra, English-centric parsers, brittle on markdown/table-heavy text; atomic facts capture the same failure classes at a fraction of the complexity. Revisit only if atomic-fact judging proves unreliable.
- **BERTScore/BLEU/ROUGE for production**: reference-free production has nothing to compare against; on the golden set our typed-fact scoring is strictly more informative. Skip.
- **3-model panels on every document**: start with one cross-family judge per metric; run the full panel weekly on a sample (and on golden runs) to measure judge agreement/drift. Promote to per-document panels only if disagreement turns out material.
- **Real-time blocking evaluation**: everything async/background (answers the meeting's open batch-vs-realtime question: batch, triggered per document, results to admin dashboard).

## 4. Cost model

### Per-document (production, background scoring)

| Component | Design | Est. cost/doc |
|---|---|---|
| Atomic facts: extraction (from summary+sections) | 1 call, ~6k in / 2k out, mid-tier model | ~$0.01-0.02 |
| Atomic facts: validation vs source, page-scoped, batched (~8 calls × ~3k in) | single cross-family judge | ~$0.05-0.10 |
| Atomic facts: validation vs summary (trivial context) | same | ~$0.01 |
| Hallucination score | derived from the above | $0 |
| Citation validation | derived (page-scoped design) | $0 |
| Omission/coverage (services + placement, source→output) | 1-2 calls | ~$0.02-0.05 |
| G-Eval section quality (10 units, batched, 1 sample) | cross-family judge | ~$0.05-0.10 |
| Translation LLM judge (per active language, ~4 × 8k in) | GEMBA-MQM-style | ~$0.10-0.20 |
| Translation deterministic checks (glossary, digits, structure) | code | $0 |
| CometKiwi (nightly batch, amortized) | CPU batch | ~$0.01-0.05 |
| **Total per document** | | **~$0.25-0.55 typical; ≤$1.50 with 3-model panels everywhere** |

Monthly at 100-200 docs: **~$25-110**; panels-everywhere worst case ~$300. Comfortably inside the <$5/doc gate, mostly two orders of magnitude inside.

### Offline golden runs (once the dataset exists)
50 cases × 2 variants × full suite ≈ $30-70 per full run; weekly full + PR-triggered deterministic-only ≈ **$120-280/month**. Smoke subsets a few dollars.

### Fixed/infra
- CometKiwi batch: $5-30/month CPU (Fargate/spot) or ~$50-150/month if a small GPU endpoint is kept warm (not recommended; batch instead).
- Bedrock: pay-per-use, no fixed cost; one-time console step to enable Anthropic model access. Cross-family judging via Bedrock keeps judge traffic inside the AWS account (consistent with the FERPA posture; the judge sees the same redacted content OpenAI already processes).
- CloudWatch dashboards/metrics: negligible.

### One-time engineering (rough)
Deterministic layer + dashboard ~2-3 days; atomic-facts service (extraction, page-scoped dual validation, derived scores) ~3-5 days; G-Eval rubrics ~1-2 days; translation judge + deterministic checks ~2-3 days; CometKiwi batch ~2-4 days (after license check); calibration runs (real IEPs + golden pilot) ~2-3 days. **Total ≈ 2.5-4 engineering weeks, phased.**

## 5. Recommended sequencing

1. **Phase A (free, ~1 week):** deterministic layer + metrics dashboard. Instant visibility (placeholder rate alone is worth it).
2. **Phase B:** atomic facts with dual validation → factual accuracy + hallucination + citation metrics; omission/coverage on services; single cross-family judge; **calibrate on the 4-5 real IEPs + golden pilot cases; report-only.**
3. **Phase C:** G-Eval quality rubrics; translation MQM LLM judge + deterministic translation checks; weekly panel sampling for judge drift; thresholds/flags only after variance is baselined.
4. **Phase D (optional):** CometKiwi nightly batch as the LLM-independent drift tripwire, contingent on license sign-off; per-language score-distribution calibration against the human MQM-lite reviews.

## 6. Open items before implementation

- CometKiwi license verified as CC-BY-NC-SA-4.0; get a deliberate non-commercial-use sign-off (fallbacks if declined: MetricX or LLM-judge-only).
- Enable Bedrock Anthropic model access (one-time) and confirm no-training/DPA terms for any judge provider.
- Confirm provenance/consent for the 4-5 real IEPs before they touch any eval run.
- Current API prices verified at build time (numbers above are planning estimates).
- Segment-alignment approach for CometKiwi (markdown-structure based).
