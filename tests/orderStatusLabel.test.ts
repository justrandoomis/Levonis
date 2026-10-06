/**
 * «بانتظار الدفع» is the legacy name of a pending order, and it is wrong for an
 * order the wallet already paid in full — every Quick Buy order among them
 * (owner brief §13: «مشاهدة حالة الدفع»). Such an order waits for the shop's
 * confirmation; an order with anything left to pay keeps the legacy label.
 *
 * Run: node --import tsx --test tests/orderStatusLabel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderStatusLabel } from '../src/components/orders/format';

const order = (over: Record<string, unknown>) => ({ status: 'pending', total_iqd: 625_000, wallet_applied_iqd: 0, due_on_delivery_iqd: 0, ...over });

test('a pending order the wallet paid in full awaits confirmation, in three languages', () => {
  const paid = order({ wallet_applied_iqd: 625_000 });
  assert.equal(orderStatusLabel('ar', paid), 'بانتظار التأكيد');
  assert.equal(orderStatusLabel('en', paid), 'Awaiting confirmation');
  assert.equal(orderStatusLabel('ckb', paid), 'چاوەڕێی پشتڕاستکردنەوە');
  // A gift-only order with nothing to pay is the same.
  assert.equal(orderStatusLabel('ar', order({ total_iqd: 0 })), 'بانتظار التأكيد');
});

test('anything left to pay keeps «بانتظار الدفع», and other statuses are untouched', () => {
  assert.equal(orderStatusLabel('ar', order({ wallet_applied_iqd: 600_000, due_on_delivery_iqd: 25_000 })), 'بانتظار الدفع', 'cash on delivery');
  assert.equal(orderStatusLabel('ar', order({})), 'بانتظار الدفع', 'a transfer still to be verified');
  assert.equal(orderStatusLabel('ar', order({ status: 'confirmed', wallet_applied_iqd: 625_000 })), 'بانتظار الشحن');
  assert.equal(orderStatusLabel('ar', { status: 'pending' }), 'بانتظار الدفع', 'no money facts: the legacy label');
});
