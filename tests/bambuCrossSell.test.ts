/**
 * THE ONE READER OF THE CROSS-SELL PAYLOAD (Bambu import spec §C.1 "SKU codes").
 *
 * The add-on groups other pages offer are the only place a SKU code appears
 * (`productSku.skuCode`), next to prices, `availableStock` and
 * `trackingQuantity`. crossSell.ts reads exactly `productSku.{id, seoCode,
 * skuCode}` through a closed list; a recording Proxy proves no other key of
 * the payload is read, and codesForProduct keeps a code only for the
 * product's own handle and variant ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROSS_SELL_READ_LIST, codesForProduct, harvestCrossSell } from '../packages/catalog/src/bambuImport/crossSell';
import { NEVER_DESCEND } from '../packages/catalog/src/bambuImport/extract';
import { parseFlight, type RowValue } from '../packages/catalog/src/bambuImport/rsc';
import { pageHtml, recording } from './fixtures/bambu/load';

const sku = (id: string, seoCode: string, skuCode: string | null) => ({
  productSku: {
    id,
    productId: '7000',
    name: 'Bambu Reusable Spool',
    seoCode,
    skuCode,
    price: 'PLANTED-price',
    discountPrice: 'PLANTED-discountPrice',
    availableStock: 'PLANTED-availableStock',
    trackingQuantity: 'PLANTED-trackingQuantity',
    status: 1,
    image: 'https://store.bblcdn.com/x.png',
  },
  price: 'PLANTED-price',
  availableStock: 'PLANTED-availableStock',
});

function synthetic(log: Set<string>): Map<string, RowValue> {
  const payload = {
    randomBuyRangeGroupList: [
      {
        name: 'Add-ons',
        discount: 'PLANTED-discount',
        spuList: [{ skuList: [], ...sku('900001', 'bambu-reusable-spool', 'RSP001') }],
        skuList: [sku('900002', 'bambu-reusable-spool', 'RSP002'), sku('900003', 'mag-alloy-scraper', 'B-SA001'), sku('900004', 'other', null)],
      },
    ],
    totalPrice: 'PLANTED-totalPrice',
  };
  const rows = new Map<string, RowValue>();
  rows.set('5', { kind: 'json', value: recording(payload, log) });
  rows.set('6', { kind: 'json', value: ['$', 'div', null, { className: 'buy-box', relationProducts: '$5' }] });
  return rows;
}

test('the Reader is served only productSku.{id, seoCode, skuCode} and the list keys; nothing priced or stocked is ever read', () => {
  const log = new Set<string>();
  const record = new Set<string>();
  const codes = harvestCrossSell(synthetic(log), record);
  assert.deepEqual(codes, [
    { variantId: '900001', handle: 'bambu-reusable-spool', skuCode: 'RSP001' },
    { variantId: '900002', handle: 'bambu-reusable-spool', skuCode: 'RSP002' },
    { variantId: '900003', handle: 'mag-alloy-scraper', skuCode: 'B-SA001' },
  ]);
  // The shape walk visits every row (a lazy payload row included) but never a money, stock or promotion key;
  // the Reader is served only the closed list.
  for (const k of log) assert.ok(!NEVER_DESCEND.test(k), `read ${k}`);
  for (const k of ['price', 'discountPrice', 'availableStock', 'trackingQuantity', 'discount', 'totalPrice']) assert.ok(!log.has(k), `read ${k}`);
  for (const p of record) assert.ok(CROSS_SELL_READ_LIST.includes(p), `served ${p}`);
  assert.ok(!JSON.stringify(codes).includes('PLANTED'));
});

test('a code belongs to a product only for its own handle and variant ids; two codes for one variant keep none', () => {
  const harvest = [
    { variantId: '1', handle: 'bambu-reusable-spool', skuCode: 'RSP001' },
    { variantId: '2', handle: 'bambu-reusable-spool', skuCode: 'RSP002' },
    { variantId: '2', handle: 'bambu-reusable-spool', skuCode: 'RSP009' },
    { variantId: '3', handle: 'bambu-reusable-spool', skuCode: 'RSP003' },
    { variantId: '1', handle: 'mag-alloy-scraper', skuCode: 'B-SA001' },
  ];
  assert.deepEqual(codesForProduct(harvest, { handle: 'bambu-reusable-spool', variantIds: ['1', '2'] }), { codes: { '1': 'RSP001' }, conflicts: ['2'] });
  assert.deepEqual(codesForProduct(harvest, { handle: 'mag-alloy-scraper', variantIds: ['9'] }), { codes: {}, conflicts: [] });
});

test('the real page harvests without reading a forbidden key', () => {
  const { rows } = parseFlight(pageHtml());
  const log = new Set<string>();
  const wrapped = new Map<string, RowValue>();
  for (const [id, row] of rows) wrapped.set(id, row.kind === 'json' ? { kind: 'json', value: recording(row.value, log) } : row);
  const codes = harvestCrossSell(wrapped);
  assert.ok(Array.isArray(codes));
  for (const k of ['price', 'discountPrice', 'availableStock', 'trackingQuantity', 'flashSaleVO', 'pointsInfo']) assert.ok(!log.has(k), `read ${k}`);
});
