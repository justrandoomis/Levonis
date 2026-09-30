/**
 * FILES ON PRODUCTS (0157; docs/COMMUNITY_ECOSYSTEM.md §9.4) over the real
 * routes — the merchant's editor, the shopfront's list, the viewer link and
 * the download door — and every rule of theirs as an attack:
 *
 *   · a key is attached only when the ledger says it is the owner's own
 *     private `product_file` upload; another store's owner cannot touch this
 *     product's files; the roles are a closed list; at most 12;
 *   · the shopfront lists files by role and never a key or a URL to the bytes;
 *   · the download is a 404 for a guest, a 403 PRODUCT_FILE_NOT_GRANTED for a
 *     signed-in non-buyer, and an attachment for the buyer once the checkout
 *     batch captured the payment — with ONE grant per buyer per file however
 *     many times the order path runs, and never a key in the answer;
 *   · a REFUNDED order takes its grants back: the customer's cancel of the
 *     pending order (`cancelStoreOrder`, the one cancellation every door
 *     runs) revokes them in the batch that refunds the wallet, unless another
 *     live order of the buyer covers the product — and a grant whose order
 *     is cancelled is dead at the door even if a row were left behind;
 *   · a hidden product's file ids are nobody's to probe: a signed-in
 *     stranger gets the list's 404, while a buyer's grant outlives the hide;
 *   · a viewer link is bound to the guest's session, opens the coarse mesh,
 *     and dies when the product leaves the shopfront.
 *
 * Run: node --import tsx --test tests/productFiles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, put, json, count, row, hasColumn, pending, type StubUser, type Mount } from './fixtures/app';
import { seedCatalog } from './fixtures/catalog';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { merchantProductFileRoutes, publicProductFileRoutes } from '../worker/routes/productFiles';
import { printRequestRoutes } from '../worker/routes/printRequests';

const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const ZAIN: StubUser = { id: 'zain', role: 'merchant', email: 'zain@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const NOOR: StubUser = { id: 'noor', role: 'customer', email: 'noor@x.co' };

const mount: Mount = (a) => {
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/merchant', merchantProductFileRoutes);
  a.route('/api/product-files', publicProductFileRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/store-orders', storeOrderRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
};

/** An in-memory R2: `put`/`get`/`head`/`delete` the way the media layer calls them. */
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
    const copy = v.slice();
    return { key, size: v.byteLength, body: new Blob([copy as unknown as BlobPart]).stream(), httpEtag: `"${key}"`, arrayBuffer: async () => copy.buffer };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** A real one-triangle binary STL: 80-byte header, uint32 count, 50 bytes per triangle. */
function binaryStl(): Uint8Array {
  const b = new Uint8Array(84 + 50);
  const v = new DataView(b.buffer);
  v.setUint32(80, 1, true);
  const tri = [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0];
  tri.forEach((f, i) => v.setFloat32(84 + i * 4, f, true));
  return b;
}
const PDF = new TextEncoder().encode('%PDF-1.4\n%fake\n');

const STL_KEY = 'merchants/ali/product-files/dragon.stl';
const SRC_KEY = 'merchants/ali/product-files/dragon-source.stl';
const PDF_KEY = 'merchants/ali/product-files/guide.pdf';
const ZAIN_KEY = 'merchants/zain/product-files/zain.stl';
const PUBLIC_KEY = 'merchants/ali/public/public.stl';

function seed() {
  const raw = freshDb();
  seedCatalog(raw);
  const purpose = hasColumn(raw, 'file_objects', 'purpose');
  const obj = (key: string, owner: string, mime: string, bytes: number, visibility = 'private', p = 'product_file') =>
    purpose
      ? `('${key}','${visibility}','merchants','${owner}','${mime}',${bytes},'${p}')`
      : `('${key}','${visibility}','merchants','${owner}','${mime}',${bytes})`;
  const cols = purpose ? '(object_key,visibility,domain,owner_id,mime_type,byte_size,purpose)' : '(object_key,visibility,domain,owner_id,mime_type,byte_size)';
  const many = Array.from({ length: 14 }, (_, i) => obj(`merchants/ali/product-files/many-${i}.pdf`, 'ali', 'application/pdf', 10)).join(',');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('noor','Noor','noor@x.co','h','customer');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep_buyer','buyer','deposit','USD',100000,'approved','seed');
    INSERT INTO file_objects ${cols} VALUES
      ${obj(STL_KEY, 'ali', 'model/stl', 134)},
      ${obj(SRC_KEY, 'ali', 'model/stl', 134)},
      ${obj(PDF_KEY, 'ali', 'application/pdf', 15)},
      ${obj(ZAIN_KEY, 'zain', 'model/stl', 134)},
      ${obj(PUBLIC_KEY, 'ali', 'model/stl', 134, 'public')},
      ${many};
  `);
  const bucket = new MemoryBucket();
  void bucket.put(STL_KEY, binaryStl());
  void bucket.put(SRC_KEY, binaryStl());
  void bucket.put(PDF_KEY, PDF);
  return { raw, bucket };
}

const as = (raw: DatabaseSync, bucket: MemoryBucket, user: StubUser | null, host?: string) =>
  stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket }, host });

/** A published simple product of Ali's, through the catalogue route. */
async function product(raw: DatabaseSync, bucket: MemoryBucket): Promise<string> {
  const res = await post(as(raw, bucket, ALI), '/api/merchant/products', { name: 'Dragon STL', price_iqd: 10_000, state: 'published', track_stock: true, stock: 5 });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).product.id as string;
}

async function attach(raw: DatabaseSync, bucket: MemoryBucket, pid: string, body: Record<string, unknown>, who: StubUser = ALI) {
  return post(as(raw, bucket, who), `/api/merchant/products/${pid}/files`, body);
}

/** Ali's product with a preview, a printable, a source and an instruction sheet. */
async function furnished(raw: DatabaseSync, bucket: MemoryBucket) {
  const pid = await product(raw, bucket);
  const ids: Record<string, string> = {};
  for (const [role, key, name] of [
    ['preview', STL_KEY, 'Dragon preview'],
    ['download_after_purchase', SRC_KEY, 'Dragon printable'],
    ['instruction', PDF_KEY, 'Printing guide'],
  ] as const) {
    const res = await attach(raw, bucket, pid, { file_key: key, role, name });
    assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
    ids[role] = (await json(res)).file.id;
  }
  return { pid, ids };
}

async function buy(raw: DatabaseSync, bucket: MemoryBucket, pid: string, key: string) {
  const app = as(raw, bucket, BUYER);
  const add = await post(app, '/api/cart/merchant-items', { productId: pid, qty: 1 });
  assert.equal(add.status, 201, JSON.stringify(await json(add.clone())));
  const q = await json(await post(app, '/api/store-orders/quote', { addressId: 'a1' }));
  assert.ok(q.quote, JSON.stringify(q));
  const res = await post(app, '/api/store-orders', { idempotencyKey: key, addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).order.id as string;
}

const UA = { 'User-Agent': 'LevonisTest/1.0' };

// ================================================================ the editor

test('the owner attaches files by role; a model gets its preview mesh; the roles are a closed list', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const list = await json(await get(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files`));
  assert.equal(list.files.length, 3);
  const preview = list.files.find((f: { id: string }) => f.id === ids.preview);
  assert.equal(preview.kind, 'model');
  assert.equal(preview.has_preview, true, 'the STL was measured and its LVM mesh stored');
  assert.equal(preview.file_key, STL_KEY, 'the owner sees the key — it is what the editor sends back');
  assert.ok(bucket.objects.has(`product-previews/${pid}/${ids.preview}.lvm`), 'the mesh sits under a prefix /files/* refuses');
  const guide = list.files.find((f: { id: string }) => f.id === ids.instruction);
  assert.equal(guide.kind, 'document');
  assert.equal(guide.has_preview, false);

  const bad = await attach(raw, bucket, pid, { file_key: PDF_KEY, role: 'thumbnail' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'PRODUCT_FILE_ROLE_INVALID');

  // Attaching the same object again is a replay, not a second row.
  const again = await attach(raw, bucket, pid, { file_key: PDF_KEY, role: 'reference' });
  assert.equal(again.status, 200);
  assert.equal((await json(again)).replayed, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_files WHERE product_id = ?', pid), 3);
});

test('a key that is not the owner\'s own PRIVATE product_file upload is refused, and another store\'s owner cannot touch this product', async () => {
  const { raw, bucket } = seed();
  const pid = await product(raw, bucket);
  for (const key of [ZAIN_KEY, PUBLIC_KEY, 'merchants/ali/product-files/never-uploaded.stl', '/files/merchants/ali/product-files/nope.stl']) {
    const res = await attach(raw, bucket, pid, { file_key: key, role: 'preview' });
    assert.equal(res.status, 400, key);
    assert.equal((await json(res)).code, 'PRODUCT_FILE_NOT_OWNED', key);
  }
  // Zain owns a store too — this product is not his, and the door says only "not found".
  const zain = await attach(raw, bucket, pid, { file_key: ZAIN_KEY, role: 'preview' }, ZAIN);
  assert.equal(zain.status, 404);
  assert.equal((await get(as(raw, bucket, ZAIN), `/api/merchant/products/${pid}/files`)).status, 404);
  // A plain customer has no store at all.
  assert.equal((await attach(raw, bucket, pid, { file_key: STL_KEY, role: 'preview' }, BUYER)).status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_files'), 0);
});

test('at most 12 files on a product; reorder, rename and remove are the owner\'s', async () => {
  const { raw, bucket } = seed();
  const pid = await product(raw, bucket);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await attach(raw, bucket, pid, { file_key: `merchants/ali/product-files/many-${i}.pdf`, role: 'reference' });
    assert.equal(res.status, 201, `file ${i}`);
    ids.push((await json(res)).file.id);
  }
  const over = await attach(raw, bucket, pid, { file_key: 'merchants/ali/product-files/many-12.pdf', role: 'reference' });
  assert.equal(over.status, 409);
  assert.equal((await json(over)).code, 'PRODUCT_FILE_LIMIT');

  const reordered = await put(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files/order`, { ids: [...ids].reverse() });
  assert.equal(reordered.status, 200);
  assert.equal((await json(reordered)).files[0].id, ids[11]);

  const renamed = await patch(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files/${ids[0]}`, { name: 'Sheet A', role: 'instruction' });
  assert.equal(renamed.status, 200);
  assert.equal((await json(renamed)).file.name, 'Sheet A');
  assert.equal((await patch(as(raw, bucket, ZAIN), `/api/merchant/products/${pid}/files/${ids[0]}`, { name: 'Mine now' })).status, 404);

  assert.equal((await as(raw, bucket, ALI).request(`/api/merchant/products/${pid}/files/${ids[0]}`, { method: 'DELETE' })).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_files WHERE product_id = ?', pid), 11);
  const gone = await patch(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files/${ids[0]}`, { name: 'x' });
  assert.equal(gone.status, 404);
  assert.equal((await json(gone)).code, 'PRODUCT_FILE_NOT_FOUND');
});

// ============================================================== the shopfront

test('the shopfront lists files by role and never a key, a preview key or a URL to the bytes', async () => {
  const { raw, bucket } = seed();
  const { pid } = await furnished(raw, bucket);
  const res = await get(as(raw, bucket, null), `/api/product-files/ali3d/${pid}`);
  assert.equal(res.status, 200);
  const text = await res.clone().text();
  assert.ok(!text.includes('file_key') && !text.includes('preview_key') && !text.includes('merchants/ali') && !text.includes('/files/'), text);
  const files = (await json(res)).files;
  assert.deepEqual(
    files.map((f: { role: string; downloadable: boolean; has_preview: boolean }) => [f.role, f.downloadable, f.has_preview]),
    [['preview', false, true], ['download_after_purchase', false, true], ['instruction', false, false]]
  );
  // A product of another store cannot be read through this store's slug.
  assert.equal((await get(as(raw, bucket, null), `/api/product-files/zainprint/${pid}`)).status, 404);
  // Hidden from the shopfront, hidden here — except to its owner.
  raw.prepare("UPDATE community_products SET publish_state = 'hidden' WHERE id = ?").run(pid);
  assert.equal((await get(as(raw, bucket, null), `/api/product-files/ali3d/${pid}`)).status, 404);
  assert.equal((await get(as(raw, bucket, ALI), `/api/product-files/ali3d/${pid}`)).status, 200);
});

test('the download: 404 for a guest, 403 PRODUCT_FILE_NOT_GRANTED for a signed-in non-buyer, an attachment for the buyer after checkout — never a key', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const path = (fid: string) => `/api/product-files/ali3d/${pid}/${fid}/download`;

  const guest = await get(as(raw, bucket, null), path(ids.download_after_purchase));
  assert.equal(guest.status, 404);
  const nonBuyer = await get(as(raw, bucket, NOOR), path(ids.download_after_purchase));
  assert.equal(nonBuyer.status, 403);
  assert.equal((await json(nonBuyer)).code, 'PRODUCT_FILE_NOT_GRANTED');
  const notYet = await get(as(raw, bucket, BUYER), path(ids.download_after_purchase));
  assert.equal(notYet.status, 403, 'the buyer before buying is a non-buyer');

  const orderId = await buy(raw, bucket, pid, 'buy-1-0123456789abcdef');
  // The checkout batch wrote one grant per downloadable-role file: the printable and the guide, never the preview.
  const grants = raw.prepare('SELECT product_file_id, order_id, downloads FROM product_file_grants WHERE user_id = ? ORDER BY product_file_id').all('buyer') as Array<{ product_file_id: string; order_id: string; downloads: number }>;
  assert.deepEqual(grants.map((g) => g.product_file_id).sort(), [ids.download_after_purchase, ids.instruction].sort());
  assert.ok(grants.every((g) => g.order_id === orderId && g.downloads === 0));

  const ok = await get(as(raw, bucket, BUYER), path(ids.download_after_purchase));
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.match(ok.headers.get('Content-Disposition') ?? '', /^attachment; filename="Dragon printable"/);
  assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(ok.headers.get('Cache-Control'), 'private, no-store');
  assert.match(ok.headers.get('Content-Security-Policy') ?? '', /sandbox/);
  const body = new Uint8Array(await ok.arrayBuffer());
  assert.equal(body.byteLength, 134, 'the stored bytes, streamed');
  ok.headers.forEach((h) => assert.ok(!h.includes('merchants/ali'), 'no key in any header'));
  assert.equal(row<{ downloads: number }>(raw, 'SELECT downloads FROM product_file_grants WHERE product_file_id = ? AND user_id = ?', ids.download_after_purchase, 'buyer')?.downloads, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product_file.downloaded'"), 1, 'every download logged');

  // The guide too (reference/instruction are downloadable after purchase, §9.4); the preview never.
  assert.equal((await get(as(raw, bucket, BUYER), path(ids.instruction))).status, 200);
  assert.equal((await get(as(raw, bucket, BUYER), path(ids.preview))).status, 404);
  // Somebody else's account gains nothing from the buyer's purchase.
  assert.equal((await get(as(raw, bucket, NOOR), path(ids.download_after_purchase))).status, 403);
  // The owner downloads their own files without a grant.
  assert.equal((await get(as(raw, bucket, ALI), path(ids.download_after_purchase))).status, 200);
  // The shopfront list now says so for the buyer, and still not for a guest.
  const mine = (await json(await get(as(raw, bucket, BUYER), `/api/product-files/ali3d/${pid}`))).files;
  assert.deepEqual(mine.map((f: { downloadable: boolean }) => f.downloadable), [false, true, true]);
  assert.deepEqual((await json(await get(as(raw, bucket, null), `/api/product-files/ali3d/${pid}`))).files.map((f: { downloadable: boolean }) => f.downloadable), [false, false, false]);
});

test('ONE grant per buyer per file, however many times the paid transition runs', async () => {
  const { raw, bucket } = seed();
  const { pid } = await furnished(raw, bucket);
  await buy(raw, bucket, pid, 'buy-1-0123456789abcdef');
  await buy(raw, bucket, pid, 'buy-2-0123456789abcdef');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', 'buyer'), 2);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_file_grants WHERE user_id = ?', 'buyer'), 2, 'two files, two grants — not four');
  // A file added AFTER the purchase is not the buyer's: the grant is per file row, written at the sale.
  const late = await attach(raw, bucket, pid, { file_key: 'merchants/ali/product-files/many-0.pdf', role: 'download_after_purchase' });
  assert.equal(late.status, 201);
  assert.equal((await get(as(raw, bucket, BUYER), `/api/product-files/ali3d/${pid}/${(await json(late)).file.id}/download`)).status, 403);
});

/** The customer's cancel of a still-pending store order: `cancelStoreOrder` refunds the wallet and, now, revokes the grants. */
async function cancelAsBuyer(raw: DatabaseSync, bucket: MemoryBucket, orderId: string) {
  const res = await post(as(raw, bucket, BUYER), `/api/orders/${orderId}/cancel`, {});
  assert.equal(res.status, 200, await res.clone().text());
  await Promise.all(pending.splice(0));
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', orderId)?.status, 'cancelled');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = ?', `wtx_refund_${orderId}_usd`), 1, 'the customer got their money back');
}

test('a REFUNDED order takes its grants back: the download is 403 again and the list says so; a second paid order keeps the file', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const download = `/api/product-files/ali3d/${pid}/${ids.download_after_purchase}/download`;
  const list = `/api/product-files/ali3d/${pid}`;

  const first = await buy(raw, bucket, pid, 'buy-refund-1-0123456789');
  assert.equal((await get(as(raw, bucket, BUYER), download)).status, 200, 'the buyer downloads once the batch captured the payment');

  await cancelAsBuyer(raw, bucket, first);
  // Money reversed → no live grant, and the door is shut again: 403, not 404 — the product is still on the shopfront.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_file_grants WHERE user_id = ?', 'buyer'), 0, 'a refunded order leaves no grant behind');
  const after = await get(as(raw, bucket, BUYER), download);
  assert.equal(after.status, 403, `a refunded buyer is a non-buyer again (got ${after.status})`);
  assert.equal((await json(after)).code, 'PRODUCT_FILE_NOT_GRANTED');
  assert.deepEqual((await json(await get(as(raw, bucket, BUYER), list))).files.map((f: { downloadable: boolean; granted: boolean }) => [f.downloadable, f.granted]), [[false, false], [false, false], [false, false]]);

  // Bought twice: ONE grant row (UNIQUE per file and buyer), stamped with the earlier order.
  const second = await buy(raw, bucket, pid, 'buy-refund-2-0123456789');
  const third = await buy(raw, bucket, pid, 'buy-refund-3-0123456789');
  assert.deepEqual([...new Set((raw.prepare('SELECT order_id FROM product_file_grants WHERE user_id = ?').all('buyer') as Array<{ order_id: string }>).map((g) => g.order_id))], [second]);
  // Cancelling the order the row names must not take a file the other, still-paid order bought: the row is re-pointed, the download stays.
  await cancelAsBuyer(raw, bucket, second);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_file_grants WHERE user_id = ? AND order_id = ?', 'buyer', third), 2, 're-pointed at the live order');
  assert.equal((await get(as(raw, bucket, BUYER), download)).status, 200, 'the other order still paid for it');
  // …and when that one is refunded too, nothing is left.
  await cancelAsBuyer(raw, bucket, third);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_file_grants WHERE user_id = ?', 'buyer'), 0);
  assert.equal((await get(as(raw, bucket, BUYER), download)).status, 403);

  // THE SECOND LOCK: a grant row whose order is cancelled opens nothing even when it is still there
  // (a row written before the revoke statement existed, or by a refund path that forgot it).
  const fourth = await buy(raw, bucket, pid, 'buy-refund-4-0123456789');
  assert.equal((await get(as(raw, bucket, BUYER), download)).status, 200);
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(fourth);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_file_grants WHERE user_id = ?', 'buyer'), 2, 'the rows were left in place on purpose');
  assert.equal((await get(as(raw, bucket, BUYER), download)).status, 403, 'dead at the door');
  assert.deepEqual((await json(await get(as(raw, bucket, BUYER), list))).files.map((f: { granted: boolean }) => f.granted), [false, false, false]);
  assert.equal((await json(await post(as(raw, bucket, BUYER), `/api/product-files/ali3d/${pid}/${ids.preview}/viewer-token`, {}, UA))).grant, 'preview');
});

test('a hidden product answers a signed-in stranger the list\'s 404 on the download door too — no oracle; a buyer\'s grant outlives the hide', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const download = (fid: string) => `/api/product-files/ali3d/${pid}/${fid}/download`;
  await buy(raw, bucket, pid, 'buy-hidden-0123456789ab');
  assert.equal((await get(as(raw, bucket, NOOR), download(ids.download_after_purchase))).status, 403, 'while the product is shown, «you have not bought this» reveals nothing');

  raw.prepare("UPDATE community_products SET publish_state = 'hidden', status = 'hidden' WHERE id = ?").run(pid);
  assert.equal((await get(as(raw, bucket, NOOR), `/api/product-files/ali3d/${pid}`)).status, 404, 'the list');
  const real = await get(as(raw, bucket, NOOR), download(ids.download_after_purchase));
  assert.equal(real.status, 404, 'a real file id of a hidden product is not distinguishable from a made-up one');
  assert.equal((await json(real)).code, 'PRODUCT_FILE_NOT_FOUND');
  assert.equal((await get(as(raw, bucket, NOOR), download('pf_made_up'))).status, 404);
  assert.equal((await get(as(raw, bucket, BUYER), download(ids.download_after_purchase))).status, 200, 'a purchase outlives a hide');
  assert.equal((await get(as(raw, bucket, ALI), download(ids.download_after_purchase))).status, 200, 'and so does the owner');
});

// ================================================================= the viewer


test('a guest\'s viewer link is bound to their session, opens the coarse mesh through the shared viewer, and dies when the product is hidden', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const mintPath = (fid: string) => `/api/product-files/ali3d/${pid}/${fid}/viewer-token`;

  // Only a `preview` file is viewable; a file without a mesh has nothing to show.
  const notPreview = await post(as(raw, bucket, null), mintPath(ids.download_after_purchase), {}, UA);
  assert.equal(notPreview.status, 403);
  const noMesh = await post(as(raw, bucket, null), mintPath(ids.instruction), {}, UA);
  assert.equal(noMesh.status, 403, 'an instruction sheet is not a preview role');

  const minted = await post(as(raw, bucket, null), mintPath(ids.preview), {}, UA);
  assert.equal(minted.status, 200, await minted.clone().text());
  const { token, url, grant, expires_at } = await json(minted);
  assert.equal(grant, 'preview');
  assert.equal(url, `/model-viewer/${token}`);
  assert.ok(Date.parse(expires_at) <= Date.now() + 60 * 60_000 + 5_000);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM model_view_tokens'), 0, 'a product link is not a request token');
  const stored = row<{ bound_user: string | null; bound_session: string | null; source_type: string }>(raw, 'SELECT bound_user, bound_session, source_type FROM viewer_grants')!;
  assert.equal(stored.bound_user, null);
  assert.equal(stored.source_type, 'product');
  assert.equal(stored.bound_session?.length, 64, 'a SHA-256 of IP + UA + day, never the IP');

  const meta = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`, UA);
  assert.equal(meta.status, 200, await meta.clone().text());
  const m = await json(meta);
  assert.equal(m.grant, 'preview');
  assert.equal(m.source_type, 'product');
  assert.equal(m.name, 'Dragon preview');
  assert.equal(m.format, 'stl');
  assert.equal(m.triangle_count, 1);

  const mesh = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}/mesh`, UA);
  assert.equal(mesh.status, 200);
  const bytes = new Uint8Array(await mesh.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x4c, 0x56, 0x4d, 0x31], 'LVM1 — the derived mesh, never the STL');
  assert.equal(mesh.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(row<{ uses: number }>(raw, 'SELECT uses FROM viewer_grants')?.uses, 1);

  // Another browser, another day: the same token opens nothing.
  const other = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`, { 'User-Agent': 'Somebody/2.0' });
  assert.equal(other.status, 404);
  assert.equal((await json(other)).code, 'VIEWER_TOKEN_INVALID');
  // Nor does a signed-in account in another browser; the same browser, signed in, is the same person.
  assert.equal((await get(as(raw, bucket, NOOR), `/api/marketplace/print/viewer/${token}`, { 'User-Agent': 'Somebody/2.0' })).status, 404);

  // The owner hides the product: the link is revoked, and a fresh mint is refused to a guest.
  const hide = await patch(as(raw, bucket, ALI), `/api/merchant/products/${pid}`, { state: 'hidden' });
  assert.equal(hide.status, 200, await hide.clone().text());
  assert.ok(row<{ revoked_at: string | null }>(raw, 'SELECT revoked_at FROM viewer_grants')?.revoked_at, 'revoked_at written by the hide');
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${token}`, UA)).status, 404);
  assert.equal((await post(as(raw, bucket, null), mintPath(ids.preview), {}, UA)).status, 404);
});

test('the owner\'s and a buyer\'s links carry the full grant; a signed-in link is bound to the account; a re-roled file loses its links', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const mintPath = `/api/product-files/ali3d/${pid}/${ids.preview}/viewer-token`;
  const owner = await json(await post(as(raw, bucket, ALI), mintPath, {}, UA));
  assert.equal(owner.grant, 'full');
  assert.equal((await get(as(raw, bucket, ALI), `/api/marketplace/print/viewer/${owner.token}`, UA)).status, 200);
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${owner.token}`, UA)).status, 404, 'bound to the account, not the browser');
  const shopper = await json(await post(as(raw, bucket, NOOR), mintPath, {}, UA));
  assert.equal(shopper.grant, 'preview');

  // The merchant turns the preview into a reference sheet: its links stop.
  assert.equal((await patch(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files/${ids.preview}`, { role: 'reference' })).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM viewer_grants WHERE revoked_at IS NOT NULL'), 2);
  assert.equal((await get(as(raw, bucket, ALI), `/api/marketplace/print/viewer/${owner.token}`, UA)).status, 404);

  // Deleting the product (no orders) revokes whatever is left and cascades the rows.
  assert.equal((await patch(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files/${ids.preview}`, { role: 'preview' })).status, 200);
  const again = await json(await post(as(raw, bucket, ALI), mintPath, {}, UA));
  assert.equal((await as(raw, bucket, ALI).request(`/api/merchant/products/${pid}`, { method: 'DELETE' })).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_files'), 0);
  assert.equal((await get(as(raw, bucket, ALI), `/api/marketplace/print/viewer/${again.token}`, UA)).status, 404);
});

test('a BUYER\'s link on the preview file carries the full grant (§4d), and the list marks the preview row theirs — from the grants on the product\'s other files', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const mintPath = `/api/product-files/ali3d/${pid}/${ids.preview}/viewer-token`;
  // The preview role itself is never granted: «buyer» is a live grant on any file of the product.
  assert.equal((await json(await post(as(raw, bucket, BUYER), mintPath, {}, UA))).grant, 'preview', 'before buying: the coarse mesh');
  await buy(raw, bucket, pid, 'buy-full-0123456789abcd');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_file_grants WHERE user_id = ? AND product_file_id = ?', 'buyer', ids.preview), 0, 'no grant row on the preview file');
  const buyer = await json(await post(as(raw, bucket, BUYER), mintPath, {}, UA));
  assert.equal(buyer.grant, 'full', '«`full` for owner/buyer» — the buyer gets the stored mesh, not the coarse one');
  assert.equal((await get(as(raw, bucket, BUYER), `/api/marketplace/print/viewer/${buyer.token}`, UA)).status, 200);
  const files = (await json(await get(as(raw, bucket, BUYER), `/api/product-files/ali3d/${pid}`))).files as Array<{ role: string; granted: boolean; downloadable: boolean }>;
  assert.deepEqual(files.map((f) => [f.role, f.granted, f.downloadable]), [['preview', true, false], ['download_after_purchase', true, true], ['instruction', true, true]]);
  assert.deepEqual((await json(await get(as(raw, bucket, NOOR), `/api/product-files/ali3d/${pid}`))).files.map((f: { granted: boolean }) => f.granted), [false, false, false], 'somebody else gains nothing');
});

test('a request viewer token is untouched by the second table: an unknown token is one 404 for both worlds', async () => {
  const { raw, bucket } = seed();
  const dead = await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${'x'.repeat(43)}`, UA);
  assert.equal(dead.status, 404);
  assert.equal((await json(dead)).code, 'VIEWER_TOKEN_INVALID');
  assert.equal((await get(as(raw, bucket, null), `/api/marketplace/print/viewer/${'x'.repeat(43)}/mesh`, UA)).status, 404);
});
