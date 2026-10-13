/**
 * WHAT A CUSTOMER MAY RECEIVE ABOUT A PRICE: THE FINAL NUMBERS, NOTHING ELSE
 * (Pricing V2, step V2-0 item C5; DECISIONS rows 220 and 225).
 *
 * The owner's rule (2026-10-10): «المستخدم واي شخص يحصل فقط على السعر النهائي
 * لا يتسرب تكلفه او عمليه حسابيه نهائيا». Cost was already stripped from every
 * customer payload; the ARITHMETIC was not. `publicQuote` removed `cost_iqd`
 * and sent the rest of the resolver's answer — `components` (every rung of the
 * ladder and every fee), `price_source`, `member_rule`, `pricing_basis`, the
 * route commission and the direct-sale premium — to every visitor of a product
 * page, every cart and every checkout. None of it is rendered; all of it let a
 * reader rebuild how a price was made.
 *
 * So every customer-facing price object is now built HERE from an ALLOW-LIST.
 * A field the resolver grows tomorrow does not reach a customer until someone
 * names it below on purpose — the opposite of a strip list, which leaks by
 * default. Admin and owner payloads are not touched by this module.
 *
 * DEFERRED, NOT FORGOTTEN (V2-7). Some facts are still rendered to customers
 * today and are therefore KEPT until the policy version that retires them
 * (purchase policy 3.3 promises the commission or the direct-sale premium is
 * disclosed before confirmation; DECISIONS row 190):
 *   - order line `pricing.pricing_basis`   OrderDetail «سُعِّر كبيع مباشر»
 *   - order line `pricing.direct.surcharge_iqd`
 *                                          PaymentBreakdown fee naming
 *   - order line `pricing.transport.commission_iqd`,
 *     `transport.commission_iqd`           PaymentBreakdown fee naming
 *   - checkout quote `pricing_basis` (with `cod_surcharge_iqd`, `cod_reprices`)
 *                                          Checkout's «عمولة الدفع عند الاستلام»
 *                                          row and the cash-option note (C6,
 *                                          pinned by codDifferenceDisclosed)
 * `CUSTOMER_DEFERRED_ARITHMETIC` lists them by path so the leak scanners can
 * hold every other occurrence at zero.
 */
import type { ResolvedPrice, ResolvedWarranty } from './pricing';

/**
 * Arithmetic a customer payload must never carry: the steps of a price, not
 * the price. The public-channel scanners (tests/costPublicChannels.test.ts,
 * tests/securityPricingLeak.test.ts) fail on any of these keys outside the
 * deferred paths below, so a removed key cannot quietly come back.
 */
export const CUSTOMER_ARITHMETIC_KEYS = [
  // the resolver's working
  'components',
  'price_source',
  'member_rule',
  'pricing_basis',
  'membership_adjustment_iqd',
  'transport_fee_iqd',
  'direct_fee_iqd',
  'warranty_fee_iqd',
  // the fees, named
  'commission_iqd',
  'surcharge_iqd',
  'direct_surcharge_iqd',
  // the raw ladder beneath the final price
  'regular_price_iqd',
  'regular_adjust_iqd',
  'prime_adjust_iqd',
  'pro_adjust_iqd',
] as const;

/**
 * A chosen warranty plan's FORMULA (the percent and the price it was taken
 * of): never on a line's `warranty`, which carries the plan and its fee. The
 * plan catalogue (`warranty_plans`) is a separate list and keeps its terms.
 */
export const CUSTOMER_WARRANTY_ARITHMETIC_KEYS = ['fee_percent', 'basis_iqd'] as const;

/**
 * Paths (in the scanners' `$.a[0].b` notation, indices as `[n]`) where a key
 * above is still RENDERED to a customer today, kept until V2-7 retires it with
 * a new policy version. Anything else is a leak.
 */
export const CUSTOMER_DEFERRED_ARITHMETIC: readonly RegExp[] = [
  /^\$\.quote\.pricing_basis$/,
  /\.items\[n\]\.pricing\.pricing_basis$/,
  /\.items\[n\]\.pricing\.direct\.surcharge_iqd$/,
  /\.items\[n\]\.pricing\.transport\.commission_iqd$/,
  /\.items\[n\]\.transport\.commission_iqd$/,
];

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The extended-warranty plan on a line, as a customer reads it: what it is and what it costs — never its formula. */
export interface CustomerWarranty {
  plan_id: string;
  title_ar: string;
  title_en: string;
  fee_iqd: number;
  duration_months: number;
  duration_kind: string;
  base_months: number | null;
  total_months: number | null;
}

export function customerWarranty(w: ResolvedWarranty | Record<string, unknown> | null | undefined): CustomerWarranty | null {
  const r = rec(w);
  if (!r) return null;
  return {
    plan_id: text(r.plan_id),
    title_ar: text(r.title_ar),
    title_en: text(r.title_en),
    fee_iqd: num(r.fee_iqd) ?? 0,
    duration_months: num(r.duration_months) ?? 0,
    duration_kind: text(r.duration_kind),
    base_months: num(r.base_months),
    total_months: num(r.total_months),
  };
}

/**
 * ONE LINE'S PRICE, AS A CUSTOMER MAY SEE IT — the product page quote, the
 * cart line's `breakdown` and the checkout line's `breakdown` all answer with
 * this shape. The struck regular price is kept because it is the only honest
 * saving (an offer or a member price); the order type and the route are kept
 * because they are what the customer chose. Nothing that adds up to the price.
 */
export interface CustomerLinePrice {
  regular_iqd: number;
  applied_iqd: number;
  applied_tier: ResolvedPrice['applied_tier'];
  unit_subtotal_iqd: number;
  fulfillment: {
    type: 'direct_sale' | 'pre_order';
    lead_time_text: string;
    lead_time_min_days: number | null;
    lead_time_max_days: number | null;
  } | null;
  transport: { method: string } | null;
  warranty: CustomerWarranty | null;
  errors: string[];
}

export function customerLinePrice(r: ResolvedPrice): CustomerLinePrice {
  const f = r.fulfillment as ResolvedPrice['fulfillment'] | null | undefined;
  return {
    regular_iqd: r.regular_iqd,
    applied_iqd: r.applied_iqd,
    applied_tier: r.applied_tier,
    unit_subtotal_iqd: r.unit_subtotal_iqd,
    fulfillment: f
      ? {
          type: f.type,
          lead_time_text: f.lead_time_text ?? '',
          lead_time_min_days: f.lead_time_min_days ?? null,
          lead_time_max_days: f.lead_time_max_days ?? null,
        }
      : null,
    transport: r.transport ? { method: r.transport.method } : null,
    warranty: customerWarranty(r.warranty),
    errors: [...r.errors],
  };
}

/**
 * The price block of a STORED order line, as its buyer reads it back
 * (`order_items.pricing_snapshot` is never rewritten — this is applied when it
 * is served). The final figures, the gift, and the three deferred facts above.
 */
export function customerOrderPricing(snapshot: unknown): Record<string, unknown> | null {
  const s = rec(snapshot);
  if (!s) return null;
  const out: Record<string, unknown> = {};
  for (const k of ['regular_iqd', 'applied_iqd', 'unit_subtotal_iqd'] as const) {
    if (num(s[k]) !== null) out[k] = s[k];
  }
  if (typeof s.applied_tier === 'string') out.applied_tier = s.applied_tier;
  const f = rec(s.fulfillment);
  if (f && (f.type === 'direct_sale' || f.type === 'pre_order')) {
    out.fulfillment = {
      type: f.type,
      lead_time_text: text(f.lead_time_text),
      lead_time_min_days: num(f.lead_time_min_days),
      lead_time_max_days: num(f.lead_time_max_days),
    };
  }
  const gift = rec(s.gift);
  if (gift) out.gift = { gift_id: text(gift.gift_id), level: num(gift.level) ?? 0, value_iqd: num(gift.value_iqd) ?? 0 };
  // ---- DEFERRED to V2-7 (rendered today; see the header) ----
  if (s.pricing_basis === 'direct' || s.pricing_basis === 'preorder') out.pricing_basis = s.pricing_basis;
  const direct = rec(s.direct);
  out.direct = direct ? { surcharge_iqd: num(direct.surcharge_iqd) ?? 0, waived: direct.waived === true } : null;
  if ('transport' in s) out.transport = customerOrderTransport(s.transport);
  return out;
}

/** A stored line's journey: the route (rendered) and, DEFERRED to V2-7, the commission and its waiver (fee naming). */
export function customerOrderTransport(snapshot: unknown): Record<string, unknown> | null {
  const t = rec(snapshot);
  if (!t) return null;
  return {
    method: text(t.method),
    commission_iqd: num(t.commission_iqd) ?? 0,
    waived: t.waived === true,
    ...(typeof t.waived_by === 'string' ? { waived_by: t.waived_by } : {}),
  };
}

/**
 * A sale-availability verdict as a customer receives it: the routes and
 * whether each is priced — never the route fee itself, which the pills already
 * fold into each route's final price (`pricing_modes`).
 */
export type CustomerAvailability<T extends { preorder: { transports: ReadonlyArray<{ method: string; configured: boolean }> } }> =
  Omit<T, 'preorder'> & { preorder: Omit<T['preorder'], 'transports'> & { transports: Array<{ method: string; configured: boolean }> } };

export function customerAvailability<T extends { preorder: { transports: ReadonlyArray<{ method: string; configured: boolean }> } }>(
  a: T
): CustomerAvailability<T> {
  return {
    ...a,
    preorder: { ...a.preorder, transports: a.preorder.transports.map((t) => ({ method: t.method, configured: t.configured })) },
  } as unknown as CustomerAvailability<T>;
}
