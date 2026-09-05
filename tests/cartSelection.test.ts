/**
 * A product with options is sold as ONE of them — for every product, not only
 * the relational ones.
 *
 * The relational path enforces the choice in validateSelection. A legacy
 * JSON-column product (the kind a TXT create produces) reached the cart with
 * no option at all and was added at the base price — a line the shop never
 * offers, priced at a number no option sells for. saleAvailability already
 * knew (it is what disables the storefront button); the cart and the checkout
 * revalidation now listen to it. These tests run the REAL cart routes against
 * real migrations through the SQLite adapter; only the session is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { cartRoutes, refuseIncompleteSelection } from '../worker/routes/cart';
import { saleAvailability } from '../worker/routes/products';
import { parseProductRow } from '../worker/lib/productModel';

function app(db: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: 'u1', role: 'customer', email: 'a@x.co' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  a.route('/api/cart', cartRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

const OPTIONS = JSON.stringify([
  { id: 'o_small', name: 'Small', name_ar: 'صغير', active: true },
  { id: 'o_large', name: 'Large', name_ar: 'كبير', active: true, regular_adjust_iqd: 20_000 },
]);
const COLORS = JSON.stringify([{ id: 'c_black', name: 'Black', name_ar: 'أسود', hex: '#000000', active: true }]);

function setup(opts: { options?: string; colors?: string } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Ali','a@x.co','h');`);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types)
       VALUES ('p1','plain','Plain','بسيط',100000,'active',10,?,?,'direct_sale','["direct_sale"]')`
    )
    .run(opts.options ?? '[]', opts.colors ?? '[]');
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const post = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a JSON-column product with options refuses a line that chose none', async () => {
  const { db } = setup({ options: OPTIONS });
  const res = await post(app(db), '/api/cart/items', { productId: 'p1', qty: 1 });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'OPTION_REQUIRED');
});

test('…and one with colours refuses a line that chose an option but no colour', async () => {
  const { db } = setup({ options: OPTIONS, colors: COLORS });
  const res = await post(app(db), '/api/cart/items', { productId: 'p1', qty: 1, optionId: 'o_small' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'COLOR_REQUIRED');
});

test('a complete selection is added, priced for the chosen option', async () => {
  const { db } = setup({ options: OPTIONS, colors: COLORS });
  const res = await post(app(db), '/api/cart/items', { productId: 'p1', qty: 1, optionId: 'o_large', colorId: 'c_black' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = (await json(res)) as { items: Array<{ option_id: string; color_id: string; breakdown: { regular_iqd: number } }> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].option_id, 'o_large');
  assert.equal(body.items[0].color_id, 'c_black');
  assert.equal(body.items[0].breakdown.regular_iqd, 120_000, '+20,000 over the base');
});

test('a product with neither options nor colours is added with no selection at all', async () => {
  const { db } = setup();
  const res = await post(app(db), '/api/cart/items', { productId: 'p1', qty: 2 });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
});

test('an update cannot clear the chosen option', async () => {
  const { db, raw } = setup({ options: OPTIONS });
  const a = app(db);
  const added = await post(a, '/api/cart/items', { productId: 'p1', qty: 1, optionId: 'o_small' });
  assert.equal(added.status, 200);
  const id = (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'u1'").get() as { id: string }).id;
  const res = await patch(a, `/api/cart/items/${id}`, { optionValueIds: [], optionId: '' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'OPTION_REQUIRED');
  // …while a real change of option is fine.
  const ok = await patch(a, `/api/cart/items/${id}`, { optionId: 'o_large' });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
});

test('the checkout guard: a stored row with no option is refused by the same rule the cart applies', () => {
  // routes/orders.ts calls exactly this pair for every cart row before pricing
  // it, so a row written before the cart refused incomplete selections (or a
  // product that gained options afterwards) cannot reach an order.
  const doc = parseProductRow({ id: 'p1', slug: 'x', name: 'X', price_iqd: 100_000, options: OPTIONS, colors: '[]', selling_type: 'direct_sale' });
  assert.throws(
    () => refuseIncompleteSelection(saleAvailability(doc, { optionValueIds: [], qty: 1 }), 'X'),
    (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'OPTION_REQUIRED' && e.message.startsWith('"X"')
  );
  assert.doesNotThrow(() => refuseIncompleteSelection(saleAvailability(doc, { optionValueIds: ['o_small'], qty: 1 }), 'X'));
});
