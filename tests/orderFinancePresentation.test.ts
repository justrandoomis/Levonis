import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFinancePresentation, projectedLineCost, visibleOrderReviewReasons } from '../src/components/financeWorkspace/orderFinancePresentation';
import type { FinanceOrder, ProfitLine, ProfitReviewIssue } from '../src/components/financeWorkspace/types';

const issue = (code: string): ProfitReviewIssue => ({ code, field: 'cogs_iqd', source_id: null, line_ids: ['refill-black'] });
const order = (extra: Partial<FinanceOrder> = {}): FinanceOrder => ({ id: 'petg-order', status: 'pending', created_at: '2026-10-05', cogs_iqd: null, owner_net_iqd: null, unknown_lines: 1, review_reasons: [issue('fifo_missing')], projected_finance: { cogs_iqd: 10000, gross_profit_iqd: 8000, owner_net_iqd: null, is_estimate: true }, ...extra });
const line = (extra: Partial<ProfitLine> = {}): ProfitLine => ({ id: 'refill-black', product_id: 'petg', name_snapshot: 'PETG Basic Refill', sku_snapshot: '', color_snapshot: 'Black', qty: 1, returned_qty: 0, cost_confidence: 'unknown', cogs_iqd: null, cost_projection: { unit_cost_iqd: 10000, total_cost_iqd: 10000, source: 'current_catalogue', source_id: 'refill-black', as_of: null }, ...extra });

test('unfulfilled catalogue-priced order shows an explicit goods margin forecast, without changing financial values', () => {
  const source = order(), before = structuredClone(source), view = orderFinancePresentation(source);
  assert.equal(view.needsReview, false); assert.equal(view.expectsDelivery, true);
  assert.equal(view.amountKind, 'projected_goods_margin'); assert.equal(view.amount, 8000);
  assert.equal(view.projection?.cogs_iqd, 10000); assert.deepEqual(source, before);
  assert.equal(source.owner_net_iqd, null); assert.equal(projectedLineCost(source, line())?.total_cost_iqd, 10000);
});

test('unknown projection stays unknown, while a confirmed zero estimate remains a number', () => {
  assert.equal(orderFinancePresentation(order({ projected_finance: undefined, owner_net_iqd: 9000 })).amount, null);
  assert.equal(projectedLineCost(order(), line({ cost_projection: { unit_cost_iqd: null, total_cost_iqd: null, source: 'current_catalogue', source_id: null, as_of: null } })), null);
  assert.equal(projectedLineCost(order(), line({ cost_projection: { unit_cost_iqd: 0, total_cost_iqd: 0, source: 'confirmed_lot', source_id: 'lot', as_of: null } }))?.total_cost_iqd, 0);
});

test('prepayment with a known forecast does not demand stock issue, but actual partial FIFO and wage errors remain', () => {
  const source = order({ has_financial_activity: true, collected_iqd: 18000, review_reasons: [issue('fifo_missing'), issue('historical_cost_unverified'), issue('verified_goods_cost_required')] });
  assert.equal(orderFinancePresentation(source).needsReview, false);
  assert.equal(orderFinancePresentation(source).amount, 8000);
  for (const code of ['fifo_quantity_incomplete', 'fifo_cost_missing', 'refund_amount_missing', 'wage_reconciliation_pending']) {
    const view = orderFinancePresentation({ ...source, review_reasons: [issue('fifo_missing'), issue(code)] });
    assert.equal(view.needsReview, true); assert.deepEqual(view.reviewReasons.map(reason => reason.code), [code]);
  }
  assert.equal(orderFinancePresentation({ ...source, pending_costs: 1 }).needsReview, true);
});

test('cancelled orders without financial activity never show a sale forecast or false missing-stock alert', () => {
  const source = order({ status: 'cancelled', owner_net_iqd: 18000 });
  const view = orderFinancePresentation(source);
  assert.equal(view.needsReview, false); assert.equal(view.projection, undefined);
  assert.equal(view.amountKind, 'not_earned'); assert.equal(view.amount, null);
  assert.equal(projectedLineCost(source, line()), null);
});

test('delivered missing costs and wage reconciliation remain actionable and ignore any stale projection', () => {
  const source = order({ status: 'delivered', pending_costs: 1, review_reasons: [issue('fifo_missing'), issue('wage_reconciliation_pending')] });
  const view = orderFinancePresentation(source);
  assert.equal(view.needsReview, true); assert.equal(view.reviewReasons.length, 2);
  assert.equal(view.amountKind, 'owner_net'); assert.equal(view.amount, null);
  assert.equal(view.projection, undefined); assert.equal(projectedLineCost(source, line()), null);
});

test('cancelled or returned orders retain real financial and refund problems without forecasting a new sale', () => {
  for (const status of ['cancelled', 'returned', 'refunded']) {
    const view = orderFinancePresentation(order({ status, has_financial_activity: true, owner_net_iqd: -2000 }));
    assert.equal(view.needsReview, true); assert.equal(view.amountKind, 'owner_net'); assert.equal(view.amount, -2000);
    assert.equal(view.projection, undefined);
  }
  const source = order({ status: 'cancelled', review_reasons: [issue('fifo_missing'), issue('refund_amount_missing'), issue('return_cost_missing')] });
  assert.deepEqual(orderFinancePresentation(source).reviewReasons.map(reason => reason.code), ['refund_amount_missing', 'return_cost_missing']);
  assert.equal(orderFinancePresentation(source).needsReview, true);
});

test('delivery history and explicit activity preserve review, while catalogue values alone do not imply activity', () => {
  assert.equal(orderFinancePresentation(order({ status: 'cancelled', delivered_at: '2026-10-04' })).needsReview, true);
  assert.equal(orderFinancePresentation(order({ cogs_iqd: 10000, has_financial_activity: false })).hasFinancialActivity, false);
  assert.deepEqual(visibleOrderReviewReasons(order(), [issue('fifo_missing'), issue('wage_reconciliation_pending')]).map(reason => reason.code), ['wage_reconciliation_pending']);
});

test('projections cannot relabel confirmed historical or FIFO costs', () => {
  for (const source of ['fifo', 'manual_verified', 'recorded_snapshot']) assert.equal(projectedLineCost(order(), line({ cost_confidence: source, cogs_iqd: 12000 })), null);
});
