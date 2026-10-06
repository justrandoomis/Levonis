import type { FinanceOrder, ProfitLine, ProfitReviewIssue } from './types';

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
