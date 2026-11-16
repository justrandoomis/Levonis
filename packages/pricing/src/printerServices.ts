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

/** Translated text the admin writes; every customer-visible string has all three. */
export interface Text3 { ar: string; en: string; ckb: string }

export interface ProductMapping {
  warranty_family?: WarrantyFamily | null;
  delivery_class?: DeliveryClass | null;
  /** Per version (option value id) — wins over the product's own answer. */
  by_option_value?: Record<string, { warranty_family?: WarrantyFamily | null; delivery_class?: DeliveryClass | null }>;
}

export interface PackagePreset {
  active: boolean;
  warranty: WarrantyChoice;
  care: CareChoice;
  packaging: PackagingChoice;
  inspection: InspectionChoice;
  /** Always null (owner ruling: packages are exactly the sum of their parts; configIssues refuses any other value). */
  discount_iqd: number | null;
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
  care: { active: boolean; policy_version: number; months: 12; price_iqd: number | null; max_discount_pct: number };
  packaging: { active: boolean; extra_iqd: number | null };
  inspection: { active: boolean; price_iqd: number | null; lead_business_days_min: number; lead_business_days_max: number };
  academy: { active: boolean; recorded_iqd: number | null; live_iqd: number | null };
  delivery: { active: boolean; classes: Record<DeliveryClass, { economy_iqd: number | null; personal_iqd: number | null }> };
  packages: { smart: PackagePreset; complete: PackagePreset };
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
  care: { active: true, policy_version: 1, months: 12, price_iqd: 19_000, max_discount_pct: 90 },
  packaging: { active: true, extra_iqd: 7_000 },
  inspection: { active: true, price_iqd: 5_000, lead_business_days_min: 2, lead_business_days_max: 3 },
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
    smart: { active: true, warranty: 'w12', care: 'c12', packaging: 'standard', inspection: 'none', discount_iqd: null },
    complete: { active: true, warranty: 'w24', care: 'c12', packaging: 'extra', inspection: 'full', discount_iqd: null },
  },
};

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
  }
  const pk = c.packaging;
  if (!isObj(pk) || typeof pk.active !== 'boolean' || !isMoneyOrNull(pk.extra_iqd)) out.push('packaging: {active, extra_iqd}');
  const ins = c.inspection;
  if (!isObj(ins) || typeof ins.active !== 'boolean' || !isMoneyOrNull(ins.price_iqd)) out.push('inspection: {active, price_iqd}');
  else {
    const lo = ins.lead_business_days_min, hi = ins.lead_business_days_max;
    if (!(Number.isInteger(lo) && Number.isInteger(hi) && (lo as number) >= 0 && (lo as number) <= (hi as number) && (hi as number) <= 30)) out.push('inspection.lead_business_days: 0 <= min <= max <= 30');
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
  }
  return out;
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
    products[pid] = row;
  }
  const tier = (t: Record<WarrantyFamily, number | null>) =>
    Object.fromEntries(WARRANTY_FAMILIES.map((f) => [f, t[f]])) as Record<WarrantyFamily, number | null>;
  const pkg = (p: PackagePreset): PackagePreset => ({
    active: p.active, warranty: p.warranty, care: p.care, packaging: p.packaging, inspection: p.inspection, discount_iqd: null,
  });
  return {
    version: 1,
    revision: c.revision,
    products,
    warranty: { active: c.warranty.active, policy_version: c.warranty.policy_version, w12: tier(c.warranty.w12), w24: tier(c.warranty.w24) },
    care: { active: c.care.active, policy_version: c.care.policy_version, months: 12, price_iqd: c.care.price_iqd, max_discount_pct: c.care.max_discount_pct },
    packaging: { active: c.packaging.active, extra_iqd: c.packaging.extra_iqd },
    inspection: {
      active: c.inspection.active, price_iqd: c.inspection.price_iqd,
      lead_business_days_min: c.inspection.lead_business_days_min, lead_business_days_max: c.inspection.lead_business_days_max,
    },
    academy: { active: c.academy.active, recorded_iqd: c.academy.recorded_iqd, live_iqd: c.academy.live_iqd },
    delivery: {
      active: c.delivery.active,
      classes: Object.fromEntries(DELIVERY_CLASSES.map((k) => [k, { economy_iqd: c.delivery.classes[k].economy_iqd, personal_iqd: c.delivery.classes[k].personal_iqd }])) as PrinterServicesConfig['delivery']['classes'],
    },
    packages: { smart: pkg(c.packages.smart), complete: pkg(c.packages.complete) },
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
  // A package may only be offered when every service it includes is priced.
  for (const id of ['smart', 'complete'] as const) {
    const p = c.packages[id];
    if (!p.active) continue;
    if (p.care === 'c12' && (!c.care.active || c.care.price_iqd === null)) out.push(`packages.${id}: includes Levo Care, which is not priced`);
    if (p.packaging === 'extra' && (!c.packaging.active || c.packaging.extra_iqd === null)) out.push(`packages.${id}: includes extra packaging, which is not priced`);
    if (p.inspection === 'full' && (!c.inspection.active || c.inspection.price_iqd === null)) out.push(`packages.${id}: includes the inspection, which is not priced`);
    if (p.warranty !== 'none' && !c.warranty.active) out.push(`packages.${id}: includes a warranty, but the warranty is off`);
    if (p.warranty === 'none') out.push(`packages.${id}: a package must include a warranty`);
  }
  return out;
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
  care: { c12: number | null; months: 12; max_discount_pct: number; policy_version: number } | null;
  packaging: { standard: 0; extra: number | null } | null;
  inspection: { full: number | null; lead_business_days: [number, number] } | null;
  academy: { recorded: number | null; live: number | null } | null;
  delivery: { economy: number | null; personal: number | null } | null;
  packages: {
    just: { price_iqd: 0 };
    smart: { price_iqd: number; includes: Omit<PackagePreset, 'active' | 'discount_iqd'>; discount_iqd: number } | null;
    complete: { price_iqd: number; includes: Omit<PackagePreset, 'active' | 'discount_iqd'>; discount_iqd: number } | null;
  };
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
      includes: { warranty: p.warranty, care: p.care, packaging: p.packaging, inspection: p.inspection },
      discount_iqd: gross.package_discount_iqd,
    };
  };
  return {
    revision: config.revision,
    warranty: config.warranty.active
      ? { w12: config.warranty.w12[fam], w24: config.warranty.w24[fam], policy_version: config.warranty.policy_version }
      : null,
    care: config.care.active
      ? { c12: config.care.price_iqd, months: 12, max_discount_pct: config.care.max_discount_pct, policy_version: config.care.policy_version }
      : null,
    packaging: config.packaging.active ? { standard: 0, extra: config.packaging.extra_iqd } : null,
    inspection: config.inspection.active
      ? { full: config.inspection.price_iqd, lead_business_days: [config.inspection.lead_business_days_min, config.inspection.lead_business_days_max] }
      : null,
    academy: config.academy.active ? { recorded: config.academy.recorded_iqd, live: config.academy.live_iqd } : null,
    delivery: config.delivery.active ? { economy: d.economy_iqd, personal: d.personal_iqd } : null,
    packages: { just: { price_iqd: 0 }, smart: pkg('smart'), complete: pkg('complete') },
  };
}
