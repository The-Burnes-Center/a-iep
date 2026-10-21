import React from 'react';
import { Button } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import type { IEPDocument } from '../../common/types';

interface ReplacementBannerProps {
  /** The newer document behind the one on screen, when there is one. */
  replacement: IEPDocument['replacement'];
  /** The poller has given up (visible-time cap), so the wait is not moving. */
  pollingStopped: boolean;
  t: (key: string) => string;
  onCheckAgain: () => void;
  onUploadAgain: () => void;
  /** Back to the processing screen, while the replacement is running. */
  onWatchProgress?: () => void;
}

/**
 * Tells a parent what is happening to the IEP they just replaced.
 *
 * The old IEP stays on screen until the new one is ready, so without this the
 * parent would upload, land on a summary that looks unchanged, and have no way
 * to know whether anything happened. Two states, nothing when the new one is
 * ready (the page has switched to it by then):
 *
 *  - processing: the new one is on its way; the current one stays;
 *  - failed: the new one could not be processed; the previous one is still
 *    here, with the upload page one tap away.
 *
 * If polling stops at the visible-time cap while the replacement is still
 * running, the same inline stalled pattern the translation wait uses replaces
 * the message. It is inline on purpose: the full-screen modal would hide the
 * summary the parent is reading.
 *
 * The state is carried by an icon AND words, never by colour alone. The live
 * region is always mounted (empty when there is nothing to say) so that content
 * arriving later is announced politely; nothing here takes focus.
 */
const ReplacementBanner: React.FC<ReplacementBannerProps> = ({
  replacement,
  pollingStopped,
  t,
  onCheckAgain,
  onUploadAgain,
  onWatchProgress,
}) => {
  const status = replacement?.status;
  const isFailed = status === 'FAILED';
  const isRunning = status === 'PROCESSING' || status === 'PROCESSING_TRANSLATIONS';

  let content: React.ReactNode = null;
  if (isFailed) {
    content = (
      <div className="replacement-banner replacement-banner-failed" data-testid="replacement-failed">
        <FontAwesomeIcon icon={faTriangleExclamation} aria-hidden="true" className="replacement-banner-icon" />
        <p className="replacement-banner-message">{t('summary.replacement.failed')}</p>
        <Button
          variant="outline-dark"
          className="replacement-banner-button"
          onClick={onUploadAgain}
          data-testid="replacement-upload-again"
        >
          {t('summary.replacement.uploadAgain')}
        </Button>
      </div>
    );
  } else if (isRunning && pollingStopped) {
    content = (
      <div className="replacement-banner replacement-banner-processing" data-testid="replacement-stalled">
        <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" className="replacement-banner-icon" />
        <p className="replacement-banner-message">{t('summary.processing.stalled')}</p>
        <Button
          variant="outline-dark"
          className="replacement-banner-button"
          onClick={onCheckAgain}
          data-testid="replacement-check-again"
        >
          {t('common.tryAgain')}
        </Button>
      </div>
    );
  } else if (isRunning) {
    content = (
      <div className="replacement-banner replacement-banner-processing" data-testid="replacement-processing">
        <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" className="replacement-banner-icon" />
        <p className="replacement-banner-message">{t('summary.replacement.processing')}</p>
        {onWatchProgress && (
          <Button
            variant="outline-dark"
            className="replacement-banner-button"
            onClick={onWatchProgress}
            data-testid="replacement-watch-progress"
          >
            {t('summary.replacement.watchProgress')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="replacement-region">
      {content}
    </div>
  );
};

export default ReplacementBanner;
