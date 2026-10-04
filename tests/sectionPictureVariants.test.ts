/**
 * A SECTION'S PICTURES, FOR EACH THEME AND EACH SCREEN (owner, 2026-09-28;
 * migration 0149).
 *
 * «في صور الأقسام الفرعية والأقسام الرئيسية اجعل هنالك صورتين أيضا فيما يخص
 * الوضع الداكن والوضع الفاتح وتكون الأبعاد متجاوبة مع جميع الأجهزة … أربع صور
 * اثنين وضع داكن لقياسين اثنين وضع فاتح لقياسين»
 *
 * Every section, main or sub, draws a CARD (the home tile) and a BANNER (the
 * explorer rows, the top of its page), and each is a set of four: dark and
 * light, a large screen and a phone. What this file holds:
 *
 *   - THE RULE for an empty slot (src/lib/catalog/sectionPictures.ts): the
 *     banner's own pictures before the card's; within a set the theme on
 *     screen first, then the screen's size. One picture fills all four.
 *   - THE EIGHT UPLOAD PATHS store in eight columns and reach the admin list,
 *     `/api/catalog/tree` and `/api/home` as URLs, never keys.
 *   - THE DEPLOY WINDOW (code live, 0149 not yet applied): the first screen
 *     still answers, the old slots still work, and a new slot refuses with
 *     SCHEMA_PENDING BEFORE anything is written to R2.
 *   - ONE FILE DOWNLOADED: the renderers choose the theme in script and the
 *     screen with `<source media>`.
 *
 * Run: node --import tsx --test tests/sectionPictureVariants.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PromoPhoto from '../src/components/home/v2/PromoPhoto';
import { variantSrcSet } from '../src/components/ui/SafeImage';
import { APEX, asD1, ctx, dbThrough, freshDb, get, hasColumn, json, row, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { catalogRoutes } from '../worker/routes/catalog';
import { homeRoutes } from '../worker/routes/products';
import { MEDIA_REFERENCE_SOURCES } from '../worker/lib/mediaRefs';
import {
  PHONE_MEDIA,
  bannerSet,
  cardSet,
  pickPicture,
  pickPictureOrigin,
  pictureSources,
  resolvePictures,
  themedFiles,
  type PictureSet,
} from '../src/lib/catalog/sectionPictures';
import { authoredPhoto } from '../src/lib/catalog/explorerModel';
import { resolveBento } from '../src/lib/homeLayout';
import type { HomeTaxon } from '../src/lib/api';

const ADMIN = { id: 'usr_boss', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const IP = { 'CF-Connecting-IP': '1.2.3.4' };

// =========================================================================
// THE RULE
// =========================================================================

const set = (over: Partial<PictureSet> = {}): PictureSet => ({ dark: '', light: '', darkPhone: '', lightPhone: '', ...over });

test('one picture fills all four slots', () => {
  for (const only of ['dark', 'light', 'darkPhone', 'lightPhone'] as const) {
    const r = resolvePictures([set({ [only]: '/one' })]);
    assert.deepEqual(r, { dark: '/one', light: '/one', darkPhone: '/one', lightPhone: '/one' }, only);
  }
  assert.deepEqual(resolvePictures([set()]), set(), 'nothing uploaded — nothing invented');
});

test('within a set: the theme on screen first, then the screen’s size, then the other theme', () => {
  const full = set({ dark: '/d', light: '/l', darkPhone: '/dp', lightPhone: '/lp' });
  assert.equal(pickPicture([full], 'dark', 'large'), '/d');
  assert.equal(pickPicture([full], 'light', 'large'), '/l');
  assert.equal(pickPicture([full], 'dark', 'phone'), '/dp');
  assert.equal(pickPicture([full], 'light', 'phone'), '/lp');

  // A light phone with no light-phone picture: the light LARGE one — the
  // right theme at the wrong size beats the wrong theme at the right size.
  assert.equal(pickPicture([set({ dark: '/d', light: '/l', darkPhone: '/dp' })], 'light', 'phone'), '/l');
  // No light picture at all: the dark one for the same screen.
  assert.equal(pickPicture([set({ dark: '/d', darkPhone: '/dp' })], 'light', 'phone'), '/dp');
  assert.equal(pickPicture([set({ dark: '/d', darkPhone: '/dp' })], 'light', 'large'), '/d');
  // Only phone pictures: a large screen shows the phone one of its theme.
  assert.equal(pickPicture([set({ darkPhone: '/dp', lightPhone: '/lp' })], 'light', 'large'), '/lp');
});

test('a banner uses its own pictures, either theme, before the card’s', () => {
  const banner = set({ light: '/bl' });
  const card = set({ dark: '/cd' });
  // The rule 0142 set and categoriesExplorerModel holds: the other theme's
  // banner before the card stretched across a strip.
  assert.equal(pickPicture([banner, card], 'dark', 'large'), '/bl');
  assert.deepEqual(pickPictureOrigin([banner, card], 'dark', 'phone'), { set: 0, theme: 'light', screen: 'large', file: '/bl' });
  // No banner at all: the card, by the same rule.
  assert.equal(pickPicture([set(), set({ light: '/cl', darkPhone: '/cdp' })], 'dark', 'phone'), '/cdp');
  assert.deepEqual(pickPictureOrigin([set(), set({ light: '/cl' })], 'light', 'phone'), { set: 1, theme: 'light', screen: 'large', file: '/cl' });
  assert.equal(pickPictureOrigin([set(), set()], 'dark', 'large'), null, 'the caller then borrows a product photograph');
});

test('the components get only what differs, and each theme draws the right pair', () => {
  // The four uploaded.
  const four = pictureSources(resolvePictures([set({ dark: '/d', light: '/l', darkPhone: '/dp', lightPhone: '/lp' })]))!;
  assert.deepEqual(four, { src: '/d', lightSrc: '/l', mobileSrc: '/dp', lightMobileSrc: '/lp' });
  assert.deepEqual(themedFiles(four, 'dark'), { large: '/d', phone: '/dp' });
  assert.deepEqual(themedFiles(four, 'light'), { large: '/l', phone: '/lp' });

  // One picture: one file everywhere, no <source> needed.
  const one = pictureSources(resolvePictures([set({ dark: '/d' })]))!;
  assert.deepEqual(one, { src: '/d' });
  assert.deepEqual(themedFiles(one, 'light'), { large: '/d', phone: '/d' });

  // Dark only, both sizes: the light theme shows the dark pair — its PHONE
  // picture on a phone, although the light large picture equals the dark one.
  const darkPair = pictureSources(resolvePictures([set({ dark: '/d', darkPhone: '/dp' })]))!;
  assert.deepEqual(darkPair, { src: '/d', mobileSrc: '/dp', lightMobileSrc: '/dp' });
  assert.deepEqual(themedFiles(darkPair, 'light'), { large: '/d', phone: '/dp' });

  // A product photograph (0138) has no phone picture: the phone draws the large one.
  assert.deepEqual(themedFiles({ src: '/p', lightSrc: '/pl' }, 'light'), { large: '/pl', phone: '/pl' });
  assert.equal(pictureSources(resolvePictures([set()])), null);
});

test('the section’s fields map to the sets, and an older Worker’s answer reads as before', () => {
  const node = {
    image_url: '/c',
    light_image_url: '/cl',
    mobile_image_url: '/cm',
    light_mobile_image_url: '/clm',
    hero_image_url: '/h',
    hero_light_image_url: '/hl',
    hero_mobile_image_url: '/hm',
    hero_light_mobile_image_url: '/hlm',
  };
  assert.deepEqual(cardSet(node), { dark: '/c', light: '/cl', darkPhone: '/cm', lightPhone: '/clm' });
  assert.deepEqual(bannerSet(node), { dark: '/h', light: '/hl', darkPhone: '/hm', lightPhone: '/hlm' });
  assert.deepEqual(authoredPhoto(node), {
    src: '/h',
    lightSrc: '/hl',
    mobileSrc: '/hm',
    lightMobileSrc: '/hlm',
    productPhoto: false,
    productId: null,
  });
  // Before 0149 the Worker sent three fields; the photo is exactly what it was.
  assert.deepEqual(authoredPhoto({ hero_image_url: '/h', hero_light_image_url: '/hl', image_url: '/c' }), {
    src: '/h',
    lightSrc: '/hl',
    productPhoto: false,
    productId: null,
  });
});

test('the home tile takes the section’s card set — both themes, both sizes', () => {
  const tree: HomeTaxon[] = [
    {
      id: 'cat_printers',
      slug: 'printers',
      name_ar: 'الطابعات',
      name_en: 'Printers',
      name_ckb: '',
      product_count: 3,
      image_url: '/files/c.webp',
      light_image_url: '/files/cl.webp',
      mobile_image_url: '/files/cm.webp',
      light_mobile_image_url: '',
      children: [],
    },
  ];
  const [tile] = resolveBento(tree, [], []);
  assert.equal(tile.image, '/files/c.webp');
  assert.equal(tile.lightImage, '/files/cl.webp');
  assert.equal(tile.mobileImage, '/files/cm.webp');
  // No light phone picture: the light LARGE one (theme first) — which is
  // already `lightImage`, so nothing extra travels.
  assert.equal(tile.lightMobileImage, '');
  assert.equal(tile.imageProductId, null, 'an authored picture is shown whole, never cropped');

  // An older answer with the cover only: exactly the tile it was.
  const [old] = resolveBento([{ ...tree[0], light_image_url: undefined, mobile_image_url: undefined }], [], []);
  assert.deepEqual([old.image, old.lightImage, old.mobileImage, old.lightMobileImage], ['/files/c.webp', '', '', '']);
});

// =========================================================================
// THE EIGHT UPLOAD PATHS
// =========================================================================

class Bucket {
  readonly puts = new Map<string, number>();
  async head(key: string) { return this.puts.has(key) ? ({ key } as unknown) : null; }
  async get(key: string) { return this.puts.has(key) ? ({ key } as unknown) : null; }
  async put(key: string, value: ArrayBufferView) { this.puts.set(key, (value as Uint8Array).byteLength); }
  async delete(key: string) { this.puts.delete(key); }
}

function webp(width = 1200, height = 900, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return b;
}

function setup(raw = freshDb()) {
  seedLiveCatalog(raw);
  const db = asD1(raw);
  const bucket = new Bucket();
  const env = { DB: db, BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket };
  const admin = stubApp(db as never, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes), { host: APEX, env });
  const catalog = stubApp(db as never, null, (a) => a.route('/api/catalog', catalogRoutes));
  const home = stubApp(db as never, null, (a) => a.route('/api/home', homeRoutes), { host: APEX, env: { DB: db } });
  return { raw, admin, catalog, home, bucket };
}

const upload = (app: ReturnType<typeof setup>['admin'], id: string, segment: string, bytes = webp()) => {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], 'picture.webp'));
  return app.request(`/api/admin/taxonomy/catalogs/${id}/${segment}`, { method: 'POST', body: form, headers: IP }, undefined, ctx);
};

/** segment → [column, the URL field it answers with] — worker/routes/adminTaxonomy.ts CATALOG_PICTURES. */
const NEW_SLOTS = [
  ['image-light', 'light_image_key', 'light_image_url'],
  ['image-mobile', 'mobile_image_key', 'mobile_image_url'],
  ['image-light-mobile', 'light_mobile_image_key', 'light_mobile_image_url'],
  ['hero-mobile-image', 'hero_mobile_image_key', 'hero_mobile_image_url'],
  ['hero-light-mobile-image', 'hero_light_mobile_image_key', 'hero_light_mobile_image_url'],
] as const;

/** A sub-section the live catalogue stocks, so it is on the home page too. */
const SUB = 'cat_printers_fdm';

test('each new slot stores in its own column and reaches the admin, the tree and the home page as a URL', async () => {
  const { raw, admin, catalog, home, bucket } = setup();
  const urls: Record<string, string> = {};
  for (const [segment, column, field] of NEW_SLOTS) {
    const res = await upload(admin, SUB, segment);
    assert.equal(res.status, 200, `${segment}: ${await res.clone().text()}`);
    const body = await json(res);
    const key = String(body[column]);
    assert.match(key, /^UiUx\/MainPage\/catalog-catprintersfdm-[a-z0-9]{16}\.webp$/, segment);
    assert.ok(bucket.puts.has(key), `${segment}: in R2 before the pointer moved`);
    assert.equal(body[field], `/files/${key}`);
    assert.equal(row<{ k: string }>(raw, `SELECT ${column} AS k FROM catalogs WHERE id = ?`, SUB)!.k, key);
    urls[field] = body[field];
  }
  assert.equal(new Set(Object.values(urls)).size, NEW_SLOTS.length, 'five pictures, five objects');
  assert.equal(row<{ k: string }>(raw, 'SELECT image_key AS k FROM catalogs WHERE id = ?', SUB)!.k, '', 'the large dark card is untouched');

  const list = await json(await get(admin, '/api/admin/taxonomy/catalogs'));
  const mine = list.catalogs.find((c: { id: string }) => c.id === SUB);
  for (const [, , field] of NEW_SLOTS) assert.equal(mine[field], urls[field], `admin list: ${field}`);
  assert.equal(mine.picture_variants, true);

  const tree = await json(await get(catalog, '/api/catalog/tree'));
  const node = tree.roots.find((r: { id: string }) => r.id === 'cat_printers').children.find((c: { id: string }) => c.id === SUB);
  for (const [, column, field] of NEW_SLOTS) {
    assert.equal(node[field], urls[field], `tree: ${field}`);
    assert.equal(column in node, false, 'the raw key never leaves the worker');
  }

  const first = await json(await home.request('/api/home', { headers: IP }, undefined, ctx));
  const sub = (first.categories as Array<{ id: string; children?: Array<Record<string, unknown>> }>)
    .find((c) => c.id === 'cat_printers')!
    .children!.find((c) => c.id === SUB)!;
  for (const field of ['light_image_url', 'mobile_image_url', 'light_mobile_image_url']) assert.equal(sub[field], urls[field], `home: ${field}`);
  for (const key of ['light_image_key', 'mobile_image_key', 'light_mobile_image_key']) assert.equal(key in sub, false);
});

test('clearing one slot clears that slot only; the object stays for the sweeper', async () => {
  const { raw, admin, bucket } = setup();
  const phone = await json(await upload(admin, SUB, 'image-mobile'));
  await upload(admin, SUB, 'image-light');
  const del = await admin.request(`/api/admin/taxonomy/catalogs/${SUB}/image-mobile`, { method: 'DELETE', headers: IP }, undefined, ctx);
  assert.equal(del.status, 200);
  assert.deepEqual(await json(del), { success: true, mobile_image_key: '', mobile_image_url: '' });
  const r = row<{ m: string; l: string }>(raw, 'SELECT mobile_image_key AS m, light_image_key AS l FROM catalogs WHERE id = ?', SUB)!;
  assert.equal(r.m, '');
  assert.notEqual(r.l, '', 'the light picture is kept');
  assert.ok(bucket.puts.has(String(phone.mobile_image_key)));
});

test('every new slot is WebP only and admins only', async () => {
  const { admin } = setup();
  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (const [segment] of NEW_SLOTS) {
    const res = await upload(admin, SUB, segment, png);
    assert.equal(res.status, 400, segment);
    assert.equal((await json(res)).code, 'SITE_MEDIA_NOT_WEBP');
  }
  const raw = freshDb();
  seedLiveCatalog(raw);
  const db = asD1(raw);
  const shopper = stubApp(db as never, { id: 'usr_x', role: 'customer', email: 'x@x.co', admin_scope: null } as never, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes), { host: APEX, env: { DB: db } });
  const refused = await upload(shopper, SUB, 'image-light-mobile');
  assert.ok(refused.status === 401 || refused.status === 403, String(refused.status));
});

test('the media sweeper knows all five columns, or its first run deletes the pictures', () => {
  for (const [, column] of NEW_SLOTS) {
    assert.ok(
      MEDIA_REFERENCE_SOURCES.some((s) => s.table === 'catalogs' && s.column === column),
      `catalogs.${column} is not registered in worker/lib/mediaRefs.ts`
    );
  }
});

// =========================================================================
// THE DEPLOY WINDOW: THE CODE IS LIVE, 0149 IS NOT
// =========================================================================

test('before 0149: the first screen and the explorer still answer, with the pictures that exist', async () => {
  const raw = dbThrough('0148');
  assert.equal(hasColumn(raw, 'catalogs', 'mobile_image_key'), false, 'the fixture really is one migration behind');
  const { admin, catalog, home } = setup(raw);
  const cover = await upload(admin, SUB, 'image');
  assert.equal(cover.status, 200, 'the slots that exist keep working: ' + (await cover.clone().text()));
  const coverUrl = (await json(cover)).image_url;

  const first = await home.request('/api/home', { headers: IP }, undefined, ctx);
  assert.equal(first.status, 200, 'never a 500 on the first screen');
  const body = await json(first);
  const sub = (body.categories as Array<{ id: string; children?: Array<Record<string, unknown>> }>)
    .find((c) => c.id === 'cat_printers')!
    .children!.find((c) => c.id === SUB)!;
  assert.equal(sub.image_url, coverUrl, 'the cover that exists is still drawn');
  assert.equal(sub.mobile_image_url, '', 'a column that does not exist yet holds nothing — which is what it will hold');

  const tree = await get(catalog, '/api/catalog/tree');
  assert.equal(tree.status, 200);

  const list = await json(await get(admin, '/api/admin/taxonomy/catalogs'));
  const mine = list.catalogs.find((c: { id: string }) => c.id === SUB);
  assert.equal(mine.picture_variants, false, 'the panel offers the large pictures only');
  assert.equal(mine.mobile_image_url, '');
});

test('before 0149: a new slot refuses with SCHEMA_PENDING, before anything is written to R2', async () => {
  const { raw, admin, bucket } = setup(dbThrough('0148'));
  for (const [segment] of NEW_SLOTS) {
    const res = await upload(admin, SUB, segment);
    assert.equal(res.status, 503, segment);
    assert.equal((await json(res)).code, 'SCHEMA_PENDING');
    const del = await admin.request(`/api/admin/taxonomy/catalogs/${SUB}/${segment}`, { method: 'DELETE', headers: IP }, undefined, ctx);
    assert.equal(del.status, 503, `DELETE ${segment}`);
  }
  assert.equal(bucket.puts.size, 0, 'no orphan: nothing was stored for a pointer that could not be written');
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'catalog.%image%'")?.n ?? 0, 0);
});

// =========================================================================
// ONE FILE DOWNLOADED
// =========================================================================

const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('the renderers pick the theme in script and the screen with <source media>', () => {
  assert.equal(PHONE_MEDIA, '(max-width: 639px)', 'below Tailwind’s `sm`, where the banner rows change proportion');
  assert.match(code('src/components/catalog/CategoryRowBanners.tsx'), /aspect-\[15\/4\][^']*sm:aspect-\[7\/1\]/, 'the rows change at `sm`');
  for (const file of ['src/components/catalog/CropPhoto.tsx', 'src/components/home/v2/PromoPhoto.tsx']) {
    const src = code(file);
    assert.match(src, /themedFiles\(\{ src, lightSrc, mobileSrc, lightMobileSrc \}, theme\)/, `${file}: one resolver for the pair`);
    if (file.endsWith('/CropPhoto.tsx')) {
      assert.match(src, /<source media=\{PHONE_MEDIA\} srcSet=\{phone\} \/>/, `${file}: the phone file through <source>`);
    }
    assert.match(src, /phone !== shown \?/, `${file}: no <source> when the phone draws the same file`);
  }
  // Every banner call site passes the phone pictures through.
  for (const file of ['src/components/catalog/CategoryHero.tsx', 'src/components/catalog/CategoryRowBanners.tsx', 'src/components/catalog/RelatedCategories.tsx']) {
    assert.match(code(file), /mobileSrc=\{[^}]*photo\.mobileSrc/, file);
    assert.match(code(file), /lightMobileSrc=\{[^}]*photo\.lightMobileSrc/, file);
  }
  assert.match(code('src/components/home/v2/CategoryBento.tsx'), /mobileSrc=\{tile\.mobileImage\}\s+lightMobileSrc=\{tile\.lightMobileImage\}/);
});

test('the promo phone source keeps its themed file through responsive candidates and original-only fallbacks', () => {
  // useTheme's server snapshot is light. The dark pair must never enter this
  // picture's candidates, and the phone must use its own file, not the lead.
  const props = {
    src: '/files/products/dark.webp', lightSrc: '/files/products/light.webp',
    mobileSrc: '/files/products/phone-dark.webp', lightMobileSrc: '/files/products/phone-light.webp',
    crop: false, className: 'inset-0', width: 560, height: 560,
  };
  const render = (over: Partial<typeof props> & { sizes?: string } = {}) => renderToStaticMarkup(createElement(PromoPhoto, { ...props, ...over }));
  const phone = (html: string) => html.match(/<source[^>]*>/)?.[0] ?? '';
  const responsive = render({ sizes: '400px' });
  assert.equal(phone(responsive), `<source media="${PHONE_MEDIA}" srcSet="${variantSrcSet(props.lightMobileSrc)}" sizes="400px"/>`);
  assert.doesNotMatch(responsive, /phone-dark\.webp|\/dark\.webp/);
  assert.match(responsive, /<img[^>]*src="\/files\/products\/light\.webp"/);
  const original = render();
  assert.equal(phone(original), `<source media="${PHONE_MEDIA}" srcSet="${props.lightMobileSrc}"/>`);
  assert.doesNotMatch(original, /\?w=|sizes=/, 'without a sizing opt-in the original pair stays untouched');
  assert.equal(phone(render({ lightMobileSrc: '/files/products/phone-light.gif', sizes: '400px' })), `<source media="${PHONE_MEDIA}" srcSet="/files/products/phone-light.gif"/>`, 'animated phone pictures retain all frames');
  assert.equal(phone(render({ lightMobileSrc: props.lightSrc, sizes: '400px' })), '', 'the same themed file needs no duplicate source');
});
