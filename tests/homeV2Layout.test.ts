/**
 * HOMEPAGE V2 — the data decisions behind the new sections, and the order the
 * owner fixed (src/lib/homeLayout.ts, src/pages/Home.tsx).
 *
 * The mapping is pure, so it is held directly: which category each bento tile
 * opens, what happens when a section has no products, which photograph a tile
 * borrows, what «أحدث المنتجات» puts first, and when the editorial banners are
 * the owner's and when they are the built-in pair. The page-level contract —
 * section order, lazy chunks, no trust strip above the categories — is held in
 * the source, as the rest of this repo does for layout decisions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiProduct, HomeBanner, HomeTaxon, SiteMediaEntry } from '../src/lib/api';
import {
  findCategory,
  isAvailableDirect,
  latestChips,
  orderLatest,
  resolveBento,
  resolveEditorial,
  BENTO_MATCHERS,
  EDITORIAL_SLOT,
} from '../src/lib/homeLayout';

// ------------------------------------------------------------------ fixtures

const node = (id: string, slug: string, children?: HomeTaxon[], image_url = ''): HomeTaxon => ({
  id,
  slug,
  name_ar: id,
  name_en: id,
  name_ckb: id,
  product_count: 1,
  image_url,
  ...(children ? { children } : {}),
});

/** The shape the live shop's tree had when this was written. */
const LIVE_TREE: HomeTaxon[] = [
  node('cat_printers', 'printers', [node('cat_printers_fdm', 'fdm-printers')]),
  node('cat_pacc', 'printer-accessories', [node('cat_pacc_fdm', 'fdm-printer-accessories')]),
  node('cat_materials', 'printing-materials', [node('cat_materials_fdm', 'fdm-materials')]),
  node('cat_makers', 'makers-supply', [node('cat_makers_new', 'new-products'), node('cat_makers_tools', 'maker-tools')]),
];

let seq = 0;
const product = (over: Partial<ApiProduct> & { id?: string }): ApiProduct =>
  ({
    id: over.id ?? `p${++seq}`,
    slug: over.id ?? `p${seq}`,
    name: over.name ?? 'Thing',
    images: over.images ?? [`/files/products/${over.id ?? seq}.webp`],
    category_id: over.category_id ?? null,
    sub_category_id: over.sub_category_id ?? null,
    direct_stock_available: over.direct_stock_available,
    price_iqd: 1000,
  }) as unknown as ApiProduct;

// ------------------------------------------------------------ availability

test('available for direct sale means a positive sellable count, and nothing else', () => {
  assert.equal(isAvailableDirect({ direct_stock_available: 3 }), true);
  assert.equal(isAvailableDirect({ direct_stock_available: 0 }), false, 'an exhausted shelf');
  assert.equal(isAvailableDirect({}), false, 'a hidden count is not a promise of stock');
});

test('«أحدث المنتجات»: available direct-sale products first, each group keeping newest-first order', () => {
  const list = [
    product({ id: 'new-preorder', direct_stock_available: 0 }),
    product({ id: 'new-instock', direct_stock_available: 2 }),
    product({ id: 'older-hidden' }),
    product({ id: 'older-instock', direct_stock_available: 40 }),
    product({ id: 'new-instock', direct_stock_available: 2 }),
  ];
  assert.deepEqual(
    orderLatest(list).map((p) => p.id),
    ['new-instock', 'older-instock', 'new-preorder', 'older-hidden'],
    'a stable partition: 40 units is not "newer" than 2, and a duplicate keeps its first place'
  );
});

// ------------------------------------------------------------- the bento

test('each tile finds its category by the seeded id first, then by slug, including a child section', () => {
  assert.equal(findCategory(LIVE_TREE, BENTO_MATCHERS.printers)?.id, 'cat_printers');
  assert.equal(findCategory(LIVE_TREE, BENTO_MATCHERS.filament)?.id, 'cat_materials_fdm', 'a child of the materials root');
  const renamed = [node('x_printers', 'printers-levo')];
  assert.equal(findCategory(renamed, BENTO_MATCHERS.printers)?.id, 'x_printers', 'the suffixed seed slug');
  assert.equal(findCategory(LIVE_TREE, BENTO_MATCHERS.resin), null, 'a section with no products is not in the tree');
});

test('the bento draws only sections the shop stocks, and maps accessories to the nearest real section', () => {
  const pool = [
    product({ id: 'h2s', category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm', direct_stock_available: 1 }),
    product({ id: 'pla', category_id: 'cat_materials', sub_category_id: 'cat_materials_fdm', direct_stock_available: 11 }),
    product({ id: 'nozzle', category_id: 'cat_pacc', sub_category_id: 'cat_pacc_fdm', direct_stock_available: 5 }),
    product({ id: 'ring', category_id: 'cat_makers', sub_category_id: 'cat_makers_tools', direct_stock_available: 9 }),
  ];
  const tiles = resolveBento(LIVE_TREE, pool, []);
  assert.deepEqual(
    tiles.map((t) => [t.id, t.to]),
    [
      ['printers', '/categories/printers'],
      ['filament', '/categories/printing-materials/fdm-materials'],
      ['parts', '/categories/printer-accessories'],
      ['accessories', '/categories/makers-supply/maker-tools'],
    ],
    'no Resin tile over an empty listing, no «المستعمل» tile with no graded stock'
  );
  assert.deepEqual(
    tiles.map((t) => t.imageProductId),
    ['h2s', 'pla', 'nozzle', 'ring'],
    'each tile borrows a photograph from its own section'
  );
});

test('an accessories section that stocks something wins over the Maker-tools fallback', () => {
  const tree = [...LIVE_TREE, node('cat_accessories', 'accessories')];
  const tiles = resolveBento(tree, [], []);
  assert.equal(tiles.find((t) => t.id === 'accessories')?.to, '/categories/accessories');
});

test('the used tile appears with graded stock and opens the used page', () => {
  const graded = product({ id: 'used-a1', category_id: 'cat_printers' });
  const tiles = resolveBento(LIVE_TREE, [], [graded]);
  const used = tiles.find((t) => t.id === 'used');
  assert.ok(used);
  assert.equal(used.to, '/used-printers');
  assert.equal(used.imageProductId, 'used-a1');
});

test('a picture the owner chose for a section outranks a borrowed product photograph', () => {
  const tree = [node('cat_printers', 'printers', [], '/files/UiUx/MainPage/catalog-printers.webp')];
  const tiles = resolveBento(tree, [product({ category_id: 'cat_printers', direct_stock_available: 1 })], []);
  assert.equal(tiles[0].image, '/files/UiUx/MainPage/catalog-printers.webp');
  assert.equal(tiles[0].imageProductId, null, 'so it is shown whole, never cropped as a catalogue photo');
});

test('a tile prefers a product that can be bought now, and two tiles never share one photograph', () => {
  const tree = [node('cat_printers', 'printers', [node('cat_printers_fdm', 'fdm-printers')])];
  const pool = [
    product({ id: 'soldout', category_id: 'cat_printers', direct_stock_available: 0 }),
    product({ id: 'instock', category_id: 'cat_printers', direct_stock_available: 3 }),
    product({ id: 'noimage', category_id: 'cat_printers', direct_stock_available: 9, images: [] }),
  ];
  assert.equal(resolveBento(tree, pool, [])[0].imageProductId, 'instock');
  assert.equal(resolveBento(tree, [], [])[0].image, '', 'no product, no picture — never a stock image');
});

// ------------------------------------------------------------- the chips

test('the chips follow the tiles; «الإكسسوارات» lists both accessory sections', () => {
  const chips = latestChips(resolveBento(LIVE_TREE, [], []));
  assert.deepEqual(
    chips.map((c) => c.id),
    ['all', 'printers', 'filament', 'accessories'],
    'no Resin chip for a section with nothing in it'
  );
  const acc = chips.find((c) => c.id === 'accessories')!;
  assert.deepEqual(acc.categoryIds, ['cat_pacc', 'cat_makers_tools']);
  assert.ok(acc.memberIds.has('cat_pacc_fdm'), 'a product filed in a child section is a member');
});

// ------------------------------------------------------------- editorial

const EMPTY = { ar: '', en: '', ckb: '' };
const pickText = (t: HomeBanner['title'], lang: string) => (lang === 'en' ? t.en || t.ar : t.ar || t.en);

test('the owner’s editorial banners win, first two with a picture, in their words', () => {
  const owner: HomeBanner[] = [
    { id: 'a', image: '/files/a.webp', link: '/bundles', title: { ...EMPTY, ar: 'أ' }, subtitle: EMPTY, cta: EMPTY },
    { id: 'no-picture', image: '', link: '/x', title: { ...EMPTY, ar: 'ب' }, subtitle: EMPTY, cta: EMPTY },
    { id: 'b', image: '/files/b.webp', link: 'https://example.com', title: EMPTY, subtitle: EMPTY, cta: EMPTY },
    { id: 'c', image: '/files/c.webp', link: '/y', title: EMPTY, subtitle: EMPTY, cta: EMPTY },
  ];
  const cards = resolveEditorial({ ownerBanners: owner, lang: 'ar', pickText, siteMedia: [], tree: LIVE_TREE, pool: [], avoid: new Set() });
  assert.deepEqual(cards.map((c) => c.key), ['a', 'b']);
  assert.equal(cards[0].title, 'أ');
  assert.equal(cards[1].title, null, 'no owner copy → the component draws nothing it was not given');
  assert.equal(cards[0].productPhoto, false, 'an uploaded picture is shown whole');
});

test('without owner banners, the spec pair is drawn over real photographs from the sections they open', () => {
  const pool = [
    product({ id: 'a1-combo', name: 'Bambu Lab A1 / A1 Combo 3D Printer', category_id: 'cat_printers', direct_stock_available: 5 }),
    product({ id: 'h2s', name: 'Bambu Lab H2S', category_id: 'cat_printers', direct_stock_available: 1 }),
    product({ id: 'pla', name: 'PLA Matte', category_id: 'cat_materials', sub_category_id: 'cat_materials_fdm' }),
  ];
  const cards = resolveEditorial({
    ownerBanners: undefined,
    lang: 'ar',
    pickText,
    siteMedia: [],
    tree: LIVE_TREE,
    pool,
    avoid: new Set(['h2s']),
  });
  assert.deepEqual(
    cards.map((c) => [c.preset, c.to, c.productPhoto]),
    [
      ['multicolor', '/categories/printers', true],
      ['materials', '/categories/printing-materials', true],
    ]
  );
  assert.equal(cards[0].image, '/files/products/a1-combo.webp', 'a multi-material machine for «اطبع بأكثر من لون»');
});

test('an uploaded site-media banner image is used before any product photograph', () => {
  const siteMedia: SiteMediaEntry[] = [
    { slot: 'banner-1', group: 'banner', label: '', link: '', url: '/files/UiUx/MainPage/banner-1-x.webp', custom: true },
  ];
  const cards = resolveEditorial({ ownerBanners: [], lang: 'ar', pickText, siteMedia, tree: LIVE_TREE, pool: [], avoid: new Set() });
  assert.deepEqual(cards.map((c) => [c.key, c.image, c.productPhoto]), [['multicolor', '/files/UiUx/MainPage/banner-1-x.webp', false]]);
});

test('a default banner with no real picture is not drawn', () => {
  assert.deepEqual(
    resolveEditorial({ ownerBanners: [], lang: 'ar', pickText, siteMedia: [], tree: LIVE_TREE, pool: [], avoid: new Set() }),
    []
  );
});

// ------------------------------------------------------------- the page

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the sections render in the owner’s order, with nothing between the ticker and the categories', () => {
  const home = stripComments(read('src/pages/Home.tsx'));
  const at = (needle: string) => {
    const i = home.indexOf(needle);
    assert.ok(i > 0, `${needle} is not rendered`);
    return i;
  };
  const order = ['<Hero ', '<Marquee', '<CategoryBento', '<PrinterFinder', '<LatestProducts', '<EditorialBanners', '<ServicesGrid'];
  const positions = order.map(at);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, order.join(' → '));
  // The old home page opened the light-coloured half with the services rail;
  // the owner asked for nothing between the hero and the categories.
  assert.equal(home.match(/<ServicesGrid/g)?.length, 1);
});

test('everything below the first screen is its own lazy chunk', () => {
  const home = read('src/pages/Home.tsx');
  for (const name of ['LatestProducts', 'EditorialBanners', 'ServicesGrid']) {
    assert.match(home, new RegExp(`const ${name} = React\\.lazy\\(\\(\\) => import\\(`), `${name} must be lazy`);
    assert.doesNotMatch(home, new RegExp(`^import ${name} from`, 'm'), `${name} must not be a static import`);
  }
});

test('the editorial banners are the owner’s to edit, under a registered admin section', () => {
  const admin = read('src/components/AdminHomeSettings.tsx');
  assert.equal(EDITORIAL_SLOT, 'editorial_banners');
  assert.match(admin, /\{ id: 'editorial_banners',[^}]*isVisible: true \}/, 'registered, so it can be hidden and appears in the tab bar');
  assert.match(admin, /activeTab === 'editorial_banners'\) && \(\s*<BannerSettings/);
});

test('«ساعدني أختار» opens the real printer advisor, and a link can start only that question', () => {
  assert.match(read('src/components/home/v2/PrinterFinder.tsx'), /to="\/support\?ask=choose_printer"/);
  const support = read('src/pages/Support.tsx');
  assert.match(support, /if \(qAsk !== 'choose_printer'\) return;/, 'allow-listed — never an arbitrary intent from a URL');
  assert.match(support, /intent: 'choose_printer'/, 'and it is the assistant’s own menu item');
});

test('the product card is the shop’s own card, reused — not a second light variant', () => {
  const latest = read('src/components/home/v2/LatestProducts.tsx');
  assert.match(latest, /import ProductCard from '\.\.\/ProductCard';/);
  assert.match(read('src/components/home/ProductCard.tsx'), /bg-surface rounded-xl border border-border-subtle/, 'still the dark panel');
});
