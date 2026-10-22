import { useCallback, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../app-context';
import { ApiClient } from '../api-client/api-client';
import { UserProfile } from '../types';
import { PROFILE_QUERY_KEY } from './use-language-preference';

/**
 * Whether the parent has been through the summary page's guided tour, kept on
 * the profile (`summaryTourSeen`) so it follows them between devices.
 *
 * Reads the shared ['profile'] cache, like the language preference does.
 *
 * Marking it seen is optimistic and is NOT rolled back if the save fails: the
 * tour is a courtesy, and a parent who just dismissed it must not be shown it
 * again in this session because a request dropped. The session's own record
 * (SESSION_KEY) is what holds that line, since a refetch of the profile would
 * otherwise bring the old value back. The cost is that a failed save means the
 * tour offers itself once more next session, which is acceptable.
 */
const SESSION_KEY = ['summaryTourSeenThisSession'] as const;

export function useSummaryTourSeen() {
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const apiClient = new ApiClient(appContext);

  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => apiClient.profile.getProfile() as Promise<UserProfile>,
  });
  // A cache entry that is only ever written by markSeen: it lives as long as
  // the app does, and every component reading it re-renders when it flips.
  const sessionQuery = useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => false,
    enabled: false,
    initialData: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const profile = profileQuery.data ?? null;

  const markSeen = useCallback(() => {
    const profileSeen =
      queryClient.getQueryData<UserProfile>(PROFILE_QUERY_KEY)?.summaryTourSeen === true;
    if (profileSeen || queryClient.getQueryData<boolean>(SESSION_KEY) === true) return;

    queryClient.setQueryData(SESSION_KEY, true);
    const previous = queryClient.getQueryData<UserProfile>(PROFILE_QUERY_KEY);
    if (previous) {
      queryClient.setQueryData(PROFILE_QUERY_KEY, { ...previous, summaryTourSeen: true });
    }
    // A partial body: the backend then skips re-encrypting the PII fields this
    // never touches.
    apiClient.profile.updateProfile({ summaryTourSeen: true }).catch((error: unknown) => {
      console.error(
        'Could not save the summary tour flag:',
        error instanceof Error ? error.name : 'unknown',
      );
    });
    // apiClient is rebuilt every render and holds nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  return {
    /** False until the profile has loaded: no profile means we do not know, so the tour stays quiet. */
    isKnown: profile !== null,
    hasSeen: profile?.summaryTourSeen === true || sessionQuery.data === true,
    markSeen,
  };
}
