/**
 * A VARIANT REPEATED ACROSS JSON-LD BLOCKS (docs/SMART_PRICING.md §3.3, §3.6): ONE RULE IN BOTH
 * STORE PAGE READERS.
 *
 * A store page can describe its product in several JSON-LD blocks (a theme's and an app's, say),
 * and one block may show only the sale price. For a variant repeated across JSON-LD nodes (one
 * id, one currency), each copy priced by the sale rule (tests/supplierPriceSaleRule.test.ts):
 *   - copies of one value (259 and 259.00) are one: the copy that states a regular price, else
 *     the first;
 *   - a plain copy whose price is another copy's sale price is that copy's sale: the copy that
 *     states the regular price is kept;
 *   - any other disagreement keeps every copy, and nothing of the variant is saved or written.
 * Two readers keep the rule, and are held here to one table:
 *   - the owner's one-page read, worker/lib/supplierPrices/storePage.ts `extractStoreOffers` and
 *     `chosenOffer` (a save writes the kept copy's price; else 502 copies_disagree with ?id=);
 *   - the capture script, scripts/supplier-prices/capture-store-offers.ts `readStoreOffers` and
 *     `pageItem` (the kept copy is written; else the variant is refused as copies_disagree).
 * The capture script reads only the blocks of the page's own product. The owner's price sheet
 * tells him, in Arabic, English and Sorani, that the page gives the option several prices.
 *
 * Run: node --import tsx --test tests/supplierPriceBlocks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageItem, readStoreOffers, type CaptureReport } from '../scripts/supplier-prices/capture-store-offers';
import { STORE_PAGE_UNREADABLE_TEXT, chosenOffer, extractStoreOffers } from '../worker/lib/supplierPrices/storePage';
import { ApiError } from '../src/lib/api';
import { isStoreCopiesDisagree, storeCopiesDisagree, type StorePageRead } from '../src/components/adminEstimates/api';
import { PRICE_SHEET, type UiLang } from '../src/components/adminEstimates/strings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'eu.store.bambulab.com';
const A1 = `https://${HOST}/products/a1`;
const A1_GROUP_ID = '8657009738076';
const ID = '599117150694776840';
const COMBO = '599117150694776844';
const LANGS = ['ar', 'en', 'ckb'] as const satisfies readonly UiLang[];

type Json = Record<string, unknown>;
/** One copy of the variant: its `offers.price`, and the StrikethroughPrice beside it when on sale. */
type Copy = [price: number | string, regular?: number | string];
type Kept = { price: string; sale_price?: string };

const variant = (id: string, [price, regular]: Copy, host = HOST): Json => ({
  '@type': 'Product',
  sku: id,
  name: `Bambu Lab A1 - ${id === COMBO ? 'A1 Combo' : 'A1'}`,
  offers: {
    '@type': 'Offer',
    price,
    priceCurrency: 'EUR',
    availability: 'https://schema.org/InStock',
    url: `https://${host}/products/a1?id=${id}`,
    ...(regular === undefined ? {} : { priceSpecification: { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: regular, priceCurrency: 'EUR' } }),
  },
});
const group = (variants: Json[], who: { url?: string; id?: string } = { url: A1, id: A1_GROUP_ID }): Json => ({
  '@context': 'https://schema.org/',
  '@type': 'ProductGroup',
  name: 'Bambu Lab A1',
  ...(who.url === undefined ? {} : { url: who.url }),
  ...(who.id === undefined ? {} : { productGroupID: who.id }),
  hasVariant: variants,
});
const blocks = (...lds: Json[]) => lds.map((ld) => `<script type="application/ld+json">${JSON.stringify(ld)}</script>`).join('\n');

// The rule's table. Each copy is priced by the sale rule first (a struck-through price above it is its price).
const ROWS: Array<[string, Copy[], Kept | 'refused']> = [
  ['one copy: nothing to resolve', [[239, 259]], { price: '259', sale_price: '239' }],
  ['the copy that shows only the sale price first', [[239], [239, 259]], { price: '259', sale_price: '239' }],
  ['…or last', [[239, 259], [239]], { price: '259', sale_price: '239' }],
  ['…its price written as other text', [['239.00'], [239, 259]], { price: '259', sale_price: '239' }],
  ['copies of one value, as other text: the copy that states a regular price', [['259.00'], [239, 259]], { price: '259', sale_price: '239' }],
  ['copies of one value, none on sale: the first', [[259], ['259.00']], { price: '259' }],
  ['the same copy twice', [[239, 259], [239, 259]], { price: '259', sale_price: '239' }],
  ['the sale price, the regular price plain, the regular price stated', [[239], [259], [239, 259]], { price: '259', sale_price: '239' }],
  ['one regular price stated with two sale prices: the first that states one', [[239, 259], [249, 259]], { price: '259', sale_price: '239' }],
  ['two plain prices: refused', [[239], [259]], 'refused'],
  ['two stated prices that differ: refused, the higher never taken', [[239, 259], [249, 279]], 'refused'],
  ['a plain price below a stated one that is not its sale price: refused', [[279, 299], [259]], 'refused'],
  ['a plain price above the stated one: refused', [[239, 259], [299]], 'refused'],
  ['the sale pattern beside a third price: refused', [[239], [239, 259], [279]], 'refused'],
  ['a copy at the other’s sale price that states its own regular price is no plain copy: refused', [[219, 239], [239, 259]], 'refused'],
];

/** A copy's price by the sale rule (every regular price in the table is above its offer price). */
const priceOf = ([price, regular]: Copy): string => String(regular ?? price);

function emptyReport(): CaptureReport {
  return {
    store: 'eu',
    source: 'bambu_eu',
    currency: 'EUR',
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

/** The one-page read's answer as POST /read-store-page gives it, for the variant named (or none). */
function answerOf(html: string, variantId: string | null): StorePageRead {
  const offers = extractStoreOffers(html);
  const chosen = chosenOffer({ target: { source: 'bambu_eu', handle: 'a1', variant_id: variantId, url: '' }, host: HOST, source: 'bambu_eu', final_url: '', offers });
  return {
    requested_source: 'bambu_eu',
    handle: 'a1',
    variant_id: variantId,
    item_url: null,
    sku_url: null,
    source: 'bambu_eu',
    host: HOST,
    redirected: false,
    offers,
    chosen_sku_key: chosen ? chosen.sku_key : null,
  };
}

/** Both readers on one page: what a save of the variant writes, and what the capture writes. */
function readersOn(html: string) {
  const answer = answerOf(html, ID);
  const chosen = answer.offers.find((o) => o.sku_key === answer.chosen_sku_key);
  const report = emptyReport();
  const item = pageItem('eu', { type: 'printer' }, 'a1', 'a1', HOST, html, report);
  const sku = item?.skus.find((s) => s.sku_key === ID);
  const sale = report.on_sale.find((s) => s.sku === ID);
  return {
    page: chosen ? { price: chosen.price, ...(chosen.sale_price ? { sale_price: chosen.sale_price } : {}) } : ('refused' as const),
    script: sku ? { price: sku.price, ...(sale ? { sale_price: sale.sale_price } : {}) } : ('refused' as const),
    answer,
    item,
    report,
  };
}

test('one rule in both page readers: copies of one value are one, a plain copy at another copy’s sale price is that sale, and any other disagreement refuses the variant', () => {
  for (const [label, copies, want] of ROWS) {
    // Each copy in its own block, or every copy in one group: either way each is its own JSON-LD node.
    for (const [layout, html] of [
      ['blocks', blocks(...copies.map((c) => group([variant(ID, c)])))],
      ['one group', blocks(group(copies.map((c) => variant(ID, c))))],
    ] as const) {
      const r = readersOn(html);
      const at = `${label} (${layout})`;
      assert.deepEqual(r.page, want, `one-page read: ${at}`);
      assert.deepEqual(r.script, want, `capture script: ${at}`);
      const mine = r.answer.offers.filter((o) => o.sku_key === ID);
      if (want === 'refused') {
        // The read answers every copy, one per price text, and none is chosen; a save without ?id= refuses too.
        assert.deepEqual(mine.map((o) => o.price), [...new Set(copies.map(priceOf))], at);
        assert.equal(answerOf(html, null).chosen_sku_key, null, at);
        // The script writes nothing of the variant and lists it with every copy’s price.
        assert.equal(r.item, null, at);
        assert.deepEqual(r.report.refused_variants, [{ handle: 'a1', sku: ID, reason: 'copies_disagree', detail: copies.map(priceOf).join(',') }], at);
        assert.deepEqual(r.report.on_sale, [], at);
      } else {
        assert.equal(mine.length, 1, `one offer answered: ${at}`);
        assert.equal(answerOf(html, null).chosen_sku_key, ID, `the page’s one price, without ?id=: ${at}`);
        assert.deepEqual(r.report.refused_variants, [], at);
        assert.equal(r.item?.skus.length, 1, at);
        // The sale price is listed beside the regular one, never written.
        assert.deepEqual(r.report.on_sale, want.sale_price ? [{ handle: 'a1', sku: ID, price: want.price, sale_price: want.sale_price }] : [], at);
      }
    }
  }
});

test('the capture script reads every block of the page’s own product — the same productGroupID, else the same handle — and never another product’s', () => {
  const ams = { url: `https://${HOST}/products/ams-2-pro`, id: '580876092009701376' };
  // The A1 in two blocks (the first shows only the sale price), and an app’s block for another product.
  const html = blocks(group([variant(ID, [239])]), group([variant(ID, [239, 259]), variant(COMBO, [339, 369])]), group([variant('3', [299])], ams));
  assert.deepEqual(readStoreOffers(html)?.variants.map((v) => v.sku), [ID, ID, COMBO], 'never the other product’s variant');
  const r = readersOn(html);
  assert.deepEqual(r.item?.skus.map((s) => [s.sku_key, s.price, s.options]), [
    [ID, '259', { option1: 'A1' }],
    [COMBO, '369', { option1: 'A1 Combo' }],
  ]);
  assert.deepEqual(r.report.on_sale.map((s) => [s.sku, s.price, s.sale_price]), [
    [ID, '259', '239'],
    [COMBO, '369', '339'],
  ]);
  assert.deepEqual([r.report.refused, r.report.refused_variants], [[], []]);

  const gathered = (second: { url?: string; id?: string }) => readStoreOffers(blocks(group([variant(ID, [239, 259])]), group([variant(COMBO, [339])], second)))?.variants.map((v) => v.sku);
  assert.deepEqual(gathered({ url: A1 }), [ID, COMBO], 'the same handle, no productGroupID');
  assert.deepEqual(gathered({ url: '/products/a1/' }), [ID, COMBO], 'the same handle, a relative address');
  assert.deepEqual(gathered({ url: `${A1}-3d-printer`, id: A1_GROUP_ID }), [ID, COMBO], 'the same productGroupID, another address');
  assert.deepEqual(gathered({ url: A1, id: '1' }), [ID], 'another productGroupID: another product, whatever its address');
  assert.deepEqual(gathered({ url: `https://${HOST}/products/a1-mini` }), [ID], 'another handle');
  assert.deepEqual(gathered({}), [ID], 'nothing says it is the same product');

  // A page without a ProductGroup: every lone Product of its product, never another’s.
  const lone = (id: string, c: Copy, url: string) => ({ ...variant(id, c), url });
  const lones = readStoreOffers(blocks(lone(ID, [239], A1), lone(ID, [239, 259], A1), lone('3', [299], ams.url)));
  assert.deepEqual(lones?.variants.map((v) => [v.sku, v.price]), [
    [ID, 239],
    [ID, 239],
  ]);
  const loneReport = emptyReport();
  const loneItem = pageItem('eu', { type: 'printer' }, 'a1', 'a1', HOST, blocks(lone(ID, [239], A1), lone(ID, [239, 259], A1)), loneReport);
  assert.deepEqual(loneItem?.skus.map((s) => [s.sku_key, s.price]), [[ID, '259']]);

  // A gathered block is checked as the first one is: offers on another store refuse the page.
  const foreign = emptyReport();
  assert.equal(pageItem('eu', { type: 'printer' }, 'a1', 'a1', HOST, blocks(group([variant(ID, [239, 259])]), group([variant(COMBO, [339], 'us.store.bambulab.com')])), foreign), null);
  assert.deepEqual(foreign.refused, [{ handle: 'a1', reason: 'offer_host_mismatch', detail: 'us.store.bambulab.com' }]);
});

test('the price sheet says the page gives the option several prices, in Arabic, English and Sorani — not that the page could not be read, nor that it does not name the option', () => {
  const twoPrices = blocks(group([variant(ID, [239])]), group([variant(ID, [259])]));
  // Read only: the option named is on the page, twice, and nothing was chosen.
  const look = answerOf(twoPrices, ID);
  assert.equal(look.chosen_sku_key, null);
  assert.ok(storeCopiesDisagree(look));
  // Not for an option the page does not name, a link without an option, or copies the rule made one.
  assert.ok(!storeCopiesDisagree(answerOf(twoPrices, '999')));
  assert.ok(!storeCopiesDisagree(answerOf(twoPrices, null)));
  assert.ok(!storeCopiesDisagree(answerOf(blocks(group([variant(ID, [239])]), group([variant(ID, [239, 259])])), ID)));
  // "Read and save": the server’s 502 names the reason; only that refusal is told this way.
  assert.ok(isStoreCopiesDisagree(new ApiError(502, 'x', 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE', { reason: 'copies_disagree' })));
  assert.ok(!isStoreCopiesDisagree(new ApiError(502, 'x', 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE')));
  assert.ok(!isStoreCopiesDisagree(new ApiError(400, 'x', 'PRICING_INPUT_INVALID', { field: 'url' })));
  assert.ok(!isStoreCopiesDisagree({ code: 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE', details: { reason: 'copies_disagree' } }));

  for (const lang of LANGS) {
    const text = PRICE_SHEET.copiesDisagree[lang];
    assert.ok(text.trim().length > 0, lang);
    assert.notEqual(text, PRICE_SHEET.noOffer[lang], `${lang}: not “the page does not name this option”`);
    assert.notEqual(text, STORE_PAGE_UNREADABLE_TEXT[lang], `${lang}: not “the page could not be read”`);
  }
  // The sheet: a refused save says it instead of the 502’s text; a read-only answer says it before
  // "the page does not name this option".
  const sheet = readFileSync(join(ROOT, 'src', 'components', 'adminEstimates', 'UpdatePriceSheet.tsx'), 'utf8');
  assert.match(sheet, /\.catch\(\(e: unknown\) => \{\s*if \(isStoreCopiesDisagree\(e\)\) return null;\s*throw e;\s*\}\)/);
  assert.match(sheet, /if \(!answer\) return \{ tone: 'danger', text: say\(PRICE_SHEET\.copiesDisagree, lang\) \};/);
  assert.match(
    sheet,
    /if \(storeCopiesDisagree\(answer\.supplier_prices\)\) return \{ tone: 'warning', text: say\(PRICE_SHEET\.copiesDisagree, lang\) \};\s*if \(!chosen && answer\.supplier_prices\.offers\.length > 1\) return \{ tone: 'warning', text: say\(PRICE_SHEET\.noOffer, lang\) \};/
  );
});
