/**
 * THE CHOOSER FOR AN IMPORTED PRODUCT (the Bambu import spec §G.3;
 * src/lib/productChooser.ts): the default selection, single-value groups,
 * impossible combinations, the group's name in three languages — and NOTHING
 * new for a product without the import's data.
 *
 * Run: node --import tsx --test tests/productChooserImport.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_OFFERED,
  defaultSelection,
  formsVariant,
  groupName,
  importedChooser,
  valueOffered,
  type ChooserGroup,
  type ChooserVariant,
} from '../src/lib/productChooser';
import { fixtureRelations } from './fixtures/bambuRelations';
import { SAMPLE_HANDLES } from './fixtures/bambu/load';

const G = (id: string, values: string[], extra: Partial<ChooserGroup> = {}): ChooserGroup & { name_en: string } => ({
  id,
  name_en: id,
  values: values.map((v) => ({ id: v })),
  ...extra,
});
const V = (id: string, ...values: string[]): ChooserVariant => ({ id, combo_key: values.map((v) => `o:${v}`).sort().join('|') });

test('the words: «غير متاح مع هذا الاختيار» — never «نفد» — in three languages, the Sorani its own', () => {
  assert.deepEqual(NOT_OFFERED, { ar: 'غير متاح مع هذا الاختيار', en: 'Not offered with this choice', ckb: 'لەگەڵ ئەم هەڵبژاردنە بەردەست نییە' });
  assert.ok(!Object.values(NOT_OFFERED).some((w) => /نفد|sold out/i.test(w)));
  assert.notEqual(NOT_OFFERED.ckb, NOT_OFFERED.ar);
});

test('an existing product (no kind, no default, no swatch): nothing is preselected and nothing is new', () => {
  const groups = [G('size', ['s', 'm']), G('colour', ['red'])];
  assert.equal(importedChooser(groups), false);
  assert.deepEqual(defaultSelection(groups, [V('v1', 's', 'red')]), [], 'not even the single-value group');
});

test('the defaults are preselected while they form a real variant', () => {
  const groups = [G('ver', ['a', 'b'], { kind: 'version', default_value_id: 'b' }), G('bundle', ['x', 'y'], { kind: 'other', default_value_id: 'y' })];
  assert.deepEqual(defaultSelection(groups, [V('1', 'a', 'x'), V('2', 'b', 'y')]), ['b', 'y']);
});

test('defaults that form no variant: the first group’s default alone', () => {
  const groups = [G('ver', ['a', 'b'], { kind: 'version', default_value_id: 'b' }), G('bundle', ['x', 'y'], { kind: 'other', default_value_id: 'x' })];
  assert.deepEqual(defaultSelection(groups, [V('1', 'a', 'x'), V('2', 'b', 'y')]), ['b']);
});

test('a single-value group is auto-selected, beside the defaults, only when it fits', () => {
  const groups = [G('ver', ['a', 'b'], { kind: 'version', default_value_id: 'a' }), G('size', ['one'], { kind: 'size' })];
  assert.deepEqual(defaultSelection(groups, [V('1', 'a', 'one'), V('2', 'b', 'one')]), ['a', 'one']);
  const noDefault = [G('ver', ['a', 'b'], { kind: 'version' }), G('size', ['one'], { kind: 'size' })];
  assert.deepEqual(defaultSelection(noDefault, [V('1', 'a', 'one')]), ['one']);
  // A default naming no value of its group is ignored.
  assert.deepEqual(defaultSelection([G('ver', ['a', 'b'], { kind: 'version', default_value_id: 'zz' })], []), []);
});

test('impossible combinations: a value forming no active variant with the other groups’ choices', () => {
  const groups = [G('ver', ['a', 'b'], { kind: 'version' }), G('bundle', ['x', 'y'], { kind: 'other' })];
  const variants = [V('1', 'a', 'x'), V('2', 'a', 'y'), V('3', 'b', 'x'), { ...V('4', 'b', 'y'), active: 0 }];
  assert.equal(valueOffered('y', 'bundle', ['b'], groups, variants), false, 'an inactive variant is no offer');
  assert.equal(valueOffered('x', 'bundle', ['b'], groups, variants), true);
  assert.equal(valueOffered('b', 'ver', ['y'], groups, variants), false);
  assert.equal(valueOffered('b', 'ver', [], groups, variants), true, 'with nothing else chosen every value is offered');
  assert.equal(formsVariant(['a', 'y'], variants), true);
  assert.equal(formsVariant(['q'], []), true, 'no published variant: nothing is ruled out');
});

test('the group’s name: Arabic and Sorani labels where the import wrote them, else the English name — never Arabic in Sorani', () => {
  const g = G('ver', [], { name_ar: 'الإصدار', name_ckb: 'وەشان' });
  assert.equal(groupName({ ...g, name_en: 'Version' }, 'ar'), 'الإصدار');
  assert.equal(groupName({ ...g, name_en: 'Version' }, 'ckb'), 'وەشان');
  assert.equal(groupName({ ...g, name_en: 'Version' }, 'en'), 'Version');
  assert.equal(groupName({ ...G('ver', [], { name_ar: 'الإصدار' }), name_en: 'Version' }, 'ckb'), 'Version');
});

test('every fixture: the default selection is a real selection of the import’s model', () => {
  for (const h of SAMPLE_HANDLES) {
    const f = fixtureRelations(h);
    if (!f.option_groups.length) continue;
    const sel = defaultSelection(f.option_groups, f.variants);
    // Every chosen value belongs to a distinct group, and together they sit in a real variant.
    const groupOf = new Map(f.option_groups.flatMap((g) => g.values.map((v) => [v.id, g.id] as const)));
    assert.equal(new Set(sel.map((id) => groupOf.get(id))).size, sel.length, h);
    assert.ok(formsVariant(sel, f.variants), `${h}: ${sel.join('+')}`);
    if (f.option_groups.some((g) => g.default_value_id)) assert.ok(sel.length > 0, `${h}: a default was published`);
  }
});
