import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback, useMemo, useRef } from 'react';
import { api, ApiError, ApiUser, clearApiSessionRequests } from './lib/api';
import { clearPageCache } from './lib/pageCache';
import { AUTH_ME_PATH, clearPrimedRequests, takePrimedJson } from './lib/bootFetch';
import { REQUEST_EDITOR_COPIES, forgetTabEntries, privateDrafts, purgeLegacyPrivateDrafts } from './lib/privateDrafts';
import { createSessionAdopter, type SessionAdoption } from './lib/sessionCheck';

export type { SessionAdoption };

/**
 * Authentication state. The session lives in a Secure HttpOnly cookie managed
 * by the server — nothing identity-related is kept in localStorage, and the
 * admin flag comes exclusively from the server-side role.
 */

interface AuthContextType {
  isAuthenticated: boolean;
  user: ApiUser | null;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<SessionAdoption>;
  register: (username: string, name: string, email: string, password: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  /**
   * After a sign-in request succeeded: ask /me afresh and publish the account
   * only if this browser really carries its session (src/lib/sessionCheck.ts).
   * Pass the user the sign-in answered with, when it named one.
   */
  adoptSession: (postUser?: ApiUser | null) => Promise<SessionAdoption>;
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
      // The request editor’s tab copies (src/lib/privateDrafts.ts): every
      // OTHER account’s go. The first check after a reload names the account
      // the copies belong to, so they stay; a session that ran out (null)
      // keeps them for the sign-in that follows.
      if (next) forgetTabEntries(REQUEST_EDITOR_COPIES, `${REQUEST_EDITOR_COPIES}${next.id}.`);
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
    // Usually already on its way: src/lib/bootFetch.ts started it with the
    // entry, before React existed. Taken once; a remount asks again.
    (takePrimedJson<{ user: ApiUser | null }>(AUTH_ME_PATH) ?? api.get<{ user: ApiUser | null }>(AUTH_ME_PATH))
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

  /**
   * THE SIGN-IN IS NOT DONE UNTIL THE BROWSER PROVES IT KEPT THE SESSION.
   *
   * Requests already in flight belong to the guest that is leaving, so they
   * are cancelled first (and the boot-time primed /me is dropped). The check
   * carries its own AbortSignal, which is what keeps it out of the GET
   * coalescer: it can never join an anonymous /me that started before the
   * cookie existed. ONE adoption at a time — a second caller joins the one in
   * flight instead of cancelling its /me — and a /me cancelled by another
   * session change is asked again, never read as a failed check
   * (src/lib/sessionCheck.ts `createSessionAdopter`). Only `refreshUser`'s
   * background callers keep the old, forgiving behaviour.
   */
  const adoptSession = useMemo(
    () =>
      createSessionAdopter<ApiUser>({
        clear: () => {
          clearApiSessionRequests();
          clearPrimedRequests();
        },
        readMe: async () =>
          (await api.get<{ user?: ApiUser | null }>(AUTH_ME_PATH, { signal: new AbortController().signal }))?.user ?? null,
        // Our signal is never aborted, so ABORTED here can only be the session
        // epoch moving under the request (src/lib/api.ts).
        isSuperseded: (err) => err instanceof ApiError && err.code === 'ABORTED',
        publish: setUser,
      }),
    [setUser]
  );

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ user: ApiUser }>('/api/auth/login', { email, password });
    clearPrimedRequests();
    setUser(data.user);
  }, [setUser]);

  const loginWithGoogle = useCallback(async (credential: string) => {
    const data = await api.post<{ user?: ApiUser }>('/api/auth/google', { credential });
    return adoptSession(data.user);
  }, [adoptSession]);

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
      // Signing out on purpose leaves nothing of the account in this tab.
      forgetTabEntries(REQUEST_EDITOR_COPIES);
      setUser(null);
    }
  }, [setUser]);

  return (
    <AuthContext.Provider
      value={{ isAuthenticated: !!user, user, login, loginWithGoogle, register, refreshUser, adoptSession, logout, isLoaded }}
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
