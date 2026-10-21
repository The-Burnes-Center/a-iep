import { useContext, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../app-context';
import { ApiClient } from '../api-client/api-client';
import { UserProfile } from '../types';
import { SupportedLanguage, useLanguage } from '../language-context';

/**
 * The parent's language preference: read, chosen and saved in one place, for
 * every picker that changes it (the top bar's default and the summary's own).
 *
 * Both pickers used to own this separately. The summary kept a private copy
 * of the profile in component state, so the two disagreed: a choice made on
 * the summary left the shared ['profile'] cache stale for the next screen,
 * and a summary opened while a save from the bar was still in flight could
 * read the old value and switch the screen back. A failed save rolled back
 * without a word on both, a pick with no profile loaded did nothing at all,
 * and a second pick while the first was saving raced its rollback.
 *
 * Here: the shared cache is written optimistically and rolled back on
 * failure, the failure is reported (`saveFailed`), a pick with no profile
 * still switches the screen, and a pick while a save is in flight is
 * ignored (pickers also show themselves unavailable via `isSaving`).
 */
export const PROFILE_QUERY_KEY = ['profile'] as const;

export function useLanguagePreference() {
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const { language, setLanguage, enabledLanguages } = useLanguage();
  const [saveFailed, setSaveFailed] = useState(false);
  const apiClient = new ApiClient(appContext);

  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => apiClient.profile.getProfile() as Promise<UserProfile>,
  });
  const profile = profileQuery.data ?? null;

  // A partial body: the backend then skips re-encrypting the PII fields this
  // never touches.
  const mutation = useMutation({
    mutationFn: (code: SupportedLanguage) => apiClient.profile.updateProfile({ secondaryLanguage: code }),
    onMutate: async (code) => {
      await queryClient.cancelQueries({ queryKey: PROFILE_QUERY_KEY });
      const previousProfile = queryClient.getQueryData<UserProfile>(PROFILE_QUERY_KEY);
      const previousLanguage = language;
      if (previousProfile) {
        queryClient.setQueryData(PROFILE_QUERY_KEY, { ...previousProfile, secondaryLanguage: code });
      }
      setLanguage(code);
      return { previousProfile, previousLanguage };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
    onError: (_error, _code, context) => {
      if (context?.previousProfile) {
        queryClient.setQueryData(PROFILE_QUERY_KEY, context.previousProfile);
      }
      if (context?.previousLanguage) {
        setLanguage(context.previousLanguage);
      }
      setSaveFailed(true);
    },
  });

  const choose = (code: SupportedLanguage) => {
    // The save in flight owns the preference until it settles.
    if (mutation.isPending) return;
    setSaveFailed(false);
    // No profile (still loading, or the fetch failed): switch the screen
    // rather than ignore the pick.
    if (!profile) {
      setLanguage(code);
      return;
    }
    // Already saved: nothing to write, but the screen may be showing another
    // language (a cleared browser), so line it up.
    if (code === profile.secondaryLanguage) {
      setLanguage(code);
      return;
    }
    mutation.mutate(code);
  };

  // What the picker shows as chosen. A saved language this environment does
  // not offer (Arabic is dark in production) cannot be shown or picked, so
  // the screen's language stands in for it.
  const saved = profile?.secondaryLanguage as SupportedLanguage | undefined;
  const preferred: SupportedLanguage = saved && enabledLanguages.includes(saved) ? saved : language;

  return {
    profile,
    isProfileLoading: profileQuery.isPending,
    isSaving: mutation.isPending,
    saveFailed,
    preferred,
    choose,
  };
}
