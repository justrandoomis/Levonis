/**
 * EVERY COLOUR-QUANTITY STRING IN REAL SORANI (docs/ux/COLOUR-QUANTITIES.md §8;
 * DECISIONS row 183: a ckb slot never carries a copy of the Arabic).
 *
 * The method of tests/refusalStrings.test.ts: each ckb sentence exists, is not
 * the Arabic or the English pasted across, and carries none of the letters
 * Sorani does not write (ة ى أ إ ؤ — an Arabic sentence left in a Sorani slot
 * nearly always has one). Then the Sorani gaps this change made visible: the
 * packing caption, the stepper's two hints and four product-page sentences.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLOUR_STRINGS, type ColourStrings } from '../src/lib/colourQuantities';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { ROOT } from './fixtures/d1';

const NOT_SORANI = /[ةىأإؤ]/;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** A string slot, or a function slot called with a neutral argument. */
const text = (v: ColourStrings[keyof ColourStrings]): string =>
  typeof v === 'function' ? (v as (...a: string[]) => string)('X', 'Y', 'Z') : v;

test('every §8 key has ar, en and real ckb — never a copy, never an Arabic letter', () => {
  const keys = Object.keys(COLOUR_STRINGS.ar) as Array<keyof ColourStrings>;
  assert.ok(keys.length >= 45, `${keys.length} keys`);
  const problems: string[] = [];
  for (const key of keys) {
    const ar = text(COLOUR_STRINGS.ar[key]);
    const en = text(COLOUR_STRINGS.en[key]);
    const ckb = text(COLOUR_STRINGS.ckb[key]);
    if (!ar.trim() || !en.trim() || !ckb.trim()) problems.push(`${key}: empty`);
    if (ckb === ar) problems.push(`${key}: ckb copies the Arabic`);
    if (ckb === en && /[A-Za-z]{3,}/.test(ckb)) problems.push(`${key}: ckb copies the English`);
    if (NOT_SORANI.test(ckb)) problems.push(`${key}: ckb carries a letter Sorani does not write: ${ckb}`);
  }
  assert.deepEqual(problems, []);
});

test('the four new refusal codes speak Sorani too', () => {
  for (const code of ['CART_LINES_CHANGED', 'BATCH_DUPLICATE_LINE', 'BATCH_TOO_MANY_LINES', 'BATCH_NOT_SUPPORTED']) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e, `${code} is in the table`);
    assert.notEqual(e.ckb, e.ar, `${code}: ckb copies the Arabic`);
    assert.notEqual(e.ckb, e.en, `${code}: ckb copies the English`);
    assert.ok(!NOT_SORANI.test(e.ckb), `${code}: ${e.ckb}`);
  }
});

test('the packing caption\'s loc has three arguments', () => {
  assert.match(read('src/components/adminOrders/OrderDetailModal.tsx'), /loc\('الخيار واللون المطلوبان', 'Selected option and colour', 'هەڵبژاردە و ڕەنگی داواکراو'\)/);
});

test('the stepper\'s two hints have Sorani', () => {
  const src = read('src/components/ui/QuantityInput.tsx');
  for (const m of src.matchAll(/loc\(`(?:المتبقي من حصة الطلب المسبق|الحد الأقصى المتوفر): \$\{shown\}`, `[^`]+`(, `([^`]+)`)?\)/g)) {
    assert.ok(m[2], `no Sorani: ${m[0]}`);
    assert.ok(!NOT_SORANI.test(m[2]), m[2]);
  }
});

test('the four product-page sentences that stood in Arabic are Sorani now', () => {
  const src = read('src/pages/Product.tsx');
  const ckb = src.slice(src.indexOf('  ckb: {'), src.indexOf('} as const;', src.indexOf('  ckb: {')));
  for (const key of ['PREORDER_CAPACITY_EXHAUSTED', 'routeQuotaFull', 'preorderLeft', 'directSoldOutPreorderOpen']) {
    const m = new RegExp(`\\b${key}: '([^']+)'`).exec(ckb);
    assert.ok(m, `${key} is in the ckb block`);
    assert.ok(!NOT_SORANI.test(m[1]), `${key} is still Arabic: ${m[1]}`);
  }
  assert.doesNotMatch(ckb, /NO SORANI IS INVENTED HERE/, 'the superseded rule is no longer cited');
  assert.match(ckb, /DECISIONS row 183/);
});

test('a row\'s + and − in Sorani say «the quantity of» the colour, so they never sound like the add button («زیادکردنی 50 × Black»)', () => {
  const ckb = COLOUR_STRINGS.ckb;
  assert.equal(ckb.rowIncrease('Black'), 'زیادکردنی بڕی Black');
  assert.equal(ckb.rowDecrease('Black'), 'کەمکردنەوەی بڕی Black');
  // The add button's own wording is never the row's.
  assert.notEqual(ckb.rowIncrease('Black').split(' ').slice(0, 2).join(' '), 'زیادکردنی Black');
  const spec = read('docs/ux/COLOUR-QUANTITIES.md');
  assert.match(spec, /زیادکردنی بڕی \{name\}/, 'the spec table says the same');
  assert.match(spec, /کەمکردنەوەی بڕی \{name\}/);
});

test('the new sentences of the review fixes are real Sorani', () => {
  const ckb = COLOUR_STRINGS.ckb;
  for (const s of [ckb.multiClosed('White، Beige'), ckb.multiClosed(''), ckb.partlyAdded, ckb.lineDelete('Black'), ckb.lineSelect('PLA', 'Black'), ckb.quickBuyAdded('5 × Black')]) {
    assert.ok(s.trim(), 'empty');
    assert.ok(!NOT_SORANI.test(s), s);
  }
  assert.notEqual(ckb.partlyAdded, COLOUR_STRINGS.ar.partlyAdded);
});
