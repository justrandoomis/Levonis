/**
 * «متوفر الآن» on the home page (owner, 2026-11-18): only products on the
 * shelf now, one chip per catalog that holds them, just below the banners.
 * Round 2 (same day): every catalog asked for its own in-stock list — the
 * all-shop list is truncated and missed the printers — and the asking starts
 * right after the home page's first paint.
 *   → src/lib/inStockShelf.ts, src/components/home/v2/InStockNow.tsx
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiProduct, HomeTaxon } from '../src/lib/api';
import { api } from '../src/lib/api';
import {
  inStockCatalogPath,
  inStockOnly,
  inStockResults,
  inStockSeeAll,
  interleave,
  resetInStockForTests,
  startInStock,
  subscribeInStock,
} from '../src/lib/inStockShelf';

const taxon = (id: string, slug: string): HomeTaxon =>
  ({ id, slug, name_ar: id, name_en: id, name_ckb: id, product_count: 1, children: [] }) as HomeTaxon;
const tree = [taxon('cat_printers', 'printers'), taxon('cat_maint', 'maintenance'), taxon('cat_laser', 'laser')];

const product = (id: string, stock: number | undefined) => ({ id, direct_stock_available: stock }) as unknown as ApiProduct;

test('only products with direct-sale units now, each once, in the given order', () => {
  const list = [product('a', 2), product('b', 0), product('c', undefined), product('a', 2), product('d', 1)];
  assert.deepEqual(inStockOnly(list).map((p) => p.id), ['a', 'd']);
});

test('«الكل» takes the catalogs in turn, so one big catalog cannot fill the rail', () => {
  const printers = ['p1', 'p2', 'p3', 'p4'].map((id) => product(id, 1));
  const parts = ['m1', 'm2'].map((id) => product(id, 1));
  const kits = [product('k1', 1), product('p1', 1)];
  assert.deepEqual(interleave([printers, parts, kits]).map((p) => p.id), ['p1', 'm1', 'k1', 'p2', 'm2', 'p3', 'p4']);
});

test('the requests and the «عرض الكل» door carry the in-stock filter, one catalog each', () => {
  assert.equal(inStockCatalogPath('cat_maint'), '/api/products?avail=1&category=cat_maint&limit=20');
  assert.equal(inStockSeeAll({ slug: 'maintenance' }), '/categories/maintenance/all?avail=1');
  assert.equal(inStockSeeAll(undefined), undefined, '«الكل» has no all-shop in-stock page to open');
});

test('every catalog is asked in parallel, once a minute, and each answer lands on its own', async () => {
  resetInStockForTests();
  const asked: string[] = [];
  const replies: Record<string, (v: unknown) => void> = {};
  const realGet = api.get;
  (api as { get: unknown }).get = (path: string) => {
    asked.push(path);
    return new Promise((resolve, reject) => {
      replies[path] = path.includes('cat_laser') ? () => reject(new Error('down')) : resolve;
    });
  };
  try {
    let heard = 0;
    const off = subscribeInStock(() => heard++);
    startInStock(tree, 1_000);
    startInStock(tree, 30_000);
    assert.deepEqual(asked, tree.map((n) => inStockCatalogPath(n.id)), 'all catalogs at once, and not again within a minute');
    assert.deepEqual(inStockResults(tree), {});

    replies[inStockCatalogPath('cat_maint')]({ products: [product('m1', 1), product('m2', 0)] });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(inStockResults(tree).cat_maint?.map((p) => p.id), ['m1'], 'one catalog shows before the others answer');
    assert.equal(inStockResults(tree).cat_printers, undefined);

    replies[inStockCatalogPath('cat_laser')](null);
    replies[inStockCatalogPath('cat_printers')]({ products: [product('p1', 3)] });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(inStockResults(tree).cat_laser, [], 'a failed catalog is empty, not stuck');
    assert.deepEqual(inStockResults(tree).cat_printers?.map((p) => p.id), ['p1']);
    assert.equal(heard, 3);

    startInStock(tree, 1_000 + 60_000);
    assert.equal(asked.length, 6, 'asked again after a minute');
    off();
  } finally {
    (api as { get: unknown }).get = realGet;
    resetInStockForTests();
  }
});

test('the home page starts the lists after its first paint; the section hides only when every catalog is empty', () => {
  const home = readFileSync('src/pages/Home.tsx', 'utf8');
  const section = home.slice(home.indexOf('in_stock: () =>'), home.indexOf('services: () =>'));
  assert.match(section, /secondaryReady \? \(\s*<Suspense[\s\S]*?<InStockNow tree=\{categories\} \/>/, 'mounted right after the first paint');
  assert.doesNotMatch(section, /DeferredHomeSection/, 'not held back until it is scrolled to');
  assert.doesNotMatch(home, /^import .*inStockShelf/m, 'kept out of the first paint');
  const src = readFileSync('src/components/home/v2/InStockNow.tsx', 'utf8');
  assert.match(src, /if \(done && catalogs\.length === 0\) return null;/);
  assert.doesNotMatch(src, /avail=1&limit=50/, 'never the truncated all-shop list');
});
