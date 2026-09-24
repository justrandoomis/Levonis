/**
 * VARIANT PRICING AND STOCK ARE THE SERVER'S (merchant platform W2-F; the
 * owner's decision 8). Against the real cart, checkout, merchant and cancel
 * routes on every migration:
 *
 *   · the price charged is the chosen variant's, read from the database — a
 *     price the client posts is never read;
 *   · a variant must be an active variant of THAT product, and a product with
 *     variants cannot be bought without one;
 *   · each variant's stock is checked at add and at quote, and FENCED inside
 *     the order batch: a unit taken between the quote and the write aborts the
 *     whole order (the wave-1 pattern), and nothing goes negative;
 *   · a cancellation puts the variant's units back, whichever door cancels;
 *   · a legacy product (pre-0126 JSON) still sells exactly as before;
 *   · a sale that takes a variant to its low-stock line tells the merchant once.
 *
 * Run: node --import tsx --test tests/catalogCheckout.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, json, row, count, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { seedCatalog, variantBody } from './fixtures/catalog';

const DEP = 100_000;

function seed() {
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer2','Noor','noor@x.co','h','customer');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES
      ('a1','buyer','Sara','+964770','Street 1','basra'), ('a2','buyer2','Noor','+964772','Street 3','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES
      ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed'), ('dep_buyer2','buyer2','deposit','USD',${DEP},'approved','seed');
  `);
  return raw;
}

const shopper = (db: D1Database, id = 'buyer') =>
  stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
  });
const owner = (db: D1Database) =>
  stubApp(db, { id: 'ali', role: 'merchant', email: 'ali@x.co' }, (a) => a.route('/api/merchant', merchantRoutes).route('/api/merchant', merchantCatalogRoutes));

async function dragon(raw: DatabaseSync, extra: Record<string, unknown> = {}) {
  const res = await post(owner(asD1(raw)), '/api/merchant/products', variantBody(extra));
  assert.equal(res.status, 201);
  const p = (await json(res)).product;
  return { p, small: p.variants[0].id as string, medium: p.variants[1].id as string };
}

async function placeOrder(app: ReturnType<typeof shopper>, key: string, address = 'a1') {
  const q = await json(await post(app, '/api/store-orders/quote', { addressId: address }));
  const res = await post(app, '/api/store-orders', { idempotencyKey: key, addressId: address, quoteFingerprint: q.quote?.quote_fingerprint });
  return { res, body: await json(res), quote: q };
}

const variantStock = (raw: DatabaseSync, id: string) => row<{ stock: number }>(raw, 'SELECT stock FROM community_product_variants WHERE id = ?', id)!.stock;
const productStock = (raw: DatabaseSync, id: string) => row<{ stock: number }>(raw, 'SELECT stock FROM community_products WHERE id = ?', id)!.stock;

test('a product with variants is bought as one of ITS active variants', async () => {
  const raw = seed();
  const { p, small } = await dragon(raw);
  const other = await dragon(raw);
  const app = shopper(asD1(raw));
  const code = async (body: Record<string, unknown>) => (await json(await post(app, '/api/cart/merchant-items', { productId: p.id, qty: 1, ...body }))).code;
  assert.equal(await code({}), 'VARIANT_REQUIRED');
  assert.equal(await code({ variantId: other.small }), 'VARIANT_INVALID', "another product's variant");
  assert.equal(await code({ variantId: 'pv_made_up' }), 'VARIANT_INVALID');
  assert.equal(await code({ optionId: 'GOLD PLATED (paid +20000)' }), 'VARIANT_REQUIRED');
  raw.exec(`UPDATE community_product_variants SET active = 0 WHERE id = '${small}'`);
  assert.equal(await code({ variantId: small }), 'VARIANT_UNAVAILABLE');
});

test('the SERVER prices the chosen variant — a price the client posts is never read', async () => {
  const raw = seed();
  const { p, medium } = await dragon(raw);
  const app = shopper(asD1(raw));
  const add = await post(app, '/api/cart/merchant-items', {
    productId: p.id, variantId: medium, qty: 2, price_iqd: 1, unit_price_iqd: 1, total_iqd: 1,
  });
  assert.equal(add.status, 201);
  const cart = await json(add);
  assert.equal(cart.items[0].unit_price_iqd, 14_000, "the variant's own price, from the database");
  assert.equal(cart.items[0].variant, 'وسط / أحمر');
  const { res, body, quote } = await placeOrder(app, 'variant-price-1');
  assert.equal(quote.quote.lines[0].unit_price_iqd, 14_000);
  assert.equal(res.status, 201, JSON.stringify(body));
  const line = row<{ unit_price_iqd: number; line_total_iqd: number; variant_id: string; option_snapshot: string; sku_snapshot: string }>(
    raw, 'SELECT unit_price_iqd, line_total_iqd, variant_id, option_snapshot, sku_snapshot FROM order_items WHERE order_id = ?', body.order.id
  )!;
  assert.deepEqual(line, { unit_price_iqd: 14_000, line_total_iqd: 28_000, variant_id: medium, option_snapshot: 'وسط / أحمر', sku_snapshot: 'DR-M' });
  assert.equal(body.order.subtotal_iqd, 28_000);
  // The merchant changing the variant's price after the quote is a new agreement.
  raw.exec(`UPDATE community_product_variants SET price_iqd = 15000 WHERE id = '${medium}'`);
  await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: medium, qty: 1 });
  const q = await json(await post(app, '/api/store-orders/quote', { addressId: 'a1' }));
  raw.exec(`UPDATE community_product_variants SET price_iqd = 16000 WHERE id = '${medium}'`);
  const stale = await post(app, '/api/store-orders', { idempotencyKey: 'variant-price-2', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'QUOTE_CHANGED');
});

test('each variant has its own stock: add, cart line and quote judge it', async () => {
  const raw = seed();
  const { p, small, medium } = await dragon(raw);
  const app = shopper(asD1(raw));
  const over = await json(await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: small, qty: 3 }));
  assert.equal(over.code, 'OUT_OF_STOCK');
  assert.equal(over.details.available, 2, "S has 2 — M's 5 do not count");
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: small, qty: 2 })).status, 201);
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: small, qty: 1 })).status, 400, 'the same variant again, over its stock');
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: medium, qty: 5 })).status, 201, 'the other variant has its own');
  raw.exec(`UPDATE community_product_variants SET stock = 1 WHERE id = '${small}'`);
  const q = await json(await post(app, '/api/store-orders/quote', { addressId: 'a1' }));
  assert.equal(q.code, 'OUT_OF_STOCK');
  assert.equal(q.details.variant_id, small);
  assert.equal(q.details.available, 1);
});

test('STOCK RACE: the last unit of a variant, taken between the quote and the write, aborts the whole order', async () => {
  const raw = seed();
  const { p, small } = await dragon(raw);
  raw.exec(`UPDATE community_product_variants SET stock = 1 WHERE id = '${small}'`);
  const { failing, db } = failingD1(raw);
  const app = shopper(db);
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: small, qty: 1 })).status, 201);
  const q = await json(await post(app, '/api/store-orders/quote', { addressId: 'a1' }));
  assert.ok(q.quote, JSON.stringify(q));
  // Another buyer's order takes the unit after this checkout priced it.
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO orders/.test(s.sql))) {
      raw.exec(`UPDATE community_product_variants SET stock = 0 WHERE id = '${small}'`);
      failing.beforeBatch = null;
    }
  };
  const res = await post(app, '/api/store-orders', { idempotencyKey: 'race-variant-1', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.equal(body.details.variant_id, small);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0, 'no order, no debit, no credit');
  assert.equal(variantStock(raw, small), 0, 'never negative');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_holds WHERE user_id = 'buyer' AND state = 'active'"), 0, 'the refused hold was handed back');
});

test('two buyers, one unit: exactly one order, and the variant ends at zero', async () => {
  const raw = seed();
  const { p, small } = await dragon(raw);
  raw.exec(`UPDATE community_product_variants SET stock = 1 WHERE id = '${small}'`);
  const a = shopper(asD1(raw));
  const b = shopper(asD1(raw), 'buyer2');
  await post(a, '/api/cart/merchant-items', { productId: p.id, variantId: small, qty: 1 });
  await post(b, '/api/cart/merchant-items', { productId: p.id, variantId: small, qty: 1 });
  const first = await placeOrder(a, 'two-buyers-a');
  const second = await placeOrder(b, 'two-buyers-b', 'a2');
  assert.equal(first.res.status, 201);
  assert.equal(second.body.code ?? second.quote.code, 'OUT_OF_STOCK');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 1);
  assert.equal(variantStock(raw, small), 0);
  assert.equal(productStock(raw, p.id), 5, 'the product is the sum of its variants');
});

test('a cancellation puts the variant’s units back — and the product’s sum follows', async () => {
  const raw = seed();
  const { p, medium } = await dragon(raw);
  const app = shopper(asD1(raw));
  await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: medium, qty: 2 });
  const { body } = await placeOrder(app, 'cancel-variant-1');
  assert.equal(variantStock(raw, medium), 3);
  assert.equal(productStock(raw, p.id), 5);
  const cancel = await post(owner(asD1(raw)), `/api/merchant/orders/${body.order.id}/status`, { status: 'cancelled', reason: 'out of filament' });
  assert.equal(cancel.status, 200, JSON.stringify(await cancel.clone().json()));
  assert.equal(variantStock(raw, medium), 5);
  assert.equal(productStock(raw, p.id), 7);
  // Once only: a second cancel moves nothing.
  await post(owner(asD1(raw)), `/api/merchant/orders/${body.order.id}/status`, { status: 'cancelled' });
  assert.equal(variantStock(raw, medium), 5);
});

test('a legacy product (pre-0126 JSON) still sells exactly as before', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,options,colors,variant_mode)
            VALUES ('cp_old','m_ali','s_ali','ali-old','Old spool','active','active',14000,10,1,'["S","M"]','[]','legacy')`);
  const app = shopper(asD1(raw));
  assert.equal((await json(await post(app, '/api/cart/merchant-items', { productId: 'cp_old', optionId: 'XL', qty: 1 }))).code, 'OPTION_INVALID');
  assert.equal((await json(await post(app, '/api/cart/merchant-items', { productId: 'cp_old', variantId: 'pv_x', qty: 1 }))).code, 'VARIANT_INVALID');
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_old', optionId: 'M', qty: 2 })).status, 201);
  const { res, body } = await placeOrder(app, 'legacy-1');
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.order.subtotal_iqd, 28_000);
  assert.equal(row<{ option_snapshot: string }>(raw, 'SELECT option_snapshot FROM order_items WHERE order_id = ?', body.order.id)!.option_snapshot, 'M');
  assert.equal(productStock(raw, 'cp_old'), 8);
});

test('a sale that takes a variant to its low-stock line tells the merchant — once', async () => {
  const raw = seed();
  const body = variantBody();
  (body.variant_model as any).variants[1].low_stock_threshold = 3;
  const res = await post(owner(asD1(raw)), '/api/merchant/products', body);
  const p = (await json(res)).product;
  const app = shopper(asD1(raw));
  await post(app, '/api/cart/merchant-items', { productId: p.id, variantId: p.variants[1].id, qty: 2 });
  const placed = await placeOrder(app, 'low-stock-1');
  assert.equal(placed.res.status, 201, JSON.stringify(placed.body));
  await Promise.all(pending);
  const notices = row<{ n: number }>(raw, "SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'ali' AND kind = 'low_stock'")!.n;
  assert.equal(notices, 1);
});
