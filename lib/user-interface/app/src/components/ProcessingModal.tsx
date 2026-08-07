import React from 'react';
import { Card, Alert } from 'react-bootstrap';
import LinearProgress from '@mui/material/LinearProgress';
import { ClipLoader } from 'react-spinners';
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
}) => {
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
              <div className='loading-while-parent-rights'>
                <p>
                  {t('summary.processing.hangTight')}
                </p>
              </div>
              <LinearProgress color="success" /> 
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
              <div className='loading-final-screen'>
                <div className="desktop-only-spinner">
                  <ClipLoader color="#F5F3EE" size={50} cssOverride={{ borderWidth: '5px' }} />
                </div>
                <h3>
                  {t('summary.processing.hangTight')}
                </h3>
              </div>
              <LinearProgress color="success" /> 
            </Card.Body>
          </Card>
        )}
      </div>
    </div>
  );
};

export default ProcessingModal;

