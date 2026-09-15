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
 * Every number here comes off the payload. Nothing is interpolated, timed or
 * guessed locally: a bar that invents its own motion is a bar that reaches 90%
 * while the document is still failing, and the parent has no way to tell. The
 * one liberty taken is the floor, below.
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
 * plus `translation_requested` (70) from translation-request-handler's
 * IN_FLIGHT_PROGRESS and `completed` (100) from the finalize_results step.
 *
 * Only used as a fallback when the payload carries a step but no usable
 * number — the number itself is always preferred, so adding a milestone
 * server-side needs no change here to keep the bar honest.
 */
export const PIPELINE_MILESTONES = {
  start: 5,
  ocr_complete: 15,
  pii_redaction_complete: 20,
  cleanup_complete: 22,
  analysis_complete: 65,
  translation_requested: 70,
  translation_complete: 85,
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
