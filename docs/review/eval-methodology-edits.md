# A-IEP Evaluation Methodology: pending edits

Re-checked line by line against the current doc: every FIND string below was
confirmed still present. Items 1.1, 1.3 and 1.4 from the previous pass are done
and removed, the ledger fix landed correctly in both places, and the Kocmi &
Federmann reference has been added.

Every source below was fetched and read. Where something could not be verified,
it says so.

---

## 1. Blocking

### 1.1 The worked example contains uncaught hallucinations

Needs a decision, not just an edit. The output block adds four things the input
does not support: the sentence about home, model-building, family and school
staff recognising the strengths, and the progress-reporting line. It also turns
`95 words correct per minute` into `95 words per minute`, a different measure.

Either regenerate the output faithfully, or keep it and make the errors the
point. The second is stronger: a doc about catching hallucinations that
demonstrates on a clean example proves nothing. If you take it, add after the
output block:

```
This output is what the pipeline produced, and it is wrong in five places. Four are extrinsic: model-building, the sentence about home, the claim that family and school staff recognise these strengths, and the progress line. None appear in the source page. One is intrinsic: the source says 95 words correct per minute and the summary says 95 words per minute, which is a different measure. Every one reads as plausible, which is why the evaluation has to be mechanical rather than a careful read.
```

The F1/F2 walkthrough then needs a third example showing a fact that fails.

### 1.2 Redaction described two incompatible ways

As written, the redacted Markdown holds only names and dates, which would leave
nothing to summarize. The body says the opposite.

FIND
```
A-IEP ensures confidentiality by creating a redacted Markdown version of each document which only keeps the names and dates in the document.
```
REPLACE
```
A-IEP protects confidentiality by converting each document to Markdown and redacting it before anything reaches an LLM. Names and dates are the only personal information kept, because a summary that cannot say who the child is or when a meeting happens is not useful to a parent.
```

### 1.3 The schema cannot both reject and backfill

Verified in the code: backfill runs at open_ai_agent.py:193, validation at :194.
The same sentence also promises page numbers let a parent check the content,
which the doc withdraws later.

FIND
```
A JSON schema rejects unknown or missing sections outright and a "not found" placeholder is added to any section the model dropped. Every section returns the page numbers it was drawn from, so the content can be checked against the original IEP the parent has.
```
REPLACE
```
Any section the model dropped is backfilled with a "not found" placeholder, and a JSON schema then rejects the output if a section is still missing or an unknown one appears. Every section returns the page numbers it was drawn from, so a parent can check the content against their own copy. We do not yet validate those page numbers, which is one of the things this evaluation adds.
```

### 1.4 The Aboulafia citation

Verified at cdt.org: author is **Ariana Aboulafia**, published 28 October 2025.
CDT's own summary says "57% of teachers", so your figure matches the source.

Not verified: the 28% figure is not in CDT's summary, only in the full report, and
I could not confirm whether it is teachers who used AI to *write* accommodations
or to *choose* them. Check the full report before publishing that clause.

FIND
```
(Abouladia, 2025)
```
REPLACE
```
(Aboulafia, 2025)
```

Add to references:
```
Aboulafia, A. (2025, October 28). From Personalized to Programmed: The Use of Generative AI to Develop Individualized Education Programs for Students with Disabilities. Center for Democracy & Technology. https://cdt.org/insights/from-personalized-to-programmed-the-use-of-generative-ai-to-develop-individualized-education-programs-for-students-with-disabilities/
```

The sentence also sits as a non-sequitur: the paragraph argues synthetic IEPs are
hard to make realistic, and this statistic is about teachers using AI. The point
you are reaching for is that real IEPs are already partly LLM-written, so the
synthetic gap is narrower than it looks. Worth saying.

### 1.5 GEMBA-MQM described as two shots

Verified in Appendix A, "Three examples Used for Few-shot Prompting". The first
is English to German and carries `Major: accuracy/mistranslation`,
`accuracy/omission`, `Minor: fluency/grammar`, `fluency/register`. Not a clean
translation. Figure 2's caption: "Three examples used for all languages."

FIND
```
The first LLM prompt will be a sample translation that is correct with an explanation of the MQM metrics, ex. numeric values are preserved and terminology is correct. Then the second will show an imperfect example and again explain how the MQM metrics misalign, ex. terminology is translated incorrectly. Lastly, the LLM knows now how it will be expected to score the translation.
```
REPLACE
```
GEMBA-MQM shows the judge three example translations, each already labelled with its errors and how severe they are. The same three are used for every language. We add our IEP terminology table to the prompt, so a term that does not match the table comes back as a terminology error.
```

### 1.6 Injected defects break the ledger

The corpus paragraph now says the ledger is the source of truth and both metrics
score against it, then says defects are added afterwards. A summary that
faithfully reproduces an injected inconsistency scores as a hallucination.

FIND
```
Before use some defects or imperfections, poor phrasing, and inconsistencies should be added to create realistic error.
```
REPLACE
```
Before use we add defects to make the documents realistic: poor phrasing, formatting noise, and the internal inconsistencies real IEPs carry. Every injected defect is recorded in the ledger, so a summary that reproduces one is scored as correct and a summary that silently corrects it is scored as a change to the source. Without that record an injected defect looks exactly like a model error.
```

### 1.7 RAGAS

Named once, never defined, not in the references, not among the three approaches
the doc commits to, and it is a RAG-evaluation framework for a pipeline the doc
says has no retrieval corpus.

FIND
```
To use some of these evaluation methods such as RAGAS, we need synthetic data to test against.
```
REPLACE
```
To use any of these evaluation methods we need data to test against, and it cannot be real student records.
```

### 1.8 The SynthTextEval paragraph concedes the doc's premise

The guiding question is what to do when evaluators cannot see real documents.
This sentence says the diversity tool largely depends on having real data, then
drops it.

FIND
```
While much of this hinges on having real data some pieces of it can be employed to ensure our dataset maintains enough diversity (Ramesh K, 2024/2026).
```
REPLACE
```
SynthTextEval's strongest features assume access to the real data a synthetic corpus stands in for, which we do not have. What we can use are the parts that work on the synthetic set alone: its measures of structural variety and topic spread, which tell us whether our hundred cases are meaningfully different from each other (Ramesh, 2024/2026). Diversity against real IEPs stays an open problem, and it is the main limitation of this corpus.
```

### 1.9 Three undefined thresholds

"discard matches that fall below a similarity threshold", "If citation recall or
precision falls below the threshold", and "if there is significant deviation".
None has a number. Add after the tone rubric:

```
Thresholds and decision rules

Every metric has a target and a stated consequence, set before the baseline run so we are not choosing the threshold after seeing the number.

Factual accuracy, supported divided by summary facts. Target [X]. Below it, the change does not ship. Contradicted facts are looked at one by one.
Completeness, matched divided by ledger facts. Target [X]. Below it, the change does not ship for Goals, Services and Accommodations. Reported for the other six sections.
Fabricated key points. Target 0. Any occurrence stops the release.
Citation recall and precision. Target [X] and [Y]. Report-only for the baseline, then we move to fact-level citation.
Flesch-Kincaid. 6th grade or below. Report-only. We investigate a move of more than one grade between runs.
G-Eval readability and tone, per language. Target [X] of 5. Report-only until we have measured judge agreement with human reviewers.
MQM critical errors. Target 0. Any occurrence stops the release for that language.
Fact matching similarity threshold. Set at [X] during the baseline run and versioned with the corpus, since every agreement number depends on it.

The report-only markings are deliberate. A threshold only gates a release once several runs have shown how much the score moves on its own. These are LLM-scored metrics and they do not repeat to the digit, so gating earlier produces failures nobody can act on.
```

---

## 2. Should fix

### 2.1 Completeness is circular and has no formula

FIND
```
Completeness uses the same graph comparison as the factual accuracy step, but to measure completeness. Accuracy is calculated to show how much of the generated sections are factually accurate, while data from the same process shows how much of the IEP is represented in the sections in the Completeness metric.
```
REPLACE
```
Completeness uses the same graph comparison as the factual accuracy step, read the other way round.

Accuracy = supported facts / facts in the summary
Completeness = matched facts / facts in the ledger

Accuracy asks how much of what we showed the parent is true. Completeness asks how much of the IEP reached them. One comparison, two denominators.
```

### 2.2 Recall is unbounded

The numerator has no correctness requirement, so citing every page pushes the
ratio above 1.

FIND
```
Recall is the ratio of cited pages to all the pages the facts are from,
```
REPLACE
```
Recall is the ratio of correctly cited pages to all the pages the facts are from,
```

### 2.3 The page-number field is proposed after it already exists

The atomic fact JSON already carries `"page_number": 1` about 85 lines earlier.

FIND
```
Our solution is to add the page number as a field in the atomic fact structure. This ensures that every atomic fact carries its page number, taken from the page-by-page segmentation of the IEP.
```
REPLACE
```
Our ledger already carries a page number on every atomic fact, taken from the page-by-page segmentation of the IEP, so we have the correct page for every fact in every section. Page numbering is 1-based, so page 1 is the first page of the IEP.
```

### 2.4 Three verdicts feed a two-way formula

Contradicted is collected and never reported, though it is the worse failure.

FIND
```
The comparison will determine if each fact is supported, unsupported, or contradicted. Once this is completed, as aligned with the FActScore methodology, an accuracy metric will be evaluated as supported facts divided by the total generated facts.
```
REPLACE
```
The comparison will determine if each fact is supported, unsupported, or contradicted. Following FActScore (Min et al., 2023) we report accuracy as supported facts divided by all facts in the summary. Contradicted facts are reported separately rather than folded into that number, because a fact that conflicts with the IEP is a different failure from one the IEP never mentions, and it is the one a parent is most likely to act on.
```

### 2.5 Two mechanisms check the same numbers

A second LLM here, deterministic hard-checks in the translation section.

FIND
```
Each atomic fact is tagged as quantitative or qualitative, for the quantitative facts, a second LLM will verify the accuracy of the date, frequency, or number provided, since these facts are some of the most critical and sensitive data in the IEP.
```
REPLACE
```
Each atomic fact is tagged as quantitative or qualitative. Quantitative facts carry the dates, frequencies and service minutes, and we check them deterministically against the ledger rather than with a model, because an exact match on a normalised number is cheaper and more reliable than asking a judge. Qualitative facts go to the graph comparison.
```

The published atomic fact JSON has no quantitative/qualitative field, and the
Hallucinations section calls the same thing "question type". Add the field to the
JSON example and drop the third name.

### 2.6 The ledger agreement sentence

Still describes a measurement the design makes impossible, since the ledger is
generated programmatically with no annotators.

FIND
```
We also report agreement on the ledger itself, because two trained annotators working from detailed guidelines still disagreed substantially in their study, and a denominator that disagrees with itself makes every metric built on top of it unreadable.
```
REPLACE
```
We also check each ledger against the IEP it produced. The LLM writing the IEP adds facts the ledger never specified, so a reviewer decides whether each one joins the answer key. We measure reviewer agreement on a sample, because a denominator that disagrees with itself makes every metric built on it unreadable.
```

### 2.7 Smaller items

- `Text must be concise, readable, and comprehensively cover critical information.` Conciseness is required and never measured. Add a length check or drop the word.
- The placeholder has two renderings: `This section was not found in the provided IEP document` and `section not found`. Use the literal string the code emits. Also `the summary is replaced` overstates: only that section is.
- The nine sections are referenced three times and listed nowhere. Enumerate once: Present Levels, Eligibility, Placement, Goals, Services, Informed Consent, Accommodations, Key People, Strengths.
- Arabic is priced throughout the cost model and absent from the readability section without comment.
- Self-hosting is a rejection reason for both alternatives, and it is the strongest answer to the doc's own confidentiality question. Worth naming the tradeoff.

---

## 3. Mechanical

| Find | Replace |
|---|---|
| `an synthetic IEP` | `a synthetic IEP` |
| `few-short prompts` | `few-shot prompts` |
| `mediate the issue of directionality` | `mitigate the issue of directionality` |
| `An outstanding issue with this message` | `An outstanding issue with this method` |
| `COMET-kiwi a turned model` | `COMET-kiwi, a tuned model` |
| `Graph representation corrects for this.` | `Graph representation exposes this.` |
| `FActScore would support this` | `FActScore would score it as supported` |
| `an LLMs performance` | `an LLM's performance` |
| `one the key-categories` | `one of the key-categories` |
| `(Pulkundwar, P.,, 2025)` | `(Pulkundwar et al., 2025)` |
| `inter-family bias in the models` | `self-preference bias, where a model scores its own output more favourably` |
| `three languages in the languages with the most need` | `three languages with the most need` |
| `Currently A-IEP offers translation in Spanish, Vietnamese, Mandarin, and Arabic soon.` | `A-IEP currently offers translation in Spanish, Vietnamese and Mandarin, with Arabic in progress.` |
| `(Reimers et al., 2019).The Hungarian` | `(Reimers et al., 2019). The Hungarian` |

Also outstanding:

- The three JSON blocks are missing enclosing brackets and one has a trailing comma. They will not parse as pasted.
- `"confidence": 1.0` is introduced, never defined, never used by any metric.
- The graph example represents only F2. F1 has no node or edge.
- `"source_span": "3 weekly probes"` does not appear in the worked example. The input says `in three consecutive weekly probes`.
- Both MQM examples call goal content a service. Reading fluency probes and Reading Comprehension are goals there, and the distinction is legally meaningful.
- The completeness table encodes "no" as an empty cell, so a negative is indistinguishable from a rendering failure.
- Heading case is inconsistent: `How we Currently Evaluate Summary Quality` against `How to evaluate translations`.
- Long blank runs remain after the completeness table, likely dropped figures.

---

## 4. Cost Analysis

Needs a rebuild rather than edits. Four errors compound, all in the same
direction.

- **Sonnet 5 is priced at $3/$15.** Verified: Anthropic publishes $2/$10 and states on the pricing page that the increase to $3/$15 "will not occur". Batch is $1/$5.
- **60 atomic facts per 20-page IEP is 3 facts per page.** Your own sample page yields roughly 43 at the granularity where `"object": "curious"` is one fact.
- **The pipeline row prices an agent loop as one call.** Verified in code: `max_turns=150`, `parallel_tool_calls=True`, and `get_all_ocr_text` puts 15,000 tokens into a transcript resent every turn. Single-call basis is $0.062. At 20 turns parsing alone is roughly $0.68, exceeding the $0.48 stated for the whole row.
- **"$81 setup, $70 per run"** assumes Sonnet plus Batch, which the sentence never says, and the next paragraph commits to running both judges. That is $120.

Smaller, all real: the $0.70 on-demand rescan quotes the batch price; the 25
rescans are never budgeted; "A Haiku 4.5 judge costs $0.79 per document" folds in
the judge-independent $0.48 pipeline row, so judge-only is $0.31 and $0.92 and
the pipeline is 61% of the Haiku column; the corpus row is not batch-discounted;
the $11 corpus figure has no model behind it and no entry in the unit table;
Comprehend has no batch discount but is halved; Sonnet 5's tokenizer produces
roughly 30% more tokens for the same text; Vietnamese tokenizes at roughly 1.5 to
2x English.

Recommend instrumenting ten real runs and publishing measured numbers.

---

## 5. References

- **Out of order:** the two `Pricing` entries and `Pulkundwar` sit after Rooein and belong between Min and Ramesh. The two Pricing entries are also reversed relative to each other.
- **Cited, missing:** Aboulafia (entry in 1.4), MQM Council (`MQM Council. (n.d.). MQM Council. https://themqm.org/mqm-council/`), Achieve Beyond.
- **Listed, never cited:** Min et al. FActScore. Discussed four times with no citation while its reference sits unused. Add `(Min et al., 2023)` at first mention.
- **Duplicated:** the Li et al. entry appears in the list and in full as footnote [1].
- **Format:** `Chataigner C, Taïk A, Farnadi G.` is not APA. `Ramesh K, 2024/2026` needs a comma after the surname. The four pricing entries have no author and no date. The AHRQ entry never names AHRQ, which is the entire weight of the 6th-grade claim. NASET keeps `| NASET` inside the title. SynthTextEval should be `[Computer software]`. SBERT pages are 3980-3990; ACL Anthology gives 3982-3992. `(arXiv:2512.02527; Version 1)` carries a version marker no other entry has.

---

## 6. Your call

1. Regenerate the worked example, or annotate its errors.
2. Arabic: in or out of the evaluation.
3. Whether injected corpus defects are recorded in the ledger.
4. Every bracketed threshold value.
5. Whether the doc still claims summarization "is not evaluated" while carrying a heading saying how it is currently evaluated.
6. Check the 28% figure against CDT's full report before publishing it.
