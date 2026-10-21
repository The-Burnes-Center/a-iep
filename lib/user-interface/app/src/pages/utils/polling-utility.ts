import { MutableRefObject, useRef } from 'react';
import { IEPDocument } from '../../common/types';
import { shouldPollForUpdates } from './translation-flow.mjs';

/** Gap between polls for the first minute a document is processing. */
export const FAST_POLL_INTERVAL_MS = 5000;
/** Gap between polls once a document has been processing for a while. */
export const SLOW_POLL_INTERVAL_MS = 15000;
/** How long the fast cadence lasts, counted from the first poll of a run. */
export const FAST_POLL_WINDOW_MS = 60000;

/**
 * Most visible time one run may poll before it stops and offers a check-again
 * button. Hidden time does not count.
 *
 * Why 15 minutes: real runs take about three minutes, and each pipeline task
 * has its own timeout that fails the document, so a document still processing
 * after this long is unlikely to change while the parent is watching. Polling
 * it forever cost 240 requests an hour per open tab.
 */
export const MAX_VISIBLE_POLL_MS = 15 * 60 * 1000;

/**
 * What outlives each interval restart. The consumer refetches on every poll
 * and restarts the timer when the fetch lands, so the manager itself is rebuilt
 * on every render. The session lives in a ref to carry the start time, the
 * visible-time budget and the parked visibility listener across those rebuilds.
 */
export interface PollingSession {
  /** When this run of polling began. Null while nothing is polling. */
  startedAt: number | null;
  /** The visibility listener, kept so it can be removed. */
  onVisible: (() => void) | null;
  /** Visible polling time banked by the stretches of this run already over. */
  visibleMs: number;
  /** When the visible stretch in progress began. Null while hidden or idle. */
  visibleSince: number | null;
  /** Set when the cap stops the run. Only resetCap() clears it. */
  capReached: boolean;
}

const isDocumentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class PollingManager {
  private pollingIntervalRef: MutableRefObject<NodeJS.Timeout | null>;
  private sessionRef: MutableRefObject<PollingSession>;

  constructor(
    pollingIntervalRef: MutableRefObject<NodeJS.Timeout | null>,
    sessionRef: MutableRefObject<PollingSession>
  ) {
    this.pollingIntervalRef = pollingIntervalRef;
    this.sessionRef = sessionRef;
  }

  // Function to start polling if document is processing.
  //
  // `forcePolling` keeps the same single interval running when the caller knows
  // work is in flight that the fetched status has not caught up with yet (an
  // on-demand translation request); the decision itself lives in
  // ./translation-flow so it can be unit tested.
  //
  // Polling pauses while the tab is hidden. When it becomes visible again the
  // next poll happens at once rather than after the interval, so a parent who
  // comes back to the tab sees the current state straight away.
  //
  // `onCapReached` runs once when the visible-time budget is spent. The run then
  // stays stopped, and further calls here do not poll, until resetCap().
  startPollingIfProcessing = (
    doc: Pick<IEPDocument, 'status'> | null,
    onPoll: () => void,
    forcePolling = false,
    onCapReached: () => void = () => undefined
  ) => {
    this.clearTimers();

    if (!shouldPollForUpdates(doc?.status, forcePolling)) {
      this.endRun();
      return;
    }

    if (this.sessionRef.current.capReached) return;

    if (this.sessionRef.current.startedAt === null) {
      this.sessionRef.current.startedAt = Date.now();
    }
    this.schedule(onPoll, onCapReached);
  };

  // Function to stop polling
  stopPolling = () => {
    this.clearTimers();
  };

  // Clears a stopped-at-cap run so the next startPollingIfProcessing begins a
  // fresh one with its own visible-time budget.
  resetCap = () => {
    this.endRun();
  };

  private schedule(onPoll: () => void, onCapReached: () => void) {
    let paused = isDocumentHidden();

    const onVisibilityChange = () => {
      if (isDocumentHidden()) {
        this.pause();
        paused = true;
        return;
      }
      if (!paused) return;
      paused = false;
      this.detachVisibilityListener();
      this.beginVisibleStretch();
      onPoll();
    };
    this.sessionRef.current.onVisible = onVisibilityChange;
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Hidden at the start: nothing ticks until the listener sees the tab return.
    if (paused) return;

    this.beginVisibleStretch();
    this.pollingIntervalRef.current = setInterval(() => {
      if (this.visibleElapsedMs() >= MAX_VISIBLE_POLL_MS) {
        this.stopAtCap(onCapReached);
        return;
      }
      onPoll();
    }, this.nextIntervalMs());
  }

  private nextIntervalMs(): number {
    const startedAt = this.sessionRef.current.startedAt ?? Date.now();
    return Date.now() - startedAt < FAST_POLL_WINDOW_MS
      ? FAST_POLL_INTERVAL_MS
      : SLOW_POLL_INTERVAL_MS;
  }

  private visibleElapsedMs(): number {
    const { visibleMs, visibleSince } = this.sessionRef.current;
    return visibleMs + (visibleSince === null ? 0 : Date.now() - visibleSince);
  }

  private beginVisibleStretch() {
    const session = this.sessionRef.current;
    if (session.visibleSince === null) session.visibleSince = Date.now();
  }

  private endVisibleStretch() {
    const session = this.sessionRef.current;
    if (session.visibleSince === null) return;
    session.visibleMs += Date.now() - session.visibleSince;
    session.visibleSince = null;
  }

  private pause() {
    this.cancelTick();
    this.endVisibleStretch();
  }

  private stopAtCap(onCapReached: () => void) {
    this.clearTimers();
    this.sessionRef.current.capReached = true;
    onCapReached();
  }

  private cancelTick() {
    if (this.pollingIntervalRef.current) {
      clearInterval(this.pollingIntervalRef.current);
      this.pollingIntervalRef.current = null;
    }
  }

  private detachVisibilityListener() {
    const listener = this.sessionRef.current.onVisible;
    if (listener) {
      document.removeEventListener('visibilitychange', listener);
      this.sessionRef.current.onVisible = null;
    }
  }

  // Ending the stretch here means the gap until the consumer restarts (the
  // refetch in flight) is not counted as visible polling time.
  private clearTimers() {
    this.cancelTick();
    this.detachVisibilityListener();
    this.endVisibleStretch();
  }

  private endRun() {
    const session = this.sessionRef.current;
    session.startedAt = null;
    session.visibleMs = 0;
    session.visibleSince = null;
    session.capReached = false;
  }
}

// Hook to use polling manager
export const usePollingManager = () => {
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sessionRef = useRef<PollingSession>({
    startedAt: null,
    onVisible: null,
    visibleMs: 0,
    visibleSince: null,
    capReached: false,
  });
  const pollingManager = new PollingManager(pollingIntervalRef, sessionRef);

  return {
    pollingManager,
    pollingIntervalRef
  };
};
