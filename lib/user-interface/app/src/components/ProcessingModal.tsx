import React, { useId } from 'react';
import { Card, Alert } from 'react-bootstrap';
import LinearProgress from '@mui/material/LinearProgress';
import AIEPSpinner from './AIEPSpinner';
import ParentRightsCarousel, { SlideData } from './ParentRightsCarousel';
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
   * How full the bar is, 5-100, straight off the document payload. See
   * pages/utils/processing-progress.mjs: the page reads it there so the value
   * survives an unmount, because the document is what knows it and this
   * component holds no state of its own.
   */
  progressPercent: number;
  /** Already-translated name of the step in flight, e.g. "Reading your document". */
  progressStepLabel: string;
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
  progressPercent,
  progressStepLabel,
}) => {
  // The bar's accessible name is the step line beside it, so a screen reader
  // reads "Reading your document, 15 percent" rather than an unnamed
  // progressbar. Generated because the two elements have to agree on an id
  // and nothing else on the page needs to know it.
  const stepLabelId = useId();

  /**
   * "We are processing the document", the step in flight, and the bar, as one
   * block.
   *
   * Rendered for both phases: the wait is the same wait, and a parent who
   * reaches the final screen should not lose the only thing on screen that
   * says how far along they are.
   */
  const statusBlock = (
    <>
      <p className="processing-status-step" id={stepLabelId}>
        {progressStepLabel}
      </p>
      {/* Determinate on purpose. The indeterminate barber-pole this replaced
          ran at the same speed for the ten seconds of OCR and the four
          minutes of summarizing, which is the single thing parents ask about
          on this screen. */}
      <LinearProgress
        variant="determinate"
        value={progressPercent}
        aria-labelledby={stepLabelId}
        className="processing-status-bar"
        data-testid="processing-progress-bar"
      />
    </>
  );

  return (
    // Stable E2E hook: "the pipeline is running" is a milestone the document
    // journey must see before it may believe any summary, and every string on
    // this screen is localized.
    <div className="page processing-modal-wrapper" data-testid="processing-modal">
      <div className="processing-modal-overlay"></div>
      <div className="processing-modal-container">
        {error && <Alert variant="danger">{error}</Alert>}
        {tutorialPhase === 'parent-rights' ? (
          <Card className="processing-summary-parent-rights-card">
            <Card.Body className="processing-summary-card-body pt-0 pb-0">
              <div className="loading-while-parent-rights">
                <p className="processing-status-headline">
                  {t('summary.processing.hangTight')}
                </p>
                {statusBlock}
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
              </div>
            </Card.Body>
          </Card>
        )}
      </div>
    </div>
  );
};

export default ProcessingModal;
