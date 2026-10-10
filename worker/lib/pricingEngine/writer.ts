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
 * PER COLOUR AND VARIANT (FX-7, migration 0183). A product whose colours or
 * variants carry their own inputs or rules, or that has a second option group,
 * is priced per SKU: every sellable SKU × channel gets its own engine price,
 * written to `product_sku_prices` — the resolver's last rung, after the colour
 * — and the ladder beneath keeps every model's route rows, cells and option row
 * at the HIGHEST of its SKUs, with the colour rows' prices cleared, so a Worker
 * that ignores the table (an older commit) never charges a SKU less than its
 * price. The variant rows mirror their SKU's direct price (the purchase
 * screens' selection price reads them; the cart never does).
 *
 * A SHAPE THE FIELDS CANNOT CARRY IS REFUSED, never approximated: options with
 * no relational rows (RELATIONS_REQUIRED), more SKUs than the engine prices
 * (SKU_GRID_TOO_LARGE) and — on a database without 0183 only — a colour or a
 * variant that states its own price or a second option group
 * (PRICE_SHAPE_UNSUPPORTED, exactly as before FX-7). And whatever the plan,
 * `verifyPlan` re-runs the cart's own resolver on the document as it would be
 * after the write — every model or SKU × channel, prepaid and cash on
 * delivery, and, priced per SKU, the same resolver without the SKU rung — and
 * any figure that is not the engine's (or, without the rung, below it) is
 * RESOLVER_MISMATCH: nothing is written.
 *
 * Pure: no I/O. The batch is built by engineWrite.ts.
 */
import { resolveUnitPrice } from '../pricing';
import type { ChannelPrice } from '@levonis/pricing/costToPrice';
import { PREORDER_ROUTES, routeOfChannel, type SkuChannel } from '@levonis/pricing/skuChannel';
import { applyRelations, type ProductRelationsView } from '../productOverlay';
import { parseProductRow } from '../productModel';
import { memberFallbackFor, type PricingContext } from '../../routes/cart';
import { modelsOf, observeModel, unitColorId, unitComboKey, unitOptionIds, type LegacyEvaluation, type ModelToday, type SkuSelectionOf } from './legacy';
import type { LoadedProduct } from './load';
import type { PricedModel } from './procurementPreview';

/** One engine price of one model (or, priced per SKU, one SKU) × channel, as written. */
export interface PlannedPrice {
  /** The model (the option value the cart prices a line from); '' = the product itself. */
  option_id: string;
  /** The unit's key: the model's own, or the exact SKU's (FX-7). */
  combo_key: string;
  channel: SkuChannel;
  price: ChannelPrice;
  /** FX-7: the unit's whole selection (the model first) and its colour. */
  option_value_ids: string[];
  color_id: string | null;
}

export interface PricePlan {
  channel?: 'direct_sale';
  direct_surcharge_iqd?: number;
  ok: boolean;
  /** Why the shape cannot be written (pricing issue codes), sorted. */
  codes: string[];
  product: { price_iqd: number; preorder_transports: string | null } | null;
  values: Array<{ id: string; price: number }>;
  cells: Array<{ id: string; price: number }>;
  routes: Array<{ id: string; price: number }>;
  prices: PlannedPrice[];
  /** FX-7: the product is priced per SKU — its prices are the rows of `skus`. */
  per_sku: boolean;
  /** FX-7: the database has the SKU rung (0183): the product's SKU rows are replaced by `skus` (none when priced per model). */
  sku_table: boolean;
  /** FX-7: the product holds SKU rows today (they are deleted even when it returns to per-model pricing). */
  had_skus: boolean;
  skus: Array<{ combo_key: string; channel: SkuChannel; price: number }>;
  /** FX-7: colour rows whose price fields the write clears (a SKU's price is its own row now). */
  colors: string[];
  /** FX-7: variant rows' regular price — the SKU's direct price (else its highest), or null to clear a stray one. */
  variants: Array<{ id: string; price: number | null }>;
}

/** What the plan may write beyond the per-model fields (FX-7): is the SKU rung (0183) on this database. */
export interface PlanOptions {
  channel?: 'direct_sale';
  skuTable?: boolean;
}

const present = (v: unknown) => v !== null && v !== undefined;
const truthy = (v: unknown) => v === true || v === 1 || v === '1';

const colourStatesPrice = (c: { regular_price_iqd: unknown; prime_price_iqd: unknown; pro_price_iqd: unknown; regular_adjust_iqd?: unknown; prime_adjust_iqd?: unknown; pro_adjust_iqd?: unknown }) =>
  [c.regular_price_iqd, c.prime_price_iqd, c.pro_price_iqd, c.regular_adjust_iqd, c.prime_adjust_iqd, c.pro_adjust_iqd].some(present);
const variantStatesPrice = (v: { regular_price_iqd: unknown; prime_price_iqd: unknown; pro_price_iqd: unknown }) =>
  [v.regular_price_iqd, v.prime_price_iqd, v.pro_price_iqd].some(present);

/**
 * What keeps the engine's prices from being written exactly (see the file
 * header). Without the SKU rung (a database before 0183) the shapes are
 * today's: a price-carrying colour or variant, or a second option group, is
 * PRICE_SHAPE_UNSUPPORTED. With it, only options without relational rows and
 * an oversized SKU grid are refused.
 */
export function shapeProblems(loaded: LoadedProduct, legacy: LegacyEvaluation, opts: PlanOptions = {}): string[] {
  const out = new Set<string>();
  const view = loaded.view;
  const activeOptions = loaded.doc.options.filter((o) => o.active !== false && !o.merged_into);
  if (activeOptions.length && !view?.has_relations) out.add('RELATIONS_REQUIRED');
  if (legacy.sku_overflow) out.add('SKU_GRID_TOO_LARGE');
  if (opts.skuTable) {
    // Priced per model, a second group's value or a colour's own price would be lost: per SKU always covers them.
    if (!legacy.per_sku && legacy.option_groups > 1) out.add('PRICE_SHAPE_UNSUPPORTED');
    return [...out].sort();
  }
  if (legacy.option_groups > 1) out.add('PRICE_SHAPE_UNSUPPORTED');
  for (const c of view?.colors ?? []) {
    if (!truthy(c.active)) continue;
    if (colourStatesPrice(c)) out.add('PRICE_SHAPE_UNSUPPORTED');
  }
  for (const v of view?.variants ?? []) {
    if (v.active === 0) continue;
    if (variantStatesPrice(v)) out.add('PRICE_SHAPE_UNSUPPORTED');
  }
  return [...out].sort();
}

/** The engine's prices of every model (or SKU) × channel sold today → the row writes (see the file header). */
export function planWrites(loaded: LoadedProduct, legacy: LegacyEvaluation, models: readonly PricedModel[], opts: PlanOptions = {}): PricePlan {
  const codes = new Set(shapeProblems(loaded, legacy, opts));
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
      prices.push({ option_id: m.option_id, combo_key: m.combo_key, channel, price, option_value_ids: [...m.option_value_ids], color_id: m.color_id });
    }
  }
  if (!prices.length) codes.add('PRICE_INVALID');
  const perSku = legacy.per_sku;
  const skuTable = opts.skuTable === true;
  const hadSkus = skuTable && (loaded.view?.sku_prices?.length ?? 0) > 0;
  const empty: PricePlan = { ok: false, codes: [...codes].sort(), product: null, values: [], cells: [], routes: [], prices, per_sku: perSku, sku_table: skuTable, had_skus: hadSkus, skus: [], colors: [], variants: [] };
  if (codes.size) return empty;

  const view = loaded.view;
  const values: PricePlan['values'] = [];
  const cells: PricePlan['cells'] = [];
  const routes: PricePlan['routes'] = [];
  const byModel = new Map<string, PlannedPrice[]>();
  for (const p of prices) byModel.set(p.option_id, [...(byModel.get(p.option_id) ?? []), p]);
  for (const [optionId, list] of byModel) {
    if (!optionId) continue;
    // A model's fields hold the HIGHEST of its SKUs on each channel (priced per model: its one price).
    const priceOf = (ch: SkuChannel) => {
      const on = list.filter((p) => p.channel === ch).map((p) => p.price.computed_price_iqd);
      return on.length ? Math.max(...on) : null;
    };
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
  // The product's own price: the lowest (the card's «from»), unless the product has no model and its
  // colours are priced one by one — then every line is charged the base, so it holds the highest.
  const hasModels = loaded.doc.options.some((o) => o.active !== false && !o.merged_into);
  const basePrice = perSku && !hasModels ? Math.max(...all) : Math.min(...all);

  // FX-7: the SKU rows, the colours' cleared prices and the variants' mirror (with the SKU rung only).
  // The product itself (key '') is never a SKU row — the table refuses the key, and the ladder's own
  // product price already is that unit's price (verifyPlan reads it back either way). FX-7 gaps.
  const skus: PricePlan['skus'] =
    perSku && skuTable ? prices.filter((p) => p.combo_key !== '').map((p) => ({ combo_key: p.combo_key, channel: p.channel, price: p.price.computed_price_iqd })) : [];
  const colors = skuTable ? (view?.colors ?? []).filter(colourStatesPrice).map((c) => c.id) : [];
  const variants: PricePlan['variants'] = [];
  if (skuTable) {
    for (const v of view?.variants ?? []) {
      const own = perSku ? prices.filter((p) => p.combo_key === v.combo_key) : [];
      const direct = own.find((p) => p.channel === 'direct_sale')?.price.computed_price_iqd ?? null;
      const price = own.length ? (direct ?? Math.max(...own.map((p) => p.price.computed_price_iqd))) : null;
      if (price !== null ? v.regular_price_iqd !== price || present(v.prime_price_iqd) || present(v.pro_price_iqd) : variantStatesPrice(v)) variants.push({ id: v.id, price });
    }
  }
  const plan: PricePlan = {
    ok: true,
    codes: [],
    product: { price_iqd: basePrice, preorder_transports: zeroCommissions(loaded.row.preorder_transports) },
    values,
    cells,
    routes,
    prices,
    per_sku: perSku,
    sku_table: skuTable,
    had_skus: hadSkus,
    skus,
    colors,
    variants,
  };
  if (opts.channel === 'direct_sale') {
    plan.channel = 'direct_sale';
    // Common option/colour/product fields also feed preorder. Leave them and
    // every preorder rung byte-for-byte unchanged, even during adoption.
    plan.values = [];
    plan.routes = [];
    plan.colors = [];
    plan.product = null;
    plan.cells = plan.cells.filter((c) => view?.fulfillments.some((f) => f.id === c.id && f.fulfillment_type === 'direct_sale'));
    const hasPreorder = legacy.units.some((m) => m.channels.some((c) => c.ok && c.channel !== 'direct_sale'));
    if (!hasModels && !perSku) {
      if (hasPreorder) {
        // A base product can express a Direct Sale Extra without touching its
        // common preorder price. A lower direct price requires a direct cell.
        const directExtra = all[0]! - loaded.doc.price_iqd;
        if (directExtra < 0 || all.length !== 1) {
          plan.ok = false;
          plan.codes.push('DIRECT_PURCHASE_PRICE_SHAPE');
        } else plan.direct_surcharge_iqd = directExtra;
      } else plan.product = { price_iqd: basePrice, preorder_transports: null };
    }
  }
  return plan;
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
  if (plan.direct_surcharge_iqd !== undefined) row.direct_surcharge_iqd = plan.direct_surcharge_iqd;
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
        // FX-7: a colour's own price is cleared (its SKUs carry theirs); a variant mirrors its SKU.
        colors: loaded.view.colors.map((c) => (plan.colors.includes(c.id) ? { ...c, ...MEMBER_CLEARED, regular_price_iqd: null } : c)),
        variants: loaded.view.variants.map((v) => {
          const w = plan.variants.find((x) => x.id === v.id);
          return w ? { ...v, regular_price_iqd: w.price, prime_price_iqd: null, pro_price_iqd: null } : v;
        }),
        sku_prices: plan.sku_table ? [...(plan.channel ? (loaded.view.sku_prices ?? []).filter((k) => k.channel !== plan.channel) : []), ...plan.skus.map((k) => ({ combo_key: k.combo_key, channel: k.channel, regular_price_iqd: k.price }))] : loaded.view.sku_prices,
      }
    : undefined;
  const parsed = parseProductRow(row);
  const doc = view ? applyRelations(parsed, view) : parsed;
  return { row, view, doc };
}

/** The same document as an older Worker reads it — without the SKU rung (FX-7 rollback check). */
const withoutSkuRung = (doc: ReturnType<typeof parseProductRow>) => ({ ...doc, sku_prices: undefined });

/** The selection a unit's cart line carries (a SKU's), or none (a model). */
const selectionOf = (unit: ModelToday): SkuSelectionOf | undefined =>
  unit.combo_key !== undefined ? { optionValueIds: unitOptionIds(unit), colorId: unitColorId(unit) } : undefined;

/** PRO and PRIME (the guest context: typed member prices and the fee waivers only) of one channel. */
function tierUnits(doc: ReturnType<typeof parseProductRow>, optionId: string, channel: SkuChannel, ctx: PricingContext, sku?: SkuSelectionOf) {
  const option = optionId ? (doc.options.find((o) => o.id === optionId) ?? null) : null;
  const route = routeOfChannel(channel);
  const at = (tier: 'pro' | 'prime') => {
    const r = resolveUnitPrice({
      product: doc,
      optionId: option?.id ?? null,
      ...(sku ? { optionValueIds: sku.optionValueIds } : {}),
      colorId: sku?.colorId ?? null,
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
  /** The unit's key (FX-7: a SKU's, priced per SKU). */
  combo_key: string;
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
  const older = plan.per_sku && !plan.channel ? withoutSkuRung(after.doc) : null;
  const mismatches: string[] = [];
  const rows: VerifiedRow[] = [];
  for (const before of legacy.units) {
    const combo = unitComboKey(before);
    const label = plan.per_sku ? combo : before.option_id;
    const option = before.option_id ? (models.find((o) => o?.id === before.option_id) ?? null) : null;
    if (before.option_id && !option) {
      mismatches.push(`${label}:model`);
      continue;
    }
    const sku = selectionOf(before);
    const observed = observeModel(after.doc, option, ctx, sku);
    const soldBefore = before.channels.filter((c) => c.ok).map((c) => c.channel).sort();
    const soldAfter = observed.channels.filter((c) => c.ok).map((c) => c.channel).sort();
    if (soldBefore.join(',') !== soldAfter.join(',')) mismatches.push(`${label}:channels`);
    const priceOf = (ch: SkuChannel) => plan.prices.find((p) => p.combo_key === combo && p.channel === ch)?.price.computed_price_iqd ?? null;
    const direct = priceOf('direct_sale');
    // The resolver's COD rule (pricing.ts): a pre-order paid at the door is priced from an ENABLED direct cell.
    const directCell = (option?.fulfillments ?? []).some((f) => f.fulfillment_type === 'direct_sale' && f.enabled !== false);
    // FX-7: the same unit as an older Worker reads it (no SKU rung) — never below the engine's price.
    const old = older ? observeModel(older, option, ctx, sku) : null;
    for (const c of observed.channels.filter((x) => x.ok)) {
      if (plan.channel && c.channel !== plan.channel) {
        const previous = before.channels.find((x) => x.channel === c.channel);
        const tiersBefore = tierUnits(loaded.doc, before.option_id, c.channel, ctx, sku);
        const tiersAfter = tierUnits(after.doc, before.option_id, c.channel, ctx, sku);
        if (!previous || previous.prepaid_iqd !== c.prepaid_iqd || previous.item_iqd !== c.item_iqd || previous.fee_iqd !== c.fee_iqd || tiersBefore.pro !== tiersAfter.pro || tiersBefore.prime !== tiersAfter.prime)
          mismatches.push(`${label}:${c.channel}:preserved`);
        continue;
      }
      const engine = priceOf(c.channel);
      const key = `${label}:${c.channel}`;
      if (engine === null) {
        mismatches.push(key);
        continue;
      }
      const directExtra = c.channel === 'direct_sale' ? plan.direct_surcharge_iqd ?? 0 : 0;
      if ((c.item_iqd ?? 0) + directExtra !== engine || c.prepaid_iqd !== engine || (c.fee_iqd ?? 0) !== directExtra) mismatches.push(`${key}:prepaid`);
      const codExpected = c.route !== null && directCell ? direct : engine;
      if (codExpected === null || c.cod_iqd !== codExpected) mismatches.push(`${key}:cod`);
      if (engine < 1000) mismatches.push(`${key}:floor`);
      if (old) {
        const o = old.channels.find((x) => x.channel === c.channel);
        if (!o || !o.ok || (o.prepaid_iqd ?? 0) < engine || (codExpected !== null && (o.cod_iqd ?? 0) < codExpected)) mismatches.push(`${key}:rollback`);
      }
      const tiersBefore = tierUnits(loaded.doc, before.option_id, c.channel, ctx, sku);
      const tiersAfter = tierUnits(after.doc, before.option_id, c.channel, ctx, sku);
      rows.push({
        option_id: before.option_id,
        combo_key: combo,
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
