/**
 * THE PRICE FEED'S ROWS (worker/lib/priceFeed.ts) — what Meta Business Agent may
 * say about each product: a price only for a direct sale on the shelf now, at
 * its final price; never an estimate («سعر تقديري») and never a pre-order price;
 * a pre-order is only «we can get it for you»; a catalog-only product has no
 * price. RFC 4180 quoting, the header row, UTF-8 without a BOM, and the order
 * (in stock, pre-order, not priced; then section, then name).
 *
 * The route itself — the listing paged whole, the shelf's direct prices beside
 * the card's pre-order «from» — is tests/priceFeedRoute.test.ts.
 *
 * Run: node --import tsx --test tests/priceFeed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_FEED_HEADER,
  PRICE_FEED_STATUS,
  categoryRanks,
  groupedIqd,
  onShelfNow,
  priceFeedCsv,
  priceFeedRows,
  priceFeedVerdict,
  type PriceFeedProduct,
  type ShelfSale,
} from '../worker/lib/priceFeed';

const ORIGIN = 'https://levonis-iq.com';
const OPTS = { origin: ORIGIN, categoryRanks: new Map<string, number>() };

/** A priced listing card, as `GET /api/products` serializes one. */
const card = (slug: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `p_${slug}`,
  slug,
  name: `Name ${slug}`,
  price_status: 'priced',
  display_price_iqd: 500_000,
  display_from: false,
  sale_types: ['direct_sale'],
  direct_stock_available: 0,
  ...over,
});
const product = (c: Record<string, unknown>, shelf: PriceFeedProduct['shelf'] = [], nameAr = ''): PriceFeedProduct => ({ card: c, name_ar: nameAr, shelf });

const IN_STOCK = PRICE_FEED_STATUS.in_stock;
const PRE_ORDER = PRICE_FEED_STATUS.pre_order;
const NOT_PRICED = PRICE_FEED_STATUS.not_priced;

test('the header row is the owner’s nine columns, the body is UTF-8 without a BOM, lines end CRLF', () => {
  // The first seven in their places since 2026-11-04; the sale's occasion and end appended (DECISIONS row 296).
  assert.deepEqual(PRICE_FEED_HEADER, ['الاسم', 'Name', 'الحالة', 'Status', 'السعر (د.ع)', 'السعر قبل الخصم (د.ع)', 'الرابط', 'المناسبة', 'ينتهي العرض']);
  const csv = priceFeedCsv([product(card('a1', { direct_stock_available: 3 }), [{ price_iqd: 760_500, estimate: false }], 'طابعة A1')], OPTS);
  assert.equal(csv.charCodeAt(0), 'ا'.charCodeAt(0), 'no BOM before the header');
  assert.ok(!csv.includes('﻿'));
  assert.equal(
    csv,
    'الاسم,Name,الحالة,Status,السعر (د.ع),السعر قبل الخصم (د.ع),الرابط,المناسبة,ينتهي العرض\r\nطابعة A1,Name a1,متوفر الآن (بيع مباشر),In stock,"760,500",,https://levonis-iq.com/product/a1,,\r\n'
  );
});

test('during a sale (owner, 2026-11-04): «السعر قبل الخصم» is the struck price of the very selection the figure is — and only then', () => {
  const sale = (shelf: PriceFeedProduct['shelf']) => priceFeedRows([product(card('a1', { direct_stock_available: 5 }), shelf)], OPTS)[1];
  // One selection on offer: the price and its struck price.
  assert.deepEqual(sale([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500 }]).slice(4, 6), ['699,000', '760,500']);
  // Two on offer: «يبدأ من» the cheaper one, and THAT selection's struck price.
  assert.deepEqual(
    sale([{ price_iqd: 885_000, estimate: false, before_iqd: 946_500 }, { price_iqd: 699_000, estimate: false, before_iqd: 760_500 }]).slice(4, 6),
    ['يبدأ من 699,000', '760,500']
  );
  // The cheapest selection is not on offer, a dearer one is: no struck price beside a figure that was never lowered.
  assert.deepEqual(sale([{ price_iqd: 699_000, estimate: false }, { price_iqd: 885_000, estimate: false, before_iqd: 946_500 }]).slice(4, 6), ['يبدأ من 699,000', '']);
  // Two selections at the same figure, two struck prices: the smaller saving (never more than the site shows).
  assert.deepEqual(
    sale([{ price_iqd: 699_000, estimate: false, before_iqd: 800_000 }, { price_iqd: 699_000, estimate: false, before_iqd: 760_500 }]).slice(4, 6),
    ['699,000', '760,500']
  );
  // The same figure, one selection struck and one sold at it undiscounted (the P1S at 900,000, the Combo cut to
  // 900,000 from 1,125,000): the product's price did not drop, so nothing is struck.
  assert.deepEqual(sale([{ price_iqd: 900_000, estimate: false }, { price_iqd: 900_000, estimate: false, before_iqd: 1_125_000 }]).slice(4, 6), ['900,000', '']);
  // A sale that takes a dearer model below the cheapest one: «يبدأ من» the new low, struck against the OLD low
  // (900,000), never against the dearer model's own struck price (1,125,000) — the card's «over the same levels».
  assert.deepEqual(
    sale([{ price_iqd: 900_000, estimate: false }, { price_iqd: 840_000, estimate: false, before_iqd: 1_125_000 }]).slice(4, 6),
    ['يبدأ من 840,000', '900,000']
  );
  // A struck price not above the figure, or on an estimated selection, is never printed.
  assert.deepEqual(sale([{ price_iqd: 699_000, estimate: false, before_iqd: 699_000 }]).slice(4, 6), ['699,000', '']);
  assert.deepEqual(sale([{ price_iqd: 650_000, estimate: true, before_iqd: 760_500 }, { price_iqd: 699_000, estimate: false }]).slice(4, 6), ['يبدأ من 699,000', '']);
  assert.deepEqual(priceFeedVerdict(product(card('a1', { direct_stock_available: 5 }), [{ price_iqd: 699_000, estimate: false, before_iqd: 760_500 }])), {
    status: 'in_stock',
    price: { iqd: 699_000, from: false, before_iqd: 760_500, sale: null },
  });
  // A pre-order or a product with no price never carries one, whatever its shelf says.
  const pre = card('h2d', { sale_types: ['pre_order'] });
  delete pre.direct_stock_available;
  const preRow = priceFeedRows([product(pre, [{ price_iqd: 699_000, estimate: false, before_iqd: 760_500 }])], OPTS)[1];
  assert.deepEqual(preRow.slice(3, 6), ['Pre-order', '', '']);
  assert.doesNotMatch(priceFeedCsv([product(pre, [{ price_iqd: 699_000, estimate: false, before_iqd: 760_500 }])], OPTS), /760,500|699,000/);
});

test('the sale’s occasion and end (owner, 2026-11-05): «المناسبة» and «ينتهي العرض» beside «السعر قبل الخصم», and only there', () => {
  const BF_END = '2026-11-27T20:59:00.000Z'; // Friday 27/11/2026, 23:59 in Baghdad
  const BF: ShelfSale = { occasion: { badge: 'black_friday' }, ends_at: BF_END };
  const row = (shelf: PriceFeedProduct['shelf'], c = card('a1', { direct_stock_available: 5 })) => priceFeedRows([product(c, shelf)], OPTS)[1];
  const link = `${ORIGIN}/product/a1`;
  // A Black Friday sale: the price, its struck price, the link, the occasion, the end — the last two appended.
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: BF }]).slice(4), [
    '699,000',
    '760,500',
    link,
    'بلاك فرايدي',
    'الجمعة 27/11/2026 الساعة 11:59 مساءً',
  ]);
  // Every preset reads its own Arabic name; the owner's own name reads as he wrote it.
  const occasionOf = (occasion: ShelfSale['occasion']) => row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: { occasion, ends_at: BF_END } }])[7];
  assert.equal(occasionOf({ badge: 'singles_day' }), 'عروض 11.11');
  assert.equal(occasionOf({ badge: 'eid_al_fitr' }), 'عيد الفطر');
  assert.equal(occasionOf({ badge: 'white_friday' }), 'الجمعة البيضاء');
  assert.equal(occasionOf({ badge: 'custom', badge_text: { ar: 'عيد ميلاد المتجر', en: 'Store birthday' } }), 'عيد ميلاد المتجر');
  // A sale with no occasion, or one this code does not know (a newer Worker's key), says the end and no name.
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: { occasion: null, ends_at: BF_END } }]).slice(7), ['', 'الجمعة 27/11/2026 الساعة 11:59 مساءً']);
  assert.equal(occasionOf({ badge: 'diwali' }), '');
  assert.equal(occasionOf({ badge: 'custom' }), '', 'a custom occasion without its name is no label');
  // A sale with no end says no end; a sale the owner ends at midnight ends with the day before.
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: { occasion: { badge: 'black_friday' }, ends_at: null } }]).slice(7), ['بلاك فرايدي', '']);
  assert.equal(row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: { occasion: null, ends_at: '2026-11-27T21:00:00.000Z' } }])[8], 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  // «يبدأ من»: the window behind the figure's own selection is the one named.
  const later: ShelfSale = { occasion: { badge: 'cyber_monday' }, ends_at: '2026-11-30T20:59:00.000Z' };
  assert.deepEqual(
    row([{ price_iqd: 885_000, estimate: false, before_iqd: 946_500, sale: later }, { price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: BF }]).slice(4),
    ['يبدأ من 699,000', '760,500', link, 'بلاك فرايدي', 'الجمعة 27/11/2026 الساعة 11:59 مساءً']
  );
  // NEVER WITHOUT A STRIKE. The sale lowers only a dearer selection; it lowers one to a figure another sells
  // at undiscounted; its struck price is not above the figure; the selection is an estimate — no occasion, no end.
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false }, { price_iqd: 885_000, estimate: false, before_iqd: 946_500, sale: BF }]).slice(5), ['', link, '', '']);
  assert.deepEqual(row([{ price_iqd: 900_000, estimate: false }, { price_iqd: 900_000, estimate: false, before_iqd: 1_125_000, sale: BF }]).slice(5), ['', link, '', '']);
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false, before_iqd: 699_000, sale: BF }]).slice(5), ['', link, '', '']);
  assert.deepEqual(row([{ price_iqd: 650_000, estimate: true, before_iqd: 760_500, sale: BF }, { price_iqd: 699_000, estimate: false }]).slice(5), ['', link, '', '']);
  // A pre-order, a product with no price and an empty shelf carry neither, whatever their shelf says.
  const pre = card('a1', { sale_types: ['pre_order'] });
  delete pre.direct_stock_available;
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: BF }], pre).slice(3), ['Pre-order', '', '', link, '', '']);
  assert.deepEqual(row([{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: BF }], card('a1', { price_status: 'unpriced' })).slice(3), ['Not priced', '', '', link, '', '']);
  // The verdict carries the window exactly with the strike.
  assert.deepEqual(priceFeedVerdict(product(card('a1', { direct_stock_available: 5 }), [{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: BF }])).price, {
    iqd: 699_000,
    from: false,
    before_iqd: 760_500,
    sale: BF,
  });
  assert.equal(priceFeedVerdict(product(card('a1', { direct_stock_available: 5 }), [{ price_iqd: 699_000, estimate: false }, { price_iqd: 885_000, estimate: false, before_iqd: 946_500, sale: BF }])).price!.sale, null);
  // The CSV: an owner's name that a spreadsheet would run as a formula keeps its text, defused.
  const csv = priceFeedCsv([product(card('a1', { direct_stock_available: 5 }), [{ price_iqd: 699_000, estimate: false, before_iqd: 760_500, sale: { occasion: { badge: 'custom', badge_text: { ar: '=عرض' } }, ends_at: BF_END } }])], OPTS);
  assert.equal(csv.split('\r\n')[1], `Name a1,Name a1,${IN_STOCK.ar},In stock,"699,000","760,500",${link},'=عرض,الجمعة 27/11/2026 الساعة 11:59 مساءً`);
});

test('in stock now as a direct sale: «متوفر الآن (بيع مباشر)», "In stock", the shelf’s firm direct price — «يبدأ من» only when the shelf differs', () => {
  const one = priceFeedRows([product(card('x1', { direct_stock_available: 2 }), [{ price_iqd: 760_500, estimate: false }])], OPTS)[1];
  assert.deepEqual(one.slice(2, 5), [IN_STOCK.ar, IN_STOCK.en, '760,500']);
  const two = priceFeedRows(
    [product(card('x1', { direct_stock_available: 4 }), [{ price_iqd: 900_000, estimate: false }, { price_iqd: 760_500, estimate: false }, { price_iqd: 760_500, estimate: false }])],
    OPTS
  )[1];
  assert.equal(two[4], 'يبدأ من 760,500');
  // Two shelf selections at one price: no «يبدأ من».
  const same = priceFeedRows([product(card('x1', { direct_stock_available: 4 }), [{ price_iqd: 760_500, estimate: false }, { price_iqd: 760_500, estimate: false }])], OPTS)[1];
  assert.equal(same[4], '760,500');
  assert.deepEqual([groupedIqd(0), groupedIqd(999), groupedIqd(1000), groupedIqd(24_250), groupedIqd(5_216_750)], ['0', '999', '1,000', '24,250', '5,216,750']);
});

test('never the card’s own figure: a product sold both ways shows the shelf’s direct price, not the pre-order «from»', () => {
  // The P1S shape: the card's «يبدأ من 825,000» is the land pre-order; the shelf sells direct at 900,000 / 1,125,000.
  const p1s = card('p1s', { display_price_iqd: 825_000, display_from: true, sale_types: ['direct_sale', 'pre_order'], direct_stock_available: 10 });
  const csv = priceFeedCsv([product(p1s, [{ price_iqd: 900_000, estimate: false }, { price_iqd: 1_125_000, estimate: false }])], OPTS);
  assert.match(csv, /,"يبدأ من 900,000",/);
  assert.doesNotMatch(csv, /825,000/);
});

test('pre-order — pre-order only, and a direct sale sold out with pre-order open: the agent’s sentence and no price, whatever the card says', () => {
  const only = card('h2d', { sale_types: ['pre_order'], display_price_iqd: 5_216_750, display_from: true, price_estimate: true });
  delete only.direct_stock_available;
  const soldOut = card('a1-mini', { sale_types: ['direct_sale', 'pre_order'], direct_stock_available: 0, display_price_iqd: 412_250 });
  const rows = priceFeedRows([product(only), product(soldOut, [])], OPTS);
  for (const row of rows.slice(1)) assert.deepEqual(row.slice(2, 5), [PRE_ORDER.ar, PRE_ORDER.en, '']);
  assert.equal(PRE_ORDER.ar, 'طلب مسبق — نكدر نوفره لك، والإدارة تبلغك بالسعر والموعد');
  const csv = priceFeedCsv([product(only), product(soldOut)], OPTS);
  assert.doesNotMatch(csv, /5,216,750|412,250/);
});

test('not priced — catalog-only, an empty direct shelf with no pre-order, a withheld shelf count — and never a figure', () => {
  const catalogOnly = card('petg-hf', { price_status: 'unpriced', display_price_iqd: null, price_iqd: null, sale_types: undefined });
  const soldOutDirect = card('x2d', { sale_types: ['direct_sale'], direct_stock_available: 0, display_price_iqd: 1_934_000 });
  const withheld = card('pla-red', { sale_types: ['direct_sale'], display_price_iqd: 24_250 });
  delete withheld.direct_stock_available;
  const rows = priceFeedRows([product(catalogOnly), product(soldOutDirect), product(withheld)], OPTS);
  for (const row of rows.slice(1)) assert.deepEqual(row.slice(2, 5), [NOT_PRICED.ar, NOT_PRICED.en, '']);
  assert.equal(NOT_PRICED.ar, 'السعر غير متوفر حالياً');
  assert.doesNotMatch(priceFeedCsv([product(catalogOnly), product(soldOutDirect), product(withheld)], OPTS), /1,934,000|24,250/);
  // The route asks the shelf's prices of the in-stock priced cards only.
  assert.deepEqual([onShelfNow(catalogOnly), onShelfNow(soldOutDirect), onShelfNow(withheld), onShelfNow(card('a', { direct_stock_available: 1 }))], [false, false, false, true]);
});

test('no estimated price ever appears: an estimated shelf is not priced, a mixed shelf quotes only its firm price', () => {
  const allEstimate = card('h2s', { direct_stock_available: 1, price_estimate: true, display_price_iqd: 3_333_000 });
  const verdict = priceFeedVerdict(product(allEstimate, [{ price_iqd: 3_333_000, estimate: true }]));
  assert.deepEqual(verdict, { status: 'not_priced', price: null });
  const mixed = card('p2s', { direct_stock_available: 3, price_estimate: true, display_price_iqd: 1_111_000, display_from: true, sale_types: ['direct_sale', 'pre_order'] });
  const csv = priceFeedCsv(
    [product(allEstimate, [{ price_iqd: 3_333_000, estimate: true }]), product(mixed, [{ price_iqd: 2_222_000, estimate: true }, { price_iqd: 1_555_000, estimate: false }])],
    OPTS
  );
  assert.match(csv, /,"يبدأ من 1,555,000",/, 'the firm shelf price, «يبدأ من» because another shelf selection differs');
  for (const estimate of ['3,333,000', '2,222,000', '1,111,000']) assert.ok(!csv.includes(estimate), estimate);
  // An in-stock card with an empty shelf (nothing the page could open on as a direct sale) has no price either.
  assert.deepEqual(priceFeedVerdict(product(card('z', { direct_stock_available: 2 }), [])), { status: 'not_priced', price: null });
  // A shelf price that is not a positive whole dinar figure is never printed.
  assert.deepEqual(priceFeedVerdict(product(card('z', { direct_stock_available: 2 }), [{ price_iqd: 0, estimate: false }])), { status: 'not_priced', price: null });
});

test('RFC 4180: a comma, a quote or a line break is quoted and its quotes doubled; whitespace is one line; a formula is defused', () => {
  const c = card('x1-carbon', { name: 'Bambu "X1", Carbon\nCombo', direct_stock_available: 1 });
  const csv = priceFeedCsv([product(c, [{ price_iqd: 1_250_000, estimate: false }], 'بامبو، "X1"')], OPTS);
  const line = csv.split('\r\n')[1];
  assert.equal(line, `"بامبو، ""X1""","Bambu ""X1"", Carbon Combo",${IN_STOCK.ar},In stock,"1,250,000",,${ORIGIN}/product/x1-carbon,,`);
  assert.equal(csv.split('\r\n').length, 3, 'one record per line: the header, the product, the final CRLF');
  // A name a spreadsheet would run as a formula keeps its text (the defusing every CSV here gets).
  const formula = priceFeedRows([product(card('f', { name: '=HYPERLINK("x")' }))], OPTS)[1];
  assert.equal(formula[1], '=HYPERLINK("x")');
  assert.match(priceFeedCsv([product(card('f', { name: '=HYPERLINK("x")' }))], OPTS), /,"'=HYPERLINK\(""x""\)",/);
});

test('names: the Arabic column falls back to the English name and the English to the Arabic; links are /product/<slug>', () => {
  const rows = priceFeedRows([product(card('only-en', { name: 'A1 mini' })), product(card('only-ar', { name: '' }), [], 'فلامنت')], { origin: `${ORIGIN}/`, categoryRanks: new Map() });
  const bySlug = new Map(rows.slice(1).map((r) => [r[6], r]));
  assert.deepEqual(bySlug.get(`${ORIGIN}/product/only-en`)!.slice(0, 2), ['A1 mini', 'A1 mini']);
  assert.deepEqual(bySlug.get(`${ORIGIN}/product/only-ar`)!.slice(0, 2), ['فلامنت', 'فلامنت']);
  // A card without a slug has no page to link: it is left out.
  assert.equal(priceFeedRows([product(card('', {}))], OPTS).length, 1);
});

test('order: in stock, then pre-order, then not priced; within each, the section in the tree’s order, then the name', () => {
  const ranks = categoryRanks([
    { id: 'cat_filament', parent_id: null, sort: 2, name_en: 'Filament', name_ar: 'فلامنت' },
    { id: 'cat_printers', parent_id: null, sort: 1, name_en: 'Printers', name_ar: 'طابعات' },
    { id: 'cat_fdm', parent_id: 'cat_printers', sort: 0, name_en: 'FDM printers', name_ar: 'طابعات FDM' },
  ]);
  assert.deepEqual([...ranks.entries()], [['cat_printers', 0], ['cat_fdm', 1], ['cat_filament', 2]]);
  const shelf = [{ price_iqd: 100_000, estimate: false }];
  const products = [
    product(card('pla', { name: 'PLA Basic', category_id: 'cat_filament', sale_types: ['pre_order'] })),
    product(card('unpriced', { name: 'Aaa', price_status: 'unpriced', category_id: 'cat_printers' })),
    product(card('p1s', { name: 'P1S', category_id: 'cat_printers', sub_category_id: 'cat_fdm', direct_stock_available: 1 }), shelf),
    product(card('a1', { name: 'A1', category_id: 'cat_printers', sub_category_id: 'cat_fdm', direct_stock_available: 1 }), shelf),
    product(card('petg', { name: 'PETG', category_id: 'cat_filament', direct_stock_available: 1 }), shelf),
    product(card('nowhere', { name: 'Zzz', category_id: 'cat_gone', direct_stock_available: 1 }), shelf),
    product(card('h2d', { name: 'H2D', category_id: 'cat_printers', sale_types: ['pre_order'] })),
  ];
  const order = priceFeedRows(products, { origin: ORIGIN, categoryRanks: ranks }).slice(1).map((r) => `${r[3]}:${r[1]}`);
  assert.deepEqual(order, ['In stock:A1', 'In stock:P1S', 'In stock:PETG', 'In stock:Zzz', 'Pre-order:H2D', 'Pre-order:PLA Basic', 'Not priced:Aaa']);
  // A cycle has no root and is ranked after the trees; a node is never ranked twice.
  const cyclic = categoryRanks([
    { id: 'a', parent_id: 'b', sort: 0, name_en: 'A', name_ar: '' },
    { id: 'b', parent_id: 'a', sort: 0, name_en: 'B', name_ar: '' },
    { id: 'r', parent_id: null, sort: 9, name_en: 'Root', name_ar: '' },
  ]);
  assert.deepEqual([...cyclic.entries()], [['r', 0], ['a', 1], ['b', 2]]);
});
