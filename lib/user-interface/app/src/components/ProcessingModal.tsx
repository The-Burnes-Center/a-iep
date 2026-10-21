import React from 'react';
import { Card, Alert } from 'react-bootstrap';
import AIEPSpinner from './AIEPSpinner';
import ParentRightsCarousel, { SlideData } from './ParentRightsCarousel';
import PollingStalledNotice from './PollingStalledNotice';
import ProcessingStatusBar from './ProcessingStatusBar';
import './ProcessingModal.css';

interface ProcessingModalProps {
  error: string | null;
  tutorialPhase: 'parent-rights' | 'completed';
  t: (key: string) => string;
  parentRightsSlideData: SlideData[];
  headerPinkTitle: string;
  headerGreenTitle: string;
  /** e.g. "{number}. {title}", localized by the page that owns t(). */
  rightsIndicatorTemplate: string;
  sectionHint: string;
  /**
   * The document's progress fields, passed through to ProcessingStatusBar,
   * which derives everything it draws from them. See
   * pages/utils/processing-progress.mjs.
   */
  progressDocument: {
    status?: string;
    progress?: number;
    current_step?: string;
    updatedAt?: number;
  };
  /** Already-translated name of the step in flight, e.g. "Reading your document". */
  progressStepLabel: string;
  /** True once polling has stopped on a document that stayed in processing. */
  pollingStopped: boolean;
  /** Restarts polling and asks for a fresh read of the document. */
  onCheckAgain: () => void;
  /**
   * A replacement: the parent already has a readable IEP behind this screen.
   * Offers it, so the wait (and the rights carousel) is the default without
   * holding the current summary hostage.
   */
  onViewCurrent?: () => void;
  viewCurrentLabel?: string;
}

const ProcessingModal: React.FC<ProcessingModalProps> = ({
  error,
  tutorialPhase,
  t,
  parentRightsSlideData,
  headerPinkTitle,
  headerGreenTitle,
  rightsIndicatorTemplate,
  sectionHint,
  progressDocument,
  progressStepLabel,
  pollingStopped,
  onCheckAgain,
  onViewCurrent,
  viewCurrentLabel,
}) => {
  /**
   * The step in flight and the bar, as one block.
   *
   * Rendered for both phases: the wait is the same wait, and a parent who
   * reaches the final screen should not lose the only thing on screen that
   * says how far along they are.
   */
  const statusBlock = (
    <ProcessingStatusBar document={progressDocument} stepLabel={progressStepLabel} />
  );

  /**
   * The way back to the IEP the parent can already read, during a replacement.
   * Outside the status block on purpose: a stalled wait replaces that block,
   * and the summary behind this screen is still there to read.
   */
  const viewCurrentButton = onViewCurrent && viewCurrentLabel ? (
    <button
      type="button"
      className="btn btn-outline-light processing-view-current"
      onClick={onViewCurrent}
      // Stable E2E hook: the label is localized
      data-testid="replacement-view-current"
    >
      {viewCurrentLabel}
    </button>
  ) : null;

  /**
   * What the screen says once polling has stopped. It replaces the headline,
   * the step and the bar, so nothing on screen still claims to be moving.
   */
  const stalledNotice = (
    <PollingStalledNotice
      message={t('summary.processing.stalled')}
      buttonLabel={t('common.tryAgain')}
      onCheckAgain={onCheckAgain}
    />
  );

  return (
    // Stable E2E hook: "the pipeline is running" is a milestone the document
    // journey must see before it may believe any summary, and every string on
    // this screen is localized.
    <div className="page processing-modal-wrapper" data-testid="processing-modal">
      <div className="processing-modal-overlay"></div>
      <div className="processing-modal-container">
        {/* The announcement. A visually hidden live region, as elsewhere in the
            app: it is always mounted, so the stop is spoken when it happens. The
            visible notice below is not itself a live region, which avoids a
            second reading of the same words. */}
        <div aria-live="polite" aria-atomic="true" className="visually-hidden">
          {pollingStopped ? t('summary.processing.stalled') : ''}
        </div>
        {error && <Alert variant="danger">{error}</Alert>}
        {tutorialPhase === 'parent-rights' ? (
          <Card className="processing-summary-parent-rights-card">
            <Card.Body className="processing-summary-card-body pt-0 pb-0">
              <div className="loading-while-parent-rights">
                {pollingStopped ? stalledNotice : (
                  <>
                    <p className="processing-status-headline">
                      {t('summary.processing.hangTight')}
                    </p>
                    {statusBlock}
                  </>
                )}
                {viewCurrentButton}
              </div>
              <div className="carousel-with-button">
                {/* Loops for as long as this screen is up. Nothing the parent
                    does inside the carousel ends the wait — the document's
                    status does, by unmounting this whole screen. */}
                <ParentRightsCarousel
                  slides={parentRightsSlideData}
                  headerPinkTitle={headerPinkTitle}
                  headerGreenTitle={headerGreenTitle}
                  rightsIndicatorTemplate={rightsIndicatorTemplate}
                  sectionHint={sectionHint}
                />
              </div>
            </Card.Body>
          </Card>
        ) : (
          <Card className="processing-summary-loader-card">
            <Card.Body className="processing-summary-card-body pt-0 pb-0">
              <div className="loading-final-screen">
                {pollingStopped ? stalledNotice : (
                  <>
                    <div className="desktop-only-spinner">
                      {/* The heading below says what the wait is, so the mark
                          here is decoration. Cream, because this card is dark
                          green. */}
                      <AIEPSpinner size="lg" className="aiep-spinner-inverse" />
                    </div>
                    <h3 className="processing-status-headline">
                      {t('summary.processing.hangTight')}
                    </h3>
                    {statusBlock}
                  </>
                )}
                {viewCurrentButton}
              </div>
            </Card.Body>
          </Card>
        )}
      </div>
    </div>
  );
};

export default ProcessingModal;
