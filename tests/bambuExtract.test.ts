/**
 * THE CLOSED READ LIST (Bambu import spec §C.10 layer 1, §C.1).
 *
 * extract.ts locates the product object `P` by its shape and reads it only
 * through a recording accessor whose closed list names identity, options,
 * SKU ids and values, media, features, videos and the route. This file proves:
 *
 *   - every path served while extracting is on the closed lists;
 *   - a path outside the list throws instead of returning a value;
 *   - on the real (trimmed) filament-buffer page, wrapped in a recording Proxy,
 *     no money, stock, promotion or limit key is ever READ — the walk skips
 *     them by name — and none of the planted values reaches the extraction;
 *   - the identity cross-check holds on every fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFromRows,
  identityCrossCheck,
  JSONLD_READ_LIST,
  MESSAGES_READ_LIST,
  NEVER_DESCEND,
  PRODUCT_READ_LIST,
  Reader,
  ReadOutsideList,
} from '../packages/catalog/src/bambuImport/extract';
import { jsonLdBlocks, parseFlight, type RowValue } from '../packages/catalog/src/bambuImport/rsc';
import { page, pageHtml, recording, sample, SAMPLE_HANDLES } from './fixtures/bambu/load';

/** Source-analysis §3.3 "Do not import" and §3.9 (the cross-sell payload's inventory keys). */
const NEVER_READ = [
  'price', 'discountPrice', 'discountOffText', 'gradientDiscountSkus', 'gradientDiscountActivityId', 'flashSaleVO', 'priceExplanation',
  'priceDescriptionList', 'defaultPrice', 'priceCurrency', 'pointsInfo', 'minimum', 'maximum', 'quantityLimitType', 'quantityLimitValue',
  'productSkuPreSale', 'productSkuBuyAndGetVO', 'trackingQuantity', 'availableStock', 'landingQuantity', 'promotionDescription',
  'qryPromotionFlag', 'skuPromotionPointsSwitch', 'relationProducts',
];

const listed = (path: string, list: readonly string[]) => {
  const set = new Set(list);
  if (set.has(path)) return true;
  const segs = path.split('.');
  return segs.some((_, i) => i > 0 && set.has(segs.map((s, j) => (j === i ? '*' : s)).join('.'))) || set.has(segs.map((s, j) => (j > 0 && j < 2 ? '*' : s)).join('.'));
};

test('every path served on the real page is on a closed list', () => {
  const { reads, extraction } = page();
  assert.ok(reads.length > 10);
  const all = [...PRODUCT_READ_LIST, ...JSONLD_READ_LIST, ...MESSAGES_READ_LIST];
  for (const p of reads) assert.ok(listed(p, all), `read outside the closed list: ${p}`);
  assert.equal(extraction.handle, 'filament-buffer');
  assert.equal(extraction.sourceProductId, '6945416380552');
  assert.equal(extraction.title, 'Filament Buffer');
});

test('a read outside the list throws ReadOutsideList instead of returning the value', () => {
  const rows = new Map<string, RowValue>();
  const r = new Reader({ rows, list: new Set(PRODUCT_READ_LIST), record: new Set() }, { id: '1', price: 99, availableStock: 5 }, 'P');
  assert.equal(r.str('id'), '1');
  assert.throws(() => r.num('price'), ReadOutsideList);
  assert.throws(() => r.num('availableStock'), ReadOutsideList);
});

test('the walk never READS a money, stock or promotion key of the page (recording Proxy over every row)', () => {
  const html = pageHtml();
  const { rows, stats } = parseFlight(html);
  const log = new Set<string>();
  const wrapped = new Map<string, RowValue>();
  for (const [id, row] of rows) wrapped.set(id, row.kind === 'json' ? { kind: 'json', value: recording(row.value, log) } : row);
  const out = extractFromRows(wrapped, jsonLdBlocks(html), stats);
  assert.equal(out.extraction.handle, 'filament-buffer');
  assert.ok(log.size > 20, 'the proxy saw the walk');
  for (const k of NEVER_READ) assert.ok(!log.has(k), `the walk read ${k}`);
  for (const k of log) assert.ok(!NEVER_DESCEND.test(k), `the walk read a NEVER_DESCEND key: ${k}`);
});

test('none of the planted forbidden values reaches the extraction', () => {
  const html = pageHtml();
  assert.ok((html.match(/PLANTED-/g) ?? []).length >= 40, 'the fixture carries its planted values');
  const json = JSON.stringify(page().extraction);
  assert.ok(!json.includes('PLANTED-'), 'a planted value was extracted');
  assert.ok(!/\$\s?\d/.test(json), 'a currency amount was extracted');
});

test('the identity cross-check holds on the page and all 8 samples; handles are decoded NFC', () => {
  assert.deepEqual(identityCrossCheck(page().extraction), { ok: true, problems: [] });
  for (const h of SAMPLE_HANDLES) {
    const x = sample(h);
    assert.equal(x.handle, h);
    assert.equal(x.handle, x.handle.normalize('NFC'));
    const c = identityCrossCheck(x);
    assert.ok(c.ok, `${h}: ${c.problems.join(', ')}`);
    assert.ok(x.gallery.length > 0, `${h} has a gallery`);
    assert.ok(x.skus.every((s) => /^\d+$/.test(s.id)), `${h}: SKU ids are strings of digits (18-digit ids exceed 2^53)`);
  }
});

test('the description format of each sample is detected (A, B, C, D1, D2, E)', () => {
  const kinds = Object.fromEntries(SAMPLE_HANDLES.map((h) => [h, sample(h).description.kind]));
  assert.equal(kinds['ams-2-pro-feeder-unit'], 'legacy_html');
  assert.equal(kinds['build-plate-combo'], 'sections_html');
  assert.equal(kinds['pla-basic-filament'], 'page_builder');
  assert.equal(kinds.a1, 'bespoke_shopify_port');
  assert.equal(kinds.h2d, 'bespoke_new');
  assert.equal(sample('h2c').description.kind, 'component_list', 'a format-E sample keeps its component list');
  assert.equal(page().extraction.description.kind, 'legacy_html');
});
