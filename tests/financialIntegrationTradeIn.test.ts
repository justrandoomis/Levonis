import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, get, json, pending, post, stubApp } from './fixtures/app';
import { seedCatalogue, orderBody } from './lib/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { tradeInRoutes } from '../worker/routes/tradeIn';
import { paidPerUnit } from '../worker/lib/tradeIn';

async function checkout(cap: 'per_unit' | 'per_order') {
  const raw = seedCatalogue(), db = asD1(raw);
  raw.exec(`UPDATE users SET email='boss@x.co' WHERE id='boss';
    UPDATE admin_settings SET value='{"paused":false,"since":null}' WHERE key='proPause';
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('approved-pro','u_pro',1,'Rami','+9647701234570','Baghdad, Karrada 15','','approved');
    UPDATE products SET category_id='cat_printers', sub_category_id='cat_printers_fdm', product_cost_iqd=100000 WHERE id='p_printer';`);
  const customer = stubApp(db, { id: 'u_pro', role: 'customer', email: 'r@x.co' }, a => {
    a.route('/api/cart', cartRoutes); a.route('/api/orders', orderRoutes); a.route('/api/trade-in', tradeInRoutes);
  });
  const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => {
    a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
  });
  const rule = await json(await post(admin, '/api/admin/membership-benefits', {
    tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent',
    percent: 10, max_discount_iqd: 100000, cap_scope: cap, label: 'Trade-in integration',
  }));
  assert.equal(rule.success, true, JSON.stringify(rule));
  const added = await json(await post(customer, '/api/cart/items', { productId: 'p_printer', qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(customer, '/api/orders', orderBody({ addressId: 'addr_o' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  await Promise.all(pending.splice(0));
  const id = String(placed.order.id);
  const item = raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(id)!;
  const order = raw.prepare('SELECT * FROM orders WHERE id=?').get(id)!;
  // Delivery is fixture state; membership amounts and their application site
  // above came through the same cart and checkout routes used by customers.
  raw.prepare("UPDATE orders SET status='delivered',stage='delivered',delivered_at='2026-09-01T00:00:00.000Z' WHERE id=?").run(id);
  return { raw, customer, item, order };
}

test('trade-in retains the historical deduction when frozen membership evidence is missing or malformed', async () => {
  const { raw, customer, item, order } = await checkout('per_unit');
  for (const snapshot of [null, '{broken']) {
    raw.prepare('UPDATE orders SET benefit_snapshot=? WHERE id=?').run(snapshot, order.id);
    const eligible = await json(await get(customer, '/api/trade-in/eligible'));
    assert.equal(eligible.success, true, JSON.stringify(eligible));
    for (const unit of eligible.units) assert.equal(unit.paid_iqd, 320000);
  }
  const draft = await json(await post(customer, '/api/trade-in/requests', {
    order_item_id: item.id, unit_index: 1, scope: 'whole',
  }));
  assert.equal(draft.success, true, JSON.stringify(draft));
  assert.equal(raw.prepare('SELECT base_iqd FROM trade_in_components WHERE request_id=?').get(draft.request.id)!.base_iqd, 320000);
});

test('frozen unit membership changes only its own deduction; warranty, coupon and quantity allocation remain intact', () => {
  const line = { product_id: 'printer', membership_rule_id: 'rule', unit_price_iqd: 360000, qty: 2,
    warranty_snapshot: JSON.stringify({ fee_iqd: 15000 }), membership_discount_iqd: 80000, coupon_discount_iqd: 10001 };
  const snapshot = (applied_at: 'unit' | 'line') => JSON.stringify({ lines: [{ product_id: 'printer', rule_id: 'rule', applied_at }] });
  assert.equal(paidPerUnit({ ...line, benefit_snapshot: snapshot('unit') }), 340000);
  assert.equal(paidPerUnit({ ...line, unit_price_iqd: 400000, benefit_snapshot: snapshot('line') }), 340000);
  assert.equal(paidPerUnit({ ...line, benefit_snapshot: null }), 300000);
});

for (const cap of ['per_unit', 'per_order'] as const) {
  test(`trade-in values a real ${cap} membership checkout exactly once`, async () => {
    const { raw, customer, item, order } = await checkout(cap);
    assert.equal(item.membership_discount_iqd, 80000);
    assert.equal(item.unit_price_iqd, cap === 'per_unit' ? 360000 : 400000);
    const snapshot = JSON.parse(String(order.benefit_snapshot));
    assert.equal(snapshot.lines[0].applied_at, cap === 'per_unit' ? 'unit' : 'line');
    const eligible = await json(await get(customer, '/api/trade-in/eligible'));
    assert.equal(eligible.success, true, JSON.stringify(eligible));
    assert.equal(eligible.units.length, 2);
    for (const unit of eligible.units) assert.equal(unit.paid_iqd, 360000);
    const draft = await json(await post(customer, '/api/trade-in/requests', {
      order_item_id: item.id, unit_index: 1, scope: 'whole',
    }));
    assert.equal(draft.success, true, JSON.stringify(draft));
    const component = raw.prepare('SELECT base_iqd FROM trade_in_components WHERE request_id=?').get(draft.request.id)!;
    assert.equal(component.base_iqd, 360000, 'the draft freezes the same actual paid basis offered by eligibility');
  });
}
