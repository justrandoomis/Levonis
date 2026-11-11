import type { FinanceOrder, ProfitLine, ProfitReviewIssue, SaleReversal } from './types';
import { tri, type Tri } from './displayCurrencyStrings';
import { rangeText } from './overviewStrings';

const fulfilmentCostIssues = new Set(['fifo_missing', 'fifo_quantity_incomplete', 'fifo_cost_missing', 'historical_cost_unverified', 'verified_goods_cost_required']);
const beforeIssueCostIssues = new Set(['fifo_missing', 'historical_cost_unverified', 'verified_goods_cost_required']);
const finalStates = new Set(['delivered', 'cancelled', 'returned', 'refunded']);

/** Presentation only: projections never replace the financial engine's amounts. */
export function orderFinancePresentation(order: FinanceOrder) {
  const hasFinancialActivity = order.status === 'delivered' || !!order.delivered_at || order.has_financial_activity === true;
  const expectsDelivery = !finalStates.has(order.status);
  const reviewReasons = visibleOrderReviewReasons(order, order.review_reasons ?? []);
  const projection = expectsDelivery ? order.projected_finance : undefined;
  const knownPreDeliveryProjection = expectsDelivery && !order.delivered_at && projection?.cogs_iqd != null;
  const needsReview = reviewReasons.length > 0 || hasFinancialActivity && ((order.pending_costs ?? 0) > 0 || !knownPreDeliveryProjection && (order.unknown_lines ?? 0) > 0);
  // A goods margin cannot stand in for final owner profit before wages and
  // investor shares are known, even when the latter happen to display zero.
  const amountKind = expectsDelivery ? 'projected_goods_margin' : hasFinancialActivity ? 'owner_net' : 'not_earned';
  const amount = amountKind === 'projected_goods_margin' ? projection?.gross_profit_iqd ?? null : amountKind === 'owner_net' ? order.owner_net_iqd ?? null : null;
  return { hasFinancialActivity, expectsDelivery, reviewReasons, needsReview, projection, amountKind, amount };
}

export function visibleOrderReviewReasons(order: Pick<FinanceOrder, 'status' | 'delivered_at' | 'has_financial_activity'>, issues: readonly ProfitReviewIssue[]) {
  const hasFinancialActivity = order.status === 'delivered' || !!order.delivered_at || order.has_financial_activity === true;
  if (!finalStates.has(order.status) && !order.delivered_at) {
    // Prepayment is cash evidence, not proof that goods should already have
    // been issued. Partial/broken actual allocations still need review.
    return issues.filter(issue => !beforeIssueCostIssues.has(issue.code));
  }
  // Missing ordinary FIFO evidence is expected before fulfilment, but refund
  // problems and genuine reconciliation failures remain visible in any state.
  return issues.filter(issue => hasFinancialActivity || !fulfilmentCostIssues.has(issue.code));
}

export function projectedLineCost(order: Pick<FinanceOrder, 'status'>, line: ProfitLine) {
  if (finalStates.has(order.status) || ['fifo', 'manual_verified', 'recorded_snapshot'].includes(line.cost_confidence)) return null;
  return line.cost_projection?.total_cost_iqd != null ? line.cost_projection : null;
}

/**
 * The order sheet's note on an order cancelled after its delivery (owner 2026-11-11, ruling 6.7.2; DECISIONS row 318): its
 * sale and goods cost reversed in the journal like a return, on the day the reversal was posted; still to be reversed by the
 * minute scan; or never booked. Arabic, English and Sorani in one table, so a missing language does not compile; the Sorani
 * is its own (DECISIONS row 183, held by tests/cancelledAfterDeliverySheet.test.ts). `{day}`: written as the workspace writes
 * a day (rangeText).
 */
export const SALE_REVERSAL_NOTES = {
  reversed: {
    ar: 'أُلغي بعد التسليم: عُكس بيعه وتكلفة بضاعته في الدفتر يوم {day}، كالمرتجع، ولا يُحسب في أي فترة.',
    en: 'Cancelled after delivery: its sale and goods cost were reversed in the journal on {day}, like a return, and it counts in no period.',
    ckb: 'دوای گەیاندن هەڵوەشێنرایەوە: فرۆشتنەکەی و تێچووی کاڵاکەی لە ڕۆژی {day} لە دەفتەردا گەڕێنرانەوە، وەک گەڕاندنەوە، و لە هیچ ماوەیەکدا ناژمێردرێت.',
  },
  pending: {
    ar: 'أُلغي بعد التسليم: لم يُعكس بيعه وتكلفة بضاعته في الدفتر بعد؛ يُعكسان تلقائيًا كالمرتجع، ولا يُحسب في أي فترة.',
    en: 'Cancelled after delivery: its sale and goods cost are not reversed in the journal yet; they are reversed automatically, like a return, and it counts in no period.',
    ckb: 'دوای گەیاندن هەڵوەشێنرایەوە: فرۆشتنەکەی و تێچووی کاڵاکەی هێشتا لە دەفتەردا نەگەڕێنراونەتەوە؛ بە شێوەی خۆکار وەک گەڕاندنەوە دەگەڕێنرێنەوە، و لە هیچ ماوەیەکدا ناژمێردرێت.',
  },
  neverBooked: {
    ar: 'أُلغي بعد التسليم: لم يُسجَّل له بيع في الدفتر، ولا يُحسب في أي فترة.',
    en: 'Cancelled after delivery: no sale of it was booked in the journal, and it counts in no period.',
    ckb: 'دوای گەیاندن هەڵوەشێنرایەوە: هیچ فرۆشتنێکی لە دەفتەردا تۆمار نەکراوە، و لە هیچ ماوەیەکدا ناژمێردرێت.',
  },
} as const satisfies Record<string, Tri>;

/** Which note it takes, from what the server says the journal did: a chain still in the books first. */
export function saleReversalNote(reversal: SaleReversal): keyof typeof SALE_REVERSAL_NOTES {
  return reversal.pending ? 'pending' : reversal.day ? 'reversed' : 'neverBooked';
}
/** That note in the reader's language, with its day. */
export function saleReversalText(loc: (ar: string, en: string, ckb?: string) => string, lang: 'ar' | 'en' | 'ckb', reversal: SaleReversal): string {
  const key = saleReversalNote(reversal), day = reversal.day;
  return tri(loc, SALE_REVERSAL_NOTES[key], key === 'reversed' && day ? { day: rangeText(lang, day, day) } : undefined);
}
