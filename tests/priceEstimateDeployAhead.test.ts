/**
 * A WORKER WITH THE ESTIMATE LABEL ON A DATABASE WITHOUT MIGRATION 0218
 * (docs/SMART_PRICING.md §2.4; CLAUDE.md rule 2; WP7).
 *
 * Workflow 7 applies migrations before it deploys, but a manual redeploy, a
 * rollback of the database or Workers Builds re-opened in an emergency can run
 * this code against a database cut before 0218. Every customer reader must
 * then answer EXACTLY as it does on a migrated database with nothing labelled
 * — substitution, not degradation:
 *
 *   - `products.price_estimate` is absent from the row: not labelled, which is
 *     what the column's own default (0) says of every row of a migrated one;
 *   - the overlay's SKU statement carries the firm arm; the old database
 *     refuses it ("no such table: price_estimate_firm_skus"), and the read runs
 *     today's statement — the same rows, the same strict flag, no firm list —
 *     and the binding remembers the absence for a minute, so later reads ask
 *     nothing extra; nothing of it is logged as a fault.
 *
 * The same catalogue is seeded on both databases; the listing, the product
 * page, the quote, the home page, the public API (list and product) and the
 * overlay's views are compared byte for byte.
 *
 * And a Worker with the profit ceiling on a database without migration 0222
 * (DECISIONS row 291, §4.11): the owner's estimator answers as today — the
 * types carry no ceiling (the editor offers no field), compute is byte for
 * byte today's (at the owner's U = 1,600), a type edit without a ceiling
 * works, a ceiling is refused as not installed (503, never a 500), a new type
 * is created and answered without the key, and nothing is logged as a fault.
 *
 * Run: node --import tsx --test tests/priceEstimateDeployAhead.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, asD1, ctx, dbThrough, freshDb, get, hasColumn, post, stubApp } from './fixtures/app';
import { seedLiveCatalog, LIVE_PRODUCTS } from './fixtures/liveCatalog';
import { fetchPublished } from './fixtures/autoPublish';
import { homeRoutes, productRoutes } from '../worker/routes/products';
import { loadRelationsViews } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import { estimateAbsentLately } from '../worker/lib/priceEstimateLabel';
// The profit cap (0222).
import { all, json, put, row, type StubUser } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate } from './fixtures/fx';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';

/** The last migration before the estimate label. */
const BEFORE_ESTIMATES = '0217';

/** A product with two colours, so the overlay has SKU rows and a strict document to read. */
function seedColoured(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, description, price_iqd, status, selling_type, sale_types, stock, inventory_mode, created_at)
      VALUES ('prd_da_colours', 'da-colours', 'Coloured Spool', 'بكرة ملونة', 'بەکرەی ڕەنگاوڕەنگ', '', 25000, 'active', 'direct_sale', '["direct_sale"]', 10, 'COLOR', '2026-09-20T09:00:00.000Z');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
      VALUES ('prd_da_colours_c0', 'prd_da_colours', 'Black', 'أسود', 'ڕەش', '#000000', 0, 1, 4),
             ('prd_da_colours_c1', 'prd_da_colours', 'White', 'أبيض', 'سپی', '#ffffff', 1, 1, 6);
  `);
}

function world(through: string | null) {
  const raw = through === null ? freshDb() : dbThrough(through);
  seedLiveCatalog(raw);
  seedColoured(raw);
  const db = asD1(raw);
  const app = stubApp(db, null, (a) => {
    a.route('/api/products', productRoutes);
    a.route('/api/home', homeRoutes);
  });
  const env = { DB: db, STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const agent = async (path: string) =>
    (await fetchPublished(worker, new Request(`https://${APEX}/api/public/v1${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.72' } }), env, ctx)).text();
  return { raw, db, app, agent };
}

/**
 * An answer as text, its lists of identified items in id order: the home page shuffles some shelves in
 * ten-minute buckets (worker/lib/homeShelves.ts `shuffleSeed`), and the two databases may be read on
 * either side of a bucket's edge. Every other byte is compared as served.
 */
function canonical(text: string): string {
  const sortById = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(sortById);
      const ids = items.every((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string');
      return ids ? [...items].sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id))) : items;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortById(x)]));
    return v;
  };
  try {
    return JSON.stringify(sortById(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** Every customer reader this package touches, as canonical text. */
async function answers(w: ReturnType<typeof world>): Promise<Array<[string, number, string]>> {
  const out: Array<[string, number, string]> = [];
  const read = async (at: string, res: Response) => out.push([at, res.status, canonical(await res.text())]);
  await read('GET /api/products', await get(w.app, '/api/products?limit=50'));
  await read('GET /api/products/:slug (printer)', await get(w.app, `/api/products/${LIVE_PRODUCTS[0].slug}`));
  await read('GET /api/products/:slug (colours)', await get(w.app, '/api/products/da-colours'));
  await read('POST quote (colour)', await post(w.app, '/api/products/da-colours/quote', { qty: 1, colorId: 'prd_da_colours_c1' }));
  await read('POST quote (printer)', await post(w.app, `/api/products/${LIVE_PRODUCTS[0].slug}/quote`, { qty: 1 }));
  await read('GET /api/home', await get(w.app, '/api/home'));
  out.push(['GET /api/public/v1/products', 200, canonical(await w.agent('/products?limit=50'))]);
  out.push(['GET /api/public/v1/products/:slug', 200, canonical(await w.agent('/products/da-colours'))]);
  return out;
}

test('the fixture really is cut before 0218 — otherwise this file proves nothing', () => {
  const old = dbThrough(BEFORE_ESTIMATES);
  assert.equal(hasColumn(old, 'products', 'price_estimate'), false);
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'price_estimate_firm_skus'").get()!.n, 0);
  assert.equal(hasColumn(freshDb(), 'products', 'price_estimate'), true);
});

test('without 0218 every customer reader answers exactly as a migrated database with nothing labelled', async () => {
  const errors: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
  let old: Array<[string, number, string]>;
  let current: Array<[string, number, string]>;
  try {
    old = await answers(world(BEFORE_ESTIMATES));
    current = await answers(world(null));
  } finally {
    console.error = log;
  }
  assert.equal(old.length, current.length);
  for (let i = 0; i < old.length; i++) {
    const [at, status, body] = old[i]!;
    assert.equal(status, 200, `${at} on the old database: ${body.slice(0, 300)}`);
    assert.equal(current[i]![1], 200, `${at} on the migrated database`);
    assert.equal(body, current[i]![2], `${at}: the old database answers exactly as a migrated one with nothing labelled`);
    assert.equal(body.includes('price_estimate'), false, `${at}: no label anywhere`);
  }
  assert.ok(old.some(([, , b]) => b.includes('"price_status":"priced"')), 'not vacuous: products are priced and sold');
  assert.deepEqual(errors.filter((e) => /price_estimate|firm skus/.test(e)), [], 'an absent migration is not a fault: nothing logged');
});

test('without 0218 the overlay reads today’s rows, no firm list, and remembers the absence; a row carries no label', async () => {
  const old = world(BEFORE_ESTIMATES);
  const current = world(null);
  // Published first (the clean start): both databases price the same SKUs.
  await get(old.app, '/api/products');
  await get(current.app, '/api/products');
  const ids = [{ id: 'prd_da_colours' }, { id: LIVE_PRODUCTS[0].id }];
  const [o, c] = [await loadRelationsViews(old.db, ids), await loadRelationsViews(current.db, ids)];
  for (const { id } of ids) {
    assert.deepEqual(o.get(id)!.sku_prices, c.get(id)!.sku_prices, `${id}: the same SKU rows`);
    assert.ok((o.get(id)!.sku_prices ?? []).length > 0, `${id}: rows were read`);
    assert.equal(o.get(id)!.sku_strict, c.get(id)!.sku_strict);
    assert.equal(o.get(id)!.sku_prices_unread, undefined);
    assert.equal(o.get(id)!.sku_firm, undefined);
  }
  assert.equal(estimateAbsentLately(old.db), true, 'the old binding remembers the absence');
  assert.equal(estimateAbsentLately(current.db), false, 'the migrated one never does');
  const row = old.raw.prepare('SELECT * FROM products WHERE id = ?').get('prd_da_colours') as Record<string, unknown>;
  assert.equal('price_estimate' in row, false);
  assert.equal('price_estimate' in parseProductRow(row), false, 'an absent key is not labelled');
});

/* ------------------------------------------------- 0222: the profit cap (DECISIONS row 291, §4.11) -- */

/** The last migration before the profit cap's column (numbers, not names: dbThrough's rule). */
const BEFORE_PROFIT_CAP = '0221';
const CAP_OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const EST = '/api/admin/pricing/estimates';

/** The same owner world on either database: the owner's rate (U = 1,600), a spare part at $6 with no ceiling, its Tmall price, «apply» on. */
function capWorld(through: string | null) {
  const raw = through === null ? freshDb() : dbThrough(through);
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1600');
  applyRate(raw, 'EUR_USD', '1.11');
  applyRate(raw, 'CNY_USD', '0.15');
  raw.exec(`
    UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';
    UPDATE price_estimate_types SET min_profit_usd = '6' WHERE key = 'spare_part';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', '2026-11-05', '${'a'.repeat(64)}', 'complete', 'usr_owner', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES ('p_da_nozzle', 'da-nozzle', 'Nozzle Wiping Plate', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'BASE', 50, 119, 50, 25);
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', 'sp_da_nozzle', 'p_da_nozzle', 'h-da-nozzle', 'https://us.store.bambulab.com/products/h-da-nozzle', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
    INSERT INTO product_price_estimates (product_id, type_key, type_source, updated_at) VALUES ('p_da_nozzle', 'spare_part', 'owner', '2026-11-05T00:00:00.000Z');
    INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '9000000000001', 'item', 'spare_part');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '9000000000001', '90000000000011', '15');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_da_nozzle', '', 'tmall_cn', '9000000000001', '90000000000011', 'exact', 'owner', 'confirmed', 'usr_owner', '2026-11-05T00:00:00.000Z', 'sps_tmall', '2026-11-05T00:00:00.000Z');
  `);
  const app = stubApp(
    asD1(raw),
    CAP_OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(EST, adminPriceEstimatesRoutes);
    },
    { publishV2: false }
  );
  return { raw, app };
}

type CapJson = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('without 0222 the estimator answers as today: no cap offered, compute byte for byte, a cap refused as not installed — nothing logged', async () => {
  const errors: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
  try {
    const old = capWorld(BEFORE_PROFIT_CAP);
    const current = capWorld(null);
    assert.equal(hasColumn(old.raw, 'price_estimate_types', 'profit_cap_pct'), false, 'the fixture really is cut before 0222');
    const typeOf = async (w: ReturnType<typeof capWorld>) => ((await json(await get(w.app, `${EST}/types`))).types as CapJson[]).find((t) => t.key === 'spare_part')!;

    // The type: no cap key on the old database (the editor offers no field), null on the migrated one.
    const [oldType, currentType] = [await typeOf(old), await typeOf(current)];
    assert.equal('profit_cap_pct' in oldType, false);
    assert.equal(currentType.profit_cap_pct, null);
    const { profit_cap_pct: _cap, ...rest } = currentType;
    assert.deepEqual({ ...oldType, updated_at: '' }, { ...rest, updated_at: '' }, 'every other figure as on the migrated database');

    // Compute: the same preview, lines and hash on both — today's estimate, byte for byte.
    const preview = async (w: ReturnType<typeof capWorld>) => {
      const res = await post(w.app, `${EST}/compute`, { product_ids: ['p_da_nozzle'] });
      assert.equal(res.status, 200);
      const p = ((await json(res)).products as CapJson[])[0]!;
      return JSON.stringify({ ...p, computed_at: '' });
    };
    const [a, b] = [await preview(old), await preview(current)];
    assert.equal(a, b);
    assert.match(a, /"est_cost_iqd":3660,"est_price_iqd":13500/, 'today’s price: $6 × 1,600 on a 3,659.5 IQD part');
    const lines = (raw: DatabaseSync) => JSON.stringify(all(raw, 'SELECT combo_key, channel, est_cost_iqd, est_price_iqd, flags_json FROM price_estimate_lines ORDER BY combo_key'));
    assert.equal(lines(old.raw), lines(current.raw));
    const hashOf = (raw: DatabaseSync) => row<{ h: string }>(raw, "SELECT preview_hash AS h FROM product_price_estimates WHERE product_id = 'p_da_nozzle'")!.h;
    assert.equal(hashOf(old.raw), hashOf(current.raw));

    // A type edit without a cap works; a cap is refused as not installed (503), and nothing of it is written.
    const edit = await put(old.app, `${EST}/types/spare_part`, { version: oldType.version, min_profit_usd: '6.5' });
    const edited = await json(edit);
    assert.equal(edit.status, 200, JSON.stringify(edited));
    assert.equal(edited.type.min_profit_usd, '6.5');
    const capped = await put(old.app, `${EST}/types/spare_part`, { version: edited.type.version, profit_cap_pct: '25' });
    const refused = await json(capped);
    assert.deepEqual([capped.status, refused.code, refused.details?.field], [503, 'PRICE_ESTIMATES_NOT_INSTALLED', 'profit_cap_pct']);
    assert.equal(row<{ v: number }>(old.raw, "SELECT version AS v FROM price_estimate_types WHERE key = 'spare_part'")!.v, edited.type.version, 'nothing written');
    // A new type works too, answered without the cap key (the editor offers no field); the migrated one answers null.
    const resin = { key: 'resin', name_ar: 'راتنج', name_en: 'Resin', name_ckb: 'ڕێزن', sourcing: 'CHINA_CNY', route: 'sea' };
    const [madeOld, madeCurrent] = [await post(old.app, `${EST}/types`, resin), await post(current.app, `${EST}/types`, resin)];
    const [oldBody, currentBody] = [await json(madeOld), await json(madeCurrent)];
    assert.deepEqual([madeOld.status, madeCurrent.status], [201, 201], JSON.stringify(oldBody));
    assert.deepEqual(['profit_cap_pct' in oldBody.type, currentBody.type.profit_cap_pct], [false, null]);
  } finally {
    console.error = log;
  }
  assert.deepEqual(errors.filter((e) => /profit_cap|no such column/i.test(e)), [], 'an absent column is not a fault: nothing logged');
});
