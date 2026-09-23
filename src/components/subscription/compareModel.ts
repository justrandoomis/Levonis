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
import { ENTITLEMENT_LABELS } from './tierMeta';
import type { PlanFeatures } from './types';
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
  loc: Loc;
  money: Money;
}

const YES: CompareCell = { kind: 'yes' };
const NO: CompareCell = { kind: 'no' };

/** Whether every tier shown has the same cell — what "differences only" hides. */
export function rowIsUniform(row: CompareRow, tiers: PaidTier[]): boolean {
  const sig = (c: CompareCell) => (c.kind === 'text' ? `t:${c.lines.join('|')}` : c.kind);
  return new Set(tiers.map((t) => sig(row.cells[t]))).size <= 1;
}

export function buildCompare({ tiers, contract, benefits, features, points, loc, money }: CompareInput): CompareModel {
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
  for (const key of ['merchantStore', 'merchantSubdomain', 'merchantAnalytics', 'communityOffers', 'proMerchantBadge']) {
    const row = tick(key);
    if (row) store.push(row);
  }

  // ------------------------------------------------- service and rewards
  const service: CompareRow[] = [];
  const priority = tick('priorityService');
  if (priority) service.push(priority);
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
  if (points && tiers.every((t) => typeof points[t] === 'number')) {
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
    { key: 'store', label: loc('المتجر والتجارة', 'Your store', 'فرۆشگا و بازرگانی'), rows: store },
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
  input: Pick<CompareInput, 'contract' | 'benefits' | 'points' | 'loc' | 'money'>
): string[] {
  const { contract, benefits, points, loc, money } = input;
  const has = (key: string) => contract?.[tier]?.[key] === true;
  const out: string[] = [];
  if (tier === 'plus') {
    if (has('merchantStore')) {
      out.push(loc('متجر شخصي على username.levonis-iq.com', 'Personal storefront at username.levonis-iq.com', 'فرۆشگای تایبەتی لە username.levonis-iq.com'));
    }
    if (has('communityOffers')) {
      out.push(loc('تقديم عروض احترافية على طلبات المجتمع', 'Professional merchant offers on Community requests', 'پێشکەشکردنی ئۆفەری پیشەیی لە داواکارییەکانی کۆمەڵگە'));
    }
    if (has('exclusiveSections')) {
      out.push(loc('الوصول إلى البندلات وأدواتها المؤهلة', 'Access to Bundles and eligible bundle tools', 'دەستگەیشتن بە پاکێج و ئامرازە گونجاوەکانی'));
    }
    return out.slice(0, 3);
  }
  const b = benefits?.[tier] ?? null;
  const first = discountSections(b, loc)[0];
  if (first) out.push(...sectionLines(first, loc, money).slice(0, 1));
  if (b?.free_shipping) {
    const line = freeShippingLine(tier, b.free_shipping, loc, money);
    if (line) out.push(line);
  }
  if (tier === 'pro' && has('bnpl')) {
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
  return out.slice(0, 3);
}
