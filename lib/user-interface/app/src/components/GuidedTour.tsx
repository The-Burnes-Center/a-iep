import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, CardPlacement, boxOf, placeCard, unionBox } from './guided-tour-layout';
import './GuidedTour.css';

/**
 * A coach-mark tour: the page dims, one target is cut out of the dim, and a
 * small card beside it says what the target is for.
 *
 * Built for a parent reading on a phone, in any of the five languages, so the
 * contract is mostly about not getting in the way:
 *
 * - The card is a modal dialog named by the step's title and described by its
 *   text. A new step is a new dialog that takes focus, which is what a screen
 *   reader announces; there is no second live region.
 * - Focus stays in the card (Tab cycles it), Escape closes it, and focus goes
 *   back to where it was.
 * - The dim and the cut-out both swallow pointer input, so a parent cannot
 *   open an accordion or a glossary term by accident while being shown it.
 * - Targets are looked up again on every measure, so it follows the page when
 *   an accordion opens, the window resizes or the language tab changes.
 */

export interface TourStep {
  id: string;
  title: string;
  text: string;
  /** The elements to highlight, looked up fresh each time (the page re-renders under the tour). */
  getTargets: () => Element[];
  /** Run when the step opens, e.g. to expand what the step points at. */
  prepare?: () => void;
}

/** 'aborted' means the tour ended without the parent deciding anything. */
export type TourCloseReason = 'done' | 'skip' | 'escape' | 'aborted';

interface GuidedTourProps {
  steps: TourStep[];
  /** The eyebrow over each step's title. */
  heading: string;
  dir: 'ltr' | 'rtl';
  lang: string;
  labels: {
    back: string;
    next: string;
    done: string;
    skip: string;
    stepOf: (number: number, total: number) => string;
  };
  onClose: (reason: TourCloseReason) => void;
  /** Where focus goes on close when what had it before has gone. */
  fallbackFocus?: () => HTMLElement | null;
}

// Rough card height for the first measure, before the card exists to measure.
const ESTIMATED_CARD_HEIGHT = 220;
// A target needs this much room beside it to be left where it is on screen.
const CARD_ROOM = 240;
// Gap kept between the sticky nav and a target that was scrolled into view.
const SCROLL_TOP_GAP = 12;
// An accordion takes this long to open (Bootstrap's collapse is 350ms).
const EXPAND_SETTLE_MS = 450;

const FOCUSABLE = 'button:not([disabled])';

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const visibleBoxes = (elements: Element[]): Box[] =>
  elements
    .map((element) => boxOf(element.getBoundingClientRect()))
    .filter((box) => box.right > box.left && box.bottom > box.top);

/** Scroll the page just enough that the target is on screen with room for the card. */
function bringIntoView(elements: Element[]): void {
  const box = unionBox(visibleBoxes(elements));
  if (!box || typeof window.scrollBy !== 'function') return;

  const navBottom =
    document.querySelector('.mobile-top-navigation')?.getBoundingClientRect().bottom ?? 0;
  const topEdge = Math.max(navBottom, 0) + SCROLL_TOP_GAP;
  const fitsOnScreen = box.top >= topEdge && box.bottom <= window.innerHeight;
  const roomBelow = window.innerHeight - box.bottom;
  const roomAbove = box.top - topEdge;
  if (fitsOnScreen && (roomBelow >= CARD_ROOM || roomAbove >= CARD_ROOM)) return;

  window.scrollBy({
    top: box.top - topEdge,
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}

const GuidedTour: React.FC<GuidedTourProps> = ({
  steps,
  heading,
  dir,
  lang,
  labels,
  onClose,
  fallbackFocus,
}) => {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [availableIds, setAvailableIds] = useState<string[]>([]);
  const [placement, setPlacement] = useState<CardPlacement | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const currentIdRef = useRef<string | null>(null);
  const lastLayoutRef = useRef('');
  const closingRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const fallbackFocusRef = useRef(fallbackFocus);
  fallbackFocusRef.current = fallbackFocus;

  const finish = useCallback((reason: TourCloseReason) => {
    if (closingRef.current) return;
    closingRef.current = true;
    // Before the card goes: focusing out of it afterwards would land on <body>.
    // closingRef is already set, so the focus guard lets it through.
    if (reason !== 'aborted') {
      const remembered = returnFocusRef.current;
      if (remembered?.isConnected) {
        remembered.focus();
      } else {
        // What had focus is gone (or nothing did): the page's heading, which
        // is not a tab stop, so it needs a tabindex to take focus at all.
        const heading = fallbackFocusRef.current?.();
        if (heading) {
          if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
          heading.focus();
        }
      }
    }
    onCloseRef.current(reason);
  }, []);

  /** Work out which steps have a target, which one is showing, and where the card goes. */
  const measure = useCallback(() => {
    const resolved = stepsRef.current
      .map((step) => ({ step, elements: step.getTargets().filter((el) => el.isConnected) }))
      .filter((entry) => entry.elements.length > 0);

    if (resolved.length === 0) {
      finish('aborted');
      return;
    }

    const ids = resolved.map((entry) => entry.step.id);
    let id = currentIdRef.current;
    if (id === null) {
      id = ids[0];
    } else if (!ids.includes(id)) {
      // The step's target went away (the language tab changed under the tour):
      // carry on from the next one that is still there.
      const order = stepsRef.current.map((step) => step.id);
      const later = ids.find((candidate) => order.indexOf(candidate) > order.indexOf(id as string));
      id = later ?? ids[ids.length - 1];
    }
    currentIdRef.current = id;

    const current = resolved.find((entry) => entry.step.id === id);
    const target = current ? unionBox(visibleBoxes(current.elements)) : null;
    const next = placeCard({
      target,
      cardHeight: cardRef.current?.getBoundingClientRect().height ?? ESTIMATED_CARD_HEIGHT,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rtl: dir === 'rtl',
    });

    // Only a real change re-renders, or measuring after every render would never settle.
    const signature = JSON.stringify([id, ids, next]);
    if (signature === lastLayoutRef.current) return;
    lastLayoutRef.current = signature;
    setCurrentId(id);
    setAvailableIds(ids);
    setPlacement(next);
  }, [dir, finish]);

  // Remember where focus was, once, before the card takes it.
  useLayoutEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);

  // The card's own height is only known once it is on screen, and changes with
  // the step's text, so measure after every render. measure() bails when
  // nothing moved.
  useLayoutEffect(() => {
    measure();
  });

  // A step opening: expand what it points at, bring it on screen, take focus.
  useEffect(() => {
    if (!currentId) return;
    const step = stepsRef.current.find((candidate) => candidate.id === currentId);
    if (!step) return;

    step.prepare?.();
    const align = () => {
      bringIntoView(step.getTargets());
      measure();
    };
    align();
    // An accordion is still opening: line up again once it has.
    const settle = step.prepare ? window.setTimeout(align, EXPAND_SETTLE_MS) : undefined;
    return () => window.clearTimeout(settle);
    // measure() is stable for a given direction; only a new step should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [currentId]);

  // Follow the page.
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    window.addEventListener('resize', schedule);
    // Capture: a scrolling container does not bubble its scroll to the window.
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('transitionend', schedule, true);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(document.body);

    // Anything but the tour's own markup changing: a tab swapped, an accordion opened.
    const mutationObserver = new MutationObserver((records) => {
      const host = hostRef.current;
      if (records.every((record) => host?.contains(record.target))) return;
      schedule();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, [measure]);

  // Escape closes, Tab stays inside the card, and focus that escapes comes back.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish('escape');
        return;
      }
      if (event.key !== 'Tab') return;

      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!card.contains(active) || active === card) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const card = cardRef.current;
      if (closingRef.current || !card || card.contains(event.target as Node)) return;
      card.focus({ preventScroll: true });
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [finish]);

  const current = steps.find((step) => step.id === currentId);
  if (!current || !placement) return null;

  const position = Math.max(availableIds.indexOf(current.id), 0);
  const isFirst = position === 0;
  const isLast = position === availableIds.length - 1;
  const titleId = `guided-tour-title-${current.id}`;
  const textId = `guided-tour-text-${current.id}`;

  const goTo = (id: string) => {
    currentIdRef.current = id;
    setCurrentId(id);
  };
  const handleNext = () => (isLast ? finish('done') : goTo(availableIds[position + 1]));
  const handleBack = () => goTo(availableIds[position - 1]);

  const { highlight } = placement;

  return createPortal(
    <div ref={hostRef} className="guided-tour" dir={dir} lang={lang}>
      {/* Swallows every pointer event, the cut-out included. Doing nothing on
          click is deliberate: tapping the dim must not advance or close. */}
      <div className="guided-tour-shield" aria-hidden="true" />
      <div
        className="guided-tour-highlight"
        aria-hidden="true"
        data-testid="guided-tour-highlight"
        data-empty={highlight ? undefined : 'true'}
        style={{
          top: highlight?.top ?? 0,
          left: highlight?.left ?? 0,
          width: highlight ? highlight.right - highlight.left : 0,
          height: highlight ? highlight.bottom - highlight.top : 0,
        }}
      />
      {/* Keyed so each step is a new dialog: it takes focus, and its name and
          description are what gets announced. */}
      <div
        key={current.id}
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        className="guided-tour-card"
        data-testid="guided-tour"
        style={{ top: placement.top, left: placement.left, width: placement.width }}
      >
        <p className="guided-tour-eyebrow">{heading}</p>
        <h2 id={titleId} className="guided-tour-title">
          {current.title}
        </h2>
        <p id={textId} className="guided-tour-text">
          {current.text}
        </p>
        <p className="guided-tour-step" data-testid="guided-tour-step">
          {labels.stepOf(position + 1, availableIds.length)}
        </p>
        <div className="guided-tour-actions">
          {!isFirst && (
            <button type="button" className="guided-tour-button guided-tour-button-secondary" onClick={handleBack}>
              {labels.back}
            </button>
          )}
          <button type="button" className="guided-tour-button guided-tour-button-primary" onClick={handleNext}>
            {isLast ? labels.done : labels.next}
          </button>
          {!isLast && (
            <button
              type="button"
              className="guided-tour-button guided-tour-skip"
              // Stable E2E hook: the label is localized
              data-testid="guided-tour-skip"
              onClick={() => finish('skip')}
            >
              {labels.skip}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default GuidedTour;
