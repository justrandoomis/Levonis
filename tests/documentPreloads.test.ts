/**
 * THE DOCUMENT'S HEAD START (P2b — docs/MERCHANT_PLATFORM_V2.md §B.1 #3, §B.2).
 *
 * The Worker already rewrites the documents that name a product or a store
 * for their share card. This file proves what the rewrite now adds and what
 * it must never do:
 *
 *   - the route's chunk is named in a `<link rel="modulepreload">` from Vite's
 *     manifest, minus everything the entry already loads;
 *   - the picture the page paints largest is preloaded at high priority;
 *   - the ANONYMOUS resolve answer rides in a JSON data block the client reads
 *     synchronously (src/lib/bootFetch.ts, src/StoreContext.tsx);
 *   - the response keeps a weak ETag OF THE REWRITTEN BODY and answers 304;
 *   - it carries the Early Hints `Link`, and a shareable Cache-Control ONLY
 *     when nothing about it depended on who asked — a session-dependent
 *     rewrite keeps `no-cache`;
 *   - every other document passes through untouched.
 *
 * Run: node --import tsx --test tests/documentPreloads.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { APEX, asD1, ctx, freshDb } from './fixtures/app';
import worker from '../worker/index';
import {
  ARABIC_FONT_PRELOAD,
  DOCUMENT_SHARED_CACHE_CONTROL,
  INLINE_RESOLVE_ID,
  MANIFEST_PATH,
  chunkPreloads,
  documentCacheControl,
  earlyHintsLink,
  entryStylesheets,
  heroCoverFrom,
  injectDocumentPreloads,
  inlineJsonScript,
  preloadImagePath,
  productImagePreload,
  routeModuleFor,
  type ViteManifest,
} from '../worker/lib/socialPreview';
import { DOCUMENT_CACHE_CONTROL } from '../worker/lib/securityPolicy';
import { ARABIC_FONT_PRELOAD as SCRIPT_FONT, earlyHintsLink as scriptEarlyHintsLink, entryStylesheets as scriptEntryStylesheets, withEarlyHints } from '../scripts/write-asset-headers.mjs';
import { HOME_PATH, RESOLVE_PATH, bootRequests } from '../src/lib/bootFetch';

// ---------------------------------------------------------------- fixtures

/** A manifest shaped like Vite's: the entry, its vendor chunks, three pages, a chunk two pages share. */
const MANIFEST: ViteManifest = {
  'index.html': { file: 'assets/index-abc.js', isEntry: true, imports: ['_vendor-react-r1.js', '_vendor-motion-core-m1.js'], css: ['assets/index-abc.css'] },
  '_vendor-react-r1.js': { file: 'assets/vendor-react-r1.js' },
  '_vendor-motion-core-m1.js': { file: 'assets/vendor-motion-core-m1.js' },
  '_vendor-icons-i1.js': { file: 'assets/vendor-icons-i1.js', imports: ['_vendor-react-r1.js'] },
  '_theme-t1.js': { file: 'assets/theme-t1.js', imports: ['_vendor-react-r1.js'], css: ['assets/theme-t1.css'] },
  'src/pages/Storefront.tsx': { file: 'assets/Storefront-s1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js', '_vendor-icons-i1.js', '_theme-t1.js'], css: ['assets/Storefront-s1.css'] },
  'src/pages/StorefrontProduct.tsx': { file: 'assets/StorefrontProduct-sp1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js', '_theme-t1.js'] },
  'src/pages/Product.tsx': { file: 'assets/Product-p1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js', '_vendor-icons-i1.js'], css: ['assets/Product-p1.css'] },
};

const SHELL = [
  '<!doctype html><html lang="ar" dir="rtl"><head>',
  '<meta charset="utf-8" />',
  '<title>LEVONIS</title>',
  '<meta name="description" content="shop" />',
  '<meta property="og:title" content="LEVONIS" />',
  '<meta property="og:description" content="shop" />',
  '<meta property="og:image" content="https://levonis-iq.com/files/UiUx/Logo/Logo.webp" />',
  '<meta property="og:url" content="https://levonis-iq.com/" />',
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/vendor-react-r1.js">',
  '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner','Ali','a@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,banner_key)
      VALUES ('s1','m1','owner','ali3d','Ali 3D','طباعة ثلاثية الأبعاد','merchants/owner/covers/cover.webp');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,description_ar,images,status,lifecycle,price_iqd) VALUES
      ('cp1','m1','s1','ali3d-bracket','Bracket','حامل رف','حامل متين','["/files/merchants/owner/public/aaaa1111.webp"]','active','active',7000);
    INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1', 'filament-pla', 'PLA', 'خيط PLA', 100000, 'active');
    INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order)
      VALUES ('pi1','p1','/files/products/filament-pla/main.webp','products/filament-pla/main.webp',1,0);
  `);
  return raw;
}

/** The real Worker with a fake asset layer: the shell for every document, the manifest at its path. */
function realWorker(opts: { manifest?: unknown; setCookie?: boolean } = {}) {
  const raw = seed();
  const assetCalls: string[] = [];
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        assetCalls.push(path);
        if (path === MANIFEST_PATH) {
          if (opts.manifest === undefined) return new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/json' } });
          if (opts.manifest === null) return new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } }); // SPA fallback: no such file
          return new Response(JSON.stringify(opts.manifest), { headers: { 'content-type': 'application/json' } });
        }
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', etag: 'W/"asset"', 'cache-control': DOCUMENT_CACHE_CONTROL, 'content-length': String(SHELL.length) };
        if (opts.setCookie) headers['set-cookie'] = 'lv_probe=1; Path=/';
        return new Response(SHELL, { headers });
      },
    },
  };
  const call = (host: string, path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', ...headers } }), env as never, ctx);
  return { call, assetCalls };
}

const STORE_HOST = `ali3d.${APEX}`;
const inline = (html: string): Record<string, unknown> | null => {
  const m = new RegExp(`<script type="application/json" id="${INLINE_RESOLVE_ID}">([\\s\\S]*?)</script>`).exec(html);
  return m ? (JSON.parse(m[1]) as Record<string, unknown>) : null;
};
const links = (html: string, rel: string) => [...html.matchAll(new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`, 'g'))].map((m) => m[1]);

// =========================================================================
// the pure pieces
// =========================================================================

test('the route → page module map mirrors src/App.tsx for exactly the rewritten paths', () => {
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
  assert.equal(routeModuleFor('/', true), 'src/pages/Storefront.tsx');
  assert.equal(routeModuleFor('/p/x', true), 'src/pages/StorefrontProduct.tsx');
  assert.equal(routeModuleFor('/product/x', false), 'src/pages/Product.tsx');
  assert.equal(routeModuleFor('/bundles/x', false), 'src/pages/BundleDetail.tsx');
  assert.equal(routeModuleFor('/community/store/ali3d', false), 'src/pages/CommunityStorePage.tsx');
  assert.equal(routeModuleFor('/community/store/ali3d/p/x', false), 'src/pages/StorefrontProduct.tsx');
  assert.equal(routeModuleFor('/products', true), null);
  assert.equal(routeModuleFor('/cart', false), null);
  // Every module named above is a lazy route of the app, spelled the same.
  for (const page of ['Storefront', 'StorefrontProduct', 'Product', 'BundleDetail', 'CommunityStorePage']) {
    assert.match(app, new RegExp(`(?:React\\.lazy|prefetchable)\\(\\(\\) => import\\('\\./pages/${page}'\\)\\)`), `${page} is not a lazy route any more — routeModuleFor names a chunk that does not exist`);
  }
});

test('the preload closure is the route chunk plus what it shares with other lazy pages, never what the entry already loads', () => {
  const store = chunkPreloads(MANIFEST, 'src/pages/Storefront.tsx');
  assert.deepEqual(store.scripts, ['/assets/Storefront-s1.js', '/assets/vendor-icons-i1.js', '/assets/theme-t1.js']);
  assert.deepEqual(store.styles, ['/assets/Storefront-s1.css', '/assets/theme-t1.css']);
  assert.ok(!store.scripts.some((s) => /vendor-react|vendor-motion-core|index-abc/.test(s)), 'the entry closure is already in the document');
  assert.deepEqual(chunkPreloads(MANIFEST, 'src/pages/Product.tsx').scripts, ['/assets/Product-p1.js', '/assets/vendor-icons-i1.js']);
  assert.deepEqual(chunkPreloads(MANIFEST, 'src/pages/Nope.tsx'), { scripts: [], styles: [] });
  assert.equal(chunkPreloads(MANIFEST, 'src/pages/Storefront.tsx', 1).scripts.length, 1, 'capped, the route chunk first');
  assert.deepEqual(entryStylesheets(MANIFEST), ['/assets/index-abc.css']);
});

test('a route emitted as a unique dynamic manifest alias retains its preload and only its static closure', () => {
  // Actual production build shape after deferring Product's optional pieces:
  // src/pages/Product.tsx is absent, but _Product-<hash>.js is a dynamic entry.
  const manifest: ViteManifest = { ...MANIFEST };
  delete manifest['src/pages/Product.tsx'];
  manifest['_Product-DtSmEuhQ.js'] = {
    file: 'assets/Product-DtSmEuhQ.js', name: 'Product', isDynamicEntry: true,
    imports: ['index.html', '_vendor-icons-i1.js'],
    dynamicImports: ['src/components/reviews/ReviewSection.tsx', 'src/lib/refusalStrings.ts'],
    css: ['assets/Product-DtSmEuhQ.css'],
  };
  manifest['src/components/reviews/ReviewSection.tsx'] = { file: 'assets/ReviewSection-r1.js', name: 'ReviewSection', isDynamicEntry: true };
  manifest['src/lib/refusalStrings.ts'] = { file: 'assets/refusalStrings-f1.js', name: 'refusalStrings', isDynamicEntry: true };
  assert.deepEqual(chunkPreloads(manifest, 'src/pages/Product.tsx'), {
    scripts: ['/assets/Product-DtSmEuhQ.js', '/assets/vendor-icons-i1.js'],
    styles: ['/assets/Product-DtSmEuhQ.css'],
  });
  assert.equal(chunkPreloads(manifest, 'src/pages/Product.tsx', 1).scripts.length, 1);
  assert.deepEqual(chunkPreloads(manifest, 'src/pages/Nope.tsx'), { scripts: [], styles: [] });
  const staticOnly: ViteManifest = { ...manifest, '_Product-DtSmEuhQ.js': { ...manifest['_Product-DtSmEuhQ.js'], isDynamicEntry: false } };
  assert.deepEqual(chunkPreloads(staticOnly, 'src/pages/Product.tsx'), { scripts: [], styles: [] }, 'a static helper is not a route');
  const differentSource: ViteManifest = { ...manifest, '_Product-DtSmEuhQ.js': { ...manifest['_Product-DtSmEuhQ.js'], src: 'src/components/Product.tsx' } };
  assert.deepEqual(chunkPreloads(differentSource, 'src/pages/Product.tsx'), { scripts: [], styles: [] }, 'a different module with the same name cannot replace the route');
  const ambiguous = { ...manifest, '_Product-another.js': { ...manifest['_Product-DtSmEuhQ.js'], file: 'assets/Product-another.js' } };
  assert.deepEqual(chunkPreloads(ambiguous, 'src/pages/Product.tsx'), { scripts: [], styles: [] }, 'an ambiguous alias is not guessed');
  manifest['src/pages/Product.tsx'] = MANIFEST['src/pages/Product.tsx'];
  assert.deepEqual(chunkPreloads(manifest, 'src/pages/Product.tsx').scripts, ['/assets/Product-p1.js', '/assets/vendor-icons-i1.js'], 'an explicit source key remains authoritative');
});

test('the real product document preloads a route published under its dynamic alias', async () => {
  const manifest: ViteManifest = { ...MANIFEST };
  delete manifest['src/pages/Product.tsx'];
  manifest['_Product-DtSmEuhQ.js'] = { file: 'assets/Product-DtSmEuhQ.js', name: 'Product', isDynamicEntry: true, imports: ['index.html', '_vendor-icons-i1.js'] };
  const { call } = realWorker({ manifest });
  const html = await (await call(APEX, '/product/filament-pla')).text();
  assert.match(html, /<link rel="modulepreload" crossorigin href="\/assets\/Product-DtSmEuhQ\.js">/);
  assert.match(html, /<link rel="modulepreload" crossorigin href="\/assets\/vendor-icons-i1\.js">/);
  assert.doesNotMatch(html, /rel="modulepreload"[^>]*href="\/assets\/index-abc\.js"/, 'the entry is already loaded by the document');
});

test('the Early Hints line names the entry stylesheet and the Arabic font as preloads', () => {
  assert.equal(
    earlyHintsLink(['/assets/index-abc.css']),
    `</assets/index-abc.css>; rel=preload; as=style, <${ARABIC_FONT_PRELOAD}>; rel=preload; as=font; crossorigin`
  );
  assert.equal(earlyHintsLink([], null), '');
  // The build script spells the same three lines again (it runs under plain
  // node, which cannot resolve the worker's import graph); they may not drift.
  assert.equal(SCRIPT_FONT, ARABIC_FONT_PRELOAD);
  assert.deepEqual(scriptEntryStylesheets(MANIFEST), entryStylesheets(MANIFEST));
  assert.equal(scriptEarlyHintsLink(['/assets/index-abc.css']), earlyHintsLink(['/assets/index-abc.css']));
  assert.equal(scriptEarlyHintsLink(['/a.css'], null), earlyHintsLink(['/a.css'], null));
  // The font named is the one the shell itself preloads (P1a).
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`<link rel="preload" as="font"[^>]*href="${ARABIC_FONT_PRELOAD}"`));
});

test('only a same-origin public /files path is preloaded, as a path', () => {
  assert.equal(preloadImagePath('https://levonis-iq.com/files/products/a/b.webp'), '/files/products/a/b.webp');
  assert.equal(preloadImagePath('/files/merchants/owner/covers/c.webp'), '/files/merchants/owner/covers/c.webp');
  assert.equal(preloadImagePath('/files/private/x.webp'), null, 'a key a crawler could not fetch is not preloaded either');
  assert.equal(preloadImagePath('https://cdn.example.com/x.webp'), null);
  assert.equal(preloadImagePath(''), null);
  assert.equal(preloadImagePath(undefined), null);
});

test('the store cover comes from the published hero block, else the banner, and nowhere else', () => {
  const banner = { store: { bannerUrl: '/files/merchants/owner/covers/c.webp', layout: { blocks: [{ type: 'header' }, { type: 'hero', settings: {} }] } } };
  assert.equal(heroCoverFrom(banner), '/files/merchants/owner/covers/c.webp');
  const hero = { store: { bannerUrl: '/files/merchants/owner/covers/c.webp', layout: { blocks: [{ type: 'hero', settings: { image: 'merchants/owner/public/h.webp' } }] } } };
  assert.equal(heroCoverFrom(hero), '/files/merchants/owner/public/h.webp');
  assert.equal(heroCoverFrom({ store: { bannerUrl: null, layout: { blocks: [] } } }), null);
  assert.equal(heroCoverFrom({ store: null }), null);
  assert.equal(heroCoverFrom(null), null);
});

test('the data block cannot be closed by its own contents', () => {
  const tag = inlineJsonScript('lv-resolve', { name: '</script><script>alert(1)</script>', line: 'a\u2028b & <c>' });
  assert.ok(!tag.includes('</script><script>'), 'a value closed the element');
  assert.match(tag, /^<script type="application\/json" id="lv-resolve">/);
  const body = tag.slice(tag.indexOf('>') + 1, -'</script>'.length);
  assert.ok(!/[<>&\u2028\u2029]/.test(body), 'raw markup characters survived');
  assert.deepEqual(JSON.parse(body), { name: '</script><script>alert(1)</script>', line: 'a\u2028b & <c>' }, 'and JSON.parse reads the same value');
});

test('the head start lands just before </head>, after the entry links, and never doubles the data block', () => {
  const once = injectDocumentPreloads(SHELL, { scripts: ['/assets/Product-p1.js'], styles: ['/assets/Product-p1.css'], image: '/files/products/a.webp', resolve: { kind: 'main', store: null } });
  const head = once.slice(0, once.indexOf('</head>'));
  assert.ok(head.indexOf('index-abc.css') < head.indexOf('Product-p1.js'), 'the entry stylesheet comes first');
  assert.match(once, /<link rel="modulepreload" crossorigin href="\/assets\/Product-p1\.js">/);
  assert.match(once, /<link rel="preload" as="style" crossorigin href="\/assets\/Product-p1\.css">/);
  assert.match(once, /<link rel="preload" as="image" fetchpriority="high" href="\/files\/products\/a\.webp">/);
  assert.deepEqual(inline(once), { kind: 'main', store: null });
  const twice = injectDocumentPreloads(once, { scripts: [], styles: [], image: null, resolve: { kind: 'merchant', store: { slug: 's' } } });
  assert.equal((twice.match(/id="lv-resolve"/g) || []).length, 1);
  assert.deepEqual(inline(twice), { kind: 'merchant', store: { slug: 's' } });
  assert.equal(injectDocumentPreloads(SHELL, { scripts: [], styles: [], image: null, resolve: null }), SHELL, 'nothing to add: the bytes as they came');
});

test('the shareable policy is for a viewer-independent document only', () => {
  assert.equal(documentCacheControl(false), DOCUMENT_SHARED_CACHE_CONTROL);
  assert.equal(documentCacheControl(true), DOCUMENT_CACHE_CONTROL);
  assert.equal(DOCUMENT_CACHE_CONTROL, 'no-cache');
  assert.equal(DOCUMENT_SHARED_CACHE_CONTROL, 'public, max-age=0, s-maxage=60', 'no stale-while-revalidate on a document that names chunk hashes (P2 review)');
  // …and the Worker derives it from the session and the cookies of THIS response, nothing else.
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  assert.match(index, /const viewerDependent = !!c\.get\('user'\) \|\| headers\.has\('Set-Cookie'\);/);
  assert.match(index, /documentCacheControl\(viewerDependent\)/);
});

test('dist/_headers gains the Link on the catch-all and unsets it on every rule after', () => {
  const text = ['# c', '/*', '  A: 1', '  Cache-Control: no-cache', '', '# x', '/assets/*', '  ! A', '  A: 1', '', '/sw.js', '  ! A', '  A: 2', ''].join('\n');
  const out = withEarlyHints(text, '</assets/i.css>; rel=preload; as=style') as string;
  const rules = new Map<string, string[]>();
  let current = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(' ')) { current = line.trim(); rules.set(current, []); continue; }
    rules.get(current)!.push(line.trim());
  }
  assert.deepEqual(rules.get('/*'), ['A: 1', 'Cache-Control: no-cache', 'Link: </assets/i.css>; rel=preload; as=style']);
  assert.deepEqual(rules.get('/assets/*'), ['! Link', '! A', 'A: 1']);
  assert.deepEqual(rules.get('/sw.js'), ['! Link', '! A', 'A: 2']);
  assert.equal(withEarlyHints(text, null), text, 'no manifest, no Link, the file as before');
});

test('the client starts only what the document did not answer', () => {
  const started = (path: string, inl: { kind?: unknown } | null) => bootRequests(path, inl, () => undefined);
  assert.deepEqual(started('/', null), [RESOLVE_PATH, HOME_PATH]);
  assert.deepEqual(started('/product/x', null), [RESOLVE_PATH]);
  assert.deepEqual(started('/', { kind: 'main' }), [HOME_PATH], 'the apex product/store documents answer resolve, not home');
  assert.deepEqual(started('/', { kind: 'merchant' }), [], "a store's / is its own home");
  assert.deepEqual(started('/p/x', { kind: 'merchant' }), []);
  assert.equal(RESOLVE_PATH, '/api/storefront/resolve');
  assert.equal(HOME_PATH, '/api/home');
});

// =========================================================================
// the Worker, in place
// =========================================================================

test("a store's home carries its chunk, its cover, the anonymous resolve answer, a fresh ETag, the Link and the shareable policy", async () => {
  const { call } = realWorker();
  const res = await call(STORE_HOST, '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  // The share card still comes first.
  assert.match(html, /<title>Ali 3D<\/title>/);
  // The route's chunk and what it shares with other lazy pages, not the entry's.
  assert.deepEqual(links(html, 'modulepreload'), ['/assets/vendor-react-r1.js', '/assets/Storefront-s1.js', '/assets/vendor-icons-i1.js', '/assets/theme-t1.js']);
  assert.ok(html.includes('<link rel="preload" as="style" crossorigin href="/assets/Storefront-s1.css">'));
  // The cover, as the page will ask for it.
  assert.ok(html.includes('<link rel="preload" as="image" fetchpriority="high" href="/files/merchants/owner/covers/cover.webp">'));
  // The anonymous resolve answer: the same shape the route gives a visitor with no session.
  const data = inline(html);
  assert.ok(data, 'no data block');
  assert.equal(data!.kind, 'merchant');
  assert.equal((data!.store as { slug: string }).slug, 'ali3d');
  assert.equal(data!.root_domain, APEX);
  assert.ok((data!.store as { delivery_to_you?: unknown }).delivery_to_you == null, 'nothing of a viewer in the document');
  const api = await (await call(STORE_HOST, '/api/storefront/resolve')).json() as Record<string, unknown>;
  assert.deepEqual(data, api, 'the block IS the anonymous route answer');
  // Validators and policy.
  const etag = res.headers.get('ETag')!;
  assert.match(etag, /^W\/"[0-9a-f]{32}"$/);
  assert.notEqual(etag, 'W/"asset"', "the asset's own validator must not survive a rewrite");
  assert.equal(res.headers.get('Content-Length'), null);
  assert.equal(res.headers.get('Cache-Control'), DOCUMENT_SHARED_CACHE_CONTROL);
  assert.equal(res.headers.get('Set-Cookie'), null);
  assert.equal(res.headers.get('Link'), `</assets/index-abc.css>; rel=preload; as=style, <${ARABIC_FONT_PRELOAD}>; rel=preload; as=font; crossorigin`);
  assert.match(res.headers.get('Content-Security-Policy') ?? '', /script-src/);
  // The same document twice is the same bytes — and a 304 when the client has it.
  const again = await call(STORE_HOST, '/');
  assert.equal(again.headers.get('ETag'), etag);
  const notModified = await call(STORE_HOST, '/', { 'If-None-Match': etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('ETag'), etag);
  assert.equal(notModified.headers.get('Cache-Control'), DOCUMENT_SHARED_CACHE_CONTROL);
  assert.equal(await notModified.text(), '');
  assert.equal((await call(STORE_HOST, '/', { 'If-None-Match': 'W/"asset"' })).status, 200, "the asset's stale validator never earns a 304");
});

test('a session cookie changes nothing about these documents — they never read it', async () => {
  const { call } = realWorker();
  const anonymous = await call(STORE_HOST, '/');
  const withCookie = await call(STORE_HOST, '/', { Cookie: 'levonis_session=not-a-real-session; other=1' });
  assert.equal(withCookie.headers.get('ETag'), anonymous.headers.get('ETag'));
  assert.equal(await withCookie.text(), await anonymous.text());
  assert.equal(withCookie.headers.get('Cache-Control'), DOCUMENT_SHARED_CACHE_CONTROL);
  // Because the paths the rewrite covers skip the session lookup (worker/index.ts): a
  // signed-in visitor's document is the anonymous one, so it may be shared.
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  assert.match(index, /if \(productSlugFromPath\(path\)\) \{/);
  assert.match(index, /storeHomeRef\(path\) !== null/);
});

test('a response that sets a cookie is not shareable, whatever else it carries', async () => {
  const { call } = realWorker({ setCookie: true });
  const res = await call(STORE_HOST, '/');
  assert.equal(res.status, 200);
  assert.ok(inline(await res.text()), 'still rewritten');
  assert.equal(res.headers.get('Cache-Control'), DOCUMENT_CACHE_CONTROL);
});

test("the platform's product page carries its chunk, its lead image and the apex answer", async () => {
  const { call } = realWorker();
  const res = await call(APEX, '/product/filament-pla?ref=ali');
  const html = await res.text();
  assert.match(html, /<title>خيط PLA<\/title>/);
  assert.deepEqual(links(html, 'modulepreload').slice(1), ['/assets/Product-p1.js', '/assets/vendor-icons-i1.js']);
  const lead = '/files/products/filament-pla/main.webp';
  const responsive = productImagePreload(lead);
  assert.ok(html.includes(`<link rel="preload" as="image" fetchpriority="high" href="${lead}" imagesrcset="${responsive.imageSrcSet}" imagesizes="${responsive.imageSizes}">`));
  assert.deepEqual(inline(html), { success: true, kind: 'main', store: null, root_domain: APEX });
  assert.equal(res.headers.get('Cache-Control'), DOCUMENT_SHARED_CACHE_CONTROL);
  assert.match(res.headers.get('ETag') ?? '', /^W\/"/);
  // A store's product on its host: the store's answer, the product's picture.
  const p = await call(STORE_HOST, '/p/ali3d-bracket');
  const pHtml = await p.text();
  assert.equal((inline(pHtml)!.store as { slug: string }).slug, 'ali3d');
  assert.ok(pHtml.includes('href="/assets/StorefrontProduct-sp1.js"'));
  assert.ok(pHtml.includes('as="image" fetchpriority="high" href="/files/merchants/owner/public/aaaa1111.webp"'));
  assert.doesNotMatch(pHtml, /imagesrcset=|imagesizes=/, 'the merchant gallery still requests its original image; no variant may preload ahead of it');
});

test('every other document passes through as the asset came', async () => {
  const { call, assetCalls } = realWorker();
  for (const [host, path] of [[APEX, '/cart'], [APEX, '/products'], [STORE_HOST, '/products'], [APEX, '/']] as const) {
    const res = await call(host, path);
    assert.equal(res.status, 200, `${host}${path}`);
    assert.equal(res.headers.get('ETag'), 'W/"asset"', `${host}${path}: the asset's own validator`);
    assert.equal(res.headers.get('Cache-Control'), DOCUMENT_CACHE_CONTROL, `${host}${path}: the asset's own policy`);
    assert.equal(inline(await res.text()), null, `${host}${path}: no data block`);
  }
  assert.ok(!assetCalls.includes(MANIFEST_PATH), 'the manifest is not even read for them');
  // A host that names no store: untouched too — the client asks and renders the 404 shape.
  const none = await call(`nostore.${APEX}`, '/');
  assert.equal(none.headers.get('ETag'), 'W/"asset"');
  assert.equal(inline(await none.text()), null);
});

test('without a manifest (an older deploy) the document is still rewritten — only the chunk links are missing', async () => {
  const { call } = realWorker({ manifest: null });
  const res = await call(STORE_HOST, '/');
  const html = await res.text();
  assert.deepEqual(links(html, 'modulepreload'), ['/assets/vendor-react-r1.js'], "the shell's own only");
  assert.ok(inline(html), 'the resolve answer is still there');
  assert.ok(html.includes('as="image" fetchpriority="high"'));
  assert.equal(res.headers.get('Link'), null, 'no stylesheet name, no Early Hints line');
  assert.match(res.headers.get('ETag') ?? '', /^W\/"/);
});

test('the manifest is read from the assets once per isolate (per ASSETS binding), not per document', async () => {
  const { call, assetCalls } = realWorker();
  await call(STORE_HOST, '/');
  await call(APEX, '/product/filament-pla');
  await call(STORE_HOST, '/p/ali3d-bracket');
  assert.equal(assetCalls.filter((p) => p === MANIFEST_PATH).length, 1);
});
