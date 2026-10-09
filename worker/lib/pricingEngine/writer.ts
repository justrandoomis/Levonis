/**
 * THE ENGINE'S WRITER, PURE PART: engine prices → the price fields the
 * storefront already reads, and the exact check that the live resolver reads
 * them back (MVP plan §5 "What the switch writes", "Before the batch: the
 * exact check"; USD design §2.4; owner brief 2026-10-09 §5, §9: the
 * storefront never recomputes — it reads the stored final price).
 *
 * The MVP writer rules, per model (an option value of the product's one
 * option group, or the product itself when it has none):
 *   - each enabled route row (`product_option_transports`) on the model's
 *     pre-order cell: `regular_price_iqd` = the engine's pre-order price of
 *     that route; `surcharge_iqd` = 0; member prices and adjustments NULL;
 *   - the enabled direct cell: the engine's direct price (pre-order base on the
 *     default profile + Direct Sale Extra); member prices and adjustments NULL;
 *   - the enabled pre-order cell: the maximum of its routes' prices;
 *   - the option row: the maximum over its priced channels;
 *   - `products`: `price_iqd` = the minimum of every written price; member
 *     prices and `direct_surcharge_iqd` NULL; every `commission_iqd` in
 *     `preorder_transports` 0 (the route fee is folded into the price — the
 *     owner's preview says "route fee removed").
 * No cost column, no stock, no capacity, no lead time is ever written.
 *
 * A SHAPE THE FIELDS CANNOT CARRY IS REFUSED, never approximated: a colour or
 * a variant that states its own price, a second option group, options with no
 * relational rows. And whatever the plan, `verifyPlan` re-runs the cart's own
 * resolver on the document as it would be after the write — every model ×
 * channel, prepaid and cash on delivery — and any figure that is not the
 * engine's is RESOLVER_MISMATCH: nothing is written.
 *
 * Pure: no I/O. The batch is built by engineWrite.ts.
 */
import { resolveUnitPrice } from '../pricing';
import type { ChannelPrice } from '@levonis/pricing/costToPrice';
import { PREORDER_ROUTES, routeOfChannel, skuComboKey, type SkuChannel } from '@levonis/pricing/skuChannel';
import { applyRelations, type ProductRelationsView } from '../productOverlay';
import { parseProductRow } from '../productModel';
import { memberFallbackFor, type PricingContext } from '../../routes/cart';
import { modelsOf, observeModel, type LegacyEvaluation } from './legacy';
import type { LoadedProduct } from './load';
import type { PricedModel } from './procurementPreview';

/** One engine price of one model × channel, as written. */
export interface PlannedPrice {
  option_id: string;
  combo_key: string;
  channel: SkuChannel;
  price: ChannelPrice;
}

export interface PricePlan {
  ok: boolean;
  /** Why the shape cannot be written (pricing issue codes), sorted. */
  codes: string[];
  product: { price_iqd: number; preorder_transports: string | null } | null;
  values: Array<{ id: string; price: number }>;
  cells: Array<{ id: string; price: number }>;
  routes: Array<{ id: string; price: number }>;
  prices: PlannedPrice[];
}

const present = (v: unknown) => v !== null && v !== undefined;
const truthy = (v: unknown) => v === true || v === 1 || v === '1';

/** A price-carrying colour or variant, a second option group, options without rows: the fields cannot carry the engine's prices. */
export function shapeProblems(loaded: LoadedProduct, legacy: LegacyEvaluation): string[] {
  const out = new Set<string>();
  const view = loaded.view;
  if (legacy.option_groups > 1) out.add('PRICE_SHAPE_UNSUPPORTED');
  const activeOptions = loaded.doc.options.filter((o) => o.active !== false && !o.merged_into);
  if (activeOptions.length && !view?.has_relations) out.add('RELATIONS_REQUIRED');
  for (const c of view?.colors ?? []) {
    if (!truthy(c.active)) continue;
    if ([c.regular_price_iqd, c.prime_price_iqd, c.pro_price_iqd, c.regular_adjust_iqd, c.prime_adjust_iqd, c.pro_adjust_iqd].some(present)) out.add('PRICE_SHAPE_UNSUPPORTED');
  }
  for (const v of view?.variants ?? []) {
    if (v.active === 0) continue;
    if ([v.regular_price_iqd, v.prime_price_iqd, v.pro_price_iqd].some(present)) out.add('PRICE_SHAPE_UNSUPPORTED');
  }
  return [...out].sort();
}

/** The engine's prices of every model × channel sold today → the row writes (see the file header). */
export function planWrites(loaded: LoadedProduct, legacy: LegacyEvaluation, models: readonly PricedModel[]): PricePlan {
  const codes = new Set(shapeProblems(loaded, legacy));
  const prices: PlannedPrice[] = [];
  for (const m of models) {
    const sold = m.channels.filter((c) => c.ok).map((c) => c.channel);
    if (!sold.length) continue;
    if (!m.result || !m.result.ok) {
      codes.add('PRICE_INVALID');
      continue;
    }
    for (const channel of sold) {
      const price = m.result.channels.find((c) => c.channel === channel);
      if (!price) {
        codes.add('PRICE_INVALID');
        continue;
      }
      prices.push({ option_id: m.option_id, combo_key: skuComboKey({ option_value_ids: m.option_id ? [m.option_id] : [], color_id: null }), channel, price });
    }
  }
  if (!prices.length) codes.add('PRICE_INVALID');
  const empty: PricePlan = { ok: false, codes: [...codes].sort(), product: null, values: [], cells: [], routes: [], prices };
  if (codes.size) return empty;

  const view = loaded.view;
  const values: PricePlan['values'] = [];
  const cells: PricePlan['cells'] = [];
  const routes: PricePlan['routes'] = [];
  const byModel = new Map<string, PlannedPrice[]>();
  for (const p of prices) byModel.set(p.option_id, [...(byModel.get(p.option_id) ?? []), p]);
  for (const [optionId, list] of byModel) {
    if (!optionId) continue;
    const priceOf = (ch: SkuChannel) => list.find((p) => p.channel === ch)?.price.computed_price_iqd ?? null;
    const fulfillments = (view?.fulfillments ?? []).filter((f) => f.option_id === optionId);
    const directCell = fulfillments.find((f) => f.fulfillment_type === 'direct_sale' && truthy(f.enabled)) ?? null;
    const preCell = fulfillments.find((f) => f.fulfillment_type === 'pre_order' && truthy(f.enabled)) ?? null;
    const direct = priceOf('direct_sale');
    if (directCell && direct !== null) cells.push({ id: directCell.id, price: direct });
    const preorderPrices: number[] = [];
    for (const route of PREORDER_ROUTES) {
      const p = priceOf(`pre_order_${route}`);
      if (p === null) continue;
      preorderPrices.push(p);
      const row = preCell ? (view?.transports ?? []).find((t) => t.fulfillment_id === preCell.id && t.method === route && truthy(t.enabled)) : null;
      if (row) routes.push({ id: row.id, price: p });
    }
    if (preCell && preorderPrices.length) cells.push({ id: preCell.id, price: Math.max(...preorderPrices) });
    values.push({ id: optionId, price: Math.max(...list.map((p) => p.price.computed_price_iqd)) });
  }
  const all = prices.map((p) => p.price.computed_price_iqd);
  return {
    ok: true,
    codes: [],
    product: { price_iqd: Math.min(...all), preorder_transports: zeroCommissions(loaded.row.preorder_transports) },
    values,
    cells,
    routes,
    prices,
  };
}

/** The product's route list with every commission at 0 (other keys kept); null when it is not a JSON list. */
function zeroCommissions(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return null;
    if (!list.some((t) => t && typeof t === 'object' && (t as Record<string, unknown>).commission_iqd !== 0)) return raw;
    return JSON.stringify(list.map((t) => (t && typeof t === 'object' && !Array.isArray(t) ? { ...(t as Record<string, unknown>), commission_iqd: 0 } : t)));
  } catch {
    return null;
  }
}

const MEMBER_CLEARED = {
  prime_price_iqd: null,
  pro_price_iqd: null,
  regular_adjust_iqd: null,
  prime_adjust_iqd: null,
  pro_adjust_iqd: null,
};

/** The product's row and relations as they would be after the plan (an in-memory copy). */
export function documentAfter(loaded: LoadedProduct, plan: PricePlan) {
  const row: Record<string, unknown> = { ...loaded.row };
  if (plan.product) {
    row.price_iqd = plan.product.price_iqd;
    row.prime_price_iqd = null;
    row.pro_price_iqd = null;
    row.direct_surcharge_iqd = null;
    if (plan.product.preorder_transports !== null) row.preorder_transports = plan.product.preorder_transports;
  }
  const at = <T extends { id: string }>(list: ReadonlyArray<{ id: string; price: number }>, r: T) => list.find((x) => x.id === r.id);
  const view: ProductRelationsView | undefined = loaded.view
    ? {
        ...loaded.view,
        values: loaded.view.values.map((v) => {
          const w = at(plan.values, v);
          return w ? { ...v, ...MEMBER_CLEARED, regular_price_iqd: w.price } : v;
        }),
        fulfillments: loaded.view.fulfillments.map((f) => {
          const w = at(plan.cells, f);
          return w ? { ...f, ...MEMBER_CLEARED, regular_price_iqd: w.price } : f;
        }),
        transports: loaded.view.transports.map((t) => {
          const w = at(plan.routes, t);
          return w ? { ...t, ...MEMBER_CLEARED, regular_price_iqd: w.price, surcharge_iqd: 0 } : t;
        }),
      }
    : undefined;
  const parsed = parseProductRow(row);
  const doc = view ? applyRelations(parsed, view) : parsed;
  return { row, view, doc };
}

/** PRO and PRIME (the guest context: typed member prices and the fee waivers only) of one channel. */
function tierUnits(doc: ReturnType<typeof parseProductRow>, optionId: string, channel: SkuChannel, ctx: PricingContext) {
  const option = optionId ? (doc.options.find((o) => o.id === optionId) ?? null) : null;
  const route = routeOfChannel(channel);
  const at = (tier: 'pro' | 'prime') => {
    const r = resolveUnitPrice({
      product: doc,
      optionId: option?.id ?? null,
      colorId: null,
      transportMethod: route,
      fulfillmentType: route ? 'pre_order' : 'direct_sale',
      warrantyPlanId: null,
      tier,
      tierActive: true,
      proPolicy: ctx.proPolicy,
      memberFallback: memberFallbackFor(ctx, doc),
      transportDefaults: ctx.transportDefaults,
      preorderPricing: 'prepaid',
      isPrinter: false,
    });
    return r.errors.length ? null : r.unit_subtotal_iqd;
  };
  return { pro: at('pro'), prime: at('prime') };
}

export interface VerifiedRow {
  option_id: string;
  channel: SkuChannel;
  pro_before_iqd: number | null;
  pro_after_iqd: number | null;
  prime_before_iqd: number | null;
  prime_after_iqd: number | null;
}

export interface Verification {
  ok: boolean;
  /** model:channel of every figure the resolver does not read back. */
  mismatches: string[];
  rows: VerifiedRow[];
}

/**
 * THE EXACT CHECK (MVP §5): on the document as it would be after the plan,
 * for every model × channel sold today, the cart's resolver must charge a
 * prepaid guest exactly the engine price (item = price, no route fee, no
 * Direct Sale Extra on top), cash on delivery the direct price when the model sells
 * direct (the resolver's COD rule, USD design §2.3) and the channel's own price
 * otherwise, and the same set of channels must stay on sale.
 */
export function verifyPlan(loaded: LoadedProduct, legacy: LegacyEvaluation, plan: PricePlan, ctx: PricingContext): Verification {
  if (!plan.ok) return { ok: false, mismatches: ['plan'], rows: [] };
  const after = documentAfter(loaded, plan);
  const { models } = modelsOf(after.doc, after.view);
  const mismatches: string[] = [];
  const rows: VerifiedRow[] = [];
  for (const before of legacy.models) {
    const option = before.option_id ? (models.find((o) => o?.id === before.option_id) ?? null) : null;
    if (before.option_id && !option) {
      mismatches.push(`${before.option_id}:model`);
      continue;
    }
    const observed = observeModel(after.doc, option, ctx);
    const soldBefore = before.channels.filter((c) => c.ok).map((c) => c.channel).sort();
    const soldAfter = observed.channels.filter((c) => c.ok).map((c) => c.channel).sort();
    if (soldBefore.join(',') !== soldAfter.join(',')) mismatches.push(`${before.option_id}:channels`);
    const priceOf = (ch: SkuChannel) => plan.prices.find((p) => p.option_id === before.option_id && p.channel === ch)?.price.computed_price_iqd ?? null;
    const direct = priceOf('direct_sale');
    // The resolver's COD rule (pricing.ts): a pre-order paid at the door is priced from an ENABLED direct cell.
    const directCell = (option?.fulfillments ?? []).some((f) => f.fulfillment_type === 'direct_sale' && f.enabled !== false);
    for (const c of observed.channels.filter((x) => x.ok)) {
      const engine = priceOf(c.channel);
      const key = `${before.option_id}:${c.channel}`;
      if (engine === null) {
        mismatches.push(key);
        continue;
      }
      if (c.item_iqd !== engine || c.prepaid_iqd !== engine || (c.fee_iqd ?? 0) !== 0) mismatches.push(`${key}:prepaid`);
      const codExpected = c.route !== null && directCell ? direct : engine;
      if (codExpected === null || c.cod_iqd !== codExpected) mismatches.push(`${key}:cod`);
      if (engine < 1000) mismatches.push(`${key}:floor`);
      const tiersBefore = tierUnits(loaded.doc, before.option_id, c.channel, ctx);
      const tiersAfter = tierUnits(after.doc, before.option_id, c.channel, ctx);
      rows.push({
        option_id: before.option_id,
        channel: c.channel,
        pro_before_iqd: tiersBefore.pro,
        pro_after_iqd: tiersAfter.pro,
        prime_before_iqd: tiersBefore.prime,
        prime_after_iqd: tiersAfter.prime,
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches, rows };
}
