/**
 * A SALE ON A STORE PAGE (docs/SMART_PRICING.md §3.1, §3.3, §3.6): ONE RULE IN EVERY STORE READER.
 *
 * When an offer's `priceSpecification` (one object or a list) holds a StrikethroughPrice or
 * ListPrice (the schema.org URL or the bare name) in the offer's currency above `offers.price`,
 * the regular price is the price written or saved and the sale price is reported beside it:
 * a price that ends with the sale is never written as the list price. An entry with a
 * referenceQuantity is a unit price (per kg) and never the item's regular price. Three readers
 * keep the rule, and are held here to one table:
 *   - the capture tools' shared core, scripts/supplier-prices/normalize-eu-snapshot.mjs `offerPriceOf`;
 *   - the store script's page reader, scripts/supplier-prices/capture-store-offers.ts `pageItem`
 *     (the regular price written, the sale price in the report's `on_sale`);
 *   - the owner's one-page read, worker/lib/supplierPrices/storePage.ts `extractStoreOffers`
 *     (`price` is what a save writes, `sale_price` is only answered).
 * And the owner's price sheet tells him, in Arabic, English and Sorani, that the page is on sale
 * and which price was saved, naming the sale price only when it is the saved variant's.
 *
 * Run: node --import tsx --test tests/supplierPriceSaleRule.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error - plain ESM capture tool, no types; typed below
import * as shared from '../scripts/supplier-prices/normalize-eu-snapshot.mjs';
import { pageItem, type CaptureReport, type StoreKey } from '../scripts/supplier-prices/capture-store-offers';
import { chosenOffer, extractStoreOffers } from '../worker/lib/supplierPrices/storePage';
import type { StorePageRead } from '../src/components/adminEstimates/api';
import { StoreReadResult, storeSavedNote } from '../src/components/adminEstimates/UpdatePriceSheet';
import { PRICE_SHEET, say, type UiLang } from '../src/components/adminEstimates/strings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Json = Record<string, unknown>;
type Want = { price: string; sale_price?: string } | { refused: string };

const offerPriceOf: (offer: unknown) => { price?: string; sale_price?: string; refused?: string; detail?: string } = shared.offerPriceOf;
const decimalAbove: (a: string, b: string) => boolean = shared.decimalAbove;

const STRIKE = 'https://schema.org/StrikethroughPrice';
const spec = (priceType: string | undefined, price: unknown, priceCurrency: string | undefined = 'EUR'): Json => ({
  '@type': 'UnitPriceSpecification',
  ...(priceType === undefined ? {} : { priceType }),
  price,
  ...(priceCurrency === undefined ? {} : { priceCurrency }),
});
/** A unit price: the price of a reference quantity (per kg here), not of the item. */
const PER_KG = { '@type': 'QuantitativeValue', value: 1, unitCode: 'KGM' };
const unit = (priceType: string, price: unknown, referenceQuantity: unknown = PER_KG): Json => ({ ...spec(priceType, price), referenceQuantity });
const offer = (price: unknown, priceSpecification?: unknown, priceCurrency = 'EUR'): Json => ({
  '@type': 'Offer',
  price,
  priceCurrency,
  availability: 'https://schema.org/InStock',
  ...(priceSpecification === undefined ? {} : { priceSpecification }),
});

const CASES: Array<[string, Json, Want]> = [
  ['no priceSpecification', offer(239), { price: '239' }],
  ['a StrikethroughPrice above it, one object, the schema.org URL', offer(239, spec(STRIKE, 259)), { price: '259', sale_price: '239' }],
  ['the bare name', offer(239, spec('StrikethroughPrice', 259)), { price: '259', sale_price: '239' }],
  ['http, any case', offer(239, spec('http://schema.org/strikethroughprice', 259)), { price: '259', sale_price: '239' }],
  ['a list holding the sale price and the regular one', offer(239, [spec(undefined, 239), spec(STRIKE, 259)]), { price: '259', sale_price: '239' }],
  ['a ListPrice, the URL, in a list', offer(1799, [spec('https://schema.org/ListPrice', 2149)]), { price: '2149', sale_price: '1799' }],
  ['a ListPrice, the bare name', offer(1799, spec('ListPrice', 2149)), { price: '2149', sale_price: '1799' }],
  ['two regular prices: the highest', offer(239, [spec(STRIKE, 259), spec('ListPrice', 279)]), { price: '279', sale_price: '239' }],
  ['decimal text kept as written', offer('17.59', spec(STRIKE, '50.98')), { price: '50.98', sale_price: '17.59' }],
  ['an entry without a currency is in the offer’s', offer(239, spec(STRIKE, 259, undefined)), { price: '259', sale_price: '239' }],
  ['the entry’s currency in lower case', offer(239, spec(STRIKE, 259, 'eur')), { price: '259', sale_price: '239' }],
  ['a struck-through price equal to the price is no sale', offer(239, spec(STRIKE, '239.00')), { price: '239' }],
  ['below the price is no sale', offer(239, spec(STRIKE, 199)), { price: '239' }],
  ['another currency is never compared', offer(239, spec(STRIKE, 299, 'USD')), { price: '239' }],
  [
    'another price type is no regular price',
    offer(239, [spec('https://schema.org/SalePrice', 299), spec('MSRP', 299), spec(undefined, 299), spec('https://example.com/StrikethroughPrice', 299)]),
    { price: '239' },
  ],
  ['no regular price stated: null, empty, zero', offer(239, [spec(STRIKE, null), spec(STRIKE, ''), spec(STRIKE, 0), spec('ListPrice', '0.00')]), { price: '239' }],
  ['what is not an entry is skipped', offer(239, [null, 'StrikethroughPrice', 259, [spec(STRIKE, 999)], spec(STRIKE, 259)]), { price: '259', sale_price: '239' }],
  ['a unit price (a referenceQuantity, per kg) is never the regular price', offer(9.99, unit(STRIKE, 19.98)), { price: '9.99' }],
  ['…nor a unit ListPrice in a list; the item’s own StrikethroughPrice beside it is', offer(9.99, [unit('ListPrice', 49.95), spec(STRIKE, 12.99)]), { price: '12.99', sale_price: '9.99' }],
  ['…a unit price is skipped even when its price cannot be read', offer(9.99, unit(STRIKE, '19,98')), { price: '9.99' }],
  ['a referenceQuantity of null is none', offer(239, unit(STRIKE, 259, null)), { price: '259', sale_price: '239' }],
  ['a stated regular price that cannot be read refuses the offer: a comma', offer(239, spec(STRIKE, '259,00')), { refused: 'regular_price_invalid' }],
  ['…or a float of three decimals', offer(239, spec('ListPrice', 259.123)), { refused: 'regular_price_invalid' }],
  ['no offer price is refused as before, whatever the regular one', offer(undefined, spec(STRIKE, 259)), { refused: 'price_missing' }],
];

const HOSTS: Readonly<Record<StoreKey, string>> = { eu: 'eu.store.bambulab.com', us: 'us.store.bambulab.com' };
const LANGS = ['ar', 'en', 'ckb'] as const satisfies readonly UiLang[];

/** One variant on a store page in the store's JSON-LD shape (`ProductGroup.hasVariant[].offers`). */
function pageOf(store: StoreKey, o: Json): string {
  const host = HOSTS[store];
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'ProductGroup',
    name: 'Probe',
    url: `https://${host}/products/probe`,
    hasVariant: [{ '@type': 'Product', sku: '1', name: 'Probe - One', offers: { ...o, url: `https://${host}/products/probe?id=1` } }],
  };
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
}

function emptyReport(store: StoreKey): CaptureReport {
  return {
    store,
    source: store === 'eu' ? 'bambu_eu' : 'bambu_us',
    currency: store === 'eu' ? 'EUR' : 'USD',
    captured_on: '2026-11-01',
    rows: 1,
    items: 0,
    skus: 0,
    requests: 0,
    captured: [],
    redirected: [],
    withdrawn: [],
    refused: [],
    refused_variants: [],
    on_sale: [],
    robots_disallowed: [],
    failed: [],
    stopped: null,
    not_reached: 0,
  };
}

/** The three readers on one offer, each answer in the table's shape. */
function readersOn(store: StoreKey, o: Json) {
  const core = offerPriceOf(o);
  const html = pageOf(store, o);
  const report = emptyReport(store);
  const item = pageItem(store, { type: 'printer' }, 'probe', 'probe', HOSTS[store], html, report);
  const offers = extractStoreOffers(html);
  return {
    core: core.price ? { price: core.price, ...(core.sale_price ? { sale_price: core.sale_price } : {}) } : { refused: core.refused },
    script: item
      ? { price: item.skus[0]!.price, ...(report.on_sale.length ? { sale_price: report.on_sale[0]!.sale_price } : {}) }
      : { refused: report.refused_variants[0]?.reason },
    scriptReport: report,
    page: offers.length ? { price: offers[0]!.price, ...(offers[0]!.sale_price ? { sale_price: offers[0]!.sale_price } : {}) } : { refused: 'dropped' },
    offers,
  };
}

test('one rule in the three readers: on sale the regular price is the price and the sale price is told beside it, never written', () => {
  for (const [label, o, want] of CASES) {
    const r = readersOn('eu', o);
    assert.deepEqual(r.core, want, `shared core: ${label}`);
    assert.deepEqual(r.script, want, `capture script: ${label}`);
    if ('refused' in want) {
      // Nothing written, nothing saved: the owner's read drops the offer (502 when it was the only one).
      assert.deepEqual(r.page, { refused: 'dropped' }, `one-page read: ${label}`);
      assert.deepEqual(r.scriptReport.on_sale, [], label);
    } else {
      assert.deepEqual(r.page, want, `one-page read: ${label}`);
      assert.equal(r.offers.length, 1, label);
      assert.deepEqual(
        r.scriptReport.on_sale,
        want.sale_price ? [{ handle: 'probe', sku: '1', price: want.price, sale_price: want.sale_price }] : [],
        `the script lists the sale: ${label}`
      );
      if (!want.sale_price) assert.ok(!('sale_price' in r.offers[0]!), `no sale, no sale_price: ${label}`);
    }
  }
});

test('the US store reads alike in USD; a struck-through price in euros on a dollar offer is never compared', () => {
  const sale = readersOn('us', offer(15.99, spec('https://schema.org/ListPrice', 19.99, 'USD'), 'USD'));
  for (const answer of [sale.core, sale.script, sale.page]) assert.deepEqual(answer, { price: '19.99', sale_price: '15.99' });
  const foreign = readersOn('us', offer(15.99, spec(STRIKE, 19.99, 'EUR'), 'USD'));
  for (const answer of [foreign.core, foreign.script, foreign.page]) assert.deepEqual(answer, { price: '15.99' });
});

test('the refusal names the regular price it could not read; the decimal comparison is exact', () => {
  assert.deepEqual(offerPriceOf(offer(239, spec(STRIKE, '259,00'))), { refused: 'regular_price_invalid', detail: '"259,00"' });
  const r = readersOn('eu', offer(239, spec(STRIKE, '259,00')));
  assert.deepEqual(r.scriptReport.refused_variants, [{ handle: 'probe', sku: '1', reason: 'regular_price_invalid', detail: '"259,00"' }]);
  assert.deepEqual(r.scriptReport.refused, [{ handle: 'probe', reason: 'no_priced_variant' }]);

  const above: Array<[string, string, boolean]> = [
    ['259', '239', true],
    ['239', '259', false],
    ['259.00', '259', false],
    ['259.01', '259', true],
    ['1000', '999', true],
    ['0.5', '0.49', true],
    ['0.49', '0.5', false],
    ['050', '49.99', true],
    ['2149', '2149.00', false],
  ];
  for (const [a, b, want] of above) assert.equal(decimalAbove(a, b), want, `${a} > ${b}`);
  // Through the readers: 2149.00 struck through on a 2149 offer is no sale, 2149.01 is.
  assert.deepEqual(readersOn('eu', offer(2149, spec(STRIKE, '2149.00'))).page, { price: '2149' });
  assert.deepEqual(readersOn('eu', offer(2149, spec(STRIKE, '2149.01'))).page, { price: '2149.01', sale_price: '2149' });
});

// ---------------------------------------------------------------- what the owner is told

test('the price sheet says the page is on sale and which price is saved, in Arabic, English and Sorani', () => {
  // The server's own answer for the A1 sale page (the regular price, the sale price beside it).
  const offers = extractStoreOffers(readFileSync(join(ROOT, 'tests', 'fixtures', 'supplierPricePages', 'eu-a1-sale.page.html'), 'utf8'));
  const read: StorePageRead = {
    requested_source: 'bambu_eu',
    handle: 'a1',
    variant_id: '599117150694776840',
    item_url: 'https://eu.store.bambulab.com/products/a1?skr=yes',
    sku_url: 'https://eu.store.bambulab.com/products/a1?id=599117150694776840&skr=yes',
    source: 'bambu_eu',
    host: 'eu.store.bambulab.com',
    redirected: false,
    offers,
    chosen_sku_key: '599117150694776840',
  };
  for (const lang of LANGS) {
    const html = renderToStaticMarkup(createElement(StoreReadResult, { read, lang }));
    assert.match(html, /data-store-on-sale/, lang);
    assert.ok(html.includes(PRICE_SHEET.saleNote[lang]), `${lang}: the page is on sale, and the regular price is the one saved`);
    const rows = html.split('data-store-offer=').slice(1);
    assert.equal(rows.length, 2, lang);
    for (const [row, regular, sale] of [
      [rows[0]!, 'EUR 259', 'EUR 239'],
      [rows[1]!, 'EUR 369', 'EUR 339'],
    ]) {
      const at = row.indexOf('data-store-sale-price');
      assert.ok(row.indexOf(regular) >= 0 && row.indexOf(regular) < at, `${lang}: the regular price first`);
      const span = row.slice(at, row.indexOf('</span>', at)).replace(/<[^>]*>/g, '');
      assert.ok(span.includes(PRICE_SHEET.salePrice[lang]) && span.includes(sale), `${lang}: the sale price beside it: ${span}`);
    }
  }
  // A page that is no sale says nothing of one.
  const plain = renderToStaticMarkup(createElement(StoreReadResult, { read: { ...read, offers: offers.map(({ sale_price: _sale, ...o }) => o) }, lang: 'en' }));
  assert.doesNotMatch(plain, /data-store-on-sale|data-store-sale-price/);

  // After "Read and save" on a sale page he is told both prices, the regular one saved.
  for (const lang of LANGS) {
    assert.deepEqual(storeSavedNote(read, lang), {
      tone: 'warning',
      text: say(PRICE_SHEET.storeSavedSale, lang, { price: 'EUR 259', sale: 'EUR 239', host: 'eu.store.bambulab.com' }),
    });
    const text = PRICE_SHEET.storeSavedSale[lang];
    for (const slot of ['{price}', '{sale}', '{host}']) assert.ok(text.includes(slot), `${lang} names ${slot}`);
  }
  const sheet = readFileSync(join(ROOT, 'src', 'components', 'adminEstimates', 'UpdatePriceSheet.tsx'), 'utf8');
  assert.match(sheet, /const savedNote = save \? storeSavedNote\(answer\.supplier_prices, lang\) : null;\s*if \(savedNote\) return savedNote;/);
});

/** A page of several variants, each `[id, offer]`, in the store's JSON-LD shape. */
function pageOfVariants(variants: Array<[string, Json]>): string {
  const host = HOSTS.eu;
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'ProductGroup',
    name: 'Probe',
    hasVariant: variants.map(([id, o]) => ({ '@type': 'Product', sku: id, name: `Probe - ${id}`, offers: { ...o, url: `https://${host}/products/probe?id=${id}` } })),
  };
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

/** The read's answer as POST /read-store-page gives it: the page's offers and the one a save writes. */
function answerOf(html: string, variantId: string | null): StorePageRead {
  const offers = extractStoreOffers(html);
  const chosen = chosenOffer({ target: { source: 'bambu_eu', handle: 'probe', variant_id: variantId, url: '' }, host: HOSTS.eu, source: 'bambu_eu', final_url: '', offers });
  return {
    requested_source: 'bambu_eu',
    handle: 'probe',
    variant_id: variantId,
    item_url: null,
    sku_url: null,
    source: 'bambu_eu',
    host: HOSTS.eu,
    redirected: false,
    offers,
    chosen_sku_key: chosen ? chosen.sku_key : null,
  };
}

test('"Read and save" names the sale price only when it is the saved variant’s; else only the regular price saved, in Arabic, English and Sorani', () => {
  const host = HOSTS.eu;
  const note = (read: StorePageRead) => LANGS.map((lang) => storeSavedNote(read, lang));
  const told = (key: 'storeSaved' | 'storeSavedSale' | 'storeSavedRegular', tone: 'success' | 'warning', vars: Record<string, string>) =>
    LANGS.map((lang) => ({ tone, text: say(PRICE_SHEET[key], lang, { ...vars, host }) }));

  // One regular price, two sale prices, no variant in the link: the SKUs saved may be either variant.
  const twoSales = pageOfVariants([
    ['1', offer(219, spec(STRIKE, 289))],
    ['2', offer(249, spec(STRIKE, 289))],
  ]);
  const noId = answerOf(twoSales, null);
  assert.equal(noId.chosen_sku_key, '1', 'the page’s one regular price is saved');
  assert.deepEqual(note(noId), told('storeSavedRegular', 'warning', { price: 'EUR 289' }));
  for (const m of note(noId)) assert.ok(!m!.text.includes('219') && !m!.text.includes('249'), `no sale price is named: ${m!.text}`);
  // The variant named: its own sale price.
  assert.deepEqual(note(answerOf(twoSales, '2')), told('storeSavedSale', 'warning', { price: 'EUR 289', sale: 'EUR 249' }));
  // Every variant on the same sale: that sale price, even without a variant.
  const oneSale = pageOfVariants([
    ['1', offer(219, spec(STRIKE, 289))],
    ['2', offer(219, spec(STRIKE, 289))],
  ]);
  assert.deepEqual(note(answerOf(oneSale, null)), told('storeSavedSale', 'warning', { price: 'EUR 289', sale: 'EUR 219' }));
  // One variant on sale and one not, in either order: on sale, no sale price named.
  const mixed: Array<[string, Json]> = [
    ['1', offer(289)],
    ['2', offer(249, spec(STRIKE, 289))],
  ];
  assert.deepEqual(note(answerOf(pageOfVariants(mixed), null)), told('storeSavedRegular', 'warning', { price: 'EUR 289' }));
  assert.deepEqual(note(answerOf(pageOfVariants([...mixed].reverse()), null)), told('storeSavedRegular', 'warning', { price: 'EUR 289' }));
  // The variant named is not on sale: the price saved, no sale.
  assert.deepEqual(note(answerOf(pageOfVariants(mixed), '1')), told('storeSaved', 'success', { price: 'EUR 289' }));
  // No sale anywhere.
  assert.deepEqual(note(answerOf(pageOfVariants([['1', offer(289)], ['2', offer(289)]]), null)), told('storeSaved', 'success', { price: 'EUR 289' }));
  // Nothing chosen: no saved note.
  assert.deepEqual(note(answerOf(pageOfVariants([['1', offer(289)], ['2', offer(299)]]), null)), [null, null, null]);

  // The variant in two JSON-LD blocks, the one that shows only the sale price first: the regular price saved and named.
  const plainFirst = pageOfVariants([['1', offer(239)]]) + pageOfVariants([['1', offer(239, spec(STRIKE, 259))]]);
  assert.deepEqual(note(answerOf(plainFirst, '1')), told('storeSavedSale', 'warning', { price: 'EUR 259', sale: 'EUR 239' }));

  for (const lang of LANGS) {
    const text = PRICE_SHEET.storeSavedRegular[lang];
    for (const slot of ['{price}', '{host}']) assert.ok(text.includes(slot), `${lang} names ${slot}`);
    assert.ok(!text.includes('{sale}'), `${lang}: no sale price`);
  }
});
