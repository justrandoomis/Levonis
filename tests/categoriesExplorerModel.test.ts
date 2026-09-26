/**
 * THE CATEGORIES EXPLORER (catalog discovery S4, docs/ux/CATALOG_DISCOVERY.md §5).
 *
 * Acceptance over the live catalogue of 2026-09-25 (tests/fixtures/liveCatalog.ts,
 * served by the REAL `GET /api/catalog/tree`): four banner ROWS in the admin's
 * order — one hero banner per line, no chips (owner, 2026-09-26: «يظهر فئات
 * الفرعية بشكل هيرو بانر بسطر واحد مستطيل») — a photograph per row that is
 * never the same product twice and is available-now first, «استكشف» where a
 * section opens onto sections and «تسوق الآن» where it is a list, and the
 * counted words the page prints. The row itself is rendered: one link, the
 * pill its label and not a second control.
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
  bannerCta,
  bannerRows,
  drawsShelves,
  photoOf,
  representativePhoto,
  rowsWithoutPhoto,
  type PhotoCandidate,
  authoredPhoto,
  authoredSrc,
} from '../src/lib/catalog/explorerModel';
import { availableLabel, categoriesCount, countNoun, countWord, explorerSubline, resultCountLabel, showCountLabel } from '../src/lib/catalog/copy';
import { LanguageProvider } from '../src/LanguageContext';
import CategoryRowBanners from '../src/components/catalog/CategoryRowBanners';
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

test('four banner rows, in the admin order — one per line, nothing empty', async () => {
  const tree = await liveTree();
  const rows = bannerRows(tree.roots, pool);
  assert.deepEqual(
    rows.map((r) => r.node.slug),
    ['printers', 'printer-accessories', 'printing-materials', 'makers-supply']
  );
  assert.equal(tree.totals.products, 14);
  const empty = { ...tree.roots[0], id: 'x', product_count: 0 };
  assert.equal(bannerRows([empty], pool).length, 0, 'a section with no products is never drawn');
});

test('«استكشف» where the section opens onto sections, «تسوق الآن» where it is a list', async () => {
  const tree = await liveTree();
  assert.deepEqual(
    tree.roots.map((r) => [r.slug, bannerCta(r)]),
    [
      ['printers', 'explore'],
      ['printer-accessories', 'explore'],
      ['printing-materials', 'explore'],
      ['makers-supply', 'explore'],
    ]
  );
  assert.equal(bannerCta(tree.roots[0].children[0]), 'shop', 'FDM printers is a list');
});

test('the client draws the category page’s layout line where the Worker does (≤ 1 child and < 8 products → a listing)', () => {
  assert.equal(LISTING_LAYOUT_BELOW, WORKER_LISTING_LAYOUT_BELOW, 'the client and the Worker must draw the same line');
  const node = (count: number, kids: number[]) =>
    ({ product_count: count, children: kids.map((n) => ({ product_count: n, children: [] })) }) as unknown as CatalogTreeNode;
  assert.equal(drawsShelves(node(7, [7])), false);
  assert.equal(drawsShelves(node(8, [8])), true);
  assert.equal(drawsShelves(node(2, [1, 1])), true);
});

test('each row borrows a different product photograph, available now first', async () => {
  const tree = await liveTree();
  const rows = bannerRows(tree.roots, pool);
  const ids = rows.map((b) => b.photo?.productId);
  assert.equal(new Set(ids).size, ids.length, 'no product lends its photograph to two rows');
  assert.ok(rows.every((b) => b.photo?.productPhoto), 'catalogue photographs are cropped to their band');
  const lead = rows[0].photo!;
  const leadProduct = LIVE_PRODUCTS.find((p) => p.id === lead.productId)!;
  assert.ok(leadProduct.stock > 0, 'the printers banner shows a printer that is available now');
  assert.equal(leadProduct.sub_category_id, 'cat_printers_fdm');
});

test('an authored picture wins, and a banner with no photograph is reported for its own read', async () => {
  const tree = await liveTree(`UPDATE catalogs SET hero_image_key = 'UiUx/MainPage/PrintersHero.webp' WHERE id = 'cat_printers'`);
  const rows = bannerRows(tree.roots, []);
  assert.equal(rows[0].photo?.productPhoto, false, 'the owner’s own picture is shown whole');
  assert.match(rows[0].photo!.src, /PrintersHero\.webp$/);
  assert.equal(rows[0].photo!.lightSrc, undefined, 'one picture for both themes until a light one is uploaded');
  assert.deepEqual(
    rowsWithoutPhoto(rows).map((n) => n.slug),
    ['printer-accessories', 'printing-materials', 'makers-supply']
  );
  // A pool with only unavailable items still lends one (the second choice).
  const onlyOut: PhotoCandidate[] = [{ id: P.P1S, category_id: 'cat_printers', direct_stock_available: 0, images: ['/x.webp'] }];
  assert.equal(representativePhoto(tree.roots[0], onlyOut)?.productId, P.P1S);
  assert.equal(photoOf({ id: 'a', media: [{ url: '/a.webp' }, { url: '/b.webp', primary: true }] }), '/b.webp');
});

test('no Resin or Laser banner is drawn while those sections are empty', async () => {
  const tree = await liveTree();
  const slugs = JSON.stringify(bannerRows(tree.roots, pool).map((b) => [b.node.slug, bannerRows(b.node.children, pool).map((s) => s.node.slug)]));
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

test('the product the page hero shows is avoided while another will do, used rather than leave a row bare', async () => {
  const tree = await liveTree();
  const printers = tree.roots[0];
  const first = bannerRows([printers], pool)[0].photo!.productId!;
  assert.notEqual(bannerRows([printers], pool, new Set([first]))[0].photo!.productId, first);
  const only: PhotoCandidate[] = [{ id: 'p', category_id: printers.id, direct_stock_available: 1, images: ['/x.webp'] }];
  assert.equal(bannerRows([printers], only, new Set(['p']))[0].photo?.productId, 'p');
});

test('each row is ONE full-width link — name, counts and the pill; no control inside it; one per line', async () => {
  const tree = await liveTree();
  const rows = bannerRows(tree.roots, pool);
  const html = renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(CategoryRowBanners, { rows, label: 'كل الفئات' })),
    })
  );
  assert.equal((html.match(/<a /g) ?? []).length, 4, 'one link per row');
  assert.equal((html.match(/<li>/g) ?? []).length, 4);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /data-sub-chip|grid-cols/, 'no chips, no grid of tiles');
  assert.match(html, /<ul class="flex flex-col/, 'a stack: one banner per line');
  assert.match(html, /href="\/categories\/printers"/);
  // Owner, 2026-09-26: «اجعل الشريط المستطيلي انحف» — thin by proportion at
  // every width: 15:4 (88–96 px) on a phone, 7:1 from 640, 8:1 from 1024,
  // never taller than 144 px.
  assert.match(html, /aspect-\[15\/4\] min-h-\[88px\] max-h-\[96px\]/, 'a thin strip on a phone');
  assert.match(html, /sm:aspect-\[7\/1\][^"]*sm:max-h-\[140px\]/);
  assert.match(html, /lg:aspect-\[8\/1\][^"]*lg:min-h-\[120px\] lg:max-h-\[144px\]/, 'a thin banner on an iPad and a desktop');
  assert.doesNotMatch(html, /max-h-\[(1[5-9]\d|[2-9]\d\d)px\]/, 'never a wall');
  // «اجعل الصورة تملأ البطاقة»: the picture is the banner, the words sit on
  // it over a dark scrim — never a framed window on a cream card.
  assert.match(html, /data-feature=""/, 'still marked a feature surface');
  assert.doesNotMatch(html, /data-theme="dark"/, 'no dark island on the light theme');
  assert.doesNotMatch(html, /data-ground="dark"/, 'no framed window on the light theme');
  assert.match(html, /\[--color-ivory:#f3efe6\]/, 'the words are light ink on the scrim in both themes');
  assert.match(html, /to-\[rgb\(11_12_15\/0\.9\)\]/, 'a dark scrim from the reading side');
  assert.match(html, /10 طابعات · 4 متوفرة الآن/);
  assert.match(html, /استكشف/);
  assert.match(html, /<img[^>]+alt=""/, 'the photograph is decorative');
});

test('an uploaded banner fills the row under the scrim; the light and dark files are both carried', async () => {
  const tree = await liveTree(
    `UPDATE catalogs SET hero_image_key = 'UiUx/MainPage/PrintersDark.webp', hero_light_image_key = 'UiUx/MainPage/PrintersLight.webp' WHERE id = 'cat_printers'`
  );
  assert.equal(tree.roots[0].hero_light_image_url, '/files/UiUx/MainPage/PrintersLight.webp', 'the tree exposes the light banner');
  const rows = bannerRows(tree.roots, pool);
  assert.deepEqual(rows[0].photo, {
    src: '/files/UiUx/MainPage/PrintersDark.webp',
    lightSrc: '/files/UiUx/MainPage/PrintersLight.webp',
    productPhoto: false,
    productId: null,
  });
  const html = renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(CategoryRowBanners, { rows: rows.slice(0, 1), label: 'x' })),
    })
  );
  assert.match(html, /data-row-photo="cover"/);
  assert.match(html, /lv-promo-zone absolute inset-0/, 'the picture fills the whole banner');
  // The test renderer's theme is light: the light file is the one requested.
  assert.match(html, /src="\/files\/UiUx\/MainPage\/PrintersLight\.webp"/);
  assert.doesNotMatch(html, /PrintersDark\.webp/, 'only the file for the theme on screen is requested');
});

test('the order of the rows is the admin’s `sort`, then the name', async () => {
  const tree = await liveTree(
    `UPDATE catalogs SET sort = 30 WHERE id = 'cat_printers'; UPDATE catalogs SET sort = 10 WHERE id = 'cat_materials'; UPDATE catalogs SET sort = 20 WHERE id = 'cat_pacc'; UPDATE catalogs SET sort = 20 WHERE id = 'cat_makers';`
  );
  // cat_makers and cat_pacc tie on 20: the English name breaks it.
  const order = bannerRows(tree.roots, pool).map((r) => r.node.id);
  const tied = ['cat_makers', 'cat_pacc'].sort((a, b) => {
    const n = (id: string) => tree.roots.find((r) => r.id === id)!.name_en;
    return n(a).localeCompare(n(b));
  });
  assert.deepEqual(order, ['cat_materials', ...tied, 'cat_printers']);
});

test('the banner picture for a theme: this theme’s → the other theme’s → the tile cover → none', () => {
  const n = (dark: string, light: string, cover: string) => ({ hero_image_url: dark, hero_light_image_url: light, image_url: cover });
  // Both themes set: each theme gets its own.
  assert.equal(authoredSrc(n('/d', '/l', '/c'), 'dark'), '/d');
  assert.equal(authoredSrc(n('/d', '/l', '/c'), 'light'), '/l');
  // One missing: the other theme's banner, before the cover.
  assert.equal(authoredSrc(n('', '/l', '/c'), 'dark'), '/l');
  assert.equal(authoredSrc(n('/d', '', '/c'), 'light'), '/d');
  // Neither banner: the home tile's cover, in both.
  assert.equal(authoredSrc(n('', '', '/c'), 'light'), '/c');
  assert.equal(authoredSrc(n('', '', '/c'), 'dark'), '/c');
  assert.equal(authoredSrc(n('', '', ''), 'dark'), '', 'nothing authored — the caller borrows a product photograph');
  // A Worker older than 0142 sends no light field at all.
  assert.equal(authoredSrc({ hero_image_url: '/d', image_url: '' }, 'light'), '/d');
  // authoredPhoto carries both files, and the light one only when it differs.
  assert.deepEqual(authoredPhoto(n('/d', '/l', '')), { src: '/d', lightSrc: '/l', productPhoto: false, productId: null });
  assert.deepEqual(authoredPhoto(n('', '/l', '')), { src: '/l', productPhoto: false, productId: null });
  assert.deepEqual(authoredPhoto(n('', '', '/c')), { src: '/c', productPhoto: false, productId: null });
  assert.equal(authoredPhoto(n('', '', '')), null);
});
