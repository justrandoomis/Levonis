/**
 * «صافي حصتك» ON THE OVERVIEW IS WHAT THE OWNER KEEPS (redesign step 1, DECISIONS row 313).
 *
 * The 2026-11-11 audit found the headline BEFORE the order coupon, credited price
 * protection and a returned trade-in credit, while every staff and investor share is
 * worked out after them — so the owner's figure was overstated by the whole of them —
 * and a "complete" net that silently rested on sale-time estimates. These cases pin
 * the pure arithmetic the overview words (src/components/financeWorkspace/overviewFigures.ts).
 *
 * Run: node --import tsx --test tests/financeOverviewFigures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewNet } from '../src/components/financeWorkspace/overviewFigures';
import type { FinanceSummary } from '../src/components/financeWorkspace/types';

const summary = (over: Partial<FinanceSummary> & { totals?: FinanceSummary['totals'] }): FinanceSummary => ({
  range: { from: '2026-11-01', to: '2026-11-11' }, orders: [], kinds: null, products: [], categories: [], exceptions: [], promotions: [],
  general_expenses_iqd: 0, truncated: false, chart_data: { revenue_iqd: 55000 } as FinanceSummary['chart_data'], known: null, missing_costs: undefined,
  ...over, totals: { orders_count: 1, unknown_lines: 0, pending_costs: 0, ...(over.totals ?? {}) },
}) as FinanceSummary;

test('the headline is the period net after the order coupon, price protection and a returned trade-in credit', () => {
  const f = overviewNet(summary({ totals: { owner_period_net_iqd: 32300, owner_period_net_after_report_adjustments_iqd: 22300, coupon_iqd: 5000, price_protection_iqd: 3000, trade_in_credit_returned_iqd: 2000 } }));
  assert.equal(f.net, 22300, 'what the owner keeps, not 32,300');
  assert.equal(f.deductions, 10000, 'and the screen can say what came off');
  assert.equal(f.fromKnown, false);
  assert.equal(f.state, 'confirmed');
});

test('with incomplete orders it is the complete orders\' net after their deductions, over their own revenue', () => {
  const f = overviewNet(summary({
    totals: { owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null, unknown_lines: 4 },
    known: { orders_count: 9, incomplete_orders: 4, revenue_iqd: 4847211, cost_iqd: 3678427, owner_net_iqd: 1168784, net_after_report_adjustments_iqd: 1160000,
      confirmed: { orders_count: 3, revenue_iqd: 3310000, owner_net_iqd: 784859, net_after_report_adjustments_iqd: 780000 },
      estimated: { orders_count: 6, revenue_iqd: 1537211, owner_net_iqd: 383925, net_after_report_adjustments_iqd: 380000 } },
  }));
  assert.equal(f.net, 1160000);
  assert.equal(f.fromKnown, true);
  assert.equal(f.marginBase, 4847211, 'the margin is over the complete orders\' own revenue');
  assert.deepEqual(f.confirmed, { orders: 3, net: 780000 });
  assert.deepEqual(f.estimated, { orders: 6, net: 380000 });
  assert.equal(f.confirmed!.net! + f.estimated!.net!, f.net, 'the two parts add up to the headline');
  assert.equal(f.state, 'review');
});

test('a complete period whose net rests partly on sale-time estimates is never shown as confirmed', () => {
  const f = overviewNet(summary({
    totals: { owner_period_net_iqd: 20000, owner_period_net_after_report_adjustments_iqd: 20000 },
    known: { orders_count: 2, incomplete_orders: 0, revenue_iqd: 75000, cost_iqd: 50000, owner_net_iqd: 20000, net_after_report_adjustments_iqd: 20000,
      confirmed: { orders_count: 1, revenue_iqd: 55000, owner_net_iqd: 15000, net_after_report_adjustments_iqd: 15000 },
      estimated: { orders_count: 1, revenue_iqd: 20000, owner_net_iqd: 5000, net_after_report_adjustments_iqd: 5000 } },
  }));
  assert.equal(f.net, 20000);
  assert.equal(f.state, 'estimated', 'the status says «فيه تكلفة تقديرية», not «كل التكاليف مؤكدة»');
});

test('in dollars the headline takes the server\'s after-deductions cents, and a figure the server lacks stays missing, never dinars', () => {
  const data = summary({ totals: { owner_period_net_iqd: 32300, owner_period_net_after_report_adjustments_iqd: 24300, coupon_iqd: 5000, price_protection_iqd: 3000 } });
  const usd = { available: true, totals: { owner_period_net_cents: 2153, owner_period_net_after_report_adjustments_cents: 1620 } };
  assert.equal(overviewNet(data, usd).cents, 1620);
  assert.equal(overviewNet(data, { available: true, totals: { owner_period_net_cents: 2153 } }).cents, null, 'missing cents are missing, not the before-deductions figure');
  assert.equal(overviewNet(data).cents, undefined, 'no USD block: the figure stays in dinars');
});

test('a server that predates the after-deductions field still answers the figure before them', () => {
  const f = overviewNet(summary({ totals: { owner_period_net_iqd: 32300 } }));
  assert.equal(f.net, 32300);
});
