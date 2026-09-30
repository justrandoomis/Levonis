/**
 * THE ESTIMATE CONTRACT (docs/MERCHANT_PLATFORM_V2.md §4.1 E1–E4).
 *
 * Two pricing engines, one public shape. What these pin:
 *
 *   E1  both routes answer `estimate` in the contract's shape, and the whole
 *       public payload never serialises `cost_`, `floor_`, `margin_` or `lines`
 *   E2  factors are ordinal buckets (≥ 40 % most, ≥ 15 % some, else omitted)
 *       and covers come from the line keys, never the amounts
 *   E4  the quantity curve carries 1, 2, 5, 10 and the requested count, is
 *       ascending, and its unit price does not rise with the count on a
 *       plain part — each point a pure re-run, never an interpolation
 *
 * Real migrations and the real routers through the D1 adapter; only the
 * session lookup is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { asD1, freshDb, json, post, stubApp } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { analyseModel, type ModelAnalysis } from '../worker/lib/modelGeometry';
import { DEFAULT_MATERIALS, DEFAULT_PRICING, quotePrint, type Quote } from '../worker/lib/printPricing';
import {
  ESTIMATE_CURVE_QUANTITIES,
  ESTIMATE_EXCLUDE_KEYS,
  ESTIMATE_FACTOR_KEYS,
  ESTIMATE_FORBIDDEN_FRAGMENTS,
  ESTIMATE_REASON_CODES,
  fromEngineA,
  quantityCurve,
  type Estimate,
} from '../worker/lib/printEstimate';
import { coversFrom, excludesFrom, factorsFrom } from '../worker/lib/printEstimate/explain';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { printQuoteRoutes } from '../worker/routes/printQuote';

// ---------------------------------------------------------------- fixtures

function boxTriangles(sx: number, sy: number, sz: number): number[][] {
  const v = (i: number, j: number, k: number) => [i * sx, j * sy, k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  return [
    [p000, p110, p100].flat(), [p000, p010, p110].flat(),
    [p001, p101, p111].flat(), [p001, p111, p011].flat(),
    [p000, p100, p101].flat(), [p000, p101, p001].flat(),
    [p010, p011, p111].flat(), [p010, p111, p110].flat(),
    [p000, p001, p011].flat(), [p000, p011, p010].flat(),
    [p100, p110, p111].flat(), [p100, p111, p101].flat(),
  ];
}

function binaryStl(triangles: number[][]): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, triangles.length, true);
  let at = 84;
  for (const t of triangles) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
}

const cubeBytes = (mm: number) => binaryStl(boxTriangles(mm, mm, mm));
const cube = (mm: number): ModelAnalysis => analyseModel(cubeBytes(mm), 'c.stl');

const CONTRACT_KEYS = [
  'priced', 'price_iqd', 'price_low_iqd', 'price_high_iqd', 'unit_price_iqd', 'quantity',
  'confidence', 'reasons', 'factors', 'covers', 'excludes', 'quantity_curve',
  'material_id', 'process', 'time_minutes', 'material_grams', 'engine',
].sort();
const OPTIONAL_KEYS = new Set(['reason', 'range_basis']);

/** The shape, exactly — no extra key can ride in, no listed key can be missing. */
function assertContractShape(e: Estimate, label: string) {
  const keys = Object.keys(e).filter((k) => !OPTIONAL_KEYS.has(k)).sort();
  assert.deepEqual(keys, CONTRACT_KEYS, `${label}: keys`);
  assert.ok(['high', 'medium', 'low'].includes(e.confidence), `${label}: confidence`);
  for (const r of e.reasons) assert.ok((ESTIMATE_REASON_CODES as readonly string[]).includes(r), `${label}: reason ${r}`);
  for (const f of e.factors) {
    assert.ok((ESTIMATE_FACTOR_KEYS as readonly string[]).includes(f.key), `${label}: factor ${f.key}`);
    assert.ok(f.weight === 'most' || f.weight === 'some', `${label}: weight ${f.weight}`);
  }
  for (const k of e.covers) assert.ok((ESTIMATE_FACTOR_KEYS as readonly string[]).includes(k), `${label}: cover ${k}`);
  for (const k of e.excludes) assert.ok((ESTIMATE_EXCLUDE_KEYS as readonly string[]).includes(k), `${label}: exclude ${k}`);
  assert.ok(e.engine.name === 'print-pricing' || e.engine.name === 'print-quote');
  assert.ok(Number.isInteger(e.engine.version) && e.engine.version >= 1);
}

function assertNoLeak(payload: unknown, label: string) {
  const text = JSON.stringify(payload);
  for (const fragment of ESTIMATE_FORBIDDEN_FRAGMENTS) {
    assert.ok(!text.includes(fragment), `${label}: public payload carries '${fragment}'`);
  }
}

function assertCurve(e: Estimate, requested: number, label: string) {
  const qtys = e.quantity_curve.map((p) => p.qty);
  for (const q of [...ESTIMATE_CURVE_QUANTITIES, requested]) assert.ok(qtys.includes(q), `${label}: curve lacks ×${q}`);
  assert.deepEqual(qtys, [...qtys].sort((a, b) => a - b), `${label}: curve ascending`);
  assert.equal(new Set(qtys).size, qtys.length, `${label}: one point per quantity`);
  for (let i = 1; i < e.quantity_curve.length; i++) {
    assert.ok(
      e.quantity_curve[i].unit_iqd <= e.quantity_curve[i - 1].unit_iqd,
      `${label}: unit price rose from ×${qtys[i - 1]} to ×${qtys[i]} (${JSON.stringify(e.quantity_curve)})`
    );
  }
  const asked = e.quantity_curve.find((p) => p.qty === requested)!;
  assert.equal(asked.unit_iqd, e.unit_price_iqd, `${label}: the curve's point at the asked count IS the unit price`);
}

// --------------------------------------------------------- the pure adapters

test('engine A folds into the contract: the shape, the curve, and not one cost figure', () => {
  const run = (quantity: number) =>
    quotePrint(
      { analysis: cube(50), materialId: 'pla', quality: 'standard', infill: 0.2, quantity, colors: 1, supports: true, post_processing_minutes: 0 },
      DEFAULT_MATERIALS,
      DEFAULT_PRICING
    );
  const q = run(3);
  const e = fromEngineA(q, { quantity: 3, curve: quantityCurve(3, (n) => run(n).unit_price_iqd) });

  assertContractShape(e, 'A');
  assertNoLeak(e, 'A');
  assert.equal(e.priced, true);
  assert.equal(e.price_iqd, q.price_iqd);
  assert.equal(e.price_low_iqd, q.price_low_iqd);
  assert.equal(e.price_high_iqd, q.price_high_iqd);
  assert.equal(e.unit_price_iqd, q.unit_price_iqd);
  assert.equal(e.quantity, 3);
  assert.equal(e.confidence, q.confidence);
  assert.equal(e.material_id, 'pla');
  assert.equal(e.process, 'fdm');
  assert.equal(e.time_minutes, q.total_time_minutes);
  assert.equal(e.material_grams, q.material_grams);
  assert.deepEqual(e.engine, { name: 'print-pricing', version: 2 });
  assert.deepEqual(e.excludes, ['delivery'], 'delivery is outside every estimate until it is priced in');
  // Every line that charged anything is covered, in the contract's words.
  assert.ok(e.covers.includes('material') && e.covers.includes('machine') && e.covers.includes('labor'));
  assert.ok(e.factors.length >= 1 && e.factors.length <= 3);
  assertCurve(e, 3, 'A');
});

test('an unpriced quote is an unpriced estimate with its reason, and still leaks nothing', () => {
  const q = quotePrint(
    { analysis: cube(20), materialId: 'unobtainium', quality: 'standard', infill: 0.2, quantity: 2, colors: 1, supports: true, post_processing_minutes: 0 },
    DEFAULT_MATERIALS,
    DEFAULT_PRICING
  );
  const e = fromEngineA(q, { quantity: 2, curve: [] });
  assertContractShape(e, 'unpriced');
  assertNoLeak(e, 'unpriced');
  assert.equal(e.priced, false);
  assert.equal(e.reason, 'MATERIAL_UNKNOWN');
  assert.deepEqual(e.reasons, ['MATERIAL_UNKNOWN']);
  assert.equal(e.price_iqd, 0);
  assert.deepEqual(e.quantity_curve, []);
  assert.deepEqual(e.factors, []);
});

test('factors are ordinal buckets of the cost shares: ≥ 40 % most, ≥ 15 % some, else omitted (E2)', () => {
  // Synthetic lines, so the thresholds are tested at their edges rather than
  // wherever a real cube happens to land.
  const lines: Quote['cost_lines'] = [
    { key: 'material', iqd: 500 }, // + waste 100 → 600 of 1,000 = 60 %  → most
    { key: 'waste', iqd: 100 },
    { key: 'machine', iqd: 250 }, //                250 of 1,000 = 25 %  → some
    { key: 'setup', iqd: 100 }, //                  100 of 1,000 = 10 %  → omitted
    { key: 'energy', iqd: 50 }, // folds into machine: 300 of 1,000 = 30 % → some
  ];
  const q: Quote = {
    priced: true, process: 'fdm', material_id: 'pla', printed_volume_cm3: 1, material_grams: 1,
    print_time_minutes: 1, total_time_minutes: 2, cost_lines: lines, cost_iqd: 1000, price_iqd: 1500,
    price_low_iqd: 1250, price_high_iqd: 1750, floor_iqd: 1250, margin_percent: 33, confidence: 'high',
    confidence_reasons: [], unit_price_iqd: 1500, accessory_lines: [], accessories_unknown: [],
  };
  const e = fromEngineA(q, { quantity: 1, curve: [{ qty: 1, unit_iqd: 1500 }] });
  assert.deepEqual(e.factors, [
    { key: 'material', weight: 'most' },
    { key: 'machine', weight: 'some' },
  ]);
  // Covers name every key that charged anything — the 10 % setup included —
  // in canonical order, and say nothing about how much.
  assert.deepEqual(e.covers, ['material', 'machine', 'labor']);
  assertNoLeak(e, 'buckets');

  // Exactly at the thresholds.
  assert.deepEqual(factorsFrom([{ key: 'material', iqd: 40 }, { key: 'machine', iqd: 45 }, { key: 'labor', iqd: 15 }]), [
    { key: 'machine', weight: 'most' },
    { key: 'material', weight: 'most' },
    { key: 'labor', weight: 'some' },
  ]);
  assert.deepEqual(factorsFrom([{ key: 'material', iqd: 86 }, { key: 'labor', iqd: 14 }]), [{ key: 'material', weight: 'most' }]);
  assert.deepEqual(factorsFrom([]), []);
  // A zero line is not in the price and is not a cover.
  assert.deepEqual(coversFrom([{ key: 'labor', iqd: 0 }, { key: 'support', iqd: 3 }, { key: 'material', iqd: 9 }]), ['material', 'support']);
  assert.deepEqual(excludesFrom(['machine', 'delivery', 'delivery']), ['delivery', 'machine']);
});

test('the quantity curve is 1, 2, 5, 10 and the asked count, ascending, one point each (E4)', () => {
  assert.deepEqual(
    quantityCurve(5, (q) => 100 - q).map((p) => p.qty),
    [1, 2, 5, 10]
  );
  assert.deepEqual(
    quantityCurve(7, (q) => 100 - q).map((p) => p.qty),
    [1, 2, 5, 7, 10]
  );
  // A quantity the engine could not price is left out, never drawn at zero.
  assert.deepEqual(
    quantityCurve(1, (q) => (q === 5 ? null : 50)).map((p) => p.qty),
    [1, 2, 10]
  );
  assert.deepEqual(quantityCurve(0, () => 10)[0], { qty: 1, unit_iqd: 10 });
});

// ------------------------------------------------- the routes, end to end

const marketplaceMount = (a: Hono<AppContext>) => a.route('/api/marketplace/print', printRequestRoutes);
const quoteMount = (a: Hono<AppContext>) => a.route('/api/print-quote', printQuoteRoutes);

test('POST /api/marketplace/print/quote answers the contract beside the quote, with no cost figure anywhere', async () => {
  const raw = freshDb();
  raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES ('u-1', 'u1@x.co', 'U', 'x', 'customer')`).run();
  const a = stubApp(asD1(raw), { id: 'u-1', role: 'customer', email: 'u1@x.co' }, marketplaceMount);

  const body = await json(
    await post(a, '/api/marketplace/print/quote', {
      process: 'fdm',
      material_id: 'pla',
      quality: 'standard',
      quantity: 3,
      analysis: cube(50),
    })
  );
  assert.equal(body.success, true, JSON.stringify(body));
  const e = body.estimate as Estimate;
  assertContractShape(e, '/quote');
  assertNoLeak(body, '/quote');
  assert.equal(e.priced, true);
  assert.equal(e.quantity, 3);
  assert.equal(e.engine.name, 'print-pricing');
  // The engine's own public half is still answered, and agrees with the contract.
  assert.equal(body.quote.price_iqd, e.price_iqd);
  assert.equal(body.quote.unit_price_iqd, e.unit_price_iqd);
  assert.equal(body.quote.confidence, e.confidence);
  assert.equal(body.quote.accessory_lines, undefined, 'the one old field whose NAME breaks the rule is gone');
  assertCurve(e, 3, '/quote');

  // A material left open is a range across the catalogue, and says so.
  const open = await json(
    await post(a, '/api/marketplace/print/quote', { process: 'fdm', material_id: 'unsure', quality: 'standard', quantity: 1, analysis: cube(20) })
  );
  const oe = open.estimate as Estimate;
  assertContractShape(oe, '/quote unsure');
  assertNoLeak(open, '/quote unsure');
  assert.equal(oe.range_basis, 'materials');
  assert.equal(oe.material_id, '');
  assert.ok(oe.reasons.includes('MATERIAL_NOT_CHOSEN'));
  assert.ok(oe.price_high_iqd > oe.price_low_iqd);
  assertCurve(oe, 1, '/quote unsure');

  // Nothing to price is an unpriced estimate, not an error and not a guess.
  const bare = await json(await post(a, '/api/marketplace/print/quote', { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 }));
  assert.equal(bare.success, true);
  assert.equal(bare.estimate.priced, false);
  assert.equal(bare.estimate.reason, 'NO_GEOMETRY');
  assertNoLeak(bare, '/quote bare');
});

test('POST /api/print-quote/analyses/:id/quote answers the same contract for a guest, with no cost figure anywhere', async () => {
  const raw = freshDb();
  const bytes = cubeBytes(20);
  const bucket = {
    put: async () => ({}),
    get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    head: async () => null,
    delete: async () => undefined,
  };
  const a = stubApp(asD1(raw), null, quoteMount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  const form = new FormData();
  form.append('file', new File([bytes], 'cube.stl', { type: 'application/octet-stream' }));
  form.append('guest_token', 'tok-guest-e1');
  const up = await json(await a.request('/api/print-quote/uploads', { method: 'POST', body: form }));
  const id = up.analysis_id as string;
  assert.ok(id, JSON.stringify(up));
  const h = { 'X-Guest-Token': 'tok-guest-e1' };
  const measured = await json(await post(a, `/api/print-quote/analyses/${id}/measure`, { printer_model_id: 'bbl-a1m', material_id: 'pla' }, h));
  assert.equal(measured.success, true, JSON.stringify(measured));

  // No filament price in the seed: the estimate says it could not price, and
  // says why in the contract's own words.
  const unpriced = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(unpriced.success, true, JSON.stringify(unpriced));
  assertContractShape(unpriced.estimate, '/analyses unpriced');
  assertNoLeak(unpriced, '/analyses unpriced');
  assert.equal(unpriced.estimate.priced, false);
  assert.equal(unpriced.estimate.reason, 'MATERIAL_NOT_PRICED');

  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  const body = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(body.success, true, JSON.stringify(body));
  const e = body.estimate as Estimate;
  assertContractShape(e, '/analyses');
  assertNoLeak(body, '/analyses');
  assert.equal(e.priced, true);
  assert.equal(e.quantity, 1);
  assert.equal(e.engine.name, 'print-quote');
  assert.equal(e.process, 'fdm');
  assert.equal(e.material_id, 'pla');
  assert.equal(e.confidence, 'medium', 'modelled on the Worker, not sliced — never claims to be exact');
  assert.deepEqual(e.reasons, ['NOT_SLICED']);
  assert.equal(e.price_iqd, body.quote.price_iqd);
  assert.equal(e.price_low_iqd, body.quote.range_iqd.low);
  assert.equal(e.price_high_iqd, body.quote.range_iqd.high);
  assert.ok(e.time_minutes > 0 && e.material_grams > 3 && e.material_grams < 4, `${e.time_minutes} min, ${e.material_grams} g`);
  assert.ok(e.covers.includes('material') && e.covers.includes('labor'));
  assert.deepEqual(e.excludes, ['delivery']);
  assertCurve(e, 1, '/analyses');
});
