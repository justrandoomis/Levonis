/**
 * PRICING V2 — THE REVIEW GATES CANNOT BE SKIPPED (review of feat/pricing-v2-core, 2026-10-14).
 *
 * 1. A data-only save (an incomplete evaluation: no hash, no 15% tick, no fresh
 *    sign-in) is for a product no customer sees yet. On a V2-PUBLISHED product
 *    it is refused (409 PRICING_V2_PRICE_MISSING with the preview) whenever it
 *    would move the price set; otherwise FX-5 would publish it later, unreviewed.
 * 2. FX-5 holds a V2 product whose inputs moved since its last reviewed write
 *    (PRICING_V2_UNREVIEWED), and an unattended run (the FX fetch, the sweep)
 *    holds a change above 15% / a drop above 30% (PRICING_V2_LARGE_CHANGE).
 * 3. The preview hash binds no supplier cost (C-14): an editor's preview of the
 *    same prices answers the same hash whatever the owner's purchase overlay says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, get, json, post, put, row, type StubUser } from './fixtures/app';
import { applyRate, fxEnv } from './fixtures/fx';
import { AMS, pricingWorld } from './fixtures/procurementPricing';
import { cartGrid, v2App, v2Context, writeV2 } from './fixtures/pricingV2';
import { evaluateV2Write } from '../worker/lib/pricingEngine/v2/evaluate';
import { repriceStaleEngineProducts, v2AutoHoldCode } from '../worker/lib/pricingEngine/autoReprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
const fixed = (usd: string) => ({ scope: 'product' as const, id: '', kind: 'fixed' as const, usd });
const envOf = (raw: DatabaseSync): Env => ({ ...fxEnv(raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' }) as Env;
const seqOf = (raw: DatabaseSync, pid: string) => {
  const s = row<{ i: number; w: number; p: number | null }>(raw, 'SELECT inputs_seq AS i, write_seq AS w, priced_inputs_seq AS p FROM product_pricing_state WHERE product_id = ?', pid);
  return { inputs_seq: s?.i ?? 0, write_seq: s?.w ?? 0, priced: s?.p ?? null };
};
const directOf = async (w: ReturnType<typeof pricingWorld>) => (await cartGrid(w.db, AMS))[`o:${AMS}_o0@direct_sale`]!.prepaid;

test('a published product: an editor\'s data-only save while the engine is paused is refused, and nothing is stored', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }], discounts: [] });
  const before = await directOf(w);
  assert.equal(before, 1_600_000);
  w.raw.exec('UPDATE pricing_engine_control SET paused = 1 WHERE id = 1');
  const seq = seqOf(w.raw, AMS);
  const editor = v2App(w.raw, EDITOR, 3 * 3600);
  const res = await put(editor, `/api/admin/products-v2/${AMS}/pricing`, { seq: { inputs_seq: seq.inputs_seq, write_seq: seq.write_seq }, pricing: { points: [fixed('10')] } });
  const out = await json(res);
  assert.equal(res.status, 409);
  assert.equal(out.code, 'PRICING_V2_PRICE_MISSING');
  assert.ok(out.details?.preview ?? out.preview, 'the refusal carries the preview');
  const points = all<{ amount_usd: string }>(w.raw, "SELECT amount_usd FROM pricing_price_points WHERE product_id = ? AND scope = 'product'", AMS);
  assert.deepEqual(points.map((p) => p.amount_usd), ['1000'], 'the stored dollar price did not move');
  assert.deepEqual(seqOf(w.raw, AMS), seq, 'no data row moved');

  // The owner unpauses and the rate moves: FX-5 reprices from the REVIEWED $1,000, never from $10.
  w.raw.exec('UPDATE pricing_engine_control SET paused = 0 WHERE id = 1');
  applyRate(w.raw, 'USD_IQD', '1632');
  const report = await repriceStaleEngineProducts(envOf(w.raw), { trigger: 'fx', budget: statementBudget(600) });
  assert.deepEqual(report.repriced, [AMS]);
  assert.equal(await directOf(w), 1_632_000);
});

test('an unpublished V2 product (method, no results) still saves its data without a price', async () => {
  const w = pricingWorld();
  w.raw.exec('UPDATE pricing_engine_control SET paused = 1 WHERE id = 1');
  const seq = seqOf(w.raw, AMS);
  const owner = v2App(w.raw);
  const res = await put(owner, `/api/admin/products-v2/${AMS}/pricing`, { seq: { inputs_seq: seq.inputs_seq, write_seq: seq.write_seq }, pricing: { method: 'usd', points: [fixed('900')] } });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.saved, 'data');
  // A second data save of the still-unpublished product (no customer sees it) is allowed too.
  const s1 = seqOf(w.raw, AMS);
  const again = await put(owner, `/api/admin/products-v2/${AMS}/pricing`, { seq: { inputs_seq: s1.inputs_seq, write_seq: s1.write_seq }, pricing: { points: [fixed('950')] } });
  assert.equal(again.status, 200, JSON.stringify(await json(again)));
});

test('FX-5 holds a V2 product whose inputs moved since its last reviewed write (PRICING_V2_UNREVIEWED)', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }], discounts: [] });
  const s0 = seqOf(w.raw, AMS);
  assert.equal(s0.priced, s0.inputs_seq, 'a complete write prices the inputs it read');
  // A data row moved outside a reviewed write (an older Worker, a data save before this fix).
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${AMS}', 1);
              UPDATE pricing_price_points SET amount_usd = '10', version = version + 1 WHERE product_id = '${AMS}' AND scope = 'product';
              DELETE FROM ops_guards WHERE id = 'engine-price:${AMS}';`);
  assert.notEqual(seqOf(w.raw, AMS).inputs_seq, s0.priced);
  applyRate(w.raw, 'USD_IQD', '1632');
  const report = await repriceStaleEngineProducts(envOf(w.raw), { trigger: 'fx', budget: statementBudget(600) });
  assert.deepEqual(report.repriced, []);
  assert.deepEqual(report.blocked, [{ product_id: AMS, code: 'PRICING_V2_UNREVIEWED' }]);
  assert.equal(await directOf(w), 1_600_000, 'the customer price stays at the reviewed write');
  const st = row<{ code: string }>(w.raw, 'SELECT reprice_blocked_code AS code FROM product_pricing_state WHERE product_id = ?', AMS)!;
  assert.equal(st.code, 'PRICING_V2_UNREVIEWED');
});

test('v2AutoHoldCode: unattended runs hold a large change; an owner rate act (previewed and ticked) does not', () => {
  const state = { inputs_seq: 4, priced_inputs_seq: 4 };
  const big = { large_change: true, drop_flag: false };
  const drop = { large_change: false, drop_flag: true };
  const small = { large_change: false, drop_flag: false };
  assert.equal(v2AutoHoldCode(state, big, 'fx'), 'PRICING_V2_LARGE_CHANGE');
  assert.equal(v2AutoHoldCode(state, drop, 'sweep'), 'PRICING_V2_LARGE_CHANGE');
  assert.equal(v2AutoHoldCode(state, big, 'owner_rate'), null);
  assert.equal(v2AutoHoldCode(state, big, 'shipping'), null);
  assert.equal(v2AutoHoldCode(state, small, 'fx'), null);
  assert.equal(v2AutoHoldCode({ inputs_seq: 5, priced_inputs_seq: 4 }, small, 'owner_rate'), 'PRICING_V2_UNREVIEWED');
  assert.equal(v2AutoHoldCode({ inputs_seq: 5, priced_inputs_seq: null }, small, 'fx'), 'PRICING_V2_UNREVIEWED');
});

test('FX-5 (the FX fetch) holds a V2 product whose new price moves more than 15%', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }], discounts: [] });
  applyRate(w.raw, 'USD_IQD', '1900');
  const report = await repriceStaleEngineProducts(envOf(w.raw), { trigger: 'fx', budget: statementBudget(600) });
  assert.deepEqual(report.blocked, [{ product_id: AMS, code: 'PRICING_V2_LARGE_CHANGE' }]);
  assert.equal(await directOf(w), 1_600_000);
});

test('C-14: an editor\'s preview hash does not move with the supplier cost folded into its evaluation', async () => {
  const w = pricingWorld();
  const c = await v2Context(w.db, AMS);
  const at = async (amount: string, opaqueCost: boolean) => {
    const ev = await evaluateV2Write({
      ...c,
      method: 'usd',
      points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '100' }],
      discounts: [],
      // The 0186 purchase overlay folded into an editor's evaluation (firstWriteInputs): a cost the editor never sees.
      inputWrites: [{ scope: 'base', scope_id: '', existing: null, set: { supplier_cost_amount: amount, supplier_cost_currency: 'USD' }, source_ref: 'purchase' }],
      ruleWrites: [],
      acceptBlocked: true,
      ...(opaqueCost ? { opaqueCost: true } : {}),
    });
    assert.ok(ev.complete, ev.codes.join(','));
    return { hash: ev.hash!, prices: ev.rows.map((r) => r.new_iqd) };
  };
  const a = await at('450', true);
  const b = await at('451', true);
  assert.deepEqual(a.prices, b.prices, 'price-first: the cost moves no price');
  assert.equal(a.hash, b.hash, 'an editor\'s hash binds no cost value');
  // The owner reads the cost: the owner's hash still binds what is written.
  assert.notEqual((await at('450', false)).hash, (await at('451', false)).hash);
});

test('C-14: an editor\'s stored answer and preview carry the same hash (both the editor\'s own evaluation)', async () => {
  const w = pricingWorld();
  const editor = v2App(w.raw, EDITOR);
  const got = await json(await get(editor, `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(got.success, true);
  assert.equal(got.method, 'usd');
  const res = await post(editor, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { points: [fixed('100')] } });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(typeof out.review_hash, 'string');
  for (const k of ['v2_cost_inputs', 'purchase_review_id']) assert.equal(JSON.stringify(out).includes(k), false, k);
});
