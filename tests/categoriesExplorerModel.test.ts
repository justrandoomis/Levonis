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
import { availableLabel, availableParts, categoriesCount, countNoun, countWord, explorerSubline, resultCountLabel, sectionStockLabel, showCountLabel } from '../src/lib/catalog/copy';
import { CATEGORY_PAGE_CAP, listingStockWord, rememberSectionStock, rememberedSectionStock, withStock } from '../src/lib/catalog/sectionStock';
import { listingTarget } from '../src/lib/catalog/listingModel';
import { cardStates, rollUpCounts } from '../worker/lib/catalogPresentation';
import { CATEGORY_PAGE_CAP as SERVER_CATEGORY_PAGE_CAP } from '../worker/routes/catalog';
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

/**
 * WHAT A SECTION CAN DO NOW, BESIDE ITS COUNT (owner, 2026-11-11; DECISIONS row 309): something on the shelf says
 * so; nothing on the shelf but something to pre-order is «بطلب مسبق», never «غير متوفرة»; «غير متوفرة حالياً» only
 * when every product is unavailable; anything unknown says nothing.
 */
test('sectionStockLabel: in stock, pre-order, unavailable, and silence when unknown — in three languages', () => {
  const s = (available: number | null, preorder?: number | null, unavailable?: number | null, total = 5, withheld: number | null | undefined = 0) => ({
    product_count: total, available_count: available, preorder_count: preorder, unavailable_count: unavailable, withheld_count: withheld,
  });
  assert.equal(sectionStockLabel(s(1, 4, 0), 'product', 'ar'), '1 متوفر الآن', 'in stock wins; one product agrees, «متوفر»');
  assert.equal(sectionStockLabel(s(1, 4, 0), 'printer', 'ar'), '1 متوفرة الآن', 'one printer, «متوفرة»');
  assert.equal(sectionStockLabel(s(1, 0, 0, 1), 'printer', 'ar'), 'متوفرة الآن');
  assert.equal(sectionStockLabel(s(1, 0, 0, 1), 'product', 'ar'), 'متوفر الآن');
  assert.equal(sectionStockLabel(s(4, 1, 0, 17), 'product', 'ar'), '4 متوفرة الآن');
  assert.equal(sectionStockLabel(s(0, 4, 1), 'product', 'ar'), 'بطلب مسبق', 'pre-order, even beside an unavailable one');
  assert.equal(sectionStockLabel(s(0, 4, 1), 'product', 'en'), 'Pre-order');
  assert.equal(sectionStockLabel(s(0, 4, 1), 'product', 'ckb'), 'بە پێش-داواکاری');
  assert.equal(sectionStockLabel(s(0, 0, 5), 'product', 'ar'), 'غير متوفرة حالياً');
  assert.equal(sectionStockLabel(s(0, 0, 5), 'product', 'en'), 'Unavailable now');
  assert.equal(sectionStockLabel(s(0, 0, 5), 'product', 'ckb'), 'ئێستا بەردەست نییە');
  for (const t of ['بە پێش-داواکاری', 'ئێستا بەردەست نییە']) assert.doesNotMatch(t, /[ةىيك]/, 'no Arabic-only letter in the Sorani');
  // Agreement: one product, one printer, the dual, more — on the shelf and off it.
  assert.equal(sectionStockLabel(s(2, 3, 0, 17), 'product', 'ar'), '2 متوفران الآن');
  assert.equal(sectionStockLabel(s(2, 3, 0, 17), 'printer', 'ar'), '2 متوفرتان الآن');
  assert.equal(sectionStockLabel(s(3, 2, 0, 17), 'printer', 'ar'), '3 متوفرة الآن');
  assert.equal(sectionStockLabel(s(0, 0, 1, 1), 'product', 'ar'), 'غير متوفر حالياً');
  assert.equal(sectionStockLabel(s(0, 0, 1, 1), 'printer', 'ar'), 'غير متوفرة حالياً');
  assert.equal(sectionStockLabel(s(0, 0, 2, 2), 'product', 'ar'), 'غير متوفرين حالياً');
  assert.equal(sectionStockLabel(s(0, 0, 2, 2), 'printer', 'ar'), 'غير متوفرتين حالياً');
  assert.equal(sectionStockLabel(s(0, 0, 11, 11), 'product', 'ar'), 'غير متوفرة حالياً');
  // Silence: unknown counts, an older answer, catalog-only products, an empty section.
  assert.equal(sectionStockLabel(s(null, 0, 5), 'product', 'ar'), null, 'the map past its cap');
  assert.equal(sectionStockLabel(s(0), 'product', 'ar'), null, 'an answer without the states');
  // A product whose shelf count the server withheld may be in stock: never «بطلب مسبق» over it.
  assert.equal(sectionStockLabel(s(0, 9, 0, 10, 1), 'printer', 'ar'), null, 'a withheld count silences the pre-order claim');
  assert.equal(
    sectionStockLabel({ product_count: 10, available_count: 0, preorder_count: 9, unavailable_count: 0 }, 'printer', 'ar'),
    null,
    'and so does an answer without the withheld count'
  );
  assert.equal(sectionStockLabel(s(0, null, null), 'product', 'ar'), null);
  assert.equal(sectionStockLabel(s(0, 0, 3), 'product', 'ar'), null, 'two of five are catalog-only or withheld: nothing is claimed');
  assert.equal(sectionStockLabel(s(0, 0, 0, 0), 'product', 'ar'), null);
});

/**
 * THE HERO'S FIGURE AND WORDS ARE THE ROWS' OWN (row 309, live 2026-11-11: «مواد الطباعة»'s hero said
 * «1 متوفرة الآن» above a row saying «1 متوفر الآن»). The hero draws `availableParts`; the rows and the
 * listing header say `availableLabel`, which joins the same parts — for every count, kind and language.
 * Sorani has its own words now, never the Arabic (DECISIONS row 183).
 */
test('availableParts: the hero’s figure and words are exactly what availableLabel joins — in three languages', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const kind of ['product', 'printer'] as const) {
      for (const total of [1, 2, 3, 10, 11, 17, 100]) {
        for (const available of [null, -1, 0, 1, 2, 3, total - 1, total]) {
          const parts = availableParts(available, total, lang, kind);
          const label = availableLabel(available, total, lang, kind);
          if (!parts) {
            assert.equal(label, null, `${lang} ${kind} ${available}/${total}`);
            continue;
          }
          assert.equal(label, parts.figure === null ? parts.words : `${parts.figure} ${parts.words}`, `${lang} ${kind} ${available}/${total}`);
          if (lang === 'ckb') assert.notEqual(label, availableLabel(available, total, 'ar', kind), 'the Sorani is never a copy of the Arabic');
        }
      }
    }
  }
  assert.deepEqual(availableParts(1, 17, 'ar', 'product'), { figure: 1, words: 'متوفر الآن' }, 'one product: «متوفر»');
  assert.deepEqual(availableParts(1, 10, 'ar', 'printer'), { figure: 1, words: 'متوفرة الآن' }, 'one printer: «متوفرة»');
  // The dual agrees as «غير متوفرين / متوفرتين» does (the third review): «2 متوفرة الآن» read as a mistake.
  assert.deepEqual(availableParts(2, 17, 'ar', 'product'), { figure: 2, words: 'متوفران الآن' }, 'two products: «متوفران»');
  assert.deepEqual(availableParts(2, 10, 'ar', 'printer'), { figure: 2, words: 'متوفرتان الآن' }, 'two printers: «متوفرتان»');
  assert.deepEqual(availableParts(3, 10, 'ar', 'printer'), { figure: 3, words: 'متوفرة الآن' }, 'three and more: the plural of things');
  assert.deepEqual(availableParts(11, 17, 'ar', 'product'), { figure: 11, words: 'متوفرة الآن' });
  assert.deepEqual(availableParts(4, 10, 'ar', 'product'), { figure: 4, words: 'متوفرة الآن' });
  assert.deepEqual(availableParts(1, 1, 'ar', 'product'), { figure: null, words: 'متوفر الآن' });
  assert.deepEqual(availableParts(3, 3, 'ar', 'printer'), { figure: null, words: 'كلها متوفرة' });
  assert.deepEqual(availableParts(1, 17, 'en', 'product'), { figure: 1, words: 'available now' });
  assert.equal(availableLabel(1, 17, 'ckb'), '1 ئێستا بەردەستە');
  assert.equal(availableLabel(1, 1, 'ckb', 'printer'), 'ئێستا بەردەستە');
  assert.equal(availableLabel(4, 4, 'ckb'), 'هەموویان بەردەستن');
  for (const w of ['ئێستا بەردەستە', 'هەموویان بەردەستن']) assert.doesNotMatch(w, /[ةىيك]/, 'no Arabic-only letter in the Sorani');
  // A section's line in Sorani: the stock word is Sorani whatever the state.
  const s = (available: number, preorder: number, unavailable: number, total = 5) => ({
    product_count: total, available_count: available, preorder_count: preorder, unavailable_count: unavailable, withheld_count: 0,
  });
  assert.equal(sectionStockLabel(s(1, 4, 0, 17), 'product', 'ckb'), '1 ئێستا بەردەستە');
  assert.equal(sectionStockLabel(s(1, 4, 0, 17), 'product', 'ar'), '1 متوفر الآن');
});

test('the listing header says its section’s word — never on a root’s «all», the map’s or an inactive one the category route named', () => {
  const node = (over: Partial<CatalogTreeNode>) =>
    ({ id: 'cat_makers', slug: 'makers-supply', parent_id: null, path: '/categories/makers-supply', product_count: 2, available_count: 1, preorder_count: 0, unavailable_count: 1, withheld_count: 0, product_type: null, is_printer_catalog: 0, children: [], ...over }) as unknown as CatalogTreeNode;
  const root = node({});
  const child = node({ id: 'cat_makers_new', slug: 'new-products', parent_id: 'cat_makers', path: '/categories/makers-supply/new-products' });
  // An inactive root the map leaves out, answered by the category route (src/pages/CategoryListing.tsx `fallback`).
  const inactiveAll = listingTarget(null, { node: root, root: true })!;
  assert.deepEqual([inactiveAll.canonical, inactiveAll.wholeRoot], ['/categories/makers-supply/all', true]);
  assert.equal(listingStockWord(inactiveAll, null, 'ar'), null, 'its «all» is the whole department: no section word');
  assert.equal(listingStockWord({ ...inactiveAll, wholeRoot: false }, null, 'ar'), '1 متوفر الآن', 'the word it used to say there');
  // An inactive section under it: its own word.
  const inactiveChild = listingTarget(null, { node: child, root: false })!;
  assert.deepEqual([inactiveChild.canonical, inactiveChild.wholeRoot], ['/categories/makers-supply/new-products', false]);
  assert.equal(listingStockWord(inactiveChild, null, 'ar'), '1 متوفر الآن');
  assert.equal(listingStockWord(inactiveChild, null, 'ckb'), '1 ئێستا بەردەستە');
  // The map's own root and section, as before.
  const mapAll = listingTarget({ node: root, root, all: true, canonical: '/categories/makers-supply/all' }, null)!;
  assert.equal(mapAll.wholeRoot, true);
  assert.equal(listingStockWord(mapAll, null, 'ar'), null);
  const mapChild = listingTarget({ node: child, root, all: false, canonical: child.path }, { node: root, root: true })!;
  assert.deepEqual([mapChild.node.id, mapChild.wholeRoot], ['cat_makers_new', false], 'the map wins over a stale fallback');
  assert.equal(listingTarget(null, 'missing'), null);
  assert.equal(listingTarget(null, null), null);
});

test('withStock lays the section answer’s counts over a map node, only when both counted the same products', () => {
  assert.equal(CATEGORY_PAGE_CAP, SERVER_CATEGORY_PAGE_CAP, 'the client mirrors the server’s cap');
  const node = { id: 'c', product_count: 5, available_count: null } as never;
  const counts = new Map([['c', { product_count: 5, available_count: 0, preorder_count: 5, unavailable_count: 0, withheld_count: 0 }]]);
  assert.deepEqual(
    (({ available_count, preorder_count, unavailable_count, withheld_count }) => ({ available_count, preorder_count, unavailable_count, withheld_count }))(withStock(node, counts) as never),
    { available_count: 0, preorder_count: 5, unavailable_count: 0, withheld_count: 0 }
  );
  assert.equal(withStock(node, new Map([['c', { product_count: 6, available_count: 0, preorder_count: 6, unavailable_count: 0 }]])), node, 'a different count is not laid over');
  assert.equal(withStock(node, null), node);
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

test('a section answer is remembered a minute, for every node it counted, and only when it counted stock', () => {
  const t0 = 1_000_000;
  rememberSectionStock(
    [
      { id: 'fdm', product_count: 47, available_count: 1, preorder_count: 44, unavailable_count: 0, withheld_count: 0 },
      { id: 'pla', product_count: 17, available_count: 1, preorder_count: 16, unavailable_count: 0, withheld_count: 0 },
      { id: 'big', product_count: 589, available_count: null },
    ],
    t0
  );
  assert.equal(rememberedSectionStock(['fdm', 'pla'], t0 + 30_000)?.get('pla')?.preorder_count, 16, 'PLA from the parent’s answer');
  assert.equal(rememberedSectionStock(['fdm', 'pla'], t0 + 61_000), null, 'older than a minute: ask again');
  assert.equal(rememberedSectionStock(['fdm', 'big'], t0 + 1_000), null, 'an uncounted node is never remembered');
  assert.equal(rememberedSectionStock(['nowhere'], t0), null);
});

test('the server splits a withheld shelf count from a catalog-only card, and rolls the states up per section', () => {
  const states = cardStates([
    ['on', { sale_types: ['direct_sale'], direct_stock_available: 3 }],
    ['pre', { sale_types: ['direct_sale', 'pre_order'], direct_stock_available: 0 }],
    ['out', { sale_types: ['direct_sale'], direct_stock_available: 0 }],
    ['pool', { sale_types: ['direct_sale'] }],
    ['catalog', { sale_types: ['direct_sale'], price_status: 'unpriced' }],
  ]);
  assert.deepEqual(Object.fromEntries(states), { on: 'available', pre: 'preorder', out: 'unavailable', pool: 'withheld', catalog: 'unknown' });
  const byProduct = new Map([...states.keys()].map((id) => [id, new Set(['sec'])]));
  byProduct.set('unread', new Set(['sec']));
  assert.deepEqual(rollUpCounts(byProduct, states).get('sec'), { products: 6, available: 1, preorder: 1, unavailable: 1, withheld: 1 });
});
