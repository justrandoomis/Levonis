/**
 * «مقارنة الخطط» AS DATA — a pure model the matrix draws and the tests read.
 *
 * Every tick comes from `entitlement_contract.tiers` (the server resolving
 * ENTITLEMENT_MINIMUM_TIER for each tier), every figure from `benefits`
 * (the rules the checkout applies) or `points_multiplier_x100` (the function
 * the check-in calls). Nothing here decides who gets what: it only arranges
 * what the server already said. So a benefit inherited by a higher tier is a
 * tick in that column by construction, and the old «يشمل جميع مزايا PLUS»
 * lists had nothing left to explain.
 */
import type { PaidTier } from './tierMeta';
import { ENTITLEMENT_LABELS, FILAMENT_LIMITS_PER_30_DAYS } from './tierMeta';
import type { FilamentLimits, PlanFeatures, ProExtras } from './types';
import {
  codTaxLine,
  discountSections,
  freeShippingLine,
  sectionLines,
  statesADeliveryThreshold,
  type Loc,
  type Money,
  type PlanBenefits,
} from './benefitLines';

export type CompareCell = { kind: 'yes' } | { kind: 'no' } | { kind: 'text'; lines: string[] };

export interface CompareRow {
  key: string;
  label: string;
  cells: Record<PaidTier, CompareCell>;
  /** The footnote this row's condition is explained in, 1-based. */
  note?: number;
}

export interface CompareGroup {
  key: string;
  label: string;
  rows: CompareRow[];
}

export interface CompareModel {
  groups: CompareGroup[];
  notes: string[];
}

export interface CompareInput {
  tiers: PaidTier[];
  contract: Partial<Record<PaidTier, Record<string, boolean>>> | null;
  benefits: PlanBenefits | null;
  features: PlanFeatures | null;
  points: Partial<Record<PaidTier, number>> | null;
  /** PRO's services discount and return windows from GET /plans (null while paused or on an older server). */
  proExtras?: ProExtras | null;
  /** The filament limits the checkout enforces (GET /plans); absent = the launch figures. */
  filamentLimits?: FilamentLimits | null;
  loc: Loc;
  money: Money;
}

/** The limits to state: the server's, else the launch figures; null when the limit is switched off. */
function filamentTable(limits: FilamentLimits | null | undefined): { days: number; free: number | null; byTier: Record<PaidTier, number | null> } | null {
  if (limits && !limits.enabled) return null;
  if (limits) return { days: limits.window_days, free: limits.per_tier.none, byTier: { plus: limits.per_tier.plus, prime: limits.per_tier.prime, pro: limits.per_tier.pro } };
  const f = FILAMENT_LIMITS_PER_30_DAYS;
  return { days: 30, free: f.free, byTier: { plus: f.plus, prime: f.prime, pro: f.pro } };
}

/** «حتى 100 بكرة» / «بلا حد» — one tier's filament limit. */
export function filamentLimitLine(limit: number | null, loc: Loc): string {
  if (limit === null) return loc('بلا حد', 'Unlimited', 'بێ سنوور');
  return loc(`حتى ${limit} بكرة`, `Up to ${limit} spools`, `تا ${limit} لوولە`);
}

/** The PRO services discount line, with the server's percent. */
export function servicesDiscountLine(pct: number, loc: Loc): string {
  return loc(
    `خصم ${pct}% على الضمان وليفو كير والتغليف الإضافي والتوصيل الشخصي وخدمات الطابعات`,
    `${pct}% off the warranty, Levo Care, extra packaging, Personal delivery and printer services`,
    `${pct}% داشکاندن بۆ گەرەنتی، لیڤۆ کێر، پێچانەوەی زیادە، گەیاندنی تایبەت و خزمەتگوزارییەکانی چاپکەر`
  );
}

/** The PRO return line, with the server's window. */
export function freeReturnLine(days: number, loc: Loc): string {
  return loc(
    `إرجاع خلال ${days} يومًا بلا أجرة شحن ولا رسوم`,
    `${days}-day returns with no return delivery or restocking fee`,
    `گەڕاندنەوە لە ماوەی ${days} ڕۆژدا بێ کرێی گەیاندن و بێ کرێی تر`
  );
}

const YES: CompareCell = { kind: 'yes' };
const NO: CompareCell = { kind: 'no' };

/** Whether every tier shown has the same cell — what "differences only" hides. */
export function rowIsUniform(row: CompareRow, tiers: PaidTier[]): boolean {
  const sig = (c: CompareCell) => (c.kind === 'text' ? `t:${c.lines.join('|')}` : c.kind);
  return new Set(tiers.map((t) => sig(row.cells[t]))).size <= 1;
}

export function buildCompare({ tiers, contract, benefits, features, points, proExtras, filamentLimits, loc, money }: CompareInput): CompareModel {
  const notes: string[] = [];
  const note = (text: string): number => {
    const at = notes.indexOf(text);
    if (at >= 0) return at + 1;
    notes.push(text);
    return notes.length;
  };
  const label = (key: string) => {
    const l = ENTITLEMENT_LABELS[key];
    return l ? loc(l.ar, l.en, l.ckb) : key;
  };
  const has = (tier: PaidTier, key: string) => contract?.[tier]?.[key] === true;
  const tick = (key: string, extra: Partial<CompareRow> = {}): CompareRow | null => {
    if (!contract) return null;
    const cells = Object.fromEntries(tiers.map((t) => [t, has(t, key) ? YES : NO])) as Record<PaidTier, CompareCell>;
    if (tiers.every((t) => cells[t].kind === 'no')) return null;
    return { key, label: label(key), cells, ...extra };
  };
  const paidBenefits = (tier: PaidTier) => (tier === 'prime' || tier === 'pro' ? benefits?.[tier] ?? null : null);
  const proAddress = () =>
    note(
      loc(
        'أسعار PRO والتوصيل المجاني وإعفاء رسوم الشحن تُطبَّق على عنوانك الافتراضي المعتمد.',
        'PRO prices, free delivery and the shipping surcharge waiver apply at your approved default address.',
        'PRO — لە ناونیشانی پەسەندکراو'
      )
    );

  // ------------------------------------------------------------- shopping
  const shopping: CompareRow[] = [];
  const sections = new Map<string, { label: string; byTier: Partial<Record<PaidTier, string[]>> }>();
  for (const tier of tiers) {
    for (const section of discountSections(paidBenefits(tier), loc)) {
      const entry = sections.get(section.key) ?? { label: section.name, byTier: {} };
      entry.byTier[tier] = sectionLines(section, loc, money, true);
      sections.set(section.key, entry);
    }
  }
  for (const [key, s] of sections) {
    const cells = Object.fromEntries(
      tiers.map((t) => [t, s.byTier[t]?.length ? ({ kind: 'text', lines: s.byTier[t]! } as CompareCell) : NO])
    ) as Record<PaidTier, CompareCell>;
    shopping.push({
      key: `discount:${key}`,
      label: loc(`خصم على ${s.label}`, `Discount on ${s.label}`, `داشکاندن بۆ ${s.label}`),
      cells,
      ...(tiers.includes('pro') && s.byTier.pro?.length ? { note: proAddress() } : {}),
    });
  }
  for (const key of ['exclusiveSections', 'exclusiveCoupons', 'memberOffers']) {
    const row = tick(key);
    if (row) shopping.push(row);
  }
  // PRO, RETURNED (owner, 2026-11-19): the services discount — the tick from
  // the contract, the percent from the server's price list.
  const services = tick('proServicesDiscount');
  if (services) {
    const pct = proExtras?.services_discount_pct ?? null;
    shopping.push({
      ...services,
      cells: Object.fromEntries(
        tiers.map((t) => [t, has(t, 'proServicesDiscount') ? (pct !== null && pct > 0 ? ({ kind: 'text', lines: [`${pct}%`] } as CompareCell) : YES) : NO])
      ) as Record<PaidTier, CompareCell>,
      note: note(
        loc(
          'يشمل الضمان الممتد وليفو كير والتغليف الإضافي والفحص قبل الشحن والأكاديمية والتوصيل الشخصي للطابعة، على عنوانك الافتراضي المعتمد.',
          'Covers the extended warranty, Levo Care, extra packaging, the pre-dispatch inspection, the academy and the printer’s Personal delivery, at your approved default address.',
          'گەرەنتی درێژکراوە، لیڤۆ کێر، پێچانەوەی زیادە، پشکنین پێش ناردن، ئەکادیمیا و گەیاندنی تایبەتی چاپکەر دەگرێتەوە، لە ناونیشانی بنەڕەتیی پەسەندکراوت.'
        )
      ),
    });
  }
  // Filament: pieces of one product per window, per tier (owner, 2026-11-19).
  const filament = filamentTable(filamentLimits);
  if (filament && tiers.length > 0) {
    const { days, free } = filament;
    shopping.push({
      key: 'filament_limit',
      label: loc(`كمية الفلمنت من المنتج نفسه كل ${days} يومًا`, `Filament of one product per ${days} days`, `فیلامێنتی هەمان بەرهەم لە هەر ${days} ڕۆژێکدا`),
      cells: Object.fromEntries(
        tiers.map((t) => [t, { kind: 'text', lines: [filamentLimitLine(filament.byTier[t], loc)] } as CompareCell])
      ) as Record<PaidTier, CompareCell>,
      note: note(
        free === null
          ? loc('بلا اشتراك: بلا حد.', 'Without a membership: unlimited.', 'بێ بەشداریکردن: بێ سنوور.')
          : loc(
              `بلا اشتراك: حتى ${free} بكرة من المنتج نفسه كل ${days} يومًا.`,
              `Without a membership: up to ${free} spools of one product per ${days} days.`,
              `بێ بەشداریکردن: تا ${free} لوولە لە هەمان بەرهەم لە هەر ${days} ڕۆژێکدا.`
            )
      ),
    });
  }

  // ------------------------------------------------- delivery and payment
  const delivery: CompareRow[] = [];
  const shippingCells = Object.fromEntries(
    tiers.map((t) => {
      const fs = paidBenefits(t)?.free_shipping;
      const line = fs && (t === 'prime' || t === 'pro') ? freeShippingLine(t, fs, loc, money, true) : null;
      return [t, line ? ({ kind: 'text', lines: [line] } as CompareCell) : NO];
    })
  ) as Record<PaidTier, CompareCell>;
  if (tiers.some((t) => shippingCells[t].kind !== 'no')) {
    const thresholdNote = tiers.some((t) => (t === 'prime' || t === 'pro') && statesADeliveryThreshold(paidBenefits(t)))
      ? note(
          loc(
            'يُحتسب حد التوصيل المجاني على قيمة المنتجات بعد الخصومات والكوبونات، ولـ PREMIUM بعد النقاط أيضًا، ويجب أن يتجاوزه الطلب.',
            'The free-delivery threshold is measured on the goods after discounts and coupons (for PREMIUM, after points too), and the order must exceed it.'
          )
        )
      : undefined;
    delivery.push({
      key: 'free_shipping',
      label: loc('التوصيل المجاني', 'Free delivery', 'گەیاندنی بێبەرامبەر'),
      cells: shippingCells,
      ...(thresholdNote ? { note: thresholdNote } : {}),
    });
  }
  const surcharge = tick('noPreorderCommission');
  if (surcharge) delivery.push({ ...surcharge, note: proAddress() });
  const codCells = Object.fromEntries(
    tiers.map((t) => [t, paidBenefits(t)?.cod_tax_exempt ? YES : NO])
  ) as Record<PaidTier, CompareCell>;
  if (tiers.some((t) => codCells[t].kind === 'yes')) {
    delivery.push({ key: 'cod_tax', label: codTaxLine(loc), cells: codCells });
  }
  const bnpl = tick('bnpl');
  if (bnpl) {
    delivery.push({
      ...bnpl,
      note: note(
        loc(
          'يتطلب BNPL حسابًا معتمدًا وهوية مستوفية وعنوانًا معتمدًا، ويخضع للحد الائتماني وسجل السداد.',
          'BNPL also requires an approved account, eligible verified identity and approved address, and enforces the credit limit and repayment ledger.',
          'BNPL هەژماری پەسەندکراو و ناسنامە و ناونیشانی پەسەندکراو و سنووری قەرز و تۆماری گەڕاندنەوە دەوێت.'
        )
      ),
    });
  }

  // --------------------------------------------------------------- store
  const store: CompareRow[] = [];
  for (const key of ['merchantStore', 'merchantSubdomain', 'merchantAnalytics', 'communityOffers', 'premiumBadge', 'proMerchantBadge']) {
    const row = tick(key);
    if (row) store.push(row);
  }

  // ------------------------------------------------- service and rewards
  const service: CompareRow[] = [];
  const priority = tick('priorityService');
  if (priority) service.push(priority);
  // Returns (owner, 2026-11-19): every column states its window; PRO's is
  // longer and fee-free. The tick decides who holds it, the days are the server's.
  if (tick('proFreeReturn14')) {
    const days = proExtras?.return_window_days ?? { default: 7, pro: 14 };
    service.push({
      key: 'proFreeReturn14',
      label: loc('مدة الإرجاع', 'Return window', 'ماوەی گەڕاندنەوە'),
      cells: Object.fromEntries(
        tiers.map((t) => [
          t,
          {
            kind: 'text',
            lines: has(t, 'proFreeReturn14')
              ? [loc(`${days.pro} يومًا`, `${days.pro} days`, `${days.pro} ڕۆژ`), loc('بلا أجرة إرجاع ولا رسوم', 'No return fees', 'بێ کرێی گەڕاندنەوە')]
              : [loc(`${days.default} أيام`, `${days.default} days`, `${days.default} ڕۆژ`)],
          } as CompareCell,
        ])
      ) as Record<PaidTier, CompareCell>,
      note: note(
        loc(
          'تُحتسب من تاريخ الاستلام، بحسب الاشتراك وقت الشراء، ويجب أن يكون المنتج بحالة قابلة للإرجاع.',
          'Counted from delivery, by the membership held at purchase; the item must be in returnable condition.',
          'لە بەرواری وەرگرتنەوە دەژمێردرێت، بەپێی بەشداریکردن لە کاتی کڕین؛ کاڵاکە دەبێت لە دۆخێکی گەڕاندنەوەپێکراودا بێت.'
        )
      ),
    });
  }
  const twelve = tick('priorityDelivery12h');
  if (twelve) {
    service.push({
      ...twelve,
      note: note(
        loc(
          'خدمة 12 ساعة تُثبّت على الطلب فقط عند توفر التوصيل الشخصي ونوع الشحن والمنطقة والعنوان المعتمد.',
          'The 12-hour service is stamped on an order only when its personal-delivery method, shipping type, service area and approved address qualify.',
          'خزمەتی ١٢ کاتژمێر تەنها کاتێک لەسەر داواکاری تۆمار دەکرێت کە ڕێگا و ناوچە و ناونیشان گونجاو بن.'
        )
      ),
    });
  }
  // Only a multiplier worth stating: a row of «×1» in every column says nothing.
  if (points && tiers.every((t) => typeof points[t] === 'number') && tiers.some((t) => (points[t] as number) > 100)) {
    const cells = Object.fromEntries(
      tiers.map((t) => [t, { kind: 'text', lines: [`×${(points[t] as number) / 100}`] } as CompareCell])
    ) as Record<PaidTier, CompareCell>;
    service.push({ key: 'points', label: loc('نقاط الدخول اليومية', 'Daily check-in points', 'خاڵی ڕۆژانە'), cells });
  }
  if (features?.preorder_gift && tiers.includes('pro')) {
    const cells = Object.fromEntries(tiers.map((t) => [t, t === 'pro' ? YES : NO])) as Record<PaidTier, CompareCell>;
    service.push({
      key: 'preorder_gift',
      label: loc('بكرة فلمنت هدية مع الطلب المسبق المدفوع بالكامل', 'A filament-spool gift with a fully prepaid pre-order', 'دیاریی لوولەی فیلامێنت لەگەڵ پێش-داواکاری تەواو پێشپارەدراو'),
      cells,
      note: proAddress(),
    });
  }

  const groups: CompareGroup[] = [
    { key: 'shopping', label: loc('التسوق والخصومات', 'Shopping and discounts', 'کڕین و داشکاندن'), rows: shopping },
    { key: 'delivery', label: loc('التوصيل والدفع', 'Delivery and payment', 'گەیاندن و پارەدان'), rows: delivery },
    { key: 'store', label: loc('المتجر والمجتمع', 'Your store and the community', 'فرۆشگا و کۆمەڵگە'), rows: store },
    { key: 'service', label: loc('الخدمة والمكافآت', 'Service and rewards', 'خزمەتگوزاری و خەڵات'), rows: service },
  ].filter((g) => g.rows.length > 0);

  return { groups, notes };
}

/**
 * THREE THINGS A CARD IS FOR, said on the card itself. The first
 * configured discount and the delivery line where the tier has them — the
 * figures are the rules' own — then what the card is chiefly for. Nothing
 * here is a figure the server did not send.
 */
export function tierHighlights(
  tier: PaidTier,
  input: Pick<CompareInput, 'contract' | 'benefits' | 'points' | 'loc' | 'money' | 'proExtras' | 'filamentLimits'>
): string[] {
  const { contract, benefits, points, proExtras, filamentLimits, loc, money } = input;
  const has = (key: string) => contract?.[tier]?.[key] === true;
  const out: string[] = [];
  if (tier === 'plus') {
    if (has('merchantStore')) {
      out.push(loc('متجر شخصي على username.levonis-iq.com', 'Personal storefront at username.levonis-iq.com', 'فرۆشگای تایبەتی لە username.levonis-iq.com'));
    }
    if (has('communityOffers')) {
      out.push(loc('تقديم عروض احترافية على طلبات المجتمع', 'Professional merchant offers on Community requests', 'پێشکەشکردنی ئۆفەری پیشەیی لە داواکارییەکانی کۆمەڵگە'));
    }
    // Bundles and mystery boxes are open to everyone (DECISIONS row 251): what the benefit still opens is an
    // offer the owner gates to members on purpose (`offerEligible`, worker/lib/offers.ts).
    if (has('exclusiveSections')) {
      out.push(loc('عروض حصرية للأعضاء', 'Members-only offers', 'ئۆفەری تایبەت بە ئەندامان'));
    }
    return out.slice(0, 3);
  }
  // PRO, RETURNED (owner, 2026-11-19): what the card is chiefly for now comes
  // first — the services discount, the 14-day fee-free return and unlimited
  // filament — each only where the contract grants it.
  // BNPL stays among them; the product discounts and free delivery are in the comparison below the card.
  if (tier === 'pro') {
    const pct = proExtras?.services_discount_pct ?? null;
    if (has('proServicesDiscount') && pct !== null && pct > 0) out.push(servicesDiscountLine(pct, loc));
    if (has('proFreeReturn14')) out.push(freeReturnLine(proExtras?.return_window_days.pro ?? 14, loc));
    const filament = filamentTable(filamentLimits);
    if (filament && filament.byTier.pro === null && filament.free !== null) {
      out.push(loc('شراء الفلمنت بلا حد للكمية', 'Unlimited filament quantity', 'کڕینی فیلامێنت بێ سنووری بڕ'));
    }
    if (has('bnpl')) {
      out.push(loc('اشترِ الآن وادفع لاحقًا (BNPL) — حصريًا لـ PRO المؤهل', 'Buy Now, Pay Later (BNPL) — exclusively for eligible PRO members', 'ئێستا بکڕە و دواتر بدە (BNPL) — تەنها بۆ PRO ی گونجاو'));
    }
    if (out.length >= 3) return out.slice(0, 4);
  }
  const b = benefits?.[tier] ?? null;
  const first = discountSections(b, loc)[0];
  if (first) out.push(...sectionLines(first, loc, money).slice(0, 1));
  if (b?.free_shipping) {
    const line = freeShippingLine(tier, b.free_shipping, loc, money);
    if (line) out.push(line);
  }
  // PREMIUM's own mark in the community (0145) — its second and last extra.
  if (tier === 'prime' && has('premiumBadge')) {
    out.push(loc('شارة PREMIUM مميزة في مجتمع ليفو', 'A distinctive PREMIUM badge in the Levo community', 'نیشانەیەکی تایبەتی PREMIUM لە کۆمەڵگەی لیڤۆ'));
  }
  if (tier === 'pro' && has('bnpl') && !out.some((l) => l.includes('BNPL'))) {
    out.push(loc('اشترِ الآن وادفع لاحقًا (BNPL) — حصريًا لـ PRO المؤهل', 'Buy Now, Pay Later (BNPL) — exclusively for eligible PRO members', 'ئێستا بکڕە و دواتر بدە (BNPL) — تەنها بۆ PRO ی گونجاو'));
  }
  const x = points?.[tier];
  if (typeof x === 'number' && x > 100) {
    out.push(loc(`نقاط الدخول اليومية ×${x / 100}`, `Daily check-in points ×${x / 100}`, `خاڵی ڕۆژانە ×${x / 100}`));
  }
  // Not «وPREMIUM» for PRO: a PREMIUM discount or delivery rule applies to
  // PREMIUM members only (`selectRule` matches the tier exactly), so the PRO
  // card must not promise one the checkout will not give.
  out.push(loc('يشمل جميع مزايا PLUS', 'Includes all PLUS benefits', 'هەموو سوودەکانی PLUS دەگرێتەوە'));
  // PRO carries the three new lines and its own discount: four, the rest in the comparison.
  return out.slice(0, tier === 'pro' ? 4 : 3);
}
