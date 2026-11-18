/**
 * PRINTER SERVICES — "Customize your printer" (owner brief 2026-11-17).
 *
 * The pure half: the owner's price list (a config the admin edits and
 * publishes), the customer's choice for ONE printer line, and the one
 * function that prices that choice. No I/O; the worker stores the config in
 * the `printer_services` setting and freezes the priced result on the order.
 *
 * Rules decided here and nowhere else:
 *  - A printer is ENROLLED when the published config maps its product (or the
 *    chosen version) to a warranty family AND a delivery class. Only enrolled
 *    printers sell the new services; every other product keeps the legacy
 *    base + extension warranty untouched (warrantyPlanMath.ts).
 *  - Warranty months are TOTALS: none = 0, w12 = 12, w24 = 24. They never add
 *    to a base and never stack (owner ruling: no free base on enrolled
 *    printers; statutory rights are separate and not modelled as a plan).
 *  - A price of null means "not offered", never 0. 0 is an explicit free
 *    option (the recorded Academy videos, standard packaging).
 *  - No package discount exists (owner ruling 2026-11-17): a package is
 *    exactly the sum of its parts; configIssues refuses any discount.
 *  - Choosing no warranty needs the customer's explicit acknowledgment
 *    (`ack_no_warranty`). A visual default is never consent: the client sends
 *    `confirmed: true` only after a tap, and the server refuses otherwise.
 *  - Delivery is chosen per printer line (Economy or Personal, priced by the
 *    printer's delivery class) but charged in the shipping total, not inside
 *    the line price; null = to be chosen at checkout.
 *  - All money is integer IQD.
 *
 * PHASE 2 (owner rulings 2026-11-17, DECISIONS row 339): the membership a
 * customer may buy WITH a printer (`membership`: which tiers are offered; the
 * price is the live membership_plans row, never stored here) and the owner's
 * filament kits (`kits`: real products / variants, priced at the sum of their
 * live prices, no discount). Both are optional in a stored config: a config
 * saved before phase 2 reads as «memberships off, no kits»
 * (`withPhase2Defaults`), so a published phase 1 list never becomes invalid.
 *
 * PHASE 4 (owner rulings 2026-11-18, DECISIONS row 355) SUPERSEDES «kits: no discount»: the owner
 * may set ONE discount per kit and per add-on (`PrinterDiscount`: a percent, or fixed dinars per
 * printer unit), applied inside the unit price (`unitDiscount`, capped at 90% of the unit). A kit
 * item's colour is fixed or chosen by the customer (`color_mode`). New: add-ons (`addons`: store
 * products sold with a printer at the owner's price, qty fixed per printer) and the store bundles
 * linked per printer product (`ProductMapping.store_bundle_ids`, at most 8, the bundle's own
 * price). A config stored before phase 4 reads as fixed colours, no discounts, no add-ons, no
 * bundles (`withPhase4Defaults`). PACKAGES still carry no discount.
 */

export const WARRANTY_FAMILIES = ['a1', 'xpa2', 'h2', 'h3c'] as const;
export type WarrantyFamily = (typeof WARRANTY_FAMILIES)[number];

export const DELIVERY_CLASSES = ['d1', 'd2', 'd3', 'd4', 'd5'] as const;
export type DeliveryClass = (typeof DELIVERY_CLASSES)[number];

export const WARRANTY_CHOICES = ['none', 'w12', 'w24'] as const;
export type WarrantyChoice = (typeof WARRANTY_CHOICES)[number];
export const CARE_CHOICES = ['none', 'c12'] as const;
export type CareChoice = (typeof CARE_CHOICES)[number];
export const PACKAGING_CHOICES = ['standard', 'extra'] as const;
export type PackagingChoice = (typeof PACKAGING_CHOICES)[number];
export const INSPECTION_CHOICES = ['none', 'full'] as const;
export type InspectionChoice = (typeof INSPECTION_CHOICES)[number];
export const ACADEMY_CHOICES = ['recorded', 'live_whatsapp', 'live_in_person'] as const;
export type AcademyChoice = (typeof ACADEMY_CHOICES)[number];
export const DELIVERY_CHOICES = ['economy', 'personal'] as const;
export type DeliveryChoice = (typeof DELIVERY_CHOICES)[number];
export const PACKAGE_IDS = ['just', 'smart', 'complete', 'custom'] as const;
export type PackageId = (typeof PACKAGE_IDS)[number];

export const WARRANTY_TOTAL_MONTHS: Record<WarrantyChoice, 0 | 12 | 24> = { none: 0, w12: 12, w24: 24 };

/**
 * Levo Care runs for the warranty AND twelve months after it (owner, 2026-11-18; DECISIONS row 358):
 * Care alone = 12 months of cover from delivery, a 12-month warranty + Care = 24, a 24-month warranty + Care = 36.
 */
export const CARE_AFTER_WARRANTY_MONTHS = 12;

/** How long a printer bought with these two choices is under Levo Care, from its delivery: 0 | 12 | 24 | 36. */
export function careTotalMonths(warranty: WarrantyChoice, care: CareChoice): number {
  if (care === 'none') return 0;
  return (WARRANTY_TOTAL_MONTHS[warranty] ?? 0) + CARE_AFTER_WARRANTY_MONTHS;
}

/** Translated text the admin writes; every customer-visible string has all three. */
export interface Text3 { ar: string; en: string; ckb: string }

export interface ProductMapping {
  warranty_family?: WarrantyFamily | null;
  delivery_class?: DeliveryClass | null;
  /** Per version (option value id) — wins over the product's own answer. */
  by_option_value?: Record<string, { warranty_family?: WarrantyFamily | null; delivery_class?: DeliveryClass | null }>;
  /**
   * Phase 4 (DECISIONS row 355): the store bundles (products with composition 'bundle') offered
   * with this printer, in the owner's order, at most MAX_STORE_BUNDLES. Absent = none. Each keeps
   * its own bundle price (no extra discount).
   */
  store_bundle_ids?: string[];
}

/** The membership_plans tier ids (`prime` is PREMIUM's storage id, never renamed). */
export const MEMBERSHIP_TIERS = ['plus', 'prime', 'pro'] as const;
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

export interface PackagePreset {
  active: boolean;
  warranty: WarrantyChoice;
  care: CareChoice;
  packaging: PackagingChoice;
  inspection: InspectionChoice;
  /** Always null (owner ruling: packages are exactly the sum of their parts; configIssues refuses any other value). */
  discount_iqd: number | null;
  /**
   * The membership tier the page PRESELECTS in the membership row for this
   * package, or null (owner ruling 2026-11-17: Complete includes NO membership;
   * the field exists, default null). Never part of the package price: the
   * membership is its own order line at the live plan price.
   */
  membership_tier?: MembershipTier | null;
}

/**
 * Phase 4 (DECISIONS row 355): ONE owner discount on a kit or an add-on.
 *  - percent:   1..90 % off each unit's price (the customer's own tier price).
 *  - fixed_iqd: 1..10,000,000 dinars off PER PRINTER UNIT, split evenly over the units that printer
 *               gets (floor(value / units) per unit).
 * Either way a unit never loses more than 90% of its price (`unitDiscount`).
 */
export type PrinterDiscount = { mode: 'percent'; value: number } | { mode: 'fixed_iqd'; value: number };
export const PRINTER_DISCOUNT_MODES = ['percent', 'fixed_iqd'] as const;
export type PrinterDiscountMode = (typeof PRINTER_DISCOUNT_MODES)[number];
export const MAX_DISCOUNT_PERCENT = 90;
export const MAX_DISCOUNT_FIXED_IQD = 10_000_000;

/**
 * Phase 4: who picks a kit item's (or an add-on's) colour. 'fixed' = the owner's `color_id`
 * (absent = 'fixed', every kit made before phase 4); 'customer' = the customer picks any active
 * in-stock colour or «random» (the system picks); `color_id` is then null and the product (with
 * its selection) appears once in the kit.
 */
export const KIT_COLOR_MODES = ['fixed', 'customer'] as const;
export type KitColorMode = (typeof KIT_COLOR_MODES)[number];

/** One product (or one exact variant) inside an owner-made filament kit, per printer unit. */
export interface KitItem {
  product_id: string;
  /** The exact selection (option value ids); [] for a product without options. */
  option_value_ids: string[];
  /** The colour id, or null for a product without colours (always null when color_mode = 'customer'). */
  color_id: string | null;
  /** Units of this item per printer unit (the kit follows the printer's quantity). */
  qty: number;
  /** Phase 4: absent = 'fixed'. */
  color_mode?: KitColorMode;
}

/** Which printer a kit belongs to: a mapped product, optionally one version of it. */
export interface KitPrinterRef { product_id: string; option_value_id: string | null }

/**
 * An owner-made filament kit (brief §H): the sum of the items' real live prices, less the owner's
 * kit discount when one is set (phase 4, DECISIONS row 355 — supersedes phase 2's «no discount»).
 */
export interface FilamentKit {
  id: string;
  active: boolean;
  sort: number;
  title: Text3;
  items: KitItem[];
  /** null = every enrolled printer; otherwise these printers (or versions) only. */
  printers: KitPrinterRef[] | null;
  /** Phase 4: the owner's discount on every unit of the kit; absent / null = none. */
  discount?: PrinterDiscount | null;
}

/**
 * Phase 4 (DECISIONS row 355): a store product sold WITH a printer at the owner's price (a nozzle,
 * a plate …), `qty` units per printer unit (it follows the printer's quantity). Its own order line,
 * which the customer may remove; a printer or a composition is never an add-on.
 */
export interface PrinterAddon {
  id: string;
  active: boolean;
  sort: number;
  /** The customer-facing name; null = the product's own name. */
  title: Text3 | null;
  product_id: string;
  option_value_ids: string[];
  /** The fixed colour id, or null (no colours, or color_mode = 'customer'). */
  color_id: string | null;
  /** Absent = 'fixed'. */
  color_mode?: KitColorMode;
  /** 1..MAX_ADDON_QTY units per printer unit. */
  qty: number;
  discount: PrinterDiscount | null;
  /** null = every enrolled printer; otherwise these printers (or versions) only. */
  printers: KitPrinterRef[] | null;
}

/**
 * LEVO CARE TERMS (phase 3, owner rulings 2026-11-18; DECISIONS row 347). A Care claim's quote
 * lists eligible parts (each a key of `eligible_parts`), labour, shipping and other work; the
 * discount applies to the eligible parts, and to labour / shipping only when they are
 * 'discounted'. Capped per device (its root unit): `max_claims` approved claims and
 * `max_benefit_iqd` dinars of discount in total (null = no money cap).
 */
export const CARE_COVER_MODES = ['discounted', 'full_price'] as const;
export type CareCoverMode = (typeof CARE_COVER_MODES)[number];
export interface CareEligiblePart { key: string; label: Text3 }
export interface CareTerms {
  eligible_parts: CareEligiblePart[];
  /** 0..care.max_discount_pct (<= 90). */
  discount_pct: number;
  /** >= 1 approved Care claims per device over the Care year. */
  max_claims: number;
  /** >= 0 dinars of discount per device over the Care year; null = no money cap. */
  max_benefit_iqd: number | null;
  labor: CareCoverMode;
  shipping: CareCoverMode;
  /** What Care does not cover, in the customer's words (each <= 200 characters). */
  exclusions: Text3[];
}
export const MAX_CARE_PARTS = 40;
export const MAX_CARE_EXCLUSIONS = 20;
const CARE_PART_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The seeded first draft of the Care terms (the owner edits them before the first publish freezes v1). */
export const DEFAULT_CARE_TERMS: CareTerms = {
  eligible_parts: [
    { key: 'nozzle', label: { ar: 'الفوهة', en: 'Nozzle', ckb: 'نۆزڵ' } },
    { key: 'hotend', label: { ar: 'رأس الطباعة الحراري', en: 'Hotend', ckb: 'سەری گەرمکەرەوەی چاپ' } },
    { key: 'extruder', label: { ar: 'مجموعة البثق', en: 'Extruder', ckb: 'دەرهێنەری فیلامێنت' } },
    { key: 'build_plate', label: { ar: 'سطح الطباعة', en: 'Build plate', ckb: 'ڕووی چاپکردن' } },
    { key: 'ptfe_tube', label: { ar: 'أنبوب PTFE', en: 'PTFE tube', ckb: 'بۆری PTFE' } },
    { key: 'fan', label: { ar: 'المروحة', en: 'Fan', ckb: 'پانکە' } },
    { key: 'belt', label: { ar: 'السير', en: 'Belt', ckb: 'قایش' } },
  ],
  discount_pct: 50,
  max_claims: 3,
  max_benefit_iqd: 150_000,
  labor: 'discounted',
  shipping: 'full_price',
  exclusions: [
    { ar: 'الأضرار المتعمدة أو الناتجة عن حريق أو سوائل', en: 'Deliberate damage, or damage from fire or liquids', ckb: 'زیانی بە ئەنقەست، یان زیانی ئاگر و شلەمەنی' },
    { ar: 'الطابعة المعدّلة أو ببرنامج غير رسمي', en: 'A modified printer, or one on unofficial firmware', ckb: 'چاپکەری دەستکاریکراو، یان بە نەرمەکاڵای نافەرمی' },
    { ar: 'الخدوش والمظهر الخارجي فقط', en: 'Scratches and cosmetic wear only', ckb: 'تەنها خڕاندن و ڕواڵەتی دەرەوە' },
  ],
};

export interface MembershipOffer {
  active: boolean;
  /** The tiers a customer may buy with a printer; prices are the live membership_plans rows. */
  tiers: MembershipTier[];
}

export interface PrinterServicesConfig {
  version: 1;
  /** Bumped on every publish; frozen with each order line. */
  revision: number;
  products: Record<string, ProductMapping>;
  warranty: {
    active: boolean;
    policy_version: number;
    w12: Record<WarrantyFamily, number | null>;
    w24: Record<WarrantyFamily, number | null>;
  };
  care: {
    active: boolean; policy_version: number; months: 12; price_iqd: number | null; max_discount_pct: number;
    /**
     * Phase 3 (DECISIONS row 347): what a Levo Care claim gives, frozen per `policy_version` at the
     * first publish (printer_care_policies, 0236). Optional in a stored config (`withPhase3Defaults`:
     * absent = null = not written yet); publishing an active, priced Care needs it.
     */
    terms?: CareTerms | null;
  };
  packaging: { active: boolean; extra_iqd: number | null };
  inspection: {
    active: boolean; price_iqd: number | null; lead_business_days_min: number; lead_business_days_max: number;
    /** Phase 3: what one completed inspection costs the shop in labour — REPORT ONLY (null = not configured). */
    labor_iqd?: number | null;
  };
  academy: { active: boolean; recorded_iqd: number | null; live_iqd: number | null };
  delivery: { active: boolean; classes: Record<DeliveryClass, { economy_iqd: number | null; personal_iqd: number | null }> };
  packages: { smart: PackagePreset; complete: PackagePreset };
  /** Phase 2; optional in a stored config (`withPhase2Defaults`). */
  membership?: MembershipOffer;
  /** Phase 2; optional in a stored config (`withPhase2Defaults`). */
  kits?: FilamentKit[];
  /** Phase 4; optional in a stored config (`withPhase4Defaults`: absent = none). */
  addons?: PrinterAddon[];
}

/**
 * The owner's prices from the brief, seeded as the FIRST DRAFT only. Nothing
 * is live until the owner maps products and publishes. Mock-up amounts
 * (676k, 34k, 54k, 179k …) are deliberately absent.
 */
export const DEFAULT_PRINTER_SERVICES: PrinterServicesConfig = {
  version: 1,
  revision: 0,
  products: {},
  warranty: {
    active: true,
    policy_version: 1,
    w12: { a1: 25_000, xpa2: 29_000, h2: 35_000, h3c: 39_000 },
    w24: { a1: 100_000, xpa2: 150_000, h2: 200_000, h3c: 250_000 },
  },
  care: { active: true, policy_version: 1, months: 12, price_iqd: 19_000, max_discount_pct: 90, terms: DEFAULT_CARE_TERMS },
  packaging: { active: true, extra_iqd: 7_000 },
  inspection: { active: true, price_iqd: 5_000, lead_business_days_min: 2, lead_business_days_max: 3, labor_iqd: null },
  academy: { active: true, recorded_iqd: 0, live_iqd: 50_000 },
  delivery: {
    active: true,
    classes: {
      d1: { economy_iqd: 5_000, personal_iqd: 15_000 },   // A1 mini, A1 mini Combo, A1
      d2: { economy_iqd: 10_000, personal_iqd: 35_000 },  // A1 Combo, P1S(+Combo), P2S(+Combo), X2D(+Combo), Snapmaker U1 (owner 2026-11-17: «like X2D»)
      d3: { economy_iqd: 15_000, personal_iqd: 40_000 },  // A2L, A2L Combo
      d4: { economy_iqd: 15_000, personal_iqd: 50_000 },  // H2 family
      d5: { economy_iqd: 20_000, personal_iqd: 65_000 },  // H3C
    },
  },
  packages: {
    smart: { active: true, warranty: 'w12', care: 'c12', packaging: 'standard', inspection: 'none', discount_iqd: null, membership_tier: null },
    complete: { active: true, warranty: 'w24', care: 'c12', packaging: 'extra', inspection: 'full', discount_iqd: null, membership_tier: null },
  },
  membership: { active: true, tiers: ['plus', 'prime', 'pro'] },
  kits: [],
  addons: [],
};

/** A config stored before phase 2 has neither field: memberships off, no kits. */
const STORED_MEMBERSHIP_DEFAULT: MembershipOffer = Object.freeze({ active: false, tiers: [] as MembershipTier[] }) as MembershipOffer;

/** The membership offer of a config (absent = off). */
export function membershipOf(c: PrinterServicesConfig): MembershipOffer {
  return c.membership ?? STORED_MEMBERSHIP_DEFAULT;
}
/** The kits of a config (absent = none). */
export function kitsOf(c: PrinterServicesConfig): FilamentKit[] {
  return c.kits ?? [];
}
/** The add-ons of a config (absent = none; phase 4). */
export function addonsOf(c: PrinterServicesConfig): PrinterAddon[] {
  return c.addons ?? [];
}
/** A kit item's or an add-on's colour mode (absent = 'fixed'). */
export function colorModeOf(i: { color_mode?: KitColorMode | null }): KitColorMode {
  return i.color_mode === 'customer' ? 'customer' : 'fixed';
}
/** The store bundles linked to a printer product, in the owner's order (phase 4; absent = none). */
export function storeBundleIdsFor(config: PrinterServicesConfig, productId: string): string[] {
  const m = Object.hasOwn(config.products, productId) ? config.products[productId] : undefined;
  return m?.store_bundle_ids ? [...m.store_bundle_ids] : [];
}

/**
 * A validated config with the phase 2 fields filled — what every reader works
 * on. A config written before phase 2 (or saved by a page that does not know
 * the new fields) reads as memberships off, no kits, no package tier.
 */
export function withPhase2Defaults(c: PrinterServicesConfig): PrinterServicesConfig {
  return withPhase3Defaults({
    ...c,
    packages: {
      smart: { ...c.packages.smart, membership_tier: c.packages.smart.membership_tier ?? null },
      complete: { ...c.packages.complete, membership_tier: c.packages.complete.membership_tier ?? null },
    },
    membership: c.membership ? { active: c.membership.active, tiers: [...c.membership.tiers] } : { active: false, tiers: [] },
    kits: c.kits ?? [],
  });
}

/**
 * Phase 3 (DECISIONS row 347): a config stored before it has no Care terms and no inspection
 * labour figure. Both read as null, never the seeded defaults: terms nobody wrote must not be
 * published and frozen as v1 by accident (publishIssues asks for them instead).
 */
export function withPhase3Defaults(c: PrinterServicesConfig): PrinterServicesConfig {
  return withPhase4Defaults({
    ...c,
    care: { ...c.care, terms: c.care.terms ?? null },
    inspection: { ...c.inspection, labor_iqd: c.inspection.labor_iqd ?? null },
  });
}

/**
 * Phase 4 (DECISIONS row 355): a config stored before it reads as fixed kit colours, no kit
 * discounts, no add-ons and no store bundles — exactly what it sold before.
 */
export function withPhase4Defaults(c: PrinterServicesConfig): PrinterServicesConfig {
  const products: Record<string, ProductMapping> = {};
  for (const [pid, m] of Object.entries(c.products)) products[pid] = { ...m, store_bundle_ids: m.store_bundle_ids ? [...m.store_bundle_ids] : [] };
  return {
    ...c,
    products,
    kits: (c.kits ?? []).map((k) => ({
      ...k,
      discount: k.discount ?? null,
      items: k.items.map((i) => ({ ...i, color_mode: colorModeOf(i) })),
    })),
    addons: (c.addons ?? []).map((a) => ({ ...a, discount: a.discount ?? null, color_mode: colorModeOf(a) })),
  };
}

// ------------------------------------------------------------ validation

const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000;
const isMoneyOrNull = (v: unknown): v is number | null => v === null || isMoney(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Every problem in a config, as `path: message` strings (empty = valid). The
 * admin save refuses a config with issues; publishing additionally needs
 * `publishIssues` to be empty.
 */
/** Size caps on the stored setting (one admin_settings row): far above the shop's printer range. */
export const MAX_MAPPED_PRODUCTS = 500;
export const MAX_VERSIONS_PER_PRODUCT = 50;
export const MAX_ID_LENGTH = 64;
const badId = (id: string) => !id || id.length > MAX_ID_LENGTH;
/** The path segment an issue names: a hostile key is shortened so the message stays small. */
const idLabel = (id: string) => (id.length > MAX_ID_LENGTH ? `${id.slice(0, MAX_ID_LENGTH)}...` : id);

export function configIssues(raw: unknown): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ['config: not an object'];
  const c = raw as Partial<PrinterServicesConfig> & Record<string, unknown>;
  if (c.version !== 1) out.push('version: must be 1');
  if (!(typeof c.revision === 'number' && Number.isInteger(c.revision) && c.revision >= 0)) out.push('revision: integer >= 0');

  if (!isObj(c.products)) out.push('products: object');
  else if (Object.keys(c.products).length > MAX_MAPPED_PRODUCTS) out.push(`products: at most ${MAX_MAPPED_PRODUCTS} printers`);
  else for (const [rawPid, m] of Object.entries(c.products)) {
    const pid = idLabel(rawPid);
    if (badId(rawPid)) out.push(`products.${pid}: bad id`);
    if (!isObj(m)) { out.push(`products.${pid}: object`); continue; }
    if (m.warranty_family != null && !oneOf(WARRANTY_FAMILIES, m.warranty_family)) out.push(`products.${pid}.warranty_family: unknown`);
    if (m.delivery_class != null && !oneOf(DELIVERY_CLASSES, m.delivery_class)) out.push(`products.${pid}.delivery_class: unknown`);
    if (m.by_option_value !== undefined) {
      if (!isObj(m.by_option_value)) out.push(`products.${pid}.by_option_value: object`);
      else if (Object.keys(m.by_option_value).length > MAX_VERSIONS_PER_PRODUCT) out.push(`products.${pid}.by_option_value: at most ${MAX_VERSIONS_PER_PRODUCT} versions`);
      else for (const [rawOv, o] of Object.entries(m.by_option_value)) {
        const ov = idLabel(rawOv);
        if (badId(rawOv)) out.push(`products.${pid}.by_option_value.${ov}: bad id`);
        if (!isObj(o)) { out.push(`products.${pid}.by_option_value.${ov}: object`); continue; }
        if (o.warranty_family != null && !oneOf(WARRANTY_FAMILIES, o.warranty_family)) out.push(`products.${pid}.by_option_value.${ov}.warranty_family: unknown`);
        if (o.delivery_class != null && !oneOf(DELIVERY_CLASSES, o.delivery_class)) out.push(`products.${pid}.by_option_value.${ov}.delivery_class: unknown`);
      }
    }
    if (m.store_bundle_ids !== undefined) {
      const b = m.store_bundle_ids;
      if (!Array.isArray(b) || b.length > MAX_STORE_BUNDLES || !b.every((x) => typeof x === 'string' && !badId(x))) {
        out.push(`products.${pid}.store_bundle_ids: at most ${MAX_STORE_BUNDLES} bundle ids`);
      } else if (new Set(b).size !== b.length) out.push(`products.${pid}.store_bundle_ids: each bundle once`);
    }
  }

  const w = c.warranty;
  if (!isObj(w)) out.push('warranty: object');
  else {
    if (typeof w.active !== 'boolean') out.push('warranty.active: boolean');
    if (!(Number.isInteger(w.policy_version) && (w.policy_version as number) >= 1)) out.push('warranty.policy_version: integer >= 1');
    for (const tier of ['w12', 'w24'] as const) {
      const t = (w as Record<string, unknown>)[tier];
      if (!isObj(t)) { out.push(`warranty.${tier}: object`); continue; }
      for (const f of WARRANTY_FAMILIES) if (!isMoneyOrNull(t[f])) out.push(`warranty.${tier}.${f}: whole IQD or null`);
    }
  }
  const care = c.care;
  if (!isObj(care)) out.push('care: object');
  else {
    if (typeof care.active !== 'boolean') out.push('care.active: boolean');
    if (!(Number.isInteger(care.policy_version) && (care.policy_version as number) >= 1)) out.push('care.policy_version: integer >= 1');
    if (care.months !== 12) out.push('care.months: 12');
    if (!isMoneyOrNull(care.price_iqd)) out.push('care.price_iqd: whole IQD or null');
    if (!(Number.isInteger(care.max_discount_pct) && (care.max_discount_pct as number) >= 0 && (care.max_discount_pct as number) <= 90)) out.push('care.max_discount_pct: 0..90');
    if (care.terms !== undefined && care.terms !== null) out.push(...careTermsIssues(care.terms, care.max_discount_pct));
  }
  const pk = c.packaging;
  if (!isObj(pk) || typeof pk.active !== 'boolean' || !isMoneyOrNull(pk.extra_iqd)) out.push('packaging: {active, extra_iqd}');
  const ins = c.inspection;
  if (!isObj(ins) || typeof ins.active !== 'boolean' || !isMoneyOrNull(ins.price_iqd)) out.push('inspection: {active, price_iqd}');
  else {
    const lo = ins.lead_business_days_min, hi = ins.lead_business_days_max;
    if (!(Number.isInteger(lo) && Number.isInteger(hi) && (lo as number) >= 0 && (lo as number) <= (hi as number) && (hi as number) <= 30)) out.push('inspection.lead_business_days: 0 <= min <= max <= 30');
    if (ins.labor_iqd !== undefined && !isMoneyOrNull(ins.labor_iqd)) out.push('inspection.labor_iqd: whole IQD or null');
  }
  const ac = c.academy;
  if (!isObj(ac) || typeof ac.active !== 'boolean' || !isMoneyOrNull(ac.recorded_iqd) || !isMoneyOrNull(ac.live_iqd)) out.push('academy: {active, recorded_iqd, live_iqd}');
  const dl = c.delivery;
  if (!isObj(dl) || typeof dl.active !== 'boolean' || !isObj(dl.classes)) out.push('delivery: {active, classes}');
  else for (const k of DELIVERY_CLASSES) {
    const row = (dl.classes as Record<string, unknown>)[k];
    if (!isObj(row) || !isMoneyOrNull(row.economy_iqd) || !isMoneyOrNull(row.personal_iqd)) out.push(`delivery.classes.${k}: {economy_iqd, personal_iqd}`);
  }
  const pg = c.packages;
  if (!isObj(pg)) out.push('packages: object');
  else for (const id of ['smart', 'complete'] as const) {
    const p = (pg as Record<string, unknown>)[id];
    if (!isObj(p)) { out.push(`packages.${id}: object`); continue; }
    if (typeof p.active !== 'boolean') out.push(`packages.${id}.active: boolean`);
    if (!oneOf(WARRANTY_CHOICES, p.warranty)) out.push(`packages.${id}.warranty: unknown`);
    if (!oneOf(CARE_CHOICES, p.care)) out.push(`packages.${id}.care: unknown`);
    if (!oneOf(PACKAGING_CHOICES, p.packaging)) out.push(`packages.${id}.packaging: unknown`);
    if (!oneOf(INSPECTION_CHOICES, p.inspection)) out.push(`packages.${id}.inspection: unknown`);
    // Owner ruling 2026-11-17: a package is exactly the sum of its parts. No
    // discount may be stored, so priceServices can never apply one.
    if (!(p.discount_iqd === null || p.discount_iqd === 0)) out.push(`packages.${id}.discount_iqd: packages carry no discount (null)`);
    for (const k of Object.keys(p)) {
      if (k !== 'discount_iqd' && /discount/i.test(k)) out.push(`packages.${id}.${idLabel(k)}: packages carry no discount`);
    }
    if (p.membership_tier !== undefined && p.membership_tier !== null && !oneOf(MEMBERSHIP_TIERS, p.membership_tier)) {
      out.push(`packages.${id}.membership_tier: plus, prime, pro or null`);
    }
  }
  if (c.membership !== undefined) {
    const m = c.membership as unknown;
    if (!isObj(m) || typeof m.active !== 'boolean' || !Array.isArray(m.tiers)) out.push('membership: {active, tiers}');
    else {
      const tiers = m.tiers as unknown[];
      if (tiers.some((t) => !oneOf(MEMBERSHIP_TIERS, t))) out.push('membership.tiers: plus, prime, pro');
      if (new Set(tiers).size !== tiers.length) out.push('membership.tiers: each tier once');
    }
  }
  if (c.kits !== undefined) out.push(...kitIssues(c.kits));
  if (c.addons !== undefined) out.push(...addonIssues(c.addons));
  return out;
}

const isTextOf = (v: unknown, max: number): v is Text3 =>
  isObj(v) && (['ar', 'en', 'ckb'] as const).every((k) => typeof v[k] === 'string' && (v[k] as string).length <= max);

/** Every problem in the Care terms (phase 3), as `care.terms...: message` strings. */
export function careTermsIssues(raw: unknown, maxDiscountPct: unknown): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ['care.terms: object or null'];
  const t = raw as Record<string, unknown>;
  if (!Array.isArray(t.eligible_parts)) out.push('care.terms.eligible_parts: array');
  else if (t.eligible_parts.length > MAX_CARE_PARTS) out.push(`care.terms.eligible_parts: at most ${MAX_CARE_PARTS}`);
  else {
    const keys = new Set<string>();
    (t.eligible_parts as unknown[]).forEach((p, i) => {
      if (!isObj(p) || typeof p.key !== 'string' || !CARE_PART_KEY.test(p.key)) { out.push(`care.terms.eligible_parts[${i}].key: a-z, 0-9, _ or -, at most 32`); return; }
      if (keys.has(p.key)) out.push(`care.terms.eligible_parts[${i}].key: used twice`);
      keys.add(p.key);
      if (!isTextOf(p.label, 80)) out.push(`care.terms.eligible_parts[${i}].label: {ar, en, ckb}, at most 80 characters each`);
    });
  }
  const cap = Number.isInteger(maxDiscountPct) ? (maxDiscountPct as number) : 90;
  if (!(Number.isInteger(t.discount_pct) && (t.discount_pct as number) >= 0 && (t.discount_pct as number) <= Math.min(90, cap))) {
    out.push('care.terms.discount_pct: 0..care.max_discount_pct');
  }
  if (!(Number.isInteger(t.max_claims) && (t.max_claims as number) >= 1 && (t.max_claims as number) <= 100)) out.push('care.terms.max_claims: 1..100');
  if (!isMoneyOrNull(t.max_benefit_iqd)) out.push('care.terms.max_benefit_iqd: whole IQD or null');
  if (!oneOf(CARE_COVER_MODES, t.labor)) out.push('care.terms.labor: discounted or full_price');
  if (!oneOf(CARE_COVER_MODES, t.shipping)) out.push('care.terms.shipping: discounted or full_price');
  if (!Array.isArray(t.exclusions)) out.push('care.terms.exclusions: array');
  else if (t.exclusions.length > MAX_CARE_EXCLUSIONS) out.push(`care.terms.exclusions: at most ${MAX_CARE_EXCLUSIONS}`);
  else (t.exclusions as unknown[]).forEach((e, i) => {
    if (!isTextOf(e, 200)) out.push(`care.terms.exclusions[${i}]: {ar, en, ckb}, at most 200 characters each`);
  });
  return out;
}

/** The Care terms rebuilt from their known fields only (texts trimmed); null stays null. */
export function canonicalCareTerms(t: CareTerms | null | undefined): CareTerms | null {
  if (!t) return null;
  const tx = (v: Text3): Text3 => ({ ar: v.ar.trim(), en: v.en.trim(), ckb: v.ckb.trim() });
  return {
    eligible_parts: t.eligible_parts.map((p) => ({ key: p.key, label: tx(p.label) })),
    discount_pct: t.discount_pct,
    max_claims: t.max_claims,
    max_benefit_iqd: t.max_benefit_iqd ?? null,
    labor: t.labor,
    shipping: t.shipping,
    exclusions: t.exclusions.map(tx),
  };
}

/** Size caps on the kits (owner-made; far above a shop's needs). */
export const MAX_KITS = 30;
export const MAX_KIT_ITEMS = 12;
export const MAX_KIT_ITEM_QTY = 20;
export const MAX_KIT_PRINTERS = 100;
/** Phase 4 caps: add-ons in the list, units of an add-on per printer, store bundles per printer. */
export const MAX_ADDONS = 40;
export const MAX_ADDON_QTY = 20;
export const MAX_STORE_BUNDLES = 8;
const KIT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isText3 = (v: unknown): v is Text3 =>
  isObj(v) && (['ar', 'en', 'ckb'] as const).every((k) => typeof v[k] === 'string' && (v[k] as string).length <= 80);

/** The identity of a kit item: one product + selection + colour appears once per kit. */
export function kitItemKey(i: Pick<KitItem, 'product_id' | 'option_value_ids' | 'color_id'>): string {
  return `${i.product_id}|${[...i.option_value_ids].sort().join(',')}|${i.color_id ?? ''}`;
}

/** Every problem in one kit's or add-on's discount (phase 4); `undefined` and null are «none». */
export function discountIssues(raw: unknown, at: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!isObj(raw) || !oneOf(PRINTER_DISCOUNT_MODES, raw.mode)) return [`${at}: {mode: percent | fixed_iqd, value} or null`];
  const v = raw.value;
  if (raw.mode === 'percent') {
    if (!(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_DISCOUNT_PERCENT)) return [`${at}.value: whole percent 1..${MAX_DISCOUNT_PERCENT}`];
  } else if (!(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_DISCOUNT_FIXED_IQD)) {
    return [`${at}.value: whole IQD 1..${MAX_DISCOUNT_FIXED_IQD} per printer`];
  }
  const extra = Object.keys(raw).filter((k) => k !== 'mode' && k !== 'value');
  return extra.length ? [`${at}: only mode and value`] : [];
}

/** A kit's or an add-on's printers: null, or at most MAX_KIT_PRINTERS {product_id, option_value_id | null}. */
function printerRefIssues(raw: unknown, at: string): string[] {
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_KIT_PRINTERS) return [`${at}.printers: null or at most ${MAX_KIT_PRINTERS} printers`];
  const out: string[] = [];
  raw.forEach((pr: unknown, j) => {
    if (!isObj(pr) || typeof pr.product_id !== 'string' || badId(pr.product_id)
      || !(pr.option_value_id === null || (typeof pr.option_value_id === 'string' && !badId(pr.option_value_id)))) {
      out.push(`${at}.printers[${j}]: {product_id, option_value_id | null}`);
    }
  });
  return out;
}

const selectionKey = (pid: string, ovs: string[]) => `${pid}|${[...ovs].sort().join(',')}`;

function kitIssues(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return ['kits: array'];
  if (raw.length > MAX_KITS) return [`kits: at most ${MAX_KITS}`];
  const ids = new Set<string>();
  raw.forEach((k: unknown, n) => {
    const at = `kits[${n}]`;
    if (!isObj(k)) { out.push(`${at}: object`); return; }
    if (typeof k.id !== 'string' || !KIT_ID.test(k.id)) out.push(`${at}.id: a-z, 0-9, _ or -, at most 32`);
    else if (ids.has(k.id)) out.push(`${at}.id: used twice`);
    else ids.add(k.id);
    if (typeof k.active !== 'boolean') out.push(`${at}.active: boolean`);
    if (!(Number.isInteger(k.sort) && (k.sort as number) >= 0 && (k.sort as number) <= 999)) out.push(`${at}.sort: 0..999`);
    if (!isText3(k.title)) out.push(`${at}.title: {ar, en, ckb}, at most 80 characters each`);
    if (!Array.isArray(k.items)) out.push(`${at}.items: array`);
    else if (k.items.length > MAX_KIT_ITEMS) out.push(`${at}.items: at most ${MAX_KIT_ITEMS}`);
    else {
      const keys = new Set<string>();
      // Phase 4: a customer-colour item's product (with its selection) appears once in the kit.
      const selections = new Set<string>();
      const customerSelections = new Set<string>();
      (k.items as unknown[]).forEach((it, j) => {
        const ia = `${at}.items[${j}]`;
        if (!isObj(it)) { out.push(`${ia}: object`); return; }
        const pidOk = typeof it.product_id === 'string' && !badId(it.product_id);
        if (!pidOk) out.push(`${ia}.product_id: bad id`);
        const ovs = it.option_value_ids;
        const ovsOk = Array.isArray(ovs) && ovs.length <= 12 && ovs.every((v) => typeof v === 'string' && !badId(v));
        if (!ovsOk) out.push(`${ia}.option_value_ids: at most 12 ids`);
        if (!(it.color_id === null || (typeof it.color_id === 'string' && !badId(it.color_id)))) out.push(`${ia}.color_id: id or null`);
        if (!(Number.isInteger(it.qty) && (it.qty as number) >= 1 && (it.qty as number) <= MAX_KIT_ITEM_QTY)) out.push(`${ia}.qty: 1..${MAX_KIT_ITEM_QTY}`);
        if (it.color_mode !== undefined && !oneOf(KIT_COLOR_MODES, it.color_mode)) out.push(`${ia}.color_mode: fixed or customer`);
        const customer = it.color_mode === 'customer';
        if (customer && it.color_id !== null) out.push(`${ia}.color_id: null when the customer picks the colour`);
        for (const key of Object.keys(it)) if (/discount/i.test(key)) out.push(`${ia}.${idLabel(key)}: a discount belongs to the kit (discount), not to an item`);
        if (pidOk && ovsOk) {
          const key = kitItemKey({ product_id: it.product_id as string, option_value_ids: ovs as string[], color_id: typeof it.color_id === 'string' ? it.color_id : null });
          if (keys.has(key)) out.push(`${ia}: the same product and selection twice — raise its qty instead`);
          keys.add(key);
          const sel = selectionKey(it.product_id as string, ovs as string[]);
          if (customerSelections.has(sel) || (customer && selections.has(sel))) {
            out.push(`${ia}: a product whose colour the customer picks appears once in the kit — raise its qty instead`);
          }
          selections.add(sel);
          if (customer) customerSelections.add(sel);
        }
      });
    }
    out.push(...printerRefIssues(k.printers, at));
    // Phase 4 (DECISIONS row 355, supersedes «kits: no discount»): exactly ONE discount field, `discount`.
    out.push(...discountIssues(k.discount, `${at}.discount`));
    for (const key of Object.keys(k)) {
      if (key !== 'discount' && /discount/i.test(key)) out.push(`${at}.${idLabel(key)}: a kit's only discount field is discount`);
    }
  });
  return out;
}

/** Every problem in the add-ons (phase 4), as `addons[n]...: message` strings. */
function addonIssues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['addons: array'];
  if (raw.length > MAX_ADDONS) return [`addons: at most ${MAX_ADDONS}`];
  const out: string[] = [];
  const ids = new Set<string>();
  raw.forEach((a: unknown, n) => {
    const at = `addons[${n}]`;
    if (!isObj(a)) { out.push(`${at}: object`); return; }
    if (typeof a.id !== 'string' || !KIT_ID.test(a.id)) out.push(`${at}.id: a-z, 0-9, _ or -, at most 32`);
    else if (ids.has(a.id)) out.push(`${at}.id: used twice`);
    else ids.add(a.id);
    if (typeof a.active !== 'boolean') out.push(`${at}.active: boolean`);
    if (!(Number.isInteger(a.sort) && (a.sort as number) >= 0 && (a.sort as number) <= 999)) out.push(`${at}.sort: 0..999`);
    if (!(a.title === null || isText3(a.title))) out.push(`${at}.title: null or {ar, en, ckb}, at most 80 characters each`);
    if (!(typeof a.product_id === 'string' && !badId(a.product_id))) out.push(`${at}.product_id: bad id`);
    const ovs = a.option_value_ids;
    if (!(Array.isArray(ovs) && ovs.length <= 12 && ovs.every((v) => typeof v === 'string' && !badId(v)))) out.push(`${at}.option_value_ids: at most 12 ids`);
    if (!(a.color_id === null || (typeof a.color_id === 'string' && !badId(a.color_id)))) out.push(`${at}.color_id: id or null`);
    if (a.color_mode !== undefined && !oneOf(KIT_COLOR_MODES, a.color_mode)) out.push(`${at}.color_mode: fixed or customer`);
    if (a.color_mode === 'customer' && a.color_id !== null) out.push(`${at}.color_id: null when the customer picks the colour`);
    if (!(Number.isInteger(a.qty) && (a.qty as number) >= 1 && (a.qty as number) <= MAX_ADDON_QTY)) out.push(`${at}.qty: 1..${MAX_ADDON_QTY} per printer`);
    out.push(...discountIssues(a.discount, `${at}.discount`));
    for (const key of Object.keys(a)) {
      if (key !== 'discount' && /discount/i.test(key)) out.push(`${at}.${idLabel(key)}: an add-on's only discount field is discount`);
    }
    out.push(...printerRefIssues(a.printers, at));
  });
  return out;
}

/**
 * Phase 4 (DECISIONS row 355): the dinars ONE unit loses to the owner's discount — what the cart,
 * the quote and the order take off the unit price (money rule D1: inside the unit price).
 *  - null / undefined discount → 0.
 *  - percent  → floor(appliedUnitIqd × value / 100).
 *  - fixed_iqd → floor(value / unitsPerPrinter): the per-printer amount split evenly over the units
 *    that ONE printer gets (the kit's or add-on's total units per printer unit).
 * Never more than floor(appliedUnitIqd × 90 / 100) (rule D5); always a non-negative integer.
 * `appliedUnitIqd` is the customer's own unit price before the discount (their tier price).
 */
export function unitDiscount(d: PrinterDiscount | null | undefined, appliedUnitIqd: number, unitsPerPrinter: number): number {
  if (!d) return 0;
  const applied = Number.isFinite(appliedUnitIqd) ? Math.max(0, Math.trunc(appliedUnitIqd)) : 0;
  if (applied <= 0) return 0;
  const value = Number.isFinite(d.value) ? Math.max(0, Math.trunc(d.value)) : 0;
  const units = Number.isFinite(unitsPerPrinter) ? Math.max(1, Math.trunc(unitsPerPrinter)) : 1;
  const cap = Math.floor((applied * MAX_DISCOUNT_PERCENT) / 100);
  const raw = d.mode === 'percent' ? Math.floor((applied * Math.min(value, MAX_DISCOUNT_PERCENT)) / 100)
    : d.mode === 'fixed_iqd' ? Math.floor(value / units)
      : 0;
  return Math.max(0, Math.min(raw, cap));
}

/**
 * The validated config rebuilt from its known fields only (call after
 * `configIssues` is empty): unknown keys anywhere are dropped, so nothing the
 * page did not mean to store reaches the setting. Package discounts are
 * stored as null (owner ruling: none).
 */
export function canonicalConfig(c: PrinterServicesConfig): PrinterServicesConfig {
  const products: Record<string, ProductMapping> = {};
  for (const [pid, m] of Object.entries(c.products)) {
    const row: ProductMapping = { warranty_family: m.warranty_family ?? null, delivery_class: m.delivery_class ?? null };
    if (m.by_option_value) {
      const by: NonNullable<ProductMapping['by_option_value']> = {};
      for (const [ov, o] of Object.entries(m.by_option_value)) {
        by[ov] = { warranty_family: o.warranty_family ?? null, delivery_class: o.delivery_class ?? null };
      }
      row.by_option_value = by;
    }
    row.store_bundle_ids = m.store_bundle_ids ? [...m.store_bundle_ids] : [];
    products[pid] = row;
  }
  const tier = (t: Record<WarrantyFamily, number | null>) =>
    Object.fromEntries(WARRANTY_FAMILIES.map((f) => [f, t[f]])) as Record<WarrantyFamily, number | null>;
  const pkg = (p: PackagePreset): PackagePreset => ({
    active: p.active, warranty: p.warranty, care: p.care, packaging: p.packaging, inspection: p.inspection, discount_iqd: null,
    membership_tier: p.membership_tier ?? null,
  });
  const m = membershipOf(c);
  const tx = (t: Text3): Text3 => ({ ar: t.ar.trim(), en: t.en.trim(), ckb: t.ckb.trim() });
  const refs = (r: KitPrinterRef[] | null): KitPrinterRef[] | null =>
    r === null ? null : r.map((p) => ({ product_id: p.product_id, option_value_id: p.option_value_id ?? null }));
  const disc = (d: PrinterDiscount | null | undefined): PrinterDiscount | null => (d ? { mode: d.mode, value: d.value } as PrinterDiscount : null);
  const kits: FilamentKit[] = kitsOf(c).map((k) => ({
    id: k.id, active: k.active, sort: k.sort,
    title: tx(k.title),
    items: k.items.map((i) => ({
      product_id: i.product_id, option_value_ids: [...i.option_value_ids].sort(), color_id: i.color_id ?? null, qty: i.qty,
      color_mode: colorModeOf(i),
    })),
    printers: refs(k.printers),
    discount: disc(k.discount),
  }));
  const addons: PrinterAddon[] = addonsOf(c).map((a) => ({
    id: a.id, active: a.active, sort: a.sort,
    title: a.title ? tx(a.title) : null,
    product_id: a.product_id, option_value_ids: [...a.option_value_ids].sort(), color_id: a.color_id ?? null,
    color_mode: colorModeOf(a), qty: a.qty, discount: disc(a.discount),
    printers: refs(a.printers),
  }));
  return {
    version: 1,
    revision: c.revision,
    products,
    warranty: { active: c.warranty.active, policy_version: c.warranty.policy_version, w12: tier(c.warranty.w12), w24: tier(c.warranty.w24) },
    care: {
      active: c.care.active, policy_version: c.care.policy_version, months: 12, price_iqd: c.care.price_iqd, max_discount_pct: c.care.max_discount_pct,
      terms: canonicalCareTerms(c.care.terms),
    },
    packaging: { active: c.packaging.active, extra_iqd: c.packaging.extra_iqd },
    inspection: {
      active: c.inspection.active, price_iqd: c.inspection.price_iqd,
      lead_business_days_min: c.inspection.lead_business_days_min, lead_business_days_max: c.inspection.lead_business_days_max,
      labor_iqd: c.inspection.labor_iqd ?? null,
    },
    academy: { active: c.academy.active, recorded_iqd: c.academy.recorded_iqd, live_iqd: c.academy.live_iqd },
    delivery: {
      active: c.delivery.active,
      classes: Object.fromEntries(DELIVERY_CLASSES.map((k) => [k, { economy_iqd: c.delivery.classes[k].economy_iqd, personal_iqd: c.delivery.classes[k].personal_iqd }])) as PrinterServicesConfig['delivery']['classes'],
    },
    packages: { smart: pkg(c.packages.smart), complete: pkg(c.packages.complete) },
    membership: { active: m.active, tiers: MEMBERSHIP_TIERS.filter((t) => m.tiers.includes(t)) },
    kits,
    addons,
  };
}

/** Issues that only block PUBLISHING (a draft may be incomplete). */
export function publishIssues(c: PrinterServicesConfig): string[] {
  const out: string[] = [];
  const mapped = Object.entries(c.products);
  if (!mapped.length) out.push('products: map at least one printer before publishing');
  for (const [pid, m] of mapped) {
    const versions = Object.values(m.by_option_value ?? {});
    const anyFamily = !!m.warranty_family || versions.some((v) => !!v.warranty_family);
    const anyClass = !!m.delivery_class || versions.some((v) => !!v.delivery_class);
    if (!anyFamily) out.push(`products.${pid}: no warranty family`);
    if (!anyClass) out.push(`products.${pid}: no delivery class`);
    // A family on one version and a class on another: no selection prices.
    if (anyFamily && anyClass && !mappingResolves(c, pid)) out.push(`products.${pid}: no version has both a warranty family and a delivery class`);
  }
  // Phase 3: Care sold to customers names what it gives; the terms are frozen with their
  // policy version at the publish (printer_care_policies, 0236).
  if (c.care.active && c.care.price_iqd !== null && !c.care.terms) out.push('care.terms: write the Levo Care terms before publishing Care');
  // A package may only be offered when every service it includes is priced.
  for (const id of ['smart', 'complete'] as const) {
    const p = c.packages[id];
    if (!p.active) continue;
    if (p.care === 'c12' && (!c.care.active || c.care.price_iqd === null)) out.push(`packages.${id}: includes Levo Care, which is not priced`);
    if (p.packaging === 'extra' && (!c.packaging.active || c.packaging.extra_iqd === null)) out.push(`packages.${id}: includes extra packaging, which is not priced`);
    if (p.inspection === 'full' && (!c.inspection.active || c.inspection.price_iqd === null)) out.push(`packages.${id}: includes the inspection, which is not priced`);
    if (p.warranty !== 'none' && !c.warranty.active) out.push(`packages.${id}: includes a warranty, but the warranty is off`);
    if (p.warranty === 'none') out.push(`packages.${id}: a package must include a warranty`);
    if (p.membership_tier) {
      const m = membershipOf(c);
      if (!m.active || !m.tiers.includes(p.membership_tier)) out.push(`packages.${id}: preselects a membership tier that is not offered`);
    }
  }
  // Kits: an active kit names its three titles and at least one item, belongs
  // to mapped printers only, and never contains a mapped printer itself.
  for (const k of kitsOf(c)) {
    if (!k.active) continue;
    if (!k.title.ar.trim() || !k.title.en.trim() || !k.title.ckb.trim()) out.push(`kits.${k.id}: needs a title in Arabic, English and Kurdish`);
    if (!k.items.length) out.push(`kits.${k.id}: needs at least one item`);
    for (const it of k.items) if (Object.hasOwn(c.products, it.product_id)) out.push(`kits.${k.id}: a printer cannot be a kit item`);
    for (const pr of k.printers ?? []) if (!Object.hasOwn(c.products, pr.product_id)) out.push(`kits.${k.id}: printer ${idLabel(pr.product_id)} is not mapped`);
  }
  // Phase 4: an active add-on names three titles when it overrides the product's name, belongs to
  // mapped printers only and is never a mapped printer itself. Catalogue checks (exists, not a
  // composition, a customer colour exists) are worker/lib/printerServices.ts printerExtrasCatalogIssues.
  for (const a of addonsOf(c)) {
    if (!a.active) continue;
    if (a.title && (!a.title.ar.trim() || !a.title.en.trim() || !a.title.ckb.trim())) out.push(`addons.${a.id}: a title needs Arabic, English and Kurdish (or none: the product's name)`);
    if (Object.hasOwn(c.products, a.product_id)) out.push(`addons.${a.id}: a printer cannot be an add-on`);
    for (const pr of a.printers ?? []) if (!Object.hasOwn(c.products, pr.product_id)) out.push(`addons.${a.id}: printer ${idLabel(pr.product_id)} is not mapped`);
  }
  // Phase 4: a store bundle linked to a printer is never a mapped printer.
  for (const [pid, m] of mapped) {
    for (const b of m.store_bundle_ids ?? []) if (Object.hasOwn(c.products, b)) out.push(`products.${pid}: store bundle ${idLabel(b)} is a printer`);
  }
  return out;
}

/**
 * The active kits offered with THIS printer selection, in the owner's order:
 * a kit for every enrolled printer (printers = null), or one naming this
 * product (and, when it names a version, that version is chosen).
 */
export function kitsForPrinter(config: PrinterServicesConfig, productId: string, optionValueIds: readonly string[]): FilamentKit[] {
  return kitsOf(config)
    .filter((k) => k.active && k.items.length > 0)
    .filter((k) => k.printers === null
      || k.printers.some((p) => p.product_id === productId && (p.option_value_id === null || optionValueIds.includes(p.option_value_id))))
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Phase 4: the active add-ons offered with THIS printer selection, in the owner's order — the same
 * rule as kitsForPrinter (printers = null = every enrolled printer; a named version must be chosen).
 */
export function addonsForPrinter(config: PrinterServicesConfig, productId: string, optionValueIds: readonly string[]): PrinterAddon[] {
  return addonsOf(config)
    .filter((a) => a.active)
    .filter((a) => a.printers === null
      || a.printers.some((p) => p.product_id === productId && (p.option_value_id === null || optionValueIds.includes(p.option_value_id))))
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The tiers a printer may be bought with (empty = no membership row). */
export function offeredMembershipTiers(config: PrinterServicesConfig): MembershipTier[] {
  const m = membershipOf(config);
  return m.active ? [...m.tiers] : [];
}

// ------------------------------------------------------------ resolution

export interface PrinterClasses { warranty_family: WarrantyFamily; delivery_class: DeliveryClass }

/**
 * The printer's family and delivery class for THIS selection: a chosen
 * version (option value) wins over the product. null = not enrolled (the
 * product, or this version, is not mapped) → the legacy flow applies.
 */
export function classesFor(config: PrinterServicesConfig | null, productId: string, optionValueIds: readonly string[]): PrinterClasses | null {
  if (!config) return null;
  const m = Object.hasOwn(config.products, productId) ? config.products[productId] : undefined;
  if (!m) return null;
  let family = m.warranty_family ?? null;
  let cls = m.delivery_class ?? null;
  for (const ov of optionValueIds) {
    const o = m.by_option_value && Object.hasOwn(m.by_option_value, ov) ? m.by_option_value[ov] : undefined;
    if (!o) continue;
    if (o.warranty_family) family = o.warranty_family;
    if (o.delivery_class) cls = o.delivery_class;
  }
  return family && cls ? { warranty_family: family, delivery_class: cls } : null;
}

/**
 * True when SOME selection of this product resolves both classes: the
 * product's own answer with no version chosen, or with any one mapped
 * version. What "enrolled" means for a product as a whole (the detail page's
 * flag, the legacy plans withheld); publishing refuses a mapping for which
 * this is false.
 */
export function mappingResolves(config: PrinterServicesConfig | null, productId: string): boolean {
  if (!config || !Object.hasOwn(config.products, productId)) return false;
  if (classesFor(config, productId, [])) return true;
  return Object.keys(config.products[productId].by_option_value ?? {}).some((ov) => !!classesFor(config, productId, [ov]));
}

// ------------------------------------------------------------ the selection

export interface ServiceSelection {
  v: 1;
  package: PackageId;
  warranty: WarrantyChoice;
  care: CareChoice;
  packaging: PackagingChoice;
  inspection: InspectionChoice;
  academy: AcademyChoice;
  /** null = chosen at checkout. */
  delivery: DeliveryChoice | null;
  /** The customer tapped to confirm this configuration (never a default). */
  confirmed: boolean;
  /** Required true whenever warranty === 'none'. */
  ack_no_warranty: boolean;
}

/** Nothing paid selected — where "Customize myself" starts. */
export const EMPTY_SELECTION: ServiceSelection = Object.freeze({
  v: 1, package: 'custom', warranty: 'none', care: 'none', packaging: 'standard',
  inspection: 'none', academy: 'recorded', delivery: null, confirmed: false, ack_no_warranty: false,
}) as ServiceSelection;

/** The selection a preset implies (unconfirmed; the customer still confirms). */
export function presetSelection(config: PrinterServicesConfig, id: 'just' | 'smart' | 'complete', delivery: DeliveryChoice | null = null): ServiceSelection {
  if (id === 'just') return { ...EMPTY_SELECTION, package: 'just', delivery };
  const p = config.packages[id];
  return { v: 1, package: id, warranty: p.warranty, care: p.care, packaging: p.packaging, inspection: p.inspection,
    academy: 'recorded', delivery, confirmed: false, ack_no_warranty: false };
}

/** Strict parse of a stored or posted selection; null = malformed. */
export function parseSelection(raw: unknown): ServiceSelection | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw) return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!isObj(v) || v.v !== 1) return null;
  if (!oneOf(PACKAGE_IDS, v.package) || !oneOf(WARRANTY_CHOICES, v.warranty) || !oneOf(CARE_CHOICES, v.care)
    || !oneOf(PACKAGING_CHOICES, v.packaging) || !oneOf(INSPECTION_CHOICES, v.inspection) || !oneOf(ACADEMY_CHOICES, v.academy)
    || !(v.delivery === null || oneOf(DELIVERY_CHOICES, v.delivery))
    || typeof v.confirmed !== 'boolean' || typeof v.ack_no_warranty !== 'boolean') return null;
  return {
    v: 1, package: v.package, warranty: v.warranty, care: v.care, packaging: v.packaging, inspection: v.inspection,
    academy: v.academy, delivery: (v.delivery ?? null) as DeliveryChoice | null, confirmed: v.confirmed, ack_no_warranty: v.ack_no_warranty,
  };
}

/** Canonical storage form: fixed key order, so equal choices compare equal as text. */
export function encodeSelection(s: ServiceSelection): string {
  return JSON.stringify({
    v: 1, package: s.package, warranty: s.warranty, care: s.care, packaging: s.packaging, inspection: s.inspection,
    academy: s.academy, delivery: s.delivery, confirmed: s.confirmed, ack_no_warranty: s.ack_no_warranty,
  });
}

/** Two selections are the same purchase when everything but the delivery preference matches. */
export function sameServices(a: ServiceSelection, b: ServiceSelection): boolean {
  return a.package === b.package && a.warranty === b.warranty && a.care === b.care && a.packaging === b.packaging
    && a.inspection === b.inspection && a.academy === b.academy;
}

// ------------------------------------------------------------ pricing

export type ServiceKey = 'warranty' | 'care' | 'packaging' | 'inspection' | 'academy';

export interface PricedServiceLine {
  service: ServiceKey;
  choice: string;
  fee_iqd: number;
  policy_version?: number;
}

export interface PricedServices {
  lines: PricedServiceLine[];
  /** Per printer unit, added to the line's unit price. Delivery is NOT in it. */
  fee_iqd: number;
  package_discount_iqd: number;
  warranty_months: 0 | 12 | 24;
  care_months: 0 | 12;
  /** The whole Care cover from delivery: the warranty's months + 12 after it (0 without Care). */
  care_total_months: number;
  inspection_lead_business_days: [number, number] | null;
  /** Delivery per printer unit for the chosen method; null = not chosen / not priced. */
  delivery_fee_iqd: number | null;
  delivery_options: { economy_iqd: number | null; personal_iqd: number | null };
  classes: PrinterClasses;
  revision: number;
  /** The choice that was priced, frozen with the result on the order line. */
  selection: ServiceSelection;
  /** Refusal codes; non-empty = this selection cannot be bought. */
  blockers: string[];
}

export const SERVICES_NOT_CONFIRMED = 'SERVICES_NOT_CONFIRMED';
export const SERVICES_NO_WARRANTY_ACK = 'SERVICES_NO_WARRANTY_ACK';
export const SERVICES_OPTION_UNAVAILABLE = 'SERVICES_OPTION_UNAVAILABLE';
export const SERVICES_PACKAGE_MISMATCH = 'SERVICES_PACKAGE_MISMATCH';
export const SERVICES_PACKAGE_UNAVAILABLE = 'SERVICES_PACKAGE_UNAVAILABLE';
/** An enrolled printer added or checked out without a services choice. */
export const SERVICES_REQUIRED = 'SERVICES_REQUIRED';
/** A line holding a services choice the published list no longer offers. */
export const SERVICES_NOT_OFFERED = 'SERVICES_NOT_OFFERED';
/** A legacy extended-warranty plan sent with the services (never both). */
export const SERVICES_WITH_LEGACY_WARRANTY = 'SERVICES_WITH_LEGACY_WARRANTY';

// ---- phase 2 refusal codes (a membership with a printer, the owner's filament kits)
/** The membership row is off, or this tier is not offered with a printer. */
export const MEMBERSHIP_NOT_OFFERED = 'MEMBERSHIP_NOT_OFFERED';
/** A membership bought with an earlier order is still waiting for that order (never a second one). */
export const MEMBERSHIP_ORDER_PENDING = 'MEMBERSHIP_ORDER_PENDING';
/** The membership's price (or the upgrade credit) moved since the customer saw it. */
export const MEMBERSHIP_PRICE_CHANGED = 'MEMBERSHIP_PRICE_CHANGED';
/** Another printer in this cart already carries the membership. */
export const CART_MEMBERSHIP_CONFLICT = 'CART_MEMBERSHIP_CONFLICT';
/** A membership bought with an order is never returned or refunded. */
export const MEMBERSHIP_NOT_RETURNABLE = 'MEMBERSHIP_NOT_RETURNABLE';
/** The order's membership is active: the order is not cancelled (return the printer instead). */
export const ORDER_MEMBERSHIP_ACTIVE = 'ORDER_MEMBERSHIP_ACTIVE';
/** The kit is not offered with this printer (off, unknown or another printer's). */
export const KIT_NOT_OFFERED = 'KIT_NOT_OFFERED';
/** An item of the kit cannot be sold now (stock, price, selection or the printer's shipping type). */
export const KIT_UNAVAILABLE = 'KIT_UNAVAILABLE';
/** The owner changed the kit since it was put in the cart: choose it again. */
export const KIT_CHANGED = 'KIT_CHANGED';
/** A kit line follows its printer: change or remove the kit from the printer. */
export const KIT_LINE_LOCKED = 'KIT_LINE_LOCKED';
/** A kit line is bought only together with its printer. */
export const KIT_WITHOUT_PRINTER = 'KIT_WITHOUT_PRINTER';
/** A membership or a kit was sent with a product that is not an enrolled printer. */
export const EXTRAS_NOT_PRINTER = 'EXTRAS_NOT_PRINTER';
/** A membership with a printer is not bought with Buy Now Pay Later (owner ruling 2026-11-17 ~10:20). */
export const MEMBERSHIP_NOT_WITH_BNPL = 'MEMBERSHIP_NOT_WITH_BNPL';

/** The phase 2 codes the page words (src/lib/refusalStrings.ts and SERVICES_ERRORS carry each). */
export const PHASE2_CODES: ReadonlySet<string> = new Set<string>([
  MEMBERSHIP_NOT_OFFERED, MEMBERSHIP_ORDER_PENDING, MEMBERSHIP_PRICE_CHANGED, CART_MEMBERSHIP_CONFLICT,
  MEMBERSHIP_NOT_RETURNABLE, ORDER_MEMBERSHIP_ACTIVE,
  KIT_NOT_OFFERED, KIT_UNAVAILABLE, KIT_CHANGED, KIT_LINE_LOCKED, KIT_WITHOUT_PRINTER, EXTRAS_NOT_PRINTER,
  MEMBERSHIP_NOT_WITH_BNPL,
]);

// ---- phase 4 refusal codes (kit colours, add-ons; DECISIONS row 355)
/** The colour chosen for a kit item (or an add-on) is not an active in-stock colour of it now — or none is left for «random». */
export const KIT_COLOR_UNAVAILABLE = 'KIT_COLOR_UNAVAILABLE';
/** The add-on is not offered with this printer (off, unknown or another printer's). */
export const ADDON_NOT_OFFERED = 'ADDON_NOT_OFFERED';
/** The add-on cannot be sold now (stock, price, selection or the printer's shipping type). */
export const ADDON_UNAVAILABLE = 'ADDON_UNAVAILABLE';
/** The owner changed the add-on since it was put in the cart: choose it again. */
export const ADDON_CHANGED = 'ADDON_CHANGED';
/** An add-on line is bought only together with its printer. */
export const ADDON_WITHOUT_PRINTER = 'ADDON_WITHOUT_PRINTER';

/** The phase 4 codes the page words (src/lib/refusalStrings.ts carries each). */
export const PHASE4_CODES: ReadonlySet<string> = new Set<string>([
  KIT_COLOR_UNAVAILABLE, ADDON_NOT_OFFERED, ADDON_UNAVAILABLE, ADDON_CHANGED, ADDON_WITHOUT_PRINTER,
]);

/** Every services refusal, each answered with its own code so the page can name the fix. */
export const SERVICES_CODES: ReadonlySet<string> = new Set<string>([
  SERVICES_REQUIRED, SERVICES_NOT_OFFERED, SERVICES_WITH_LEGACY_WARRANTY,
  SERVICES_NOT_CONFIRMED, SERVICES_NO_WARRANTY_ACK, SERVICES_OPTION_UNAVAILABLE,
  SERVICES_PACKAGE_MISMATCH, SERVICES_PACKAGE_UNAVAILABLE,
]);

/**
 * THE price of a selection for one printer unit. Pure and total: an
 * unavailable option yields a blocker, never a made-up number. Callers that
 * only PREVIEW (the product page, the admin) ignore `SERVICES_NOT_CONFIRMED`;
 * the cart and the order refuse on any blocker.
 */
export function priceServices(config: PrinterServicesConfig, classes: PrinterClasses, s: ServiceSelection): PricedServices {
  const blockers = new Set<string>();
  const lines: PricedServiceLine[] = [];
  const fam = classes.warranty_family;

  if (s.warranty !== 'none') {
    const fee = config.warranty.active ? config.warranty[s.warranty][fam] : null;
    if (fee === null) blockers.add(SERVICES_OPTION_UNAVAILABLE);
    else lines.push({ service: 'warranty', choice: s.warranty, fee_iqd: fee, policy_version: config.warranty.policy_version });
  } else if (!s.ack_no_warranty) {
    blockers.add(SERVICES_NO_WARRANTY_ACK);
  }
  if (s.care === 'c12') {
    const fee = config.care.active ? config.care.price_iqd : null;
    if (fee === null) blockers.add(SERVICES_OPTION_UNAVAILABLE);
    else lines.push({ service: 'care', choice: 'c12', fee_iqd: fee, policy_version: config.care.policy_version });
  }
  if (s.packaging === 'extra') {
    const fee = config.packaging.active ? config.packaging.extra_iqd : null;
    if (fee === null) blockers.add(SERVICES_OPTION_UNAVAILABLE);
    else lines.push({ service: 'packaging', choice: 'extra', fee_iqd: fee });
  } else {
    lines.push({ service: 'packaging', choice: 'standard', fee_iqd: 0 });
  }
  if (s.inspection === 'full') {
    const fee = config.inspection.active ? config.inspection.price_iqd : null;
    if (fee === null) blockers.add(SERVICES_OPTION_UNAVAILABLE);
    else lines.push({ service: 'inspection', choice: 'full', fee_iqd: fee });
  }
  {
    const fee = !config.academy.active ? null : s.academy === 'recorded' ? config.academy.recorded_iqd : config.academy.live_iqd;
    if (fee === null) {
      if (s.academy !== 'recorded') blockers.add(SERVICES_OPTION_UNAVAILABLE);
    } else lines.push({ service: 'academy', choice: s.academy, fee_iqd: fee });
  }

  // Owner ruling: no package discount, ever — a package is the sum of its parts.
  const discount = 0;
  if (s.package === 'smart' || s.package === 'complete') {
    const p = config.packages[s.package];
    if (!p.active) blockers.add(SERVICES_PACKAGE_UNAVAILABLE);
    else if (p.warranty !== s.warranty || p.care !== s.care || p.packaging !== s.packaging || p.inspection !== s.inspection) {
      blockers.add(SERVICES_PACKAGE_MISMATCH);
    }
  } else if (s.package === 'just') {
    if (s.warranty !== 'none' || s.care !== 'none' || s.packaging !== 'standard' || s.inspection !== 'none' || s.academy !== 'recorded') {
      blockers.add(SERVICES_PACKAGE_MISMATCH);
    }
  }
  if (!s.confirmed) blockers.add(SERVICES_NOT_CONFIRMED);

  const gross = lines.reduce((sum, l) => sum + l.fee_iqd, 0);

  const dRow = config.delivery.active ? config.delivery.classes[classes.delivery_class] : null;
  const delivery_options = { economy_iqd: dRow?.economy_iqd ?? null, personal_iqd: dRow?.personal_iqd ?? null };
  let delivery_fee_iqd: number | null = null;
  if (s.delivery) {
    delivery_fee_iqd = s.delivery === 'economy' ? delivery_options.economy_iqd : delivery_options.personal_iqd;
    if (delivery_fee_iqd === null) blockers.add(SERVICES_OPTION_UNAVAILABLE);
  }

  return {
    lines,
    fee_iqd: gross - discount,
    package_discount_iqd: discount,
    warranty_months: WARRANTY_TOTAL_MONTHS[s.warranty],
    care_months: s.care === 'c12' ? 12 : 0,
    care_total_months: careTotalMonths(s.warranty, s.care),
    inspection_lead_business_days: s.inspection === 'full' ? [config.inspection.lead_business_days_min, config.inspection.lead_business_days_max] : null,
    delivery_fee_iqd,
    delivery_options,
    classes,
    revision: config.revision,
    selection: s,
    blockers: [...blockers],
  };
}

/** The per-unit price of each preset for a printer (what the package card shows). */
export function presetPrices(config: PrinterServicesConfig, classes: PrinterClasses): Record<'just' | 'smart' | 'complete', number | null> {
  const out = { just: 0 as number | null, smart: null as number | null, complete: null as number | null };
  for (const id of ['smart', 'complete'] as const) {
    if (!config.packages[id].active) continue;
    const p = priceServices(config, classes, { ...presetSelection(config, id), confirmed: true });
    out[id] = p.blockers.length ? null : p.fee_iqd;
  }
  return out;
}

/**
 * What the product page and the sheet show for ONE printer: each option's
 * per-unit price (null = not offered), the package totals, and the active
 * packages. Customer-safe: prices only, no costs, no internal ids.
 */
export interface ServicesOffer {
  revision: number;
  warranty: { w12: number | null; w24: number | null; policy_version: number } | null;
  care: { c12: number | null; months: 12; /** Care runs for the warranty and `months` after it (clients read `?? false`). */ after_warranty: true; max_discount_pct: number; policy_version: number; terms: CareTerms | null } | null;
  packaging: { standard: 0; extra: number | null } | null;
  inspection: { full: number | null; lead_business_days: [number, number] } | null;
  academy: { recorded: number | null; live: number | null } | null;
  delivery: { economy: number | null; personal: number | null } | null;
  packages: {
    just: { price_iqd: 0 };
    smart: { price_iqd: number; includes: Omit<PackagePreset, 'active' | 'discount_iqd'>; discount_iqd: number } | null;
    complete: { price_iqd: number; includes: Omit<PackagePreset, 'active' | 'discount_iqd'>; discount_iqd: number } | null;
  };
  /** Phase 2: the tiers offered with this printer (null = no membership row). Prices: GET /api/memberships/order-options. */
  membership: { tiers: MembershipTier[] } | null;
  /** Phase 2: the owner's kits for this selection (ids and titles; priced by GET /api/products/:slug/kits). */
  kits: Array<{ id: string; title: Text3 }>;
  /** Phase 4: the add-ons for this selection (ids and title overrides — null = the product's name; priced by GET /api/products/:slug/kits). */
  addons: Array<{ id: string; title: Text3 | null }>;
  /** Phase 4: the store bundle product ids linked to this printer, in the owner's order (priced by GET /api/products/:slug/kits). */
  store_bundles: string[];
}

export function servicesOffer(config: PrinterServicesConfig, classes: PrinterClasses): ServicesOffer {
  const fam = classes.warranty_family;
  const d = config.delivery.classes[classes.delivery_class];
  const prices = presetPrices(config, classes);
  const pkg = (id: 'smart' | 'complete') => {
    const p = config.packages[id];
    const price = prices[id];
    if (!p.active || price === null) return null;
    const gross = priceServices(config, classes, { ...presetSelection(config, id), confirmed: true });
    return {
      price_iqd: price,
      includes: { warranty: p.warranty, care: p.care, packaging: p.packaging, inspection: p.inspection, membership_tier: p.membership_tier ?? null },
      discount_iqd: gross.package_discount_iqd,
    };
  };
  const tiers = offeredMembershipTiers(config);
  return {
    revision: config.revision,
    warranty: config.warranty.active
      ? { w12: config.warranty.w12[fam], w24: config.warranty.w24[fam], policy_version: config.warranty.policy_version }
      : null,
    care: config.care.active
      ? { c12: config.care.price_iqd, months: 12, after_warranty: true as const, max_discount_pct: config.care.max_discount_pct, policy_version: config.care.policy_version, terms: config.care.terms ?? null }
      : null,
    packaging: config.packaging.active ? { standard: 0, extra: config.packaging.extra_iqd } : null,
    inspection: config.inspection.active
      ? { full: config.inspection.price_iqd, lead_business_days: [config.inspection.lead_business_days_min, config.inspection.lead_business_days_max] }
      : null,
    academy: config.academy.active ? { recorded: config.academy.recorded_iqd, live: config.academy.live_iqd } : null,
    delivery: config.delivery.active ? { economy: d.economy_iqd, personal: d.personal_iqd } : null,
    packages: { just: { price_iqd: 0 }, smart: pkg('smart'), complete: pkg('complete') },
    membership: tiers.length ? { tiers } : null,
    kits: [],
    addons: [],
    store_bundles: [],
  };
}

/** The offer with THIS selection's kits, add-ons and store bundles (a kit or add-on may belong to one version only). */
export function servicesOfferFor(config: PrinterServicesConfig, classes: PrinterClasses, productId: string, optionValueIds: readonly string[]): ServicesOffer {
  return {
    ...servicesOffer(config, classes),
    kits: kitsForPrinter(config, productId, optionValueIds).map((k) => ({ id: k.id, title: k.title })),
    addons: addonsForPrinter(config, productId, optionValueIds).map((a) => ({ id: a.id, title: a.title })),
    store_bundles: storeBundleIdsFor(config, productId),
  };
}
