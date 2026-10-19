/**
 * «ملفاتك» — THE BUYER'S DOOR TO A PAID DOWNLOAD THAT DOES NOT DEPEND ON THE
 * SHOPFRONT (community v3 push 1.4 review; worker/lib/orderFiles.ts,
 * GET /api/orders/:id/files, src/components/orders/OrderFiles.tsx).
 *
 * The product page is the shopfront's, and a store not approved yet answers
 * it STORE_UNAVAILABLE — so before this door a buyer of a digital product on
 * such a store had no screen that led to the file the download door would
 * still serve them. Proved over the real routes:
 *
 *   · hidden store: the product read is 404 STORE_UNAVAILABLE, the order's
 *     files list what the buyer paid for, and every listed link downloads;
 *     the answer is `private, no-store` and carries no key;
 *   · someone else's order is the same «Order not found» a missing id gets;
 *   · a sanctioned store lists nothing (as its download door is closed);
 *   · a file the buyer holds no grant on is never listed;
 *   · a cancelled (refunded) order lists nothing;
 *   · the screen: the order page lazy-loads the block, the block asks this
 *     door, and it renders the download door's own link and «View in 3D»;
 *     its words in ar, en and real Sorani; StoreUnavailable says the files
 *     are in «My orders» too, in all three.
 *
 * Run: node --import tsx --test tests/orderFilesDoor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, stubApp, post, get, json, hasColumn, pending, type StubUser, type Mount } from './fixtures/app';
import { seedCatalog } from './fixtures/catalog';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { merchantProductFileRoutes, publicProductFileRoutes } from '../worker/routes/productFiles';
import { storefrontRoutes } from '../worker/routes/storefront';
import { LanguageProvider } from '../src/LanguageContext';
import { OrderFilesList, ORDER_FILES_STRINGS, ORDER_FILE_ROLE_ORDER, groupByProduct, orderFileAction, type OrderFilesDoor } from '../src/components/orders/OrderFiles';
import { orderFilesApi, type OrderFile } from '../src/components/orders/orderFilesApi';
import { formatBytes, storefrontFilesApi } from '../src/components/community/files/api';
import { ROLE_ORDER, bytesLabel, rowAction } from '../src/components/storefront/ProductFiles';
import { STOREFRONT_STRINGS } from '../src/components/storefront/strings';

const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const NOOR: StubUser = { id: 'noor', role: 'customer', email: 'noor@x.co' };

const mount: Mount = (a) => {
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/merchant', merchantProductFileRoutes);
  a.route('/api/product-files', publicProductFileRoutes);
  a.route('/api/storefront', storefrontRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/store-orders', storeOrderRoutes);
  a.route('/api/orders', orderRoutes);
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
const LATE_KEY = 'merchants/ali/product-files/late.pdf';

function seed() {
  const raw = freshDb();
  seedCatalog(raw);
  const purpose = hasColumn(raw, 'file_objects', 'purpose');
  const obj = (key: string, mime: string, bytes: number) =>
    purpose ? `('${key}','private','merchants','ali','${mime}',${bytes},'product_file')` : `('${key}','private','merchants','ali','${mime}',${bytes})`;
  const cols = purpose ? '(object_key,visibility,domain,owner_id,mime_type,byte_size,purpose)' : '(object_key,visibility,domain,owner_id,mime_type,byte_size)';
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('noor','Noor','noor@x.co','h','customer');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('dep_buyer','buyer','deposit','USD',100000,'approved','seed');
    INSERT INTO file_objects ${cols} VALUES
      ${obj(STL_KEY, 'model/stl', 134)},
      ${obj(SRC_KEY, 'model/stl', 134)},
      ${obj(PDF_KEY, 'application/pdf', 15)},
      ${obj(LATE_KEY, 'application/pdf', 15)};
  `);
  const bucket = new MemoryBucket();
  void bucket.put(STL_KEY, binaryStl());
  void bucket.put(SRC_KEY, binaryStl());
  void bucket.put(PDF_KEY, PDF);
  void bucket.put(LATE_KEY, PDF);
  return { raw, bucket };
}

const as = (raw: DatabaseSync, bucket: MemoryBucket, user: StubUser | null) => stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket } });

/** Ali's published product with a preview, a printable and an instruction sheet. */
async function furnished(raw: DatabaseSync, bucket: MemoryBucket) {
  const res = await post(as(raw, bucket, ALI), '/api/merchant/products', { name: 'Dragon STL', price_iqd: 10_000, state: 'published', track_stock: true, stock: 5 });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const pid = (await json(res)).product.id as string;
  const ids: Record<string, string> = {};
  for (const [role, key, name] of [
    ['preview', STL_KEY, 'Dragon preview'],
    ['download_after_purchase', SRC_KEY, 'Dragon printable'],
    ['instruction', PDF_KEY, 'Printing guide'],
  ] as const) {
    const r = await post(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files`, { file_key: key, role, name });
    assert.equal(r.status, 201, JSON.stringify(await json(r.clone())));
    ids[role] = (await json(r)).file.id;
  }
  const slug = (raw.prepare('SELECT slug FROM community_products WHERE id = ?').get(pid) as { slug: string }).slug;
  return { pid, ids, slug };
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

const hide = (raw: DatabaseSync) => raw.prepare("UPDATE community_merchants SET approved_at = NULL WHERE id = 'm_ali'").run();

async function filesOf(raw: DatabaseSync, bucket: MemoryBucket, user: StubUser, orderId: string) {
  const res = await get(as(raw, bucket, user), `/api/orders/${orderId}/files`);
  return { res, body: await json(res) };
}

test('a hidden (unapproved) store: the product page is STORE_UNAVAILABLE, the order lists the paid files, and every listed link downloads', async () => {
  const { raw, bucket } = seed();
  const { pid, ids, slug } = await furnished(raw, bucket);
  const orderId = await buy(raw, bucket, pid, 'order-files-0123456789abcdef');
  hide(raw);

  const page = await get(as(raw, bucket, BUYER), `/api/storefront/ali3d/products/${slug}`);
  assert.equal(page.status, 404);
  assert.equal((await json(page)).code, 'STORE_UNAVAILABLE', 'the shopfront is closed to the buyer too');

  const { res, body } = await filesOf(raw, bucket, BUYER, orderId);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store', 'a buyer\'s files are never cached');
  const files = body.files as OrderFile[];
  const byId = new Map(files.map((f) => [f.id, f]));
  for (const role of ['download_after_purchase', 'instruction'] as const) {
    const f = byId.get(ids[role]);
    assert.ok(f, `${role} is listed: ${JSON.stringify(files)}`);
    assert.equal(f.role, role);
    assert.equal(f.downloadable, true);
    assert.equal(f.store_slug, 'ali3d');
    assert.equal(f.product_id, pid);
    assert.equal(f.product_name, 'Dragon STL');
  }
  // The preview is offered «View in 3D» only when it carries a mesh — and never as a download.
  const mesh = (raw.prepare('SELECT preview_key FROM product_files WHERE id = ?').get(ids.preview) as { preview_key: string }).preview_key;
  assert.ok(mesh, 'the STL preview was given a derived mesh on attach');
  const preview = byId.get(ids.preview);
  assert.ok(preview, 'the bought product\'s preview is listed for the viewer');
  assert.equal(preview.downloadable, false);
  assert.equal(preview.has_preview, true);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /file_key|preview_key|merchants\/ali/, 'no storage key, no path to the bytes');

  // Every listed downloadable row opens at the existing door, for this buyer.
  for (const f of files.filter((x) => x.downloadable)) {
    const dl = await get(as(raw, bucket, BUYER), storefrontFilesApi.downloadUrl(f.store_slug, f.product_id, f.id));
    assert.equal(dl.status, 200, `${f.role}: ${await dl.clone().text()}`);
    assert.match(dl.headers.get('Content-Disposition') ?? '', /attachment/);
  }
  // And the listed preview mints a full viewer link for this buyer at the existing viewer door.
  const vt = await post(as(raw, bucket, BUYER), `/api/product-files/${preview.store_slug}/${preview.product_id}/${preview.id}/viewer-token`, {});
  assert.equal(vt.status, 200, await vt.clone().text());
  assert.equal((await json(vt)).grant, 'full');
  // A product taken off the shopfront keeps its downloads but not its viewer (that door does not outlive a hide).
  raw.prepare("UPDATE community_products SET status = 'hidden' WHERE id = ?").run(pid);
  const afterHide = (await filesOf(raw, bucket, BUYER, orderId)).body.files as OrderFile[];
  assert.ok(!afterHide.some((f) => f.id === ids.preview), 'no «View in 3D» the viewer door would refuse');
  assert.ok(afterHide.some((f) => f.id === ids.download_after_purchase), 'the download outlives the hide');
  await Promise.all(pending.splice(0));
});

test('someone else\'s order is the same «Order not found» a missing id gets — no oracle, no rows', async () => {
  const { raw, bucket } = seed();
  const { pid } = await furnished(raw, bucket);
  const orderId = await buy(raw, bucket, pid, 'order-files-foreign-0123456789');
  hide(raw);
  const foreign = await filesOf(raw, bucket, NOOR, orderId);
  const missing = await filesOf(raw, bucket, NOOR, 'ord_does_not_exist');
  assert.equal(foreign.res.status, 404);
  assert.equal(missing.res.status, 404);
  assert.deepEqual(foreign.body, missing.body, 'one answer for «not yours» and «not there»');
  assert.equal(foreign.body.files, undefined);
  // The store's owner is not this order's buyer either.
  assert.equal((await filesOf(raw, bucket, ALI, orderId)).res.status, 404);
  await Promise.all(pending.splice(0));
});

test('a sanctioned store lists nothing — its download door is closed too', async () => {
  const { raw, bucket } = seed();
  const { pid, ids } = await furnished(raw, bucket);
  const orderId = await buy(raw, bucket, pid, 'order-files-sanction-01234567');
  assert.ok((await filesOf(raw, bucket, BUYER, orderId)).body.files.length >= 2, 'listed before the sanction');
  raw.prepare("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's_ali'").run();
  const { res, body } = await filesOf(raw, bucket, BUYER, orderId);
  assert.equal(res.status, 200);
  assert.deepEqual(body.files, []);
  const dl = await get(as(raw, bucket, BUYER), `/api/product-files/ali3d/${pid}/${ids.download_after_purchase}/download`);
  assert.equal(dl.status, 404, 'the door the list would have linked is closed');
  // The merchant's own suspension is a sanction as well.
  raw.prepare("UPDATE merchant_stores SET status = 'active' WHERE id = 's_ali'").run();
  raw.prepare("UPDATE community_merchants SET status = 'suspended' WHERE id = 'm_ali'").run();
  assert.deepEqual((await filesOf(raw, bucket, BUYER, orderId)).body.files, []);
  await Promise.all(pending.splice(0));
});

test('a file the buyer holds no grant on is never listed; a cancelled order lists nothing', async () => {
  const { raw, bucket } = seed();
  const { pid } = await furnished(raw, bucket);
  const orderId = await buy(raw, bucket, pid, 'order-files-nogrant-012345678');
  // Attached AFTER the purchase: the checkout's batch granted what existed then, not this.
  const late = await post(as(raw, bucket, ALI), `/api/merchant/products/${pid}/files`, { file_key: LATE_KEY, role: 'reference', name: 'Late reference' });
  assert.equal(late.status, 201, await late.clone().text());
  const lateId = (await json(late)).file.id as string;
  hide(raw);
  const listed = (await filesOf(raw, bucket, BUYER, orderId)).body.files as OrderFile[];
  assert.ok(listed.length >= 2);
  assert.ok(!listed.some((f) => f.id === lateId), 'no grant, no row');
  const dl = await get(as(raw, bucket, BUYER), `/api/product-files/ali3d/${pid}/${lateId}/download`);
  assert.notEqual(dl.status, 200, 'and the door agrees');

  // A grant that is no longer live (its order cancelled and refunded) lists nothing either.
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
  assert.deepEqual((await filesOf(raw, bucket, BUYER, orderId)).body.files, []);
  await Promise.all(pending.splice(0));
});

// ------------------------------------------------------------------ the screen

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the order page lazy-loads «Your files» for a store order, and the block asks the order files door', async () => {
  const page = code('src/pages/OrderDetail.tsx');
  assert.match(page, /const OrderFiles = React\.lazy\(\(\) => import\('\.\.\/components\/orders\/OrderFiles'\)\)/);
  assert.match(page, /<OrderFiles orderId=\{order\.id\} \/>/);
  const block = code('src/components/orders/OrderFiles.tsx');
  assert.match(block, /orderFilesApi\s*\.list\(orderId\)/);
  assert.match(block, /door=\{storefrontFilesApi\}/, 'the links are the shopfront\'s own doors');

  // The door's URL, asked through the real client.
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ success: true, files: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await orderFilesApi.list('ord 1'), []);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\/api\/orders\/ord%201\/files$/);
});

const FILES: OrderFile[] = [
  { id: 'pf_src', role: 'download_after_purchase', name: 'Dragon printable', bytes: 2048, kind: 'model', has_preview: false, downloadable: true, granted: true, product_id: 'cp_1', product_name: 'Dragon STL', store_slug: 'ali3d' },
  { id: 'pf_prev', role: 'preview', name: 'Dragon preview', bytes: 134, kind: 'model', has_preview: true, downloadable: false, granted: true, product_id: 'cp_1', product_name: 'Dragon STL', store_slug: 'ali3d' },
  { id: 'pf_pdf', role: 'instruction', name: 'Printing guide', bytes: 15, kind: 'document', has_preview: false, downloadable: true, granted: true, product_id: 'cp_2', product_name: 'Vase', store_slug: 'ali3d' },
];

const render = (files: OrderFile[], door: OrderFilesDoor = storefrontFilesApi) =>
  renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(OrderFilesList, { files, door })) }));

test('«Your files» renders the download door\'s own link and «View in 3D»; nothing when the list is empty', () => {
  const html = render(FILES);
  assert.match(html, /data-order-files/);
  assert.ok(html.includes('href="/api/product-files/ali3d/cp_1/pf_src/download"'), html);
  assert.ok(html.includes('href="/api/product-files/ali3d/cp_2/pf_pdf/download"'));
  assert.match(html, /data-view-3d="pf_prev"/);
  assert.doesNotMatch(html, /data-download="pf_prev"/, 'a preview is viewed, never downloaded');
  assert.ok(html.includes('Dragon STL') && html.includes('Vase'), 'grouped under what was bought');
  assert.equal(render([]), '', 'an order with no files draws nothing');
  // Grouping keeps the server's product order and the shopfront's role order.
  const groups = groupByProduct(FILES);
  assert.deepEqual(groups.map((g) => g.productId), ['cp_1', 'cp_2']);
  assert.deepEqual(groups[0].files.map((f) => f.role), ['preview', 'download_after_purchase']);
});

test('the block\'s words — and StoreUnavailable\'s promise about files — in ar, en and real Sorani', () => {
  const SORANI = /[ەێۆڕڵ]/u;
  for (const k of ['title', 'intro'] as const) {
    const { ar, en, ckb } = { ar: ORDER_FILES_STRINGS.ar[k], en: ORDER_FILES_STRINGS.en[k], ckb: ORDER_FILES_STRINGS.ckb[k] };
    assert.ok(ar.trim() && en.trim() && ckb.trim(), k);
    assert.notEqual(ckb, ar, `ckb.${k} is the Arabic pasted across`);
    assert.match(ckb, SORANI, `ckb.${k} is Sorani`);
  }
  const page = read('src/components/merchant/StoreUnavailable.tsx');
  const call = page.match(/loc\(\s*'إن كان لديك طلب[^']*',\s*'([^']*)',\s*'([^']*)'\s*\)/);
  assert.ok(call, 'the «My orders» sentence carries all three languages');
  assert.match(call[1], /files you bought/i);
  assert.match(call[2], SORANI);
  assert.match(call[2], /فایل/, 'the Sorani says files too');
  assert.match(page, /الملفات التي اشتريتها/);
});

test('«Your files» reads exactly as the shopfront\'s files block, without importing it (the storefront app payload)', () => {
  // The per-file words are the block's own copy of the shopfront's, word for word.
  for (const l of ['ar', 'en', 'ckb'] as const) {
    const own = ORDER_FILES_STRINGS[l];
    const shop = STOREFRONT_STRINGS[l].files;
    for (const k of ['view3d', 'download', 'opening', 'noPreview', 'viewerFailed'] as const) assert.equal(own[k], shop[k], `${l}.${k}`);
    assert.deepEqual({ ...own.roles }, { ...shop.roles }, `${l}.roles`);
    for (const n of [0, 15, 1023, 1024, 2048, 1536 * 1024, 150 * 1024 * 1024, 3 * 1024 ** 3]) {
      assert.equal(formatBytes(n, l), bytesLabel(n, shop.units), `${l} size of ${n}`);
    }
  }
  // The same role order and the same row rule.
  assert.deepEqual([...ORDER_FILE_ROLE_ORDER], [...ROLE_ORDER]);
  for (const role of ROLE_ORDER) {
    for (const has_preview of [true, false]) {
      for (const downloadable of [true, false]) {
        for (const granted of [true, false]) {
          const f = { role, has_preview, downloadable, granted };
          assert.equal(orderFileAction(f), rowAction(f), JSON.stringify(f));
        }
      }
    }
  }
  // Importing the shopfront's strings or its files block from this lazy chunk split the strings table
  // out of the store pages' chunk; the order door in community/files/api.ts grew a static import of the
  // store's product page (tests/bundleBudget.test.ts). Neither comes back.
  const block = code('src/components/orders/OrderFiles.tsx');
  assert.doesNotMatch(block, /from '\.\.\/storefront\//, 'OrderFiles imports nothing from the shopfront\'s own folder');
  assert.doesNotMatch(code('src/components/community/files/api.ts'), /orderFilesApi|\/api\/orders\//, 'the order door is not in the module every store visit downloads');
});
