/**
 * THE OWNER'S CONTROLS OVER THE HOME PAGE (2026-09-26).
 *
 *  «اجعل الصورة تملأ البطاقة … أجعل الصورة يمكن تغييرها من قسم تعديل اللوحة
 *   الرئيسية للأدمن حيث يضع صورتين تناسب الثيم الفاتح والثيم الداكن»
 *        → site-media pairs `home-<target>-light|dark` (worker/lib/siteMedia.ts),
 *          resolved by src/lib/homeLayout.ts `ownerPhoto`; full-bleed tiles.
 *  «في قسم إعدادات الصفحة الرئيسية أجعل القسم يتبع التقسيم الحالي»
 *        → src/lib/homeSections.ts, read by the page AND the admin.
 *  «يقرر ماذا يضع على اليسار في المربع الكبير وماذا يضع في المربعات الخمسة»
 *        → the `homeBento` assignment (worker/lib/homeBento.ts).
 *  «النص يبدو متداخل … كله على اليمين … الهيرو بانر أبيض لا يمكن فرزه»
 *        → the hero's leading, its picture, its own panel.
 *
 * Run: npx tsx --test tests/homeOwnerControls.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiProduct, HomeTaxon, SiteMediaEntry } from '../src/lib/api';
import { ownerPhoto, resolveBento, resolveEditorial, resolveHeroVisual } from '../src/lib/homeLayout';
import { HOME_SECTIONS, normalizeHomeSections, serializeHomeSections, slideGroupVisible } from '../src/lib/homeSections';
import {
  HOME_PHOTO_SLOTS,
  findSiteMediaSlot,
  isSiteMediaObject,
  mintSiteMediaObject,
  normalizeSiteMedia,
  resolveSiteMedia,
} from '../worker/lib/siteMedia';
import { BENTO_POSITIONS, normalizeHomeBento, validateHomeBento } from '../worker/lib/homeBento';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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
const TREE: HomeTaxon[] = [
  node('cat_printers', 'printers', [node('cat_printers_fdm', 'fdm-printers')]),
  node('cat_pacc', 'printer-accessories', [node('cat_pacc_fdm', 'fdm-printer-accessories')]),
  node('cat_materials', 'printing-materials', [node('cat_materials_fdm', 'fdm-materials')]),
  node('cat_makers', 'makers-supply', [node('cat_makers_tools', 'maker-tools')]),
];
let seq = 0;
const product = (over: Partial<ApiProduct>): ApiProduct =>
  ({
    id: over.id ?? `p${++seq}`,
    slug: over.slug ?? over.id ?? `p${seq}`,
    name: over.name ?? 'Thing',
    images: over.images ?? [`/files/products/${over.id ?? seq}.webp`],
    category_id: over.category_id ?? null,
    sub_category_id: over.sub_category_id ?? null,
    direct_stock_available: over.direct_stock_available,
    is_featured: over.is_featured ?? false,
    price_iqd: 1000,
  }) as unknown as ApiProduct;

/** A resolved site-media list, as `/api/home` sends it, with some uploads. */
const media = (uploads: Record<string, string>): SiteMediaEntry[] =>
  resolveSiteMedia(uploads) as SiteMediaEntry[];

// ------------------------------------------------------ the slot allow-list

test('every home picture has exactly a light and a dark slot, and nothing else is a home slot', () => {
  const targets = [
    'hero',
    'bento-large', 'bento-top-1', 'bento-top-2', 'bento-bottom-1', 'bento-bottom-2', 'bento-bottom-3',
    'editorial-multicolor', 'editorial-materials',
  ];
  assert.deepEqual(
    HOME_PHOTO_SLOTS.map((s) => s.slot),
    targets.flatMap((t) => [`home-${t}-light`, `home-${t}-dark`])
  );
  for (const s of HOME_PHOTO_SLOTS) {
    assert.equal(s.group, 'home');
    assert.equal(s.defaultObject, '', 'no default: an empty pair keeps the automatic photograph');
    assert.equal(findSiteMediaSlot(s.slot), s, `${s.slot} is on the allow-list`);
  }
});

test('a slot name that is not on the list is refused, whatever it looks like', () => {
  for (const bad of ['home-evil-light', 'home-hero', 'home-hero-light ', '../home-hero-light', 'HOME-HERO-LIGHT', '', null, 42, {}]) {
    assert.equal(findSiteMediaSlot(bad), null, String(bad));
  }
  // A stored map is re-checked on the way out: unknown slots and anything that
  // is not a bare .webp name are dropped, so no URL or path can be injected.
  assert.deepEqual(
    normalizeSiteMedia({
      'home-hero-light': 'home-hero-light-abc.webp',
      'home-hero-dark': 'https://evil.example/x.webp',
      'home-nope-light': 'a.webp',
      'home-bento-large-dark': '../../secret.webp',
    }),
    { 'home-hero-light': 'home-hero-light-abc.webp' }
  );
  assert.ok(isSiteMediaObject(mintSiteMediaObject('home-editorial-materials-dark', 'Tok_123')));
});

test('the upload route converts a home photograph, keeps WebP-only for logos, and sits behind requireAdmin', () => {
  const admin = read('worker/routes/admin.ts');
  assert.match(admin, /adminRoutes\.use\('\*', requireAdmin\);/, 'every admin route, site media included, requires an admin');
  const route = admin.slice(admin.indexOf("adminRoutes.post('/site-media/:slot'"), admin.indexOf("adminRoutes.delete('/site-media/:slot'"));
  assert.match(route, /const slot = findSiteMediaSlot\(c\.req\.param\('slot'\)\);\s*if \(!slot\) throw notFound/, 'the allow-list is checked first');
  assert.match(route, /const photo = slot\.group === 'home';/);
  assert.match(route, /if \(photo && kind && kind\.mime !== SITE_MEDIA_MIME && isConvertibleToWebp\(kind\.mime\)\)/);
  assert.match(route, /if \(!kind \|\| kind\.mime !== SITE_MEDIA_MIME\)/, 'what is stored is always WebP');
});

// --------------------------------------------------- light / dark resolution

test('the current theme’s picture; one picture for both themes; none → the automatic photograph', () => {
  const both = media({ 'home-hero-light': 'home-hero-light-a.webp', 'home-hero-dark': 'home-hero-dark-b.webp' });
  assert.deepEqual(ownerPhoto(both, 'hero'), {
    image: '/files/UiUx/MainPage/home-hero-dark-b.webp',
    lightImage: '/files/UiUx/MainPage/home-hero-light-a.webp',
  });
  const onlyLight = media({ 'home-hero-light': 'home-hero-light-a.webp' });
  assert.deepEqual(ownerPhoto(onlyLight, 'hero'), {
    image: '/files/UiUx/MainPage/home-hero-light-a.webp',
    lightImage: '/files/UiUx/MainPage/home-hero-light-a.webp',
  }, 'the light one serves the dark theme too');
  const onlyDark = media({ 'home-hero-dark': 'home-hero-dark-b.webp' });
  assert.deepEqual(ownerPhoto(onlyDark, 'hero'), { image: '/files/UiUx/MainPage/home-hero-dark-b.webp', lightImage: '' },
    'lightImage empty → themedImage shows the dark one on the light theme');
  assert.equal(ownerPhoto(media({}), 'hero'), null);
});

test('a square’s pair outranks the section cover and the borrowed product photograph', () => {
  const tree = [node('cat_printers', 'printers', [], '/files/UiUx/MainPage/catalog-printers.webp')];
  const pool = [product({ id: 'h2s', category_id: 'cat_printers', direct_stock_available: 1 })];
  const siteMedia = media({ 'home-bento-large-light': 'home-bento-large-light-x.webp' });
  const [tile] = resolveBento(tree, pool, [], siteMedia);
  assert.equal(tile.position, 'large');
  assert.equal(tile.image, '/files/UiUx/MainPage/home-bento-large-light-x.webp');
  assert.equal(tile.lightImage, '/files/UiUx/MainPage/home-bento-large-light-x.webp');
  assert.equal(tile.imageProductId, null, 'shown whole, never cropped as a catalogue photo');
});

test('an editorial pair outranks the old single banner image, which still outranks a product photo', () => {
  const pickText = () => '';
  const common = { ownerBanners: [], lang: 'ar', pickText, tree: TREE, pool: [], avoid: new Set<string>() };
  const legacy = media({ 'banner-1': 'banner-1-old.webp' });
  assert.equal(resolveEditorial({ ...common, siteMedia: legacy })[0].image, '/files/UiUx/MainPage/banner-1-old.webp');
  const pair = media({ 'banner-1': 'banner-1-old.webp', 'home-editorial-multicolor-dark': 'home-editorial-multicolor-dark-n.webp' });
  const [card] = resolveEditorial({ ...common, siteMedia: pair });
  assert.equal(card.image, '/files/UiUx/MainPage/home-editorial-multicolor-dark-n.webp');
  assert.equal(card.productPhoto, false);
});

test('the hero’s picture: the owner’s pair, else a featured printer, else none', () => {
  const pool = [
    product({ id: 'p1', category_id: 'cat_printers', direct_stock_available: 3 }),
    product({ id: 'p2', slug: 'bambu-h2s', category_id: 'cat_printers', direct_stock_available: 1, is_featured: true }),
    product({ id: 'pla', category_id: 'cat_materials' }),
  ];
  const auto = resolveHeroVisual({ siteMedia: media({}), tree: TREE, pool });
  assert.equal(auto?.productPhoto, true);
  assert.equal(auto?.to, '/product/bambu-h2s', 'the featured printer, linked to its page');
  const own = resolveHeroVisual({ siteMedia: media({ 'home-hero-dark': 'home-hero-dark-z.webp' }), tree: TREE, pool });
  assert.deepEqual([own?.image, own?.productPhoto, own?.to], ['/files/UiUx/MainPage/home-hero-dark-z.webp', false, '']);
  assert.equal(resolveHeroVisual({ siteMedia: [], tree: TREE, pool: [] }), null);
});

// ------------------------------------------------------- the bento squares

test('an assignment puts the owner’s section in the square, with their title and the category page link', () => {
  const pool = [product({ id: 'pla', category_id: 'cat_materials', sub_category_id: 'cat_materials_fdm' })];
  const tiles = resolveBento(TREE, pool, [], [], {
    large: { category: 'cat_materials_fdm', title: { ar: 'خيوط', en: 'Filament', ckb: '' } },
  });
  const large = tiles.find((t) => t.position === 'large')!;
  assert.equal(large.category?.id, 'cat_materials_fdm');
  assert.equal(large.to, '/categories/printing-materials/fdm-materials', 'via categoryHref');
  assert.deepEqual(large.title, { ar: 'خيوط', en: 'Filament', ckb: '' });
  // The automatic square that would have shown the same section skips it.
  assert.ok(!tiles.some((t) => t.position === 'top-1'), 'no second tile for the same section');
});

test('a partial assignment falls back per square; an unstocked or unknown section hides only its square', () => {
  const graded = product({ id: 'used-a1', category_id: 'cat_printers' });
  const tiles = resolveBento(TREE, [], [graded], [], {
    'top-2': { category: 'cat_makers_tools', title: { ar: '', en: '', ckb: '' } },
    'bottom-1': { category: 'cat_not_stocked', title: { ar: '', en: '', ckb: '' } },
    large: { category: 'used', title: { ar: '', en: '', ckb: '' } },
  });
  assert.deepEqual(tiles.map((t) => [t.position, t.id, t.to]), [
    ['large', 'used', '/used-printers'],
    ['top-1', 'filament', '/categories/printing-materials/fdm-materials'],
    ['top-2', 'accessories', '/categories/makers-supply/maker-tools'],
  ]);
  const by = new Map(tiles.map((t) => [t.position, t]));
  assert.equal(by.get('large')?.to, '/used-printers', 'the graded shelf can be assigned');
  assert.equal(by.get('top-1')?.category?.id, 'cat_materials_fdm', 'unassigned → the automatic section');
  assert.equal(by.get('top-2')?.category?.id, 'cat_makers_tools', 'assigned');
  assert.equal(by.has('bottom-1'), false, 'an assigned section with no products is not drawn — no empty tile');
  assert.equal(by.get('bottom-2')?.category?.id, undefined, 'accessories is already shown in top-2, so its default square stays empty');
  assert.equal(by.has('bottom-3'), false, 'the graded shelf is already in the large square');
  assert.equal(by.get('large')?.imageProductId, 'used-a1');
});

test('with no assignment the squares are exactly the automatic bento', () => {
  const tiles = resolveBento(TREE, [], []);
  assert.deepEqual(tiles.map((t) => [t.position, t.id]), [
    ['large', 'printers'],
    ['top-1', 'filament'],
    ['bottom-1', 'parts'],
    ['bottom-2', 'accessories'],
  ]);
  assert.deepEqual(resolveBento(TREE, [], [], [], null).map((t) => t.position), tiles.map((t) => t.position));
});

test('the server refuses an unknown square and an unknown section, and keeps a valid assignment', async () => {
  const known = async (id: string) => ['cat_printers', 'cat_materials_fdm'].includes(id);
  const bad1 = await validateHomeBento({ middle: { category: 'cat_printers' } }, known);
  assert.equal(bad1.ok, false);
  assert.equal(!bad1.ok && bad1.refusal.code, 'BENTO_UNKNOWN_POSITION');
  const bad2 = await validateHomeBento({ large: { category: 'cat_gone' } }, known);
  assert.equal(!bad2.ok && bad2.refusal.code, 'BENTO_UNKNOWN_CATEGORY');
  const bad3 = await validateHomeBento({ large: { category: "x' OR 1=1 --" } }, known);
  assert.equal(!bad3.ok && bad3.refusal.code, 'BENTO_BAD_CATEGORY', 'a malformed id never reaches the lookup');
  const bad4 = await validateHomeBento(['large'], known);
  assert.equal(bad4.ok, false);
  const good = await validateHomeBento(
    { large: { category: 'used', title: { ar: 'مستعمل', en: 'Used', ckb: '', extra: 'x' } }, 'top-1': { category: 'cat_materials_fdm' } },
    known
  );
  assert.ok(good.ok);
  assert.deepEqual(good.ok && good.value, {
    large: { category: 'used', title: { ar: 'مستعمل', en: 'Used', ckb: '' } },
    'top-1': { category: 'cat_materials_fdm', title: { ar: '', en: '', ckb: '' } },
  });
  assert.deepEqual([...BENTO_POSITIONS], ['large', 'top-1', 'top-2', 'bottom-1', 'bottom-2', 'bottom-3']);
  assert.deepEqual(normalizeHomeBento({ nope: { category: 'a' }, large: { category: 5 } }), {}, 'read side drops junk');
});

test('the assignment is a public setting, validated on write, and its sections survive the tree caps', () => {
  const settings = read('worker/lib/settings.ts');
  assert.match(settings, /homeBento: \{\} as HomeBento,/);
  assert.match(settings, /\n {2}'homeBento',\n/, 'public: the storefront draws the bento from it');
  const admin = read('worker/routes/admin.ts');
  assert.match(admin, /key === 'homeBento'[\s\S]{0,200}validateHomeBento\(value,/);
  assert.match(admin, /SELECT 1 AS ok FROM catalogs WHERE id = \? AND active = 1/);
  assert.match(read('worker/routes/products.ts'), /homeCategoryTree\(c\.env\.DB, \{\s*keep:/);
});

// ------------------------------------------------------- the section list

/** The live shop's stored list on 2026-09-26, verbatim in shape. */
const LIVE_STORED = [
  { id: 'ads_panel', isVisible: true },
  { id: 'first_banner', isVisible: true },
  { id: 'second_banner', isVisible: false },
  { id: 'coupons_offers', isVisible: false },
  { id: 'categories', isVisible: true },
  { id: 'discounts_offers', isVisible: false },
  { id: 'top_brands', isVisible: true },
  { id: 'open_box', isVisible: true },
  { id: 'best_sellers', isVisible: true },
  { id: 'flash_deals', isVisible: false },
  { id: 'filament', isVisible: true },
];

test('the admin list is the page’s sections: hero and ticker pinned first, the rest movable', () => {
  assert.deepEqual(HOME_SECTIONS.map((s) => s.id), [
    'hero', 'ads_panel', 'categories', 'printer_finder', 'latest_products', 'editorial_banners', 'services',
  ]);
  assert.deepEqual(HOME_SECTIONS.filter((s) => s.pinned).map((s) => s.id), ['hero', 'ads_panel']);
});

test('an old stored list maps onto the current sections without losing a hide choice', () => {
  const rows = normalizeHomeSections([...LIVE_STORED, { id: 'ads_panel', isVisible: false }, { id: 'editorial_banners', isVisible: false }]);
  assert.deepEqual(rows.map((r) => r.id), [
    'hero', 'ads_panel', 'categories', 'editorial_banners', 'printer_finder', 'latest_products', 'services',
  ], 'pinned first; the stored order for what was stored; new sections appended');
  assert.equal(rows.find((r) => r.id === 'editorial_banners')?.isVisible, false, 'a hidden section stays hidden');
  assert.equal(rows.find((r) => r.id === 'ads_panel')?.isVisible, true, 'the first entry for an id wins');
  assert.equal(rows.find((r) => r.id === 'printer_finder')?.isVisible, true, 'a never-saved section is shown');
  assert.equal(slideGroupVisible(LIVE_STORED, 'second_banner'), false, 'a hidden slide group stays hidden');
  assert.equal(slideGroupVisible(LIVE_STORED, 'first_banner'), true);
  assert.equal(slideGroupVisible([], 'first_banner'), true);
});

test('saving writes the current sections and the slide-group switches, and drops retired ids', () => {
  const rows = normalizeHomeSections(LIVE_STORED);
  const saved = serializeHomeSections(rows, { first_banner: true, second_banner: false });
  const ids = saved.map((s) => s.id);
  assert.deepEqual(ids, [...HOME_SECTIONS.map((s) => s.id), 'first_banner', 'second_banner']);
  for (const retired of ['coupons_offers', 'discounts_offers', 'top_brands', 'open_box', 'best_sellers', 'flash_deals', 'filament']) {
    assert.ok(!ids.includes(retired), `${retired} controls nothing on the page and is not written back`);
  }
  assert.equal(saved.find((s) => s.id === 'second_banner')?.isVisible, false);
  // Round trip: what is saved reads back as the same thing.
  assert.deepEqual(normalizeHomeSections(saved), rows);
  assert.equal(slideGroupVisible(saved, 'second_banner'), false);
});

test('the admin panel has no editor left for a section the page does not draw', () => {
  const admin = read('src/components/AdminHomeSettings.tsx');
  for (const gone of ['coupons_offers', 'discounts_offers', 'top_brands', 'best_sellers', 'flash_deals', 'spotlight', 'combos']) {
    assert.doesNotMatch(admin, new RegExp(`'${gone}'`), `${gone} is still in the admin panel`);
  }
  assert.doesNotMatch(admin, /GenericSectionSettings|INITIAL_SECTIONS|DATA_DRIVEN_SECTIONS/);
  assert.match(admin, /HOME_SECTIONS\.map\(\(section\) => tabButton\(section\.id/, 'one tab per live section');
  for (const id of ['hero', 'ads_panel', 'categories', 'editorial_banners', 'printer_finder', 'latest_products', 'services']) {
    assert.match(admin, new RegExp(`activeTab === '${id}' && \\(`), `the ${id} tab renders a panel — its gear button works`);
  }
  assert.match(admin, /<HomePhotoPairs/, 'the light/dark picture pairs are in the pictures tab');
  assert.match(admin, /api\.put\('\/api\/admin\/settings\/homeBento'/, 'the squares are saved');
});

// ------------------------------------------------------- the pictures, drawn

test('the bento tiles and the banners are full-bleed: picture everywhere, light words on a dark scrim', () => {
  const promo = read('src/components/home/v2/PromoPhoto.tsx');
  assert.match(promo, /const ground = !bleed && crop/, 'a bled picture is never framed as a window');
  for (const f of ['src/components/home/v2/CategoryBento.tsx', 'src/components/home/v2/EditorialBanners.tsx']) {
    const src = read(f);
    assert.match(src, /bleed\s/, `${f}: the photograph bleeds`);
    assert.match(src, /className="inset-0"/, `${f}: over the whole surface`);
    assert.match(src, /lv-bleed-scrim/, `${f}: under a scrim`);
    assert.match(src, /text-snow/, `${f}: light words in both themes`);
    assert.doesNotMatch(src, /text-ivory/, `${f}: ivory flips to ink on the light theme`);
  }
  const css = read('src/index.css');
  assert.match(css, /\.lv-bleed-scrim \{\s*background-image:\s*linear-gradient\(to top, rgb\(8 9 11/, 'the scrim is dark, not a theme role');
  assert.doesNotMatch(css, /\.lv-bento-wide-photo|\.lv-fade-corner/, 'the old label-beside-photo zones are gone');
});

test('the hero: roomy Arabic leading, a picture on the far side, its own panel in both themes', () => {
  const hero = read('src/components/home/Hero.tsx');
  const title = hero.match(/data-hero-title\s+className="([^"]+)"/g)?.pop() ?? '';
  assert.match(title, /leading-\[1\.4\]/, 'at 1.1 the two Arabic lines touched');
  assert.doesNotMatch(title, /leading-\[1\.1\]|leading-tight/);
  assert.match(hero, /md:grid-cols-\[minmax\(0,1\.08fr\)_minmax\(0,1fr\)\]/, 'text on the reading side, picture on the other');
  assert.match(hero, /\{visual \? <HeroPicture visual=\{visual\} \/> : null\}/);
  const css = read('src/index.css');
  assert.match(css, /\[data-theme='light'\] \.lv-hero-panel \{[^}]*border-color: rgb\(58 46 28/, 'a hairline on the cream theme');
  assert.match(css, /\[data-theme='light'\] \.lv-hero-panel \{[^}]*box-shadow/, 'and a soft lift');
});
