import type { PriceFields, OptionV2, PricingProduct, TransportOffer } from './pricing';

export type FulfillmentType = 'direct_sale' | 'pre_order';
export type TransportMethod = 'air' | 'sea' | 'land';

export interface FulfillmentPricing extends Partial<PriceFields> {
  id?: string;
  enabled: boolean;
  stock?: number | null;
  reserved?: number;
  image?: string;
  sku_part?: string;
  lead_time_text?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
}

export interface ModelTransport extends FulfillmentPricing {
  method: TransportMethod;
  surcharge_iqd?: number | null;
}

export interface ModelPreorder extends FulfillmentPricing {
  /** Omitted inherits the product methods; an explicit list replaces them. */
  transports?: ModelTransport[];
}

export interface ModelAvailability {
  direct?: FulfillmentPricing;
  preorder?: ModelPreorder;
}

export interface SelectionPriceSnapshot {
  fulfillment_type: FulfillmentType;
  transport_method: TransportMethod | null;
  membership_tier: 'regular' | 'prime' | 'pro';
  resolved_product_base: number;
  resolved_option_delta: number;
  resolved_fulfillment_delta: number;
  resolved_transport_delta: number;
  resolved_membership_adjustment: number;
  resolved_delivery_fee: number;
  resolved_final_price: number;
  lead_time: { text: string; min_days: number | null; max_days: number | null };
}

export function modelSaleTypes(option: ModelAvailability | null | undefined, defaults: readonly string[]): FulfillmentType[] {
  if (option?.direct !== undefined || option?.preorder !== undefined) {
    return [option.direct?.enabled ? 'direct_sale' : '', option.preorder?.enabled ? 'pre_order' : '']
      .filter((t): t is FulfillmentType => !!t);
  }
  return defaults.flatMap((t) => t === 'bundle' ? ['direct_sale' as const] : t === 'direct_sale' || t === 'pre_order' ? [t] : []);
}

export function modelTransports(product: Pick<PricingProduct, 'preorder_transports'>, option?: OptionV2 | null): Array<TransportOffer & Partial<ModelTransport>> {
  const own = option?.preorder?.transports;
  if (own !== undefined) return own.map((t) => {
    const fallback = product.preorder_transports.find((d) => d.method === t.method);
    const merged = { ...fallback, ...t, active: t.enabled, commission_iqd: fallback?.commission_iqd ?? null };
    // Null means inherit; zero is a real override. A model fee replaces the
    // product fee as one pricing rung, never as a second commission.
    for (const key of ['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'cost_iqd', 'regular_adjust_iqd', 'prime_adjust_iqd', 'pro_adjust_iqd', 'cost_adjust_iqd'] as const) {
      merged[key] = t[key] ?? fallback?.[key] ?? null;
    }
    if (t.regular_price_iqd != null || t.regular_adjust_iqd != null || t.surcharge_iqd != null) {
      merged.regular_price_iqd = t.regular_price_iqd ?? null;
      merged.regular_adjust_iqd = t.regular_adjust_iqd ?? null;
      merged.surcharge_iqd = t.surcharge_iqd ?? 0;
      merged.commission_iqd = merged.surcharge_iqd;
      for (const tier of ['prime', 'pro'] as const) {
        merged[`${tier}_price_iqd`] = t[`${tier}_price_iqd`] ?? null;
        merged[`${tier}_adjust_iqd`] = t[`${tier}_adjust_iqd`] ?? null;
      }
    } else merged.surcharge_iqd = fallback?.surcharge_iqd ?? fallback?.commission_iqd ?? null;
    for (const tier of ['prime', 'pro'] as const) if (t[`${tier}_price_iqd`] != null || t[`${tier}_adjust_iqd`] != null) {
      merged[`${tier}_price_iqd`] = t[`${tier}_price_iqd`] ?? null;
      merged[`${tier}_adjust_iqd`] = t[`${tier}_adjust_iqd`] ?? null;
    }
    if (!t.lead_time_text && t.lead_time_min_days == null && t.lead_time_max_days == null) {
      merged.lead_time_text = fallback?.lead_time_text;
      merged.lead_time_min_days = fallback?.lead_time_min_days;
      merged.lead_time_max_days = fallback?.lead_time_max_days;
    }
    return merged;
  });
  return product.preorder_transports;
}

export function leadTimeOf(...levels: Array<Partial<FulfillmentPricing> | undefined | null>): SelectionPriceSnapshot['lead_time'] {
  const first = levels.find((l) => l && (l.lead_time_text || l.lead_time_min_days != null || l.lead_time_max_days != null));
  return { text: first?.lead_time_text ?? '', min_days: first?.lead_time_min_days ?? null, max_days: first?.lead_time_max_days ?? null };
}
