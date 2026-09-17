import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITION_GRADES, CONDITION_KINDS } from '../worker/lib/condition';
import {
  CONDITION_GRADES_UI,
  CONDITION_KINDS_UI,
  conditionGradeLabel,
  conditionKindLabel,
  conditionText,
} from '../src/lib/condition';

const LANGS = ['ar', 'en', 'ckb'];

/**
 * A grade the server can STORE and the storefront cannot NAME renders as a raw
 * `like_new` on a product page. These two lists are written in two files — the
 * client cannot import the worker's — so this is what keeps them paired.
 */
test('every kind and grade the server stores has a label in every language', () => {
  assert.deepEqual([...CONDITION_KINDS_UI], [...CONDITION_KINDS]);
  assert.deepEqual([...CONDITION_GRADES_UI], [...CONDITION_GRADES]);

  for (const lang of LANGS) {
    for (const kind of CONDITION_KINDS) {
      const label = conditionKindLabel(kind, lang);
      assert.ok(label && label !== kind, `${kind} has no ${lang} label`);
    }
    for (const grade of CONDITION_GRADES) {
      const label = conditionGradeLabel(grade, lang);
      assert.ok(label && label !== grade, `${grade} has no ${lang} label`);
    }
  }
});

test('«Open Box» stays Latin in all three languages', () => {
  // The owner's own term, and what the trade calls it. «صندوق مفتوح» would
  // leave a customer searching for the phrase they already know.
  for (const lang of LANGS) assert.equal(conditionKindLabel('open_box', lang), 'Open Box');
});

const doc = (over: Record<string, string>) =>
  ({
    kind: 'used', grade: 'good', usage_hours: null, warranty_months: 12, new_product_id: null,
    fault_ar: '', fault_en: '', fault_ckb: '',
    repair_ar: '', repair_en: '', repair_ckb: '',
    notes_ar: '', notes_en: '', notes_ckb: '',
    unit_images: [], ...over,
  }) as Parameters<typeof conditionText>[0];

test('a note falls back to whatever language the owner actually filled in', () => {
  // The same rule home content uses: a missing translation shows the written
  // one rather than an empty panel.
  assert.equal(conditionText(doc({ fault_ar: 'عطل' }), 'fault', 'en'), 'عطل');
  assert.equal(conditionText(doc({ fault_en: 'A fault' }), 'fault', 'ar'), 'A fault');
  assert.equal(conditionText(doc({ fault_ckb: 'کێشە' }), 'fault', 'ar'), 'کێشە');
  // The reader's own language wins when it exists.
  assert.equal(conditionText(doc({ fault_ar: 'عطل', fault_en: 'A fault' }), 'fault', 'en'), 'A fault');
  assert.equal(conditionText(doc({ fault_ar: 'عطل', fault_en: 'A fault' }), 'fault', 'ar'), 'عطل');
  // Nothing written anywhere renders nothing, never a placeholder.
  assert.equal(conditionText(doc({}), 'fault', 'ar'), '');
  assert.equal(conditionText(doc({ notes_ar: '   ' }), 'notes', 'ar'), '', 'whitespace is not content');
});

test('an unknown value falls back rather than printing its raw key', () => {
  assert.equal(conditionKindLabel('nonsense' as never, 'ar'), 'مستعمل');
  assert.equal(conditionGradeLabel('mint' as never, 'en'), 'Good');
});
