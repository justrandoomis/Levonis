/**
 * EVERY WORD OF THE USD PRICING SCREENS EXISTS IN ARABIC, ENGLISH AND REAL
 * SORANI (USD design §5.4, §12 P-C; CLAUDE.md "Languages"; docs/DECISIONS.md
 * row 183): the procurement card's strings and the product form's.
 *
 *   - every key has ar, en and ckb, none empty;
 *   - ckb is never the Arabic and never the English;
 *   - ckb carries a Sorani-only letter;
 *   - ckb uses the pricing terms: never «گواستنەوە» (freight) or «کاڵا» (goods),
 *     which tests/pricingIssues.test.ts keeps out of the pricing vocabulary.
 *
 * Run: node --import tsx --test tests/procurementPricingStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROCUREMENT_PRICING_STRINGS } from '../src/components/adminOperations/procurementPricingStrings';
import { USD_PRICING_FORM_STRINGS } from '../src/components/adminProducts/form/usdPricingStrings';

const SORANI_ONLY = /[ڕڵێۆەڤ]/;
const text = (v: unknown): string => (typeof v === 'function' ? (v as (...a: string[]) => string)('X', 'Y', 'Z') : String(v));

for (const [name, table] of [
  ['procurement card', PROCUREMENT_PRICING_STRINGS],
  ['product form', USD_PRICING_FORM_STRINGS],
] as const) {
  test(`${name}: every key in ar, en and real Sorani`, () => {
    const keys = Object.keys(table.ar);
    assert.ok(keys.length > 20, `${keys.length} keys`);
    assert.deepEqual(Object.keys(table.en).sort(), [...keys].sort());
    assert.deepEqual(Object.keys(table.ckb).sort(), [...keys].sort());
    const problems: string[] = [];
    for (const k of keys) {
      const ar = text((table.ar as unknown as Record<string, unknown>)[k]);
      const en = text((table.en as unknown as Record<string, unknown>)[k]);
      const ckb = text((table.ckb as unknown as Record<string, unknown>)[k]);
      if (!ar.trim() || !en.trim() || !ckb.trim()) problems.push(`${k}: empty`);
      if (ckb === ar) problems.push(`${k}: ckb copies the Arabic`);
      if (ckb === en) problems.push(`${k}: ckb copies the English`);
      if (!SORANI_ONLY.test(ckb)) problems.push(`${k}: no Sorani letter in «${ckb}»`);
      if (/گواستنەوە|کاڵا/.test(ckb)) problems.push(`${k}: ckb uses a word the pricing vocabulary forbids`);
      if (/[؀-ۿ]/.test(en)) problems.push(`${k}: Arabic script in the English`);
    }
    assert.deepEqual(problems, []);
  });
}

test('the brief’s field label replaces the old reference price in all three languages', () => {
  assert.equal(PROCUREMENT_PRICING_STRINGS.ar.fieldLabel, 'الحد الأدنى للربح (USD)');
  assert.equal(PROCUREMENT_PRICING_STRINGS.en.fieldLabel, 'Minimum profit (USD)');
  assert.equal(PROCUREMENT_PRICING_STRINGS.ckb.fieldLabel, 'کەمترین قازانجی مەبەست (USD)');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const all = Object.values(PROCUREMENT_PRICING_STRINGS[lang]).map(text).join('\n');
    assert.doesNotMatch(all, /سعر البيع المرجعي للقطعة بالدينار|Reference unit selling price/);
  }
  // The four cells, in the brief's words.
  assert.deepEqual(
    [PROCUREMENT_PRICING_STRINGS.ar.cellCost, PROCUREMENT_PRICING_STRINGS.ar.cellProfit, PROCUREMENT_PRICING_STRINGS.ar.cellFinalUsd, PROCUREMENT_PRICING_STRINGS.ar.cellCustomer],
    ['التكلفة النهائية', 'الحد الأدنى للربح', 'السعر النهائي بالدولار', 'السعر النهائي للزبون']
  );
});
