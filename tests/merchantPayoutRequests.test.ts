/**
 * PAYOUTS ARE REQUESTS THAT RESERVE — never more than «available», whatever
 * races (docs/MERCHANT_PLATFORM.md §4.3; migration 0121; W2-B).
 *
 *   · a request moves its amount available → reserved in the SAME batch
 *     that writes it, and is refused (nothing written) beyond available;
 *   · requests racing on one balance: the reservations never exceed it;
 *   · the same key replays, the same key for anything else is 409;
 *   · the merchant cancels only a request nobody approved (reserved →
 *     available); another merchant's request is 404;
 *   · approve → paid (with a reference) moves reserved → paid; failed moves
 *     reserved → available; a paid payout never fails; a decision twice is a
 *     replay; every decision is audited;
 *   · the queue, the decisions, the adjustment and the parity report are the
 *     financial admin's only — an assistant is refused and nothing moves;
 *   · an adjustment needs a reason and never takes «available» below zero.
 *
 * Run: node --import tsx --test tests/merchantPayoutRequests.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, type StubUser } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { merchantPayoutRoutes } from '../worker/routes/merchantFinance';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantBuckets } from '../worker/lib/merchantLedger';

function seed(available = 50_000): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('ali','Ali','ali@x.co','h','merchant',NULL), ('zed','Zed','zed@x.co','h','merchant',NULL),
      ('boss','Boss','boss@x.co','h','admin',NULL), ('aide','Aide','aide@x.co','h','admin','assistant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zed','zed','Zed','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D','active'), ('s_zed','m_zed','zed','zed3d','Zed','active');
  `);
  raw.prepare(
    `INSERT INTO merchant_ledger_entries (id,merchant_id,store_id,order_id,kind,bucket,amount_iqd,event_key)
     VALUES ('seed','m_ali','s_ali','ORD-S','sale_gross','available',?,'sale:ORD-S:gross')`
  ).run(available);
  return raw;
}

const ali = (db: unknown, id = 'ali') =>
  stubApp(db, { id, role: 'merchant', email: `${id}@x.co` }, (a) => a.route('/api/merchant/payouts', merchantPayoutRoutes));
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const AIDE: StubUser = { id: 'aide', role: 'admin', email: 'aide@x.co', admin_scope: 'assistant' };
const admin = (db: unknown, user: StubUser = BOSS) =>
  stubApp(db, user, (a) => a.route('/api/admin/community', adminCommunityRoutes));

let n = 0;
const ask = (raw: DatabaseSync, amount: number, extra: Record<string, unknown> = {}, db: unknown = asD1(raw)) =>
  post(ali(db), '/api/merchant/payouts', {
    amount_iqd: amount, channel: 'zaincash', account: '07701234567', idempotencyKey: `req-key-${++n}`, ...extra,
  });
const buckets = (raw: DatabaseSync) => merchantBuckets(asD1(raw), 'm_ali');

test('a request reserves its amount in the same batch — and beyond «available» it is refused with nothing written', async () => {
  const raw = seed();
  const res = await ask(raw, 30_000);
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.payout.state, 'requested');
  assert.deepEqual(body.payout.method, { channel: 'zaincash', label: 'زين كاش', account: '07701234567', holder: '' }, 'the channel name comes from the owner’s list');
  assert.deepEqual(await buckets(raw), { pending: 0, available: 20_000, reserved: 30_000, paid: 0 });

  const over = await ask(raw, 20_001);
  assert.equal(over.status, 400);
  const o = await json(over);
  assert.equal(o.code, 'INSUFFICIENT_BALANCE');
  assert.equal(o.details.available_iqd, 20_000);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payouts'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'merchant.payout_requested'"), 1, 'the refused one left no audit row either');

  // The list shows it, with the channels the form may offer.
  const list = await json(await get(ali(asD1(raw)), '/api/merchant/payouts'));
  assert.equal(list.payouts.length, 1);
  assert.deepEqual(list.buckets, { pending: 0, available: 20_000, reserved: 30_000, paid: 0 });
  assert.ok(list.methods.some((m: { id: string }) => m.id === 'cash_pickup'));
});

test('requests racing on one balance: the reservations never exceed it', async () => {
  const raw = seed(50_000);
  const db = serialD1(raw);
  const results = await Promise.all([1, 2, 3, 4].map(() => ask(raw, 20_000, {}, db)));
  const ok = results.filter((r) => r.status === 201).length;
  assert.equal(ok, 2, '2 × 20,000 fit in 50,000; the others are refused');
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 400, 400]);
  const b = await buckets(raw);
  assert.deepEqual(b, { pending: 0, available: 10_000, reserved: 40_000, paid: 0 });
  assert.ok(b.available >= 0);
});

test('the same key replays the same request; the same key for anything else is 409; bad input has stable codes', async () => {
  const raw = seed();
  const first = await ask(raw, 10_000, { idempotencyKey: 'same-key-001' });
  assert.equal(first.status, 201);
  const again = await ask(raw, 10_000, { idempotencyKey: 'same-key-001' });
  assert.equal(again.status, 200);
  assert.equal((await json(again)).replayed, true);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payouts'), 1);
  assert.equal((await buckets(raw)).reserved, 10_000, 'reserved once');
  const other = await ask(raw, 12_000, { idempotencyKey: 'same-key-001' });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).code, 'IDEMPOTENCY_KEY_REUSED');

  for (const [extra, code] of [
    [{ amount_iqd: 0 }, 'INVALID_AMOUNT'],
    [{ amount_iqd: 12.5 }, 'INVALID_AMOUNT'],
    [{ channel: 'fib' }, 'UNKNOWN_PAYOUT_METHOD'],
    [{ account: '' }, 'PAYOUT_ACCOUNT_REQUIRED'],
    [{ idempotencyKey: 'x' }, 'INVALID_IDEMPOTENCY_KEY'],
  ] as const) {
    const base: Record<string, unknown> = { amount_iqd: 1000, channel: 'zaincash', account: '0770123', idempotencyKey: 'code-key-01' };
    const res = await post(ali(asD1(raw)), '/api/merchant/payouts', { ...base, ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.equal((await json(res)).code, code);
  }
  // Cash pickup needs no account.
  assert.equal((await ask(raw, 1000, { channel: 'cash_pickup', account: '' })).status, 201);
});

test('the merchant cancels a request nobody approved — reserved back to available — and never another merchant’s', async () => {
  const raw = seed();
  const id = (await json(await ask(raw, 15_000))).payout.id;
  const stranger = await post(ali(asD1(raw), 'zed'), `/api/merchant/payouts/${id}/cancel`);
  assert.equal(stranger.status, 404);
  const res = await post(ali(asD1(raw)), `/api/merchant/payouts/${id}/cancel`);
  assert.equal(res.status, 200);
  assert.equal((await json(res)).payout.state, 'cancelled');
  assert.deepEqual(await buckets(raw), { pending: 0, available: 50_000, reserved: 0, paid: 0 });
  assert.equal((await json(await post(ali(asD1(raw)), `/api/merchant/payouts/${id}/cancel`))).replayed, true);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_ledger_entries WHERE kind = 'payout_reversal'"), 2, 'returned once');

  const id2 = (await json(await ask(raw, 5_000))).payout.id;
  assert.equal((await post(admin(asD1(raw)), `/api/admin/community/payouts/${id2}/approve`)).status, 200);
  const late = await post(ali(asD1(raw)), `/api/merchant/payouts/${id2}/cancel`);
  assert.equal(late.status, 409);
  assert.deepEqual(await json(late).then((b) => [b.code, b.details.state]), ['PAYOUT_NOT_CANCELLABLE', 'approved']);
});

test('approve → paid with a reference moves reserved → paid; fail moves reserved → available; a paid payout never fails', async () => {
  const raw = seed();
  const a = admin(asD1(raw));
  const id = (await json(await ask(raw, 20_000))).payout.id;
  const queue = await json(await get(a, '/api/admin/community/payouts'));
  assert.equal(queue.payouts.length, 1);
  assert.equal(queue.payouts[0].merchant.store_name, 'Ali 3D');
  assert.equal(queue.payouts[0].merchant.reserved_iqd, 20_000);
  assert.equal(queue.payouts[0].method.account, '07701234567', 'the admin sees where to transfer');

  const early = await post(a, `/api/admin/community/payouts/${id}/paid`, { reference: 'ZC-778' });
  assert.equal(early.status, 409, 'paid only after approval');
  assert.equal((await json(early)).code, 'PAYOUT_STATE_CONFLICT');
  assert.equal((await post(a, `/api/admin/community/payouts/${id}/approve`)).status, 200);
  const noRef = await post(a, `/api/admin/community/payouts/${id}/paid`, {});
  assert.equal((await json(noRef)).code, 'PAYOUT_REFERENCE_REQUIRED');
  const paid = await json(await post(a, `/api/admin/community/payouts/${id}/paid`, { reference: 'ZC-778' }));
  assert.equal(paid.payout.state, 'paid');
  assert.equal(paid.payout.reference, 'ZC-778');
  assert.deepEqual(await buckets(raw), { pending: 0, available: 30_000, reserved: 0, paid: 20_000 });
  assert.equal((await json(await post(a, `/api/admin/community/payouts/${id}/paid`, { reference: 'ZC-778' }))).replayed, true);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_ledger_entries WHERE bucket = 'paid'"), 1, 'paid once');
  const failPaid = await post(a, `/api/admin/community/payouts/${id}/fail`, { reason: 'bounced' });
  assert.equal(failPaid.status, 409);

  const id2 = (await json(await ask(raw, 10_000))).payout.id;
  const failed = await json(await post(a, `/api/admin/community/payouts/${id2}/fail`, { reason: 'the account number is wrong' }));
  assert.equal(failed.payout.state, 'failed');
  assert.equal(failed.payout.decision_reason, 'the account number is wrong');
  assert.deepEqual(await buckets(raw), { pending: 0, available: 30_000, reserved: 0, paid: 20_000 });
  for (const action of ['admin.merchant_payout_approved', 'admin.merchant_payout_paid', 'admin.merchant_payout_failed']) {
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM audit_log WHERE action = ?', action), 1, action);
  }
  const history = await json(await get(a, '/api/admin/community/payouts?state=paid'));
  assert.deepEqual(history.payouts.map((p: { id: string }) => p.id), [id]);
});

test('the queue, the decisions, adjustments and the parity report are the financial admin’s only — nothing moves for an assistant', async () => {
  const raw = seed();
  const id = (await json(await ask(raw, 20_000))).payout.id;
  const aide = admin(asD1(raw), AIDE);
  for (const [method, path, body] of [
    ['GET', '/api/admin/community/payouts', null],
    ['POST', `/api/admin/community/payouts/${id}/approve`, {}],
    ['POST', `/api/admin/community/payouts/${id}/paid`, { reference: 'X-1' }],
    ['POST', `/api/admin/community/payouts/${id}/fail`, { reason: 'nope nope' }],
    ['POST', '/api/admin/community/merchants/m_ali/adjustment', { amount_iqd: -5000, reason: 'test', idempotencyKey: 'adj-key-01' }],
    ['GET', '/api/admin/community/ledger/parity', null],
  ] as const) {
    const res = method === 'GET' ? await get(aide, path) : await post(aide, path, body ?? {});
    assert.equal(res.status, 403, path);
    assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED', path);
  }
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM merchant_payouts WHERE id = ?', id)!.state, 'requested');
  assert.deepEqual(await buckets(raw), { pending: 0, available: 30_000, reserved: 20_000, paid: 0 });
});

test('an adjustment needs a reason, is audited, replays by key — and never takes «available» below zero', async () => {
  const raw = seed(10_000);
  const a = admin(asD1(raw));
  const path = '/api/admin/community/merchants/m_ali/adjustment';
  assert.equal((await json(await post(a, path, { amount_iqd: 500, reason: '', idempotencyKey: 'adj-key-001' }))).code, 'REASON_REQUIRED');
  const plus = await post(a, path, { amount_iqd: 2500, reason: 'goodwill after a courier loss', idempotencyKey: 'adj-key-001' });
  assert.equal(plus.status, 200, JSON.stringify(await json(plus.clone())));
  assert.equal((await json(await post(a, path, { amount_iqd: 2500, reason: 'goodwill after a courier loss', idempotencyKey: 'adj-key-001' }))).replayed, true);
  assert.equal((await post(a, path, { amount_iqd: 900, reason: 'other', idempotencyKey: 'adj-key-001' })).status, 409);
  const over = await post(a, path, { amount_iqd: -12_501, reason: 'too much', idempotencyKey: 'adj-key-002' });
  assert.equal(over.status, 400);
  assert.equal((await json(over)).code, 'INSUFFICIENT_BALANCE');
  assert.equal((await buckets(raw)).available, 12_500);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.merchant_adjustment'"), 1);
  const parity = await json(await get(a, '/api/admin/community/ledger/parity'));
  assert.deepEqual(parity.mismatches, []);
});
