/**
 * THE CATEGORY MAP AND THE COMMUNITY HOME GET THE HEAD START /products HAS
 * (speed audit 2026-10-16, findings «category and other non-rewritten pages
 * get no head start» and «category listing pages load as a 5-step serial
 * waterfall»; worker/lib/socialPreview.ts `mainOpeningFor`).
 *
 * Before, `/categories*` and `/community` were answered by the asset layer as
 * the bare shell: the app waited for `/api/storefront/resolve`, then asked for
 * its page's chunks, then the page asked for its first read — three round
 * trips one after another (live phone LCP ≈6.0 s on a category page against
 * 3.3 s on /products). Proved here on the real Worker with a fake asset layer:
 *
 *   - each document carries the main host's resolve answer, the modulepreloads
 *     of its page's closure and a `preload as=fetch` of exactly the URL its
 *     page reads first (the page's own code is read to prove it);
 *   - the document stays shareable (no session read, no price, a fresh ETag
 *     and a 304), and a store host's same paths pass through untouched;
 *   - every path is in `run_worker_first` in all three environments.
 *
 * Run: node --import tsx --test tests/mainOpeningDocuments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { APEX, asD1, ctx, freshDb } from './fixtures/app';
import { fetchPublished } from './fixtures/autoPublish';
import worker from '../worker/index';
import {
  DOCUMENT_SHARED_CACHE_CONTROL,
  INLINE_RESOLVE_ID,
  MANIFEST_PATH,
  mainOpeningFor,
  type ViteManifest,
} from '../worker/lib/socialPreview';
import { DOCUMENT_CACHE_CONTROL } from '../worker/lib/securityPolicy';
import { bootRequests, productsOpeningPath } from '../src/lib/bootFetch';

const MANIFEST: ViteManifest = {
  'index.html': { file: 'assets/index-abc.js', isEntry: true, imports: ['_vendor-react-r1.js'], css: ['assets/index-abc.css'] },
  '_vendor-react-r1.js': { file: 'assets/vendor-react-r1.js' },
  '_catalog-c1.js': { file: 'assets/catalog-c1.js', imports: ['_vendor-react-r1.js'], css: ['assets/catalog-c1.css'] },
  '_listing-l1.js': { file: 'assets/listing-l1.js', imports: ['_catalog-c1.js'] },
  'src/pages/CategoriesExplorer.tsx': { file: 'assets/CategoriesExplorer-e1.js', isDynamicEntry: true, imports: ['_catalog-c1.js'] },
  'src/pages/CategoryPage.tsx': { file: 'assets/CategoryPage-p1.js', isDynamicEntry: true, imports: ['_catalog-c1.js', '_listing-l1.js'] },
  'src/pages/CategoryListing.tsx': { file: 'assets/CategoryListing-l1.js', isDynamicEntry: true, imports: ['_listing-l1.js'] },
  'src/pages/Community.tsx': { file: 'assets/Community-k1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'] },
  'src/pages/Products.tsx': { file: 'assets/Products-x1.js', isDynamicEntry: true, imports: ['_listing-l1.js'] },
};

const SHELL = [
  '<!doctype html><html lang="ar" dir="rtl"><head>',
  '<meta charset="utf-8" />',
  '<title>LEVONIS</title>',
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/vendor-react-r1.js">',
  '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

function realWorker() {
  const raw = freshDb();
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname === MANIFEST_PATH) return new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/json' } });
        return new Response(SHELL, {
          headers: { 'content-type': 'text/html; charset=utf-8', etag: 'W/"asset"', 'cache-control': DOCUMENT_CACHE_CONTROL, 'content-length': String(SHELL.length) },
        });
      },
    },
  };
  const statements: string[] = [];
  const db = env.DB as unknown as { prepare: (sql: string) => unknown };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    statements.push(sql);
    return prepare(sql);
  };
  const call = (host: string, path: string, headers: Record<string, string> = {}) =>
    fetchPublished(worker, new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', ...headers } }), env as never, ctx);
  return { call, statements };
}

const inline = (html: string): Record<string, unknown> | null => {
  const m = new RegExp(`<script type="application/json" id="${INLINE_RESOLVE_ID}">([\\s\\S]*?)</script>`).exec(html);
  return m ? (JSON.parse(m[1]) as Record<string, unknown>) : null;
};
const links = (html: string, rel: string) => [...html.matchAll(new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`, 'g'))].map((m) => m[1]);
const fetches = (html: string) => [...html.matchAll(/<link rel="preload" as="fetch" crossorigin href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ------------------------------------------------------------------- the map

test('the opening map: each document, its page module and the first read that page makes', () => {
  assert.deepEqual(mainOpeningFor('/categories'), { route: 'src/pages/CategoriesExplorer.tsx', fetches: ['/api/catalog/tree'] });
  assert.deepEqual(mainOpeningFor('/categories/'), mainOpeningFor('/categories'));
  assert.deepEqual(mainOpeningFor('/categories/printer-accessories'), { route: 'src/pages/CategoryPage.tsx', fetches: ['/api/catalog/printer-accessories'] });
  assert.deepEqual(mainOpeningFor('/categories/printing-materials/fdm-materials'), { route: 'src/pages/CategoryListing.tsx', fetches: ['/api/catalog/tree'] });
  assert.deepEqual(mainOpeningFor('/categories/printers/all'), { route: 'src/pages/CategoryListing.tsx', fetches: ['/api/catalog/tree'] });
  assert.deepEqual(mainOpeningFor('/community'), { route: null, fetches: ['/api/community/access'] }, 'the gate decides whether the page code is needed at all');
  // The two that had it already keep exactly what they had.
  assert.deepEqual(mainOpeningFor('/'), { route: null, fetches: ['/api/home'] });
  assert.deepEqual(mainOpeningFor('/products', '?category=cat%26x&search=PLA&debug=1'), {
    route: 'src/pages/Products.tsx',
    fetches: [productsOpeningPath('?category=cat%26x&search=PLA&debug=1')],
  });
  // A slug is written back the way the page writes it (useParams decodes, encodeURIComponent encodes).
  const arabic = 'طباعة';
  assert.deepEqual(mainOpeningFor(`/categories/${encodeURIComponent(arabic)}`)?.fetches, [`/api/catalog/${encodeURIComponent(arabic)}`]);
  assert.deepEqual(mainOpeningFor('/categories/%E0%A4%A')?.fetches, [], 'an undecodable slug names no read');
  assert.deepEqual(mainOpeningFor('/categories/a%2Fb')?.fetches, [], 'nor one that would leave its path');
  for (const other of ['/cart', '/categories/a/b/c', '/community/posts', '/product/x', '/auth']) assert.equal(mainOpeningFor(other), null, other);
});

test('the map mirrors the app: the same lazy pages, and the very reads those pages make first', () => {
  const app = read('src/App.tsx');
  for (const [route, page] of [
    ['/categories', 'CategoriesExplorer'],
    ['/categories/:categorySlug', 'CategoryPage'],
    ['/categories/:categorySlug/:subCategorySlug', 'CategoryListing'],
  ]) {
    assert.match(app, new RegExp(`<Route path="${route.replace(/\//g, '\\/')}" element=\\{<${page} />\\} />`), route);
    assert.match(app, new RegExp(`const ${page} = React\\.lazy\\(\\(\\) => import\\('\\./pages/${page}'\\)\\)`), page);
  }
  assert.match(app, /<Route path="\/community" element=\{<CommunityGate><Community \/><\/CommunityGate>\} \/>/);
  assert.match(app, /const Community = React\.lazy\(\(\) => import\('\.\/pages\/Community'\)\)/);
  // The reads, spelled as the document names them.
  const data = read('src/lib/catalog/data.ts');
  assert.match(data, /api\.get<CatalogTreeResponse>\('\/api\/catalog\/tree', opts\)/);
  assert.match(data, /api\.get<CategoryPayload>\(`\/api\/catalog\/\$\{encodeURIComponent\(slug\)\}`, opts\)/);
  assert.match(read('src/pages/CategoryPage.tsx'), /loadCategory\(categorySlug\)/);
  assert.match(read('src/pages/CategoryListing.tsx'), /loadTree\(\)/);
  assert.match(read('src/pages/CategoriesExplorer.tsx'), /loadTree\(\)/);
  assert.match(read('src/pages/community/access.tsx'), /api\.get<unknown>\('\/api\/community\/access'\)/);
  // …with no header and the session's credentials — the request a `preload as=fetch crossorigin` matches.
  assert.match(read('src/lib/api.ts'), /const init: RequestInit = \{ method, credentials: 'same-origin', headers: \{ \.\.\.opts\?\.headers \} \};/);
});

test('every opening path runs the Worker first, in all three environments', () => {
  const blocks = read('wrangler.jsonc').match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    for (const route of ['/', '/products', '/categories', '/categories/*', '/community']) assert.ok(block.includes(`"${route}"`), `${route} missing from a run_worker_first block`);
  }
});

// ---------------------------------------------------------------- in place

test('a category page carries its page code, its first read and the resolve answer — and the app starts nothing the document answered', async () => {
  const { call, statements } = realWorker();
  const res = await call(APEX, '/categories/printer-accessories');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.deepEqual(inline(html), { success: true, kind: 'main', store: null, root_domain: APEX });
  assert.deepEqual(fetches(html), ['/api/catalog/printer-accessories']);
  assert.deepEqual(
    links(html, 'modulepreload'),
    ['/assets/vendor-react-r1.js', '/assets/CategoryPage-p1.js', '/assets/catalog-c1.js', '/assets/listing-l1.js'],
    "the shell's own, then the page's closure beyond the entry"
  );
  assert.deepEqual(links(html, 'preload').filter((h) => h.endsWith('.css')), ['/assets/catalog-c1.css']);
  assert.equal(statements.length, 0, 'no database read on the document');
  assert.equal(res.headers.get('Cache-Control'), DOCUMENT_SHARED_CACHE_CONTROL);
  assert.notEqual(res.headers.get('ETag'), 'W/"asset"', 'a validator of the rewritten body');
  const again = await call(APEX, '/categories/printer-accessories', { 'If-None-Match': res.headers.get('ETag')! });
  assert.equal(again.status, 304);
  // The client reads the inline answer and asks for no resolve of its own.
  assert.deepEqual(bootRequests('/categories/printer-accessories', inline(html) as { kind: string }, () => undefined, '', APEX), []);
});

test('the explorer, a listing and the community home each name their own page and read', async () => {
  const { call } = realWorker();
  const cases: Array<[string, string | null, string[]]> = [
    ['/categories', '/assets/CategoriesExplorer-e1.js', ['/api/catalog/tree']],
    ['/categories/printing-materials/fdm-materials', '/assets/CategoryListing-l1.js', ['/api/catalog/tree']],
    ['/community', null, ['/api/community/access']],
  ];
  for (const [path, chunk, reads] of cases) {
    const html = await (await call(APEX, path)).text();
    if (chunk) assert.ok(links(html, 'modulepreload').includes(chunk), `${path}: ${chunk}`);
    else assert.deepEqual(links(html, 'modulepreload'), ['/assets/vendor-react-r1.js'], `${path}: the shell's own only`);
    assert.deepEqual(fetches(html), reads, path);
    assert.equal(inline(html)?.kind, 'main', path);
  }
});

test('a session cookie changes nothing: the document reads no session and stays one shareable body', async () => {
  const { call, statements } = realWorker();
  const guest = await (await call(APEX, '/categories')).text();
  const signed = await call(APEX, '/categories', { Cookie: 'levonis_session=not-a-real-session' });
  assert.equal(await signed.text(), guest);
  assert.equal(signed.headers.get('Cache-Control'), DOCUMENT_SHARED_CACHE_CONTROL);
  assert.equal(statements.length, 0, 'no sessions × users JOIN for the shell');
  // (The counter counts: a path outside the map loads the session for the same cookie.)
  await call(APEX, '/cart', { Cookie: 'levonis_session=not-a-real-session' });
  assert.ok(statements.some((sql) => /FROM sessions/i.test(sql)), statements.join('\n'));
});

test("a store host's same paths pass through as the asset came", async () => {
  const { call } = realWorker();
  for (const path of ['/categories', '/categories/x', '/community']) {
    const res = await call(`ali3d.${APEX}`, path);
    assert.equal(res.headers.get('ETag'), 'W/"asset"', path);
    assert.equal(res.headers.get('Cache-Control'), DOCUMENT_CACHE_CONTROL, path);
    assert.equal(inline(await res.text()), null, path);
  }
});
