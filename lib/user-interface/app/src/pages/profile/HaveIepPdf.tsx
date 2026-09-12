import React from 'react';
import { Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { IconFileCheck, IconHelpCircle } from '@tabler/icons-react';
import { useLanguage } from '../../common/language-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import OnboardingTopBar from '../../components/OnboardingChrome';

/**
 * The fork in onboarding: a parent who already has the file goes straight to
 * the upload, and a parent holding a printed IEP gets the screen that explains
 * how to ask the school for a PDF.
 */
export default function HaveIepPdf() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <>
      <MobileTopNavigation />
      <div className="onboarding-page">
        <OnboardingTopBar />

        <h1 className="onboarding-heading">{t('havePdf.heading')}</h1>

        <div className="onboarding-actions">
          <Button
            variant="outline-secondary"
            className="onboarding-choice"
            onClick={() => navigate('/iep-documents')}
            // Stable E2E hook: both labels are localized
            data-testid="have-pdf-yes"
          >
            <IconFileCheck size={32} stroke={1.5} className="onboarding-choice-icon" aria-hidden="true" />
            <span className="onboarding-choice-text">
              <span className="onboarding-choice-lead">{t('havePdf.yes.lead')}</span>{' '}
              {t('havePdf.yes.detail')}
            </span>
          </Button>

          <Button
            variant="outline-secondary"
            className="onboarding-choice"
            onClick={() => navigate('/how-to-ask-for-pdf')}
            data-testid="have-pdf-no"
          >
            <IconHelpCircle size={32} stroke={1.5} className="onboarding-choice-icon" aria-hidden="true" />
            <span className="onboarding-choice-text">
              <span className="onboarding-choice-lead">{t('havePdf.no.lead')}</span>{' '}
              {t('havePdf.no.detail')}
            </span>
          </Button>
        </div>
      </div>
    </>
  );
}
