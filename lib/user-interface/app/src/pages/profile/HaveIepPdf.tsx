import React from 'react';
import { useNavigate } from 'react-router-dom';
import { firstUploadStep } from '../../common/onboarding-next';
import { useFeatures } from '../../common/hooks/use-features';
import { IconFileCheck, IconHelpCircle } from '@tabler/icons-react';
import { useLanguage } from '../../common/language-context';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import { STEP } from '../../common/breadcrumb-steps';
import './HaveIepPdf.css';

/**
 * The fork in onboarding: a parent who already has the file goes straight to
 * the upload, and a parent holding a printed IEP gets the screen that explains
 * how to ask the school for a PDF.
 *
 * Each choice is a secondary Button, so both look alike and neither is the
 * "right" answer. The sentence is the parent's own words, so it keeps its
 * casing and wraps: HaveIepPdf.css turns the Button's uppercase condensed
 * style off for these two.
 */
export default function HaveIepPdf() {
  const navigate = useNavigate();
  const { isFeatureEnabled } = useFeatures();
  const { t } = useLanguage();

  return (
    <PageShell trail={[STEP.howItWorks, STEP.yourIep]}>
      <PageHero titleId="have-pdf-title" title={t('havePdf.heading')} />

      <div className="page-card">
        <Button
          variant="secondary"
          fullWidth
          className="have-pdf-choice"
          icon={<IconFileCheck size={32} stroke={1.5} />}
          onClick={() => navigate(firstUploadStep(isFeatureEnabled))}
          // Stable E2E hook: both labels are localized
          data-testid="have-pdf-yes"
        >
          <span className="have-pdf-choice-text">
            <span className="have-pdf-choice-lead">{t('havePdf.yes.lead')}</span>{' '}
            {t('havePdf.yes.detail')}
          </span>
        </Button>

        <Button
          variant="secondary"
          fullWidth
          className="have-pdf-choice"
          icon={<IconHelpCircle size={32} stroke={1.5} />}
          onClick={() => navigate('/how-to-ask-for-pdf')}
          data-testid="have-pdf-no"
        >
          <span className="have-pdf-choice-text">
            <span className="have-pdf-choice-lead">{t('havePdf.no.lead')}</span>{' '}
            {t('havePdf.no.detail')}
          </span>
        </Button>
      </div>
    </PageShell>
  );
}
