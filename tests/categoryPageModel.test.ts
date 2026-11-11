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

/**
 * WHAT A SECTION CAN DO NOW, THROUGH THE REAL ROUTE (owner, 2026-11-11: «بطلب مسبق» or «غير متوفرة حالياً»,
 * whichever fits; DECISIONS row 309). The route counts its children by the cards' own states. With the shelf
 * emptied, printers that offer pre-order read «بطلب مسبق» in their row and hero — never «غير متوفرة», which the
 * shelf count alone would have said of most Bambu filaments; with pre-order taken away too, «غير متوفرة حالياً».
 * A root this page read nothing of carries null counts, never a false 0.
 */
test('a section with nothing on the shelf reads «بطلب مسبق» when it can be pre-ordered, «غير متوفرة حالياً» when nothing can be ordered', async () => {
  const emptyShelf = 'UPDATE products SET stock = 0, stock_reserved = 0; UPDATE product_variants SET stock = 0';
  const rowLine = (body: CategoryPayload) => {
    const html = renderToStaticMarkup(
      createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(CategoryRowBanners, { rows: bannerRows(body.children, []), label: 'x' })) })
    );
    return [...html.matchAll(/<p class="line-clamp-1[^"]*">([^<]*)<\/p>/g)].map((m) => m[1]);
  };

  const pre = (await page('printers', emptyShelf)).body;
  const fdm = pre.children.find((c) => c.slug === 'fdm-printers')!;
  assert.equal(fdm.available_count, 0);
  assert.ok((fdm.preorder_count ?? 0) > 0, 'the seed’s printers offer pre-order');
  assert.ok(rowLine(pre).some((l) => l.endsWith(' · بطلب مسبق')), rowLine(pre).join(' | '));
  assert.ok(!rowLine(pre).some((l) => l.includes('غير متوفر')), 'a pre-order section is never «غير متوفرة»');
  const hero = renderHero(pre);
  assert.match(hero, /data-hero-stock=""/);
  assert.match(hero, /بطلب مسبق/);

  const none = (await page('printers', `${emptyShelf}; UPDATE products SET sale_types = '["direct_sale"]', selling_type = 'direct_sale'`)).body;
  const fdmNone = none.children.find((c) => c.slug === 'fdm-printers')!;
  assert.equal(fdmNone.preorder_count, 0);
  assert.equal(fdmNone.unavailable_count, fdmNone.product_count, 'every printer is unavailable');
  assert.ok(rowLine(none).some((l) => l.endsWith(' · غير متوفرة حالياً')), rowLine(none).join(' | '));
  assert.match(renderHero(none), /غير متوفرة حالياً/);

  // In stock: the usual words, and no state word beside them.
  const stocked = (await page('printers')).body;
  assert.ok(rowLine(stocked).every((l) => !/بطلب مسبق|غير متوفر/.test(l)), rowLine(stocked).join(' | '));
  assert.doesNotMatch(renderHero(stocked), /data-hero-stock/);

  // Another root, read nothing of here: unknown, never a 0 a row could word as «غير متوفرة».
  const materials = (await page('printing-materials')).body;
  for (const r of materials.related) {
    assert.equal(r.available_count, null, r.slug);
    assert.equal(r.preorder_count ?? null, null, r.slug);
  }
});

/** `run` with the language provider opening in `lang`: it reads the stored choice once, as it mounts. */
function inLanguage<T>(lang: 'ar' | 'en' | 'ckb', run: () => T): T {
  const scope = globalThis as { localStorage?: unknown };
  const had = scope.localStorage;
  scope.localStorage = { getItem: (k: string) => (k === 'levo_lang' ? lang : null), setItem: () => {}, removeItem: () => {} };
  try {
    return run();
  } finally {
    if (had === undefined) delete scope.localStorage;
    else scope.localStorage = had;
  }
}

/** The hero's «متوفر الآن» stat as it reads: its figure and its words. */
const heroAvailable = (html: string) =>
  [...(/<div data-hero-available=""[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? '').matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map((m) => m[1]).join(' ');

/** What a row for the same section says after its count. */
function rowStock(node: CategoryPayload['node']): string {
  const html = renderToStaticMarkup(
    createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(CategoryRowBanners, { rows: bannerRows([node], []), label: 'x' })) })
  );
  return (/<p class="line-clamp-1[^"]*">([^<]*)<\/p>/.exec(html)?.[1] ?? '').split(' · ').slice(1).join(' · ');
}

/**
 * THE HERO SAYS WHAT ITS ROWS SAY (row 309). Live on 2026-11-11 the hero of «مواد الطباعة» and of «إكسسوارات
 * الطابعات» said «1 متوفرة الآن» above a row saying «1 متوفر الآن»: the agreement fix had reached the rows, not
 * the hero's own stat. Both now take the rule and the words from src/lib/catalog/copy.ts, in all three languages.
 */
test('the hero’s stat agrees as its rows do — «1 متوفر الآن» for a product, «1 متوفرة الآن» for a printer — in three languages', async () => {
  // «makers-supply» with one of its two products sold out: one product on the shelf, through the real route.
  const ring = 'prd_94dedaeb082243efb43a';
  const makers = (await page('makers-supply', `UPDATE products SET stock = 0, stock_reserved = 0 WHERE id = '${ring}'; UPDATE product_variants SET stock = 0 WHERE product_id = '${ring}'`)).body;
  assert.deepEqual([makers.node.product_count, makers.node.available_count], [2, 1]);
  const printers = (await page('printers')).body;
  assert.deepEqual([printers.node.product_count, printers.node.available_count], [10, 4]);
  const onePrinter = { ...printers, node: { ...printers.node, available_count: 1 } };

  const cases: Array<[CategoryPayload, Record<'ar' | 'en' | 'ckb', string>]> = [
    [makers, { ar: '1 متوفر الآن', en: '1 available now', ckb: '1 ئێستا بەردەستە' }],
    [onePrinter, { ar: '1 متوفرة الآن', en: '1 available now', ckb: '1 ئێستا بەردەستە' }],
    [printers, { ar: '4 متوفرة الآن', en: '4 available now', ckb: '4 ئێستا بەردەستە' }],
  ];
  const term = { ar: 'التوفر', en: 'Availability', ckb: 'بەردەستبوون' };
  for (const lang of ['en', 'ckb', 'ar'] as const) {
    for (const [payload, want] of cases) {
      const hero = inLanguage(lang, () => renderHero(payload));
      const label = `${lang} ${payload.node.slug} ${payload.node.available_count}/${payload.node.product_count}`;
      assert.equal(heroAvailable(hero), want[lang], `${label}: the hero`);
      assert.equal(inLanguage(lang, () => rowStock(payload.node)), want[lang], `${label}: the row for the same section`);
      assert.ok(hero.includes(`<dt class="sr-only">${term[lang]}</dt>`), `${label}: a screen reader hears the same words`);
    }
  }
  assert.doesNotMatch(renderHero(makers), /متوفرة الآن/, 'never «1 متوفرة الآن» for one product (the live hero’s word)');
  // A section of one, and one whose products are all on the shelf: the words alone, as the rows say them.
  const one = { ...makers, node: { ...makers.node, product_count: 1, available_count: 1 } };
  assert.equal(heroAvailable(renderHero(one)), 'متوفر الآن');
  assert.equal(heroAvailable(renderHero({ ...printers, node: { ...printers.node, available_count: 10 } })), 'كلها متوفرة');
});
