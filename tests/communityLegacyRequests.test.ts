/**
 * THE COMMUNITY PAGE'S REQUEST DOORS TAKE THE REQUEST STATE MACHINE — audit 03
 * §10 E (handed over from W1-B: worker/routes/community.ts).
 *
 * `POST /api/community/requests` (src/pages/Community.tsx) inserted with the
 * table's defaults — `open` since migration 0031 — so a request landed on the
 * board with no draft/publish step, no estimate, no matching, no merchant told
 * and no expiry. `publishRequest` is now the only door onto the board; this
 * door makes a draft and goes through it. Its list showed private and expired
 * requests, and its close wrote `status` under a paid request's feet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, send, json, row, count, all, pending, type Mount } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { communityRoutes } from '../worker/routes/community';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';

const mount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role) VALUES
      ('buyer','Sara','sara','s@x.co','h','customer'), ('owner','Ali','ali','a@x.co','h','customer'),
      ('stranger','Nour','nour','n@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityRequestExpiryDays','30');
  `);
  return raw;
}

const as = (raw: DatabaseSync, id: string) => stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount);

test('the community page\'s request is born a draft and PUBLISHED — on the board, with an expiry, matched and audited', async () => {
  const raw = seed();
  const res = await post(as(raw, 'buyer'), '/api/community/requests', { title: 'A shelf bracket', description: 'Two of them' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal(typeof body.id, 'string', 'the page reads `id` — the old contract holds');
  assert.equal(body.published, true);
  assert.equal(typeof body.matching?.considered, 'number', 'the matching ran');

  const r = row<{ state: string; status: string; visibility: string; expires_at: string | null }>(
    raw, 'SELECT state, status, visibility, expires_at FROM community_requests WHERE id = ?', body.id
  )!;
  assert.deepEqual({ state: r.state, status: r.status, visibility: r.visibility }, { state: 'open', status: 'open', visibility: 'public' });
  assert.ok(r.expires_at && r.expires_at > new Date().toISOString(), 'the expiry clock started at publish');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_print_requests WHERE request_id = ?', body.id), 1, 'published with a spec row');
  assert.deepEqual(
    all<{ action: string }>(raw, 'SELECT action FROM audit_log WHERE target = ? ORDER BY rowid', body.id).map((a) => a.action),
    ['community.request_created', 'print.request_published']
  );

  // The same request on both lists.
  const board = await json(await get(as(raw, 'stranger'), '/api/marketplace/requests'));
  assert.ok((board.requests as Array<{ id: string }>).some((x) => x.id === body.id));
  const legacy = await json(await get(as(raw, 'stranger'), '/api/community/requests'));
  assert.ok((legacy.requests as Array<{ id: string }>).some((x) => x.id === body.id));
  await Promise.allSettled(pending.splice(0));
});

test('the community list shows what the board shows: no draft, no private request, nothing expired or finished', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,expires_at) VALUES
      ('r_live','buyer','Live','x','receiving_offers','open','public','2099-01-01T00:00:00.000Z'),
      ('r_draft','buyer','Draft','x','draft','closed','public',NULL),
      ('r_private','buyer','Private','x','open','open','private','2099-01-01T00:00:00.000Z'),
      ('r_expired','buyer','Expired','x','open','open','public','2020-01-01T00:00:00.000Z'),
      ('r_stale','buyer','Cancelled but status says open','x','cancelled','open','public','2099-01-01T00:00:00.000Z');
  `);
  const { requests } = await json(await get(as(raw, 'stranger'), '/api/community/requests'));
  assert.deepEqual((requests as Array<{ id: string }>).map((x) => x.id), ['r_live']);
});

test('the legacy close is the customer\'s cancel: it moves `state`, rejects pending offers, and refuses a paid request', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at) VALUES
      ('r_open','buyer','Open','x','receiving_offers','open','public',1,'2099-01-01T00:00:00.000Z'),
      ('r_paid','buyer','Paid','x','in_progress','closed','public',1,'2099-01-01T00:00:00.000Z'),
      ('r_theirs','stranger','Theirs','x','open','open','public',0,'2099-01-01T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o1','r_open','m1','s1',5000,'pending');
  `);
  const buyer = as(raw, 'buyer');
  const follow = async (id: string) => {
    const first = await send(buyer, 'POST', `/api/community/requests/${id}/close`);
    assert.equal(first.status, 307);
    const to = first.headers.get('location')!;
    assert.equal(to, `/api/marketplace/requests/${id}/cancel`);
    return send(buyer, 'POST', to);
  };

  assert.equal((await follow('r_open')).status, 200);
  assert.deepEqual(row(raw, "SELECT state, status FROM community_requests WHERE id = 'r_open'"), { state: 'cancelled', status: 'closed' });
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o1'")!.state, 'rejected', 'the merchant is not left hanging');

  const paid = await follow('r_paid');
  assert.equal(paid.status, 409);
  assert.equal((await json(paid)).code, 'REQUEST_HAS_ORDER');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r_paid'")!.state, 'in_progress');

  assert.equal((await follow('r_theirs')).status, 404);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r_theirs'")!.state, 'open');
});

test('community.ts puts nothing on the board by itself: its one insert is a draft, and publishRequest opens it', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/community.ts'), 'utf8');
  const inserts = src.match(/INSERT INTO community_requests[^`]*`/g) ?? [];
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /'draft'/);
  assert.match(src, /await publishRequest\(c\.env, user\.id, id, \{\}\)/);
  assert.doesNotMatch(src, /UPDATE community_requests/, 'no community route moves a request by itself');
});
