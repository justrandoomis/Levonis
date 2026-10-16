/**
 * «يكمّل طابعتك» TAKES ITS PICTURES FROM THE MAP, AND ONLY WHEN IT IS NEAR
 * (speed audit 2026-10-16: the related-departments row at the bottom of a
 * department page read the 50-product pool — 27 KB on the wire, 160 KB of
 * JSON — on mount, beside the page's first screen).
 *
 * The admin's picture, else the photograph the map picked for that root
 * (`GET /api/catalog/tree`); the map already in memory paints them at once;
 * otherwise the 3 KB map is asked for when the row nears the screen, and the
 * pool only for a root the map has no photograph for.
 *
 * Run: node --import tsx --test tests/relatedCategoriesPhotos.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { LanguageProvider } from '../src/LanguageContext';
import RelatedCategories, { relatedPhotos } from '../src/components/catalog/RelatedCategories';
import { TREE_KEY } from '../src/lib/catalog/data';
import { clearPageCache, writePageCache } from '../src/lib/pageCache';
import type { CatalogTreeNode, CatalogTreeResponse } from '../src/lib/catalog/types';

afterEach(() => clearPageCache());

const node = (id: string, extra: Partial<CatalogTreeNode> = {}) =>
  ({ id, slug: id, path: `/categories/${id}`, name_ar: id, name_en: id, name_ckb: id, product_count: 3, children: [], hero_image_url: '', image_url: '', hero_light_image_url: '', ...extra }) as unknown as CatalogTreeNode;
const tree = (roots: CatalogTreeNode[]) => ({ success: true, roots, totals: { products: 9, available: 3 } }) as unknown as CatalogTreeResponse;

test('the admin\'s picture, else the map\'s pick for that root, else none yet', () => {
  const related = [node('a', { hero_image_url: '/files/catalog/a.webp' }), node('b'), node('c')];
  const map = tree([node('a', { photo: { src: '/files/products/x.webp', product_id: 'x' } }), node('b', { photo: { src: '/files/products/y.webp', product_id: 'y' } }), node('c')]);
  const got = relatedPhotos(related, map);
  assert.equal(got.a?.productPhoto, false, 'the admin\'s banner');
  assert.deepEqual(got.b, { src: '/files/products/y.webp', productPhoto: true, productId: 'y' });
  assert.equal(got.c, null);
  assert.deepEqual(relatedPhotos([node('b')], null), { b: null }, 'no map in memory: nothing yet');
});

test('with the map in memory the tiles paint their photographs in the first render', () => {
  writePageCache(TREE_KEY, tree([node('b', { photo: { src: '/files/products/y.webp', product_id: 'y' } })]));
  const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(MemoryRouter, null, createElement(RelatedCategories, { nodes: [node('b')] }))));
  assert.match(html, /src="\/files\/products\/y\.webp"/);
});

test('the pool is never read on mount: the map first, when the row nears the screen', () => {
  const src = readFileSync(join(ROOT, 'src/components/catalog/RelatedCategories.tsx'), 'utf8');
  assert.match(src, /const cancel = whenNear\(el, \(\) => void fill\(\)\.catch\(\(\) => undefined\)\);/);
  const fill = src.slice(src.indexOf('const fill = async'), src.indexOf('const cancel'));
  assert.ok(fill.indexOf('loadTree(') >= 0 && fill.indexOf('loadTree(') < fill.indexOf('loadPhotoPool('), 'the 3 KB map before the 27 KB pool');
  assert.match(fill, /if \(!nodes\.every\(\(n\) => next\[n\.id\]\)\) \{\s+const pool = await loadPhotoPool\(\);/);
  assert.equal((src.match(/loadPhotoPool\(/g) ?? []).length, 1);
});
