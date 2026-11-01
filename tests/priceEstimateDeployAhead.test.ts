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
