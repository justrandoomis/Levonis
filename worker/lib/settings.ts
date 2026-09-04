import { safeParse } from './types';
import { DEFAULT_WARRANTY_CONFIG, type WarrantyConfig } from './warrantyConfig';
import { DEFAULT_PRICING, DEFAULT_MATERIALS, type PrintPricingConfig, type PrintMaterial } from './printPricing';
import { DEFAULT_MATCH_WEIGHTS, type MatchWeights } from './printMatching';
import { DEFAULT_LINK_PROVIDERS, type LinkProviderConfig } from './externalModels';

/** Typed access to the admin_settings key/value store, with safe defaults. */

export interface DeliveryMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  price_iqd: number;
  icon: string;
}
export interface CheckoutPaymentMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  icon: string;
}
export interface CartShippingMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
}
export interface ManualPaymentMethod {
  id: string;
  name: string;
  details: string;
}

export const SETTING_DEFAULTS = {
  /**
   * The warranty receipt's printed wording and the shop's own details.
   * Editable from the admin so the terms can change without a deploy; every
   * issued receipt keeps the copy it was printed with (migration 0042).
   */
  warrantyConfig: DEFAULT_WARRANTY_CONFIG as WarrantyConfig,
  exchangeRate: 1400, // IQD per 1 USD
  currency: 'IQD' as 'IQD' | 'USD',
  adVideoUrl: '',
  paymentMethods: [] as ManualPaymentMethod[],
  checkoutDeliveryMethods: [
    { id: 'standard', titleAr: 'توصيل عادي', titleEn: 'Standard Delivery', descAr: '2-3 أيام عمل', descEn: '2-3 business days', price_iqd: 5000, icon: 'Truck' },
    { id: 'personal', titleAr: 'توصيل شخصي', titleEn: 'Personal Delivery', descAr: 'نفس اليوم', descEn: 'Same day delivery', price_iqd: 10000, icon: 'User' },
    { id: 'pickup', titleAr: 'استلام من المخزن', titleEn: 'Store Pickup', descAr: 'جاهز خلال ساعتين', descEn: 'Ready in 2 hours', price_iqd: 0, icon: 'Store' },
  ] as DeliveryMethod[],
  checkoutPaymentMethods: [
    { id: 'wallet', titleAr: 'محفظة ليفو', titleEn: 'Levo Wallet', icon: 'Wallet' },
    { id: 'cash', titleAr: 'الدفع عند الاستلام', titleEn: 'Cash on Delivery', icon: 'Banknote' },
    { id: 'full_advance', titleAr: 'الدفع مقدما بالكامل', titleEn: 'Full Payment in Advance', icon: 'CreditCard' },
    { id: 'half_advance', titleAr: 'دفع نصف المبلغ مقدما', titleEn: '50% Payment in Advance', icon: 'CreditCard' },
  ] as CheckoutPaymentMethod[],
  cartShippingMethods: [
    { id: 'direct', titleAr: 'شحن مباشر', titleEn: 'Direct Shipping', descAr: 'يصل خلال 3-5 أيام عمل', descEn: 'Arrives in 3-5 business days' },
    { id: 'preorder_air', titleAr: 'طلب مسبق (شحن جوي)', titleEn: 'Pre-order (Air Freight)', descAr: 'يصل خلال 10-14 يوم عمل', descEn: 'Arrives in 10-14 business days' },
    { id: 'preorder_sea', titleAr: 'طلب مسبق (شحن بحري)', titleEn: 'Pre-order (Sea Freight)', descAr: 'يصل خلال 30-45 يوم عمل', descEn: 'Arrives in 30-45 business days' },
    { id: 'preorder_land', titleAr: 'طلب مسبق (شحن بري)', titleEn: 'Pre-order (Land Freight)', descAr: 'يصل خلال 20-30 يوم عمل', descEn: 'Arrives in 20-30 business days' },
  ] as CartShippingMethod[],
  homeSections: [] as Array<{ id: string; titleEn: string; titleAr: string; isVisible: boolean }>,
  homeBanners: {} as Record<string, Array<{ id: string; image: string; link: string }>>,
  homeSectionItems: {} as Record<string, Array<{ id: string; title: string; subtitle: string; image: string; link: string }>>,
  homeAds: [] as Array<{ id: string; text: string; animation: string }>,
  // PRO pricing fallback when no explicit PRO price exists on a product/option/color.
  // 'explicit_only' = no fabricated discount (default until the owner approves a rule).
  proPricingPolicy: { mode: 'explicit_only', percent: null } as { mode: 'explicit_only' | 'global_percent'; percent: number | null },
  /**
   * §13 profit guard. The smallest gross margin (percent of the SELLING price)
   * the admin wants to be warned below. null = no floor configured, so only
   * "price below cost" warns — a number invented here would fire on healthy
   * products and train the owner to click through the warning.
   *
   * It WARNS, it does not veto: the quick-edit and bulk endpoints refuse the
   * write only until an explicit confirm flag arrives, so a deliberate
   * clearance price is still one confirmation away.
   */
  minMarginPercent: null as number | null,
  // Admin defaults for preorder transport commissions (IQD), inherited by
  // products whose offer has commission_iqd = null. Unset (null) = unconfigured.
  preorderTransportDefaults: [
    { method: 'air', commission_iqd: null },
    { method: 'sea', commission_iqd: null },
    { method: 'land', commission_iqd: null },
  ] as Array<{ method: string; commission_iqd: number | null }>,
  // LEVO Community commission and lifecycle timings (§30, §34, §75).
  // Percentages are held in HUNDREDTHS of a percent so the split stays
  // integer arithmetic all the way to the ledger — 500 = 5.00%. The seeded
  // values are conservative starting points, not a business decision; the
  // owner sets the real rates in the community admin, and whatever they are
  // at the moment of sale is snapshot onto that order forever.
  communityFeeRequestPercentX100: 500,
  communityFeeStorePercentX100: 500,
  communityFeeMinIqd: 0,
  // Days a customer has to confirm or dispute before work auto-completes.
  // 0 disables automatic release entirely — the safe default for a policy
  // that has not been decided yet, because it means money only ever moves
  // when a human says so.
  communityAutoCompleteDays: 7,
  communityRequestExpiryDays: 30,
  // Owner-configured launch event for memberships (mandate §8.1).
  launchConfig: { launch_at: null, activated: false, activated_at: null } as {
    launch_at: string | null; activated: boolean; activated_at: string | null;
  },
  // PLUS gift on printer purchase: owner decisions pending (duration/milestone).
  printerGiftConfig: { enabled: false, plan_id: 'plus_1mo', milestone: 'delivered' } as {
    enabled: boolean; plan_id: string; milestone: 'paid' | 'delivered';
  },
  /**
   * «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية» — a spool ships with a
   * pre-order that an active PRO paid in full at checkout.
   *
   * DISABLED WITH NOTHING CHOSEN, deliberately. The rule names a benefit but
   * not which filament it means, and a default here would be the store giving
   * away stock nobody approved. While `enabled` is false or `product_id` is
   * empty, no order records a gift and nothing is promised to a customer.
   * `label_ar` is what the customer is told when the product itself is not
   * the whole answer ("بكرة PLA بلون من اختيارك").
   */
  preorderGiftConfig: { enabled: false, product_id: '', label_ar: '', qty: 1 } as {
    enabled: boolean; product_id: string; label_ar: string; qty: number;
  },
  // Last-mile shipping policy (final-phase brief §6.3). Confirmed values are
  // filled; unresolved parts stay null and produce honest needs_config
  // states instead of invented fees.
  shippingPolicy: {
    ordinary_iqd: 5000,
    printer_small_iqd: null,      // 25,000 or 50,000 mapping pending owner (decision log)
    printer_large_iqd: null,
    pro_threshold_iqd: 75000,     // STRICTLY greater-than qualifies (75,000 does NOT)
    threshold_basis: 'merchandise_after_coupon', // pending owner confirmation
    pro_waiver_covers: 'all',     // 'all' | 'ordinary_only' — pending owner confirmation
    // LEVO PRIME (product-form mandate §5): the owner stated 150,000 IQD
    // explicitly, so it is a real default, not a placeholder. STRICTLY
    // greater-than qualifies (150,000 does NOT; 150,001 does).
    prime_threshold_iqd: 150000,
    // §5 gives PRIME no PRO benefit beyond this waiver, so it covers the
    // ordinary delivery fee only — printer and carton surcharges stay payable.
    prime_waiver_covers: 'ordinary_only',
    carton_threshold_spools: null, // >10 spools MAY incur a carton fee — amount pending
    carton_fee_iqd: null,
    printer_advance_required: true,
    // Protected (boxed/insured) delivery as an opt-in add-on ON TOP of the
    // ordinary tariff. null = the owner has not priced it, so the option is
    // not offered at checkout at all — an unpriced benefit is not a benefit,
    // and inventing a number here would charge a fee nobody set.
    protected_iqd: null,
  } as {
    ordinary_iqd: number;
    printer_small_iqd: number | null;
    printer_large_iqd: number | null;
    pro_threshold_iqd: number;
    threshold_basis: 'merchandise_after_coupon' | 'merchandise_before_coupon';
    pro_waiver_covers: 'all' | 'ordinary_only';
    prime_threshold_iqd: number;
    prime_waiver_covers: 'all' | 'ordinary_only';
    carton_threshold_spools: number | null;
    carton_fee_iqd: number | null;
    printer_advance_required: boolean;
    protected_iqd: number | null;
  },
  // Points for approved NON-printer product reviews (final-phase §5). The
  // value is an owner decision (decision row 20) — disabled and unpriced
  // until configured; reviews.ts reads it and shows an honest pending state.
  reviewPointsConfig: { enabled: false, points: null } as {
    enabled: boolean; points: number | null;
  },
  // How long an order waits in each AUTOMATIC tracking stage, in minutes.
  // The owner asked for every automatic transition to be editable "وخاصة
  // Air / Sea / Land", so the three freight waits are separate keys rather
  // than one shared number. The defaults live in worker/lib/orderStages.ts
  // (DEFAULT_STAGE_DURATIONS) and this stays {} until an owner overrides
  // something — an empty object means "use the defaults", not "wait zero".
  orderStageDurations: {} as Record<string, number>,
  /**
   * The local courier's wire format — endpoint paths and the map from our
   * field names to theirs. NOT credentials: those are Worker secrets
   * (ALWASEET_*) and never a settings row, because a settings row is
   * readable by every admin screen and the owner's rule is that no token or
   * login ever reaches the frontend.
   *
   * Empty until someone reads the Merchant API documentation — see the long
   * note at the top of worker/lib/delivery/alwaseet.ts. Until then the
   * integration reports itself as unconfigured rather than sending guesses.
   */
  deliveryConfig: {} as Record<string, unknown>,
  /**
   * The print-service rates the price calculator adds on top of material.
   *
   * NOT SEEDED WITH GUESSES. Material cost the calculator can work out
   * honestly — it divides a real spool's real price by its real net weight —
   * but what LEVONIS charges for machine time, setup and margin is the
   * owner's business decision, and inventing a number would produce a quote
   * a customer might act on. Null means "not configured", and the calculator
   * says so instead of filling the gap.
   */
  printServicePricing: {
    machine_iqd_per_hour: null,
    setup_fee_iqd: null,
    margin_percent: null,
  } as { machine_iqd_per_hour: number | null; setup_fee_iqd: number | null; margin_percent: number | null },

  /**
   * THE PRINT-REQUEST COST MODEL. Every rate, factor and threshold the estimate
   * is built from — labour, machine hours, energy, waste, supports, purge,
   * failure risk, complexity, the margin floor and the minimum job.
   *
   * NOT PUBLIC, and `printServicePricing` above is left exactly as it was. That
   * one IS in PUBLIC_SETTING_KEYS, so anything added to it would be readable by
   * a signed-out visitor — and a competitor should not be able to download the
   * owner's cost structure by opening the site.
   */
  printPricingConfig: DEFAULT_PRICING as PrintPricingConfig,

  /**
   * The material catalogue: reference price, density, waste factor, support
   * factor and minimum economic cost per filament and resin, exactly as the
   * owner listed them. Also NOT public — a merchant's buying price is not
   * customer-facing. The wizard receives a stripped projection (names and ids
   * only) from the print API instead.
   */
  printMaterials: DEFAULT_MATERIALS as PrintMaterial[],

  /** What each matching signal is worth. Tuning these re-ranks who hears about
   *  a request; it can never make an incompatible merchant eligible. */
  printMatchWeights: DEFAULT_MATCH_WEIGHTS as MatchWeights,

  /** How many merchants one published request may notify. A cap, not a filter:
   *  everyone eligible can still find it on the public board. */
  printMatchNotifyLimit: 25,

  /**
   * External model providers. `api_url` is EMPTY by default on purpose: Levonis
   * knows what a MakerWorld permalink looks like, and the owner decides whether
   * and where to ask MakerWorld about it. Nothing is scraped, ever.
   */
  printLinkProviders: DEFAULT_LINK_PROVIDERS as LinkProviderConfig[],
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

// Settings a signed-out storefront visitor may read.
export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  'exchangeRate',
  'currency',
  'adVideoUrl',
  'paymentMethods',
  'checkoutDeliveryMethods',
  'checkoutPaymentMethods',
  'cartShippingMethods',
  'homeSections',
  'homeBanners',
  'homeSectionItems',
  'homeAds',
  // The calculator is a public tool; the rates on it are a published price
  // list, not internal policy.
  'printServicePricing',
  // NOTE: proPricingPolicy, preorderTransportDefaults, launchConfig and
  // printerGiftConfig are intentionally NOT public — internal policy data.
];

export async function getSettings(db: D1Database, keys?: SettingKey[]): Promise<Record<string, unknown>> {
  const wanted = keys ?? SETTING_KEYS;
  const placeholders = wanted.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT key, value FROM admin_settings WHERE key IN (${placeholders})`)
    .bind(...wanted)
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const k of wanted) {
    out[k] = map.has(k) ? safeParse(map.get(k), SETTING_DEFAULTS[k]) : SETTING_DEFAULTS[k];
  }
  return out;
}

export async function getSetting<K extends SettingKey>(db: D1Database, key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return SETTING_DEFAULTS[key];
  return safeParse(row.value, SETTING_DEFAULTS[key]);
}

export async function setSetting(db: D1Database, key: SettingKey, value: unknown): Promise<void> {
  await db
    .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value))
    .run();
}
