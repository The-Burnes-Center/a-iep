import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TourStep } from '../../components/GuidedTour';

/**
 * The summary page's guided tour: which strings it reads, what it points at,
 * and how the Support page asks for it again.
 */

/** The navigation state the Support page's "Show me around" sends. */
export const REPLAY_TOUR_STATE_KEY = 'startSummaryTour';

type Translate = (key: string) => string;

const panelFor = (tab: string): Element | null =>
  document.querySelector(`[data-testid="summary-tab-panel-${tab}"]`);

const asList = (...elements: Array<Element | null | undefined>): Element[] =>
  elements.filter((element): element is Element => Boolean(element));

/** The first key insight's page numbers: the first one any insight has. */
const firstPageNumbers = (panel: Element | null): Element | null =>
  panel?.querySelector('.summary-accordion .page-numbers-text') ?? null;

/** Open the insight the page numbers sit in, so there is something on screen to point at. */
const openInsightWithPageNumbers = (tab: string): void => {
  const item = firstPageNumbers(panelFor(tab))?.closest('.accordion-item');
  if (!item || item.querySelector('.accordion-collapse.show')) return;
  item.querySelector<HTMLElement>('.accordion-button')?.click();
};

/**
 * The four steps, in the order a parent meets them. A step whose target is
 * not in this document (no glossary term in the summary, no page numbers) has
 * no elements and is skipped by the tour itself.
 */
export function buildSummaryTourSteps(t: Translate, tab: string): TourStep[] {
  return [
    {
      id: 'summary',
      title: t('rights.slide7.title'),
      text: t('rights.slide7.content'),
      getTargets: () => {
        const panel = panelFor(tab);
        return asList(
          panel?.querySelector('.summary-content') ??
            panel?.querySelector('[data-testid^="summary-text-"]'),
        );
      },
    },
    {
      id: 'insights',
      title: t('rights.slide8.title'),
      text: t('rights.slide8.content'),
      getTargets: () => {
        const panel = panelFor(tab);
        return asList(
          panel?.querySelector('.key-insights-header'),
          panel?.querySelector('.summary-accordion'),
        );
      },
    },
    {
      id: 'glossary',
      title: t('rights.slide9.title'),
      text: t('rights.slide9.content'),
      // The summary's own terms only: an insight's are inside a closed accordion.
      getTargets: () =>
        asList(panelFor(tab)?.querySelector('[data-testid^="summary-text-"] .jargon-term')),
    },
    {
      id: 'pages',
      title: t('rights.slide10.title'),
      text: t('rights.slide10.content'),
      getTargets: () => asList(firstPageNumbers(panelFor(tab))),
      prepare: () => openInsightWithPageNumbers(tab),
    },
  ];
}

/** Where focus goes when closing the tour finds nothing it can return to. */
export const summaryHeading = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid^="summary-tab-panel-"] .summary-header') ??
  document.getElementById('main-content');

/**
 * Whether the Support page asked for the tour, read once on arrival.
 *
 * The request is cleared from the history entry right away, so a reload or a
 * trip through the back button does not start the tour a second time.
 * `consume` is for the page to call once the tour has started or been
 * declined, so remounting the summary does not start it again either.
 */
export function useTourReplayRequest(): { requested: boolean; consume: () => void } {
  const location = useLocation();
  const navigate = useNavigate();
  const [requested, setRequested] = useState(
    () => (location.state as Record<string, unknown> | null)?.[REPLAY_TOUR_STATE_KEY] === true,
  );

  useEffect(() => {
    if (!requested) return;
    navigate(location.pathname + location.search, { replace: true, state: null });
    // Once, on arrival: the state it clears is what this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const consume = useCallback(() => setRequested(false), []);
  return { requested, consume };
}
