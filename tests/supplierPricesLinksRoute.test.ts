/**
 * GET /api/admin/pricing/supplier-prices/links — THE OWNER'S SUPPLIER LINKS
 * (docs/SMART_PRICING.md §3.9; the owner's request of 2026-10-31, DECISIONS
 * row 278: "for tmall saved id of every product and link for admin so here can
 * easily found the product by tap on link to order it or update the price").
 *
 *   - owner-only: a non-owner admin is refused in the same bytes as every other
 *     supplier-price route and every cost route;
 *   - the list: 25 products a page, the most recently linked or priced first,
 *     an opaque cursor, a source filter, and a search in every form the owner
 *     pastes or types (Tmall URL or id, store URL or handle, colour or part
 *     code, words of the product's name or the supplier's title);
 *   - one product, per sellable SKU with its names in ar / en / ckb: source,
 *     state (auto / confirmed / suggested / manual), ids, titles, price,
 *     currency, label, capture date and the two links, built only from
 *     validated ids — https, EU with skr=yes, US without; an id that fails gets
 *     no link;
 *   - a hostile stored `url` or `evidence_url` never appears in an answer;
 *   - a key missing from the newest capture keeps its links and shows no price;
 *   - a database without 0218 answers an empty list;
 *   - every supplier datum sits under a FINANCIAL_FIELDS key (the second net).
 *
 * Run: node --import tsx --test tests/supplierPricesLinksRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, ctx, dbThrough, freshDb, stubApp, type StubUser } from './fixtures/app';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { stripFinancials } from '../worker/lib/adminScope';
import { EMPTY_TOKEN } from '../worker/lib/supplierPrices/store';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type App = ReturnType<typeof stubApp>;

const BASE = '/api/admin/pricing/supplier-prices';
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

const appAs = (raw: DatabaseSync, user: StubUser | null): App =>
  stubApp(asD1(raw), user, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route(BASE, adminSupplierPricesRoutes);
  });
const bareAs = (raw: DatabaseSync, user: StubUser | null): App => stubApp(asD1(raw), user, (a) => a.route(BASE, adminSupplierPricesRoutes));

async function get(app: App, path: string) {
  const res = await app.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Json, text, headers: res.headers };
}

const SHA = 'f'.repeat(64);
const HOSTILE = ['evil.example', 'javascript:', 'data:text'];

/** A catalogue written straight into the 0218 tables: three current captures, matches in every state, the owner's prices. */
function seed(raw: DatabaseSync): void {
  const fillers = Array.from({ length: 30 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      product: `('p_f${n}', 'filler-${n}', 'Filler ${n}', 'منتج ${n}', 'بەرهەم ${n}')`,
      match: `('p_f${n}', '', 'tmall_cn', '693972799714', '4930331344241', 'low', 'name', '[]', 1, 'suggested', '', '', 'sps_tm', 1, '2026-10-01T00:00:${n}.000Z')`,
    };
  });
  raw.exec(`
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, item_count, sku_count, state, created_by, created_at, completed_at) VALUES
      ('sps_tm', 'tmall_cn', 'CNY', 'browser_sweep', '2026-10-31', '${SHA}', 2, 3, 'complete', 'usr_owner', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z'),
      ('sps_eu', 'bambu_eu', 'EUR', 'browser_sweep', '2026-10-30', '${SHA}', 2, 3, 'complete', 'usr_owner', '2026-10-30T00:00:00Z', '2026-10-30T00:00:00Z'),
      ('sps_us', 'bambu_us', 'USD', 'store_script', '2026-10-29', '${SHA}', 1, 1, 'complete', 'usr_owner', '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z'),
      ('sps_old', 'tmall_cn', 'CNY', 'browser_sweep', '2026-09-01', '${SHA}', 1, 1, 'superseded', 'usr_owner', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    -- Stored addresses are hostile on purpose: a link is never built from them, and they are never answered.
    INSERT INTO supplier_price_items (snapshot_id, item_key, url, page_host, title, name_en, category) VALUES
      ('sps_tm', '693972799714', 'javascript:alert(1)', 'detail.tmall.com', '拓竹PLA Basic基础 3D打印耗材', 'PLA Basic filament', 'filament'),
      ('sps_tm', '1036834158903', 'https://evil.example/phish', 'evil.example', '拓竹 斜口剪钳 创客宝库-QA018', 'Flush cutters', 'tool'),
      ('sps_eu', 'h2d', 'data:text/html,<script>1</script>', 'eu.store.bambulab.com', 'Bambu Lab H2D', 'Bambu Lab H2D', 'printer'),
      ('sps_eu', 'usb‑c-soldering-iron-kit', '', 'eu.store.bambulab.com', 'USB-C Soldering Iron Kit', 'USB-C Soldering Iron Kit', ''),
      ('sps_us', 'h2d', 'https://evil.example/us', 'us.store.bambulab.com', 'Bambu Lab H2D', 'Bambu Lab H2D', 'printer'),
      ('sps_old', '693972799714', 'https://evil.example/old', '', 'old title', 'old', 'filament');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, options_json, options_en_json, price, price_label, quantity) VALUES
      ('sps_tm', '693972799714', '4930331344241', '{"颜色":"红色10200【含料盘】"}', '{"Colour":"Red 10200 (with spool)"}', '75', '优惠前', 200),
      ('sps_tm', '693972799714', '5789497398754', '{"颜色":"红色10200【无料盘】"}', '{"Colour":"Red 10200 (refill, no spool)"}', '65', '优惠前', 200),
      ('sps_tm', '1036834158903', '6054830021130', '{"商品规格":"斜口剪钳"}', '{"Spec":"Flush cutters"}', '75', '优惠前', 178),
      ('sps_eu', 'h2d', '596571526982115329', '{"option1":"H2D AMS Combo","option2":"Standard"}', '{"option1":"H2D AMS Combo","option2":"Standard"}', '1599', '', NULL),
      ('sps_eu', 'h2d', 'A00-H2D-BASE', '{"option1":"H2D","option2":"Standard"}', '{"option1":"H2D","option2":"Standard"}', '1399', '', NULL),
      ('sps_eu', 'usb‑c-soldering-iron-kit', '43719762900001', '{"option1":"Default"}', '{"option1":"Default"}', '39.99', '', NULL),
      ('sps_us', 'h2d', '581025672340709385', '{"option1":"H2D AMS Combo"}', '{"option1":"H2D AMS Combo"}', '1899', '', NULL),
      ('sps_old', '693972799714', '4930331344241', '{}', '{}', '99', '', NULL);
    INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key, sku_key) VALUES
      ('sps_tm', 'color_code', '10200', '693972799714', '4930331344241'),
      ('sps_tm', 'part_code', 'QA018', '1036834158903', ''),
      ('sps_old', 'part_code', 'ZZ999', '693972799714', '');

    INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES
      ('p_pla', 'pla-basic', 'PLA Basic', 'بي إل إيه بيسك', 'پی ئێڵ ئەی بەیسیک'),
      ('p_cut', 'flush-cutters', 'Flush Cutters', 'قاطعة', 'بڕەر'),
      ('p_h2d', 'h2d', 'Bambu Lab H2D', 'طابعة H2D', 'چاپکەری H2D'),
      ('p_kit', 'soldering-kit', 'USB-C Soldering Iron Kit', 'عدة لحام', 'کیتی لەحیم'),
      ('p_missing', 'cutters-old', 'Old Cutters', 'قاطعة قديمة', 'بڕەری کۆن'),
      ('p_manual', 'manual-only', 'Typed Only', 'سعر يدوي', 'نرخی دەستی'),
      ('p_rejected', 'rejected-only', 'Rejected Only', 'مرفوض', 'ڕەتکراوە'),
      ('p_none', 'no-links', 'No Links', 'بلا روابط', 'بێ بەستەر'),
      ${fillers.map((f) => f.product).join(',\n      ')};
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES
      ('g_col', 'p_pla', 'Colour', 'color', 0, 1), ('g_spl', 'p_pla', 'Spool', 'spool', 1, 1), ('g_b', 'p_h2d', 'Bundle', 'version', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('v_red', 'p_pla', 'g_col', 'Red (10200)', 'أحمر', 'سوور', 0, 1),
      ('v_spl', 'p_pla', 'g_spl', 'Filament with spool', 'مع بكرة', 'لەگەڵ بەکرە', 0, 1),
      ('v_ref', 'p_pla', 'g_spl', 'Refill', 'عبوة بلا بكرة', 'بێ بەکرە', 1, 1),
      ('v_combo', 'p_h2d', 'g_b', 'H2D AMS Combo', 'مع AMS', 'لەگەڵ AMS', 0, 1),
      ('v_base', 'p_h2d', 'g_b', 'H2D', 'الطابعة وحدها', 'تەنها چاپکەرەکە', 1, 1);

    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, reasons_json, units_per_offer, state, decided_by, decided_at, found_in_snapshot, version, updated_at) VALUES
      ('p_pla', 'o:v_red|o:v_spl', 'tmall_cn', '693972799714', '4930331344241', 'high', 'color_code', '["COLOUR_COVERAGE","SPOOL_DICT"]', 1, 'confirmed', 'auto', '2026-10-31T10:00:00.000Z', 'sps_tm', 1, '2026-10-31T10:00:00.000Z'),
      ('p_pla', 'o:v_red|o:v_ref', 'tmall_cn', '693972799714', '5789497398754', 'medium', 'name', '[]', 1, 'suggested', '', '', 'sps_tm', 1, '2026-10-31T10:00:00.000Z'),
      ('p_cut', '', 'tmall_cn', '1036834158903', '6054830021130', 'exact', 'owner', '[]', 1, 'confirmed', 'usr_owner', '2026-10-31T09:00:00.000Z', 'sps_tm', 2, '2026-10-31T09:00:00.000Z'),
      ('p_h2d', 'o:v_combo', 'bambu_eu', 'h2d', '596571526982115329', 'high', 'handle', '[]', 1, 'confirmed', 'auto', '2026-10-31T08:00:00.000Z', 'sps_eu', 1, '2026-10-31T08:00:00.000Z'),
      ('p_h2d', 'o:v_base', 'bambu_eu', 'h2d', 'A00-H2D-BASE', 'high', 'handle', '[]', 1, 'confirmed', 'auto', '2026-10-31T08:00:00.000Z', 'sps_eu', 1, '2026-10-31T08:00:00.000Z'),
      ('p_h2d', 'o:v_combo', 'bambu_us', 'h2d', '581025672340709385', 'medium', 'name', '[]', 1, 'suggested', '', '', 'sps_us', 1, '2026-10-31T07:30:00.000Z'),
      ('p_kit', '', 'bambu_eu', 'usb‑c-soldering-iron-kit', '43719762900001', 'high', 'handle', '[]', 1, 'confirmed', 'auto', '2026-10-31T07:00:00.000Z', 'sps_eu', 1, '2026-10-31T07:00:00.000Z'),
      ('p_missing', '', 'tmall_cn', '1036834158903', '6099999999999', 'exact', 'owner', '[]', 1, 'confirmed', 'usr_owner', '2026-10-31T06:00:00.000Z', 'sps_old', 1, '2026-10-31T06:00:00.000Z'),
      ('p_rejected', '', 'tmall_cn', '693972799714', '4930331344241', 'low', 'name', '[]', 1, 'rejected', 'usr_owner', '2026-10-31T12:00:00.000Z', 'sps_tm', 1, '2026-10-31T12:00:00.000Z'),
      ${fillers.map((f) => f.match).join(',\n      ')};
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, evidence_url, evidence_host, note, entered_by, entered_at, version) VALUES
      ('p_pla', 'o:v_red|o:v_ref', '9.9', 'USD', 'store_page', 'https://evil.example/manual', 'evil.example', '', 'usr_owner', '2026-10-31T11:00:00.000Z', 1),
      ('p_manual', '', '12', 'EUR', 'typed', 'javascript:alert(2)', '', 'from the invoice', 'usr_owner', '2026-10-31T05:00:00.000Z', 3);
  `);
}

const ids = (body: Json) => (body.products as Json[]).map((p) => p.product_id);
const MAIN = ['p_pla', 'p_cut', 'p_h2d', 'p_kit', 'p_missing', 'p_manual'];
const FILLERS = Array.from({ length: 30 }, (_, i) => `p_f${String(30 - i).padStart(2, '0')}`);

test('owner-only: every other admin is refused in the same bytes as the other supplier-price routes and every cost route; never stored', async () => {
  const raw = freshDb();
  seed(raw);
  const reference = await get(appAs(raw, FULL), '/api/admin/pricing/overview');
  const snapshots = await get(appAs(raw, FULL), `${BASE}/snapshots`);
  assert.equal(reference.status, 403);
  assert.equal(snapshots.text, reference.text);
  for (const user of [FULL, ASSISTANT]) {
    for (const mount of [appAs, bareAs]) {
      for (const path of [`${BASE}/links`, `${BASE}/links?q=693972799714&source=tmall_cn`, `${BASE}/links/p_pla`, `${BASE}/links/zz-no-such-id`]) {
        const r = await get(mount(raw, user), path);
        assert.equal(r.status, 403, `${user.id} ${path}`);
        assert.equal(r.text, reference.text, `${user.id} ${path}`);
        assert.equal(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(!r.text.includes('tmall'));
      }
    }
  }
  assert.equal((await get(appAs(raw, null), `${BASE}/links`)).status, 401);
  const owner = await get(appAs(raw, OWNER), `${BASE}/links`);
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('cache-control'), 'private, no-store');
});

test('the list: 25 a page, the most recently linked or priced first, an opaque cursor; rejected-only and unlinked products are not listed', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  const first = await get(app, `${BASE}/links`);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(ids(first.body), [...MAIN, ...FILLERS.slice(0, 19)]);
  assert.equal(typeof first.body.next_cursor, 'string');
  assert.match(first.body.next_cursor, /^[A-Za-z0-9_-]+$/);
  const second = await get(app, `${BASE}/links?cursor=${first.body.next_cursor}`);
  assert.deepEqual(ids(second.body), FILLERS.slice(19));
  assert.equal(second.body.next_cursor, null);
  for (const bad of ['a.b', 'bm90IGpzb24', 'W10']) assert.deepEqual((await get(app, `${BASE}/links?cursor=${bad}`)).body.details, { field: 'cursor' }, bad);
  // The source filter: that source's matches only, and no owner's price (it has no source).
  assert.deepEqual(ids((await get(app, `${BASE}/links?source=bambu_us`)).body), ['p_h2d']);
  assert.deepEqual(ids((await get(app, `${BASE}/links?source=bambu_eu`)).body), ['p_h2d', 'p_kit']);
  const eu = (await get(app, `${BASE}/links?source=bambu_eu`)).body.products[0];
  assert.ok(eu.skus.every((s: Json) => s.supplier_prices.every((l: Json) => l.source === 'bambu_eu')));
  assert.deepEqual((await get(app, `${BASE}/links?source=taobao`)).body.details, { field: 'source' });
});

test('the search: a Tmall URL or id, a store URL or handle, a colour or part code, words of the product or the supplier’s title', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  const search = async (q: string, extra = '') => ids((await get(app, `${BASE}/links?q=${encodeURIComponent(q)}${extra}`)).body);
  assert.deepEqual(await search('693972799714'), ['p_pla', ...FILLERS.slice(0, 24)].slice(0, 25));
  assert.deepEqual(await search('https://detail.tmall.com/item.htm?id=1036834158903&skuId=6054830021130'), ['p_cut', 'p_missing']);
  assert.deepEqual(await search('6054830021130'), ['p_cut'], 'a Tmall SKU id');
  assert.deepEqual(await search('QA018'), ['p_cut', 'p_missing'], 'a part code of the matched listing');
  assert.deepEqual(await search('10200'), ['p_pla', ...FILLERS.slice(0, 24)], 'a colour code of the matched SKU');
  assert.deepEqual(await search('h2d'), ['p_h2d'], 'a store handle');
  assert.deepEqual(await search('https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes'), ['p_h2d']);
  assert.deepEqual(await search('https://us.store.bambulab.com/products/h2d'), ['p_h2d']);
  assert.deepEqual(await search('581025672340709385'), ['p_h2d'], 'a store variant id');
  assert.deepEqual(await search('Filler 07'), ['p_f07'], 'words of the product name');
  assert.deepEqual(await search('عدة لحام'), ['p_kit'], 'the Arabic name');
  assert.deepEqual(await search('PLA Basic'), ['p_pla', ...FILLERS.slice(0, 24)], 'words of the name or of the matched title');
  assert.deepEqual(await search('Rejected Only'), [], 'a product with no link is never listed, whatever the search');
  assert.deepEqual(await search('ZZ999'), [], 'a superseded capture is never searched');
  assert.deepEqual(await search('100%_'), [], '% and _ are literal');
  assert.deepEqual(await search('h2d', '&source=bambu_us'), ['p_h2d']);
  assert.deepEqual(await search('QA018', '&source=bambu_eu'), []);
});

test('one product: per sellable SKU its names in three languages, each supplier fact with its links — built from validated ids only', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  const one = async (pid: string) => {
    const r = await get(app, `${BASE}/links/${pid}`);
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  const pla = await one('p_pla');
  assert.equal(pla.products.length, 1);
  const p = pla.products[0];
  assert.deepEqual([p.product_id, p.name, p.names], ['p_pla', 'PLA Basic', { ar: 'بي إل إيه بيسك', en: 'PLA Basic', ckb: 'پی ئێڵ ئەی بەیسیک' }]);
  assert.deepEqual(pla.versions, p.versions);
  assert.match(p.versions.matches, /^2\.2\.2026-10-31T10:00:00\.000Z$/);
  const spool = p.skus.find((s: Json) => s.combo_key === 'o:v_red|o:v_spl');
  assert.deepEqual(spool.labels, { ar: 'أحمر · مع بكرة', en: 'Red (10200) · Filament with spool', ckb: 'سوور · لەگەڵ بەکرە' });
  const auto = spool.supplier_prices[0];
  assert.deepEqual(
    {
      source: auto.source,
      state: auto.state,
      item_key: auto.item_key,
      sku_key: auto.sku_key,
      title: auto.title,
      name_en: auto.name_en,
      price: auto.price,
      currency: auto.currency,
      price_label: auto.price_label,
      captured_on: auto.captured_on,
      item_url: auto.item_url,
      sku_url: auto.sku_url,
      missing: auto.missing,
    },
    {
      source: 'tmall_cn',
      state: 'auto',
      item_key: '693972799714',
      sku_key: '4930331344241',
      title: '拓竹PLA Basic基础 3D打印耗材',
      name_en: 'PLA Basic filament',
      price: '75',
      currency: 'CNY',
      price_label: '优惠前',
      captured_on: '2026-10-31',
      item_url: 'https://detail.tmall.com/item.htm?id=693972799714',
      sku_url: 'https://detail.tmall.com/item.htm?id=693972799714&skuId=4930331344241',
      missing: false,
    }
  );
  assert.deepEqual(auto.options, { 颜色: '红色10200【含料盘】' });
  assert.deepEqual(auto.match_reasons, ['COLOUR_COVERAGE', 'SPOOL_DICT']);
  // The refill: the owner's page price first, then the suggestion — the current capture's price, never the superseded one.
  const refill = p.skus.find((s: Json) => s.combo_key === 'o:v_red|o:v_ref');
  assert.deepEqual(
    refill.supplier_prices.map((l: Json) => [l.source, l.state, l.price, l.currency, l.item_url, l.sku_url]),
    [
      ['store_page', 'manual', '9.9', 'USD', null, null],
      ['tmall_cn', 'suggested', '65', 'CNY', 'https://detail.tmall.com/item.htm?id=693972799714', 'https://detail.tmall.com/item.htm?id=693972799714&skuId=5789497398754'],
    ]
  );

  // The EU store: skr=yes on the item and the variant; a SKU keyed by its SKU code has the item link only; the US store never carries skr.
  const h2d = (await one('p_h2d')).products[0];
  const combo = h2d.skus.find((s: Json) => s.combo_key === 'o:v_combo');
  assert.deepEqual(
    combo.supplier_prices.map((l: Json) => [l.source, l.state, l.price, l.currency, l.captured_on, l.item_url, l.sku_url]),
    [
      ['bambu_eu', 'auto', '1599', 'EUR', '2026-10-30', 'https://eu.store.bambulab.com/products/h2d?skr=yes', 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes'],
      ['bambu_us', 'suggested', '1899', 'USD', '2026-10-29', 'https://us.store.bambulab.com/products/h2d', 'https://us.store.bambulab.com/products/h2d?id=581025672340709385'],
    ]
  );
  const base = h2d.skus.find((s: Json) => s.combo_key === 'o:v_base').supplier_prices[0];
  assert.deepEqual([base.item_url, base.sku_url, base.price], ['https://eu.store.bambulab.com/products/h2d?skr=yes', null, '1399']);
  // A handle with a non-ASCII hyphen: shown as text, never a link.
  const kit = (await one('p_kit')).products[0].skus[0].supplier_prices[0];
  assert.deepEqual([kit.item_key, kit.item_url, kit.sku_url, kit.price], ['usb‑c-soldering-iron-kit', null, null, '39.99']);
  // The owner's confirmation.
  assert.equal((await one('p_cut')).products[0].skus[0].supplier_prices[0].state, 'confirmed');
  // A key missing from the newest capture keeps its links and shows no price.
  const missing = (await one('p_missing')).products[0].skus[0].supplier_prices[0];
  assert.deepEqual(
    [missing.missing, missing.price, missing.price_label, missing.captured_on, missing.item_url, missing.sku_url],
    [true, null, null, null, 'https://detail.tmall.com/item.htm?id=1036834158903', 'https://detail.tmall.com/item.htm?id=1036834158903&skuId=6099999999999']
  );
  // The owner's typed price.
  const typed = (await one('p_manual')).products[0].skus[0].supplier_prices[0];
  assert.deepEqual([typed.source, typed.state, typed.price, typed.currency, typed.note, typed.captured_on], ['typed', 'manual', '12', 'EUR', 'from the invoice', '2026-10-31']);
  // No link: an empty list, with the tokens «تحديث السعر» needs; an invented id the same.
  assert.deepEqual(await one('p_none'), { success: true, products: [], next_cursor: null, versions: { matches: EMPTY_TOKEN, manual: EMPTY_TOKEN } });
  assert.deepEqual((await one('p_rejected')).products, []);
  assert.deepEqual((await one('zz-no-such-id')).products, []);
  assert.deepEqual((await one('bad%20id')).products, []);
});

test('a hostile stored url or evidence_url never appears in any answer; every supplier datum sits under a FINANCIAL_FIELDS key', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  // One request at a time: the test adapter is one SQLite connection (D1 serialises its own).
  const answers = [await get(app, `${BASE}/links`)];
  answers.push(await get(app, `${BASE}/links?cursor=${answers[0]!.body.next_cursor}`));
  answers.push(await get(app, `${BASE}/links?q=QA018`));
  for (const pid of MAIN) answers.push(await get(app, `${BASE}/links/${pid}`));
  answers.push(await get(app, `${BASE}/matches?state=suggested`));
  answers.push(await get(app, `${BASE}/lookup?q=QA018`));
  answers.push(await get(app, `${BASE}/lookup?q=h2d`));
  for (const a of answers) {
    assert.equal(a.status, 200, a.text);
    for (const bad of HOSTILE) assert.ok(!a.text.includes(bad), `${bad} in ${a.text.slice(0, 200)}`);
    // Every link answered is https on a supplier host, built from ids.
    for (const m of a.text.matchAll(/"(?:item_url|sku_url)":"([^"]+)"/g)) assert.match(m[1]!, /^https:\/\/(?:detail\.tmall\.com\/item\.htm\?id=\d+(?:&skuId=\d+)?|(?:eu|us)\.store\.bambulab\.com\/products\/[a-z0-9-]+(?:\?id=\d+(?:&skr=yes)?|\?skr=yes)?)$/);
  }
  // The second net: projected for a non-owner, no supplier datum survives.
  const projected = JSON.stringify(stripFinancials(answers[0]!.body));
  for (const leak of ['supplier_prices', '693972799714', 'tmall', '优惠前', '"75"', 'item_url']) assert.ok(!projected.includes(leak), leak);
  assert.ok(projected.includes('p_pla'), 'the product itself is not a supplier datum');
});

test('a database without 0218 answers an empty list (the banner shows none)', async () => {
  const raw = dbThrough('0217');
  raw.exec("INSERT INTO products (id, slug, name) VALUES ('p_pla', 'pla', 'PLA Basic')");
  const app = appAs(raw, OWNER);
  const list = await get(app, `${BASE}/links?q=PLA`);
  assert.deepEqual([list.status, list.body], [200, { success: true, products: [], next_cursor: null }]);
  const one = await get(app, `${BASE}/links/p_pla`);
  assert.deepEqual([one.status, one.body], [200, { success: true, products: [], next_cursor: null, versions: { matches: EMPTY_TOKEN, manual: EMPTY_TOKEN } }]);
  assert.equal((await get(appAs(raw, FULL), `${BASE}/links`)).status, 403);
});
