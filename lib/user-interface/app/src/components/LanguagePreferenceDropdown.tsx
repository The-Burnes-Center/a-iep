import React, { useContext } from 'react';
import { Dropdown } from 'react-bootstrap';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../common/app-context';
import { ApiClient } from '../common/api-client/api-client';
import { UserProfile } from '../common/types';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import './LanguagePreferenceDropdown.css';

/**
 * The language pill from the summary toolbar, on pages that are only read.
 *
 * It looks like the one in IEPSummarizationAndTranslation's button-container
 * but does something different: that one picks which TRANSLATION OF A
 * DOCUMENT to show, this one changes the parent's own language preference,
 * exactly as the select on /account-center/change-language does. Same
 * profile field, same optimistic update, same rollback — so switching here
 * and switching there are the same act, and either is reflected by the other
 * through the shared ['profile'] query.
 */
const LanguagePreferenceDropdown: React.FC = () => {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const queryClient = useQueryClient();
  const { t, language, setLanguage, enabledLanguages } = useLanguage();

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
      if (context?.previousProfile) {
        queryClient.setQueryData(['profile'], context.previousProfile);
      }
      if (context?.previousLanguage) {
        setLanguage(context.previousLanguage);
      }
    },
  });

  const handleLanguageChange = (languageCode: SupportedLanguage) => {
    if (!profile || languageCode === profile.secondaryLanguage) return;
    updateProfileMutation.mutate({ ...profile, secondaryLanguage: languageCode });
  };

  // Nothing to pick from, so nothing to show — the same guard the summary
  // toolbar applies. Placed after the hooks, which must run unconditionally.
  if (languageOptions.length <= 1) return null;

  // The profile is the stored preference; the context language is what the
  // page is currently rendered in, and stands in for it until the first fetch
  // lands so the pill never flashes the wrong language.
  const selectedLanguage = profile?.secondaryLanguage ?? language;
  const selectedLabel =
    languageOptions.find((option) => option.value === selectedLanguage)?.label || 'English';

  return (
    <div className="language-preference-bar d-flex justify-content-end align-items-center">
      <Dropdown className="language-preference-dropdown">
        <Dropdown.Toggle
          variant="outline-primary"
          id="language-preference-dropdown"
          size="sm"
          // A save in flight owns the preference until it settles; a second
          // pick mid-request would race the rollback the first one may need.
          disabled={updateProfileMutation.isPending}
          // The control's text is a language name, which names the VALUE and
          // not the control. Without this a screen reader announces "English,
          // button" and never says what choosing it would do.
          aria-label={t('profile.preferredLanguage')}
          // Stable E2E hook: the label is a language endonym
          data-testid="language-preference-toggle"
        >
          {selectedLabel.toUpperCase()}
        </Dropdown.Toggle>
        <Dropdown.Menu>
          {languageOptions.map((option) => (
            <Dropdown.Item
              key={option.value}
              onClick={() => handleLanguageChange(option.value)}
              active={selectedLanguage === option.value}
              // Stable E2E hook: the items are labelled with each language's
              // own endonym
              data-testid={`language-preference-option-${option.value}`}
            >
              {option.label.toUpperCase()}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown>
    </div>
  );
};

export default LanguagePreferenceDropdown;
