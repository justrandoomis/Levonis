/**
 * THE WAVE-1 MONEY REVIEW, COMMUNITY ESCROW (findings F1, F2, F3, F8) — each
 * reviewer probe, inverted: the race or the stuck row that reproduced the
 * defect now proves it cannot happen.
 *
 *   F1  the auto-confirm sweep paid out an escrow a dispute had just frozen;
 *       only an admin may settle a disputed escrow, and the confirmation and
 *       the sweep release only while the order is still delivered-and-waiting.
 *   F2  the customer's cancel racing the merchant's «ابدأ العمل» refunded the
 *       money while the job went live; refund and cancel are one batch, and
 *       work starts only on held money.
 *   F3  a hundred un-settleable due orders starved the auto-confirm sweep.
 *   F8  an acceptance whose batch committed but whose response was lost had
 *       its hold released under a live escrow.
 *
 * Real routes, real migrations; D1's single-writer model is `serialD1`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, json, count, row, all, spendable, holds, type Mount } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { runCommunitySweeps } from '../worker/lib/communityRequests';
import { merchantBalance, releaseEscrow, refundEscrow, releaseEscrowReservation } from '../worker/lib/escrowOps';

const mount: Mount = (a) => {
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};
const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Ali','a@x.co','h','customer'),
      ('owner2','Omar','o@x.co','h','customer'), ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','owner2','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',2,'${FUTURE}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('o1','r1','m1','s1',50000,'pending'), ('o2','r1','m2','s2',60000,'pending');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt1','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','test funding')`);
  return raw;
}

const as = (raw: DatabaseSync, id: string, role: 'customer' | 'admin' = 'customer', db: unknown = asD1(raw)) =>
  stubApp(db, { id, role, email: `${id}@x.co` }, mount);

async function accepted(raw: DatabaseSync) {
  const acc = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const orderId = (await json(acc)).order.id as string;
  const escrowId = row<{ id: string }>(raw, 'SELECT id FROM community_escrows WHERE community_order_id = ?', orderId)!.id;
  return { orderId, escrowId };
}

async function delivered(raw: DatabaseSync) {
  const a = await accepted(raw);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${a.orderId}/start`)).status, 200);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${a.orderId}/delivered`)).status, 200);
  return a;
}

const credited = (raw: DatabaseSync) =>
  row<{ s: number | null }>(raw, "SELECT SUM(amount_iqd) AS s FROM merchant_payout_ledger WHERE merchant_id='m1' AND kind='community_order_credit'")?.s ?? 0;
const escrowState = (raw: DatabaseSync, id: string) => row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', id)!.state;
const orderState = (raw: DatabaseSync, id: string) => row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', id)!.state;

// ===================================================================== F1

test('F1 (probe C1 inverted): the auto-confirm sweep racing the customer’s dispute never pays over the dispute — the admin still decides it', async () => {
  const raw = seed();
  const { orderId, escrowId } = await delivered(raw);
  const due = row<{ a: string }>(raw, 'SELECT auto_complete_at a FROM community_orders WHERE id = ?', orderId)!.a;
  const after = new Date(Date.parse(due) + 60_000).toISOString();

  const db = serialD1(raw);
  const [report, disputed] = await Promise.all([
    runCommunitySweeps({ DB: db } as never, after),
    post(as(raw, 'buyer', 'customer', db), `/api/marketplace/orders/${orderId}/dispute`, { description: 'The part arrived broken in two' }),
  ]);
  assert.equal(disputed.status, 201, JSON.stringify(await json(disputed.clone())));
  assert.equal(report.auto_completed, 0, 'the sweep completed nothing');
  assert.equal(escrowState(raw, escrowId), 'disputed', 'the money stays frozen');
  assert.equal(orderState(raw, orderId), 'disputed');
  assert.equal(credited(raw), 0, 'the merchant was NOT paid over the open dispute');
  const kinds = all<{ kind: string }>(raw, 'SELECT kind FROM community_escrow_events WHERE escrow_id = ? ORDER BY rowid', escrowId).map((e) => e.kind);
  assert.ok(!kinds.includes('release'), `no release event: ${kinds}`);
  assert.equal(holds(raw, 'buyer').filter((h) => h.state === 'active').length, 1, 'the reservation is untouched');

  // The complaint is decidable — the whole point of the freeze.
  const decided = await post(as(raw, 'boss', 'admin'), `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'arrived broken' });
  assert.equal(decided.status, 200, JSON.stringify(await json(decided.clone())));
  assert.equal(escrowState(raw, escrowId), 'refunded');
});

test('F1: a DISPUTED escrow settles only by an admin — the system, the customer and the merchant are refused, nothing moves', async () => {
  const raw = seed();
  const { orderId, escrowId } = await delivered(raw);
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/dispute`, { description: 'Only half of it is usable' })).status, 201);
  const before = spendable(raw, 'buyer');
  for (const actorRole of ['system', 'customer', 'merchant'] as const) {
    const rel = await releaseEscrow(asD1(raw), { escrowId, actorId: null, actorRole, idempotencyKey: `probe-rel-${actorRole}` });
    assert.deepEqual(rel, { ok: false, reason: 'STATE_CONFLICT', detail: 'disputed' }, `${actorRole} release`);
    const ref = await refundEscrow(asD1(raw), { escrowId, actorId: null, actorRole, idempotencyKey: `probe-ref-${actorRole}` });
    assert.deepEqual(ref, { ok: false, reason: 'STATE_CONFLICT', detail: 'disputed' }, `${actorRole} refund`);
  }
  assert.equal(escrowState(raw, escrowId), 'disputed');
  assert.equal(credited(raw), 0);
  assert.equal(spendable(raw, 'buyer'), before, 'no refund leaked out');
  // An admin decides it.
  const rel = await releaseEscrow(asD1(raw), { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'admin:release:x' });
  assert.equal(rel.ok, true);
  assert.equal(escrowState(raw, escrowId), 'released');
  assert.equal(credited(raw), 47_500);
});

test('F1: an escrow a dispute froze BETWEEN the read and the batch is not released — the escrow fence aborts the whole settlement', async () => {
  const raw = seed();
  const { escrowId } = await delivered(raw);
  // releaseEscrow reads the escrow (held), then — before its batch — the
  // dispute flips it. The dispute changes the escrow and not the hold, so
  // without the fence the debit and the merchant's credit would still post.
  const inner = asD1(raw) as unknown as { prepare: (s: string) => unknown; batch: (s: unknown[]) => Promise<unknown> };
  let flipped = false;
  const racing = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: unknown[]) => {
      if (!flipped) {
        flipped = true;
        raw.prepare("UPDATE community_escrows SET state = 'disputed', disputed_at = ? WHERE id = ?").run(new Date().toISOString(), escrowId);
      }
      return inner.batch(stmts);
    },
  };
  const res = await releaseEscrow(racing as unknown as D1Database, {
    escrowId, actorId: null, actorRole: 'system', idempotencyKey: 'confirm:race', orderStates: ['merchant_marked_delivered'],
  });
  assert.equal(res.ok, false);
  assert.equal(escrowState(raw, escrowId), 'disputed');
  assert.equal(credited(raw), 0, 'no merchant credit');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer' AND type = 'withdrawal'"), 0, 'no debit');
  assert.equal(holds(raw, 'buyer')[0].state, 'active');
});

test('F1: the customer’s confirmation releases only while the order is still delivered-and-waiting (checked in the batch)', async () => {
  const raw = seed();
  const { orderId, escrowId } = await delivered(raw);
  // The order moved (a dispute's order flip) while the escrow still reads held.
  raw.prepare("UPDATE community_orders SET state = 'disputed' WHERE id = ?").run(orderId);
  const res = await releaseEscrow(asD1(raw), {
    escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: `confirm:${orderId}`, orderStates: ['merchant_marked_delivered'],
  });
  assert.deepEqual(res, { ok: false, reason: 'ORDER_CHANGED', detail: 'disputed' });
  assert.equal(escrowState(raw, escrowId), 'held');
  assert.equal(credited(raw), 0);
});

// ===================================================================== F2

test('F2 (probe C2 inverted): the customer’s cancel racing the merchant’s start — never a refunded escrow under a live job', async () => {
  for (const firstStart of [true, false]) {
    const raw = seed();
    const { orderId, escrowId } = await accepted(raw);
    const before = spendable(raw, 'buyer');
    const db = serialD1(raw);
    const calls = [
      () => post(as(raw, 'buyer', 'customer', db), `/api/marketplace/orders/${orderId}/cancel`),
      () => post(as(raw, 'owner', 'customer', db), `/api/marketplace/orders/${orderId}/start`),
    ];
    const [cancel, start] = firstStart
      ? await Promise.all([calls[0](), calls[1]()]).then(([a, b]) => [a, b])
      : await Promise.all([calls[1](), calls[0]()]).then(([b, a]) => [a, b]);
    const esc = escrowState(raw, escrowId);
    const ord = orderState(raw, orderId);
    const req = row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")!.state;
    // Exactly one of them happened, and the rows agree about which.
    const coherent =
      (esc === 'refunded' && ord === 'cancelled' && req === 'cancelled' && cancel.status === 200 && start.status === 409) ||
      (esc === 'held' && ord === 'in_progress' && req !== 'cancelled' && start.status === 200 && cancel.status === 409);
    assert.ok(coherent, `escrow ${esc}, order ${ord}, request ${req}, cancel ${cancel.status}, start ${start.status}`);
    if (esc === 'refunded') assert.equal(spendable(raw, 'buyer') - before, holds(raw, 'buyer')[0].amount_cents);
    else assert.equal(spendable(raw, 'buyer'), before, 'no refund leaked out');
  }
});

test('F2: cancel after the work started is 409 ORDER_CHANGED and moves nothing; start after the cancel is 409 too', async () => {
  // The escrow's own UPDATE asks the order's state inside the batch: a refund
  // built on a stale «funded» read of an order already in progress is refused.
  const raw = seed();
  const a = await accepted(raw);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${a.orderId}/start`)).status, 200);
  const stale = await refundEscrow(asD1(raw), {
    escrowId: a.escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'cancel:stale',
    orderStates: ['accepted', 'funded'],
  });
  assert.deepEqual(stale, { ok: false, reason: 'ORDER_CHANGED', detail: 'in_progress' });
  assert.equal(escrowState(raw, a.escrowId), 'held');
  assert.equal(holds(raw, 'buyer')[0].state, 'active');

  // Through the route: the work started, the cancel is refused in words.
  const late = await post(as(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/cancel`);
  assert.equal(late.status, 409);
  assert.equal(escrowState(raw, a.escrowId), 'held');
  assert.equal(orderState(raw, a.orderId), 'in_progress');

  // The other order of events: cancelled first, then the merchant taps start.
  const raw2 = seed();
  const b = await accepted(raw2);
  const cancel = await post(as(raw2, 'buyer'), `/api/marketplace/orders/${b.orderId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(orderState(raw2, b.orderId), 'cancelled', 'the refund and the cancel landed together');
  assert.equal(row<{ state: string }>(raw2, "SELECT state FROM community_requests WHERE id = 'r1'")!.state, 'cancelled');
  const start = await post(as(raw2, 'owner'), `/api/marketplace/orders/${b.orderId}/start`);
  assert.equal(start.status, 409);
  assert.equal(orderState(raw2, b.orderId), 'cancelled');
  assert.equal(escrowState(raw2, b.escrowId), 'refunded');
});

test('F2: work never starts on money that is not held — 409 ESCROW_NOT_HELD; a double tap is one start', async () => {
  const raw = seed();
  const { orderId, escrowId } = await accepted(raw);
  raw.prepare("UPDATE community_escrows SET state = 'refunded' WHERE id = ?").run(escrowId);
  const start = await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/start`);
  assert.equal(start.status, 409);
  assert.equal((await json(start)).code, 'ESCROW_NOT_HELD');
  assert.equal(orderState(raw, orderId), 'funded');

  const raw2 = seed();
  const a2 = await accepted(raw2);
  const db = serialD1(raw2);
  const taps = await Promise.all([
    post(as(raw2, 'owner', 'customer', db), `/api/marketplace/orders/${a2.orderId}/start`),
    post(as(raw2, 'owner', 'customer', db), `/api/marketplace/orders/${a2.orderId}/start`),
  ]);
  assert.deepEqual(taps.map((t) => t.status), [200, 200], 'the losing tap is told the work IS started');
  assert.equal(orderState(raw2, a2.orderId), 'in_progress');
  assert.equal(count(raw2, "SELECT COUNT(*) n FROM audit_log WHERE action = 'community.order_started'"), 1, 'started once');
});

test('F2: a cancel that stopped between its two old steps (escrow refunded, order still funded) is FINISHED by the retry — no money moves', async () => {
  // The shape the two-step cancel could leave behind: the refund committed,
  // the order's flip never ran. A retry answers the cancel the customer asked
  // for instead of refusing it forever.
  const raw = seed();
  const { orderId, escrowId } = await accepted(raw);
  const holdId = row<{ hold_id: string }>(raw, 'SELECT hold_id FROM community_escrows WHERE id = ?', escrowId)!.hold_id;
  raw.prepare("UPDATE community_escrows SET state = 'refunded', refunded_iqd = gross_iqd, refunded_at = ? WHERE id = ?").run(new Date().toISOString(), escrowId);
  raw.prepare("UPDATE wallet_holds SET state = 'released', released_at = ?, release_reason = 'refund' WHERE id = ?").run(new Date().toISOString(), holdId);
  const before = spendable(raw, 'buyer');
  const txBefore = count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer'");

  const retry = await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/cancel`);
  assert.equal(retry.status, 200, JSON.stringify(await json(retry.clone())));
  assert.equal(orderState(raw, orderId), 'cancelled');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")!.state, 'cancelled');
  assert.equal(escrowState(raw, escrowId), 'refunded');
  assert.equal(spendable(raw, 'buyer'), before, 'no second refund');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id = 'buyer'"), txBefore, 'no money row written');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'community.order_cancelled'"), 1);

  // And a second retry is a plain replay.
  const again = await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/cancel`);
  assert.equal(again.status, 409, 'a cancelled order is not cancellable again (the policy answers first)');
  assert.equal(orderState(raw, orderId), 'cancelled');
});

// ===================================================================== F3

test('F3 (probe C7 inverted): a hundred un-settleable due orders no longer starve the auto-confirm sweep', async () => {
  const raw = seed();
  const { orderId, escrowId } = await delivered(raw);
  const due = row<{ a: string }>(raw, 'SELECT auto_complete_at a FROM community_orders WHERE id = ?', orderId)!.a;
  for (let i = 0; i < 100; i++) {
    raw.exec(`INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility) VALUES ('rq${i}','buyer','t','d','delivered','closed','public');
      INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('of${i}','rq${i}','m2','s2',1000,'accepted');
      INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,merchant_receivable_iqd,auto_complete_at)
        VALUES ('cx${i}','rq${i}','of${i}','buyer','m2','s2','merchant_marked_delivered',1000,1000,'2000-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z');
      INSERT INTO community_escrows (id,community_order_id,customer_id,merchant_id,gross_iqd,platform_fee_iqd,merchant_receivable_iqd,state)
        VALUES ('ex${i}','cx${i}','buyer','m2',1000,0,1000,'disputed');`);
  }
  const r = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date(Date.parse(due) + 60_000).toISOString());
  assert.equal(r.auto_completed, 1, JSON.stringify(r));
  assert.equal(r.auto_complete_skipped, 100, 'the stuck rows are counted, not selected');
  assert.equal(orderState(raw, orderId), 'completed');
  assert.equal(escrowState(raw, escrowId), 'released');
  assert.equal(credited(raw), 47_500);
});

// ===================================================================== F8

test('F8 (probe C6 inverted): an acceptance whose batch committed but whose response was lost keeps its reservation — and answers 201', async () => {
  const raw = seed();
  const inner = asD1(raw) as unknown as { prepare: (s: string) => unknown; batch: (s: unknown[]) => Promise<unknown> };
  const lossy = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: Array<unknown>) => {
      const res = await inner.batch(stmts);
      const sqls = JSON.stringify(stmts.map((s) => (s as { sql?: string }).sql ?? ''));
      if (/INSERT INTO community_orders/.test(sqls)) throw new Error('D1_ERROR: Network connection lost.');
      return res;
    },
  };
  const acc = await post(as(raw, 'buyer', 'customer', lossy), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const esc = row<{ id: string; state: string; hold_id: string }>(raw, 'SELECT id, state, hold_id FROM community_escrows')!;
  assert.equal(esc.state, 'held');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM wallet_holds WHERE id = ?', esc.hold_id)!.state, 'active', 'the escrow still reserves the money');
  // And the job can be paid at the end, as it should.
  const orderId = row<{ id: string }>(raw, 'SELECT id FROM community_orders')!.id;
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/start`)).status, 200);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/confirm`)).status, 200);
  assert.equal(credited(raw), 47_500);
  assert.equal((await merchantBalance(asD1(raw), 'm1')).available_iqd, 47_500);
});

test('F8: the reservation release asks, INSIDE its own UPDATE, whether an escrow stands on the hold — the sweep’s release included', async () => {
  const raw = seed();
  const { escrowId } = await accepted(raw);
  const holdId = row<{ hold_id: string }>(raw, 'SELECT hold_id FROM community_escrows WHERE id = ?', escrowId)!.hold_id;
  const res = await releaseEscrowReservation(asD1(raw), holdId, 'probe');
  assert.deepEqual(res, { ok: false, reason: 'STATE_CONFLICT', holdId });
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM wallet_holds WHERE id = ?', holdId)!.state, 'active');
  // A reservation nobody claimed IS released, once.
  raw.exec(`INSERT INTO wallet_holds (id,user_id,kind,amount_cents,state,event_key,ref_type,ref_id,created_at,updated_at)
            VALUES ('orphan','buyer','purchase',100,'active','escrow:accept:ghost','community_order','cord_ghost','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`);
  assert.deepEqual(await releaseEscrowReservation(asD1(raw), 'orphan', 'probe'), { ok: true, holdId: 'orphan', replayed: false });
  assert.deepEqual(await releaseEscrowReservation(asD1(raw), 'orphan', 'probe'), { ok: true, holdId: 'orphan', replayed: true });
});
