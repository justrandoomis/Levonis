/**
 * «طلب السعر» — THE PURE HALF OF THE PANEL (DECISIONS rows 239 (4) and 240,
 * spec §6.2).
 *
 * Which row of the panel's state table is on screen, and how a selection is
 * carried through /auth and back. No React, no I/O: the panel
 * (`PriceRequestPanel.tsx`, a lazy chunk) renders what `priceRequestView`
 * answers, and a test pins every row of the table without a DOM.
 *
 * THE ORDER OF THE QUESTIONS IS THE TABLE'S:
 *   1. a priced product on a priced selection has no panel at all;
 *   2. a required option or colour not chosen → the button waits, with the
 *      helper sentence (the server would answer SELECTION_REQUIRED anyway);
 *   3. signed out → the button opens the sign-in sheet;
 *   4. signed in, «mine» still loading → the button waits;
 *   5. an OPEN request for exactly this selection → «طلبت السعر»;
 *   6. otherwise → the switch and the button.
 * A request that was priced, notified or withdrawn earlier is not «open»: the
 * customer may ask again while this selection still has no price (the server
 * reopens the same row — one person still counts once).
 */
import { parseSkuComboKey, skuComboKey } from '../../../packages/pricing/src/skuChannel';

export type PriceRequestState = 'open' | 'priced' | 'notified' | 'closed';

/** One of the caller's own rows, as `GET /api/price-requests/mine` lists it. */
export interface PriceRequestRow {
  id: string;
  product_id: string;
  product_slug?: string;
  /** The canonical SKU key (`skuComboKey`): '' is the product itself. */
  selection: string;
  state: PriceRequestState;
  notify: boolean;
  requested_at?: string;
}

export type PriceRequestView =
  | { kind: 'none' }
  | { kind: 'choose' }
  | { kind: 'signed_out' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'requested'; request: PriceRequestRow };

export interface PriceRequestInputs {
  /** The page body's `price_status`: 'unpriced' = a catalog-only product. */
  productStatus: 'priced' | 'unpriced';
  /** A priced product whose CURRENT complete selection has no V2 price. */
  selectionUnpriced: boolean;
  /** Every required option group and colour is chosen. */
  selectionComplete: boolean;
  authenticated: boolean;
  /** The caller's rows for this product; null while they load (or signed out). */
  mine: readonly PriceRequestRow[] | null;
  /** `skuComboKey` of the current selection. */
  selectionKey: string;
}

export function priceRequestView(i: PriceRequestInputs): PriceRequestView {
  if (i.productStatus !== 'unpriced' && !i.selectionUnpriced) return { kind: 'none' };
  if (!i.selectionComplete) return { kind: 'choose' };
  if (!i.authenticated) return { kind: 'signed_out' };
  if (i.mine === null) return { kind: 'loading' };
  const open = i.mine.find((r) => r.selection === i.selectionKey && r.state === 'open');
  return open ? { kind: 'requested', request: open } : { kind: 'ready' };
}

/** The rows after the server answered a write: one row per selection, the newest answer wins. */
export function withRow(mine: readonly PriceRequestRow[] | null, row: PriceRequestRow): PriceRequestRow[] {
  return [row, ...(mine ?? []).filter((r) => r.id !== row.id && r.selection !== row.selection)];
}

/** The selection key, from the page's own state. */
export const selectionKeyOf = (optionValueIds: readonly string[], colorId: string | null | undefined): string =>
  skuComboKey({ option_value_ids: optionValueIds, color_id: colorId || null });

// ---------------------------------------------------- the /auth round trip

/** The URL parameter that carries the selection through sign-in (the `?alert=` pattern). */
export const PRICE_REQUEST_PARAM = 'price_request';
/** '' (the product itself) travels as this, so an empty parameter is never ambiguous. */
const WHOLE_PRODUCT = '_';
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** `/product/<slug>?price_request=<key>` — where /auth sends the customer back. */
export function productPathWithPriceIntent(slug: string, selectionKey: string): string {
  const params = new URLSearchParams({ [PRICE_REQUEST_PARAM]: selectionKey || WHOLE_PRODUCT });
  return `/product/${encodeURIComponent(slug)}?${params.toString()}`;
}

/**
 * The selection that came back from /auth, decoded as UNTRUSTED input (anyone
 * can type the URL): a canonical key of well-formed ids, at most 400
 * characters, or nothing. It only PRE-SELECTS — the page keeps ids its own
 * product actually has, and nothing is sent until the customer taps again.
 */
export function decodePriceRequestIntent(raw: string | null | undefined): { option_value_ids: string[]; color_id: string | null } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) return null;
  if (raw === WHOLE_PRODUCT) return { option_value_ids: [], color_id: null };
  const parsed = parseSkuComboKey(raw);
  if (!parsed) return null;
  if (!parsed.option_value_ids.every((id) => ID.test(id))) return null;
  if (parsed.color_id !== null && !ID.test(parsed.color_id)) return null;
  return parsed;
}
