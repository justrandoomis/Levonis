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
  type OptionV2,
  type PreorderPricing,
  type PriceFields,
  type ResolvedPrice,
} from '../pricing';
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
import { PREORDER_ROUTES, SKU_CHANNELS, routeOfChannel, type PreorderRoute, type SkuChannel } from '@levonis/pricing/skuChannel';

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

export interface ModelToday {
  /** null: the product itself (it has no models). */
  option: OptionV2 | null;
  option_id: string;
  channels: ChannelToday[];
}

export interface LegacyEvaluation {
  models: ModelToday[];
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

function resolve(doc: ProductDoc, option: OptionV2 | null, ctx: PricingContext, route: PreorderRoute | null, preorderPricing: PreorderPricing): ResolvedPrice {
  // The cart's call (routes/cart.ts resolveCartLine) for a guest: free tier,
  // no warranty, the stated order type and route.
  return resolveUnitPrice({
    product: doc,
    optionId: option?.id ?? null,
    colorId: null,
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

/** Every channel the store offers this model today, priced prepaid and cash on delivery. */
export function observeModel(doc: ProductDoc, option: OptionV2 | null, ctx: PricingContext): ModelToday {
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
    const prepaid = resolve(doc, option, ctx, route, 'prepaid');
    const cod = resolve(doc, option, ctx, route, 'cod');
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

/** The legacy-derivation input of one model, from its priced channels. */
export function legacyInputOf(model: ModelToday, variantCosts: readonly number[]): LegacyModelInput {
  const priced = model.channels.filter((c) => c.ok);
  const directChannel = priced.find((c) => c.route === null) ?? null;
  const routes: LegacyRouteObservation[] = priced
    .filter((c) => c.route !== null)
    .map((c) => ({ route: c.route as PreorderRoute, ...observation(c) }));
  return {
    option_id: model.option_id,
    direct: directChannel ? observation(directChannel) : null,
    routes,
    ...(variantCosts.length ? { variant_costs: variantCosts } : {}),
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

/** Today's channels of every model, and the old profit they carry (answer B). */
export function evaluateLegacy(productId: string, doc: ProductDoc, view: ProductRelationsView | undefined, ctx: PricingContext): LegacyEvaluation {
  const { models, groups } = modelsOf(doc, view);
  const today = models.map((option) => observeModel(doc, option, ctx));
  const legacy = deriveLegacyTargets({
    product_id: productId,
    models: today.map((m) => legacyInputOf(m, variantCostsOf(view, m.option_id))),
  });
  return {
    models: today,
    legacy,
    option_groups: groups,
    typed_member_prices: hasTypedMemberPrices(doc),
    colour_pricing: hasColourPricing(doc),
  };
}
