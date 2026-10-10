/**
 * THE CENTRAL REQUIRED-FIELD LIST (owner brief 2026-10-10: «اخفاء كل المنتجات
 * التي تنقصها التكاليف والحقول الناقصه مع اعلام احمر للحقل الناقص»;
 * worker/lib/productCompleteness.ts, packages/contracts/src/productCompleteness.ts,
 * migration 0184).
 *
 * Proves, on real migrations and SQLite:
 *   - each field of the list is flagged when — and only when — it is missing:
 *     the Arabic name, the price, the cost, the picture, the section (unset or
 *     deleted), the packaged weight, the box;
 *   - the cost is per MODEL: a product whose second model reaches no cost is
 *     flagged on that model, by id; a supplier cost in the USD pricing inputs
 *     satisfies it as well as a dinar cost; a model's own measures satisfy the
 *     weight and the box when the product has none;
 *   - an engine-priced product needs no manual price, needs a minimum profit,
 *     and is NEVER flagged for the environment: no exchange rate, no shipping
 *     rate, a paused engine — only its own data decides;
 *   - compositions are never evaluated; the verdict stores codes only (no value);
 *   - `facts_key` makes the sweep re-evaluate only what moved (the row, a
 *     picture, a pricing input, a global rule) and the sweep spends no more than
 *     its budget;
 *   - `held` is decided inside the upsert from the switch as stored at that
 *     instant, and a stale verdict never overwrites a newer product row;
 *   - a non-owner reads one OWNER_DATA item for any private code.
 *
 * Run: node --import tsx --test tests/productCompleteness.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb } from './fixtures/app';
import { seedCatalog, seedProduct } from './fixtures/completeness';
import {
  COMPLETENESS_CHUNK,
  parseMissing,
  projectItems,
  recomputeCompleteness,
  recomputeCost,
  scanStale,
  sweepCompleteness,
} from '../worker/lib/productCompleteness';
import { statementBudget } from '../worker/lib/fx/budget';
import { countingD1 } from '../worker/lib/d1Count';
import { COMPLETENESS_CODES, COMPLETENESS_ENTRIES } from '../packages/contracts/src/productCompleteness';

function db(setup: (raw: ReturnType<typeof freshDb>) => void) {
  const raw = freshDb();
  seedCatalog(raw);
  setup(raw);
  return { raw, d1: asD1(raw) };
}

async function codesOf(d1: D1Database, id: string): Promise<string[]> {
  const r = await recomputeCompleteness(d1, [id]);
  const v = r.verdicts.find((x) => x.id === id);
  assert.ok(v, `a verdict for ${id}`);
  return v.items.map((i) => (i.option_id ? `${i.code}@${i.option_id}` : i.code));
}

test('a product with every field is complete; each missing field is flagged alone', async () => {
  const cases: Array<[string, Parameters<typeof seedProduct>[1], string[]]> = [
    ['complete', { id: 'p', slug: 'p' }, []],
    ['no Arabic name', { id: 'p', slug: 'p', name_ar: '   ' }, ['NAME_AR']],
    ['price zero', { id: 'p', slug: 'p', price_iqd: 0 }, ['PRICE']],
    ['no cost', { id: 'p', slug: 'p', product_cost_iqd: null }, ['COST']],
    ['cost zero', { id: 'p', slug: 'p', product_cost_iqd: 0 }, ['COST']],
    ['no picture', { id: 'p', slug: 'p', image: false }, ['IMAGE']],
    ['no section', { id: 'p', slug: 'p', category_id: null }, ['CATEGORY']],
    ['no packaged weight', { id: 'p', slug: 'p', package_weight_g: null }, ['PACKAGE_WEIGHT']],
    ['no box', { id: 'p', slug: 'p', box: null }, ['PACKAGE_BOX']],
    ['half a box', { id: 'p', slug: 'p', box: [300, 0, 100] }, ['PACKAGE_BOX']],
  ];
  for (const [name, seed, want] of cases) {
    const { d1 } = db((raw) => seedProduct(raw, seed));
    assert.deepEqual(await codesOf(d1, 'p'), want, name);
  }
});

test('a section that is deleted makes its products incomplete', async () => {
  const { raw, d1 } = db((r) => {
    r.exec(`INSERT INTO catalogs (id, slug, name_ar, name_en, name_ckb, sort, active) VALUES ('cat_gone', 'gone-section', 'قسم', 'Gone', 'بەش', 1, 1)`);
    seedProduct(r, { id: 'p', slug: 'p', category_id: 'cat_gone' });
  });
  assert.deepEqual(await codesOf(d1, 'p'), []);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`DELETE FROM catalogs WHERE id = 'cat_gone'`);
  raw.exec('PRAGMA foreign_keys = ON');
  assert.deepEqual(await codesOf(d1, 'p'), ['CATEGORY']);
});

test('the cost is per model: the model that reaches none is flagged by its id; a cell or a route cost counts', async () => {
  const { raw, d1 } = db((r) => {
    seedProduct(r, { id: 'p', slug: 'p', product_cost_iqd: null });
    r.exec(`
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g', 'p', 'Model', 0, 1);
      INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, cost_iqd) VALUES
        ('o_a', 'p', 'g', 'A', 0, 1, 5, 50000),
        ('o_b', 'p', 'g', 'B', 1, 1, 5, NULL),
        ('o_c', 'p', 'g', 'C', 2, 1, 5, NULL);
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, cost_iqd) VALUES
        ('f_c', 'p', 'o_c', 'direct_sale', 1, 61000);
    `);
  });
  assert.deepEqual(await codesOf(d1, 'p'), ['COST@o_b']);
  // A disabled model is not sold: it needs no cost.
  raw.exec(`UPDATE product_option_values SET active = 0 WHERE id = 'o_b'`);
  raw.exec(`UPDATE products SET updated_at = '2026-10-02T00:00:00.000Z' WHERE id = 'p'`);
  assert.deepEqual(await codesOf(d1, 'p'), []);
});

test('a supplier cost in the USD pricing inputs satisfies the cost as well as a dinar cost does', async () => {
  const { raw, d1 } = db((r) => seedProduct(r, { id: 'p', slug: 'p', product_cost_iqd: null }));
  assert.deepEqual(await codesOf(d1, 'p'), ['COST']);
  raw.exec(`
    INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, updated_at)
    VALUES ('p', 'base', '', 'MANUAL_OVERRIDE', '412.50', 'USD', 'SOURCE_CURRENCY', '2026-10-02T00:00:00.000Z');
  `);
  assert.deepEqual(await codesOf(d1, 'p'), []);
});

test('a model whose own measures are set satisfies the weight and the box when the product has none', async () => {
  const { d1 } = db((r) => {
    seedProduct(r, { id: 'p', slug: 'p', package_weight_g: null, box: null });
    r.exec(`
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g', 'p', 'Model', 0, 1);
      INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, package_weight_g, package_width_mm, package_depth_mm, package_height_mm) VALUES
        ('o_a', 'p', 'g', 'A', 0, 1, 5, 900, 100, 100, 100),
        ('o_b', 'p', 'g', 'B', 1, 1, 5, 950, 110, 100, 100);
    `);
  });
  assert.deepEqual(await codesOf(d1, 'p'), []);
});

test('an engine product: no manual price needed, a minimum profit needed — and the environment never flags it', async () => {
  const { raw, d1 } = db((r) => {
    seedProduct(r, { id: 'p', slug: 'p', product_cost_iqd: null, price_iqd: 0 });
    // The engine's own tokens, as its writer holds them inside its batch.
    r.exec(`
      INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, shipping_profile, shipping_weight_g, updated_at)
      VALUES ('p', 'base', '', 'MANUAL_OVERRIDE', '412.50', 'USD', 'SOURCE_CURRENCY', 'CHINA_AIR', 8200, '2026-10-02T00:00:00.000Z');
      INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:p', 1);
      INSERT INTO product_pricing_state (product_id, mode) VALUES ('p', 'engine');
      DELETE FROM ops_guards WHERE id = 'pricing-mode:p';
    `);
  });
  // No exchange rate, no shipping rate, no minimum profit anywhere: only the minimum profit is the product's own gap.
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM pricing_fx_rates WHERE rate_iqd IS NOT NULL").get()!.n, 0, 'no exchange rate is set');
  assert.deepEqual(await codesOf(d1, 'p'), ['ENGINE_INPUTS']);
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:p', 1);
            INSERT INTO pricing_rules (id, kind, scope, product_id, scope_id, state, amount_usd, updated_at)
            VALUES ('r1', 'target_profit', 'product', 'p', '', 'ACTIVE', '25', '2026-10-02T00:00:00.000Z');
            DELETE FROM ops_guards WHERE id = 'engine-price:p';`);
  assert.deepEqual(await codesOf(d1, 'p'), [], 'complete with no rate and a paused or idle engine: the environment never hides a product');
  // The engine's last repricing blocked for an ENVIRONMENT reason: still complete; for an INPUT reason: flagged.
  raw.exec(`UPDATE product_pricing_state SET reprice_blocked_code = 'FX_RATE_MISSING', reprice_blocked_at = '2026-10-02T00:00:00.000Z' WHERE product_id = 'p'`);
  assert.deepEqual(await codesOf(d1, 'p'), []);
  raw.exec(`UPDATE product_pricing_state SET reprice_blocked_code = 'WEIGHT_MISSING' WHERE product_id = 'p'`);
  assert.deepEqual(await codesOf(d1, 'p'), ['ENGINE_INPUTS']);
});

test('compositions are never evaluated; the stored verdict carries codes and model ids only', async () => {
  const { raw, d1 } = db((r) => {
    seedProduct(r, { id: 'p', slug: 'p', product_cost_iqd: null, image: false });
    seedProduct(r, { id: 'b', slug: 'b', composition: 'bundle', product_cost_iqd: null });
  });
  const r = await recomputeCompleteness(d1, ['p', 'b']);
  assert.deepEqual(r.verdicts.map((v) => v.id), ['p']);
  const row = raw.prepare("SELECT * FROM product_completeness WHERE product_id = 'p'").get()!;
  assert.equal(row.complete, 0);
  assert.equal(row.missing_count, 2);
  assert.equal(row.private_missing, 1);
  assert.equal(row.held, 0, 'the switch is off');
  assert.deepEqual(parseMissing(row.missing_json), [
    { code: 'COST', option_id: '' },
    { code: 'IMAGE', option_id: '' },
  ]);
  assert.doesNotMatch(String(row.missing_json), /\d{4,}/, 'no number travels in the verdict');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM product_completeness WHERE product_id = 'b'").get()!.n, 0);
});

test('a non-owner reads one OWNER_DATA item in place of every private code', () => {
  const items = [
    { code: 'COST' as const, option_id: 'o_a' },
    { code: 'COST' as const, option_id: 'o_b' },
    { code: 'ENGINE_INPUTS' as const, option_id: '' },
    { code: 'IMAGE' as const, option_id: '' },
  ];
  assert.deepEqual(projectItems(items, true), items);
  assert.deepEqual(projectItems(items, false), [
    { code: 'IMAGE', option_id: '' },
    { code: 'OWNER_DATA', option_id: '' },
  ]);
  assert.deepEqual(projectItems([{ code: 'IMAGE', option_id: '' }], false), [{ code: 'IMAGE', option_id: '' }]);
  for (const c of COMPLETENESS_CODES) assert.equal(COMPLETENESS_ENTRIES[c].private, c === 'COST' || c === 'ENGINE_INPUTS', c);
});

test('held is decided inside the upsert from the switch as stored; a stale verdict never overwrites a newer row', async () => {
  const { raw, d1 } = db((r) => seedProduct(r, { id: 'p', slug: 'p', product_cost_iqd: null }));
  raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('catalogHideIncomplete', '{"enabled":true,"since":null,"by":null}')`);
  const r = await recomputeCompleteness(d1, ['p']);
  assert.deepEqual(r.flipped, ['p'], 'held now: its page is purged');
  assert.equal(raw.prepare("SELECT held FROM product_completeness WHERE product_id = 'p'").get()!.held, 1);
  // The product row moves after the facts were read: the old verdict is not written over it.
  raw.exec(`UPDATE products SET product_cost_iqd = 50000 WHERE id = 'p'`); // updated_at unchanged: a write the facts cannot see
  const facts = (await scanStale(d1)).facts.filter((f) => f.id === 'p');
  raw.exec(`UPDATE products SET updated_at = '2026-10-05T00:00:00.000Z' WHERE id = 'p'`);
  await recomputeCompleteness(d1, ['p'], { facts });
  assert.equal(raw.prepare("SELECT complete FROM product_completeness WHERE product_id = 'p'").get()!.complete, 0, 'the fenced upsert wrote nothing');
  await recomputeCompleteness(d1, ['p']);
  assert.deepEqual(
    { ...raw.prepare("SELECT complete, held FROM product_completeness WHERE product_id = 'p'").get()! },
    { complete: 1, held: 0 }
  );
});

test('facts_key: the sweep re-evaluates only what moved — the row, a picture, a pricing input, a global rule', async () => {
  const { raw, d1 } = db((r) => {
    for (let i = 0; i < 3; i++) seedProduct(r, { id: `p${i}`, slug: `p${i}` });
  });
  assert.equal((await scanStale(d1)).stale.length, 3, 'never evaluated');
  const sweep = await sweepCompleteness(d1, statementBudget(200));
  assert.equal(sweep.recomputed, 3);
  assert.equal((await scanStale(d1)).stale.length, 0);
  raw.exec(`UPDATE products SET updated_at = '2026-10-09T00:00:00.000Z' WHERE id = 'p0'`);
  raw.exec(`DELETE FROM product_images WHERE product_id = 'p1'`);
  assert.deepEqual((await scanStale(d1)).stale.map((f) => f.id).sort(), ['p0', 'p1']);
  await sweepCompleteness(d1, statementBudget(200));
  assert.equal((await scanStale(d1)).stale.length, 0);
  assert.equal(raw.prepare("SELECT complete FROM product_completeness WHERE product_id = 'p1'").get()!.complete, 0);
  raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, updated_at) VALUES ('p2', 'base', '', 'MANUAL_OVERRIDE', 900, '2026-10-09T00:00:00.000Z')`);
  assert.deepEqual((await scanStale(d1)).stale.map((f) => f.id), ['p2']);
  await sweepCompleteness(d1, statementBudget(200));
  raw.exec(`INSERT INTO pricing_rules (id, kind, scope, scope_id, state, amount_usd, updated_at) VALUES ('rg', 'target_profit', 'global', '', 'ACTIVE', '20', '2026-10-09T00:00:00.000Z')`);
  assert.equal((await scanStale(d1)).stale.length, 3, 'a global rule moves every product');
});

test('the sweep spends no more than its budget, and nothing at all when none is left', async () => {
  const { d1, raw } = db((r) => {
    for (let i = 0; i < 40; i++) seedProduct(r, { id: `p${String(i).padStart(2, '0')}`, slug: `p${i}` });
  });
  const counted = countingD1(d1);
  const before = counted.executed;
  const budget = statementBudget(30);
  const report = await sweepCompleteness(counted.db, budget);
  const spent = counted.executed - before;
  assert.ok(spent <= 30, `spent ${spent} of 30`);
  assert.ok(report.recomputed > 0 && report.recomputed < COMPLETENESS_CHUNK, `recomputed ${report.recomputed}`);
  assert.equal(recomputeCost(report.recomputed) - 2 + 3 <= 30, true);
  const none = await sweepCompleteness(counted.db, statementBudget(0));
  assert.equal(none.statements, 0);
  // Tick after tick, every product ends evaluated.
  for (let i = 0; i < 10 && (await scanStale(d1)).stale.length; i++) await sweepCompleteness(d1, statementBudget(60));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM product_completeness').get()!.n, 40);
});
