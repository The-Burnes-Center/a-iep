import React, { useEffect, useId, useRef, useState } from 'react';
import LinearProgress from '@mui/material/LinearProgress';
import {
  displayPercent,
  processingProgressState,
} from '../pages/utils/processing-progress.mjs';
import type { ProcessingProgressState } from '../pages/utils/processing-progress.mjs';

/**
 * The step in flight and how far along it is.
 *
 * Its own component for one reason: it re-renders every second, and the
 * carousel beside it is fifteen slides. Putting the ticker in ProcessingModal
 * re-rendered the whole deck once a second for a bar 6px tall.
 */
interface ProcessingStatusBarProps {
  /** The document's own progress fields; everything here is derived from them. */
  document: {
    status?: string;
    progress?: number;
    current_step?: string;
    updatedAt?: number;
  };
  /** Already-translated name of the step in flight. */
  stepLabel: string;
}

/**
 * How often the eased value is recomputed.
 *
 * The document is polled every 5s, so this is what fills the gap. 1s is the
 * coarsest tick that still reads as continuous once the CSS transition on the
 * fill smooths between two of them.
 */
const TICK_MS = 1000;

const ProcessingStatusBar: React.FC<ProcessingStatusBarProps> = ({ document: doc, stepLabel }) => {
  // The bar's accessible name is the step line beside it, so a screen reader
  // reads "Writing your plain-language summary, 38 percent" rather than an
  // unnamed progressbar.
  const stepLabelId = useId();

  const state: ProcessingProgressState = processingProgressState(doc);

  /**
   * The anchor this component is easing from, and the milestone it belongs to.
   *
   * The payload's timestamp is preferred, and is what makes the bar survive
   * the parent leaving the page: on a remount the first anchor seen is the
   * milestone's own time, so the bar comes back where it was rather than
   * restarting.
   *
   * But it is only taken ONCE per milestone. Writers exist that refresh
   * `updated_at` without moving `progress` (record_failure, the S3 content
   * migration), and taking a later timestamp for the same milestone would
   * restart the ease and slide the bar BACKWARDS. A bar that goes backwards
   * is worse than a bar that sits still, which is the whole reason this file
   * exists.
   */
  const anchorRef = useRef<{ key: string; anchorMs: number } | null>(null);
  const milestoneKey = `${state.confirmedPercent}:${doc?.current_step ?? ''}`;

  if (anchorRef.current?.key !== milestoneKey) {
    anchorRef.current = {
      key: milestoneKey,
      // Date.now() only when the payload carries no timestamp at all, in
      // which case easing starts from the moment the parent first saw this
      // milestone, which is the best available answer.
      anchorMs: state.anchorMs ?? Date.now(),
    };
  }

  const easedState: ProcessingProgressState = {
    ...state,
    anchorMs: anchorRef.current.anchorMs,
  };

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Nothing left to ease toward: a finished document, or an unknown-length
    // wait with no anchor. No timer at all rather than one that recomputes
    // the same number forever.
    if (easedState.confirmedPercent >= easedState.ceilingPercent) return undefined;

    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [easedState.confirmedPercent, easedState.ceilingPercent]);

  const percent = displayPercent(easedState, now);

  return (
    <>
      <p className="processing-status-step" id={stepLabelId}>
        {stepLabel}
      </p>
      {/* Determinate on purpose. The indeterminate barber-pole this replaced
          ran at the same speed for the two seconds of redaction and the
          ninety of summarizing, which is the single thing parents ask about
          on this screen. */}
      <LinearProgress
        variant="determinate"
        value={percent}
        aria-labelledby={stepLabelId}
        className="processing-status-bar"
        data-testid="processing-progress-bar"
        // The confirmed milestone, beside the eased value the bar draws. A
        // test asserting on aria-valuenow alone cannot tell the two apart,
        // and the difference between them is the whole design.
        data-confirmed-percent={easedState.confirmedPercent}
      />
    </>
  );
};

export default ProcessingStatusBar;
