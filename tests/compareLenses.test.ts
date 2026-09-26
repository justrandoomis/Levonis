/**
 * «أفضل لـ» — THE COMPARE LENSES (catalog discovery S7-server, §10.2).
 *
 * Acceptance: for the live X2D / H2S / P2S set the lenses are business → H2S,
 * beginners → P2S, value → X2D, multicolor → X2D, precision → X2D. And the
 * rules: a winner needs a 5% margin (else «متقاربة»), fewer than two products
 * with data is «لا توجد بيانات كافية», printers and lasers only.
 *
 * Run: node --import tsx --test tests/compareLenses.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { LIVE_PRODUCTS, P, seedLiveCatalog } from './fixtures/liveCatalog';
import { compareRoutes } from '../worker/routes/compare';
import { compareLenses, compareWithLenses, LENS_MARGIN } from '../worker/lib/compareLenses';
import type { CompareInputProduct } from '../worker/lib/compareSpecs';

const input = (id: string, over: Partial<CompareInputProduct> = {}): CompareInputProduct => {
  const p = LIVE_PRODUCTS.find((x) => x.id === id)!;
  return { id, product_type: 'printer', section_slugs: ['fdm-printers', 'printers'], spec_fields: { ...p.spec_fields }, price_iqd: p.price_iqd, ...over };
};

test('ACCEPTANCE over HTTP: X2D / H2S / P2S → business H2S, beginners P2S, value X2D, multicolor X2D, precision X2D', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/compare', compareRoutes));
  const b = await json(await get(app, `/api/compare?ids=${P.X2D},${P.H2S},${P.P2S}`));
  const lenses = b.comparison.lenses as Array<{ id: string; state: string; winner: number | null; reason: { code: string; field_id: string; value_text: string } | null }>;
  const names = [P.X2D, P.H2S, P.P2S];
  assert.deepEqual(
    lenses.map((l) => [l.id, l.state, l.winner === null ? null : names[l.winner]]),
    [
      ['business', 'winner', P.H2S],
      ['beginners', 'winner', P.P2S],
      ['value', 'winner', P.X2D],
      ['multicolor', 'winner', P.X2D],
      ['precision', 'winner', P.X2D],
    ]
  );
  const by = Object.fromEntries(lenses.map((l) => [l.id, l.reason]));
  assert.deepEqual(by.beginners, { code: 'ease', field_id: 'skill_level', value_text: 'Beginner' });
  assert.deepEqual(by.multicolor, { code: 'colors', field_id: 'max_colors', value_text: '25' });
  assert.deepEqual(by.precision, { code: 'quality', field_id: 'min_layer_height', value_text: '0.04 mm' });
  assert.deepEqual(by.value, { code: 'value', field_id: 'price_iqd', value_text: '1,575,000 IQD' });
  assert.equal(by.business!.code, 'size', 'the H2S leads on its 340 mm volume');
});

test('the 5% rule: a lead under 5% is a tie; extruders settle a near tie on colours', () => {
  const a = input(P.X2D);
  const b = input(P.H2S);
  // 25 vs 24 colours is a 4% lead. The X2D has 2 extruders to the H2S's 1.
  const lens = compareWithLenses({ products: [a, b] }).lenses!.find((l) => l.id === 'multicolor')!;
  assert.equal(lens.state, 'winner');
  assert.equal(lens.winner, 0);
  const sameExtruders = compareWithLenses({
    products: [a, { ...b, spec_fields: { ...b.spec_fields, extruders: '2' } }],
  }).lenses!.find((l) => l.id === 'multicolor')!;
  assert.equal(sameExtruders.state, 'tie', 'no tie-break left → «متقاربة», never an invented winner');
  assert.equal(sameExtruders.winner, null);
  assert.equal(sameExtruders.reason, null);
  assert.equal(LENS_MARGIN, 0.05);
});

test('fewer than two products with the data is «لا توجد بيانات كافية»', () => {
  const a = input(P.A1, { spec_fields: { ...input(P.A1).spec_fields } });
  const b = input(P.U1);
  // Neither the A1 nor the U1 states a skill level; drop assembly on one.
  delete (a.spec_fields as Record<string, unknown>).assembly;
  const beginners = compareWithLenses({ products: [a, b] }).lenses!.find((l) => l.id === 'beginners')!;
  assert.equal(beginners.state, 'no_data');
  const noZ = compareWithLenses({ products: [input(P.A1), input(P.U1)] }).lenses!.find((l) => l.id === 'precision')!;
  assert.equal(noZ.state, 'no_data', 'the A1 states no layer height and nobody states Z accuracy');
});

test('a missing value is never a loss: it is left out of the mean, not scored as zero', () => {
  const a = input(P.X2D);
  const b = input(P.H2S, { spec_fields: { ...input(P.H2S).spec_fields, warranty: '' } });
  const lenses = compareLenses([a, b], { verdict: { scores: [0.5, 0.5], wins: [[], []], losses: [[], []], unscored: [] } });
  const business = lenses.find((l) => l.id === 'business')!;
  assert.ok(business.scores.every((s) => s !== null));
});

test('printers and lasers only — a filament comparison gets no lens row', () => {
  const pla = { id: 'x', product_type: 'filament', section_slugs: ['fdm-materials'], spec_fields: { material_type: 'PLA' }, price_iqd: 21000 };
  assert.deepEqual(compareWithLenses({ products: [pla, { ...pla, id: 'y' }] }).lenses, []);
  assert.deepEqual(compareLenses([input(P.X2D)], { verdict: { scores: [1], wins: [[]], losses: [[]], unscored: [] } }), [], 'one column is not a comparison');
});
