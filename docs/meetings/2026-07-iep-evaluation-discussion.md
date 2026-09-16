# AIEP Evaluation Discussion — Meeting Notes

**When:** July 2026, 1:02-2:01 PM (exact date not in transcript; Stephan captured the full transcript, Ravina's note-taker caught the first portion)
**Attendees:** Anirudh Dinesh (chair), Diane Grant (presenting research), Dhruv Kamalesh Kumar, Stephan Schmidt, Anjith Prakash, Ayush Prashant Khanvilkar, Mariana
**Basis:** Diane's research document "AI Evaluation Framework w/ Confidential Data" (rev 7/17)

## TL;DR

Diane presented a survey of summarization-evaluation techniques for AIEP's core risks (hallucination, omission, semantic misrepresentation). The team converged on: a five-category evaluation scope; an atomic-facts approach with dual validation (against both the summary and the source document) as the leading candidate for per-IEP background scoring; a methodology document (detailed + plain-language versions) to be externally critiqued before anything is implemented; and a calibration experiment running candidate metrics on the few real IEPs the team holds. Nothing is being implemented yet.

## Techniques reviewed (Diane)

- **Leave-N-Out:** remove a known fact from the source, check the summary handles it; fact-controlled hallucination probing.
- **HDGSR** (hallucination-detection-guided self-refinement): a separate LLM screens for hallucinations iteratively before output; shown to work in medical summarization.
- **BLEU/ROUGE/BERTScore:** classical metrics; BLEU precision-focused, ROUGE recall-focused, both miss paraphrase; BERTScore handles paraphrase but has **no directionality/polarity** ("the sky is not blue" ≈ "the sky is blue"). If used, must be paired with something polarity-aware.
- **AMR (Abstract Meaning Representation):** sentence → directed graph; preserves polarity; highly accurate but heavy/costly. Gold standard territory alongside atomic facts.
- **OpenIE** (subject-relation-object triples): lighter, underperforms AMR, could join a metric mix. **Dependency entailment:** grammatical rather than semantic; less infra, loses paraphrase.
- **Atomic facts (generation + validation):** extract single-piece-of-information facts, validate each against a source of truth, iterate; the direction the field is moving; infra and repeated-verification cost are the concerns.
- **Temporal reasoning benchmarks:** relevant since IEP requirements are time-bound.
- **Translation evaluation:** thin literature, English-centric methods, heavy reliance on human translators; flagged as a category we must handle.
- **LLM-as-judge:** biases include self-preference (same-family tone/grammar), verbosity preference, own hallucinations, inconsistency. Mitigation: **panels of diverse model families**; four prompting approaches (direct scoring, G-Eval-style rubric + chain of thought, pairwise, reference-based). Reference-based fits AIEP best but depends on reference quality.
- **Federated evaluation:** likely not feasible for us (requires local compute).
- **Synthetic data:** medical field trains DP-protected generator models; SynthTextEval offers generation + evaluation tooling; alternatives include teacher-provided classroom examples and clinical-note proxy corpora (ACI-Bench), though non-IEP proxies are second-best.

## Team contributions

- **Dhruv:** ABE project uses RAGAS (6 metrics); warns of the score-mismatch pitfall (terse reference vs detailed correct answer scores low; "the evaluation, not the system, is what's suboptimal"). GraphDB proposed for multi-year/multi-document goal tracking; would be one graph per student; cost/architecture research needed (single instance, multiple clusters?). **Atomic-facts refinement adopted:** facts generated from the summary only (so hallucinations are replicated), then validated against BOTH the summary and the original document, since the fact-extraction step can itself hallucinate; one agent can emit both pass/fail scores. Raised the unresolved **backend/batch vs real-time per-IEP evaluation** architecture question. Cost of these checks estimated well under $5/IEP.
- **Anjith:** Cantwell pipeline already runs an atomic-facts-like validation layer (extract data + location, cross-match) and extraction complaints disappeared; supports going heavier on verification for AIEP since the team can't see production data; BERTScore is a pip-installable package.
- **Stephan:** used pairwise comparison + ELO ratings in All Our Ideas and Discuss First for translations/rewritings; candidate technique here. Asked whether IEP practitioners have their own evaluation criteria (varies by state and district); hunch that synthetic-only evaluation without something "real-worldish" will be harder; asked about partner archives.
- **Anirudh (framing):** all of this is admin/backend-side, never parent-facing; parent processing time (~75s-2min) must not grow; goal is per-metric scores with out-of-bounds flagging. AIEP summarizes *specific sections*, so fact authentication is targeted, not generic summarization. A "flag badly-written IEP elements" feature (e.g., "1,200 minutes/year" with no weekly frequency) is a separate future track, not this evaluation.

## Facts established

- The team holds **4-5 real IEPs** (3-4 collected by students, one more via Lisa). Dhruv separately has an agent-collected library of 40-50 state sample/template documents (none real).
- **SPEDucational** (Lisa, LA-based; spelling to verify) is a new partner alongside Innovate Public Schools: creates parent documentation/guidance, has **offered to help with synthetic data generation**, e.g. rare medical-equipment accommodations with dense medical terminology that appear in no template, and can describe the range of such cases plus tap her networks.
- Innovate Public Schools (advocacy partner) pushed the SFUSD IEP template; same effort underway in LA. California IEP standardization is ongoing with no visible update since ~2025.

## Decisions

1. **Five evaluation categories** for the methodology: hallucinations; factual accuracy; per-section summary quality; citation (page-number) validation; translation accuracy.
2. **Methodology before implementation:** Diane writes the detailed, AIEP-specific methodology document (with Dhruv supplying current architecture/tooling detail), plus a simpler plain-language version; share the short version with Beth and the team; then external critique (technologist reviewers, e.g. Matt Salganik, plus a less-technical version for IEP experts). Implementation only after critique.
3. **Calibration experiment:** run candidate metrics (atomic facts with dual validation; possibly AMR if affordable; BERTScore paired with a polarity-aware complement) on the real IEPs held by the team, and have partners (Innovate, Lisa) manually verify what the scores mean.
4. **Per-processed-IEP background scoring** (e.g., a hallucination-confidence score) is the eventual production direction, cost-gated (fine if a few dollars per IEP; absurd costs kill it). "This is a research project we want to do."

## Action items

- **Diane:** detailed methodology document in ~1-2 weeks (full-time after next week); then the plain-language version; compile the external reviewer list. Treat the current doc as the living literature review.
- **Dhruv:** cost analysis of the candidate approaches per IEP; walk Diane through the current AIEP architecture and tools so the methodology is AIEP-specific; continue GraphDB feasibility research (per-student clusters, cost).
- **Team:** suggestions for who beyond the team should review the methodology.
- **Open questions:** backend/batch vs real-time evaluation; GraphDB architecture; provenance/consent status of the 4-5 real IEPs; SPEDucational engagement specifics.
