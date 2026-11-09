import React from 'react';
import { useNavigate } from 'react-router-dom';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useLanguage } from '../../common/language-context';
import { STEP } from '../../common/breadcrumb-steps';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import './HowToAskForPdf.css';

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
    <PageShell trail={[STEP.yourIep, STEP.askForPdf]}>
      <PageHero titleId="how-to-ask-title" title={t('howToAsk.heading')} />

      <section className="page-card">
        <figure className="how-to-ask-video">
          <div className="how-to-ask-video-frame" data-testid="how-to-ask-video">
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
          <figcaption className="how-to-ask-video-caption">
            {t('howToAsk.video.label')}
            {!HOW_TO_ASK_VIDEO && <> {t('howToAsk.video.comingSoon')}</>}
          </figcaption>
        </figure>

        <Button
          variant="primary"
          fullWidth
          onClick={() => navigate('/iep-documents')}
          // Stable E2E hook: the label is localized
          data-testid="how-to-ask-upload"
        >
          {t('howToAsk.button.upload')}
        </Button>
        <Button
          variant="secondary"
          fullWidth
          onClick={() => navigate('/view-resources')}
          data-testid="how-to-ask-resources"
        >
          {t('howToAsk.button.resources')}
        </Button>
      </section>
    </PageShell>
  );
}
