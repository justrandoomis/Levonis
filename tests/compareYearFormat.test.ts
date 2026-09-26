/**
 * «2,025» → «2025», AND THE MULTI-NOZZLE VOLUME (catalog discovery S7-server).
 *
 * The live compare page printed the release year with a thousands separator,
 * because a year went through the quantity formatter. And the X2D, H2D and H2C
 * quote one volume per nozzle, which the reader refused whole — so those
 * machines were never scored on size. Both are fixed where the values are read.
 *
 * Run: node --import tsx --test tests/compareYearFormat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCompareValue, readDimensions, compareProducts } from '../worker/lib/compareSpecs';
import { allTemplateGroups } from '../worker/lib/templateFamilies';
import { LIVE_PRODUCTS, P } from './fixtures/liveCatalog';

const field = (id: string) => allTemplateGroups().flatMap((g) => g.fields).find((f) => f.id === id)!;

test('release_year renders «2025», and still ranks as a number', () => {
  const v = readCompareValue(field('release_year'), '2025');
  assert.equal(v.text, '2025');
  assert.equal(v.num, 2025);
  assert.equal(readCompareValue(field('release_year'), '٢٠٢٦').text, '2026', 'Arabic-Indic digits too');
  // Every other quantity keeps its separator.
  assert.equal(readCompareValue(field('print_speed'), '1000').text, '1,000 mm/s');
  assert.equal(readCompareValue(field('max_acceleration'), '20000').text, '20,000 mm/s²');
});

test('the comparison row of the live X2D / H2S / P2S says 2026 · 2025 · 2025', () => {
  const r = compareProducts({
    products: [P.X2D, P.H2S, P.P2S].map((id) => {
      const p = LIVE_PRODUCTS.find((x) => x.id === id)!;
      return { id, product_type: 'printer', section_slugs: ['fdm-printers'], spec_fields: p.spec_fields, price_iqd: p.price_iqd };
    }),
  });
  const row = r.groups.flatMap((g) => g.rows).find((x) => x.field_id === 'release_year')!;
  assert.deepEqual(row.values.map((v) => v.text), ['2026', '2025', '2025']);
  assert.deepEqual(row.winners, [0]);
});

test('a multi-nozzle volume is read on the MAIN (or single) nozzle, and says so', () => {
  const x2d = LIVE_PRODUCTS.find((p) => p.id === P.X2D)!.spec_fields.build_volume;
  const h2d = LIVE_PRODUCTS.find((p) => p.id === P.H2D)!.spec_fields.build_volume;
  const h2c = LIVE_PRODUCTS.find((p) => p.id === P.H2C)!.spec_fields.build_volume;
  assert.deepEqual(readDimensions(x2d, 'mm'), { axes: [256, 256, 260], magnitude: 256 * 256 * 260, segment: 'Main nozzle' });
  assert.deepEqual(readDimensions(h2d, 'mm')!.axes, [325, 320, 325], 'Single nozzle — never the union');
  assert.deepEqual(readDimensions(h2c, 'mm')!.axes, [325, 320, 320], 'no main/single label: the first configuration listed');
  const v = readCompareValue(field('build_volume'), x2d);
  assert.equal(v.text, '256 × 256 × 260 mm (Main nozzle)');
  assert.deepEqual(v.axes, [256, 256, 260]);
});

test('what was not this shape stays unread, as before', () => {
  assert.equal(readDimensions('Live View 1920 × 1080; Nozzle Camera 1920 × 1080'), null, 'no labels → not segments');
  assert.equal(readDimensions('Main nozzle: big; Aux: 1 x 2 x 3', 'mm'), null, 'an unreadable MAIN nozzle is not replaced by the auxiliary one');
  assert.equal(readDimensions('Left: ?; Right: 1 x 2 x 3', 'mm')!.segment, 'Right', 'with no primary label, the first readable configuration');
  assert.equal(readDimensions('Build: 256 x 256 x 256'), null, 'one labelled segment is not a list');
  assert.deepEqual(readDimensions('256 x 256 x 256')!.axes, [256, 256, 256]);
});
