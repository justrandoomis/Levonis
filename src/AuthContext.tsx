
import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import { queryDb } from './lib/db';

interface User {
  id?: string;
  username?: string;
  name?: string;
  email?: string;
  isAdmin?: boolean;
  subscription_plan?: string;
  subscription_status?: string;
  subscription_expiry?: number;
  card_number?: string;
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  login: (userData?: any) => Promise<void>;
  refreshUser: () => Promise<void>;
  updateUserSubscription: (plan: string, expiry: number, cardNumber: string) => Promise<void>;
  register: (username: string, name: string, email: string, password?: string) => Promise<void>;
  logout: () => void;
  isLoaded: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {

  const fetchApi = async (url: string, options: any) => {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err: any) {
      throw new Error("Network error: " + err.message);
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(res.ok ? 'Invalid response from server' : `Server error (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(data.error || data.message || `Server error ${res.status}`);
    }
    if (data && data.success === false) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  };

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loadUser = async () => {
      try {
        const token = localStorage.getItem('auth_token');
        if (token) {
          const res = await fetch('/api/auth/me', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const data = await res.json();
          if (data.success) {
            const dbUser = data.user;
            if (dbUser.email === 'aliamer59409@gmail.com') dbUser.isAdmin = true;
            setUser(dbUser);
            setIsAuthenticated(true);
          } else {
            localStorage.removeItem('auth_token');
          }
        }
      } catch (err) {
        console.error("Error loading user from backend", err);
      } finally {
        setIsLoaded(true);
      }
    };
    loadUser();
  }, []);

  const refreshUser = async () => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      try {
        const res = await fetch('/api/auth/me', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success) {
          const dbUser = data.user;
          if (dbUser.email === 'aliamer59409@gmail.com') dbUser.isAdmin = true;
          setUser(dbUser);
        }
      } catch(e) {}
    }
  };

  const updateUserSubscription = async (plan: string, expiry: number, cardNumber: string) => {
    if (user?.id) {
      await queryDb(`UPDATE users SET subscription_plan = ?, subscription_status = 'active', subscription_expiry = ?, card_number = ? WHERE id = ?`, [plan, expiry, cardNumber, user.id]);
      await refreshUser();
    }
  };


  const login = async (userData?: any) => {
    if (!userData?.email) return;
    
    if (userData.password) {
      const data = await fetchApi('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userData.email, password: userData.password })
      });
      
      const loggedInUser = data.user;
      if (loggedInUser.email === 'aliamer59409@gmail.com') loggedInUser.isAdmin = true;
      
      setIsAuthenticated(true);
      setUser(loggedInUser);
      localStorage.setItem('auth_token', data.token);
    } else {
      const data = await fetchApi('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userData.email, name: userData.name })
      });
      if (data.generatedPassword) {
        alert(`An email would be sent with your new password: ${data.generatedPassword}`);
      }
      const loggedInUser = data.user;
      if (loggedInUser.email === 'aliamer59409@gmail.com') loggedInUser.isAdmin = true;
      
      setIsAuthenticated(true);
      setUser(loggedInUser);
      localStorage.setItem('auth_token', data.token);
    }
  };

  const register = async (username: string, name: string, email: string, password?: string) => {
    if (!password) {
      throw new Error('Password is required');
    }
    const data = await fetchApi('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, email, password })
    });
    
    const newUser = data.user;
    if (newUser.email === 'aliamer59409@gmail.com') newUser.isAdmin = true;
    
    setIsAuthenticated(true);
    setUser(newUser);
    localStorage.setItem('auth_token', data.token);
  };

  const logout = () => {
    setIsAuthenticated(false);
    setUser(null);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('current_user_id'); // legacy
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, login, register, logout, isLoaded, refreshUser, updateUserSubscription }}>
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
