/**
 * The document poller: how often it asks, when it stops asking, and what
 * happens when the tab is hidden. The status rules (which statuses keep polling)
 * are pinned in test/lambdas/summary-page/translation-flow.test.mjs; these tests
 * are about timing.
 */
import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IEPDocument } from '../../common/types';
import {
  FAST_POLL_INTERVAL_MS,
  FAST_POLL_WINDOW_MS,
  PollingManager,
  PollingSession,
  SLOW_POLL_INTERVAL_MS,
} from './polling-utility';

const PROCESSING: Pick<IEPDocument, 'status'> = { status: 'PROCESSING' };
const PROCESSED: Pick<IEPDocument, 'status'> = { status: 'PROCESSED' };

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
};

const setup = () => {
  const intervalRef = { current: null } as MutableRefObject<NodeJS.Timeout | null>;
  const sessionRef = {
    current: { startedAt: null, onVisible: null },
  } as MutableRefObject<PollingSession>;
  const manager = new PollingManager(intervalRef, sessionRef);
  return { manager, intervalRef, sessionRef };
};

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('PollingManager', () => {
  test('polls every 5 seconds while the document is processing', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    vi.advanceTimersByTime(FAST_POLL_INTERVAL_MS * 3);

    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  test('does not poll a document that is not processing', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSED, onPoll);
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS);

    expect(onPoll).not.toHaveBeenCalled();
  });

  test('hidden pauses polling: no poll fires while the tab is in the background', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    setVisibility('hidden');
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS);

    expect(onPoll).not.toHaveBeenCalled();
  });

  test('starting a poll while already hidden waits for the tab to return', () => {
    setVisibility('hidden');
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS);

    expect(onPoll).not.toHaveBeenCalled();
  });

  test('visible resumes with an immediate poll, not after the interval', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    setVisibility('hidden');
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS);
    expect(onPoll).not.toHaveBeenCalled();

    setVisibility('visible');

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test('the resume poll is one-shot: a later visibility change does not poll again on its own', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    setVisibility('hidden');
    vi.advanceTimersByTime(FAST_POLL_INTERVAL_MS);
    setVisibility('visible');
    expect(onPoll).toHaveBeenCalledTimes(1);

    // Visible again with nothing restarted: the listener was removed on resume,
    // so this must not poll a second time.
    setVisibility('hidden');
    setVisibility('visible');

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test('polling continues after a resume once the consumer restarts the timer', () => {
    const { manager } = setup();
    const onPoll = vi.fn((): void => {
      manager.startPollingIfProcessing(PROCESSING, onPoll);
    });

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    setVisibility('hidden');
    vi.advanceTimersByTime(FAST_POLL_INTERVAL_MS);
    setVisibility('visible');
    expect(onPoll).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FAST_POLL_INTERVAL_MS * 2);

    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  test('backs off from 5 seconds to 15 seconds after the first minute', () => {
    const { manager } = setup();
    const pollTimes: number[] = [];
    // The consumer restarts the timer after each fetch lands. Mirror that so the
    // cadence is measured the way the app experiences it.
    const onPoll = (): void => {
      pollTimes.push(Date.now());
      manager.startPollingIfProcessing(PROCESSING, onPoll);
    };

    const started = Date.now();
    manager.startPollingIfProcessing(PROCESSING, onPoll);
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS + SLOW_POLL_INTERVAL_MS * 2);

    const gaps = pollTimes.map((time, index) => time - (index === 0 ? started : pollTimes[index - 1]));
    // Twelve 5-second gaps reach the 60-second mark, then the cadence is 15 s.
    expect(gaps.slice(0, 12)).toEqual(Array(12).fill(FAST_POLL_INTERVAL_MS));
    expect(gaps.slice(12)).toEqual([SLOW_POLL_INTERVAL_MS, SLOW_POLL_INTERVAL_MS]);
  });

  test('a new run after the document finishes starts fast again', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS + SLOW_POLL_INTERVAL_MS);
    manager.startPollingIfProcessing(PROCESSED, onPoll);
    onPoll.mockClear();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    vi.advanceTimersByTime(FAST_POLL_INTERVAL_MS);

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test('stopPolling still stops: no poll fires afterwards', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    manager.stopPolling();
    vi.advanceTimersByTime(FAST_POLL_WINDOW_MS);

    expect(onPoll).not.toHaveBeenCalled();
  });

  test('stopPolling while paused also removes the resume listener', () => {
    const { manager } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    setVisibility('hidden');
    // One tick while hidden is what parks the resume listener.
    vi.advanceTimersByTime(FAST_POLL_INTERVAL_MS);
    manager.stopPolling();
    setVisibility('visible');

    expect(onPoll).not.toHaveBeenCalled();
  });

  test('stopPolling keeps the run start time, so a refetch does not reset the backoff', () => {
    const { manager, sessionRef } = setup();
    const onPoll = vi.fn();

    manager.startPollingIfProcessing(PROCESSING, onPoll);
    manager.stopPolling();

    // stopPolling runs on every refetch; the run is still going, so the start
    // time survives it. Only a status that stops polling ends the run.
    expect(sessionRef.current.startedAt).not.toBeNull();
  });
});
