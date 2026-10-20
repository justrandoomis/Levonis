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

/**
 * `?v=` — THE SELECTION A SEARCH RESULT MATCHED (smart search 1.7). A result
 * for «10101» or «0.4» links to its product with the colour or option its
 * code names (src/components/search/resultLink.ts writes it, in the same
 * canonical key as `?price_request=`). Decoded here as UNTRUSTED input, like
 * the price request above: a malformed key is nothing; of a well-formed one
 * only ids THIS product owns are kept — at most one value per option group,
 * in the page own group order, and a colour only when the product has it. It
 * only pre-selects: the price comes from the quote for that selection, and
 * the parameter stays in the address so a shared link opens the same way.
 * The page applies it the same on a phone and on a desktop (one selection
 * state, src/pages/Product.tsx).
 */
export const VARIANT_PARAM = 'v';

export function linkedSelection(
  raw: string | null | undefined,
  product: { options?: ReadonlyArray<{ id: string }> | null; colors?: ReadonlyArray<{ id: string }> | null },
  relations: { option_groups?: ReadonlyArray<{ values: ReadonlyArray<{ id: string }> }> } | null | undefined
): { option_value_ids: string[]; color_id: string | null } | null {
  const wish = decodePriceRequestIntent(raw);
  if (!wish) return null;
  const wanted = new Set(wish.option_value_ids);
  const groups = relations?.option_groups ?? [];
  const option_value_ids = groups.length
    ? groups.flatMap((g) => {
        const hit = g.values.find((v) => wanted.has(v.id));
        return hit ? [hit.id] : [];
      })
    : (product.options ?? []).filter((o) => wanted.has(o.id)).slice(0, 1).map((o) => o.id);
  const color_id = wish.color_id && (product.colors ?? []).some((c) => c.id === wish.color_id) ? wish.color_id : null;
  return option_value_ids.length || color_id ? { option_value_ids, color_id } : null;
}

/**
 * `?v=` FOLLOWS THE SELECTION WITHOUT A NAVIGATION. Once a link opened the
 * page, a later choice rewrites the parameter in place, so a reload or a
 * shared address opens what is on screen. It is written with
 * `history.replaceState` over the entry the router already holds (its state,
 * and so its `key`, kept), never with `navigate`: a router navigation, even a
 * replace, hands out a new location key, and the shell scrolls
 * `#main-scroll-container` to the top on every new key (src/App.tsx), so each
 * option tap on a product opened from search would jump to the top. The
 * current address is read from the window, not from the router, which does
 * not see this write. An address without `?v=` is left alone: a page not
 * opened from a link never grows one. Returns the address written, or null.
 */
export function followSelectionInAddress(
  selectionKey: string,
  w: { location: { href: string }; history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void } } = window
): string | null {
  const url = new URL(w.location.href);
  if (!url.searchParams.has(VARIANT_PARAM) || url.searchParams.get(VARIANT_PARAM) === selectionKey) return null;
  if (selectionKey) url.searchParams.set(VARIANT_PARAM, selectionKey);
  else url.searchParams.delete(VARIANT_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  w.history.replaceState(w.history.state, '', next);
  return next;
}

/** The `?v=` the WINDOW shows now (null when none): what followSelectionInAddress last wrote, or a navigation since. */
export function shownVariant(w: { location: { href: string } } = window): string | null {
  return new URL(w.location.href).searchParams.get(VARIANT_PARAM);
}

/**
 * WHEN THE PRODUCT PAGE APPLIES A `?v=` LINK: once per product, link and
 * NAVIGATION, and only while the window still shows it. `token` is the last
 * one handled (the page keeps it in a ref); `key` is the router location key.
 *   - The key is part of the token: after a choice rewrote `?v=` in place, a
 *     second tap on the same search result is a router REPLACE to the same
 *     search, so only its new key says it happened, and the link is applied
 *     again (keyed on the search alone it never was).
 *   - A router entry whose `?v=` a later choice has already rewritten (the
 *     window shows the choice, not the entry) is an old address, never applied
 *     over what is on screen.
 */
export function linkArrival(
  token: string,
  at: { slug: string; raw: string | null; key: string },
  w: { location: { href: string } } = window
): { token: string; apply: boolean } {
  if (!at.raw) return { token, apply: false };
  const next = `${at.slug}|${at.raw}|${at.key}`;
  if (next === token) return { token, apply: false };
  return { token: next, apply: shownVariant(w) === at.raw };
}

/**
 * The address a consumed parameter (`?alert=`, `?price_request=`) leaves, for
 * the router REPLACE that drops it: path, the other parameters and the hash.
 * Built from the WINDOW, never from the router location: `?v=` follows the
 * selection in place, so the router still holds the address the page opened
 * with, and a replace built from it would bring a stale `?v=` back over the
 * choice on screen (and re-arm the link with it). Null when the window does not
 * carry the parameter.
 */
export function addressWithout(param: string, w: { location: { href: string } } = window): string | null {
  const url = new URL(w.location.href);
  if (!url.searchParams.has(param)) return null;
  url.searchParams.delete(param);
  return `${url.pathname}${url.search}${url.hash}`;
}
