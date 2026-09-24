/**
 * «What needs me now» — the client side of GET /api/merchant/attention
 * (worker/routes/merchantWorkspace.ts). One read feeds the Command Center and
 * every badge of the shell, so the sidebar and the home screen can never
 * disagree about a count.
 *
 * EVERY FIELD IS OPTIONAL ON PURPOSE: the server leaves out what it could not
 * count, and a missing field must draw nothing — never a «0».
 *
 * Refreshed when the shell mounts, when the tab comes back to the front, on a
 * section change (at most every 15 s) and every 90 s while visible; never
 * while the tab is hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';

export type ActionStage = 'pending' | 'confirmed' | 'processing';

export interface Attention {
  orders?: { total: number; by_stage: Record<ActionStage, number>; link: string; links: Record<ActionStage, string> };
  custom_orders?: { to_start: number; in_progress: number; total: number; link: string };
  inbox?: { threads: number; messages: number; link: string };
  notifications?: { unread: number; link: string };
  requests?: { matching: number; link: string };
  stock?: { low: number; out: number; link_low: string; link_out: string };
  reviews?: { new?: number; unanswered?: number; link: string };
  money?: { available_iqd: number; pending_iqd: number; link: string };
  payouts?: { in_flight: number; amount_iqd: number; link: string };
  coupons?: { ending_soon: number; first_ends_at: string | null; within_days: number; link: string };
  store?: { problems: Array<{ code: StoreProblem; link: string }> };
}

export type StoreProblem =
  | 'store_suspended'
  | 'merchant_suspended'
  | 'merchant_restricted'
  | 'store_paused'
  | 'subscription_inactive'
  | 'benefit_restricted'
  | 'layout_unpublished';

export interface AttentionState {
  data: Attention | null;
  error: unknown;
  loading: boolean;
  /** `force` skips the 15 s gap (after the merchant changed something). */
  refresh: (force?: boolean) => void;
}

const POLL_MS = 90_000;
const MIN_GAP_MS = 15_000;

export function useAttention(): AttentionState {
  const [data, setData] = useState<Attention | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const last = useRef(0);
  const seq = useRef(0);

  const load = useCallback((force: boolean) => {
    if (!force && Date.now() - last.current < MIN_GAP_MS) return;
    last.current = Date.now();
    const mine = ++seq.current;
    api
      .get<{ success: true; attention: Attention }>('/api/merchant/attention')
      .then((r) => {
        if (mine !== seq.current) return;
        setData(r.attention);
        setError(null);
      })
      .catch((e) => {
        // A failed refresh keeps the last real answer on screen; only the
        // first read has nothing to fall back to.
        if (mine === seq.current) setError(e);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const arm = () => {
      if (timer === null) timer = window.setInterval(() => load(true), POLL_MS);
    };
    const disarm = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') disarm();
      else {
        load(false);
        arm();
      }
    };
    load(true);
    if (document.visibilityState === 'visible') arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disarm();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const refresh = useCallback((force = false) => load(force), [load]);
  return { data, error, loading, refresh };
}
