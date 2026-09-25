/**
 * A CUSTOM REQUEST'S LIFE — draft, publish, revise, expire, cancel — and the
 * offers that hang off it. Audit 03 §10 E, H, I, J, K, P, U, W.
 *
 * Real routes and migrations through the D1 adapter; each test names the
 * defect it pins and asserts the corrected behaviour (the audit's probes
 * asserted the broken one).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb, dbThrough, asD1, stubApp, post, get, json, count, row, all, failingD1, type Mount,
} from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { runCommunitySweeps } from '../worker/lib/communityRequests';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | ArrayBuffer) {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async head(key: string) {
    const v = this.objects.get(key);
    return v ? ({ key, size: v.byteLength } as unknown as R2Object) : null;
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    return { body: new Blob([v as unknown as BlobPart]).stream(), httpEtag: `"${key}"`, arrayBuffer: async () => v.buffer };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

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
    -- A shop that can make anything FDM that fits 300 mm — so a publish has
    -- somebody to match and notify.
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra');
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

const as = (raw: DatabaseSync, id: string, opts: { db?: unknown; bucket?: MemoryBucket } = {}) =>
  stubApp(opts.db ?? asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, opts.bucket ? { env: { BUCKET: opts.bucket } } : {});

const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 };

async function newPublished(raw: DatabaseSync, spec: Record<string, unknown> = PLA): Promise<string> {
  const created = await json(await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please',
  }));
  const id = created.request.id as string;
  const pub = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, spec);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}

// ---------------------------------------------------------------------- E

test('E: the wizard\'s first step creates a DRAFT — not on the board, not biddable, not readable by anyone else', async () => {
  const raw = seed();
  const created = await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'Half-finished wizard', description: 'created at the end of step 1 only',
  });
  assert.equal(created.status, 201);
  const id = (await json(created)).request.id as string;
  assert.deepEqual(row(raw, 'SELECT state, status FROM community_requests WHERE id = ?', id), { state: 'draft', status: 'closed' });

  const board = await json(await get(as(raw, 'stranger'), '/api/marketplace/requests'));
  assert.ok(!(board.requests as Array<{ id: string }>).some((r) => r.id === id), 'a draft is not on the board');
  assert.equal((await get(as(raw, 'stranger'), `/api/marketplace/requests/${id}`)).status, 404);
  assert.equal((await get(as(raw, 'stranger'), `/api/marketplace/print/requests/${id}`)).status, 404);
  assert.equal((await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}`)).status, 200, 'its customer still sees it');

  const offer = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 1000 });
  assert.equal(offer.status, 404, 'a merchant cannot bid on a job that was never published');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ?', id), 0);
});

test('E: publishing is the one door onto the board — it opens the request, starts the expiry clock and runs the matching', async () => {
  const raw = seed();
  raw.exec("INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityRequestExpiryDays','30')");
  const created = await json(await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please',
  }));
  const id = created.request.id as string;
  const t0 = Date.now();
  const pub = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, PLA);
  assert.equal(pub.status, 200);
  const body = await json(pub);
  assert.equal(body.published, true);
  assert.ok(body.matching.notified >= 1, JSON.stringify(body.matching));

  const r = row<{ state: string; status: string; expires_at: string }>(raw, 'SELECT state, status, expires_at FROM community_requests WHERE id = ?', id)!;
  assert.equal(r.state, 'open');
  assert.equal(r.status, 'open');
  assert.ok(Date.parse(r.expires_at) >= t0 + 29 * 86_400_000, 'the 30 days start at publish');
  const board = await json(await get(as(raw, 'stranger'), '/api/marketplace/requests'));
  assert.ok((board.requests as Array<{ id: string }>).some((x) => x.id === id));
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 12_000 })).status, 201);
});

test('E: «إعادة الطلب» — the copy is a DRAFT, and goes through matching when it is published', async () => {
  const raw = seed();
  const source = await newPublished(raw);
  const before = count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request'");

  const res = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${source}/repeat`);
  assert.equal(res.status, 201);
  const body = await json(res);
  // W5-A (audit 03 §11 item 9): /repeat creates a draft — invisible, unmatched.
  assert.equal(body.published, false, JSON.stringify(body));
  assert.equal(body.draft, true);
  const copy = body.request_id as string;
  assert.notEqual(copy, source);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', copy)?.state, 'draft');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_matches WHERE request_id = ?', copy), 0);
  // Publishing the copy as stored is the one door onto the board.
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${copy}/publish`, {})).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', copy)?.state, 'open');
  // The matcher ran for the COPY: a decision row per merchant, and the shop
  // that can make it was told about the new request, by its own id.
  assert.ok(count(raw, 'SELECT COUNT(*) AS n FROM community_request_matches WHERE request_id = ?', copy) >= 1);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request' AND entity_id = ? AND user_id = 'owner'", copy),
    1
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request'"), before + 1);
  // It carries the source's spec, priced again today rather than copied.
  assert.deepEqual(row(raw, 'SELECT process, material_id FROM community_print_requests WHERE request_id = ?', copy), {
    process: 'fdm',
    material_id: 'pla',
  });
  assert.notEqual(row<{ estimate: string }>(raw, 'SELECT estimate FROM community_print_requests WHERE request_id = ?', copy)?.estimate, null);
});

// ---------------------------------------------------------------------- K

test('K: re-publishing a different job revises it — standing offers go stale, cannot be accepted, and their merchants are told', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const id = await newPublished(raw);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000 })).status, 201);
  const offerId = row<{ id: string }>(raw, 'SELECT id FROM community_offers WHERE request_id = ?', id)!.id;

  // PLA ×1 becomes resin ×50 ultra — the audit's own example.
  const again = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, {
    process: 'resin', material_id: 'resin-standard', quality: 'ultra', quantity: 50,
  });
  assert.equal(again.status, 200);
  assert.equal((await json(again)).revised, true);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)?.revision, 2);

  const seen = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`));
  const o = (seen.offers as Array<{ id: string; stale: boolean; revision: number; price_iqd: number }>)[0];
  assert.equal(o.stale, true, 'the customer is shown that the offer priced the old job');
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offerId}/accept`, {
    expected_price_iqd: o.price_iqd, offer_revision: o.revision,
  });
  assert.equal(acc.status, 409);
  assert.equal((await json(acc)).code, 'OFFER_STALE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'offer_stale' AND user_id = 'owner' AND entity_id = ?", offerId),
    1
  );

  // The merchant stands by it for the new job; now it can be accepted.
  const re = await post(as(raw, 'owner'), `/api/marketplace/offers/${offerId}/reconfirm`);
  assert.equal(re.status, 200);
  const fresh = (await json(re)).offer;
  assert.equal(fresh.revision, 2);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/offers/${offerId}/reconfirm`)).status, 409, 'nothing left to re-confirm');
  const ok = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offerId}/accept`, {
    expected_price_iqd: fresh.price_iqd, offer_revision: fresh.revision,
  });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
});

test('K: a re-publish that changes nothing revises nothing', async () => {
  const raw = seed();
  const id = await newPublished(raw);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000 })).status, 201);
  const again = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, PLA);
  assert.equal(again.status, 200);
  assert.equal((await json(again)).revised, false);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)?.revision, 1);
  const seen = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`));
  assert.equal((seen.offers as Array<{ stale: boolean }>)[0].stale, false);
});

test('K: an attachment added or removed while offers stand revises the job; the draft stage does not', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const upload = (id: string) => {
    const form = new FormData();
    form.append('file', new File([png as unknown as BlobPart], 'photo.png'));
    return as(raw, 'buyer', { bucket }).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form });
  };

  const created = await json(await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please',
  }));
  const id = created.request.id as string;
  assert.equal((await upload(id)).status, 201);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)?.revision, 1, 'nobody priced the draft');

  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, PLA)).status, 200);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000 })).status, 201);
  assert.equal((await upload(id)).status, 201);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)?.revision, 2);
  const seen = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`));
  assert.equal((seen.offers as Array<{ stale: boolean }>)[0].stale, true);
});

// ---------------------------------------------------------------------- J

test('J: the customer cannot cancel a request whose paid order is running — REQUEST_HAS_ORDER, and nothing moves', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const acc = await post(as(raw, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(acc.status, 201);
  const orderId = (await json(acc)).order.id as string;
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/orders/${orderId}/start`)).status, 200);

  const cancel = await post(as(raw, 'buyer'), '/api/marketplace/requests/r1/cancel');
  assert.equal(cancel.status, 409);
  assert.equal((await json(cancel)).code, 'REQUEST_HAS_ORDER');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")?.state, 'in_progress');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', orderId)?.state, 'in_progress');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE community_order_id = ?', orderId)?.state, 'held');
});

test('J: a request still taking offers cancels cleanly — offers rejected, count zero, preview links revoked', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO community_request_files (id,request_id,file_key,file_name,content_type,size_bytes,kind)
              VALUES ('f1','r1','requests/buyer/x.stl','x.stl','model/stl',84,'model');
            INSERT INTO model_view_tokens (token_hash,file_id,request_id,created_by,expires_at)
              VALUES ('hash1','f1','r1','owner','2099-01-01T00:00:00.000Z')`);
  const res = await post(as(raw, 'buyer'), '/api/marketplace/requests/r1/cancel');
  assert.equal(res.status, 200);
  assert.deepEqual(row(raw, "SELECT state, status, offer_count FROM community_requests WHERE id = 'r1'"), {
    state: 'cancelled', status: 'closed', offer_count: 0,
  });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r1' AND state = 'rejected'"), 2);
  assert.ok(row<{ revoked_at: string | null }>(raw, "SELECT revoked_at FROM model_view_tokens WHERE token_hash = 'hash1'")?.revoked_at);
  // A second tap is not an error.
  assert.equal((await post(as(raw, 'buyer'), '/api/marketplace/requests/r1/cancel')).status, 200);
});

// ---------------------------------------------------------------------- H

test('H: the advertised offer count follows the offers — down on withdraw, right again on a re-offer', async () => {
  const raw = seed();
  const countNow = () => row<{ offer_count: number }>(raw, "SELECT offer_count FROM community_requests WHERE id = 'r1'")!.offer_count;
  const live = () => count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r1' AND state IN ('pending','accepted')");

  assert.equal((await post(as(raw, 'owner'), '/api/marketplace/offers/o1/withdraw')).status, 200);
  assert.equal(countNow(), 1);
  assert.equal((await post(as(raw, 'owner'), '/api/marketplace/requests/r1/offers', { price_iqd: 40_000 })).status, 201);
  assert.equal(countNow(), 2);
  assert.equal(countNow(), live());
});

test('H (live data): migration 0116 heals counts the old code inflated', async () => {
  const raw = dbThrough('0113');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('buyer','Sara','s@x.co','h'), ('owner','Ali','a@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO community_requests (id,customer_id,title,state,offer_count) VALUES ('r1','buyer','X','receiving_offers',3);
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd,state) VALUES
      ('o1','r1','m1',100,'withdrawn'), ('o2','r1','m1',100,'pending');
  `);
  raw.exec(readFileSync(join(ROOT, 'migrations', '0116_community_request_integrity.sql'), 'utf8'));
  assert.equal(row<{ offer_count: number }>(raw, "SELECT offer_count FROM community_requests WHERE id = 'r1'")?.offer_count, 1);
  assert.deepEqual(row(raw, "SELECT revision, request_revision FROM community_offers WHERE id = 'o2'"), { revision: 1, request_revision: 1 });
});

// ---------------------------------------------------------------------- P

test('P: an offer is not written onto a request that left the board between the check and the write', async () => {
  const raw = seed();
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => s.sql.includes('INSERT INTO community_offers'))) {
      raw.exec("UPDATE community_requests SET state = 'cancelled', status = 'closed' WHERE id = 'r1'");
    }
  };
  raw.exec("UPDATE community_offers SET state = 'withdrawn' WHERE id = 'o1'");
  const res = await post(as(raw, 'owner', { db }), '/api/marketplace/requests/r1/offers', { price_iqd: 40_000 });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'REQUEST_NOT_OPEN');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r1' AND state = 'pending' AND merchant_id = 'm1'"), 0);
});

// ---------------------------------------------------------------------- I

test('I: a request past its expiry takes no offers and is not served to strangers, even before the sweep runs', async () => {
  const raw = seed();
  raw.exec("UPDATE community_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'r1'");
  raw.exec("UPDATE community_offers SET state = 'withdrawn' WHERE id = 'o2'");
  const offer = await post(as(raw, 'owner2'), '/api/marketplace/requests/r1/offers', { price_iqd: 1 });
  assert.equal(offer.status, 409);
  assert.equal((await json(offer)).code, 'REQUEST_EXPIRED');
  assert.equal((await get(as(raw, 'stranger'), '/api/marketplace/requests/r1')).status, 404);
  assert.equal((await get(as(raw, 'stranger'), '/api/marketplace/print/requests/r1')).status, 404);
  assert.equal((await get(as(raw, 'buyer'), '/api/marketplace/requests/r1')).status, 200);
});

test('I: the sweep makes expiry a state — the request and its pending offers expire together, once', async () => {
  const raw = seed();
  raw.exec(`
    UPDATE community_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'r1';
    INSERT INTO community_request_files (id,request_id,file_key,file_name,content_type,size_bytes,kind)
      VALUES ('f1','r1','requests/buyer/x.stl','x.stl','model/stl',84,'model');
    INSERT INTO model_view_tokens (token_hash,file_id,request_id,created_by,expires_at)
      VALUES ('hash1','f1','r1','owner','2099-01-01T00:00:00.000Z');
    -- A second request, still open, with one offer whose OWN validity ran out.
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r2','buyer','Gear','A gear','receiving_offers','open','public',1,'2099-01-01T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state,expires_at)
      VALUES ('o9','r2','m1','s1',1000,'pending','2020-06-01T00:00:00.000Z');
  `);
  const report = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(report.expired_requests, 1, JSON.stringify(report));
  assert.equal(report.expired_offers, 1, JSON.stringify(report));
  assert.deepEqual(row(raw, "SELECT state, status, offer_count FROM community_requests WHERE id = 'r1'"), {
    state: 'expired', status: 'closed', offer_count: 0,
  });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r1' AND state = 'expired'"), 2);
  assert.ok(row<{ revoked_at: string | null }>(raw, "SELECT revoked_at FROM model_view_tokens WHERE token_hash = 'hash1'")?.revoked_at);
  assert.deepEqual(row(raw, "SELECT state, offer_count FROM community_requests WHERE id = 'r2'"), { state: 'receiving_offers', offer_count: 0 });
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o9'")?.state, 'expired');

  const again = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(again.expired_requests + again.expired_offers, 0);
});

test('I: an offer validity must be a real future date', async () => {
  const raw = seed();
  raw.exec("UPDATE community_offers SET state = 'withdrawn' WHERE id = 'o1'");
  const bad = await post(as(raw, 'owner'), '/api/marketplace/requests/r1/offers', { price_iqd: 5000, expires_at: 'next week' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'OFFER_EXPIRY_INVALID');
  const ok = await post(as(raw, 'owner'), '/api/marketplace/requests/r1/offers', { price_iqd: 5000, expires_at: '2099-02-03' });
  assert.equal(ok.status, 201);
  assert.equal((await json(ok)).offer.expires_at, '2099-02-03T00:00:00.000Z');
});

// ------------------------------------------------------------------- U · W

test('W: a publish carrying a non-http link is refused, not stored for a merchant to click', async () => {
  const raw = seed();
  const created = await json(await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please',
  }));
  const id = created.request.id as string;
  const res = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, {
    ...PLA, source_kind: 'link', source_url: 'javascript:alert(document.cookie)',
  });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'BAD_URL');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)?.state, 'draft');
});

test('U: a re-publish keeps the id of the notification that really reached the merchant', async () => {
  const raw = seed();
  const id = await newPublished(raw);
  const first = row<{ notified: number; notification_id: string }>(raw,
    "SELECT notified, notification_id FROM community_request_matches WHERE request_id = ? AND merchant_id = 'm1'", id)!;
  assert.equal(first.notified, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE id = ?', first.notification_id), 1);

  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, PLA)).status, 200);
  const second = row<{ notified: number; notification_id: string }>(raw,
    "SELECT notified, notification_id FROM community_request_matches WHERE request_id = ? AND merchant_id = 'm1'", id)!;
  assert.equal(second.notification_id, first.notification_id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE id = ?', second.notification_id), 1);
  assert.equal(all(raw, "SELECT id FROM user_notifications WHERE kind = 'matching_request' AND user_id = 'owner'").length, 1);
});
