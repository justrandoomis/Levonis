/**
 * A SUSPENDED STORE OR MERCHANT: THE GOODS STILL ARRIVE, THE MONEY WAITS
 * (owner decision, DECISIONS row 137).
 *
 * While Levonis has suspended a store or its merchant:
 *   - existing orders still move through to «delivered» — the customer gets
 *     what they paid for;
 *   - NO money is released to the merchant: a store order's «استلمت طلبي» is
 *     recorded but its credit stays pending, the three-day sweep skips it; a
 *     custom order's confirmation is recorded (`customer_confirmed`) and the
 *     money stays in escrow, the auto-confirm skips it;
 *   - payout requests are refused 409 STORE_SUSPENDED / MERCHANT_SUSPENDED;
 *   - when the suspension lifts, the sweeps release what is due.
 *
 * Run: node --import tsx --test tests/suspendedMerchantMoneyHold.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, json, row, pending } from './fixtures/app';
import {
  storeWorld,
  openStore,
  buyerApp,
  storeAdminApp,
  buyStoreOrder,
  deliverStoreOrder,
  seedB,
  asB,
  acceptedB,
  MemoryBucket,
} from './fixtures/reviewE2eWorld';
import { limitD1 } from './fixtures/d1Limits';
import { releaseDueStoreCredits } from '../worker/lib/storeOrderOps';
import { runCommunitySweeps } from '../worker/lib/communityRequests';
import type { Env } from '../worker/lib/types';

const settle = () => Promise.allSettled(pending.splice(0));
const LATER = () => new Date(Date.now() + 4 * 86_400_000).toISOString();

test('store suspended: the order still reaches delivered, the receipt is recorded, no money moves, payouts refused — and the lift releases it', async () => {
  const { raw, db } = storeWorld();
  const { m, store, product } = await openStore(db);
  const id = await buyStoreOrder(db, product, 'susp-order-1', 2);
  await settle();

  const adm = storeAdminApp(db);
  const sus = await post(adm, `/api/admin/community/stores/${store.id}/status`, { status: 'suspended', reason: 'under review' });
  assert.equal(sus.status, 200, JSON.stringify(await json(sus)));

  // The customer gets the goods: the merchant can still move the order.
  await deliverStoreOrder(m, id);
  await settle();
  const cr = await json(await post(buyerApp(db), `/api/orders/${id}/confirm-receipt`, {}));
  assert.equal(cr.success, true, JSON.stringify(cr));
  assert.equal(cr.released, false, 'no release while suspended');
  assert.ok(row<{ r: string | null }>(raw, 'SELECT receipt_confirmed_at AS r FROM orders WHERE id = ?', id)!.r, 'the receipt is recorded');

  const sweep = await releaseDueStoreCredits({ DB: db } as unknown as Env, LATER());
  assert.equal(sweep.released, 0);
  assert.ok(sweep.frozen >= 1, JSON.stringify(sweep));
  const held = (await json(await get(m, '/api/merchant/finance/summary'))).summary;
  assert.equal(held.available, 0);
  assert.ok(held.pending > 0);

  const methods = (await json(await get(m, '/api/merchant/payouts'))).methods;
  const pay = await post(m, '/api/merchant/payouts', { amount_iqd: 1_000, idempotencyKey: 'susp-payout-1', channel: methods[0].id, account: '0770000' });
  assert.equal(pay.status, 409);
  assert.equal((await json(pay)).code, 'STORE_SUSPENDED');

  // The suspension lifts: the next run releases what is due, and payouts open.
  const lift = await post(adm, `/api/admin/community/stores/${store.id}/status`, { status: 'active', reason: 'cleared' });
  assert.equal(lift.status, 200, JSON.stringify(await json(lift)));
  const after = await releaseDueStoreCredits({ DB: db } as unknown as Env, LATER());
  assert.equal(after.released, 1);
  const freed = (await json(await get(m, '/api/merchant/finance/summary'))).summary;
  assert.equal(freed.pending, 0);
  assert.equal(freed.available, held.pending);
  const pay2 = await post(m, '/api/merchant/payouts', { amount_iqd: 1_000, idempotencyKey: 'susp-payout-2', channel: methods[0].id, account: '0770000' });
  assert.equal(pay2.status, 201, JSON.stringify(await json(pay2)));
});

test('merchant suspended: payout requests are refused 409 MERCHANT_SUSPENDED', async () => {
  const { raw, db } = storeWorld();
  const { m } = await openStore(db);
  raw.exec("UPDATE community_merchants SET status = 'suspended' WHERE user_id = 'ali'");
  const methods = (await json(await get(m, '/api/merchant/payouts'))).methods;
  const pay = await post(m, '/api/merchant/payouts', { amount_iqd: 1_000, idempotencyKey: 'susp-payout-3', channel: methods[0].id, account: '0770000' });
  assert.equal(pay.status, 409);
  assert.equal((await json(pay)).code, 'MERCHANT_SUSPENDED');
});

test('custom order, merchant suspended: the confirmation is recorded, the money stays in escrow, the sweep waits — and releases after the lift', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  assert.equal((await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`)).status, 200);
  raw.exec("UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'");

  const cf = await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/confirm`);
  const body = await json(cf);
  assert.equal(cf.status, 200, JSON.stringify(body));
  assert.equal(body.released, false);
  assert.equal(body.held, true);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', a.orderId)!.state, 'customer_confirmed');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', a.escrowId)!.state, 'held');
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM merchant_ledger_entries WHERE escrow_id = ?', a.escrowId)!.n, 0);
  // A second tap is the same answer.
  assert.equal((await json(await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/confirm`))).held, true);

  const env = { DB: limitD1(raw) } as unknown as Env;
  const during = await runCommunitySweeps(env, LATER());
  assert.equal(during.auto_completed, 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', a.escrowId)!.state, 'held');

  raw.exec("UPDATE community_merchants SET status = 'active' WHERE id = 'm1'");
  const lifted = await runCommunitySweeps(env, LATER());
  assert.equal(lifted.auto_completed, 1, JSON.stringify(lifted));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', a.escrowId)!.state, 'released');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', a.orderId)!.state, 'completed');
  assert.ok(row<{ c: string | null }>(raw, 'SELECT confirmed_at AS c FROM community_orders WHERE id = ?', a.orderId)!.c, 'the customer\'s confirmation stamp is kept');
});

test('custom order, store suspended: the auto-confirm date passes and nothing is released until the lift', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`);
  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'");
  const env = { DB: limitD1(raw) } as unknown as Env;
  const farLater = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const during = await runCommunitySweeps(env, farLater);
  assert.equal(during.auto_completed, 0);
  assert.ok(during.auto_complete_skipped >= 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', a.escrowId)!.state, 'held');
  raw.exec("UPDATE merchant_stores SET status = 'active' WHERE id = 's1'");
  assert.equal((await runCommunitySweeps(env, farLater)).auto_completed, 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', a.orderId)!.state, 'completed');
});

test('the fence is inside the release itself: a customer or system release of a suspended merchant\'s escrow moves nothing; an admin decision still can', async () => {
  const { releaseEscrow } = await import('../worker/lib/escrowOps');
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'");
  const db = limitD1(raw);
  for (const actorRole of ['customer', 'system'] as const) {
    const r = await releaseEscrow(db, { escrowId: a.escrowId, actorId: null, actorRole, idempotencyKey: `fence-${actorRole}` });
    assert.deepEqual(r, { ok: false, reason: 'MERCHANT_SUSPENDED' });
  }
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', a.escrowId)!.state, 'held');
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM merchant_ledger_entries WHERE escrow_id = ?', a.escrowId)!.n, 0);
  const admin = await releaseEscrow(db, { escrowId: a.escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'fence-admin' });
  assert.equal(admin.ok, true, JSON.stringify(admin));
});
