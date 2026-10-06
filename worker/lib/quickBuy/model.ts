/**
 * «الشراء السريع» — the shapes and the fixed numbers (owner brief 2026-10-06
 * §3–§21, docs/GIFTS_QUICK_BUY.md §3). Every rule that decides money, stock or
 * time lives on the server; the client is told these numbers, never trusted
 * with them.
 */

/** §8: thirty minutes from the FIRST quick purchase, never extended (§9). */
export const QUICK_BUY_WINDOW_MS = 30 * 60 * 1000;
/** Distinct lines one session may hold — a guard on batch size, not a shop rule. */
export const QUICK_BUY_MAX_LINES = 20;
export const QUICK_BUY_MAX_QTY = 99;
/** The cron retries a session that could not be submitted this many times
 *  (once a minute) before it is marked `failed` for an administrator. */
export const QUICK_BUY_FINALIZE_MAX_ATTEMPTS = 10;
/** How long one finaliser owns a session before another may take it over. */
export const QUICK_BUY_LEASE_MS = 2 * 60 * 1000;

/** The database's own clock, for every in-batch comparison against `expires_at`. */
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export type QuickBuyState = 'open' | 'submitted' | 'cancelled' | 'failed';

export interface QuickBuySessionRow {
  id: string;
  user_id: string;
  state: QuickBuyState;
  started_at: string;
  expires_at: string;
  order_id: string;
  address_id: string;
  address_snapshot: string;
  delivery_method_id: string;
  exchange_rate: number;
  rev: number;
  hold_id: string | null;
  held_iqd: number;
  held_cents: number;
  items_iqd: number;
  discount_iqd: number;
  shipping_iqd: number;
  shipping_before_iqd: number;
  total_iqd: number;
  quote_json: string;
  consent_json: string;
  printer_ack_json: string | null;
  lease_until: string | null;
  finalize_attempts: number;
  finalize_error: string | null;
  submitted_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuickBuyItemRow {
  id: string;
  session_id: string;
  user_id: string;
  product_id: string;
  option_id: string;
  option_value_ids: string;
  color_id: string;
  shipping_method_id: string;
  transport_method: string;
  fulfillment_type: string;
  warranty_plan_id: string;
  draw_salt: string;
  qty: number;
  reserved_qty: number;
  stock_targets: string;
  unit_price_iqd: number;
  line_total_iqd: number;
  snapshot: string;
  image_snapshot: string;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

/** The counters a reservation is held on — scope and id are all a release needs. */
export interface HeldTarget {
  scope: string;
  scope_id: string;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Option values in one canonical order, so the same selection is the same line. */
export function canonicalOptionValues(ids: unknown): string {
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  return JSON.stringify([...new Set(list)].sort());
}

export function sameTargets(a: readonly HeldTarget[], b: readonly HeldTarget[]): boolean {
  const key = (t: HeldTarget) => `${t.scope}:${t.scope_id}`;
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

export const isoIn = (ms: number, from = Date.now()) => new Date(from + ms).toISOString();
