/**
 * THE CATALOGUE MODEL, PURE (packages/catalog) — the one gate every variant
 * write passes, the legacy converter, the lifecycle vocabulary, the storefront
 * picker's helpers and the 3D-printing attributes.
 *
 * Run: node --import tsx --test tests/catalogModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVariantModel, allCombinations, findVariant, valueState, initialSelection, priceRange, comboKey,
  MAX_GROUPS, MAX_VARIANTS,
} from '../packages/catalog/src/variants';
import { convertLegacyOptions, readLegacyList, swatchForName } from '../packages/catalog/src/legacy';
import { isLowStock, isSoldOut, legacyLifecycleOf, stateFromLegacyLifecycle, PUBLISH_STATES } from '../packages/catalog/src/lifecycle';
import { normalizeAttributes } from '../packages/catalog/src/attributes';
import { merchantEntryLabel } from '../worker/lib/storeOrderOps';

const group = (ref: string, name: string, values: string[], kind = 'choice') => ({
  ref, name, kind, values: values.map((v, i) => ({ ref: `${ref}_${i}`, name: v })),
});

test('a valid model normalises; names are cleaned; an empty model is a simple product', () => {
  const r = normalizeVariantModel({
    groups: [group('size', '  Size ', ['S', 'M']), group('col', 'Colour', ['Red'], 'color')],
    variants: [
      { values: ['size_0', 'col_0'], price_iqd: 12000, stock: 3, sku: 'A-1' },
      { values: ['size_1', 'col_0'], price_iqd: null, stock: '4', active: false },
    ],
  });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  assert.equal(r.model.groups[0].name, 'Size');
  assert.equal(r.model.variants[1].stock, 4);
  assert.equal(r.model.variants[1].active, false);
  assert.equal(r.model.variants[1].price_iqd, null);
  assert.deepEqual(normalizeVariantModel({ groups: [], variants: [] }), { ok: true, model: { groups: [], variants: [] } });
});

test('the gate refuses what cannot be sold honestly — each with its code and path', () => {
  const codes = (input: unknown) => {
    const r = normalizeVariantModel(input);
    return r.ok ? [] : r.errors.map((e) => `${e.code}@${e.path}`);
  };
  const size = group('size', 'Size', ['S', 'M']);
  assert.ok(codes({ groups: [size], variants: [] }).includes('VARIANTS_EMPTY@variants'));
  assert.ok(codes({ groups: [size], variants: [{ values: ['size_0'], price_iqd: -1 }] }).includes('VARIANT_PRICE_INVALID@variants.0.price_iqd'));
  assert.ok(codes({ groups: [size], variants: [{ values: ['size_0'], price_iqd: 1.5 }] }).includes('VARIANT_PRICE_INVALID@variants.0.price_iqd'));
  assert.ok(codes({ groups: [size], variants: [{ values: ['size_0'], stock: -2 }] }).includes('VARIANT_STOCK_INVALID@variants.0.stock'));
  assert.ok(codes({ groups: [size], variants: [{ values: ['size_0'] }, { values: ['size_0'] }] }).includes('VARIANT_DUPLICATE@variants.1'));
  assert.ok(codes({ groups: [size], variants: [{ values: ['nope'] }] }).includes('VARIANT_VALUES_INVALID@variants.0.values'));
  assert.ok(codes({ groups: [size, group('c', 'Colour', ['Red'])], variants: [{ values: ['size_0'] }] }).includes('VARIANT_VALUES_INVALID@variants.0.values'));
  assert.ok(codes({ groups: [group('size', 'Size', ['S', 's'])], variants: [{ values: ['size_0'] }] }).includes('OPTION_VALUE_DUPLICATE@groups.0.values.1'));
  assert.ok(codes({ groups: [size, group('x', 'size', ['A'])], variants: [{ values: ['size_0', 'x_0'] }] }).includes('OPTION_NAME_DUPLICATE@groups.1'));
  const four = [0, 1, 2, 3].map((i) => group(`g${i}`, `G${i}`, ['a']));
  assert.ok(codes({ groups: four, variants: [] }).includes('OPTION_GROUPS_TOO_MANY@groups'));
  assert.equal(MAX_GROUPS, 3);
  const many = group('n', 'N', Array.from({ length: 30 }, (_, i) => `v${i}`));
  const many2 = group('m', 'M', Array.from({ length: 4 }, (_, i) => `w${i}`));
  const combos = allCombinations([many, many2]).map((values) => ({ values }));
  assert.equal(combos.length, 120);
  assert.ok(codes({ groups: [many, many2], variants: combos }).includes('VARIANTS_TOO_MANY@variants'));
  assert.equal(MAX_VARIANTS, 100);
  // A bidi override or zero-width mark cannot hide in a name.
  const sneaky = normalizeVariantModel({ groups: [group('s', 'Size‮', ['A​'])], variants: [{ values: ['s_0'] }] });
  assert.ok(sneaky.ok);
  assert.equal(sneaky.model.groups[0].name, 'Size');
  assert.equal(sneaky.model.groups[0].values[0].name, 'A');
});

test('the storefront helpers: find, value state, first selection, price range', () => {
  const groups = [{ id: 'g1' }, { id: 'g2' }];
  const variants = [
    { id: 'v1', value_ids: ['s', 'red'], in_stock: false, price_iqd: 10 },
    { id: 'v2', value_ids: ['m', 'red'], in_stock: true, price_iqd: 12 },
    { id: 'v3', value_ids: ['s', 'blue'], in_stock: true, price_iqd: 9 },
  ];
  assert.equal(findVariant(groups, variants, { g1: 'm', g2: 'red' })?.id, 'v2');
  assert.equal(findVariant(groups, variants, { g1: 'm', g2: 'blue' }), null, 'a combination nobody sells');
  assert.equal(findVariant(groups, variants, { g1: 'm' }), null, 'an incomplete selection names no variant');
  assert.equal(valueState(groups, variants, { g2: 'red' }, 0, 's'), 'sold_out');
  assert.equal(valueState(groups, variants, { g2: 'red' }, 0, 'm'), 'available');
  assert.equal(valueState(groups, variants, { g2: 'blue' }, 0, 'm'), 'unavailable');
  assert.deepEqual(initialSelection(groups, variants), { g1: 'm', g2: 'red' });
  assert.deepEqual(priceRange(5, variants), { min: 9, max: 12 });
  assert.deepEqual(priceRange(5, []), { min: 5, max: 5 });
  assert.equal(comboKey(['a', 'b']), 'a|b');
});

test('legacy lists are read with the add door’s own rules — the same entry id, the same label', () => {
  const options = '[{"id":"opt_l","name":"كبير"},"صغير",{"value":"x9","label":"Tiny","name_ar":"صغير جدًا"}]';
  const read = readLegacyList(options);
  assert.ok(read.ok);
  for (const e of read.entries) assert.equal(e.label, merchantEntryLabel(options, e.ref), `label of ${e.ref}`);
  assert.deepEqual(read.entries.map((e) => e.ref), ['opt_l', 'صغير', 'x9']);
  assert.deepEqual(readLegacyList('not json'), { ok: true, entries: [] }, 'unparseable JSON never offered a choice');
  assert.deepEqual(readLegacyList('{"a":1}'), { ok: false, reason: 'not_a_list' });
  assert.deepEqual(readLegacyList('["a","a"]'), { ok: false, reason: 'duplicate_id' });
  assert.deepEqual(readLegacyList('[{"name":"no id"}]'), { ok: false, reason: 'entry_without_id' });
  assert.equal(swatchForName('أحمر'), 'red');
  assert.equal(swatchForName('Navy'), 'navy');
  assert.equal(swatchForName('Rainbow'), '');
});

test('legacy conversion happens only when nothing must be invented', () => {
  // Untracked: every combination, no stock to split.
  const a = convertLegacyOptions('["S","M"]', '["أحمر",{"id":"c_blue","label":"أزرق"}]', { track_stock: false, stock: 0 });
  assert.ok(a.ok);
  assert.equal(a.model.variants.length, 4);
  assert.deepEqual(a.legacyKeys[3], { option_id: 'M', color_id: 'c_blue' });
  assert.equal(a.model.groups[1].values[0].swatch, 'red');
  assert.ok(normalizeVariantModel(a.model).ok, 'the converter’s output passes the gate');
  // One combination: it takes the product's whole stock.
  const b = convertLegacyOptions('["Only"]', '[]', { track_stock: true, stock: 7 });
  assert.ok(b.ok);
  assert.equal(b.model.variants[0].stock, 7);
  // Tracked stock over several combinations cannot be split: stays legacy.
  assert.deepEqual(convertLegacyOptions('["S","M"]', '[]', { track_stock: true, stock: 7 }), { ok: false, reason: 'shared_stock' });
  assert.deepEqual(convertLegacyOptions('[]', 'null', { track_stock: true, stock: 1 }), { ok: false, reason: 'empty' });
  assert.deepEqual(convertLegacyOptions('[1,2]', '[]', { track_stock: false, stock: 0 }).ok, false);
});

test('the lifecycle: four states, sold out derived, the legacy spelling mapped', () => {
  assert.deepEqual([...PUBLISH_STATES], ['draft', 'published', 'hidden', 'archived']);
  assert.equal(stateFromLegacyLifecycle('active'), 'published');
  assert.equal(stateFromLegacyLifecycle('sold_out'), 'hidden', 'the old manual flag took it off the storefront');
  assert.equal(stateFromLegacyLifecycle('weird'), 'hidden');
  assert.equal(legacyLifecycleOf('published'), 'active');
  assert.equal(isSoldOut({ track_stock: 1, stock: 0 }), true);
  assert.equal(isSoldOut({ track_stock: 0, stock: 0 }), false, 'an untracked product is never sold out');
  assert.equal(isLowStock(2, 3), true);
  assert.equal(isLowStock(0, 3), false, 'out of stock is not "low"');
  assert.equal(isLowStock(5, null), false);
});

test('3D-printing attributes: typed, bounded, never free text where a vocabulary exists', () => {
  const ok = normalizeAttributes({ material: 'petg', technology: 'fdm', color: 'blue', finish: 'sanded', dim_x_mm: '12.34', weight_g: 45 });
  assert.ok(ok.ok);
  assert.equal(ok.value.dim_x_mm, 12.3);
  assert.equal(ok.value.dim_y_mm, null, 'not stated is null — never a zero that reads as a size');
  const bad = normalizeAttributes({ material: 'PLA; DROP', technology: 'magic', color: '#ff0000', finish: 'gold', dim_z_mm: -1, weight_g: 0.5 });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['color', 'dim_z_mm', 'finish', 'material', 'technology', 'weight_g']);
});
