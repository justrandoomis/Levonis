import test from 'node:test';
import assert from 'node:assert/strict';
import { canReconcilePendingCosts, displayedCostAmount, groupOrderCosts } from '../src/components/financeWorkspace/orderCostGroups';
import type { OrderProfit, ProfitCost, ProfitLine } from '../src/components/financeWorkspace/types';
const cost = (id: string, staff_id: string | null, amount_iqd: number | null, extra: Partial<ProfitCost> = {}): ProfitCost => ({ id, staff_id, amount_iqd, rule_name: 'Pay', state: 'due', order_item_id: `line:${id}`, center_id: null, ...extra });

test('equal wages for separate product lines remain separate under one employee total', () => {
  const groups = groupOrderCosts([cost('order', 'hussein', 2500), cost('printer-a', 'sajjad', 22500), cost('printer-b', 'sajjad', 22500)]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].knownAmount, 45000);
  assert.deepEqual(groups[1].costs.map(c => c.id), ['printer-a', 'printer-b']);
  assert.equal(groups[0].knownAmount, 2500);
});

test('linked account is the grouping identity, while identical names alone never merge staff', () => {
  const groups = groupOrderCosts([cost('a', 's1', 10, { staff_user_id: 'u1', staff_name: 'Ali' }), cost('b', 's2', 20, { staff_user_id: 'u1', staff_name: 'Ali' }), cost('c', 's3', 30, { staff_user_id: 'u2', staff_name: 'Ali' })]);
  assert.equal(groups.length, 2); assert.equal(groups[0].knownAmount, 30); assert.equal(groups[0].costs.length, 2);
});

test('pending costs are not zero or a final total, even with a retained historical amount', () => {
  const groups = groupOrderCosts([cost('known', 's', 5000), cost('unknown', 's', 3000, { state: 'pending_cost', effective_amount_iqd: 3000 })]);
  assert.equal(groups[0].knownAmount, 5000); assert.equal(groups[0].knownCount, 1); assert.equal(groups[0].pendingCount, 1);
  assert.equal(displayedCostAmount(groups[0].costs[1]), null);
});

test('effective adjustments replace displayed amounts; reversals remain visible without contributing wages', () => {
  const groups = groupOrderCosts([cost('corrected', 's', 10000, { effective_amount_iqd: 5000 }), cost('reversed', 's', 10000, { state: 'reversed' })]);
  assert.equal(groups[0].knownAmount, 5000); assert.equal(groups[0].costs.length, 2); assert.equal(groups[0].pendingCount, 0);
});

test('explicit unknown remains unknown and confirmed zero remains zero', () => {
  assert.equal(displayedCostAmount(cost('unknown', 's', 1000, { effective_amount_iqd: null })), null);
  assert.equal(displayedCostAmount(cost('zero', 's', 1000, { effective_amount_iqd: 0 })), 0);
  const group = groupOrderCosts([cost('unknown', 's', null)])[0];
  assert.equal(group.knownCount, 0); assert.equal(group.pendingCount, 1);
});

test('unassigned material costs do not get merged into a fabricated employee', () => {
  const groups = groupOrderCosts([cost('material-a', null, 10), cost('material-b', null, 20)]);
  assert.equal(groups.length, 2); assert.deepEqual(groups.map(g => g.knownAmount), [10, 20]);
});

const retryData = (confidence = 'recorded_snapshot', cogs: number | null = 600000): Pick<OrderProfit, 'can_reconcile' | 'order' | 'lines' | 'costs'> => ({
  can_reconcile: true,
  order: { id: 'order', status: 'delivered', created_at: '2026-09-01' },
  lines: [{ id: 'line', product_id: 'printer', name_snapshot: 'Printer', sku_snapshot: 'SKU', qty: 1, returned_qty: 0, cost_confidence: confidence, cogs_iqd: cogs }],
  costs: [cost('pending', 'staff', null, { state: 'pending_cost', order_item_id: 'line', line_ids: ['line'] })],
});

test('explicit retry accepts confirmed recorded order costs, including a documented zero', () => {
  for (const source of ['recorded_snapshot', 'fifo', 'manual_verified']) assert.equal(canReconcilePendingCosts(retryData(source)), true);
  assert.equal(canReconcilePendingCosts(retryData('recorded_snapshot', 0)), true);
});

test('retry never treats a catalogue or unrecorded snapshot reference as confirmed evidence', () => {
  assert.equal(canReconcilePendingCosts(retryData('snapshot')), false);
  assert.equal(canReconcilePendingCosts(retryData('unknown', null)), false);
  const data = retryData(); data.can_reconcile = false;
  assert.equal(canReconcilePendingCosts(data), false);
  data.can_reconcile = true; data.order.status = 'shipped';
  assert.equal(canReconcilePendingCosts(data), false);
});

test('retry checks the pending wage dependencies, allowing unrelated unknown lines to remain pending', () => {
  const data = retryData();
  data.lines.push({ ...data.lines[0], id: 'other', cost_confidence: 'unknown', cogs_iqd: null });
  assert.equal(canReconcilePendingCosts(data), true);
  data.costs[0].line_ids = ['line', 'other'];
  assert.equal(canReconcilePendingCosts(data), false);
});

test('missing return facts and already-computed wages do not offer a misleading retry', () => {
  const data = retryData();
  data.lines[0].cost_review = { issues: [{ code: 'refund_amount_missing', field: 'refund_iqd', source_id: 'return', line_ids: ['line'] }] } as ProfitLine['cost_review'];
  assert.equal(canReconcilePendingCosts(data), false);
  delete data.lines[0].cost_review; data.costs[0].state = 'due';
  assert.equal(canReconcilePendingCosts(data), false);
});
