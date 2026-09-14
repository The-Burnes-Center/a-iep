import React from 'react';
import { useLanguage } from '../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import Breadcrumbs, { Crumb } from './Breadcrumbs';
import LanguageDropdown from './LanguageDropdown';
import './OnboardingChrome.css';

interface OnboardingTopBarProps {
  /**
   * Where this screen sits: the step before it, then itself. Two crumbs on
   * every screen but the first, which has only itself because the entry
   * behind it is the sign-in card.
   *
   * Named by the screen rather than read off the history stack, which is what
   * the BACK pill this replaces had to do. A stack cannot say what the
   * previous step is CALLED, and it was wrong whenever it disagreed with the
   * flow: a parent who signed in and landed here on a replace had an entry
   * behind them, and it was the login form.
   */
  trail?: Crumb[];
  /**
   * Whether to offer the language selector. Off on the language step, which
   * is itself a full-page language picker: a parent was shown the same
   * choice twice on one screen, once as a dropdown and once as the list of
   * buttons the design asks for.
   */
  showLanguagePicker?: boolean;
}

/**
 * The row every onboarding screen wears under the app's top navigation: the
 * breadcrumb trail on the leading edge and the language selector on the
 * trailing one.
 *
 * The trail replaced a BACK pill. Onboarding was the only part of the app that
 * navigated that way; the account and support screens have always used
 * breadcrumbs, so a parent met one idiom or the other depending which half
 * they were in. Breadcrumbs also say where the link goes, which "BACK" never
 * did, and they answer "where am I in this flow" on screens that have no
 * heading (the language step is a lede and a list of buttons).
 *
 * OnboardingChrome.css is imported here rather than by each screen: every one
 * of them renders this component, so the stylesheet that carries the
 * `.onboarding-*` classes travels with it.
 */
export default function OnboardingTopBar(
  { trail = [], showLanguagePicker = true }: OnboardingTopBarProps = {},
) {
  const { language, setLanguage, enabledLanguages } = useLanguage();

  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  return (
    <div className="onboarding-topbar">
      <Breadcrumbs trail={trail} />
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
