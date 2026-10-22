import React, { useEffect, useMemo, useRef, useState } from 'react';
import GuidedTour, { TourCloseReason } from '../../components/GuidedTour';
import { useLanguage } from '../../common/language-context';
import { getDirForLanguage } from '../../common/direction';
import { useSummaryTourSeen } from '../../common/hooks/use-summary-tour-seen';
import { buildSummaryTourSteps, summaryHeading } from './summary-tour';

interface SummaryTourProps {
  /** A processed summary with content is on screen. */
  ready: boolean;
  /** Something else owns the screen (the glossary drawer). */
  blocked: boolean;
  activeTab: string;
  /** The Support page asked for the tour: show it whether or not it was seen. */
  replayRequested: boolean;
  onReplayConsumed: () => void;
}

/**
 * Offers the tour the first time a parent reads a finished summary, and
 * whenever the Support page sends them back for it.
 *
 * Finishing, skipping and pressing Escape all count as seen. Leaving the page
 * mid-tour does not: the component simply unmounts, and the tour is offered
 * again next visit.
 */
const SummaryTour: React.FC<SummaryTourProps> = ({
  ready,
  blocked,
  activeTab,
  replayRequested,
  onReplayConsumed,
}) => {
  const { t, language } = useLanguage();
  const { isKnown, hasSeen, markSeen } = useSummaryTourSeen();
  const [open, setOpen] = useState(false);
  // One offer per visit: a tour that ended without an answer (aborted) is not
  // pushed on the parent again before they leave and come back.
  const offered = useRef(false);

  // An unknown profile is not "unseen": without it the tour stays quiet.
  const isDue = replayRequested || (isKnown && !hasSeen);

  useEffect(() => {
    if (open || offered.current || !ready || blocked || !isDue) return;
    offered.current = true;
    setOpen(true);
    if (replayRequested) onReplayConsumed();
  }, [open, ready, blocked, isDue, replayRequested, onReplayConsumed]);

  // A processing screen taking over mid-tour ends it without an answer.
  useEffect(() => {
    if (open && !ready) setOpen(false);
  }, [open, ready]);

  const steps = useMemo(() => buildSummaryTourSteps(t, activeTab), [t, activeTab]);

  if (!open) return null;

  const handleClose = (reason: TourCloseReason) => {
    setOpen(false);
    if (reason !== 'aborted') markSeen();
  };

  return (
    <GuidedTour
      steps={steps}
      heading={t('carousel.section.whatYouWillSeeNext')}
      dir={getDirForLanguage(language)}
      lang={language}
      labels={{
        back: t('common.previous'),
        next: t('common.next'),
        done: t('common.done'),
        skip: t('common.skip'),
        stepOf: (number, total) =>
          t('summary.processing.stepOf')
            .replace('{number}', String(number))
            .replace('{total}', String(total)),
      }}
      onClose={handleClose}
      fallbackFocus={summaryHeading}
    />
  );
};

export default SummaryTour;
