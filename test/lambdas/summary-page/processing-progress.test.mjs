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
  hasProgressChanged,
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
    // 70 is translation-request-handler's IN_FLIGHT_PROGRESS, for a
    // translation a parent asked for; 100 is finalize_results.
    expect(PIPELINE_MILESTONES.translation_requested).toBe(70);
    expect(PIPELINE_MILESTONES.completed).toBe(100);
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
      .toBe(65);
    expect(progressPercent({ status: 'PROCESSING', progress: 0, current_step: 'translation_complete' }))
      .toBe(85);
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
