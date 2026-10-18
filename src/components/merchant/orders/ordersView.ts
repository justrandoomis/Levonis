/**
 * THE ORDERS LIST'S ADDRESS — the list exactly as the merchant left it: the
 * status tab, the search and how many pages were open (`?status&q&pages`),
 * so Back from an order lands on the same list.
 *
 * The same rule as the contract's query words (packages/contracts/src/
 * merchantRoutes.ts `readWorkspaceQuery`): a closed list or a bound, and
 * anything else dropped. The status is the contract's own closed list; the
 * two words that are not a list are bounded — a search of at most
 * LIST_SEARCH_MAX characters (the server's bound) with no control
 * characters, and 2 to LIST_PAGES_MAX open pages (one page is the default
 * and is never written; more is clamped, never an unbounded crawl).
 *
 * The writer goes THROUGH the reader, so a word is written only when it
 * would be read back. It lives here, not in the contract module, because
 * that module rides in the workspace shell's closure; this one loads with
 * the orders section only.
 */
import { merchantHref, ORDER_STATUS_FILTERS, type OrderStatusFilter } from '../../../lib/merchantRoutes';

export const LIST_SEARCH_MAX = 60;
export const LIST_PAGES_MAX = 10;

/** What the orders list's address keeps. */
export interface OrdersView {
  status?: string;
  q?: string;
  pages?: number;
}

/** The orders list's words from an address's query string — each checked, anything else dropped. */
export function readOrdersView(search: string): { status?: OrderStatusFilter; q?: string; pages?: number } {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  } catch {
    return {};
  }
  const out: { status?: OrderStatusFilter; q?: string; pages?: number } = {};
  const status = params.get('status');
  if (status !== null && (ORDER_STATUS_FILTERS as readonly string[]).includes(status)) out.status = status as OrderStatusFilter;
  const q = (params.get('q') ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (q && [...q].length <= LIST_SEARCH_MAX && !/[\u0000-\u001f\u007f]/.test(q)) out.q = q;
  const pages = params.get('pages') ?? '';
  if (/^\d{1,3}$/.test(pages) && Number(pages) >= 2) out.pages = Math.min(Number(pages), LIST_PAGES_MAX);
  return out;
}

/** The orders list's address for a view — only the words `readOrdersView` would take back. */
export function ordersViewHref(view: OrdersView): string {
  const raw = new URLSearchParams();
  if (view.status) raw.set('status', view.status);
  if (view.q) raw.set('q', view.q);
  if (view.pages) raw.set('pages', String(view.pages));
  const kept = readOrdersView(raw.toString());
  const qs = new URLSearchParams();
  if (kept.status) qs.set('status', kept.status);
  if (kept.q) qs.set('q', kept.q);
  if (kept.pages) qs.set('pages', String(kept.pages));
  const rest = qs.toString();
  return rest ? `${merchantHref.orders()}?${rest}` : merchantHref.orders();
}
