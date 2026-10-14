/**
 * PRICING V2-3 — THE LOCKS AND THE DOORS OF A V2 PRODUCT (spec §3.3 step 4,
 * §3.4, §3.5, §2.6; C-1, C-11).
 *
 * A V2 product is `mode = 'engine'` with a method, so every 0181/0183/0188
 * ENGINE_MANAGED lock already covers it. Proves, on a V2 product:
 *   - every V1 pricing door answers PRICING_V2_MANAGED with its section
 *     (inputs, preview, rules, targets adopt, the price grid's and the
 *     selection price's guard), the exit to manual PRICING_V2_NO_MANUAL, the
 *     purchase apply PRICING_V2_MANAGED (D1: the purchase becomes a price review) — and V1's own evaluation
 *     refuses to plan it, so V1's bulk save reports it refused;
 *   - a structure edit (a new model with a direct cell) through the V2 save
 *     commits structure, prices and results in ONE batch — and the very same
 *     statements without the token are ENGINE_MANAGED at the database;
 *   - a commission or a direct surcharge is refused by the fee trigger
 *     (PRICING_V2_FEES_RETIRED), the token notwithstanding;
 *   - the method flips only under the mode token, and a V2 product never drops
 *     to manual, even from an older Worker's raw statement.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2Locks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, json, post, put, row } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { v2Context, writeV2, cartGrid } from './fixtures/pricingV2';
import { applyRelations } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import { evaluateV2Write } from '../worker/lib/pricingEngine/v2/evaluate';
import { v2WriteStatements } from '../worker/lib/pricingEngine/v2/write';
import { evaluateEngineWrite } from '../worker/lib/pricingEngine/engineWrite';
import { refuseEngineManaged } from '../worker/lib/engineInstalled';
import { HttpError } from '../worker/lib/http';

type World = ReturnType<typeof pricingWorld>;

const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });
const MODEL = `${AMS}_o0`;
const NEW = `${AMS}_o9`;

async function v2Ams(w: World) {
  return writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
}

const refusal = async (res: Response) => ({ status: res.status, body: await json(res) });

test('every V1 door of a V2 product refuses with its code and section; V1 never plans it', async () => {
  const w = pricingWorld();
  await v2Ams(w);
  const seq = row<{ s: number; w: number }>(w.raw, 'SELECT inputs_seq AS s, write_seq AS w FROM product_pricing_state WHERE product_id = ?', AMS)!;
  const doors: Array<[string, () => Response | Promise<Response>, string]> = [
    ['PUT inputs', () => put(w.app, `/api/admin/pricing/products/${AMS}/inputs`, { inputs_seq: seq.s, inputs: [], rules: [] }), 'PRICING_V2_MANAGED'],
    ['POST preview', () => post(w.app, `/api/admin/pricing/products/${AMS}/preview`, { draft: {} }), 'PRICING_V2_MANAGED'],
    ['PUT rules', () => put(w.app, `/api/admin/pricing/products/${AMS}/rules`, { rules: [] }), 'PRICING_V2_MANAGED'],
    ['POST targets/adopt', () => post(w.app, `/api/admin/pricing/products/${AMS}/targets/adopt`, { legacy_hash: 'a'.repeat(64) }), 'PRICING_V2_MANAGED'],
    ['POST manual', () => post(w.app, `/api/admin/pricing/products/${AMS}/manual`, { write_seq: seq.w }), 'PRICING_V2_NO_MANUAL'],
    ['POST apply-purchase', () => post(w.app, `/api/admin/pricing/products/${AMS}/apply-purchase`, { purchase_id: 'pur_12345678', preview_hash: 'b'.repeat(64) }), 'PRICING_V2_MANAGED'],
  ];
  // One request at a time (the test binding runs one transaction at a time).
  for (const [name, send, code] of doors) {
    const r = await refusal(await send());
    assert.equal(r.status, 409, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code, name);
    assert.equal(r.body.details?.section, 3, `${name} names the section`);
    assert.equal(r.body.details?.v2, true, `${name}: the old panel hides itself`);
    assert.doesNotMatch(JSON.stringify(r.body), /1600000|1520000|\b1600\b/, `${name}: a refusal carries no value`);
  }
  // The legacy price writers (the quick-price grid, the selection price) refuse before planning anything.
  await assert.rejects(refuseEngineManaged(w.db, AMS), (e: unknown) => e instanceof HttpError && e.code === 'PRICING_V2_MANAGED' && e.details?.section === 3);
  await assert.rejects(refuseEngineManaged(w.db, AMS, 5), (e: unknown) => e instanceof HttpError && e.details?.section === 5);
  // V1's evaluation of a V2 product is a refusal: no plan, no hash, nothing V1 could write.
  const c = await v2Context(w.db, AMS);
  const ev = await evaluateEngineWrite({ loaded: c.loaded, stored: c.stored, ctx: c.ctx, rates: c.rates, control: c.control, inputs: c.stored.inputs, inputWrites: [], ruleWrites: [], image: c.image, storedCosts: [] });
  assert.deepEqual([ev.kind, ev.complete, ev.hash, ev.codes], [null, false, null, ['PRICING_V2_MANAGED']]);
  // V1's bulk save reports it refused (never "unchanged", never written).
  const bulk = await json(await post(w.app, '/api/admin/pricing/products/save-bulk', { items: [{ product_id: AMS, preview_hash: 'c'.repeat(64) }] }));
  assert.deepEqual(bulk.results, [{ product_id: AMS, status: 'refused', code: 'PRICING_V2_MANAGED' }]);
  // The old panel's read never fails on a V2 product: it says the product is V2's and offers no V1 save.
  const inputs = await w.getInputs(AMS);
  assert.equal(inputs.status, 200, JSON.stringify(inputs.body).slice(0, 300));
  assert.equal((inputs.body as { v2?: unknown }).v2, true, 'the old panel reads v2 and hides itself');
  assert.doesNotMatch(JSON.stringify(inputs.body), /"preview_hash":"[0-9a-f]{64}"/, 'no V1 hash for a V2 product');
  // V1's stale and ready lists never list a V2 product.
  const list = await json(await (await import('./fixtures/app')).get(w.app, '/api/admin/pricing/save-list'));
  assert.equal([...list.stale.items, ...list.ready.items].some((i: { product_id: string }) => i.product_id === AMS), false);
});

test('a new model through the V2 save commits structure, prices and results in one batch; without the token it is ENGINE_MANAGED', async () => {
  const w = pricingWorld();
  await v2Ams(w);
  const c = await v2Context(w.db, AMS);
  const view = structuredClone(c.loaded.view!);
  const model = view.values.find((v) => v.id === MODEL)!;
  const cell = view.fulfillments.find((f) => f.option_id === MODEL && f.fulfillment_type === 'direct_sale')!;
  view.values.push({ ...model, id: NEW, name_en: 'Combo', sort: 9, regular_price_iqd: null });
  view.fulfillments.push({ ...cell, id: `${NEW}_d`, option_id: NEW, regular_price_iqd: null });
  const draft = { id: AMS, row: c.loaded.row, view, doc: applyRelations(parseProductRow(c.loaded.row), view) };
  const structure = [
    w.db.prepare("INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock) VALUES (?, ?, ?, 'Combo', 9, 1, 5)").bind(NEW, AMS, model.group_id),
    w.db.prepare("INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (?, ?, ?, 'direct_sale', 1)").bind(`${NEW}_d`, AMS, NEW),
  ];

  // The database's own locks: the same statements, no token.
  await assert.rejects(w.db.batch(structure), /ENGINE_MANAGED/);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE id = ?', NEW), 0);

  const ev = await evaluateV2Write({
    loaded: draft,
    stored: c.stored,
    v2: c.v2,
    ctx: c.ctx,
    rates: c.rates,
    control: c.control,
    method: 'usd',
    points: [fixed('1000')],
    discounts: [off('50')],
    inputWrites: [],
    ruleWrites: [],
    image: c.image,
    structureDigest: 'add-combo',
  });
  assert.equal(ev.complete, true, ev.codes.join(','));
  assert.deepEqual(ev.changes.map((r) => [r.combo_key, r.channel, r.old_iqd, r.new_iqd]), [[`o:${NEW}`, 'direct_sale', null, 1_600_000]], 'the review sheet lists only the new SKU');
  const updatedAt = row<{ u: string }>(w.raw, 'SELECT updated_at AS u FROM products WHERE id = ?', AMS)!.u;
  const statements = await v2WriteStatements(w.db, ev, { actor: 'usr_owner', now: new Date().toISOString(), source: 'product_form', idempotencyKey: `save:${ev.hash}`, structure: [
    w.db.prepare("INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock) VALUES (?, ?, ?, 'Combo', 9, 1, 5)").bind(NEW, AMS, model.group_id),
    w.db.prepare("INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (?, ?, ?, 'direct_sale', 1)").bind(`${NEW}_d`, AMS, NEW),
  ], updatedAt });
  await w.db.batch(statements);
  const grid = await cartGrid(w.db, AMS);
  assert.equal(grid[`o:${NEW}@direct_sale`]!.prepaid, 1_600_000, 'the new model sells at its V2 price at once');
  assert.equal(grid[`o:${MODEL}@pre_order_land`]!.prepaid, 1_520_000);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ? AND combo_key = ?', AMS, `o:${NEW}`), 1);

  // A stale edit (the product changed since the read) refuses the whole batch: nothing is written.
  const again = await v2Context(w.db, AMS);
  const ev2 = await evaluateV2Write({ loaded: again.loaded, stored: again.stored, v2: again.v2, ctx: again.ctx, rates: again.rates, control: again.control, method: 'usd', points: [fixed('1100')], discounts: [off('50')], inputWrites: [], ruleWrites: [], image: again.image });
  const stale = await v2WriteStatements(w.db, ev2, { actor: 'usr_owner', now: new Date().toISOString(), source: 'product_form', idempotencyKey: `save:${ev2.hash}`, updatedAt: '1999-01-01T00:00:00.000Z' });
  await assert.rejects(w.db.batch(stale), /CHECK constraint failed/);
  assert.equal((await cartGrid(w.db, AMS))[`o:${MODEL}@direct_sale`]!.prepaid, 1_600_000, 'nothing moved');
});

test('fees stay 0, the method moves only under its token, and a V2 product never drops to manual', async () => {
  const w = pricingWorld();
  await v2Ams(w);
  const exec = (sql: string) => () => w.raw.exec(sql);
  // A commission or a direct surcharge, even under the engine token: the fee trigger refuses it.
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${AMS}', 1)`);
  assert.throws(exec(`UPDATE products SET preorder_transports = '[{"method":"land","commission_iqd":5000,"active":true}]' WHERE id = '${AMS}'`), /PRICING_V2_FEES_RETIRED/);
  assert.throws(exec(`UPDATE products SET preorder_transports = '[{"method":"land","active":true}]' WHERE id = '${AMS}'`), /PRICING_V2_FEES_RETIRED/, 'a route with no commission would fall back to the admin default');
  assert.throws(exec(`UPDATE products SET direct_surcharge_iqd = 1000 WHERE id = '${AMS}'`), /PRICING_V2_FEES_RETIRED/);
  w.raw.exec(`UPDATE products SET preorder_transports = '[{"method":"land","commission_iqd":0,"active":true}]' WHERE id = '${AMS}'`);
  w.raw.exec(`DELETE FROM ops_guards WHERE id = 'engine-price:${AMS}'`);
  // The method: refused without the mode token, allowed with it; a drop to manual is refused either way.
  assert.throws(exec(`UPDATE product_pricing_state SET pricing_method = 'cost' WHERE product_id = '${AMS}'`), /PRICING_MODE_ENGINE_ONLY/);
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${AMS}', 1)`);
  assert.throws(exec(`UPDATE product_pricing_state SET mode = 'manual' WHERE product_id = '${AMS}'`), /PRICING_MODE_ENGINE_ONLY/, 'even an older Worker’s exit cannot drop a V2 product to manual');
  w.raw.exec(`UPDATE product_pricing_state SET pricing_method = 'cost' WHERE product_id = '${AMS}'`);
  w.raw.exec(`UPDATE product_pricing_state SET pricing_method = 'usd' WHERE product_id = '${AMS}'`);
  w.raw.exec(`DELETE FROM ops_guards WHERE id = 'pricing-mode:${AMS}'`);
  // The price rows themselves stay locked like any engine product's.
  assert.throws(exec(`UPDATE products SET price_iqd = 1000 WHERE id = '${AMS}'`), /ENGINE_MANAGED/);
  assert.throws(exec(`UPDATE product_sku_prices SET regular_price_iqd = 1000 WHERE product_id = '${AMS}'`), /ENGINE_MANAGED/);
  assert.throws(exec(`DELETE FROM pricing_v2_sku_results WHERE product_id = '${AMS}'`), /ENGINE_MANAGED/);
});
