/**
 * «متوفر الآن» on the home page (owner, 2026-11-18): only products on the
 * shelf now, one chip per catalog that holds them, just below the banners.
 *   → src/lib/inStockShelf.ts, src/components/home/v2/InStockNow.tsx
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiProduct, HomeTaxon } from '../src/lib/api';
import { IN_STOCK_PATH, inStockCatalogPath, inStockCatalogs, inStockOnly, inStockSeeAll } from '../src/lib/inStockShelf';

const taxon = (id: string, slug: string, children: HomeTaxon[] = []): HomeTaxon =>
  ({ id, slug, name_ar: id, name_en: id, name_ckb: id, product_count: 1, children }) as HomeTaxon;

const tree = [
  taxon('cat_printers', 'printers', [taxon('cat_fdm', 'fdm')]),
  taxon('cat_maint', 'maintenance', [taxon('cat_parts', 'parts')]),
  taxon('cat_makers', 'makers', [taxon('cat_kits', 'kits')]),
];

const product = (id: string, stock: number | undefined, category_id: string, sub_category_id: string | null = null) =>
  ({ id, direct_stock_available: stock, category_id, sub_category_id }) as unknown as ApiProduct;

test('only products with direct-sale units now, each once, in the server order', () => {
  const list = [product('a', 2, 'cat_maint'), product('b', 0, 'cat_maint'), product('c', undefined, 'cat_makers'), product('a', 2, 'cat_maint'), product('d', 1, 'cat_makers')];
  assert.deepEqual(inStockOnly(list).map((p) => p.id), ['a', 'd']);
});

test('chips are the catalogs that hold stock, most-stocked first, a sub-section counting for its catalog', () => {
  const list = [
    product('k1', 1, 'cat_makers', 'cat_kits'),
    product('p1', 1, 'cat_maint', 'cat_parts'),
    product('p2', 1, 'cat_parts'),
  ];
  const chips = inStockCatalogs(tree, list);
  assert.deepEqual(chips.map((c) => [c.id, c.count]), [['cat_maint', 2], ['cat_makers', 1]]);
  assert.ok(!chips.some((c) => c.id === 'cat_printers'), 'a catalog with nothing on the shelf has no chip');
  assert.deepEqual(inStockCatalogs(tree, [product('x', 1, 'cat_makers'), product('y', 1, 'cat_maint')]).map((c) => c.id), ['cat_maint', 'cat_makers'], 'ties keep the tree order');
});

test('the requests and the «عرض الكل» door carry the in-stock filter', () => {
  assert.match(IN_STOCK_PATH, /[?&]avail=1(&|$)/);
  assert.equal(inStockCatalogPath('cat_maint'), '/api/products?avail=1&category=cat_maint&limit=20');
  assert.equal(inStockSeeAll({ slug: 'maintenance' }), '/categories/maintenance/all?avail=1');
  assert.equal(inStockSeeAll(undefined), undefined, '«الكل» has no all-shop in-stock page to open');
});

test('the section draws nothing while empty, and re-checks stock on every list it shows', () => {
  const src = readFileSync('src/components/home/v2/InStockNow.tsx', 'utf8');
  assert.match(src, /if \(opening\.length === 0\) return null;/);
  assert.match(src, /setOpening\(inStockOnly\(/);
  assert.match(src, /return inStockOnly\(\[/);
});
