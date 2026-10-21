import React, { useContext, useState } from 'react';
import { QueryClientContext, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../common/app-context';
import { ApiClient } from '../common/api-client/api-client';
import { UserProfile } from '../common/types';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import LanguageMenu from './LanguageMenu';
import './LanguagePreferenceDropdown.css';

/**
 * The parent's language preference, as the in-app bar's default picker on
 * every signed-in screen (MobileTopNavigation renders it into the bar's
 * language spot; see NavLanguageSlot.tsx).
 *
 * The summary screen puts its own picker in the same spot, which saves the
 * same preference and also marks the languages not translated yet. Both read
 * and write the shared ['profile'] query, so a switch on one screen is what
 * the next screen shows. This replaced the account center's separate Change
 * Language page, which did the same thing one screen deeper.
 */
const ProfileLanguagePicker: React.FC = () => {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const queryClient = useQueryClient();
  const { t, language, setLanguage, enabledLanguages } = useLanguage();
  const [saveFailed, setSaveFailed] = useState(false);

  // Languages enabled for this environment, each labelled in its own language
  // so a parent can always read the name of the one they want.
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  // Shares the cache entry that ChangeLanguage and the profile pages use, so
  // this renders from whatever has already been fetched this session rather
  // than putting a request on three more pages.
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => apiClient.profile.getProfile(),
  });

  // Mirrors ChangeLanguage.tsx: optimistic cache write plus an immediate
  // setLanguage so the page re-renders in the new language at once, with both
  // rolled back if the save fails. A partial body keeps the backend from
  // re-encrypting the PII fields this never touches.
  const updateProfileMutation = useMutation({
    mutationFn: (updatedProfile: UserProfile) =>
      apiClient.profile.updateProfile({ secondaryLanguage: updatedProfile.secondaryLanguage }),
    onMutate: async (updatedProfile) => {
      await queryClient.cancelQueries({ queryKey: ['profile'] });

      const previousProfile = queryClient.getQueryData<UserProfile>(['profile']);
      const previousLanguage = language;

      queryClient.setQueryData(['profile'], updatedProfile);

      if (updatedProfile.secondaryLanguage) {
        setLanguage(updatedProfile.secondaryLanguage as SupportedLanguage);
      }

      return { previousProfile, previousLanguage };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (_error, _updatedProfile, context) => {
      // Rolled back, and said so: a silent rollback looked like the pick had
      // simply not registered.
      setSaveFailed(true);
      if (context?.previousProfile) {
        queryClient.setQueryData(['profile'], context.previousProfile);
      }
      if (context?.previousLanguage) {
        setLanguage(context.previousLanguage);
      }
    },
  });

  const handleLanguageChange = (languageCode: SupportedLanguage) => {
    setSaveFailed(false);
    // No profile yet (still loading, or the fetch failed): switch the screen
    // anyway rather than ignore the pick. The preference is saved on the next
    // pick once the profile has loaded.
    if (!profile) {
      setLanguage(languageCode);
      return;
    }
    if (languageCode === profile.secondaryLanguage) return;
    updateProfileMutation.mutate({ ...profile, secondaryLanguage: languageCode });
  };

  // Nothing to pick from, so nothing to show — the same guard the summary
  // toolbar applies. Placed after the hooks, which must run unconditionally.
  if (languageOptions.length <= 1) return null;

  // The profile is the stored preference; the context language is what the
  // page is currently rendered in, and stands in for it until the first fetch
  // lands so the pill never flashes the wrong language.
  const selectedLanguage = profile?.secondaryLanguage ?? language;

  return (
    <>
      <LanguageMenu
        options={languageOptions}
        selected={selectedLanguage}
        onSelect={(value) => handleLanguageChange(value as SupportedLanguage)}
        name={t('languageMenu.label')}
        // A save in flight owns the preference until it settles; a second
        // pick mid-request would race the rollback the first one may need.
        unavailableReason={updateProfileMutation.isPending ? t('languageMenu.saving') : undefined}
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
