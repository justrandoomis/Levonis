/**
 * WHAT EVERY PRINT CLOUD SCREEN NEEDS TO KNOW BEFORE IT ASKS FOR ANYTHING:
 * is the service there, is it open, and may THIS viewer use its customer
 * doors.
 *
 *   status        GET /status — installed, enabled, slicer, delivery,
 *                 integrations. Public, answered even while closed.
 *   access        'loading' | 'open' | 'preview' | 'closed' | 'unavailable'.
 *                 The owner ships the service CLOSED: every customer door
 *                 answers 503 PRINT_CLOUD_DISABLED to everyone but platform
 *                 admins (`role === 'admin'`, the server's own test in
 *                 worker/lib/printCloud/http.ts `enabledGate`). So a closed
 *                 service is a public landing, and an admin previews the full
 *                 app under a banner that says it is closed. 'unavailable':
 *                 the status itself could not be read.
 *   canUse        open, or an admin's preview — the screens behind the
 *                 customer doors may render.
 *   user          the signed-in Levonis account (the shared session cookie:
 *                 signed in on the apex is signed in here).
 *   dashboardVersion / refreshDashboard()
 *                 a screen that moved hours, grams or money (an order paid, a
 *                 job confirmed) calls refreshDashboard() and every screen
 *                 that shows a balance reloads on the new version.
 *
 * Nothing here is cached across visits: every figure is the server's, read
 * when the screen opens.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../AuthContext';
import type { ApiUser } from '../lib/api';
import { useStore } from '../StoreContext';
import { getStatus } from './api';
import type { CloudStatus, IntegrationName } from './types';

export type CloudAccess = 'loading' | 'open' | 'preview' | 'closed' | 'unavailable';

export interface CloudContextValue {
  status: CloudStatus | null;
  statusError: unknown;
  reloadStatus: () => void;
  access: CloudAccess;
  /** The customer screens may render: the service is open, or an admin previews it. */
  canUse: boolean;
  user: ApiUser | null;
  signedIn: boolean;
  /** The session question is answered (signed in or not). */
  authReady: boolean;
  /** A platform admin — the one viewer a closed service still answers. */
  isAdmin: boolean;
  /** `https://<root>` from the server, or '' (no root domain configured). */
  mainSite: string;
  /** Whether an integration adapter is connected; null until the status is known or for an unknown name. */
  integrationConnected: (name: IntegrationName) => boolean | null;
  dashboardVersion: number;
  refreshDashboard: () => void;
}

const CloudContext = createContext<CloudContextValue | null>(null);

/** Pure, for the tests: the access a status and a viewer give. */
export function accessOf(status: CloudStatus | null, statusError: unknown, authReady: boolean, isAdmin: boolean): CloudAccess {
  if (status === null) return statusError ? 'unavailable' : 'loading';
  if (status.installed && status.enabled) return 'open';
  // Closed (or not installed): who is looking decides between the landing and the preview.
  if (!authReady) return 'loading';
  return isAdmin ? 'preview' : 'closed';
}

export function CloudProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoaded } = useAuth();
  const { mainSite } = useStore();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [dashboardVersion, setDashboardVersion] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setStatusError(null);
    getStatus({ signal: ac.signal })
      .then((s) => {
        if (!ac.signal.aborted) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setStatusError(e ?? new Error('status'));
      });
    return () => ac.abort();
  }, [statusVersion]);

  const reloadStatus = useCallback(() => {
    setStatus(null);
    setStatusVersion((v) => v + 1);
  }, []);
  const refreshDashboard = useCallback(() => setDashboardVersion((v) => v + 1), []);

  // The server's own test of who may use a closed service.
  const isAdmin = user?.role === 'admin';
  const access = accessOf(status, statusError, isLoaded, isAdmin);

  const value = useMemo<CloudContextValue>(
    () => ({
      status,
      statusError,
      reloadStatus,
      access,
      canUse: access === 'open' || access === 'preview',
      user,
      signedIn: isAuthenticated,
      authReady: isLoaded,
      isAdmin,
      mainSite,
      integrationConnected: (name) => {
        const found = status?.integrations.find((i) => i.name === name);
        return found ? found.connected : null;
      },
      dashboardVersion,
      refreshDashboard,
    }),
    [status, statusError, reloadStatus, access, user, isAuthenticated, isLoaded, isAdmin, mainSite, dashboardVersion, refreshDashboard]
  );

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudContextValue {
  const ctx = useContext(CloudContext);
  if (!ctx) throw new Error('useCloud must be used inside <CloudProvider> (src/cloud/PrintCloudApp.tsx)');
  return ctx;
}
