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

/** The first pending orders under the orders ticket (≤ FIRST_ROWS on the server). */
export interface FirstOrder {
  id: string;
  customer_name: string;
  total_iqd: number;
  governorate: string;
  created_at: string;
  link: string;
}

/** The first unread threads under the inbox ticket. */
export interface FirstThread {
  id: string;
  customer_name: string;
  /** The latest unread words from the customer's side, at most 140 characters; '' for a bare attachment. */
  last_message: string;
  unread: number;
  last_message_at: string | null;
  link: string;
}

/** The first sold-out products under the stock ticket — what the restock sheet edits. */
export interface FirstProduct {
  id: string;
  name: string;
  name_ar: string;
  stock: number;
  link: string;
}

/** An open return case on one of this merchant's orders (decided by Levonis; a door to the order). */
export interface FirstReturn {
  id: string;
  order_id: string;
  state: string;
  requested_at: string;
  link: string;
}

export interface Attention {
  orders?: { total: number; by_stage: Record<ActionStage, number>; link: string; links: Record<ActionStage, string>; first?: FirstOrder[] };
  custom_orders?: { to_start: number; in_progress: number; total: number; link: string };
  inbox?: { threads: number; messages: number; link: string; first?: FirstThread[] };
  notifications?: { unread: number; link: string };
  requests?: { matching: number; link: string };
  stock?: { low: number; out: number; link_low: string; link_out: string; first?: FirstProduct[] };
  reviews?: { new?: number; unanswered?: number; link: string };
  /** Return cases still open on this merchant's orders — read-only, the admin decides (v2 §4.1). */
  returns?: { open: number; link: string; first?: FirstReturn[] };
  money?: { available_iqd: number; pending_iqd: number; link: string };
  payouts?: { in_flight: number; amount_iqd: number; link: string };
  coupons?: { ending_soon: number; first_ends_at: string | null; within_days: number; link: string };
  store?: { problems: Array<{ code: StoreProblem; link: string }> };
  /** «جهّز متجرك»: what a new store still lacks (GET /api/merchant/attention). */
  setup?: {
    logo: boolean;
    banner: boolean;
    about: boolean;
    phone: boolean;
    delivery: boolean;
    products: number;
    design: boolean;
    links: { settings: string; delivery: string; products: string; design: string };
  };
  /**
   * «سرعة متجري» (P4): PRESENT ONLY when the phone LCP p75 bucket was poor on
   * three consecutive days with ≥ 30 samples each; absent by design otherwise
   * — so it is NOT one of the sources whose absence forbids «nothing waiting».
   * `link` is the builder's «السرعة» tab door (`merchantHref.storeDesign()`).
   */
  speed?: { grade: 'poor'; samples: number; poor_days: number; link: string };
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
