import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../../lib/api';

/**
 * «الخدمات» — WHAT WAITS ON THE DESK, for the sidebar (GET /api/admin/services/badge, any admin):
 * trade-ins whose device is due today, received devices waiting for inspection, devices to hand
 * back, and price-protection claims requested. Counts only — never a figure. One store, one
 * timer while anyone is listening and the tab is visible (the support badge's shape,
 * src/components/adminSupport/supportCounts.ts); a desk action asks for a refresh.
 */
export interface ServicesBadge {
  trade_in: number;
  price_protection: number;
}

const POLL_MS = 60_000;
let snapshot: ServicesBadge | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

export function refreshServicesBadge(): Promise<void> {
  if (inflight) return inflight;
  inflight = api
    .get<ServicesBadge>('/api/admin/services/badge', { mascot: 'silent' })
    .then((d) => {
      snapshot = { trade_in: Number(d.trade_in) || 0, price_protection: Number(d.price_protection) || 0 };
      for (const l of listeners) l();
    })
    // A missed poll keeps the last numbers: a badge blinking to zero would say nothing waits.
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function onVisible() {
  if (document.visibilityState === 'visible') void refreshServicesBadge();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshServicesBadge();
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export function useServicesBadge(): ServicesBadge | null {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null
  );
  useEffect(() => {
    if (snapshot === null) void refreshServicesBadge();
  }, []);
  return value;
}
