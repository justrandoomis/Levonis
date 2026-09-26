/**
 * THE CATEGORY PAGE (catalog discovery S4, docs/ux/CATALOG_DISCOVERY.md §6).
 *
 * Over the live catalogue of 2026-09-25 through the REAL `GET /api/catalog/:slug`:
 *   - /categories/printers draws an FDM shelf (10), «جاهزة للتسليم الآن» (4),
 *     «للطباعة بأكثر من لون» (≥ 3) and the brands (2), with a jump chip each;
 *   - /categories/printing-materials renders as a listing (compact hero);
 *   - under the hero, the section's children as hero-banner rows, one per line
 *     (owner, 2026-09-26) — on the shelves page and on the listing page alike;
 *   - no Resin or Laser frame is drawn;
 *   - a leaf slug and a renamed slug replace to the canonical path;
 *   - the hero says only what the data says (no description → no line), offers
 *     the finder and compare to printers and «تصفّح الكل» to everything else.
 *
 * Run: node --import tsx --test tests/categoryPageModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { asD1, freshDb, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';
import {
  categoryRedirect,
  heroPhoto,
  isPrinterNode,
  jumpChips,
  nodeDescription,
  nodeName,
  relatedHeading,
  shelfDomId,
  shelfSubline,
  shelfTitle,
} from '../src/lib/catalog/categoryPageModel';
import { bannerRows, type PhotoCandidate } from '../src/lib/catalog/explorerModel';
import CategoryRowBanners from '../src/components/catalog/CategoryRowBanners';
import { LanguageProvider } from '../src/LanguageContext';
import CategoryHero from '../src/components/catalog/CategoryHero';
import type { CategoryPayload } from '../src/lib/catalog/types';

async function page(slug: string, extra = ''): Promise<{ status: number; body: CategoryPayload }> {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (extra) raw.exec(extra);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/catalog', catalogRoutes));
  const res = await app.request(`/api/catalog/${slug}`);
  return { status: res.status, body: (await json(res)) as CategoryPayload };
}

test('/categories/printers: FDM (10), ready now (4), multicolour (≥ 3), brands (2) — each with a jump chip', async () => {
  const { body } = await page('printers');
  assert.equal(body.layout, 'shelves');
  const shelves = body.shelves;
  assert.deepEqual(shelves.map((s) => s.kind), ['child', 'available', 'multicolor', 'brand']);
  assert.equal(shelfTitle(shelves[0], 'ar'), 'طابعات FDM');
  assert.equal(shelves[0].count, 10);
  assert.equal(shelfTitle(shelves[1], 'ar'), 'جاهزة للتسليم الآن');
  assert.equal(shelves[1].count, 4);
  assert.equal(shelfTitle(shelves[2], 'ar'), 'للطباعة بأكثر من لون');
  assert.ok(shelves[2].count >= 3);
  assert.equal(body.brands.length, 2);
  assert.equal(shelfSubline(shelves[1], 'ar'), 'بيع مباشر من مخزون Levonis في العراق.', 'the shop is «Levonis» in Latin letters (DECISIONS row 99)');
  assert.match(shelfSubline(shelves[2], 'ar'), /^16 لونًا فأكثر/);

  const chips = jumpChips(shelves, 'ar');
  assert.deepEqual(
    chips.map((c) => [c.label, c.count]),
    [
      ['طابعات FDM', 10],
      ['متوفرة الآن', 4],
      ['متعددة الألوان', shelves[2].count],
      ['العلامات التجارية', null],
    ]
  );
  assert.deepEqual(chips.map((c) => c.target), shelves.map(shelfDomId));
  assert.ok(chips.every((c) => /^shelf-[a-zA-Z0-9_-]+$/.test(c.target)), 'the chip targets are valid element ids');
  // «عرض الكل» goes to the canonical listing, with the smart shelf's preset.
  assert.deepEqual(shelves.slice(0, 3).map((s) => s.see_all), [
    '/categories/printers/fdm-printers',
    '/categories/printers/all?avail=1',
    '/categories/printers/all?colors=16-',
  ]);
});

test('no Resin or Laser frame is drawn', async () => {
  const { body } = await page('printers');
  const words = JSON.stringify(body.shelves.map((s) => [s.id, shelfTitle(s, 'en'), s.catalog?.slug ?? '']));
  assert.doesNotMatch(words, /resin|laser/i);
  assert.ok(body.related.every((r) => r.product_count > 0), 'related tiles lead only to stocked departments');
});

test('a single shelf gets no jump row', () => {
  assert.deepEqual(jumpChips([{ id: 'child:x', kind: 'child', title_key: 'child', count: 3, see_all: '/x', products: [] }], 'ar'), []);
});

test('/categories/printing-materials is its own listing', async () => {
  const { body } = await page('printing-materials');
  assert.equal(body.layout, 'listing');
  assert.equal(nodeName(body.node, 'ar'), 'مواد الطباعة');
  assert.equal(isPrinterNode(body.node), false);
  assert.equal(relatedHeading(body.node, 'ar'), 'تحتاجها مع الخيوط');
  assert.equal(categoryRedirect(body, '/categories/printing-materials'), null, 'a root is drawn where it is');
});

test('a leaf section replaces to its listing; a renamed slug to the canonical path', async () => {
  const leaf = await page('fdm-printers');
  assert.equal(categoryRedirect(leaf.body, '/categories/fdm-printers'), '/categories/printers/fdm-printers');

  const moved = await page('old-printers', `INSERT INTO catalog_slug_history (slug, catalog_id) VALUES ('old-printers', 'cat_printers')`);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.moved, true);
  assert.equal(categoryRedirect(moved.body, '/categories/old-printers'), '/categories/printers');
});

test('an unknown slug is a 404 the page turns into «هذه الفئة غير موجودة»', async () => {
  const { status, body } = await page('no-such-thing');
  assert.equal(status, 404);
  assert.equal((body as unknown as { code: string }).code, 'CATALOG_NOT_FOUND');
});

test('the hero borrows an available printer’s photograph, and the owner’s picture wins', async () => {
  // The seed has no photographs; give every product one, as the live shop has.
  const { body } = await page('printers', `UPDATE products SET images = json_array('/files/products/' || slug || '.webp')`);
  const photo = heroPhoto(body);
  assert.ok(photo?.productPhoto);
  const card = body.shelves.flatMap((s) => s.products as Array<{ id: string; direct_stock_available?: number }>).find((c) => c.id === photo!.productId);
  assert.ok((card?.direct_stock_available ?? 0) > 0);

  const own = await page('printers', `UPDATE catalogs SET hero_image_key = 'UiUx/MainPage/PrintersHero.webp' WHERE id = 'cat_printers'`);
  assert.deepEqual(heroPhoto(own.body), { src: '/files/UiUx/MainPage/PrintersHero.webp', productPhoto: false, productId: null });
});

function renderHero(payload: CategoryPayload, compact = false): string {
  return renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(CategoryHero, { payload, photo: null, compact })),
    })
  );
}

test('the printers hero: breadcrumb, name, description, live stats, the finder and compare doors', async () => {
  const { body } = await page('printers');
  const html = renderHero(body);
  assert.match(html, /href="\/categories"/, '«الفئات» leads to the explorer');
  assert.match(html, /<h1[^>]*>الطابعات<\/h1>/);
  assert.ok(html.includes(nodeDescription(body.node, 'ar')) && nodeDescription(body.node, 'ar') !== '');
  assert.match(html, />10<\/dd>/);
  assert.match(html, />4<\/dd>/);
  assert.match(html, /href="\/printer-finder"/);
  assert.match(html, /data-hero-cta="compare"/);
  assert.doesNotMatch(html, /data-hero-cta="all"/);
});

test('any other hero: one «تصفّح الكل», and no description line when the admin wrote none', async () => {
  const { body } = await page('makers-supply', `UPDATE catalogs SET description_ar = '', description_en = '' WHERE id = 'cat_makers'`);
  const html = renderHero(body);
  assert.match(html, /href="\/categories\/makers-supply\/all"/);
  assert.doesNotMatch(html, /printer-finder/);
  assert.doesNotMatch(html, /data-hero-description/, 'no empty description paragraph is drawn');
});

test('the children as hero-banner rows under the hero: printers (shelves) and printing-materials (listing)', async () => {
  const photos = `UPDATE products SET images = json_array('/files/products/' || slug || '.webp')`;
  const printers = (await page('printers', photos)).body;
  const hero = heroPhoto(printers)!.productId!;
  const cards = printers.shelves.flatMap((s) => (s.products ?? []) as PhotoCandidate[]);
  const rows = bannerRows(printers.children, cards, new Set([hero]));
  assert.deepEqual(rows.map((r) => r.node.slug), ['fdm-printers']);
  assert.ok(rows[0].photo?.productPhoto && rows[0].photo.productId !== hero, 'not the hero’s own product');

  const materials = (await page('printing-materials', photos)).body;
  assert.equal(materials.layout, 'listing');
  const mRows = bannerRows(materials.children, materials.shelves.flatMap((s) => (s.products ?? []) as PhotoCandidate[]));
  assert.deepEqual(mRows.map((r) => r.node.path), ['/categories/printing-materials/fdm-materials']);
  assert.ok(mRows[0].photo, 'the only product lends its photograph rather than leave the row bare');

  const html = renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(CategoryRowBanners, { rows: mRows, label: 'x', heading: 'أقسام مواد الطباعة' })),
    })
  );
  assert.match(html, /<h2[^>]*>أقسام مواد الطباعة<\/h2>/);
  assert.match(html, /href="\/categories\/printing-materials\/fdm-materials"/);
  assert.match(html, /تسوق الآن/, 'a list is shopped, not explored');
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});

test('a section with no children draws no banner section', () => {
  const html = renderToStaticMarkup(
    createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(CategoryRowBanners, { rows: [], label: 'x', heading: 'y' })) })
  );
  assert.equal(html, '');
});

test('the hero is part of the page: no card, no border, no ring — breadcrumb, name, one line each, the doors', async () => {
  const { body } = await page('printers');
  const html = renderHero(body);
  const section = html.match(/<section[^>]*>/)![0];
  // Owner, 2026-09-26: «بدون حدود المستطيل الذي يحيط بها (مدموجه في الصفحه)».
  assert.doesNotMatch(section, /rounded|ring-|border|bg-|min-h-/, 'the section draws no box');
  assert.doesNotMatch(section, /data-feature/, 'it stands on the page, not on a feature surface');
  assert.match(html, /line-clamp-1/, 'the description is one line');
  assert.match(html, />10<\/dd><dd>طابعات<\/dd>/, 'the counts are one inline line');
  assert.match(html, /data-hero-cta="finder"/);
});

test('the hero shows the admin’s banner for the theme on screen as a band that fades into the page', async () => {
  const { body } = await page(
    'printers',
    `UPDATE catalogs SET hero_image_key = 'UiUx/MainPage/PrintersDark.webp', hero_light_image_key = 'UiUx/MainPage/PrintersLight.webp' WHERE id = 'cat_printers'`
  );
  assert.equal(body.node.hero_light_image_url, '/files/UiUx/MainPage/PrintersLight.webp', 'GET /api/catalog/:slug exposes the light banner');
  const photo = heroPhoto(body)!;
  assert.deepEqual(photo, {
    src: '/files/UiUx/MainPage/PrintersDark.webp',
    lightSrc: '/files/UiUx/MainPage/PrintersLight.webp',
    productPhoto: false,
    productId: null,
  });
  const html = renderToStaticMarkup(
    createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(CategoryHero, { payload: body, photo })) })
  );
  assert.match(html, /data-hero-photo="band"/);
  assert.match(html, /lv-hero-blend/, 'faded on the reading side and at both edges');
  assert.doesNotMatch(html, /data-ground="dark"/, 'never a framed window');
  assert.match(html, /PrintersLight\.webp/, 'the light theme gets the light banner');
  // Only the light one uploaded: the dark theme falls back to it.
  const light = await page('printers', `UPDATE catalogs SET hero_light_image_key = 'UiUx/MainPage/PrintersLight.webp' WHERE id = 'cat_printers'`);
  assert.equal(heroPhoto(light.body)!.src, '/files/UiUx/MainPage/PrintersLight.webp');
});
