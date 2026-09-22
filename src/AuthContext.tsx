import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback, useRef } from 'react';
import { api, ApiUser } from './lib/api';
import { clearPageCache } from './lib/pageCache';

/**
 * Authentication state. The session lives in a Secure HttpOnly cookie managed
 * by the server — nothing identity-related is kept in localStorage, and the
 * admin flag comes exclusively from the server-side role.
 */

interface AuthContextType {
  isAuthenticated: boolean;
  user: ApiUser | null;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  register: (username: string, name: string, email: string, password: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  isLoaded: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ user: ApiUser | null }>('/api/auth/me')
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * THE BACK-NAVIGATION SNAPSHOTS ARE IDENTITY-SCOPED.
   *
   * src/lib/pageCache.ts holds what a list page last showed so `back` paints
   * instantly instead of running its skeleton again. Catalogue prices are
   * membership-dependent — a PRIME member and a signed-out visitor are quoted
   * different numbers for the same product — so a snapshot taken as one
   * identity must never be painted for another.
   *
   * The ref starts at `null` because that is what the app IS until
   * `/api/auth/me` answers: a visitor. So the boot case is covered by the same
   * line as sign-in and sign-out — the moment the answer arrives and it is a
   * user, the identity changed and anything cached while the page was still
   * anonymous goes with it. Deciding which of those rows were
   * identity-dependent would be guesswork; dropping the lot is cheap and
   * cannot be wrong.
   */
  const lastIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.id ?? null;
    if (lastIdentityRef.current === id) return;
    lastIdentityRef.current = id;
    clearPageCache();
  }, [user?.id]);

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: ApiUser | null }>('/api/auth/me');
      setUser(data.user);
    } catch {
      /* keep the current state on transient errors */
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ user: ApiUser }>('/api/auth/login', { email, password });
    setUser(data.user);
  }, []);

  const loginWithGoogle = useCallback(async (credential: string) => {
    const data = await api.post<{ user: ApiUser }>('/api/auth/google', { credential });
    setUser(data.user);
  }, []);

  const register = useCallback(async (username: string, name: string, email: string, password: string) => {
    // Email-first sign-up (mail configured) answers pending_email with no
    // account object: the account opens from the link in the inbox.
    const data = await api.post<{ user?: ApiUser; pending_email?: boolean }>('/api/auth/register', { username, name, email, password });
    if (data.user) setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{ isAuthenticated: !!user, user, login, loginWithGoogle, register, refreshUser, logout, isLoaded }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
