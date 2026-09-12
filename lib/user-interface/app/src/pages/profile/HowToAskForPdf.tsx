import React from 'react';
import { Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useLanguage } from '../../common/language-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import OnboardingTopBar from '../../components/OnboardingChrome';

/**
 * TODO(content): the embed URL for the "how to ask for a PDF IEP" video.
 *
 * Deliberately null rather than a guess: the design shows a thumbnail but not
 * which video it is, and a wrong third-party URL here would put an unrelated
 * video, and whatever that host sets on a parent's device, in front of a
 * family. Set this to the privacy-enhanced embed URL of the real video
 * (youtube-nocookie.com/embed/<id>, or whatever host we settle on) and the
 * frame below renders it instead of the placeholder.
 */
const HOW_TO_ASK_VIDEO: string | null = null;

export default function HowToAskForPdf() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <>
      <MobileTopNavigation />
      <div className="onboarding-page">
        <OnboardingTopBar />

        <h1 className="onboarding-heading">{t('howToAsk.heading')}</h1>

        <figure className="onboarding-video">
          <div className="onboarding-video-frame" data-testid="how-to-ask-video">
            {HOW_TO_ASK_VIDEO ? (
              <iframe
                src={HOW_TO_ASK_VIDEO}
                title={t('howToAsk.video.label')}
                allowFullScreen
              />
            ) : (
              <IconPlayerPlay size={56} stroke={1.5} aria-hidden="true" />
            )}
          </div>
          <figcaption className="onboarding-video-caption">
            {t('howToAsk.video.label')}
            {!HOW_TO_ASK_VIDEO && <> {t('howToAsk.video.comingSoon')}</>}
          </figcaption>
        </figure>

        <div className="onboarding-actions">
          <Button
            variant="primary"
            className="aiep-button onboarding-action"
            onClick={() => navigate('/iep-documents')}
            // Stable E2E hook: the label is localized
            data-testid="how-to-ask-upload"
          >
            {t('howToAsk.button.upload')}
          </Button>
          <Button
            variant="outline-secondary"
            className="aiep-button onboarding-action"
            onClick={() => navigate('/view-resources')}
            data-testid="how-to-ask-resources"
          >
            {t('howToAsk.button.resources')}
          </Button>
        </div>
      </div>
    </>
  );
}
