import { safeParse } from './types';

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
  // Admin defaults for preorder transport commissions (IQD), inherited by
  // products whose offer has commission_iqd = null. Unset (null) = unconfigured.
  preorderTransportDefaults: [
    { method: 'air', commission_iqd: null },
    { method: 'sea', commission_iqd: null },
    { method: 'land', commission_iqd: null },
  ] as Array<{ method: string; commission_iqd: number | null }>,
  // Owner-configured launch event for memberships (mandate §8.1).
  launchConfig: { launch_at: null, activated: false, activated_at: null } as {
    launch_at: string | null; activated: boolean; activated_at: string | null;
  },
  // PLUS gift on printer purchase: owner decisions pending (duration/milestone).
  printerGiftConfig: { enabled: false, plan_id: 'plus_1mo', milestone: 'delivered' } as {
    enabled: boolean; plan_id: string; milestone: 'paid' | 'delivered';
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
