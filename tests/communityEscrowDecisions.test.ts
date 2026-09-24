/**
 * WHAT HAPPENS AFTER THE MONEY IS HELD — confirmation, the auto-confirm clock,
 * disputes and the admin's decision — tested as replays and races.
 *
 * Audit 04 B3 (a replayed resolution doubled the −20 and left the request
 * `disputed`), B4 (a disputed request could be "removed"), B9 (two
 * confirmations counted the completion twice), 04 #13 / 03 §10 M (the
 * «يتأكد تلقائيًا» date nothing ever read), 03 §10 C and R.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, type Mount } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { runCommunitySweeps } from '../worker/lib/communityRequests';

const mount: Mount = (a) => {
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

const RATE = 1400;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Ali','a@x.co','h','customer'),
      ('owner2','Omar','o@x.co','h','customer'), ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    -- Acceptance asks what making an offer asks (review S2): the owner's plan too.
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',2,
              '2099-01-01T00:00:00.000Z');
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

/** Accept o1, start it and mark it delivered: an order waiting on the customer. */
async function deliveredOrder(raw: DatabaseSync): Promise<{ orderId: string; escrowId: string }> {
  const acc = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const orderId = (await json(acc)).order.id as string;
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/start`)).status, 200);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);
  const escrowId = row<{ id: string }>(raw, 'SELECT id FROM community_escrows WHERE community_order_id = ?', orderId)!.id;
  return { orderId, escrowId };
}

async function disputedOrder(raw: DatabaseSync) {
  const d = await deliveredOrder(raw);
  const res = await post(as(raw, 'buyer'), `/api/marketplace/orders/${d.orderId}/dispute`, {
    description: 'The part arrived broken in two',
  });
  assert.equal(res.status, 201);
  return d;
}

/** What the merchant was credited for custom orders — read off the ledger rows
 *  themselves, not through a balance function another change may redefine. */
const credited = (raw: DatabaseSync) =>
  row<{ s: number | null }>(raw,
    "SELECT SUM(amount_iqd) AS s FROM merchant_payout_ledger WHERE merchant_id = 'm1' AND kind = 'community_order_credit'")?.s ?? 0;

const repEvents = (raw: DatabaseSync, orderId: string, kind: string) =>
  count(raw, 'SELECT COUNT(*) AS n FROM merchant_reputation_events WHERE community_order_id = ? AND kind = ?', orderId, kind);

// ------------------------------------------------------------------- B9 · 6

test('B9: two «تأكيد الاستلام» racing each other count the completion ONCE', async () => {
  const raw = seed();
  const { orderId } = await deliveredOrder(raw);
  const db = serialD1(raw);
  const [a, b] = await Promise.all([
    post(as(raw, 'buyer', 'customer', db), `/api/marketplace/orders/${orderId}/confirm`),
    post(as(raw, 'buyer', 'customer', db), `/api/marketplace/orders/${orderId}/confirm`),
  ]);
  assert.ok([a.status, b.status].includes(200), `${a.status} ${b.status}`);
  assert.equal(row<{ completed_orders: number }>(raw, "SELECT completed_orders FROM community_merchants WHERE id = 'm1'")?.completed_orders, 1);
  assert.equal(repEvents(raw, orderId, 'order_completed'), 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'completed');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'completed');
  // Paid once: 47,500 receivable on a 50,000 order at the default 5%.
  assert.equal(credited(raw), 47_500);
});

test('B9: a confirmation replayed after it succeeded changes nothing', async () => {
  const raw = seed();
  const { orderId } = await deliveredOrder(raw);
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/confirm`)).status, 200);
  // Force the route past its read-time check, the way a racing twin gets past it.
  raw.exec(`UPDATE community_orders SET state = 'merchant_marked_delivered' WHERE id = '${orderId}'`);
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/confirm`)).status, 200);
  assert.equal(row<{ completed_orders: number }>(raw, "SELECT completed_orders FROM community_merchants WHERE id = 'm1'")?.completed_orders, 1);
  assert.equal(repEvents(raw, orderId, 'order_completed'), 1);
});

// ------------------------------------------------------------------ 14 · M

test('14: the auto-confirm date is real — the sweep releases a delivered order once its day has passed', async () => {
  const raw = seed();
  const { orderId, escrowId } = await deliveredOrder(raw);
  const due = row<{ auto_complete_at: string }>(raw, 'SELECT auto_complete_at FROM community_orders WHERE id = ?', orderId)!.auto_complete_at;
  assert.ok(due, 'delivery stamped the date both sides are shown');

  // Not yet due: nothing moves.
  const early = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(early.auto_completed, 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'merchant_marked_delivered');

  const after = new Date(Date.parse(due) + 60_000).toISOString();
  const report = await runCommunitySweeps({ DB: asD1(raw) } as never, after);
  assert.equal(report.auto_completed, 1, JSON.stringify(report));
  assert.deepEqual(row(raw, 'SELECT state, confirmed_at IS NULL AS unconfirmed FROM community_orders WHERE id = ?', orderId), {
    state: 'completed', unconfirmed: 1,
  });
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', escrowId)?.state, 'released');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'completed');
  assert.equal(credited(raw), 47_500);
  assert.equal(
    row<{ actor_role: string; idempotency_key: string }>(raw, "SELECT actor_role, idempotency_key FROM community_escrow_events WHERE kind = 'release'")?.actor_role,
    'system'
  );

  // Idempotent: another run, and the customer's own late confirmation, pay nothing more.
  const again = await runCommunitySweeps({ DB: asD1(raw) } as never, after);
  assert.equal(again.auto_completed, 0);
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/confirm`)).status, 409);
  assert.equal(credited(raw), 47_500);
  assert.equal(row<{ completed_orders: number }>(raw, "SELECT completed_orders FROM community_merchants WHERE id = 'm1'")?.completed_orders, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_escrow_events WHERE kind = 'release'"), 1);
});

test('14: a disputed order is never auto-confirmed', async () => {
  const raw = seed();
  const { orderId, escrowId } = await disputedOrder(raw);
  const report = await runCommunitySweeps({ DB: asD1(raw) } as never, '2100-01-01T00:00:00.000Z');
  assert.equal(report.auto_completed, 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'disputed');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', escrowId)?.state, 'disputed');
  assert.equal(credited(raw), 0);
});

test('14: the customer confirming at the same moment as the sweep settles the escrow once between them', async () => {
  const raw = seed();
  const { orderId } = await deliveredOrder(raw);
  const db = serialD1(raw);
  const [res] = await Promise.all([
    post(as(raw, 'buyer', 'customer', db), `/api/marketplace/orders/${orderId}/confirm`),
    runCommunitySweeps({ DB: db } as never, '2100-01-01T00:00:00.000Z'),
  ]);
  assert.ok([200, 409].includes(res.status));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_escrow_events WHERE kind = 'release'"), 1);
  assert.equal(credited(raw), 47_500);
  assert.equal(repEvents(raw, orderId, 'order_completed'), 1);
});

// ---------------------------------------------------------------------- R

test('R: a dispute that arrives after the escrow was settled is refused, and the order is not rewritten', async () => {
  const raw = seed();
  const { orderId } = await deliveredOrder(raw);
  // The escrow was released a moment ago (a confirmation, the clock) while the
  // disputing party still had the order open.
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}/confirm`)).status, 200);
  raw.exec(`UPDATE community_orders SET state = 'merchant_marked_delivered' WHERE id = '${orderId}'`);
  const res = await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/dispute`, { description: 'Customer is lying about it' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'ORDER_SETTLED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_complaints'), 0);
  assert.notEqual(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'disputed');
});

// ------------------------------------------------------------------ C · B3

test('B3: a replayed admin refund never applies the −20 twice, and the request leaves `disputed`', async () => {
  const raw = seed();
  const { orderId, escrowId } = await disputedOrder(raw);
  const admin = as(raw, 'boss', 'admin');
  const r1 = await json(await post(admin, `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'broken part' }));
  const r2 = await json(await post(admin, `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'broken part' }));
  assert.equal(r1.success, true);
  assert.equal(r1.replayed, false);
  assert.equal(r2.success, true);
  assert.equal(r2.replayed, true);
  assert.equal(repEvents(raw, orderId, 'dispute_lost'), 1);
  assert.equal(
    row<{ p: number }>(raw, "SELECT SUM(points) AS p FROM merchant_reputation_events WHERE merchant_id = 'm1'")?.p,
    -20
  );
  assert.deepEqual(row(raw, "SELECT state, status FROM community_requests WHERE id = 'r1'"), { state: 'cancelled', status: 'closed' });
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'refunded');
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM community_complaints WHERE community_order_id = ?', orderId)?.status, 'resolved');
});

test('C: releasing to the merchant completes the request, and a different second decision is refused', async () => {
  const raw = seed();
  const { orderId, escrowId } = await disputedOrder(raw);
  const admin = as(raw, 'boss', 'admin');
  const ok = await post(admin, `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'release', reason: 'work was fine' });
  assert.equal(ok.status, 200);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'completed');
  assert.equal(repEvents(raw, orderId, 'dispute_won'), 1);
  const flip = await post(admin, `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'changed my mind' });
  assert.equal(flip.status, 409);
  assert.equal((await json(flip)).code, 'ESCROW_SETTLED');
  assert.equal(repEvents(raw, orderId, 'dispute_lost'), 0);
});

test('C: an escrow nobody disputed is not the admin\'s to settle — it waits for the customer', async () => {
  const raw = seed();
  const { escrowId } = await deliveredOrder(raw);
  const res = await post(as(raw, 'boss', 'admin'), `/api/admin/community/escrows/${escrowId}/resolve`, {
    decision: 'release', reason: 'looks done',
  });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'ESCROW_NOT_DISPUTED');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', escrowId)?.state, 'held');
});

test('C: a decision whose money moved but whose consequences did not (a crash) is finished by the replay', async () => {
  const raw = seed();
  const { orderId, escrowId } = await disputedOrder(raw);
  const admin = as(raw, 'boss', 'admin');
  assert.equal((await post(admin, `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'broken' })).status, 200);
  // Undo the consequences only, as if the second batch had never committed.
  raw.exec(`DELETE FROM merchant_reputation_events WHERE community_order_id = '${orderId}' AND kind = 'dispute_lost';
            UPDATE community_orders SET state = 'disputed' WHERE id = '${orderId}';
            UPDATE community_requests SET state = 'disputed' WHERE id = 'r1';`);
  const replay = await json(await post(admin, `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'refund', reason: 'broken' }));
  assert.equal(replay.replayed, true);
  assert.equal(repEvents(raw, orderId, 'dispute_lost'), 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'refunded');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'cancelled');
});

// ---------------------------------------------------------------------- B4

test('B4: an admin cannot remove a request whose escrow is disputed — REQUEST_HAS_ESCROW, and nothing moves', async () => {
  const raw = seed();
  const { orderId, escrowId } = await disputedOrder(raw);
  const res = await post(as(raw, 'boss', 'admin'), '/api/admin/community/requests/r1/remove', { reason: 'spam' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'REQUEST_HAS_ESCROW');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'disputed');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'disputed');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', escrowId)?.state, 'disputed');
});

test('B4: nor one whose escrow is funded and the work under way', async () => {
  const raw = seed();
  const acc = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(acc.status, 201);
  const res = await post(as(raw, 'boss', 'admin'), '/api/admin/community/requests/r1/remove', { reason: 'spam' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'REQUEST_HAS_ESCROW');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'in_progress');
});

test('B4: removing a request still taking offers closes its offers and links with it, and a second removal is a no-op', async () => {
  const raw = seed();
  const admin = as(raw, 'boss', 'admin');
  const res = await post(admin, '/api/admin/community/requests/r1/remove', { reason: 'off topic' });
  assert.equal(res.status, 200);
  assert.deepEqual(row(raw, "SELECT state, offer_count FROM community_requests WHERE id = 'r1'"), { state: 'cancelled', offer_count: 0 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r1' AND state = 'pending'"), 0);
  const again = await post(admin, '/api/admin/community/requests/r1/remove', { reason: 'off topic' });
  assert.equal(again.status, 200);
  assert.equal((await json(again)).replayed, true);
  // The order page still answers for nobody: there never was one.
  assert.equal((await get(as(raw, 'buyer'), '/api/marketplace/orders')).status, 200);
});
