/**
 * WHAT A CRAWLER READS OFF A SHARED PRODUCT LINK.
 *
 * The bug this file pins down is invisible in a browser and total in a chat
 * app: `/product/<slug>` is served the same shell as every other route, React
 * writes the product in afterwards, and a crawler — which never boots React —
 * unfurled the SHOP's card for every product in the catalogue.
 *
 * So these tests assert on the BYTES a crawler would be handed: the shell as
 * shipped, transformed by the same pure functions the Worker runs. There is no
 * mock of HTMLRewriter here because there is no HTMLRewriter — the rewrite is
 * a string transform precisely so this file can check the real output.
 *
 * Four things must hold together or the feature is not delivered:
 *   1. the four product routes are recognised and nothing else is;
 *   2. `run_worker_first` actually lets the Worker see those documents —
 *      without that line the rewrite is dead code, which is what the previous
 *      architecture note in securityPolicy.ts proves happened once already;
 *   3. the product's own picture and description replace the shop's;
 *   4. a private, unfetchable or draft thing NEVER becomes a share card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  absoluteImageUrl,
  injectSocialPreview,
  productSlugFromPath,
  resolveProductPreview,
  shortDescription,
} from '../worker/lib/socialPreview';

const SHELL = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WRANGLER = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

/** The value of one meta tag as a crawler would read it, or null. */
function meta(html: string, attr: 'property' | 'name', key: string): string | null {
  const tag = new RegExp(`<meta\\s+${attr}="${key}"[^>]*>`, 'i').exec(html);
  if (!tag) return null;
  return /content="([^"]*)"/i.exec(tag[0])?.[1] ?? null;
}

// --------------------------------------------------------------- the shell

test('the shipped shell carries a card and an icon of its own', () => {
  // The owner reported both symptoms — a generic tab icon and an empty
  // unfurl — and both were the same absence.
  assert.match(SHELL, /<link rel="icon"[^>]*Logo\.webp/i);
  // THE HOME-SCREEN ICON IS NO LONGER THAT WEBP, and the change is the fix
  // rather than a regression this line should have caught. iOS does not
  // accept WebP for `apple-touch-icon`: it ignores the link entirely and uses
  // a SCREENSHOT OF THE PAGE as the home-screen icon, which is what every
  // iPhone that added this shop actually got. The link now points at
  // /icons/apple-touch-icon.png, a real 180x180 file in public/. What this
  // test still guards is that the shell declares one at all;
  // tests/indexHtmlPwa.test.ts owns the format, the size and whether the file
  // it names exists.
  assert.match(SHELL, /<link rel="apple-touch-icon"[^>]*\.png/i);
  assert.equal(meta(SHELL, 'property', 'og:site_name'), 'LEVONIS');
  assert.ok((meta(SHELL, 'property', 'og:title') || '').includes('LEVONIS'));
  assert.ok((meta(SHELL, 'property', 'og:description') || '').length > 20);
  assert.match(meta(SHELL, 'property', 'og:image') || '', /^https:\/\//);
  assert.equal(meta(SHELL, 'name', 'twitter:card'), 'summary_large_image');
});

test('og:image is absolute — a relative one is silently dropped by crawlers', () => {
  for (const key of ['og:image'] as const) {
    assert.match(meta(SHELL, 'property', key) || '', /^https:\/\/levonis-iq\.com\//);
  }
  assert.match(meta(SHELL, 'name', 'twitter:image') || '', /^https:\/\/levonis-iq\.com\//);
  assert.match(meta(SHELL, 'property', 'og:url') || '', /^https:\/\/levonis-iq\.com\//);
});

// ------------------------------------------------- the routing that enables it

test('the Worker is invoked for the product documents, or the rewrite is dead code', () => {
  /**
   * This is the assertion that would have caught the whole feature being
   * unreachable. Anything not named in `run_worker_first` is answered by the
   * asset layer BEFORE the Worker exists for that request — the reason the
   * SPA's security headers had to be moved into a generated `_headers` file.
   * A rewrite in `app.notFound` for a path the Worker never sees changes
   * nothing at all.
   */
  const blocks = WRANGLER.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(blocks.length, 3, 'top-level, staging and production must each declare it');
  for (const block of blocks) {
    for (const route of ['/api/*', '/files/*', '/product/*', '/bundles/*', '/p/*', '/community/store/*']) {
      assert.ok(block.includes(`"${route}"`), `${route} missing from ${block}`);
    }
  }
});

test('every product route the SPA declares is a route the rewriter recognises', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // The paths in App.tsx that render a product detail page. If one is renamed
  // or a new one appears, its share card silently reverts to the shop's — so
  // the route table is read from the app rather than restated here.
  const declared = [...app.matchAll(/<Route path="([^"]*\/p\/:[^"]+|\/product\/:[^"]+|\/bundles\/:[^"]+)"/g)].map(
    (m) => m[1]
  );
  assert.ok(declared.length >= 3, `expected the product routes in App.tsx, saw ${declared.length}`);
  for (const path of declared) {
    const concrete = path.replace(/:[^/]+/g, 'x');
    assert.ok(productSlugFromPath(concrete), `${path} (${concrete}) is not recognised`);
  }
});

test('the four product paths are recognised, and the referral query is irrelevant to them', () => {
  assert.equal(productSlugFromPath('/product/bambu-a1-mini'), 'bambu-a1-mini');
  assert.equal(productSlugFromPath('/bundles/starter-kit'), 'starter-kit');
  assert.equal(productSlugFromPath('/p/pla-black'), 'pla-black');
  assert.equal(productSlugFromPath('/community/store/ali3d/p/pla-black'), 'pla-black');
  // A trailing slash is the same page.
  assert.equal(productSlugFromPath('/product/bambu-a1-mini/'), 'bambu-a1-mini');
  // The supporter's handle rides in the QUERY (productSupportPath), which is
  // never part of the path — which is why a referral share needs no special
  // case anywhere in this module.
  assert.equal(productSlugFromPath('/product/bambu-a1-mini'), 'bambu-a1-mini');
});

test('nothing else in the app pays for a lookup', () => {
  for (const path of [
    '/',
    '/products',
    '/cart',
    '/checkout',
    '/orders',
    '/auth',
    '/community/store/ali3d',
    '/product',
    '/product/',
    '/assets/index-abc123.js',
    '/p/favicon.ico', // a FILE that fell through to the SPA, not a product
    '/product/a/b/c',
  ]) {
    assert.equal(productSlugFromPath(path), null, path);
  }
});

test('a malformed slug is refused rather than guessed at', () => {
  assert.equal(productSlugFromPath('/product/%E0%A4%A'), null);
  assert.equal(productSlugFromPath(`/product/${'x'.repeat(200)}`), null);
  // Percent-encoded Arabic is a real slug and must survive.
  assert.equal(productSlugFromPath('/product/%D8%B7%D8%A7%D8%A8%D8%B9%D8%A9'), 'طابعة');
});

// ------------------------------------------------------------ the short text

test('a long description is cut on a word boundary, not mid-word', () => {
  const text = 'طابعة ثلاثية الأبعاد صغيرة وسريعة '.repeat(20);
  const short = shortDescription(text);
  assert.ok(short.length <= 161, `${short.length} characters`);
  assert.ok(short.endsWith('…'));
  assert.ok(!short.slice(0, -1).endsWith(' '));
  // The cut fell on a space in the source, so no word is broken in half.
  assert.ok(text.startsWith(short.slice(0, -1)));
});

test('markup from an imported vendor description never reaches the card', () => {
  assert.equal(shortDescription('<p>Fast <b>PLA</b><br/>printer</p>'), 'Fast PLA printer');
  assert.equal(shortDescription('a&nbsp;&nbsp;b'), 'a b');
  assert.equal(shortDescription('   '), '');
  assert.equal(shortDescription(null), '');
});

test('a short description is left exactly as the shop wrote it', () => {
  const text = 'خيط PLA أسود 1.75 مم';
  assert.equal(shortDescription(text), text);
});

// --------------------------------------------------------------- the image

test('a product photo is made absolute against the trusted origin', () => {
  assert.equal(
    absoluteImageUrl('/files/products/abc/def.webp', 'https://levonis-iq.com'),
    'https://levonis-iq.com/files/products/abc/def.webp'
  );
});

test('an image a crawler cannot fetch is refused, not shown broken', () => {
  // A crawler arrives with no cookie. These keys answer it 403, and a card
  // with a 403 image shows nothing at all — worse than the shop's logo.
  assert.equal(absoluteImageUrl('/files/receipts/u1/r.png', 'https://levonis-iq.com'), '');
  assert.equal(absoluteImageUrl('/files/chat/u1/x.png', 'https://levonis-iq.com'), '');
  assert.equal(absoluteImageUrl('/files/reviews/r1/x.png', 'https://levonis-iq.com'), '');
  // Not an image route, not https, nothing to show.
  assert.equal(absoluteImageUrl('/some/page.png', 'https://levonis-iq.com'), '');
  assert.equal(absoluteImageUrl('http://vendor.example/x.jpg', 'https://levonis-iq.com'), '');
  assert.equal(absoluteImageUrl('', 'https://levonis-iq.com'), '');
  assert.equal(absoluteImageUrl(null, 'https://levonis-iq.com'), '');
});

test('an imported vendor image is never hotlinked, even over https', () => {
  assert.equal(absoluteImageUrl('https://bad.example/a1.jpg', 'https://levonis-iq.com'), '');
});

// -------------------------------------------------------------- the rewrite

const PREVIEW = {
  title: 'Bambu Lab A1 mini',
  description: 'طابعة صغيرة وسريعة للمبتدئين.',
  image: 'https://levonis-iq.com/files/products/a/b.webp',
  url: 'https://levonis-iq.com/product/a1-mini?ref=ali',
};

test('the product replaces the shop in every tag a chat app reads', () => {
  const html = injectSocialPreview(SHELL, PREVIEW);
  assert.equal(meta(html, 'property', 'og:title'), PREVIEW.title);
  assert.equal(meta(html, 'property', 'og:description'), PREVIEW.description);
  assert.equal(meta(html, 'property', 'og:image'), PREVIEW.image);
  assert.equal(meta(html, 'property', 'og:url'), PREVIEW.url);
  assert.equal(meta(html, 'name', 'twitter:title'), PREVIEW.title);
  assert.equal(meta(html, 'name', 'twitter:description'), PREVIEW.description);
  assert.equal(meta(html, 'name', 'twitter:image'), PREVIEW.image);
  assert.match(html, /<title>Bambu Lab A1 mini<\/title>/);
  // Exactly one of each: a replace that appends instead would give a crawler
  // two og:image tags and let it pick the shop's.
  assert.equal((html.match(/property="og:image"/g) || []).length, 1);
  assert.equal((html.match(/property="og:title"/g) || []).length, 1);
  assert.equal((html.match(/name="twitter:image"/g) || []).length, 1);
});

test('the shop keeps everything that is not the identity of the shared thing', () => {
  const html = injectSocialPreview(SHELL, PREVIEW);
  assert.equal(meta(html, 'property', 'og:site_name'), 'LEVONIS');
  assert.equal(meta(html, 'property', 'og:type'), 'website');
  assert.equal(meta(html, 'property', 'og:locale'), 'ar_IQ');
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
  assert.match(html, /<link rel="icon"[^>]*Logo\.webp/);
  assert.match(html, /<script type="module" src="\/src\/main\.tsx">/);
  assert.match(html, /<html lang="ar" dir="rtl"/);
  // The anti-flash rules and the font links are untouched.
  assert.match(html, /background-color: #000/);
  assert.match(html, /fonts\.googleapis\.com/);
});

test('the referral handle survives into the card', () => {
  // og:url is what Facebook and Messenger treat as canonical and follow. If it
  // were rewritten to the bare product path, every share through them would
  // drop the supporter the sharer is owed.
  const html = injectSocialPreview(SHELL, PREVIEW);
  assert.equal(meta(html, 'property', 'og:url'), 'https://levonis-iq.com/product/a1-mini?ref=ali');
});

test('a product name with a quote or an ampersand cannot break out of the tag', () => {
  const html = injectSocialPreview(SHELL, {
    ...PREVIEW,
    title: 'PLA "Pro" & Co <script>alert(1)</script>',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.equal(meta(html, 'property', 'og:title'), 'PLA &quot;Pro&quot; &amp; Co &lt;script&gt;alert(1)&lt;/script&gt;');
});

test('an empty field leaves the shop default rather than blanking the card', () => {
  const html = injectSocialPreview(SHELL, { ...PREVIEW, description: '', image: '' });
  assert.equal(meta(html, 'property', 'og:description'), meta(SHELL, 'property', 'og:description'));
  assert.equal(meta(html, 'property', 'og:image'), meta(SHELL, 'property', 'og:image'));
  assert.equal(meta(html, 'property', 'og:title'), PREVIEW.title);
});

test('a document with no tags of its own still gets them', () => {
  const bare = '<!doctype html><html><head><title>x</title></head><body></body></html>';
  const html = injectSocialPreview(bare, PREVIEW);
  assert.equal(meta(html, 'property', 'og:image'), PREVIEW.image);
  assert.equal(meta(html, 'name', 'twitter:title'), PREVIEW.title);
  assert.ok(html.indexOf('og:image') < html.indexOf('</head>'));
});

// ------------------------------------------------------------- the lookup

/** A D1 stand-in that answers each prepared statement from a fixed table. */
function fakeDb(tables: Record<string, Record<string, unknown> | Record<string, unknown>[] | null>) {
  const asked: string[] = [];
  return {
    asked,
    prepare(sql: string) {
      const table = /FROM (\w+)/.exec(sql)![1];
      return {
        bind(...bindings: string[]) {
          asked.push(`${table}:${bindings[0] ?? ''}`);
          const answer = tables[table] ?? null;
          return {
            first: async () => Array.isArray(answer) ? (answer[0] ?? null) : answer,
            all: async () => ({ results: Array.isArray(answer) ? answer : answer ? [answer] : [] }),
          };
        },
      };
    },
  } as never;
}

test('the catalogue is read first, exactly as the product API reads it', async () => {
  const db = fakeDb({
    products: { id: 'catalog', name_ar: 'كتالوج', description_ar: 'وصف', images: '[]' },
    product_images: [],
    community_products: { name_ar: 'متجر', description_ar: 'آخر', images: '[]' },
  });
  const preview = await resolveProductPreview(db, 'slug', 'https://levonis-iq.com');
  assert.equal(preview?.title, 'كتالوج');
  assert.deepEqual((db as unknown as { asked: string[] }).asked, ['products:slug', 'product_images:catalog']);
});

test('a merchant product falls through to community_products', async () => {
  const db = fakeDb({
    products: null,
    community_products: { name_ar: 'خيط PLA', description_ar: 'أسود', images: '[]' },
  });
  const preview = await resolveProductPreview(db, 'pla', 'https://levonis-iq.com');
  assert.equal(preview?.title, 'خيط PLA');
  assert.equal(preview?.description, 'أسود');
  assert.deepEqual((db as unknown as { asked: string[] }).asked, ['products:pla', 'community_products:pla']);
});

test('an unknown slug produces no card at all', async () => {
  const db = fakeDb({ products: null, community_products: null });
  assert.equal(await resolveProductPreview(db, 'nope', 'https://levonis-iq.com'), null);
});

test('the lead image is the one the product page itself shows', async () => {
  // Not the stale products.images mirror and not quarantine provenance:
  // explicit relational primary wins, which is the rule the page, cards, cart
  // and immutable order snapshot all use.
  const db = fakeDb({
    products: {
      id: 'p1',
      name_ar: 'طابعة',
      description_ar: 'وصف قصير',
      images: JSON.stringify(['https://bad.example/stale.jpg']),
    },
    product_images: [
      {
        id: 'second', product_id: 'p1', url: '/files/products/second.webp',
        r2_key: 'products/second.webp', sort_order: 0, is_primary: 0,
      },
      {
        id: 'lead', product_id: 'p1', url: '/files/products/lead.webp',
        r2_key: 'products/lead.webp', sort_order: 1, is_primary: 1,
      },
      {
        id: 'bad', product_id: 'p1', url: '', r2_key: '', sort_order: 0, is_primary: 0,
        quarantined: 1, source_url: 'https://bad.example/quarantine.jpg',
      },
    ],
  });
  const preview = await resolveProductPreview(db, 'p', 'https://levonis-iq.com');
  assert.equal(preview?.image, 'https://levonis-iq.com/files/products/lead.webp');
  assert.equal(JSON.stringify(preview).includes('bad.example'), false);
});

test('a quarantined-only catalogue product keeps the shop OG image', async () => {
  const db = fakeDb({
    products: {
      id: 'p2', name_ar: 'طابعة', description_ar: 'وصف',
      images: JSON.stringify(['https://bad.example/stale.jpg']),
    },
    product_images: [{
      id: 'bad', product_id: 'p2', url: '', r2_key: '', sort_order: 0, is_primary: 0,
      quarantined: 1, source_url: 'https://bad.example/source.jpg',
    }],
  });
  const preview = await resolveProductPreview(db, 'p2', 'https://levonis-iq.com');
  assert.equal(preview?.image, '');
  assert.equal(JSON.stringify(preview).includes('bad.example'), false);
});

test('a product with no description keeps the shop line instead of an invented one', async () => {
  const db = fakeDb({ products: { id: 'p1', name_ar: 'طابعة', description_ar: '', images: '[]' }, product_images: [] });
  const preview = await resolveProductPreview(db, 'p', 'https://levonis-iq.com');
  assert.equal(preview?.description, '');
  const html = injectSocialPreview(SHELL, { ...preview!, url: 'https://levonis-iq.com/product/p' });
  assert.equal(meta(html, 'property', 'og:description'), meta(SHELL, 'property', 'og:description'));
});

test('only a published product is readable — a draft must not leak through a card', () => {
  // The status filter is the whole guard: a crawler is anonymous, and a guessed
  // slug would otherwise unfurl an unreleased product's name and photo.
  const source = readFileSync(new URL('../worker/lib/socialPreview.ts', import.meta.url), 'utf8');
  const selects = source.match(/SELECT[\s\S]*?FROM (?:products|community_products)[\s\S]*?(?=")/g) ?? [];
  assert.equal(selects.length, 2, `expected two reads, saw ${selects.length}`);
  for (const select of selects) assert.match(select, /WHERE slug = \? AND status = 'active'$/);
  // And the slug is bound, never interpolated.
  assert.ok(!/\$\{slug\}/.test(source));
});

// ------------------------------------------------------- the route, in place

test('the fallback injects, strips the stale validator, and cannot break a page load', () => {
  const index = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
  assert.match(index, /productSlugFromPath/);
  assert.match(index, /resolveProductPreview/);
  assert.match(index, /injectSocialPreview/);
  // The body no longer matches the asset that was hashed: a surviving ETag
  // would let a cache answer a later request with the shop's card again.
  assert.match(index, /headers\.delete\('ETag'\)/);
  assert.match(index, /headers\.delete\('Content-Length'\)/);
  // A card is an enhancement; the app is not. Every failure returns the asset.
  const fn = /async function assetWithPreview[\s\S]*?\n}\n/.exec(index)?.[0] ?? '';
  assert.ok(fn, 'assetWithPreview not found');
  assert.match(fn, /catch\s*{[\s\S]*return asset;/);
  assert.match(fn, /if \(!slug \|\| !asset\.ok\) return asset;/);
  // Only HTML is rewritten — a JSON or binary asset served on these prefixes
  // must pass through untouched.
  assert.match(fn, /text\\\/html/);
});
