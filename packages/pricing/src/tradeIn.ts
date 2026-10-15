/**
 * «استبدل جهازك القديم» — THE TRADE-IN VALUATION ENGINE.
 *
 * The owner (2026-09-26): «نظام تقييم وتسعير احترافي يعتمد على نسب وقواعد
 * قابلة للإدارة. لكل عنصر تقييم نسبة تأثير مستقلة وقابلة للتعديل من لوحة
 * الإدارة … عند إدخال المستخدم للبيانات يحسب النظام السعر التقريبي تلقائياً
 * بهذه القواعد، بشكل احترافي وشفاف وقابل للتطوير».
 *
 * PURE: no database, no clock, no request. The Worker is the authority
 * (worker/lib/tradeIn.ts runs this at submit and again whenever it matters),
 * and the customer's wizard and the admin's «جرّب القواعد» calculator run the
 * SAME function for their live previews — so the figure a customer watches
 * move while they fill the form is the figure the server will write, and the
 * breakdown the admin reviews is the breakdown the customer saw.
 *
 * ─── THE MODEL ──────────────────────────────────────────────────────────────
 *
 * A request is one or more COMPONENTS (a Combo is its printer AND its AMS,
 * each assessed on its own, as the owner asked: «يجب تقييم كل جزء بشكل
 * مستقل»). Each component has:
 *
 *   base_iqd   what the customer actually paid for THAT part (the Worker
 *              derives it from the order line; see worker/lib/tradeIn.ts for
 *              the Combo → AMS split).
 *   a family   fdm | resin | laser | ams | accessory — each with its own
 *              versioned rule set, because «قواعد التقييم تختلف».
 *
 * A rule set is a list of FACTORS (the thirteen the owner named). Each factor
 * turns the customer's answer into a signed effect in BASIS POINTS of the base
 * price (100 bp = 1%), and the factor's own WEIGHT (also basis points; 10,000
 * = 100%) scales that effect — «نسبة تأثير مستقلة». Integers throughout: a
 * weight is never a float, so no two runs of this function can disagree by a
 * rounding hair.
 *
 *   contribution_bp = trunc(effect_bp × weight_bp / 10,000)
 *   amount_iqd      = trunc(base_iqd × contribution_bp / 10,000)
 *   raw             = base + Σ amount
 *   clamped         = clamp(raw, base × floor_bp, base × cap_bp)
 *   value           = clamped rounded DOWN to `rounding_iqd` (1,000 by default)
 *
 * ADDITIVE, NOT MULTIPLICATIVE, on purpose. «شفاف» means the desk can read
 * the breakdown top to bottom and the lines add up to the answer (the customer
 * reads the final figure alone — DECISIONS row 220, trade-in G22). A product of
 * thirteen percentages does not decompose into lines anyone can check; a sum
 * does. The clamp and the rounding are printed as their own lines for the same
 * reason — the breakdown always sums EXACTLY to the value.
 *
 * ROUNDED DOWN, never to the nearest. An estimate that rounds up promises a
 * dinar the rules did not give, and the gap reappears as a disappointment at
 * the counter.
 *
 * ─── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 *
 * It does not decide ELIGIBILITY (whose order, delivered or not, traded
 * already) — that needs the database and lives in the Worker. It does not know
 * the NEW product's price either: `tradeInSettlement` takes that figure from
 * the caller, who resolved it server-side (direct-sale price, after
 * commission) and never from a client.
 */

// ============================================================ vocabulary

export const TRADE_IN_FAMILIES = ['fdm', 'resin', 'laser', 'ams', 'accessory'] as const;
export type TradeInFamily = (typeof TRADE_IN_FAMILIES)[number];

export const isTradeInFamily = (v: unknown): v is TradeInFamily =>
  typeof v === 'string' && (TRADE_IN_FAMILIES as readonly string[]).includes(v);

/** A label in the three languages every screen speaks (DECISIONS row 183: the Sorani is written, never the Arabic copied). */
export type Trilingual = {
  ar: string;
  en: string;
  ckb: string;
};

export const FAMILY_LABELS: Record<TradeInFamily, Trilingual> = {
  fdm: { ar: 'طابعة FDM (فلمنت)', en: 'FDM printer (filament)', ckb: 'چاپکەری FDM (فیلامێنت)' },
  resin: { ar: 'طابعة Resin', en: 'Resin printer', ckb: 'چاپکەری Resin' },
  laser: { ar: 'جهاز ليزر', en: 'Laser machine', ckb: 'ئامێری لەیزەر' },
  ams: { ar: 'AMS / نظام تعدد الألوان', en: 'AMS / multi-material unit', ckb: 'AMS / سیستەمی چەند ڕەنگ' },
  accessory: { ar: 'ملحق', en: 'Accessory', ckb: 'پاشکۆ' },
};

/**
 * WHICH PART OF A PURCHASED LINE A COMPONENT IS.
 *   device  the product itself — the printer, the laser, a standalone AMS.
 *   ams     the AMS that came INSIDE a Combo option of a printer line.
 */
export const COMPONENT_ROLES = ['device', 'ams'] as const;
export type ComponentRole = (typeof COMPONENT_ROLES)[number];

/**
 * WHAT IS BEING TRADED FROM ONE UNIT.
 *   whole         everything that line delivered (a Combo = printer + AMS)
 *   printer_only  a Combo's printer, keeping its AMS
 *   ams_only      a Combo's AMS alone — «سوف نتعامل مع سعر ams فقط»
 * The last two exist only on a Combo line. They are complementary on purpose:
 * a customer who trades the AMS today can trade the printer next year, and
 * neither can be traded twice (the claims table in 0143 is keyed per part).
 */
export const TRADE_IN_SCOPES = ['whole', 'printer_only', 'ams_only'] as const;
export type TradeInScope = (typeof TRADE_IN_SCOPES)[number];

export function rolesForScope(scope: TradeInScope, isCombo: boolean): ComponentRole[] {
  if (!isCombo) return scope === 'whole' ? ['device'] : [];
  if (scope === 'whole') return ['device', 'ams'];
  if (scope === 'printer_only') return ['device'];
  return ['ams'];
}

// ============================================================ factors

export const FACTOR_IDS = [
  'usage_age',
  'warranty_remaining',
  'operating_hours',
  'cleanliness',
  'exterior',
  'scratches',
  'faults',
  'repairs',
  'replaced_parts',
  'accessory_condition',
  'original_accessories',
  'market',
  'product_type',
] as const;
export type FactorId = (typeof FACTOR_IDS)[number];

/**
 * THE SORANI OF THE SEEDED CHECKLIST ITEMS (faults and replaced parts),
 * keyed by the Arabic the seed wrote. The items themselves live in the
 * owner's rule sets (data, editable), which carry Arabic and English only;
 * the Worker adds this Sorani to the questions it sends while an item still
 * reads as seeded (`checklistLabelCkb`). An item the owner renamed or added
 * has no Sorani here and is shown as the owner wrote it.
 */
const CHECKLIST_LABELS_CKB: Readonly<Record<string, string>> = {
  'اللوحة الأم': 'بۆردی سەرەکی',
  'الشاشة': 'شاشە',
  'مروحة': 'پانکە',
  'مزود الطاقة': 'دابینکەری کارەبا',
  'انسداد النوزل': 'گیرانی نۆزڵ',
  'تقطيع أو انزلاق في الإكسترودر': 'پچڕان یان خلیسکانی ئێکسترودەر',
  'مشكلة في معايرة السطح': 'کێشە لە ڕێکخستنی ڕووی چاپ',
  'خطأ في التسخين': 'هەڵەی گەرمکردنەوە',
  'صوت غير طبيعي في المحركات': 'دەنگی نائاسایی لە بزوێنەرەکان',
  'تآكل الأحزمة': 'سووانی قایشەکان',
  'عطل الكاميرا أو الليدار': 'تێکچوونی کامێرا یان لایدار',
  'عطل الشاشة أو اللمس': 'تێکچوونی شاشە یان دەستلێدان',
  'مشكلة في الاتصال (واي فاي)': 'کێشەی پەیوەندی (وای فای)',
  'مروحة عالية الصوت أو معطلة': 'پانکەی دەنگبەرز یان تێکچوو',
  'عطل حساس الفلمنت': 'تێکچوونی هەستەوەری فیلامێنت',
  'عطل في اللوحة الأم': 'تێکچوونی بۆردی سەرەکی',
  'رأس الطباعة (Hotend)': 'سەری چاپ (Hotend)',
  'النوزل': 'نۆزڵ',
  'سطح الطباعة': 'ڕووی چاپ',
  'الأحزمة': 'قایشەکان',
  'الإكسترودر': 'ئێکسترودەر',
  'تلف شاشة LCD': 'تێکچوونی شاشەی LCD',
  'فيلم FEP مستهلك': 'فیلمی FEP سواوە',
  'تسريب في الحوض': 'دزەکردن لە حەوزەکەوە',
  'ضعف ضوء UV': 'لاوازیی ڕووناکیی UV',
  'اهتزاز أو خلل في محور Z': 'لەرزین یان کێشە لە تەوەری Z',
  'ضعف الالتصاق بالمنصة': 'لاوازیی لکان بە سەکۆکەوە',
  'عطل شاشة اللمس': 'تێکچوونی شاشەی دەستلێدان',
  'تسرب ريزن داخل الجهاز': 'ڕژانی ڕێزن بۆ ناو ئامێرەکە',
  'شاشة LCD': 'شاشەی LCD',
  'فيلم FEP': 'فیلمی FEP',
  'الحوض': 'حەوز',
  'منصة الطباعة': 'سەکۆی چاپ',
  'وحدة UV': 'یەکەی UV',
  'اتساخ أو خدش العدسة': 'پیسبوون یان ڕووشانی هاوێنە',
  'ضعف قوة الليزر': 'لاوازیی هێزی لەیزەر',
  'عطل نفخ الهواء': 'تێکچوونی فووکردنی هەوا',
  'خطأ في العودة للصفر': 'هەڵە لە گەڕانەوە بۆ خاڵی سفر',
  'عطل الكاميرا': 'تێکچوونی کامێرا',
  'عطل حساس الأمان': 'تێکچوونی هەستەوەری سەلامەتی',
  'العدسة': 'هاوێنە',
  'وحدة الليزر': 'یەکەی لەیزەر',
  'أخطاء في سحب الفلمنت': 'هەڵە لە ڕاکێشانی فیلامێنت',
  'عطل قارئ RFID': 'تێکچوونی خوێنەرەوەی RFID',
  'مشكلة في الـ Buffer': 'کێشە لە Buffer',
  'عطل حساس الرطوبة': 'تێکچوونی هەستەوەری شێ',
  'مشكلة في القاطع': 'کێشە لە بڕەرەکە',
  'أنابيب PTFE مستهلكة': 'بۆرییە PTFE ـیەکان سواون',
  'وحدة السحب (Feeder)': 'یەکەی ڕاکێشان (Feeder)',
  'أنابيب PTFE': 'بۆرییەکانی PTFE',
  'لا يعمل': 'کار ناکات',
  'يعمل جزئياً': 'تەنها بەشێکی کار دەکات',
  'قطع ناقصة': 'پارچەی کەمە',
};

/** The Sorani of a checklist item that still reads as seeded, else undefined. */
export function checklistLabelCkb(labelAr: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(CHECKLIST_LABELS_CKB, labelAr) ? CHECKLIST_LABELS_CKB[labelAr] : undefined;
}

/** The owner's own words for each factor, in the order the breakdown prints. */
export const FACTOR_LABELS: Record<FactorId, Trilingual> = {
  usage_age: { ar: 'مدة الاستخدام', en: 'Time in use', ckb: 'ماوەی بەکارهێنان' },
  warranty_remaining: { ar: 'المتبقي من الضمان', en: 'Warranty remaining', ckb: 'گەرەنتیی ماوە' },
  operating_hours: { ar: 'ساعات التشغيل', en: 'Operating hours', ckb: 'کاتژمێرەکانی کارکردن' },
  cleanliness: { ar: 'حالة النظافة', en: 'Cleanliness', ckb: 'پاکوخاوێنی' },
  exterior: { ar: 'الحالة الخارجية', en: 'Exterior condition', ckb: 'دۆخی دەرەوە' },
  scratches: { ar: 'الخدوش', en: 'Scratches', ckb: 'ڕووشانەکان' },
  faults: { ar: 'المشاكل والأعطال', en: 'Problems & faults', ckb: 'کێشە و تێکچوونەکان' },
  repairs: { ar: 'الإصلاحات السابقة', en: 'Previous repairs', ckb: 'چاککردنەوەکانی پێشوو' },
  replaced_parts: { ar: 'القطع المستبدلة', en: 'Replaced parts', ckb: 'پارچە گۆڕدراوەکان' },
  accessory_condition: { ar: 'حالة الملحقات المرفقة', en: 'Included accessories', ckb: 'دۆخی پاشکۆ هاوپێچەکان' },
  original_accessories: { ar: 'توفر الملحقات الأصلية', en: 'Original accessories present', ckb: 'بوونی پاشکۆ ڕەسەنەکان' },
  market: { ar: 'حالة السوق وقيمة إعادة البيع', en: 'Market & resale value', ckb: 'دۆخی بازاڕ و بەهای دووبارە فرۆشتنەوە' },
  product_type: { ar: 'نوع الجهاز', en: 'Device type', ckb: 'جۆری ئامێر' },
};

/** Limits every stored rule is validated against (bp = basis points). */
export const BP_LIMITS = { effect: 10_000, weight: 20_000 } as const;
export const MAX_HOURS = 100_000;
export const MAX_REPAIRS = 20;
export const MAX_CHECKLIST_ITEMS = 30;
export const MAX_NOTE_CHARS = 1000;

export interface ChecklistItem {
  /** Stable id, `[a-z0-9_]{2,40}` — what a customer's answer stores. */
  id: string;
  label_ar: string;
  label_en: string;
  /** Signed; a fault or a replaced part normally takes value away. */
  effect_bp: number;
}

export type FactorConfig =
  /** Months since delivery × per-month depreciation, after a grace period, capped. */
  | { kind: 'age'; per_month_bp: number; max_bp: number; grace_months: number }
  /** Remaining warranty months × per-month bonus, capped. */
  | { kind: 'warranty'; per_month_bp: number; max_bp: number }
  /** The first band whose `up_to` holds the hours (null = and above). Ascending. */
  | { kind: 'hours'; bands: Array<{ up_to: number | null; effect_bp: number }> }
  /** A 1..5 answer (5 = like new); effects_bp[score − 1]. */
  | { kind: 'scale'; effects_bp: [number, number, number, number, number] }
  /** Ticked items add up, capped by `max_total_bp` (a negative floor). */
  | { kind: 'checklist'; items: ChecklistItem[]; max_total_bp: number }
  /** How many times; × per-item, capped. */
  | { kind: 'count'; per_item_bp: number; max_bp: number }
  /** One of a fixed set. */
  | { kind: 'choice'; options: Array<{ id: 'all' | 'partial' | 'none'; effect_bp: number }> }
  /** The shop's resale view of this family, with per-product overrides. */
  | { kind: 'market'; resale_bp: number; product_overrides: Array<{ product_id: string; effect_bp: number }> }
  /** One flat effect for the family («نوع الطابعة أو الملحق»). */
  | { kind: 'flat'; effect_bp: number };

/** Which config kind each factor takes. Fixed: a factor never changes shape. */
export const FACTOR_KIND: Record<FactorId, FactorConfig['kind']> = {
  usage_age: 'age',
  warranty_remaining: 'warranty',
  operating_hours: 'hours',
  cleanliness: 'scale',
  exterior: 'scale',
  scratches: 'scale',
  faults: 'checklist',
  repairs: 'count',
  replaced_parts: 'checklist',
  accessory_condition: 'scale',
  original_accessories: 'choice',
  market: 'market',
  product_type: 'flat',
};

export interface FactorRule {
  factor: FactorId;
  enabled: boolean;
  /** «نسبة التأثير» — 10,000 = the effect as configured, 5,000 = half of it, 0 = off. */
  weight_bp: number;
  config: FactorConfig;
}

export interface TradeInRuleSet {
  family: TradeInFamily;
  version: number;
  /** The value never falls below this share of the base … */
  floor_bp: number;
  /** … and never rises above this one. */
  cap_bp: number;
  /** The value is rounded DOWN to a multiple of this (1,000 by default). */
  rounding_iqd: number;
  /** A line paid below this is not worth a trade-in (a nozzle, a cable). 0 = no minimum. */
  min_base_iqd: number;
  /**
   * THE AMS PORTION WHEN IT CANNOT BE DERIVED — read from the `ams` family's
   * rule set only. The primary path prices a Combo's AMS as the gap between
   * the Combo option and the plain one (worker/lib/tradeIn.ts); this is the
   * owner's fallback for a Combo whose sibling option no longer exists.
   * 0 = not configured, and then «AMS فقط» is not offered at all.
   */
  ams_reference_iqd: number;
  /** True for the seeded defaults the owner has not tuned yet. */
  is_default: boolean;
  factors: FactorRule[];
}

// ============================================================ inputs

export type Score = 1 | 2 | 3 | 4 | 5;

/** What the customer tells us about ONE component. */
export interface ComponentInputs {
  /** Actual operating hours; null when the family does not count hours (AMS). */
  hours: number | null;
  cleanliness: Score;
  exterior: Score;
  scratches: Score;
  /** Ids from the family's `faults` checklist. */
  faults: string[];
  repairs_count: number;
  /** Ids from the family's `replaced_parts` checklist. */
  replaced_parts: string[];
  accessory_condition: Score;
  original_accessories: 'all' | 'partial' | 'none';
  /** Free text: the fault in their own words, what was repaired, anything else. */
  fault_notes: string;
  repair_notes: string;
  notes: string;
}

/** A neutral starting point for the wizard: every answer at "good". */
export function blankInputs(family: TradeInFamily): ComponentInputs {
  return {
    hours: familyCountsHours(family) ? 0 : null,
    cleanliness: 4,
    exterior: 4,
    scratches: 4,
    faults: [],
    repairs_count: 0,
    replaced_parts: [],
    accessory_condition: 4,
    original_accessories: 'all',
    fault_notes: '',
    repair_notes: '',
    notes: '',
  };
}

/** Families whose machines keep an hour counter the customer can read off the screen. */
export function familyCountsHours(family: TradeInFamily): boolean {
  return family === 'fdm' || family === 'resin' || family === 'laser';
}

/** The facts the Worker derives; the customer never supplies them. */
export interface ValuationContext {
  base_iqd: number;
  /** Whole months since delivery. */
  usage_months: number;
  /** Whole months of warranty left (0 when expired or unknown). */
  warranty_remaining_months: number;
  /** For the market factor's per-product override. */
  product_id: string;
}

// ============================================================ the engine

export interface BreakdownLine {
  factor: FactorId | 'base' | 'clamp' | 'rounding';
  label_ar: string;
  label_en: string;
  /** The factor's effect after its weight, in basis points of the base. 0 for base/clamp/rounding. */
  effect_bp: number;
  /** Signed dinars this line adds; the base line carries the base itself. */
  amount_iqd: number;
  /** A short machine note — «14 شهر», «3 أعطال» — for the screen to phrase. */
  detail?: Record<string, number | string>;
}

export interface ComponentValuation {
  family: TradeInFamily;
  rule_version: number;
  base_iqd: number;
  floor_iqd: number;
  cap_iqd: number;
  lines: BreakdownLine[];
  value_iqd: number;
}

const trunc = (n: number) => (n < 0 ? -Math.floor(-n) : Math.floor(n));
const bpOf = (base: number, bp: number) => trunc((base * bp) / 10_000);

function rawEffect(rule: FactorRule, ctx: ValuationContext, input: ComponentInputs): { bp: number; detail?: Record<string, number | string> } {
  const c = rule.config;
  switch (c.kind) {
    case 'age': {
      const months = Math.max(0, ctx.usage_months - c.grace_months);
      return { bp: Math.max(-c.max_bp, -months * c.per_month_bp), detail: { months: ctx.usage_months } };
    }
    case 'warranty': {
      const m = Math.max(0, ctx.warranty_remaining_months);
      return { bp: Math.min(c.max_bp, m * c.per_month_bp), detail: { months: m } };
    }
    case 'hours': {
      if (input.hours === null) return { bp: 0 };
      const h = input.hours;
      const band = c.bands.find((b) => b.up_to === null || h <= b.up_to) ?? c.bands[c.bands.length - 1];
      return { bp: band ? band.effect_bp : 0, detail: { hours: h } };
    }
    case 'scale': {
      const score = scoreFor(rule.factor, input);
      return { bp: c.effects_bp[score - 1] ?? 0, detail: { score } };
    }
    case 'checklist': {
      const ticked = rule.factor === 'faults' ? input.faults : input.replaced_parts;
      const set = new Set(ticked);
      const sum = c.items.filter((i) => set.has(i.id)).reduce((s, i) => s + i.effect_bp, 0);
      return { bp: Math.max(c.max_total_bp, sum), detail: { count: set.size } };
    }
    case 'count': {
      const n = Math.max(0, input.repairs_count);
      return { bp: Math.max(-c.max_bp, -n * c.per_item_bp), detail: { count: n } };
    }
    case 'choice': {
      const o = c.options.find((x) => x.id === input.original_accessories);
      return { bp: o ? o.effect_bp : 0, detail: { choice: input.original_accessories } };
    }
    case 'market': {
      const o = c.product_overrides.find((x) => x.product_id === ctx.product_id);
      return { bp: o ? o.effect_bp : c.resale_bp, detail: o ? { override: 1 } : undefined };
    }
    case 'flat':
      return { bp: c.effect_bp };
  }
}

function scoreFor(factor: FactorId, input: ComponentInputs): Score {
  switch (factor) {
    case 'cleanliness':
      return input.cleanliness;
    case 'exterior':
      return input.exterior;
    case 'scratches':
      return input.scratches;
    default:
      return input.accessory_condition;
  }
}

/**
 * ONE COMPONENT'S VALUE, with the lines that add up to it.
 *
 * The factors are walked in `FACTOR_IDS` order whatever order the rule set
 * lists them in, so two rule sets that say the same thing print the same
 * breakdown. A disabled factor, or one weighted to zero, prints nothing — a
 * line reading «0 د.ع» thirteen times is noise, not transparency.
 */
export function valuateComponent(rules: TradeInRuleSet, ctx: ValuationContext, input: ComponentInputs): ComponentValuation {
  const base = Math.max(0, Math.trunc(ctx.base_iqd));
  const lines: BreakdownLine[] = [
    { factor: 'base', label_ar: 'السعر المدفوع', label_en: 'Price paid', effect_bp: 0, amount_iqd: base },
  ];
  const byId = new Map(rules.factors.map((f) => [f.factor, f]));
  let raw = base;
  for (const id of FACTOR_IDS) {
    const rule = byId.get(id);
    if (!rule || !rule.enabled || rule.weight_bp === 0) continue;
    if (id === 'operating_hours' && input.hours === null) continue;
    const eff = rawEffect(rule, ctx, input);
    const bp = trunc((eff.bp * rule.weight_bp) / 10_000);
    if (bp === 0) continue;
    const amount = bpOf(base, bp);
    raw += amount;
    lines.push({
      factor: id,
      label_ar: FACTOR_LABELS[id].ar,
      label_en: FACTOR_LABELS[id].en,
      effect_bp: bp,
      amount_iqd: amount,
      ...(eff.detail ? { detail: eff.detail } : {}),
    });
  }
  const floor = bpOf(base, rules.floor_bp);
  const cap = bpOf(base, rules.cap_bp);
  const clamped = Math.min(cap, Math.max(floor, raw));
  if (clamped !== raw) {
    lines.push({
      factor: 'clamp',
      label_ar: clamped === cap ? 'الحد الأعلى للاستبدال' : 'الحد الأدنى للاستبدال',
      label_en: clamped === cap ? 'Trade-in ceiling' : 'Trade-in floor',
      effect_bp: 0,
      amount_iqd: clamped - raw,
      detail: { bp: clamped === cap ? rules.cap_bp : rules.floor_bp },
    });
  }
  const step = Math.max(1, Math.trunc(rules.rounding_iqd) || 1);
  const value = Math.max(0, Math.floor(clamped / step) * step);
  if (value !== clamped) {
    lines.push({ factor: 'rounding', label_ar: 'تقريب', label_en: 'Rounding', effect_bp: 0, amount_iqd: value - clamped });
  }
  return { family: rules.family, rule_version: rules.version, base_iqd: base, floor_iqd: floor, cap_iqd: cap, lines, value_iqd: value };
}

/**
 * WHAT THE CUSTOMER PAYS FOR THE NEW DEVICE.
 *
 * THE NEGATIVE-DIFFERENCE RULE (decided here, stated once): the trade-in is a
 * CREDIT AGAINST THE NEW DEVICE, never cash. When the old device is worth more
 * than the new one, the credit is capped at the new device's price — the
 * customer pays nothing for it, and the excess is NOT paid out to a wallet or
 * in cash. `excess_iqd` says how much was left on the table, so both screens
 * can tell the customer before they submit, while choosing a dearer target is
 * still possible. (A wallet payout would turn a trade-in into a way to sell a
 * used printer back to the shop for cash, which is a different business the
 * owner did not ask for.)
 */
export interface TradeInSettlement {
  target_price_iqd: number;
  trade_in_value_iqd: number;
  /** What is actually taken off the new device: min(value, target). */
  credit_iqd: number;
  /** What the customer still pays for the new device (≥ 0). Delivery is extra, as on any order. */
  difference_iqd: number;
  /** Value above the target price that is not credited (≥ 0). */
  excess_iqd: number;
}

export function tradeInSettlement(targetPriceIqd: number, valueIqd: number): TradeInSettlement {
  const target = Math.max(0, Math.trunc(targetPriceIqd));
  const value = Math.max(0, Math.trunc(valueIqd));
  const credit = Math.min(value, target);
  return {
    target_price_iqd: target,
    trade_in_value_iqd: value,
    credit_iqd: credit,
    difference_iqd: target - credit,
    excess_iqd: value - credit,
  };
}

// ============================================================ time

const DAY_MS = 86_400_000;
/** A month is 30 days here: the customer reads «14 شهر», not a calendar proof. */
const MONTH_DAYS = 30;

export function wholeMonthsBetween(fromIso: string | null, toIso: string): number {
  const a = fromIso ? Date.parse(fromIso) : NaN;
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.floor((b - a) / DAY_MS / MONTH_DAYS);
}

export function daysBetween(fromIso: string | null, toIso: string): number {
  const a = fromIso ? Date.parse(fromIso) : NaN;
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.floor((b - a) / DAY_MS);
}

/** Months of warranty left, rounded UP (a warranty ending in 10 days still has "a month" of cover to it). */
export function warrantyMonthsLeft(endIso: string | null, nowIso: string): number {
  const end = endIso ? Date.parse(endIso) : NaN;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(end) || !Number.isFinite(now) || end <= now) return 0;
  return Math.ceil((end - now) / DAY_MS / MONTH_DAYS);
}

/** Display-only time left (months, then days) — its own module so the warranty screens need not load this one. */
export { warrantyTimeLeft } from './warrantyTime';

// ============================================================ photos

export interface PhotoAngle {
  id: string;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  /** What to frame, one sentence. */
  hint_ar: string;
  hint_en: string;
  hint_ckb: string;
}

/** An angle: its id, then [ar, en, ckb] for the label and [ar, en, ckb] for the hint. */
const A = (id: string, label: [string, string, string], hint: [string, string, string]): PhotoAngle => ({
  id,
  label_ar: label[0],
  label_en: label[1],
  label_ckb: label[2],
  hint_ar: hint[0],
  hint_en: hint[1],
  hint_ckb: hint[2],
});

const FRONT = A(
  'front',
  ['الأمام', 'Front', 'پێشەوە'],
  ['الجهاز كاملاً من الأمام، والإضاءة جيدة.', 'The whole machine from the front, in good light.', 'ئامێرەکە بە تەواوی لە پێشەوە، لە ڕووناکییەکی باشدا.']
);
const BACK = A('back', ['الخلف', 'Back', 'دواوە'], ['الجهة الخلفية مع المنافذ والكابلات.', 'The back, with the ports and cables.', 'لای دواوە لەگەڵ دەرچە و کێبڵەکان.']);
const LEFT = A('left', ['الجانب الأيسر', 'Left side', 'لای چەپ'], ['الجانب الأيسر كاملاً.', 'The whole left side.', 'لای چەپ بە تەواوی.']);
const RIGHT = A('right', ['الجانب الأيمن', 'Right side', 'لای ڕاست'], ['الجانب الأيمن كاملاً.', 'The whole right side.', 'لای ڕاست بە تەواوی.']);
const SERIAL = A(
  'serial',
  ['ملصق الرقم التسلسلي', 'Serial label', 'لەیبڵی ژمارەی زنجیرەیی'],
  ['الملصق الذي يحمل الرقم التسلسلي، مقروءاً.', 'The label with the serial number, readable.', 'ئەو لەیبڵەی ژمارەی زنجیرەیی لەسەرە، بە شێوەیەک بخوێندرێتەوە.']
);

/**
 * «صور إلزامية من عدة زوايا، مع صور خاصة للأجزاء المهمة حسب نوع الجهاز».
 *
 * THE SERVER ENFORCES THIS LIST at submit (worker/lib/tradeIn.ts); the wizard
 * reads the same list, so the checklist on the phone cannot ask for less than
 * the door refuses. Code, not rule configuration: an angle is a question about
 * a physical machine, and a new one is a new question with its own hint.
 */
export const REQUIRED_PHOTOS: Record<TradeInFamily, PhotoAngle[]> = {
  fdm: [
    FRONT,
    BACK,
    LEFT,
    RIGHT,
    A(
      'build_plate',
      ['سطح الطباعة', 'Build plate', 'ڕووی چاپ'],
      ['سطح الطباعة بعد رفعه أو من الأعلى، ليظهر أي خدش أو تلف.', 'The build plate, lifted or from above, so any wear shows.', 'ڕووی چاپ دوای هەڵگرتنی یان لە سەرەوە، بۆ ئەوەی هەر ڕووشان یان زیانێک دەربکەوێت.']
    ),
    A('hotend', ['رأس الطباعة / النوزل', 'Hotend / nozzle', 'سەری چاپ / نۆزڵ'], ['رأس الطباعة والنوزل عن قرب.', 'The hotend and nozzle, close up.', 'سەری چاپ و نۆزڵەکە لە نزیکەوە.']),
    A(
      'screen_hours',
      ['الشاشة وساعات التشغيل', 'Screen with hours', 'شاشە و کاتژمێرەکانی کارکردن'],
      ['الشاشة مشغّلة وتظهر ساعات التشغيل إن أمكن.', 'The screen switched on, showing the hour counter if it has one.', 'شاشەکە هەڵکراو بێت و ئەگەر هەبێت کاتژمێرەکانی کارکردن پیشان بدات.']
    ),
    SERIAL,
  ],
  resin: [
    FRONT,
    BACK,
    LEFT,
    RIGHT,
    A('vat', ['حوض الريزن والفيلم', 'Resin vat & film', 'حەوزی ڕێزن و فیلمەکە'], ['الحوض فارغاً ونظيفاً، وفيلم FEP واضح.', 'The vat empty and clean, with the FEP film visible.', 'حەوزەکە بەتاڵ و پاک، و فیلمی FEP بە ڕوونی دیار بێت.']),
    A('lcd_screen', ['شاشة LCD', 'LCD screen', 'شاشەی LCD'], ['شاشة التعريض بعد رفع الحوض.', 'The exposure screen with the vat removed.', 'شاشەی تیشکدان دوای لابردنی حەوزەکە.']),
    A('build_plate', ['منصة الطباعة', 'Build platform', 'سەکۆی چاپ'], ['منصة الطباعة من الأسفل.', 'The build platform from below.', 'سەکۆی چاپ لە خوارەوە.']),
    SERIAL,
  ],
  laser: [
    FRONT,
    A('top', ['من الأعلى', 'From above', 'لە سەرەوە'], ['الجهاز من الأعلى ومنطقة العمل.', 'The machine from above, with the work area.', 'ئامێرەکە لە سەرەوە، لەگەڵ ناوچەی کارکردن.']),
    A('lens', ['العدسة', 'Lens', 'هاوێنە'], ['العدسة عن قرب، ليظهر أي اتساخ أو خدش.', 'The lens close up, so any dirt or scratch shows.', 'هاوێنەکە لە نزیکەوە، بۆ ئەوەی هەر پیسی یان ڕووشانێک دەربکەوێت.']),
    A('laser_module', ['وحدة الليزر', 'Laser module', 'یەکەی لەیزەر'], ['وحدة/رأس الليزر كاملة.', 'The whole laser module/head.', 'یەکە/سەری لەیزەر بە تەواوی.']),
    A('work_area', ['سطح العمل', 'Work bed', 'ڕووی کار'], ['سطح العمل أو الشبكة.', 'The work bed or honeycomb.', 'ڕووی کار یان تۆڕەکە.']),
    SERIAL,
  ],
  ams: [
    A('front', ['الأمام', 'Front', 'پێشەوە'], ['الوحدة كاملة من الأمام والغطاء مغلق.', 'The whole unit from the front, lid closed.', 'یەکەکە بە تەواوی لە پێشەوە، سەرپۆشەکەی داخراو.']),
    A('interior', ['الداخل', 'Interior', 'ناوەوە'], ['الغطاء مفتوح وتظهر الفتحات الأربع.', 'Lid open, with every slot visible.', 'سەرپۆشەکە کراوە و هەموو خانەکان دیار بن.']),
    A('back', ['الخلف والوصلات', 'Back & connectors', 'دواوە و گەیەنەرەکان'], ['الخلف مع الأنابيب والوصلات.', 'The back, with its tubes and connectors.', 'دواوە لەگەڵ بۆری و گەیەنەرەکانی.']),
    SERIAL,
  ],
  accessory: [
    FRONT,
    BACK,
    A('detail', ['تفاصيل الحالة', 'Condition detail', 'وردەکاریی دۆخ'], ['أي جزء يظهر حالته الحقيقية عن قرب.', 'Any part that shows its real condition, close up.', 'هەر بەشێک کە دۆخی ڕاستەقینەی لە نزیکەوە پیشان بدات.']),
  ],
};

/** Close-ups of damage are welcome and never required. */
export const OPTIONAL_PHOTO: PhotoAngle = A(
  'damage',
  ['صور الأضرار (اختياري)', 'Damage close-ups (optional)', 'وێنەی زیانەکان (ئارەزوومەندانە)'],
  ['أي خدش أو كسر أو عطل ظاهر.', 'Any visible scratch, crack or fault.', 'هەر ڕووشان، شکان یان تێکچوونێکی دیار.']
);

/**
 * THE HOURS SCREEN of a resin printer or a laser (S-P2, G14): optional as an
 * angle, and the photograph the hours answer is bound to on a v2 request
 * (`proves = 'hours'`). The FDM list already asks for it.
 */
export const HOURS_PHOTO: PhotoAngle = A(
  'screen_hours',
  ['الشاشة وساعات التشغيل', 'Screen with hours', 'شاشە و کاتژمێرەکانی کارکردن'],
  ['الشاشة مشغّلة وتظهر ساعات التشغيل.', 'The screen switched on, showing the hour counter.', 'شاشەکە هەڵکراو بێت و کاتژمێرەکانی کارکردن پیشان بدات.']
);

export const MAX_PHOTOS_PER_ANGLE = 3;
/** Damage close-ups: one per ticked fault at least (S-P2, G14), so twelve. */
export const MAX_DAMAGE_PHOTOS = 12;
export const MAX_PHOTOS_PER_REQUEST = 60;

/** The angles a component may carry; a v2 request adds the hours screen for a resin printer or a laser. */
export function anglesFor(family: TradeInFamily, valuationVersion = 1): PhotoAngle[] {
  const extra = valuationVersion >= 2 && familyCountsHours(family) && !REQUIRED_PHOTOS[family].some((a) => a.id === HOURS_PHOTO.id) ? [HOURS_PHOTO] : [];
  return [...REQUIRED_PHOTOS[family], ...extra, OPTIONAL_PHOTO];
}

export function isAllowedAngle(family: TradeInFamily, angle: string, valuationVersion = 1): boolean {
  return anglesFor(family, valuationVersion).some((a) => a.id === angle);
}

/**
 * THE PROOFS A v2 REQUEST STILL LACKS for one component (S-P2, G14): the hours
 * answer bound to a photograph of the hours screen (`hours`), and a damage
 * close-up for each ticked fault (`damage:<fault id>`). A photo proves what its
 * `proves` names; the hours screen's own angle proves the hours too.
 */
export function missingProofs(
  family: TradeInFamily,
  inputs: Pick<ComponentInputs, 'hours' | 'faults'>,
  photos: ReadonlyArray<{ angle: string; proves?: string | null }>
): string[] {
  const out: string[] = [];
  if (familyCountsHours(family) && inputs.hours !== null && !photos.some((p) => p.proves === 'hours' || p.angle === HOURS_PHOTO.id)) out.push('hours');
  for (const id of inputs.faults ?? []) {
    if (!photos.some((p) => p.angle === OPTIONAL_PHOTO.id && p.proves === id)) out.push(`damage:${id}`);
  }
  return out;
}

/** The required angles this component still lacks. */
export function missingPhotoAngles(family: TradeInFamily, uploadedAngles: readonly string[]): string[] {
  const have = new Set(uploadedAngles);
  return REQUIRED_PHOTOS[family].filter((a) => !have.has(a.id)).map((a) => a.id);
}

// ============================================================ status machine

/**
 * THE LIFE OF A REQUEST.
 *
 *   draft ──submit──▶ submitted ──inspect──▶ under_review
 *                        │                        │
 *            approve as estimated ◀───────────────┤
 *                        │                  change value
 *                        ▼                        ▼
 *            approved_as_estimated          value_changed ──(change again)──┐
 *                        │                   │          │         ◀────────┘
 *                        │           customer_accepted  customer_rejected ■
 *                        ▼                   ▼
 *                      awaiting_payment ◀────┘
 *                        │
 *                        ├──complete──▶ completed ■
 *                        └──cancel────▶ cancelled ■
 *
 * `approved_as_estimated` and `customer_accepted` are passed THROUGH: the same
 * batch that records either one moves the request on to `awaiting_payment`
 * (the value is fixed, there is nothing else to wait for), and the event log
 * keeps both steps so the timeline shows them. Any open state may be
 * cancelled. ■ = terminal.
 */
export const TRADE_IN_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'approved_as_estimated',
  'value_changed',
  'customer_accepted',
  'customer_rejected',
  'awaiting_payment',
  'completed',
  'cancelled',
] as const;
export type TradeInStatus = (typeof TRADE_IN_STATUSES)[number];

const TRANSITIONS: Record<TradeInStatus, readonly TradeInStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['under_review', 'approved_as_estimated', 'value_changed', 'cancelled'],
  under_review: ['approved_as_estimated', 'value_changed', 'cancelled'],
  approved_as_estimated: ['awaiting_payment', 'cancelled'],
  value_changed: ['value_changed', 'customer_accepted', 'customer_rejected', 'cancelled'],
  customer_accepted: ['awaiting_payment', 'cancelled'],
  customer_rejected: [],
  awaiting_payment: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: TradeInStatus, to: TradeInStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const TERMINAL_STATUSES: readonly TradeInStatus[] = ['customer_rejected', 'completed', 'cancelled'];
export const isTerminal = (s: TradeInStatus) => TERMINAL_STATUSES.includes(s);

/** States in which the parts stay claimed (released on rejection or cancellation). */
export const CLAIMING_STATUSES: readonly TradeInStatus[] = TRADE_IN_STATUSES.filter(
  (s) => s !== 'customer_rejected' && s !== 'cancelled'
);

/**
 * WHERE A REQUEST STANDS, AS ITS CUSTOMER READS IT (Services S-P2 spec §6.4,
 * §6.15) — derived from the stored status and the facts beside it, never stored
 * (no CHECK is widened). `liveOrder`: an order that is not cancelled holds the
 * credit; `liveReissue`: a credit given back (cancel / return) still valid and
 * not spent again.
 */
export const TRADE_IN_STAGES = [
  'draft',
  'awaiting_device',
  'inspecting',
  'decision',
  'credit_ready',
  'awaiting_new_device',
  'completed',
  'credit_reissued',
  'offer_expired',
  'credit_expired',
  'device_to_collect',
  'cancelled',
  'rejected',
] as const;
export type TradeInStage = (typeof TRADE_IN_STAGES)[number];

export function stageOf(
  r: { status: TradeInStatus; intake_at?: string | null; cancel_reason?: string | null; device_returned_at?: string | null },
  liveOrder: boolean,
  liveReissue: boolean
): TradeInStage {
  const received = !!r.intake_at;
  switch (r.status) {
    case 'draft':
      return 'draft';
    case 'submitted':
      return received ? 'inspecting' : 'awaiting_device';
    case 'under_review':
      return received ? 'inspecting' : 'awaiting_device';
    case 'value_changed':
      return 'decision';
    case 'approved_as_estimated':
    case 'customer_accepted':
    case 'awaiting_payment':
      if (liveOrder) return 'awaiting_new_device';
      return received ? 'credit_ready' : 'awaiting_device';
    case 'completed':
      return liveReissue && !liveOrder ? 'credit_reissued' : 'completed';
    case 'customer_rejected':
      return received && !r.device_returned_at ? 'device_to_collect' : 'rejected';
    case 'cancelled':
      if (r.cancel_reason === 'expired_offer') return 'offer_expired';
      if (received && !r.device_returned_at) return 'device_to_collect';
      return r.cancel_reason === 'expired_credit' ? 'credit_expired' : 'cancelled';
  }
}

/** The customer's words for each stage (spec §6.15; the Sorani is its own, DECISIONS row 183). */
export const STAGE_LABELS: Record<TradeInStage, Trilingual> = {
  draft: { ar: 'مسودة', en: 'Draft', ckb: 'ڕەشنووس' },
  awaiting_device: { ar: 'بانتظار جهازك', en: 'Waiting for your device', ckb: 'چاوەڕێی ئامێرەکەتین' },
  inspecting: { ar: 'استلمنا جهازك، قيد الفحص', en: 'We received your device; it is being inspected', ckb: 'ئامێرەکەتمان وەرگرت، لە پشکنیندایە' },
  decision: { ar: 'قيمة جديدة بانتظار موافقتك', en: 'A new value is waiting for your decision', ckb: 'بەهایەکی نوێ چاوەڕێی بڕیاری تۆیە' },
  credit_ready: { ar: 'رصيد الاستبدال جاهز', en: 'Your trade-in credit is ready', ckb: 'باڵانسی گۆڕینەوەکەت ئامادەیە' },
  awaiting_new_device: { ar: 'بانتظار وصول الجهاز الجديد', en: 'Waiting for your new device to arrive', ckb: 'چاوەڕێی گەیشتنی ئامێرە نوێیەکەین' },
  completed: { ar: 'اكتمل الاستبدال', en: 'Trade-in complete', ckb: 'گۆڕینەوەکە تەواو بوو' },
  credit_reissued: { ar: 'عاد رصيد الاستبدال', en: 'Your trade-in credit is back', ckb: 'باڵانسی گۆڕینەوەکەت گەڕایەوە' },
  offer_expired: { ar: 'انتهت صلاحية العرض', en: 'The offer expired', ckb: 'ماوەی پێشنیارەکە بەسەرچوو' },
  credit_expired: { ar: 'انتهت صلاحية الرصيد', en: 'The credit expired', ckb: 'ماوەی باڵانسەکە بەسەرچوو' },
  device_to_collect: { ar: 'جهازك جاهز للاستلام من المتجر', en: 'Your device is ready to collect from the store', ckb: 'ئامێرەکەت ئامادەیە بۆ وەرگرتنەوە لە فرۆشگا' },
  cancelled: { ar: 'ملغى', en: 'Cancelled', ckb: 'هەڵوەشێنرایەوە' },
  rejected: { ar: 'رفضت القيمة', en: 'You declined the value', ckb: 'بەهاکەت ڕەت کردەوە' },
};

export const STATUS_LABELS: Record<TradeInStatus, Trilingual> = {
  draft: { ar: 'قيد التحضير', en: 'Draft', ckb: 'لە ئامادەکردندایە' },
  submitted: { ar: 'أُرسل للمراجعة', en: 'Submitted', ckb: 'بۆ پێداچوونەوە نێردرا' },
  under_review: { ar: 'قيد الفحص', en: 'Under inspection', ckb: 'لە پشکنیندایە' },
  approved_as_estimated: { ar: 'اعتُمد التقدير', en: 'Estimate approved', ckb: 'خەمڵاندنەکە پەسەند کرا' },
  value_changed: { ar: 'قيمة جديدة بانتظار موافقتك', en: 'New value — your decision', ckb: 'بەهایەکی نوێ — چاوەڕێی بڕیاری تۆیە' },
  customer_accepted: { ar: 'وافقت على القيمة', en: 'You accepted', ckb: 'بەهاکەت قبووڵ کرد' },
  customer_rejected: { ar: 'رفضت القيمة', en: 'You declined', ckb: 'بەهاکەت ڕەت کردەوە' },
  awaiting_payment: { ar: 'بانتظار السداد', en: 'Awaiting payment', ckb: 'چاوەڕێی پارەدانە' },
  completed: { ar: 'اكتمل الاستبدال', en: 'Completed', ckb: 'گۆڕینەوەکە تەواو بوو' },
  cancelled: { ar: 'ملغى', en: 'Cancelled', ckb: 'هەڵوەشێنرایەوە' },
};

// ============================================================ validation

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => isInt(v) && v >= lo && v <= hi;
const ITEM_ID = /^[a-z0-9_]{2,40}$/;
const isScore = (v: unknown): v is Score => v === 1 || v === 2 || v === 3 || v === 4 || v === 5;

function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // Control characters out (a note is printed into Telegram and the admin
  // panel), whitespace collapsed at the edges, length capped.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

/**
 * A CUSTOMER'S ANSWERS, AGAINST THE ALLOW-LIST OF THE RULE SET IN FORCE.
 *
 * Every field is checked and rebuilt; nothing the client sent is stored as it
 * came. A fault or a part id must exist in the family's own checklist — so a
 * client cannot invent a «no fault» id worth +50%, and a checklist the admin
 * edited after the customer opened the form refuses the stale id rather than
 * silently pricing it at zero.
 */
export function validateInputs(raw: unknown, rules: TradeInRuleSet): Result<ComponentInputs> {
  const errors: string[] = [];
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const countsHours = familyCountsHours(rules.family);
  let hours: number | null = null;
  if (countsHours) {
    if (!inRange(o.hours, 0, MAX_HOURS)) errors.push('hours');
    else hours = o.hours;
  }
  for (const k of ['cleanliness', 'exterior', 'scratches', 'accessory_condition'] as const) {
    if (!isScore(o[k])) errors.push(k);
  }
  const faultIds = new Set(checklistOf(rules, 'faults').map((i) => i.id));
  const partIds = new Set(checklistOf(rules, 'replaced_parts').map((i) => i.id));
  const list = (v: unknown, allowed: Set<string>, name: string): string[] => {
    if (!Array.isArray(v)) {
      errors.push(name);
      return [];
    }
    if (v.length > MAX_CHECKLIST_ITEMS) errors.push(name);
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string' || !allowed.has(x)) {
        errors.push(`${name}:${typeof x === 'string' ? x.slice(0, 40) : '?'}`);
        continue;
      }
      if (!out.includes(x)) out.push(x);
    }
    return out;
  };
  const faults = list(o.faults ?? [], faultIds, 'faults');
  const parts = list(o.replaced_parts ?? [], partIds, 'replaced_parts');
  if (!inRange(o.repairs_count, 0, MAX_REPAIRS)) errors.push('repairs_count');
  const acc = o.original_accessories;
  if (acc !== 'all' && acc !== 'partial' && acc !== 'none') errors.push('original_accessories');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      hours,
      cleanliness: o.cleanliness as Score,
      exterior: o.exterior as Score,
      scratches: o.scratches as Score,
      faults,
      repairs_count: o.repairs_count as number,
      replaced_parts: parts,
      accessory_condition: o.accessory_condition as Score,
      original_accessories: acc as ComponentInputs['original_accessories'],
      fault_notes: cleanText(o.fault_notes, MAX_NOTE_CHARS),
      repair_notes: cleanText(o.repair_notes, MAX_NOTE_CHARS),
      notes: cleanText(o.notes, MAX_NOTE_CHARS),
    },
  };
}

export function checklistOf(rules: TradeInRuleSet, factor: 'faults' | 'replaced_parts'): ChecklistItem[] {
  const f = rules.factors.find((x) => x.factor === factor);
  return f && f.config.kind === 'checklist' ? f.config.items : [];
}

const PRODUCT_ID = /^[A-Za-z0-9_-]{1,80}$/;

function validateConfig(factor: FactorId, raw: unknown, errors: string[]): FactorConfig | null {
  const kind = FACTOR_KIND[factor];
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const E = BP_LIMITS.effect;
  const bad = (what: string) => {
    errors.push(`${factor}.${what}`);
    return null;
  };
  if (c.kind !== kind) return bad('kind');
  switch (kind) {
    case 'age':
      if (!inRange(c.per_month_bp, 0, 2000)) return bad('per_month_bp');
      if (!inRange(c.max_bp, 0, E)) return bad('max_bp');
      if (!inRange(c.grace_months, 0, 120)) return bad('grace_months');
      return { kind, per_month_bp: c.per_month_bp, max_bp: c.max_bp, grace_months: c.grace_months };
    case 'warranty':
      if (!inRange(c.per_month_bp, 0, 2000)) return bad('per_month_bp');
      if (!inRange(c.max_bp, 0, E)) return bad('max_bp');
      return { kind, per_month_bp: c.per_month_bp, max_bp: c.max_bp };
    case 'hours': {
      if (!Array.isArray(c.bands) || c.bands.length < 1 || c.bands.length > 12) return bad('bands');
      const bands: Array<{ up_to: number | null; effect_bp: number }> = [];
      let prev = -1;
      for (let i = 0; i < c.bands.length; i++) {
        const b = (c.bands[i] ?? {}) as Record<string, unknown>;
        const last = i === c.bands.length - 1;
        // Ascending, and only the LAST band may be open-ended — otherwise a
        // band after an open one could never be reached and the editor would
        // be showing the owner a rule that does nothing.
        if (last ? !(b.up_to === null || inRange(b.up_to, prev + 1, MAX_HOURS)) : !inRange(b.up_to, prev + 1, MAX_HOURS)) {
          return bad(`bands[${i}].up_to`);
        }
        if (!inRange(b.effect_bp, -E, E)) return bad(`bands[${i}].effect_bp`);
        bands.push({ up_to: b.up_to as number | null, effect_bp: b.effect_bp as number });
        if (typeof b.up_to === 'number') prev = b.up_to;
      }
      if (bands[bands.length - 1].up_to !== null) return bad('bands.last_open');
      return { kind, bands };
    }
    case 'scale': {
      const e = c.effects_bp;
      if (!Array.isArray(e) || e.length !== 5 || !e.every((x) => inRange(x, -E, E))) return bad('effects_bp');
      return { kind, effects_bp: [e[0], e[1], e[2], e[3], e[4]] as [number, number, number, number, number] };
    }
    case 'checklist': {
      if (!Array.isArray(c.items) || c.items.length > MAX_CHECKLIST_ITEMS) return bad('items');
      const items: ChecklistItem[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < c.items.length; i++) {
        const it = (c.items[i] ?? {}) as Record<string, unknown>;
        if (typeof it.id !== 'string' || !ITEM_ID.test(it.id) || seen.has(it.id)) return bad(`items[${i}].id`);
        const la = cleanText(it.label_ar, 80);
        const le = cleanText(it.label_en, 80);
        if (!la || !le) return bad(`items[${i}].label`);
        if (!inRange(it.effect_bp, -E, E)) return bad(`items[${i}].effect_bp`);
        seen.add(it.id);
        items.push({ id: it.id, label_ar: la, label_en: le, effect_bp: it.effect_bp as number });
      }
      if (!inRange(c.max_total_bp, -E, 0)) return bad('max_total_bp');
      return { kind, items, max_total_bp: c.max_total_bp };
    }
    case 'count':
      if (!inRange(c.per_item_bp, 0, E)) return bad('per_item_bp');
      if (!inRange(c.max_bp, 0, E)) return bad('max_bp');
      return { kind, per_item_bp: c.per_item_bp, max_bp: c.max_bp };
    case 'choice': {
      if (!Array.isArray(c.options)) return bad('options');
      const out: Array<{ id: 'all' | 'partial' | 'none'; effect_bp: number }> = [];
      for (const id of ['all', 'partial', 'none'] as const) {
        const o = (c.options as Array<Record<string, unknown>>).find((x) => x && x.id === id);
        if (!o || !inRange(o.effect_bp, -E, E)) return bad(`options.${id}`);
        out.push({ id, effect_bp: o.effect_bp as number });
      }
      if (c.options.length !== 3) return bad('options');
      return { kind, options: out };
    }
    case 'market': {
      if (!inRange(c.resale_bp, -E, E)) return bad('resale_bp');
      const ov = c.product_overrides;
      if (!Array.isArray(ov) || ov.length > 200) return bad('product_overrides');
      const overrides: Array<{ product_id: string; effect_bp: number }> = [];
      const seen = new Set<string>();
      for (let i = 0; i < ov.length; i++) {
        const x = (ov[i] ?? {}) as Record<string, unknown>;
        if (typeof x.product_id !== 'string' || !PRODUCT_ID.test(x.product_id) || seen.has(x.product_id)) {
          return bad(`product_overrides[${i}].product_id`);
        }
        if (!inRange(x.effect_bp, -E, E)) return bad(`product_overrides[${i}].effect_bp`);
        seen.add(x.product_id);
        overrides.push({ product_id: x.product_id, effect_bp: x.effect_bp as number });
      }
      return { kind, resale_bp: c.resale_bp, product_overrides: overrides };
    }
    case 'flat':
      if (!inRange(c.effect_bp, -E, E)) return bad('effect_bp');
      return { kind, effect_bp: c.effect_bp };
  }
}

/**
 * AN ADMIN'S RULE SET, BEFORE IT IS SAVED AS A NEW VERSION.
 *
 * Every one of the thirteen factors must be present (disabled is a choice; a
 * missing factor is a mistake), every number an integer inside its range, the
 * floor below the cap, the hour bands ascending and closed by an open band.
 * The editor shows the paths this returns next to the fields they name.
 */
export function validateRuleSet(raw: unknown, family: TradeInFamily): Result<Omit<TradeInRuleSet, 'version' | 'is_default'>> {
  const errors: string[] = [];
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!inRange(o.floor_bp, 0, 10_000)) errors.push('floor_bp');
  if (!inRange(o.cap_bp, 0, 10_000)) errors.push('cap_bp');
  if (isInt(o.floor_bp) && isInt(o.cap_bp) && o.floor_bp > o.cap_bp) errors.push('floor_above_cap');
  if (!inRange(o.rounding_iqd, 1, 1_000_000)) errors.push('rounding_iqd');
  if (!inRange(o.min_base_iqd, 0, 1_000_000_000)) errors.push('min_base_iqd');
  if (!inRange(o.ams_reference_iqd, 0, 1_000_000_000)) errors.push('ams_reference_iqd');
  const list = Array.isArray(o.factors) ? (o.factors as unknown[]) : [];
  if (!Array.isArray(o.factors)) errors.push('factors');
  const factors: FactorRule[] = [];
  for (const id of FACTOR_IDS) {
    const f = list.find((x) => x && typeof x === 'object' && (x as Record<string, unknown>).factor === id) as
      | Record<string, unknown>
      | undefined;
    if (!f) {
      errors.push(`${id}.missing`);
      continue;
    }
    if (typeof f.enabled !== 'boolean') errors.push(`${id}.enabled`);
    if (!inRange(f.weight_bp, 0, BP_LIMITS.weight)) errors.push(`${id}.weight_bp`);
    const config = validateConfig(id, f.config, errors);
    if (config && typeof f.enabled === 'boolean' && isInt(f.weight_bp)) {
      factors.push({ factor: id, enabled: f.enabled, weight_bp: f.weight_bp, config });
    }
  }
  if (list.length !== FACTOR_IDS.length) errors.push('factors.count');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      family,
      floor_bp: o.floor_bp as number,
      cap_bp: o.cap_bp as number,
      rounding_iqd: o.rounding_iqd as number,
      min_base_iqd: o.min_base_iqd as number,
      ams_reference_iqd: o.ams_reference_iqd as number,
      factors,
    },
  };
}

// The seeded default rule sets live in ./tradeInDefaults.ts (DECISIONS row
// 219): this module is shared with the customer's browser, which must not
// download the owner's valuation numbers; only the Worker and the tests read
// the defaults.
