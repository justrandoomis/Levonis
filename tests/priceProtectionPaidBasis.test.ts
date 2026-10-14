import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, json, post, stubApp } from './fixtures/app';
import { priceProtectionRoutes } from '../worker/routes/returns';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { repriceV2 } from './fixtures/v2Publish';

async function checkout(member: 'none' | 'unit' | 'line' = 'none', discounts: { coupon?: number; points?: number } = {}) {
  const raw = seedCatalogue(), baseDb = asD1(raw);
  // D1 serializes transactions; the in-memory adapter yields per statement.
  // Serialize its batches so simultaneous route calls exercise the SQL fence,
  // rather than SQLite's artificial nested-transaction refusal.
  let tail: Promise<unknown> = Promise.resolve();
  const db = { prepare: baseDb.prepare.bind(baseDb), batch: (statements: D1PreparedStatement[]) => {
    const result = tail.then(() => baseDb.batch(statements));
    tail = result.catch(() => undefined);
    return result;
  } } as unknown as D1Database;
  const memberOn = member !== 'none';
  const buyer = memberOn ? 'u_pro' : 'buyer';
  raw.exec(`UPDATE users SET email='boss@x.co' WHERE id='boss';
    UPDATE admin_settings SET value='{"paused":false,"since":null}' WHERE key='proPause';
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('approved-pro','u_pro',1,'Rami','+9647701234570','Baghdad, Karrada 15','','approved');
    UPDATE products SET product_cost_iqd=10000 WHERE id='p_pla';
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('refund-lot','p_pla','base','',6,6,10000,'received','2026-01-01T00:00:00Z');`);
  if (discounts.coupon) raw.prepare("INSERT INTO coupons(id,code,kind,value,min_total_iqd,active) VALUES ('integration-coupon','INTEGRATION','fixed_iqd',?,0,1)").run(discounts.coupon);
  if (discounts.points) raw.prepare("INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status) VALUES ('integration-points',?,'deposit','POINT',?,'approved')").run(buyer, discounts.points);
  await publishSeededV2(raw); // the clean start (A.12.1): the serialising wrapper hides the raw rows from stubApp
  const customer = stubApp(db, { id: buyer, role: 'customer', email: memberOn ? 'r@x.co' : 's@x.co' }, a => {
    a.route('/api/cart', cartRoutes); a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes); a.route('/api/price-protection', priceProtectionRoutes);
  });
  const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => {
    a.route('/api/admin/orders', adminOrderPriceRoutes); a.route('/api/price-protection', priceProtectionRoutes);
    a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
  });
  if (memberOn) {
    const rule = await json(await post(admin, '/api/admin/membership-benefits', {
      tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent',
      percent: 10, max_discount_iqd: 10000, cap_scope: member === 'unit' ? 'per_unit' : 'per_order', label: 'Integration membership',
    }));
    assert.equal(rule.success, true, JSON.stringify(rule));
  }
  const added = await json(await post(customer, '/api/cart/items', { productId: 'p_pla', qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(customer, '/api/orders', orderBody({ addressId: memberOn ? 'addr_o' : 'addr_b', couponCode: discounts.coupon ? 'INTEGRATION' : undefined, usePoints: !!discounts.points })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const id = String(placed.order.id);
  return { raw, db, customer, admin, id };
}

async function acceptCut(world: Awaited<ReturnType<typeof checkout>>, cut: number) {
  const { raw, admin, customer, id } = world;
  const order = raw.prepare('SELECT * FROM orders WHERE id=?').get(id)!;
  const proposed = await json(await post(admin, `/api/admin/orders/${id}/price-adjustment`, {
    new_total_iqd: Number(order.total_iqd) - cut, reason: 'Agreed goods price correction', idempotencyKey: `adjust-${id}`,
  }));
  assert.equal(proposed.success, true, JSON.stringify(proposed));
  const approved = await json(await post(customer, `/api/orders/${id}/price-adjustment/${proposed.adjustment.id}/approve`));
  assert.equal(approved.success, true, JSON.stringify(approved));
}


/** Delivers the order, then the owner lowers the price — through the V2 writer (the engine locks refuse a raw UPDATE). */
async function deliverAndLower(w: Awaited<ReturnType<typeof checkout>>, price: number) {
  w.raw.prepare("UPDATE orders SET status='delivered',stage='delivered',delivered_at=? WHERE id=?").run(new Date().toISOString(), w.id);
  await repriceV2(w.raw, 'p_pla', price);
  return w.raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(w.id)!;
}
const claim = (w: Awaited<ReturnType<typeof checkout>>, itemId: unknown) => post(w.customer, '/api/price-protection/claims', { orderItemId: itemId });
const approve = (w: Awaited<ReturnType<typeof checkout>>, claimId: unknown) => post(w.admin, `/api/price-protection/admin/claims/${claimId}/decide`, { decision: 'approved' });

for (const member of ['line', 'unit'] as const) {
  test(`actual ${member}-applied membership does not turn a higher price into a protected drop`, async () => {
    const w = await checkout(member);
    const item = await deliverAndLower(w, 24000);
    const res = await claim(w, item.id);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'NO_ELIGIBLE_DROP');
    assert.equal(w.raw.prepare('SELECT COUNT(*) n FROM price_protection_claims').get()!.n, 0);
  });
}

test('a real line-membership price drop records and pays only the difference from the frozen paid price', async () => {
  const w = await checkout('line');
  const item = await deliverAndLower(w, 20000);
  // Today's rules must never re-decide the member saving frozen at checkout.
  w.raw.exec("UPDATE membership_benefit_rules SET percent=50 WHERE benefit_type='product_discount'");
  const res = await json(await claim(w, item.id));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.claim.original_unit_iqd, 22500);
  assert.equal(res.claim.eligible_unit_iqd, 2500);
  const paid = await json(await approve(w, res.claim.id));
  assert.equal(paid.success, true, JSON.stringify(paid));
  assert.equal(paid.credit.amount_iqd, 5000);
});

test('customer-accepted price cuts reach protection eligibility and a genuine remaining drop', async () => {
  const w = await checkout();
  await acceptCut(w, 10000);
  const item = await deliverAndLower(w, 22000);
  const noDrop = await claim(w, item.id);
  assert.equal(noDrop.status, 400);
  assert.equal((await json(noDrop)).code, 'NO_ELIGIBLE_DROP');
  await repriceV2(w.raw, 'p_pla', 15000);
  const res = await json(await claim(w, item.id));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.claim.original_unit_iqd, 20000);
  const paid = await json(await approve(w, res.claim.id));
  assert.equal(paid.credit.amount_iqd, 10000);
});

for (const observed of [24000, 20000]) {
  test(`a legacy pending gross-membership claim at ${observed} is capped again before payment`, async () => {
    const w = await checkout('line');
    const item = await deliverAndLower(w, observed);
    w.raw.prepare(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
      VALUES('legacy','u_pro',?,?,25000,?,2,'requested')`).run(w.id, item.id, observed);
    const res = await approve(w, 'legacy');
    if (observed === 24000) {
      assert.equal(res.status, 400);
      assert.equal((await json(res)).code, 'NO_ELIGIBLE_DROP');
      assert.equal(w.raw.prepare("SELECT state FROM price_protection_claims WHERE id='legacy'").get()!.state, 'requested');
    } else {
      assert.equal(res.status, 200);
      assert.equal((await json(res)).credit.amount_iqd, 5000);
    }
    assert.equal(w.raw.prepare("SELECT COALESCE(SUM(amount_iqd),0) n FROM wallet_transactions WHERE id='wtx_pp_legacy'").get()!.n, observed === 24000 ? 0 : 5000);
  });
}

test('prior paid protection remains immutable and consumes the corrected eligible difference', async () => {
  const w = await checkout('line');
  const item = await deliverAndLower(w, 20000);
  w.raw.prepare(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state,credited_iqd)
    VALUES('prior','u_pro',?,?,25000,24000,2,'credited',2000)`).run(w.id, item.id);
  w.raw.prepare(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
    VALUES('pending','u_pro',?,?,25000,20000,2,'requested')`).run(w.id, item.id);
  const before = w.raw.prepare("SELECT * FROM price_protection_claims WHERE id='prior'").get();
  const res = await json(await approve(w, 'pending'));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.credit.amount_iqd, 3000);
  assert.deepEqual(w.raw.prepare("SELECT * FROM price_protection_claims WHERE id='prior'").get(), before);
});

for (const discounts of [{ coupon: 10000 }, { points: 10000 }, { coupon: 5000, points: 5000 }]) {
  test(`protection uses the established frozen customer discount allocation for ${JSON.stringify(discounts)}`, async () => {
    const w = await checkout('none', discounts);
    // Since the clean start every line is a V2 (engine) line, and its rule calls a drop below one 1,000 step
    // FX_ONLY_DROP (protectionBasis.ts): the new price is low enough that the discounted paid price still
    // drops by more than a step, so the allocation itself is what this test measures.
    const item = await deliverAndLower(w, 15000);
    const order = w.raw.prepare('SELECT * FROM orders WHERE id=?').get(w.id)!;
    const coupon = JSON.parse(String(order.coupon_snapshot ?? 'null'))?.discount_iqd ?? 0;
    const discount = Number(coupon) + Number(order.points_discount_iqd);
    const paid = 50000 - Math.floor(discount * 50000 / (Number(order.subtotal_iqd) + Number(order.shipping_iqd)));
    const res = await json(await claim(w, item.id));
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(res.claim.original_unit_iqd, Math.floor(paid / 2));
    const credited = await json(await approve(w, res.claim.id));
    assert.equal(credited.credit.amount_iqd, Math.max(0, Math.floor(paid / 2) - 15000) * 2);
  });
}

test('a large frozen coupon cannot turn a low-paid invoice into an oversized protection payout', async () => {
  const w = await checkout('none', { coupon: 50000 });
  const item = await deliverAndLower(w, 10000);
  const order = w.raw.prepare('SELECT * FROM orders WHERE id=?').get(w.id)!;
  assert.equal(order.total_iqd, 5000);
  const res = await claim(w, item.id);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'NO_ELIGIBLE_DROP');
  // A request accepted by the former gross-price reader cannot bypass this.
  w.raw.prepare(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
    VALUES('legacy-coupon','buyer',?,?,25000,10000,2,'requested')`).run(w.id, item.id);
  assert.equal((await approve(w, 'legacy-coupon')).status, 400);
  assert.equal(w.raw.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE id='wtx_pp_legacy-coupon'").get()!.n, 0);
});

test('a fully discounted invoice cannot generate a new wallet protection credit', async () => {
  const w = await checkout('none', { coupon: 55000 });
  const item = await deliverAndLower(w, 10000);
  assert.equal(w.raw.prepare('SELECT total_iqd FROM orders WHERE id=?').get(w.id)!.total_iqd, 0);
  const res = await claim(w, item.id);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'NO_ELIGIBLE_DROP');
});
