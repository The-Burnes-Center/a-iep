# Sample IEP Reference Library

Public sample IEPs and blank state forms, collected 2026-07-16 for the synthetic IEP dataset research (see [docs/AI_EVALUATION_RESEARCH.md](../AI_EVALUATION_RESEARCH.md) §5.5 and the blog draft). These ground the template profiles and serve as local-only realism controls.

**Usage policy:** all files are public documents published by state agencies, districts, or NASET. Several completed samples are *redacted records of real students*: treat them respectfully, use them locally for format research only, and never commit or redistribute them. The folder `.gitignore` excludes `*.pdf` for this reason.

**Naming convention:** `{STATE}_{source}_{kind}_{detail}_{year}.pdf`
- `kind`: `sample` (completed, filled-in) | `form` (blank template) | `manual` (form-writing guide)
- `sample` detail notes `redacted` (real student, redacted) vs `fictional` (filled with fake data)

## Completed samples (highest value: show real filled-in content)

| File | Pages | What it is | Source |
|---|---|---|---|
| `CA_fontana-selpa_sample_fictional-26p_2021.pdf` | 26 | Fontana SELPA (CA) full sample filled with **fictional** data ("John Doe", 555 numbers). SEIS-style packet incl. meeting invitation. Precedent for synthetic IEPs. | [NASET](https://media.naset.com/uploads/2026/04/Sample-IEP.pdf) |
| `CA_fresno-usd_sample_redacted_2018.pdf` | ~? | Fresno Unified (CA) completed IEP, redacted, Dec 2018. Closest to what SF-area parents upload (SEIS-style). | [NASET](https://media.naset.com/uploads/2026/04/Sample-IEP-ca-1.pdf) |
| `MT_state_sample_kindergarten_2012.pdf` | ~? | Montana completed kindergarten sample (April 2012). | [NASET](https://media.naset.com/uploads/2026/04/iep-a-montana-1.pdf) |
| `OR_ode_sample_redacted.pdf` | 14 | Oregon Dept. of Education redacted completed sample. | [ODE](https://www.oregon.gov/ode/educator-resources/standards/Documents/IEP%20Sample%20Redacted.pdf) |
| `US_naset_sample_completed.pdf` | 11 | NASET generic completed sample IEP. | [NASET](https://media.naset.com/fileadmin/user_upload/Forms_Checklist_Etc/IEP/Completed_Sample_IEP.pdf) |
| `WA_ospi_sample_A_redacted.pdf` … `_H_redacted.pdf` | varies | Washington OSPI redacted real IEP samples A through H (8 documents, scanned packets). **Sample E** (grade 9, EBD, 15p) is the deep-dive anchor analyzed in the plan/blog: invitation letter, contact log, cover page, team considerations, present levels, transition, goal blocks, accommodations, assessment grid, services matrix, LRE grid with rejected options, PWN. | [OSPI](https://ospi.k12.wa.us/student-success/special-education/program-improvement/model-forms-services-students-special-education) (`.../2022-12/iep-a.pdf` … `iep-h.pdf`) |

Missing (server blocks non-browser downloads; fetch manually if needed): Mississippi *redacted real* sample at <https://www.mdek12.org/sites/default/files/sample_iep_redacted.pdf>.

### Team-collected fictional examples (from DB's collection, added 2026-07-16; originally gathered March 2025)

All filled with fictional data (sitcom-character names, 555 numbers, "Central" schools, sequential fake IDs) on real state form layouts. Five are from [Euna Solutions' IEP examples page](https://eunasolutions.com/resources/iep-examples-in-2023/); note their identity pool is deliberately recognizable as fake, a useful contrast for our own (which aims for realistic-but-provably-fictional).

| File | Pages | What it is |
|---|---|---|
| `AZ_euna_sample_fictional-ohi-g11_2021.pdf` | 10 | Arizona annual IEP, OHI, grade 11; services grid with §300.320/A.A.C. citations |
| `AR_euna_sample_fictional-g5_2022.pdf` | 10 | Arkansas ADE-SPED form, grade 5; rich parent-input narrative (vision, motor, mental health) |
| `MO_euna_sample_fictional-sld-g8_2022.pdf` | 21 | Missouri DESE form, SLD, grade 8; **includes COVID-era distance-learning service language** (real-world quirk worth sampling) |
| `MS_euna_sample_fictional-sld-g9_2022.pdf` | 16 | Mississippi form, SLD, grade 9; committee participants, meeting-recorded field |
| `TX_euna_sample_fictional-ard-aut-gK_2022.pdf` | 15 | Texas **completed ARD committee document**, autism, kindergarten, transfer student (fills the filled-TX gap; blank TEA model form above) |
| `US_pwsa_sample_fictional-prader-willi.pdf` | ~? | Prader-Willi Syndrome Association "School Success Kit" sample IEP ([pwsausa.org](https://www.pwsausa.org/wp-content/uploads/2021/08/Sample-IEP-.pdf)); disability-specific, health/dietary/behavioral supports |

(The zip also contained NASET's `Completed_Sample_IEP.pdf`, byte-identical to `US_naset_sample_completed.pdf` above; skipped as duplicate.)

## Blank state forms (template-profile sources)

| File | Pages | Notes | Source |
|---|---|---|---|
| `AL_state_form_blank.pdf` | 7 | Alabama state template (Feb 2019) | [NASET](https://media.naset.com/uploads/2026/04/Individualized-Education-Program-Alabama.pdf) |
| `CO_state_form_blank_2015.pdf` | ? | Colorado state form (June 2015) | [NASET](https://media.naset.com/uploads/2026/04/IEP-Form-from-Colorado-Department-of-Education-1.pdf) |
| `CT_state_form_ppt_2021.pdf` | 16 | Connecticut PPT form, domain-by-domain goals | [NASET](https://media.naset.com/uploads/2026/04/CT-IEP.pdf) |
| `FL_palm-beach_form_blank_2015.pdf` | ? | Palm Beach County FL district template | [NASET](https://media.naset.com/uploads/2026/04/Sample-IEP-Florida.pdf) |
| `GA_state_form_model_2007.pdf` | 7 | Georgia model form | [NASET](https://media.naset.com/uploads/2026/04/Iep-Georgia-1.pdf) |
| `IN_state_form_case-conference_2025.pdf` | 29 | Indiana case-conference form with **embedded eligibility** (April 2025); source for `in_embedded` profile | [NASET](https://media.naset.com/uploads/2026/04/IEP-Template-Indiana-1.pdf) |
| `KS_state_form_blank.pdf` | 21 | Kansas, domain-by-domain format | [NASET](https://media.naset.com/uploads/2026/04/Blank-IEP-kansas-1.pdf) |
| `KY_state_form_arc_2016.pdf` | ? | Kentucky ARC form (transition at 14) | [NASET](https://media.naset.com/uploads/2026/04/KYIEP.pdf) |
| `LA_state_form_blank_2019.pdf` | 15 | Louisiana form with sample pages | [NASET](https://media.naset.com/uploads/2026/04/Blank-IEP-Form-Louisiana-1.pdf) |
| `MD_state_form_blank_2020.pdf` | 34 | Maryland (July 2020); documents emergency-evacuation accommodations | [NASET](https://media.naset.com/uploads/2026/04/MdIEP_July2020-1.pdf) |
| `ME_state_form_muser_2018.pdf` | 10 | Maine MUSER template | [NASET](https://media.naset.com/uploads/2026/04/maine-IEP.pdf) |
| `MS_state_form_blank_2018.pdf` | 15 | Mississippi state template (Feb 2018) | [NASET](https://media.naset.com/uploads/2026/04/IEP.REVISED.2.18.18-Mississippi-.pdf) |
| `MT_state_form_blank-3p_2021.pdf` | 3 | Montana minimal 3-page form; source for `mt_minimal` profile | [NASET](https://media.naset.com/uploads/2026/04/IEP-Plan-for-Informational-Purposes-Only-montana-1.pdf) |
| `ND_state_form_ages6-15.pdf` | ? | North Dakota ages 6-15, embedded parent guidance | [NASET](https://media.naset.com/uploads/2026/04/sample-iep-age-6-15.pdf) |
| `ND_state_form_ages16-21_transition.pdf` | ? | North Dakota ages 16-21 transition version | [NASET](https://media.naset.com/uploads/2026/04/sample-iep-age-16-21-nd.pdf) |
| `NE_state_form_blank_2012.pdf` | ? | Nebraska state form (Aug 2012) | [NASET](https://media.naset.com/uploads/2026/04/iep-form-Nebraska-1.pdf) |
| `NV_state_form_blank_2015.pdf` | 11 | Nevada state form (Oct 2015) | [NASET](https://media.naset.com/uploads/2026/04/IEP-Info-1.pdf) |
| `NY_state_form_mandated.pdf` | ? | New York **state-mandated** form; source for `ny_state` profile | [NASET](https://media.naset.com/uploads/2026/04/blank-iep-NY-1.pdf) |
| `OK_state_form_blank.pdf` | ? | Oklahoma fillable template (22p) | [NASET](https://media.naset.com/uploads/2026/04/Ok.pdf) |
| `OR_state_form_standard_2022.pdf` | 14 | Oregon standard form (June 2022); gender "X" option | [NASET](https://media.naset.com/uploads/2026/04/orstandardiep.pdf) |
| `PA_state_form_blank_2025.pdf` | ? | Pennsylvania form (July 2025, 18p); source for `pa_state` profile | [NASET](https://media.naset.com/uploads/2026/04/individualized-education-program-iep-PA-1.pdf) |
| `RI_state_form_ages3-13.pdf` | 18 | Rhode Island elementary/early childhood | [NASET](https://media.naset.com/uploads/2026/04/RI-Age-3-thru-13-IEP-form_2.pdf) |
| `RI_state_form_secondary.pdf` | ? | Rhode Island secondary transition (first-person student voice) | [NASET](https://media.naset.com/uploads/2026/04/RI-Secondary-IEP-form_4.pdf) |
| `SD_state_form_blank_2022.pdf` | ? | South Dakota (Aug 2022) | [NASET](https://media.naset.com/uploads/2026/04/IEP-plan-0922-1.pdf) |
| `SD_state_form_blank_2025.pdf` | 12 | South Dakota (July 2025) | [NASET](https://media.naset.com/uploads/2026/04/IEP-plan-0725-sd-1.pdf) |
| `TX_tea_form_model.pdf` | ? | Texas TEA model form, goal-area structure; source for `tx_ard` profile | [NASET](https://media.naset.com/uploads/2026/04/model-iep-form-english-tx.pdf) |
| `VT_state_form_blank_2023.pdf` | 20 | Vermont (Sept 2023) | [NASET](https://media.naset.com/uploads/2026/04/IEP-vermont.pdf) |
| `WA_ospi_form_secondary-28p_2019.pdf` | 28 | Washington blank secondary form; source for `wa_ospi` profile | [NASET](https://media.naset.com/uploads/2026/04/Secondary-Indiviualized-Education-Program-IEP-Revised-August-2019.docx.pdf) |

## Manuals & federal

| File | Pages | Notes | Source |
|---|---|---|---|
| `CA_state-selpa_manual_seis-forms_2021.pdf` | 34 | CA State SELPA "Writing IEPs for Educational Benefit" forms manual (Jan 2021); documents the SEIS form set; source for `ca_seis` profile | [Sutter SELPA](https://sutterselpa.org/documents/Resources/Staff%20Resources/SEIS%20Updates/State%20SELPA%20IEP%20Manual%20Main%20Forms%20January%202021%20Final.pdf) |
| `CA_state-selpa_manual_seis-forms_2025.pdf` | 36 | Same manual, 2025 edition | [CAHELP](https://resources.finalsite.net/images/v1755717709/cahelporg/ndxa8gaym2rza6xelrzl/StateFormsManual2025.pdf) |
| `CA_riverside-selpa_manual_iep_2023.pdf` | 154 | Riverside County SELPA IEP manual 2023-24 (deep CA process detail) | [RCSELPA](https://rcselpa.org/uploads/files/files/IEP%20Manual%2007-23(5).pdf) |
| `US_osep_form_model-part-b.pdf` | 3 | Federal OSEP model IEP form (the bare federal minimum; useful contrast) | [ed.gov](https://sites.ed.gov/idea/files/modelform1_IEP.pdf) |

## Landing pages (for future re-fetching)

- NASET state-by-state collection: <https://www.naset.com/ieps-from-around-the-country/>
- WA OSPI model forms & samples: <https://ospi.k12.wa.us/student-success/special-education/program-improvement/model-forms-services-students-special-education>
- NY State Education Dept. IEP forms: <https://www.nysed.gov/special-education/model-student-information-summary-form-and-mandatory-iep>
- Texas TEA IEP model form: <https://tea.texas.gov/academics/special-student-populations/special-education/programs-and-services/iep-model-form>

## State rules & content references (no documents)

These complement the forms/samples above: they describe per-state *rules* (timelines, safeguards, ESY criteria, discipline procedures) that synthetic IEP content must respect, e.g. for the spec sampler's per-state consistency constraints.

- **IEP Says state hubs**: <https://www.iepsays.com/states> — all 50 states + DC, ~74 articles each on state rules beyond the federal IDEA baseline (e.g. [California](https://www.iepsays.com/states/california)). Parent-guidance site, publisher/authorship not disclosed; convenient index, but **verify any rule against primary sources** (state ed code/regs, SELPA manuals) before encoding it into the generator.
- Primary rule sources: state special-ed regulations, CA SELPA procedural manuals (see Riverside manual above), state DOE guidance pages.
