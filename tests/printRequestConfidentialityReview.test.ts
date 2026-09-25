/**
 * REVIEW W2-5 — WHAT A PRINT REQUEST'S ORDER AND HISTORY MAY SHOW, AND TO WHOM.
 *
 *   · p6 — a request published before 0130 has a backfilled revision holding
 *     the RAW estimate; accepting an offer on it copied the platform's cost
 *     lines, cost, floor and margin into community_orders.request_snapshot,
 *     which the order screen returns to BOTH parties. The copy now goes through
 *     `publicEstimate`, and the read strips whatever an old row holds.
 *   · #7 — the merchant contact revealed after acceptance fell back to the
 *     merchant ACCOUNT's private phone; it is now the store's published
 *     contact_phone or nothing.
 *   · #6 — GET /print/requests/:id/revisions returned every PAST revision
 *     (old titles, descriptions, notes, source links) to anyone the board lets
 *     in, anonymous visitors included. Past revisions are now for the owner,
 *     an admin and a merchant with an offer on the request; anyone else gets
 *     the current revision only (`history: false`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, row, type Mount, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};
const RATE = 1400;
const COST_KEYS = ['cost_lines', 'cost_iqd', 'floor_iqd', 'margin_percent'];

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,phone_e164) VALUES
      ('buyer','Sara','s@x.co','h','customer','+9647700000001'), ('owner','Ali','a@x.co','h','customer',NULL),
      ('owner2','Omar','o@x.co','h','customer',NULL), ('stranger','Nour','n@x.co','h','customer',NULL),
      ('boss','Boss','boss@x.co','h','admin',NULL);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m1','owner','Ali 3D','+9647511111111'), ('m2','owner2','Omar Resin','+9647599999999');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES
      ('s1','m1','owner','ali3d','Ali 3D',''), ('s2','m2','owner2','omarresin','Omar Resin','+9647522222222');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra'), ('p2','m2','s2','Big FDM 2','fdm',300,300,300,'[]','ultra');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area)
      VALUES ('a1','buyer','Home','Sara K','+9647700000009','Street 12, house 4','near the mosque',1,'baghdad','Karrada');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt1','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','test funding');
  `);
  return raw;
}
const as = (raw: DatabaseSync, id: string | null, role: StubUser['role'] = 'customer') =>
  stubApp(asD1(raw), id ? { id, role, email: `${id}@x.co` } : null, mount);

async function published(raw: DatabaseSync): Promise<string> {
  const res = await post(as(raw, 'buyer'), '/api/marketplace/requests', { title: 'A phone stand', description: 'A stand for a phone, please' });
  assert.equal(res.status, 201);
  const id = (await json(res)).request.id as string;
  const pub = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 });
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}

/** Make the request look published before 0130, then run 0130's own backfill statement (the raw estimate). */
function asPre0130(raw: DatabaseSync, id: string) {
  raw.prepare('DELETE FROM community_request_revisions WHERE request_id = ?').run(id);
  const mig = readFileSync(join(ROOT, 'migrations/0130_request_revisions_offers_v2.sql'), 'utf8');
  const s = mig.indexOf('INSERT OR IGNORE INTO community_request_revisions');
  const e = mig.indexOf(';', mig.indexOf("WHERE r.state <> 'draft'", s));
  raw.exec(mig.slice(s, e + 1));
}

async function accept(raw: DatabaseSync, id: string, merchantUser: string) {
  const offer = (await json(await post(as(raw, merchantUser), `/api/marketplace/requests/${id}/offers`, { price_iqd: 40_000, delivery_method: 'merchant_delivery' }))).offer;
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, { expected_price_iqd: 40_000, offer_revision: 1, address_id: 'a1' });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  return (await json(acc)).order.id as string;
}

test('p6: accepting on a pre-0130 revision never copies the cost breakdown into the order — neither party sees it', async () => {
  const raw = seed();
  const id = await published(raw);
  asPre0130(raw, id);
  const rawRev = JSON.parse(row<{ estimate: string }>(raw, 'SELECT estimate FROM community_request_revisions WHERE request_id = ?', id)!.estimate);
  assert.ok(COST_KEYS.some((k) => k in rawRev), 'the backfilled revision holds the raw estimate (the precondition)');
  const orderId = await accept(raw, id, 'owner');
  const stored = JSON.parse(row<{ request_snapshot: string }>(raw, 'SELECT request_snapshot FROM community_orders WHERE id = ?', orderId)!.request_snapshot);
  for (const k of COST_KEYS) assert.ok(!(k in stored.estimate), `stored snapshot has no ${k}`);
  assert.ok('price_iqd' in stored.estimate, 'the customer-facing figures stay');
  for (const who of ['owner', 'buyer']) {
    const e = (await json(await get(as(raw, who), `/api/marketplace/orders/${orderId}`))).order.request_snapshot.estimate;
    for (const k of COST_KEYS) assert.ok(!(k in e), `${who} does not see ${k}`);
  }
});

test('p6: an order row written before the fix is stripped on read as well', async () => {
  const raw = seed();
  const id = await published(raw);
  const orderId = await accept(raw, id, 'owner');
  raw.prepare(`UPDATE community_orders SET request_snapshot = json_set(request_snapshot, '$.estimate.cost_iqd', 9999, '$.estimate.cost_lines', json('[1]')) WHERE id = ?`).run(orderId);
  const e = (await json(await get(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}`))).order.request_snapshot.estimate;
  assert.ok(!('cost_iqd' in e) && !('cost_lines' in e));
});

test('#7: a store with no published phone reveals no phone — never the merchant account’s private one', async () => {
  const raw = seed();
  const orderId = await accept(raw, await published(raw), 'owner');
  const contact = (await json(await get(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}`))).contact;
  assert.equal(contact.phone, '', JSON.stringify(contact));
  assert.ok(!JSON.stringify(contact).includes('7511111111'));
});

test('#7: a store with a published phone reveals exactly that phone', async () => {
  const raw = seed();
  const orderId = await accept(raw, await published(raw), 'owner2');
  const contact = (await json(await get(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}`))).contact;
  assert.equal(contact.phone, '+9647522222222');
});

test('#6: past revisions only for the owner, an admin and a merchant with an offer; the board gets the current one', async () => {
  const raw = seed();
  const id = await published(raw);
  // owner2 quotes on revision 1, then the customer rewrites the job: revision 2.
  assert.equal((await post(as(raw, 'owner2'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 40_000, delivery_method: 'merchant_delivery' })).status, 201);
  raw.prepare(`UPDATE community_request_revisions SET spec = json_set(spec, '$.description', 'my old private notes') WHERE request_id = ? AND revision = 1`).run(id);
  raw.prepare(`UPDATE community_requests SET revision = 2 WHERE id = ?`).run(id);
  raw.prepare(`INSERT INTO community_request_revisions (id, request_id, revision, spec, reason) VALUES (?, ?, 2, '{"description":"the current text"}', 'edit')`).run(`crv_${id}_2`, id);

  const read = async (who: string | null, role?: StubUser['role']) => {
    const res = await get(as(raw, who, role), `/api/marketplace/print/requests/${id}/revisions`);
    return { status: res.status, body: await json(res) };
  };
  for (const [who, role] of [['buyer'], ['boss', 'admin'], ['owner2']] as Array<[string, StubUser['role']?]>) {
    const r = await read(who, role);
    assert.equal(r.status, 200, who);
    assert.equal(r.body.history, true, who);
    assert.deepEqual(r.body.revisions.map((x: { revision: number }) => x.revision), [1, 2], who);
  }
  for (const who of [null, 'owner', 'stranger']) {
    const r = await read(who);
    assert.equal(r.status, 200, String(who));
    assert.equal(r.body.history, false, String(who));
    assert.deepEqual(r.body.revisions.map((x: { revision: number }) => x.revision), [2], String(who));
    assert.ok(!JSON.stringify(r.body).includes('my old private notes'), `${who} never sees a past revision`);
  }
});
