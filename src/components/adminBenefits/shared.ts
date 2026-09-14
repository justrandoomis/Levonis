/**
 * WHAT A MEMBERSHIP IS WORTH — the wire types of `/api/admin/membership-benefits`
 * and the pieces the three panels of this screen share.
 *
 * NOT ONE COMMERCIAL NUMBER LIVES IN THIS FOLDER. Every percentage, ceiling,
 * threshold, quantity and minimum on the screen is read from the response, and
 * the UNIT each one is printed in comes from `schema.units` — so the file never
 * has to know that `percent` is a percentage and `fixed_iqd` is dinars, and a
 * field whose unit changes on the server changes here without an edit.
 *
 * The visual language is the admin-products design system (`.ap` tokens, the
 * recipes in `adminProducts/theme.ts`) and the primitives the taxonomy tab
 * already built on it, so this page reads as one panel with «التصنيفات».
 */
import { api, formatIqd } from '../../lib/api';
import type { CatalogNode } from '../adminTaxonomy/shared';
import { TIER_META, isPaidTier } from '../subscription/tierMeta';

/** The page's translator: Kurdish is optional and falls back to Arabic. */
export type Loc = (ar: string, en: string, ckb?: string) => string;

// --------------------------------------------------------------- wire types

export type BenefitType = 'product_discount' | 'free_shipping' | 'cod_tax_exemption';
export type BenefitScope = 'global' | 'category' | 'sub_category' | 'product';
export type DiscountMode = 'percent' | 'fixed';
export type CapScope = 'per_unit' | 'per_order';
/** `prime` is the stored id; PREMIUM is what every customer surface calls it. */
export type BenefitTier = 'prime' | 'pro';
export type Unit = 'percent' | 'iqd' | 'quantity';

/**
 * One row of `membership_benefit_rules` as the admin API returns it.
 *
 * `notes` is deliberately absent: the reader (`ruleFromRow`) drops it, so the
 * list cannot show it and the editor recovers it from the version history —
 * see `notesFromVersions`.
 */
export interface BenefitRule {
  id: string;
  tier: BenefitTier;
  benefit_type: BenefitType;
  scope: BenefitScope;
  category_id: string | null;
  sub_category_id: string | null;
  product_id: string | null;
  discount_mode: DiscountMode | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: CapScope | null;
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  free_shipping_threshold_iqd: number | null;
  shipping_methods: string[] | null;
  max_shipping_subsidy_iqd: number | null;
  cod_tax_exempt: boolean | null;
  enabled: boolean;
  priority: number;
  valid_from: string | null;
  valid_until: string | null;
  label: string | null;
}

export interface SchemaDeliveryMethod {
  id: string;
  title_ar: string;
  title_en: string;
  price_iqd: number;
}

/** The vocabularies and units the server publishes so the screen never guesses. */
export interface BenefitSchema {
  tiers: string[];
  benefit_types: BenefitType[];
  scopes: BenefitScope[];
  discount_modes: DiscountMode[];
  cap_scopes: CapScope[];
  delivery_methods: SchemaDeliveryMethod[];
  units: Record<string, Unit>;
}

export interface BenefitsPayload {
  rules: BenefitRule[];
  version_id: number | null;
  schema: BenefitSchema;
}

export interface VersionRow {
  id: number;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  rule_id: string | null;
  before_json: string | null;
  after_json: string | null;
}

export interface SimulateLine {
  product_id: string;
  name: string;
  qty: number;
  regular_unit_iqd: number;
  member_unit_iqd: number;
  regular_line_iqd: number;
  member_rule_id: string | null;
  rule_scope: BenefitScope | null;
  discount_iqd: number;
  per_unit_discount_iqd: number;
  eligible_qty: number;
  capped_by: 'none' | 'per_unit' | 'per_order' | 'quantity';
  applied_at: 'unit' | 'line';
}

export interface SimulateResult {
  at: string;
  tier: BenefitTier;
  version_id: number | null;
  assumptions: string[];
  lines: SimulateLine[];
  totals: {
    merchandise_regular_iqd: number;
    membership_discount_iqd: number;
    merchandise_iqd: number;
    shipping_before_benefit_iqd: number;
    shipping_iqd: number;
    shipping_benefit_iqd: number;
    cod_tax_before_exemption_iqd: number;
    cod_tax_exemption_iqd: number;
    cod_tax_iqd: number;
    total_iqd: number;
  };
  shipping: {
    rule_id: string | null;
    eligible: boolean;
    reason: 'applied' | 'no_rule' | 'below_threshold' | 'method_not_covered';
    threshold_iqd: number | null;
    basis_iqd: number;
    methods: string[] | null;
    subsidy_capped: boolean;
    reasons: string[];
  };
  cod_tax: { rule_id: string | null; exempt: boolean };
}

// ------------------------------------------------------------------ loading

export const loadBenefits = () => api.get<BenefitsPayload>('/api/admin/membership-benefits');

/** The server caps `limit` at 100; the whole window is read once and shared by
 *  the history panel and the editor's note recovery. */
export const loadVersions = (limit = 100) =>
  api.get<{ versions: VersionRow[] }>(`/api/admin/membership-benefits/versions?limit=${limit}`);

export const loadCatalogs = () => api.get<{ catalogs: CatalogNode[] }>('/api/admin/taxonomy/catalogs');

// ------------------------------------------------------- units and wording

/** The unit the SERVER says this field is in, or null when it publishes none. */
export function unitOf(schema: BenefitSchema | null, field: string): Unit | null {
  const unit = schema?.units?.[field];
  return unit === 'percent' || unit === 'iqd' || unit === 'quantity' ? unit : null;
}

/** The unit as a suffix for a field label: «%», «د.ع», «وحدات». */
export function unitWord(unit: Unit | null, loc: Loc): string {
  if (unit === 'percent') return '%';
  if (unit === 'iqd') return loc('د.ع', 'IQD');
  if (unit === 'quantity') return loc('وحدات', 'units', 'یەکە');
  return '';
}

/**
 * A NUMBER IS NEVER PRINTED WITHOUT ITS UNIT, and the unit is never guessed:
 * «10%», «100,000 د.ع», «2 وحدات».
 */
export function fmtValue(schema: BenefitSchema | null, field: string, value: number, loc: Loc): string {
  const unit = unitOf(schema, field);
  if (unit === 'percent') return `${value}%`;
  if (unit === 'iqd') return formatIqd(value);
  if (unit === 'quantity') return loc(`${value} ${value === 1 ? 'وحدة' : 'وحدات'}`, `${value} units`, `${value} یەکە`);
  return String(value);
}

/** PLUS / PREMIUM / PRO — `prime` is PREMIUM on every customer-facing surface. */
export const tierName = (tier: string): string => (isPaidTier(tier) ? TIER_META[tier].label : tier.toUpperCase());
export const tierChip = (tier: string): string =>
  isPaidTier(tier) ? TIER_META[tier].chip : 'bg-[var(--ap-surface-2)] text-[var(--ap-text-2)] border-[var(--ap-border)]';

type Phrase = { ar: string; en: string; ckb?: string };

/**
 * Kurdish appears ONLY where the same words already exist in this codebase;
 * everywhere else the Kurdish reader gets the Arabic sentence rather than an
 * invented one (`loc(ar, en)` falls back to `ar`).
 */
export const TYPE_LABEL: Record<BenefitType, Phrase> = {
  product_discount: { ar: 'خصم على المنتجات', en: 'Product discount' },
  free_shipping: { ar: 'توصيل مجاني', en: 'Free delivery' },
  cod_tax_exemption: { ar: 'إعفاء من ضريبة الدفع عند الاستلام', en: 'Cash-on-delivery tax exemption' },
};

export const SCOPE_LABEL: Record<BenefitScope, Phrase> = {
  global: { ar: 'كل المنتجات', en: 'Every product' },
  category: { ar: 'قسم رئيسي', en: 'Main section' },
  sub_category: { ar: 'قسم فرعي', en: 'Sub-section' },
  product: { ar: 'منتج واحد', en: 'One product' },
};

export const MODE_LABEL: Record<DiscountMode, Phrase> = {
  percent: { ar: 'نسبة', en: 'Percent', ckb: 'ڕێژە' },
  fixed: { ar: 'سعر ثابت', en: 'Fixed', ckb: 'جێگیر' },
};

export const CAP_LABEL: Record<CapScope, Phrase> = {
  per_unit: { ar: 'لكل وحدة', en: 'Per unit' },
  per_order: { ar: 'لكل طلب', en: 'Per order' },
};

export const FIELD_LABEL: Record<string, Phrase> = {
  percent: { ar: 'النسبة', en: 'Percent', ckb: 'ڕێژە' },
  fixed_iqd: { ar: 'المبلغ الثابت', en: 'Fixed amount' },
  max_discount_iqd: { ar: 'الحد الأقصى للخصم', en: 'Maximum discount' },
  cap_scope: { ar: 'الحد الأقصى محسوب', en: 'The ceiling counts' },
  max_quantity: { ar: 'أقصى كمية مشمولة', en: 'Maximum eligible quantity' },
  min_subtotal_iqd: { ar: 'الحد الأدنى للطلب', en: 'Minimum order' },
  free_shipping_threshold_iqd: { ar: 'يصبح التوصيل مجانيًا فوق', en: 'Delivery is free above' },
  shipping_methods: { ar: 'طرق التوصيل المشمولة', en: 'Delivery methods covered' },
  max_shipping_subsidy_iqd: { ar: 'الحد الأقصى لتغطية التوصيل', en: 'Maximum delivery cover' },
  cod_tax_exempt: { ar: 'إعفاء من ضريبة الدفع عند الاستلام', en: 'Exempt from the cash-on-delivery tax' },
  discount_mode: { ar: 'نوع الخصم', en: 'Discount kind' },
  tier: { ar: 'العضوية', en: 'Membership' },
  benefit_type: { ar: 'نوع الميزة', en: 'Benefit' },
  scope: { ar: 'النطاق', en: 'Applies to' },
  category_id: { ar: 'القسم الرئيسي', en: 'Main section' },
  sub_category_id: { ar: 'القسم الفرعي', en: 'Sub-section' },
  product_id: { ar: 'المنتج', en: 'Product', ckb: 'بەرهەم' },
  enabled: { ar: 'الحالة', en: 'State', ckb: 'دۆخ' },
  priority: { ar: 'الأولوية', en: 'Priority' },
  valid_from: { ar: 'يبدأ من', en: 'From', ckb: 'لە' },
  valid_until: { ar: 'ينتهي في', en: 'Until' },
  label: { ar: 'الاسم', en: 'Name', ckb: 'ناو' },
  notes: { ar: 'الملاحظات', en: 'Notes', ckb: 'تێبینی' },
};

export const phrase = (p: Phrase | undefined, loc: Loc, fallback = ''): string =>
  p ? loc(p.ar, p.en, p.ckb) : fallback;

/** The order every rule's fields are read in — the list, the editor and the
 *  version diff all walk it, so they can never disagree about what a rule is. */
export const RULE_FIELDS = [
  'tier',
  'benefit_type',
  'scope',
  'category_id',
  'sub_category_id',
  'product_id',
  'discount_mode',
  'percent',
  'fixed_iqd',
  'max_discount_iqd',
  'cap_scope',
  'max_quantity',
  'min_subtotal_iqd',
  'free_shipping_threshold_iqd',
  'shipping_methods',
  'max_shipping_subsidy_iqd',
  'cod_tax_exempt',
  'enabled',
  'priority',
  'valid_from',
  'valid_until',
  'label',
  'notes',
] as const;

/** The numeric fields each benefit type actually uses (docs/MEMBERSHIP_BENEFITS §1). */
export const VALUE_FIELDS: Record<BenefitType, string[]> = {
  product_discount: ['percent', 'fixed_iqd', 'max_discount_iqd', 'max_quantity', 'min_subtotal_iqd'],
  free_shipping: ['free_shipping_threshold_iqd', 'max_shipping_subsidy_iqd'],
  cod_tax_exemption: [],
};

// ----------------------------------------------------------------- naming

/** A section's name in the reader's language, falling back to the other two. */
export function catalogName(catalogs: CatalogNode[], id: string | null, lang: string): string | null {
  if (!id) return null;
  const node = catalogs.find((c) => c.id === id);
  if (!node) return null;
  const order =
    lang === 'en'
      ? [node.name_en, node.name_ar, node.name_ckb]
      : lang === 'ckb'
        ? [node.name_ckb, node.name_ar, node.name_en]
        : [node.name_ar, node.name_en, node.name_ckb];
  return order.find((x) => x && x.trim()) || node.slug || id;
}

/**
 * PRODUCT NAMES FOR THE PRODUCT-SCOPED RULES.
 *
 * `/api/admin/products-v2` has no "these ids" filter, so a product rule would
 * otherwise list as a bare `prd_…` and an owner could not tell which printer
 * they had written an override for. One resolve per id, cached for the session,
 * through the same two readers `ProductPicker` uses — a bundle answers from the
 * bundles route, because the product editor refuses a composition row.
 */
const productNameCache = new Map<string, string>();
/** Keyed by LANGUAGE too: the same product answers with a different name in
 *  Arabic and in English, and a cache that forgot which one it stored would
 *  keep showing the previous language after the admin switched. */
const cacheKey = (lang: string, id: string) => `${lang}:${id}`;

export async function resolveProductNames(ids: string[], lang: string): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))].slice(0, 60);
  await Promise.all(
    wanted
      .filter((id) => !productNameCache.has(cacheKey(lang, id)))
      .map(async (id) => {
        try {
          const res = await api
            .get<{ product: { name_ar?: string; name_en?: string; name?: string } }>(
              `/api/admin/products-v2/${encodeURIComponent(id)}`
            )
            .catch(() =>
              api.get<{ product: { name_ar?: string; name_en?: string; name?: string } }>(
                `/api/admin/bundles/${encodeURIComponent(id)}`
              )
            );
          const p = res.product ?? {};
          const name =
            lang === 'en'
              ? p.name_en || p.name || p.name_ar
              : p.name_ar || p.name_en || p.name;
          if (name) productNameCache.set(cacheKey(lang, id), name);
        } catch {
          // A product that no longer resolves stays its raw id — blanking it
          // would read as "this rule lost its product", which is not what
          // happened.
        }
      })
  );
  return new Map(wanted.map((id) => [id, productNameCache.get(cacheKey(lang, id)) ?? id]));
}

/** What a rule is called in a sentence — its own name, or what it does. */
export function ruleTitle(
  rule: BenefitRule,
  loc: Loc,
  targetName: string | null
): string {
  if (rule.label && rule.label.trim()) return rule.label.trim();
  const what = phrase(TYPE_LABEL[rule.benefit_type], loc);
  const where = targetName ?? phrase(SCOPE_LABEL[rule.scope], loc);
  return `${tierName(rule.tier)} · ${what} · ${where}`;
}

// ------------------------------------------------------------- version rows

/**
 * ONE SHAPE FOR BOTH SIDES OF A VERSION.
 *
 * `before_json` is the stored ROW (`enabled` 1/0, `shipping_methods` a JSON
 * string) and `after_json` is the written RULE (`enabled` true/false, the
 * methods an array). Diffing them raw would report "enabled: 1 → true" on
 * every single edit and bury the change the owner actually made.
 */
export function normalizeVersionRule(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  if ('enabled' in out) out.enabled = out.enabled === true || out.enabled === 1;
  if ('cod_tax_exempt' in out) {
    out.cod_tax_exempt = out.cod_tax_exempt == null ? null : out.cod_tax_exempt === true || out.cod_tax_exempt === 1;
  }
  if (typeof out.shipping_methods === 'string') {
    try {
      const methods: unknown = JSON.parse(out.shipping_methods);
      out.shipping_methods = Array.isArray(methods) ? methods : null;
    } catch {
      out.shipping_methods = null;
    }
  }
  if (out.shipping_methods === undefined) out.shipping_methods = null;
  return out;
}

/**
 * THE NOTE THE LIST CANNOT READ.
 *
 * `GET /api/admin/membership-benefits` drops `notes` (the resolver has no use
 * for it), and a PUT replaces the whole row — so an editor that opened with an
 * empty note would erase it on every save. The note is recovered from the most
 * recent version that WROTE this rule, which is the same text, from the server.
 */
export function notesFromVersions(versions: VersionRow[]): Map<string, string> {
  const out = new Map<string, string>();
  // The endpoint answers newest first; the first write wins and later (older)
  // rows are ignored.
  for (const v of versions) {
    if (!v.rule_id || out.has(v.rule_id)) continue;
    const after = normalizeVersionRule(v.after_json);
    if (!after) continue;
    out.set(v.rule_id, typeof after.notes === 'string' ? after.notes : '');
  }
  return out;
}

// --------------------------------------------------------------- formatting

/**
 * `en-GB` for every language, exactly as `adminProducts/ui.tsx` `fmtDate` does:
 * one unambiguous day-month-year on a screen where three locales read the same
 * audit row. D1 writes `datetime('now')` without a zone, so a bare
 * `YYYY-MM-DD HH:MM:SS` is read as the UTC it is.
 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const hasZone = iso.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasZone ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** An ISO instant as the value a `datetime-local` input wants, in local time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** '' -> null, so an empty box clears the field instead of sending a zero. */
export function numOrNull(value: string): number | null {
  const s = value.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * A multi-line control on the `.ap` tokens. `theme.ts` has no textarea recipe
 * and its `input` fixes a 40px height — appending `h-auto` to it would be dead
 * CSS (Tailwind emits height utilities in its own order, not the class list's),
 * so the control recipe is restated here without the height.
 */
export const textareaCls =
  'min-w-0 w-full rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] ' +
  'text-[var(--ap-text-1)] text-[13px] px-3 py-2 leading-relaxed placeholder:text-[var(--ap-text-3)] ' +
  'transition-colors duration-150 hover:border-[var(--ap-border-hover)] focus:outline-none ' +
  'focus:border-[var(--ap-accent)] focus:shadow-[0_0_0_3px_var(--ap-accent-soft)]';
