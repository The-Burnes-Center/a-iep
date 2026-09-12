import React, { createContext, useState, useEffect, useContext, useCallback } from 'react';
import { signOut, getCurrentUser } from 'aws-amplify/auth';
import { AppContext } from './app-context';
import { useFeatures } from './hooks/use-features';
import {
  clearCachedTokens,
  clearPersistedSessionHandle,
  exchangeSession,
  logoutSession,
  readPersistedSessionHandle,
  setCachedTokens,
} from './auth/passwordless-auth';

interface AuthContextType {
  authenticated: boolean;
  setAuthenticated: React.Dispatch<React.SetStateAction<boolean>>;
  loading: boolean;
  user: unknown | null;
  login: (user: unknown) => void;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  authenticated: false,
  setAuthenticated: () => {},
  loading: true,
  user: null,
  login: () => {},
  logout: async () => {},
  checkAuth: async () => {},
});

// eslint-disable-next-line react-refresh/only-export-components -- context/provider co-located by design
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [user, setUser] = useState<unknown | null>(null);
  const appConfig = useContext(AppContext);
  const { isFeatureEnabled } = useFeatures();

  // Stable identity (empty deps: only setState setters inside, which React
  // guarantees never change) so the memoized chain below — resumeSession ->
  // checkAuth -> the mount effect — does not get a new identity, and does not
  // re-run, on every render. Without this the effect would re-fire checkAuth
  // after its own first setLoading/setAuthenticated call, forever.
  const login = useCallback((user: unknown) => {
    setUser(user);
    setAuthenticated(true);
  }, []);

  /**
   * The additional route to "signed in" a fresh page load needs (contract
   * §§6, 8): re-exchange the durably-persisted session handle for a fresh
   * access/ID token pair, so a reload doesn't strand a parent whose handle is
   * still good. This never REPLACES the Amplify check below — it only
   * short-circuits it on success — and is a no-op (no network call, no state
   * change) when the flag is off or nothing was persisted, so the legacy
   * path's behaviour and timing are unchanged in both cases.
   *
   * Returns true only when the parent is now signed in via this route.
   */
  const resumePasswordlessSession = useCallback(async (): Promise<boolean> => {
    if (!isFeatureEnabled('passwordlessAuth')) return false;

    const session = readPersistedSessionHandle();
    if (!session) return false;

    const httpEndpoint = appConfig?.httpEndpoint ?? '/';
    const tokens = await exchangeSession({ httpEndpoint, session });

    if ('accessToken' in tokens) {
      setCachedTokens(tokens);
      login({ passwordlessAuth: true });
      return true;
    }

    // contract §4: a 401 session_invalid is the one answer that PROVES the
    // handle is dead (expired, revoked, or the account is gone), so clearing
    // it is correct. Everything else here — 503 unavailable, a network
    // failure `postJson` already collapsed into `unavailable`, or any code
    // this client has never seen — is not proof of anything, and a handle
    // that might still be good must survive to the next attempt.
    if (tokens.code === 'session_invalid') {
      clearPersistedSessionHandle();
      clearCachedTokens();
    }
    return false;
  }, [isFeatureEnabled, appConfig, login]);

  const checkAuth = useCallback(async () => {
    setLoading(true);
    try {
      // Tried first: if it signs the parent in, the Amplify check below never
      // runs at all. If it doesn't (flag off, no handle, or the attempt
      // failed), fall through to the exact check that ran before this
      // existed, unmodified — a parent who signed in the old way keeps
      // working even after this flag is on.
      if (await resumePasswordlessSession()) return;

      const currentUser = await getCurrentUser();
      if (currentUser) {
        setUser(currentUser);
        setAuthenticated(true);
      } else {
        setUser(null);
        setAuthenticated(false);
      }
    } catch (e) {
      // No authenticated user found via either route.
      setUser(null);
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, [resumePasswordlessSession]);

  // Check authentication status on mount. checkAuth's identity is stable
  // (see the useCallback chain above) whenever appConfig/isFeatureEnabled
  // are, which they are for this provider's whole lifetime — AppConfigured
  // does not render AuthProvider at all until config has already loaded (see
  // app-configured.tsx) — so this runs once, not on every render.
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  /**
   * Sign out of BOTH routes, local state first.
   *
   * Amplify signOut() alone is not a sign-out once passwordlessAuth is on.
   * checkAuth tries resumePasswordlessSession() before the Amplify check, so
   * a handle left in storage signs the parent straight back in on the next
   * page load: they tap Sign Out, the app looks signed out, and a reload
   * hands the account back. On a shared or family computer that is the next
   * person reading a child's IEP.
   *
   * Order matters. The local clears happen first and unconditionally, so a
   * failing network call or a thrown signOut() cannot leave a live handle on
   * the device: whatever else breaks, this browser can no longer resume.
   * Revoking server-side is best-effort on top of that, per contract §5,
   * which specifies /auth/logout always answers 200. The row also carries a
   * TTL, so a missed revoke expires on its own rather than living forever.
   */
  const logout = async () => {
    const session = readPersistedSessionHandle();
    clearPersistedSessionHandle();
    clearCachedTokens();

    if (session) {
      try {
        await logoutSession({ httpEndpoint: appConfig?.httpEndpoint ?? '/', session });
      } catch {
        // Already unusable on this device. A failed revoke is not a reason to
        // keep the parent on a screen that says they are still signed in.
      }
    }

    try {
      await signOut();
      setUser(null);
      setAuthenticated(false);
    } catch (error) {
      console.error('Error signing out:', error);
      throw error;
    }
  };

  const value = {
    authenticated,
    setAuthenticated,
    loading,
    user,
    login,
    logout,
    checkAuth,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

