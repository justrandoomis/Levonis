/**
 * PHASE 0 OF THE PRICING PROGRAMME — EVERY COST LEAK THE AUDIT FOUND, CLOSED.
 *
 * The owner's invariant: «ANY ROLE OTHER THAN MAIN ADMIN / SUPER ADMIN MUST
 * NEVER RECEIVE PRIVATE COST DATA… ليس فقط ألا تظهر له في الشاشة. بل يجب ألا
 * تصل إلى جهازه أصلاً.» Each test below is one leak the audit reproduced, run
 * through the REAL route against a migrated database:
 *
 *   L1  GET /api/cart served nested option / cell / route / colour cost to any
 *       signed-in customer.
 *   L2  legacy GET /api/admin/products served every rung's cost to assistants.
 *   L3  legacy POST /api/admin/products let an assistant set — or blank — it.
 *   L4  price-grid bulk/copy previews answered BELOW_COST to an assistant, so a
 *       few previews binary-searched the exact cost.
 *   L5  the lot receipt's camelCase cost keys passed the snake_case strip.
 *   L6  assistants read and wrote the cost-bearing settings and the wallet rate.
 *   L7/8 the incoming list's FX rate and source currency.
 *   L9  "the selling price must not equal the cost" confirmed a guessed cost.
 *   L10 a TXT file wrote a model's or a route's cost for an assistant.
 *   L12 admin and cart JSON carried no Cache-Control.
 *
 * The assertions are shaped "no key mentioning cost, and no seeded cost VALUE,
 * survives at any depth" — the shape that also catches the next cost column.
 *
 * Run: node --import tsx --test tests/costLeaksPhase0.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, freshDb, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { adminRoutes } from '../worker/routes/admin';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { stripFinancials } from '../worker/lib/adminScope';
import { validateProductDoc } from '../worker/lib/productModel';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import type { AppContext } from '../worker/lib/types';
import { COST, leaks, seedCostlyProduct } from './fixtures/costlyProduct';

const CUSTOMER: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };

// ---------------------------------------------------------------- L1

test('L1 — the cart carries no cost key and no cost value, at any depth', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const app = stubApp(asD1(raw), CUSTOMER, (a) => a.route('/api/cart', cartRoutes));
  const res = await get(app, '/api/cart');
  assert.equal(res.status, 200);
  const body = await json(res);
  const line = (body.items as Array<Record<string, unknown>>).find((i) => i.id === 'ci');
  assert.ok(line, 'the line is in the cart');
  // The fixture really does reach the nested levels — otherwise this proves nothing.
  const option = (line.options as Array<Record<string, unknown>>)[0]!;
  assert.ok(Array.isArray(option.fulfillments) && option.fulfillments.length === 2, 'the model’s cells are served');
  assert.deepEqual(leaks(body), []);
});

// ---------------------------------------------------------------- L2 / L3

const legacyApp = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin', adminRoutes));

test('L2 — the legacy product list strips every rung’s cost for an assistant, and keeps it for a financial admin', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const asAssistant = await json(await get(legacyApp(raw, ASSISTANT), '/api/admin/products'));
  assert.equal(asAssistant.success, true);
  assert.deepEqual(leaks(asAssistant.products), []);

  const asFull = await json(await get(legacyApp(raw, FULL), '/api/admin/products'));
  assert.equal((asFull.products as Array<Record<string, unknown>>)[0]!.product_cost_iqd, COST.product);
});

test('L3 — an assistant can neither set nor blank the cost through the legacy save', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const app = legacyApp(raw, ASSISTANT);
  const base = { id: 'p_a1', name: 'Bambu Lab A1', slug: 'a1', price_iqd: 910000 };

  const set = await post(app, '/api/admin/products', { ...base, product_cost_iqd: 1 });
  assert.equal(set.status, 200, JSON.stringify(await set.clone().json()));
  assert.deepEqual(leaks(await json(set)), [], 'and the answer carries no cost either');
  assert.equal(row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c, COST.product);

  await post(app, '/api/admin/products', base); // the validator used to emit null for an absent cost
  assert.equal(row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c, COST.product);
  assert.equal(row(raw, 'SELECT price_iqd AS p FROM products WHERE id = ?', 'p_a1')!.p, 910000, 'the price did save');

  // A financial admin still can.
  await post(legacyApp(raw, FULL), '/api/admin/products', { ...base, product_cost_iqd: 500000 });
  assert.equal(row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c, 500000);
});

// ---------------------------------------------------------------- L4

test('L4 — a bulk preview below cost says nothing about the cost to an assistant', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const grid = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/products', adminPriceGridRoutes));
  const below = { op: 'set', fields: ['regular'], value: 100_000, scope: { levels: ['product'] } };

  const full = await json(await post(grid(FULL), '/api/admin/products/p_a1/price-grid/bulk', below));
  assert.ok((full.preview.guards as unknown[]).length > 0, 'the financial admin is warned — otherwise this proves nothing');

  for (const value of [100_000, 700_000, 611_110, 611_112]) {
    const res = await json(
      await post(grid(ASSISTANT), '/api/admin/products/p_a1/price-grid/bulk', { ...below, value })
    );
    assert.equal(res.success, true, JSON.stringify(res));
    assert.deepEqual(res.preview.guards, [], `no guard at ${value}`);
    assert.deepEqual(leaks(res), []);
  }

  // And the apply does not ask an assistant to confirm a below-cost price.
  const applied = await post(grid(ASSISTANT), '/api/admin/products/p_a1/price-grid/bulk', { ...below, apply: true });
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()));
});

test('L4/L9 — the grid’s ladder check never compares a price with a cost the assistant cannot see', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const grid = stubApp(asD1(raw), ASSISTANT, (a) => a.route('/api/admin/products', adminPriceGridRoutes));
  const res = await post(grid, '/api/admin/products/p_a1/price-grid/bulk', {
    op: 'set', fields: ['regular'], value: COST.product, scope: { levels: ['product'] },
  });
  const body = await json(res);
  assert.equal(body.success, true, JSON.stringify(body));
  assert.deepEqual(body.errors, [], 'a price equal to the hidden cost is not refused — that refusal was the oracle');
});

// ---------------------------------------------------------------- L5 / L7 / L8

test('L5 — the camelCase lot-cost keys are stripped like the snake_case ones', () => {
  const stripped = stripFinancials({
    cost: { unitCostIqd: 1, purchaseUnitIqd: 2, shippingShareIqd: 3, internalShareIqd: 4, totalCostIqd: 5, complete: true },
    qty: 7,
  });
  assert.deepEqual(stripped, { cost: { complete: true }, qty: 7 });
});

test('L7/L8 — the incoming list hides the FX rate, source currency and purchase total from an assistant', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  raw.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,
                                    source_currency,source_unit_amount,exchange_rate_used,status)
    VALUES ('inc1','p_a1','base','',3,${COST.product},'CNY',2999,203.7,'incoming');
  `);
  const inv = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/inventory', adminInventoryRoutes));
  const asAssistant = await json(await get(inv(ASSISTANT), '/api/admin/inventory/incoming'));
  assert.equal(asAssistant.success, true, JSON.stringify(asAssistant));
  const item = (asAssistant.incoming as Array<Record<string, unknown>>)[0]!;
  assert.ok(item, 'the purchase is listed — quantities are not secret');
  for (const k of ['exchange_rate_used', 'source_currency', 'source_unit_amount', 'purchase_unit_iqd', 'purchase_total_iqd']) {
    assert.equal(k in item, false, `${k} is not served`);
  }
  const asFull = await json(await get(inv(FULL), '/api/admin/inventory/incoming'));
  assert.equal((asFull.incoming as Array<Record<string, unknown>>)[0]!.exchange_rate_used, 203.7);
});

// ---------------------------------------------------------------- L6

test('L6 — cost-bearing settings are not read by an assistant, and money settings are not written by one', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('minMarginPercent', '17')").run();
  const settings = (user: StubUser) => legacyApp(raw, user);

  const read = await json(await get(settings(ASSISTANT), '/api/admin/settings'));
  assert.equal(read.success, true);
  for (const k of ['minMarginPercent', 'printPricingConfig', 'printMaterials']) {
    assert.equal(k in read.settings, false, `${k} is not served to an assistant`);
  }
  assert.ok('homeSections' in read.settings || 'exchangeRate' in read.settings, 'the rest of the settings still are');
  const readFull = await json(await get(settings(FULL), '/api/admin/settings'));
  assert.equal(readFull.settings.minMarginPercent, 17);

  for (const [key, value] of [
    ['exchangeRate', 1500],
    ['minMarginPercent', 5],
    ['preorderTransportDefaults', [{ method: 'air', commission_iqd: 1 }]],
    ['proPricingPolicy', { mode: 'global_percent', percent: 50 }],
  ] as const) {
    const res = await put(settings(ASSISTANT), `/api/admin/settings/${key}`, { value });
    assert.equal(res.status, 403, `${key} refused`);
    assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED');
  }
  assert.equal(row(raw, "SELECT value FROM admin_settings WHERE key = 'minMarginPercent'")!.value, '17');

  const ok = await put(settings(FULL), '/api/admin/settings/exchangeRate', { value: 1500 });
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------- L9

test('L9 — the validator judges price against cost only for a caller who can see the cost', () => {
  const doc = { name_en: 'X', price_iqd: 500_000, product_cost_iqd: 500_000 };
  assert.throws(() => validateProductDoc(doc), /must not equal the cost/);
  assert.doesNotThrow(() => validateProductDoc(doc, { costBlind: true }));
  assert.equal(validateProductDoc(doc, { costBlind: true }).product_cost_iqd, 500_000, 'the stored cost is still carried');
});

// ---------------------------------------------------------------- L12

test('L12 — admin and cart answers are private, no-store, unless the route chose a policy', async () => {
  const a = new Hono<AppContext>();
  a.use('/api/admin/*', noStoreUnlessSet);
  a.get('/api/admin/x', (c) => c.json({ ok: true }));
  a.get('/api/admin/file', (c) => {
    c.header('Cache-Control', 'private, max-age=60');
    return c.text('file');
  });
  assert.equal((await a.request('/api/admin/x')).headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await a.request('/api/admin/file')).headers.get('Cache-Control'), 'private, max-age=60');
});

test('L12 — the middleware is mounted on admin and cart in the Worker', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
  assert.match(src, /app\.use\('\/api\/admin\/\*', noStoreUnlessSet\)/);
  assert.match(src, /app\.use\('\/api\/cart', noStoreUnlessSet\)/);
  assert.match(src, /app\.use\('\/api\/cart\/\*', noStoreUnlessSet\)/);
});

// ---------------------------------------------------------------- sanity on the fixture

test('the fixture seeds every cost level it claims to (or the leak checks above prove nothing)', () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const seeded = [
    ...all<{ c: number }>(raw, 'SELECT cost_iqd AS c FROM product_option_values'),
    ...all<{ c: number }>(raw, 'SELECT cost_iqd AS c FROM product_option_fulfillment'),
    ...all<{ c: number }>(raw, 'SELECT cost_iqd AS c FROM product_option_transports'),
    ...all<{ c: number }>(raw, 'SELECT cost_iqd AS c FROM product_colors'),
  ].map((r) => r.c);
  assert.deepEqual(seeded.sort(), [COST.option, COST.cell, COST.cell, COST.route, COST.color].sort());
});

// ---------------------------------------------------------------- L10

test('L10 — a TXT file cannot write a model’s order-type cost for an assistant; a financial admin still can', async () => {
  const { templateRoutes } = await import('../worker/routes/template');
  const raw = freshDb();
  const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co', admin_scope: null };
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES
    ('usr_owner','Owner','boss@x.co','h','admin'),('usr_asst','Asst','asst@x.co','h','admin')`);
  const tpl = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/template', templateRoutes));
  const apply = async (user: StubUser, text: string, mode: 'draft' | 'update') => {
    const res = await post(tpl(user), '/api/admin/template/apply', { text, mode, confirm: true });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  };
  const cellCosts = (id: string) =>
    all<{ t: string; c: number | null; a: number | null }>(
      raw,
      'SELECT fulfillment_type AS t, cost_iqd AS c, cost_adjust_iqd AS a FROM product_option_fulfillment WHERE product_id = ? ORDER BY fulfillment_type',
      id
    );
  const cells = (direct: string, preorder: string) => `options.1.id=a1
options.1.name_ar=A1
options.1.name_en=A1
options.1.active=true
options.1.stock=3
options.1.direct.enabled=true
options.1.direct.cost_iqd=${direct}
options.1.preorder.enabled=true
options.1.preorder.cost_iqd=${preorder}
options.1.preorder.transports.1.method=air
`;

  const created = await apply(
    OWNER,
    `template_version=2
slug=cell-cost
name_ar=طابعة
name_en=Printer
status=draft
price_iqd=900000
${cells(String(COST.cell), String(COST.cell))}`,
    'draft'
  );
  const id = String(created.product_id);
  assert.deepEqual(cellCosts(id), [
    { t: 'direct_sale', c: COST.cell, a: null },
    { t: 'pre_order', c: COST.cell, a: null },
  ], 'the owner wrote both cells’ cost — otherwise this proves nothing');

  const stampOf = () => String(row(raw, 'SELECT updated_at FROM products WHERE id = ?', id)!.updated_at);
  const update = (user: StubUser, direct: string, preorder: string) =>
    apply(user, `template_version=2\nproduct_id=${id}\nexpected_updated_at=${stampOf()}\n${cells(direct, preorder)}`, 'update');

  await update(ASSISTANT, '1', '+2');
  assert.deepEqual(cellCosts(id), [
    { t: 'direct_sale', c: COST.cell, a: null },
    { t: 'pre_order', c: COST.cell, a: null },
  ], 'the stored cell costs survive an assistant’s file');

  await update(OWNER, '500000', '510000');
  assert.deepEqual(cellCosts(id).map((r) => r.c), [500000, 510000], 'a financial admin’s file still writes them');
});
