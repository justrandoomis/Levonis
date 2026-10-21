/**
 * THE WORDS AS CONSTRAINTS (smart search 1.6; @levonis/catalog/nlQuery, the
 * listing route with `nl=1`) — acceptance rows 9 to 12 of the assistant plan:
 *
 *   9  «فلامنت اسود اقل من 30 الف» → filament, colour black, price ≤ 30,000;
 *      nothing above the budget;
 *  10  «طابعة بدون AMS», «مو كومبو» → the AMS units and the combos left out;
 *      no AMS product at all;
 *  11  «ريفل» vs «بكرة كاملة» → the refill vs the with-spool facet; «spool»
 *      never reaches the spool→filament synonym;
 *  12  «متوفر هسه» vs «حجز» → sale=direct vs sale=preorder, never the other.
 *
 * In Arabic, English and Sorani, with digits from every keyboard and number
 * words; and what keeps it honest (the precision rule, docs/SEARCH.md §4e): a
 * number without a money marker and a comparator is not a price (X1C, 0.4, 6×2,
 * 10101, a resin printer «8K», «اقل من 30»), a word it does not
 * know stays in the search, an exclusion reads names and never descriptions,
 * and without `nl=1` the route answers exactly as before. Deterministic code
 * only: nothing here asks a model.
 *
 * Run: node --import tsx --test tests/assistUnderstand.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
import { limitD1, violations } from './fixtures/d1Limits';
import { DEFAULT_LISTING } from '../packages/catalog/src/discovery';
import { nlApply, nlChipKey, nlFold, nlJudgesProducts, nlKeeps, parseNlQuery, type NlChip } from '../packages/catalog/src/nlQuery';
import { backfillSearchIndex } from '../worker/lib/search/store';

// =========================================================================
// THE PARSER: PURE
// =========================================================================

const chips = (q: string): NlChip[] => parseNlQuery(q).understood;
const priceOf = (q: string) => parseNlQuery(q).price;

test('row 9: «فلامنت اسود اقل من 30 الف» is filament, black and at most 30,000 — in every language and on every keyboard', () => {
  for (const q of [
    'فلامنت اسود اقل من 30 الف',
    'فلامنت أسود أقل من ٣٠ ألف',
    'فلامنت اسود اقل من ۳۰ الف',
    'فلامنت اسود اقل من ثلاثين الف',
    'فلامنت اسود تحت 30 الف',
    'فلامنت اسود 30 الف واقل',
    'فلامنت اسود بحدود 30 الف',
    'فلامنت الاسود اقل من 30,000 دينار',
  ]) {
    const nl = parseNlQuery(q);
    assert.equal(nl.text, 'فلامنت', q);
    assert.deepEqual(nl.colours, ['black'], q);
    assert.deepEqual(nl.price, { min: null, max: 30_000, currency: 'IQD' }, q);
    assert.equal(nl.tailConsumed, true, `${q}: the last word became a constraint`);
  }
  for (const [q, text] of [
    ['filament black under 30k', 'filament'],
    ['black filament below 30,000', 'filament'],
    ['filament black thirty thousand or less', 'filament'],
    ['فیلامێنت ڕەش کەمتر لە 30 هەزار', 'فیلامێنت'],
    ['فیلامێنت ڕەش لە ٣٠ هەزار کەمتر', 'فیلامێنت'],
    ['فیلامێنت ڕەش کەمتر لە سی هەزار', 'فیلامێنت'],
  ] as const) {
    const nl = parseNlQuery(q);
    assert.equal(nl.text, text, q);
    assert.deepEqual(nl.colours, ['black'], q);
    assert.deepEqual(nl.price, { min: null, max: 30_000, currency: 'IQD' }, q);
  }
  assert.deepEqual(chips('فلامنت اسود اقل من 30 الف'), [
    { kind: 'price', min: null, max: 30_000, currency: 'IQD' },
    { kind: 'color', value: 'black' },
  ]);
});

test('amounts: number words, halves and quarters, ranges, bounds after the amount, and dollars — beside a comparator', () => {
  const max = (v: number) => ({ min: null, max: v, currency: 'IQD' });
  // The precision rule: an amount is a price only with a comparator or a range opener in its clause.
  assert.deepEqual(priceOf('طابعة اقل من مليون ونص'), max(1_500_000));
  assert.deepEqual(priceOf('تحت نص مليون'), max(500_000));
  assert.deepEqual(priceOf('اقل من ربع مليون'), max(250_000));
  assert.deepEqual(priceOf('اقل من مليونين'), max(2_000_000));
  // «مليون و 250» is 1,000,250 as written and 1,250,000 as often meant: no thousands are implied, nothing applies.
  assert.equal(priceOf('اقل من مليون و 250'), null);
  assert.deepEqual(priceOf('اقل من خمسة وعشرين الف'), max(25_000));
  assert.deepEqual(priceOf('under half a million'), max(500_000));
  assert.deepEqual(priceOf('کەمتر لە نیو ملیۆن'), max(500_000));
  // Without one the amount is searched as typed (it was a ceiling before the precision rule).
  for (const q of ['طابعة بمليون ونص', 'نص مليون', 'ربع مليون', 'مليونين', 'مليون و 250', 'خمسة وعشرين الف', 'ب 500 الف', 'half a million', 'نیو ملیۆن']) {
    assert.equal(priceOf(q), null, q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
  assert.equal(priceOf('اقل من 30'), null, 'a bare number beside a bound is no price');
  assert.deepEqual(priceOf('اكثر من مليون'), { min: 1_000_000, max: null, currency: 'IQD' });
  assert.deepEqual(priceOf('مو اكثر من مليون'), max(1_000_000), 'a fixed negated form reads as its positive meaning');
  assert.equal(priceOf('ما يزيد عن مليون'), null, 'any other negation around a price leaves it unapplied');
  assert.deepEqual(priceOf('زیاتر لە ملیۆنێک'), { min: 1_000_000, max: null, currency: 'IQD' }, 'the Sorani indefinite «a million»');
  assert.deepEqual(priceOf('زیاتر لە ملیۆنەها'), null, 'an unknown word is not guessed into a number');
  for (const q of ['بين 500 الف و مليون', 'من 500 الف الى مليون', 'between 500k and 1m', 'لە نێوان 500 هەزار و ملیۆن']) {
    assert.deepEqual(priceOf(q), { min: 500_000, max: 1_000_000, currency: 'IQD' }, q);
  }
  assert.equal(priceOf('500 الف - مليون'), null, 'no range opener');
  assert.equal(priceOf('250-400 الف'), null, 'no opener, and the bare end never borrows the thousand');
  assert.equal(priceOf('بين 25 و 50 الف'), null, 'a bare end never borrows the money word of the other');
  // Dollars as typed; the route converts them at the shop rate.
  assert.deepEqual(priceOf('اقل من 5 ورقات'), { min: null, max: 500, currency: 'USD' });
  assert.deepEqual(priceOf('under $500'), { min: null, max: 500, currency: 'USD' });
  assert.deepEqual(priceOf('اقل من 700 دولار'), { min: null, max: 700, currency: 'USD' });
  // «ميزانية مليونين، ABS» (the printer finder row): the budget is read, the material stays a search word.
  const finder = parseNlQuery('ميزانية مليونين، ABS');
  assert.deepEqual(finder.price, max(2_000_000));
  assert.deepEqual(finder.materials, ['abs']);
  assert.equal(finder.text, 'ABS');
});

test('a number without a money word or a bound is not a price, and a word the parser does not know stays in the search', () => {
  for (const q of ['X1C', 'A1 mini', 'H2D', 'nozzle 0.4', 'نوزل ٠.٤', 'مغناطيس 6×2', 'PLA 10101', '10102', 'FAP035', 'طابعة ريزن 8K', '1000g', '24v', 'ورقة صنفرة', 'دفتر', 'اكس ون سي']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.price, null, q);
    assert.equal(nl.text, q, `${q}: the search text is untouched`);
    assert.equal(nl.tailConsumed, false, q);
    assert.deepEqual(nl.exclude, { colours: [], materials: [], words: [] }, q);
  }
  // Nothing understood: a lone filler is still the search («اريد» is not turned into the whole shop).
  assert.equal(parseNlQuery('اريد').text, 'اريد');
  // Something understood: the fillers and joining words around it are not searched.
  assert.equal(parseNlQuery('اريد طابعة رخيصة').text, 'اريد طابعة');
  assert.equal(parseNlQuery('PLA او PETG').text, 'PLA PETG');
  assert.deepEqual(parseNlQuery('PLA او PETG').materials, ['pla', 'petg']);
  // «ولا» and «والا» are the Iraqi "or", read like «او»: both choices, neither excluded.
  for (const q of ['PLA ولا PETG', 'PLA والا PETG']) {
    const nl = parseNlQuery(q);
    assert.deepEqual(nl.materials, ['pla', 'petg'], q);
    assert.deepEqual(nl.exclude, { colours: [], materials: [], words: [] }, q);
    assert.equal(nl.text, 'PLA PETG', q);
  }
  for (const q of ['A1 ولا A1 mini', 'طابعة A1 ولا P1S']) {
    assert.deepEqual(parseNlQuery(q).exclude.words, [], q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
  assert.deepEqual(parseNlQuery('اسود ولا ابيض').colours, ['black', 'white']);
  // After a negation «ولا» and «والا» are "nor": both words are excluded.
  for (const q of ['طابعة بدون AMS ولا كومبو', 'طابعة بدون AMS والا كومبو']) {
    assert.deepEqual(parseNlQuery(q).exclude.words, ['ams', 'combo'], q);
    assert.equal(parseNlQuery(q).text, 'طابعة', q);
  }
  // A model name is not a bound: "3 Max" and "2 Plus" stay in the search; a money word or k makes them one.
  for (const q of ['Kobra 3 Max', 'Neptune 4 Max', 'Ender 3 Max', 'Kobra 2 Plus', 'Ender 5 Plus', '3+ colors']) {
    assert.equal(parseNlQuery(q).price, null, q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
  const kobra = parseNlQuery('Kobra 3 Max under 900 الف');
  assert.equal(kobra.text, 'Kobra 3 Max');
  assert.deepEqual(kobra.price, { min: null, max: 900_000, currency: 'IQD' });
  assert.deepEqual(priceOf('30k max'), { min: null, max: 30_000, currency: 'IQD' });
  assert.deepEqual(priceOf('500 الف plus'), { min: 500_000, max: null, currency: 'IQD' });
  // A measure or a count after the number is not a price, whatever bound stands before it.
  for (const q of [
    'filament under 1kg', 'filament under 1 kg', 'فلامنت اقل من 1 كيلو', 'printer under 300mm', 'طابعة تحت 256 ملم', 'nozzle up to 300°C',
    'nozzle up to 300 °C', 'اقل من 3 قطع', 'اكثر من 2 كيلو', 'printer between 200 and 300mm', 'بين 1.75 و 2.85 ملم', 'فیلامێنت کەمتر لە 1 کیلۆ',
  ]) {
    const nl = parseNlQuery(q);
    assert.equal(nl.price, null, q);
    assert.equal(nl.text, q, `${q}: the words stay in the search`);
  }
});

test('a bare number beside a bound is never a price: it stays searched; a money word or digits grouped in threes make it one', () => {
  const max = (v: number) => ({ min: null, max: v, currency: 'IQD' });
  const min = (v: number) => ({ min: v, max: null, currency: 'IQD' });
  // The precision rule: 30, 30000, 1500 may be a model, a size or a code. The words stay in the search as typed.
  for (const q of [
    'اقل من 30', 'طابعة تحت 500', 'under 1', 'under 999', 'under 1000', 'اقل من 1000', 'اقل من 30000', 'اقل من 1500', 'اقل من 1200',
    'printer 1000 or less', 'اقل من 15000000', 'اكثر من 20000', 'over 50000', 'فیلامێنت زیاتر لە 30000', 'طابعة 30000 او اكثر',
    'اكثر من 500', 'above 999', 'above 1000', 'کەمتر لە 30', 'لە 30000 کەمتر', 'تحت ال 500', 'فلامنت 30 ونازل',
  ]) {
    const nl = parseNlQuery(q);
    assert.equal(nl.price, null, q);
    assert.equal(nl.text, q, `${q}: searched as typed`);
    assert.equal(nl.tailConsumed, false, q);
  }
  for (const n of [1, 30, 500, 999, 1_000, 9_999, 10_000, 30_000, 1_000_000]) assert.equal(priceOf(`under ${n}`), null, String(n));
  // With its money word it is what the word says, whatever its size.
  assert.deepEqual(priceOf('اقل من 30000 دينار'), max(30_000));
  assert.deepEqual(priceOf('اقل من 30000 د.ع'), max(30_000));
  assert.deepEqual(priceOf('under 30000 IQD'), max(30_000));
  assert.deepEqual(priceOf('اقل من 30 الف'), max(30_000));
  assert.deepEqual(priceOf('اقل من 1500 الف'), max(1_500_000));
  assert.deepEqual(priceOf('under 30k'), max(30_000));
  assert.deepEqual(priceOf('over 50k'), min(50_000));
  assert.deepEqual(priceOf('فیلامێنت زیاتر لە 30 هەزار'), min(30_000));
  assert.deepEqual(priceOf('طابعة 30 الف او اكثر'), min(30_000));
  // Grouped in threes it is written in full: exact, on either keyboard.
  for (const q of ['اقل من 30,000', 'اقل من ٣٠٬٠٠٠', 'under 30,000', 'کەمتر لە 30,000']) assert.deepEqual(priceOf(q), max(30_000), q);
  assert.deepEqual(priceOf('اقل من 1,500,000'), max(1_500_000));
  assert.deepEqual(priceOf('اكثر من 20,000'), min(20_000));
});

test('a range applies only when both ends carry a money marker; written high-to-low it is sorted only with the same marker', () => {
  const range = (min: number, max: number) => ({ min, max, currency: 'IQD' });
  assert.deepEqual(priceOf('بين 5 الاف و 15 الف'), range(5_000, 15_000));
  assert.deepEqual(priceOf('بين 5,000 و 15,000'), range(5_000, 15_000));
  assert.deepEqual(priceOf('from 2k to 20k'), range(2_000, 20_000));
  assert.deepEqual(priceOf('لە نێوان 5 هەزار و 15 هەزار'), range(5_000, 15_000));
  assert.deepEqual(priceOf('بين 500 الف و 1,200,000'), range(500_000, 1_200_000));
  // A bare end, on either side or both: no price, and the range is searched as typed.
  for (const q of [
    'بين 5000 و 15000', 'من 5000 الى 20000', 'from 2000 to 20000', 'nozzle between 5000 and 15000', 'لە نێوان 5000 و 15000', 'بين 500 و 900',
    'بين 25 و 50', 'بين 500 و 1200', 'بين 5,000 و 15', 'بين 50 و 25', 'بين 25 و 50 الف', 'بين 2 و 3 مليون', 'بين مليون و 2', 'بين 500 و مليون',
    'بين 5 الف و 9000', 'بين 1500 و 2 مليون', 'بين 500 الف و 1200',
  ]) {
    assert.equal(priceOf(q), null, q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
  for (const [a, b] of [[1, 9], [500, 999], [500, 1_000], [5_000, 10_000], [9, 15_000]] as const) assert.equal(priceOf(`بين ${a} و ${b}`), null, `${a}..${b}`);
  // Written high-to-low: the same money marker on both ends is sorted, two markers are no price.
  assert.deepEqual(priceOf('بين 50 الف و 25 الف'), range(25_000, 50_000));
  assert.deepEqual(priceOf('بين 15,000 و 5,000'), range(5_000, 15_000));
  assert.deepEqual(priceOf('between 3 million and 2 million'), range(2_000_000, 3_000_000));
  assert.equal(priceOf('بين مليون و 500 الف'), null);
  assert.equal(priceOf('between 1m and 500k'), null);
  // Two bounds: both money marked, or neither applies.
  assert.deepEqual(priceOf('اكثر من 20 الف واقل من 50 الف'), range(20_000, 50_000));
  assert.equal(priceOf('اكثر من 10 واقل من 30 الف'), null);
});

test('a price per unit sold is a price, a measured quantity is not: «اقل من 25 الف للكيلو», "per kg", "/kg", «بۆ هەر کیلۆیەک»', () => {
  const max25 = { min: null, max: 25_000, currency: 'IQD' };
  for (const q of [
    'فلامنت اقل من 25 الف للكيلو', 'فلامنت اقل من 25 الف لكل كيلو', 'فلامنت اقل من 25 الف بالكيلو', 'فلامنت اقل من 25 الف لكيلو',
    'filament under 25k per kg', 'filament under 25k each kg', 'filament under 25k/kg', 'filament under 25k /kg', 'filament under 25k / kg',
    'filament under 25k/ kg', 'filament under 25,000 per kg', 'filament under 25 thousand per kg',
    'فلامنت 25 الف للكيلو او اقل',
    // Per-unit words after a final bound.
    'فلامنت 25 الف او اقل للكيلو', 'filament 25k or less per kg',
    // Sorani: «بۆ هەر کیلۆ», «بۆ هەر کیلۆیەک», «بۆ کیلۆیەک», «کیلۆی» before the price, and after a final bound.
    'فیلامێنت کەمتر لە 25 هەزار بۆ هەر کیلۆ', 'فیلامێنت کەمتر لە 25 هەزار بۆ هەر کیلۆیەک', 'فیلامێنت کەمتر لە 25 هەزار بۆ کیلۆیەک',
    'فیلامێنت کیلۆی کەمتر لە 25 هەزار', 'فیلامێنت کیلۆی لە 25 هەزار کەمتر',
    'فیلامێنت لە 25 هەزار کەمتر بۆ هەر کیلۆیەک', 'فیلامێنت 25 هەزار یان کەمتر بۆ کیلۆیەک',
  ]) {
    const nl = parseNlQuery(q);
    assert.deepEqual(nl.price, max25, q);
    assert.ok(!/كيلو|kg|کیلۆ|\/|بۆ|هەر|each|per/u.test(nl.text), `${q}: the per-unit words went with the price (${nl.text})`);
  }
  assert.deepEqual(priceOf('فلامنت بين 20 الف و 30 الف للكيلو'), { min: 20_000, max: 30_000, currency: 'IQD' });
  // A bare amount, or no comparator («بە», at): no price, and the per-unit words stay searched with it.
  for (const q of ['فلامنت اقل من 25 للكيلو', 'filament under 25 per kg', 'filament under 25/kg', 'فیلامێنت کەمتر لە 25 بۆ کیلۆیەک', 'فیلامێنت کیلۆی بە 25 هەزار', 'PLA اقل من 25 للبكرة']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.price, null, q);
    assert.equal(nl.spool, null, `${q}: a held price word is no spool facet`);
  }
  // Every unit things are sold by: a gram, a piece, a roll, a spool, a litre, a millilitre, a metre.
  for (const [q, v] of [
    ['اقل من 3 الاف لكل قطعة', 3_000], ['اقل من 3 الاف للقطعة', 3_000], ['اقل من 3 الاف للدانة', 3_000], ['اقل من 3 الاف للحبة', 3_000], ['under 3k per piece', 3_000],
    ['PLA اقل من 25 الف للبكرة', 25_000], ['PLA under 25k per spool', 25_000], ['اقل من 25 الف للرول', 25_000], ['under 25k per roll', 25_000],
    ['resin under 30k per litre', 30_000], ['ريزن اقل من 30 الف للتر', 30_000], ['ريزن اقل من 30 الف باللتر', 30_000], ['under 5k per ml', 5_000], ['under 5k/g', 5_000],
    ['PTFE اقل من 5 الاف للمتر', 5_000], ['PTFE اقل من 5 الاف بالمتر', 5_000], ['PTFE under 5k per metre', 5_000],
    ['ڕێزن کەمتر لە 30 هەزار بۆ هەر لیترێک', 30_000], ['PTFE کەمتر لە 5 هەزار بۆ هەر مەترێک', 5_000], ['کەمتر لە 3 هەزار بۆ هەر دانەیەک', 3_000],
    ['PTFE مەتری کەمتر لە 5 هەزار', 5_000], ['کەمتر لە 3 هەزار دانەیەک', 3_000],
  ] as const) {
    assert.equal(priceOf(q)?.max ?? null, v, q);
  }
  // A length, a temperature, a power or a time after «per» or a prefix stays a measure: no price, the words searched.
  for (const q of [
    'اقل من 30 للسم', 'اقل من 30 بالسم', 'اقل من 300 للملم', 'اقل من 300 بالدرجة', 'اقل من 300 لكل درجة', 'اقل من 40 للواط', 'اقل من 50 لكل ساعة', 'اقل من 50 بالساعة',
    'heater under 50 per hour', 'under 30 per cm', 'under 40 per watt', 'under 300 per degree', 'اقل من الف غرام', 'under 2 thousand grams',
  ]) {
    assert.equal(parseNlQuery(q).price, null, q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
  // Without «per» the measure is a quantity again, «2 کیلۆی PLA» (two kilos of PLA) too.
  for (const q of ['فلامنت اقل من 1 كيلو', 'filament under 1 kg', 'اقل من 2 لتر', 'اقل من 5 متر', 'PTFE under 2 metres', 'کەمتر لە 2 کیلۆی PLA', 'printer under 300mm/s']) {
    assert.equal(parseNlQuery(q).price, null, q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
});

test('row 10: a negation is an exclusion — «بدون AMS», «مو كومبو», "without AMS", «بێ AMS»', () => {
  for (const [q, text, word] of [
    ['طابعة بدون AMS', 'طابعة', 'ams'],
    ['طابعة بلا AMS', 'طابعة', 'ams'],
    ['طابعة ما بيه AMS', 'طابعة', 'ams'],
    ['طابعة مو كومبو', 'طابعة', 'combo'],
    ['printer without AMS', 'printer', 'ams'],
    ['printer no combo', 'printer', 'combo'],
    ['non-combo printer', 'printer', 'combo'],
    ['non-AMS printer', 'printer', 'ams'],
    ['چاپکەر بێ AMS', 'چاپکەر', 'ams'],
    ['چاپکەر بەبێ AMS', 'چاپکەر', 'ams'],
    ['چاپکەر نەک کۆمبۆ', 'چاپکەر', 'combo'],
  ] as const) {
    const nl = parseNlQuery(q);
    assert.equal(nl.text, text, q);
    assert.deepEqual(nl.exclude.words, [word], q);
    assert.ok(!nlFold(nl.text).includes('ams') && !/بدون|without|بێ/u.test(nl.text), `${q}: the negation and its word left the search`);
  }
  // A negated constraint is the opposite constraint (the spool beside a filament word only).
  assert.equal(parseNlQuery('فلامنت بدون بكرة').spool, 'refill');
  assert.equal(parseNlQuery('filament without spool').spool, 'refill');
  assert.equal(parseNlQuery('طابعة بدون بكرة').spool, null);
  assert.equal(parseNlQuery('بدون حجز').sale, 'direct');
  assert.deepEqual(parseNlQuery('فلامنت مو اسود').exclude.colours, ['black']);
  assert.deepEqual(parseNlQuery('فلامنت بدون PLA').exclude.materials, ['pla']);
  // «دون» before an amount is a bound, not a negation.
  assert.deepEqual(priceOf('طابعة دون مليون'), { min: null, max: 1_000_000, currency: 'IQD' });
  // "non-" names a product feature unless a known term follows: "Non-Slip Mat" is searched, not excluded.
  for (const q of ['non-slip mat', 'Non-Stick Glue', 'non slip mat', 'non-contact sensor']) {
    const nl = parseNlQuery(q);
    assert.deepEqual(nl.exclude, { colours: [], materials: [], words: [] }, q);
    assert.equal(nl.text, q, q);
  }
  assert.deepEqual(parseNlQuery('non-black PLA').exclude.colours, ['black']);
});

test('a negation carries over "or" in every language: "without AMS or combo", «بێ AMS یان کۆمبۆ», like «بدون AMS ولا كومبو»', () => {
  for (const [q, text] of [
    ['طابعة بدون AMS ولا كومبو', 'طابعة'],
    ['طابعة بدون AMS والا كومبو', 'طابعة'],
    ['طابعة بدون AMS او كومبو', 'طابعة'],
    ['printer without AMS or combo', 'printer'],
    ['printer without AMS nor combo', 'printer'],
    ['printer no AMS or combo', 'printer'],
    ['چاپکەر بێ AMS یان کۆمبۆ', 'چاپکەر'],
    ['چاپکەر بەبێ AMS یان کۆمبۆ', 'چاپکەر'],
  ] as const) {
    const nl = parseNlQuery(q);
    assert.deepEqual(nl.exclude.words, ['ams', 'combo'], q);
    assert.equal(nl.text, text, q);
  }
  // A colour or a material after it, the same.
  assert.deepEqual(parseNlQuery('PLA without black or white').exclude.colours, ['black', 'white']);
  assert.deepEqual(parseNlQuery('فیلامێنت بێ PLA یان PETG').exclude.materials, ['pla', 'petg']);
  // Without a negation "or" is "or": both stay, nothing is excluded.
  for (const q of ['printer AMS or combo', 'چاپکەر AMS یان کۆمبۆ', 'طابعة AMS او كومبو', 'PLA or PETG']) {
    assert.deepEqual(parseNlQuery(q).exclude, { colours: [], materials: [], words: [] }, q);
  }
  assert.equal(parseNlQuery('printer AMS or combo').text, 'printer AMS or combo');
  assert.deepEqual(parseNlQuery('PLA or PETG').materials, ['pla', 'petg']);
  // Only right where a negation ended: a word between them and the combo is searched again.
  assert.deepEqual(parseNlQuery('without AMS printer or combo').exclude.words, ['ams']);
});

test('row 11: refill vs with spool beside a filament word, consumed so «spool» never reaches the spool→filament synonym', () => {
  for (const [q, text] of [
    ['فلامنت ريفل', 'فلامنت'], ['فلامنت ريفيل', 'فلامنت'], ['filament refill', 'filament'], ['فیلامێنت ڕیفیل', 'فیلامێنت'],
    ['فلامنت بدون بكرة', 'فلامنت'], ['فیلامێنت بێ ماسوورە', 'فیلامێنت'], ['PLA filament refill', 'PLA filament'],
  ] as const) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, 'refill', q);
    assert.equal(nl.text, text, q);
  }
  for (const [q, text] of [
    ['فلامنت بكرة كاملة', 'فلامنت'], ['فلامنت مع بكرة', 'فلامنت'], ['filament with spool', 'filament'], ['filament full spool', 'filament'],
    ['فیلامێنت لەگەڵ ماسوورە', 'فیلامێنت'], ['filament spool', 'filament'], ['فلامنت بكرة', 'فلامنت'], ['فیلامێنت ماسوورە', 'فیلامێنت'],
  ] as const) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, 'spool', q);
    assert.equal(nl.text, text, `${q}: no spool word is left for the synonym`);
  }
  // Without a filament word beside it the spool and refill words are a product: a glue or wiper refill, a printer
  // or an AMS with a spool, «بكرة» (tomorrow). A material is no anchor: «PLA refill» searches the refills by name.
  for (const q of [
    'ريفل', 'refill', 'بدون بكرة', 'with spool', 'بكرة كاملة', 'glue refill', 'nozzle wiper refill', 'ريفيل غراء', 'طابعة بدون بكرة',
    'AMS with spool', 'P1S with spool', 'چاپکەر لەگەڵ ماسوورە', 'PLA refill', 'PLA spool', 'PLA اسود يوصل بكرة',
  ]) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, null, q);
    assert.ok(!nl.understood.some((c) => c.kind === 'spool'), q);
  }
  // An empty spool, a spool holder, a reusable spool, an adapter: products, not the facet. Alone, the
  // spool word and the diameter are product names too ("PTFE 1.75" is a tube, not a filament filter).
  for (const q of [
    'empty spool', 'بكرة فارغة', 'حامل بكرة', 'spool holder', 'spool', 'ماسوورە', 'Bambu Reusable Spool', 'بكرة بامبو قابلة لاعادة الاستخدام',
    'reusable spool', 'PETG reusable spool', 'spool adapter', 'spool buffer', 'توصيل بكرة', 'PTFE 1.75', 'انبوب تفلون 1.75', 'PTFE tube 1.75 for PLA',
  ]) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, null, q);
    assert.deepEqual(nl.diameters, [], q);
    assert.equal(nl.text, q, q);
  }
});

test('row 12: «متوفر هسه» is direct, «حجز» is pre-order — never the other', () => {
  for (const q of ['متوفر هسه', 'متوفر', 'هسه متوفر', 'موجود الان', 'in stock', 'available now', 'بەردەستە', 'ئێستا بەردەستە', 'بدون حجز']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.sale, 'direct', q);
    assert.equal(nl.text, '', q);
  }
  for (const q of ['حجز', 'حجز مسبق', 'بالطلب', 'pre-order', 'preorder', 'pre order', 'پێشوەختە', 'داواکاریی پێشوەخت', 'مو متوفر']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.sale, 'preorder', q);
    assert.equal(nl.text, '', q);
  }
  // «هسه» alone is not an availability: it is left to the search.
  assert.equal(parseNlQuery('طابعة هسه').sale, null);
  // A product feature is not the sale mode: "direct drive", "AMS ready", "available colors".
  for (const q of ['direct drive printer', 'direct drive extruder', 'AMS ready printer', 'available colors PLA', 'Bambu Lab printer ready to print', 'طابعة دفع مباشر']) {
    assert.equal(parseNlQuery(q).sale, null, q);
    assert.equal(parseNlQuery(q).text, q, q);
  }
  for (const q of ['direct sale', 'ready to ship', 'now available', 'بيع مباشر', 'البيع المباشر', 'فرۆشتنی ڕاستەوخۆ']) assert.equal(parseNlQuery(q).sale, 'direct', q);
});

test('row 13 and the rest: the diameter, the price order, colour words of every language', () => {
  // The diameter beside a filament word or with mm; a material beside it is no anchor (its chip removed would take it).
  assert.deepEqual(parseNlQuery('فلامنت 1.75').diameters, ['1.75']);
  assert.deepEqual(parseNlQuery('PETG filament ٢٫٨٥').diameters, ['2.85']);
  assert.deepEqual(parseNlQuery('فلامنت قطر 1.75mm').diameters, ['1.75']);
  assert.deepEqual(parseNlQuery('PLA 1.75mm').diameters, ['1.75']);
  assert.deepEqual(parseNlQuery('1.75mm').diameters, ['1.75']);
  assert.equal(parseNlQuery('PLA 1.75mm').text, 'PLA');
  assert.deepEqual(parseNlQuery('PLA 1.75').diameters, []);
  assert.equal(parseNlQuery('PLA 1.75').text, 'PLA 1.75');
  assert.deepEqual(parseNlQuery('طابعة رخيصة').sort, 'price_asc');
  assert.deepEqual(parseNlQuery('cheapest printer').sort, 'price_asc');
  assert.deepEqual(parseNlQuery('چاپکەری هەرزان').sort, 'price_asc');
  for (const [q, c] of [
    ['ابيض', 'white'],
    ['سپی', 'white'],
    ['ڕەش', 'black'],
    ['شفاف', 'transparent'],
    ['لبني', 'blue'],
    ['بالاحمر', 'red'],
    ['multi-color', 'multicolour'],
    ['متعدد الالوان', 'multicolour'],
  ] as const) {
    assert.deepEqual(parseNlQuery(q).colours, [c], q);
  }
});

// =========================================================================
// APPLYING IT: PURE
// =========================================================================

test('nlApply: the words join the listing state, an explicit URL value wins, and a dollar bound needs the shop rate', () => {
  const nl = parseNlQuery('فلامنت ريفل 1.75 متوفر رخيص اقل من 30 الف');
  const { state, understood } = nlApply(DEFAULT_LISTING, nl);
  assert.equal(state.q, 'فلامنت');
  assert.deepEqual(state.price, { min: null, max: 30_000 });
  assert.equal(state.sale, 'direct');
  assert.deepEqual(state.specs, { spool_type: ['refill'], diameter: ['1.75'] });
  assert.equal(state.sort, 'price_asc');
  assert.deepEqual(understood.map((c) => c.kind), ['price', 'sale', 'spool', 'diameter', 'sort']);

  // The URL already says preorder and a price: the words do not override it, and their chips are not reported.
  const own = nlApply({ ...DEFAULT_LISTING, sale: 'preorder', price: { min: 1, max: 2 } }, nl);
  assert.equal(own.state.sale, 'preorder');
  assert.deepEqual(own.state.price, { min: 1, max: 2 });
  assert.ok(!own.understood.some((c) => c.kind === 'sale' || c.kind === 'price'));

  const usd = parseNlQuery('طابعة اقل من 5 ورقات');
  assert.equal(nlApply(DEFAULT_LISTING, usd).state.price, null, 'no rate: not applied');
  assert.deepEqual(nlApply(DEFAULT_LISTING, usd).understood, [], 'and not reported');
  const at = nlApply(DEFAULT_LISTING, usd, { usdIqd: 1_310 });
  assert.deepEqual(at.state.price, { min: null, max: 655_000 });
  assert.deepEqual(at.understood, [{ kind: 'price', min: null, max: 500, currency: 'USD', iqd: { min: null, max: 655_000 } }]);
});

test('a removed chip (smart search 1.7): its own words leave the field, every other word stays as typed', () => {
  const w = (q: string) => parseNlQuery(q).without;
  assert.deepEqual(w('فلامنت اسود اقل من 30 الف'), { price: 'فلامنت اسود', 'color:black': 'فلامنت اقل من 30 الف' });
  assert.deepEqual(w('طابعة بدون AMS'), { 'exclude:ams': 'طابعة' }, 'the negation goes with what it negated');
  assert.deepEqual(w('چاپکەر بێ AMS'), { 'exclude:ams': 'چاپکەر' });
  assert.deepEqual(w('فلامنت مو اسود'), { 'color!:black': 'فلامنت' });
  assert.deepEqual(w('فلامنت بدون بكرة'), { spool: 'فلامنت' }, 'a flipped constraint is one chip with its negation');
  assert.deepEqual(w('متوفر'), { sale: '' }, 'nothing left: the field is emptied');
  // Two bounds are one price chip; a material is a chip AND a search word.
  assert.deepEqual(w('اكثر من 10 الف واقل من 30 الف PLA'), { price: 'PLA', 'material:pla': 'اكثر من 10 الف واقل من 30 الف' });
  // A bare bound beside it: neither applies, and only the material is a chip.
  assert.deepEqual(w('اكثر من 10 واقل من 30 الف PLA'), { 'material:pla': 'اكثر من 10 واقل من 30 الف' });
  assert.deepEqual(w('filament black under $20'), { price: 'filament black', 'color:black': 'filament under $20' });
  // A joining word left at an end has nothing to join.
  assert.equal(w('PLA اسود و رخيص').sort, 'PLA اسود');
  // Read again, the removal text is the same answer less that one chip.
  for (const q of ['فلامنت اسود اقل من 30 الف', 'فلامنت PETG ابيض 1.75 متوفر هسه', 'طابعة رخيصة مو كومبو']) {
    const nl = parseNlQuery(q);
    for (const chip of nl.understood) {
      const again = parseNlQuery(nl.without[nlChipKey(chip)]).understood.map(nlChipKey);
      assert.deepEqual(again, nl.understood.map(nlChipKey).filter((k) => k !== nlChipKey(chip)), `${q} less ${nlChipKey(chip)}`);
    }
  }
  // No exception: with mm the diameter stands without the material, and a material alone anchors nothing.
  assert.deepEqual(parseNlQuery(w('PETG 1.75mm')['material:petg']).diameters, ['1.75']);
  assert.deepEqual(parseNlQuery('PETG 1.75').diameters, []);
});

test('nlKeeps: an exclusion reads names and the family, never the description; a colour needs evidence; a material judges materials only', () => {
  const noAms = parseNlQuery('طابعة بدون AMS');
  assert.ok(nlJudgesProducts(noAms));
  const product = (names: string[], specs: Record<string, unknown> = {}, colours: string[] = []) => ({ names, specs, colours });
  assert.equal(nlKeeps(noAms, product(['Bambu Lab P1S 3D Printer', 'طابعة P1S'])), true, 'a printer that works WITH an AMS is not an AMS');
  assert.equal(nlKeeps(noAms, product(['Bambu Lab X1 Carbon Combo'])), false, 'a combo is the printer with its AMS');
  assert.equal(nlKeeps(noAms, product(['نظام تعدد المواد'], { product_family: 'bambu_lab_ams' })), false, 'the family names it');
  assert.equal(nlKeeps(noAms, product(['Bambu Lab AMS lite'])), false);
  assert.equal(nlKeeps(noAms, product(['', 'طابعة الكومبو'])), false, 'an Arabic name, with its article');
  // A combo left out takes the AMS units with it, unless the search asks for them: «AMS بدون كومبو», "AMS lite non-combo".
  assert.equal(nlKeeps(parseNlQuery('طابعة مو كومبو'), product(['Bambu Lab AMS lite'])), false);
  for (const q of ['AMS بدون كومبو', 'AMS lite without combo', 'AMS lite بێ کۆمبۆ', 'AMS lite non-combo']) {
    const nl = parseNlQuery(q);
    assert.equal(nlKeeps(nl, product(['Bambu Lab AMS lite', 'AMS لايت'])), true, `${q}: the AMS asked for stays`);
    assert.equal(nlKeeps(nl, product(['نظام تعدد المواد'], { product_family: 'bambu_lab_ams' })), true, `${q}: by its family too`);
    assert.equal(nlKeeps(nl, product(['Bambu Lab X1 Carbon Combo'])), false, `${q}: the combo goes`);
  }
  // «لبنية» is light blue, never «ل» + «بنية» (brown).
  const lightBlue = parseNlQuery('PLA لبنية');
  assert.equal(nlKeeps(lightBlue, product(['Bambu PLA Basic'], { color_name: 'blue', material_type: 'PLA' })), true);
  assert.equal(nlKeeps(lightBlue, product(['Bambu PLA Basic'], { color_name: 'brown', material_type: 'PLA' })), false);

  const black = parseNlQuery('فلامنت اسود');
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'], { color_name: 'white | black' })), true, 'the colour facet');
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'], {}, ['Jade White', 'Black'])), true, 'a colour it is sold in');
  assert.equal(nlKeeps(black, product(['فلامنت اسود'])), true, 'its name');
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'], { color_name: 'white' })), false);
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'])), false, 'no evidence, no black');

  // A colour named in a phrase: «Multi-Color» is two words, neither a colour alone.
  const silk = product(['PLA Silk Multi-Color', 'PLA حريري متعدد الالوان'], { material_type: 'PLA' }, ['Aurora Purple', 'Dawn Radiance']);
  for (const q of ['PLA Silk Multi-Color', 'PLA multi-color', 'PLA متعدد الالوان', 'PLA فرە ڕەنگ']) {
    assert.equal(nlKeeps(parseNlQuery(q), silk), true, `${q}: the line the shopper named stays`);
  }
  assert.equal(nlKeeps(parseNlQuery('PLA multi-color'), product(['Bambu PLA Basic'], { color_name: 'black', material_type: 'PLA' })), false);
  assert.equal(nlKeeps(parseNlQuery('PLA بدون متعدد الالوان'), silk), false, 'a multicolour line left out by its name');

  const notBlack = parseNlQuery('فلامنت مو اسود');
  assert.equal(nlKeeps(notBlack, product(['PLA'], { color_name: 'black' })), false, 'sold in black alone');
  assert.equal(nlKeeps(notBlack, product(['PLA'], { color_name: 'white | black' })), true, 'sold in other colours too');

  const pla = parseNlQuery('PLA');
  assert.equal(nlKeeps(pla, product(['Bambu PLA Basic'], { material_type: 'PLA' })), true);
  assert.equal(nlKeeps(pla, product(['Bambu PLA-CF'], { material_type: 'PLA-CF' })), true);
  assert.equal(nlKeeps(pla, product(['Bambu PETG HF'], { material_type: 'PETG' })), false);
  assert.equal(nlKeeps(pla, product(['Hardened Steel Nozzle for PLA and CF'])), true, 'not a material: not judged by one');
  assert.equal(nlKeeps(parseNlQuery('PET'), product(['Bambu PETG HF'], { material_type: 'PETG' })), false, 'PET is not PETG');
});

// =========================================================================
// THROUGH THE ROUTE, ON THE LIMITS D1 ENFORCES
// =========================================================================

interface Seed {
  id: string;
  name: string;
  name_ar?: string;
  description?: string;
  price: number;
  preorder?: boolean;
  specs?: Record<string, string>;
}

const SHOP: Seed[] = [
  // Printers. The P1S describes the AMS it works with; it is not one.
  { id: 'p_p1s', name: 'Bambu Lab P1S 3D Printer', name_ar: 'طابعة بامبو P1S', description: 'A fast printer that works with the AMS for multicolour.', price: 900_000, specs: { product_family: 'bambu_lab_3d_printers' } },
  { id: 'p_a1', name: 'Bambu Lab A1 3D Printer', name_ar: 'طابعة بامبو A1', description: 'An open printer.', price: 600_000, specs: { product_family: 'bambu_lab_3d_printers' } },
  { id: 'p_x1c_combo', name: 'Bambu Lab X1 Carbon Combo', name_ar: 'طابعة X1 كاربون كومبو', description: 'The printer with its AMS.', price: 1_500_000, specs: { product_family: 'bambu_lab_3d_printers' } },
  { id: 'p_ams', name: 'Bambu Lab AMS', name_ar: 'نظام AMS للطابعة', description: 'Multi-material unit for the X1 and P1 printer.', price: 450_000, specs: { product_family: 'bambu_lab_ams' } },
  { id: 'p_ams_lite', name: 'Bambu Lab AMS lite', name_ar: 'AMS لايت لطابعة A1', description: 'For the A1 printer.', price: 300_000, specs: { product_family: 'bambu_lab_ams' } },
  // Filaments: colour, material, spool and diameter on the spec mirror the import writes.
  { id: 'f_black', name: 'Bambu PLA Basic Filament', price: 25_000, specs: { material_type: 'PLA', color_name: 'black', diameter: '1.75', spool_type: 'Refill | With spool' } },
  { id: 'f_white', name: 'Bambu PLA Matte Filament', price: 25_000, specs: { material_type: 'PLA', color_name: 'white', diameter: '1.75', spool_type: 'With spool' } },
  { id: 'f_silk_black', name: 'Bambu PLA Silk Filament', price: 45_000, specs: { material_type: 'PLA', color_name: 'black', diameter: '1.75', spool_type: 'With spool' } },
  { id: 'f_petg_black', name: 'Bambu PETG HF Filament', price: 28_000, specs: { material_type: 'PETG', color_name: 'black', diameter: '1.75', spool_type: 'With spool' } },
  { id: 'f_refill', name: 'Bambu PLA Tough Filament Refill', price: 22_000, specs: { material_type: 'PLA', color_name: 'white | black', diameter: '1.75', spool_type: 'Refill' } },
  { id: 'f_285', name: 'Generic PLA Filament', price: 20_000, specs: { material_type: 'PLA', color_name: 'grey', diameter: '2.85' } },
  { id: 'f_tpu_pre', name: 'Bambu TPU 95A Filament', price: 35_000, preorder: true, specs: { material_type: 'TPU', color_name: 'black', diameter: '1.75', spool_type: 'With spool' } },
  // Accessories named with a spool word or a diameter: no spool type, no diameter, no colour.
  { id: 'a_spool', name: 'Bambu Reusable Spool', name_ar: 'بكرة بامبو قابلة لاعادة الاستخدام', price: 30_000 },
  { id: 'a_ptfe', name: 'PTFE Bowden 1.75mm', name_ar: 'انبوب تفلون 1.75', price: 30_000 },
];

function seedShop(raw: DatabaseSync, rows: readonly Seed[]): void {
  const insert = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, description, price_iqd, status, stock, options, colors,
                           selling_type, sale_types, preorder_transports, images, inventory_mode, ops_policy, spec_fields)
     VALUES (?, ?, ?, ?, '', ?, ?, 'active', ?, '[]', '[]', ?, ?, ?, '[]', 'BASE', '{}', ?)`
  );
  for (const p of rows) {
    insert.run(
      p.id,
      p.id.replace(/_/g, '-'),
      p.name,
      p.name_ar ?? '',
      p.description ?? '',
      p.price,
      p.preorder ? null : 10,
      p.preorder ? 'pre_order' : 'direct_sale',
      p.preorder ? '["pre_order"]' : '["direct_sale"]',
      p.preorder ? '[{"method":"air","active":true}]' : '[]',
      JSON.stringify(p.specs ?? {})
    );
  }
}

async function understandingShop(): Promise<DatabaseSync> {
  const raw = freshDb();
  seedShop(raw, SHOP);
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

type Body = {
  products: { id: string; display_price_iqd?: number | null }[];
  total?: number;
  has_more?: boolean;
  suggestion?: string | null;
  understood?: { text: string; chips: Array<NlChip & { drop: string }> };
};

async function list(db: D1Database, query: string): Promise<Body> {
  const { productRoutes } = await import('../worker/routes/products');
  const app = stubApp(db as never, null, (x) => x.route('/api/products', productRoutes), { host: APEX, env: { DB: db } });
  const res = await app.request(`/api/products?${query}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const body = (await json(res)) as Record<string, unknown>;
  assert.equal(res.status, 200, `${query}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as unknown as Body;
}
/** A finished search with `nl=1` (trailing space: the last word is not still being typed). */
const understand = (db: D1Database, q: string) => list(db, `search=${encodeURIComponent(`${q} `)}&nl=1&limit=50`);
const ids = (b: Body) => b.products.map((p) => p.id).sort();
/** The chips as the parser reads them, without the removal text the route adds (`drop`, smart search 1.7). */
const bare = (chips: Array<NlChip & { drop: string }> | undefined): NlChip[] | undefined =>
  chips?.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'drop')) as NlChip);

test('row 10 through the route: «طابعة بدون AMS» lists the printers and no AMS item — and without nl=1 it is the old search', async () => {
  const db = limitD1(await understandingShop());
  const before = await list(db, `search=${encodeURIComponent('طابعة بدون AMS ')}&limit=50`);
  assert.ok(before.products.some((p) => p.id === 'p_ams'), 'the old search ranks the AMS (the inversion this fixes)');
  assert.equal(before.understood, undefined, 'and says nothing new');

  for (const q of ['طابعة بدون AMS', 'طابعة مو كومبو', 'printer without AMS', 'چاپکەر بێ AMS']) {
    const b = await understand(db, q);
    assert.deepEqual(ids(b), ['p_a1', 'p_p1s'], q);
    for (const p of b.products) assert.ok(!/ams|combo/i.test(SHOP.find((s) => s.id === p.id)!.name), `${q}: ${p.id} is not an AMS item`);
    assert.equal(b.total, 2, q);
  }
  const b = await understand(db, 'طابعة بدون AMS');
  // `drop` (smart search 1.7): what removing the chip searches — the words without «بدون AMS».
  assert.deepEqual(b.understood, { text: 'طابعة', chips: [{ kind: 'exclude', value: 'ams', drop: 'طابعة' }] });
  const dropped = await understand(db, b.understood!.chips[0].drop);
  assert.deepEqual(dropped.understood, { text: 'طابعة', chips: [] }, 'the removed chip is gone, and nothing else was understood');
  assert.deepEqual(violations, []);
});

test('row 9 through the route: black filament at most 30,000 — nothing above the budget, nothing of another colour', async () => {
  const db = limitD1(await understandingShop());
  for (const q of ['فلامنت اسود اقل من 30 الف', 'filament black under 30k', 'فیلامێنت ڕەش کەمتر لە 30 هەزار']) {
    const b = await understand(db, q);
    assert.deepEqual(ids(b), ['f_black', 'f_petg_black', 'f_refill'], q);
    for (const p of b.products) assert.ok((p.display_price_iqd ?? Infinity) <= 30_000, `${q}: ${p.id} is within the budget`);
    assert.deepEqual(bare(b.understood?.chips), [
      { kind: 'price', min: null, max: 30_000, currency: 'IQD' },
      { kind: 'color', value: 'black' },
    ]);
  }
  // A material asked for narrows the materials: PETG is not PLA.
  assert.deepEqual(ids(await understand(db, 'فلامنت PLA اسود اقل من 30 الف')), ['f_black', 'f_refill']);
  assert.deepEqual(violations, []);
});

test('row 11 through the route: «فلامنت ريفل» is the refill facet, «فلامنت بكرة كاملة» the with-spool one — «spool» is not «filament»', async () => {
  const db = limitD1(await understandingShop());
  const refill = await understand(db, 'فلامنت ريفل');
  assert.deepEqual(ids(refill), ['f_black', 'f_refill']);
  assert.deepEqual(refill.understood, { text: 'فلامنت', chips: [{ kind: 'spool', value: 'refill', drop: 'فلامنت' }] });
  const spool = await understand(db, 'فلامنت بكرة كاملة');
  assert.deepEqual(ids(spool), ['f_black', 'f_petg_black', 'f_silk_black', 'f_tpu_pre', 'f_white']);
  // «spool» beside a filament word is the with-spool facet, not every filament: the refill-only spool and the one with no spool fact are not in it.
  const english = await understand(db, 'filament spool');
  assert.deepEqual(ids(english), ids(spool));
  assert.ok(!english.products.some((p) => p.id === 'f_refill' || p.id === 'f_285'));
  assert.deepEqual(ids(await understand(db, 'PLA filament refill')), ['f_black', 'f_refill']);
  // Alone, a refill word is no facet: nothing is filtered.
  assert.deepEqual((await understand(db, 'ريفل')).understood?.chips, []);
  // Alone, the spool word and the diameter name products: nothing is filtered, and the spool and the tube are found.
  for (const [q, id] of [
    ['Bambu Reusable Spool', 'a_spool'],
    ['بكرة بامبو قابلة لاعادة الاستخدام', 'a_spool'],
    ['reusable spool', 'a_spool'],
    ['spool', 'a_spool'],
    ['PTFE 1.75', 'a_ptfe'],
    ['انبوب تفلون 1.75', 'a_ptfe'],
  ] as const) {
    const b = await understand(db, q);
    assert.ok(b.products.some((p) => p.id === id), `${q}: ${id} is listed`);
    assert.deepEqual(b.understood?.chips, [], q);
  }
  assert.deepEqual(violations, []);
});

test('the precision rule through the route: a negation around a price applies nothing, a combo left out keeps the AMS asked for', async () => {
  const db = limitD1(await understandingShop());
  // «على الاكثر» is "at most": the filaments at 30,000 or less, never only the dearer ones.
  const most = await understand(db, 'فلامنت على الاكثر 30 الف');
  assert.deepEqual(bare(most.understood?.chips), [{ kind: 'price', min: null, max: 30_000, currency: 'IQD' }]);
  assert.ok(most.products.some((p) => p.id === 'f_285') && most.products.some((p) => p.id === 'f_refill'), 'the cheap filaments are listed');
  assert.ok(!most.products.some((p) => p.id === 'f_silk_black' || p.id === 'f_tpu_pre'), 'nothing above the budget');
  // "Nor more than a million" after a list: the price is held, the printers under a million stay.
  const nor = await understand(db, 'طابعة بدون AMS ولا اكثر من مليون');
  assert.deepEqual(bare(nor.understood?.chips), [{ kind: 'exclude', value: 'ams' }]);
  assert.ok(nor.products.some((p) => p.id === 'p_a1') && nor.products.some((p) => p.id === 'p_p1s'), 'A1 and P1S are listed');
  // "I do not have more than 30,000": no bound at all, the page is the page without nl=1.
  const have = await understand(db, 'فلامنت ما عندي اكثر من 30 الف');
  assert.deepEqual(have.understood?.chips, []);
  // «لا اريد الاسود»: black is left out, never the only colour kept.
  const notBlack = await understand(db, 'لا اريد الاسود PLA');
  assert.deepEqual(bare(notBlack.understood?.chips), [{ kind: 'material', value: 'pla' }, { kind: 'color', value: 'black', not: true }]);
  assert.ok(notBlack.products.some((p) => p.id === 'f_white') && !notBlack.products.some((p) => p.id === 'f_black'));
  // «AMS بدون كومبو»: the AMS units searched for stay, only the combo goes.
  const ams = await understand(db, 'AMS بدون كومبو');
  assert.ok(ams.products.some((p) => p.id === 'p_ams') && ams.products.some((p) => p.id === 'p_ams_lite'), 'the AMS units are listed');
  assert.ok(!ams.products.some((p) => p.id === 'p_x1c_combo'), 'the combo is left out');
  assert.deepEqual(violations, []);
});

test('«ولا» is "or", a measure is not a budget, a feature is not the sale mode — through the route', async () => {
  const db = limitD1(await understandingShop());
  const either = await understand(db, 'PLA ولا PETG');
  assert.ok(either.products.some((p) => p.id === 'f_petg_black') && either.products.some((p) => p.id === 'f_black'), 'both choices are listed');
  assert.ok(!either.understood?.chips.some((c) => c.kind === 'material' && c.not), 'nothing is excluded');
  const kilo = await understand(db, 'فلامنت اقل من 1 كيلو');
  assert.ok(!kilo.understood?.chips.some((c) => c.kind === 'price'), 'a weight is not a price');
  // A search the words understood nothing in is the plain read: the page, priced — not the listing.
  const plain = await list(db, `search=${encodeURIComponent('Bambu Lab')}&nl=1&limit=6`);
  assert.deepEqual(plain.understood, { text: 'Bambu Lab', chips: [] });
  assert.equal(plain.has_more, undefined, 'the plain read, as without nl=1');
  assert.deepEqual(ids(plain), ids(await list(db, `search=${encodeURIComponent('Bambu Lab')}&limit=6`)));
  // The precision rule: a bare number applies nothing, and the page is the page without nl=1.
  const bare = await list(db, `search=${encodeURIComponent('فلامنت اقل من 30')}&nl=1&limit=6`);
  assert.deepEqual(bare.understood, { text: 'فلامنت اقل من 30', chips: [] });
  assert.equal(bare.has_more, undefined, 'the plain read, as without nl=1');
  assert.deepEqual(ids(bare), ids(await list(db, `search=${encodeURIComponent('فلامنت اقل من 30')}&limit=6`)));
  assert.deepEqual(violations, []);
});

test('the grey completion comes from what the constraints kept, never from a product they left out', async () => {
  const db = limitD1(await understandingShop());
  // The PLA Silk is the only «si…» filament, and it costs 45,000: under 30k it is not listed, so it completes nothing.
  const b = await list(db, `search=${encodeURIComponent('filament under 30k si')}&nl=1&limit=6`);
  assert.ok(!b.products.some((p) => p.id === 'f_silk_black'));
  assert.notEqual(b.suggestion, 'Silk');
  const open = await list(db, `search=${encodeURIComponent('filament si')}&nl=1&limit=6`);
  assert.equal(open.suggestion, 'Silk', 'without the budget it is listed, and completes the word');
  assert.deepEqual(violations, []);
});

test('a colour or an exclusion alone walks the whole shop: a match past the candidate cap is found, and only the page is priced', async () => {
  const { listCatalogProducts, pricingCtxForUser } = await import('../worker/routes/products');
  const raw = freshDb();
  const rows: Seed[] = Array.from({ length: 30 }, (_, i) => ({
    id: `p_${String(i).padStart(2, '0')}`,
    name: i % 7 === 0 ? `Widget ${i} Black` : i % 10 === 5 ? `Widget ${i} AMS Hub` : `Widget ${i}`,
    price: 10_000 + i,
    specs: i % 7 === 0 ? { color_name: 'black' } : ({} as Record<string, string>),
  }));
  seedShop(raw, rows);
  const db = asD1(raw);
  const CAP = 10;
  const run = async (q: Record<string, string>) =>
    (await listCatalogProducts(db, q, pricingCtxForUser(db, null), { caps: { candidates: CAP } })).body as unknown as Body;
  const black = await run({ search: 'black ', nl: '1', limit: '50' });
  assert.deepEqual(ids(black), ['p_00', 'p_07', 'p_14', 'p_21', 'p_28'], 'every black widget, the ones past the cap too');
  assert.equal(black.total, 5);
  const noAms = await run({ search: 'without AMS ', nl: '1', limit: '6' });
  assert.equal(noAms.total, 27, 'every widget but the three AMS hubs, past the cap too');
  assert.equal(noAms.products.length, 6);
  assert.equal(noAms.has_more, true);
  const rest = await run({ search: 'without AMS ', nl: '1', limit: '50', offset: '6' });
  assert.equal(rest.products.length, 21);
  assert.ok(![...noAms.products, ...rest.products].some((p) => /^p_(05|15|25)$/.test(p.id)));
});

test('row 12 through the route: «متوفر هسه» is direct sale only, «حجز» pre-order only', async () => {
  const db = limitD1(await understandingShop());
  const direct = await understand(db, 'فلامنت متوفر هسه');
  assert.ok(direct.products.length > 0);
  assert.ok(!direct.products.some((p) => p.id === 'f_tpu_pre'), 'no pre-order item');
  assert.deepEqual(bare(direct.understood?.chips), [{ kind: 'sale', value: 'direct' }]);
  const pre = await understand(db, 'فلامنت حجز');
  assert.deepEqual(ids(pre), ['f_tpu_pre']);
  assert.deepEqual(ids(await understand(db, 'حجز')), ['f_tpu_pre'], 'the words alone: the whole shop, filtered');
  assert.deepEqual(violations, []);
});

test('the words alone, with nothing left to search: the whole shop under the constraints', async () => {
  const db = limitD1(await understandingShop());
  const cheap = await understand(db, 'اقل من 23 الف');
  assert.deepEqual(ids(cheap), ['f_285', 'f_refill']);
  // An exclusion alone is judged per product too.
  const noCombo = await understand(db, 'مو كومبو');
  assert.ok(noCombo.products.length > 0);
  assert.ok(!noCombo.products.some((p) => ['p_ams', 'p_ams_lite', 'p_x1c_combo'].includes(p.id)));
  // A diameter: that one only.
  assert.deepEqual(ids(await understand(db, 'فلامنت 2.85')), ['f_285']);
  assert.deepEqual(violations, []);
});
