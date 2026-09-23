/**
 * Compact, inheritance-first membership comparison. The customer sees only
 * what the Worker enforces; the expanded list makes inherited benefits
 * accessible without stretching every card on phones and tablets.
 *
 * §22 — THE SHOPPING BENEFITS ARE READ, NEVER WRITTEN HERE.
 *
 * Every percentage, threshold, ceiling and covered delivery method on this
 * page comes from `GET /api/memberships/plans` → `benefits`, which is the
 * `membership_benefit_rules` table the checkout itself applies
 * (`docs/MEMBERSHIP_BENEFITS.md`). A figure typed into a React string is a
 * promise nobody can keep: the owner lowers it in the admin, the page goes on
 * quoting the old number, and the customer discovers the difference at the
 * door. So when a tier has no rule configured — or an older server sends
 * no `benefits` at all — this page says NOTHING about that benefit rather
 * than repeating a figure nobody enforces.
 *
 * The points multipliers, the priority service, the gifts, the community and
 * warranty lines are not part of that system and stay exactly as they are.
 * PLUS holds no pricing or delivery entitlement at all, so no rule can exist
 * for it and its list is untouched.
 */
import type { ReactNode } from 'react';
import { Check, ChevronDown, Info, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { TIER_META, type PaidTier } from './tierMeta';
import type { PlanFeatures } from './types';
import { useMoney } from '../../CurrencyContext';

/* ------------------------------------------ what the server says it promises */

/** Mirrors `PublicDiscountRule` in worker/lib/membershipBenefits.ts. */
export interface BenefitDiscountRule {
  rule_id: string;
  scope: 'global' | 'category' | 'sub_category' | 'product';
  target_id: string | null;
  target_name_ar: string;
  target_name_en: string;
  discount_mode: 'percent' | 'fixed' | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: 'per_unit' | 'per_order' | null;
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  label: string | null;
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

export interface BenefitsSectionProps {
  features: PlanFeatures | null;
  benefits: PlanBenefits | null;
  loading: boolean;
}

type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * KURDISH IS REUSED, NEVER INVENTED.
 *
 * Every Sorani string below is one this codebase already ships:
 * «گەیاندنی بێبەرامبەر» is the memberships admin's own free-delivery label,
 * «لە سەرووی …» and «لە ناونیشانی پەسەندکراو» and «گەیاندنی ئاسایی» are this
 * file's existing benefit lines, «داشکاندن» the discount row, and
 * «زۆرترین داشکاندن بۆ هەر یەکێک / بۆ هەر داواکارییەک» and
 * «بۆ هەر یەکێک لە … یەکەکە» the cart's membership lines. Where no equivalent
 * exists the sentence reads in Arabic, which is what the cart does with the
 * same benefit rather than manufacture Sorani.
 */

/**
 * Every delivery method a rule is allowed to name — `DeliveryMethodId` in
 * packages/pricing/src/membershipBenefits.ts, which the admin door filters
 * every saved list against (`METHODS` in adminMembershipBenefits.ts). A rule
 * that names all of them needs no qualifier; one that names fewer says which,
 * so the page never promises a method the quote engine will charge for.
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
 * this tier. It is the one thing the note under the card explains, and a note
 * about a bar the card never names explains nothing.
 */
function statesADeliveryThreshold(benefits: TierBenefits | null | undefined): boolean {
  const fs = benefits?.free_shipping;
  if (!fs || fs.threshold_iqd === null) return false;
  return fs.methods === null || fs.methods.some(isDeliveryMethodId);
}

/**
 * A FORMATTER IS PASSED IN, exactly as `loc` is.
 *
 * These are pure sentence builders at module scope — no component, no hook —
 * and the amounts inside them are prices like any other: they must follow the
 * currency the customer chose (src/CurrencyContext.tsx). Threading it is what
 * keeps them pure and keeps «خصم 100,000 د.ع» from being the one figure on the
 * page that ignores the switch.
 */
type Money = (iqd: number) => string;

/**
 * A BENEFIT IS STATED, NOT ENUMERATED.
 *
 * The owner's words: «المقصود هو ميزة الاشتراك يذكر الخصم لكل منتج بدل ذكر
 * عام» — the card was naming the discount PER PRODUCT instead of stating it
 * generally. That is not a copy slip; it is what the data does. The server
 * publishes EVERY live `product_discount` row, `scope: 'product'` rows
 * included (`publicBenefitSummary` in worker/lib/membershipBenefits.ts), and
 * it sorts most-specific FIRST. A store that prices a few thousand products
 * with per-product overrides therefore opened the membership card with a few
 * thousand check-marked lines, each naming one product, with the tier-wide
 * «خصم 10%» buried under all of them. The list grew with the catalogue, so
 * it could only ever get worse.
 *
 * A per-product override is a PRICE, and a price belongs on the product — the
 * shopper already sees the member figure there. What belongs here is the
 * promise: the percentage, the ceiling, the quantity and the minimum. So a
 * `scope: 'product'` rule is stated against «المنتجات المؤهلة» — the store's
 * existing words for "whatever the rule covers", the same ones the tier
 * headline and the printer-gift note already use — and never against the
 * product's own name. Identical rules then collapse into one sentence for
 * free, because `shoppingLines` keys the list on the rendered line.
 *
 * NOTHING IS OVERSTATED BY THIS. Dropping a name only ever makes the claim
 * NARROWER in the reader's mind than the rule is in the engine; a figure is
 * still never printed unless the rule carries it (§22 above).
 */
/** "خصم 10% على الطابعات — حتى 100,000 د.ع لكل وحدة", from the rule alone. */
function discountLine(rule: BenefitDiscountRule, loc: Loc, money: Money): string | null {
  const ar = rule.target_name_ar.trim();
  const en = rule.target_name_en.trim();
  const name =
    rule.scope === 'product'
      ? loc('المنتجات المؤهلة', 'eligible products', 'بەرهەمی گونجاو')
      : loc(ar || en, en || ar, ar || en);
  // A SECTION rule whose section no longer names itself cannot be stated
  // honestly: "10% off" with nothing after it reads as the whole catalogue.
  // A product rule never reaches this guard — it is not named in the first
  // place, so a deleted `products` row costs the shopper a live benefit
  // instead of silently withdrawing one the checkout still applies.
  if (rule.scope !== 'global' && !name) return null;

  let head: string;
  if (rule.discount_mode === 'percent') {
    const pct = rule.percent;
    if (pct === null || !(pct > 0)) return null;
    head =
      rule.scope === 'global'
        ? loc(`خصم ${pct}%`, `${pct}% off`, `داشکاندنی ${pct}%`)
        : loc(`خصم ${pct}% على ${name}`, `${pct}% off ${name}`, `داشکاندنی ${pct}% بۆ ${name}`);
  } else if (rule.discount_mode === 'fixed') {
    const fixed = rule.fixed_iqd;
    if (fixed === null || !(fixed > 0)) return null;
    const amount = money(fixed);
    head =
      rule.scope === 'global'
        ? loc(`خصم ${amount} لكل وحدة`, `${amount} off every unit`, `داشکاندنی ${amount} بۆ هەر یەکێک`)
        : loc(
            `خصم ${amount} لكل وحدة على ${name}`,
            `${amount} off every unit of ${name}`,
            `داشکاندنی ${amount} بۆ هەر یەکێک لە ${name}`
          );
  } else {
    return null;
  }

  // What narrows the rule is said beside it, because a benefit stated wider
  // than the rule is a refund conversation at the checkout.
  const limits: string[] = [];
  // A ceiling with no `cap_scope` is inert in `unitDiscountIqd` and in
  // `lineBenefit`, so it is not a limit and is not claimed as one.
  if (rule.max_discount_iqd !== null && rule.cap_scope) {
    const cap = money(rule.max_discount_iqd);
    limits.push(
      rule.cap_scope === 'per_unit'
        ? loc(`حتى ${cap} لكل وحدة`, `up to ${cap} per unit`, `زۆرترین داشکاندن ${cap} بۆ هەر یەکێک`)
        : // `cap_scope: 'per_order'` is NAMED for the order, but `lineBenefit`
          // applies the ceiling to ONE LINE and `resolveProductBenefits` then
          // sums the lines with no order-wide ceiling above them — a
          // two-product order really does get the ceiling twice. "لكل طلب"
          // would understate the benefit and be contradicted by the cart, so
          // the copy says what the customer actually gets. No Sorani exists
          // for a per-product ceiling, so it reads in Arabic there.
          loc(`حتى ${cap} لكل منتج`, `up to ${cap} per product`)
    );
  }
  if (rule.max_quantity !== null && rule.max_quantity > 0) {
    const n = rule.max_quantity;
    limits.push(loc(`لأول ${n} من الكمية`, `on the first ${n} of the quantity`, `بۆ هەر یەکێک لە ${n} یەکەکە`));
  }
  // `selectRule` tests this with `>=`, so it reads "or more" and never "above".
  if (rule.min_subtotal_iqd !== null && rule.min_subtotal_iqd > 0) {
    const min = money(rule.min_subtotal_iqd);
    limits.push(loc(`للطلبات من ${min} فأكثر`, `on orders of ${min} or more`));
  }
  return limits.length ? `${head} — ${limits.join(loc('، ', ', '))}` : head;
}

/** "توصيل مجاني للطلبات فوق 75,000 د.ع", and which methods it covers. */
function freeShippingLine(tier: 'prime' | 'pro', fs: BenefitFreeShipping, loc: Loc, money: Money): string | null {
  // `methods: null` covers every method. A list covers exactly what it names,
  // and an id this page cannot name is dropped rather than printed raw — a
  // machine value must never reach a customer's screen.
  const covered = fs.methods === null ? null : fs.methods.filter(isDeliveryMethodId);
  // A list that covers nothing is a rule switched off everywhere it could
  // apply, and there is no free delivery to promise.
  if (covered !== null && covered.length === 0) return null;

  const threshold = fs.threshold_iqd !== null ? money(fs.threshold_iqd) : null;
  const subsidy = fs.max_subsidy_iqd !== null ? money(fs.max_subsidy_iqd) : null;

  // §3: with a subsidy ceiling the member can still pay a difference, so the
  // delivery is never called free — it is called what it is. Each figure is
  // interpolated only inside the branch its own guard opened, so a missing
  // one takes the sentence written without it rather than leaving a gap.
  const head = subsidy
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

  const parts = [head];
  // Named only when the rule covers less than every method — a set test, not
  // a length test, so a row that repeats an id cannot read as full coverage.
  if (covered !== null && !DELIVERY_METHOD_IDS.every((id) => covered.includes(id))) {
    parts.push(`(${covered.map((m) => methodLabel(m, loc)).join(loc('، ', ', '))})`);
  }
  // CONFIRMED, and deliberately NOT a rule: a PRO delivery benefit exists at
  // the approved default address (packages/shipping/src/shipping.ts keeps
  // that condition whatever the rule says the benefit is worth).
  if (tier === 'pro') parts.push(loc('على العنوان المعتمد', 'at the approved address', 'لە ناونیشانی پەسەندکراو'));
  return parts.join(' ');
}

/**
 * HOW MANY DISTINCT PER-PRODUCT SENTENCES THE CARD WILL CARRY.
 *
 * Naming no product (see `discountLine`) already collapses a thousand
 * identically-configured overrides into one line. It does NOT bound an owner
 * who gives each product its own figure — «خصم 5,000 د.ع لكل وحدة»,
 * «خصم 7,500 د.ع لكل وحدة», … — and that is the same unreadable list again in
 * a different shape. Past this ceiling the card stops quoting the individual
 * overrides and says the figure-less thing instead, which is the pattern this
 * file already uses when it holds a benefit but not its number (the
 * «توصيل مجاني على الطلبات المؤهلة» branch in `freeShippingLine`). The
 * shopper loses nothing they could have acted on from here: a per-product
 * figure is only ever true of that one product, and that product's page
 * states it.
 */
const MAX_PRODUCT_DISCOUNT_LINES = 3;

/**
 * The tier's shopping benefits as the rules currently stand: the discounts,
 * then the delivery, then the cash-on-delivery tax. An unconfigured benefit
 * contributes nothing — there is no default sentence to fall back to.
 *
 * Exported so tests can hold it to the two promises above against real rule
 * rows: a figure only ever reaches the screen because a rule carries it, and
 * the length of this list is bounded by the number of distinct OFFERS the
 * owner configured, never by the size of the catalogue.
 */
export function shoppingLines(
  tier: 'prime' | 'pro',
  benefits: TierBenefits | null | undefined,
  loc: Loc,
  money: Money
): string[] {
  if (!benefits) return [];
  const out: string[] = [];
  // Rendered in the server's order first, so the per-product group can be
  // bounded as a group and then emitted exactly where the server put it —
  // `publicBenefitSummary` sorts most-specific first on purpose, and a
  // readability fix has no business quietly re-ranking the benefits.
  const rendered: { scope: BenefitDiscountRule['scope']; line: string }[] = [];
  for (const rule of benefits.discounts) {
    const line = discountLine(rule, loc, money);
    if (line) rendered.push({ scope: rule.scope, line });
  }
  const productLines = [...new Set(rendered.filter((r) => r.scope === 'product').map((r) => r.line))];
  const productGroup =
    productLines.length > MAX_PRODUCT_DISCOUNT_LINES
      ? [loc('خصومات العضوية على المنتجات المؤهلة', 'Membership discounts on eligible products', 'داشکاندنی ئەندامێتی بۆ بەرهەمی گونجاو')]
      : productLines;
  let productGroupEmitted = false;
  for (const entry of rendered) {
    if (entry.scope !== 'product') {
      out.push(entry.line);
      continue;
    }
    if (productGroupEmitted) continue;
    productGroupEmitted = true;
    out.push(...productGroup);
  }
  if (benefits.free_shipping) {
    const line = freeShippingLine(tier, benefits.free_shipping, loc, money);
    if (line) out.push(line);
  }
  // §4: the tax is calculated on every order and then waived, so this says
  // the exemption rather than pretending there is no tax. No Sorani exists
  // for the waiver, so it reads in Arabic there, as the cart's line does.
  if (benefits.cod_tax_exempt) {
    out.push(loc('إعفاء من ضريبة الدفع عند الاستلام', 'Exempt from the cash-on-delivery tax'));
  }
  // Two rules can phrase themselves identically; the list keys on the line.
  return [...new Set(out)];
}

/* -------------------------------------------------------------- the cards */

interface BenefitCardProps {
  tier: PaidTier;
  title: string;
  subtitle: string;
  inheritance?: string;
  lines: string[];
  inheritedLines?: string[];
  inheritedLabel?: string;
  note?: ReactNode;
  loading: boolean;
}

function BenefitList({ tier, lines, compact = false }: { tier: PaidTier; lines: string[]; compact?: boolean }) {
  const meta = TIER_META[tier];
  return (
    <ul className={compact ? 'space-y-2' : 'space-y-2.5'}>
      {lines.map((line) => (
        <li key={line} className={`flex items-start gap-2.5 ${compact ? 'text-[12px]' : 'text-[13px]'} leading-relaxed text-zinc-300`}>
          <Check className={`mt-0.5 h-4 w-4 shrink-0 ${meta.check}`} strokeWidth={2.6} aria-hidden="true" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function BenefitCard({ tier, title, subtitle, inheritance, lines, inheritedLines, inheritedLabel, note, loading }: BenefitCardProps) {
  const meta = TIER_META[tier];
  return (
    <article data-benefits={tier} className={`relative self-start overflow-hidden rounded-[22px] border ${meta.panelBorder} bg-zinc-900/35 p-4 shadow-lg sm:p-5`}>
      <div className="pointer-events-none absolute end-0 top-0 h-24 w-24 rounded-es-[100px] opacity-70 blur-xl mix-blend-screen" style={{ background: `${meta.hex}22` }} aria-hidden="true" />
      <div className="relative z-10 mb-3 flex items-start gap-3">
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${meta.panelBorder} bg-black/35`}>
          <meta.Icon className={`h-[18px] w-[18px] ${meta.heading}`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h4 className={`text-[15px] font-black ${meta.heading}`}>{title}</h4>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">{subtitle}</p>
        </div>
      </div>

      {inheritance && !loading && (
        <p className={`relative z-10 mb-3 rounded-xl border px-3 py-2 text-[11.5px] font-bold ${meta.chip}`} data-membership-inheritance={tier}>
          {inheritance}
        </p>
      )}

      {loading ? (
        <ul className="relative z-10 space-y-2.5" role="status" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <li key={i} className="h-3.5 animate-pulse rounded bg-zinc-800/60 motion-reduce:animate-none" />)}
        </ul>
      ) : (
        <div className="relative z-10">
          <BenefitList tier={tier} lines={lines} />
          {!!inheritedLines?.length && (
            <details className="group mt-3 rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2">
              <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11.5px] font-semibold text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 [&::-webkit-details-marker]:hidden">
                <span>{inheritedLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="border-t border-white/[0.06] pt-2.5">
                <BenefitList tier={tier} lines={inheritedLines} compact />
              </div>
            </details>
          )}
          {note && <div className="mt-3 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-zinc-500">{note}</div>}
        </div>
      )}
    </article>
  );
}

export function BenefitsSection({ features, benefits, loading }: BenefitsSectionProps) {
  const { t, loc } = useLanguage();
  const { money } = useMoney();

  // The configured half of each paid tier's list. `prime` is the API id;
  // PREMIUM is the name on every customer-facing surface (tierMeta).
  const premiumShopping = shoppingLines('prime', benefits?.prime, loc, money);
  const proShopping = shoppingLines('pro', benefits?.pro, loc, money);

  const plusLines = [
    loc('متجر شخصي على username.levonis-iq.com', 'Personal storefront at username.levonis-iq.com', 'فرۆشگای تایبەتی لە username.levonis-iq.com'),
    loc('لوحة تاجر كاملة: المنتجات والطلبات والرسائل والتحليلات', 'Full merchant dashboard: products, orders, messages and analytics', 'داشبۆردی تەواوی بازرگان: بەرهەم، داواکاری، نامە و شیکاری'),
    loc('استقبال طلبات العملاء ومدفوعاتهم عبر ليفونيس', 'Receive customer orders and payments through Levonis', 'وەرگرتنی داواکاری و پارەدانی کڕیار لە ڕێگەی Levonis'),
    loc('تقديم عروض احترافية على طلبات المجتمع', 'Professional merchant offers on Community requests', 'پێشکەشکردنی ئۆفەری پیشەیی لە داواکارییەکانی کۆمەڵگە'),
    loc('الوصول إلى البندلات وأدواتها المؤهلة', 'Access to Bundles and eligible bundle tools', 'دەستگەیشتن بە پاکێج و ئامرازە گونجاوەکانی'),
    loc('عروض وكوبونات PLUS عند توفيرها', 'PLUS offers and coupons when provided', 'ئۆفەر و کۆپۆنی PLUS کاتێک بەردەست بن'),
  ];

  // PREMIUM's own lines that are NOT shopping benefits. They are what a PRO
  // member genuinely inherits; the configured shopping numbers below are not,
  // because a PRO member is priced by PRO's rules and never by PREMIUM's.
  const premiumHeadLines = [
    // `prime` is the API id; PREMIUM is the name on every customer-facing
    // surface (TIER_META.prime.label). This line was the last place left in
    // the app that still showed a customer the word PRIME.
    loc('أسعار PREMIUM على المنتجات المؤهلة وخصومات أفضل من PLUS عند ضبطها', 'PREMIUM pricing on eligible products and better configured discounts than PLUS', 'نرخی PREMIUM بۆ بەرهەمی گونجاو و داشکاندنی باشتر لە PLUS'),
    loc('عروض وكوبونات حصرية للعضوية', 'Membership-exclusive offers and PREMIUM coupons', 'ئۆفەر و کۆپۆنی تایبەت بە PREMIUM'),
  ];
  const premiumTailLines = [
    loc('عروض بندلات خاصة بـ PREMIUM', 'PREMIUM-specific bundle offers', 'ئۆفەری پاکێجی تایبەت بە PREMIUM'),
    loc('نقاط تسجيل الدخول اليومية أعلى من PLUS (×1.5)', 'Higher daily login rewards than PLUS (1.5×)', 'خاڵی ڕۆژانەی زیاتر لە PLUS (×1.5)'),
  ];

  const premiumLines = [
    ...premiumHeadLines,
    ...premiumShopping,
    ...premiumTailLines,
  ];

  const proLines = [
    loc('أفضل أسعار وخصومات وعروض وكوبونات PRO المؤهلة', 'Best eligible PRO prices, discounts, offers and coupons', 'باشترین نرخ و داشکاندن و ئۆفەر و کۆپۆنی PRO'),
    ...proShopping,
    loc('أولوية تجهيز وتوصيل خلال 12 ساعة حيث تتوفر الخدمة', 'Priority preparation and delivery within 12 hours where available', 'پێشینەیی ئامادەکردن و گەیاندن لە ١٢ کاتژمێردا لە شوێنی بەردەست'),
    loc('أعلى أولوية للدعم وطلبات الضمان', 'Highest support and warranty-request priority', 'بەرزترین پێشینەیی پشتیوانی و داواکاری گەرەنتی'),
    loc('مضاعفة نقاط تسجيل الدخول اليومية (×2)', 'Double daily login reward points (2×)', 'دووقاتکردنی خاڵی چوونەژوورەوەی ڕۆژانە (×2)'),
    loc('مكافأة إحالة عند شراء المدعو عضوية PRO مؤهلة', 'Referral reward when an invited user buys an eligible PRO membership', 'خەڵاتی بانگهێشت کاتێک بانگهێشتکراوێک PRO ی گونجاو دەکڕێت'),
    loc('بندلات وعروض PRO حصرية ومعاملة تاجر مميزة', 'PRO-exclusive bundles and premium merchant/community treatment', 'پاکێجی تایبەتی PRO و مامەڵەی بازرگانی تایبەت'),
    loc('شارة تاجر PRO مميزة في المجتمع وملف المتجر', 'Distinctive PRO merchant badge in Community and the store profile', 'نیشانەی تایبەتی بازرگانی PRO لە کۆمەڵگە و پڕۆفایلی فرۆشگا'),
    loc('اشترِ الآن وادفع لاحقًا (BNPL) — حصريًا لـ PRO المؤهل', 'Buy Now, Pay Later (BNPL) — exclusively for eligible PRO members', 'ئێستا بکڕە و دواتر بدە (BNPL) — تەنها بۆ PRO ی گونجاو'),
  ];

  if (features?.preorder_gift) {
    proLines.push(loc('بكرة فلمنت هدية مع الطلب المسبق المدفوع بالكامل', 'A filament-spool gift with a fully prepaid pre-order', 'دیاریی لوولەی فیلامێنت لەگەڵ پێش-داواکاری تەواو پێشپارەدراو'));
  }

  const plusNote = features?.printer_gift ? (
    <p>{loc('يمكن منح PLUS هديةً مع شراء طابعة مؤهلة وفق إعداد المتجر.', 'PLUS may be gifted with an eligible printer purchase under the store setting.', 'PLUS دەتوانرێت وەک دیاری لەگەڵ کڕینی پرینتەری گونجاو بدرێت.')}</p>
  ) : undefined;

  // Which methods the waiver covers is now stated by the line above, from the
  // rule — so the note keeps only what the rule does NOT say: the figure the
  // threshold is tested against (§3). It appears only when a threshold was
  // actually stated: a PREMIUM configured with a discount or a tax exemption
  // and no free-delivery rule has no bar for this sentence to describe.
  const premiumNote = statesADeliveryThreshold(benefits?.prime) ? (
    <p className="flex items-start gap-2">
      <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{loc('يُحتسب الحد بعد الخصومات والكوبونات والنقاط.', 'The threshold is evaluated after discounts, coupons and points.', 'دوای داشکاندن و کۆپۆن و خاڵ هەژمار دەکرێت.')}</span>
    </p>
  ) : undefined;

  const proNote = (
    <div className="space-y-1.5">
      <p>{loc('خدمة 12 ساعة تُثبّت على الطلب فقط عند توفر التوصيل الشخصي ونوع الشحن والمنطقة والعنوان المعتمد.', 'The 12-hour service is stamped on an order only when its personal-delivery method, shipping type, service area and approved address qualify.', 'خزمەتی ١٢ کاتژمێر تەنها کاتێک لەسەر داواکاری تۆمار دەکرێت کە ڕێگا و ناوچە و ناونیشان گونجاو بن.')}</p>
      <p>{loc('يتطلب BNPL حسابًا معتمدًا وهوية مستوفية وعنوانًا معتمدًا، ويخضع للحد الائتماني وسجل السداد.', 'BNPL also requires an approved account, eligible verified identity and approved address, and enforces the credit limit and repayment ledger.', 'BNPL هەژماری پەسەندکراو و ناسنامە و ناونیشانی پەسەندکراو و سنووری قەرز و تۆماری گەڕاندنەوە دەوێت.')}</p>
    </div>
  );

  return (
    <section aria-labelledby="benefits-title" className="relative z-10">
      <h3 id="benefits-title" className="mb-4 flex items-center justify-center gap-2 px-1 text-[16px] font-bold text-white">
        {t('planComparisons')} <Info className="h-4 w-4 text-zinc-500" aria-hidden="true" />
      </h3>
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        <BenefitCard tier="plus" title={t('plusBenefits')} subtitle={loc('العضوية الأساسية للتاجر والمجتمع', 'Base merchant and Community membership', 'ئەندامێتی بنەڕەتی بازرگان و کۆمەڵگە')} lines={plusLines} note={plusNote} loading={loading} />
        <BenefitCard tier="prime" title={t('primeBenefits')} subtitle={loc('تسوق وعضوية بمزايا محسّنة', 'Enhanced shopping and member benefits', 'کڕین و ئەندامێتی بە سوودی باشتر')} inheritance={loc('يشمل جميع مزايا PLUS', 'Includes all PLUS benefits', 'هەموو سوودەکانی PLUS دەگرێتەوە')} lines={premiumLines} inheritedLines={plusLines} inheritedLabel={loc('عرض مزايا PLUS الموروثة', 'View inherited PLUS benefits', 'بینینی سوودە میراتکراوەکانی PLUS')} note={premiumNote} loading={loading} />
        <BenefitCard tier="pro" title={t('proBenefits')} subtitle={loc('أعلى مستوى من المزايا الحصرية', 'Highest-level exclusive benefits', 'بەرزترین ئاستی سوودە تایبەتەکان')} inheritance={loc('يشمل جميع مزايا PLUS وPREMIUM', 'Includes all PLUS and PREMIUM benefits', 'هەموو سوودەکانی PLUS و PREMIUM دەگرێتەوە')} lines={proLines} inheritedLines={[...plusLines, ...premiumHeadLines, ...premiumTailLines]} inheritedLabel={loc('عرض جميع المزايا الموروثة', 'View all inherited benefits', 'بینینی هەموو سوودە میراتکراوەکان')} note={proNote} loading={loading} />
      </div>
    </section>
  );
}

export default BenefitsSection;
