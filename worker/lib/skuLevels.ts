/**
 * THE SKU RUNG, READ WHERE THE STOREFRONT SHOWS ONE PRICE (FX-7 gaps, migration
 * 0183; DECISIONS row 184 (1): product → option → colour → SKU).
 *
 * The cart, checkout, product page quote, bundles and trade-in pass a line's
 * WHOLE selection to `resolveUnitPrice`, so a SKU of a product priced per colour
 * or variant is charged its own engine price. A screen that shows ONE figure for
 * a product or for one of its models — the listing card, the comparison column,
 * the printer finder — has no selection to pass: resolved with a model alone, a
 * product with a second option group (or colours priced one by one) answers the
 * ladder beneath the rung, which the engine keeps at the HIGHEST of the model's
 * SKUs (the rollback safety of 0183). So those screens price every SKU the rung
 * names, exactly as the cart would, and show the LOWEST as a «يبدأ من» figure —
 * the same rule the card already applies across a product's options and
 * colours (`display_from`).
 *
 * WHAT A SKU LEVEL IS: one distinct `combo_key` of the document's `sku_prices`
 * whose every option value and colour is still on the document (an option or a
 * colour switched off since the engine wrote its row is not sellable), its
 * option values in relation order — the model first, the one the cart prices a
 * line from — and the line its single figure is read on: the direct line when
 * the SKU has a `direct_sale` row (what every level of the card resolves), else
 * its cheapest pre-order route, prepaid.
 *
 * Pure: no I/O. A product priced per model, a database without 0183 and an
 * admin projection carry no `sku_prices`, and get no level here — every caller
 * then answers exactly as before.
 */
import { parseSkuComboKey, routeOfChannel, isSkuChannel, type PreorderRoute } from '@levonis/pricing/skuChannel';
import type { SkuPriceRow } from './pricing';
import { optionValueIdsInRelationOrder } from './cartSelectionIdentity';

export interface SkuLevelSelection {
  combo_key: string;
  /** The model: the first value in relation order (null for a colour-only product). */
  option_id: string | null;
  /** Every option value of the SKU, relation order, the model first. */
  option_value_ids: string[];
  color_id: string | null;
  /** The route its single figure is read on; null = the direct line. */
  transport_method: PreorderRoute | null;
}

interface SkuLevelDoc {
  options: ReadonlyArray<{ id: string; active?: boolean | null; merged_into?: string | null }>;
  colors: ReadonlyArray<{ id: string; active?: boolean | null }>;
  sku_prices?: readonly SkuPriceRow[] | null;
}

type RelationOrder = Parameters<typeof optionValueIdsInRelationOrder>[1];

/**
 * The SKUs the document's rung names, at most one per combo key, in the rows'
 * order. Empty when the product has no SKU row.
 */
export function skuLevelSelections(doc: SkuLevelDoc, relations?: RelationOrder): SkuLevelSelection[] {
  const rows = doc.sku_prices;
  if (!rows || !rows.length) return [];
  const liveOption = new Set(doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));
  const liveColour = new Set(doc.colors.filter((c) => c.active !== false).map((c) => c.id));
  const byKey = new Map<string, SkuPriceRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.combo_key);
    if (list) list.push(r);
    else byKey.set(r.combo_key, [r]);
  }
  const out: SkuLevelSelection[] = [];
  for (const [key, list] of byKey) {
    const sel = parseSkuComboKey(key);
    if (!sel || (!sel.option_value_ids.length && !sel.color_id)) continue;
    if (sel.option_value_ids.some((id) => !liveOption.has(id))) continue;
    if (sel.color_id && !liveColour.has(sel.color_id)) continue;
    let transport: PreorderRoute | null = null;
    if (!list.some((r) => r.channel === 'direct_sale')) {
      let best: { route: PreorderRoute; price: number } | null = null;
      for (const r of list) {
        if (!isSkuChannel(r.channel)) continue;
        const route = routeOfChannel(r.channel);
        if (route && (!best || r.regular_price_iqd < best.price)) best = { route, price: r.regular_price_iqd };
      }
      if (!best) continue;
      transport = best.route;
    }
    const ids = relations ? optionValueIdsInRelationOrder(sel.option_value_ids, relations) : sel.option_value_ids;
    out.push({ combo_key: key, option_id: ids[0] ?? null, option_value_ids: ids, color_id: sel.color_id, transport_method: transport });
  }
  return out;
}

/** The resolver's selection fields for one SKU level (the cart's own call for that line). */
export function skuLevelResolveInput(s: SkuLevelSelection): {
  optionId: string | null;
  optionValueIds: string[];
  colorId: string | null;
  transportMethod: string | null;
  fulfillmentType?: 'pre_order';
} {
  return {
    optionId: s.option_id,
    optionValueIds: s.option_value_ids,
    colorId: s.color_id,
    transportMethod: s.transport_method,
    ...(s.transport_method ? { fulfillmentType: 'pre_order' as const } : {}),
  };
}
