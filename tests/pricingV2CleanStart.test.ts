/**
 * THE CLEAN START, END TO END (spec addendum A.12.4; DECISIONS row 222).
 *
 *   1. after 0190 every pre-existing product is unpurchasable until its first
 *      complete V2 write — and, since DECISIONS row 240, SHOWN catalog-only:
 *      the listing and the page carry it with `price_status: 'unpriced'` and
 *      no number; the cart refuses it (PRICE_NOT_AVAILABLE); an open cart
 *      lists it apart (ar/en/ckb, no number);
 *   2. a V2-published product is listed and sold again, priced from its SKU
 *      rows;
 *   3. no legacy number reaches a new order line: cost NULL, basis
 *      `unpriced`, the frozen V2 estimate when the result has a replacement
 *      cost — and `calculateGoods` reads it as `estimated`;
 *   4. the archive: one `clean_start` row per product present when 0190 runs,
 *      every legacy money field kept, a second run inserts nothing;
 *   5. deploy-ahead: on a database at 0188 the new Worker sells nothing and
 *      shows every product catalog-only (never a legacy price).
 *
 * Every app here opts out of the route-test auto-publish (`publishV2: false`).
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2CleanStart.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, dbThrough, json, post, get, row, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { seedCatalogue, orderBody } from './lib/bundles';
import { isV2Published, publishV2 } from './fixtures/v2Publish';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { calculateGoods } from '../worker/lib/orderProfit';

/** `row` for a row the test itself just wrote (never absent). */
const one = <T = Record<string, unknown>>(...a: Parameters<typeof row>): T => row<T>(...a)!;

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

const appFor = (db: D1Database, user: StubUser | null = BUYER) =>
  stubApp(
    db,
    user,
    (a) => {
      a.route('/api/products', productRoutes);
      a.route('/api/cart', cartRoutes);
      a.route('/api/orders', orderRoutes);
    },
    { publishV2: false }
  );

test('1. after the cut-over a legacy product is shown catalog-only and unpurchasable; an open cart line is unavailable, never priced', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  // An open cart from before the cut-over.
  raw.exec("INSERT INTO cart_items (id, user_id, product_id, qty) VALUES ('ci_old', 'buyer', 'p_nozzle', 2)");
  const app = appFor(db);
  const list = await json(await get(app, '/api/products'));
  const listed = (list.products ?? list.items ?? []) as Array<{ id: string; price_status: string; price_iqd: unknown; display_price_iqd: unknown }>;
  assert.ok(listed.length > 0, 'the legacy products are shown (DECISIONS row 240)');
  for (const card of listed) {
    assert.equal(card.price_status, 'unpriced', card.id);
    assert.equal(card.price_iqd, null, card.id);
    assert.equal(card.display_price_iqd, null, card.id);
  }
  assert.doesNotMatch(JSON.stringify(list), /"(display_|prime_|pro_)?price_iqd":[1-9]/, 'no legacy number on any card');
  const page = await get(app, '/api/products/nozzle');
  assert.equal(page.status, 200);
  const pageBody = await json(page);
  assert.equal(pageBody.price_status, 'unpriced');
  assert.equal(pageBody.pricing, null);
  const add = await post(app, '/api/cart/items', { productId: 'p_pla', qty: 1 });
  assert.equal(add.status, 409);
  assert.equal((await json(add)).code, 'PRICE_NOT_AVAILABLE');
  const cart = await json(await get(app, '/api/cart'));
  const lines = (cart.items ?? []) as unknown[];
  assert.equal(lines.length, 0, 'a hidden line is never priced in the cart');
  const unavailable = cart.unavailable_lines as Array<Record<string, unknown>>;
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0]!.product_id, 'p_nozzle');
  assert.equal(unavailable[0]!.code, 'PRICE_NOT_AVAILABLE', 'still shown: the line names the missing price');
  const names = unavailable[0]!.name as { ar: string; en: string; ckb: string };
  assert.ok(names.ar && names.en && names.ckb && names.ckb !== names.ar, 'ar, en and real Sorani');
  assert.doesNotMatch(JSON.stringify(unavailable), /5000|_iqd|"price/, 'no number for an unsellable line');
});

test('2. a V2-published product is listed priced and sold again; the others stay catalog-only', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  await publishV2(raw, 'p_nozzle');
  assert.equal(isV2Published(raw, 'p_nozzle'), true);
  const app = appFor(db);
  const list = await json(await get(app, '/api/products'));
  const cards = (list.products ?? list.items ?? []) as Array<{ id: string; price_status: string }>;
  assert.deepEqual(cards.filter((p) => p.price_status === 'priced').map((p) => p.id), ['p_nozzle']);
  assert.equal(cards[0]!.id, 'p_nozzle', 'browse puts the priced product first (R1)');
  const nozzle = await get(app, '/api/products/nozzle');
  assert.equal(nozzle.status, 200);
  assert.equal((await json(nozzle)).price_status, 'priced');
  const add = await json(await post(app, '/api/cart/items', { productId: 'p_nozzle', qty: 1 }));
  assert.equal(add.success, true, JSON.stringify(add));
  const pla = await get(app, '/api/products/pla');
  assert.equal(pla.status, 200);
  assert.equal((await json(pla)).price_status, 'unpriced');
});

test('3. no legacy number reaches a new order line; the frozen V2 estimate is read as `estimated`', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  // A legacy cost the line must never carry.
  raw.exec("UPDATE products SET product_cost_iqd = 3333 WHERE id = 'p_nozzle'");
  await publishV2(raw, 'p_nozzle');
  // The result's replacement cost (what a cost-first write records): the line's estimate.
  withoutTriggers(raw, ['pricing_v2_sku_results_update_guard'], "UPDATE pricing_v2_sku_results SET replacement_exact = '4100.5', replacement_cost_iqd = 4101 WHERE product_id = 'p_nozzle'");
  const app = appFor(db);
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'p_nozzle', qty: 2 }))).success, true);
  const placed = await json(await post(app, '/api/orders', orderBody({ printerStandardDeliveryAcceptance: undefined })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const line = one<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ?', placed.order.id);
  assert.equal(line.cost_iqd, null);
  assert.equal(line.cost_basis, 'unpriced');
  assert.equal(line.estimated_cost_iqd, 4101);
  assert.equal(line.estimated_usd_iqd_rate, '1500');
  assert.ok(Number(line.estimated_fx_version) > 0);
  assert.equal(line.estimated_cost_usd, '2.733667', 'ceil6(4100.5 ÷ 1500)');
  assert.doesNotMatch(String(line.pricing_snapshot), /3333/, 'the legacy cost is nowhere on the line');
  const goods = calculateGoods(
    one<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', placed.order.id),
    [line as never],
    []
  );
  assert.equal(goods.lines[0]!.cost_confidence, 'estimated');
  assert.equal(goods.lines[0]!.cogs_iqd, 8202);
});

const migration0190 = () => readFileSync(join(ROOT, 'migrations', readdirSync(join(ROOT, 'migrations')).find((f) => f.startsWith('0190_'))!), 'utf8');

test('4. the archive: one clean_start row per product present at 0190, every legacy money field kept; a second run inserts nothing', () => {
  const raw = dbThrough('0189');
  raw.exec(`INSERT INTO products (id, slug, name, price_iqd, prime_price_iqd, pro_price_iqd, original_price_iqd, product_cost_iqd, status)
            VALUES ('p_a', 'a', 'A', 125000, 120000, 115000, 140000, 654321, 'active'),
                   ('p_b', 'b', 'B', 99000, NULL, NULL, NULL, NULL, 'draft')`);
  raw.exec(migration0190());
  const rows = raw.prepare("SELECT product_id, payload_json FROM pricing_legacy_snapshots WHERE reason = 'clean_start' ORDER BY product_id").all() as Array<{ product_id: string; payload_json: string }>;
  assert.deepEqual(rows.map((r) => r.product_id), ['p_a', 'p_b']);
  const payload = JSON.parse(rows[0]!.payload_json) as { product: Record<string, unknown> };
  assert.equal(payload.product.price_iqd, 125000);
  assert.equal(payload.product.pro_price_iqd, 115000);
  assert.equal(payload.product.original_price_iqd, 140000);
  assert.equal(payload.product.product_cost_iqd, 654321);
  // The archive statement again (a re-run of 0190 — its ALTERs are guarded by migrate-check --twice).
  const archive = /INSERT INTO pricing_legacy_snapshots[\s\S]*?;\n/.exec(migration0190())![0];
  raw.exec(archive);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM pricing_legacy_snapshots WHERE reason = 'clean_start'").get() as { n: number }).n, 2);
  assert.throws(() => raw.exec("UPDATE pricing_legacy_snapshots SET reason = 'clean_start' WHERE product_id = 'p_a'"));
  assert.throws(() => raw.exec("DELETE FROM pricing_legacy_snapshots WHERE product_id = 'p_a'"));
});

test('5. deploy-ahead: on a database at 0188 the new Worker sells nothing and shows every product catalog-only (fail closed)', async () => {
  const raw = dbThrough('0188');
  raw.exec("INSERT INTO products (id, slug, name, price_iqd, status, stock, selling_type, sale_types) VALUES ('p_x', 'x', 'X', 50000, 'active', 3, 'direct_sale', '[\"direct_sale\"]')");
  const app = appFor(asD1(raw), null);
  const res = await get(app, '/api/products');
  assert.equal(res.status, 200);
  const body = await json(res);
  const cards = (body.products ?? body.items ?? []) as Array<{ id: string; price_status: string; price_iqd: unknown }>;
  assert.deepEqual(cards.map((c) => [c.id, c.price_status, c.price_iqd]), [['p_x', 'unpriced', null]]);
  assert.doesNotMatch(JSON.stringify(body), /50000|50,000/, 'never the legacy price');
  const page = await get(app, '/api/products/x');
  assert.equal(page.status, 200);
  assert.equal((await json(page)).price_status, 'unpriced');
  assert.equal((await post(app, '/api/products/x/quote', { qty: 1 })).status, 409);
});
