import { useCallback, useEffect, useRef } from 'react';
import { SurveyClosedError } from '../../common/api-client/profile-client';
import type { SurveySave } from '../../common/types';

/** How long after the last answer the open part is saved. */
export const AUTOSAVE_MS = 1_500;

interface Autosave {
  /** The parent changed an answer: save it shortly, and on leaving. */
  changed: () => void;
  /** A save of everything on screen was just sent: nothing is waiting. */
  saved: () => void;
}

interface Options {
  /** Only a part of the survey has answers to keep; the invite and thank-you do not. */
  isPart: boolean;
  /** The saves that keep what is on screen, built when they are sent. */
  saves: () => SurveySave[];
  write: (save: SurveySave) => Promise<unknown>;
  onClosed: () => void;
}

/**
 * Keeps the answers on an open part without waiting for "Next".
 *
 * The bottom nav and the child switcher are route changes, so leaving by them
 * unmounts the survey, and answers that lived only in its state were lost: the
 * parent came back to the right part with it blank. Now a change is saved a
 * moment after the last one, and anything still unsaved is saved on leaving.
 * A failed save is kept as unsaved, to go with the next one; "Next" reports
 * its own failures on screen.
 */
export function useSurveyAutosave(options: Options): Autosave {
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const { isPart, saves, write, onClosed } = latest.current;
    if (!dirty.current || !isPart) return;
    dirty.current = false;
    for (const save of saves()) {
      write(save).catch((error) => {
        if (error instanceof SurveyClosedError) {
          onClosed();
          return;
        }
        dirty.current = true;
      });
    }
  }, []);

  const changed = useCallback(() => {
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  }, [flush]);

  const saved = useCallback(() => {
    dirty.current = false;
    clearTimeout(timer.current);
  }, []);

  // Leaving the page, or this child for another (the flow is keyed by child).
  useEffect(() => flush, [flush]);

  return { changed, saved };
}
