import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { api } from '../../lib/api';

export default function RequireCommunityProfile({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuth();
  const location = useLocation();
  const [profileOk, setProfileOk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded) return;
    if (!isAuthenticated) {
      setProfileOk(null);
      return;
    }
    api
      .get<{ complete: boolean; hasStore: boolean }>('/api/community/profile-status')
      .then((data) => {
        if (!cancelled) setProfileOk(data.complete);
      })
      .catch(() => {
        if (!cancelled) setProfileOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isAuthenticated]);

  if (!isLoaded) {
    return <div className="min-h-screen bg-black flex items-center justify-center"><div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div></div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  if (profileOk === null) {
    return <div className="min-h-screen bg-black flex items-center justify-center"><div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div></div>;
  }

  if (!profileOk) {
    return <Navigate to="/edit-profile" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
