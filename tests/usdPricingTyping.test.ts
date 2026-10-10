/**
 * NUMBERS AND REFUSALS AS THE OWNER TYPES AND READS THEM in «التسعير بالدولار
 * والشحن» (owner report 2026-10-10):
 *   - one reader for a typed decimal (`typedDecimalText`, shared by the server's
 *     supplier cost, manual CBM and minimum profit, and by the form);
 *   - Arabic-Indic digits reach the dinar fields (`Money` → `wholeDigits`) and
 *     the box (`parseScaledInteger`) instead of being dropped key by key;
 *   - a refusal sentence never prints «{field}»: the panel's own label, else a
 *     sentence without a name — in Arabic, English and Sorani;
 *   - the new words name «التسعير والشحن» where they send the owner.
 *
 * Run: node --import tsx --test tests/usdPricingTyping.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedDecimalText } from '../packages/contracts/src/procurementCost';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { wholeDigits } from '../src/components/adminProducts/form/formUi';
import { parseScaledInteger } from '../src/components/adminProducts/form/DimensionsSection';
import { contractRefusal, type Lang } from '../src/lib/refusalStrings';
import { PRICING_TAB_HREF, fieldLabelOf } from '../src/components/adminProducts/form/UsdPricingSection';
import { USD_PRICING_FORM_STRINGS } from '../src/components/adminProducts/form/usdPricingStrings';
import { codeOf } from './fixtures/source';

const LANGS: Lang[] = ['ar', 'en', 'ckb'];

test('a typed decimal reads one way everywhere: Arabic digits and «٫» are digits and a point; a comma only as a decimal comma', () => {
  const table: Array<[string, string]> = [
    ['٨٩٩٫٥', '899.5'],
    ['899,50', '899.50'],
    ['899,5', '899.5'],
    ['۱۲۰', '120'],
    [' ٠٫١٥ ', '0.15'],
    ['1,200', '1,200'],
    ['1,250,000', '1,250,000'],
    ['5.', '5.'],
  ];
  for (const [typed, read] of table) assert.equal(typedDecimalText(typed), read, typed);
});

test('the dinar fields and the box keep Arabic-Indic digits instead of dropping them', () => {
  assert.equal(wholeDigits('١٥٬٠٠٠'), '15000');
  assert.equal(wholeDigits('۲۵۰۰۰'), '25000');
  assert.equal(wholeDigits('15,000 د.ع'), '15000');
  assert.equal(parseScaledInteger('٦٠', 10), 600);
  assert.equal(parseScaledInteger('٠٫٥', 1000), 500);
  assert.equal(parseScaledInteger('52.5', 10), 525);
  assert.equal(parseScaledInteger('٥٢٫٥٥', 10), null, 'over-precise stays refused');
  // `Money` reads through `wholeDigits`.
  assert.match(codeOf('src/components/adminProducts/form/formUi.tsx'), /const raw = wholeDigits\(e\.target\.value\);/);
});

test('«{field}» is never printed: the panel’s own label for details.field in each language, else a sentence with no name', () => {
  for (const lang of LANGS) {
    const s = USD_PRICING_FORM_STRINGS[lang];
    const label = (f: string) => fieldLabelOf(f, s);
    const named = contractRefusal({ code: 'PRICING_INPUT_INVALID', message: 'x', details: { field: 'supplier_cost_amount' } }, lang, '', label);
    assert.equal(named, COST_REFUSALS.PRICING_INPUT_INVALID[lang].replace('{field}', s.supplierCost), lang);
    const rule = contractRefusal({ code: 'PRICING_INPUT_INVALID', message: 'x', details: { field: 'rules[0].amount_usd' } }, lang, '', label);
    assert.ok(rule.includes(s.minProfit), rule);
    const unnamed = contractRefusal({ code: 'PRICING_INPUT_INVALID', message: 'x', details: { field: 'inputs_seq' } }, lang, '', label);
    assert.ok(!unnamed.includes('{field}') && unnamed.length > 5, unnamed);
    const bare = contractRefusal({ code: 'PRICING_INPUT_INVALID', message: 'x' }, lang);
    assert.ok(!bare.includes('{field}'), bare);
  }
  // Every cost refusal, in every language, through the same door: no raw placeholder.
  for (const code of Object.keys(COST_REFUSALS)) for (const lang of LANGS) assert.ok(!contractRefusal({ code, message: '', details: { field: 'nope' } }, lang).includes('{field}'), `${code} ${lang}`);
});

test('the words that send the owner to «التسعير والشحن» name it in each language, and the link is the tab’s own address', () => {
  const tab = { ar: 'التسعير والشحن', en: 'Pricing & shipping', ckb: 'نرخدانان و ناردنی بەرهەم' } as const;
  for (const lang of LANGS) {
    const s = USD_PRICING_FORM_STRINGS[lang];
    for (const k of ['iqdNeedsRate', 'ratesNoUsd', 'ratesDerivedStale', 'openPricingTab'] as const) assert.ok(s[k].includes(tab[lang]), `${lang}.${k}`);
  }
  assert.equal(PRICING_TAB_HREF, '/admin?tab=pricing');
  assert.match(codeOf('src/components/adminPricing/fxParts.tsx'), /export const PRICING_TAB_PATH = '\/admin\?tab=pricing';/);
});
