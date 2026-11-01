/**
 * SUPPLIER LINKS FOR THE OWNER (docs/SMART_PRICING.md §3.6; owner request of
 * 2026-10-31: a link per product and per option so he can find it on Tmall
 * or the EU store, order it or update its price).
 *
 *   - every format: the Tmall item and SKU pages, the EU store's product and
 *     variant pages (always with skr=yes, the skip-region-redirect parameter:
 *     without it a visitor from Iraq lands on another region's store), the US
 *     store's product and variant pages;
 *   - a link is built only from an id that passes its grammar: Tmall ids are
 *     digits only, store handles [a-z0-9-] only, variant ids digits only —
 *     javascript:, http:, another host, free text and empty ids give null;
 *   - the real ids of the 2026-10-31 captures (Tmall, EU 18- and 14-digit
 *     variant ids) give their links.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EU_SKIP_REGION_REDIRECT,
  isStoreHandle,
  isStoreVariantId,
  isTmallId,
  supplierItemUrl,
  supplierSkuUrl,
} from '../packages/catalog/src/supplierPrices/links';
import type { SupplierSource } from '../packages/catalog/src/supplierPrices/format';
import { euFile, tmallFile } from './fixtures/supplierPrices/load';

test('every format, exactly', () => {
  assert.equal(supplierItemUrl('tmall_cn', '1053109777521'), 'https://detail.tmall.com/item.htm?id=1053109777521');
  assert.equal(supplierSkuUrl('tmall_cn', '1053109777521', '6264995743059'), 'https://detail.tmall.com/item.htm?id=1053109777521&skuId=6264995743059');
  assert.equal(supplierItemUrl('bambu_eu', 'h2d'), 'https://eu.store.bambulab.com/products/h2d?skr=yes');
  assert.equal(supplierSkuUrl('bambu_eu', 'h2d', '596571526982115329'), 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes');
  assert.equal(supplierItemUrl('bambu_us', 'filament-buffer'), 'https://us.store.bambulab.com/products/filament-buffer');
  assert.equal(supplierSkuUrl('bambu_us', 'filament-buffer', '40922942079112'), 'https://us.store.bambulab.com/products/filament-buffer?id=40922942079112');
  assert.equal(EU_SKIP_REGION_REDIRECT, 'skr=yes');
});

test('the real ids of the 2026-10-31 captures give their links', () => {
  const tmall = tmallFile();
  for (const item of tmall.items) {
    assert.equal(supplierItemUrl('tmall_cn', item.item_key), `https://detail.tmall.com/item.htm?id=${item.item_key}`);
    for (const sku of item.skus) assert.equal(supplierSkuUrl('tmall_cn', item.item_key, sku.sku_key), `https://detail.tmall.com/item.htm?id=${item.item_key}&skuId=${sku.sku_key}`);
  }
  const eu = euFile();
  const ids = eu.items.flatMap((i) => i.skus.map((s) => s.sku_key));
  assert.ok(ids.includes('596571526982115329') && ids.includes('43719762903259'), 'an 18-digit and a 14-digit EU variant id');
  for (const item of eu.items) for (const sku of item.skus) assert.equal(supplierSkuUrl('bambu_eu', item.item_key, sku.sku_key), `https://eu.store.bambulab.com/products/${item.item_key}?id=${sku.sku_key}&skr=yes`);
  assert.equal(supplierSkuUrl('bambu_eu', 'filament-buffer', '43719762903259'), 'https://eu.store.bambulab.com/products/filament-buffer?id=43719762903259&skr=yes');
});

test('EU links always carry skr=yes, once, on the EU store only', () => {
  const eu = euFile();
  const links: string[] = [];
  for (const item of eu.items) {
    links.push(supplierItemUrl('bambu_eu', item.item_key)!);
    for (const sku of item.skus) links.push(supplierSkuUrl('bambu_eu', item.item_key, sku.sku_key)!);
  }
  links.push(supplierItemUrl('bambu_eu', 'pla-basic-filament')!, supplierSkuUrl('bambu_eu', 'pla-basic-filament', '40475106640008')!);
  assert.equal(links.length, 2 + eu.items.length + eu.items.reduce((n, i) => n + i.skus.length, 0));
  for (const link of links) {
    const u = new URL(link);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, 'eu.store.bambulab.com');
    assert.equal(u.searchParams.get('skr'), 'yes', link);
    assert.equal(u.searchParams.getAll('skr').length, 1, link);
    assert.equal(link.split('skr=yes').length, 2, link);
  }
  // The other sources never carry it.
  assert.doesNotMatch(supplierItemUrl('bambu_us', 'h2d')!, /skr/);
  assert.doesNotMatch(supplierSkuUrl('tmall_cn', '1', '2')!, /skr/);
});

test('every link is https on its own fixed host, with only its own parameters', () => {
  const cases: Array<[string | null, string, string[]]> = [
    [supplierItemUrl('tmall_cn', '693972799714'), 'detail.tmall.com', ['id']],
    [supplierSkuUrl('tmall_cn', '693972799714', '4930331344240'), 'detail.tmall.com', ['id', 'skuId']],
    [supplierItemUrl('bambu_eu', 'x2d'), 'eu.store.bambulab.com', ['skr']],
    [supplierSkuUrl('bambu_eu', 'x2d', '720057962001530884'), 'eu.store.bambulab.com', ['id', 'skr']],
    [supplierItemUrl('bambu_us', 'x2d'), 'us.store.bambulab.com', []],
    [supplierSkuUrl('bambu_us', 'x2d', '720069852718190592'), 'us.store.bambulab.com', ['id']],
  ];
  for (const [link, host, params] of cases) {
    assert.ok(link, `${host} link`);
    const u = new URL(link!);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, host);
    assert.equal(u.username + u.password + u.port + u.hash, '');
    assert.deepEqual([...u.searchParams.keys()], params);
  }
});

test('refused: Tmall ids that are not digits only', () => {
  for (const bad of ['', ' ', '12a', 'a12', '1053109777521 ', ' 1053109777521', '10531-09777521', '1.5', '+123', '１２３', '1'.repeat(41), 'javascript:alert(1)', 'http://evil.example/item.htm?id=1', 'https://detail.tmall.com/item.htm?id=1', '123&skuId=9', '123#x', '123/../4']) {
    assert.equal(isTmallId(bad), false, JSON.stringify(bad));
    assert.equal(supplierItemUrl('tmall_cn', bad), null, `item ${JSON.stringify(bad)}`);
    assert.equal(supplierSkuUrl('tmall_cn', bad, '6264995743059'), null, `item ${JSON.stringify(bad)}`);
    assert.equal(supplierSkuUrl('tmall_cn', '1053109777521', bad), null, `sku ${JSON.stringify(bad)}`);
  }
});

test('refused: store handles with any character outside [a-z0-9-]', () => {
  for (const bad of [
    '',
    '-h2d',
    'H2D',
    'h2d ',
    'h2d/../admin',
    'h2d?x=1',
    'h2d#top',
    'h2d%2f',
    'h2d&skr=no',
    'h_2d',
    'h2d.json',
    'javascript:alert(1)',
    'http://evil.example',
    'https://eu.store.bambulab.com/products/h2d',
    '//evil.example',
    // Real Shopify handles with non-ASCII characters: no link is built from them.
    'cyberbrick-mk20-1a4-waffenträger',
    'garden-races-cyberbrick-4×4-rc-truck',
    'usb‑c-soldering-iron-kit-for-heat-set-inserts',
    'a'.repeat(121),
  ]) {
    assert.equal(isStoreHandle(bad), false, JSON.stringify(bad));
    for (const source of ['bambu_eu', 'bambu_us'] as const) {
      assert.equal(supplierItemUrl(source, bad), null, `${source} item ${JSON.stringify(bad)}`);
      assert.equal(supplierSkuUrl(source, bad, '596571526982115329'), null, `${source} variant ${JSON.stringify(bad)}`);
    }
  }
});

test('refused: store variant ids that are not digits only (a SKU-code key has an item link only)', () => {
  for (const bad of ['', 'A00-W1-1.75-1000-SPLFREE', '5965715269821153290x', 'javascript:alert(1)', 'http://evil.example', '596571526982115329&skr=no', ' 1', '1'.repeat(41)]) {
    assert.equal(isStoreVariantId(bad), false, JSON.stringify(bad));
    assert.equal(supplierSkuUrl('bambu_eu', 'h2d', bad), null, `eu ${JSON.stringify(bad)}`);
    assert.equal(supplierSkuUrl('bambu_us', 'h2d', bad), null, `us ${JSON.stringify(bad)}`);
  }
  assert.equal(supplierItemUrl('bambu_eu', 'pla-basic-filament'), 'https://eu.store.bambulab.com/products/pla-basic-filament?skr=yes');
});

test('refused: an unknown source and values that are not strings', () => {
  for (const source of ['taobao', 'bambu_cn', '', 'TMALL_CN'] as unknown as SupplierSource[]) {
    assert.equal(supplierItemUrl(source, '1053109777521'), null);
    assert.equal(supplierSkuUrl(source, '1053109777521', '6264995743059'), null);
  }
  for (const bad of [null, undefined, 1053109777521, ['1'], { id: '1' }] as unknown as string[]) {
    assert.equal(supplierItemUrl('tmall_cn', bad), null);
    assert.equal(supplierItemUrl('bambu_eu', bad), null);
    assert.equal(supplierSkuUrl('bambu_us', 'h2d', bad), null);
  }
});
