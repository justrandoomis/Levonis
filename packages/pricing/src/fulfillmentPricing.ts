import type { OptionV2, PricingProduct, ResolvedPrice, UnitPriceInput } from './pricing';
import {
  TRANSPORT_METHODS, FULFILLMENT_TIERS, fulfillmentModes, resolveModelFulfillment,
  type FulfillmentOffer, type FulfillmentLadder, type ModelFulfillment, type FulfillmentTier,
} from './fulfillment';

/** Field-wise inheritance: null/absent inherits; false, zero and empty text do not. */
function inheritOffer(base: FulfillmentOffer | undefined, override: FulfillmentOffer | undefined): FulfillmentOffer | undefined {
  if (!base && !override) return undefined;
  return Object.fromEntries(Object.entries({ ...base, ...Object.fromEntries(Object.entries(override ?? {}).filter(([, value]) => value !== null && value !== undefined)) }));
}
export function mergeFulfillmentDefaults(base: ModelFulfillment = {}, override: ModelFulfillment = {}): ModelFulfillment {
  const direct = inheritOffer(base.direct, override.direct);
  const preorder = inheritOffer(base.preorder, override.preorder);
  return {
    ...(direct ? { direct } : {}),
    ...(preorder ? { preorder: { ...preorder,
      pro_exempt_transport: override.preorder?.pro_exempt_transport ?? base.preorder?.pro_exempt_transport,
      transports: Object.fromEntries(TRANSPORT_METHODS.flatMap(method => {
        const merged = inheritOffer(base.preorder?.transports?.[method], override.preorder?.transports?.[method]);
        return merged ? [[method, merged]] : [];
      })),
    } } : {}),
  };
}

/** The compatibility adapter reads the old scalars only as defaults. New model
 * overrides remain independent and are NEVER fabricated as option records.
 */
export function fulfillmentDefaultsFor(product: PricingProduct, transportDefaults: UnitPriceInput['transportDefaults'] = []): ModelFulfillment {
  const types = product.sale_types?.length ? product.sale_types : [product.selling_type];
  const legacy: ModelFulfillment = {
    direct: { enabled: types.includes('direct_sale') || types.includes('bundle'), surcharge_iqd: product.direct_surcharge_iqd ?? null },
    preorder: { enabled: types.includes('pre_order'), transports: Object.fromEntries(TRANSPORT_METHODS.map(method => {
      const offer = product.preorder_transports.find(row => row.method === method);
      return [method, {
        enabled: !!offer && offer.active !== false,
        surcharge_iqd: offer?.commission_iqd ?? transportDefaults.find(row => row.method === method)?.commission_iqd ?? null,
      }];
    })) },
  };
  return mergeFulfillmentDefaults(legacy, product.fulfillment);
}

export function canonicalModelSelection(options: OptionV2[], optionId: string | null | undefined): { id: string | null; legacyType: 'direct_sale' | 'pre_order' | null } {
  if (!optionId) return { id: null, legacyType: null };
  if (options.some(option => option.id === optionId)) return { id: optionId, legacyType: null };
  for (const option of options) {
    const alias = option.legacy_fulfillment_ids?.find(row => row.id === optionId);
    if (alias) return { id: option.id, legacyType: alias.fulfillment_type };
  }
  return { id: optionId, legacyType: null };
}

function hasDirectPrice(defaults: ModelFulfillment, override: ModelFulfillment): boolean {
  return [defaults.direct, override.direct].some(row => !!row && (
    (row.surcharge_iqd ?? 0) > 0 || FULFILLMENT_TIERS.some(tier => row[`${tier}_price_iqd`] != null || row[`${tier}_adjust_iqd`] != null)
  ));
}
function costAt(base: number | null, local: FulfillmentOffer | undefined, defaults: FulfillmentOffer | undefined): number | null {
  for (const row of [local, defaults]) {
    if (row?.cost_iqd != null) return row.cost_iqd;
    if (row?.cost_adjust_iqd != null) return base === null ? null : Math.max(0, base + row.cost_adjust_iqd);
  }
  return base;
}
const noStock = (config: ModelFulfillment): ModelFulfillment => ({ ...config, direct: { ...config.direct, enabled: true, stock: null } });

/** Called ONLY by resolveUnitPrice; legacy arithmetic remains its base/color/
 * warranty engine. Both engines return the same financial contract: applied
 * item + effective fees + warranty = unit subtotal. Fixed totals are not fees.
 */
export function resolveStructuredUnitPrice(input: UnitPriceInput, legacyResolver: (value: UnitPriceInput) => ResolvedPrice): ResolvedPrice {
  const selection = canonicalModelSelection(input.product.options, input.optionId);
  const option = input.product.options.find(row => row.id === selection.id);
  const defaults = fulfillmentDefaultsFor(input.product, input.transportDefaults);
  const override = option?.fulfillment ?? {};
  const method = input.transportMethod?.trim() || null;
  const available = fulfillmentModes(defaults, override);
  const type = input.fulfillmentType ?? selection.legacyType ?? (method || (available.length === 1 && available[0] === 'pre_order') ? 'pre_order' : 'direct_sale');
  const tier: FulfillmentTier = input.tier === 'pro' ? 'pro' : input.tier === 'prime' ? 'prime' : 'regular';
  const base = legacyResolver({ ...input, optionId: selection.id, transportMethod: null, tier: 'free', tierActive: false,
    product: { ...input.product, fulfillment: undefined, selling_type: 'direct_sale', sale_types: ['direct_sale'],
      direct_surcharge_iqd: null, preorder_transports: [],
      options: input.product.options.map(row => ({ ...row, availability_type: '' })),
    },
  });
  const request = {
    productId: input.product.id ?? '', modelId: selection.id, modelActive: option?.active,
    productRegularIqd: input.product.price_iqd,
    modelPrices: { regular: base.regular_iqd, prime: base.prime_iqd ?? base.regular_iqd, pro: base.pro_iqd ?? base.prime_iqd ?? base.regular_iqd },
    defaults, override, fulfillmentType: type, transportMethod: method,
    tier, tierActive: input.tierActive, quantity: input.quantity,
  };
  const journey = resolveModelFulfillment(request);
  const errors = [...base.errors, ...journey.errors];
  if (selection.legacyType && selection.legacyType !== type) errors.push('LEGACY_FULFILLMENT_MISMATCH');
  // Preserve the existing cash-on-delivery rule without changing the parcel's
  // selected preorder journey or consulting/decrementing direct inventory.
  const cod = type === 'pre_order' && input.preorderPricing === 'cod' && hasDirectPrice(defaults, override);
  const priced = cod ? resolveModelFulfillment({ ...request, fulfillmentType: 'direct_sale', transportMethod: null,
    defaults: noStock(defaults), override: noStock(override) }) : journey;
  errors.push(...priced.errors);
  if (!journey.ok || !priced.ok || !priced.prices || !priced.snapshot || errors.length) {
    return { ...base, transport: null, direct: null, errors: [...new Set(errors)], fulfillment_snapshot: null };
  }
  const chargedTier = input.tierActive ? tier : 'regular';
  const isDirectPriced = type === 'direct_sale' || cod;
  const directFees = isDirectPriced ? priced.fulfillment_fees : null;
  const transportFees = cod ? null : priced.transport_fees;
  // Clamped legacy member ladders cannot allocate more positive fees than the
  // complete unit price. Negative adjustments stay in the item component.
  const feeFor = (which: FulfillmentTier) => {
    const d = Math.min(directFees?.[which] ?? 0, priced.prices![which]);
    const t = Math.min(transportFees?.[which] ?? 0, priced.prices![which] - d);
    return { d, t };
  };
  const charged = feeFor(chargedTier);
  const itemLadder = Object.fromEntries(FULFILLMENT_TIERS.map(which => {
    const fees = feeFor(which);
    return [which, priced.prices![which] - fees.d - fees.t];
  })) as FulfillmentLadder;
  const pro = chargedTier === 'pro';
  const directWaived = isDirectPriced && pro ? priced.pro_direct_waived_iqd : 0;
  const transportWaived = pro ? journey.pro_transport_waived_iqd : 0;
  const direct: ResolvedPrice['direct'] = charged.d > 0 || directWaived > 0
    ? { surcharge_iqd: directWaived || charged.d, waived: directWaived > 0 } : null;
  const transport: ResolvedPrice['transport'] = method ? {
    method,
    commission_iqd: cod ? (journey.transport_fees?.[chargedTier] ?? 0) + transportWaived : transportWaived || charged.t,
    waived: cod || transportWaived > 0,
    ...(cod ? { waived_by: 'cod_direct_pricing' as const } : transportWaived > 0 ? { waived_by: 'pro' as const } : {}),
  } : null;
  const actualOffer = type === 'pre_order' ? override.preorder : override.direct;
  const defaultOffer = type === 'pre_order' ? defaults.preorder : defaults.direct;
  let cost = costAt(base.cost_iqd, actualOffer, defaultOffer);
  if (method === 'air' || method === 'sea' || method === 'land') cost = costAt(cost, override.preorder?.transports?.[method], defaults.preorder?.transports?.[method]);
  // Keep the already-established warranty basis: model/color regular, before
  // availability or transport fees. Membership never waives that warranty.
  const warrantyFee = base.warranty?.fee_iqd ?? 0;
  return {
    ...base, regular_iqd: itemLadder.regular, prime_iqd: itemLadder.prime, pro_iqd: itemLadder.pro,
    applied_iqd: itemLadder[chargedTier], applied_tier: chargedTier,
    cost_iqd: cost, direct, transport,
    pricing_basis: isDirectPriced ? 'direct' : 'preorder',
    unit_subtotal_iqd: priced.prices[chargedTier] + warrantyFee,
    errors: [],
    fulfillment_snapshot: {
      ...priced.snapshot, fulfillment_type: type,
      transport_method: journey.snapshot!.transport_method,
      lead_time: { ...journey.snapshot!.lead_time },
      pricing_basis: isDirectPriced ? 'direct' : 'preorder',
    },
  };
}
