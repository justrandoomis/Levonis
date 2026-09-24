/**
 * THE MODEL A CUSTOMER UPLOADED, AND WHO GETS TO SEE IT — audit 03 §10 F
 * (viewer links) and G (original files behind the maintenance gate).
 *
 * Before: any signed-in account could mint a 168-hour ANONYMOUS link to a
 * stranger's model preview; the link outlived the request and reported the
 * customer's own file name; and the original file downloaded with a 200 while
 * the board beside it answered 503. Real routes, real migrations, an
 * in-memory R2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, row, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes, VIEWER_TOKEN_TTL_MINUTES } from '../worker/routes/printRequests';

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

function seed(opts: { gate?: string } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Ali','a@x.co','h','customer'),
      ('owner2','Omar','o@x.co','h','customer'), ('lapsed','Zaid','z@x.co','h','customer'),
      ('stranger','Nour','n@x.co','h','customer'), ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES
      ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D'), ('m3','lapsed','Zaid 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D'), ('s3','m3','lapsed','zaid3d','Zaid 3D');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','buyer','A crown','A dental crown model','receiving_offers','open','public',1,'2099-01-01T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o1','r1','m1','s1',50000,'pending');
    INSERT INTO community_request_files (id,request_id,file_key,file_name,content_type,size_bytes,kind,analysis,model_format,preview_key)
      VALUES ('f1','r1','requests/buyer/x.stl','Sara_Ahmed_dental_crown.stl','model/stl',84,'model',
              '{"dimensions_mm":{"x":10,"y":10,"z":10},"volume_mm3":1000}','stl','request-previews/r1/f1.lvm');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
  `);
  raw.prepare("INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate', ?)").run(opts.gate ?? '{"open":true}');
  const bucket = new MemoryBucket();
  void bucket.put('requests/buyer/x.stl', new Uint8Array(84));
  void bucket.put('request-previews/r1/f1.lvm', new Uint8Array([0x4c, 0x56, 0x4d, 0x31, 0, 0, 0, 0]));
  return { raw, bucket };
}

const as = (raw: DatabaseSync, bucket: MemoryBucket, id: string | null, role: 'customer' | 'admin' = 'customer') =>
  stubApp(asD1(raw), id ? { id, role, email: `${id}@x.co` } : null, mount, { env: { BUCKET: bucket } });

const mint = (raw: DatabaseSync, bucket: MemoryBucket, who: string, body: Record<string, unknown> = {}) =>
  post(as(raw, bucket, who), '/api/marketplace/print/requests/r1/files/f1/viewer-token', body);

// ---------------------------------------------------------------------- F

test('F: a plain customer account cannot mint a preview of somebody else\'s model; the customer and a quoting merchant can', async () => {
  const { raw, bucket } = seed();
  const stranger = await mint(raw, bucket, 'stranger');
  assert.equal(stranger.status, 403);
  assert.equal((await json(stranger)).code, 'VIEWER_NOT_ALLOWED');
  // A shop whose plan lapsed cannot quote, so it has no reason to preview.
  assert.equal((await mint(raw, bucket, 'lapsed')).status, 403);
  assert.equal((await mint(raw, bucket, 'buyer')).status, 200);
  assert.equal((await mint(raw, bucket, 'owner2')).status, 200);
  assert.equal(
    row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM model_view_tokens')?.n,
    2,
    'only the two allowed mints wrote a row'
  );
});

test('F: the link lives minutes, not days — whatever the caller asks for', async () => {
  const { raw, bucket } = seed();
  const t0 = Date.now();
  const res = await mint(raw, bucket, 'owner2', { hours: 168 });
  assert.equal(res.status, 200);
  const expires = Date.parse((await json(res)).expires_at);
  assert.ok(expires <= t0 + VIEWER_TOKEN_TTL_MINUTES * 60_000 + 5_000, new Date(expires).toISOString());
  assert.ok(VIEWER_TOKEN_TTL_MINUTES <= 60);
});

test('F: the viewer never tells a link-holder the customer\'s file name', async () => {
  const { raw, bucket } = seed();
  const { token } = await json(await mint(raw, bucket, 'owner2'));
  const meta = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`);
  assert.equal(meta.status, 200);
  const text = await meta.text();
  assert.ok(!text.includes('Sara_Ahmed'), text);
  assert.ok(!('name' in JSON.parse(text)), text);
  assert.equal(JSON.parse(text).format, 'stl');
  const mesh = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}/mesh`);
  assert.equal(mesh.status, 200);
});

test('F: cancelling the request kills its links, and no new one can be minted', async () => {
  const { raw, bucket } = seed();
  const { token } = await json(await mint(raw, bucket, 'owner2'));
  assert.equal((await post(as(raw, bucket, 'buyer'), '/api/marketplace/requests/r1/cancel')).status, 200);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`)).status, 404);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}/mesh`)).status, 404);
  const again = await mint(raw, bucket, 'buyer');
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'REQUEST_CLOSED');
});

test('F: a closed request refuses its links at use time even if nothing revoked them', async () => {
  const { raw, bucket } = seed();
  const { token } = await json(await mint(raw, bucket, 'buyer'));
  raw.exec("UPDATE community_requests SET state = 'expired', status = 'closed' WHERE id = 'r1'");
  assert.equal(row<{ revoked_at: string | null }>(raw, 'SELECT revoked_at FROM model_view_tokens')?.revoked_at, null);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`)).status, 404);
});

test('F: acceptance revokes the losing merchants\' links; the customer\'s and the winner\'s keep working', async () => {
  const { raw, bucket } = seed();
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt1','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','f')`);
  const loser = (await json(await mint(raw, bucket, 'owner2'))).token;
  const winner = (await json(await mint(raw, bucket, 'owner'))).token;
  const mine = (await json(await mint(raw, bucket, 'buyer'))).token;
  const acc = await post(as(raw, bucket, 'buyer'), '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(acc.status, 201);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${loser}`)).status, 404);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${winner}`)).status, 200);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${mine}`)).status, 200);
  // And a merchant who lost cannot mint a fresh one either.
  assert.equal((await mint(raw, bucket, 'owner2')).status, 403);
  assert.equal((await mint(raw, bucket, 'owner')).status, 200, 'the engaged merchant keeps the preview');
});

// ---------------------------------------------------------------------- G

test('G: while Levo Community is shut, the original file answers like the board — 503 — to everyone it would have let in by the board', async () => {
  const { raw, bucket } = seed({ gate: '{"open":false}' });
  const board = await get(as(raw, bucket, 'stranger'), '/api/marketplace/requests');
  assert.equal(board.status, 503);
  const file = await get(as(raw, bucket, 'stranger'), '/api/marketplace/requests/r1/files/f1');
  assert.equal(file.status, 503);
  assert.equal((await json(file)).code, 'COMMUNITY_CLOSED');
  const viewer = await mint(raw, bucket, 'owner2');
  assert.equal(viewer.status, 503);
  // The customer's own file is theirs, shut or not; so is an admin's view.
  assert.equal((await get(as(raw, bucket, 'buyer'), '/api/marketplace/requests/r1/files/f1')).status, 200);
  assert.equal((await get(as(raw, bucket, 'boss', 'admin'), '/api/marketplace/requests/r1/files/f1')).status, 200);
});

test('G: a tester on the allow-list is let through, and the engaged merchant keeps the file with the wall up', async () => {
  const { raw, bucket } = seed({ gate: '{"open":false,"allowed_user_ids":["owner2"]}' });
  assert.equal((await get(as(raw, bucket, 'owner2'), '/api/marketplace/requests/r1/files/f1')).status, 200);
  raw.exec(`UPDATE community_offers SET state = 'accepted' WHERE id = 'o1';
            UPDATE community_requests SET state = 'in_progress', status = 'closed' WHERE id = 'r1';`);
  assert.equal((await get(as(raw, bucket, 'owner'), '/api/marketplace/requests/r1/files/f1')).status, 200);
  assert.equal((await get(as(raw, bucket, 'owner2'), '/api/marketplace/requests/r1/files/f1')).status, 404, 'off the board, the tester has no claim');
});

test('G: an expired request\'s files are not the board\'s any more', async () => {
  const { raw, bucket } = seed();
  raw.exec("UPDATE community_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'r1'");
  assert.equal((await get(as(raw, bucket, 'owner2'), '/api/marketplace/requests/r1/files/f1')).status, 404);
  assert.equal((await get(as(raw, bucket, 'buyer'), '/api/marketplace/requests/r1/files/f1')).status, 200);
});
