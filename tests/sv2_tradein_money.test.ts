/**
 * Services V2 survey — trade-in MONEY CONTROLS, reproduced (ported from the
 * survey worktree onto the default branch for stages S-P0 and S-P2). Each test
 * states the behaviour the store needs («لا تثبت خسائر للشركة», an admin review
 * that can only lower or confirm). LOCAL ONLY.
 *
 * M1 (owner decision 3: a value above the server's figure is the owner's) and
 * M2 (owner decision 2: the credit ends) since S-P0; M3 (the credit only after
 * the device is received, S-P2 «الجهاز أولاً»); M4 and M5 (completion on the
 * new order's delivery, the device booked into stock) land with S-P2's
 * completion. M6 (the customer reads the offer, not the formula) is green on
 * the default branch (DECISIONS rows 219/220).
 *
 * Run: node --import tsx --test tests/sv2_tradein_money.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, json, post, row } from './fixtures/app';
import { STAFF, adminApp, checkoutBody, customerApp, daysAhead, received, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

test('M1 a non-owner admin cannot raise the value above the formula — today any full-scope admin can make the new P1S free', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  const est = row<{ estimated_iqd: number }>(raw, 'SELECT estimated_iqd FROM trade_in_requests WHERE id = ?', id)!.estimated_iqd;
  // 1,500,000 = the whole price of the new device; the formula said `est`.
  const res = await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 1_500_000, reason: '' });
  const accepted = res.status === 200 ? await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/accept`, { offer_no: 1 })) : null;
  assert.notEqual(res.status, 200, `staff raised ${est} → 1,500,000; accepted difference = ${accepted?.request?.difference_iqd}`);
});

test('M2 the trade-in credit expires (coupons.ends_at) — today it is valid for ever while the device and prices age', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`);
  const c = row<{ ends_at: string | null }>(raw, 'SELECT ends_at FROM coupons WHERE trade_in_id = ?', id)!;
  assert.ok(c.ends_at, 'a fixed credit with no end date');
});

test('M3 the credit is not spendable before the old device is in the shop’s hands — not by the request door, not by the checkout, not by SQL', async () => {
  const raw = seed();
  const id = await submitted(raw);
  // Decision 2: nothing is fixed on photos any more.
  const approve = await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`);
  assert.deepEqual([approve.status, (await json(approve)).code], [409, 'TRADE_IN_INTAKE_REQUIRED']);

  // A credit minted on photos BEFORE S-P2 (the cut-over): awaiting payment, its coupon live, no intake.
  const offer = row<{ offer_iqd: number }>(raw, 'SELECT offer_iqd FROM trade_in_requests WHERE id = ?', id)!.offer_iqd;
  raw.exec(`
    INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope,
                         product_id, fulfillment_types, applies_to, cap_scope, max_quantity, stacks, trade_in_id, ends_at)
      VALUES ('cpn_legacy', 'TILEGACY0001', NULL, 'fixed_iqd', ${offer}, 0, 1, 1, 1, '${new Date().toISOString()}', 'cust', 'product',
              'p_p1s', '["direct_sale"]', 'merchandise', 'per_order', 1, 0, '${id}', '${daysAhead(5)}');
    UPDATE trade_in_requests SET status = 'awaiting_payment', final_value_iqd = ${offer}, credit_iqd = ${offer}, difference_iqd = ${1_500_000 - offer},
                                 coupon_id = 'cpn_legacy' WHERE id = '${id}';
  `);
  const a = customerApp(raw);
  const door = await post(a, `/api/trade-in/requests/${id}/checkout`);
  assert.deepEqual([door.status, (await json(door)).code], [409, 'TRADE_IN_DEVICE_NOT_RECEIVED']);
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_m3','cust','p_p1s','','[]','','','','',1)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: 'TILEGACY0001' }));
  assert.deepEqual([placed.status, (await json(placed)).code], [409, 'TRADE_IN_DEVICE_NOT_RECEIVED']);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'cust' AND id <> 'ORD-OLD'"), 0);
  // The database itself (0192 trg_trade_in_credit_needs_intake), whatever door a future change opens.
  assert.throws(
    () => raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('red_x', 'cpn_legacy', 'cust', 'ORD-OLD', 1000)`),
    /TRADE_IN_DEVICE_NOT_RECEIVED/
  );

  // Received: the legacy credit is re-valued at intake (§7) — here the ceiling covers it, so the same
  // coupon (same code) is spendable for a fresh week, and the order goes through.
  await received(raw, id);
  const after = row<{ status: string; coupon_id: string; ceiling_iqd: number }>(raw, 'SELECT status, coupon_id, ceiling_iqd FROM trade_in_requests WHERE id = ?', id)!;
  assert.deepEqual([after.status, after.coupon_id, after.ceiling_iqd], ['awaiting_payment', 'cpn_legacy', offer]);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  assert.equal(pay.coupon_code, 'TILEGACY0001');
  const ok = await post(a, '/api/orders', checkoutBody({ couponCode: 'TILEGACY0001' }));
  assert.equal(ok.status, 200, await ok.clone().text());
  await settle();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 1, 'one coupon for life (row 237)');
});
