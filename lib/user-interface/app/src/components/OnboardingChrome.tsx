import React from 'react';
import { Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';
import { useLanguage } from '../common/language-context';
import { useCanGoBack } from '../common/app-history';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import LanguageDropdown from './LanguageDropdown';
import './OnboardingChrome.css';

interface OnboardingTopBarProps {
  /**
   * Where Back goes on a screen that knows its own previous step, whether or
   * not one is in the history stack. The consent form is the case: it is
   * reachable as a first navigation, and the step before it is always the
   * language picker (never '/', which is the logged-out marketing page).
   * Left out, the history rule below decides.
   */
  backTo?: string;
  /**
   * Whether to offer the language selector. Off on the language step, which
   * is itself a full-page language picker: a parent was shown the same
   * choice twice on one screen, once as a dropdown and once as the list of
   * buttons the design asks for.
   */
  showLanguagePicker?: boolean;
}

/**
 * The row every onboarding screen wears under the app's top navigation: a BACK
 * pill on the leading edge and the language selector on the trailing one.
 *
 * Extracted from ViewAndAddChild, which had the only copy of it while it was
 * the only screen built to the designer's onboarding layout. Six screens now
 * carry the same row, and the Back rule below is the kind of thing that gets
 * copied slightly wrong the fourth time.
 *
 * OnboardingChrome.css is imported here rather than by each screen: every one
 * of them renders this component, so the stylesheet that carries the
 * `.onboarding-*` classes travels with it.
 */
export default function OnboardingTopBar(
  { backTo, showLanguagePicker = true }: OnboardingTopBarProps = {},
) {
  const navigate = useNavigate();
  const hasSomethingBehind = useCanGoBack();
  const { t, language, setLanguage, enabledLanguages } = useLanguage();

  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  // A screen that names its own previous step can always offer Back. Otherwise
  // it depends on there being something of ours behind this one: a parent who
  // opened the URL directly, or who landed here on the first navigation after
  // signing in, gets no Back button rather than one that leaves the app.
  const canGoBack = Boolean(backTo) || hasSomethingBehind;

  return (
    <div className="onboarding-topbar">
      {canGoBack && (
        <Button
          variant="outline-secondary"
          className="aiep-button onboarding-back"
          onClick={() => (backTo ? navigate(backTo) : navigate(-1))}
        >
          <IconArrowLeft size={18} stroke={2} className="arrow-icon" aria-hidden="true" />
          {t('common.back')}
        </Button>
      )}
      {showLanguagePicker && (
        <div className="onboarding-language">
          <LanguageDropdown
            language={language}
            languageOptions={languageOptions}
            onLanguageChange={setLanguage}
            variant="secondary"
          />
        </div>
      )}
    </div>
  );
}
