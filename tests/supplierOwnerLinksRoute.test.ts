/**
 * /api/admin/pricing/supplier-prices/owner-links — THE OWNER'S OWN SUPPLIER
 * LINKS, PER PRODUCT (docs/SMART_PRICING.md §3.10; migration 0223; DECISIONS
 * row 293; the owner's request of 2026-11-05: «i need to save the link so i
 * can easily track price from supplier or on pre order item to order it or
 * when i need to future buy on inventory»).
 *
 *   - owner-only: every other admin hears COST_ACCESS_DENIED in the same bytes
 *     as the other supplier-price routes, through either door; a guest 401, a
 *     customer 403, the unverified owner the way out; never stored;
 *   - the read: his links (labels in three languages, host, source) beside the
 *     matched Tmall / EU facts of the same SKUs, the keys a link may be saved
 *     for, the version token; the filters a purchase line and an order line
 *     use (`combo_key`, `scope` base / option / color / variant) and the rule
 *     that a link applies to a SKU holding every part of its key;
 *   - the write: add, edit and remove, version-fenced (409 PRICING_CHANGED) —
 *     on the token he sent and again inside the write's own batch, so another
 *     tab's save landing in between is kept and this write refused whole — a
 *     strict body, the address through the shared parser (a Tmall link with
 *     tracking rebuilt, an EU link with skr=yes, any other host kept), a key
 *     the product offers (on a grid too large for the engine: the product, an
 *     option or a colour, never a full SKU key), no duplicate, at most 40, a
 *     note that keeps its lines; no price is written and no match touched; the
 *     audit row carries counts only;
 *   - the second net: `supplier_links` and `supplier_prices` are stripped
 *     whole for a non-owner;
 *   - deploy-ahead: without 0223 the read answers installed:false with the
 *     matched links, the write 503 SUPPLIER_LINKS_NOT_INSTALLED; without 0218
 *     the read answers the product alone and the write 503
 *     PRICE_ESTIMATES_NOT_INSTALLED;
 *   - one reader: only worker/lib/supplierPrices/ownerLinks.ts and the table
 *     registries name the table, only the owner router imports the module,
 *     and only the admin chunk's api.ts calls the route.
 *
 * Run: node --import tsx --test tests/supplierOwnerLinksRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, count, ctx, dbThrough, freshDb, row, stubApp, type StubUser } from './fixtures/app';
import { ROOT, SqliteD1, type SqliteStatement } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { stripFinancials } from '../worker/lib/adminScope';
import { EMPTY_TOKEN } from '../worker/lib/supplierPrices/store';
import { isMissingEstimateSchema } from '../worker/lib/priceEstimateLabel';
import { OWNER_LINKS_TOKEN_SQL, isMissingOwnerLinks, linkApplies } from '../worker/lib/supplierPrices/ownerLinks';
import { OWNER_LINKS_PER_PRODUCT } from '../packages/catalog/src/supplierPrices/ownerLink';
import { ENGINE_MAX_SKUS } from '../packages/pricing/src/costToPrice';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type App = ReturnType<typeof stubApp>;

const BASE = '/api/admin/pricing/supplier-prices';
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const LEGACY: StubUser = { id: 'usr_legacy', role: 'admin', email: 'legacy@x.co', admin_scope: null };
const SUPPORT: StubUser = { id: 'usr_support', role: 'admin', email: 'support@x.co', admin_scope: 'support_assistant' };
const CUSTOMER: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };

/** The mount WP15 lands: the router inside adminPricingRoutes' door. */
const appOn = (db: D1Database, user: StubUser | null): App =>
  stubApp(db, user, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route(BASE, adminSupplierPricesRoutes);
  });
const appAs = (raw: DatabaseSync, user: StubUser | null): App => appOn(asD1(raw), user);
/** The router alone: its own door. */
const bareAs = (raw: DatabaseSync, user: StubUser | null): App => stubApp(asD1(raw), user, (a) => a.route(BASE, adminSupplierPricesRoutes));

async function req(app: App, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' };
  const init: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = 'https://levonis-iq.com';
    init.body = JSON.stringify(body ?? {});
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

const SHA = 'f'.repeat(64);
const AT = '2026-11-05T09:00:00.000Z';
/** The four SKUs of the printer: two models in two colours. */
const COMBO_BLK = 'o:v_combo|c:c_blk';
const COMBO_WHT = 'o:v_combo|c:c_wht';
const BASE_BLK = 'o:v_base|c:c_blk';
const BASE_WHT = 'o:v_base|c:c_wht';

/** A printer in two models and two colours, an EU capture matched to one SKU, his own price on another, and a filament with no option. */
function seed(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES
      ('p_h2d', 'h2d', 'Bambu Lab H2D', 'طابعة H2D', 'چاپکەری H2D'),
      ('p_pla', 'pla', 'PLA Basic', 'خيط PLA', 'فیلامێنتی PLA');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_model', 'p_h2d', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('v_combo', 'p_h2d', 'g_model', 'H2D AMS Combo', 'مع AMS', 'لەگەڵ AMS', 0, 1),
      ('v_base', 'p_h2d', 'g_model', 'H2D', 'الطابعة وحدها', 'تەنها چاپکەرەکە', 1, 1);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES
      ('c_blk', 'p_h2d', 'Black', 'أسود', 'ڕەش', '#000000', 0, 1),
      ('c_wht', 'p_h2d', 'White', 'أبيض', 'سپی', '#ffffff', 1, 1);
    INSERT INTO product_variants (id, product_id, combo_key) VALUES ('pv_combo_wht', 'p_h2d', '${COMBO_WHT}');
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, item_count, sku_count, state, created_by, created_at, completed_at)
      VALUES ('sps_eu', 'bambu_eu', 'EUR', 'browser_sweep', '2026-10-30', '${SHA}', 1, 1, 'complete', 'usr_owner', '2026-10-30T00:00:00Z', '2026-10-30T00:00:00Z');
    INSERT INTO supplier_price_items (snapshot_id, item_key, url, page_host, title, name_en, category)
      VALUES ('sps_eu', 'h2d', 'javascript:alert(1)', 'eu.store.bambulab.com', 'Bambu Lab H2D', 'Bambu Lab H2D', 'printer');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, options_json, options_en_json, price, price_label)
      VALUES ('sps_eu', 'h2d', '596571526982115329', '{"option1":"H2D AMS Combo"}', '{"option1":"H2D AMS Combo"}', '1599', '');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, reasons_json, units_per_offer, state, decided_by, decided_at, found_in_snapshot, version, updated_at)
      VALUES ('p_h2d', '${COMBO_BLK}', 'bambu_eu', 'h2d', '596571526982115329', 'high', 'handle', '[]', 1, 'confirmed', 'auto', '${AT}', 'sps_eu', 1, '${AT}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at, version)
      VALUES ('p_h2d', '${BASE_WHT}', '1399', 'EUR', 'typed', 'usr_owner', '${AT}', 1);
  `);
}

const ownerApp = (raw: DatabaseSync) => appAs(raw, OWNER);
const read = async (app: App, pid: string, query = '') => {
  const r = await req(app, 'GET', `${BASE}/owner-links/${pid}${query}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const put = (app: App, pid: string, body: unknown) => req(app, 'PUT', `${BASE}/owner-links/${pid}`, body);
const linksOf = (body: Json) => (body.product.supplier_links as Json[]).map((l) => [l.combo_key, l.url]);

/** Adds links in one write, on the token read just before. */
async function add(app: App, pid: string, links: Array<Record<string, unknown>>) {
  const version = (await read(app, pid)).product.versions.links;
  const r = await put(app, pid, { version, upsert: links });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

// ------------------------------------------------------------------ the door

test('owner-only: every other admin hears COST_ACCESS_DENIED in the same bytes as the other supplier-price routes, through either door; never stored', async () => {
  const raw = freshDb();
  seed(raw);
  const reference = await req(appAs(raw, FULL), 'GET', `${BASE}/links`);
  assert.equal(reference.status, 403);
  for (const user of [FULL, ASSISTANT, LEGACY, SUPPORT]) {
    for (const mount of [appAs, bareAs]) {
      for (const [method, path] of [
        ['GET', `${BASE}/owner-links/p_h2d`],
        ['GET', `${BASE}/owner-links/p_h2d?scope=option&scope_id=v_combo`],
        ['GET', `${BASE}/owner-links/zz-no-such-id`],
        ['PUT', `${BASE}/owner-links/p_h2d`],
        ['PUT', `${BASE}/owner-links/zz-no-such-id`],
      ] as const) {
        const r = await req(mount(raw, user), method, path, { version: EMPTY_TOKEN, upsert: [{ combo_key: '', url: 'https://example.com/' }] });
        assert.equal(r.status, 403, `${user.id} ${method} ${path}`);
        assert.equal(r.text, reference.text, `${user.id} ${method} ${path}`);
        assert.equal(r.headers.get('cache-control'), 'private, no-store');
      }
    }
  }
  assert.equal((await req(appAs(raw, null), 'GET', `${BASE}/owner-links/p_h2d`)).status, 401);
  assert.equal((await req(appAs(raw, CUSTOMER), 'GET', `${BASE}/owner-links/p_h2d`)).status, 403);
  // Nothing a refused write sent was stored.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_supplier_links'), 0);
  const owner = await req(ownerApp(raw), 'GET', `${BASE}/owner-links/p_h2d`);
  assert.equal(owner.status, 200, owner.text);
  assert.equal(owner.headers.get('cache-control'), 'private, no-store');
  // An invented product is 404 for the owner, after the door.
  assert.equal((await req(ownerApp(raw), 'GET', `${BASE}/owner-links/zz-no-such-id`)).status, 404);
  assert.equal((await req(ownerApp(raw), 'GET', `${BASE}/owner-links/bad%20id`)).status, 404);
});

test('the unverified owner hears the way out, on the read and the write', async () => {
  const raw = freshDb();
  seed(raw);
  const unverified: StubUser = { ...OWNER, email_verified_at: null };
  for (const [method, path] of [
    ['GET', `${BASE}/owner-links/p_h2d`],
    ['PUT', `${BASE}/owner-links/p_h2d`],
  ] as const) {
    const r = await req(appAs(raw, unverified), method, path, {});
    assert.deepEqual([r.status, r.body.code], [403, 'OWNER_EMAIL_UNVERIFIED'], `${method} ${path}`);
  }
});

// ------------------------------------------------------------------ the read

test('the read: the product, its matched facts, no link yet, the keys a link may be saved for, and the version token', async () => {
  const raw = freshDb();
  seed(raw);
  const body = await read(ownerApp(raw), 'p_h2d');
  assert.equal(body.installed, true);
  assert.equal(body.scope_key, '');
  const p = body.product;
  assert.deepEqual([p.product_id, p.name, p.names], ['p_h2d', 'Bambu Lab H2D', { ar: 'طابعة H2D', en: 'Bambu Lab H2D', ckb: 'چاپکەری H2D' }]);
  assert.deepEqual(p.supplier_links, []);
  assert.equal(p.versions.links, EMPTY_TOKEN);
  assert.match(p.versions.matches, /^1\.1\./);
  assert.match(p.versions.manual, /^1\.1\./);
  // The matched facts of the SKUs that carry any: the EU match, and his own price.
  assert.deepEqual(
    p.skus.map((s: Json) => [s.combo_key, s.supplier_prices.map((l: Json) => [l.source, l.state, l.price, l.sku_url])]),
    [
      [COMBO_BLK, [['bambu_eu', 'auto', '1599', 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes']]],
      [BASE_WHT, [['typed', 'manual', '1399', null]]],
    ].sort((a, b) => p.skus.findIndex((s: Json) => s.combo_key === a[0]) - p.skus.findIndex((s: Json) => s.combo_key === b[0]))
  );
  // The keys: the whole product, each model, each colour, each SKU — every one named in three languages.
  assert.deepEqual(
    p.choices.map((c: Json) => [c.combo_key, c.kind]),
    [
      ['', 'product'],
      ['o:v_combo', 'option'],
      ['o:v_base', 'option'],
      ['c:c_blk', 'colour'],
      ['c:c_wht', 'colour'],
      [COMBO_BLK, 'sku'],
      [COMBO_WHT, 'sku'],
      [BASE_BLK, 'sku'],
      [BASE_WHT, 'sku'],
    ]
  );
  const byKey = new Map((p.choices as Json[]).map((c) => [c.combo_key, c.labels]));
  assert.deepEqual(byKey.get('o:v_combo'), { ar: 'مع AMS', en: 'H2D AMS Combo', ckb: 'لەگەڵ AMS' });
  assert.deepEqual(byKey.get('c:c_wht'), { ar: 'أبيض', en: 'White', ckb: 'سپی' });
  assert.deepEqual(byKey.get(COMBO_BLK), { ar: 'مع AMS · أسود', en: 'H2D AMS Combo · Black', ckb: 'لەگەڵ AMS · ڕەش' });
  // A product with no option: the product alone.
  assert.deepEqual((await read(ownerApp(raw), 'p_pla')).product.choices.map((c: Json) => c.combo_key), ['']);
});

test('add, then read: labels, host and source per link; the most specific first; a filter reads the links that apply to its SKUs', async () => {
  const raw = freshDb();
  seed(raw);
  const app = ownerApp(raw);
  const saved = await add(app, 'p_h2d', [
    { combo_key: '', url: 'https://www.aliexpress.com/item/1005006.html', label: 'AliExpress', supplier_name: 'Shenzhen 3D' },
    { combo_key: 'o:v_combo', url: 'https://eu.store.bambulab.com/de-de/products/h2d?utm_source=x', note: 'EU price incl. VAT' },
    { combo_key: 'c:c_wht', url: 'https://item.taobao.com/item.htm?id=7788' },
    { combo_key: COMBO_BLK, url: 'https://detail.tmall.com/item.htm?spm=a1z10.1&id=693972799714&skuId=4930331344241&ali_refid=x' },
  ]);
  assert.deepEqual(saved.saved, { added: 4, updated: 0, removed: 0 });
  const whole = (await read(app, 'p_h2d')).product;
  assert.deepEqual(
    whole.supplier_links.map((l: Json) => [l.combo_key, l.url, l.host, l.source, l.item_key, l.sku_key]),
    [
      [COMBO_BLK, 'https://detail.tmall.com/item.htm?id=693972799714&skuId=4930331344241', 'detail.tmall.com', 'tmall_cn', '693972799714', '4930331344241'],
      ['o:v_combo', 'https://eu.store.bambulab.com/products/h2d?skr=yes', 'eu.store.bambulab.com', 'bambu_eu', 'h2d', null],
      ['c:c_wht', 'https://item.taobao.com/item.htm?id=7788', 'item.taobao.com', 'other', null, null],
      ['', 'https://www.aliexpress.com/item/1005006.html', 'www.aliexpress.com', 'other', null, null],
    ]
  );
  const first = whole.supplier_links[3];
  assert.deepEqual([first.label, first.supplier_name, first.note, first.version, first.labels], ['AliExpress', 'Shenzhen 3D', '', 1, { ar: '', en: '', ckb: '' }]);
  assert.match(first.id, /^psl_[0-9a-f]{32}$/);
  assert.deepEqual(whole.supplier_links[0].labels, { ar: 'مع AMS · أسود', en: 'H2D AMS Combo · Black', ckb: 'لەگەڵ AMS · ڕەش' });
  assert.equal(whole.supplier_links[1].note, 'EU price incl. VAT');
  assert.match(whole.versions.links, /^4\.4\./);

  // An order line's exact SKU: its own links, its model's, its colour's and the product's.
  const order = await read(app, 'p_h2d', `?combo_key=${encodeURIComponent(COMBO_WHT)}`);
  assert.equal(order.scope_key, COMBO_WHT);
  assert.deepEqual(linksOf(order).map(([k]) => k), ['o:v_combo', 'c:c_wht', '']);
  assert.deepEqual(order.product.skus, [], 'no matched fact on that SKU');
  const black = await read(app, 'p_h2d', `?combo_key=${encodeURIComponent(COMBO_BLK)}`);
  assert.deepEqual(linksOf(black).map(([k]) => k), [COMBO_BLK, 'o:v_combo', '']);
  assert.deepEqual(black.product.skus.map((s: Json) => s.combo_key), [COMBO_BLK]);
  // A purchase line stocked per model: every link of a SKU of that model, and that model's matched facts.
  const model = await read(app, 'p_h2d', '?scope=option&scope_id=v_combo');
  assert.equal(model.scope_key, 'o:v_combo');
  assert.deepEqual(linksOf(model).map(([k]) => k), [COMBO_BLK, 'o:v_combo', 'c:c_wht', '']);
  assert.deepEqual(model.product.skus.map((s: Json) => s.combo_key), [COMBO_BLK]);
  const baseModel = await read(app, 'p_h2d', '?scope=option&scope_id=v_base');
  assert.deepEqual(linksOf(baseModel).map(([k]) => k), ['c:c_wht', '']);
  assert.deepEqual(baseModel.product.skus.map((s: Json) => s.combo_key), [BASE_WHT]);
  // …per colour.
  const white = await read(app, 'p_h2d', '?scope=color&scope_id=c_wht');
  assert.equal(white.scope_key, 'c:c_wht');
  assert.deepEqual(linksOf(white).map(([k]) => k), ['o:v_combo', 'c:c_wht', '']);
  // …per variant: the variant's own combination, read from product_variants.
  const variant = await read(app, 'p_h2d', '?scope=variant&scope_id=pv_combo_wht');
  assert.equal(variant.scope_key, COMBO_WHT);
  assert.deepEqual(linksOf(variant).map(([k]) => k), ['o:v_combo', 'c:c_wht', '']);
  // A variant gone since the purchase: the product's links only, no SKU's facts.
  const gone = await read(app, 'p_h2d', '?scope=variant&scope_id=pv_gone');
  assert.deepEqual([gone.scope_key, linksOf(gone).map(([k]) => k), gone.product.skus], ['', [''], []]);
  // The base row and no filter: everything.
  assert.equal((await read(app, 'p_h2d', '?scope=base')).product.supplier_links.length, 4);
  // An order line whose SKU is no longer sold (an option removed since): its parts still find their links.
  assert.deepEqual(linksOf(await read(app, 'p_h2d', `?combo_key=${encodeURIComponent('o:v_combo|c:c_gone')}`)).map(([k]) => k), ['o:v_combo', '']);

  // The query is checked: one filter at a time, canonical keys, known scopes.
  for (const [q, field] of [
    ['?combo_key=c:c_blk|o:v_combo', 'combo_key'],
    ['?combo_key=x:1', 'combo_key'],
    ['?combo_key=o:', 'combo_key'],
    [`?combo_key=${encodeURIComponent(COMBO_BLK)}&scope=base`, 'scope'],
    ['?scope=model&scope_id=v_combo', 'scope'],
    ['?scope=option', 'scope_id'],
    ['?scope=base&scope_id=x', 'scope_id'],
    ['?scope_id=v_combo', 'scope'],
    ['?scope=option&scope_id=a%20b', 'scope_id'],
  ] as const) {
    const r = await req(app, 'GET', `${BASE}/owner-links/p_h2d${q}`);
    assert.deepEqual([r.status, r.body.code, r.body.details], [400, 'PRICING_INPUT_INVALID', { field }], q);
  }
});

test('linkApplies: a link concerns a SKU that holds every part of its key', () => {
  assert.equal(linkApplies('', COMBO_BLK), true);
  assert.equal(linkApplies('o:v_combo', COMBO_BLK), true);
  assert.equal(linkApplies('c:c_blk', COMBO_BLK), true);
  assert.equal(linkApplies(COMBO_BLK, COMBO_BLK), true);
  assert.equal(linkApplies('c:c_wht', COMBO_BLK), false);
  assert.equal(linkApplies(COMBO_BLK, 'o:v_combo'), false);
  assert.equal(linkApplies('o:v_com', COMBO_BLK), false, 'parts, never a prefix');
});

// ------------------------------------------------------------------ the write

test('edit and remove: fenced on the token read; an edit moves its version; the audit carries counts only', async () => {
  const raw = freshDb();
  seed(raw);
  const app = ownerApp(raw);
  await add(app, 'p_h2d', [
    { combo_key: '', url: 'https://supplier-one.example/h2d' },
    { combo_key: 'o:v_base', url: 'https://supplier-two.example/h2d-base', label: 'Two' },
  ]);
  const before = (await read(app, 'p_h2d')).product;
  const [two, one] = before.supplier_links as Json[];
  assert.equal(two.label, 'Two');

  // A stale token is refused and nothing moves.
  const stale = await put(app, 'p_h2d', { version: EMPTY_TOKEN, remove: [one.id] });
  assert.deepEqual([stale.status, stale.body.code], [409, 'PRICING_CHANGED']);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_supplier_links'), 2);

  // One write: edit one (its key, address and label), remove the other.
  const edited = await put(app, 'p_h2d', {
    version: before.versions.links,
    upsert: [{ id: two.id, combo_key: 'c:c_blk', url: 'supplier-two.example/h2d-black', label: '  Two, black  ', supplier_name: 'Two Ltd', note: 'MOQ 2' }],
    remove: [one.id],
  });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual(edited.body.saved, { added: 0, updated: 1, removed: 1 });
  assert.deepEqual(
    all<Json>(raw, 'SELECT id, product_id, combo_key, url, host, label, supplier_name, note, version, created_by, updated_by FROM product_supplier_links'),
    [{ id: two.id, product_id: 'p_h2d', combo_key: 'c:c_blk', url: 'https://supplier-two.example/h2d-black', host: 'supplier-two.example', label: 'Two, black', supplier_name: 'Two Ltd', note: 'MOQ 2', version: 2, created_by: 'usr_owner', updated_by: 'usr_owner' }]
  );
  // The token he sent is spent: the same write again is refused.
  assert.equal((await put(app, 'p_h2d', { version: before.versions.links, remove: [two.id] })).status, 409);

  // No price was written and no match touched.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_matches'), 1);
  assert.deepEqual(row<Json>(raw, 'SELECT amount, version FROM supplier_price_manual'), { amount: '1399', version: 1 });

  // The audit: counts, never an address, a host, a label or a note.
  const audits = all<Json>(raw, "SELECT target, detail FROM audit_log WHERE action = 'supplier_prices.owner_links_set' ORDER BY id");
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map((a) => [a.target, JSON.parse(String(a.detail))]), [
    ['p_h2d', { added: 2, updated: 0, removed: 0 }],
    ['p_h2d', { added: 0, updated: 1, removed: 1 }],
  ]);
  for (const a of audits) assert.doesNotMatch(String(a.detail), /example|https|Two|MOQ/);
});

test('the address goes through the shared parser: a Tmall link rebuilt, an EU store link with skr=yes, any other https host kept; anything else refused by reason', async () => {
  const raw = freshDb();
  seed(raw);
  const app = ownerApp(raw);
  await add(app, 'p_h2d', [
    { combo_key: COMBO_BLK, url: 'https://detail.m.tmall.com/item.htm?id=693972799714&skuId=4930331344241&spm=a2141' },
    { combo_key: COMBO_WHT, url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115330' },
    { combo_key: BASE_BLK, url: 'https://us.store.bambulab.com/products/h2d?skr=yes' },
    { combo_key: BASE_WHT, url: 'HTTPS://Bücher.example/Path?q=<x>' },
  ]);
  assert.deepEqual(
    all<Json>(raw, 'SELECT combo_key, url, host FROM product_supplier_links ORDER BY combo_key'),
    [
      { combo_key: BASE_BLK, url: 'https://us.store.bambulab.com/products/h2d', host: 'us.store.bambulab.com' },
      { combo_key: BASE_WHT, url: 'https://xn--bcher-kva.example/Path?q=%3Cx%3E', host: 'xn--bcher-kva.example' },
      { combo_key: COMBO_BLK, url: 'https://detail.tmall.com/item.htm?id=693972799714&skuId=4930331344241', host: 'detail.tmall.com' },
      { combo_key: COMBO_WHT, url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115330&skr=yes', host: 'eu.store.bambulab.com' },
    ]
  );
  const version = (await read(app, 'p_h2d')).product.versions.links;
  for (const [url, reason] of [
    ['', 'empty'],
    ['http://detail.tmall.com/item.htm?id=1', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['data:text/html,hi', 'not_https'],
    ['//detail.tmall.com/item.htm?id=1', 'not_https'],
    ['https://user:pw@example.com/', 'credentials'],
    ['https://example.com:8443/', 'port'],
    ['https://127.0.0.1/x', 'host'],
    ['https://localhost/x', 'host'],
    ['https://intranet/x', 'host'],
    ['https://example.com/a b', 'not_url'],
    ['https://example.com/\u202eevil', 'not_url'],
    [`https://example.com/${'a'.repeat(1000)}`, 'too_long'],
  ] as const) {
    const r = await put(app, 'p_h2d', { version, upsert: [{ combo_key: '', url }] });
    assert.deepEqual([r.status, r.body.code, r.body.details], [400, 'PRICING_INPUT_INVALID', { field: 'url', reason }], url.slice(0, 60));
  }
  const notText = await put(app, 'p_h2d', { version, upsert: [{ combo_key: '', url: 42 }] });
  assert.deepEqual(notText.body.details, { field: 'url', reason: 'not_url' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_supplier_links'), 4, 'no refused address was stored');
});

test('every other refusal names its field: strict bodies, keys the product does not offer, foreign or unknown ids, texts, duplicates and the cap of 40', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO product_supplier_links (id, product_id, combo_key, url, host, created_by, created_at, updated_by, updated_at)
    VALUES ('psl_foreign', 'p_pla', '', 'https://filament.example/', 'filament.example', 'usr_owner', '${AT}', 'usr_owner', '${AT}')`);
  const app = ownerApp(raw);
  await add(app, 'p_h2d', [{ combo_key: 'o:v_combo', url: 'https://supplier.example/a' }]);
  const version = (await read(app, 'p_h2d')).product.versions.links;
  const mine = (await read(app, 'p_h2d')).product.supplier_links[0].id;
  const ok = { combo_key: '', url: 'https://supplier.example/b' };

  const extra = await put(app, 'p_h2d', { version, upsert: [ok], price: '1' });
  assert.deepEqual([extra.status, extra.body.code, extra.body.details], [400, 'UNKNOWN_FIELD', { field: 'price' }]);
  const inner = await put(app, 'p_h2d', { version, upsert: [{ ...ok, amount: '1' }] });
  assert.deepEqual([inner.status, inner.body.code, inner.body.details], [400, 'UNKNOWN_FIELD', { field: 'amount' }]);
  for (const [body, field] of [
    [{ upsert: [ok] }, 'version'],
    [{ version: 7, upsert: [ok] }, 'version'],
    [{ version }, 'upsert'],
    [{ version, upsert: [] }, 'upsert'],
    [{ version, upsert: 'x' }, 'upsert'],
    [{ version, upsert: [7] }, 'upsert'],
    [{ version, upsert: Array.from({ length: 21 }, (_, i) => ({ combo_key: '', url: `https://s.example/${i}` })) }, 'upsert'],
    [{ version, remove: 'x' }, 'remove'],
    [{ version, remove: ['bad id'] }, 'remove'],
    [{ version, remove: [mine, mine] }, 'remove'],
    [{ version, remove: ['psl_nobody'] }, 'remove'],
    [{ version, remove: ['psl_foreign'] }, 'remove'],
    [{ version, upsert: [{ ...ok, id: mine }], remove: [mine] }, 'remove'],
    [{ version, upsert: [{ ...ok, id: 'psl_nobody' }] }, 'id'],
    [{ version, upsert: [{ ...ok, id: 'psl_foreign' }] }, 'id'],
    [{ version, upsert: [{ ...ok, id: 'nope' }] }, 'id'],
    [{ version, upsert: [{ ...ok, id: mine }, { ...ok, id: mine, url: 'https://supplier.example/c' }] }, 'id'],
    [{ version, upsert: [{ url: ok.url }] }, 'combo_key'],
    [{ version, upsert: [{ ...ok, combo_key: 'c:c_blk|o:v_combo' }] }, 'combo_key'],
    [{ version, upsert: [{ ...ok, combo_key: 'o:v_nope' }] }, 'combo_key'],
    [{ version, upsert: [{ ...ok, combo_key: 'o:v_combo|o:v_base' }] }, 'combo_key'],
    [{ version, upsert: [{ ...ok, label: 'x'.repeat(81) }] }, 'label'],
    [{ version, upsert: [{ ...ok, label: 'a\u202eb' }] }, 'label'],
    [{ version, upsert: [{ ...ok, supplier_name: 5 }] }, 'supplier_name'],
    [{ version, upsert: [{ ...ok, note: 'x'.repeat(301) }] }, 'note'],
  ] as const) {
    const r = await put(app, 'p_h2d', body);
    assert.deepEqual([r.status, r.body.code, r.body.details?.field], [400, 'PRICING_INPUT_INVALID', field], JSON.stringify(body).slice(0, 120));
  }
  // The same address twice for one key — in one write, or beside a stored one — is refused; for another key it is not.
  const twice = await put(app, 'p_h2d', { version, upsert: [ok, { ...ok, label: 'again' }] });
  assert.deepEqual(twice.body.details, { field: 'url', reason: 'duplicate' });
  const stored = await put(app, 'p_h2d', { version, upsert: [{ combo_key: 'o:v_combo', url: 'supplier.example/a' }] });
  assert.deepEqual(stored.body.details, { field: 'url', reason: 'duplicate' });
  assert.equal((await put(app, 'p_h2d', { version, upsert: [{ combo_key: 'o:v_base', url: 'https://supplier.example/a' }] })).status, 200);
  // No such product: 404.
  assert.equal((await put(app, 'zz-no-such-id', { version: EMPTY_TOKEN, upsert: [ok] })).status, 404);
  // The cap: 40 links a product.
  for (let n = 0; count(raw, "SELECT COUNT(*) AS n FROM product_supplier_links WHERE product_id = 'p_h2d'") < OWNER_LINKS_PER_PRODUCT; n += 1) {
    const have = count(raw, "SELECT COUNT(*) AS n FROM product_supplier_links WHERE product_id = 'p_h2d'");
    const batch = Array.from({ length: Math.min(20, OWNER_LINKS_PER_PRODUCT - have) }, (_, i) => ({ combo_key: '', url: `https://bulk.example/${n}/${i}` }));
    await add(app, 'p_h2d', batch);
  }
  const full = await put(app, 'p_h2d', { version: (await read(app, 'p_h2d')).product.versions.links, upsert: [{ combo_key: '', url: 'https://one-more.example/' }] });
  assert.deepEqual([full.status, full.body.details], [400, { field: 'upsert', reason: 'limit' }]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_supplier_links WHERE product_id = 'p_h2d'"), OWNER_LINKS_PER_PRODUCT);
  // The other product's link was never touched.
  assert.deepEqual(row<Json>(raw, "SELECT product_id, version FROM product_supplier_links WHERE id = 'psl_foreign'"), { product_id: 'p_pla', version: 1 });
});

test('the token is the read’s and the fence’s: one expression, product by product', async () => {
  const raw = freshDb();
  seed(raw);
  const app = ownerApp(raw);
  await add(app, 'p_h2d', [{ combo_key: '', url: 'https://supplier.example/a' }]);
  const token = (await read(app, 'p_h2d')).product.versions.links;
  assert.equal(row<Json>(raw, `SELECT ${OWNER_LINKS_TOKEN_SQL} AS t`, 'p_h2d')!.t, token);
  assert.equal(row<Json>(raw, `SELECT ${OWNER_LINKS_TOKEN_SQL} AS t`, 'p_pla')!.t, EMPTY_TOKEN);
  assert.equal((await read(app, 'p_pla')).product.versions.links, EMPTY_TOKEN, 'another product’s links never move its token');
});

test('the fence holds inside the write’s own batch: another tab’s save landing after this write read the token is kept, and this write is refused whole (409)', async () => {
  const raw = freshDb();
  seed(raw);
  await add(ownerApp(raw), 'p_h2d', [{ combo_key: '', url: 'https://first.example/' }]);
  const before = (await read(ownerApp(raw), 'p_h2d')).product;
  const first = before.supplier_links[0].id as string;
  // Another tab saves a link between this write's own read of the token (which still matches what it sent) and its batch.
  class OtherTabFirst extends SqliteD1 {
    fired = false;
    override batch(statements: SqliteStatement[]) {
      if (!this.fired && statements.some((s) => /INSERT INTO ops_guards/.test(s.sql))) {
        this.fired = true;
        raw.exec(`INSERT INTO product_supplier_links (id, product_id, combo_key, url, host, created_by, created_at, updated_by, updated_at)
          VALUES ('psl_other_tab', 'p_h2d', 'c:c_blk', 'https://other-tab.example/', 'other-tab.example', 'usr_owner', '2026-11-05T10:00:00.000Z', 'usr_owner', '2026-11-05T10:00:00.000Z')`);
      }
      return super.batch(statements);
    }
  }
  const racing = new OtherTabFirst(raw);
  const r = await put(appOn(racing as unknown as D1Database, OWNER), 'p_h2d', {
    version: before.versions.links,
    upsert: [{ combo_key: '', url: 'https://mine.example/' }],
    remove: [first],
  });
  assert.ok(racing.fired, 'the other tab saved inside the window');
  assert.deepEqual([r.status, r.body.code], [409, 'PRICING_CHANGED']);
  // The other tab's link is kept, nothing of this write landed: no add, no removal, no audit row.
  assert.deepEqual(
    all<Json>(raw, 'SELECT id, url FROM product_supplier_links ORDER BY url'),
    [
      { id: first, url: 'https://first.example/' },
      { id: 'psl_other_tab', url: 'https://other-tab.example/' },
    ]
  );
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier_prices.owner_links_set'"), 1, 'only the first add');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'the fence leaves no guard row');
});

test('a grid too large for the engine: the product, its models and its colours to choose from; a link on a model reads on an order line; a full SKU key is refused', async () => {
  const raw = freshDb();
  const models = Array.from({ length: 20 }, (_, i) => `v${String(i).padStart(2, '0')}`);
  const colours = Array.from({ length: 13 }, (_, i) => `c${String(i).padStart(2, '0')}`);
  assert.ok(models.length * colours.length > ENGINE_MAX_SKUS, 'past the engine’s grid: no SKU list');
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES ('p_big', 'big', 'Big grid', 'شبكة كبيرة', 'تۆڕی گەورە');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_big', 'p_big', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ${models.map((v, i) => `('${v}', 'p_big', 'g_big', 'Model ${v}', 'موديل ${v}', 'مۆدێلی ${v}', ${i}, 1)`).join(',\n      ')};
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES
      ${colours.map((c, i) => `('${c}', 'p_big', 'Colour ${c}', 'لون ${c}', 'ڕەنگی ${c}', '#000000', ${i}, 1)`).join(',\n      ')};
  `);
  const app = ownerApp(raw);
  const view = await read(app, 'p_big');
  assert.deepEqual(
    view.product.choices.map((c: Json) => [c.combo_key, c.kind]),
    [['', 'product'], ...models.map((v) => [`o:${v}`, 'option']), ...colours.map((c) => [`c:${c}`, 'colour'])]
  );
  const named = new Map((view.product.choices as Json[]).map((c) => [c.combo_key, c.labels]));
  assert.deepEqual(named.get('o:v03'), { ar: 'موديل v03', en: 'Model v03', ckb: 'مۆدێلی v03' });
  assert.deepEqual(named.get('c:c05'), { ar: 'لون c05', en: 'Colour c05', ckb: 'ڕەنگی c05' });
  // A link on one model is saved; an order line of that model, in any colour, reads it; another model's does not.
  await add(app, 'p_big', [{ combo_key: 'o:v03', url: 'https://big-supplier.example/v03' }]);
  const order = await read(app, 'p_big', `?combo_key=${encodeURIComponent('o:v03|c:c05')}`);
  assert.deepEqual(linksOf(order), [['o:v03', 'https://big-supplier.example/v03']]);
  assert.deepEqual(linksOf(await read(app, 'p_big', `?combo_key=${encodeURIComponent('o:v04|c:c05')}`)), []);
  // A full SKU key is not offered there: refused by its field, nothing stored.
  const r = await put(app, 'p_big', { version: order.product.versions.links, upsert: [{ combo_key: 'o:v03|c:c05', url: 'https://big-supplier.example/v03-c05' }] });
  assert.deepEqual([r.status, r.body.code, r.body.details], [400, 'PRICING_INPUT_INVALID', { field: 'combo_key' }]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM product_supplier_links WHERE product_id = 'p_big'"), 1);
});

test('a note keeps its lines (a Windows or old Mac break is stored as \\n); any other control or a bidi override is refused, and the label stays one line', async () => {
  const raw = freshDb();
  seed(raw);
  const app = ownerApp(raw);
  await add(app, 'p_h2d', [{ combo_key: '', url: 'https://notes.example/', note: '  MOQ 2\r\nask for the black one\rships in a week  ' }]);
  const stored = 'MOQ 2\nask for the black one\nships in a week';
  assert.equal(row<Json>(raw, 'SELECT note FROM product_supplier_links')!.note, stored);
  const view = (await read(app, 'p_h2d')).product;
  assert.equal(view.supplier_links[0].note, stored);
  for (const note of ['a\tb', 'a\u0000b', 'a\u000bb', 'a\u007fb', 'a‮b', 'a⁦b', `${'x'.repeat(300)}\ny`]) {
    const r = await put(app, 'p_h2d', { version: view.versions.links, upsert: [{ combo_key: 'o:v_combo', url: 'https://notes.example/', note }] });
    assert.deepEqual([r.status, r.body.code, r.body.details?.field], [400, 'PRICING_INPUT_INVALID', 'note'], JSON.stringify(note).slice(0, 40));
  }
  for (const field of ['label', 'supplier_name']) {
    const r = await put(app, 'p_h2d', { version: view.versions.links, upsert: [{ combo_key: 'o:v_combo', url: 'https://notes.example/', [field]: 'a\nb' }] });
    assert.deepEqual([r.status, r.body.details?.field], [400, field]);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_supplier_links'), 1, 'no refused write was stored');
});

// ------------------------------------------------------------------ the second net

test('the second net: projected for a non-owner, no link, host, label, supplier name or matched fact survives', async () => {
  const raw = freshDb();
  seed(raw);
  const app = ownerApp(raw);
  await add(app, 'p_h2d', [{ combo_key: 'o:v_combo', url: 'https://secret-supplier-9q.example/h2d', label: 'LABEL-9Q', supplier_name: 'SUPPLIER-9Q', note: 'NOTE-9Q' }]);
  const body = await read(app, 'p_h2d');
  const text = JSON.stringify(body);
  for (const w of ['secret-supplier-9q.example', 'LABEL-9Q', 'SUPPLIER-9Q', 'NOTE-9Q', '1599', '1399']) assert.ok(text.includes(w), `the owner reads ${w}`);
  const projected = JSON.stringify(stripFinancials(body));
  for (const w of ['supplier_links', 'supplier_prices', 'secret-supplier-9q', 'LABEL-9Q', 'SUPPLIER-9Q', 'NOTE-9Q', '1599', '1399', 'skr=yes']) assert.ok(!projected.includes(w), w);
  assert.ok(projected.includes('p_h2d'), 'the product itself is not a supplier datum');
});

// ------------------------------------------------------------------ deploy-ahead

test('without 0223: the read answers installed:false with the matched links still there; the write 503 SUPPLIER_LINKS_NOT_INSTALLED', async () => {
  const raw = dbThrough('0220');
  seed(raw);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'product_supplier_links'"), 0);
  const app = ownerApp(raw);
  const body = await read(app, 'p_h2d', '?scope=option&scope_id=v_combo');
  assert.equal(body.installed, false);
  assert.equal(body.scope_key, 'o:v_combo');
  assert.deepEqual(body.product.supplier_links, []);
  assert.equal(body.product.versions.links, EMPTY_TOKEN);
  assert.deepEqual(body.product.skus.map((s: Json) => s.combo_key), [COMBO_BLK], 'the matched links still answer');
  assert.ok(body.product.choices.length > 1);
  const w = await put(app, 'p_h2d', { version: EMPTY_TOKEN, upsert: [{ combo_key: '', url: 'https://supplier.example/' }] });
  assert.deepEqual([w.status, w.body.code, w.headers.get('cache-control')], [503, 'SUPPLIER_LINKS_NOT_INSTALLED', 'private, no-store']);
  // The missing table is its own: never mistaken for a missing 0218.
  const missing = new Error('D1_ERROR: no such table: product_supplier_links: SQLITE_ERROR');
  assert.equal(isMissingOwnerLinks(missing), true);
  assert.equal(isMissingEstimateSchema(missing), false);
  assert.equal(isMissingOwnerLinks(new Error('no such table: supplier_price_manual')), false);
  // Every other admin is still refused at the door.
  assert.equal((await req(appAs(raw, FULL), 'GET', `${BASE}/owner-links/p_h2d`)).status, 403);
});

test('without 0218: the read answers the product alone (installed:false, no fact, no key); the write 503 PRICE_ESTIMATES_NOT_INSTALLED', async () => {
  const raw = dbThrough('0217');
  raw.exec("INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES ('p_h2d', 'h2d', 'Bambu Lab H2D', 'طابعة H2D', 'چاپکەری H2D')");
  const app = ownerApp(raw);
  const body = await read(app, 'p_h2d', `?combo_key=${encodeURIComponent(COMBO_BLK)}`);
  assert.deepEqual(body, {
    success: true,
    installed: false,
    scope_key: COMBO_BLK,
    product: {
      product_id: 'p_h2d',
      name: 'Bambu Lab H2D',
      names: { ar: 'طابعة H2D', en: 'Bambu Lab H2D', ckb: 'چاپکەری H2D' },
      versions: { matches: EMPTY_TOKEN, manual: EMPTY_TOKEN, links: EMPTY_TOKEN },
      skus: [],
      supplier_links: [],
      choices: [],
    },
  });
  assert.equal((await req(app, 'GET', `${BASE}/owner-links/zz-no-such-id`)).status, 404);
  const w = await put(app, 'p_h2d', { version: EMPTY_TOKEN, upsert: [{ combo_key: '', url: 'https://supplier.example/' }] });
  assert.deepEqual([w.status, w.body.code], [503, 'PRICE_ESTIMATES_NOT_INSTALLED']);
});

// ------------------------------------------------------------------ one reader

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, name);
    if (statSync(p).isDirectory()) filesUnder(relative(ROOT, p), out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}

test('one reader: only ownerLinks.ts and the table registries name the table; only the owner router imports it; only the admin chunk’s api.ts calls the route', () => {
  const worker = filesUnder('worker');
  assert.deepEqual(
    worker.filter((f) => /\bproduct_supplier_links\b/.test(codeOf(f))).sort(),
    ['worker/lib/catalogImport/protectedTables.ts', 'worker/lib/mediaRefs.ts', 'worker/lib/productDeletion.ts', 'worker/lib/supplierPrices/ownerLinks.ts']
  );
  assert.deepEqual(worker.filter((f) => /supplierPrices\/ownerLinks['"]/.test(codeOf(f))), ['worker/routes/adminSupplierPrices.ts']);
  // No customer or staff route, cron or job reaches it: the router is mounted only inside the owner's pricing router.
  assert.deepEqual(worker.filter((f) => /adminSupplierPrices['"]/.test(codeOf(f))), ['worker/routes/adminPricing.ts']);
  const src = filesUnder('src');
  assert.deepEqual(src.filter((f) => /owner-links/.test(codeOf(f))), ['src/components/adminEstimates/api.ts']);
  assert.deepEqual(src.filter((f) => /\bproduct_supplier_links\b/.test(codeOf(f))), []);
  // The migration is the one that creates it.
  const creators = readdirSync(join(ROOT, 'migrations')).filter((f) => /CREATE TABLE IF NOT EXISTS product_supplier_links\b/.test(readFileSync(join(ROOT, 'migrations', f), 'utf8')));
  assert.deepEqual(creators, ['0223_product_supplier_links.sql']);
});
