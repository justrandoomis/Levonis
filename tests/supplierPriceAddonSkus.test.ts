/**
 * ADD-ON SKUS IN THE SUPPLIER MATCHER (docs/SMART_PRICING.md §3.5).
 *
 * A SKU that is another product offered beside the item is none of the item's
 * SKUs. Tmall writes the glue offered beside a build plate as 【推荐加购】 or
 * 【推荐选购】 ("recommended add-on"); both are add-ons.
 *
 * The items are the real engineering-plate listings 995409205368 and
 * 997242295770 of the 2026-10-31 Tmall capture (ids, titles and options as
 * captured); the prices are not the capture's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAddonSku } from '../packages/catalog/src/supplierPrices/keys';
import { matchProduct, type CatalogueItem, type ItemMatch, type ProductMatch } from '../packages/catalog/src/supplierPrices/match';
import { handIdentity } from './fixtures/supplierPrices/load';

const tm = (item_key: string, title: string, name_en: string, skus: Array<[string, string]>): CatalogueItem => ({
  source: 'tmall_cn',
  item_key,
  title,
  name_en,
  category: 'build_plate',
  sourcing_hint: 'CHINA_CNY',
  skus: skus.map(([sku_key, value], i) => ({ sku_key, options: { 配件类型: value }, price: String(i + 1) })),
});
const h2c = tm('995409205368', '拓竹 A2L/H2C工程材料打印板 工程耗材打印 光面打印 工程板 3D打印板配件', 'Engineering plate — A2L/H2C', [
  ['6139846547314', '工程材料打印板-适配 H2C'],
  ['6198711695206', '【推荐选购】固体胶*1'],
  ['6198711695207', '【推荐选购】液体胶*1'],
]);
const h2d = tm('997242295770', '拓竹 工程材料打印板【适配H2D/H2S】工程耗材打印 光面打印 工程板 3D打印板配件', 'Engineering plate — H2D/H2S', [
  ['5980973024945', '工程材料打印板-适配 H2D/H2S'],
  ['6198711635035', '【推荐选购】固体胶*1'],
  ['6198711635036', '【推荐选购】液体胶*1'],
]);
/** The four glue SKUs (a glue stick and a liquid glue beside each plate). */
const GLUE = ['6198711695206', '6198711695207', '6198711635035', '6198711635036'];

function itemOf(r: ProductMatch, itemKey: string): ItemMatch {
  const m = r.sources.find((s) => s.source === 'tmall_cn')?.items.find((i) => i.item_key === itemKey);
  assert.ok(m, `tmall_cn ${itemKey} scored`);
  return m!;
}

test('【推荐选购】 marks an add-on SKU, as 【推荐加购】 does', () => {
  for (const it of [h2c, h2d]) for (const s of it.skus) assert.equal(isAddonSku(s.options), GLUE.includes(s.sku_key), `${it.item_key} ${s.sku_key}`);
  assert.equal(isAddonSku({ 配件类型: '【推荐加购】固体胶*1' }), true);
});

test('the glue offered beside an engineering plate is never one of its SKUs', () => {
  // The finding: the glue counted as the listings' own SKUs, so each printer's plate stayed AMBIGUOUS with it.
  const r = matchProduct(handIdentity({ name: 'Bambu Engineering Plate', groups: [{ kind: 'printer', values: ['H2C', 'H2D'] }] }), [h2c, h2d]);
  assert.deepEqual(itemOf(r, '995409205368').skus.map((s) => s.sku_key), ['6139846547314', null]);
  assert.deepEqual(itemOf(r, '997242295770').skus.map((s) => s.sku_key), [null, '5980973024945']);
  // H2D and H2S share one plate: both stay for the owner, and the glue is in no could-be list.
  const both = itemOf(matchProduct(handIdentity({ name: 'Bambu Engineering Plate', groups: [{ kind: 'printer', values: ['H2D', 'H2S'] }] }), [h2d]), '997242295770');
  assert.deepEqual(both.skus.map((s) => [s.sku_key, s.could_be]), [
    [null, ['5980973024945']],
    [null, ['5980973024945']],
  ]);
});
