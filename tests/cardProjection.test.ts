/**
 * A CARD IS NOT A PRODUCT DOCUMENT.
 *
 * `/api/home` returns 30 rows and `/api/products` up to 50, and each one used
 * to be serialized through the FULL public projection — the option ladder,
 * every colour with its four price columns, the spec groups, the usage guide
 * and its per-step media, three languages of description, the warranty plans.
 * A grid that draws a picture, a name and a price was being handed tens of
 * kilobytes per tile.
 *
 * Two things have to stay true for `cardShape` to be safe, and neither is
 * obvious from reading it:
 *
 *   1. It must keep every field the card components actually read. Those
 *      components were enumerated when the list was written; this test is what
 *      stops the list and the components drifting apart afterwards.
 *   2. It must NOT keep the heavy, page-only fields — otherwise it is a
 *      comment rather than a projection.
 *
 * And the number on the card must not move: the price is resolved over the
 * WHOLE document before the projection runs, so narrowing the output cannot
 * change it. The last test pins that directly.
 *
 * A CARD CARRIES ITS PICTURE, NOT THE GALLERY (speed audit 2026-10-16,
 * findings 7 and 21; worker/lib/cardGallery.ts). `media` and `images` used to
 * be copied whole — every gallery entry with seventeen keys — on every card of
 * every list answer, 90 % of the live `/api/products?limit=50` JSON. The
 * second half of this file holds the three things that make trimming them
 * safe: every reader still picks the SAME picture (the storefront card, the
 * category banner, the profile tile, a cached older bundle, the public API's
 * card image with its alt texts), the trimmed card fits a byte budget through
 * the real routes, and the product page's own answer keeps the whole gallery.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { cardShape, homeRoutes, productRoutes } from '../worker/routes/products';
import { catalogRoutes } from '../worker/routes/catalog';
import { CARD_MEDIA_KEYS, cardGallery, cardLeadUrl } from '../worker/lib/cardGallery';
import { cardImage } from '../worker/lib/publicApi/common';
import { urlsForOrigin } from '../worker/lib/publicApi/urls';
import { productMainImage, productPrimaryImage } from '../src/lib/productImage';
import { photoOf } from '../src/lib/catalog/explorerModel';

// ------------------------------------------------------------ galleries

const hex = (i: number) => String(i).padStart(2, '0').repeat(32);
const keyOf = (i: number, prefix = 'products/p1/gallery') => `${prefix}/${hex(i)}.webp`;
const fileUrl = (i: number, prefix?: string) => `/files/${keyOf(i, prefix)}`;

/** A stored gallery entry with every key the public projection publishes (17). */
function entry(i: number, primary: boolean, prefix?: string): Record<string, unknown> {
  return {
    id: `pi_${i}`,
    url: fileUrl(i, prefix),
    key: keyOf(i, prefix),
    role: 'gallery',
    alt_ar: `صورة المنتج رقم ${i} — Bambu Lab PLA Basic`,
    alt_en: `Product picture ${i} — Bambu Lab PLA Basic`,
    alt_ckb: `وێنەی بەرهەم ${i} — Bambu Lab PLA Basic`,
    order: i,
    primary,
    width: 2048,
    height: 2048,
    content_type: 'image/webp',
    bytes: 40_000 + i,
    source_url: '',
    option_value_id: i % 3 === 0 ? `ov_${i}` : '',
    color_id: i % 4 === 0 ? `col_${i}` : '',
    variant_id: i % 5 === 0 ? `pv_${i}` : '',
  };
}

/** `n` entries in stored order, the one at `primaryAt` marked primary (none when -1). */
const gallery = (n: number, primaryAt: number, prefix?: string) =>
  Array.from({ length: n }, (_, i) => entry(i, i === primaryAt, prefix));

/**
 * The gallery as `projectPublic` publishes it: primary first, then by order
 * (worker/lib/productModel.ts `primaryMediaFirst`), and `images` the same URLs
 * in the same order.
 */
function publishedGallery(media: Record<string, unknown>[]) {
  const sorted = [...media].sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || (a.order as number) - (b.order as number));
  return { media: sorted, images: sorted.map((m) => m.url as string) };
}

/**
 * Every field the card surfaces read, gathered from the files themselves, and
 * copied through as it is. (`media` and `images` are read too, and PROJECTED:
 * see the gallery tests below.)
 */
const READ_BY_CARDS = [
  'id',
  'slug',
  'product_slug',
  'name',
  'status',
  'price_iqd',
  'display_price_iqd',
  'display_regular_iqd',
  'display_prime_iqd',
  'display_pro_iqd',
  'display_applied_tier',
  'display_from',
  'direct_stock_available',
  'offer',
];

/** Page-only, and the reason the payload was large. */
const MUST_NOT_SURVIVE = [
  'options',
  'colors',
  'spec_groups',
  'spec_fields',
  'warranty_plans',
  'warranty_base_months',
  'usage_guide',
  'how_to_use',
  'content_blocks',
  'description',
  'description_ar',
  'description_en',
  'description_ckb',
  'description_images',
  'description_videos',
  'labels',
  'delivery_options',
  'payment_options',
  'preorder_transports',
  'specifications',
  'features',
  'shipping_methods',
  'membership_prices',
  'stores',
];

/** A product row as the full projection would emit it. */
const fullRow = (): Record<string, unknown> => ({
  ...Object.fromEntries(READ_BY_CARDS.map((k) => [k, `v:${k}`])),
  ...Object.fromEntries(MUST_NOT_SURVIVE.map((k) => [k, `HEAVY:${k}`])),
  ...publishedGallery(gallery(3, 1)),
  display_plus_iqd: 1,
  sku: 'SKU-1',
  template_family: 'printers-fdm',
  hashtags: ['a', 'b'],
});

test('every field the card components read survives the projection', () => {
  const card = cardShape(fullRow());
  for (const k of READ_BY_CARDS) {
    assert.equal(card[k], `v:${k}`, `cardShape dropped ${k}, which a card renders`);
  }
  assert.equal((card.media as unknown[]).length, 1, 'the card lost its picture entry');
  assert.deepEqual(card.images, [fileUrl(1)], 'the card lost its picture URL');
});

test('the page-only bulk does not survive — this is the whole point of the projection', () => {
  const card = cardShape(fullRow());
  for (const k of MUST_NOT_SURVIVE) {
    assert.equal(k in card, false, `cardShape kept ${k}; the payload is still a product document`);
  }
});

test('a field the projection does not name is dropped, not passed through', () => {
  const card = cardShape({ ...fullRow(), something_new_and_enormous: 'x'.repeat(10_000) });
  assert.equal('something_new_and_enormous' in card, false);
});

test('an absent field is omitted rather than serialized as undefined', () => {
  // `product_slug` exists only on a composition row. Emitting `undefined` for
  // every ordinary product would put the key back in the JSON as null.
  const card = cardShape({ id: 'p1', slug: 's', name: 'n', price_iqd: 1000 });
  assert.equal('product_slug' in card, false);
  assert.equal('offer' in card, false);
  assert.deepEqual(Object.keys(card).sort(), ['id', 'name', 'price_iqd', 'slug']);
});

test('the projection is applied to the OUTPUT, never to the query that resolves the price', () => {
  // `display_price_iqd` is the cheapest way to buy the product, computed by
  // walking every option and colour. Narrowing the SELECT would change it;
  // narrowing the serialized output cannot. Pin that the routes still hand the
  // whole row to the resolver and only then project.
  const src = readFileSync(join(ROOT, 'worker/routes/products.ts'), 'utf8');
  assert.ok(
    // The listing predicates (completeness hold, DECISIONS row 205; VISIBLE + the SELLABLE
    // flag, row 240) replaced the bare status filter; the SELECT is still the whole row.
    src.includes('const selectList = `SELECT *, ${optimisticSellableFlag(db)} AS sellable_now FROM products`;'),
    'the list route no longer selects the whole row — the resolver would lose the option ladder'
  );
  assert.ok(
    /cardShape\(\s*publicWithDisplayPrice\(/.test(src),
    'cardShape must wrap the resolver result, not replace it'
  );
});

test('a composition card is never run through the product projection', () => {
  // `compositionCard` already returns a narrow shape, and a LOCKED bundle has
  // its member prices stripped in there. Re-projecting it would be a different
  // bug, and a quiet one.
  const src = readFileSync(join(ROOT, 'worker/routes/products.ts'), 'utf8');
  assert.ok(
    src.includes('if (b) return compositionCard(b, ctx);'),
    'the composition branch must return before the product projection'
  );
  assert.ok(
    !/cardShape\(\s*compositionCard/.test(src),
    'a composition card is being re-projected'
  );
});

// ============================================================ the card's picture, not the gallery

/** Gallery keys a card never reads — the reason the payload was large. */
const GALLERY_ONLY_KEYS = ['key', 'role', 'content_type', 'bytes', 'source_url', 'option_value_id', 'color_id', 'variant_id'];

test('a card carries the ONE picture it draws, not the product\'s gallery', () => {
  // A Bambu filament carried 31 gallery entries on every card of the live listing.
  const published = publishedGallery(gallery(31, 7));
  const card = cardShape({ id: 'p1', slug: 's', name: 'n', price_iqd: 1000, ...published });
  const media = card.media as Record<string, unknown>[];
  assert.equal(media.length, 1);
  assert.deepEqual(card.images, [fileUrl(7)]);
  assert.equal(media[0].url, fileUrl(7), 'the primary entry is the one kept');
  assert.equal(media[0].primary, true);
  assert.deepEqual(Object.keys(media[0]), [...CARD_MEDIA_KEYS], 'the entry keeps exactly what card readers read');
  for (const k of GALLERY_ONLY_KEYS) assert.equal(k in media[0], false, `${k} rode along on a card`);
  // The public API's card image reads these from the entry: they survive as they were.
  assert.equal(media[0].alt_en, 'Product picture 7 — Bambu Lab PLA Basic');
  assert.equal(media[0].width, 2048);
  // An empty gallery stays empty — never a hole the card tries to draw.
  const bare = cardShape({ id: 'p2', slug: 's2', name: 'n', price_iqd: 1, media: [], images: [] });
  assert.deepEqual([bare.media, bare.images], [[], []]);
});

/**
 * Galleries of every shape the readers distinguish: a primary first (what the
 * projection publishes), a primary somewhere else, two primaries, none, orders
 * out of array order, a lead whose file `/files` does not serve to a visitor
 * (the public API then publishes the next one), nothing public at all, a
 * light-theme picture, a gallery only `images` knows.
 */
function shapes(): Array<{ name: string; card: Record<string, unknown> }> {
  const out: Array<{ name: string; card: Record<string, unknown> }> = [];
  const add = (name: string, media: Record<string, unknown>[], images?: string[], extra: Record<string, unknown> = {}) =>
    out.push({ name, card: { id: 'p', slug: 's', name: 'n', media, images: images ?? media.map((m) => m.url as string), ...extra } });
  for (const n of [1, 2, 5, 31]) {
    for (const at of [-1, 0, Math.floor(n / 2), n - 1]) {
      add(`published n=${n} primary=${at}`, publishedGallery(gallery(n, at)).media);
      add(`stored order n=${n} primary=${at}`, gallery(n, at));
      add(`reversed n=${n} primary=${at}`, [...gallery(n, at)].reverse());
      add(`light n=${n} primary=${at}`, publishedGallery(gallery(n, at)).media, undefined, { light_image: fileUrl(90) });
    }
  }
  const two = gallery(6, 4);
  two[1].primary = true;
  add('two primaries', two);
  add('two primaries, published', publishedGallery(two).media);
  // A lead the public API may not publish (not an anonymously served key), with public entries behind it.
  const privLead = [entry(0, true, 'uploads/private'), ...gallery(5, -1).slice(1)];
  add('private lead, public rest', privLead);
  add('private lead, public primary behind', [entry(0, true, 'uploads/private'), { ...entry(3, true) }, entry(1, false)]);
  add('private lead, no primary', [entry(0, false, 'uploads/private'), entry(1, false), entry(2, false, 'uploads/private')]);
  add('nothing public', [entry(0, true, 'uploads/private'), entry(1, false, 'uploads/private')]);
  add('images only', [], [fileUrl(4), fileUrl(5)]);
  add('media without images', publishedGallery(gallery(4, 2)).media, []);
  add('entry without url', [{ ...entry(0, true), url: '' }, entry(1, false), entry(2, false)]);
  add('empty', [], []);
  return out;
}

/**
 * Is this gallery one `projectPublic` could publish — every entry a stored file
 * (`canonicalProductMedia` keeps only those), primary first, `images` the
 * entries' URLs in the same order?
 */
function asPublished(card: Record<string, unknown>): boolean {
  const media = card.media as Record<string, unknown>[];
  const again = publishedGallery(media);
  return (
    media.every((m) => typeof m.url === 'string' && m.url !== '') &&
    JSON.stringify(again.media) === JSON.stringify(media) &&
    JSON.stringify(card.images) === JSON.stringify(again.images)
  );
}

test('every reader picks the SAME picture from the trimmed card — the storefront, the banner, the profile, an old bundle, the public API', () => {
  const urls = urlsForOrigin('https://levonis-iq.com');
  for (const { name, card } of shapes()) {
    const trimmed = cardShape(card);
    const pairs: Array<[string, unknown, unknown]> = [
      // ProductCard, the listing rows, live search, the home rails, the finder — and every older bundle, which ran the same helpers.
      ['productPrimaryImage', productPrimaryImage(card as never), productPrimaryImage(trimmed as never)],
      ['productMainImage light', productMainImage(card as never, 'light'), productMainImage(trimmed as never, 'light')],
      ['productMainImage dark', productMainImage(card as never, 'dark'), productMainImage(trimmed as never, 'dark')],
      // The category banners (src/lib/catalog/explorerModel.ts).
      ['photoOf', photoOf(card as never), photoOf(trimmed as never)],
      // Profile.tsx and the project composer read images[0] — on a gallery as the
      // projection publishes it (primary first, `images` in the same order), the same file.
      ...(asPublished(card) ? [['images[0]', (card.images as string[])[0] ?? '', (trimmed.images as string[])[0] ?? ''] as [string, unknown, unknown]] : []),
      // Whatever the order it came in, the card's list leads with the picture the card draws.
      ['images[0] is the lead', productPrimaryImage(card as never), (trimmed.images as string[])[0] ?? ''],
      // The public API v1 card image: url, width, height and the three alt texts.
      ['public API image', JSON.stringify(cardImage(card, urls)), JSON.stringify(cardImage(trimmed, urls))],
    ];
    for (const [reader, before, after] of pairs) assert.equal(after, before, `${name}: ${reader} changed its picture`);
    assert.ok((trimmed.media as unknown[]).length <= 2, `${name}: the card kept ${(trimmed.media as unknown[]).length} entries`);
  }
});

test('the server\'s lead picture is src/lib/productImage.ts productPrimaryImage, rule for rule', () => {
  for (const { name, card } of shapes()) {
    assert.equal(cardLeadUrl(card.media as unknown[], card.images as unknown[]), productPrimaryImage(card as never), name);
  }
  // And a second entry rides along only for the public API, only when the lead is not a file it may publish.
  const published = publishedGallery(gallery(8, 0));
  assert.equal(cardGallery(published.media, published.images).media.length, 1);
  const priv = [entry(0, true, 'uploads/private'), entry(1, false)];
  const g = cardGallery(priv, priv.map((m) => m.url));
  assert.deepEqual(g.media.map((m) => m.url), [priv[0].url, priv[1].url]);
  assert.deepEqual(g.images, [priv[0].url, priv[1].url], 'images[0] is still the lead');
});

// ------------------------------------------------------------ through the real routes

/** The live catalogue, one filament given a 31-picture gallery (primary in the middle), the routes that serve cards. */
function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.prepare('UPDATE products SET images = ? WHERE slug = ?').run(JSON.stringify(gallery(31, 12)), 'bambu-lab-pla-matte-1kg');
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes).route('/api/home', homeRoutes).route('/api/catalog', catalogRoutes));
  return app;
}

/** Every card in an answer, wherever it sits (`products`, `latest`, `shelves[].products`, …). */
function cardsIn(body: unknown, slug: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    if (r.slug === slug && 'media' in r) out.push(r);
    else Object.values(r).forEach(walk);
  };
  walk(body);
  return out;
}

/**
 * THE CARD BUDGET. One card of a 31-picture product, as JSON, in bytes. With
 * the whole gallery it was 21,924 bytes in this world (17 keys × 31 entries +
 * the 31 URLs again); with its one picture it is 1,191. One more picture entry
 * (~430 bytes) breaks it, so a change that lets the gallery back onto cards
 * fails here. May only get tighter.
 */
const CARD_JSON_BUDGET = 1_500;

test('every route that serves cards serves the one picture, within the card budget', async () => {
  const app = world();
  const paths = [
    '/api/products?limit=50', // /products, the document preloads it
    '/api/products?sort=available&limit=50', // the /categories photo pool
    '/api/products?category=cat_materials_fdm&facets=1&limit=24', // a category listing
    '/api/products?category=cat_materials&limit=20', // the home «latest» tabs
    '/api/products?search=matte&limit=6', // live search
    '/api/home',
    '/api/catalog/printing-materials',
  ];
  for (const path of paths) {
    const res = await get(app, path);
    assert.equal(res.status, 200, path);
    const cards = cardsIn(await json(res), 'bambu-lab-pla-matte-1kg');
    assert.ok(cards.length >= 1, `${path}: the filament's card is not in the answer`);
    for (const card of cards) {
      assert.equal((card.media as unknown[]).length, 1, `${path}: the card carries ${(card.media as unknown[]).length} gallery entries`);
      assert.deepEqual(card.images, [fileUrl(12)], `${path}: the card's picture is not the primary`);
      const bytes = Buffer.byteLength(JSON.stringify(card));
      assert.ok(bytes <= CARD_JSON_BUDGET, `${path}: one card is ${bytes} bytes (budget ${CARD_JSON_BUDGET})`);
    }
  }
});

test('the product page still receives the whole gallery — only the cards were trimmed', async () => {
  const app = world();
  const body = await json(await get(app, '/api/products/bambu-lab-pla-matte-1kg'));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 300));
  const media = body.product.media as Record<string, unknown>[];
  assert.equal(media.length, 31);
  assert.equal(media[0].url, fileUrl(12), 'primary first');
  assert.equal(body.product.images.length, 31);
  assert.equal(media[0].variant_id, '', 'and each entry keeps its bindings for the page');
  assert.equal(media.find((m) => m.id === 'pi_5')?.variant_id, 'pv_5');
});
