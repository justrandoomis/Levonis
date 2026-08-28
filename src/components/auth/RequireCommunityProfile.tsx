import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { queryDb } from '../../lib/db';

export default function RequireCommunityProfile({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, user, loading } = useAuth();
  const location = useLocation();
  const [profileOk, setProfileOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!loading && isAuthenticated && user) {
      // Mocking profile check
      setProfileOk(true);
    } else if (!loading && !isAuthenticated) {
      setProfileOk(false);
    }
  }, [loading, isAuthenticated, user]);

  if (loading || profileOk === null) {
    return <div className="min-h-screen bg-black flex items-center justify-center"><div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div></div>;
  }

  if (!isAuthenticated || !profileOk) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
