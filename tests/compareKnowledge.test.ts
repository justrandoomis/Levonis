/**
 * THE COMPARISON READS THE KNOWLEDGE MODEL (the Bambu import spec §G.5
 * «Compare»; worker/lib/knowledge/compare.ts, worker/lib/compareSpecs.ts).
 *
 * For the registry keys flagged `compare`, a product's typed fact (0194
 * `product_spec_values`) answers the cell its template field would otherwise
 * answer from `spec_fields`: with its unit, its test method, and — where there
 * is no value — the state's words instead of a blank, never a loss. Without
 * 0194 every cell is read from `spec_fields` exactly as before.
 *
 *   1. the key map and the per-column choice (option first, 220 V first);
 *   2. the engine: a fact over a typed value, a typed value over a state, the
 *      state's words, units converted or left unscored, unverified said;
 *   3. the real route: public rows only, never the US table, never an owner
 *      row, the option's own fact, a sheet of facts is a sheet;
 *   4. a database without 0194: the answer of before;
 *   5. the leak scanners and the private markers.
 *
 * Run: node --import tsx --test tests/compareKnowledge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, stubApp } from './fixtures/app';
import { seedLiveCatalog, P } from './fixtures/liveCatalog';
import { leaks, arithmeticLeaks } from './fixtures/costlyProduct';
import { catalogLeaks } from './fixtures/catalogOnly';
import { insertSpecValue, notFound, notPublished } from './fixtures/knowledgeModel';
import { compareRoutes } from '../worker/routes/compare';
import { compareProducts, inFieldUnit, knowledgeHasValue, type CompareInputProduct, type KnowledgeCell } from '../worker/lib/compareSpecs';
import { COMPARE_KEY_FIELDS, knowledgeCellsFor, hasKnowledgeValue, type CompareKnowledgeRow } from '../worker/lib/knowledge/compare';
import { VALUE_STATE_LABELS } from '../worker/lib/knowledge/labels';
import { SPEC_KEYS } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { allTemplateGroups } from '../worker/lib/templateFamilies';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MARK = {
  storeUrl: 'https://us.store.bambulab.com/products/h2d?compare-secret',
  storeTitle: 'compare-store-title-secret',
  excerpt: 'compare-excerpt-secret',
  usValue: 987,
  ownerValue: 4242,
} as const;

// ------------------------------------------------------------------ 1. the key map, the choice

test('the key map: only registry keys flagged `compare`, each onto a real template field', () => {
  const fields = new Set(allTemplateGroups().flatMap((g) => g.fields.map((f) => f.id)));
  assert.ok(COMPARE_KEY_FIELDS.size >= 8, `${COMPARE_KEY_FIELDS.size}`);
  for (const [key, field] of COMPARE_KEY_FIELDS) {
    const k = SPEC_KEYS.find((s) => s.key === key);
    assert.ok(k?.compare, `${key} is not flagged compare`);
    assert.equal(k?.templateField, field);
    assert.ok(fields.has(field), `${key} → ${field} is not a template field`);
  }
  assert.equal(COMPARE_KEY_FIELDS.get('printing.build_volume'), 'build_volume');
  assert.equal(COMPARE_KEY_FIELDS.get('thermal.max_nozzle_temp'), 'nozzle_temp_max');
  assert.equal(COMPARE_KEY_FIELDS.get('material.net_weight'), 'net_weight');
});

const row = (over: Partial<CompareKnowledgeRow>): CompareKnowledgeRow => ({
  product_id: 'p',
  canonical_key: 'thermal.max_nozzle_temp',
  scope_kind: 'product',
  scope_id: '',
  region: '',
  value_text: '300 °C',
  value_num: 300,
  value_num_max: null,
  unit: '°C',
  status: 'verified',
  test_method: '',
  ...over,
});

test('a column’s cells: the option’s own fact first, then the product’s; 220 V before region-free; another option’s never', () => {
  const rows = [
    row({}),
    row({ region: 'intl_220v', value_num: 310, value_text: '310 °C' }),
    row({ scope_kind: 'option_value', scope_id: 'v_combo', value_num: 320, value_text: '320 °C' }),
    row({ scope_kind: 'option_value', scope_id: 'v_other', value_num: 999, value_text: '999 °C' }),
    row({ canonical_key: 'x.not-a-compare-key', value_num: 1 }),
    row({ canonical_key: 'thermal.max_bed_temp', status: 'not_found', value_text: '', value_num: null, unit: '°C' }),
    row({ canonical_key: 'motion.max_acceleration', status: 'bogus' }),
  ];
  const base = knowledgeCellsFor(rows, null);
  assert.equal(base.nozzle_temp_max.num, 310, 'the international version answers before the region-free row');
  assert.equal(knowledgeCellsFor(rows, 'v_combo').nozzle_temp_max.num, 320, 'the column narrowed to an option takes its own fact');
  assert.equal(knowledgeCellsFor(rows, 'v_none').nozzle_temp_max.num, 310, 'another option’s fact is never this column’s');
  assert.deepEqual(base.bed_temp_max, { key: 'thermal.max_bed_temp', status: 'not_found', text: '', num: null, num_max: null, unit: '°C', test_method: '' });
  assert.deepEqual(Object.keys(base).sort(), ['bed_temp_max', 'nozzle_temp_max'], 'an unknown key and an unknown status give no cell');
  assert.equal(hasKnowledgeValue(base), true);
  assert.equal(hasKnowledgeValue({ bed_temp_max: base.bed_temp_max }), false, 'a state alone is no sheet');
});

// ------------------------------------------------------------------ 2. the engine

const printer = (id: string, spec: Record<string, unknown>, knowledge?: Record<string, KnowledgeCell>): CompareInputProduct => ({
  id,
  product_type: 'printer',
  section_slugs: ['printers', 'fdm-printers'],
  spec_fields: spec,
  price_iqd: null,
  ...(knowledge ? { knowledge } : {}),
});
const cell = (over: Partial<KnowledgeCell>): KnowledgeCell => ({ key: 'thermal.max_nozzle_temp', status: 'verified', text: '', num: null, num_max: null, unit: '°C', test_method: '', ...over });
const rowOf = (result: ReturnType<typeof compareProducts>, field: string) => result.groups.flatMap((g) => g.rows).find((r) => r.field_id === field);

test('without a knowledge cell the comparison is exactly the comparison of before', () => {
  const a = { nozzle_temp_max: '300 °C', bed_temp_max: '110', build_volume: '256 x 256 x 256' };
  const b = { nozzle_temp_max: '350', bed_temp_max: '120 °C', build_volume: '325 x 320 x 325' };
  assert.deepEqual(compareProducts({ products: [printer('a', a, {}), printer('b', b, {})] }), compareProducts({ products: [printer('a', a), printer('b', b)] }));
});

test('a fact answers before the typed value — with its unit, its test method and its state; it ranks like a typed value', () => {
  const result = compareProducts({
    products: [
      printer('a', { nozzle_temp_max: '280' }, { nozzle_temp_max: cell({ text: '350 °C', num: 350, test_method: 'Bench measurement' }) }),
      printer('b', { nozzle_temp_max: '300 °C' }),
    ],
  });
  const r = rowOf(result, 'nozzle_temp_max')!;
  assert.deepEqual(r.values[0], { raw: '350', num: 350, text: '350 °C', missing: false, unit: '°C', state: 'verified', test_method: 'Bench measurement' });
  assert.equal(r.values[1].state, undefined, 'the typed column is read as before');
  assert.deepEqual(r.winners, [0]);
  assert.deepEqual(r.losers, [1]);
});

test('no value in the model: the typed value still answers; failing it, the state’s words instead of a blank — never a loss', () => {
  const result = compareProducts({
    products: [
      printer('a', { nozzle_temp_max: '300', bed_temp_max: '110' }, { bed_temp_max: cell({ key: 'thermal.max_bed_temp', status: 'not_found' }) }),
      printer('b', { bed_temp_max: '120' }, { nozzle_temp_max: cell({ status: 'not_published' }) }),
    ],
  });
  const bed = rowOf(result, 'bed_temp_max')!;
  assert.equal(bed.values[0].num, 110, 'a typed value beats «not found»');
  assert.equal(bed.values[0].state, undefined);
  const nozzle = rowOf(result, 'nozzle_temp_max')!;
  assert.deepEqual(nozzle.values[1], { raw: '', num: null, text: '', missing: true, state: 'not_published', state_label: VALUE_STATE_LABELS.not_published });
  assert.deepEqual(nozzle.winners, [], 'a row somebody could not answer is scored for nobody');
  assert.deepEqual(nozzle.losers, []);
  assert.ok(result.verdict.unscored.includes('nozzle_temp_max'));
  assert.ok(!result.verdict.losses[1].includes('nozzle_temp_max'), 'a state is never a loss');
});

test('a row of states alone is not drawn (a state is no row), and a fact alone draws one', () => {
  const states = compareProducts({
    products: [
      printer('a', { bed_temp_max: '100' }, { nozzle_temp_max: cell({ status: 'not_found' }) }),
      printer('b', { bed_temp_max: '110' }, { nozzle_temp_max: cell({ status: 'unknown' }) }),
    ],
  });
  assert.equal(rowOf(states, 'nozzle_temp_max'), undefined);
  const one = compareProducts({
    products: [
      printer('a', { bed_temp_max: '100' }, { nozzle_temp_max: cell({ text: '300 °C', num: 300 }) }),
      printer('b', { bed_temp_max: '110' }, { nozzle_temp_max: cell({ status: 'not_applicable' }) }),
    ],
  });
  const r = rowOf(one, 'nozzle_temp_max')!;
  assert.equal(r.values[0].text, '300 °C');
  assert.deepEqual(r.values[1].state_label, VALUE_STATE_LABELS.not_applicable);
});

test('an unverified fact is shown, scored, and says so in three languages', () => {
  const result = compareProducts({
    products: [
      printer('a', {}, { nozzle_temp_max: cell({ status: 'unverified', text: '320 °C', num: 320 }), bed_temp_max: cell({ key: 'thermal.max_bed_temp', text: '100 °C', num: 100 }) }),
      printer('b', { nozzle_temp_max: '300', bed_temp_max: '110' }),
    ],
  });
  const r = rowOf(result, 'nozzle_temp_max')!;
  assert.equal(r.values[0].state, 'unverified');
  assert.deepEqual(r.values[0].state_label, VALUE_STATE_LABELS.unverified);
  assert.deepEqual(r.winners, [0]);
  for (const l of Object.values(VALUE_STATE_LABELS)) {
    assert.ok(l.ar && l.en && l.ckb);
    assert.notEqual(l.ckb, l.ar, 'the Sorani never copies the Arabic');
  }
});

test('units: kilograms and centimetres are converted to the field’s unit; a unit it cannot take is shown, never scored', () => {
  const spool = (id: string, knowledge: Record<string, KnowledgeCell>): CompareInputProduct => ({
    id, product_type: 'filament', section_slugs: ['materials', 'fdm-materials'], spec_fields: { material_type: 'PLA' }, price_iqd: null, knowledge,
  });
  const kg = compareProducts({
    products: [
      spool('a', { net_weight: cell({ key: 'material.net_weight', text: '1 kg', num: 1, unit: 'kg' }) }),
      spool('b', { net_weight: cell({ key: 'material.net_weight', text: '500 g', num: 500, unit: 'g' }) }),
    ],
  });
  const w = rowOf(kg, 'net_weight')!;
  assert.equal(w.values[0].text, '1,000 g');
  assert.equal(w.values[0].num, 1000);
  assert.equal(w.values[0].unit, 'g');
  assert.deepEqual(w.winners, [0]);
  const odd = compareProducts({
    products: [
      spool('a', { net_weight: cell({ key: 'material.net_weight', text: '2.2 lbs', num: 2.2, unit: 'lbs-per-spool' }) }),
      spool('b', { net_weight: cell({ key: 'material.net_weight', text: '500 g', num: 500, unit: 'g' }) }),
    ],
  });
  const o = rowOf(odd, 'net_weight')!;
  assert.deepEqual(
    { text: o.values[0].text, num: o.values[0].num, unit: o.values[0].unit, missing: o.values[0].missing },
    { text: '2.2 lbs', num: null, unit: 'lbs-per-spool', missing: false }
  );
  assert.deepEqual(o.winners, [], 'a value in a unit the field cannot take is never ranked');
  assert.equal(inFieldUnit(25, 'cm', 'mm'), 250);
  assert.equal(inFieldUnit(1.5, 'kg', 'g'), 1500);
  assert.equal(inFieldUnit(300, '°C', '°C'), 300);
  assert.equal(inFieldUnit(300, 'mm', 'g'), null);
  assert.equal(inFieldUnit(300, 'MPa', 'mm/s'), null);
  assert.equal(inFieldUnit(300, '', 'mm'), 300, 'a fact with no unit is stated in the key’s own unit');
  assert.equal(knowledgeHasValue(undefined), false);
  assert.equal(knowledgeHasValue(cell({ status: 'verified', text: '', num: null })), false);
});

test('a build volume fact reads like the typed one: axes, magnitude, the unit once', () => {
  const result = compareProducts({
    products: [
      printer('a', {}, { build_volume: cell({ key: 'printing.build_volume', text: '325 × 320 × 325 mm', unit: 'mm' }) }),
      printer('b', { build_volume: '256 x 256 x 256' }),
    ],
  });
  const r = rowOf(result, 'build_volume')!;
  assert.equal(r.values[0].text, '325 × 320 × 325 mm');
  assert.deepEqual(r.values[0].axes, [325, 320, 325]);
  assert.deepEqual(r.winners, [0]);
});

// ------------------------------------------------------------------ 3. the real route

/** H2D and X2D with knowledge rows; the X2D's typed nozzle temperature removed so its state shows. */
function seed(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_cmp_ver', '${P.H2D}', 'Version', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES
      ('v_cmp_std', '${P.H2D}', 'g_cmp_ver', 'H2D', 0, 1),
      ('v_cmp_combo', '${P.H2D}', 'g_cmp_ver', 'H2D AMS Combo', 1, 1);
    UPDATE products SET spec_fields = json_remove(spec_fields, '$.nozzle_temp_max') WHERE id = '${P.X2D}';
  `);
  const at = { source_ref: MARK.storeUrl, source_title: MARK.storeTitle };
  insertSpecValue(raw, P.H2D, 'thermal.max_nozzle_temp', {
    ...at, value_text: '350 °C', value_num: 350, source_kind: 'manual', source_ref: 'https://store.bblcdn.com/s1/h2d-manual.pdf', source_excerpt: MARK.excerpt, test_method: 'Bench measurement',
  });
  insertSpecValue(raw, P.H2D, 'thermal.max_nozzle_temp', { ...at, scope_kind: 'option_value', scope_id: 'v_cmp_combo', value_text: '300 °C', value_num: 300 });
  insertSpecValue(raw, P.H2D, 'printing.build_volume', { ...at, value_text: '325 × 320 × 325 mm', value_list: '[325,320,325]' });
  // The H2D's bed: not found in the sources — but the shop typed 120 °C, and that answers.
  insertSpecValue(raw, P.H2D, 'thermal.max_bed_temp', { ...at, ...notFound([{ kind: 'store_page', url: MARK.storeUrl, title: MARK.storeTitle }]) });
  // The US table and an owner row never reach a column.
  insertSpecValue(raw, P.X2D, 'thermal.max_bed_temp', { ...at, value_text: `${MARK.usValue} °C`, value_num: MARK.usValue, status: 'unverified', region: 'us_110v' });
  insertSpecValue(raw, P.X2D, 'motion.max_acceleration', { ...at, value_text: `${MARK.ownerValue} mm/s²`, value_num: MARK.ownerValue, visibility: 'owner' });
  // The X2D's nozzle: the manufacturer does not publish it.
  insertSpecValue(raw, P.X2D, 'thermal.max_nozzle_temp', notPublished());
}

function world(opts: { through?: string; knowledge?: boolean } = {}) {
  const raw = opts.through ? dbThrough(opts.through) : freshDb();
  seedLiveCatalog(raw);
  if (!opts.through && opts.knowledge !== false) seed(raw);
  const db = asD1(raw);
  const app = stubApp(db, null, (a) => a.route('/api/compare', compareRoutes), { publishV2: false });
  return { raw, db, app };
}

async function compareOf(w: ReturnType<typeof world>, ids: string): Promise<{ status: number; body: Body; text: string }> {
  const random = Math.random;
  Math.random = () => 0.5; // the rate limiter's 2 % sweep is not what is tested here
  try {
    const res = await get(w.app, `/api/compare?ids=${ids}`);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Body, text };
  } finally {
    Math.random = random;
  }
}

const routeRow = (body: Body, field: string): Body | undefined =>
  (body.comparison.groups as Body[]).flatMap((g) => g.rows as Body[]).find((r) => r.field_id === field);

test('the route: the H2D’s fact with its test method, the X2D’s state instead of a blank, the typed bed temperature', async () => {
  const { status, body } = await compareOf(world(), `${P.H2D},${P.X2D}`);
  assert.equal(status, 200, JSON.stringify(body));
  const nozzle = routeRow(body, 'nozzle_temp_max')!;
  assert.deepEqual(nozzle.values[0], { raw: '350', num: 350, text: '350 °C', missing: false, unit: '°C', state: 'verified', test_method: 'Bench measurement' });
  assert.deepEqual(nozzle.values[1], { raw: '', num: null, text: '', missing: true, state: 'not_published', state_label: VALUE_STATE_LABELS.not_published });
  assert.deepEqual(nozzle.winners, []);
  const bed = routeRow(body, 'bed_temp_max')!;
  assert.equal(bed.values[0].text, '120 °C', 'a typed value answers a «not found»');
  assert.equal(bed.values[0].state, undefined);
  assert.equal(bed.values[1].state, undefined, 'the US table never answers a column');
  const volume = routeRow(body, 'build_volume')!;
  assert.equal(volume.values[0].text, '325 × 320 × 325 mm');
  assert.equal(volume.values[0].state, 'verified');
  const accel = routeRow(body, 'max_acceleration')!;
  assert.ok(accel.values.every((v: Body) => v.num !== MARK.ownerValue && v.state === undefined), 'an owner row never answers a column');
});

test('a column narrowed to an option takes the option’s own fact; the bare product its own', async () => {
  const w = world();
  const narrowed = await compareOf(w, `${P.H2D}:v_cmp_combo,${P.X2D}`);
  assert.equal(narrowed.status, 200, narrowed.text);
  assert.equal(routeRow(narrowed.body, 'nozzle_temp_max')!.values[0].num, 300);
  const twoOptions = await compareOf(w, `${P.H2D}:v_cmp_combo,${P.H2D}:v_cmp_std`);
  assert.equal(twoOptions.status, 200, twoOptions.text);
  assert.deepEqual(routeRow(twoOptions.body, 'nozzle_temp_max')!.values.map((v: Body) => v.num), [300, 350]);
});

test('a sheet of facts is a sheet: a product with no typed spec but a fact is compared; one with only states is refused', async () => {
  const w = world();
  w.raw.exec(`UPDATE products SET spec_fields = '{}' WHERE id = '${P.X2D}'`);
  const refused = await compareOf(w, `${P.H2D},${P.X2D}`);
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.body.code, 'COMPARE_NO_SPECS', 'a «not published» and a US row are no sheet');
  insertSpecValue(w.raw, P.X2D, 'printing.build_volume', { value_text: '256 × 256 × 260 mm', value_list: '[256,256,260]' });
  const drawn = await compareOf(w, `${P.H2D},${P.X2D}`);
  assert.equal(drawn.status, 200, drawn.text);
  assert.equal(routeRow(drawn.body, 'build_volume')!.values[1].text, '256 × 256 × 260 mm');
});

// ------------------------------------------------------------------ 4. before 0194

test('a database without 0194: 200, and the answer a database with 0194 and no fact gives', async () => {
  const old = await compareOf(world({ through: '0193' }), `${P.H2D},${P.X2D}`);
  assert.equal(old.status, 200, old.text);
  assert.doesNotMatch(old.text, /"state"/);
  const none = await compareOf(world({ knowledge: false }), `${P.H2D},${P.X2D}`);
  assert.equal(none.status, 200, none.text);
  assert.deepEqual(old.body.comparison, none.body.comparison);
});

// ------------------------------------------------------------------ 5. the scanners

test('the leak scanners find nothing; no store reference, title, excerpt, US or owner value leaves', async () => {
  const { body, text } = await compareOf(world(), `${P.H2D},${P.X2D}`);
  assert.deepEqual(leaks(body), []);
  assert.deepEqual(catalogLeaks(body), []);
  assert.deepEqual(arithmeticLeaks(body), []);
  for (const secret of [MARK.storeUrl, MARK.storeTitle, MARK.excerpt, 'us.store.bambulab.com', 'h2d-manual.pdf', String(MARK.usValue), String(MARK.ownerValue)]) {
    assert.ok(!text.includes(secret), `the comparison carries ${secret}`);
  }
});
