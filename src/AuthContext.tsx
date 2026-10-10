import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback, useRef } from 'react';
import { api, ApiUser, clearApiSessionRequests } from './lib/api';
import { clearPageCache } from './lib/pageCache';
import { clearPrimedRequests } from './lib/bootFetch';
import { privateDrafts, purgeLegacyPrivateDrafts } from './lib/privateDrafts';

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

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setSessionUser] = useState<ApiUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const sessionScope = useRef<string | null>(null);
  const setUser = useCallback((next: ApiUser | null) => {
    const scope = next ? JSON.stringify([next.id, next.role, next.admin_scope, next.can_view_cost, next.can_move_money]) : '';
    if (scope !== sessionScope.current) {
      // The first /me only identifies the cookie the opening requests already
      // carry. Cancelling those reads would break a signed-in first paint.
      if (sessionScope.current !== null) {
        clearApiSessionRequests();
        clearPrimedRequests();
      }
      sessionScope.current = scope;
      clearPageCache();
      privateDrafts.clear();
    }
    // Invalidate before rendering the new account; a parent effect runs after
    // child effects and would let their first reads join the old request.
    setSessionUser(next);
  }, []);

  useEffect(purgeLegacyPrivateDrafts, []);
  useEffect(() => {
    if (user?.can_view_cost !== true) privateDrafts.clear();
  }, [user?.can_view_cost]);

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
  }, [setUser]);

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: ApiUser | null }>('/api/auth/me');
      setUser(data.user);
    } catch {
      /* keep the current state on transient errors */
    }
  }, [setUser]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ user: ApiUser }>('/api/auth/login', { email, password });
    clearPrimedRequests();
    setUser(data.user);
  }, [setUser]);

  const loginWithGoogle = useCallback(async (credential: string) => {
    const data = await api.post<{ user: ApiUser }>('/api/auth/google', { credential });
    clearPrimedRequests();
    setUser(data.user);
  }, [setUser]);

  const register = useCallback(async (username: string, name: string, email: string, password: string) => {
    // Email-first sign-up (mail configured) answers pending_email with no
    // account object: the account opens from the link in the inbox.
    const data = await api.post<{ user?: ApiUser; pending_email?: boolean }>('/api/auth/register', { username, name, email, password });
    if (data.user) { clearPrimedRequests(); setUser(data.user); }
  }, [setUser]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      clearPrimedRequests();
      setUser(null);
    }
  }, [setUser]);

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

/**
 * The same context, or `undefined` outside an AuthProvider — for a provider
 * that sits under this one in the app but is also rendered alone (the
 * LanguageProvider in the browser fixtures), where `useAuth` would throw.
 */
export function useOptionalAuth(): AuthContextType | undefined {
  return useContext(AuthContext);
}
