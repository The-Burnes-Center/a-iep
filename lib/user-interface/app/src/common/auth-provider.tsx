import React, { createContext, useState, useEffect, useContext } from 'react';
import { signOut, getCurrentUser } from 'aws-amplify/auth';

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

  // Check authentication status on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    setLoading(true);
    try {
      const currentUser = await getCurrentUser();
      if (currentUser) {
        setUser(currentUser);
        setAuthenticated(true);
      } else {
        setUser(null);
        setAuthenticated(false);
      }
    } catch (e) {
      // No authenticated user found
      setUser(null);
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  };

  const login = (user: unknown) => {
    setUser(user);
    setAuthenticated(true);
  };

  const logout = async () => {
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

