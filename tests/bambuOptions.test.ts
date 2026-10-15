/**
 * OPTION GROUPS, VALUES AND ONLY THE REAL VARIANTS (Bambu import spec §C.2,
 * §C.3, §B.8), and the authored three-language registries the import writes.
 *
 *   - H2D's `Standard` / `standard` stay two values with two variant keys, and
 *     the save path's legacyShapeErrors accepts the whole value list;
 *   - one variant per source SKU, combo_key = sorted `o:<valueId>` joined by
 *     `|` (the inventory comboKey), never a missing combination;
 *   - the order-type reading is exactly availabilityFromName's;
 *   - every registry label exists in ar, en and ckb, and no ckb copies the ar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, newProductId, orderTypeWord, variantKeyOf } from '../packages/catalog/src/bambuImport/options';
import { CANONICAL_GROUPS } from '../packages/catalog/src/bambuImport/registry/groups';
import { VALUE_WORDS } from '../packages/catalog/src/bambuImport/registry/values';
import { BASE_COLOURS, baseColourOf, colourCodeOf } from '../packages/catalog/src/bambuImport/registry/colours';
import { SPEC_KEYS } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { DOCUMENT_TITLES } from '../packages/catalog/src/bambuImport/registry/documents';
import { BLOCK_TITLES, REGION_LABELS, VALUE_STATE_LABELS, altText, type Tri } from '../packages/catalog/src/bambuImport/registry/labels';
import { IMPORT_ERROR_MESSAGES } from '../packages/catalog/src/bambuImport/payload';
import { availabilityFromName } from '../packages/pricing/src/availability';
import { legacyShapeErrors } from '../worker/lib/optionFulfillment';
import { sample, SAMPLE_HANDLES } from './fixtures/bambu/load';

const modelOf = (h: Parameters<typeof sample>[0]) => {
  const x = sample(h);
  return { x, m: buildOptions(x, newProductId(x.sourceProductId)) };
};

test('H2D: Standard and standard are two values with two variant keys, and legacyShapeErrors passes', () => {
  const { m } = modelOf('h2d');
  const option = m.groups.find((g) => g.values.some((v) => v.nameEn === 'Standard'))!;
  const upper = option.values.find((v) => v.nameEn === 'Standard')!;
  const lower = option.values.find((v) => v.nameEn === 'standard')!;
  assert.notEqual(upper.id, lower.id);
  assert.notEqual(upper.variantKey, lower.variantKey);
  assert.equal(upper.variantKey, variantKeyOf(upper.sourceId));
  assert.match(upper.variantKey, /^bv-[0-9a-f]{24}$/);
  assert.equal(upper.variantLabel, 'Standard');
  const incoming = m.groups.flatMap((g) => g.values.map((v) => ({ id: v.id, name_en: v.nameEn, variant_key: v.variantKey, active: 1 })));
  assert.deepEqual(legacyShapeErrors(incoming, new Map(), availabilityFromName), []);
  // The save path WOULD refuse the same two values sharing a key: the explicit key is what saves them.
  const shared = incoming.map((v) => (v.id === lower.id ? { ...v, variant_key: upper.variantKey } : v));
  assert.equal(legacyShapeErrors(shared, new Map(), availabilityFromName).length, 1);
});

test('one variant per SKU, combo keys sorted o:<id> joined by |, no missing combination invented', () => {
  const expected: Record<string, number> = { h2d: 6, 'pla-basic-filament': 43, a1: 3, 'bambu-textured-pei-plate': 10 };
  for (const h of SAMPLE_HANDLES) {
    const { x, m } = modelOf(h);
    assert.deepEqual(m.errors, [], `${h}: ${JSON.stringify(m.errors)}`);
    if (m.groups.length) assert.equal(m.variants.length, x.skus.length, h);
    assert.equal(m.inventoryMode, m.groups.length ? 'VARIANT_COMBINATION' : 'BASE');
    for (const v of m.variants) {
      assert.equal(v.comboKey, [...v.valueIds].sort().map((id) => `o:${id}`).join('|'));
      assert.match(v.id, /^pv_[0-9a-f]{24}$/);
    }
    assert.equal(new Set(m.variants.map((v) => v.comboKey)).size, m.variants.length, `${h}: duplicate combination`);
    if (expected[h]) assert.equal(m.variants.length, expected[h], h);
    for (const g of m.groups) {
      assert.match(g.id, /^og_[0-9a-f]{24}$/);
      for (const v of g.values) assert.match(v.id, /^ov_[0-9a-f]{24}$/);
    }
  }
  const full = modelOf('ams-2-pro.options').m;
  assert.equal(full.variants.length, 15, 'AMS 2 Pro: 15 real variants of 42 combinations');
});

test('ids are deterministic and scoped by product (§B.8)', () => {
  const a = modelOf('h2d').m;
  const b = modelOf('h2d').m;
  assert.deepEqual(a.groups.map((g) => g.values.map((v) => v.id)), b.groups.map((g) => g.values.map((v) => v.id)));
  assert.equal(newProductId('581025672340709376'), newProductId('581025672340709376'));
  assert.match(newProductId('581025672340709376'), /^p_[0-9a-f]{24}$/);
});

test('the default value is the source selectedDefault; groups map to the registry with three-language names', () => {
  const { m } = modelOf('h2d');
  const version = m.groups.find((g) => g.kind === 'version')!;
  assert.equal(version.values.find((v) => v.id === version.defaultValueId)?.nameEn, 'H2D AMS Combo');
  assert.equal(version.nameAr, 'الإصدار');
  assert.equal(version.nameCkb, 'وەشان');
  const pla = modelOf('pla-basic-filament').m;
  const colour = pla.groups.find((g) => g.kind === 'color')!;
  assert.ok(colour.values.some((v) => v.colourCode && /^\d{5}$/.test(v.colourCode)), 'colour codes (10100) are read from the value text');
  const spool = pla.groups.find((g) => g.kind === 'spool');
  assert.ok(spool, 'the spool group is recognised');
  assert.ok(spool!.values.every((v) => v.nameAr && v.nameCkb && v.nameAr !== v.nameCkb), 'spool words have authored ar and ckb');
});

test('orderTypeWord reads exactly as availabilityFromName on every word of interest', () => {
  const words = ['Pre-order', 'preorder', 'PRE ORDER', 'Direct Sale', 'direct', 'طلب مسبق', 'بيع مباشر', 'Standard', 'AMS Combo', 'Directional fan', 'Combo', ''];
  for (const w of words) assert.equal(orderTypeWord(w), availabilityFromName(w), w);
  for (const h of SAMPLE_HANDLES) assert.equal(modelOf(h).m.hold, '', `${h} carries no order-type word`);
});

test('colour vocabulary: base colours and codes', () => {
  assert.equal(colourCodeOf('Jade White (10100)'), '10100');
  assert.equal(colourCodeOf('Jade White'), null);
  assert.equal(baseColourOf('Jade White (10100)'), 'white');
  assert.equal(baseColourOf('Bambu Green (10501)'), 'green');
});

test('every authored label exists in ar, en and ckb, and no ckb slot copies the ar', () => {
  const check = (where: string, t: Tri) => {
    assert.ok(t.ar && t.en && t.ckb, `${where}: a missing language`);
    assert.notEqual(t.ckb, t.ar, `${where}: ckb copies ar`);
    assert.ok(/[؀-ۿ]/.test(t.ar) && /[؀-ۿ]/.test(t.ckb), `${where}: ar and ckb are in Arabic script`);
  };
  for (const [k, g] of Object.entries(CANONICAL_GROUPS)) check(`group ${k}`, g.label);
  for (const [w, t] of VALUE_WORDS) check(`value ${w}`, t);
  for (const [k, t] of Object.entries(BASE_COLOURS)) check(`colour ${k}`, t);
  for (const s of SPEC_KEYS) check(`spec ${s.key}`, s.labels);
  for (const [k, t] of Object.entries(DOCUMENT_TITLES)) check(`document ${k}`, t);
  for (const [k, t] of Object.entries(VALUE_STATE_LABELS)) check(`state ${k}`, t);
  for (const [k, t] of Object.entries(REGION_LABELS)) check(`region ${k}`, t);
  for (const [k, t] of Object.entries(BLOCK_TITLES)) check(`block ${k}`, t);
  for (const [k, t] of Object.entries(IMPORT_ERROR_MESSAGES)) check(`refusal ${k}`, t);
  check('alt text', altText('Bambu Lab H2D', 'H2D AMS Combo'));
  assert.equal(new Set(SPEC_KEYS.map((s) => s.key)).size, SPEC_KEYS.length, 'spec keys are unique');
});
