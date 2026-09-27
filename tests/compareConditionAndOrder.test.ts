/**
 * THE COMPARISON, MORE ACCURATE (owner, 2026-09-27: «في المقارنة اجعلها أكثر
 * دقة وسهلة للعين وأكثر نظامًا»).
 *
 *   - NEW AGAINST USED: when a column is an open-box, used or refurbished
 *     listing, the table opens with «الحالة» — the grade and the running
 *     hours from its condition document — and a new column answers it as new.
 *   - THE RIGHT HEADING: rows are walked in the compared products' own group
 *     order, so a filament's «الأبعاد» sits under «مواصفات المادة», never
 *     under «مواصفات الجهاز».
 *   - THE READER'S WORDS: a value the store's dictionary translates in full
 *     carries its Arabic reading; a quantity never does.
 *
 * Pure: `compareProducts` takes plain objects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareProducts, type CompareInputProduct } from '../worker/lib/compareSpecs';
import type { ConditionDoc } from '../worker/lib/condition';

const used = (over: Partial<ConditionDoc> = {}): ConditionDoc => ({
  kind: 'used',
  grade: 'good',
  usage_hours: 900,
  warranty_months: 1,
  new_product_id: null,
  fault_ar: '', fault_en: '', fault_ckb: '',
  repair_ar: '', repair_en: '', repair_ckb: '',
  notes_ar: '', notes_en: '', notes_ckb: '',
  unit_images: [],
  ...over,
});

const printer = (id: string, spec: Record<string, unknown>, extra: Partial<CompareInputProduct> = {}): CompareInputProduct => ({
  id,
  product_type: 'printer',
  section_slugs: ['fdm-printers', 'printers'],
  spec_fields: spec,
  price_iqd: 1_000_000,
  ...extra,
});

test('a used column opens the table with «الحالة»: kind, grade and hours, a new column answering as new', () => {
  const r = compareProducts({
    products: [
      printer('new', { print_speed: '500' }),
      printer('used', { print_speed: '500' }, { condition: used(), price_iqd: 700_000 }),
    ],
  });
  assert.deepEqual(r.groups.map((g) => g.id).slice(0, 2), ['price', 'condition'], 'price, then the condition, then the specs');
  const cond = r.groups.find((g) => g.id === 'condition')!;
  const by = Object.fromEntries(cond.rows.map((row) => [row.field_id, row]));
  assert.deepEqual(by.condition_kind.values.map((v) => v.raw), ['New', 'Used']);
  assert.deepEqual(by.condition_grade.values.map((v) => v.raw), ['New', 'Good']);
  assert.deepEqual(by.condition_grade.winners, [0], 'a new unit wins the grade');
  assert.deepEqual(by.condition_usage_hours.values.map((v) => v.num), [0, 900]);
  assert.deepEqual(by.condition_usage_hours.winners, [0], 'fewer hours win');
  assert.ok(r.verdict.wins[0].includes('condition_grade'));
  assert.ok(r.verdict.losses[1].includes('condition_usage_hours'), 'the used unit is told what it loses on');
});

test('hours the owner did not record are «not stated», never a loss against zero', () => {
  const r = compareProducts({
    products: [printer('new', { print_speed: '500' }), printer('ob', { print_speed: '500' }, { condition: used({ kind: 'open_box', grade: 'like_new', usage_hours: null }) })],
  });
  const hours = r.groups.find((g) => g.id === 'condition')!.rows.find((row) => row.field_id === 'condition_usage_hours')!;
  assert.equal(hours.values[1].missing, true);
  assert.deepEqual(hours.winners, []);
  assert.ok(!r.verdict.losses[1].includes('condition_usage_hours'));
});

test('two new products get no «الحالة» group at all', () => {
  const r = compareProducts({ products: [printer('a', { print_speed: '500' }), printer('b', { print_speed: '300' })] });
  assert.equal(r.groups.some((g) => g.id === 'condition'), false);
});

test('rows sit under the compared products’ own headings — a filament’s dimensions under «مواصفات المادة»', () => {
  const spool = (id: string, spec: Record<string, unknown>): CompareInputProduct => ({
    id,
    product_type: 'filament',
    section_slugs: ['fdm-materials', 'printing-materials'],
    spec_fields: spec,
    price_iqd: 25_000,
  });
  const r = compareProducts({
    products: [
      spool('a', { dimensions: '200 x 200 x 70', net_weight: '1000', compatibility: 'All FDM' }),
      spool('b', { dimensions: '200 x 200 x 65', net_weight: '1000', compatibility: 'All FDM' }),
    ],
  });
  const home = (field: string) => r.groups.find((g) => g.rows.some((row) => row.field_id === field))?.id;
  assert.equal(home('dimensions'), 'material_core');
  assert.equal(home('compatibility'), 'material_core');
  assert.ok(!r.groups.some((g) => g.id === 'device_core'), 'no device heading over two spools');
});

test('a printer comparison reads in its form’s order: the device, then the mains, then FDM', () => {
  const r = compareProducts({
    products: [
      printer('a', { print_speed: '500', rated_power: '350', nozzle_temp_max: '300' }),
      printer('b', { print_speed: '300', rated_power: '1000', nozzle_temp_max: '350' }),
    ],
  });
  const order = r.groups.map((g) => g.id).filter((id) => id !== 'price');
  const at = (id: string) => order.indexOf(id);
  assert.ok(at('device_core') < at('device_env') || at('device_env') === -1);
  if (at('device_env') !== -1 && at('fdm') !== -1) assert.ok(at('device_env') < at('fdm'));
});

test('an option the dictionary translates carries its Arabic reading; a quantity never does', () => {
  const r = compareProducts({
    products: [
      printer('a', { camera: 'Yes', build_volume: '256 x 256 x 256', skill_level: 'Beginner' }),
      printer('b', { camera: 'No', build_volume: '220 x 220 x 250', skill_level: 'Advanced' }),
    ],
  });
  const row = (id: string) => r.groups.flatMap((g) => g.rows).find((x) => x.field_id === id)!;
  assert.equal(row('camera').values[0].i18n?.ar, 'نعم');
  assert.equal(row('camera').values[1].i18n?.ar, 'لا');
  assert.equal(row('build_volume').values[0].i18n, undefined, 'a volume reads the same in every language');
  assert.equal(row('camera').values[0].text, 'Yes', 'the English stays the value; the reading is additive');
});

test('a used printer beside a new one: its used-condition sections follow the device, in the printer form’s order', () => {
  const r = compareProducts({
    products: [
      printer('new', { print_speed: '500', rated_power: '350', nozzle_temp_max: '300' }),
      printer(
        'used',
        { print_speed: '500', rated_power: '350', nozzle_temp_max: '300', usage_age: '8', filament_used_kg: '12' },
        { section_slugs: ['used-printers', 'used'], condition: used() }
      ),
    ],
  });
  const order = r.groups.map((g) => g.id);
  const at = (id: string) => order.indexOf(id);
  assert.ok(at('condition') < at('device_core'), 'the condition first');
  assert.ok(at('device_core') < at('used_state') && at('used_state') < at('used_printer'), 'then the device, then its used record');
  assert.ok(at('used_printer') < at('fdm'), 'before the FDM detail — the printer form’s own order');
});
