import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONDITION_GRADES,
  CONDITION_KINDS,
  conditionSaving,
  conditionWarrantyMonths,
  isConditionProduct,
  parseConditionDoc,
  returnRefusal,
  serializeConditionDoc,
  warrantyExtendable,
} from '../worker/lib/condition';

const OPEN_BOX = {
  kind: 'open_box',
  grade: 'like_new',
  usage_hours: 100,
  warranty_months: 12,
  new_product_id: 'p_x2d',
  fault_ar: 'عطل مصنعي في لوحة AMS 2 Pro',
  repair_ar: 'استُبدلت اللوحة بقطعة أصلية',
};

test('an unmarked product is NEW, and every not-new signal is off for it', () => {
  // The default for every row that existed before this feature.
  for (const empty of ['{}', '', null, undefined, '[]', 'not json', 42, { kind: 'brand_new' }]) {
    const doc = parseConditionDoc(empty);
    assert.equal(doc, null, `${JSON.stringify(empty)} should parse as new`);
    assert.equal(isConditionProduct(doc), false);
    assert.equal(conditionWarrantyMonths(doc), null);
    assert.equal(warrantyExtendable(doc), true, 'a new product may still be extended');
    assert.equal(returnRefusal(doc, 'not_as_described'), null, 'a new product returns normally');
  }
});

test('a condition document round-trips through the column', () => {
  const doc = parseConditionDoc(OPEN_BOX)!;
  assert.ok(doc);
  const back = parseConditionDoc(serializeConditionDoc(doc));
  assert.deepEqual(back, doc);
  assert.equal(serializeConditionDoc(null), '{}', 'null stores as NEW');
});

test('the warranty is the owner’s choice, and nothing is sold on top of it', () => {
  assert.equal(conditionWarrantyMonths(parseConditionDoc({ ...OPEN_BOX, warranty_months: 1 })), 1);
  assert.equal(conditionWarrantyMonths(parseConditionDoc({ ...OPEN_BOX, warranty_months: 12 })), 12);
  // Twelve is the default, because it is what a NEW device carries: an owner
  // who did not say otherwise must not quietly give the buyer less.
  assert.equal(conditionWarrantyMonths(parseConditionDoc({ ...OPEN_BOX, warranty_months: undefined })), 12);
  for (const bad of [0, 3, 24, 36, -1, 'twelve']) {
    assert.equal(
      conditionWarrantyMonths(parseConditionDoc({ ...OPEN_BOX, warranty_months: bad })),
      12,
      `warranty_months=${bad} must fall back to 12, never to an invented length`
    );
  }
  assert.equal(warrantyExtendable(parseConditionDoc(OPEN_BOX)), false);
});

test('change of mind is refused; a unit that arrives broken is not', () => {
  const doc = parseConditionDoc(OPEN_BOX);
  // The line the owner drew: sold AS imperfect, so "not what I pictured" is
  // change-of-mind. Arriving dead, damaged or wrong is none of those.
  assert.equal(returnRefusal(doc, 'not_as_described'), 'CONDITION_NO_RETURN');
  for (const honoured of ['defective', 'manufacturing_fault', 'wrong_item', 'shipping_damage']) {
    assert.equal(returnRefusal(doc, honoured), null, `${honoured} must still be claimable`);
  }
});

test('the saving is shown only when there is an honest one', () => {
  assert.deepEqual(conditionSaving(1_220_000, 1_525_000), { reference_iqd: 1_525_000, saving_iqd: 305_000 });
  // Nothing to boast about, and printing "توفير 0" or a negative saving beside
  // a struck-through number is worse than printing nothing at all.
  assert.equal(conditionSaving(1_525_000, 1_525_000), null, 'equal prices show no comparison');
  assert.equal(conditionSaving(1_600_000, 1_525_000), null, 'a dearer used unit shows no comparison');
  assert.equal(conditionSaving(1_220_000, null), null, 'no linked product, no comparison');
  assert.equal(conditionSaving(1_220_000, 0), null);
  assert.equal(conditionSaving(1_220_000, undefined), null);
  assert.equal(conditionSaving(0, 1_525_000), null);
});

test('grades and hours are bounded, and nonsense does not reach the page', () => {
  const doc = parseConditionDoc({ ...OPEN_BOX, grade: 'mint', usage_hours: -5 })!;
  assert.equal(doc.grade, 'good', 'an unknown grade falls back rather than rendering raw');
  assert.equal(doc.usage_hours, null, 'negative hours are not hours');
  assert.equal(parseConditionDoc({ ...OPEN_BOX, usage_hours: '100' })!.usage_hours, 100, 'a numeric string is read');
  assert.equal(parseConditionDoc({ ...OPEN_BOX, usage_hours: 12.9 })!.usage_hours, 12, 'floored, never rounded up');
  assert.equal(parseConditionDoc({ ...OPEN_BOX, usage_hours: 1e9 })!.usage_hours, 200_000, 'capped');
});

test('unit photographs accept only a path or an http(s) url', () => {
  const doc = parseConditionDoc({
    ...OPEN_BOX,
    unit_images: ['/files/UiUx/x.webp', 'https://cdn.example/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAA', '', 42],
  })!;
  assert.deepEqual(doc.unit_images, ['/files/UiUx/x.webp', 'https://cdn.example/a.jpg']);
  assert.deepEqual(parseConditionDoc({ ...OPEN_BOX, unit_images: 'nope' })!.unit_images, []);
});

test('every kind and grade the UI offers actually parses', () => {
  for (const kind of CONDITION_KINDS) {
    assert.equal(parseConditionDoc({ ...OPEN_BOX, kind })!.kind, kind);
  }
  for (const grade of CONDITION_GRADES) {
    assert.equal(parseConditionDoc({ ...OPEN_BOX, grade })!.grade, grade);
  }
});
