/**
 * THE SENTENCES THE MEMBERSHIP PAGE IS ALLOWED TO SAY — pure, and nowhere else.
 *
 * §22 — THE SHOPPING BENEFITS ARE READ, NEVER WRITTEN HERE.
 *
 * Every percentage, threshold, ceiling and covered delivery method below comes
 * from `GET /api/memberships/plans` → `benefits`, which is the
 * `membership_benefit_rules` table the checkout itself applies
 * (`docs/MEMBERSHIP_BENEFITS.md`). A figure typed into a React string is a
 * promise nobody can keep: the owner lowers it in the admin, the page goes on
 * quoting the old number, and the customer discovers the difference at the
 * door. So when a tier has no rule configured — or an older server sends no
 * `benefits` at all — nothing is said about that benefit rather than a figure
 * nobody enforces.
 *
 * Pure functions with `loc` and `money` passed in, so the tier cards, the
 * comparison matrix and the tests all phrase a rule the same way.
 *
 * KURDISH IS REUSED, NEVER INVENTED. Every Sorani fragment here is one the
 * codebase already ships («داشکاندن», «زۆرترین داشکاندن … بۆ هەر یەکێک»,
 * «گەیاندنی بێبەرامبەر لە سەرووی …», «بەرهەمی گونجاو», …). Where none exists
 * the sentence reads in Arabic, which is what the cart does with the same
 * benefit rather than manufacture Sorani.
 */

/* ------------------------------------------ what the server says it promises */

/** Mirrors `PublicDiscountRule` in worker/lib/membershipBenefits.ts. */
export interface BenefitDiscountRule {
  rule_id: string;
  /**
   * `product` only from a server older than the per-section summary; the
   * current one publishes a group of product rules as `category` with
   * `product_count` set, and never names a product.
   */
  scope: 'global' | 'category' | 'sub_category' | 'product';
  target_id: string | null;
  target_name_ar: string;
  target_name_en: string;
  /** The section's Sorani name when the owner wrote one. */
  target_name_ckb?: string;
  discount_mode: 'percent' | 'fixed' | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: 'per_unit' | 'per_order' | null;
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  label: string | null;
  /** null for a rule written on a section; a count for a group of product rules. */
  product_count?: number | null;
}

export interface BenefitFreeShipping {
  rule_id: string;
  /** null = no minimum at all, NOT "unknown". */
  threshold_iqd: number | null;
  /** null = every method; a list = only these. */
  methods: string[] | null;
  max_subsidy_iqd: number | null;
}

/** Mirrors `PublicTierBenefits`. */
export interface TierBenefits {
  discounts: BenefitDiscountRule[];
  free_shipping: BenefitFreeShipping | null;
  cod_tax_exempt: boolean;
}

/** `benefits` on GET /api/memberships/plans. Absent on an older server. */
export type PlanBenefits = Partial<Record<'prime' | 'pro', TierBenefits | null>>;

export type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * A FORMATTER IS PASSED IN, exactly as `loc` is. The amounts inside these
 * sentences are prices like any other: they follow the currency the customer
 * chose (src/CurrencyContext.tsx).
 */
export type Money = (iqd: number) => string;

/**
 * A figure wrapped in a Unicode isolate in the page's own direction (LRI or
 * RLI … PDI), for the sentences the page renders. «29,000 د.ع · 12 months» in
 * an English paragraph otherwise reorders: the Arabic letters of the currency
 * pull the digits after them into their run and the line reads «29,000 12 ·
 * د.ع months». The isolate keeps each amount one unit; its direction is the
 * paragraph's (a first-strong isolate would read the currency's letters and
 * turn the amount around in English). Tests pass a plain formatter and
 * compare the plain sentence.
 */
export function isolatedMoney(money: Money, dir: 'rtl' | 'ltr'): Money {
  const open = dir === 'rtl' ? '\u2067' : '\u2066';
  return (iqd) => `${open}${money(iqd)}\u2069`;
}

/**
 * Every delivery method a rule is allowed to name — `DeliveryMethodId` in
 * packages/pricing/src/membershipBenefits.ts, which the admin door filters
 * every saved list against. A rule that names all of them needs no qualifier;
 * one that names fewer says which, so the page never promises a method the
 * quote engine will charge for.
 */
const DELIVERY_METHOD_IDS = ['standard', 'personal'] as const;
type DeliveryMethodId = (typeof DELIVERY_METHOD_IDS)[number];

function isDeliveryMethodId(id: string): id is DeliveryMethodId {
  return (DELIVERY_METHOD_IDS as readonly string[]).includes(id);
}

function methodLabel(id: DeliveryMethodId, loc: Loc): string {
  // A delivery method carries no Kurdish title anywhere in the store, so the
  // Arabic name is used there — exactly as the cart's `deliveryMethodName`
  // does with the configured titles.
  return id === 'standard'
    ? loc('التوصيل العادي', 'Standard delivery', 'گەیاندنی ئاسایی')
    : loc('التوصيل الشخصي', 'Personal delivery');
}

/**
 * Whether a free-delivery THRESHOLD figure actually reaches the screen for
 * this tier. It is the one thing the threshold footnote explains, and a note
 * about a bar the page never names explains nothing.
 */
export function statesADeliveryThreshold(benefits: TierBenefits | null | undefined): boolean {
  const fs = benefits?.free_shipping;
  if (!fs || fs.threshold_iqd === null) return false;
  return fs.methods === null || fs.methods.some(isDeliveryMethodId);
}

/* ----------------------------------------------------------- the discounts */

/** What the line is ABOUT: a section's name, the whole store, or "eligible products". */
function targetName(rule: BenefitDiscountRule, loc: Loc): string | null {
  if (rule.scope === 'global') return loc('جميع المنتجات', 'all products', 'هەموو بەرهەمەکان');
  const ar = rule.target_name_ar.trim();
  const en = rule.target_name_en.trim();
  const ckb = (rule.target_name_ckb ?? '').trim();
  const named = loc(ar || en, en || ar, ckb || ar || en);
  if (named) return named;
  // A group of product rules whose products are filed under no section — or
  // an older server's per-product row — is still a benefit the checkout
  // applies, so it is stated against the store's existing words for "whatever
  // the rule covers". A SECTION rule whose section no longer names itself
  // cannot be stated honestly: "10% off" with nothing after it reads as the
  // whole catalogue.
  if (rule.scope === 'product' || (rule.product_count ?? 0) > 0) {
    return loc('المنتجات المؤهلة', 'eligible products', 'بەرهەمی گونجاو');
  }
  return null;
}

/** The effective per-unit figure of a fixed rule: a per-unit ceiling below it wins. */
function fixedPerUnit(rule: BenefitDiscountRule): number | null {
  const fixed = rule.fixed_iqd;
  if (fixed === null || !(fixed > 0)) return null;
  if (rule.cap_scope === 'per_unit' && rule.max_discount_iqd !== null && rule.max_discount_iqd >= 0) {
    return Math.min(fixed, rule.max_discount_iqd);
  }
  return fixed;
}

/**
 * A count or a percentage in the digits the money beside it uses. `money`
 * (`formatIqd`) formats with the device's locale, so a raw `${pct}` put Latin
 * «10%» and Arabic-Indic «١٠٠٬٠٠٠ د.ع» into one sentence.
 */
const num = (n: number): string => n.toLocaleString();

/** The qualifiers that narrow a rule, said after a dash. */
function qualifiers(rule: BenefitDiscountRule, loc: Loc, money: Money): string[] {
  const out: string[] = [];
  if (rule.max_quantity !== null && rule.max_quantity > 0) {
    const n = num(rule.max_quantity);
    out.push(loc(`لأول ${n} من الكمية`, `on the first ${n} of the quantity`, `بۆ هەر یەکێک لە ${n} یەکەکە`));
  }
  // `selectRule` tests this with `>=`, so it reads "or more" and never "above".
  if (rule.min_subtotal_iqd !== null && rule.min_subtotal_iqd > 0) {
    const min = money(rule.min_subtotal_iqd);
    out.push(loc(`للطلبات من ${min} فأكثر`, `on orders of ${min} or more`));
  }
  return out;
}

/**
 * THE OWNER'S TEMPLATE: «خصم 10% حتى 100,000 لكل وحدة على الطابعات».
 *
 * The owner's words: «عرض الخصم لكل منتج خطأ؛ الصحيح خصم 10% حتى 100,000 لكل
 * وحدة على الفئة». So the ceiling sits with the figure it limits and the
 * section closes the sentence; a store-wide rule says «على جميع المنتجات»
 * instead of trailing off after the figure.
 *
 *   percent + per-unit ceiling  خصم {pct}% حتى {cap} لكل وحدة على {القسم}
 *   percent                     خصم {pct}% على {القسم}
 *   fixed                       خصم {amount} لكل وحدة على {القسم}
 *                               (a per-unit ceiling at or above the amount is
 *                               the amount, and is not printed twice)
 *   per-order ceiling           حتى {cap} لكل طلب — one budget for the whole
 *                               order (`orderLineBenefits`), the same words
 *                               the cart uses («الخصم بحد أقصى لكل طلب»)
 *
 * The quantity and minimum-order qualifiers follow a dash, because a benefit
 * stated wider than the rule is a refund conversation at the checkout. A
 * ceiling with no `cap_scope` is inert in `unitDiscountIqd` and is not claimed.
 */
export function discountLine(rule: BenefitDiscountRule, loc: Loc, money: Money): string | null {
  const name = targetName(rule, loc);
  if (!name) return null;

  let head: string;
  if (rule.discount_mode === 'percent') {
    if (rule.percent === null || !(rule.percent > 0)) return null;
    const pct = num(rule.percent);
    const cap = rule.max_discount_iqd !== null && rule.cap_scope ? money(rule.max_discount_iqd) : null;
    if (cap && rule.cap_scope === 'per_unit') {
      head = loc(
        `خصم ${pct}% حتى ${cap} لكل وحدة على ${name}`,
        `${pct}% off, up to ${cap} per unit, on ${name}`,
        `داشکاندنی ${pct}% بۆ ${name} — زۆرترین داشکاندن ${cap} بۆ هەر یەکێک`
      );
    } else if (cap) {
      head = loc(`خصم ${pct}% حتى ${cap} لكل طلب على ${name}`, `${pct}% off, up to ${cap} per order, on ${name}`);
    } else {
      head = loc(`خصم ${pct}% على ${name}`, `${pct}% off ${name}`, `داشکاندنی ${pct}% بۆ ${name}`);
    }
  } else if (rule.discount_mode === 'fixed') {
    const perUnit = fixedPerUnit(rule);
    if (perUnit === null || !(perUnit > 0)) return null;
    const amount = money(perUnit);
    head = loc(
      `خصم ${amount} لكل وحدة على ${name}`,
      `${amount} off every unit of ${name}`,
      `داشکاندنی ${amount} بۆ هەر یەکێک لە ${name}`
    );
    if (rule.cap_scope === 'per_order' && rule.max_discount_iqd !== null) {
      const cap = money(rule.max_discount_iqd);
      head += loc(` — حتى ${cap} لكل طلب`, ` — up to ${cap} per order`);
    }
  } else {
    return null;
  }
  const q = qualifiers(rule, loc, money);
  return q.length ? `${head} — ${q.join(loc('، ', ', '))}` : head;
}

/**
 * The same offer, without the section — for a matrix cell whose row already
 * names it. «10% · حتى 100,000 د.ع لكل وحدة».
 */
export function discountCell(rule: BenefitDiscountRule, loc: Loc, money: Money): string | null {
  let head: string;
  if (rule.discount_mode === 'percent') {
    if (rule.percent === null || !(rule.percent > 0)) return null;
    const pct = num(rule.percent);
    const cap = rule.max_discount_iqd !== null && rule.cap_scope ? money(rule.max_discount_iqd) : null;
    head = cap
      ? rule.cap_scope === 'per_unit'
        ? loc(`${pct}% حتى ${cap} لكل وحدة`, `${pct}%, up to ${cap} per unit`, `${pct}% — زۆرترین ${cap} بۆ هەر یەکێک`)
        : loc(`${pct}% حتى ${cap} لكل طلب`, `${pct}%, up to ${cap} per order`)
      : `${pct}%`;
  } else if (rule.discount_mode === 'fixed') {
    const perUnit = fixedPerUnit(rule);
    if (perUnit === null || !(perUnit > 0)) return null;
    head = loc(`${money(perUnit)} لكل وحدة`, `${money(perUnit)} per unit`, `${money(perUnit)} بۆ هەر یەکێک`);
  } else {
    return null;
  }
  const q = qualifiers(rule, loc, money);
  return q.length ? `${head} — ${q.join(loc('، ', ', '))}` : head;
}

/**
 * HOW MANY DISTINCT OFFERS ONE SECTION MAY LIST before it is summarised.
 *
 * Grouping per section already folds a thousand identically-configured
 * per-product rules into one line. It does not bound an owner who gives each
 * printer its own figure; past this many the section says the honest ceiling
 * instead — «خصم حتى 15% على الطابعات» — which is a figure a rule carries, so
 * §22 still holds. The product page states each product's exact price.
 */
export const MAX_LINES_PER_SECTION = 3;

/** The line that stands for a section with too many distinct offers. */
function sectionSummary(rules: BenefitDiscountRule[], name: string, loc: Loc, money: Money): string {
  const percents = rules.map((r) => (r.discount_mode === 'percent' ? r.percent : null));
  if (percents.every((p): p is number => p !== null && p > 0)) {
    const max = num(Math.max(...percents));
    return loc(`خصم حتى ${max}% على ${name}`, `Up to ${max}% off ${name}`);
  }
  const fixed = rules.map((r) => (r.discount_mode === 'fixed' ? fixedPerUnit(r) : null));
  if (fixed.every((f): f is number => f !== null && f > 0)) {
    const max = money(Math.max(...fixed));
    return loc(`خصم حتى ${max} لكل وحدة على ${name}`, `Up to ${max} off every unit of ${name}`);
  }
  return loc(`خصومات العضوية على ${name}`, `Membership discounts on ${name}`, `داشکاندنی ئەندامێتی بۆ ${name}`);
}

/** The discount lines, one group per section, bounded per section. */
function sectionKey(rule: BenefitDiscountRule): string {
  return rule.scope === 'global' ? 'global' : rule.target_id ? `id:${rule.target_id}` : `unnamed:${rule.scope}`;
}

export interface SectionDiscounts {
  key: string;
  /** The section's name as the row label, or "all products" / "eligible products". */
  name: string;
  rules: BenefitDiscountRule[];
}

/** The tier's discount rules grouped by what they are about, in the server's order. */
export function discountSections(benefits: TierBenefits | null | undefined, loc: Loc): SectionDiscounts[] {
  const out = new Map<string, SectionDiscounts>();
  for (const rule of benefits?.discounts ?? []) {
    const name = targetName(rule, loc);
    if (!name) continue;
    const key = sectionKey(rule);
    const entry = out.get(key) ?? { key, name, rules: [] };
    entry.rules.push(rule);
    out.set(key, entry);
  }
  return [...out.values()];
}

/** The lines one section contributes: up to three offers, or its summary. */
export function sectionLines(section: SectionDiscounts, loc: Loc, money: Money, cell = false): string[] {
  const render = cell ? discountCell : discountLine;
  const lines = [...new Set(section.rules.map((r) => render(r, loc, money)).filter((l): l is string => !!l))];
  if (lines.length <= MAX_LINES_PER_SECTION) return lines;
  const summary = sectionSummary(section.rules, section.name, loc, money);
  if (!cell) return [summary];
  // In a cell the row names the section; keep only the figure.
  const percents = section.rules.map((r) => (r.discount_mode === 'percent' ? r.percent : null));
  if (percents.every((p): p is number => p !== null && p > 0)) {
    const top = num(Math.max(...percents));
    return [loc(`حتى ${top}%`, `Up to ${top}%`)];
  }
  return [summary];
}

/* -------------------------------------------------------- delivery and tax */

/** "توصيل مجاني للطلبات فوق 75,000 د.ع", and which methods it covers. */
export function freeShippingLine(tier: 'prime' | 'pro', fs: BenefitFreeShipping, loc: Loc, money: Money, short = false): string | null {
  // `methods: null` covers every method. A list covers exactly what it names,
  // and an id this page cannot name is dropped rather than printed raw.
  const covered = fs.methods === null ? null : fs.methods.filter(isDeliveryMethodId);
  if (covered !== null && covered.length === 0) return null;

  const threshold = fs.threshold_iqd !== null ? money(fs.threshold_iqd) : null;
  const subsidy = fs.max_subsidy_iqd !== null ? money(fs.max_subsidy_iqd) : null;

  // §3: with a subsidy ceiling the member can still pay a difference, so the
  // delivery is never called free — it is called what it is. Each figure is
  // interpolated only inside the branch its own guard opened.
  let head: string;
  if (short) {
    head = subsidy
      ? threshold
        ? loc(`يغطي حتى ${subsidy} فوق ${threshold}`, `Covers up to ${subsidy} above ${threshold}`)
        : loc(`يغطي حتى ${subsidy}`, `Covers up to ${subsidy}`)
      : threshold
        ? loc(`مجاني فوق ${threshold}`, `Free above ${threshold}`, `بێبەرامبەر لە سەرووی ${threshold}`)
        : loc('مجاني', 'Free', 'بێبەرامبەر');
  } else {
    head = subsidy
      ? threshold
        ? loc(
            `تغطي العضوية حتى ${subsidy} من أجرة التوصيل للطلبات فوق ${threshold}`,
            `The membership covers up to ${subsidy} of the delivery fee on orders above ${threshold}`
          )
        : loc(`تغطي العضوية حتى ${subsidy} من أجرة التوصيل`, `The membership covers up to ${subsidy} of the delivery fee`)
      : threshold
        ? loc(
            `توصيل مجاني للطلبات فوق ${threshold}`,
            `Free delivery on orders above ${threshold}`,
            `گەیاندنی بێبەرامبەر لە سەرووی ${threshold}`
          )
        : loc('توصيل مجاني على الطلبات المؤهلة', 'Free delivery on eligible orders', 'گەیاندنی بێبەرامبەر');
  }
  const parts = [head];
  // Named only when the rule covers less than every method — a set test, not
  // a length test, so a row that repeats an id cannot read as full coverage.
  if (covered !== null && !DELIVERY_METHOD_IDS.every((id) => covered.includes(id))) {
    parts.push(`(${covered.map((m) => methodLabel(m, loc)).join(loc('، ', ', '))})`);
  }
  // CONFIRMED, and deliberately NOT a rule: a PRO delivery benefit exists at
  // the approved default address (packages/shipping keeps that condition
  // whatever the rule says the benefit is worth).
  if (tier === 'pro' && !short) parts.push(loc('على العنوان المعتمد', 'at the approved address', 'لە ناونیشانی پەسەندکراو'));
  return parts.join(' ');
}

/** §4: the tax is calculated on every order and then waived. */
export function codTaxLine(loc: Loc): string {
  return loc('إعفاء من ضريبة الدفع عند الاستلام', 'Exempt from the cash-on-delivery tax');
}

/**
 * The tier's shopping benefits as the rules currently stand: the discounts
 * (per section, bounded), then the delivery, then the cash-on-delivery tax. An
 * unconfigured benefit contributes nothing — there is no default sentence.
 *
 * Exported so tests can hold it to the two promises above against real rule
 * rows: a figure only ever reaches the screen because a rule carries it, and
 * the length of this list is bounded by the sections and offers the owner
 * configured, never by the size of the catalogue.
 */
export function shoppingLines(
  tier: 'prime' | 'pro',
  benefits: TierBenefits | null | undefined,
  loc: Loc,
  money: Money
): string[] {
  if (!benefits) return [];
  const out: string[] = [];
  for (const section of discountSections(benefits, loc)) out.push(...sectionLines(section, loc, money));
  if (benefits.free_shipping) {
    const line = freeShippingLine(tier, benefits.free_shipping, loc, money);
    if (line) out.push(line);
  }
  if (benefits.cod_tax_exempt) out.push(codTaxLine(loc));
  // Two rules can phrase themselves identically; the list keys on the line.
  return [...new Set(out)];
}
