/**
 * A PRODUCT'S PRICE STATE AS A CUSTOMER READS IT (DECISIONS rows 239 (3) and 240).
 *
 * Every customer projection carries `price_status`: `priced` (shown with the
 * server's final numbers, and sold) or `unpriced` (the catalog-only state:
 * shown with «السعر غير متوفر حالياً» and NO number — never 0, never the
 * archived dinar ladder, never a stock claim). The state is decided by the
 * SELLABLE predicate (worker/lib/listing.ts), never by a row's money columns:
 * migration 0190 left every old product's legacy prices in its row, and a
 * projection that looked at them would publish the archive.
 *
 * PER SKU. A V2 product whose engine priced some SKUs and not others (a colour
 * added after publication) is sellable, and each unpriced selection is shown
 * and requested on its own: it never inherits another SKU's price. The strict
 * resolver already refuses such a line (`VARIANT_UNAVAILABLE`); these helpers
 * let the page and the card say so before the tap.
 *
 * Pure: no I/O.
 */
import { skuComboKey } from '@levonis/pricing/skuChannel';
import type { SkuPriceRow } from './pricing';
import type { ProductDoc } from './productModel';
import type { ProductRelationsView } from './productOverlay';
import { sellableSkus } from './pricingEngine/legacy';
import { validateSelection } from './productRelations';

export type PriceStatus = 'priced' | 'unpriced';

export const priceStatusOf = (sellable: boolean): PriceStatus => (sellable ? 'priced' : 'unpriced');

/** A row read with `… AS sellable_now` (worker/lib/listing.ts): 1 = sellable. Absent reads as sellable only where the caller says so. */
export const sellableNowOf = (row: Record<string, unknown> | null | undefined, absent = false): boolean => {
  if (!row || row.sellable_now === undefined || row.sellable_now === null) return absent;
  return Number(row.sellable_now) === 1;
};

/**
 * A `products` row's own base price, ONLY when the row was read SELLABLE
 * (`sellable_now = 1`) — null otherwise: never 0, never a catalog-only
 * product's archived dinar figure. The one sanctioned raw read of a row's
 * price on a VISIBLE surface (tests/listingPredicateGuard.test.ts).
 */
export function rowPriceIfSellable(row: { price_iqd?: unknown; sellable_now?: unknown } | null | undefined): number | null {
  if (!row || Number(row.sellable_now) !== 1) return null;
  const n = Number(row.price_iqd);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A V2 document's SKU priced on SOME channel: a live `product_sku_prices` row
 * (`doc.sku_prices`, after the overlay). A document that is not strict (not a
 * V2 product's, or an older database) answers true: the resolver prices it as
 * before and the product-level state decides.
 */
export function skuPriced(doc: { sku_strict?: true; sku_prices?: readonly SkuPriceRow[] | null }, comboKey: string): boolean {
  if (doc.sku_strict !== true) return true;
  const rows = doc.sku_prices ?? [];
  return rows.some((r) => r.combo_key === comboKey);
}

/** The canonical key of a selection (the cart's, the engine's and the overlay's). */
export const selectionKey = (optionValueIds: readonly string[], colorId: string | null | undefined): string =>
  skuComboKey({ option_value_ids: [...optionValueIds], color_id: colorId ?? null });

/**
 * The structurally sellable SKUs (the V2 writer's own universe, `sellableSkus`)
 * with no live price row. Empty unless the document is strict; empty too when
 * the grid overflows (the quote then decides per selection).
 */
export function unpricedSkuKeys(doc: ProductDoc, view: ProductRelationsView | undefined): string[] {
  if (doc.sku_strict !== true) return [];
  const { skus, overflow } = sellableSkus(doc, view);
  if (overflow) return [];
  const priced = new Set((doc.sku_prices ?? []).map((r) => r.combo_key));
  const out: string[] = [];
  for (const s of skus) if (!priced.has(s.combo_key) && !out.includes(s.combo_key)) out.push(s.combo_key);
  return out;
}

// ------------------------------------------------------------- the selection, checked on the server
// (the quote's per-SKU answer and «طلب السعر» share it: worker/routes/products.ts, worker/routes/priceRequests.ts)

export type SelectionRefusal = 'PRICE_REQUEST_SELECTION_REQUIRED' | 'PRICE_REQUEST_SELECTION_INVALID';
export type SelectionCheck =
  | { ok: true; key: string; optionValueIds: string[]; colorId: string | null }
  | { ok: false; code: SelectionRefusal };

const REQUIRED_ERRORS = new Set(['OPTION_GROUP_REQUIRED', 'COLOR_REQUIRED']);

/**
 * THE SELECTION, CHECKED ON THE SERVER against the product's real options,
 * colours and combinations — never trusted from the client.
 *
 * A selection is valid when it names one of the product's structurally
 * sellable SKUs (`sellableSkus`, the V2 writer's own universe: active,
 * unmerged values, one per active group, a colour visible for them). A
 * selection that is PART of one (a required group or colour not chosen yet)
 * is `SELECTION_REQUIRED`; anything else — an unknown, inactive or merged
 * value, an inactive colour, a colour not sold with that option — is
 * `SELECTION_INVALID`. When the grid is too large to list, the relational
 * validator decides instead.
 */
export function checkSelection(
  doc: ProductDoc,
  view: ProductRelationsView | undefined,
  optionValueIds: readonly string[],
  colorId: string | null
): SelectionCheck {
  const ids = [...new Set(optionValueIds.filter((x) => typeof x === 'string' && x.length > 0))];
  const key = skuComboKey({ option_value_ids: ids, color_id: colorId });
  const { skus, overflow } = sellableSkus(doc, view);
  if (!overflow) {
    if (skus.some((s) => s.combo_key === key)) return { ok: true, key, optionValueIds: ids, colorId };
    const partOf = skus.some(
      (s) => ids.every((id) => s.option_value_ids.includes(id)) && (colorId === null || s.color?.id === colorId)
    );
    return { ok: false, code: partOf ? 'PRICE_REQUEST_SELECTION_REQUIRED' : 'PRICE_REQUEST_SELECTION_INVALID' };
  }
  // A grid past ENGINE_MAX_SKUS: the cart's own validator answers.
  const live = new Set(doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));
  if (ids.some((id) => !live.has(id))) return { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' };
  if (colorId && !doc.colors.some((c) => c.id === colorId && c.active !== false)) return { ok: false, code: 'PRICE_REQUEST_SELECTION_INVALID' };
  if (view && view.has_relations) {
    const errors = validateSelection({
      groups: view.groups,
      values: view.values,
      colors: view.colors,
      links: view.links,
      selectedValueIds: ids,
      selectedColorId: colorId,
    });
    if (errors.length) {
      return { ok: false, code: errors.every((e) => REQUIRED_ERRORS.has(e)) ? 'PRICE_REQUEST_SELECTION_REQUIRED' : 'PRICE_REQUEST_SELECTION_INVALID' };
    }
  }
  return { ok: true, key, optionValueIds: ids, colorId };
}
