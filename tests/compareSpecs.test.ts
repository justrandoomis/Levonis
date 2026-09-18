/**
 * THE COMPARISON IS PURE, SO IT IS THE ONE PART OF THIS FEATURE THAT CAN BE
 * PROVED RATHER THAN EYEBALLED (worker/lib/compareSpecs.ts).
 *
 * The first block is D1 and it is first on purpose: a missing spec is never a
 * loss. Everything else in the feature — the page, the assistant's compact
 * table, the chart — renders whatever this module returns, so if a blank cell
 * can become a defeat here, it becomes a defeat everywhere, and the shop's own
 * incomplete data entry is served to a customer as a statement about a machine.
 *
 * The parse cases are run through the REAL field definitions rather than
 * fixtures, so the test also pins the annotation table: an annotation deleted or
 * flipped in templateFamilies.ts fails here rather than silently changing what
 * a customer is told.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareProducts,
  readCompareValue,
  readList,
  readNumber,
  type CompareInputProduct,
  type CompareResult,
  type CompareRow,
} from '../worker/lib/compareSpecs';
import { allTemplateGroups, type TemplateField } from '../worker/lib/templateFamilies';

// ------------------------------------------------------------------ fixtures

const FIELDS = new Map<string, TemplateField>();
for (const g of allTemplateGroups()) for (const f of g.fields) if (!FIELDS.has(f.id)) FIELDS.set(f.id, f);

/** The real field, so a test failure means the ANNOTATION moved, not a fixture. */
function field(id: string): TemplateField {
  const f = FIELDS.get(id);
  assert.ok(f, `field ${id} is not in templateFamilies`);
  return f as TemplateField;
}

function fdm(id: string, specs: Record<string, unknown>, price = 1_000_000): CompareInputProduct {
  return { id, product_type: 'printer', section_slugs: ['fdm-printers'], spec_fields: specs, price_iqd: price };
}

function resin(id: string, specs: Record<string, unknown>, price = 1_000_000): CompareInputProduct {
  return { id, product_type: 'printer', section_slugs: ['resin-printers'], spec_fields: specs, price_iqd: price };
}

function row(result: CompareResult, fieldId: string): CompareRow {
  const found = result.groups.flatMap((g) => g.rows).find((r) => r.field_id === fieldId);
  assert.ok(found, `row ${fieldId} missing from the comparison`);
  return found as CompareRow;
}

const hasRow = (result: CompareResult, fieldId: string): boolean =>
  result.groups.flatMap((g) => g.rows).some((r) => r.field_id === fieldId);

// ------------------------------------------------------------------------ D1
//
// A PRODUCT WITH NO VALUE IS NOT A LOSER. Written before the scoring, because
// the scoring is only honest if this holds.

test('D1: a missing spec is shown, never scored, and never a loss', () => {
  const a = fdm('a', { max_flow_rate: '', print_speed: '500' });
  const b = fdm('b', { max_flow_rate: '32', print_speed: '300' });
  const res = compareProducts({ products: [a, b] });

  const flow = row(res, 'max_flow_rate');
  assert.equal(flow.values[0].missing, true, 'A has no value at all');
  assert.equal(flow.values[0].num, null);
  assert.equal(flow.values[1].missing, false);
  assert.deepEqual(flow.winners, [], 'nobody wins a row somebody could not answer');
  assert.deepEqual(flow.losers, []);

  // Excluded from the verdict on BOTH sides…
  assert.ok(res.verdict.unscored.includes('max_flow_rate'));
  assert.ok(!res.verdict.losses[0].includes('max_flow_rate'), 'D1: a blank is not a loss');
  assert.ok(!res.verdict.wins[1].includes('max_flow_rate'), 'and not a free win either');
  // …and from every chart axis.
  assert.ok(!res.chart.axes.some((ax) => ax.field_id === 'max_flow_rate'));

  // The denominator is the rows everyone answered: A won print_speed, which is
  // the only decisive scorable row, so it takes the whole score.
  assert.equal(res.verdict.scores[0], 1);
  assert.equal(res.verdict.scores[1], 0);
});

test('D1 extends to a value nobody could read: shown, not scored', () => {
  const a = fdm('a', { max_flow_rate: 'high', noise_level: '50' });
  const b = fdm('b', { max_flow_rate: '32', noise_level: '55' });
  const res = compareProducts({ products: [a, b] });

  const flow = row(res, 'max_flow_rate');
  assert.equal(flow.values[0].missing, false, 'the admin DID type something');
  assert.equal(flow.values[0].num, null, 'but it is not a number we understood');
  assert.equal(flow.values[0].text, 'high', 'and it is still shown as typed');
  assert.deepEqual(flow.winners, []);
  assert.ok(res.verdict.unscored.includes('max_flow_rate'));
  assert.ok(!res.verdict.losses[0].includes('max_flow_rate'));
});

test('a row nobody filled in is not rendered at all', () => {
  const res = compareProducts({ products: [fdm('a', { print_speed: '500' }), fdm('b', { print_speed: '300' })] });
  assert.equal(hasRow(res, 'max_flow_rate'), false);
  assert.equal(hasRow(res, 'print_speed'), true);
});

// -------------------------------------------------------------- parse shapes

test('build_volume: three axes AND a volume', () => {
  const f = field('build_volume');
  for (const raw of ['256x256x256', '256 × 256 × 256', '256 X 256 X 256', '٢٥٦ × ٢٥٦ × ٢٥٦']) {
    const v = readCompareValue(f, raw);
    assert.deepEqual(v.axes, [256, 256, 256], raw);
    assert.equal(v.num, 256 ** 3, raw);
    assert.equal(v.text, '256 × 256 × 256 mm', raw);
  }
  const star = readCompareValue(f, '220*220*250');
  assert.deepEqual(star.axes, [220, 220, 250]);
  assert.equal(star.num, 220 * 220 * 250);
});

test('a trailing unit that duplicates the field unit is read once and printed once', () => {
  assert.equal(readCompareValue(field('build_volume'), '256 x 256 x 256 mm').text, '256 × 256 × 256 mm');
  const nozzle = readCompareValue(field('nozzle'), '0.4mm');
  assert.equal(nozzle.num, 0.4);
  assert.equal(nozzle.text, '0.4 mm');
});

test('numbers survive the shapes people actually type', () => {
  assert.equal(readCompareValue(field('print_speed'), 'up to 500').num, 500);
  assert.equal(readCompareValue(field('print_speed'), '500 mm/s').num, 500);
  assert.equal(readCompareValue(field('weight'), '8.5 kg').num, 8.5);
  assert.equal(readCompareValue(field('noise_level'), '~50').num, 50);
  assert.equal(readCompareValue(field('warranty'), '12 months').num, 12);
  assert.equal(readCompareValue(field('warranty'), '١٢').num, 12);
  assert.equal(readCompareValue(field('tolerance'), '±0.02').num, 0.02);
  assert.equal(readNumber('1,250'), 1250);
});

test('a number we did not understand stays null — never a guess', () => {
  // Two numbers in a field that wants one.
  assert.equal(readCompareValue(field('nozzle'), '0.4 / 0.6 / 0.8').num, null);
  // "4K" is a marketing word, not 3840.
  const lcd = readCompareValue(field('lcd_resolution'), '4K');
  assert.equal(lcd.num, null);
  assert.equal(lcd.text, '4K');
  assert.equal(readNumber('4K'), null);
  assert.equal(readNumber(''), null);
});

test('lists split on the separators the data really uses, and keep their items', () => {
  const sizes = readCompareValue(field('supported_nozzle_sizes'), '0.2 / 0.4 / 0.6 / 0.8');
  assert.deepEqual(sizes.items, ['0.2', '0.4', '0.6', '0.8']);
  assert.equal(sizes.num, 4, 'a list is scored on its COUNT');
  const filaments = readCompareValue(field('supported_filaments'), 'PLA, PETG، ABS');
  assert.deepEqual(filaments.items, ['PLA', 'PETG', 'ABS']);
  assert.deepEqual(readList('PLA, PLA, PETG'), ['PLA', 'PETG'], 'the same item twice is one item');
});

test('camera 1080p and LCD 1920x1080 both read, and point different ways', () => {
  const cam = readCompareValue(field('camera_resolution'), '1080p');
  assert.deepEqual(cam.axes, [1080]);
  assert.equal(field('camera_resolution').compare?.better, 'none', 'lines vs pixels vs MP: unrankable');

  const lcd = readCompareValue(field('lcd_resolution'), '1920x1080');
  assert.equal(lcd.num, 1920 * 1080);
  assert.equal(field('lcd_resolution').compare?.better, 'higher', 'more pixels on one panel is finer');
  assert.equal(field('layer_height_range').compare?.better, 'lower', 'a thinner layer is finer');
  assert.equal(field('xy_resolution').compare?.better, 'lower', 'a smaller micron is finer');
});

test('a range reduces to the end its direction cares about', () => {
  const layer = readCompareValue(field('layer_height_range'), '0.01 - 0.2');
  assert.equal(layer.num, 0.01, 'lower-wins reads the finest end');
  assert.equal(layer.text, '0.01 – 0.2 mm');
  assert.equal(readCompareValue(field('layer_height_range'), '0.05').num, 0.05, 'a bare number is a range of one');
  const temp = readCompareValue(field('operating_temp'), '-20 to 60');
  assert.equal(temp.num, null, 'operating temperature is shown, never ranked');
  assert.equal(temp.text, '-20 – 60 °C');
});

test('yes / no / optional', () => {
  const f = field('filament_sensor');
  assert.equal(readCompareValue(f, 'Yes').num, 1);
  assert.equal(readCompareValue(f, 'No').num, 0);
  assert.equal(readCompareValue(f, 'Optional').num, 0.5);
  assert.equal(readCompareValue(f, 'N/A').num, null, 'not applicable is not a No');
});

// ------------------------------------------------------------------- ranking

test('lower-is-better inverts the winner AND the chart', () => {
  const a = fdm('a', { noise_level: '48' });
  const b = fdm('b', { noise_level: '58 dB' });
  const res = compareProducts({ products: [a, b] });

  const noise = row(res, 'noise_level');
  assert.equal(noise.better, 'lower');
  assert.deepEqual(noise.winners, [0], 'the quieter machine wins');
  assert.deepEqual(noise.losers, [1]);
  assert.ok(res.verdict.wins[0].includes('noise_level'));
  assert.ok(res.verdict.losses[1].includes('noise_level'));

  const axis = res.chart.axes.findIndex((ax) => ax.field_id === 'noise_level');
  assert.ok(axis >= 0);
  assert.equal(res.chart.series[0][axis], 1, 'further out = better, with no legend to contradict it');
  assert.ok(res.chart.series[1][axis] < res.chart.series[0][axis]);
});

test('higher-is-better ranks the bigger number, including a parsed volume', () => {
  const a = fdm('a', { build_volume: '256 x 256 x 256' });
  const b = fdm('b', { build_volume: '220 x 220 x 250' });
  const res = compareProducts({ products: [a, b] });
  assert.deepEqual(row(res, 'build_volume').winners, [0]);
  assert.deepEqual(row(res, 'build_volume').losers, [1]);
});

test('a tie has no winner, no loser and no pull on the score', () => {
  const a = fdm('a', { print_speed: '500', noise_level: '50' });
  const b = fdm('b', { print_speed: '500', noise_level: '50' });
  const res = compareProducts({ products: [a, b] });

  assert.deepEqual(row(res, 'print_speed').winners, []);
  assert.deepEqual(row(res, 'print_speed').losers, []);
  assert.equal(row(res, 'print_speed').decisive, false);
  assert.deepEqual(res.verdict.scores, [0, 0], 'two identical machines beat each other at nothing');
  assert.deepEqual(res.verdict.wins, [[], []]);
  assert.deepEqual(res.verdict.losses, [[], []]);
  assert.deepEqual(res.verdict.unscored, [], 'a tie is not "unscored" — everybody answered');
  assert.deepEqual(res.chart.axes, [], 'an axis where nothing differs draws nothing');
});

test('«Optional» does not win against «Yes», and is not recorded as a loss', () => {
  const a = fdm('a', { filament_sensor: 'Yes' });
  const b = fdm('b', { filament_sensor: 'Optional' });
  const c = fdm('c', { filament_sensor: 'No' });
  const res = compareProducts({ products: [a, b, c] });

  const sensor = row(res, 'filament_sensor');
  assert.deepEqual(sensor.winners, [0]);
  assert.deepEqual(sensor.losers, [2], 'only the machine that cannot take one at all loses');
  assert.deepEqual(res.verdict.losses[1], [], 'Optional is a part you can buy, not a defeat');
  assert.ok(res.verdict.losses[2].includes('filament_sensor'));
});

test('the score is a weighted share of the decisive rows, and the shares sum to one', () => {
  const a = fdm('a', { build_volume: '300 x 300 x 300', noise_level: '55' });
  const b = fdm('b', { build_volume: '220 x 220 x 250', noise_level: '48' });
  const res = compareProducts({ products: [a, b] });

  // build_volume weighs 3, noise_level 2 — so A takes 3/5 and B takes 2/5.
  assert.ok(Math.abs(res.verdict.scores[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(res.verdict.scores[1] - 0.4) < 1e-9);
  assert.ok(Math.abs(res.verdict.scores[0] + res.verdict.scores[1] - 1) < 1e-9);
});

test('wins and losses are reported BOTH ways round — «وهذه ما لا تتفوق فيه»', () => {
  const a = fdm('a', { print_speed: '500', noise_level: '58' });
  const b = fdm('b', { print_speed: '300', noise_level: '48' });
  const res = compareProducts({ products: [a, b] });

  assert.deepEqual(res.verdict.wins[0], ['print_speed']);
  assert.deepEqual(res.verdict.losses[0], ['noise_level']);
  assert.deepEqual(res.verdict.wins[1], ['noise_level']);
  assert.deepEqual(res.verdict.losses[1], ['print_speed']);
});

// ------------------------------------------------------------- three columns

test('three products: every column is ranked against the other two', () => {
  const a = fdm('a', { print_speed: '600', noise_level: '60' });
  const b = fdm('b', { print_speed: '500', noise_level: '50' });
  const c = fdm('c', { print_speed: '400', noise_level: '55' });
  const res = compareProducts({ products: [a, b, c] });

  assert.equal(row(res, 'print_speed').values.length, 3);
  assert.deepEqual(row(res, 'print_speed').winners, [0]);
  assert.deepEqual(row(res, 'print_speed').losers, [1, 2], 'second place still loses the row');
  assert.deepEqual(row(res, 'noise_level').winners, [1]);
  assert.equal(res.verdict.scores.length, 3);
  assert.equal(res.chart.series.length, 3, 'one series per product');
  for (const s of res.chart.series) assert.equal(s.length, res.chart.axes.length);
});

test('a three-way tie at the top splits the row instead of handing it to both', () => {
  const a = fdm('a', { print_speed: '500' });
  const b = fdm('b', { print_speed: '500' });
  const c = fdm('c', { print_speed: '300' });
  const res = compareProducts({ products: [a, b, c] });
  assert.deepEqual(row(res, 'print_speed').winners, [0, 1]);
  assert.deepEqual(row(res, 'print_speed').losers, [2]);
  assert.ok(Math.abs(res.verdict.scores[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(res.verdict.scores[1] - 0.5) < 1e-9);
  assert.equal(res.verdict.scores[2], 0);
});

// ------------------------------------------------------------------ D3 price

test('price is its own row, marks the cheaper machine, and stays out of the score', () => {
  const a = fdm('a', { print_speed: '300' }, 900_000);
  const b = fdm('b', { print_speed: '500' }, 1_200_000);
  const res = compareProducts({ products: [a, b] });

  const price = res.groups[0];
  assert.equal(price.id, 'price');
  const priceRow = row(res, 'price_iqd');
  assert.deepEqual(priceRow.winners, [0], 'the cheaper one is marked on its own row');
  assert.equal(priceRow.values[0].text, '900,000 IQD');
  assert.equal(priceRow.weight, 0);

  // …but it never becomes the verdict: B wins on specs despite costing more.
  assert.equal(res.verdict.scores[1], 1);
  assert.ok(!res.verdict.wins[0].includes('price_iqd'));
  assert.ok(!res.verdict.losses[1].includes('price_iqd'));
  assert.ok(!res.chart.axes.some((ax) => ax.field_id === 'price_iqd'));
});

test('an unpriced product does not lose on price either', () => {
  const res = compareProducts({ products: [fdm('a', {}, 0), fdm('b', {}, 1_200_000)] });
  const priceRow = row(res, 'price_iqd');
  assert.equal(priceRow.values[0].missing, true);
  assert.deepEqual(priceRow.winners, []);
});

// ------------------------------------------------- D2 cross-technology basis

test('FDM against FDM is grounded in the section it shares', () => {
  const res = compareProducts({
    products: [fdm('a', { technology: 'FDM', enclosed: 'Yes' }), fdm('b', { technology: 'FDM', enclosed: 'No' })],
  });
  assert.equal(res.basis, 'same_section');
  assert.equal(res.basis_label.ar, 'طابعة FDM');
  const deviceCore = res.groups.find((g) => g.id === 'device_core');
  assert.equal(deviceCore?.shared, true);
  assert.equal(res.groups.find((g) => g.id === 'fdm')?.shared, true);
});

test('FDM against Resin is allowed, and says which groups are not shared', () => {
  const a = fdm('a', { technology: 'FDM', build_volume: '256 x 256 x 256', nozzle_temp_max: '300' });
  const b = resin('b', { technology: 'Resin (MSLA)', build_volume: '218 x 123 x 235', xy_resolution: '19' });
  const res = compareProducts({ products: [a, b] });

  assert.equal(res.basis, 'same_type', 'same product type, different technology');
  assert.equal(res.basis_label.en, 'Printer');
  assert.equal(res.groups.find((g) => g.id === 'device_core')?.shared, true, 'both were asked these');
  assert.equal(res.groups.find((g) => g.id === 'fdm')?.shared, false, 'only one was asked these');
  assert.equal(res.groups.find((g) => g.id === 'resin')?.shared, false);

  // The technology-only rows are shown for the machine that has them and are
  // never scored against the machine that was never asked.
  assert.deepEqual(row(res, 'nozzle_temp_max').winners, []);
  assert.ok(!res.verdict.losses[1].includes('nozzle_temp_max'));
  // The shared row still decides.
  assert.deepEqual(row(res, 'build_volume').winners, [0]);
});

test('a printer against a filament is mixed, and still compares what they share', () => {
  const a = fdm('a', { weight: '8.5', warranty: '12' });
  const b: CompareInputProduct = {
    id: 'b',
    product_type: 'filament',
    section_slugs: ['fdm-materials'],
    spec_fields: { net_weight: '1000', warranty: '24' },
    price_iqd: 20_000,
  };
  const res = compareProducts({ products: [a, b] });
  assert.equal(res.basis, 'mixed');
  assert.equal(res.basis_label.ar, 'المواصفات المشتركة');
  assert.deepEqual(row(res, 'warranty').winners, [1], 'a field both templates declare still ranks');
  assert.deepEqual(row(res, 'weight').winners, [], 'a printer weight is shown and never ranked');
});

// ------------------------------------------------------------------ the page

test('the chart is capped, decisive, and has one number per product per axis', () => {
  const many = {
    build_volume: '300 x 300 x 300', print_speed: '500', max_flow_rate: '32', max_acceleration: '20000',
    nozzle_temp_max: '300', bed_temp_max: '120', noise_level: '48', camera_fps: '30', extruders: '1',
    warranty: '24', supported_filaments: 'PLA, PETG, ABS, ASA, TPU',
  };
  const fewer = {
    build_volume: '220 x 220 x 250', print_speed: '300', max_flow_rate: '12', max_acceleration: '5000',
    nozzle_temp_max: '260', bed_temp_max: '100', noise_level: '58', camera_fps: '15', extruders: '2',
    warranty: '12', supported_filaments: 'PLA, PETG',
  };
  const res = compareProducts({ products: [fdm('a', many), fdm('b', fewer)] });

  assert.ok(res.chart.axes.length > 0);
  assert.ok(res.chart.axes.length <= 8, 'a radar with more spokes than this is decoration');
  assert.equal(res.chart.series.length, 2);
  for (const series of res.chart.series) {
    assert.equal(series.length, res.chart.axes.length);
    for (const v of series) assert.ok(v >= 0 && v <= 1, `normalised to 0..1, got ${v}`);
  }
  // The heaviest axes come first, so a truncated chart keeps the rows that
  // decide the verdict and drops the ones that decorate it.
  const ids = res.chart.axes.map((ax) => ax.field_id);
  assert.ok(['build_volume', 'max_flow_rate'].includes(ids[0]), `weight-3 row first, got ${ids[0]}`);
  assert.ok(ids.includes('build_volume') && ids.includes('max_flow_rate'));
  assert.ok(!ids.includes('camera_fps'), 'a weight-1 row is not worth a spoke here');
});

test('one product, or none, is answered rather than thrown at', () => {
  const single = compareProducts({ products: [fdm('a', { print_speed: '500' })] });
  assert.equal(single.verdict.scores.length, 1);
  assert.deepEqual(single.verdict.wins, [[]]);
  assert.deepEqual(single.chart.axes, []);
  assert.equal(row(single, 'print_speed').values.length, 1);

  const none = compareProducts({ products: [] });
  assert.deepEqual(none.groups, []);
  assert.deepEqual(none.verdict.scores, []);
});

test('a spec id the definitions no longer carry is not shown as a raw key', () => {
  const res = compareProducts({
    products: [fdm('a', { legacy_thing: 'whatever' }), fdm('b', { legacy_thing: 'other' })],
  });
  assert.equal(hasRow(res, 'legacy_thing'), false);
});

test('every row carries a trilingual label and its unit', () => {
  const res = compareProducts({ products: [fdm('a', { print_speed: '500' }), fdm('b', { print_speed: '300' })] });
  const speed = row(res, 'print_speed');
  assert.equal(speed.label.ar, 'السرعة');
  assert.equal(speed.label.en, 'Print speed');
  assert.ok(speed.label.ckb.length > 0, 'ckb falls back to the English label, never empty');
  assert.equal(speed.unit, 'mm/s');
});
