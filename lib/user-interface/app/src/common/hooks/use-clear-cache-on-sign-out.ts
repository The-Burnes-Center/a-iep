import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth-provider';

/**
 * Empties the query cache the moment a signed-in parent stops being signed in:
 * sign-out, a deleted account, or a session the server says is dead.
 *
 * The cache lives for the whole page and keeps data fresh for five minutes, so
 * without this the next account to sign in on this tab reads the last one's
 * profile. That is how an upload failed on staging: a parent deleted their
 * account, signed up again within five minutes, and the upload screen sent the
 * deleted account's child id, which the new profile rightly refused. On a
 * shared family computer it would also show one parent another's child.
 *
 * Only the signed-in to signed-out edge clears. The first render is never
 * that edge, so the boot-time auth check costs nothing.
 */
export function useClearCacheOnSignOut(): void {
  const { authenticated } = useAuth();
  const queryClient = useQueryClient();
  const wasAuthenticated = useRef(authenticated);

  useEffect(() => {
    if (wasAuthenticated.current && !authenticated) queryClient.clear();
    wasAuthenticated.current = authenticated;
  }, [authenticated, queryClient]);
}
