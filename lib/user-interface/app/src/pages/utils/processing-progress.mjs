/**
 * Pure mapping from an IEP document payload to what the processing screen
 * draws: how full the bar is, and which i18n KEY names the work in flight.
 *
 * The bar used to be MUI's indeterminate LinearProgress, which says nothing
 * at all — the same barber-pole for the ten seconds of OCR and the four
 * minutes of summarizing. The pipeline already records where it is
 * (`progress`, `current_step`, written at every milestone by ddb-service's
 * update_progress), the documents endpoint already returns both, and nothing
 * on the frontend read either one.
 *
 * `progressPercent` is what the server has CONFIRMED and is the honest value.
 * On top of it, `displayPercent` eases between milestones so the bar is never
 * motionless, under one rule that makes it safe: it can never reach the next
 * milestone, only approach it. Whatever happens to the clock, a document that
 * has confirmed 22% never draws a bar that claims 65%.
 *
 * Same extensions and the same reason as ./translation-flow.mjs — .mjs plus a
 * hand-written .d.mts, because jest here has no TypeScript transform and
 * .gitignore blanket-ignores .js/.d.ts. The two files are a pair: change one,
 * change the other.
 *
 * Tested by test/lambdas/summary-page/processing-progress.test.mjs.
 */

/**
 * What the pipeline writes at each milestone.
 *
 * Mirrors `progress` in lib/chatbot-api/state-machines/iep-processing.asl.json,
 * plus `translation_requested` (80) from translation-request-handler's
 * IN_FLIGHT_PROGRESS and `completed` (100) from the finalize_results step.
 *
 * Only used as a fallback when the payload carries a step but no usable
 * number — the number itself is always preferred, so adding a milestone
 * server-side needs no change here to keep the bar honest.
 *
 * WHY THESE VALUES, and why analysis_complete is not higher.
 *
 * They are spaced by measured wall clock (the table further down), but one
 * scale has to serve two paths and the two disagree. The upload pipeline
 * skips the translate step for an English-only document, 32 of 40 prod runs,
 * and for those almost nothing happens after the analysis milestone, so
 * time-proportional spacing wants it near 94. For a document that DOES
 * translate, half the remaining wait comes after it, and the same logic wants
 * it near 52. Nothing can tell the two apart at the milestone before, because
 * the language decision is not made until after the summarizing step.
 *
 * 75 is the point past which the translated parent starts paying for the
 * English-only one. Simulated against the measured timeline, moving this to
 * 96 halves the English-only pacing error and leaves a translated document's
 * bar moving two points or less for 25 SECONDS, at 94%: the "it is stuck"
 * failure this file exists to prevent, at the percentage where it reads
 * worst, for the non-English-speaking parent the app is for. So the value is
 * capped where neither path regresses rather than where the weighted average
 * is best.
 *
 * The tail is the part that was simply wrong, and is what this fixed: 85 gave
 * 15 points of bar to a step that takes 1.5s, so the bar rested and leapt.
 */
export const PIPELINE_MILESTONES = {
  start: 5,
  ocr_complete: 15,
  pii_redaction_complete: 20,
  cleanup_complete: 22,
  analysis_complete: 75,
  translation_requested: 80,
  translation_complete: 97,
  completed: 100,
};

/**
 * The bar never starts empty.
 *
 * A row the upload handler has written but the pipeline has not picked up yet
 * comes back as `progress: 0` (user-profile-handler defaults it), and a bar at
 * 0% next to "we are processing the document" reads as nothing happening at
 * all. 5 is the pipeline's own first milestone, so this shows the parent where
 * the run is about to start rather than a number we made up.
 */
export const FLOOR_PERCENT = 5;

const COMPLETE_PERCENT = 100;

/**
 * The milestones a single run passes through, in order, so "the next one" is a
 * lookup rather than a second table to keep in step.
 *
 * `translation_requested` (80) is deliberately absent. It is where the
 * on-demand add-a-language path ENTERS, not a waypoint the upload pipeline
 * crosses, and including it made 80 the ceiling for the whole translate step:
 * the bar eased 75 -> 79 across 24 seconds of work and looked stuck at the
 * milestone it had just left. Leaving it out makes the next milestone above
 * both 75 and 80 the same one, `translation_complete`, which is what actually
 * comes next from either.
 */
const MILESTONE_ORDER = [
  'start',
  'ocr_complete',
  'pii_redaction_complete',
  'cleanup_complete',
  'analysis_complete',
  'translation_complete',
  'completed',
];

/**
 * How long the step AFTER each milestone usually takes, in ms.
 *
 * Measured, not guessed: WALL CLOCK between consecutive progress writes, from
 * the Step Functions execution history of the 40 most recent successful prod
 * runs and the 60 most recent on staging, pooled (2026-09-15, n=100).
 *
 * Wall clock rather than the steps' AWS/Lambda Duration, which was the first
 * thing tried and is the wrong statistic: it leaves out the state transitions
 * and the separate progress-writing lambda between every pair.
 *
 *   sitting at               n    p50     avg     p90     max
 *   start (5%)              96   4.6s   10.4s    7.7s  500.6s
 *   ocr_complete (15%)      96   2.3s    1.9s    3.0s    3.7s
 *   pii_redaction (20%)     96   2.2s    1.6s    2.5s    3.6s
 *   cleanup_complete (22%)  96  29.2s   31.8s   46.7s  100.5s
 *   analysis_complete (75%) 47  24.2s   30.0s   47.6s  117.7s
 *   translation_cmpl (97%)  47   1.5s    1.0s    1.8s    1.9s
 *
 * The whole run is 48s at p50 in both environments (prod 48.3s, staging
 * 47.4s), so pooling them is sound and doubles the sample.
 *
 * Staging is what makes the translate step measurable at all: only 8 of the
 * 40 prod runs translated, because TranslationChoice skips the step for an
 * English-only document, and 39 of the 60 staging runs did. Off prod alone
 * this step's p90 was just the slowest of eight samples, 117.7s, which is
 * 2.5x the pooled figure below and paced the bar far too slowly.
 *
 * p90 rather than the mean throughout -- see TIME_CONSTANT_NOTE. The one
 * place they diverge sharply is `start`, whose mean is dragged to 10.4s by a
 * single 500s outlier; p90 is the robust reading there.
 *
 * Re-measure from the execution history if a step changes materially, and
 * pool both environments again. Being wrong here costs the bar's pacing and
 * nothing else: the ceiling below is what keeps it honest, not these
 * numbers.
 */
const STEP_TIME_CONSTANT_MS = {
  // Waiting for the browser's S3 PUT to land and the orchestrator to fire.
  // Not measurable from the execution history, which by definition starts
  // after it (once a run starts, 5% is written within 0.2s). Generous,
  // because this is also the window a stalled upload sits in.
  initializing: 20_000,
  start: 7_700,
  ocr_complete: 3_000,
  pii_redaction_complete: 2_500,
  cleanup_complete: 46_700,
  analysis_complete: 47_600,
  translation_requested: 47_600,
  translation_complete: 1_800,
};

/** For a step added after this file was written. */
const DEFAULT_TIME_CONSTANT_MS = 60_000;

/**
 * TIME_CONSTANT_NOTE
 *
 * The ease is 1 - e^(-t/T), so T is where it has covered 63% of the distance
 * it is ever allowed to cover, and it approaches the rest without arriving.
 * Feeding it p90 rather than the mean means the typical document's milestone
 * lands while the bar is only part of the way, which reads as the bar jumping
 * FORWARD. The other way round -- a bar that has run out of room and is
 * sitting still -- is the thing this whole mechanism exists to avoid, so the
 * error is pointed deliberately.
 */
const EASE = (elapsedMs, timeConstantMs) =>
  1 - Math.exp(-elapsedMs / timeConstantMs);

/**
 * The share of the gap to the next milestone that easing may cover.
 *
 * Under 1 because the remainder is the promise: 22% confirmed eases to at most
 * 22 + 0.9 * (65 - 22) = 60.7, and only the server saying `analysis_complete`
 * moves it to 65. A parent is never shown a step as finished that is not.
 */
const CREEP_CEILING = 0.9;

/** Status the pipeline sets once every language is written. */
const PROCESSED_STATUS = 'PROCESSED';

const isUsableNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const clampPercent = (value) =>
  Math.min(COMPLETE_PERCENT, Math.max(FLOOR_PERCENT, Math.round(value)));

/**
 * How full the bar is, 5-100.
 *
 * PROCESSED wins over both fields: finalize_results writes the 100 and the
 * status in two separate calls, so a read landing between them would otherwise
 * park a finished document at 85 for the rest of the poll interval.
 */
export const progressPercent = (document) => {
  const { status, progress, current_step: currentStep } = document ?? {};

  if (status === PROCESSED_STATUS) return COMPLETE_PERCENT;
  if (isUsableNumber(progress) && progress > 0) return clampPercent(progress);

  const milestone = PIPELINE_MILESTONES[currentStep];
  return isUsableNumber(milestone) ? clampPercent(milestone) : FLOOR_PERCENT;
};

/**
 * i18n key for the line under the bar.
 *
 * `current_step` names the step that FINISHED, so each one maps to the work
 * that starts next: that is what the parent is waiting on while they read it.
 * Redaction and the delete-the-original step that follows it are one line,
 * because 20 and 22 are two percent apart and "removing your personal
 * information" describes both.
 *
 * Every branch returns a real key. An unrecognized step is a step the backend
 * added after this file, and t() renders a miss as the raw dotted key, so the
 * default has to be wording rather than nothing.
 */
export const processingStepKey = (document) => {
  const { status, current_step: currentStep } = document ?? {};

  if (status === PROCESSED_STATUS) return 'summary.processing.step.finishing';

  switch (currentStep) {
    case undefined:
    case null:
    case '':
    case 'initializing':
    case 'start':
      return 'summary.processing.step.reading';
    case 'ocr_complete':
    case 'pii_redaction_complete':
      return 'summary.processing.step.protecting';
    case 'cleanup_complete':
      return 'summary.processing.step.summarizing';
    case 'analysis_complete':
    case 'translation_requested':
      return 'summary.processing.step.translating';
    case 'translation_complete':
    case 'completed':
      return 'summary.processing.step.finishing';
    default:
      return 'summary.processing.step.working';
  }
};

/**
 * Whether a fetched payload carries progress the screen has not drawn yet.
 *
 * useDocumentFetch keeps the document in state only when the status or
 * createdAt changed, which is true of neither field for the whole of a run:
 * every milestone between 5 and 85 arrives while the status is still
 * PROCESSING, so the bar never moved. This is the third thing that counts as
 * news about a document.
 */
export const hasProgressChanged = (previous, next) =>
  progressPercent(previous) !== progressPercent(next) ||
  (previous?.current_step ?? null) !== (next?.current_step ?? null);

/**
 * The milestone the run is heading for, as a percentage.
 *
 * Read from the CONFIRMED percentage rather than from `current_step`, so a
 * step this file has never heard of still gets a sane ceiling: whichever
 * milestone is next above where the document already is.
 */
export const nextMilestonePercent = (document) => {
  const confirmed = progressPercent(document);
  const ahead = MILESTONE_ORDER
    .map((step) => PIPELINE_MILESTONES[step])
    .filter((milestone) => milestone > confirmed);

  return ahead.length ? Math.min(...ahead) : COMPLETE_PERCENT;
};

/**
 * Everything the bar needs, derived from the payload in one place.
 *
 * `anchorMs` is the document's own `updatedAt`, which the documents endpoint
 * normalizes to epoch seconds and which every pipeline writer refreshes -- so
 * it is when the CONFIRMED milestone was recorded, and it survives the parent
 * leaving the page and coming back. null when the payload has no timestamp,
 * which turns easing off rather than guessing a start time.
 */
export const processingProgressState = (document) => {
  const { updatedAt, current_step: currentStep } = document ?? {};
  const anchorSeconds = typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0
    ? updatedAt
    : null;

  return {
    confirmedPercent: progressPercent(document),
    ceilingPercent: nextMilestonePercent(document),
    anchorMs: anchorSeconds === null ? null : anchorSeconds * 1000,
    timeConstantMs: STEP_TIME_CONSTANT_MS[currentStep] ?? DEFAULT_TIME_CONSTANT_MS,
  };
};

/**
 * What to actually draw, at wall-clock `nowMs`.
 *
 * Eases from the confirmed milestone toward -- never to -- the next one. The
 * three ways this could lie are all closed here rather than by the caller:
 *
 *  - a browser clock BEHIND the server reads as negative elapsed time, which
 *    clamps to the confirmed value. The bar is honest and still.
 *  - a browser clock AHEAD, by a minute or by a decade, reads as a large
 *    elapsed time, and the ease asymptotes at the ceiling. Unbounded input,
 *    bounded output.
 *  - a missing anchor turns easing off entirely.
 *
 * Pure: the clock is a parameter, so every case above is a test rather than a
 * thing to reason about.
 */
export const displayPercent = (state, nowMs) => {
  const { confirmedPercent, ceilingPercent, anchorMs, timeConstantMs } = state ?? {};

  if (!Number.isFinite(confirmedPercent)) return FLOOR_PERCENT;
  if (anchorMs === null || anchorMs === undefined) return confirmedPercent;
  if (!Number.isFinite(nowMs) || !(timeConstantMs > 0)) return confirmedPercent;

  const gap = ceilingPercent - confirmedPercent;
  if (gap <= 0) return confirmedPercent;

  const elapsedMs = nowMs - anchorMs;
  if (!(elapsedMs > 0)) return confirmedPercent;

  const reach = gap * CREEP_CEILING * EASE(elapsedMs, timeConstantMs);
  // Floored, never rounded: rounding could put the bar ON the next milestone
  // at the top of the ceiling, which is the one thing it must not claim.
  return Math.min(confirmedPercent + Math.floor(reach), confirmedPercent + Math.floor(gap * CREEP_CEILING));
};
