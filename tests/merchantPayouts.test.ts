/**
 * A MERCHANT PAYOUT PAYS AVAILABLE MONEY ONCE — audit 02 B3 + B14 + B20,
 * audit 04 B1.
 *
 *   · "available" was `SUM(state = 'available')` while payouts are written
 *     `state = 'paid'`, so it never went down: the same 10,000 could be paid
 *     out any number of times, sequentially — not even a race was needed;
 *   · the payout route answered EVERY failed insert with «already recorded»;
 *   · "paid out" summed every `paid` row, and escrow writes the platform's
 *     commission as one, so the merchant's tile showed money Levonis kept.
 *
 * Run: node --import tsx --test tests/merchantPayouts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count } from './fixtures/app';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantBalance } from '../worker/lib/escrowOps';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('ali','Ali','ali@x.co','h','merchant'),
      ('zain','Zain','zain@x.co','h','merchant'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active');
    INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,idempotency_key)
      VALUES ('pl1','m_ali','sale_credit',10000,'available','ORD-X','sale:ORD-X');
  `);
}

const adminApp = (db: D1Database, user: { id: string; email: string } = { id: 'boss', email: 'boss@x.co' }) =>
  stubApp(db, { ...user, role: 'admin' }, (a) => a.route('/api/admin/community', adminCommunityRoutes));
const payout = (raw: DatabaseSync, body: Record<string, unknown>, merchant = 'm_ali') =>
  post(adminApp(asD1(raw)), `/api/admin/community/merchants/${merchant}/payout`, body);
const payouts = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) n FROM merchant_payout_ledger WHERE kind = 'payout'");

test('B3 a payout lowers «available», so the same balance cannot be paid out twice', async () => {
  const raw = freshDb();
  seed(raw);
  const first = await json(await payout(raw, { amount_iqd: 10000, idempotencyKey: 'payout-key-1' }));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.replayed, false);
  assert.equal(first.balance.available_iqd, 0, 'nothing left to pay');
  assert.equal(first.balance.paid_iqd, -10000);

  const second = await payout(raw, { amount_iqd: 10000, idempotencyKey: 'payout-key-2' });
  const body = await json(second);
  assert.equal(second.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'INSUFFICIENT_BALANCE');
  assert.equal(body.details.available_iqd, 0);
  assert.equal(payouts(raw), 1, 'one payout of one balance');

  // A partial payout leaves exactly the rest.
  raw.exec(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,idempotency_key)
            VALUES ('pl2','m_ali','sale_credit',7000,'available','ORD-Y','sale:ORD-Y')`);
  const part = await json(await payout(raw, { amount_iqd: 3000, idempotencyKey: 'payout-key-3' }));
  assert.equal(part.balance.available_iqd, 4000);
  assert.equal((await payout(raw, { amount_iqd: 4001, idempotencyKey: 'payout-key-4' })).status, 400, 'never more than available');
});

test('B14 the SAME payout replays; the same key for anything else is 409; any other failure is a failure', async () => {
  const raw = freshDb();
  seed(raw);
  assert.equal((await json(await payout(raw, { amount_iqd: 4000, idempotencyKey: 'payout-key-9' }))).replayed, false);

  const again = await json(await payout(raw, { amount_iqd: 4000, idempotencyKey: 'payout-key-9' }));
  assert.equal(again.success, true);
  assert.equal(again.replayed, true, 'a double click is the same payout');
  assert.equal(payouts(raw), 1);

  const otherAmount = await payout(raw, { amount_iqd: 5000, idempotencyKey: 'payout-key-9' });
  assert.equal(otherAmount.status, 409);
  assert.equal((await json(otherAmount)).code, 'IDEMPOTENCY_KEY_REUSED');

  raw.exec(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,idempotency_key)
            VALUES ('plz','m_zain','sale_credit',9000,'available','ORD-Z','sale:ORD-Z')`);
  const otherMerchant = await payout(raw, { amount_iqd: 4000, idempotencyKey: 'payout-key-9' }, 'm_zain');
  assert.equal(otherMerchant.status, 409, 'another merchant’s key is not this payout');
  assert.equal(payouts(raw), 1);

  // A write that fails for a reason that is not the key — here the foreign
  // key on admin_id, a session user with no users row — is NOT "already recorded".
  const ghost = await post(
    adminApp(asD1(raw), { id: 'ghost', email: 'ghost@x.co' }),
    '/api/admin/community/merchants/m_ali/payout',
    { amount_iqd: 1000, idempotencyKey: 'payout-key-10' }
  );
  const ghostBody = await json(ghost);
  assert.equal(ghost.status, 500, JSON.stringify(ghostBody));
  assert.notEqual(ghostBody.replayed, true, 'nothing was written, and the admin is not told it was');
  assert.equal(payouts(raw), 1);

  const unknown = await payout(raw, { amount_iqd: 1000, idempotencyKey: 'payout-key-11' }, 'm_nobody');
  assert.equal(unknown.status, 404);
});

test('B20 «paid out» counts payouts only — never the platform’s commission rows', async () => {
  const raw = freshDb();
  seed(raw);
  // What an escrow release writes: the receivable, and the commission as `paid`.
  raw.exec(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,community_order_id,idempotency_key) VALUES
      ('esc_c','m_ali','community_order_credit',45000,'available',NULL,'credit:e1'),
      ('esc_f','m_ali','commission',-5000,'paid',NULL,'fee:e1')`);
  const db = asD1(raw);
  assert.deepEqual(await merchantBalance(db, 'm_ali'), { available_iqd: 55000, pending_iqd: 0, paid_iqd: 0 });

  await payout(raw, { amount_iqd: 20000, idempotencyKey: 'payout-key-20' });
  assert.deepEqual(await merchantBalance(db, 'm_ali'), { available_iqd: 35000, pending_iqd: 0, paid_iqd: -20000 });

  // The merchant's own money screen reads the same figures.
  const mine = await json(await get(stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => a.route('/api/merchant', merchantRoutes)), '/api/merchant/payouts'));
  assert.deepEqual(mine.balance, { available_iqd: 35000, pending_iqd: 0, paid_iqd: -20000 });
  assert.ok(mine.entries.every((e: { state: string }) => typeof e.state === 'string'), 'every row says what state it is in');
});
