/**
 * TODAY'S PRICES, FROM THE LIVE RESOLVER, AND THE OLD PROFIT THEY CARRY
 * (MVP plan §6 P1; master plan v2 §2.5, answer B).
 *
 * One product's models are the values of its option group (the first active
 * group in authored order — the value the cart prices a line from), or the
 * product itself when it has none. For each model, every channel the store
 * offers today (`saleAvailability`: the enabled order types, and the model's
 * own routes before the product's list) is priced with `resolveUnitPrice`
 * exactly as the cart prices a guest's line — free tier, no warranty, no offer
 * window (a promotion is temporary; the migration reads the ordinary price,
 * LEG decision 6) — once prepaid and once paid cash on delivery.
 *
 * Those prepaid answers are the input of `deriveLegacyTargets` (packages/
 * pricing/src/legacyTargets.ts): item + the resolver's commission, and the
 * resolver's landed cost.
 *
 * The rung that set the COST is read here, over the very rows the resolver
 * priced from (`pick`'s walk: base → option → order-type cell → route), so the
 * "cost less specific than price" check compares like with like; its value is
 * cross-checked against the resolver's own `cost_iqd`, and a mismatch is held
 * for review rather than trusted.
 *
 * Pure over the loaded document: no I/O here.
 */
import {
  findFulfillment,
  findTransport,
  resolveUnitPrice,
  type ColorV2,
  type OptionV2,
  type PreorderPricing,
  type PriceFields,
  type ResolvedPrice,
} from '../pricing';
import { colorVisibility, validateSelection, type GroupSelection } from '../productRelations';
import { optionValueIdsInRelationOrder } from '../cartSelectionIdentity';
import { ENGINE_MAX_SKUS } from '@levonis/pricing/costToPrice';
import { memberFallbackFor, type PricingContext } from '../../routes/cart';
import { saleAvailability } from '../../routes/products';
import type { ProductDoc } from '../productModel';
import type { ProductRelationsView } from '../productOverlay';
import {
  deriveLegacyTargets,
  type LegacyChannelObservation,
  type LegacyModelInput,
  type LegacyProductResult,
  type LegacyRouteObservation,
  type LegacyRung,
} from '@levonis/pricing/legacyTargets';
import { PREORDER_ROUTES, SKU_CHANNELS, routeOfChannel, skuComboKey, type PreorderRoute, type SkuChannel } from '@levonis/pricing/skuChannel';

/** One channel of one model, as a guest's cart is charged for it today. */
export interface ChannelToday {
  channel: SkuChannel;
  route: PreorderRoute | null;
  /** The resolver priced it without an error. */
  ok: boolean;
  /** The resolver's refusal codes when it did not. */
  errors: string[];
  /** `regular_iqd`: the item price. */
  item_iqd: number | null;
  /** The route commission (pre-order) or the product's direct scalar (direct sale). */
  fee_iqd: number | null;
  /** What a prepaid guest pays per unit (`unit_subtotal_iqd`). */
  prepaid_iqd: number | null;
  /** What the same guest pays cash on delivery. */
  cod_iqd: number | null;
  /** Cash on delivery re-prices this pre-order from the direct ladder (`pricing_basis === 'direct'`). */
  cod_as_direct: boolean;
  /** The resolver's landed cost (owner only). */
  cost_iqd: number | null;
  price_rung: LegacyRung | null;
  cost_rung: LegacyRung | null;
}

/** A unit's names in the three languages (a model's own, or a SKU's: its values and colour). */
export interface UnitNames {
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

export interface ModelToday {
  /** null: the product itself (it has no models). */
  option: OptionV2 | null;
  option_id: string;
  channels: ChannelToday[];
  /**
   * FX-7: the unit the engine prices. A MODEL (every product priced per model)
   * leaves these absent: its key is its own option value, no colour. A SKU of
   * a product priced per colour or variant carries its exact key, its whole
   * selection (relation order, the model first) and its colour.
   */
  combo_key?: string;
  option_value_ids?: string[];
  color?: ColorV2 | null;
  names?: UnitNames;
}

/** The exact key a unit's prices are stored under (`skuComboKey`). */
export const unitComboKey = (m: Pick<ModelToday, 'option_id' | 'combo_key'>): string =>
  m.combo_key ?? skuComboKey({ option_value_ids: m.option_id ? [m.option_id] : [], color_id: null });

/** A unit's whole selection: its option values (the model first) — a model alone is `[option_id]`. */
export const unitOptionIds = (m: Pick<ModelToday, 'option_id' | 'option_value_ids'>): string[] =>
  m.option_value_ids && m.option_value_ids.length ? [...m.option_value_ids] : m.option_id ? [m.option_id] : [];

/** A unit's colour id, or null (a model). */
export const unitColorId = (m: Pick<ModelToday, 'color'>): string | null => m.color?.id ?? null;

export interface LegacyEvaluation {
  models: ModelToday[];
  /**
   * FX-7: what the engine prices — the models themselves (a product priced per
   * model, every product before FX-7), or every sellable SKU (a product priced
   * per colour or variant: `per_sku`). The legacy derivation reads `models`.
   */
  units: ModelToday[];
  per_sku: boolean;
  /** More sellable SKUs than the engine prices (ENGINE_MAX_SKUS): SKU_GRID_TOO_LARGE. */
  sku_overflow: boolean;
  legacy: LegacyProductResult;
  /** Active option groups that hold a model; > 1 is OPTION_GROUPS_UNSUPPORTED. */
  option_groups: number;
  /** A typed PRIME/PRO price or adjustment on any rung the resolver reads. */
  typed_member_prices: boolean;
  /** An active colour that states a price, a member price, a cost or an adjustment. */
  colour_pricing: boolean;
}

const RUNGS: ReadonlySet<string> = new Set(['base', 'option', 'fulfillment', 'transport', 'color']);
const rungOf = (v: unknown): LegacyRung | null => (typeof v === 'string' && RUNGS.has(v) ? (v as LegacyRung) : null);
const present = (v: unknown) => v !== null && v !== undefined;

/** The models of a product: the active values of its first active option group, authored order. */
export function modelsOf(doc: ProductDoc, view: ProductRelationsView | undefined): { models: Array<OptionV2 | null>; groups: number } {
  const active = doc.options.filter((o) => o.active !== false && !o.merged_into);
  if (!active.length) return { models: [null], groups: 0 };
  if (!view || !view.groups.length) return { models: active, groups: 1 };
  const groupOf = new Map(view.values.map((v) => [v.id, v.group_id] as const));
  const groups = view.groups.filter((g) => g.active !== 0 && g.active !== false && active.some((o) => groupOf.get(o.id) === g.id));
  if (!groups.length) return { models: active, groups: 1 };
  const first = groups[0]!.id;
  return { models: active.filter((o) => groupOf.get(o.id) === first), groups: groups.length };
}

/**
 * The cost the resolver's `pick` reaches over the same rows, and the rung that
 * set it. Cost gets no regular-price anchor (pricing.ts): an adjustment with no
 * cost beneath it leaves the cost absent.
 */
function costWalk(doc: ProductDoc, option: OptionV2 | null, type: 'direct_sale' | 'pre_order', method: string | null): { value: number | null; rung: LegacyRung | null } {
  const cell = findFulfillment(option, type);
  const enabledCell = cell && cell.enabled !== false ? cell : null;
  const routeRow = method ? findTransport(findFulfillment(option, 'pre_order'), method) : null;
  const rows: Array<[LegacyRung, PriceFields | null]> = [
    ['option', option],
    ['fulfillment', enabledCell],
    ['transport', routeRow && routeRow.enabled !== false ? routeRow : null],
  ];
  let value: number | null = present(doc.product_cost_iqd) ? (doc.product_cost_iqd as number) : null;
  let rung: LegacyRung | null = value !== null ? 'base' : null;
  for (const [name, row] of rows) {
    if (!row) continue;
    if (present(row.cost_iqd)) {
      value = row.cost_iqd as number;
      rung = name;
    } else if (present(row.cost_adjust_iqd) && Number.isFinite(row.cost_adjust_iqd) && value !== null) {
      value = Math.max(0, Math.round(value + (row.cost_adjust_iqd as number)));
      rung = name;
    }
  }
  return { value, rung };
}

/** A SKU's selection beyond its model: every option value (relation order) and its colour. */
export interface SkuSelectionOf {
  optionValueIds: readonly string[];
  colorId: string | null;
}

function resolve(
  doc: ProductDoc,
  option: OptionV2 | null,
  ctx: PricingContext,
  route: PreorderRoute | null,
  preorderPricing: PreorderPricing,
  sku?: SkuSelectionOf
): ResolvedPrice {
  // The cart's call (routes/cart.ts resolveCartLine) for a guest: free tier,
  // no warranty, the stated order type and route — and, for a SKU, its whole
  // selection and colour, exactly as the cart line carries them.
  return resolveUnitPrice({
    product: doc,
    optionId: option?.id ?? null,
    ...(sku ? { optionValueIds: sku.optionValueIds } : {}),
    colorId: sku?.colorId ?? null,
    transportMethod: route,
    fulfillmentType: route ? 'pre_order' : 'direct_sale',
    warrantyPlanId: null,
    tier: 'free',
    tierActive: false,
    proPolicy: ctx.proPolicy,
    memberFallback: memberFallbackFor(ctx, doc),
    transportDefaults: ctx.transportDefaults,
    preorderPricing,
    isPrinter: false,
  });
}

/**
 * Every channel the store offers this model today, priced prepaid and cash on
 * delivery — and, given `sku`, the same channels for one exact SKU of the model
 * (its colour and its other groups' values change the price, never the
 * channels: those are the model's cells and routes).
 */
export function observeModel(doc: ProductDoc, option: OptionV2 | null, ctx: PricingContext, sku?: SkuSelectionOf): ModelToday {
  const offer = saleAvailability(doc, { optionId: option?.id ?? null, transportDefaults: ctx.transportDefaults });
  const direct = offer.modes.some((m) => m.type === 'direct_sale');
  const preorder = offer.modes.some((m) => m.type === 'pre_order');
  const routes = preorder
    ? PREORDER_ROUTES.filter((r) => offer.preorder.transports.some((t) => t.method === r))
    : [];
  const wanted: SkuChannel[] = SKU_CHANNELS.filter((c) => {
    const r = routeOfChannel(c);
    return r === null ? direct : routes.includes(r);
  });
  const channels = wanted.map((channel): ChannelToday => {
    const route = routeOfChannel(channel);
    const prepaid = resolve(doc, option, ctx, route, 'prepaid', sku);
    const cod = resolve(doc, option, ctx, route, 'cod', sku);
    const errors = [...new Set([...prepaid.errors, ...cod.errors])].sort();
    const ok = errors.length === 0;
    const walk = costWalk(doc, option, route ? 'pre_order' : 'direct_sale', route);
    // The walk must reach the resolver's own cost; if it ever does not, the
    // rung is unknown and `observation` treats the cost as the least specific.
    const costRung = walk.value === prepaid.cost_iqd ? walk.rung : null;
    const fee = route ? (prepaid.transport?.commission_iqd ?? 0) : prepaid.components.direct_fee_iqd;
    return {
      channel,
      route,
      ok,
      errors,
      item_iqd: ok ? prepaid.regular_iqd : null,
      fee_iqd: ok ? fee : null,
      prepaid_iqd: ok ? prepaid.unit_subtotal_iqd : null,
      cod_iqd: ok ? cod.unit_subtotal_iqd : null,
      cod_as_direct: ok && route !== null && cod.pricing_basis === 'direct',
      cost_iqd: ok ? prepaid.cost_iqd : null,
      price_rung: ok ? rungOf(prepaid.price_source) : null,
      cost_rung: ok ? costRung : null,
    };
  });
  return { option, option_id: option?.id ?? '', channels };
}

const observation = (c: ChannelToday): LegacyChannelObservation => ({
  item_iqd: c.item_iqd as number,
  fee_iqd: c.fee_iqd as number,
  cost_iqd: c.cost_iqd,
  price_rung: c.price_rung ?? 'color',
  // A cost the rung walk could not reproduce is treated as the least specific
  // (base): the "less specific than price" review then holds the value.
  cost_rung: c.cost_iqd === null ? null : (c.cost_rung ?? 'base'),
});

/**
 * The legacy-derivation input of one model, from its priced channels — and the
 * offered channels the resolver could not price, so a model with no priced
 * channel is held rather than left out (CHANNEL_NOT_PRICED).
 */
export function legacyInputOf(model: ModelToday, variantCosts: readonly number[]): LegacyModelInput {
  const priced = model.channels.filter((c) => c.ok);
  const failed = model.channels.filter((c) => !c.ok);
  const directChannel = priced.find((c) => c.route === null) ?? null;
  const routes: LegacyRouteObservation[] = priced
    .filter((c) => c.route !== null)
    .map((c) => ({ route: c.route as PreorderRoute, ...observation(c) }));
  return {
    option_id: model.option_id,
    direct: directChannel ? observation(directChannel) : null,
    routes,
    ...(variantCosts.length ? { variant_costs: variantCosts } : {}),
    ...(failed.length
      ? { unpriced: { direct: failed.some((c) => c.route === null), routes: failed.filter((c) => c.route !== null).map((c) => c.route as PreorderRoute) } }
      : {}),
  };
}

/** A typed PRIME/PRO price or adjustment anywhere the resolver reads one. */
export function hasTypedMemberPrices(doc: ProductDoc): boolean {
  const states = (r: Partial<PriceFields> | null | undefined) =>
    !!r && [r.prime_price_iqd, r.pro_price_iqd, r.prime_adjust_iqd, r.pro_adjust_iqd].some(present);
  if (present(doc.prime_price_iqd) || present(doc.pro_price_iqd)) return true;
  for (const o of doc.options) {
    if (o.active === false) continue;
    if (states(o)) return true;
    for (const f of o.fulfillments ?? []) {
      if (f.enabled === false) continue;
      if (states(f)) return true;
      for (const t of f.transports ?? []) if (t.enabled !== false && states(t)) return true;
    }
  }
  return doc.colors.some((c) => c.active !== false && states(c));
}

/** An active colour that states any price, member price, cost or adjustment. */
export function hasColourPricing(doc: ProductDoc): boolean {
  return doc.colors.some(
    (c) =>
      c.active !== false &&
      [
        c.regular_price_iqd,
        c.prime_price_iqd,
        c.pro_price_iqd,
        c.cost_iqd,
        c.regular_adjust_iqd,
        c.prime_adjust_iqd,
        c.pro_adjust_iqd,
        c.cost_adjust_iqd,
      ].some(present)
  );
}

/** The stored SKU costs (`product_variants.cost_iqd`) of one model's active SKUs. */
function variantCostsOf(view: ProductRelationsView | undefined, optionId: string): number[] {
  if (!view || !optionId) return [];
  const key = `o:${optionId}`;
  return view.variants
    .filter((v) => v.active !== 0 && present(v.cost_iqd) && v.combo_key.split('|').includes(key))
    .map((v) => v.cost_iqd as number);
}

const nameIn = (x: { name_ar?: string; name_en?: string; name_ckb?: string } | null | undefined, lang: 'ar' | 'en' | 'ckb'): string =>
  (lang === 'en' ? x?.name_en || x?.name_ar : lang === 'ckb' ? x?.name_ckb || x?.name_ar || x?.name_en : x?.name_ar || x?.name_en) || '';

/** A unit's names: its option values (the model first) and its colour, joined by « · ». */
export function unitNamesOf(doc: ProductDoc, optionIds: readonly string[], color: ColorV2 | null): UnitNames {
  const parts = [...optionIds.map((id) => doc.options.find((o) => o.id === id) ?? null).filter((o): o is OptionV2 => !!o), ...(color ? [color] : [])];
  const join = (lang: 'ar' | 'en' | 'ckb') => parts.map((p) => nameIn(p, lang)).filter(Boolean).join(' · ');
  return { name_ar: join('ar'), name_en: join('en'), name_ckb: join('ckb') };
}

/** One sellable SKU: its whole selection (relation order, the model first), its model, its colour, its key. */
export interface SellableSku {
  option_value_ids: string[];
  model: OptionV2 | null;
  color: ColorV2 | null;
  combo_key: string;
}

/**
 * EVERY SKU A CUSTOMER CAN BUY (FX-7): one active value of every active option
 * group that holds one (one implicit group for a product with options but no
 * group rows), times every colour visible for that selection — the colour
 * links' AND/OR algebra, `validateSelection`, the very check the cart runs —
 * or no colour when none is visible. The model is the first value in relation
 * order (`optionValueIdsInRelationOrder`), the one the cart prices a line from.
 * At most ENGINE_MAX_SKUS; more is `overflow` (SKU_GRID_TOO_LARGE).
 */
export function sellableSkus(doc: ProductDoc, view: ProductRelationsView | undefined): { skus: SellableSku[]; overflow: boolean } {
  const active = doc.options.filter((o) => o.active !== false && !o.merged_into);
  const relational = !!view && view.has_relations;
  const groupOf = new Map((view?.values ?? []).map((v) => [v.id, v.group_id] as const));
  let groups: Array<{ id: string; values: OptionV2[] }> = [];
  if (active.length) {
    const rows = relational && view!.groups.length ? view!.groups.filter((g) => g.active !== 0 && g.active !== false) : [];
    groups = rows.map((g) => ({ id: g.id, values: active.filter((o) => groupOf.get(o.id) === g.id) })).filter((g) => g.values.length > 0);
    if (!groups.length) groups = [{ id: '', values: active }];
  }
  const colours = doc.colors.filter((c) => c.active !== false);
  let selections: Array<OptionV2[]> = [[]];
  for (const g of groups) {
    const next: Array<OptionV2[]> = [];
    for (const sel of selections) for (const v of g.values) next.push([...sel, v]);
    selections = next;
    if (selections.length > ENGINE_MAX_SKUS) return { skus: [], overflow: true };
  }
  const skus: SellableSku[] = [];
  for (const sel of selections) {
    const ids = relational ? optionValueIdsInRelationOrder(sel.map((o) => o.id), view) : sel.map((o) => o.id);
    const model = ids.length ? (doc.options.find((o) => o.id === ids[0]) ?? null) : null;
    const selection: GroupSelection = {};
    for (const o of sel) selection[groupOf.get(o.id) ?? ''] = o.id;
    const visible = colours.filter((c) =>
      relational ? colorVisibility(c.id, view!.links, selection).visible : !c.option_id || c.option_id === (model?.id ?? null)
    );
    for (const color of visible.length ? visible : [null]) {
      if (relational) {
        const errors = validateSelection({
          groups: view!.groups,
          values: view!.values,
          colors: view!.colors,
          links: view!.links,
          selectedValueIds: ids,
          selectedColorId: color?.id ?? null,
        });
        if (errors.length) continue;
      }
      skus.push({ option_value_ids: ids, model, color, combo_key: skuComboKey({ option_value_ids: ids, color_id: color?.id ?? null }) });
      if (skus.length > ENGINE_MAX_SKUS) return { skus: [], overflow: true };
    }
  }
  return { skus, overflow: false };
}

/** Today's channels of every model, and the old profit they carry (answer B) — and, priced per SKU (FX-7), every sellable SKU's. */
export function evaluateLegacy(
  productId: string,
  doc: ProductDoc,
  view: ProductRelationsView | undefined,
  ctx: PricingContext,
  opts: { perSku?: boolean } = {}
): LegacyEvaluation {
  const { models, groups } = modelsOf(doc, view);
  const today = models.map((option) => observeModel(doc, option, ctx));
  const legacy = deriveLegacyTargets({
    product_id: productId,
    models: today.map((m) => legacyInputOf(m, variantCostsOf(view, m.option_id))),
  });
  let units: ModelToday[] = today;
  let overflow = false;
  if (opts.perSku) {
    const grid = sellableSkus(doc, view);
    overflow = grid.overflow;
    units = grid.skus.map((sku) => ({
      ...observeModel(doc, sku.model, ctx, { optionValueIds: sku.option_value_ids, colorId: sku.color?.id ?? null }),
      combo_key: sku.combo_key,
      option_value_ids: sku.option_value_ids,
      color: sku.color,
      names: unitNamesOf(doc, sku.option_value_ids, sku.color),
    }));
  }
  return {
    models: today,
    units,
    per_sku: opts.perSku === true,
    sku_overflow: overflow,
    legacy,
    option_groups: groups,
    typed_member_prices: hasTypedMemberPrices(doc),
    colour_pricing: hasColourPricing(doc),
  };
}
