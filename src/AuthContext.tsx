import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import { api, ApiUser } from './lib/api';

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
    const data = await api.post<{ user: ApiUser }>('/api/auth/register', { username, name, email, password });
    setUser(data.user);
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
