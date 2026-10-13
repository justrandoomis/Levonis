/**
 * Review of de54666a (price protection ↔ return settlement).
 *
 * Policy (worker/lib/policies/price_protection.ts §548): protection is not
 * combined with a refund of the same item, and "a customer who returned the
 * item and recovered its price is not entitled to its price difference".
 *
 * de54666a fences the two payments against each other, but the protection
 * approval only looks at RESOLVED refund returns. A return that is already in
 * progress for the same line (the unit is physically back: received/inspected)
 * is ignored, so an admin working the price-protection queue can pay the
 * smaller difference first. From then on the return can never be refunded
 * (PRICE_PROTECTION_RETURN_REVIEW on every attempt, with no admin override),
 * and its stock is never restored: the customer handed the unit back and keeps
 * only the price difference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, json, row } from './fixtures/app';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';

function world(caseState: 'received' | 'inspected') {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES
    ('buyer','Buyer','buyer@x.co','h','customer'),('boss','Admin','boss@x.co','h','admin');
    INSERT INTO products(id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES('p','p','Product',40000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
      subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES('ord','buyer','delivered','{}','standard','{}','cash',50000,0,1400,50000,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES('item','ord','p','Product','',1,50000,50000);`);
  raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,within_window)
    VALUES('ret','ord','item','buyer',1,'defective',?,1)`).run(caseState);
  raw.prepare(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
    VALUES('pp','buyer','ord','item',50000,40000,1,'requested')`).run();
  const db = asD1(raw);
  const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => {
    a.route('/api/price-protection', priceProtectionRoutes); a.route('/api/returns', returnRoutes);
  });
  return { raw, admin };
}

for (const caseState of ['received', 'inspected'] as const) {
  test(`protection approval is refused while a return of the same line is open (${caseState})`, async () => {
    const w = world(caseState);
    const approved = await post(w.admin, '/api/price-protection/admin/claims/pp/decide', { decision: 'approved' });
    const body = await json(approved);
    // Today: 200 and a 10,000 IQD wallet credit for the line whose unit is
    // already back at the store.
    assert.equal(approved.status, 400, `protection paid while the return is open: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'PRICE_PROTECTION_RETURN_REVIEW');
    assert.equal(row(w.raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id='wtx_pp_pp'")!.n, 0);
  });
}

/* Fix 2026-10-13 (PF-1): the open return decides the line first. Its refund
 * succeeds, and protection on the refunded unit then stays refused (the
 * policy never pays both). The reviewer's original third subtest assumed the
 * approval still went through; it now cannot, so the flow is asserted end to end. */
test('with protection held back, the open return is refunded and protection stays refused afterwards', async () => {
  const w = world('inspected');
  const held = await post(w.admin, '/api/price-protection/admin/claims/pp/decide', { decision: 'approved' });
  assert.equal(held.status, 400);
  const refund = await post(w.admin, '/api/returns/admin/ret/transition', { to: 'resolved', resolution: 'refund' });
  const body = await json(refund);
  assert.equal(refund.status, 200, `the returned unit must be refundable: ${JSON.stringify(body)}`);
  assert.equal(body.refund.amount_iqd, 50000);
  const again = await post(w.admin, '/api/price-protection/admin/claims/pp/decide', { decision: 'approved' });
  assert.equal(again.status, 400);
  assert.equal((await json(again)).code, 'PRICE_PROTECTION_RETURN_REVIEW');
  assert.equal(row(w.raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id='wtx_pp_pp'")!.n, 0);
});

test('a rejected return does not hold protection back', async () => {
  const w = world('inspected');
  w.raw.exec("UPDATE return_cases SET state='rejected' WHERE id='ret'");
  const approved = await post(w.admin, '/api/price-protection/admin/claims/pp/decide', { decision: 'approved' });
  assert.equal(approved.status, 200, JSON.stringify(await json(approved)));
});
