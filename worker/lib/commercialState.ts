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
import { parseSkuComboKey, skuComboKey } from '@levonis/pricing/skuChannel';
import type { SkuPriceRow } from './pricing';
import type { ProductDoc } from './productModel';
import type { ProductRelationsView } from './productOverlay';
import { sellableSkus } from './pricingEngine/legacy';
import { validateSelection } from './productRelations';
import { skuLevelSelections } from './skuLevels';

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

// ------------------------------------------------------------- the estimate label
// (docs/SMART_PRICING.md §5.1–5.2; migration 0218; DECISIONS rows 278 and 281)
//
// An ESTIMATED price is an ordinary priced SKU — `price_status` stays binary —
// whose product the owner has not yet confirmed against the supplier. The label
// lives on the product row the price is read with (`products.price_estimate`,
// parsed by `parseProductRow` only when it is 1), and the owner may make single
// SKUs firm (`price_estimate_firm_skus`, read by the overlay into `sku_firm`).
//
// FAIL CLOSED, AND ONLY FOR LABELLED PRODUCTS (I2): a document whose firm list
// could not be read carries no `sku_firm`, so every priced SKU of a labelled
// product is an estimate; an unlabelled product is never one, whatever was read.
// A boolean and a list of keys: no figure, source or flag ever rides along (I6).

/** The two document fields the label reads. */
export type EstimateLabelled = { price_estimate?: true; sku_firm?: readonly string[] };

/** Is this SKU's price an estimate? Its product is labelled and the owner has not made this very SKU firm. */
export function skuEstimated(doc: EstimateLabelled, comboKey: string): boolean {
  return doc.price_estimate === true && !(doc.sku_firm ?? []).includes(comboKey);
}

/**
 * Is ANY priced SKU of this product an estimate — the card's label («سعر تقديري»)? The priced SKUs are the
 * live price rows of a strict (V2) document (`skuPriced`); a document whose rows are not known (not strict,
 * no row read) cannot prove any SKU firm, so a labelled one is labelled.
 */
export function productEstimated(doc: EstimateLabelled & { sku_strict?: true; sku_prices?: readonly SkuPriceRow[] | null }): boolean {
  if (doc.price_estimate !== true) return false;
  const firm = doc.sku_firm ?? [];
  if (firm.length === 0 || doc.sku_strict !== true) return true;
  const rows = doc.sku_prices ?? [];
  return rows.length === 0 || rows.some((r) => !firm.includes(r.combo_key));
}

/**
 * The label of a SELECTION, as the product page and the quote state it. A selection that names a priced SKU
 * carries that SKU's own label (`skuEstimated`). One that names none yet — nothing or part of it chosen — is
 * labelled while any priced SKU that could finish it is an estimate, so it is never labelled once all of
 * them are firm; with no such SKU known (not strict, nothing read) it answers as the product (fail closed).
 */
export function selectionEstimated(
  doc: EstimateLabelled & { sku_strict?: true; sku_prices?: readonly SkuPriceRow[] | null },
  optionValueIds: readonly string[],
  colorId: string | null | undefined
): boolean {
  if (doc.price_estimate !== true) return false;
  const key = selectionKey(optionValueIds, colorId);
  const rows = doc.sku_strict === true ? (doc.sku_prices ?? []) : [];
  if (rows.some((r) => r.combo_key === key)) return skuEstimated(doc, key);
  const ids = [...new Set(optionValueIds.filter(Boolean))];
  const finishing = rows.filter((r) => {
    const sku = parseSkuComboKey(r.combo_key);
    return sku !== null && ids.every((id) => sku.option_value_ids.includes(id)) && (!colorId || sku.color_id === colorId);
  });
  return finishing.length === 0 ? productEstimated(doc) : finishing.some((r) => skuEstimated(doc, r.combo_key));
}

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

/**
 * THE COMBINATIONS A PRODUCT DOES NOT SELL (review r2-quote): the cells of a
 * VARIANT_COMBINATION product's grid that `sellableSkus` leaves out — no
 * active variant row, while each of their choices is stocked in another
 * combination. The cart refuses them (VARIANT_NOT_MODELLED) and so does
 * «طلب السعر» (SELECTION_INVALID), so the quote and the page answer them
 * «not available», never «طلب السعر». Empty for every other product: another
 * mode, a grid with a row for every cell, no active row — and for a grid past
 * ENGINE_MAX_SKUS, which is not listed: the page reads `offeredPastLimitKeys`
 * there, and `selectionUnoffered` still answers such a grid with relations
 * (one without relations answers false, see there).
 */
export function unofferedSkuKeys(doc: ProductDoc, view: ProductRelationsView | undefined): string[] {
  if (!view || view.inventory_mode !== 'VARIANT_COMBINATION') return [];
  const sold = sellableSkus(doc, view);
  if (sold.overflow) return [];
  // The whole grid: the same cells with no variant row read (`sellableSkus` then leaves none out).
  const whole = sellableSkus(doc, { ...view, variants: [] });
  if (whole.overflow || whole.skus.length === sold.skus.length) return [];
  const kept = new Set(sold.skus.map((s) => s.combo_key));
  const out: string[] = [];
  for (const s of whole.skus) if (!kept.has(s.combo_key) && !out.includes(s.combo_key)) out.push(s.combo_key);
  return out;
}

/**
 * THE SKUS A PRODUCT SELLS, WHERE THOSE COMBINATIONS ARE NOT LISTED (review
 * r3-unoffered-large): a VARIANT_COMBINATION grid past ENGINE_MAX_SKUS that
 * `sellableSkus` still counts on the cells it keeps (at most ENGINE_MAX_SKUS of
 * them). The selection check answers from exactly these, so a selection that
 * is part of none of them is refused by the cart and by «طلب السعر». Empty for
 * every other product: another mode, a grid `unofferedSkuKeys` covers, or one
 * too large to count.
 */
export function offeredPastLimitKeys(doc: ProductDoc, view: ProductRelationsView | undefined): string[] {
  if (!view || view.inventory_mode !== 'VARIANT_COMBINATION') return [];
  const sold = sellableSkus(doc, view);
  if (sold.overflow || !sellableSkus(doc, { ...view, variants: [] }).overflow) return [];
  return [...new Set(sold.skus.map((s) => s.combo_key))];
}

/**
 * Does this selection name one of those combinations? It is a complete cell of
 * the grid (the selection check passes with no variant row read) that is not a
 * SKU the product sells, nor a part of one. Any grid size; false for every
 * other product, and for a grid without relations too large to list (its
 * check cannot tell a whole cell from a part of one there).
 */
export function selectionUnoffered(
  doc: ProductDoc,
  view: ProductRelationsView | undefined,
  optionValueIds: readonly string[],
  colorId: string | null
): boolean {
  if (!view || view.inventory_mode !== 'VARIANT_COMBINATION') return false;
  const sold = checkSelection(doc, view, optionValueIds, colorId);
  if (sold.ok || sold.code === 'PRICE_REQUEST_SELECTION_REQUIRED') return false;
  const whole = { ...view, variants: [] };
  if (!view.has_relations && sellableSkus(doc, whole).overflow) return false;
  return checkSelection(doc, whole, optionValueIds, colorId).ok;
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

/**
 * THE SELECTION NAMES A CHOICE NO PRICED SKU CARRIES (DECISIONS row 240): a
 * live option value or colour that is part of no SKU with a price row, so
 * every way to finish the selection is unpriced and no figure may stand for
 * it — the test `partialPriceLevels` paints its null levels with, and the page
 * mirrors (`choiceUnpriced`). False on a document that is not strict, and for
 * an id the document does not carry live (the resolver's own errors answer
 * that).
 */
export function namesUnpricedChoice(
  doc: ProductDoc,
  view: ProductRelationsView | undefined,
  optionValueIds: readonly string[],
  colorId: string | null
): boolean {
  if (doc.sku_strict !== true) return false;
  const priced = skuLevelSelections(doc, view);
  const liveOption = new Set(doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));
  if (optionValueIds.some((id) => liveOption.has(id) && !priced.some((sku) => sku.option_value_ids.includes(id)))) return true;
  if (!colorId || !doc.colors.some((c) => c.id === colorId && c.active !== false)) return false;
  return !priced.some((sku) => sku.color_id === colorId);
}
