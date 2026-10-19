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
 * What outlives each interval restart. The consumer refetches on every poll
 * and restarts the timer when the fetch lands, so the manager itself is rebuilt
 * on every render. The session lives in a ref to carry the start time and the
 * parked visibility listener across those rebuilds.
 */
export interface PollingSession {
  /** When this run of polling began. Null while nothing is polling. */
  startedAt: number | null;
  /** The listener parked while the tab is hidden, kept so it can be removed. */
  onVisible: (() => void) | null;
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
  startPollingIfProcessing = (
    doc: Pick<IEPDocument, 'status'> | null,
    onPoll: () => void,
    forcePolling = false
  ) => {
    this.clearTimers();

    if (!shouldPollForUpdates(doc?.status, forcePolling)) {
      this.sessionRef.current.startedAt = null;
      return;
    }

    if (this.sessionRef.current.startedAt === null) {
      this.sessionRef.current.startedAt = Date.now();
    }
    this.schedule(onPoll);
  };

  // Function to stop polling
  stopPolling = () => {
    this.clearTimers();
  };

  private schedule(onPoll: () => void) {
    if (isDocumentHidden()) {
      this.pauseUntilVisible(onPoll);
      return;
    }

    this.pollingIntervalRef.current = setInterval(() => {
      if (isDocumentHidden()) {
        this.pauseUntilVisible(onPoll);
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

  private pauseUntilVisible(onPoll: () => void) {
    this.cancelTick();

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      this.detachVisibilityListener();
      onPoll();
    };
    this.sessionRef.current.onVisible = onVisibilityChange;
    document.addEventListener('visibilitychange', onVisibilityChange);
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

  private clearTimers() {
    this.cancelTick();
    this.detachVisibilityListener();
  }
}

// Hook to use polling manager
export const usePollingManager = () => {
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sessionRef = useRef<PollingSession>({ startedAt: null, onVisible: null });
  const pollingManager = new PollingManager(pollingIntervalRef, sessionRef);

  return {
    pollingManager,
    pollingIntervalRef
  };
};
