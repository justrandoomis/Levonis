/**
 * «اطلب من المتجر طباعته» — A STORE PRODUCT, ASKED OF ITS OWN STORE (plan
 * P1-06, docs/DECISIONS.md row 268).
 *
 *   the entry makes a DIRECT draft to the product's store, titled with the
 *   product's name in the customer's language, holding a link to the product
 *   page on the main site (the main source, `origin_id` = the product) and a
 *   copy of its cover picture with its sha256 — and NOTHING of the product's
 *   own files (the design is the store's, its paid files stay paid);
 *   the product as the shopfront shows it: a hidden or private product is
 *   ENTRY_NOT_FOUND, a store the public may not see STORE_UNAVAILABLE;
 *   an idle entry is answered again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, json, MemoryBucket, post, row, stubApp, type Mount } from './fixtures/app';
import { world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestEntryRoutes } from '../worker/routes/requestEntries';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace/print', requestEntryRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function shop(raw: DatabaseSync, bucket: MemoryBucket) {
  raw.exec(`
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp1','m1','s1','cable-clip','Cable clip','مشبك كابلات','active','active',5000,10,0),
      ('cp_hidden','m1','s1','hidden-clip','Hidden clip','','hidden','archived',5000,10,0);
    INSERT INTO product_files (id, product_id, store_id, file_key, role, name, bytes, mime, kind) VALUES
      ('pf1','cp1','s1','merchants/owner/private/clip.stl','download_after_purchase','clip.stl',684,'model/stl','model');
    INSERT INTO community_product_media (id, product_id, store_id, kind, media_key, position) VALUES
      ('pm1','cp1','s1','image','merchants/owner/public/clipcover.png',0);
  `);
  void bucket.put('merchants/owner/public/clipcover.png', PNG, { httpMetadata: { contentType: 'image/png' } });
  void bucket.put('merchants/owner/private/clip.stl', new Uint8Array(684), { httpMetadata: { contentType: 'model/stl' } });
}

const as = (raw: DatabaseSync, id: string, bucket: MemoryBucket) =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, {
    // The products are seeded as the shopfront would hold them; the fixture's auto-publish would unhide them.
    publishV2: false,
    env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket, STORE_ROOT_DOMAIN: 'levonis-iq.com' },
  });

async function enter(raw: DatabaseSync, bucket: MemoryBucket, product: string, lang = 'ar') {
  const res = await post(as(raw, 'buyer', bucket), '/api/marketplace/print/requests', { entry: { kind: 'product', product_id: product, store: 'ali3d' }, lang });
  return { status: res.status, body: await json(res) };
}

test('a store product becomes a direct draft: the product page as its main link, the cover copied, no product file', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  shop(raw, bucket);
  const born = await enter(raw, bucket, 'cp1');
  assert.equal(born.status, 201, JSON.stringify(born.body));
  const id = born.body.request_id as string;
  const d = born.body.draft;
  assert.equal(d.title, 'مشبك كابلات', 'the product name in the customer’s language');
  assert.equal(d.direct.merchant_id, 'm1');
  const r = row<Record<string, unknown>>(raw, 'SELECT visibility, target_merchant_id, origin_chat_id FROM community_requests WHERE id = ?', id)!;
  assert.deepEqual({ ...r }, { visibility: 'direct', target_merchant_id: 'm1', origin_chat_id: null });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chats'), 0);

  const link = row<Record<string, unknown>>(raw, `SELECT canonical_url, origin_id, origin_ref, is_primary FROM community_request_sources WHERE request_id = ? AND kind = 'link'`, id)!;
  assert.equal(link.canonical_url, 'https://levonis-iq.com/community/store/ali3d/p/cable-clip');
  assert.equal(link.origin_id, 'cp1');
  assert.equal(link.origin_ref, 'product');
  assert.equal(link.is_primary, 1);

  const files = raw.prepare('SELECT file_key, kind FROM community_request_files WHERE request_id = ?').all(id) as Array<{ file_key: string; kind: string }>;
  assert.equal(files.length, 1, 'the cover only — never the store’s files');
  assert.equal(files[0].kind, 'reference');
  assert.ok(files[0].file_key.startsWith('requests/buyer/'));
  assert.deepEqual(bucket.objects.get(files[0].file_key)!.bytes, PNG);
  const cover = row<Record<string, unknown>>(raw, `SELECT kind, origin_id, origin_ref, sha256 FROM community_request_sources WHERE request_id = ? AND file_id IS NOT NULL`, id)!;
  assert.deepEqual({ ...cover }, { kind: 'file', origin_id: 'cp1', origin_ref: 'product_cover', sha256: sha(PNG) });

  const en = await enter(raw, bucket, 'cp1', 'en');
  assert.equal(en.status, 200, 'an idle draft from the same product is answered again');
  assert.equal(en.body.request_id, id);
});

test('a product the shopfront would not show is not one to ask for; a store the public may not see says so', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  shop(raw, bucket);
  for (const id of ['cp_hidden', 'nope']) {
    const r = await enter(raw, bucket, id);
    assert.equal(r.status, 404, id);
    assert.equal(r.body.code, 'ENTRY_NOT_FOUND', id);
  }
  raw.prepare(`UPDATE community_merchants SET approved_at = NULL WHERE id = 'm1'`).run();
  const hidden = await enter(raw, bucket, 'cp1');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, 'STORE_UNAVAILABLE');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_requests WHERE customer_id = 'buyer'`), 0);
});
