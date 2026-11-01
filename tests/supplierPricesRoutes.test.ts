/**
 * /api/admin/pricing/supplier-prices — THE OWNER'S SUPPLIER PRICE CATALOGUE
 * (docs/SMART_PRICING.md §3.4, §3.6; migration 0218; WP5).
 *
 *   - the door: every caller but the verified owner is refused before an id is
 *     read — 403 COST_ACCESS_DENIED in the SAME bytes as every cost route, for
 *     a real id and an invented one, through adminPricingRoutes' door and
 *     through the router's own; every answer is `private, no-store`;
 *   - the chunked upload: ≤ 50 items and ≤ 256 KB a chunk, the strict parser,
 *     idempotent re-posts, a chunk beyond the declared count refused whole;
 *   - completion supersedes the previous complete snapshot (one per source),
 *     a discard deletes the rows, superseded beyond three per source pruned;
 *   - the owner's manual price: decimal text, three currencies, version-fenced;
 *   - the lookup: every form the owner pastes or types;
 *   - 503 PRICE_ESTIMATES_NOT_INSTALLED on a database without 0218 (after the door).
 *
 * The router is mounted the way WP15 mounts it: inside adminPricingRoutes.
 *
 * Run: node --import tsx --test tests/supplierPricesRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, count, ctx, dbThrough, freshDb, row, stubApp, type StubUser } from './fixtures/app';
import { fixtureText } from './fixtures/supplierPrices/load';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { serverMessage } from '../packages/contracts/src/costRefusals';
import { EMPTY_TOKEN, unitPriceOf } from '../worker/lib/supplierPrices/store';
import { parseSupplierQuery } from '../worker/lib/supplierPrices/lookup';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = '/api/admin/pricing/supplier-prices';
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const LEGACY: StubUser = { id: 'usr_legacy', role: 'admin', email: 'legacy@x.co', admin_scope: null };
const CUSTOMER: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };

type App = ReturnType<typeof stubApp>;

/** The mount WP15 lands: the router inside adminPricingRoutes' door. */
const appAs = (raw: DatabaseSync, user: StubUser | null): App =>
  stubApp(asD1(raw), user, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route(BASE, adminSupplierPricesRoutes);
  });

/** The router alone: its own door. */
const bareAs = (raw: DatabaseSync, user: StubUser | null): App => stubApp(asD1(raw), user, (a) => a.route(BASE, adminSupplierPricesRoutes));

async function req(app: App, method: string, path: string, body?: unknown, rawBody?: string) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' };
  const init: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = 'https://levonis-iq.com';
    init.body = rawBody ?? JSON.stringify(body ?? {});
  }
  const res = await app.request(path, init, undefined, ctx);
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface V1File {
  source: string;
  currency: string;
  price_basis: string;
  capture: string;
  captured_on: string;
  captured_by: string;
  items: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Uploads a v1 file the way the owner's browser does: create, chunks, complete. Answers the snapshot id. */
async function upload(app: App, file: V1File, opts: { chunk?: number; complete?: boolean } = {}): Promise<string> {
  const text = JSON.stringify(file);
  const sha = sha256(text);
  const created = await req(app, 'POST', `${BASE}/snapshots`, {
    source: file.source,
    currency: file.currency,
    price_basis: file.price_basis,
    capture: file.capture,
    captured_on: file.captured_on,
    captured_by: file.captured_by,
    file_sha256: sha,
    item_count: file.items.length,
  });
  assert.equal(created.status, 201, created.text);
  const id = created.body.snapshot.id as string;
  const chunk = opts.chunk ?? 10;
  for (let i = 0; i < file.items.length; i += chunk) {
    const r = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: file.items.slice(i, i + chunk), offset: i });
    assert.equal(r.status, 200, r.text);
  }
  if (opts.complete !== false) {
    const skuCount = file.items.reduce((n, it) => n + it.skus.length, 0);
    const done = await req(app, 'POST', `${BASE}/snapshots/${id}/complete`, { item_count: file.items.length, sku_count: skuCount, file_sha256: sha });
    assert.equal(done.status, 200, done.text);
  }
  return id;
}

const tmall = (): V1File => JSON.parse(fixtureText('tmall-2026-10-31.v1.json')) as V1File;
const eu = (): V1File => JSON.parse(fixtureText('eu-2026-10-31.v1.json')) as V1File;

function seedProducts(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES ('p_pla', 'pla-basic', 'PLA Basic', 'بي إل إيه بيسك', 'پی ئێڵ ئەی بەیسیک');
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES
      ('g_col', 'p_pla', 'Colour', 'color', 0, 1), ('g_spl', 'p_pla', 'Spool', 'spool', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('v_red', 'p_pla', 'g_col', 'Red (10200)', 'أحمر', 'سوور', 0, 1),
      ('v_blk', 'p_pla', 'g_col', 'Black (10101)', 'أسود', 'ڕەش', 1, 1),
      ('v_spl', 'p_pla', 'g_spl', 'Filament with spool', 'مع بكرة', 'لەگەڵ بەکرە', 0, 1),
      ('v_ref', 'p_pla', 'g_spl', 'Refill', 'عبوة بلا بكرة', 'بێ بەکرە', 1, 1);
    INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES ('p_cut', 'flush-cutters', 'Flush Cutters', 'قاطعة', 'بڕەر');
  `);
}

// ------------------------------------------------------------------ the door

const EVERY_ROUTE: Array<[string, string, unknown?]> = [
  ['GET', `${BASE}/snapshots`],
  ['POST', `${BASE}/snapshots`, { source: 'tmall_cn' }],
  ['POST', `${BASE}/snapshots/sps_0123456789abcdef0123456789abcdef/items`, { items: [] }],
  ['POST', `${BASE}/snapshots/sps_nope/complete`, {}],
  ['POST', `${BASE}/snapshots/sps_nope/discard`, {}],
  ['POST', `${BASE}/match`, {}],
  ['GET', `${BASE}/matches?state=suggested`],
  ['PUT', `${BASE}/matches/p_pla`, { version: '0.0.', skus: [] }],
  ['PUT', `${BASE}/matches/zz-no-such-id`, { version: '0.0.', skus: [] }],
  ['PUT', `${BASE}/manual/p_pla`, { version: '0.0.', skus: [] }],
  ['GET', `${BASE}/lookup?q=QA018`],
  ['POST', `${BASE}/read-store-page`, { url: 'https://eu.store.bambulab.com/products/h2d' }],
  ['GET', `${BASE}/links`],
  ['GET', `${BASE}/links/p_pla`],
  ['GET', `${BASE}/links/zz-no-such-id?include=cost&role=owner`],
];

test('the door: every other admin hears COST_ACCESS_DENIED in the same bytes as every cost route — real or invented id, either door; never stored', async () => {
  const raw = freshDb();
  seedProducts(raw);
  await upload(appAs(raw, OWNER), tmall());
  const reference = await req(appAs(raw, FULL), 'GET', '/api/admin/pricing/overview');
  assert.equal(reference.status, 403);
  assert.equal(reference.body.code, 'COST_ACCESS_DENIED');
  assert.equal(reference.body.error, serverMessage('COST_ACCESS_DENIED'));
  for (const user of [FULL, ASSISTANT, LEGACY]) {
    for (const mount of [appAs, bareAs]) {
      for (const [method, path, body] of EVERY_ROUTE) {
        const r = await req(mount(raw, user), method, path, body);
        assert.equal(r.status, 403, `${user.id} ${method} ${path}`);
        assert.equal(r.text, reference.text, `${user.id} ${method} ${path}: the refusal is the same bytes`);
        assert.equal(r.headers.get('cache-control'), 'private, no-store');
      }
    }
  }
  // A customer never reaches it; a guest is asked to sign in at the admin door; the owner's
  // unverified session hears the way out.
  for (const [method, path, body] of EVERY_ROUTE) {
    assert.equal((await req(appAs(raw, CUSTOMER), method, path, body)).status, 403);
    assert.equal((await req(appAs(raw, null), method, path, body)).status, 401);
    const unverified = await req(appAs(raw, { ...OWNER, email_verified_at: null }), method, path, body);
    assert.deepEqual([unverified.status, unverified.body.code], [403, 'OWNER_EMAIL_UNVERIFIED']);
  }
  // Nothing written by any refused call: the one snapshot is still the owner's.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_snapshots'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 0);
  // The owner is let in, and the answer is private too.
  const ok = await req(appAs(raw, OWNER), 'GET', `${BASE}/snapshots`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const bare = await req(bareAs(raw, OWNER), 'GET', `${BASE}/snapshots`);
  assert.equal(bare.headers.get('cache-control'), 'private, no-store', 'the router marks its own answers');
});

test('503 PRICE_ESTIMATES_NOT_INSTALLED without migration 0218 — told to the owner only, after the door', async () => {
  const raw = dbThrough('0217');
  for (const [method, path, body] of EVERY_ROUTE.filter(([, p]) => !p.includes('/links'))) {
    const r = await req(appAs(raw, OWNER), method, path, body);
    assert.equal(r.status, 503, `${method} ${path}`);
    assert.equal(r.body.code, 'PRICE_ESTIMATES_NOT_INSTALLED');
    assert.equal((await req(appAs(raw, FULL), method, path, body)).status, 403, 'a non-owner learns nothing about the database');
  }
});

// ------------------------------------------------------------------ the upload

test('chunked upload: the strict parser per chunk, packs and weights read at upload, the index written; a re-post writes once', async () => {
  const raw = freshDb();
  const app = appAs(raw, OWNER);
  const file = tmall();
  const id = await upload(app, file, { complete: false, chunk: 7 });
  const totalSkus = file.items.reduce((n, it) => n + it.skus.length, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_items WHERE snapshot_id = ?', id), file.items.length);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_skus WHERE snapshot_id = ?', id), totalSkus);
  // Re-posting the first chunk (a retried request) writes nothing new.
  const again = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: file.items.slice(0, 7), offset: 0 });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.totals, { items: file.items.length, skus: totalSkus });
  // Prices are kept as decimal text; the label beside the price is words, never a figure.
  const sku = row<Json>(raw, "SELECT price, price_label, typeof(price) AS t FROM supplier_price_skus WHERE snapshot_id = ? AND sku_key = '4930331344241'", id)!;
  assert.deepEqual(sku, { price: '75', price_label: '优惠前', t: 'text' });
  // The 10-pack is ten units at upload (keys.ts packOf), and 10 kg net.
  const pack = row<Json>(raw, "SELECT pack_units, net_weight_g FROM supplier_price_skus WHERE snapshot_id = ? AND item_key = '1001036512689' LIMIT 1", id)!;
  assert.deepEqual(pack, { pack_units: 10, net_weight_g: 10000 });
  // The matcher's index: part codes, colour codes and names.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_keys WHERE snapshot_id = ? AND key_type = 'part_code' AND key_value = 'QA018'", id), 1);
  assert.ok(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_keys WHERE snapshot_id = ? AND key_type = 'color_code' AND key_value = '10200'", id) >= 1);
  // While loading, nothing is current.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_snapshots WHERE state = 'complete'"), 0);
  const list = await req(app, 'GET', `${BASE}/snapshots`);
  const snap = list.body.snapshots.find((s: Json) => s.id === id);
  assert.equal(snap.state, 'loading');
  assert.equal(snap.stored_items, file.items.length);
  assert.equal(snap.stored_skus, totalSkus);
});

test('a chunk is refused whole: over 256 KB, over 50 items, a float price, a USD page under the EU store, more items than declared, a closed snapshot', async () => {
  const raw = freshDb();
  const app = appAs(raw, OWNER);
  const file = tmall();
  const id = await upload(app, { ...file, items: file.items.slice(0, 2) }, { complete: false });
  const stored = () => count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_items WHERE snapshot_id = ?', id);
  assert.equal(stored(), 2);

  const big = { items: [{ ...file.items[2], props: Array.from({ length: 60 }, () => 'x'.repeat(5000)) }] };
  const tooBig = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, big);
  assert.deepEqual([tooBig.status, tooBig.body.code, tooBig.body.details], [400, 'PRICING_INPUT_INVALID', { field: 'items' }]);

  const many = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: Array.from({ length: 51 }, (_, i) => ({ ...file.items[5], item_key: String(900000000000 + i) })) });
  assert.equal(many.status, 400);
  assert.equal(many.body.code, 'SUPPLIER_PRICE_FORMAT_INVALID');
  assert.equal(many.body.details.reason, 'too_many');

  const float = structuredClone(file.items[5]!);
  float.skus[0].price = 0.1 + 0.2;
  const refused = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: [float], offset: 20 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'SUPPLIER_PRICE_FORMAT_INVALID');
  assert.deepEqual(refused.body.details, { path: '$.items[20].skus[0].price', reason: 'float_price' }, 'the path names the file position, never the value');
  assert.ok(!refused.text.includes('0.30000000000000004'));

  const unknown = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: [file.items[5]], extra: 1 });
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.details], [400, 'UNKNOWN_FIELD', { field: 'extra' }]);

  // The snapshot declared two items: a third is refused with the chunk it came in.
  const over = await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: [file.items[5]] });
  assert.deepEqual([over.status, over.body.code], [400, 'PRICING_INPUT_INVALID']);
  assert.equal(stored(), 2, 'nothing of a refused chunk is stored');

  // A geo-redirected "EU" capture that carries USD is never stored as EUR.
  const usd = await req(app, 'POST', `${BASE}/snapshots`, { ...eu(), items: undefined, format: undefined, currency: 'USD', file_sha256: 'a'.repeat(64), item_count: 1 });
  assert.equal(usd.status, 400);
  assert.equal(usd.body.details.reason, 'currency_mismatch');
  const badSha = await req(app, 'POST', `${BASE}/snapshots`, { source: 'tmall_cn', currency: 'CNY', capture: 'browser_sweep', captured_on: '2026-10-31', file_sha256: 'nope', item_count: 1 });
  assert.deepEqual([badSha.status, badSha.body.details], [400, { field: 'file_sha256' }]);

  // A completed snapshot takes no more items; an unknown one is not found.
  const done = await upload(app, { ...file, items: file.items.slice(0, 1) });
  const closed = await req(app, 'POST', `${BASE}/snapshots/${done}/items`, { items: [file.items[1]] });
  assert.deepEqual([closed.status, closed.body.code], [409, 'PRICING_CHANGED']);
  assert.equal((await req(app, 'POST', `${BASE}/snapshots/sps_0123456789abcdef0123456789abcdef/items`, { items: [file.items[1]] })).status, 404);
});

test('completion checks the counts and the hash, then supersedes the previous snapshot of its source in one batch; only three superseded are kept', async () => {
  const raw = freshDb();
  const app = appAs(raw, OWNER);
  const file = tmall();
  const first = await upload(app, file);
  const head = row<Json>(raw, 'SELECT state, sku_count, completed_at FROM supplier_price_snapshots WHERE id = ?', first)!;
  assert.equal(head.state, 'complete');
  assert.equal(head.sku_count, file.items.reduce((n, it) => n + it.skus.length, 0));
  assert.ok(head.completed_at);

  // Wrong counts or another file's hash: refused, the snapshot stays loading.
  const second = await upload(app, file, { complete: false });
  const sha = sha256(JSON.stringify(file));
  const skus = file.items.reduce((n, it) => n + it.skus.length, 0);
  for (const [body, field] of [
    [{ item_count: file.items.length, sku_count: skus + 1, file_sha256: sha }, 'sku_count'],
    [{ item_count: file.items.length + 1, sku_count: skus, file_sha256: sha }, 'item_count'],
    [{ item_count: file.items.length, sku_count: skus, file_sha256: 'b'.repeat(64) }, 'file_sha256'],
  ] as const) {
    const r = await req(app, 'POST', `${BASE}/snapshots/${second}/complete`, body);
    assert.deepEqual([r.status, r.body.details], [400, { field }]);
  }
  assert.equal(row<Json>(raw, 'SELECT state FROM supplier_price_snapshots WHERE id = ?', second)!.state, 'loading');
  const ok = await req(app, 'POST', `${BASE}/snapshots/${second}/complete`, { item_count: file.items.length, sku_count: skus, file_sha256: sha });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.snapshot.state, 'complete');
  assert.deepEqual(
    all<Json>(raw, 'SELECT id, state FROM supplier_price_snapshots ORDER BY rowid').map((r) => [r.id, r.state]),
    [
      [first, 'superseded'],
      [second, 'complete'],
    ]
  );
  // Completing twice is refused (it is no longer loading).
  assert.equal((await req(app, 'POST', `${BASE}/snapshots/${second}/complete`, { item_count: file.items.length, sku_count: skus, file_sha256: sha })).status, 409);

  // Three more captures: the oldest superseded snapshot is deleted with its rows.
  const small = { ...file, items: file.items.slice(5, 6) };
  const later: string[] = [];
  for (let i = 0; i < 3; i++) later.push(await upload(app, small));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_snapshots WHERE state = 'complete'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_snapshots WHERE state = 'superseded'"), 3);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_snapshots WHERE id = ?', first), 0, 'the oldest is pruned');
  for (const t of ['supplier_price_items', 'supplier_price_skus', 'supplier_price_keys']) {
    assert.equal(count(raw, `SELECT COUNT(*) AS n FROM ${t} WHERE snapshot_id = ?`, first), 0, `${t} of the pruned snapshot`);
  }
  // The list: source, date, state, counts and age.
  const list = await req(app, 'GET', `${BASE}/snapshots`);
  const current = list.body.snapshots.find((s: Json) => s.state === 'complete');
  assert.equal(current.id, later[2]);
  assert.equal(current.source, 'tmall_cn');
  assert.equal(current.captured_on, '2026-10-31');
  assert.equal(current.snapshot_price_basis, 'list');
  assert.equal(typeof current.age_days, 'number');
  assert.deepEqual([current.matched_items, current.unmatched_items], [0, 1]);
});

test('discard: a loading or a complete snapshot loses its rows and stops being current; a second discard answers it as it is', async () => {
  const raw = freshDb();
  const app = appAs(raw, OWNER);
  const loading = await upload(app, tmall(), { complete: false });
  const r = await req(app, 'POST', `${BASE}/snapshots/${loading}/discard`);
  assert.deepEqual([r.status, r.body.snapshot.state], [200, 'discarded']);
  for (const t of ['supplier_price_items', 'supplier_price_skus', 'supplier_price_keys']) assert.equal(count(raw, `SELECT COUNT(*) AS n FROM ${t} WHERE snapshot_id = ?`, loading), 0);
  assert.equal((await req(app, 'POST', `${BASE}/snapshots/${loading}/discard`)).body.snapshot.state, 'discarded');
  assert.equal((await req(app, 'POST', `${BASE}/snapshots/${loading}/items`, { items: tmall().items.slice(0, 1) })).status, 409);

  const current = await upload(app, eu());
  await req(app, 'POST', `${BASE}/snapshots/${current}/discard`);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_snapshots WHERE source = 'bambu_eu' AND state = 'complete'"), 0, 'no capture is current after a discard');
  assert.equal((await req(app, 'POST', `${BASE}/snapshots/sps_unknown/discard`)).status, 404);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier_prices.snapshot_discard'"), 2);
});

// ------------------------------------------------------------------ the owner's own price

test('manual entry: decimal text in USD, EUR or CNY per sellable SKU, removed with null; version-fenced; every refusal names a field', async () => {
  const raw = freshDb();
  seedProducts(raw);
  const app = appAs(raw, OWNER);
  const RED_SPOOL = 'o:v_red|o:v_spl';
  const RED_REFILL = 'o:v_red|o:v_ref';
  const put = (body: unknown) => req(app, 'PUT', `${BASE}/manual/p_pla`, body);

  const first = await put({ version: EMPTY_TOKEN, skus: [{ combo_key: RED_SPOOL, amount: '69.5', currency: 'CNY', note: 'same as black' }, { combo_key: RED_REFILL, amount: 27.99, currency: 'EUR' }] });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(
    all<Json>(raw, 'SELECT combo_key, amount, typeof(amount) AS t, currency, origin, note, evidence_url, version FROM supplier_price_manual ORDER BY combo_key'),
    [
      { combo_key: RED_REFILL, amount: '27.99', t: 'text', currency: 'EUR', origin: 'typed', note: '', evidence_url: '', version: 1 },
      { combo_key: RED_SPOOL, amount: '69.5', t: 'text', currency: 'CNY', origin: 'typed', note: 'same as black', evidence_url: '', version: 1 },
    ]
  );
  const view = first.body.product;
  const red = view.skus.find((s: Json) => s.combo_key === RED_SPOOL);
  assert.deepEqual(red.labels, { ar: 'أحمر · مع بكرة', en: 'Red (10200) · Filament with spool', ckb: 'سوور · لەگەڵ بەکرە' });
  assert.deepEqual(
    red.supplier_prices.map((l: Json) => [l.source, l.state, l.price, l.currency, l.item_url]),
    [['typed', 'manual', '69.5', 'CNY', null]]
  );

  // The token moved: the old one is refused, the new one passes.
  const stale = await put({ version: EMPTY_TOKEN, skus: [{ combo_key: RED_SPOOL, amount: '70', currency: 'CNY' }] });
  assert.deepEqual([stale.status, stale.body.code], [409, 'PRICING_CHANGED']);
  const second = await put({ version: view.versions.manual, skus: [{ combo_key: RED_SPOOL, amount: '70', currency: 'USD' }, { combo_key: RED_REFILL, amount: null }] });
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(all<Json>(raw, 'SELECT combo_key, amount, currency, version FROM supplier_price_manual'), [{ combo_key: RED_SPOOL, amount: '70', currency: 'USD', version: 2 }]);

  const token = second.body.product.versions.manual;
  for (const [sku, field] of [
    [{ combo_key: 'o:v_red', amount: '1', currency: 'USD' }, 'combo_key'],
    [{ combo_key: RED_SPOOL, amount: '1.2.3', currency: 'USD' }, 'amount'],
    [{ combo_key: RED_SPOOL, amount: '0', currency: 'USD' }, 'amount'],
    [{ combo_key: RED_SPOOL, amount: '-1', currency: 'USD' }, 'amount'],
    [{ combo_key: RED_SPOOL, amount: 0.1 + 0.2, currency: 'USD' }, 'amount'],
    [{ combo_key: RED_SPOOL, amount: '1', currency: 'IQD' }, 'currency'],
    [{ combo_key: RED_SPOOL, amount: '1', currency: 'USD', note: 'x\u202ey' }, 'note'],
  ] as const) {
    const r = await put({ version: token, skus: [sku] });
    assert.deepEqual([r.status, r.body.code, r.body.details], [400, 'PRICING_INPUT_INVALID', { field }], JSON.stringify(sku));
  }
  const extra = await put({ version: token, skus: [{ combo_key: RED_SPOOL, amount: '1', currency: 'USD', cost_iqd: 5 }] });
  assert.deepEqual([extra.status, extra.body.code], [400, 'UNKNOWN_FIELD']);
  assert.equal((await req(app, 'PUT', `${BASE}/manual/zz-no-such-id`, { version: EMPTY_TOKEN, skus: [] })).status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 1, 'no refused entry wrote anything');
  // The audit carries counts, never an amount.
  const audits = all<Json>(raw, "SELECT detail FROM audit_log WHERE action = 'supplier_prices.manual_set'");
  assert.equal(audits.length, 2);
  for (const a of audits) assert.ok(!/69\.5|27\.99|"70"/.test(String(a.detail)), String(a.detail));
});

test('unitPriceOf: a pack divided by the owner is ceil(price / units) at four decimals, exactly', () => {
  assert.equal(unitPriceOf('99', 1), '99');
  assert.equal(unitPriceOf('99', 10), '9.9');
  assert.equal(unitPriceOf('100', 3), '33.3334');
  assert.equal(unitPriceOf('0.01', 3), '0.0034');
  assert.equal(unitPriceOf('1299.99', 7), '185.7129');
  assert.equal(unitPriceOf('123456789012345678.5', 2), '61728394506172839.25');
  assert.throws(() => unitPriceOf('1.5', 0));
  assert.throws(() => unitPriceOf('abc', 2));
});

// ------------------------------------------------------------------ lookup

test('lookup: a Tmall URL or id, a store URL or handle or variant id, a colour or part code, words — complete snapshots only, ≤ 50 items with links', async () => {
  const raw = freshDb();
  seedProducts(raw);
  const app = appAs(raw, OWNER);
  await upload(app, tmall());
  await upload(app, eu());
  const loading = await upload(app, { ...tmall(), items: tmall().items.slice(0, 3).map((i) => ({ ...i, item_key: `7${i.item_key}` })) }, { complete: false });
  const look = async (q: string) => {
    const r = await req(app, 'GET', `${BASE}/lookup?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, r.text);
    return r.body as Json;
  };

  const byUrl = await look('https://detail.tmall.com/item.htm?spm=a1z10&id=1036834158903&skuId=6054830021130');
  assert.equal(byUrl.query, 'tmall_url');
  assert.equal(byUrl.supplier_prices.length, 1);
  const cutters = byUrl.supplier_prices[0];
  assert.deepEqual([cutters.source, cutters.item_key, cutters.currency, cutters.captured_on], ['tmall_cn', '1036834158903', 'CNY', '2026-10-31']);
  assert.equal(cutters.item_url, 'https://detail.tmall.com/item.htm?id=1036834158903');
  assert.equal(cutters.skus[0].sku_url, 'https://detail.tmall.com/item.htm?id=1036834158903&skuId=6054830021130');
  assert.equal(cutters.skus[0].highlight, true);
  assert.ok(!JSON.stringify(byUrl).includes('spm='), 'the pasted URL is a search key, never an answer');

  assert.deepEqual((await look('1036834158903')).supplier_prices.map((i: Json) => i.item_key), ['1036834158903']);
  assert.deepEqual((await look('QA018')).supplier_prices.map((i: Json) => i.item_key), ['1036834158903']);
  assert.deepEqual((await look('B-QA018')).supplier_prices.map((i: Json) => i.item_key), ['1036834158903']);
  const colour = await look('10200');
  assert.ok(colour.supplier_prices.some((i: Json) => i.item_key === '693972799714'), 'the colour code finds the PLA Basic listing');
  assert.ok(colour.supplier_prices.find((i: Json) => i.item_key === '693972799714').skus.some((s: Json) => s.highlight && /10200/.test(JSON.stringify(s.options))));

  const store = await look('https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes');
  assert.equal(store.query, 'store_url');
  assert.deepEqual(store.supplier_prices.map((i: Json) => [i.source, i.item_key]), [['bambu_eu', 'h2d']]);
  assert.equal(store.supplier_prices[0].item_url, 'https://eu.store.bambulab.com/products/h2d?skr=yes');
  const variant = store.supplier_prices[0].skus.find((s: Json) => s.highlight);
  assert.equal(variant.sku_key, '596571526982115329');
  assert.equal(variant.sku_url, 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes');
  assert.deepEqual((await look('596571526982115329')).supplier_prices.map((i: Json) => i.item_key), ['h2d']);
  assert.deepEqual((await look('filament-buffer')).supplier_prices.map((i: Json) => i.item_key), ['filament-buffer']);

  const words = await look('PLA Basic');
  assert.ok(words.supplier_prices.length >= 2 && words.supplier_prices.every((i: Json) => /pla/i.test(`${i.title} ${i.name_en}`) && /basic/i.test(`${i.title} ${i.name_en}`)));
  assert.ok(!words.supplier_prices.some((i: Json) => i.snapshot_id === loading), 'a loading snapshot is never searched');
  assert.deepEqual((await look('100%_off')).supplier_prices, [], '% and _ are taken literally');
  assert.deepEqual((await look('')).supplier_prices, []);
  const long = await req(app, 'GET', `${BASE}/lookup?q=${'x'.repeat(301)}`);
  assert.deepEqual([long.status, long.body.details], [400, { field: 'q' }]);
});

test('the lookup parser reads every form the owner pastes, and keeps none of it as a link', () => {
  assert.deepEqual(parseSupplierQuery('https://detail.tmall.com/item.htm?id=1036834158903&skuId=6054830021130'), { kind: 'tmall_url', item_key: '1036834158903', sku_key: '6054830021130' });
  assert.deepEqual(parseSupplierQuery('detail.tmall.com/item.htm?id=1036834158903'), { kind: 'tmall_url', item_key: '1036834158903', sku_key: null });
  assert.deepEqual(parseSupplierQuery('https://eu.store.bambulab.com/products/h2d?skr=yes'), { kind: 'store_url', source: 'bambu_eu', item_key: 'h2d', sku_key: null });
  assert.deepEqual(parseSupplierQuery('https://us.store.bambulab.com/products/H2D?id=581025672340709385'), { kind: 'store_url', source: 'bambu_us', item_key: 'h2d', sku_key: '581025672340709385' });
  assert.deepEqual(parseSupplierQuery('10101'), { kind: 'digits', value: '10101' });
  assert.deepEqual(parseSupplierQuery('fap023-v1'), { kind: 'code', part_code: 'FAP023', sku_code: null });
  assert.deepEqual(parseSupplierQuery('A00-W1-1.75-1000-SPLFREE'), { kind: 'code', part_code: null, sku_code: 'A00-W1-1.75-1000-SPLFREE' });
  assert.equal(parseSupplierQuery('pla-basic-filament').kind, 'handle');
  assert.deepEqual(parseSupplierQuery('  PLA  Matte  '), { kind: 'words', words: ['pla', 'matte'] });
  // An address of another site is only words; it names no item.
  assert.equal(parseSupplierQuery('https://evil.example/products/h2d?id=1').kind, 'words');
  assert.equal(parseSupplierQuery('javascript:alert(1)').kind, 'words');
});
