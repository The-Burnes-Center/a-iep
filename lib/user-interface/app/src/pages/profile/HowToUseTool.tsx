import React from 'react';
import { useNavigate } from 'react-router-dom';
import { firstUploadStep } from '../../common/onboarding-next';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { STEP } from '../../common/breadcrumb-steps';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import '../../components/OnboardingChrome.css';

/**
 * The dedicated screen that walks a parent through what happens to their
 * document, provider by provider. The published privacy policy
 * (/privacy-policy) is still linked from the account area; this is the
 * onboarding answer.
 */
const PRIVACY_SCREEN_ROUTE = '/how-we-protect-your-privacy';

/**
 * Where Continue goes. The pair of screens for a parent who only has paper
 * sits behind pdfHelpScreens; where that is dark there is nothing to ask, so
 * this step leads straight to the upload. The routes stay registered either
 * way, the same as the referral entry point: it is the way in that is gated,
 * not the page.
 */
const NEXT_WITH_PDF_HELP = '/do-you-have-pdf';

/** The three things the tool does, in the order a parent does them. */
const STEP_KEYS = ['howToUse.step1', 'howToUse.step2', 'howToUse.step3'];

export default function HowToUseTool() {
  const navigate = useNavigate();
  const { isFeatureEnabled } = useFeatures();
  const { t } = useLanguage();

  // What comes before this step depends on studentNameGate, the same flag that
  // decides whether the child's name is asked for at all: with it on, consent
  // leads here through that screen, and with it off consent leads straight here.
  return (
    <PageShell
      trail={[
        isFeatureEnabled('studentNameGate') ? STEP.child : STEP.consent,
        STEP.howItWorks,
      ]}
    >
      <PageHero titleId="how-to-use-title" title={t('howToUse.heading')} />

      <section className="page-card">
        {/* An ordered list, so the numbering a sighted parent reads off the
            circles is also what a screen reader announces; the circles
            themselves are decoration. */}
        <ol className="onboarding-steps">
          {STEP_KEYS.map((key, index) => (
            <li className="onboarding-step" key={key}>
              <span className="onboarding-step-number" aria-hidden="true">{index + 1}</span>
              <span className="onboarding-step-label">{t(key)}</span>
            </li>
          ))}
        </ol>

        <Button
          variant="primary"
          fullWidth
          onClick={() => navigate(
            isFeatureEnabled('pdfHelpScreens') ? NEXT_WITH_PDF_HELP : firstUploadStep(isFeatureEnabled))}
          // Stable E2E hook: the label is localized
          data-testid="how-to-use-continue"
        >
          {t('common.continue')}
        </Button>
        <Button
          variant="secondary"
          fullWidth
          onClick={() => navigate(PRIVACY_SCREEN_ROUTE)}
          data-testid="how-to-use-privacy"
        >
          {t('howToUse.button.privacy')}
        </Button>
      </section>
    </PageShell>
  );
}
