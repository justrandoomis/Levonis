import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, freshDb, json, post, stubApp } from './fixtures/app';
import { planInventory, type StockMove } from '../worker/lib/inventory';
import { deductOrderStock, planOrderDeduction } from '../worker/lib/orderInventory';
import { getOrderGoods } from '../worker/lib/orderProfit';
import { returnRoutes } from '../worker/routes/returns';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminOrderPriceRoutes, orderPriceRoutes } from '../worker/routes/orderPriceAdjust';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { seedCatalogue, orderBody } from './lib/bundles';

for (const [schema, create] of [['current', freshDb], ['before cost versions', () => dbThrough('0164')], ['before operations', () => dbThrough('0161')]] as const) {
test(`concurrent confirmations cannot lose FIFO cost on ${schema} schema`, async () => {
  const raw = create();
  const db = asD1(raw);
  raw.exec(`
    INSERT INTO users(id,email,name) VALUES ('integration-buyer','integration@example.com','Buyer');
    INSERT INTO products(id,slug,name,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('integration-product','integration-product','Product',50000,9999,2,'BASE');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('integration-old','integration-product','base','',1,1,10000,'received','2026-01-01T00:00:00Z'),
             ('integration-new','integration-product','base','',1,1,20000,'received','2026-02-01T00:00:00Z');
  `);
  for (const id of ['integration-a', 'integration-b']) {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
      payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES (?,'integration-buyer','pending','{}','standard','{}','cod',50000,1400,50000,50000)`).run(id);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'integration-product','Product',1,50000,50000,9999,'snapshot')`).run(`${id}-item`, id);
    const move: StockMove = { product_id: 'integration-product', qty: 1, line_id: `${id}-item`, targets: [{
      scope: 'base', scope_id: '', stock: 2, reserved: 0, low_stock_threshold: null, label: 'Product',
    }] };
    const reserve = await planInventory(db, [move], { kind: 'reserve', operationId: id, orderId: id, actorUserId: null });
    await db.batch(reserve.statements);
  }
  // Both handlers observed the same complete FIFO queue before either batch committed.
  const stale = await planOrderDeduction(db, 'integration-a', null);
  const winner = await planOrderDeduction(db, 'integration-b', null);
  assert.ok(stale && winner);
  await db.batch(winner.statements);
  assert.equal((await getOrderGoods(db, 'integration-b'))!.lines[0].cogs_iqd, 10000);

  await assert.rejects(db.batch(stale.statements), 'the stale queue must abort the whole deduction and allow a fresh retry');
  assert.equal(raw.prepare('SELECT stock FROM products WHERE id=?').get('integration-product')!.stock, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id='integration-a' AND kind='deduct'").get()!.n, 0);
  const retry = await planOrderDeduction(db, 'integration-a', null);
  assert.ok(retry);
  await db.batch(retry.statements);
  assert.equal((await getOrderGoods(db, 'integration-a'))!.lines[0].cogs_iqd, 20000);
  assert.equal(raw.prepare('SELECT SUM(qty_remaining) AS n FROM inventory_lots WHERE product_id=?').get('integration-product')!.n, 0);
});
}


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
  const customer = stubApp(db, { id: buyer, role: 'customer', email: memberOn ? 'r@x.co' : 's@x.co' }, a => {
    a.route('/api/cart', cartRoutes); a.route('/api/orders', orderRoutes);
    a.route('/api/orders', orderPriceRoutes); a.route('/api/returns', returnRoutes);
  });
  const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => {
    a.route('/api/admin/orders', adminOrderPriceRoutes); a.route('/api/returns', returnRoutes);
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

async function prepareReturn(world: Awaited<ReturnType<typeof checkout>>, qty = 2) {
  const { raw, db, customer, admin, id } = world;
  if (raw.prepare('SELECT status FROM orders WHERE id=?').get(id)!.status !== 'delivered') await deductOrderStock(db, id, null);
  raw.prepare("UPDATE orders SET status='delivered',stage='delivered',delivered_at=? WHERE id=?").run(new Date().toISOString(), id);
  const item = raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(id)!;
  const opened = await json(await post(customer, '/api/returns', { orderItemId: item.id, qty, reason: 'defective' }));
  assert.equal(opened.success, true, JSON.stringify(opened));
  const caseId = opened.case.id;
  for (const to of ['assessment', 'approved', 'received', 'inspected']) {
    const step = await json(await post(admin, `/api/returns/admin/${caseId}/transition`, { to }));
    assert.equal(step.success, true, JSON.stringify(step));
  }
  return String(caseId);
}

async function refundGoods(world: Awaited<ReturnType<typeof checkout>>, qty = 2) {
  const caseId = await prepareReturn(world, qty);
  const resolved = await json(await post(world.admin, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' }));
  assert.equal(resolved.success, true, JSON.stringify(resolved));
  return Number(resolved.refund.amount_iqd);
}

for (const member of ['none', 'line', 'unit'] as const) {
  test(`actual checkout ${member} discount and customer-approved price cut reach the goods refund`, async () => {
    const world = await checkout(member);
    await acceptCut(world, 10000);
    const order = world.raw.prepare('SELECT * FROM orders WHERE id=?').get(world.id)!;
    const item = world.raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(world.id)!;
    const snap = JSON.parse(String(order.benefit_snapshot));
    assert.equal(item.line_total_iqd, member === 'unit' ? 45000 : 50000);
    assert.equal(snap.line_discount_iqd, member === 'line' ? 5000 : 0);
    const expectedGoods = Number(item.line_total_iqd) - Number(snap.line_discount_iqd) - 10000;
    const refund = await refundGoods(world);
    assert.equal(refund, expectedGoods, 'accepted final goods price is the refund ceiling; delivery remains excluded');
  });
}

test('actual unit-discount checkout finance counts the member saving once', async () => {
  const world = await checkout('unit');
  const goods = await getOrderGoods(world.db, world.id);
  assert.equal(goods!.lines[0].net_goods_iqd, 45000, 'unit discount is already inside immutable line_total_iqd');
});

test('refund keeps the frozen coupon and points shipping-share policy beside line membership and accepted cut', async () => {
  const world = await checkout('line', { coupon: 1000, points: 500 });
  await acceptCut(world, 10000);
  const order = world.raw.prepare('SELECT * FROM orders WHERE id=?').get(world.id)!;
  const coupon = JSON.parse(String(order.coupon_snapshot)).discount_iqd;
  assert.equal(coupon, 1000);
  assert.ok(Number(order.points_discount_iqd) > 0, 'checkout actually admits the point spend');
  const originalDiscounts = Number(coupon) + Number(order.points_discount_iqd);
  const expected = 50000 - Math.floor(originalDiscounts * 50000 / (Number(order.subtotal_iqd) + Number(order.shipping_iqd))) - 5000 - 10000;
  assert.equal(await refundGoods(world), expected);
});

test('splitting two returned units cannot refund more than returning the whole frozen line', async () => {
  const world = await checkout('none', { coupon: 2 });
  const order = world.raw.prepare('SELECT * FROM orders WHERE id=?').get(world.id)!;
  const wholeRefund = 50000 - Math.floor(2 * 50000 / (Number(order.subtotal_iqd) + Number(order.shipping_iqd)));
  const first = await refundGoods(world, 1);
  const second = await refundGoods(world, 1);
  assert.equal(first + second, wholeRefund, 'the final returned unit receives the exact remainder, never an extra dinar');
});

test('concurrent partial refunds serialize the exact remainder and the loser can retry', async () => {
  const world = await checkout('none', { coupon: 2 });
  const first = await prepareReturn(world, 1), second = await prepareReturn(world, 1);
  const resolve = (id: string) => post(world.admin, `/api/returns/admin/${id}/transition`, { to: 'resolved', resolution: 'refund' });
  const responses = await Promise.all([resolve(first), resolve(second)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  const failed = responses[0].status === 400 ? first : second;
  assert.equal(world.raw.prepare('SELECT state FROM return_cases WHERE id=?').get(failed)!.state, 'inspected');
  const retry = await resolve(failed);
  assert.equal(retry.status, 200, JSON.stringify(await json(retry)));
  assert.equal(world.raw.prepare("SELECT SUM(amount_iqd) n FROM wallet_transactions WHERE id LIKE 'wtx_ret_%'").get()!.n, 49999);
  const replay = await resolve(failed);
  assert.equal(replay.status, 400);
  assert.equal(world.raw.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_ret_%'").get()!.n, 2);
});

test('wallet failure rolls back the refund decision and its quantity cursor before a successful retry', async () => {
  const world = await checkout();
  await acceptCut(world, 10001);
  const first = await prepareReturn(world, 1);
  world.raw.exec(`CREATE TRIGGER fail_refund_credit BEFORE INSERT ON wallet_transactions
    WHEN NEW.id LIKE 'wtx_ret_%' BEGIN SELECT RAISE(ABORT,'synthetic refund credit failure'); END;`);
  const refused = await post(world.admin, `/api/returns/admin/${first}/transition`, { to: 'resolved', resolution: 'refund' });
  assert.equal(refused.status, 500);
  assert.equal(world.raw.prepare('SELECT state FROM return_cases WHERE id=?').get(first)!.state, 'inspected');
  assert.equal(world.raw.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_ret_%'").get()!.n, 0);
  world.raw.exec('DROP TRIGGER fail_refund_credit');
  const retried = await json(await post(world.admin, `/api/returns/admin/${first}/transition`, { to: 'resolved', resolution: 'refund' }));
  assert.equal(retried.success, true, JSON.stringify(retried));
  const second = await refundGoods(world, 1);
  assert.equal(Number(retried.refund.amount_iqd) + second, 39999);
});

test('a previous legacy refund is retained and caps the remaining accepted invoice refund', async () => {
  const world = await checkout();
  await acceptCut(world, 10000);
  const item = world.raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(world.id)!;
  world.raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution)
    VALUES ('legacy-refund',?,?,'buyer',1,'defective','resolved','refund')`).run(world.id, item.id);
  world.raw.prepare(`INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,amount_iqd,exchange_rate_snapshot)
    VALUES ('wtx_ret_legacy-refund','buyer','deposit','USD',1785,'approved',25000,1400)`).run();
  const before = world.raw.prepare("SELECT * FROM wallet_transactions WHERE id='wtx_ret_legacy-refund'").get();
  assert.equal(await refundGoods(world, 1), 15000, 'old gross credit consumes part of the new whole-line cap');
  assert.deepEqual(world.raw.prepare("SELECT * FROM wallet_transactions WHERE id='wtx_ret_legacy-refund'").get(), before);
  assert.equal(world.raw.prepare("SELECT SUM(amount_iqd) n FROM wallet_transactions WHERE id LIKE 'wtx_ret_%'").get()!.n, 40000);
});

test('legacy cents-only prior refund is included in the remaining dinar ceiling', async () => {
  const world = await checkout();
  await acceptCut(world, 10000);
  const item = world.raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(world.id)!;
  world.raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution)
    VALUES ('legacy-cents',?,?,'buyer',1,'defective','resolved','refund')`).run(world.id, item.id);
  world.raw.prepare(`INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status)
    VALUES ('wtx_ret_legacy-cents','buyer','deposit','USD',1786,'approved')`).run();
  const order = world.raw.prepare('SELECT exchange_rate FROM orders WHERE id=?').get(world.id)!;
  const oldValue = Math.floor(1786 * Number(order.exchange_rate) / 100);
  assert.equal(await refundGoods(world, 1), 40000 - oldValue);
  assert.equal(world.raw.prepare("SELECT amount_iqd FROM wallet_transactions WHERE id='wtx_ret_legacy-cents'").get()!.amount_iqd, null);
});

test('accepted cut into shipping cannot refund goods above the entire final invoice', async () => {
  const world = await checkout('none', { points: 500 });
  const order = world.raw.prepare('SELECT total_iqd FROM orders WHERE id=?').get(world.id)!;
  await acceptCut(world, Number(order.total_iqd) - 1);
  assert.equal(await refundGoods(world), 0, 'the accepted cut exhausted all goods; the remaining dinar is delivery');
});

test('a legacy refund without monetary evidence refuses before another credit or decision', async () => {
  const world = await checkout();
  const item = world.raw.prepare('SELECT * FROM order_items WHERE order_id=?').get(world.id)!;
  world.raw.prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution)
    VALUES ('legacy-unknown',?,?,'buyer',1,'defective','resolved','refund')`).run(world.id, item.id);
  const next = await prepareReturn(world, 1);
  const refused = await post(world.admin, `/api/returns/admin/${next}/transition`, { to: 'resolved', resolution: 'refund' });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'RETURN_REFUND_REVIEW_REQUIRED');
  assert.equal(world.raw.prepare('SELECT state FROM return_cases WHERE id=?').get(next)!.state, 'inspected');
  assert.equal(world.raw.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_ret_%'").get()!.n, 0);
});

test('a positive refund smaller than one wallet cent waits for review without resolving or restoring stock', async () => {
  const world = await checkout();
  const order = world.raw.prepare('SELECT total_iqd,shipping_iqd FROM orders WHERE id=?').get(world.id)!;
  assert.equal(order.shipping_iqd, 5000);
  await acceptCut(world, Number(order.total_iqd) - 5001);
  const caseId = await prepareReturn(world);
  const beforeStock = world.raw.prepare("SELECT stock FROM products WHERE id='p_pla'").get()!.stock;
  const refused = await post(world.admin, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'RETURN_REFUND_REVIEW_REQUIRED');
  assert.equal(world.raw.prepare('SELECT state FROM return_cases WHERE id=?').get(caseId)!.state, 'inspected');
  assert.equal(world.raw.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_ret_%'").get()!.n, 0);
  assert.equal(world.raw.prepare("SELECT stock FROM products WHERE id='p_pla'").get()!.stock, beforeStock);
});
