import React from 'react';
import { Card, Alert } from 'react-bootstrap';
import AIEPSpinner from './AIEPSpinner';
import ParentRightsCarousel, { SlideData } from './ParentRightsCarousel';
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
