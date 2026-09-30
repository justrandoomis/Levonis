/**
 * THE ORDERS LIST'S READS, WRITES AND ARITHMETIC (merchant platform v2 §3.3,
 * §4.2) — everything the screen decides without the DOM, so it is tested
 * without one.
 *
 *   ordersListApi   the list (`?status&q&cursor`), one move with an optional
 *                   tracking number, the bulk move, one order in full (for
 *                   the packing slips) and the CSV's address.
 *   bulkPlan        which forward steps a selection can take, and which of
 *                   the selected ids each step applies to — the server decides
 *                   again per id; this only keeps the tray from offering
 *                   «تأكيد» to a selection that has nothing to confirm.
 *   bulkOutcome     the sentence a bulk answer earns: all done, some refused,
 *                   none moved.
 *   searchTerm      the typed text as the server accepts it: trimmed, at most
 *                   SEARCH_MAX characters — null says «too long», '' says
 *                   «everything».
 *   mapLimit        N slips fetched a few at a time, not fifty at once.
 */
import { api } from '../../../lib/api';
import type { OrderRecord } from './api';
import { ORDER_FLOW } from './labels';

/** One row of GET /api/merchant/orders — what the list shows; never the phone or the street. */
export interface OrderListRow {
  id: string;
  status: string;
  total_iqd: number;
  merchant_receivable_iqd: number;
  customer_name: string;
  item_count: number;
  created_at: string;
  governorate: string;
  tracking_no: string;
  credit_state: string | null;
  release_after: string | null;
}

export interface OrderListPage {
  orders: OrderListRow[];
  next_cursor: string | null;
}

export interface BulkAnswer {
  status: string;
  done: string[];
  refused: Array<{ id: string; code: string }>;
}

/** One order's lines as GET /api/merchant/orders/:id returns them (the slip prints these). */
export interface SlipItem {
  id: string;
  name_snapshot: string;
  option_snapshot: string | null;
  qty: number;
}

export interface SlipOrder {
  order: OrderRecord;
  items: SlipItem[];
}

const enc = encodeURIComponent;
/** `?a=b` or '' — a query string only when there is one. */
const withQuery = (qs: URLSearchParams) => {
  const q = qs.toString();
  return q ? `?${q}` : '';
};

export const ordersListApi = {
  list: (params: URLSearchParams) =>
    api.get<OrderListPage>(`/api/merchant/orders${withQuery(params)}`),
  setStatus: (id: string, status: string, trackingNo = '') =>
    api.post<{ status: string; tracking_no?: string }>(`/api/merchant/orders/${enc(id)}/status`, {
      status,
      ...(trackingNo ? { tracking_no: trackingNo } : {}),
    }),
  // The server runs one transition per id in turn; the deadline grows with
  // the list so a 50-order move is not abandoned by the client while the
  // orders keep moving (the screen re-reads on any failure regardless).
  bulkStatus: (ids: string[], status: string, trackingNo = '') =>
    api.post<BulkAnswer>('/api/merchant/orders/bulk-status', {
      ids,
      status,
      ...(trackingNo ? { tracking_no: trackingNo } : {}),
    }, { timeoutMs: bulkTimeoutMs(ids.length) }),
  order: (id: string) => api.get<SlipOrder>(`/api/merchant/orders/${enc(id)}`),
};

/** The client's deadline for a bulk move: the default 20 s plus a second per order. */
export function bulkTimeoutMs(count: number): number {
  return 20_000 + Math.max(0, Math.min(BULK_MAX, count)) * 1_000;
}

/** The server's limits, repeated where the screen refuses before asking. */
export const SEARCH_MAX = 60;
export const TRACKING_NO_MAX = 60;
export const BULK_MAX = 50;

/** The list's query string for a filter, a search and a page — the CSV takes the same words. */
export function listParams(f: { status?: string; q?: string; cursor?: string | null }): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.status) qs.set('status', f.status);
  if (f.q) qs.set('q', f.q);
  if (f.cursor) qs.set('cursor', f.cursor);
  return qs;
}

/** Where the current filter downloads as a spreadsheet (GET, the session's cookie carries the auth). */
export function csvHref(f: { status?: string; q?: string }): string {
  return `/api/merchant/orders/export.csv${withQuery(listParams(f))}`;
}

/** The typed search as sent: '' for nothing, null when it is too long to send. */
export function searchTerm(text: string): string | null {
  const t = text.trim();
  if (!t) return '';
  return [...t].length > SEARCH_MAX ? null : t;
}

/** The order the forward steps come in — a tray lists them in this order. */
const STEP_ORDER = ['confirmed', 'processing', 'shipped', 'delivered'] as const;

export interface BulkStep {
  to: string;
  ids: string[];
}

/**
 * The forward steps the selected rows can take, each with the ids it applies
 * to. A mixed selection («2 جديد + 1 مؤكد») gets one button per step, each
 * counted; the cancel is never a step. Rows the selection names that are not
 * on the page (a stale set) are ignored.
 */
export function bulkPlan(rows: readonly OrderListRow[], selected: ReadonlySet<string>): BulkStep[] {
  const byStep = new Map<string, string[]>();
  for (const row of rows) {
    if (!selected.has(row.id)) continue;
    for (const to of ORDER_FLOW[row.status] ?? []) {
      if (to === 'cancelled') continue;
      const ids = byStep.get(to) ?? [];
      ids.push(row.id);
      byStep.set(to, ids);
    }
  }
  return STEP_ORDER.filter((to) => byStep.has(to)).map((to) => ({ to, ids: byStep.get(to)! }));
}

export type BulkOutcome =
  | { kind: 'done'; n: number }
  | { kind: 'partial'; n: number; m: number; refused: BulkAnswer['refused'] }
  | { kind: 'none'; refused: BulkAnswer['refused'] };

/** What the answer earns: a success toast, a partial one with the refusals listed, or a failure. */
export function bulkOutcome(answer: BulkAnswer): BulkOutcome {
  const n = answer.done.length;
  const m = answer.refused.length;
  if (m === 0) return { kind: 'done', n };
  if (n === 0) return { kind: 'none', refused: answer.refused };
  return { kind: 'partial', n, m, refused: answer.refused };
}

/**
 * The rows after a move landed: the moved ones carry the new status (and the
 * tracking number a ship named); under a status filter they leave the list,
 * because they no longer belong to it.
 */
export function applyMoves(
  rows: readonly OrderListRow[],
  moved: readonly string[],
  to: string,
  filter: string,
  trackingNo = ''
): OrderListRow[] {
  const set = new Set(moved);
  if (filter && filter !== to) return rows.filter((r) => !set.has(r.id));
  return rows.map((r) =>
    set.has(r.id) ? { ...r, status: to, ...(to === 'shipped' && trackingNo ? { tracking_no: trackingNo } : {}) } : r
  );
}

/** `fn` over `items`, at most `limit` in flight; the answers in the items' order, a failure as `null`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<R | null>> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
