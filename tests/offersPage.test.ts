/**
 * «العروض» — THE STORE-WIDE OFFERS PAGE (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md §16.6).
 *
 *   - `/offers` is a public route, lazy like its neighbours, reported to the pixel like /products, in the
 *     sitemap, the guest e2e walk and the theme shots;
 *   - THE WAY IN: the home rail «أحدث المنتجات» grows an «العروض» chip while the page holds a live sale,
 *     and its «عرض الكل» then opens /offers; no sale, no chip (the retired «عروض سريعة» board points
 *     there too — it opened /products?type=discounted, which that page ignores);
 *   - the page reads `GET /api/products?type=offers` (the SQL-narrowed listing,
 *     tests/offerOccasionSurfaces.test.ts) and nothing else, pages it, and keeps its snapshot per occasion;
 *   - rendered from that snapshot: «الكل» and one chip per occasion on today's sales, each a link drawn in
 *     its occasion's design with its count; the chosen one pressed; the shop's compact cards with their
 *     tags; an occasion with no sale says so and links back to every deal; the count's noun agrees with
 *     its number; «رجوع» from a shared link goes home;
 *   - every word in Arabic, English and Sorani, the Sorani its own.
 *
 * Run: node --import tsx --test tests/offersPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import Offers from '../src/pages/Offers';
import ProductCard from '../src/components/home/ProductCard';
import LatestProducts, { latestSeeAll } from '../src/components/home/v2/LatestProducts';
import type { LatestChip } from '../src/lib/homeLayout';
import { clearPageCache, writePageCache } from '../src/lib/pageCache';
import { isMetaPixelPath } from '../src/lib/metaPixel';
import { isMetaReportedPath } from '../worker/lib/metaCapi';
import type { ApiProduct } from '../src/lib/api';

const read = (p: string) => readFileSync(p, 'utf8');

let LANG = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => {},
  removeItem: () => {},
};

function render(el: ReactElement, url: string, lang: 'ar' | 'en' | 'ckb' = 'ar'): string {
  LANG = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: false,
        user: null,
        login: async () => {},
        loginWithGoogle: async () => 'ok' as const,
        register: async () => {},
        refreshUser: async () => {},
        adoptSession: async () => 'ok' as const,
        logout: async () => {},
        isLoaded: true,
      },
      children: createElement(WalletProvider, {
        children: createElement(CurrencyProvider, {
          children: createElement(LanguageProvider, { children: createElement(MemoryRouter, { initialEntries: [url] }, el) }),
        }),
      }),
    })
  );
}

const page = (url: string, lang: 'ar' | 'en' | 'ckb' = 'ar') => render(createElement(Offers), url, lang);

const card = (id: string, badge?: string): ApiProduct =>
  ({
    id,
    slug: id,
    name: `Bambu Lab ${id}`,
    price_status: 'priced',
    price_iqd: 750_000,
    display_price_iqd: 750_000,
    display_regular_iqd: 750_000,
    display_offer_before_iqd: 900_000,
    display_offer_saving_percent: 17,
    display_applied_tier: 'regular',
    display_prime_iqd: null,
    display_pro_iqd: null,
    display_from: false,
    offer: { offer_id: `ofw_${id}`, required_tiers: [], starts_at: null, ends_at: '2099-01-01T00:00:00.000Z', schedule_state: 'live', price_source: 'offer', priced: true, locked: false, ...(badge ? { badge } : {}) },
  }) as unknown as ApiProduct;

/* ------------------------------------------------------------- the wiring -- */

test('the route: public, lazy, reported like /products, in the sitemap, the guest walk and the theme shots', () => {
  const app = read('src/App.tsx');
  assert.match(app, /const Offers = React\.lazy\(\(\) => import\('\.\/pages\/Offers'\)\);/);
  assert.match(app, /<Route path="\/offers" element=\{<Offers \/>\} \/>/, 'open to guests: no ProtectedRoute');
  // The retired «عروض سريعة» board (not on Home V2: `flash_deals` is a retired section) points there too.
  assert.match(read('src/lib/homeSections.ts'), /'flash_deals',/);
  assert.match(read('src/components/home/FlashDealsBoard.tsx'), /<SectionHeader title=\{t\('homeFlashDeals'\)\} accent="bg-rose-500" to="\/offers" \/>/);
  assert.doesNotMatch(read('src/components/home/FlashDealsBoard.tsx'), /to="\/products\?type=discounted"/);
  for (const path of ['/offers', '/offers/']) {
    assert.ok(isMetaPixelPath(path), `${path}: a product list, reported like /products`);
    assert.equal(isMetaReportedPath(path), isMetaPixelPath(path), `${path}: the server reports what the browser does`);
  }
  assert.ok(!isMetaPixelPath('/offers/anything'));
  assert.match(read('worker/routes/seo.ts'), /'\/products',\s*'\/offers',/);
  assert.match(read('scripts/e2e-guest.mjs'), /\{ path: '\/offers', name: 'the deals' \}/);
  assert.match(read('scripts/e2e-theme-shots.mjs'), /\{ name: 'offers', path: '\/offers', wait: '\[data-offers-page\]', full: false \}/);
});

/* ------------------------------------------------------------ the way in -- */

const ALL: LatestChip = { id: 'all', categoryIds: [], memberIds: new Set<string>() };
const PRINTERS: LatestChip = { id: 'printers', categoryIds: ['cat_printers'], memberIds: new Set(['cat_printers']) };
/** A card as /api/home answers it, on sale (its own «from» lowered) or not. */
const homeCard = (id: string, onSale: boolean): ApiProduct =>
  ({ ...card(id), category_id: 'cat_printers', ...(onSale ? {} : { offer: null, display_offer_before_iqd: null, display_offer_saving_percent: null }) }) as unknown as ApiProduct;

test('the home rail is the way in: an «العروض» chip while the page holds a live sale, and its «عرض الكل» opens /offers', () => {
  const rail = (latest: ApiProduct[], pool: ApiProduct[] = [], lang: 'ar' | 'en' | 'ckb' = 'ar') =>
    render(createElement(LatestProducts, { latest, pool, chips: [ALL, PRINTERS] }), '/', lang);
  // A sale on the page (in the newest list or in the shelves' pool): the chip, after the sections.
  const withSale = rail([homeCard('p1', false)], [homeCard('p2', true)]);
  assert.match(withSale, /data-latest-chip="all"[\s\S]*data-latest-chip="printers"[\s\S]*data-latest-chip="offers"/);
  assert.match(withSale, /data-latest-chip="offers"[^>]*>[\s\S]*?العروض/);
  assert.match(rail([homeCard('p1', true)], [], 'en'), /data-latest-chip="offers"[^>]*>[\s\S]*?Deals/);
  assert.match(rail([homeCard('p1', true)], [], 'ckb'), /data-latest-chip="offers"[^>]*>[\s\S]*?ئۆفەرەکان/);
  // No sale anywhere on the page: no chip — the rail never promises a sale the shop does not have.
  assert.doesNotMatch(rail([homeCard('p1', false)], [homeCard('p2', false)]), /data-latest-chip="offers"/);
  // «عرض الكل» follows the chip: /offers for «العروض», a section's own list, else every product.
  assert.equal(latestSeeAll({ id: 'offers', categoryIds: [] }), '/offers');
  assert.equal(latestSeeAll(PRINTERS), '/products?category=cat_printers');
  assert.equal(latestSeeAll(ALL), '/products');
  const src = read('src/components/home/v2/LatestProducts.tsx');
  assert.match(src, /<SectionHead id="home-latest-title" title=\{loc\('أحدث المنتجات', 'Latest products'\)\} to=\{latestSeeAll\(chip\)\} \/>/);
  assert.match(src, /\['\/api\/products\?type=offers&limit=20'\]/, 'the chip asks the sales list itself, once');
  assert.match(src, /const onSale = \(p: ApiProduct\) => p\.offer\?\.price_source === 'offer';/, 'the rule of /offers: the card’s own «from» lowered');
});

test('«رجوع» from a shared link goes home, never out of the shop', () => {
  const src = read('src/pages/Offers.tsx');
  assert.match(src, /const goBack = useGoBack\('\/'\);/);
  assert.match(src, /onClick=\{goBack\}/);
  assert.doesNotMatch(src, /navigate\(-1\)/, 'a fresh tab has no entry of the shop’s to go back to');
});

test('the page reads the SQL-narrowed listing alone, pages it, and keys its snapshot by occasion', () => {
  const src = read('src/pages/Offers.tsx');
  assert.match(src, /new URLSearchParams\(\{ type: 'offers', limit: String\(PAGE\) \}\)/);
  assert.match(src, /qs\.set\('occasion', occasion\)/);
  assert.match(src, /api\.get<ProductsListResponse>\(`\/api\/products\?\$\{qs\.toString\(\)\}`\)/);
  assert.equal((src.match(/api\.get</g) ?? []).length, 1, 'one door, nothing else');
  assert.match(src, /`offers:\$\{occasion\}`/);
  assert.match(src, /fetchPage\(products\.length\)/, '«عرض المزيد» asks for the next page at the server’s offset');
  assert.match(src, /useFreshOnReturn\(load/, 'a sale ends on its own clock: coming back asks again');
});

/* ---------------------------------------------------------------- the page -- */

/** The cards load their occasion tag as its own chunk (ProductCard): one draw starts it, the next shows it. */
async function tagLanded() {
  const drawn = () => render(createElement(ProductCard, { p: card('p0', 'black_friday'), density: 'compact' }), '/offers').includes('data-occasion="black_friday"');
  for (let i = 0; i < 100 && !drawn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(drawn(), 'the occasion chunk landed');
}

test('rendered: «الكل» and a chip per occasion in its own design with its count; the chosen one pressed; the cards wear their tags', async () => {
  await tagLanded();
  clearPageCache();
  writePageCache('offers:', {
    products: [card('p1', 'black_friday'), card('p2'), card('p3', 'ramadan')],
    occasions: [{ key: 'black_friday', count: 1 }, { key: 'ramadan', count: 1 }],
    total: 3,
    hasMore: true,
  });
  const html = page('/offers');
  assert.match(html, /data-offers-page/);
  assert.match(html, /<h1[^>]*>العروض<\/h1>/);
  assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/offers"|<a[^>]*href="\/offers"[^>]*aria-current="page"/, '«الكل» is the chosen chip');
  assert.match(html, /href="\/offers\?occasion=black_friday"[^>]*aria-label="بلاك فرايدي \(1\)"|aria-label="بلاك فرايدي \(1\)"[^>]*href="\/offers\?occasion=black_friday"/);
  assert.match(html, /data-offers-occasion="black_friday"[\s\S]*?data-occasion="black_friday" data-occasion-size="picker"/, 'the chip is drawn in its occasion’s design');
  assert.match(html, /data-offers-occasion="ramadan"/);
  assert.match(html, /data-offers-count[^>]*>3 منتجات عليها تخفيض</);
  assert.equal((html.match(/data-product-card="compact"/g) ?? []).length, 3, 'the shop’s compact card, once per product');
  assert.equal((html.match(/data-occasion-size="card"/g) ?? []).length, 2, 'the two labelled sales wear their tags; the third its chip alone');
  assert.match(html, />عرض المزيد</);
  // English and Sorani: the same page in their words.
  const en = page('/offers', 'en');
  assert.match(en, /<h1[^>]*>Deals<\/h1>/);
  assert.match(en, /aria-label="Black Friday \(1\)"/);
  assert.match(en, /3 products on sale/);
  assert.match(page('/offers', 'ckb'), /<h1[^>]*>ئۆفەرەکان<\/h1>/);
});

test('an occasion with no sale says so, by name, and links back to every deal; a stale key reads the plain words', () => {
  clearPageCache();
  writePageCache('offers:white_friday', { products: [], occasions: [{ key: 'black_friday', count: 2 }], total: 0, hasMore: false });
  const html = page('/offers?occasion=white_friday');
  assert.match(html, /لا توجد عروض «الجمعة البيضاء» الآن/);
  assert.match(html, /href="\/offers"[^>]*>كل العروض<|>كل العروض</);
  assert.match(html, /href="\/offers\?occasion=black_friday"/, 'the chips of today’s sales stay');
  assert.match(page('/offers?occasion=white_friday', 'ckb'), /ئێستا هیچ ئۆفەرێکی «هەینیی سپی» نییە/);
  clearPageCache();
  writePageCache('offers:', { products: [], occasions: [], total: 0, hasMore: false });
  const empty = page('/offers');
  assert.match(empty, /لا توجد عروض الآن/);
  assert.match(empty, /href="\/products"/, 'nothing on sale: the way to every product');
  clearPageCache();
});

test('the count: the Arabic noun agrees with its number past a hundred, and one product is one in Sorani', () => {
  const counted = (total: number, lang: 'ar' | 'en' | 'ckb') => {
    clearPageCache();
    writePageCache('offers:', { products: [card('p1')], occasions: [], total, hasMore: total > 1 });
    return /data-offers-count[^>]*>([^<]*)</.exec(page('/offers', lang))?.[1];
  };
  const ar: Array<[number, string]> = [
    [1, 'منتج واحد عليه تخفيض'],
    [2, 'منتجان عليهما تخفيض'],
    [3, '3 منتجات عليها تخفيض'],
    [10, '10 منتجات عليها تخفيض'],
    [11, '11 منتجًا عليها تخفيض'],
    [99, '99 منتجًا عليها تخفيض'],
    [100, '100 منتج عليها تخفيض'],
    [102, '102 منتج عليها تخفيض'],
    [103, '103 منتجات عليها تخفيض'],
    [111, '111 منتجًا عليها تخفيض'],
    [200, '200 منتج عليها تخفيض'],
  ];
  for (const [n, said] of ar) assert.equal(counted(n, 'ar'), said, `ar ${n}`);
  assert.equal(counted(1, 'ckb'), 'یەک بەرهەم داشکاندنی لەسەرە', 'one product: a singular verb');
  assert.equal(counted(5, 'ckb'), '5 بەرهەم داشکاندنیان لەسەرە');
  assert.equal(counted(1, 'en'), '1 product on sale');
  assert.equal(counted(103, 'en'), '103 products on sale');
  clearPageCache();
});

test('every word of the page in three languages, the Sorani its own', () => {
  const src = read('src/pages/Offers.tsx');
  const block = src.slice(src.indexOf('const STRINGS = {'), src.indexOf('} as const;'));
  const keys = [...block.slice(block.indexOf('ar: {'), block.indexOf('en: {')).matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 12);
  for (const lang of ['en', 'ckb']) {
    const part = lang === 'en' ? block.slice(block.indexOf('en: {'), block.indexOf('ckb: {')) : block.slice(block.indexOf('ckb: {'));
    for (const k of keys) assert.match(part, new RegExp(`^\\s{4}${k}:`, 'm'), `${lang}.${k}`);
  }
  const ckb = block.slice(block.indexOf('ckb: {'));
  assert.doesNotMatch(ckb, /[ةىيك]/, 'the Sorani uses no Arabic-only letter');
  assert.doesNotMatch(block.slice(block.indexOf('en: {'), block.indexOf('ckb: {')), /[؀-ۿ]/, 'English is English');
});
