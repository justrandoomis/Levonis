/**
 * A TMALL LISTING WITHOUT OPTIONS (docs/SMART_PRICING.md §3.3; the 2026-10-31 capture's
 * laser work platform ¥399, laser platform support bar set ¥80, X1 display rear cover ¥79
 * and X1C heatbed ¥799).
 *
 *   - a listing the capture read with no SKU rows and no option groups is one product at one
 *     price: one SKU keyed by its own item id, no options, the page's price as exact text;
 *   - it is kept only when it is an offer: a not-for-sale, placeholder, pre-launch or
 *     discontinued flag, a parked price (9999, 999999), a price range, a missing or malformed
 *     page price, or option groups without SKU rows each drop it, with the reason;
 *   - a listing whose SKUs were all refused never falls back to its page price;
 *   - the file passes the upload door's parser, and the SKU's link is the item page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSupplierPriceFile, type SupplierPriceFile } from '../packages/catalog/src/supplierPrices/format';
import { supplierItemUrl, supplierSkuUrl } from '../packages/catalog/src/supplierPrices/links';
// @ts-expect-error - plain ESM capture tool, no types; typed below
import * as tmallTool from '../scripts/supplier-prices/normalize-tmall.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (): { captured_on: string; items: Array<Record<string, unknown>> } =>
  JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'supplierPricePages', 'tmall-store-2026-10-31.sample.json'), 'utf8'));

interface Report {
  dropped_items: Array<{ item_key: string; reason: string; detail?: string }>;
  notes: Array<{ item_key: string; sku_key?: string; note: string }>;
}
const normalize: (snapshot: unknown) => { file: unknown; report: Report } = tmallTool.normalizeTmallSnapshot;

/** A listing as the capture writes one without options (the X1C heatbed's shape). */
function noOptions(itemId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: itemId,
    name_en: 'Heatbed — X1C',
    category: 'electronic_part',
    sourcing: 'EU_STORE_EUR',
    freight_route: 'GERMANY_LAND',
    codes: [],
    flags: [],
    price_min_cny: 799,
    price_max_cny: 799,
    price_source: 'from_price',
    title: '拓竹 热床 【X1C适用】 3D打印机配件',
    listing_title: '拓竹 热床 【X1C适用】 3D打印机配件',
    url: `https://detail.tmall.com/item.htm?id=${itemId}`,
    seller: '拓竹官方旗舰店',
    from_price_cny: 799,
    from_price_title: null,
    hidden_price: false,
    ok: true,
    props: [],
    skus: [],
    ...over,
  };
}

function v1Of(file: unknown): SupplierPriceFile {
  assert.ok(file, 'a file was produced');
  return parseSupplierPriceFile(JSON.stringify(file));
}

test('a listing without options is one SKU keyed by its item id, at the page price, and passes the parser', () => {
  const snap = sample();
  snap.items.push(noOptions('960718061606'));
  snap.items.push(noOptions('966154880524', { name_en: 'Display rear cover (with hinge) — X1 series', category: 'spare_part', sourcing: 'CHINA_CNY', freight_route: 'CHINA_SEA_OR_AIR', price_min_cny: 79, price_max_cny: 79, from_price_cny: 79 }));
  snap.items.push(noOptions('900000000101', { price_min_cny: 19.7, price_max_cny: 19.7, from_price_cny: 19.7 }));
  const { file, report } = normalize(snap);
  const v1 = v1Of(file);

  const heatbed = v1.items.find((i) => i.item_key === '960718061606');
  assert.ok(heatbed, 'the heatbed is in the file');
  assert.deepEqual(heatbed.skus, [{ sku_key: '960718061606', options: {}, options_en: {}, price: '799', price_label: '', quantity: null, sku_code: '', codes: [] }]);
  assert.deepEqual([heatbed.category, heatbed.sourcing, heatbed.freight_route, heatbed.props], ['electronic_part', 'EU_STORE_EUR', 'GERMANY_LAND', []]);
  assert.equal(v1.items.find((i) => i.item_key === '966154880524')?.skus[0]?.price, '79');
  assert.equal(v1.items.find((i) => i.item_key === '900000000101')?.skus[0]?.price, '19.7', 'a decimal page price stays exact text');

  for (const key of ['960718061606', '966154880524', '900000000101']) {
    assert.ok(report.notes.some((n) => n.item_key === key && n.sku_key === key && n.note === 'single_price_item'), `${key} is noted`);
    assert.ok(!report.dropped_items.some((d) => d.item_key === key), `${key} is not dropped`);
  }
  // Its option link is the item page; a real option keeps its skuId link.
  assert.equal(supplierSkuUrl('tmall_cn', '960718061606', '960718061606'), supplierItemUrl('tmall_cn', '960718061606'));
  assert.equal(supplierSkuUrl('tmall_cn', '960718061606', '960718061606'), 'https://detail.tmall.com/item.htm?id=960718061606');
  assert.equal(supplierSkuUrl('tmall_cn', '1053109777521', '6264995743059'), 'https://detail.tmall.com/item.htm?id=1053109777521&skuId=6264995743059');
});

test('a listing without options that is not an offer, or whose page price is not one amount, is dropped with the reason', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['900000000201', { flags: ['pre_launch'] }, 'listing_pre_launch'],
    ['900000000202', { flags: ['new', 'placeholder'] }, 'listing_placeholder'],
    ['900000000203', { flags: ['not_for_sale'] }, 'listing_not_for_sale'],
    ['900000000204', { flags: ['discontinued'] }, 'listing_discontinued'],
    ['900000000205', { price_min_cny: 9999, price_max_cny: 9999, from_price_cny: 9999 }, 'page_price_parked'],
    ['900000000206', { price_min_cny: 999999, price_max_cny: 999999, from_price_cny: 999999 }, 'page_price_parked'],
    ['900000000207', { price_min_cny: 79, price_max_cny: 99, from_price_cny: '79-99' }, 'page_price_range'],
    ['900000000208', { price_source: null, price_min_cny: null, price_max_cny: null, from_price_cny: null }, 'no_page_price'],
    ['900000000209', { from_price_cny: 12.345, price_min_cny: 12.345, price_max_cny: 12.345 }, 'page_price_price_not_two_decimals'],
    ['900000000210', { props: [{ name: '颜色', values: ['黑'] }] }, 'option_groups_without_skus'],
  ];
  const snap = sample();
  for (const [id, over] of cases) snap.items.push(noOptions(id, over));
  const { file, report } = normalize(snap);
  const v1 = v1Of(file);
  for (const [id, , detail] of cases) {
    assert.deepEqual(report.dropped_items.find((d) => d.item_key === id), { item_key: id, reason: 'no_priced_sku', detail }, id);
    assert.ok(!v1.items.some((i) => i.item_key === id), `${id} is not in the file`);
  }
});

test('a listing whose SKUs were all refused never falls back to its page price', () => {
  const snap = sample();
  // The TPU 75A shape: every option parked at 9999, a page price beside them.
  snap.items.push(
    noOptions('900000000301', {
      price_source: null,
      from_price_cny: 129,
      skus: [{ sku_id: '6300000000001', options: { 颜色: '黑' }, options_en: { Colour: 'Black' }, price_cny: 9999, price_title: null, quantity: null, not_for_sale: true, not_for_sale_reason: 'placeholder_price' }],
    })
  );
  const { file, report } = normalize(snap);
  assert.deepEqual(report.dropped_items.find((d) => d.item_key === '900000000301'), { item_key: '900000000301', reason: 'no_priced_sku' });
  assert.ok(!v1Of(file).items.some((i) => i.item_key === '900000000301'));
  assert.ok(!report.notes.some((n) => n.item_key === '900000000301' && n.note === 'single_price_item'));
});

test("a figure in the page price's label is dropped, never used", () => {
  const snap = sample();
  snap.items.push(noOptions('900000000401', { from_price_title: '¥699' }));
  snap.items.push(noOptions('900000000402', { from_price_title: '优惠前' }));
  const { file, report } = normalize(snap);
  const v1 = v1Of(file);
  assert.deepEqual(v1.items.find((i) => i.item_key === '900000000401')?.skus.map((s) => [s.price, s.price_label]), [['799', '']]);
  assert.ok(report.notes.some((n) => n.item_key === '900000000401' && n.note === 'price_title_figure_dropped'));
  assert.deepEqual(v1.items.find((i) => i.item_key === '900000000402')?.skus.map((s) => [s.price, s.price_label]), [['799', '优惠前']]);
});
