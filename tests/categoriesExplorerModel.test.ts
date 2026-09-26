/**
 * THE CATEGORIES EXPLORER (catalog discovery S4, docs/ux/CATALOG_DISCOVERY.md §5).
 *
 * Acceptance over the live catalogue of 2026-09-25 (tests/fixtures/liveCatalog.ts,
 * served by the REAL `GET /api/catalog/tree`): four banners in the admin's order,
 * printers as the lead, sub-section chips only under Printers and Maker's
 * Supply, a photograph per banner that is never the same product twice and is
 * available-now first, and the counted words the page prints. The banner itself
 * is rendered: one link, the arrow drawn and not a second control.
 *
 * Run: node --import tsx --test tests/categoriesExplorerModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { asD1, freshDb, json, stubApp } from './fixtures/app';
import { LIVE_PRODUCTS, P, seedLiveCatalog } from './fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';
import { LISTING_LAYOUT_BELOW as WORKER_LISTING_LAYOUT_BELOW } from '../worker/lib/catalogPresentation';
import {
  LISTING_LAYOUT_BELOW,
  drawsShelves,
  explorerBanners,
  leadRootId,
  photoOf,
  representativePhoto,
  rootsWithoutPhoto,
  subChipsFor,
  type PhotoCandidate,
} from '../src/lib/catalog/explorerModel';
import { availableLabel, categoriesCount, countNoun, countWord, explorerSubline, resultCountLabel, showCountLabel } from '../src/lib/catalog/copy';
import { LanguageProvider } from '../src/LanguageContext';
import CategoryBanner from '../src/components/catalog/CategoryBanner';
import type { CatalogTreeNode, CatalogTreeResponse } from '../src/lib/catalog/types';

async function liveTree(extra = ''): Promise<CatalogTreeResponse> {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (extra) raw.exec(extra);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/catalog', catalogRoutes));
  return (await json(await app.request('/api/catalog/tree'))) as CatalogTreeResponse;
}

/** A pool shaped like `/api/products?sort=available`: every live product, a photo each. */
const pool: PhotoCandidate[] = LIVE_PRODUCTS.map((p) => ({
  id: p.id,
  category_id: p.category_id,
  sub_category_id: p.sub_category_id,
  direct_stock_available: p.stock,
  images: [`/files/${p.slug}.webp`],
}));

test('four banners, in the admin order, printers as the lead', async () => {
  const tree = await liveTree();
  const banners = explorerBanners(tree.roots, pool);
  assert.deepEqual(
    banners.map((b) => [b.node.slug, b.variant]),
    [
      ['printers', 'lead'],
      ['printer-accessories', 'regular'],
      ['printing-materials', 'regular'],
      ['makers-supply', 'regular'],
    ]
  );
  assert.equal(tree.totals.products, 14);
  assert.equal(leadRootId(tree.roots), 'cat_printers');
});

test('sub-section chips only under Printers and Maker’s Supply', async () => {
  const tree = await liveTree();
  const chips = Object.fromEntries(explorerBanners(tree.roots, pool).map((b) => [b.node.slug, b.subs.map((s) => [s.slug, s.product_count])]));
  assert.deepEqual(chips, {
    printers: [['fdm-printers', 10]],
    'printer-accessories': [],
    'printing-materials': [],
    'makers-supply': [
      ['new-products', 1],
      ['maker-tools', 1],
    ],
  });
});

test('the chip rule is the category page’s own layout rule (≤ 1 child and < 8 products → a listing)', () => {
  assert.equal(LISTING_LAYOUT_BELOW, WORKER_LISTING_LAYOUT_BELOW, 'the client and the Worker must draw the same line');
  const node = (count: number, kids: number[]) =>
    ({ product_count: count, children: kids.map((n) => ({ product_count: n, children: [] })) }) as unknown as CatalogTreeNode;
  assert.equal(drawsShelves(node(7, [7])), false);
  assert.equal(drawsShelves(node(8, [8])), true);
  assert.equal(drawsShelves(node(2, [1, 1])), true);
  assert.deepEqual(subChipsFor({ ...node(3, [3]), id: 'x' } as CatalogTreeNode), []);
});

test('each banner borrows a different product photograph, available now first', async () => {
  const tree = await liveTree();
  const banners = explorerBanners(tree.roots, pool);
  const ids = banners.map((b) => b.photo?.productId);
  assert.equal(new Set(ids).size, ids.length, 'no product lends its photograph to two banners');
  assert.ok(banners.every((b) => b.photo?.productPhoto), 'catalogue photographs are cropped to their band');
  const lead = banners[0].photo!;
  const leadProduct = LIVE_PRODUCTS.find((p) => p.id === lead.productId)!;
  assert.ok(leadProduct.stock > 0, 'the printers banner shows a printer that is available now');
  assert.equal(leadProduct.sub_category_id, 'cat_printers_fdm');
});

test('an authored picture wins, and a banner with no photograph is reported for its own read', async () => {
  const tree = await liveTree(`UPDATE catalogs SET hero_image_key = 'UiUx/MainPage/PrintersHero.webp' WHERE id = 'cat_printers'`);
  const banners = explorerBanners(tree.roots, []);
  assert.equal(banners[0].photo?.productPhoto, false, 'the owner’s own picture is shown whole');
  assert.match(banners[0].photo!.src, /PrintersHero\.webp$/);
  assert.deepEqual(
    rootsWithoutPhoto(banners).map((n) => n.slug),
    ['printer-accessories', 'printing-materials', 'makers-supply']
  );
  // A pool with only unavailable items still lends one (the second choice).
  const onlyOut: PhotoCandidate[] = [{ id: P.P1S, category_id: 'cat_printers', direct_stock_available: 0, images: ['/x.webp'] }];
  assert.equal(representativePhoto(tree.roots[0], onlyOut)?.productId, P.P1S);
  assert.equal(photoOf({ id: 'a', media: [{ url: '/a.webp' }, { url: '/b.webp', primary: true }] }), '/b.webp');
});

test('no Resin or Laser banner is drawn while those sections are empty', async () => {
  const tree = await liveTree();
  const slugs = JSON.stringify(explorerBanners(tree.roots, pool).map((b) => [b.node.slug, b.subs.map((s) => s.slug)]));
  assert.doesNotMatch(slugs, /resin|laser/i);
});

test('counted words: dual, plural, and the 11–99 singular', () => {
  assert.equal(countNoun(1, 'printer', 'ar'), 'طابعة واحدة');
  assert.equal(countNoun(2, 'printer', 'ar'), 'طابعتان');
  assert.equal(countNoun(10, 'printer', 'ar'), '10 طابعات');
  assert.equal(countNoun(11, 'printer', 'ar'), '11 طابعة');
  assert.equal(countNoun(14, 'product', 'ar'), '14 منتجًا');
  assert.equal(countNoun(100, 'product', 'ar'), '100 منتج');
  assert.equal(countNoun(103, 'product', 'ar'), '103 منتجات');
  assert.equal(countNoun(1, 'printer', 'en'), '1 printer');
  assert.equal(countNoun(4, 'product', 'en'), '4 products');
  assert.equal(countWord(10, 'printer', 'ar'), 'طابعات');
  assert.equal(countWord(1, 'printer', 'ar'), 'طابعة');
  assert.equal(showCountLabel(1, 'printer', 'ar'), 'عرض طابعة واحدة');
  assert.equal(showCountLabel(2, 'printer', 'ar'), 'عرض طابعتين');
  assert.equal(showCountLabel(4, 'printer', 'ar'), 'عرض 4 طابعات');
  assert.equal(showCountLabel(0, 'printer', 'ar'), 'لا نتائج بهذه الشروط');
  assert.equal(resultCountLabel(4, 10, 'printer', 'ar'), '4 من 10 طابعات');
  assert.equal(resultCountLabel(10, 10, 'printer', 'ar'), '10 طابعات');
  assert.equal(availableLabel(4, 10, 'ar'), '4 متوفرة الآن');
  assert.equal(availableLabel(1, 1, 'ar'), 'متوفر الآن');
  assert.equal(availableLabel(2, 2, 'ar'), 'كلها متوفرة');
  assert.equal(availableLabel(0, 3, 'ar'), null, 'the pill is omitted at zero');
  assert.equal(availableLabel(null, 3, 'ar'), null, 'an unknown count is never guessed');
});

test('the explorer’s sub-line carries live counts up to ten categories, then only the instruction', () => {
  assert.equal(explorerSubline(4, 14, 'ar'), 'أربع فئات و14 منتجًا. اختر فئة لتتصفح أقسامها.');
  assert.equal(explorerSubline(12, 400, 'ar'), 'اختر فئة لتتصفح أقسامها.');
  assert.equal(categoriesCount(2, 'ar'), 'فئتان');
  assert.equal(explorerSubline(4, 14, 'en'), '4 categories and 14 products. Pick one to browse its sections.');
});

test('the banner is ONE link — name, counts and the drawn arrow; no control inside it', () => {
  const html = renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(
        MemoryRouter,
        null,
        createElement(CategoryBanner, {
          to: '/categories/printers',
          title: 'الطابعات',
          description: 'للبيت والعمل.',
          count: '10 طابعات',
          available: '4 متوفرة الآن',
          photo: { src: '/files/x.webp', productPhoto: true, productId: 'p' },
          variant: 'lead',
        })
      ),
    })
  );
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /href="\/categories\/printers"/);
  // Owner, 2026-09-26: no dark blocks on the light theme — the banner follows
  // the page (`data-feature`, src/index.css FEATURE SURFACES) and a dark
  // catalogue photograph with no light twin is framed rather than faded.
  assert.match(html, /data-feature=""/, 'a feature surface that follows the theme');
  assert.doesNotMatch(html, /data-theme="dark"/, 'no dark island on the light theme');
  assert.match(html, /data-ground="dark"/, 'the dark photograph is framed on the light theme');
  assert.match(html, /10 طابعات[\s\S]*4 متوفرة الآن/);
  assert.match(html, /<img[^>]+alt=""/, 'the photograph is decorative');
});
