import React from 'react';
import { Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../../common/language-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import OnboardingTopBar from '../../components/OnboardingChrome';

/**
 * The dedicated screen that walks a parent through what happens to their
 * document, provider by provider. The published privacy policy
 * (/privacy-policy) is still linked from the account area; this is the
 * onboarding answer.
 */
const PRIVACY_SCREEN_ROUTE = '/how-we-protect-your-privacy';

/** The three things the tool does, in the order a parent does them. */
const STEP_KEYS = ['howToUse.step1', 'howToUse.step2', 'howToUse.step3'];

export default function HowToUseTool() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <>
      <MobileTopNavigation />
      <div className="onboarding-page">
        <OnboardingTopBar />

        <h1 className="onboarding-heading">{t('howToUse.heading')}</h1>

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

        <div className="onboarding-actions">
          <Button
            variant="primary"
            className="aiep-button onboarding-action"
            onClick={() => navigate('/do-you-have-pdf')}
            // Stable E2E hook: the label is localized
            data-testid="how-to-use-continue"
          >
            {t('common.continue')}
          </Button>
          <Button
            variant="outline-secondary"
            className="aiep-button onboarding-action"
            onClick={() => navigate(PRIVACY_SCREEN_ROUTE)}
            data-testid="how-to-use-privacy"
          >
            {t('howToUse.button.privacy')}
          </Button>
        </div>
      </div>
    </>
  );
}
