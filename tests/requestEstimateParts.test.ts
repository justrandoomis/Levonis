/**
 * A JOB OF PARTS, PRICED PART BY PART (P1-05, docs/DECISIONS.md row 267, D1;
 * Community V3 R10) — worker/lib/requestEstimate.ts, pure and through the
 * real routes and migrations.
 *
 * Pinned: a PLA part and a TPU part are each priced exactly as `quotePrint`
 * prices that material, that geometry and those pieces, and the totals are
 * the sums (TPU is not PLA); pieces are pieces a set × sets, also on a
 * one-part job (critique 1: 4 × 2 = 8, never 2); a part in two materials is a
 * range across them; a part with nothing to measure is left out, honestly
 * (`complete: false`), and the matcher then knows no job value; a one-part
 * one-material v3 job is priced byte for byte as v1; R10 is counted on read
 * and never stored on a v1 estimate; and no public payload carries a cost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, get, json, post } from './fixtures/app';
import { addFile, as, newDraft, publish, saveDraft, world } from './fixtures/requestModelWorld';
import { analyseModel, type ModelAnalysis } from '../worker/lib/modelGeometry';
import { DEFAULT_MATERIALS, DEFAULT_PRICING, quotePrint, type QuoteInput } from '../worker/lib/printPricing';
import { ESTIMATE_FORBIDDEN_FRAGMENTS, fromEngineA } from '../worker/lib/printEstimate';
import { estimateModel, modelsUnpriced, pricesAsOneJob, unsupportedPart } from '../worker/lib/requestEstimate';
import type { ModelMaterial, ModelPart } from '../worker/lib/requestModel';
import { loadRequestFacts } from '../worker/lib/printMatchingStore';

// ---------------------------------------------------------------- fixtures

function boxStl(mm: number): Uint8Array {
  const v = (i: number, j: number, k: number) => [i * mm, j * mm, k * mm];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  const tris = [
    [p000, p110, p100], [p000, p010, p110], [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001], [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010], [p100, p110, p111], [p100, p111, p101],
  ].map((t) => t.flat());
  const out = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  let at = 84;
  for (const t of tris) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
}
const cube = (mm: number): ModelAnalysis => analyseModel(boxStl(mm), 'c.stl');
const A30 = cube(30);
const A20 = cube(20);

const mat = (id: string, material_id: string, colours = 1): ModelMaterial => ({
  id, position: 0, material_id, material_unsure: false,
  colors: Array.from({ length: colours }, () => ({ mode: 'any' as const, hex: '', label: '', palette: '', ref: '' })),
  finish: '', region_reference: '', requirements: '', colors_need_review: false, created_at: '', updated_at: '',
});
const part = (id: string, position: number, quantity: number, materials: ModelMaterial[], measured: string | null): ModelPart => ({
  id, position, name: id, quantity, process: 'fdm', process_unsure: false, stated_dims: null, measured_file_id: measured,
  notes: '', assembly_notes: '', legacy_text: '', review_state: '', review_reasons: [], reviewed_by: null, reviewed_at: null,
  source_ids: [], materials: materials.map((m, i) => ({ ...m, position: i })), created_at: '', updated_at: '',
});
const job = (quantity: number) => ({ quantity, quality: 'standard', infill_percent: 20, supports: true, post_processing_minutes: 0, source_type: 'model' as const });
const files = [{ id: 'f30', analysis: JSON.stringify(A30) }, { id: 'f20', analysis: JSON.stringify(A20) }];
const ctx = {
  mats: DEFAULT_MATERIALS, cfg: DEFAULT_PRICING, quality: 'standard' as const, infill: 0.2, supports: true,
  postProcessingMinutes: 0, accessories: [], accessoryCatalogue: [],
};
const engine = (analysis: ModelAnalysis, materialId: string, quantity: number, colors = 1) =>
  quotePrint(
    { analysis, materialId, quality: 'standard', infill: 0.2, quantity, colors, supports: true, post_processing_minutes: 0, accessories: [], accessory_catalogue: [] } as QuoteInput,
    DEFAULT_MATERIALS,
    DEFAULT_PRICING
  );

// --------------------------------------------------------------- the pure half

test('15: a PLA part and a TPU part are each priced as quotePrint prices them, and the totals are the sums', () => {
  const m = { job: job(1), parts: [part('pla', 0, 1, [mat('m1', 'pla')], 'f30'), part('tpu', 1, 2, [mat('m2', 'tpu')], 'f20')] };
  assert.equal(pricesAsOneJob(m), false);
  const q = estimateModel(m, files, ctx);
  const a = engine(A30, 'pla', 1);
  const b = engine(A20, 'tpu', 2);
  const cov = q.coverage!;
  assert.equal(cov.complete, true);
  assert.equal(cov.parts_total, 2);
  assert.deepEqual(cov.unpriced_parts, []);
  const [pa, pb] = cov.priced_parts;
  assert.deepEqual([pa.part_id, pa.material_id, pa.pieces, pa.price_iqd, pa.price_low_iqd, pa.price_high_iqd, pa.material_grams],
    ['pla', 'pla', 1, a.price_iqd, a.price_low_iqd, a.price_high_iqd, a.material_grams]);
  assert.deepEqual([pb.part_id, pb.material_id, pb.pieces, pb.price_iqd, pb.price_low_iqd, pb.price_high_iqd, pb.material_grams],
    ['tpu', 'tpu', 2, b.price_iqd, b.price_low_iqd, b.price_high_iqd, b.material_grams]);
  assert.notEqual(b.price_iqd, engine(A20, 'pla', 2).price_iqd, 'TPU is not priced as PLA');
  assert.equal(q.price_iqd, a.price_iqd + b.price_iqd);
  assert.equal(q.price_low_iqd, a.price_low_iqd + b.price_low_iqd);
  assert.equal(q.price_high_iqd, a.price_high_iqd + b.price_high_iqd);
  assert.equal(q.material_id, '', 'two materials: no one material is the job\'s');
  assert.equal(q.unit_price_iqd, q.price_iqd, 'per set: one set');
  // The contract: the coverage rides, the figures are the sums, no cost is in it.
  const e = fromEngineA(q, { quantity: 1 });
  assert.deepEqual(e.coverage, cov);
  for (const f of ESTIMATE_FORBIDDEN_FRAGMENTS) assert.ok(!JSON.stringify(e).includes(f), f);
  for (const f of ESTIMATE_FORBIDDEN_FRAGMENTS) assert.ok(!JSON.stringify(cov).includes(f), `coverage carries ${f}`);
});

test('pieces are pieces a set × sets: 4 a set, 2 sets is 8 pieces — on a one-part job too (critique 1)', () => {
  const m = { job: job(2), parts: [part('only', 0, 4, [mat('m1', 'pla')], 'f30')] };
  assert.equal(pricesAsOneJob(m), false, 'four pieces a set are not the v1 job of one');
  const q = estimateModel(m, files, ctx);
  const eight = engine(A30, 'pla', 8);
  assert.equal(q.coverage!.priced_parts[0].pieces, 8);
  assert.equal(q.price_iqd, eight.price_iqd);
  assert.equal(q.material_grams, Math.round(eight.material_grams * 10) / 10);
  assert.notEqual(q.price_iqd, engine(A30, 'pla', 2).price_iqd, 'never the sets read as pieces');
  assert.equal(q.unit_price_iqd, Math.round(eight.price_iqd / 2), 'the unit is a set');
});

test('a part in two materials is one part priced as a range across them, low confidence', () => {
  const m = { job: job(1), parts: [part('two', 0, 1, [mat('m1', 'pla'), mat('m2', 'petg')], 'f30')] };
  const q = estimateModel(m, files, ctx);
  const entry = q.coverage!.priced_parts[0];
  assert.equal(q.coverage!.priced_parts.length, 1, 'never split behind the customer');
  assert.equal(entry.range_basis, 'materials');
  assert.equal(entry.confidence, 'low');
  assert.equal(entry.material_id, '');
  const pla = engine(A30, 'pla', 1, 2);
  const petg = engine(A30, 'petg', 1, 2);
  assert.equal(entry.price_low_iqd, Math.min(pla.price_low_iqd, petg.price_low_iqd));
  assert.equal(entry.price_high_iqd, Math.max(pla.price_high_iqd, petg.price_high_iqd));
  assert.equal(q.range_basis, 'materials');
});

test('a part with nothing to measure is left out and says why: the sum is not the job\'s price', () => {
  const m = { job: job(1), parts: [part('a', 0, 1, [mat('m1', 'pla')], 'f30'), part('b', 1, 1, [mat('m2', 'pla')], null)] };
  const q = estimateModel(m, files, ctx);
  assert.equal(q.coverage!.complete, false);
  assert.deepEqual(q.coverage!.unpriced_parts, [{ part_id: 'b', position: 1, reason: 'NO_GEOMETRY' }]);
  assert.equal(q.price_iqd, engine(A30, 'pla', 1).price_iqd);
  assert.equal(q.confidence, 'low');
  // A part a publish refuses is shown with its code, never priced.
  const mixed = { job: job(1), parts: [part('x', 0, 1, [mat('m1', 'pla'), mat('m2', 'resin-standard')], 'f30')] };
  assert.equal(unsupportedPart(mixed.parts[0], DEFAULT_MATERIALS), 'PART_PROCESS_MIXED');
  const mq = estimateModel(mixed, files, ctx);
  assert.equal(mq.priced, false);
  assert.deepEqual(mq.coverage!.unpriced_parts, [{ part_id: 'x', position: 0, reason: '', refusal: 'PART_PROCESS_MIXED' }]);
});

test('R10 counted from the model: the model files no part is measured from', () => {
  const m = { parts: [part('a', 0, 1, [mat('m1', 'pla')], 'f1')], sources: [] };
  assert.equal(modelsUnpriced(m, [{ id: 'f1', kind: 'model' }, { id: 'f2', kind: 'model' }, { id: 'f3', kind: 'model' }, { id: 'i1', kind: 'reference' }]), 2);
});

// --------------------------------------------------------- through the routes

async function draftWith(raw: ReturnType<typeof world>, models: Array<[string, ModelAnalysis | null]>) {
  const id = await newDraft(raw);
  for (const [fid, a] of models) addFile(raw, id, fid, 'model', `${fid}.stl`, a ? { analysis: a as unknown as Record<string, unknown> } : {});
  return id;
}

test('a one-part one-material v3 job is quoted byte for byte as the same v1 job', async () => {
  const raw = world();
  const id = await draftWith(raw, [['fq', A30]]);
  const buyer = as(raw, 'buyer');
  const v1 = await json(await post(buyer, '/api/marketplace/print/quote', { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 3, file_id: 'fq' }));
  const v3 = await json(await post(buyer, '/api/marketplace/print/quote', {
    request_id: id, schema_version: 3, quantity: 3, quality: 'standard',
    parts: [{ process: 'fdm', measured_file_id: 'fq', materials: [{ material_id: 'pla', colors: [{ mode: 'any' }] }] }],
  }));
  assert.equal(v3.success, true, JSON.stringify(v3));
  assert.deepEqual(v3.estimate, v1.estimate);
  assert.deepEqual(v3.quote, v1.quote);
  assert.equal(v3.estimate.coverage, undefined, 'a one-job estimate carries no coverage');
});

test('critique 1 through the publish: one part, 4 a set, 2 sets is stored as 8 pieces', async () => {
  const raw = world();
  const id = await draftWith(raw, [['f8', A30]]);
  const res = await publish(raw, id, {
    schema_version: 3, quantity: 2,
    parts: [{ process: 'fdm', quantity: 4, measured_file_id: 'f8', materials: [{ material_id: 'pla', colors: [{ mode: 'any' }] }] }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = JSON.parse(raw.prepare('SELECT estimate FROM community_print_requests WHERE request_id = ?').get(id)!.estimate as string);
  assert.equal(stored.price_iqd, engine(A30, 'pla', 8).price_iqd);
  assert.equal(stored.coverage.priced_parts[0].pieces, 8);
  const facts = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
  assert.equal(facts.estimate_iqd, stored.price_iqd, 'one material, every part priced: the job value is known');
  assert.equal(facts.grams, stored.material_grams);
});

test('a job of PLA and TPU publishes priced per part; a part left unpriced makes the job value unknown to the matcher', async () => {
  const raw = world();
  const id = await draftWith(raw, [['fa', A30], ['fb', A20]]);
  const body = {
    schema_version: 3,
    parts: [
      { name: 'Body', process: 'fdm', measured_file_id: 'fa', materials: [{ material_id: 'pla', colors: [{ mode: 'any' }] }] },
      { name: 'Grip', process: 'fdm', measured_file_id: 'fb', materials: [{ material_id: 'tpu', colors: [{ mode: 'any' }] }] },
    ],
  };
  const res = await publish(raw, id, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = raw.prepare('SELECT estimate, estimate_low_iqd, estimate_high_iqd FROM community_print_requests WHERE request_id = ?').get(id) as Record<string, unknown>;
  const e = JSON.parse(String(p.estimate));
  const a = engine(A30, 'pla', 1);
  const b = engine(A20, 'tpu', 1);
  assert.equal(p.estimate_low_iqd, a.price_low_iqd + b.price_low_iqd);
  assert.equal(p.estimate_high_iqd, a.price_high_iqd + b.price_high_iqd);
  assert.equal(e.coverage.complete, true);
  const facts = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
  assert.equal(facts.parts!.length, 2);
  assert.deepEqual(facts.parts!.map((x) => [x.materials[0].material_id, x.grams]), [['pla', a.material_grams], ['tpu', b.material_grams]]);

  // A part with nothing to measure: the sum covers the priced part only.
  const other = await draftWith(raw, [['fc', A30]]);
  const partial = await publish(raw, other, {
    schema_version: 3,
    parts: [
      { name: 'Body', process: 'fdm', measured_file_id: 'fc', materials: [{ material_id: 'pla' }] },
      { name: 'Lid', process: 'fdm', stated_dimensions_mm: { x: 40, y: 40, z: 5 }, materials: [{ material_id: 'pla' }] },
    ],
  });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  const pf = (await loadRequestFacts(asD1(raw), [other])).get(other)!;
  assert.equal(pf.estimate_iqd, null, 'a sum over some parts is not the job value');
  assert.equal(pf.grams, null);
  assert.equal(pf.parts!.find((x) => x.dims_mm?.z === 5)!.grams, null);
  // The owner's detail labels it: coverage incomplete, its estimate free of any cost.
  const detail = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${other}`));
  assert.equal(detail.print.estimate.coverage.complete, false);
  assert.deepEqual(detail.print.estimate.coverage.unpriced_parts.map((x: Record<string, unknown>) => x.reason), ['NO_GEOMETRY']);
  // The stored estimate's public half (publicEstimate) never had a cost; its coverage has no fragment at all.
  for (const f of ['cost_', 'floor_', 'margin_']) assert.ok(!JSON.stringify(detail.print.estimate).includes(f), f);
  for (const f of ESTIMATE_FORBIDDEN_FRAGMENTS) assert.ok(!JSON.stringify(detail.print.estimate.coverage).includes(f), f);
  assert.equal(detail.summary.parts_count, 2);
});

test('R10 for v1: three model files keep the same numbers, and the two beside the priced one are counted on read — never stored', async () => {
  const raw = world();
  const one = await draftWith(raw, [['g1', A30]]);
  const three = await draftWith(raw, [['h1', A30], ['h2', A20], ['h3', A20]]);
  const body = (f: string) => ({ process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 2, primary_file_id: f, source_type: 'model' });
  assert.equal((await publish(raw, one, body('g1'))).status, 200);
  assert.equal((await publish(raw, three, body('h1'))).status, 200);
  const est = (id: string) => raw.prepare('SELECT estimate FROM community_print_requests WHERE request_id = ?').get(id)!.estimate as string;
  assert.equal(est(three), est(one), 'the same job, the same stored bytes');
  assert.ok(!est(three).includes('coverage'), 'nothing of R10 is stored on a v1 estimate');
  const q = await json(await post(as(raw, 'buyer'), '/api/marketplace/print/quote', { process: 'fdm', material_id: 'pla', quantity: 2, file_id: 'h1' }));
  assert.equal(q.models_unpriced, 2);
  const solo = await json(await post(as(raw, 'buyer'), '/api/marketplace/print/quote', { process: 'fdm', material_id: 'pla', quantity: 2, file_id: 'g1' }));
  assert.equal(solo.models_unpriced, 0);
  const detail = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${three}`));
  assert.equal(detail.print.models_unpriced, 2);
  const mine = await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  assert.equal(mine.requests.find((r: Record<string, unknown>) => r.id === three).summary.models_unpriced, 2);
  assert.equal(mine.requests.find((r: Record<string, unknown>) => r.id === one).summary.models_unpriced, 0);
});

test('the live estimate of a v3 draft: a part a publish would refuse is shown unpriced with its code, nothing written', async () => {
  const raw = world();
  const id = await draftWith(raw, [['fm', A30]]);
  const body = {
    schema_version: 3,
    parts: [
      { name: 'Ok', process: 'fdm', measured_file_id: 'fm', materials: [{ material_id: 'pla' }] },
      { name: 'Mixed', materials: [{ material_id: 'pla' }, { material_id: 'resin-standard' }] },
    ],
  };
  assert.equal((await saveDraft(raw, id, body)).status, 200, 'a draft keeps it');
  const before = raw.prepare('SELECT estimate FROM community_print_requests WHERE request_id = ?').get(id)!.estimate;
  const q = await json(await post(as(raw, 'buyer'), '/api/marketplace/print/quote', { request_id: id, schema_version: 3 }));
  assert.equal(q.success, true, JSON.stringify(q));
  assert.equal(q.estimate.coverage.complete, false);
  assert.equal(q.estimate.coverage.unpriced_parts[0].refusal, 'PART_PROCESS_MIXED');
  assert.equal(raw.prepare('SELECT estimate FROM community_print_requests WHERE request_id = ?').get(id)!.estimate, before, '/quote writes nothing');
  for (const f of ESTIMATE_FORBIDDEN_FRAGMENTS) assert.ok(!JSON.stringify(q.estimate).includes(f), f);
  // Another customer's request is not theirs to quote.
  const stranger = await post(as(raw, 'stranger'), '/api/marketplace/print/quote', { request_id: id, schema_version: 3 });
  assert.equal(stranger.status, 404);
});
