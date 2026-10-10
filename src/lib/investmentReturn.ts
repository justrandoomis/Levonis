/**
 * THE INVESTMENT REMAINDER, ON SCREEN (owner request 2026-10-10: «فان الباقي …
 * تضاف وترجع لمحفظة المستثمر ( نفسها محفظة الارباح للموظف ) عند تاكيد الشحنه»).
 *
 * The server decides the money (worker/lib/investorSurplus.ts): the remainder
 * is agreed − allocated, fixed at the confirm, and it becomes withdrawable
 * returned capital in the investor's «أرباحي» out of the cash actually
 * received. This module only words it, and gives the purchase card's footer
 * the same estimate the server will make on save.
 *
 * Every word in Arabic, English and Sorani — the Sorani its own, never the
 * Arabic (docs/DECISIONS.md row 183). The investor's screen says «أرباحي» /
 * «قازانجەکانم», never «محفظتك»: the customer Levo wallet is another thing, and
 * the money is not there. Pure: no React, no request.
 */
import type { Language } from '../translations';

export interface InvestmentReturnStrings {
  /** Purchase card footer (owner). */
  footerRow: string;
  footerCaption: string;
  /** Saved purchase, «تفاصيل الشحنة» (owner). */
  agreed: string;
  received: string;
  allocated: string;
  surplus: string;
  returned: string;
  returnPending: string;
  storeContribution: string;
  shortfall: string;
  recordReceipt: string;
  receiptAmount: string;
  receiptReference: string;
  recordButton: string;
  /** «المستثمرون» (owner). */
  profilesReturned: string;
  /** «أرباحي» (the investor). */
  heroCapital: string;
  sourcesSurplus: string;
  batchesReturned: string;
  batchesPending: string;
}

export const INVESTMENT_RETURN_STRINGS: Readonly<Record<Language, InvestmentReturnStrings>> = {
  ar: {
    footerRow: 'يعود إلى محفظة أرباح المستثمر',
    footerCaption: 'يصبح قابلًا للسحب عند تسجيل استلام تمويله',
    agreed: 'المتفق عليه',
    received: 'المستلم',
    allocated: 'المخصص',
    surplus: 'فائض التمويل',
    returned: 'أُعيد إلى أرباح المستثمر',
    returnPending: 'يعود إليه عند استلام بقية تمويله',
    storeContribution: 'مساهمة المتجر',
    shortfall: 'تمويل ينتظر الاستلام',
    recordReceipt: 'تسجيل تمويل مستلم',
    receiptAmount: 'المبلغ المستلم بالدينار',
    receiptReference: 'مرجع الاستلام',
    recordButton: 'تسجيل الاستلام',
    profilesReturned: 'فائض أُعيد إلى أرباحه',
    heroCapital: 'ولك أيضًا رأس مال متاح للسحب',
    sourcesSurplus: 'منه فائض تمويل الشحنات',
    batchesReturned: 'فائض تمويل أُعيد إليك',
    batchesPending: 'يعود إليك عند استلام بقية تمويلك',
  },
  en: {
    footerRow: "Returns to the investor's earnings",
    footerCaption: "Withdrawable once the investor's funding is recorded as received",
    agreed: 'Agreed',
    received: 'Received',
    allocated: 'Allocated',
    surplus: 'Funding surplus',
    returned: "Returned to the investor's earnings",
    returnPending: 'Returns once the rest of the funding is received',
    storeContribution: 'Store contribution',
    shortfall: 'Funding not yet received',
    recordReceipt: 'Record received funding',
    receiptAmount: 'Amount received IQD',
    receiptReference: 'Receipt reference',
    recordButton: 'Record receipt',
    profilesReturned: 'Surplus returned to earnings',
    heroCapital: 'You also have capital available to withdraw',
    sourcesSurplus: 'Of which shipment funding surplus',
    batchesReturned: 'Funding surplus returned to you',
    batchesPending: 'Returns to you once the rest of your funding is received',
  },
  ckb: {
    footerRow: 'دەگەڕێتەوە بۆ جزدانی قازانجی وەبەرهێنەر',
    footerCaption: 'کاتێک وەرگرتنی پارەدارکردنەکەی تۆمار کرا دەتوانرێت ڕابکێشرێت',
    agreed: 'ڕێککەوتوو',
    received: 'وەرگیراو',
    allocated: 'تەرخانکراو',
    surplus: 'زیادەی پارەدارکردن',
    returned: 'گەڕێندرایەوە بۆ قازانجەکانی وەبەرهێنەر',
    returnPending: 'کاتێک ماوەی پارەدارکردنەکەی وەرگیرا بۆی دەگەڕێتەوە',
    storeContribution: 'بەشداریی فرۆشگا',
    shortfall: 'پارەدارکردنی چاوەڕێی وەرگرتن',
    recordReceipt: 'تۆمارکردنی پارەدارکردنی وەرگیراو',
    receiptAmount: 'بڕی وەرگیراو بە دینار',
    receiptReference: 'ژمارەی پسوولەی وەرگرتن',
    recordButton: 'تۆمارکردنی وەرگرتن',
    profilesReturned: 'زیادەی گەڕێندراو بۆ قازانجەکانی',
    heroCapital: 'هەروەها سەرمایەی بەردەستت هەیە بۆ ڕاکێشان',
    sourcesSurplus: 'لەمەش زیادەی پارەدارکردنی بارەکان',
    batchesReturned: 'زیادەی پارەدارکردن کە بۆت گەڕێندرایەوە',
    batchesPending: 'کاتێک ماوەی پارەدارکردنەکەت وەرگیرا بۆت دەگەڕێتەوە',
  },
};

export const investmentReturnStrings = (lang: Language): InvestmentReturnStrings =>
  INVESTMENT_RETURN_STRINGS[lang] ?? INVESTMENT_RETURN_STRINGS.ar;

/**
 * The purchase card footer's estimate, the server's own sums (purchaseFunding.ts
 * `fundingDistribution` and `purchaseFundingSummary`):
 *   allocated   = min(agreed, landed cost of the funded lines)
 *   returnTotal = max(0, max(agreed, received) − allocated) — 146,178 for 13,000,000 on 12,853,822
 *   cashBacked  = max(0, received − allocated) — what is withdrawable on save
 * `awaitsCash` is true while part of the return still waits for the investor's cash.
 * A display estimate only: the server computes it again on save.
 */
export function fundingReturnEstimate(agreed: number, received: number, fundedCost: number) {
  const a = Number.isFinite(agreed) ? Math.max(0, agreed) : 0;
  const r = Number.isFinite(received) ? Math.max(0, received) : 0;
  const allocated = Math.min(a, Number.isFinite(fundedCost) ? Math.max(0, fundedCost) : 0);
  const returnTotal = Math.max(0, Math.max(a, r) - allocated);
  const cashBacked = Math.max(0, r - allocated);
  return { allocated, return_total_iqd: returnTotal, cash_backed_iqd: cashBacked, awaits_cash: returnTotal > cashBacked };
}

/**
 * What «أرباحي» shows of the returned remainder, from the server's figures
 * (`/api/finance-earnings`): the hero's capital line, the «منه فائض تمويل الشحنات»
 * sub-row, and the «دفعات استثماري» notes. A zero hides its line; an older
 * response without the new fields reads as zero (the received-unallocated
 * figure stands in for the returned one).
 */
export function investorReturnView(
  summary: { capital_available_iqd?: number; capital_surplus_iqd?: number } | null | undefined,
  investment: { returned_surplus_iqd?: number; unallocated_iqd?: number; pending_surplus_iqd?: number; batches?: readonly unknown[] } | null | undefined,
) {
  const returned = investment?.returned_surplus_iqd ?? investment?.unallocated_iqd ?? 0;
  const pending = investment?.pending_surplus_iqd ?? 0;
  return {
    hero_capital_iqd: Math.max(0, summary?.capital_available_iqd ?? 0),
    sources_surplus_iqd: Math.max(0, summary?.capital_surplus_iqd ?? 0),
    batches_returned_iqd: Math.max(0, returned),
    batches_pending_iqd: Math.max(0, pending),
    show_batches: !!(investment?.batches?.length || returned > 0 || pending > 0),
  };
}
