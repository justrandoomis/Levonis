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
 * words; and what keeps it honest: a number without a money word or a bound is
 * not a price (X1C, 0.4, 6×2, 10101, a resin printer «8K»), a word it does not
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

test('amounts: number words, halves and quarters, ranges, bounds after the amount, and dollars', () => {
  const max = (v: number) => ({ min: null, max: v, currency: 'IQD' });
  assert.deepEqual(priceOf('طابعة بمليون ونص'), max(1_500_000));
  assert.deepEqual(priceOf('نص مليون'), max(500_000));
  assert.deepEqual(priceOf('ربع مليون'), max(250_000));
  assert.deepEqual(priceOf('مليونين'), max(2_000_000));
  assert.deepEqual(priceOf('مليون و 250'), max(1_250_000));
  assert.deepEqual(priceOf('خمسة وعشرين الف'), max(25_000));
  assert.deepEqual(priceOf('ب 500 الف'), max(500_000));
  assert.deepEqual(priceOf('half a million'), max(500_000));
  assert.deepEqual(priceOf('نیو ملیۆن'), max(500_000));
  assert.deepEqual(priceOf('اقل من 30'), max(30_000), 'a bare number beside a bound is thousands (Iraqi shorthand)');
  assert.deepEqual(priceOf('اكثر من مليون'), { min: 1_000_000, max: null, currency: 'IQD' });
  assert.deepEqual(priceOf('مو اكثر من مليون'), max(1_000_000), 'a negated lower bound is an upper bound');
  assert.deepEqual(priceOf('زیاتر لە ملیۆنێک'), null, 'an unknown word is not guessed into a number');
  for (const q of ['بين 500 الف و مليون', 'من 500 الف الى مليون', 'between 500k and 1m', '500 الف - مليون', 'لە نێوان 500 هەزار و ملیۆن']) {
    assert.deepEqual(priceOf(q), { min: 500_000, max: 1_000_000, currency: 'IQD' }, q);
  }
  assert.deepEqual(priceOf('250-400 الف'), { min: 250_000, max: 400_000, currency: 'IQD' }, 'the bare end borrows the thousand');
  assert.deepEqual(priceOf('بين 25 و 50 الف'), { min: 25_000, max: 50_000, currency: 'IQD' });
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
    ['چاپکەر بێ AMS', 'چاپکەر', 'ams'],
    ['چاپکەر بەبێ AMS', 'چاپکەر', 'ams'],
    ['چاپکەر نەک کۆمبۆ', 'چاپکەر', 'combo'],
  ] as const) {
    const nl = parseNlQuery(q);
    assert.equal(nl.text, text, q);
    assert.deepEqual(nl.exclude.words, [word], q);
    assert.ok(!nlFold(nl.text).includes('ams') && !/بدون|without|بێ/u.test(nl.text), `${q}: the negation and its word left the search`);
  }
  // A negated constraint is the opposite constraint.
  assert.equal(parseNlQuery('بدون بكرة').spool, 'refill');
  assert.equal(parseNlQuery('without spool').spool, 'refill');
  assert.equal(parseNlQuery('بدون حجز').sale, 'direct');
  assert.deepEqual(parseNlQuery('فلامنت مو اسود').exclude.colours, ['black']);
  assert.deepEqual(parseNlQuery('فلامنت بدون PLA').exclude.materials, ['pla']);
  // «دون» before an amount is a bound, not a negation.
  assert.deepEqual(priceOf('طابعة دون مليون'), { min: null, max: 1_000_000, currency: 'IQD' });
});

test('row 11: refill vs with spool, consumed so «spool» never reaches the spool→filament synonym', () => {
  for (const q of ['ريفل', 'ريفيل', 'refill', 'ڕیفیل', 'بدون بكرة', 'بێ ماسوورە', 'عبوة بدون بكرة']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, 'refill', q);
    assert.equal(nl.text, '', q);
  }
  for (const q of ['بكرة كاملة', 'مع بكرة', 'spool', 'with spool', 'full spool', 'ماسوورە', 'لەگەڵ ماسوورە']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, 'spool', q);
    assert.equal(nl.text, '', `${q}: no spool word is left for the synonym`);
  }
  const pla = parseNlQuery('PLA refill');
  assert.equal(pla.text, 'PLA');
  assert.equal(pla.spool, 'refill');
  // An empty spool and a spool holder are products, not the facet.
  for (const q of ['empty spool', 'بكرة فارغة', 'حامل بكرة', 'spool holder']) {
    const nl = parseNlQuery(q);
    assert.equal(nl.spool, null, q);
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
});

test('row 13 and the rest: the diameter, the price order, colour words of every language', () => {
  assert.deepEqual(parseNlQuery('PLA 1.75').diameters, ['1.75']);
  assert.deepEqual(parseNlQuery('PETG ٢٫٨٥').diameters, ['2.85']);
  assert.deepEqual(parseNlQuery('فلامنت قطر 1.75mm').diameters, ['1.75']);
  assert.equal(parseNlQuery('PLA 1.75').text, 'PLA');
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
  assert.deepEqual(w('ريفل'), { spool: '' }, 'nothing left: the field is emptied');
  // Two bounds are one price chip; a material is a chip AND a search word.
  assert.deepEqual(w('اكثر من 10 واقل من 30 الف PLA'), { price: 'PLA', 'material:pla': 'اكثر من 10 واقل من 30 الف' });
  assert.deepEqual(w('filament black under $20'), { price: 'filament black', 'color:black': 'filament under $20' });
  // A joining word left at an end has nothing to join.
  assert.equal(w('PLA اسود و رخيص').sort, 'PLA اسود');
  // Read again, the removal text is the same answer less that one chip.
  for (const q of ['فلامنت اسود اقل من 30 الف', 'PETG ابيض 1.75 متوفر هسه', 'طابعة رخيصة مو كومبو']) {
    const nl = parseNlQuery(q);
    for (const chip of nl.understood) {
      const again = parseNlQuery(nl.without[nlChipKey(chip)]).understood.map(nlChipKey);
      assert.deepEqual(again, nl.understood.map(nlChipKey).filter((k) => k !== nlChipKey(chip)), `${q} less ${nlChipKey(chip)}`);
    }
  }
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

  const black = parseNlQuery('فلامنت اسود');
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'], { color_name: 'white | black' })), true, 'the colour facet');
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'], {}, ['Jade White', 'Black'])), true, 'a colour it is sold in');
  assert.equal(nlKeeps(black, product(['فلامنت اسود'])), true, 'its name');
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'], { color_name: 'white' })), false);
  assert.equal(nlKeeps(black, product(['Bambu PLA Basic'])), false, 'no evidence, no black');

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
];

async function understandingShop(): Promise<DatabaseSync> {
  const raw = freshDb();
  const insert = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, description, price_iqd, status, stock, options, colors,
                           selling_type, sale_types, preorder_transports, images, inventory_mode, ops_policy, spec_fields)
     VALUES (?, ?, ?, ?, '', ?, ?, 'active', ?, '[]', '[]', ?, ?, ?, '[]', 'BASE', '{}', ?)`
  );
  for (const p of SHOP) {
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
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

type Body = {
  products: { id: string; display_price_iqd?: number | null }[];
  total?: number;
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

test('row 11 through the route: «ريفل» is the refill facet, «بكرة كاملة» the with-spool one — «spool» is not «filament»', async () => {
  const db = limitD1(await understandingShop());
  const refill = await understand(db, 'ريفل');
  assert.deepEqual(ids(refill), ['f_black', 'f_refill']);
  assert.deepEqual(refill.understood, { text: '', chips: [{ kind: 'spool', value: 'refill', drop: '' }] });
  const spool = await understand(db, 'بكرة كاملة');
  assert.deepEqual(ids(spool), ['f_black', 'f_petg_black', 'f_silk_black', 'f_tpu_pre', 'f_white']);
  // «spool» is the with-spool facet, not every filament: the refill-only spool and the one with no spool fact are not in it.
  const english = await understand(db, 'spool');
  assert.deepEqual(ids(english), ids(spool));
  assert.ok(!english.products.some((p) => p.id === 'f_refill' || p.id === 'f_285'));
  assert.deepEqual(ids(await understand(db, 'PLA refill')), ['f_black', 'f_refill']);
  assert.deepEqual(violations, []);
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
