/**
 * ACCEPTING AN OFFER, TESTED BY TRYING TO BREAK IT — audit 03 §10 A, B, O and
 * the accept half of I; audit 04 B12; the merchant's «قبل العميل عرضك» (N).
 *
 * Real routes, real migrations (0116 included), real SQLite through the D1
 * adapter: the fences, the partial unique index and the wallet-hold guards
 * all execute. Each test names the defect it pins; each was written against
 * the pre-fix code first and failed there (see the audit's probes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, get, json, count, row, all, spendable, failingD1, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { runCommunitySweeps } from '../worker/lib/communityRequests';
import { serialD1 } from './fixtures/serialD1';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

const RATE = 1400;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Ali','a@x.co','h','customer'),
      ('owner2','Omar','o@x.co','h','customer'), ('stranger','Nour','n@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',2,
              '2099-01-01T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('o1','r1','m1','s1',50000,'pending'), ('o2','r1','m2','s2',60000,'pending');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);

const as = (raw: DatabaseSync, id: string, db: unknown = asD1(raw)) =>
  stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, mount);

/** Accept exactly the version the offer list shows, the way the page does. */
async function acceptAsSeen(raw: DatabaseSync, offerId: string, who = 'buyer') {
  const list = await json(await get(as(raw, who), '/api/marketplace/requests/r1/offers'));
  const o = (list.offers as Array<{ id: string; price_iqd: number; revision: number }>).find((x) => x.id === offerId)!;
  return post(as(raw, who), `/api/marketplace/offers/${offerId}/accept`, {
    expected_price_iqd: o.price_iqd,
    offer_revision: o.revision,
  });
}

// ------------------------------------------------------------ A · B12

test('A: a customer who cannot pay is refused BEFORE anything is written, and the retry after topping up succeeds', async () => {
  const raw = seed();
  const first = await acceptAsSeen(raw, 'o1');
  assert.equal(first.status, 400);
  assert.equal((await json(first)).code, 'INSUFFICIENT_FUNDS');
  // Nothing to undo: no order row that could lock the offer, the request and
  // both offers exactly as they were, and no reservation left behind.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.deepEqual(row(raw, 'SELECT state, accepted_offer_id FROM community_requests WHERE id = ?', 'r1'), {
    state: 'receiving_offers',
    accepted_offer_id: null,
  });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE state = 'pending'"), 2);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);

  fund(raw, 'buyer', 200_000);
  const second = await acceptAsSeen(raw, 'o1');
  assert.equal(second.status, 201, JSON.stringify(await json(second.clone())));
  const body = await json(second);
  assert.equal(body.order.state, 'funded');
  assert.equal(body.order.price_iqd, 50_000);
  assert.deepEqual(row(raw, 'SELECT state, status, accepted_offer_id, community_order_id FROM community_requests WHERE id = ?', 'r1'), {
    state: 'in_progress',
    status: 'closed',
    accepted_offer_id: 'o1',
    community_order_id: body.order.id,
  });
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', body.order.id)?.state, 'held');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o2'")?.state, 'rejected');
  assert.equal(row<{ offer_count: number }>(raw, "SELECT offer_count FROM community_requests WHERE id = 'r1'")?.offer_count, 1);
});

test('A (live data): a CANCELLED order the old acceptance left behind no longer locks the offer — the retry is not a 500', async () => {
  const raw = seed();
  // Exactly what the pre-0116 INSUFFICIENT_FUNDS rollback wrote (audit 04 B12).
  raw.exec(`INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
            VALUES ('cord_failed','r1','o1','buyer','m1','s1','cancelled',50000,2500,47500)`);
  fund(raw, 'buyer', 200_000);
  const res = await acceptAsSeen(raw, 'o1');
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_orders WHERE offer_id = 'o1'"), 2);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_orders WHERE offer_id = 'o1' AND state <> 'cancelled'"), 1);
});

test('A: one offer per request can win — the loser is refused and its reservation handed back', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const before = spendable(raw, 'buyer');
  // Two acceptances racing on one serialised database, as D1 runs them.
  const db = serialD1(raw);
  const [a, b] = await Promise.all([
    post(as(raw, 'buyer', db), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 }),
    post(as(raw, 'buyer', db), '/api/marketplace/offers/o2/accept', { expected_price_iqd: 60_000, offer_revision: 1 }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = a.status === 409 ? a : b;
  assert.ok(['REQUEST_NOT_OPEN', 'OFFER_NOT_AVAILABLE'].includes((await json(loser)).code));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_orders WHERE state <> 'cancelled'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 1, 'the loser\'s hold was released');
  const won = row<{ price_iqd: number }>(raw, "SELECT price_iqd FROM community_orders WHERE state = 'funded'")!;
  const heldCents = row<{ c: number }>(raw, "SELECT amount_cents AS c FROM wallet_holds WHERE state = 'active'")!.c;
  assert.equal(spendable(raw, 'buyer'), before - heldCents);
  assert.ok(heldCents <= Math.floor((won.price_iqd * 100) / RATE) + 1);
});

test('A: a batch that fails for any reason leaves no request stranded and gives the money back', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const { failing, db } = failingD1(raw);
  failing.failWhen = (stmts) => stmts.some((s) => s.sql.includes('INSERT INTO community_orders'));
  const res = await post(as(raw, 'buyer', db), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(res.status, 500);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'receiving_offers');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE state = 'pending'"), 2);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);
  // And it can simply be done again.
  assert.equal((await acceptAsSeen(raw, 'o1')).status, 201);
});

test('A (live data): the sweep reopens a request the old acceptance stranded in offer_selected, and releases an orphaned reservation', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  // B12's end state: the retry won the race guard, then the order INSERT threw.
  raw.exec(`UPDATE community_requests SET state = 'offer_selected', status = 'closed', accepted_offer_id = 'o1',
              updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'r1';
            INSERT INTO wallet_holds (id,user_id,kind,amount_cents,state,event_key,ref_type,ref_id,created_at,updated_at)
              VALUES ('whold_orphan','buyer','purchase',3572,'active','escrow:accept:cord_gone','community_order','cord_gone',
                      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`);
  // Stranded: every offer refuses.
  assert.equal((await acceptAsSeen(raw, 'o2')).status, 409);

  const report = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(report.reopened_requests, 1, JSON.stringify(report));
  assert.equal(report.released_holds, 1, JSON.stringify(report));
  assert.deepEqual(row(raw, "SELECT state, status, accepted_offer_id FROM community_requests WHERE id = 'r1'"), {
    state: 'receiving_offers',
    status: 'open',
    accepted_offer_id: null,
  });
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM wallet_holds WHERE id = 'whold_orphan'")?.state, 'released');
  assert.equal((await acceptAsSeen(raw, 'o2')).status, 201);

  // Idempotent: a second run finds nothing to heal.
  const again = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(again.reopened_requests + again.released_holds + again.healed_orders, 0);
});

test('A (live data): an order the old flow left in `accepted` is carried forward when funded and unwound when not', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const old = '2026-01-01T00:00:00.000Z';
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,accepted_offer_id,community_order_id,updated_at)
      VALUES ('r2','buyer','Gear','A gear','offer_selected','closed','public','o3','cord_nofund','${old}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state,updated_at) VALUES
      ('o3','r2','m1','s1',40000,'accepted','${old}'), ('o4','r2','m2','s2',45000,'rejected','${old}');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd,created_at)
      VALUES ('cord_nofund','r2','o3','buyer','m1','s1','accepted',40000,2000,38000,'${old}');
  `);
  const report = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(report.healed_orders, 1, JSON.stringify(report));
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_orders WHERE id = 'cord_nofund'")?.state, 'cancelled');
  assert.deepEqual(all(raw, "SELECT id, state FROM community_offers WHERE request_id = 'r2' ORDER BY id"), [
    { id: 'o3', state: 'pending' },
    { id: 'o4', state: 'pending' },
  ]);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r2'")?.state, 'receiving_offers');
});

// ----------------------------------------------------------------- B · O

test('B: an offer edited after the customer saw it cannot be accepted at the new price — 409 OFFER_CHANGED with the fresh offer', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const seen = await json(await get(as(raw, 'buyer'), '/api/marketplace/requests/r1/offers'));
  const o1 = (seen.offers as Array<{ id: string; price_iqd: number; revision: number }>).find((x) => x.id === 'o1')!;
  assert.equal(o1.revision, 1);

  const edited = await patch(as(raw, 'owner'), '/api/marketplace/offers/o1', { price_iqd: 95_000 });
  assert.equal(edited.status, 200);
  assert.equal((await json(edited)).offer.revision, 2, 'an edit is a new version');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.offer_edited' AND target = 'o1'"), 1);

  const res = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept', {
    expected_price_iqd: o1.price_iqd,
    offer_revision: o1.revision,
  });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'OFFER_CHANGED');
  assert.equal(body.details.offer.price_iqd, 95_000, 'the customer is shown what it says now');
  assert.equal(body.details.offer.revision, 2);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0, 'nothing was held at a price nobody confirmed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);

  // Confirming the version they now see goes through, at that price.
  const ok = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 95_000, offer_revision: 2 });
  assert.equal(ok.status, 201);
  assert.equal((await json(ok)).order.price_iqd, 95_000);
});

test('B: an acceptance that names no version is not a blank cheque', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const res = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept');
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'OFFER_CHANGED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
});

test('B: the merchant edits WHILE the acceptance is in flight — the batch refuses and the money comes back', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const { failing, db } = failingD1(raw);
  // A concurrent PATCH lands between the checks and the acceptance batch.
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => s.sql.includes('INSERT INTO community_orders'))) {
      raw.exec("UPDATE community_offers SET price_iqd = 99000, revision = revision + 1 WHERE id = 'o1'");
      failing.beforeBatch = null;
    }
  };
  const res = await post(as(raw, 'buyer', db), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'OFFER_CHANGED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'receiving_offers');
});

test('O: a withdraw that lands mid-acceptance is not overridden into a contract', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => s.sql.includes('INSERT INTO community_orders'))) {
      raw.exec("UPDATE community_offers SET state = 'withdrawn' WHERE id = 'o1'");
      failing.beforeBatch = null;
    }
  };
  const res = await post(as(raw, 'buyer', db), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'OFFER_NOT_AVAILABLE');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o1'")?.state, 'withdrawn');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
});

// -------------------------------------------------------------- I at accept

test('I: an expired request, or an expired offer, cannot be accepted', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  raw.exec("UPDATE community_offers SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'o1'");
  const off = await acceptAsSeen(raw, 'o1');
  assert.equal(off.status, 409);
  assert.equal((await json(off)).code, 'OFFER_EXPIRED');

  raw.exec("UPDATE community_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'r1'");
  const req = await acceptAsSeen(raw, 'o2');
  assert.equal(req.status, 409);
  assert.equal((await json(req)).code, 'REQUEST_EXPIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);
});

// ------------------------------------------------------------------ N · 15

test('15: the merchant is told their offer was accepted — once, linking to the request', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const res = await acceptAsSeen(raw, 'o1');
  assert.equal(res.status, 201);
  const orderId = (await json(res)).order.id;
  const n = all<{ user_id: string; kind: string; link: string; entity_type: string; entity_id: string }>(
    raw,
    "SELECT user_id, kind, link, entity_type, entity_id FROM user_notifications WHERE kind = 'offer_accepted'"
  );
  assert.deepEqual(n, [
    // The job itself, at its workspace address (W2-E: packages/contracts/src/merchantRoutes.ts).
    { user_id: 'owner', kind: 'offer_accepted', link: `/merchant/requests/orders/${orderId}`, entity_type: 'order', entity_id: orderId },
  ]);
  // The losing merchant is not told they won.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner2' AND kind = 'offer_accepted'"), 0);
});

test('15: the merchant can open the request the notification points at', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  assert.equal((await acceptAsSeen(raw, 'o1')).status, 201);
  const page = await get(as(raw, 'owner'), '/api/marketplace/requests/r1');
  assert.equal(page.status, 200, 'the engaged merchant reads the request after it left the board');
  assert.equal((await get(as(raw, 'owner2'), '/api/marketplace/requests/r1')).status, 404, 'the loser does not');
});
