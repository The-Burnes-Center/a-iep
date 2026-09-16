# 50 Students Who Don't Exist: Our Plan to Test the AI That Reads IEPs

**DRAFT v3. Placeholders in [brackets]. Editorial flag: the earlier post publicly says "ten sections"; the current system organizes nine. This draft says "nine." Pick one and keep it consistent.**

*By [DB], with colleagues in the AI for Impact initiative at the Burnes Center for Social Change. [Comment link / email / form here.]*

---

A-IEP does one job. It takes an Individualized Education Program, the legal document of 15 to 30 pages of tables and jargon that defines a child's special education services, and makes it understandable to the parent it belongs to. A plain-language summary. Nine organized sections. Translations in Spanish, Vietnamese, Chinese, or Arabic. Nearly [8 million students](https://nces.ed.gov/programs/coe/indicator/cgg/students-with-disabilities) in the US have one of these documents.

Ask us how often our AI gets an IEP right, and the honest answer today is: we cannot give you a number. As far as we can tell, nobody building AI for special education can give you one that can be checked: how it was measured, on which documents, against what definition of correct. That is not a knock on anyone. There is no shared test for this work. This post is our plan to build that test for our own tool, openly, so anyone else can borrow it.

We are publishing the plan before we build any of it. [The last time we put our internal work in front of this community](https://rebootdemocracy.ai/blog/unboxing-the-prompt-how-community-feedback-and-ai-helped-us-build-better-ai-together), parents found problems no engineer would have caught. What we are sharing now decides something bigger than any prompt: it is the test our AI has to pass.

## The test our AI never took

Today, our system automatically checks that the AI returned everything in the right *format*. Nothing automatically checks that any of it is *right*. Is the summary faithful to the document? Did we catch every service and every minute? Does "least restrictive environment" survive the trip into Vietnamese with its legal meaning intact? We review outputs by hand, we build guardrails into the prompts, and we designed the pipeline so mistakes are recoverable. But we cannot yet put a number on how accurate we are, and neither can almost anyone else building AI for special education.

For me, this was the uncomfortable admission of this year: we built the feedback loop with parents, and we still had no ruler.

The stakes are not abstract. *Imagine walking into your child's IEP meeting trusting a summary that quietly dropped the one service you needed to fight for.* [A majority of teachers already report using AI for IEP-related work](https://cdt.org/insights/from-personalized-to-programmed-the-use-of-generative-ai-to-develop-individualized-education-programs-for-students-with-disabilities/), and advocates have documented real cases of AI tools inventing content. If AI is going to touch these documents, it should be tested like it matters. And the tests should be public.

## The test data problem

The standard way to test a system like ours is a golden dataset: real inputs paired with expert-verified correct answers, so every change to a prompt or model gets scored against known truth.

There is one problem. IEPs are among the most sensitive documents that exist about a child. They combine identity, disability, health, behavior, and family information, and they are protected education records under FERPA. A-IEP is built around that: PII is machine-redacted before any AI model sees the text, originals are deleted after processing, and nothing a parent uploads is kept for training or testing.

That privacy posture is a feature. It also means we cannot mine our own history for test data, because we deliberately do not have one. And no public benchmark of IEP documents exists anywhere, for the same reason.

So we are going to invent the students.

Our plan: roughly 50 fully synthetic IEPs, belonging to no real child, realistic enough that our pipeline cannot tell the difference, each paired with a machine-checkable answer key. Fake students. Real test.

## What we studied before designing anything

We did not want to invent IEPs from an engineer's imagination. So we went looking at real ones first.

**There is no such thing as "the" IEP format.** Federal law fixes what an IEP must contain, but every state, and often every district, designs its own form. We reviewed model forms and completed samples from more than two dozen states, including [NASET's state-by-state collection](https://www.naset.com/ieps-from-around-the-country/) and redacted real examples published by [Washington](https://ospi.k12.wa.us/student-success/special-education/program-improvement/model-forms-services-students-special-education), [Oregon](https://www.oregon.gov/ode/educator-resources/standards/Documents/IEP%20Sample%20Redacted.pdf), [Mississippi](https://www.mdek12.org/sites/default/files/sample_iep_redacted.pdf), and California SELPAs. Montana's form is 3 pages. Washington's secondary sample runs 28. Transition planning starts at 16 in most states, at 14 in New York, and at the start of high school in California as of 2025. Even the software matters: much of what an IEP looks like is decided by district systems like SEIS, EasyIEP, or Frontline, and one vendor estimates its products generate [a fifth of the IEPs in the country](https://www.fullmindlearning.com/blog/frontline-iep-review).

**Real documents are packets, and they are messy.** We studied one Washington sample page by page. It is not a form. It is a 15-page packet: a meeting invitation letter, a contact log, a cover page, a special-factors checklist, narrative pages with quantified baselines ("reading 60 words correct per minute at the 6.0 grade level"), ten separate goal blocks, an accommodations table, an assessment grid, a services matrix with totals ("900 minutes per week served in a special education setting"), a placement page listing options *considered and rejected*, and a prior written notice. The scans are crooked. A goal splits mid-sentence across a page break. One page is nearly blank. Any fake IEP that is not this messy, in these specific ways, is a fake test.

**Who IEPs are about.** In federal data, roughly a third of students served have specific learning disabilities, about 19 percent have speech or language impairments, 15 percent other health impairments, and 13 to 14 percent autism. Our 50 students should mirror that distribution, not the scenarios that are easiest to write.

**What the research warns.** Two traps are well documented. Synthetic documents tend to come out too clean, which makes the AI look better than it is. And when the same AI family writes the fake documents, reads them, and grades the results, self-consistency can quietly inflate every score. Our design confronts both head-on.

## The plan: how to fake an IEP honestly

One decision matters more than all the others: **the truth about each fake student is fixed before any AI writes a word.**

**1. The answer key comes first, and no AI writes it.** A generator program assembles each student the way a tabletop game assembles a character: weighted dice rolls over tables we built from the research above. Disability is drawn from the national distribution. Grade is rolled, then a birth date computed to match. Services come from menus of real service types with realistic minutes, and dates and totals are computed so everything adds up. Consistency rules reject combinations that make no sense. The result is a complete profile: placement, services, accommodations, goal baselines, team members, family language. That profile *is* the answer key. Because code chose every fact, we know every answer with certainty, instead of hoping an AI described its own invention accurately.

**2. Code writes the facts. AI writes only the prose.** Every checkable value, from service grids to dates, is placed into the document by code, character for character. A language model writes only what educators write freely: present-levels narratives, strengths, parent concerns, meeting notes. If the model drops a required detail, the passage is regenerated. If it keeps failing, the case is thrown away. Never patched.

**3. Real PDFs, through our real pipeline, twice.** We render each case as an actual PDF styled after a specific state's forms, packet and all, and run it through the same OCR engine production uses. Then we do it again with a degraded twin of the same document: reprinted and rescanned to look like the phone photos parents actually upload. Same student, same answer key, two versions. Comparing scores between the clean and messy versions tells us how much of any failure is the AI's reading and how much is document quality, and it keeps us honest about the gap between lab conditions and a kitchen-table photo. Either way, the noise in our test data will be real OCR noise, not our imagination of it.

**4. Provably fake people.** Every name comes from curated fictional pools, every school and district is invented and checked against a blocklist of real district names, phone numbers use reserved fictional ranges, student IDs come from a marked synthetic range. A validator rejects any document containing a name it cannot account for. No real student, family, educator, or school appears anywhere, and we can prove it mechanically.

**5. Fifty students, eight states, on purpose.** Cases are spread across eight template profiles modeled on real state forms and vendor software, across ages from preschool to transition, meeting types, placements, family languages, and deliberate mess: missing sections, split tables, duplicate scanned pages, illegible handwriting. A few students appear twice, with consecutive annual IEPs whose year-over-year changes we know exactly, because a child's IEP story spans years, and tools should someday be tested on whether they can follow it.

**6. Traps.** Real IEPs contain placements that were considered and rejected. A trustworthy summary must not present a rejected option as the decision. Our answer keys include "must never appear" traps built from exactly these structures, to catch an AI that reads the right page and draws the wrong conclusion.

**7. People check everything.** Every case gets human review against a checklist before it counts. We will ask special education practitioners to judge samples against the real thing. And we will statistically compare our synthetic documents to the public redacted samples to detect too-clean drift.

## Grading the test before it grades us

Before this corpus judges our AI, it gets judged itself, four ways. Machine gates: dates that add up, ages that match grades, every answer-key fact actually findable on its page, zero PII policy violations. Pipeline compatibility: synthetic packets must flow through our production system exactly like real uploads. Practitioner review: the test we cannot automate, do these read as real? And a pilot: we build five cases and score them with a prototype evaluator before we commit to fifty.

Then comes the part we care about most. With this corpus in place, every summary claim can be checked for faithfulness, every extracted service for accuracy, every translation scored per language with human calibration, every prompt change regression-tested automatically. We intend to publish those numbers together with the methodology and the dataset design behind them, so anyone can interrogate how we measured, not just what we scored. We think that should be the norm in special education AI. The most useful contribution we can make is to go first and show our work.

## Now it is your turn

This is where you come in, especially if you are a special education practitioner, an advocate, a parent, a translator, or an AI evaluation researcher. Mark this plan up. Specifically:

1. **What would give it away?** If you work with IEPs daily, what would tell you a document is fake? What do real goal pages, meeting notes, and district quirks look like that we have not captured?
2. **What must not be missing?** Which student scenarios does a 50-case corpus absolutely need? Dually identified English learners, AAC users, students in foster care, contentious meetings with partial consent, something we have not listed?
3. **What do tools get wrong?** In your experience, what do AI tools, or rushed humans, most often misread in an IEP? Those mistakes are exactly what we should plant traps for.
4. **Is our answer key the right kind of answer?** For a parent-facing summary, is "key facts that must appear, exact values that must match, statements that must never appear" the right definition of correct?
5. **Should this exist, and should it be public?** Are there harms in realistic fake IEPs we have not weighed? How realistic should the fake *identities* be: our plan uses realistic, culturally diverse names (because name handling is where AI fails unevenly) with provably fake identifiers and fictional schools, rather than obviously fake names, and we want scrutiny on that trade-off. If the finished corpus is solid, should we release it as an open benchmark for everyone building in this space, and under what conditions?
6. **The long game.** Research is clear that synthetic data alone is never enough. If you know consent frameworks or partners through which fully de-identified real IEPs could responsibly join this corpus, we want to talk.

**How to respond:** [comment mechanism / email / form]. The comment window is open until [date]. We will publish what we heard and what we changed, then build in the open, pilot first.

If this plan survives your critique, we build it. If it does not, even better. We would rather be wrong on paper than wrong in a corpus of fifty students, and wrong again in every accuracy score built on top of it.

---

*A-IEP is developed by the AI for Impact initiative at the Burnes Center for Social Change [at Northeastern University], piloted with families in San Francisco. Our co-design research was published at [DIS 2025](https://doi.org/10.1145/3715336.3735778). Nothing in this post, and nothing in the planned dataset, contains information about any real student.*
