import { safeParse } from './types';
import { DEFAULT_WARRANTY_CONFIG, type WarrantyConfig } from './warrantyConfig';
import { DEFAULT_PRICING, DEFAULT_MATERIALS, type PrintPricingConfig, type PrintMaterial } from './printPricing';
import { DEFAULT_ACCESSORIES, type PrintAccessory } from './printAccessories';
import { DEFAULT_MATCH_WEIGHTS, type MatchWeights } from './printMatching';
import { DEFAULT_LINK_PROVIDERS, type LinkProviderConfig } from './externalModels';
import { FARM_CONFIG_DEFAULTS, type FarmConfig } from './farm/config';
import {
  DEFAULT_DELIVERY_DAY_POLICY,
  resolveDeliveryDayPolicy,
  type DeliveryDayPolicy,
} from './deliveryDay';

/** Typed access to the admin_settings key/value store, with safe defaults. */

export interface DeliveryMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  price_iqd: number;
  icon: string;
  /**
   * Does this method end at the CUSTOMER'S DOOR? It decides whether an order
   * gets a delivery day at all — there is no "which day do you want it" for a
   * pickup, because nobody is driving anywhere.
   *
   * OPTIONAL, AND `undefined` MEANS "infer `id !== 'pickup'`". The existing
   * test for "no last mile" is the hardcoded `delivery.id === 'pickup'` at
   * checkout, and `checkoutDeliveryMethods` is an ADMIN-EDITABLE array: the
   * day the owner adds «استلام من الفرع الثاني» that test silently
   * misclassifies it as a home delivery and starts asking its customers which
   * day to drive to them. A method that carries the flag declares itself; one
   * that does not keeps exactly today's behaviour, so nothing stored before
   * this field existed changes meaning. Read it through `deliversToHome`.
   */
  home_delivery?: boolean;
  /**
   * WHERE THE CUSTOMER IS BEING ASKED TO COME.
   *
   * «عند الضغط على الاستلام من المخزن … اجعل هناك ملاحظة يظهر فيها عرض مكان
   *  المخزن على الخريطة».
   *
   * A pickup method asks somebody to drive somewhere, and the checkout could
   * not say where: the card said «محسوب حسب القطع والكمية», which is a
   * sentence about a FEE and is meaningless on a method that has none.
   *
   * OPTIONAL, AND ABSENT MEANS NO LINK IS DRAWN. The shop's address is not
   * something this repository knows or may guess — inventing a map pin for a
   * warehouse would send customers to a place that does not exist. The owner
   * pastes the link they already use (Google Maps, OpenStreetMap, anything
   * with an https URL) into the admin's delivery-method row, and only then
   * does the card offer it. `checkoutDeliveryMethods` is admin-editable, so
   * this belongs to the METHOD rather than to a single global setting: a shop
   * with two pickup points gives each its own.
   *
   * It is rendered as an ordinary external link and never embedded: an iframe
   * would put a third party's script inside the checkout, which the CSP
   * refuses and which nothing here needs.
   */
  map_url?: string;
}
export interface CheckoutPaymentMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  icon: string;
}
/**
 * «خدمه اقساطي على تطبيق جني ( مصرف الرافدين )» — the instalments service the
 * customer takes out in the Gini app, financed entirely outside Levonis.
 *
 * THE TEXT IS HAND-WRITTEN IN THREE LANGUAGES and is the actual condition the
 * customer has to meet — «الشروط يكون موظفا على مصرف الرافدين». It lives in a
 * setting rather than in the bundle because it is a bank's rule: the day
 * Rafidain widens it past its own staff, the owner edits a form instead of
 * waiting for a deploy. Nothing here is machine-translated, and an owner who
 * clears one language is shown the next one they DID write (`pickText`),
 * never a placeholder.
 */
export interface GiniPolicy {
  enabled: boolean;
  /** Who Gini will finance, as the bank states it — shown in the popup. */
  conditions: { ar: string; en: string; ckb: string };
  /**
   * «يبقى الطلب معلقا حتى ٢٤ ساعه ويلغي في حال عدم الاستجابة» — how long an
   * order waits for the Gini receipt scan before the sweep releases its stock
   * and cancels it. Hours, not minutes: this is a bank's queue, not a
   * checkout timeout.
   */
  hold_hours: number;
  /**
   * Where «تريدها اقساط ؟» sends a customer whose product carries no
   * `gini_url` of its own — the app's own landing page. Empty means the note
   * is shown without a link rather than pointing at a page that cannot show
   * the product.
   */
  app_url: string;
}
export interface BnplPolicy {
  enabled: boolean;
  due_days: number;
  min_order_iqd: number;
  max_order_iqd: number | null;
  require_verified_identity: boolean;
  require_approved_address: boolean;
}
export interface ProPriorityDeliveryConfig {
  enabled: boolean;
  max_hours: 12;
  delivery_method_ids: string[];
  shipping_types: string[];
  /** Empty means every address already served by the selected method. */
  governorates: string[];
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
  /**
   * 1 USD = 1,400 IQD — A CONFIRMED FIGURE, NOT A PLACEHOLDER.
   *
   * The owner answered the standing question on 2026-09-23 («نعم في سعر الصرف
   * أكمل وأطبق القرار») and docs/DECISIONS.md row 6 is now ✅: the rate stands
   * at 1,400 and the rounding policy stands exactly as written. This comment
   * exists because the number did not change — without it, the next reader
   * finds a bare literal on a money path and has no way to tell a decision
   * from a guess, which is how the same question gets asked a fourth time.
   *
   * THE ROUNDING IS A PAIR AND IT LEANS ONE WAY ON PURPOSE.
   * `iqdToUsdCents` rounds UP and `usdCentsToIqd` rounds DOWN
   * (worker/lib/escrowOps.ts), so a hold never under-reserves and a spendable
   * balance is never reported as covering a total it cannot actually pay.
   * `corroboratedDeclaredIqd` (worker/lib/walletOps.ts) accepts both `floor`
   * and `floor + 1` so a client that has not reloaded since the rate moved is
   * not refused. None of that is changed by this decision; it is ratified.
   *
   * IT IS STILL A SETTING, and confirming it did not freeze it. The admin
   * writes it through `PATCH` with `int(value, …, { min: 1, max: 1_000_000 })`
   * (worker/routes/admin.ts), and every operation stores an
   * `exchange_rate_snapshot` of the rate it actually used, so moving the rate
   * tomorrow cannot rewrite what somebody was charged today.
   */
  exchangeRate: 1400, // IQD per 1 USD — confirmed, DECISIONS.md row 6
  /**
   * THE COURIER'S CASH-HANDLING CHARGE, «قابله للتغير من قبل الادارة».
   *
   * 3,000 IQD for every complete 500,000 IQD collected at the door. It was two
   * constants compiled into packages/shipping until the owner halved the rate
   * and asked for it to be theirs; it is a setting so the next change is a
   * form field rather than a deploy.
   *
   * CHANGING IT IS NOT RETROACTIVE. `orders.cod_tax_iqd` is written at
   * placement and every read of a past order takes that stored figure, so
   * lowering the rate today cannot rewrite what somebody was charged last
   * month. Both halves are PUBLIC because the checkout has to print the rate
   * in a sentence before any quote exists — and a sentence quoting a
   * different number from the charge is the defect this replaces.
   */
  codTaxPerBlockIqd: 3_000,
  codTaxBlockIqd: 500_000,
  currency: 'IQD' as 'IQD' | 'USD',
  adVideoUrl: '',
  paymentMethods: [] as ManualPaymentMethod[],
  checkoutDeliveryMethods: [
    { id: 'standard', titleAr: 'توصيل عادي', titleEn: 'Standard Delivery', descAr: '2-3 أيام عمل', descEn: '2-3 business days', price_iqd: 5000, icon: 'Truck', home_delivery: true },
    { id: 'personal', titleAr: 'توصيل شخصي', titleEn: 'Personal Delivery', descAr: 'نفس اليوم', descEn: 'Same day delivery', price_iqd: 10000, icon: 'User', home_delivery: true },
    { id: 'pickup', titleAr: 'استلام من المخزن', titleEn: 'Store Pickup', descAr: 'جاهز خلال ساعتين', descEn: 'Ready in 2 hours', price_iqd: 0, icon: 'Store', home_delivery: false },
  ] as DeliveryMethod[],
  checkoutPaymentMethods: [
    { id: 'wallet', titleAr: 'محفظة ليفو', titleEn: 'Levo Wallet', icon: 'Wallet' },
    { id: 'cash', titleAr: 'الدفع عند الاستلام', titleEn: 'Cash on Delivery', icon: 'Banknote' },
    { id: 'bnpl', titleAr: 'اشترِ الآن وادفع لاحقًا', titleEn: 'Buy Now, Pay Later', icon: 'CalendarClock' },
    // «خيار ناعم وبسيط ليس ضخما» — it sits under cash on delivery, and it is
    // a row here for one reason only: checkout intersects this setting with
    // the server's allowed list, so an id missing from it is invisible with no
    // error at all. `normalizedSetting` rescues it on a configured shop.
    { id: 'gini', titleAr: 'أقساط عبر تطبيق جني', titleEn: 'Instalments via Gini', icon: 'Landmark' },
    { id: 'full_advance', titleAr: 'الدفع مقدما بالكامل', titleEn: 'Full Payment in Advance', icon: 'CreditCard' },
    { id: 'half_advance', titleAr: 'دفع نصف المبلغ مقدما', titleEn: '50% Payment in Advance', icon: 'CreditCard' },
  ] as CheckoutPaymentMethod[],
  // PRO-only financing. Access also requires an individually approved account,
  // verified identity and the approved default address; no fee is invented.
  bnplPolicy: {
    enabled: true,
    due_days: 30,
    min_order_iqd: 10000,
    max_order_iqd: null,
    require_verified_identity: true,
    require_approved_address: true,
  } as BnplPolicy,
  /**
   * Gini instalments (Qi Card / Rafidain Bank). SHIPS ENABLED because the
   * owner asked for the service itself, not for a switch to find later — and
   * enabling it adds one soft row to checkout and one note on the product
   * page, neither of which can move a dinar on an order that does not choose
   * it.
   *
   * THE HOLD IS THE OWNER'S NUMBER, WRITTEN DOWN. Twenty-four hours is the
   * wait a Gini order gets before `giniSweep.ts` releases its stock; changing
   * it here changes the sweep, and never an order already placed, whose
   * `gini_hold_until` was frozen at checkout.
   */
  giniPolicy: {
    enabled: true,
    conditions: {
      ar: 'خدمة التقسيط عبر تطبيق جني متاحة لموظفي مصرف الرافدين. يتم شراء المنتج وتقسيطه داخل تطبيق جني، ويُدفع سعر التوصيل فقط عند الاستلام.',
      en: 'Gini instalments are available to Rafidain Bank employees. The product is bought and financed inside the Gini app; only the delivery fee is paid on receipt.',
      ckb: 'خزمەتگوزاری قیستی ئەپی جینی بۆ فەرمانبەرانی بانکی ڕافیدەین بەردەستە. بەرهەمەکە لە ناو ئەپی جینی دەکڕدرێت و قیست دەکرێت، تەنها کرێی گەیاندن لە کاتی وەرگرتن دەدرێت.',
    },
    hold_hours: 24,
    app_url: '',
  } as GiniPolicy,
  // The existing same-day personal-delivery method is the initially supported
  // 12-hour service area. Admin configuration can add methods/regions later.
  proPriorityDelivery: {
    enabled: true,
    max_hours: 12,
    delivery_method_ids: ['personal'],
    shipping_types: ['direct'],
    governorates: [],
  } as ProPriorityDeliveryConfig,
  /**
   * «يستطيع اختيار وتغيير يوم التوصيل في أي وقت يريد ولكن بحد أقصى أسبوع» —
   * the customer names their delivery day, up to a week out.
   *
   * SHIPS ENABLED, at 7 days, AGAINST the house rule that a new policy ships
   * off (orderExpiryConfig, printerGiftConfig, preorderGiftConfig all do). The
   * owner asked for this one directly and named the number — «الأسبوع أقصد به
   * مدة سبعة أيام من تاريخ الطلب» — so it is a decision, not an oversight, and
   * it is written down in both places rather than left to be discovered.
   *
   * Deployed behaviour still does not change: migration 0094 backfills
   * nothing, so every existing order stays `delivery_day_schedulable = 0` with
   * a NULL day and the policy first applies to the next new checkout.
   *
   * The shape and the 1..30 clamp live in worker/lib/deliveryDay.ts, and
   * `normalizedSetting` reads through the same `resolveDeliveryDayPolicy` the
   * admin route validates with — so what is stored is what runs.
   */
  deliveryDayPolicy: DEFAULT_DELIVERY_DAY_POLICY as DeliveryDayPolicy,
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
  /**
   * Main-page artwork the owner replaces from the admin: slot id → the object
   * name inside `UiUx/MainPage/`. Empty means every slot uses the seeded
   * default, which is why the brand strip works before anyone touches this.
   * Written only by POST/DELETE /api/admin/site-media/:slot — see
   * worker/lib/siteMedia.ts for why an upload mints a new object name instead
   * of overwriting one.
   */
  mainPageMedia: {} as Record<string, string>,
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
  /**
   * THE PRINTER HOME-DELIVERY NOTE — «for printers, show a note stating that
   * 50,000 IQD must be paid when requesting home delivery — only as a note».
   *
   * An amount shown beside a printer on the product page, in the cart, at
   * checkout and on the order; it is never added to any total by any code
   * path, and it is not the printer delivery FEE mapping (shippingPolicy
   * printer_small/large_iqd, decision row 16), which stays unconfigured. The
   * owner named the number, so 50,000 is a real default, editable here.
   */
  printerHomeDeliveryNoteIqd: 50000,
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
  // WHEN AN ABANDONED CHECKOUT LETS GO OF ITS STOCK (owner decision 5).
  // Ships OFF and at zero: until an owner turns it on, nothing is expired and
  // the behaviour is identical to before the feature existed. The shape and
  // the clamps live in worker/lib/orderExpiry.ts, and the admin route
  // validates through the same function the sweep reads with. Internal ops
  // policy — deliberately NOT in PUBLIC_SETTING_KEYS.
  orderExpiryConfig: { enabled: false, ttl_minutes: 0, batch_limit: 100 } as {
    enabled: boolean; ttl_minutes: number; batch_limit: number;
  },
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
  /**
   * «إكسسوارات ميكر وورد» — the magnets, motors, LEDs and keyrings a printed
   * model calls for. A catalogue and not a material: priced per piece, and the
   * count comes from the model's instructions rather than from its geometry.
   * worker/lib/printAccessories.ts says why that distinction is load-bearing.
   */
  printAccessories: DEFAULT_ACCESSORIES as PrintAccessory[],

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

  /**
   * LEVO PRINTER FARM — every number the game runs on (docs/PRINTER_FARM.md
   * §5): prices, rates, probabilities, rewards, deadlines, thresholds, limits.
   * One versioned document; defaults live in worker/lib/farm/config.ts (a leaf
   * module) and are normalised on every read.
   *
   * NOT PUBLIC: `limits` and `rewards` are anti-abuse and Points budgets, and
   * the game serves players `publicFarmConfig(cfg)` from its own route.
   * NOT WRITABLE through the generic PUT /api/admin/settings/:key either — the
   * farm admin route (/api/admin/farm/config) is the only write path, because
   * it is the one that normalises, checks `farmConfigProblems`, bumps `version`
   * and audits before/after per section.
   */
  printerFarmConfig: FARM_CONFIG_DEFAULTS as FarmConfig,
};

/**
 * The printer note amount as stored, or null when nothing usable is
 * configured. The admin settings endpoint stores this key generically, so the
 * read side is where a blank, a zero or a stray string becomes "no note"
 * rather than a fabricated figure on a customer's screen.
 */
export function printerNoteIqdFrom(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Does this delivery method end at the customer's door?
 *
 * THE ONE PLACE THE INFERENCE LIVES. An explicit `home_delivery` wins; absent,
 * it falls back to the existing hardcoded test — `id !== 'pickup'` — so every
 * method configured before the flag existed keeps behaving exactly as it does
 * today. Callers use this instead of re-testing the id, which is how a method
 * the owner adds tomorrow gets to declare itself.
 *
 * MERCHANT ORDERS DO NOT PASS THROUGH HERE AT ALL. They insert into the same
 * `orders` table with `delivery_method_id = 'merchant'`, which is not a row in
 * this array, so a caller resolving a method by id gets `undefined` and must
 * decide for itself — it must not fall through to "true".
 */
export function deliversToHome(method: Pick<DeliveryMethod, 'id' | 'home_delivery'>): boolean {
  return typeof method.home_delivery === 'boolean' ? method.home_delivery : method.id !== 'pickup';
}

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

// Settings a signed-out storefront visitor may read.
export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  'exchangeRate',
  // The checkout explains the door charge before it can quote one, so the
  // rate the sentence quotes has to be readable without an order.
  'codTaxPerBlockIqd',
  'codTaxBlockIqd',
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
  // Brand marks and service icons on the first screen a signed-out visitor
  // sees. Public by nature; the bytes themselves are already anonymous.
  'mainPageMedia',
  // The calculator is a public tool; the rates on it are a published price
  // list, not internal policy.
  'printServicePricing',
  // The printer note is customer-facing copy: the product page and the cart
  // read it before any quote exists.
  'printerHomeDeliveryNoteIqd',
  // «تريدها اقساط ؟» is drawn on the product page, which a signed-out visitor
  // sees, and the popup has to state the Rafidain condition there — before
  // any cart, any quote or any account exists. The three fields are the offer
  // itself, in the bank's own words; nothing internal is in them.
  'giniPolicy',
  // Checkout has to draw the day picker BEFORE an order exists, so it needs
  // `max_days` and `allow_same_day` with nothing to read them off. The three
  // values are the offer itself — the same thing the picker puts on screen —
  // not internal policy.
  'deliveryDayPolicy',
  // NOTE: proPricingPolicy, preorderTransportDefaults, launchConfig and
  // printerGiftConfig are intentionally NOT public — internal policy data.
];

function normalizedSetting<K extends SettingKey>(key: K, value: unknown): (typeof SETTING_DEFAULTS)[K] {
  if (key === 'checkoutPaymentMethods') {
    /**
     * THE STORED ARRAY IS A WHOLE ANSWER, NOT A PATCH — which is why a method
     * added to the defaults after a shop was configured is INVISIBLE there
     * rather than new. Checkout offers the intersection of this setting with
     * the server's allowed ids, so an id the owner's saved array predates is
     * simply not drawn, with no error anywhere to explain it. That is exactly
     * what happened to BNPL, and `gini` would have repeated it on every shop
     * whose settings row was written before today.
     *
     * Re-injected by id, never by position: an owner who deliberately deleted
     * a row keeps it deleted only if the row is genuinely theirs to delete —
     * these two are server-gated (PRO eligibility, `giniPolicy.enabled`), so
     * the switch that turns them off is the policy, not this list.
     */
    const configured = Array.isArray(value) ? value : [];
    const hasId = (id: string) =>
      configured.some((m) => typeof m === 'object' && m !== null && (m as { id?: unknown }).id === id);
    const missing = SETTING_DEFAULTS.checkoutPaymentMethods.filter((m) => m.id === 'bnpl' || m.id === 'gini').filter((m) => !hasId(m.id));
    return (missing.length === 0 ? configured : [...configured, ...missing]) as (typeof SETTING_DEFAULTS)[K];
  }
  // Merged over the defaults like `bnplPolicy` below, but through the policy
  // module's own resolver rather than a bare spread: a stored `max_days` of 0
  // would otherwise reach the picker as an empty window with no error, and a
  // stored 10_000 would let a customer park an order thirty years out. The
  // clamp belongs to the policy, so the read side calls it.
  if (key === 'deliveryDayPolicy') {
    return resolveDeliveryDayPolicy(value) as (typeof SETTING_DEFAULTS)[K];
  }
  /**
   * Merged like `bnplPolicy`, and then once more one level down. The stored
   * value is a whole object, so a shop that saved `{ enabled: false }` before
   * the text existed would otherwise read back with three EMPTY conditions —
   * a popup that states no condition at all. The three languages are merged
   * key by key so an owner who rewrote only the Arabic keeps the English and
   * the Sorani they never touched.
   */
  if (key === 'giniPolicy') {
    const object: Record<string, unknown> =
      typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const storedText: Record<string, unknown> =
      typeof object.conditions === 'object' && object.conditions !== null && !Array.isArray(object.conditions)
        ? (object.conditions as Record<string, unknown>)
        : {};
    return {
      ...SETTING_DEFAULTS.giniPolicy,
      ...object,
      conditions: { ...SETTING_DEFAULTS.giniPolicy.conditions, ...storedText },
    } as (typeof SETTING_DEFAULTS)[K];
  }
  if (key === 'bnplPolicy' || key === 'proPriorityDelivery') {
    const object: Record<string, unknown> =
      typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return { ...(SETTING_DEFAULTS[key] as Record<string, unknown>), ...object } as (typeof SETTING_DEFAULTS)[K];
  }
  return value as (typeof SETTING_DEFAULTS)[K];
}

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
    const value = map.has(k) ? safeParse(map.get(k), SETTING_DEFAULTS[k]) : SETTING_DEFAULTS[k];
    out[k] = normalizedSetting(k, value);
  }
  return out;
}

export async function getSetting<K extends SettingKey>(db: D1Database, key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return SETTING_DEFAULTS[key];
  return normalizedSetting(key, safeParse(row.value, SETTING_DEFAULTS[key]));
}

export async function setSetting(db: D1Database, key: SettingKey, value: unknown): Promise<void> {
  await db
    .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value))
    .run();
}
