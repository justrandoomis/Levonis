/**
 * The platform's community administration, tested as refusals.
 *
 * Every test here asks whether an admin control does the thing it must NOT
 * do. A "reject offer" button that also works on an accepted offer would pull
 * the contract out from under a funded escrow; a "re-open store" that works
 * while its owner is suspended would leave two admin decisions contradicting
 * each other and the storefront choosing between them; a reputation
 * correction that edited the record instead of adding to it would make the
 * log unusable as evidence.
 *
 * The routes run against a real SQLite engine through the D1 adapter, so the
 * CHECK constraints, the partial unique indexes and the conditional UPDATEs
 * all execute. Only the session is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';

// --------------------------------------------------------------- harness

/**
 * Mounts the real routes behind a stub admin session, with the same error
 * translation worker/index.ts applies — otherwise a deliberate 409 arrives
 * as an unhandled throw and a refusal test cannot tell "refused" from
 * "crashed", which are very different outcomes.
 */
function adminApp(db: D1Database) {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'boss', role: 'admin' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  app.route('/api/admin/community', adminCommunityRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  });
  return app;
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('buyer','Sara','s@x.co','h'), ('owner','Ali','a@x.co','h'),
      ('owner2','Zaid','z@x.co','h'), ('boss','Admin','ad@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES
      ('m1','owner','Ali 3D'), ('m2','owner2','Zaid Prints');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','zaid','Zaid Prints');
    INSERT INTO community_requests (id,customer_id,title,state,offer_count)
      VALUES ('r1','buyer','Print a bracket','receiving_offers',2);
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('o1','r1','m1','s1',50000,'pending'),
      ('o2','r1','m2','s2',60000,'pending');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const json = async (res: Response) => (await res.json()) as Record<string, never>;

const post = (app: ReturnType<typeof adminApp>, path: string, body: unknown = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ------------------------------------------------------ requests & offers

test('the admin board names the customer the public board withholds', async () => {
  const { db } = setup();
  const res = await adminApp(db).request('/api/admin/community/requests');
  assert.equal(res.status, 200);
  const body = await json(res);
  const rows = body.requests as unknown as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  // A merchant may not learn this until their offer wins (§24). An admin
  // resolving a dispute has to know it from the start.
  assert.equal(rows[0].customer_name, 'Sara');
  assert.equal(rows[0].customer_email, 's@x.co');
  assert.equal(Number(rows[0].offers_pending), 2);
});

test('an admin sees every offer and its price; a merchant never sees a rival price', async () => {
  const { db } = setup();
  const res = await adminApp(db).request('/api/admin/community/requests/r1');
  const body = await json(res);
  const offers = body.offers as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(offers.map((o) => o.price_iqd).sort(), [50000, 60000]);
  assert.deepEqual(offers.map((o) => o.merchant_name).sort(), ['Ali 3D', 'Zaid Prints']);
});

test('rejecting a pending offer removes it and refreshes the advertised count', async () => {
  const { db, raw } = setup();
  const res = await post(adminApp(db), '/api/admin/community/offers/o1/reject', { reason: 'abusive text' });
  assert.equal(res.status, 200);

  const offer = raw.prepare('SELECT state FROM community_offers WHERE id = ?').get('o1') as { state: string };
  assert.equal(offer.state, 'rejected');

  // The board must not keep advertising an offer that is no longer there.
  const req = raw.prepare('SELECT offer_count FROM community_requests WHERE id = ?').get('r1') as
    { offer_count: number };
  assert.equal(Number(req.offer_count), 1);
});

test('an ACCEPTED offer cannot be rejected — a funded contract sits behind it', async () => {
  const { db, raw } = setup();
  raw.exec("UPDATE community_offers SET state = 'accepted' WHERE id = 'o1'");

  const res = await post(adminApp(db), '/api/admin/community/offers/o1/reject', { reason: 'changed my mind' });
  assert.equal(res.status, 409);
  const state = (raw.prepare('SELECT state FROM community_offers WHERE id = ?').get('o1') as { state: string }).state;
  assert.equal(state, 'accepted');
});

test('an already-rejected offer cannot be rejected again', async () => {
  const { db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/offers/o1/reject', { reason: 'spam' });
  const again = await post(app, '/api/admin/community/offers/o1/reject', { reason: 'spam' });
  assert.equal(again.status, 409);
});

test('rejecting an offer requires a reason', async () => {
  const { db } = setup();
  const res = await post(adminApp(db), '/api/admin/community/offers/o1/reject', {});
  assert.equal(res.status, 400);
});

test('a request with work under way is not removable — that is a dispute', async () => {
  const { db, raw } = setup();
  raw.exec("UPDATE community_requests SET state = 'in_progress' WHERE id = 'r1'");
  const res = await post(adminApp(db), '/api/admin/community/requests/r1/remove', { reason: 'reported' });
  assert.equal(res.status, 409);
  const state = (raw.prepare('SELECT state FROM community_requests WHERE id = ?').get('r1') as
    { state: string }).state;
  assert.equal(state, 'in_progress');
});

test('removing an open request cancels it and keeps the row', async () => {
  const { db, raw } = setup();
  const res = await post(adminApp(db), '/api/admin/community/requests/r1/remove', { reason: 'off topic' });
  assert.equal(res.status, 200);
  const row = raw.prepare('SELECT state, status, title FROM community_requests WHERE id = ?').get('r1') as
    { state: string; status: string; title: string };
  // Cancelled, not deleted (§46). The title is still readable afterwards.
  assert.equal(row.state, 'cancelled');
  assert.equal(row.status, 'closed');
  assert.equal(row.title, 'Print a bracket');
});

// -------------------------------------------------------- store sanctions

test('suspending a STORE leaves its merchant able to trade', async () => {
  const { db, raw } = setup();
  const res = await post(adminApp(db), '/api/admin/community/stores/s1/status', {
    status: 'suspended',
    reason: 'banner violates policy',
  });
  assert.equal(res.status, 200);

  const store = raw.prepare('SELECT status, status_reason FROM merchant_stores WHERE id = ?').get('s1') as
    { status: string; status_reason: string };
  assert.equal(store.status, 'suspended');
  assert.equal(store.status_reason, 'banner violates policy');

  // The point of the separate sanction: the merchant is untouched, so work
  // they already owe other customers is not cancelled by a bad banner.
  const merchant = raw.prepare('SELECT status FROM community_merchants WHERE id = ?').get('m1') as
    { status: string };
  assert.equal(merchant.status, 'active');
});

test('a store cannot be re-opened while its merchant is suspended', async () => {
  const { db, raw } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/merchants/m1/status', { status: 'suspended', reason: 'fraud' });

  const res = await post(app, '/api/admin/community/stores/s1/status', { status: 'active', reason: '' });
  assert.equal(res.status, 409);
  // The merchant sanction shuts the shop from the MERCHANT row; it no longer
  // writes the store's own status (audit 04 B2 — see
  // tests/merchantSanctionsModeration.test.ts), and the refused re-open wrote
  // nothing either.
  const store = raw.prepare('SELECT status FROM merchant_stores WHERE id = ?').get('s1') as { status: string };
  assert.equal(store.status, 'active');
  const merchant = raw.prepare('SELECT status FROM community_merchants WHERE id = ?').get('m1') as { status: string };
  assert.equal(merchant.status, 'suspended');
});

test('a store sanction cannot be set to `paused` — that is the merchant\'s own switch', async () => {
  const { db } = setup();
  const res = await post(adminApp(db), '/api/admin/community/stores/s1/status', {
    status: 'paused',
    reason: 'x',
  });
  // If an admin could write `paused`, the merchant re-opening their own shop
  // would silently lift an admin decision (§50).
  assert.equal(res.status, 400);
});

// --------------------------------------------------- reviews & reputation

function withReviews(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd,state)
      VALUES ('co1','r1','o1','buyer','m1',50000,5000,45000,'completed');
    INSERT INTO merchant_reviews (id,merchant_id,customer_id,community_order_id,rating,body)
      VALUES ('rv1','m1','buyer','co1',1,'never delivered');
  `);
}

test('hiding a review moves the rating with it', async () => {
  const { db, raw } = setup();
  withReviews(raw);
  const app = adminApp(db);

  // Establish the visible rating first, the way a real review would.
  await post(app, '/api/admin/community/reviews/rv1/hide', { hidden: false });
  const before = raw.prepare('SELECT rating_avg_x100, rating_count FROM community_merchants WHERE id = ?')
    .get('m1') as { rating_avg_x100: number; rating_count: number };
  assert.equal(Number(before.rating_count), 1);
  assert.equal(Number(before.rating_avg_x100), 100);

  await post(app, '/api/admin/community/reviews/rv1/hide', { hidden: true });
  const after = raw.prepare('SELECT rating_avg_x100, rating_count FROM community_merchants WHERE id = ?')
    .get('m1') as { rating_avg_x100: number; rating_count: number };
  // A hidden review that kept counting would leave a score nobody can see
  // the basis for (§40).
  assert.equal(Number(after.rating_count), 0);
  assert.equal(Number(after.rating_avg_x100), 0);
});

test('the moderation list keeps hidden reviews visible to the admin', async () => {
  const { db, raw } = setup();
  withReviews(raw);
  const app = adminApp(db);
  await post(app, '/api/admin/community/reviews/rv1/hide', { hidden: true });

  const all = await json(await app.request('/api/admin/community/reviews'));
  assert.equal((all.reviews as unknown as unknown[]).length, 1);

  const onlyHidden = await json(await app.request('/api/admin/community/reviews?hidden=1'));
  assert.equal((onlyHidden.reviews as unknown as unknown[]).length, 1);

  const onlyVisible = await json(await app.request('/api/admin/community/reviews?hidden=0'));
  assert.equal((onlyVisible.reviews as unknown as unknown[]).length, 0);
});

test('the reputation view reports the EARNED badge next to any override', async () => {
  const { db } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/merchants/m1/badge', { badge: 'elite' });

  const body = await json(await app.request('/api/admin/community/merchants/m1/reputation'));
  // Pinned by an admin, but the criteria award `new` — an admin about to
  // change it should see what they are overriding (§42).
  assert.equal(body.badge_override as unknown as string, 'elite');
  assert.equal(body.earned_badge as unknown as string, 'new');
});

test('clearing a badge override returns the merchant to what they earned', async () => {
  const { db, raw } = setup();
  const app = adminApp(db);
  await post(app, '/api/admin/community/merchants/m1/badge', { badge: 'elite' });
  await post(app, '/api/admin/community/merchants/m1/badge', { badge: '' });

  const m = raw.prepare('SELECT badge, badge_override FROM community_merchants WHERE id = ?').get('m1') as
    { badge: string; badge_override: string };
  assert.equal(m.badge_override, '');
  assert.equal(m.badge, 'new');
});

test('a reputation correction is APPENDED; the mistaken event stays on the record', async () => {
  const { db, raw } = setup();
  const app = adminApp(db);

  raw.exec(
    `INSERT INTO merchant_reputation_events (id,merchant_id,kind,points,note)
     VALUES ('rep_bad','m1','dispute_lost',-20,'wrongly recorded')`
  );

  const res = await post(app, '/api/admin/community/merchants/m1/reputation', {
    points: 20,
    note: 'reversing rep_bad — dispute was decided for the merchant',
  });
  assert.equal(res.status, 200);

  const rows = raw
    .prepare('SELECT kind, points FROM merchant_reputation_events WHERE merchant_id = ? ORDER BY points')
    .all('m1') as Array<{ kind: string; points: number }>;
  // Two rows, not one edited row. The original is still there to be shown.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.kind), ['dispute_lost', 'admin_adjustment']);

  const body = await json(await app.request('/api/admin/community/merchants/m1/reputation'));
  assert.equal(Number(body.reputation_points), 0);
});

test('a reputation adjustment requires a reason', async () => {
  const { db } = setup();
  const res = await post(adminApp(db), '/api/admin/community/merchants/m1/reputation', { points: 50 });
  assert.equal(res.status, 400);
});
