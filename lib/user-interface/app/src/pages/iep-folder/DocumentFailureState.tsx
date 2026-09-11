import React from 'react';
import { Button } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import LinkButton from '../../components/LinkButton';
import './DocumentFailureState.css';

export interface DocumentFailureStateProps {
  /**
   * Whether trying again could plausibly succeed, per canRetryFailedDocument
   * in ./document-failure. Passed in as a plain boolean (rather than the
   * document itself) so this component stays a pure presentation of one
   * decision, not a second place that knows the reason taxonomy.
   */
  canRetry: boolean;
  t: (key: string) => string;
  /**
   * Both the primary retry CTA and the neutral fallback below send the
   * parent to the same place (/iep-documents lists the current document
   * and the uploader together) — only the label and emphasis change with
   * canRetry, so one callback covers both.
   */
  onGoToDocuments: () => void;
  onContactSupport: () => void;
}

/**
 * What a parent sees when their document's processing failed closed.
 *
 * Replaces a red Bootstrap Alert whose only instruction was "try uploading it
 * again" — unconditionally, even for a cause (e.g. a password-protected PDF)
 * that fails identically every time. This says plainly that we could not read
 * the document, never blames the parent, and only encourages a retry when
 * canRetry says a retry is not known to be futile.
 */
const DocumentFailureState: React.FC<DocumentFailureStateProps> = ({
  canRetry,
  t,
  onGoToDocuments,
  onContactSupport,
}) => {
  return (
    <div className="document-failure-state" data-testid="document-failure-state">
      <FontAwesomeIcon icon={faCircleInfo} className="document-failure-icon" aria-hidden="true" />
      {/* data-testid stays on the heading, not the wrapper: an E2E journey
          already depends on "summary-failed" existing here to fail fast
          instead of waiting out its budget, carried over from the alert
          this component replaces in IEPSummarizationAndTranslation.tsx. */}
      <h5 className="document-failure-title" data-testid="summary-failed">
        {t('summary.failed.title')}
      </h5>
      <p className="document-failure-message">{t('summary.failed.message')}</p>
      <div className="document-failure-actions">
        {canRetry ? (
          <Button
            variant="primary"
            size="sm"
            onClick={onGoToDocuments}
            // Stable E2E hook: the label is localized
            data-testid="failure-try-different-file"
          >
            {t('summary.failed.tryDifferentFile')}
          </Button>
        ) : (
          <Button
            variant="outline-secondary"
            size="sm"
            onClick={onGoToDocuments}
            // Stable E2E hook: the label is localized
            data-testid="failure-go-to-documents"
          >
            {t('summary.failed.goToDocuments')}
          </Button>
        )}
        <LinkButton
          onClick={onContactSupport}
          disabled={false}
          buttonText={t('summary.failed.contactSupport')}
        />
      </div>
    </div>
  );
};

export default DocumentFailureState;
