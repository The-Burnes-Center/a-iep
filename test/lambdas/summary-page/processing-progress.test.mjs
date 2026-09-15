/**
 * Unit tests for what the processing screen's bar and step line are made of
 * (lib/user-interface/app/src/pages/utils/processing-progress.mjs).
 *
 * Lives under test/lambdas for the same reason translation-flow.test.mjs does:
 * that is the only jest project here that can run a plain-ESM frontend module.
 *
 * The behaviour this pins is the thing a parent stares at for four minutes.
 * Two properties matter more than any single value:
 *
 *  - every number comes off the payload. The bar is allowed to be still; it is
 *    not allowed to invent motion, because a bar that climbs on a timer
 *    reaches 90% on a document that is failing.
 *  - the step line is never a raw key. t() is `translations[key] || key`, so a
 *    key this file returns that no dictionary has renders
 *    "summary.processing.step.whatever" to a parent mid-wait.
 *
 * The milestone table is a copy of the state machine's, so it is checked
 * against iep-processing.asl.json itself rather than against itself.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  FLOOR_PERCENT,
  PIPELINE_MILESTONES,
  displayPercent,
  hasProgressChanged,
  nextMilestonePercent,
  processingProgressState,
  processingStepKey,
  progressPercent,
} from '../../../lib/user-interface/app/src/pages/utils/processing-progress.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));

const ENGLISH = readJson('lib/user-interface/app/src/translations/en.json');

/**
 * Every step the state machine writes, paired with the progress beside it.
 *
 * Walked rather than regexed: the ASL carries each pair twice (once in the
 * ddb-service call's parameters, once in the Pass state that puts it back into
 * the execution's own state), and a regex over the text reads across the gap
 * between one pair and the next.
 */
const stateMachineMilestones = () => {
  const machine = readJson('lib/chatbot-api/state-machines/iep-processing.asl.json');
  const found = {};

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node.current_step === 'string' && typeof node.progress === 'number') {
      found[node.current_step] = node.progress;
    }
    Object.values(node).forEach(walk);
  };

  walk(machine);
  return found;
};

describe('the milestone table', () => {
  test('matches the progress the state machine actually writes', () => {
    const written = stateMachineMilestones();

    // Guards the regex above: a rename in the ASL that stops matching would
    // otherwise leave this suite comparing an empty object to itself.
    expect(Object.keys(written).length).toBeGreaterThanOrEqual(6);

    for (const [step, progress] of Object.entries(written)) {
      expect(PIPELINE_MILESTONES[step]).toBe(progress);
    }
  });

  test('carries the two milestones the state machine does not write', () => {
    // 80 is translation-request-handler's IN_FLIGHT_PROGRESS, for a
    // translation a parent asked for; 100 is finalize_results.
    expect(PIPELINE_MILESTONES.translation_requested).toBe(80);
    expect(PIPELINE_MILESTONES.completed).toBe(100);
  });

  /**
   * The spacing rules, as assertions rather than as a comment nobody reads
   * when they next move a number.
   *
   * Both of these have already been violated once. The milestones are spaced
   * by measured wall clock (see the table in the module), and the two that
   * carry real waiting are `cleanup_complete` -> `analysis_complete`
   * (summarizing, 29s at p50) and `analysis_complete` ->
   * `translation_complete` (translating, 24s). If either gap is narrow, the
   * bar has nowhere to ease through the longest steps in the pipeline, which
   * is what "it looks stuck" means.
   */
  test('the gaps around the two slow steps are wide enough to ease through', () => {
    const gap = (from, to) => PIPELINE_MILESTONES[to] - PIPELINE_MILESTONES[from];

    expect(gap('cleanup_complete', 'analysis_complete')).toBeGreaterThanOrEqual(15);
    expect(gap('analysis_complete', 'translation_complete')).toBeGreaterThanOrEqual(15);
  });

  test('the on-demand entry point sits strictly inside the translate gap', () => {
    // translation-request-handler's IN_FLIGHT_PROGRESS. A parent who asks for
    // one extra language starts here, and the ease runs from here to
    // `translation_complete`. Put it just under the analysis milestone and
    // that ease has a couple of points to cover the whole translate step;
    // put it at or above translation_complete and the bar cannot move at all.
    expect(PIPELINE_MILESTONES.translation_requested)
      .toBeGreaterThan(PIPELINE_MILESTONES.analysis_complete);
    expect(PIPELINE_MILESTONES.translation_requested)
      .toBeLessThan(PIPELINE_MILESTONES.translation_complete);
    expect(
      PIPELINE_MILESTONES.translation_complete - PIPELINE_MILESTONES.translation_requested,
    ).toBeGreaterThanOrEqual(15);
  });

  test('the tail is narrow, because the step it covers is a second and a half', () => {
    // finalize_results is 1.5s at p50. This gap was 15 points, which drew a
    // bar that rested and then leapt; the whole re-spacing was for this.
    expect(100 - PIPELINE_MILESTONES.translation_complete).toBeLessThanOrEqual(5);
  });

  test('never goes backwards through the run', () => {
    const inOrder = [
      'start',
      'ocr_complete',
      'pii_redaction_complete',
      'cleanup_complete',
      'analysis_complete',
      'translation_requested',
      'translation_complete',
      'completed',
    ];

    const values = inOrder.map((step) => PIPELINE_MILESTONES[step]);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('progressPercent', () => {
  test('is the number the pipeline recorded', () => {
    expect(progressPercent({ status: 'PROCESSING', progress: 22, current_step: 'cleanup_complete' }))
      .toBe(22);
    expect(progressPercent({ status: 'PROCESSING', progress: 65, current_step: 'analysis_complete' }))
      .toBe(65);
  });

  test('prefers the number over the step it came with', () => {
    // Only one of these can be right, and the number is the one the backend
    // writes last. A step whose milestone disagrees must not override it.
    expect(progressPercent({ status: 'PROCESSING', progress: 65, current_step: 'start' })).toBe(65);
  });

  test('falls back to the step when there is no usable number', () => {
    expect(progressPercent({ status: 'PROCESSING', current_step: 'ocr_complete' })).toBe(15);
    expect(progressPercent({ status: 'PROCESSING', progress: null, current_step: 'analysis_complete' }))
      .toBe(75);
    expect(progressPercent({ status: 'PROCESSING', progress: 0, current_step: 'translation_complete' }))
      .toBe(97);
  });

  test('never draws an empty bar', () => {
    // A row the upload handler wrote but the pipeline has not picked up comes
    // back as progress 0 / current_step "initializing", and 0% beside "we are
    // processing the document" reads as nothing happening.
    expect(progressPercent({ status: 'PROCESSING', progress: 0, current_step: 'initializing' }))
      .toBe(FLOOR_PERCENT);
    expect(progressPercent({ status: 'PROCESSING' })).toBe(FLOOR_PERCENT);
    expect(progressPercent(undefined)).toBe(FLOOR_PERCENT);
    expect(progressPercent({ status: 'PROCESSING', progress: -40 })).toBe(FLOOR_PERCENT);
  });

  test('a finished document is full, whatever the other two fields say', () => {
    // finalize_results writes the 100 and the PROCESSED status in two separate
    // calls, so a read can land between them.
    expect(progressPercent({ status: 'PROCESSED', progress: 85, current_step: 'translation_complete' }))
      .toBe(100);
  });

  test('is never over 100 and never fractional', () => {
    expect(progressPercent({ status: 'PROCESSING', progress: 140 })).toBe(100);
    expect(progressPercent({ status: 'PROCESSING', progress: 66.6 })).toBe(67);
  });

  test('ignores a progress field that is not a number', () => {
    // DynamoDB numbers arrive as strings through some paths, and "65" > 0 is
    // true in JavaScript, so this is the case where a bar silently breaks.
    expect(progressPercent({ status: 'PROCESSING', progress: '65', current_step: 'ocr_complete' }))
      .toBe(15);
    expect(progressPercent({ status: 'PROCESSING', progress: NaN, current_step: 'ocr_complete' }))
      .toBe(15);
  });
});

describe('processingStepKey', () => {
  test('names the work that starts next, not the step that finished', () => {
    // current_step is the COMPLETED step. A parent reading "reading your
    // document" wants to know what is happening now.
    expect(processingStepKey({ status: 'PROCESSING', current_step: 'cleanup_complete' }))
      .toBe('summary.processing.step.summarizing');
    expect(processingStepKey({ status: 'PROCESSING', current_step: 'analysis_complete' }))
      .toBe('summary.processing.step.translating');
  });

  test('reads the document before any step has been recorded', () => {
    for (const current_step of [undefined, null, '', 'initializing', 'start']) {
      expect(processingStepKey({ status: 'PROCESSING', current_step }))
        .toBe('summary.processing.step.reading');
    }
    expect(processingStepKey(undefined)).toBe('summary.processing.step.reading');
  });

  test('redaction and deleting the original are one line', () => {
    // 20 and 22 are two percent apart; splitting them would flash a line the
    // parent cannot finish reading.
    expect(processingStepKey({ status: 'PROCESSING', current_step: 'ocr_complete' }))
      .toBe('summary.processing.step.protecting');
    expect(processingStepKey({ status: 'PROCESSING', current_step: 'pii_redaction_complete' }))
      .toBe('summary.processing.step.protecting');
  });

  test('an on-demand translation says it is translating', () => {
    expect(processingStepKey({ status: 'PROCESSING_TRANSLATIONS', current_step: 'translation_requested' }))
      .toBe('summary.processing.step.translating');
  });

  test('a step this file has never heard of still gets wording', () => {
    expect(processingStepKey({ status: 'PROCESSING', current_step: 'some_future_step' }))
      .toBe('summary.processing.step.working');
  });

  test('every key it can return exists in the English dictionary', () => {
    const steps = [
      undefined, null, '', 'initializing', 'start', 'ocr_complete',
      'pii_redaction_complete', 'cleanup_complete', 'analysis_complete',
      'translation_requested', 'translation_complete', 'completed',
      'a_step_nobody_wrote',
    ];

    const keys = new Set([
      ...steps.map((current_step) => processingStepKey({ status: 'PROCESSING', current_step })),
      processingStepKey({ status: 'PROCESSED' }),
    ]);

    // Six lines, not five: the fallback is one of them and is the easiest to
    // forget to translate.
    expect(keys.size).toBe(6);
    for (const key of keys) {
      expect(typeof ENGLISH[key]).toBe('string');
      expect(ENGLISH[key]).not.toBe('');
    }
  });
});

describe('hasProgressChanged', () => {
  test('a milestone inside one status counts as news', () => {
    // The whole point. useDocumentFetch kept the payload only when the status
    // or createdAt moved, and neither does between 5% and 85%, so every
    // milestone of a run was thrown away and the bar never advanced.
    const before = { status: 'PROCESSING', progress: 22, current_step: 'cleanup_complete' };
    const after = { status: 'PROCESSING', progress: 65, current_step: 'analysis_complete' };

    expect(hasProgressChanged(before, after)).toBe(true);
  });

  test('a step that moves without the number counts too', () => {
    expect(hasProgressChanged(
      { status: 'PROCESSING', progress: 20, current_step: 'pii_redaction_complete' },
      { status: 'PROCESSING', progress: 20, current_step: 'cleanup_complete' },
    )).toBe(true);
  });

  test('an identical re-read is not news', () => {
    // Polling every 5 seconds through a four-minute step means most reads say
    // nothing new, and each one that "changed" is a re-render of the deck.
    const same = { status: 'PROCESSING', progress: 22, current_step: 'cleanup_complete' };

    expect(hasProgressChanged(same, { ...same })).toBe(false);
  });

  test('is not confused by the first read, when there is no previous', () => {
    expect(hasProgressChanged(null, { status: 'PROCESSING', progress: 15, current_step: 'ocr_complete' }))
      .toBe(true);
    expect(hasProgressChanged(undefined, undefined)).toBe(false);
  });
});

/**
 * The easing between milestones.
 *
 * `progressPercent` above is the honest number and the bar's floor. This is
 * the motion laid over it, so the bar is never still through the ninety
 * seconds of summarizing. The hard rule, and the first two tests, is that it
 * approaches the next milestone and never reaches it: only the server saying
 * `analysis_complete` may draw a bar at 65.
 */
describe('easing between milestones', () => {
  const SUMMARIZING = { status: 'PROCESSING', progress: 22, current_step: 'cleanup_complete' };
  /** Epoch seconds, as the documents endpoint normalizes updatedAt. */
  const ANCHOR_SECONDS = 1789504200;
  const ANCHOR_MS = ANCHOR_SECONDS * 1000;

  const after = (document, seconds) =>
    displayPercent(
      processingProgressState({ ...document, updatedAt: ANCHOR_SECONDS }),
      ANCHOR_MS + seconds * 1000,
    );

  test('never reaches the next milestone, however long the step runs', () => {
    // The constraint the whole mechanism rests on. An hour is already 75x the
    // measured p90 of this step; a day is a document nothing is coming back
    // for.
    for (const seconds of [0, 1, 10, 50, 91, 300, 3600, 86_400, 86_400 * 365]) {
      const drawn = after(SUMMARIZING, seconds);
      expect(drawn).toBeLessThan(PIPELINE_MILESTONES.analysis_complete);
      expect(drawn).toBeGreaterThanOrEqual(PIPELINE_MILESTONES.cleanup_complete);
    }
  });

  test('never reaches the next milestone from ANY milestone', () => {
    // Including the short steps, where the gap is 2 points and rounding up
    // by one would put the bar on a milestone the server has not confirmed.
    const steps = [
      'initializing', 'start', 'ocr_complete', 'pii_redaction_complete',
      'cleanup_complete', 'analysis_complete', 'translation_requested',
      'translation_complete', 'a_step_nobody_wrote',
    ];

    for (const current_step of steps) {
      const document = { status: 'PROCESSING', current_step };
      const ceiling = nextMilestonePercent(document);
      for (const seconds of [0, 1, 5, 60, 600, 86_400]) {
        expect(after(document, seconds)).toBeLessThan(ceiling);
      }
    }
  });

  test('moves, and keeps moving, through the longest step there is', () => {
    // The complaint this answers: half a minute at 22% reads as stuck.
    const atTenSeconds = after(SUMMARIZING, 10);
    const atTheMedian = after(SUMMARIZING, 29);
    const atP90 = after(SUMMARIZING, 47);

    expect(atTenSeconds).toBeGreaterThan(22);
    expect(atTheMedian).toBeGreaterThan(atTenSeconds);
    expect(atP90).toBeGreaterThan(atTheMedian);
  });

  test('decelerates, so the remaining distance always looks like there is some', () => {
    const firstTenSeconds = after(SUMMARIZING, 10) - after(SUMMARIZING, 0);
    const laterTenSeconds = after(SUMMARIZING, 110) - after(SUMMARIZING, 100);

    expect(laterTenSeconds).toBeLessThan(firstTenSeconds);
  });

  test('is monotonic in elapsed time', () => {
    // A bar that goes backwards is worse than a bar that sits still.
    let previous = -1;
    for (let seconds = 0; seconds <= 600; seconds += 1) {
      const drawn = after(SUMMARIZING, seconds);
      expect(drawn).toBeGreaterThanOrEqual(previous);
      previous = drawn;
    }
  });

  test('the real milestone landing is a jump FORWARD, never back', () => {
    // Where the two halves meet: whatever easing had reached, confirming the
    // next milestone must be an increase.
    const easedToTheLimit = after(SUMMARIZING, 86_400);
    const confirmed = progressPercent({
      status: 'PROCESSING',
      progress: PIPELINE_MILESTONES.analysis_complete,
      current_step: 'analysis_complete',
    });

    expect(confirmed).toBeGreaterThan(easedToTheLimit);
  });

  describe('the clock', () => {
    test('a browser clock behind the server draws the confirmed value, not less', () => {
      // Negative elapsed time. Clamps rather than easing backwards out of the
      // milestone the server has already confirmed.
      expect(after(SUMMARIZING, -30)).toBe(22);
      expect(after(SUMMARIZING, -86_400)).toBe(22);
    });

    test('a browser clock far ahead is bounded by the ceiling, not by the clock', () => {
      // Unbounded input, bounded output: this is why the ceiling is a hard
      // cap rather than a target the ease is scaled to hit.
      expect(after(SUMMARIZING, 86_400 * 3650))
        .toBeLessThan(PIPELINE_MILESTONES.analysis_complete);
    });

    test('a document with no timestamp does not ease at all', () => {
      // Rather than inventing a start time inside a pure function. The
      // component supplies one from when the parent first saw the milestone.
      const state = processingProgressState(SUMMARIZING);

      expect(state.anchorMs).toBeNull();
      expect(displayPercent(state, ANCHOR_MS + 600_000)).toBe(22);
    });

    test('a nonsense timestamp does not ease either', () => {
      for (const updatedAt of ['', '2026-09-15T20:30:00', 0, -1, NaN, null, undefined]) {
        expect(processingProgressState({ ...SUMMARIZING, updatedAt }).anchorMs).toBeNull();
      }
    });
  });

  test('a finished document is 100 and stays there', () => {
    const done = { status: 'PROCESSED', progress: 100, current_step: 'completed', updatedAt: ANCHOR_SECONDS };
    const state = processingProgressState(done);

    expect(state.confirmedPercent).toBe(100);
    expect(state.ceilingPercent).toBe(100);
    expect(displayPercent(state, ANCHOR_MS + 600_000)).toBe(100);
  });

  test('the pacing comes from the step in flight, not from one constant', () => {
    // Redaction is two seconds and summarizing is half a minute. One shared
    // constant would make the bar crawl through the short steps and stall in
    // the long ones, which is what the measured table is for.
    const redacting = processingProgressState({ status: 'PROCESSING', current_step: 'ocr_complete' });
    const summarizing = processingProgressState(SUMMARIZING);

    expect(redacting.timeConstantMs).toBeLessThan(summarizing.timeConstantMs);
  });

  test('the two long steps are paced as the long steps', () => {
    // Summarizing (p50 29s) and translating (p50 24s) are where all the
    // waiting is; everything else is under 5s. A constant that drifted short
    // on either would put the bar back at its ceiling, doing nothing, which
    // is the exact failure this file exists to prevent.
    const constantFor = (step) =>
      processingProgressState({ status: 'PROCESSING', current_step: step }).timeConstantMs;

    for (const slow of ['cleanup_complete', 'analysis_complete', 'translation_requested']) {
      expect(constantFor(slow)).toBeGreaterThanOrEqual(30_000);
    }
    for (const quick of ['ocr_complete', 'pii_redaction_complete', 'translation_complete']) {
      expect(constantFor(quick)).toBeLessThan(10_000);
    }
  });

  test('at the typical duration the bar has moved a lot, and is still moving', () => {
    // The acceptance test for the pacing, stated the way a parent would:
    // by the time a normal document finishes summarizing, has the bar done
    // something visible, and does it still have somewhere to go?
    // Pooled p50 of the summarizing step across prod and staging.
    const P50_SECONDS = 29;
    const atTypical = after(SUMMARIZING, P50_SECONDS);

    expect(atTypical - 22).toBeGreaterThan(10);
    expect(after(SUMMARIZING, P50_SECONDS * 2)).toBeGreaterThan(atTypical);
    expect(atTypical).toBeLessThan(65);
  });

  test('a step this file has never heard of still eases, and still stops short', () => {
    const unknown = { status: 'PROCESSING', progress: 30, current_step: 'some_future_step' };

    // 30% confirmed: the next milestone above it is analysis_complete.
    expect(nextMilestonePercent(unknown)).toBe(PIPELINE_MILESTONES.analysis_complete);
    expect(after(unknown, 60)).toBeGreaterThan(30);
    expect(after(unknown, 86_400))
      .toBeLessThan(PIPELINE_MILESTONES.analysis_complete);
  });
});

describe('nextMilestonePercent', () => {
  test('is the next milestone above where the document already is', () => {
    expect(nextMilestonePercent({ status: 'PROCESSING', current_step: 'start' }))
      .toBe(PIPELINE_MILESTONES.ocr_complete);
    expect(nextMilestonePercent({ status: 'PROCESSING', current_step: 'cleanup_complete' }))
      .toBe(PIPELINE_MILESTONES.analysis_complete);
  });

  test('is read off the percentage, so an unknown step still gets a ceiling', () => {
    // Deliberately a percentage that matches no milestone: the ceiling is the
    // next one ABOVE it, whatever the step is called.
    expect(nextMilestonePercent({ status: 'PROCESSING', progress: 66, current_step: 'mystery' }))
      .toBe(PIPELINE_MILESTONES.analysis_complete);
    expect(nextMilestonePercent({ status: 'PROCESSING', progress: 90, current_step: 'mystery' }))
      .toBe(PIPELINE_MILESTONES.translation_complete);
  });

  test('skips translation_requested, which no run passes THROUGH', () => {
    // Caught by reading the curve, not by a test, so here is the test. 80 is
    // where the on-demand add-a-language path starts; treating it as a
    // waypoint capped the translate step at 80 and the bar eased 75 -> 79
    // across 24 seconds of real work.
    expect(PIPELINE_MILESTONES.translation_requested).toBe(80);
    expect(nextMilestonePercent({ status: 'PROCESSING', current_step: 'analysis_complete' }))
      .toBe(PIPELINE_MILESTONES.translation_complete);
    // And from inside the on-demand path itself, the next one is the same.
    expect(nextMilestonePercent({ status: 'PROCESSING_TRANSLATIONS', current_step: 'translation_requested' }))
      .toBe(PIPELINE_MILESTONES.translation_complete);
  });

  test('leaves the translate step room to actually move', () => {
    // The regression this guards: a ceiling only 5 points above the milestone
    // is indistinguishable from no easing at all.
    const translating = { status: 'PROCESSING', current_step: 'analysis_complete' };
    const gap = nextMilestonePercent(translating) - progressPercent(translating);

    expect(gap).toBeGreaterThanOrEqual(15);
  });

  test('is 100 once there is nothing above', () => {
    expect(nextMilestonePercent({ status: 'PROCESSED' })).toBe(100);
    expect(nextMilestonePercent({ status: 'PROCESSING', progress: 99 })).toBe(100);
  });
});
