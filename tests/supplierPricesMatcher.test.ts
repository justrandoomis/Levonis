/**
 * PAGED SUPPLIER MATCHING ON THE DATABASE (docs/SMART_PRICING.md §3.5, §3.6,
 * §3.7; migration 0218; WP5).
 *
 *   - a page of products, read the way the import wrote them (option groups
 *     with kinds, external ids, the store handle), matched against the real
 *     Tmall and EU captures: exact and high matches confirmed automatically,
 *     the rest suggested, a type the owner chose refusing the other sourcing;
 *   - a re-run is idempotent: confirmations are carried, suggestions replaced,
 *     a pairing the owner rejected never comes back;
 *   - the owner confirms, re-points (dividing a pack) and rejects, version-fenced;
 *   - a match whose combo key is no longer sellable is pruned;
 *   - a confirmed key missing from the newest capture is flagged (and an
 *     automatic one gives way to a new automatic one);
 *   - §3.7: the price each SKU uses, rung by rung, with its flags;
 *   - every statement within D1's limits.
 *
 * Run: node --import tsx --test tests/supplierPricesMatcher.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, count, ctx, dbThrough, freshDb, row, stubApp } from './fixtures/app';
import { fixtureText } from './fixtures/supplierPrices/load';
import { limitD1, violations } from './fixtures/d1Limits';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { EMPTY_TOKEN, supplierCategories, supplierPricesFor, versionTokens } from '../worker/lib/supplierPrices/store';
import { decideMatches, runMatchPage } from '../worker/lib/supplierPrices/matcher';
import { completeSnapshot, createSnapshot, uploadItems } from '../worker/lib/supplierPrices/upload';
import { lookupCatalogue, parseSupplierQuery } from '../worker/lib/supplierPrices/lookup';
import { linksPage, productLinks } from '../worker/lib/supplierPrices/links';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type App = ReturnType<typeof stubApp>;

const BASE = '/api/admin/pricing/supplier-prices';
const appOf = (raw: DatabaseSync): App =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route(BASE, adminSupplierPricesRoutes);
  });

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
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json, text };
}

interface V1File {
  source: string;
  currency: string;
  price_basis: string;
  capture: string;
  captured_on: string;
  captured_by: string;
  items: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const tmall = (): V1File => JSON.parse(fixtureText('tmall-2026-10-31.v1.json')) as V1File;
const eu = (): V1File => JSON.parse(fixtureText('eu-2026-10-31.v1.json')) as V1File;

async function upload(app: App, file: V1File): Promise<string> {
  const text = JSON.stringify(file);
  const sha = createHash('sha256').update(text).digest('hex');
  const { source, currency, price_basis, capture, captured_on, captured_by } = file;
  const created = await req(app, 'POST', `${BASE}/snapshots`, { source, currency, price_basis, capture, captured_on, captured_by, file_sha256: sha, item_count: file.items.length });
  assert.equal(created.status, 201, created.text);
  const id = created.body.snapshot.id as string;
  for (let i = 0; i < file.items.length; i += 10) assert.equal((await req(app, 'POST', `${BASE}/snapshots/${id}/items`, { items: file.items.slice(i, i + 10), offset: i })).status, 200);
  const skus = file.items.reduce((n, it) => n + it.skus.length, 0);
  const done = await req(app, 'POST', `${BASE}/snapshots/${id}/complete`, { item_count: file.items.length, sku_count: skus, file_sha256: sha });
  assert.equal(done.status, 200, done.text);
  return id;
}

const REF = (pid: string, handle: string, n: number) => `
  INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
  VALUES ('bambu_us', '${7000 + n}', '${pid}', '${handle}', 'https://us.store.bambulab.com/products/${handle}', 'created', 'not_configured', 'f', '2026-10-30T00:00:00Z', 'cir_test');`;

/** Products as the Bambu import writes them (groups with kinds, external ids, the store handle), and two it did not. */
function seed(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku) VALUES ('p_pla', 'pla-basic', 'PLA Basic', 'بي إل إيه بيسك', 'پی ئێڵ ئەی بەیسیک');
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES
      ('g_col', 'p_pla', 'Colour', 'color', 0, 1), ('g_spl', 'p_pla', 'Spool', 'spool', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES
      ('v_red', 'p_pla', 'g_col', 'Red', 'أحمر', 'سوور', 0, 1),
      ('v_blk', 'p_pla', 'g_col', 'Black (10101)', 'أسود', 'ڕەش', 1, 1),
      ('v_spl', 'p_pla', 'g_spl', 'Filament with spool', 'مع بكرة', 'لەگەڵ بەکرە', 0, 1),
      ('v_ref', 'p_pla', 'g_spl', 'Refill', 'عبوة بلا بكرة', 'بێ بەکرە', 1, 1);
    -- The import keeps a colour's code apart from its name.
    INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value) VALUES ('p_pla', 'option_value', 'v_red', 'color_code', '10200');
    ${REF('p_pla', 'pla-basic-filament', 1)}

    INSERT INTO products (id, slug, name) VALUES ('p_cut', 'flush-cutters', 'Flush Cutters');
    INSERT INTO product_variants (id, product_id, combo_key) VALUES ('pv_cut', 'p_cut', '');
    INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value) VALUES ('p_cut', 'variant', 'pv_cut', 'bambu_sku_code', 'B-QA018');
    ${REF('p_cut', 'flush-cutters', 2)}

    INSERT INTO products (id, slug, name) VALUES ('p_buf', 'filament-buffer', 'Filament Buffer');
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES ('g_buf', 'p_buf', 'Compatibility', 'other', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v_buf', 'p_buf', 'g_buf', 'X1 Series and P1 Series', 0, 1);
    INSERT INTO product_variants (id, product_id, combo_key) VALUES ('pv_buf', 'p_buf', 'o:v_buf');
    -- The US store's variant id: never the EU store's (its ids are its own).
    INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value) VALUES ('p_buf', 'variant', 'pv_buf', 'bambu_variant_id', '40922942079112');
    ${REF('p_buf', 'filament-buffer', 3)}

    INSERT INTO products (id, slug, name) VALUES ('p_fan', 'hotend-fan-x2d', 'Hotend Cooling Fan - X2D');
    ${REF('p_fan', 'hotend-cooling-fan-x2d', 4)}

    -- Enrolled by the owner with a China type: the EU-sourced Tmall listing is refused (TYPE_MISMATCH).
    INSERT INTO products (id, slug, name) VALUES ('p_fan_owner', 'hotend-fan-x2d-2', 'Hotend Cooling Fan - X2D');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, state, updated_at) VALUES ('p_fan_owner', 'spare_part', 'owner', 'candidate', '2026-10-31T00:00:00Z');

    -- Neither imported nor enrolled: never matched.
    INSERT INTO products (id, slug, name) VALUES ('p_plain', 'plain', 'Flush Cutters');
  `);
}

const RED_SPOOL = 'o:v_red|o:v_spl';
const RED_REFILL = 'o:v_red|o:v_ref';
const BLACK_SPOOL = 'o:v_blk|o:v_spl';
const BLACK_REFILL = 'o:v_blk|o:v_ref';

const matchesOf = (raw: DatabaseSync, pid: string) =>
  all<Json>(raw, 'SELECT combo_key, source, item_key, sku_key, state, confidence, decided_by, units_per_offer FROM supplier_price_matches WHERE product_id = ? ORDER BY combo_key, source, item_key, sku_key', pid);

async function world() {
  const raw = freshDb();
  seed(raw);
  const app = appOf(raw);
  const tmallId = await upload(app, tmall());
  const euId = await upload(app, eu());
  return { raw, app, tmallId, euId };
}

test('a page of imported products: exact and high matches confirmed automatically, the rest suggested, the owner’s type refusing the other sourcing', async () => {
  const { raw, app, tmallId, euId } = await world();
  const r = await req(app, 'POST', `${BASE}/match`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    r.body.products.map((p: Json) => p.product_id),
    ['p_buf', 'p_cut', 'p_fan', 'p_fan_owner', 'p_pla'],
    'imported or enrolled products only, by id'
  );
  assert.equal(r.body.next_cursor, null);

  // Flush cutters: the import's SKU code B-QA018 against the Tmall listing's QA018 — exact.
  assert.deepEqual(matchesOf(raw, 'p_cut'), [
    { combo_key: '', source: 'tmall_cn', item_key: '1036834158903', sku_key: '6054830021130', state: 'confirmed', confidence: 'exact', decided_by: 'auto', units_per_offer: 1 },
  ]);
  // PLA Basic: colour codes (one from the import's external id, one from the name) and the spool dictionary — high.
  assert.deepEqual(
    matchesOf(raw, 'p_pla').map((m) => [m.combo_key, m.sku_key, m.state, m.confidence, m.decided_by]),
    [
      [BLACK_REFILL, '5789497398755', 'confirmed', 'high', 'auto'],
      [BLACK_SPOOL, '4930331344242', 'confirmed', 'high', 'auto'],
      [RED_REFILL, '5789497398754', 'confirmed', 'high', 'auto'],
      [RED_SPOOL, '4930331344241', 'confirmed', 'high', 'auto'],
    ]
  );
  assert.ok(matchesOf(raw, 'p_pla').every((m) => m.item_key === '693972799714'), 'never the 10-pack (PACK_MISMATCH)');
  // The filament buffer on the EU store by its handle and English labels — high; the EU id is the store's own.
  assert.deepEqual(matchesOf(raw, 'p_buf'), [
    { combo_key: 'o:v_buf', source: 'bambu_eu', item_key: 'filament-buffer', sku_key: '43719762903259', state: 'confirmed', confidence: 'high', decided_by: 'auto', units_per_offer: 1 },
  ]);
  // A name and a model only: medium, the owner's to confirm.
  assert.deepEqual(matchesOf(raw, 'p_fan'), [
    { combo_key: '', source: 'tmall_cn', item_key: '1036813526277', sku_key: '6219554715476', state: 'suggested', confidence: 'medium', decided_by: '', units_per_offer: 1 },
  ]);
  assert.deepEqual(matchesOf(raw, 'p_fan_owner'), [], 'the owner chose a China type: the EU-sourced listing is refused');
  assert.deepEqual(matchesOf(raw, 'p_plain'), []);
  const found = row<Json>(raw, "SELECT found_in_snapshot, reasons_json, method FROM supplier_price_matches WHERE product_id = 'p_cut'")!;
  assert.equal(found.found_in_snapshot, tmallId);
  assert.ok(JSON.parse(found.reasons_json).includes('CODE_EQUAL'));
  assert.equal(row<Json>(raw, "SELECT found_in_snapshot FROM supplier_price_matches WHERE product_id = 'p_buf'")!.found_in_snapshot, euId);

  const summary = Object.fromEntries(r.body.products.map((p: Json) => [p.product_id, [p.confirmed, p.suggested, p.carried, p.pruned, p.missing.length]]));
  assert.deepEqual(summary, { p_buf: [1, 0, 0, 0, 0], p_cut: [1, 0, 0, 0, 0], p_fan: [0, 1, 0, 0, 0], p_fan_owner: [0, 0, 0, 0, 0], p_pla: [4, 0, 0, 0, 0] });
  // A refused pairing maps no SKU, so it has no row: the run tells the owner why.
  const refusedOf = (pid: string) => r.body.products.find((p: Json) => p.product_id === pid).refused as Json[];
  assert.ok(refusedOf('p_fan_owner').some((x) => x.item_key === '1036813526277' && x.reason === 'TYPE_MISMATCH'), JSON.stringify(refusedOf('p_fan_owner')));
  assert.ok(refusedOf('p_pla').some((x) => x.item_key === '1001036512689' && x.reason === 'PACK_MISMATCH'), 'the 10-pack against single spools');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM supplier_price_matches WHERE item_key = '1001036512689'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier_prices.match_run'"), 1);

  // The review: the auto-confirmed products listed for the owner's audit, the suggestions apart.
  const auto = await req(app, 'GET', `${BASE}/matches?state=auto`);
  assert.deepEqual(auto.body.products.map((p: Json) => p.product_id), ['p_buf', 'p_cut', 'p_pla']);
  const cutLink = auto.body.products.find((p: Json) => p.product_id === 'p_cut').skus[0].supplier_prices[0];
  assert.deepEqual([cutLink.state, cutLink.match_confidence, cutLink.price, cutLink.price_label], ['auto', 'exact', '75', '优惠前']);
  assert.ok(cutLink.codes.includes('QA018'), 'the codes the capture read are shown beside the price');
  const suggested = await req(app, 'GET', `${BASE}/matches?state=suggested`);
  assert.deepEqual(suggested.body.products.map((p: Json) => p.product_id), ['p_fan']);
  const fanLink = suggested.body.products[0].skus[0].supplier_prices[0];
  assert.deepEqual(
    [fanLink.state, fanLink.price, fanLink.currency, fanLink.match_confidence, fanLink.item_url],
    ['suggested', '65', 'CNY', 'medium', 'https://detail.tmall.com/item.htm?id=1036813526277']
  );
  assert.equal((await req(app, 'GET', `${BASE}/matches?state=nope`)).status, 400);

  // Paging by cursor: the page after p_cut starts at p_fan.
  const after = await req(app, 'POST', `${BASE}/match`, { cursor: 'p_cut' });
  assert.deepEqual(after.body.products.map((p: Json) => p.product_id), ['p_fan', 'p_fan_owner', 'p_pla']);
  const named = await req(app, 'POST', `${BASE}/match`, { product_ids: ['p_cut'] });
  assert.deepEqual(named.body.products.map((p: Json) => p.product_id), ['p_cut']);
  assert.equal((await req(app, 'POST', `${BASE}/match`, { product_ids: [] })).status, 400);
});

test('a re-run carries every confirmation and replaces the suggestions; the owner confirms, re-points with a pack division and rejects — version-fenced', async () => {
  const { raw, app } = await world();
  await req(app, 'POST', `${BASE}/match`, {});
  const before = all<Json>(raw, 'SELECT * FROM supplier_price_matches ORDER BY product_id, combo_key, source');
  const again = await req(app, 'POST', `${BASE}/match`, {});
  const pla = again.body.products.find((p: Json) => p.product_id === 'p_pla');
  assert.deepEqual([pla.confirmed, pla.carried], [0, 4], 'confirmations are carried as they are');
  const after = all<Json>(raw, 'SELECT * FROM supplier_price_matches ORDER BY product_id, combo_key, source');
  assert.deepEqual(
    after.filter((m) => m.state === 'confirmed'),
    before.filter((m) => m.state === 'confirmed'),
    'a confirmed row is untouched by a re-run'
  );
  assert.equal(after.length, before.length);

  // The owner rejects the fan's suggestion: it never comes back.
  const tokens = async (pid: string) => (await versionTokens(asD1(raw), [pid])).get(pid)!.matches;
  const reject = await req(app, 'PUT', `${BASE}/matches/p_fan`, { version: await tokens('p_fan'), skus: [{ combo_key: '', source: 'tmall_cn', item_key: '1036813526277', sku_key: null }] });
  assert.equal(reject.status, 200, reject.text);
  assert.deepEqual(matchesOf(raw, 'p_fan').map((m) => [m.state, m.decided_by]), [['rejected', OWNER.id]]);
  await req(app, 'POST', `${BASE}/match`, {});
  assert.deepEqual(matchesOf(raw, 'p_fan').map((m) => m.state), ['rejected'], 'a pairing the owner rejected is not suggested again');

  // The owner re-points red refill to another SKU and divides it (a pack of two): the automatic pairing becomes his rejection.
  const stale = await tokens('p_pla');
  const repoint = await req(app, 'PUT', `${BASE}/matches/p_pla`, {
    version: stale,
    skus: [{ combo_key: RED_REFILL, source: 'tmall_cn', item_key: '693972799714', sku_key: '5789497398755', units_per_offer: 2 }],
  });
  assert.equal(repoint.status, 200, repoint.text);
  assert.deepEqual(
    matchesOf(raw, 'p_pla')
      .filter((m) => m.combo_key === RED_REFILL)
      .map((m) => [m.sku_key, m.state, m.decided_by, m.units_per_offer, m.confidence]),
    [
      ['5789497398754', 'rejected', OWNER.id, 1, 'high'],
      ['5789497398755', 'confirmed', OWNER.id, 2, 'exact'],
    ]
  );
  const view = repoint.body.product.skus.find((s: Json) => s.combo_key === RED_REFILL);
  assert.deepEqual(
    view.supplier_prices.map((l: Json) => [l.state, l.sku_key, l.units_per_offer]),
    [
      ['confirmed', '5789497398755', 2],
      ['rejected', '5789497398754', 1],
    ]
  );
  // The token he read is spent.
  const refused = await req(app, 'PUT', `${BASE}/matches/p_pla`, { version: stale, skus: [{ combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: null }] });
  assert.deepEqual([refused.status, refused.body.code], [409, 'PRICING_CHANGED']);
  // A re-run leaves the owner's work alone.
  await req(app, 'POST', `${BASE}/match`, {});
  assert.deepEqual(
    matchesOf(raw, 'p_pla').filter((m) => m.combo_key === RED_REFILL).map((m) => [m.sku_key, m.state, m.units_per_offer]),
    [
      ['5789497398754', 'rejected', 1],
      ['5789497398755', 'confirmed', 2],
    ]
  );

  // Refusals name a field; nothing is written.
  const token = await tokens('p_pla');
  const rows = count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_matches');
  for (const [sku, field] of [
    [{ combo_key: 'o:v_red', source: 'tmall_cn', item_key: '693972799714', sku_key: '4930331344241' }, 'combo_key'],
    [{ combo_key: RED_SPOOL, source: 'taobao', item_key: '693972799714', sku_key: '4930331344241' }, 'source'],
    [{ combo_key: RED_SPOOL, source: 'tmall_cn', item_key: 'not-digits', sku_key: '4930331344241' }, 'item_key'],
    [{ combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: '9999999999999' }, 'sku_key'],
    [{ combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: '4930331344241', units_per_offer: 0 }, 'units_per_offer'],
    [{ combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: null, units_per_offer: 2 }, 'units_per_offer'],
  ] as const) {
    const r = await req(app, 'PUT', `${BASE}/matches/p_pla`, { version: token, skus: [sku] });
    assert.deepEqual([r.status, r.body.code, r.body.details], [400, 'PRICING_INPUT_INVALID', { field }], JSON.stringify(sku));
  }
  const twice = await req(app, 'PUT', `${BASE}/matches/p_pla`, {
    version: token,
    skus: [
      { combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: null },
      { combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: '4930331344241' },
    ],
  });
  assert.deepEqual([twice.status, twice.body.details], [400, { field: 'skus' }]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_matches'), rows);
  assert.equal((await req(app, 'PUT', `${BASE}/matches/zz-no-such-id`, { version: EMPTY_TOKEN, skus: [] })).status, 404);
  // The audit names counts only.
  for (const a of all<Json>(raw, "SELECT detail FROM audit_log WHERE action = 'supplier_prices.match_decide'")) assert.deepEqual(Object.keys(JSON.parse(String(a.detail))).sort(), ['confirmed', 'divided', 'rejected']);
});

test('a match whose combo key is no longer sellable is pruned by the next run, the owner’s too', async () => {
  const { raw, app } = await world();
  await req(app, 'POST', `${BASE}/match`, {});
  const token = (await versionTokens(asD1(raw), ['p_pla'])).get('p_pla')!.matches;
  await req(app, 'PUT', `${BASE}/matches/p_pla`, { version: token, skus: [{ combo_key: RED_REFILL, source: 'tmall_cn', item_key: '693972799714', sku_key: '5789497398754', units_per_offer: 2 }] });
  const refillRows = count(raw, "SELECT COUNT(*) AS n FROM supplier_price_matches WHERE product_id = 'p_pla' AND combo_key LIKE '%v_ref%'");
  assert.equal(refillRows, 2);
  // The owner stops selling refills.
  raw.exec("UPDATE product_option_values SET active = 0 WHERE id = 'v_ref'");
  const r = await req(app, 'POST', `${BASE}/match`, { product_ids: ['p_pla'] });
  assert.equal(r.body.products[0].pruned, refillRows);
  assert.deepEqual(
    matchesOf(raw, 'p_pla').map((m) => m.combo_key),
    [BLACK_SPOOL, RED_SPOOL]
  );
});

test('a confirmed key missing from the newest capture is flagged and keeps its link; an automatic one gives way to a new automatic one', async () => {
  const { raw, app } = await world();
  await req(app, 'POST', `${BASE}/match`, {});
  // A new capture without the flush cutters (the listing was withdrawn).
  const withdrawn = tmall();
  withdrawn.items = withdrawn.items.filter((i) => i.item_key !== '1036834158903');
  withdrawn.captured_on = '2026-11-15';
  await upload(app, withdrawn);
  const r = await req(app, 'POST', `${BASE}/match`, { product_ids: ['p_cut', 'p_pla'] });
  const cut = r.body.products.find((p: Json) => p.product_id === 'p_cut');
  assert.deepEqual(cut.missing, [{ combo_key: '', source: 'tmall_cn', item_key: '1036834158903', sku_key: '6054830021130' }]);
  assert.equal(cut.carried, 1);
  assert.deepEqual(r.body.products.find((p: Json) => p.product_id === 'p_pla').missing, [], 'PLA Basic re-attaches to the new capture');
  const missing = await req(app, 'GET', `${BASE}/matches?state=missing`);
  assert.deepEqual(missing.body.products.map((p: Json) => p.product_id), ['p_cut']);
  const link = missing.body.products[0].skus[0].supplier_prices[0];
  assert.deepEqual(
    [link.missing, link.price, link.item_url, link.sku_url],
    [true, null, 'https://detail.tmall.com/item.htm?id=1036834158903', 'https://detail.tmall.com/item.htm?id=1036834158903&skuId=6054830021130']
  );
  const priced = await supplierPricesFor(asD1(raw), [{ product_id: 'p_cut', combo_keys: [''], sourcing: 'CHINA_CNY', us_reference_allowed: false }]);
  assert.deepEqual(priced.get('p_cut')!.get('')!.flags, ['EST_SOURCE_ITEM_MISSING', 'EST_NO_PRICE']);

  // The listing comes back under a new id, out of stock: the automatic confirmation moves to it.
  const relisted = tmall();
  const cutters = relisted.items.find((i) => i.item_key === '1036834158903')!;
  cutters.item_key = '1099999999999';
  cutters.url = 'https://detail.tmall.com/item.htm?id=1099999999999';
  cutters.skus[0].sku_key = '6099999999999';
  cutters.skus[0].quantity = 0;
  await upload(app, relisted);
  const moved = await req(app, 'POST', `${BASE}/match`, { product_ids: ['p_cut'] });
  assert.deepEqual([moved.body.products[0].confirmed, moved.body.products[0].missing], [1, []]);
  assert.deepEqual(matchesOf(raw, 'p_cut').map((m) => [m.item_key, m.sku_key, m.state, m.decided_by]), [['1099999999999', '6099999999999', 'confirmed', 'auto']]);
  const now = await supplierPricesFor(asD1(raw), [{ product_id: 'p_cut', combo_keys: [''], sourcing: 'CHINA_CNY', us_reference_allowed: false }]);
  assert.deepEqual([now.get('p_cut')!.get('')!.amount, now.get('p_cut')!.get('')!.flags], ['75', ['EST_SUPPLIER_OUT_OF_STOCK']]);
});

test('§3.7: the owner’s price first, then the confirmed match of the type’s source, then the US reference where allowed — never a sibling, never a suggestion', async () => {
  const { raw, app } = await world();
  await req(app, 'POST', `${BASE}/match`, {});
  // A US reference capture of the filament buffer, confirmed by the owner.
  await upload(app, {
    source: 'bambu_us',
    currency: 'USD',
    price_basis: 'list',
    capture: 'store_script',
    captured_on: '2026-10-31',
    captured_by: 'store script',
    items: [{ item_key: 'filament-buffer', title: 'Filament Buffer', name_en: 'Filament Buffer', skus: [{ sku_key: '40922942079112', options: { option1: 'X1 Series and P1 Series' }, price: '19.99' }] }],
  });
  const db = asD1(raw);
  const token = async (pid: string) => (await versionTokens(db, [pid])).get(pid)!;
  await decideMatches(db, 'p_buf', { version: (await token('p_buf')).matches, skus: [{ combo_key: 'o:v_buf', source: 'bambu_us', item_key: 'filament-buffer', sku_key: '40922942079112' }] }, OWNER.id, new Date());
  await decideMatches(db, 'p_pla', { version: (await token('p_pla')).matches, skus: [{ combo_key: BLACK_REFILL, source: 'tmall_cn', item_key: '693972799714', sku_key: '5789497398755', units_per_offer: 3 }] }, OWNER.id, new Date());
  await req(app, 'PUT', `${BASE}/manual/p_pla`, { version: (await token('p_pla')).manual, skus: [{ combo_key: RED_SPOOL, amount: '12.5', currency: 'USD' }] });

  const prices = await supplierPricesFor(
    db,
    [
      { product_id: 'p_pla', combo_keys: [RED_SPOOL, RED_REFILL, BLACK_REFILL], sourcing: 'CHINA_CNY', us_reference_allowed: false, stale_after_days: 30 },
      { product_id: 'p_buf', combo_keys: ['o:v_buf'], sourcing: 'EU_STORE_EUR', us_reference_allowed: true },
      { product_id: 'p_fan', combo_keys: [''], sourcing: 'CHINA_CNY', us_reference_allowed: false },
      { product_id: 'p_cut', combo_keys: ['', 'o:not-a-sku'], sourcing: 'EU_STORE_EUR', us_reference_allowed: false },
    ],
    { today: '2026-11-05' }
  );
  const pick = (pid: string, combo: string) => {
    const p = prices.get(pid)!.get(combo)!;
    return [p.price_source, p.amount, p.currency, p.flags];
  };
  assert.deepEqual(pick('p_pla', RED_SPOOL), ['typed', '12.5', 'USD', ['EST_MANUAL_PRICE']]);
  assert.deepEqual(pick('p_pla', RED_REFILL), ['tmall_cn', '65', 'CNY', []]);
  assert.deepEqual(pick('p_pla', BLACK_REFILL), ['tmall_cn', '21.6667', 'CNY', ['EST_UNITS_DIVIDED']], 'the owner divided a pack of three: rounded up, never down');
  assert.equal(prices.get('p_pla')!.get(BLACK_REFILL)!.offer_amount, '65');
  assert.deepEqual(pick('p_buf', 'o:v_buf'), ['bambu_eu', '27.99', 'EUR', []], 'the EU store before the US reference');
  // Only a suggestion: no price, and the owner is asked to review it.
  assert.deepEqual(pick('p_fan', ''), ['none', null, null, ['EST_MATCH_REVIEW']]);
  assert.deepEqual(prices.get('p_fan')!.get('')!.suggestion, { source: 'tmall_cn', item_key: '1036813526277', sku_key: '6219554715476', amount: '65', currency: 'CNY' });
  // A Tmall match never prices an EU-sourced product; nothing is inferred for an unknown SKU.
  assert.deepEqual(pick('p_cut', ''), ['none', null, null, ['EST_NO_PRICE']]);
  assert.deepEqual(pick('p_cut', 'o:not-a-sku'), ['none', null, null, ['EST_NO_PRICE']]);

  // Without the EU confirmation the US reference prices the EU type that allows it — flagged — and nothing otherwise.
  await decideMatches(db, 'p_buf', { version: (await token('p_buf')).matches, skus: [{ combo_key: 'o:v_buf', source: 'bambu_eu', item_key: 'filament-buffer', sku_key: null }] }, OWNER.id, new Date());
  const us = await supplierPricesFor(db, [{ product_id: 'p_buf', combo_keys: ['o:v_buf'], sourcing: 'EU_STORE_EUR', us_reference_allowed: true }]);
  assert.deepEqual([us.get('p_buf')!.get('o:v_buf')!.price_source, us.get('p_buf')!.get('o:v_buf')!.amount, us.get('p_buf')!.get('o:v_buf')!.flags], ['bambu_us', '19.99', ['EST_US_REFERENCE']]);
  const noUs = await supplierPricesFor(db, [{ product_id: 'p_buf', combo_keys: ['o:v_buf'], sourcing: 'EU_STORE_EUR', us_reference_allowed: false }]);
  assert.deepEqual(noUs.get('p_buf')!.get('o:v_buf')!.flags, ['EST_NO_PRICE']);

  // A capture older than the type's staleness is flagged.
  const stale = await supplierPricesFor(db, [{ product_id: 'p_pla', combo_keys: [RED_REFILL], sourcing: 'CHINA_CNY', us_reference_allowed: false, stale_after_days: 30 }], { today: '2027-01-15' });
  assert.deepEqual(stale.get('p_pla')!.get(RED_REFILL)!.flags, ['EST_SNAPSHOT_STALE']);

  // The confirmed Tmall match's category (§3.8 supplier_category).
  assert.deepEqual([...(await supplierCategories(db, ['p_pla', 'p_buf', 'p_fan']))], [['p_pla', 'filament']]);

  // A database without 0218: no supplier price, no error.
  const old = await supplierPricesFor(asD1(dbThrough('0217')), [{ product_id: 'p_pla', combo_keys: [RED_SPOOL], sourcing: 'CHINA_CNY', us_reference_allowed: false }]);
  assert.deepEqual(old.get('p_pla')!.get(RED_SPOOL)!.flags, ['EST_NO_PRICE']);
});

test('a Tmall listing without options: its one SKU, keyed by the item id, is suggested, confirmed and priced like any other', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO products (id, slug, name) VALUES ('p_cover', 'display-rear-housing', 'Display Rear Housing with Hinge - X1 Series');
    ${REF('p_cover', 'display-rear-housing-with-hinge-x1-series', 5)}
    -- The same part in two colours: one offer cannot tell them apart.
    INSERT INTO products (id, slug, name) VALUES ('p_cover2', 'display-rear-housing-2', 'Display Rear Housing with Hinge - X1 Series');
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES ('g_cc', 'p_cover2', 'Colour', 'color', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v_cb', 'p_cover2', 'g_cc', 'Black', 0, 1), ('v_cw', 'p_cover2', 'g_cc', 'White', 1, 1);
    ${REF('p_cover2', 'display-rear-housing-with-hinge-x1-series-2', 6)}
  `);
  const app = appOf(raw);
  // The real listing as normalize-tmall.mjs writes it (2026-10-31 capture); the price is not the capture's.
  await upload(app, {
    ...tmall(),
    items: [
      {
        item_key: '966154880524',
        url: 'https://detail.tmall.com/item.htm?id=966154880524',
        title: '拓竹 显示屏后盖（含转轴）【X1系列适用】 3D打印机配件',
        name_en: 'Display rear cover (with hinge) — X1 series',
        category: 'spare_part',
        sourcing: 'CHINA_CNY',
        freight_route: 'CHINA_SEA_OR_AIR',
        codes: [],
        props: [],
        skus: [{ sku_key: '966154880524', options: {}, options_en: {}, price: '11', price_label: '', quantity: null, sku_code: '' }],
      },
    ],
  });
  const r = await req(app, 'POST', `${BASE}/match`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(matchesOf(raw, 'p_cover'), [
    { combo_key: '', source: 'tmall_cn', item_key: '966154880524', sku_key: '966154880524', state: 'suggested', confidence: 'medium', decided_by: '', units_per_offer: 1 },
  ]);
  assert.deepEqual(matchesOf(raw, 'p_cover2'), [], 'two SKUs on one offer: nothing paired');
  const link = (await req(app, 'GET', `${BASE}/matches?state=suggested`)).body.products.find((p: Json) => p.product_id === 'p_cover').skus[0].supplier_prices[0];
  assert.deepEqual([link.sku_key, link.price, link.item_url, link.sku_url], ['966154880524', '11', 'https://detail.tmall.com/item.htm?id=966154880524', 'https://detail.tmall.com/item.htm?id=966154880524']);

  // The owner confirms it; the estimate prices from it.
  const version = (await versionTokens(asD1(raw), ['p_cover'])).get('p_cover')!.matches;
  const done = await req(app, 'PUT', `${BASE}/matches/p_cover`, { version, skus: [{ combo_key: '', source: 'tmall_cn', item_key: '966154880524', sku_key: '966154880524' }] });
  assert.equal(done.status, 200, done.text);
  const priced = (await supplierPricesFor(asD1(raw), [{ product_id: 'p_cover', combo_keys: [''], sourcing: 'CHINA_CNY', us_reference_allowed: false }])).get('p_cover')!.get('')!;
  assert.deepEqual([priced.price_source, priced.amount, priced.currency, priced.item_key, priced.sku_key, priced.flags], ['tmall_cn', '11', 'CNY', '966154880524', '966154880524', []]);
});

test('every statement of the upload, matching, decisions, lookup, links and pricing stays within D1’s limits', async () => {
  const raw = freshDb();
  seed(raw);
  violations.length = 0;
  const db = limitD1(raw);
  const now = new Date('2026-10-31T10:00:00Z');
  for (const file of [tmall(), eu()]) {
    const text = JSON.stringify(file);
    const sha = createHash('sha256').update(text).digest('hex');
    const { source, currency, price_basis, capture, captured_on, captured_by } = file;
    const snap = await createSnapshot(db, { source, currency, price_basis, capture, captured_on, captured_by, file_sha256: sha, item_count: file.items.length }, OWNER.id, now);
    for (let i = 0; i < file.items.length; i += 50) await uploadItems(db, snap.id, JSON.stringify({ items: file.items.slice(i, i + 50), offset: i }));
    await completeSnapshot(db, snap.id, { item_count: file.items.length, sku_count: file.items.reduce((n, it) => n + it.skus.length, 0), file_sha256: sha }, OWNER.id, now);
  }
  const page = await runMatchPage(db, {}, OWNER.id, now);
  assert.equal(page.products.length, 5);
  const token = (await versionTokens(db, ['p_pla'])).get('p_pla')!.matches;
  await decideMatches(db, 'p_pla', { version: token, skus: [{ combo_key: RED_SPOOL, source: 'tmall_cn', item_key: '693972799714', sku_key: '4930331344241', units_per_offer: 2 }] }, OWNER.id, now);
  for (const q of ['10200', 'QA018', 'PLA Basic', 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329', 'filament-buffer', '1036834158903']) await lookupCatalogue(db, parseSupplierQuery(q));
  for (const q of [undefined, '10200', 'QA018', 'PLA', 'https://detail.tmall.com/item.htm?id=693972799714', 'filament-buffer']) await linksPage(db, { q });
  await productLinks(db, 'p_pla');
  await supplierPricesFor(db, [{ product_id: 'p_pla', combo_keys: [RED_SPOOL, RED_REFILL], sourcing: 'CHINA_CNY', us_reference_allowed: false }]);
  assert.deepEqual(violations, []);
});
