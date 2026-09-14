/** Model identity is not an order type or a transport. Pure, shared domain code.
 * Null/absent inherits; zero and false are deliberate overrides. No I/O.
 */
export const TRANSPORT_METHODS = ['air', 'sea', 'land'] as const;
export type TransportMethod = typeof TRANSPORT_METHODS[number];
export type FulfillmentType = 'direct_sale' | 'pre_order';
export type FulfillmentTier = 'regular' | 'prime' | 'pro';
export const FULFILLMENT_TIERS = ['regular', 'prime', 'pro'] as const;
export const FULFILLMENT_IQD_MAX = 2_000_000_000;
export type FulfillmentPriceFields = Partial<Record<`${FulfillmentTier}_price_iqd` | `${FulfillmentTier}_adjust_iqd`, number | null>>;
export interface FulfillmentOffer extends FulfillmentPriceFields {
  enabled?: boolean | null;
  surcharge_iqd?: number | null;
  pro_exempt?: boolean | null;
  stock?: number | null;
  cost_iqd?: number | null;
  cost_adjust_iqd?: number | null;
  lead_time_text?: string | null;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  sku?: string | null;
  image?: string | null;
}
export interface PreorderOffer extends FulfillmentOffer {
  transports?: Partial<Record<TransportMethod, FulfillmentOffer>>;
  pro_exempt_transport?: boolean | null;
}
export interface ModelFulfillment {
  direct?: FulfillmentOffer;
  preorder?: PreorderOffer;
}
export type FulfillmentLadder = Record<FulfillmentTier, number>;
export interface FulfillmentSnapshot {
  version: 2;
  pricing_basis?: 'direct' | 'preorder';
  product_id: string;
  model_id: string | null;
  fulfillment_type: FulfillmentType;
  transport_method: TransportMethod | null;
  membership_tier: FulfillmentTier;
  resolved_base_price: number;
  resolved_option_delta: number;
  resolved_fulfillment_delta: number;
  resolved_transport_delta: number;
  resolved_membership_adjustment: number;
  resolved_final_price: number;
  lead_time: { text: string; min_days: number | null; max_days: number | null };
}
export interface FulfillmentResolution {
  ok: boolean;
  errors: string[];
  prices: FulfillmentLadder | null;
  snapshot: FulfillmentSnapshot | null;
  direct_stock: number | null;
  fulfillment_fees: FulfillmentLadder | null;
  transport_fees: FulfillmentLadder | null;
  pro_direct_waived_iqd: number;
  pro_transport_waived_iqd: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const present = (value: unknown) => value !== null && value !== undefined;
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const isMoney = (value: unknown, signed = false): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= (signed ? -FULFILLMENT_IQD_MAX : 0) && value <= FULFILLMENT_IQD_MAX;

/** Strict public write contract. Typos never disappear during TXT/JSON saves. */
export function validateFulfillment(value: unknown, path = 'fulfillment'): string[] {
  if (value === undefined || value === null) return [];
  if (!record(value)) return [`${path}: expected an object`];
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (key !== 'direct' && key !== 'preorder') errors.push(`${path}.${key}: unknown field`);
  function offer(raw: unknown, at: string, kind: 'direct' | 'preorder' | 'transport') {
    if (raw === undefined) return;
    if (!record(raw)) { errors.push(`${at}: expected an object`); return; }
    const allowed = new Set(['enabled', 'surcharge_iqd', 'pro_exempt', 'cost_iqd', 'cost_adjust_iqd', 'lead_time_text', 'lead_time_min_days', 'lead_time_max_days', 'sku', 'image']);
    if (kind === 'direct') allowed.add('stock');
    if (kind === 'preorder') { allowed.add('transports'); allowed.add('pro_exempt_transport'); }
    for (const tier of FULFILLMENT_TIERS) { allowed.add(`${tier}_price_iqd`); allowed.add(`${tier}_adjust_iqd`); }
    for (const [key, cell] of Object.entries(raw)) {
      if (!allowed.has(key)) { errors.push(`${at}.${key}: unknown or misplaced field`); continue; }
      if (!present(cell)) continue;
      if (key === 'transports') continue;
      if (key === 'enabled' || key === 'pro_exempt' || key === 'pro_exempt_transport') {
        if (typeof cell !== 'boolean') errors.push(`${at}.${key}: expected boolean or null`);
      } else if (key === 'stock' || key === 'lead_time_min_days' || key === 'lead_time_max_days') {
        const max = key === 'stock' ? 10_000_000 : 3650;
        if (typeof cell !== 'number' || !Number.isSafeInteger(cell) || cell < 0 || cell > max) errors.push(`${at}.${key}: invalid nonnegative integer`);
      } else if (key === 'lead_time_text' || key === 'sku' || key === 'image') {
        const max = key === 'image' ? 2000 : 240;
        if (typeof cell !== 'string' || cell.length > max) errors.push(`${at}.${key}: invalid text`);
        else if (key === 'image' && cell && !/^(?:https?:\/\/|\/[^/])/.test(cell)) errors.push(`${at}.image: expected an HTTP(S) URL or relative path`);
      } else if (!isMoney(cell, key.endsWith('_adjust_iqd'))) errors.push(`${at}.${key}: invalid integer IQD`);
    }
    for (const tier of [...FULFILLMENT_TIERS, 'cost'] as const) {
      const fixed = tier === 'cost' ? raw.cost_iqd : raw[`${tier}_price_iqd`];
      if (present(fixed) && present(raw[`${tier}_adjust_iqd`])) errors.push(`${at}.${tier}: fixed price and adjustment are mutually exclusive`);
    }
    const min = raw.lead_time_min_days, max = raw.lead_time_max_days;
    if (typeof min === 'number' && typeof max === 'number' && min > max) errors.push(`${at}: minimum lead time exceeds maximum`);
    if (kind === 'preorder' && own(raw, 'transports')) {
      if (!record(raw.transports)) errors.push(`${at}.transports: expected an object keyed by air, sea, land`);
      else for (const [method, child] of Object.entries(raw.transports)) {
        if (!(TRANSPORT_METHODS as readonly string[]).includes(method)) errors.push(`${at}.transports.${method}: unknown method`);
        else offer(child, `${at}.transports.${method}`, 'transport');
      }
    }
  }
  offer(value.direct, `${path}.direct`, 'direct');
  offer(value.preorder, `${path}.preorder`, 'preorder');
  return errors;
}

export function parseFulfillment(value: unknown, path = 'fulfillment'): ModelFulfillment | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let raw = value;
  if (typeof value === 'string') {
    try { raw = JSON.parse(value); } catch { throw new Error(`${path}: invalid JSON`); }
  }
  const errors = validateFulfillment(raw, path);
  if (errors.length) throw new Error(errors.join('; '));
  if (!record(raw)) throw new Error(`${path}: expected an object`);
  // A detached copy prevents edits to an admin draft changing an existing snapshot.
  return JSON.parse(JSON.stringify(raw)) as ModelFulfillment;
}

/** Cost is private at EVERY depth, including metadata retained from old rows. */
export function publicFulfillment(value: ModelFulfillment | undefined): ModelFulfillment | undefined {
  if (!value) return undefined;
  const clean = (row: FulfillmentOffer): FulfillmentOffer => {
    const { cost_iqd, cost_adjust_iqd, ...rest } = row;
    void cost_iqd; void cost_adjust_iqd;
    return rest;
  };
  return {
    ...(value.direct ? { direct: clean(value.direct) } : {}),
    ...(value.preorder ? { preorder: {
      ...clean(value.preorder),
      ...(value.preorder.pro_exempt_transport === undefined ? {} : { pro_exempt_transport: value.preorder.pro_exempt_transport }),
      ...(value.preorder.transports ? { transports: Object.fromEntries(Object.entries(value.preorder.transports).map(([key, row]) => [key, clean(row)])) } : {}),
    } } : {}),
  };
}

/** Summaries are derived from the independent availability structure. */
export function fulfillmentModes(defaults: ModelFulfillment = {}, override: ModelFulfillment = {}): FulfillmentType[] {
  const result: FulfillmentType[] = [];
  if (override.direct?.enabled ?? defaults.direct?.enabled ?? false) result.push('direct_sale');
  if (override.preorder?.enabled ?? defaults.preorder?.enabled ?? false) result.push('pre_order');
  return result;
}
export function fulfillmentTransports(defaults: ModelFulfillment = {}, override: ModelFulfillment = {}): TransportMethod[] {
  if (!fulfillmentModes(defaults, override).includes('pre_order')) return [];
  return TRANSPORT_METHODS.filter(method => override.preorder?.transports?.[method]?.enabled ?? defaults.preorder?.transports?.[method]?.enabled ?? false);
}

type Amount = { mode: 'fixed' | 'adjust'; amount: number; source: 'model' | 'product' };
function priceAt(row: FulfillmentOffer | undefined, tier: FulfillmentTier, source: Amount['source']): Amount | null {
  if (present(row?.[`${tier}_price_iqd`])) return { mode: 'fixed', amount: row![`${tier}_price_iqd`]!, source };
  if (present(row?.[`${tier}_adjust_iqd`])) return { mode: 'adjust', amount: row![`${tier}_adjust_iqd`]!, source };
  return null;
}
function regularAmount(local: FulfillmentOffer | undefined, defaults: FulfillmentOffer | undefined): Amount | null {
  const exact = priceAt(local, 'regular', 'model');
  if (exact) return exact;
  if (present(local?.surcharge_iqd)) return { mode: 'adjust', amount: local!.surcharge_iqd!, source: 'model' };
  const parent = priceAt(defaults, 'regular', 'product');
  if (parent) return parent;
  return present(defaults?.surcharge_iqd) ? { mode: 'adjust', amount: defaults!.surcharge_iqd!, source: 'product' } : null;
}
function stage(beneath: FulfillmentLadder, local: FulfillmentOffer | undefined, defaults: FulfillmentOffer | undefined, waivePro: boolean): { prices: FulfillmentLadder; fees: FulfillmentLadder; waived: number } {
  const regular = regularAmount(local, defaults);
  const prices = { ...beneath };
  if (regular) prices.regular = regular.mode === 'fixed' ? regular.amount : beneath.regular + regular.amount;
  const regularDelta = prices.regular - beneath.regular;
  const fees: FulfillmentLadder = { regular: regular?.mode === 'adjust' ? Math.max(0, regularDelta) : 0, prime: 0, pro: 0 };
  let waived = 0;
  for (const tier of ['prime', 'pro'] as const) {
    const exact = priceAt(local, tier, 'model') ?? priceAt(defaults, tier, 'product');
    if (exact?.mode === 'fixed') { prices[tier] = exact.amount; continue; }
    const delta = exact ? exact.amount : regularDelta;
    // A fixed TOTAL is never a commission. Waivers remove only a positive
    // surcharge/adjustment; they do not erase the already resolved model rung.
    const isFee = exact?.mode === 'adjust' || regular?.mode === 'adjust';
    const exempt = tier === 'pro' && waivePro && isFee && delta > 0;
    prices[tier] = beneath[tier] + (exempt ? 0 : delta);
    fees[tier] = isFee && !exempt ? Math.max(0, delta) : 0;
    if (exempt) waived = delta;
  }
  return { prices, fees, waived };
}

/** The resolver consumes SERVER-VERIFIED membership activity and the existing
 * base/model ladder. Color/combination arithmetic remains in the current engine.
 * Failed selections return no price/snapshot, never a plausible free purchase.
 */
export function resolveModelFulfillment(input: {
  productId: string;
  modelId: string | null;
  modelActive?: boolean;
  productRegularIqd: number;
  modelPrices: FulfillmentLadder;
  defaults?: ModelFulfillment;
  override?: ModelFulfillment;
  fulfillmentType: FulfillmentType;
  transportMethod?: string | null;
  tier: FulfillmentTier;
  tierActive: boolean;
  quantity?: number;
}): FulfillmentResolution {
  const defaults = input.defaults ?? {}, local = input.override ?? {};
  const errors = [...validateFulfillment(defaults, 'product.fulfillment'), ...validateFulfillment(local, 'model.fulfillment')];
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000_000) errors.push('QUANTITY_INVALID');
  if (!isMoney(input.productRegularIqd) || FULFILLMENT_TIERS.some(t => !isMoney(input.modelPrices[t]))) errors.push('BASE_PRICE_INVALID');
  if (input.modelActive === false) errors.push('MODEL_INACTIVE');
  if (!fulfillmentModes(defaults, local).includes(input.fulfillmentType)) errors.push('FULFILLMENT_UNAVAILABLE');
  const requested = input.transportMethod ?? null;
  const preorder = input.fulfillmentType === 'pre_order';
  let method: TransportMethod | null = null;
  if (!preorder && requested) errors.push('DIRECT_HAS_NO_TRANSPORT');
  if (preorder) {
    if (!requested) errors.push('TRANSPORT_REQUIRED');
    else if (!fulfillmentTransports(defaults, local).includes(requested as TransportMethod)) errors.push('TRANSPORT_UNAVAILABLE');
    else method = requested as TransportMethod;
  }
  const ownOffer = preorder ? local.preorder : local.direct;
  const parentOffer = preorder ? defaults.preorder : defaults.direct;
  const directStock = preorder ? null : (local.direct?.stock ?? defaults.direct?.stock ?? null);
  if (directStock !== null && directStock < quantity) errors.push('DIRECT_OUT_OF_STOCK');
  const ownTransport = method ? local.preorder?.transports?.[method] : undefined;
  const parentTransport = method ? defaults.preorder?.transports?.[method] : undefined;
  if (method && !regularAmount(ownTransport, parentTransport)) errors.push('TRANSPORT_COMMISSION_UNCONFIGURED');
  // All ladder prices include their corresponding benefit for preview. Charging
  // still selects the regular rung for an expired membership below.
  const directWaiver = !preorder && (local.direct?.pro_exempt ?? defaults.direct?.pro_exempt ?? true);
  const transportWaiver = ownTransport?.pro_exempt ?? parentTransport?.pro_exempt ?? local.preorder?.pro_exempt_transport ?? defaults.preorder?.pro_exempt_transport ?? true;
  const fulfillment = stage(input.modelPrices, ownOffer, parentOffer, directWaiver);
  const transported = method ? stage(fulfillment.prices, ownTransport, parentTransport, transportWaiver) : { prices: fulfillment.prices, fees: { regular: 0, prime: 0, pro: 0 }, waived: 0 };
  const lead = <K extends 'lead_time_text' | 'lead_time_min_days' | 'lead_time_max_days'>(key: K) =>
    ownTransport?.[key] ?? parentTransport?.[key] ?? ownOffer?.[key] ?? parentOffer?.[key] ?? null;
  const text = preorder ? lead('lead_time_text') ?? '' : '';
  const min = preorder ? lead('lead_time_min_days') : null;
  const max = preorder ? lead('lead_time_max_days') : null;
  if (min !== null && max !== null && min > max) errors.push('LEAD_TIME_INVALID');
  const prices = { ...transported.prices };
  if (FULFILLMENT_TIERS.some(t => !isMoney(prices[t]))) errors.push('RESOLVED_PRICE_INVALID');
  // Match the existing member ladder guarantee: no member pays more than
  // regular and PRO never pays more than PRIME. No price is invented below 0.
  prices.prime = Math.min(prices.prime, prices.regular);
  prices.pro = Math.min(prices.pro, prices.prime);
  if (errors.length) return { ok: false, errors: [...new Set(errors)], prices: null, snapshot: null, direct_stock: directStock, fulfillment_fees: null, transport_fees: null, pro_direct_waived_iqd: 0, pro_transport_waived_iqd: 0 };
  const tier = input.tierActive ? input.tier : 'regular';
  return {
    ok: true, errors: [], prices, direct_stock: directStock,
    fulfillment_fees: fulfillment.fees, transport_fees: transported.fees,
    pro_direct_waived_iqd: fulfillment.waived,
    pro_transport_waived_iqd: transported.waived,
    snapshot: {
      version: 2, product_id: input.productId, model_id: input.modelId,
      fulfillment_type: input.fulfillmentType, transport_method: method, membership_tier: tier,
      resolved_base_price: input.productRegularIqd,
      resolved_option_delta: input.modelPrices.regular - input.productRegularIqd,
      resolved_fulfillment_delta: fulfillment.prices.regular - input.modelPrices.regular,
      resolved_transport_delta: transported.prices.regular - fulfillment.prices.regular,
      resolved_membership_adjustment: prices[tier] - transported.prices.regular,
      resolved_final_price: prices[tier],
      lead_time: { text, min_days: min, max_days: max },
    },
  };
}
