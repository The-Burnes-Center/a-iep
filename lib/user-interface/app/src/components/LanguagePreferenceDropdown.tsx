import React, { useContext } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { useLanguagePreference } from '../common/hooks/use-language-preference';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import LanguageMenu from './LanguageMenu';
import './LanguagePreferenceDropdown.css';

/**
 * The parent's language preference, as the in-app bar's default picker on
 * every signed-in screen (MobileTopNavigation renders it into the bar's
 * language spot; see NavLanguageSlot.tsx).
 *
 * The summary screen puts its own picker in the same spot, which saves the
 * same preference and also marks the languages not translated yet. Both go
 * through useLanguagePreference and the shared ['profile'] query, so a switch
 * on one screen is what the next screen shows. This replaced the account center's separate Change
 * Language page, which did the same thing one screen deeper.
 */
const ProfileLanguagePicker: React.FC = () => {
  const { t, enabledLanguages } = useLanguage();
  const { profile, isSaving, saveFailed, preferred, choose } = useLanguagePreference();

  // Languages enabled for this environment, each labelled in its own language
  // so a parent can always read the name of the one they want.
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  // Nothing to pick from, so nothing to show. Placed after the hooks, which
  // must run unconditionally.
  if (languageOptions.length <= 1) return null;

  return (
    <>
      <LanguageMenu
        options={languageOptions}
        selected={preferred}
        onSelect={(value) => choose(value as SupportedLanguage)}
        name={t('languageMenu.label')}
        // A save in flight owns the preference until it settles; a second
        // pick mid-request would race the rollback the first one may need.
        unavailableReason={isSaving ? t('languageMenu.saving') : undefined}
        variant="bar"
        uppercase
        id="language-preference-dropdown"
        className="language-preference-dropdown"
        testIdPrefix="language-preference"
        ready={Boolean(profile)}
      />
      {saveFailed && (
        <p className="language-menu-error" role="alert">
          {t('languageMenu.saveFailed')}
        </p>
      )}
    </>
  );
};

/**
 * The screen's language only, for a bar rendered without the app's query
 * client (component tests that mount the bar bare). The app always has one,
 * so a parent always gets the saving picker above.
 */
const ScreenLanguagePicker: React.FC = () => {
  const { t, language, setLanguage, enabledLanguages } = useLanguage();
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);
  if (languageOptions.length <= 1) return null;
  return (
    <LanguageMenu
      options={languageOptions}
      selected={language}
      onSelect={(value) => setLanguage(value as SupportedLanguage)}
      name={t('languageMenu.label')}
      variant="bar"
      uppercase
      id="language-preference-dropdown"
      className="language-preference-dropdown"
      testIdPrefix="language-preference"
    />
  );
};

const LanguagePreferenceDropdown: React.FC = () =>
  useContext(QueryClientContext) ? <ProfileLanguagePicker /> : <ScreenLanguagePicker />;

export default LanguagePreferenceDropdown;
