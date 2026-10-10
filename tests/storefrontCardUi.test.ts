/**
 * THE SHOPPER-SIDE QUICK WINS, RENDERED (merchant platform V2, P3c: storefront
 * L9 / L10 / L11 / L12) — the real renderer in Node, the inert preview runtime:
 *
 *   - the product card draws a ▶ mark for a product with a video, holds its
 *     second frame as state (no transform, nothing sprung), and carries no
 *     hex or raw red any more (`parts.tsx`);
 *   - the collections `cards` variant draws a cover with the name over the
 *     page's own fade when the merchant set one, and the plain card when not;
 *   - the reviews block draws the four chips as ONE radio group, the pictures
 *     as a four-column strip, and «المزيد» only when a page follows;
 *   - the Products tab carries a labelled search field and the sort group;
 *   - every new word exists in Arabic, English AND Sorani, and the Sorani is
 *     not the Arabic (storefront/strings.ts, community/reviews/strings.ts).
 *
 * Run: node --import tsx --test tests/storefrontCardUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { fixtureStore, renderStore, visibleText } from './fixtures/storefrontRender';
import { emptyBlockData, productQueryKey, type ProductCardData, type ReviewsData } from '../packages/storeLayout/src/data';
import { STOREFRONT_STRINGS } from '../src/components/storefront/strings';
import { REVIEW_FORM_STRINGS } from '../src/components/community/reviews/strings';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function card(id: string, over: Partial<ProductCardData> = {}): ProductCardData {
  return {
    id,
    slug: `raf3d-${id}`,
    name: `Product ${id}`,
    name_ar: `منتج ${id}`,
    images: [`/files/merchants/owner/public/${id}-1.webp`],
    price_iqd: 12000,
    original_price_iqd: null,
    in_stock: true,
    featured: false,
    section_id: null,
    sales_tier: null,
    ...over,
  };
}

const REVIEWS: ReviewsData = {
  average: 4.7,
  count: 3,
  distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 },
  reviews: [
    { id: 'r1', rating: 5, body: 'ممتاز', images: ['/files/merchants/c1/public/a.webp', '/files/merchants/c1/public/b.webp'], verified: true, customer_name: 'Ahmed K.', merchant_reply: null, merchant_replied_at: null, created_at: '2026-09-10T10:00:00.000Z' },
    { id: 'r2', rating: 4, body: 'جيد', images: [], verified: true, customer_name: 'Sara H.', merchant_reply: null, merchant_replied_at: null, created_at: '2026-09-09T10:00:00.000Z' },
  ],
  next_cursor: '2026-09-09T10:00:00.000Z|r2',
};

test('L10: the card marks a video, holds its second frame as state, and carries no hex or raw red', async () => {
  const store = await fixtureStore();
  const data = emptyBlockData();
  data.products[productQueryKey('latest', '')] = {
    items: [card('v1', { has_video: true, image_2: '/files/merchants/owner/public/v1-2.webp' }), card('v2', { original_price_iqd: 15000 })],
    next_cursor: null,
  };
  const html = await renderStore(store, { layout: { schema_version: 1, blocks: [{ type: 'products_grid', settings: { source: 'latest', limit: 8 } }] }, data });
  assert.equal((html.match(/data-card-video/g) ?? []).length, 1, 'one ▶ mark, on the product with a video');
  assert.match(html, /role="img" aria-label="يحتوي على فيديو"/, 'the mark says what it is');
  assert.match(html, /data-card-frame="1"/, 'the first frame renders; the second is a state swap, not a transform');
  assert.doesNotMatch(html, /v1-2\.webp/, 'the second frame is not in the first paint');
  // The count / deal badge is crimson (clay, docs/DECISIONS.md row 209): snow on
  // the danger tone measured 3.15:1 in dark; on crimson it reads 5.62:1 in both.
  assert.match(html, /bg-crimson text-snow/, 'the deal badge is tokens');
  const parts = code('src/components/storefront/parts.tsx');
  assert.doesNotMatch(parts, /#[0-9a-fA-F]{3,8}\b/, 'no hex in the card');
  assert.doesNotMatch(parts, /bg-red-600|text-white"\s*dir="ltr"/, 'no raw red');
  assert.doesNotMatch(parts, /active:scale-\[0\.98\] transition-transform/, 'the press is the house press-scale');
  assert.match(parts, /onPointerEnter=\{\(\) => setPeek\(true\)\}/);
  assert.match(parts, /onFocus=\{\(\) => setPeek\(true\)\}/, 'keyboard focus shows the second frame too');
  assert.doesNotMatch(parts, /useMotion|motion\//, 'a src swap is state, not motion');
});

test('L9: the collections cards draw a cover with the name over the fade when set, and the plain card when not', async () => {
  const store = await fixtureStore();
  const data = emptyBlockData();
  data.collections = [
    { id: 'sec1', name: 'Figures', name_ar: 'مجسمات', product_count: 3, image_url: '/files/merchants/owner/public/cover1.webp' },
    { id: 'sec2', name: 'Spare parts', name_ar: 'قطع غيار', product_count: 2, image_url: null },
  ];
  const html = await renderStore(store, { layout: { schema_version: 1, blocks: [{ type: 'collections', variant: 'cards' }] }, data });
  assert.match(html, /data-collection-cover="sec1"/);
  assert.doesNotMatch(html, /data-collection-cover="sec2"/);
  assert.match(html, /cover1\.webp/);
  assert.match(html, /sf-cover-fade/, 'the page’s own fade under the name');
  assert.ok(visibleText(html).includes('مجسمات') && visibleText(html).includes('قطع غيار'));
  const src = code('src/components/storefront/blocks/Collections.tsx');
  assert.doesNotMatch(src, /style=\{\{/, 'no inline style: the cover is an <img> under sf-media');
});

test('L12: the reviews block draws one radio group of chips, a four-column photo strip, and «المزيد» only when a page follows', async () => {
  const store = await fixtureStore();
  const data = emptyBlockData();
  data.reviews = REVIEWS;
  const layout = { schema_version: 1, blocks: [{ type: 'reviews', settings: { limit: 10 } }] };
  const html = await renderStore(store, { layout, data });
  assert.match(html, /role="radiogroup" aria-label="تصفية التقييمات"/);
  for (const id of ['all', '5', '4', 'photos']) assert.match(html, new RegExp(`data-review-filter="${id}"`), `chip ${id}`);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 4, 'four chips, one group');
  assert.match(html, /aria-checked="true"[^>]*data-review-filter="all"|data-review-filter="all"[^>]*aria-checked="true"/, '«all» is the page that came with the store');
  assert.match(html, /data-review-photos="2"/);
  assert.match(html, /grid grid-cols-4 gap-1 sf-r-sm overflow-hidden/);
  assert.match(html, /alt="صورة 1 من التقييم"/);
  assert.match(html, /data-reviews-more/, 'a cursor follows: «المزيد»');
  assert.ok(visibleText(html).includes('المزيد'));

  const last = { ...REVIEWS, next_cursor: null };
  const data2 = emptyBlockData();
  data2.reviews = last;
  const html2 = await renderStore(store, { layout, data: data2 });
  assert.doesNotMatch(html2, /data-reviews-more/, 'nothing follows: no «المزيد»');
  // The About tab's embed keeps a plain first page.
  const embed = await renderStore(store, { layout: { schema_version: 1, blocks: [{ type: 'tabs', settings: { items: ['about'], about_reviews: true } }] }, data });
  assert.doesNotMatch(embed, /data-review-filter=/, 'no chips in the About embed');
  const reviews = code('src/components/storefront/blocks/Reviews.tsx');
  assert.match(reviews, /rt\.loadReviews\(\{ \.\.\.reviewQueryOf\(filter\), cursor: data\.next_cursor \}\)/, '«المزيد» pages by the server cursor under the same chip');
  assert.match(reviews, /rel="noopener noreferrer"/, 'a photo opens with no handle on the page');
});

test('L11: the Products tab carries a labelled search field and the sort group, debounced, with no new CSS', async () => {
  const store = await fixtureStore();
  const html = await renderStore(store, { layout: { schema_version: 1, blocks: [{ type: 'tabs' }] } });
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="ابحث في منتجات المتجر"/);
  assert.match(html, /placeholder="ابحث في المتجر"/);
  assert.match(html, /maxLength="60"|maxlength="60"/i, 'the field never sends more than the server takes');
  assert.match(html, /role="radiogroup" aria-label="ترتيب المنتجات"/);
  for (const id of ['new', 'price_asc', 'price_desc']) assert.match(html, new RegExp(`data-store-sort="${id}"`));
  const tabs = code('src/components/storefront/blocks/Tabs.tsx');
  assert.match(tabs, /setTimeout\(\(\) => onQuery\(term\), SEARCH_DEBOUNCE_MS\)/, 'debounced');
  assert.match(tabs, /const SEARCH_MAX = 60;/);
  const grid = code('src/components/storefront/blocks/ProductsGrid.tsx');
  assert.match(grid, /\.\.\.\(sort !== 'new' \? \{ sort \} : \{\}\)/, '«new» is never sent: a collection keeps the merchant’s order');
  const page = code('src/pages/Storefront.tsx');
  assert.match(page, /if \(term\) qs\.set\('q', term\.slice\(0, 60\)\);/);
  assert.match(page, /if \(rq\?\.rating\) qs\.set\('rating', String\(rq\.rating\)\);/);
  assert.match(page, /if \(rq\?\.photos\) qs\.set\('photos', '1'\);/);
});

test('every new word exists in ar, en and ckb, and the Sorani is not the Arabic', () => {
  const flat = (o: Record<string, unknown>, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'function') out[`${prefix}${k}`] = String((v as (n: number) => string)(3));
      else if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
      else out[`${prefix}${k}`] = String(v);
    }
    return out;
  };
  for (const [name, table] of [
    ['storefront', STOREFRONT_STRINGS],
    ['review form', REVIEW_FORM_STRINGS],
  ] as const) {
    const ar = flat(table.ar as unknown as Record<string, unknown>);
    const en = flat(table.en as unknown as Record<string, unknown>);
    const ckb = flat(table.ckb as unknown as Record<string, unknown>);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort(), `${name}: en carries every key`);
    assert.deepEqual(Object.keys(ckb).sort(), Object.keys(ar).sort(), `${name}: ckb carries every key`);
    for (const k of Object.keys(ar)) {
      assert.notEqual(ckb[k], ar[k], `${name}: ckb.${k} is the Arabic pasted across`);
      assert.notEqual(en[k], ar[k], `${name}: en.${k} is the Arabic`);
      assert.match(ckb[k], /[؀-ۿ]/, `${name}: ckb.${k} is written in the Sorani script`);
      assert.ok(ckb[k].trim().length > 0 && ar[k].trim().length > 0 && en[k].trim().length > 0, `${name}: ${k} is empty somewhere`);
    }
  }
});
