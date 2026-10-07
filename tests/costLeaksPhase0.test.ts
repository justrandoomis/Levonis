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
 * S1 (owner decision 2, 2026-10-07): the FULL-scope admin now sees NO cost
 * either — cost is the owner's alone — and keeps the money settings. Every
 * "financial admin still can" assertion below is the OWNER now.
 *
 * Run: node --import tsx --test tests/costLeaksPhase0.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, freshDb, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
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

test('L2 — the legacy product list strips every rung’s cost for an assistant AND a full admin, and keeps it for the owner', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  for (const user of [ASSISTANT, FULL]) {
    const body = await json(await get(legacyApp(raw, user), '/api/admin/products'));
    assert.equal(body.success, true);
    assert.deepEqual(leaks(body.products), [], `${user.id} sees no cost`);
  }

  const asOwner = await json(await get(legacyApp(raw, OWNER), '/api/admin/products'));
  assert.equal((asOwner.products as Array<Record<string, unknown>>)[0]!.product_cost_iqd, COST.product);
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

  // A full admin cannot either (decision 2); the owner still can.
  await post(legacyApp(raw, FULL), '/api/admin/products', { ...base, product_cost_iqd: 1 });
  assert.equal(row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c, COST.product);
  await post(legacyApp(raw, OWNER), '/api/admin/products', { ...base, product_cost_iqd: 500000 });
  assert.equal(row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c, 500000);
});

// ---------------------------------------------------------------- L4

test('L4 — a bulk preview below cost says nothing about the cost to an assistant', async () => {
  const raw = freshDb();
  seedCostlyProduct(raw);
  const grid = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/products', adminPriceGridRoutes));
  const below = { op: 'set', fields: ['regular'], value: 100_000, scope: { levels: ['product'] } };

  const owner = await json(await post(grid(OWNER), '/api/admin/products/p_a1/price-grid/bulk', below));
  assert.ok((owner.preview.guards as unknown[]).length > 0, 'the owner is warned — otherwise this proves nothing');

  for (const user of [ASSISTANT, FULL]) {
    for (const value of [100_000, 700_000, 611_110, 611_112]) {
      const res = await json(await post(grid(user), '/api/admin/products/p_a1/price-grid/bulk', { ...below, value }));
      assert.equal(res.success, true, JSON.stringify(res));
      assert.deepEqual(res.preview.guards, [], `no guard at ${value} for ${user.id}`);
      assert.deepEqual(leaks(res), []);
    }
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

test('L7/L8 — the incoming list hides the FX rate, source currency and purchase total from an assistant and a full admin', async () => {
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
  assert.equal('exchange_rate_used' in (asFull.incoming as Array<Record<string, unknown>>)[0]!, false, 'decision 2: no FX rate for a full admin');
  const asOwner = await json(await get(inv(OWNER), '/api/admin/inventory/incoming'));
  assert.equal((asOwner.incoming as Array<Record<string, unknown>>)[0]!.exchange_rate_used, 203.7);
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
  assert.equal('minMarginPercent' in readFull.settings, false, 'decision 2: the margin floor is the owner’s');
  const readOwner = await json(await get(settings(OWNER), '/api/admin/settings'));
  assert.equal(readOwner.settings.minMarginPercent, 17);

  for (const [key, value, code] of [
    ['exchangeRate', 1500, 'FINANCIAL_SCOPE_REQUIRED'],
    ['minMarginPercent', 5, 'COST_ACCESS_DENIED'],
    ['preorderTransportDefaults', [{ method: 'air', commission_iqd: 1 }], 'FINANCIAL_SCOPE_REQUIRED'],
    ['proPricingPolicy', { mode: 'global_percent', percent: 50 }, 'FINANCIAL_SCOPE_REQUIRED'],
  ] as const) {
    const res = await put(settings(ASSISTANT), `/api/admin/settings/${key}`, { value });
    assert.equal(res.status, 403, `${key} refused`);
    assert.equal((await json(res)).code, code);
  }
  // A full admin writes the money settings but never a cost setting.
  const fullCost = await put(settings(FULL), '/api/admin/settings/minMarginPercent', { value: 5 });
  assert.equal(fullCost.status, 403);
  assert.equal((await json(fullCost)).code, 'COST_ACCESS_DENIED');
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

// ------------------------------------------- S1: no equality oracle on a write

/**
 * The answer with the guess itself taken out, so a right guess and a wrong
 * one can be compared word for word: anything left that differs is a signal.
 */
const scrubbed = (v: unknown, ...guesses: number[]) =>
  JSON.parse(
    guesses.reduce(
      (s, g) => s.split(String(g)).join('<guess>').split(g.toLocaleString('en-US')).join('<guess>'),
      JSON.stringify(v)
    )
  ) as unknown;

/** Sets (or adds) `key` in an exported TXT file. */
const withLine = (text: string, key: string, value: string | number) => {
  const re = new RegExp(`^(${key.replace(/\./g, '\\.')}\\s*=).*$`, 'm');
  return re.test(text) ? text.replace(re, `$1${value}`) : text.replace(/^(product_id=.*)$/m, `$1\n${key}=${value}`);
};

test('L9 (relations) — a TXT row priced at the hidden option or colour cost is judged like any other price', async () => {
  // validatePriceLadder inside the relations planner compared a non-owner's
  // row price with the STORED cost the template merge carried onto the row,
  // and /parse writes nothing — so «the PRO price is identical to the cost»
  // confirmed a guess, three rungs per row per call.
  const { templateRoutes } = await import('../worker/routes/template');
  const raw = freshDb();
  seedCostlyProduct(raw);
  const tpl = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/template', templateRoutes));
  const parse = async (user: StubUser, key: string, value: number) => {
    const text = await (await get(tpl(user), '/api/admin/template/export/p_a1')).text();
    const res = await post(tpl(user), '/api/admin/template/parse', { text: withLine(text, key, value) });
    assert.equal(res.status, 200);
    return json(res);
  };

  // The owner IS told — otherwise the comparison below proves nothing.
  const owner = await parse(OWNER, 'options.1.pro_price_iqd', COST.option);
  assert.match(JSON.stringify(owner.validation_error), /identical to the cost|must not equal the cost/);

  for (const user of [ASSISTANT, FULL]) {
    for (const [key, cost] of [
      ['options.1.pro_price_iqd', COST.option],
      ['options.1.prime_price_iqd', COST.option],
      ['colors.1.pro_price_iqd', COST.color],
    ] as const) {
      const right = await parse(user, key, cost);
      const wrong = await parse(user, key, cost + 1000);
      assert.doesNotMatch(JSON.stringify(right), /identical to the cost|equal the cost|يساوي التكلفة/, `${user.id} ${key}`);
      assert.deepEqual(
        scrubbed(right.validation_error, cost),
        scrubbed(wrong.validation_error, cost + 1000),
        `${user.id}: ${key} at the stored cost answers exactly as any other price`
      );
      assert.deepEqual(scrubbed(right.warnings, cost), scrubbed(wrong.warnings, cost + 1000));
    }
  }
});

test('products-v2 — a non-owner sending the STORED cost is refused exactly like any other number', async () => {
  // The refusal used to be "you changed it": 200 for the stored cost, 403 for
  // anything else. It is decided from the request alone now.
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = freshDb();
  seedCostlyProduct(raw);
  const app = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/products-v2', adminProductsRoutes));
  for (const user of [ASSISTANT, FULL]) {
    const loaded = await json(await get(app(user), '/api/admin/products-v2/p_a1'));
    const doc = (loaded.product ?? loaded) as Record<string, unknown>;
    assert.deepEqual(leaks(doc), [], 'the form reads no cost');
    const answers: unknown[] = [];
    for (const guess of [COST.product, COST.product + 1000]) {
      const res = await post(app(user), '/api/admin/products-v2', { ...doc, id: 'p_a1', product_cost_iqd: guess });
      const body = await json(res);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(body.code, 'COST_ACCESS_DENIED');
      answers.push(scrubbed(body, guess));
    }
    assert.deepEqual(answers[0], answers[1], `${user.id}: a right guess and a wrong one get the same answer`);
    // The form's own save — the cost it never saw comes back as null — still works
    // and keeps the stored number.
    const saved = await post(app(user), '/api/admin/products-v2', { ...doc, id: 'p_a1', product_cost_iqd: null });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    assert.deepEqual(leaks(await json(saved)), []);
    assert.equal(row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c, COST.product);
  }
});

test('template apply — `cost_refused` and its warning come from the file, never from a comparison with the stored cost', async () => {
  const { templateRoutes } = await import('../worker/routes/template');
  const applyAs = async (user: StubUser, key: string, guess: number) => {
    const raw = freshDb();
    seedCostlyProduct(raw);
    raw.exec("UPDATE product_option_values SET stock = 3 WHERE id='v_a1'");
    const app = stubApp(asD1(raw), user, (a) => a.route('/api/admin/template', templateRoutes));
    const text = await (await get(app, '/api/admin/template/export/p_a1')).text();
    const res = await post(app, '/api/admin/template/apply', { text: withLine(text, key, guess), mode: 'update', confirm: true });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    const stored = {
      product: row(raw, 'SELECT product_cost_iqd AS c FROM products WHERE id = ?', 'p_a1')!.c,
      option: row(raw, 'SELECT cost_iqd AS c FROM product_option_values WHERE id = ?', 'v_a1')!.c,
    };
    return { body, stored };
  };
  for (const user of [ASSISTANT, FULL]) {
    for (const [key, cost] of [
      ['product_cost_iqd', COST.product],
      ['options.1.cost_iqd', COST.option],
    ] as const) {
      const right = await applyAs(user, key, cost);
      const wrong = await applyAs(user, key, cost + 1000);
      for (const r of [right, wrong]) {
        assert.deepEqual(r.body.cost_refused, [key], `${user.id}: the line the file carried is refused, by name`);
        assert.ok((r.body.warnings as string[]).some((w) => w.includes('الكلفة لا تُعدَّل')), 'and said so');
        assert.deepEqual(r.stored, { product: COST.product, option: COST.option }, 'the stored cost is kept');
        assert.ok(!(r.body.applied_fields as string[]).includes('product_cost_iqd'));
      }
      const pick = (b: Record<string, unknown>) => ({
        cost_refused: b.cost_refused,
        applied_fields: b.applied_fields,
        preserved_fields: b.preserved_fields,
        cleared_fields: b.cleared_fields,
        warnings: b.warnings,
      });
      assert.deepEqual(
        scrubbed(pick(right.body), cost),
        scrubbed(pick(wrong.body), cost + 1000),
        `${user.id}: ${key} — a right guess and a wrong one get the same answer`
      );
    }
  }
});

test('withdrawal notices written before S1 stay out of every non-owner admin’s bell; the participant’s own notice stays', async () => {
  // Before S1 «طلب سحب بقيمة X د.ع» reached every full and NULL-scope admin.
  // New rows go to the owner alone; the old rows are still in the table, so
  // the inbox hides them from anyone who may not see cost.
  const { notificationRoutes } = await import('../worker/routes/notifications');
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope,email_verified_at) VALUES
      ('usr_full','Full','full@x.co','h','admin','full',NULL),
      ('usr_owner','Owner','boss@x.co','h','admin',NULL,'2026-01-01T00:00:00.000Z');
    INSERT INTO user_notifications (id,user_id,kind,title_ar,body_ar,link,entity_type,entity_id,created_at) VALUES
      ('n_old_full','usr_full','payout_available','طلب سحب أرباح جديد','طلب سحب بقيمة 612,345 د.ع جاهز للمراجعة',
       '/admin?tab=finance&section=withdrawals','payout','w1','2026-09-01T00:00:00.000Z'),
      ('n_own_full','usr_full','payout_available','اعتماد طلب سحب الأرباح','تم اعتماد الطلب وهو بانتظار التسديد',
       '/earnings','payout','w9','2026-09-02T00:00:00.000Z'),
      ('n_other_full','usr_full','order_status','طلبك في الطريق','',
       '/orders/o1','order','o1','2026-09-03T00:00:00.000Z'),
      ('n_old_owner','usr_owner','payout_available','طلب سحب أرباح جديد','طلب سحب بقيمة 612,345 د.ع جاهز للمراجعة',
       '/admin?tab=finance&section=withdrawals','payout','w1','2026-09-01T00:00:00.000Z');
  `);
  const inbox = async (user: StubUser) => {
    const app = stubApp(asD1(raw), user, (a) => a.route('/api/notifications', notificationRoutes));
    const list = await json(await get(app, '/api/notifications'));
    const count = await json(await get(app, '/api/notifications/unread-count'));
    return { ids: (list.notifications as Array<{ id: string }>).map((n) => n.id).sort(), unread: list.unread, badge: count.unread };
  };
  assert.deepEqual(await inbox(FULL), { ids: ['n_other_full', 'n_own_full'], unread: 2, badge: 2 });
  assert.deepEqual(await inbox(OWNER), { ids: ['n_old_owner'], unread: 1, badge: 1 }, 'the owner still reads it');
});

test('a full admin and a receiving assistant can still receive a purchase — through a view with no cost in it', async () => {
  // S1 made the purchase register and the document the owner's (cost), but
  // receiving stays an operations act (SEC §1.2: POST …/receive is OP). The
  // receiver finds the shipment and its lines through /receiving, an
  // allowlist with no price, charge, payment, funding or FX column.
  const { adminProcurementRoutes } = await import('../worker/routes/adminProcurement');
  const { seedRoleMatrix, ROLES } = await import('./fixtures/roleMatrix');
  for (const role of ['full', 'support_assistant'] as const) {
    const raw = seedRoleMatrix();
    const app = stubApp(asD1(raw), ROLES[role], (a) => a.route('/api/admin/procurement', adminProcurementRoutes));

    const register = await get(app, '/api/admin/procurement/documents?awaiting=1');
    assert.equal(register.status, 403, 'the register itself stays the owner’s');
    assert.equal((await json(register)).code, 'COST_ACCESS_DENIED');

    const list = await json(await get(app, '/api/admin/procurement/receiving'));
    assert.deepEqual((list.purchases as Array<{ id: string }>).map((p) => p.id), ['po1'], `${role} finds the shipment`);
    assert.deepEqual(leaks(list), [], `${role}: the list carries no cost`);
    const doc = await json(await get(app, '/api/admin/procurement/receiving/po1'));
    assert.equal(doc.purchase.ready, true);
    assert.deepEqual((doc.lines as Array<Record<string, unknown>>).map((l) => [l.line_id, l.qty_ordered, l.qty_received]), [['pl1', 2, 0]]);
    assert.deepEqual(leaks(doc), [], `${role}: the document view carries no cost`);
    for (const key of ['purchase_unit_iqd', 'charges_iqd', 'exchange_rate', 'source_unit_amount', 'selling_price_iqd', 'funding', 'payments']) {
      assert.ok(!JSON.stringify(doc).includes(`"${key}"`), `${role}: no ${key} in the receiving view`);
    }

    const received = await post(app, '/api/admin/procurement/documents/po1/receive', {
      operation_id: `rm-po1-${role}`,
      lines: [{ line_id: 'pl1', qty: 1 }],
    });
    assert.equal(received.status, 200, JSON.stringify(await received.clone().json()));
    assert.deepEqual(leaks(await json(received)), []);
    assert.equal(row(raw, 'SELECT qty_received AS q FROM incoming_inventory WHERE id = ?', 'inc2')!.q, 1, `${role} received the unit`);
  }
});

test('nested cost doors charge the rate limit once per request (the profit report is behind two)', async () => {
  // `/api/admin/finance`'s door also runs on `/api/admin/finance/report/*`,
  // whose own router wears the same door: one owner GET counted twice
  // against the budget every finance router shares.
  const { adminFinanceRoutes } = await import('../worker/routes/adminFinance');
  const { adminFinanceReportRoutes } = await import('../worker/routes/adminFinanceReport');
  const raw = freshDb();
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin/finance', adminFinanceRoutes);
    a.route('/api/admin/finance/report', adminFinanceReportRoutes);
  });
  await get(app, '/api/admin/finance/report/summary');
  const counts = all<{ key: string; count: number }>(raw, "SELECT key, count FROM rate_limits WHERE key LIKE 'finance-read%'");
  assert.equal(counts.length, 1, JSON.stringify(counts));
  assert.equal(counts[0]!.count, 1, 'one request, one charge');
  await get(app, '/api/admin/finance/report/summary');
  assert.equal(all<{ count: number }>(raw, "SELECT count FROM rate_limits WHERE key LIKE 'finance-read%'")[0]!.count, 2);
});
