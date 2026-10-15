/**
 * TRADE-IN V2 CODE ON A DATABASE STILL AT 0191 (CLAUDE.md rule 2; S-P2 spec §6.1, §8).
 *
 * A manual redeploy of an older database, or the minutes before workflow 7's
 * migration step, runs this code without migration 0192. Then:
 *   - the schema probe says «absent» (and asks again after a minute, never caching a failure for good);
 *   - every existing door behaves as it did before S-P2: a request is drafted, sent,
 *     approved and its credit spent at checkout with no intake;
 *   - every new door answers 503 TRADE_IN_V2_NOT_INSTALLED, never a 500.
 *
 * Run: node --import tsx --test tests/sv2_p2_deploy_ahead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, json, post, row } from './fixtures/app';
import { forgetTradeInV2, tradeInV2Installed } from '../worker/lib/tradeInSchema';
import { adminApp, checkoutBody, customerApp, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

test('the probe: absent at 0191, present at 0192', async () => {
  const old = asD1(seed({ through: '0191' }));
  assert.equal(await tradeInV2Installed(old), false);
  forgetTradeInV2(old);
  const fresh = asD1(seed());
  assert.equal(await tradeInV2Installed(fresh), true);
  assert.equal(await tradeInV2Installed(fresh), true, 'remembered');
});

test('at 0191 the old flow runs whole: submit, approve without intake, spend the credit at checkout', async () => {
  const raw = seed({ through: '0191' });
  const id = await submitted(raw);
  const approved = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(approved.request.status, 'awaiting_payment', JSON.stringify(approved));
  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  assert.ok(pay.coupon_code, JSON.stringify(pay));
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s_old','cust','p_p1s','','[]','','','','',1)`);
  const placed = await post(a, '/api/orders', checkoutBody({ couponCode: pay.coupon_code }));
  assert.equal(placed.status, 200, await placed.clone().text());
  await settle();
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE state = 'active'"), 1);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'awaiting_payment');
});

test('at 0191 every new door answers 503 TRADE_IN_V2_NOT_INSTALLED — never a 500; the retired inspect door still works', async () => {
  const raw = seed({ through: '0191' });
  const id = await submitted(raw);
  for (const [path, body] of [
    ['intake', { serial: 'SN0000001', handover: 'store' }],
    ['device-returned', {}],
  ] as const) {
    const res = await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/${path}`, body);
    assert.deepEqual([res.status, (await json(res)).code], [503, 'TRADE_IN_V2_NOT_INSTALLED'], path);
  }
  const entry = await (await import('./fixtures/app')).get(customerApp(raw), '/api/trade-in/entry?product_id=p_p1s');
  assert.deepEqual([entry.status, (await json(entry)).code], [503, 'TRADE_IN_V2_NOT_INSTALLED']);
  // The old «بدأ الفحص» is the old flow's door on an old database.
  const inspected = await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/inspect`);
  assert.equal(inspected.status, 200, await inspected.clone().text());
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'under_review');
});
