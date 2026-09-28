/**
 * THE PUBLIC READ-ONLY API — `/api/public/v1/*` (worker/routes/publicApi.ts).
 *
 * The owner's rule: «Public API يستطيع إرجاع فقط البيانات التي يستطيع الزائر
 * غير المسجل رؤيتها بالفعل … يُمنع تمامًا كشف cost prices, profits,
 * suppliers, internal notes, customer information, orders, private inventory
 * information, admin data, sessions, tokens, secrets, private IDs». Every test
 * here drives the REAL worker (worker/index.ts `fetch`), so the session
 * skip-list, the host guard, CORS and the error envelope are the production
 * ones.
 *
 *   NOTHING PRIVATE LEAVES. The database is seeded with a secret marker in
 *     every private place — cost prices, SKUs, supplier links on pictures, a
 *     customer's e-mail and phone, a password hash, a session, an order, bank
 *     details in the settings, drafts, hidden products, a pending review — and
 *     every endpoint is crawled; no marker, no internal id and no forbidden
 *     key may appear in any answer.
 *   THE SCHEMA IS THE ALLOWLIST. Every answer is validated against the schema
 *     /openapi.json publishes for it, with no extra property allowed.
 *   ANONYMOUS. An admin's session cookie changes nothing — no session is even
 *     read — and prices are the visitor's.
 *   READ-ONLY. Every other method is a 405 and nothing in the database moves.
 *   A GOOD CITIZEN. CORS for any origin, HEAD, ETag/304, a 429 with
 *     Retry-After, pagination that visits every item exactly once, the main
 *     host only, robots.txt allowing it.
 *
 * Run: node --import tsx --test tests/publicApi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, MERCHANT_HOST, asD1, ctx, freshDb } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { validate } from './fixtures/jsonSchema';
import worker from '../worker/index';
import { sha256Hex } from '../worker/lib/crypto';
import { ALL_ROUTES } from '../worker/lib/publicApi/meta';
import type { PublicRoute } from '../worker/lib/publicApi/types';

const ORIGIN = `https://${APEX}`;
const IP = '203.0.113.7';
const ADMIN_TOKEN = 'public-api-admin-session-token-7Q';

/** A marker in every private place; none may appear in any public answer. */
const SECRETS = [
  '987654321', // product_cost_iqd
  'SKU-SECRET-7Q',
  'supplier-secret.example',
  'leak-check@example.com',
  '+9647700000099',
  'HASH-SECRET-7Q',
  'Leaky Customer',
  'IBAN-SECRET-7Q',
  'DRAFT-SECRET-NAME',
  'HIDDEN-SECRET-NAME',
  'PENDING-REVIEW-SECRET',
  'MODERATION-SECRET-7Q',
  'SECRET-SECTION',
  'SUPPLIER-SECRET-7Q',
  'ADMIN-NOTE-SECRET-7Q',
  ADMIN_TOKEN,
];

/** Keys no public answer may carry, at any depth. */
const FORBIDDEN_KEY =
  /^(id|.*_id|.*cost.*|.*profit.*|.*supplier.*|sku|sku_part|source_url|stock|stock_reserved|reserved|low_stock_threshold|capacity|email|phone.*|password.*|token|session.*|.*_note|moderation.*|admin.*|merged_into|group_en|.*_adjust_iqd|pro_price_iqd|prime_price_iqd|rule_id|.*_key|r2_key)$/i;

/** Internal database ids (prd_…, cat_…, brd_…, usr_…); slugs are the public identifiers. */
const INTERNAL_ID = /\b(prd|cat|brd|usr|ord|mer|str|rev|ses)_[A-Za-z0-9]{2,}/;

const GALLERY_KEY = 'products/p1/gallery/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0.webp';

async function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const first = raw.prepare("SELECT id, slug FROM products WHERE status = 'active' AND composition = '' ORDER BY id LIMIT 1").get() as {
    id: string;
    slug: string;
  };
  // Internal columns, everywhere.
  raw.exec(`UPDATE products SET product_cost_iqd = 987654321, sku = 'SKU-SECRET-7Q-' || id, stock_reserved = 1, low_stock_threshold = 3`);
  // One product with a real gallery whose picture carries a supplier link.
  raw.prepare('UPDATE products SET images = ?, description = ?, name_ar = ? WHERE id = ?').run(
    JSON.stringify([
      {
        id: 'img1',
        url: `/files/${GALLERY_KEY}`,
        key: GALLERY_KEY,
        role: 'gallery',
        alt_ar: 'صورة',
        alt_en: 'Picture',
        alt_ckb: '',
        order: 0,
        primary: true,
        width: 1600,
        height: 1600,
        source_url: 'https://supplier-secret.example/original.jpg',
        option_value_id: '',
        color_id: '',
        variant_id: '',
      },
    ]),
    'A public description.',
    'منتج عام',
    first.id
  );
  // What a visitor must never see.
  raw.exec(`INSERT INTO products (id, slug, name, description, price_iqd, status, category_id)
            VALUES ('prd_draft7q', 'draft-secret-product', 'DRAFT-SECRET-NAME', '', 1000, 'draft', 'cat_printers'),
                   ('prd_hidden7q', 'hidden-secret-product', 'HIDDEN-SECRET-NAME', '', 1000, 'hidden', 'cat_printers')`);
  raw.exec(`INSERT INTO catalogs (id, slug, name_ar, name_en, name_ckb, active) VALUES ('cat_secret7q', 'secret-section', 'SECRET-SECTION', 'SECRET-SECTION', '', 0)`);
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, username, phone_e164)
            VALUES ('usr_leak7q', 'Leaky Customer', 'leak-check@example.com', 'HASH-SECRET-7Q', 'customer', 'leaky', '+9647700000099'),
                   ('usr_other7q', 'Other Buyer', 'other@x.co', 'HASH-SECRET-7Q', 'customer', 'other', NULL),
                   ('usr_boss7q', 'Boss', 'boss@x.co', 'HASH-SECRET-7Q', 'admin', 'boss', NULL)`);
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    await sha256Hex(ADMIN_TOKEN),
    'usr_boss7q',
    new Date(Date.now() + 86_400_000).toISOString()
  );
  raw.prepare(
    `INSERT INTO reviews (id, user_id, product_id, stars, body, status, moderation_note, created_at, source)
     VALUES ('rev_pub7q', 'usr_leak7q', ?, 4, 'Great nozzle.', 'published', 'MODERATION-SECRET-7Q', '2026-09-01T10:00:00.000Z', 'user'),
            ('rev_pen7q', 'usr_other7q', ?, 1, 'PENDING-REVIEW-SECRET', 'pending', '', '2026-09-02T10:00:00.000Z', 'user')`
  ).run(first.id, first.id);
  raw.prepare(`INSERT INTO admin_settings (key, value) VALUES ('paymentMethods', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify([{ id: 'zain', name: 'Zain Cash', details: 'IBAN-SECRET-7Q' }])
  );
  raw.exec(`INSERT INTO inventory_suppliers (id, name, notes) VALUES ('sup_7q', 'SUPPLIER-SECRET-7Q', 'ADMIN-NOTE-SECRET-7Q')`);

  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: ORIGIN,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; host?: string } = {}) => {
    const host = init.host ?? APEX;
    return worker.fetch(
      new Request(`https://${host}${path}`, {
        method: init.method ?? 'GET',
        headers: { Host: host, 'CF-Connecting-IP': IP, ...(init.headers ?? {}) },
      }),
      env as never,
      ctx
    );
  };
  return { raw, env, call, first };
}

/** Every GET the API has, with real values for its path parameters. */
function concrete(route: PublicRoute, first: { slug: string }): string[] {
  const base = `/api/public/v1${route.path === '/' ? '' : route.path}`;
  if (!route.path.includes('{')) {
    const extra = route.example && route.example.includes('?') && !route.example.includes('{') ? `/api/public/v1${route.example}` : null;
    const needsQuery = (route.params ?? []).some((p) => p.in === 'query' && p.required);
    if (needsQuery) return [extra ?? base];
    return extra ? [base, extra] : [base];
  }
  if (route.path.startsWith('/products/')) return [base.replace('{slug}', first.slug)];
  if (route.path === '/sections/{slug}') return [base.replace('{slug}', 'printers')];
  if (route.path === '/brands/{slug}') return [base.replace('{slug}', 'snapmaker')];
  if (route.path === '/policies/{key}') return [base.replace('{key}', 'returns'), base.replace('{key}', 'privacy')];
  return [];
}

function scanKeys(value: unknown, path: string, out: string[]) {
  if (Array.isArray(value)) value.forEach((v, i) => scanKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${path}.${k}`);
      scanKeys(v, `${path}.${k}`, out);
    }
  }
}

// =========================================================================
// NOTHING PRIVATE LEAVES
// =========================================================================

test('every endpoint answers, and no answer carries a secret, an internal id or a forbidden key', async () => {
  const { call, first } = await world();
  const openapi = (await (await call('/api/public/v1/openapi.json')).json()) as { paths: Record<string, unknown> };
  let crawled = 0;
  for (const route of ALL_ROUTES) {
    for (const path of concrete(route, first)) {
      const res = await call(path);
      assert.equal(res.status, 200, `${path} → ${res.status}: ${await res.clone().text()}`);
      const text = await res.text();
      crawled++;
      for (const s of SECRETS) assert.ok(!text.includes(s), `${path} leaks «${s}»`);
      // The OpenAPI document and /context describe fields by name; only data is scanned for keys and ids.
      if (route.path === '/openapi.json') continue;
      const m = INTERNAL_ID.exec(text);
      assert.equal(m, null, `${path} carries an internal id: ${m?.[0]}`);
      if (route.path === '/context') continue;
      const bad: string[] = [];
      scanKeys(JSON.parse(text), '$', bad);
      assert.deepEqual(bad, [], `${path} carries forbidden keys`);
    }
  }
  assert.ok(crawled >= Object.keys(openapi.paths).length, 'every documented path was crawled');
});

test('drafts, hidden products and inactive sections are not public, even by slug', async () => {
  const { call } = await world();
  for (const path of [
    '/api/public/v1/products/draft-secret-product',
    '/api/public/v1/products/hidden-secret-product',
    '/api/public/v1/products/draft-secret-product/reviews',
    '/api/public/v1/sections/secret-section',
  ]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    const body = (await res.json()) as { success: boolean; code?: string };
    assert.equal(body.success, false);
  }
  const search = await (await call('/api/public/v1/search?q=DRAFT-SECRET-NAME')).text();
  assert.ok(!search.includes('draft-secret-product'));
});

test('a review is public only once published, with the reviewer masked and no photo URLs', async () => {
  const { call, first } = await world();
  const body = (await (await call(`/api/public/v1/products/${first.slug}/reviews`)).json()) as {
    data: { count: number; reviews: Array<{ reviewer: string; text: string; photo_count: number }> };
  };
  assert.equal(body.data.count, 1, 'the pending review is not counted');
  assert.equal(body.data.reviews[0].text, 'Great nozzle.');
  assert.equal(body.data.reviews[0].reviewer, 'Leaky C.', 'the site\'s own mask (maskName), never the full name');
  assert.equal(body.data.reviews[0].photo_count, 0);
  assert.ok(!/Leaky Customer/.test(JSON.stringify(body)));
});

// =========================================================================
// THE SCHEMA IS THE ALLOWLIST
// =========================================================================

test('every answer matches the schema /openapi.json publishes for it — no field more, none missing', async () => {
  const { call, first } = await world();
  const doc = (await (await call('/api/public/v1/openapi.json')).json()) as {
    paths: Record<string, { get: { responses: { '200': { content: { 'application/json': { schema: Record<string, unknown> } } } } } }>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  for (const route of ALL_ROUTES) {
    if (route.path === '/openapi.json' || route.path === '/context') continue;
    const schema = doc.paths[route.path].get.responses['200'].content['application/json'].schema;
    for (const path of concrete(route, first)) {
      const body = await (await call(path)).json();
      const errors = validate(body, schema, doc.components.schemas);
      assert.deepEqual(errors.slice(0, 5), [], `${path} does not match its schema`);
    }
  }
});

test('/openapi.json is a complete OpenAPI 3.1 document of exactly the served endpoints', async () => {
  const { call } = await world();
  interface Param { name: string; in: string; required?: boolean }
  interface OpenApiDoc {
    openapi: string;
    servers: Array<{ url: string }>;
    paths: Record<string, { get: { operationId: string; parameters: Param[] } }>;
    components: Record<string, Record<string, unknown>>;
  }
  const doc = (await (await call('/api/public/v1/openapi.json')).json()) as OpenApiDoc;
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0].url, `${ORIGIN}/api/public/v1`);
  assert.deepEqual(Object.keys(doc.paths).sort(), ALL_ROUTES.map((r) => r.path).sort());
  const ids = Object.values(doc.paths).map((p) => p.get.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  for (const [path, item] of Object.entries(doc.paths)) {
    assert.deepEqual(Object.keys(item), ['get'], `${path}: GET only`);
    for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
      assert.ok(item.get.parameters.some((p) => p.name === name && p.in === 'path' && p.required), `${path} documents {${name}}`);
    }
  }
  // Every $ref resolves.
  const refs = new Set<string>();
  JSON.stringify(doc, (k, v) => (k === '$ref' && typeof v === 'string' ? (refs.add(v), v) : v));
  for (const r of refs) {
    const [, section, name] = /^#\/components\/(schemas|responses)\/(.+)$/.exec(r) ?? [];
    assert.ok(section && doc.components[section][name], `unresolvable ${r}`);
  }
});

test('/context introduces the API to an agent: conventions, where to start, every endpoint', async () => {
  const { call } = await world();
  const res = await call('/api/public/v1/context');
  assert.equal(res.status, 200);
  interface ContextDoc {
    base_url: string;
    openapi_url: string;
    access: { authentication: string; methods: string[] };
    conventions: Record<string, string>;
    resources: Array<{ endpoints: Array<{ path: string }> }>;
    content: { products: number; community_open_to_visitors: boolean };
  }
  const doc = (await res.json()) as ContextDoc;
  assert.equal(doc.base_url, `${ORIGIN}/api/public/v1`);
  assert.equal(doc.openapi_url, `${ORIGIN}/api/public/v1/openapi.json`);
  assert.equal(doc.access.authentication, 'none');
  assert.deepEqual(doc.access.methods, ['GET', 'HEAD']);
  for (const k of ['envelope', 'languages', 'currency', 'prices', 'identifiers', 'pagination', 'images', 'errors', 'caching', 'rate_limits']) {
    assert.ok(typeof doc.conventions[k] === 'string' && doc.conventions[k].length > 20, `conventions.${k}`);
  }
  const listed = doc.resources.flatMap((r) => r.endpoints.map((e) => e.path)).sort();
  assert.deepEqual(listed, ALL_ROUTES.map((r) => r.path).sort());
  assert.ok(doc.content.products > 0);
  assert.equal(doc.content.community_open_to_visitors, false, 'the community is closed by default');
});

// =========================================================================
// ANONYMOUS
// =========================================================================

test('an admin session cookie changes nothing, and no session is even read', async () => {
  const { call, first, env } = await world();
  const counted = { sessions: 0 };
  const db = env.DB as D1Database;
  (env as { DB: unknown }).DB = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (/\bsessions\b/i.test(sql)) counted.sessions += 1;
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  for (const path of ['/api/public/v1/products?limit=5', `/api/public/v1/products/${first.slug}`, '/api/public/v1/home', '/api/public/v1/site']) {
    const anon = await (await call(path)).text();
    const admin = await (await call(path, { headers: { Cookie: `levonis_session=${ADMIN_TOKEN}` } })).text();
    assert.equal(admin, anon, `${path}: the same answer with and without a session`);
  }
  assert.equal(counted.sessions, 0, 'no session lookup on the public API');
});

// =========================================================================
// READ-ONLY
// =========================================================================

test('every write method is refused with 405 and changes nothing', async () => {
  const { call, raw, first } = await world();
  const before = JSON.stringify(raw.prepare('SELECT COUNT(*) AS n, SUM(price_iqd) AS s FROM products').get());
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/public/v1/products', `/api/public/v1/products/${first.slug}`, '/api/public/v1/anything']) {
      const res = await call(path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('Allow'), 'GET, HEAD, OPTIONS');
      assert.equal(((await res.json()) as { code: string }).code, 'METHOD_NOT_ALLOWED');
    }
  }
  // A cross-origin write never even gets that far.
  const cross = await call('/api/public/v1/products', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(JSON.stringify(raw.prepare('SELECT COUNT(*) AS n, SUM(price_iqd) AS s FROM products').get()), before);
});

// =========================================================================
// A GOOD CITIZEN
// =========================================================================

test('CORS: any origin may read, without credentials; the preflight is answered', async () => {
  const { call } = await world();
  const res = await call('/api/public/v1/site', { headers: { Origin: 'https://agent.example' } });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  const pre = await call('/api/public/v1/products', { method: 'OPTIONS', headers: { Origin: 'https://agent.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(pre.headers.get('Access-Control-Allow-Methods') ?? '', /GET, HEAD, OPTIONS/);
  const err = await call('/api/public/v1/products/no-such-product');
  assert.equal(err.status, 404);
  assert.equal(err.headers.get('Access-Control-Allow-Origin'), '*', 'errors are readable too');
});

test('HEAD answers without a body; ETag + If-None-Match answer 304; Cache-Control is public', async () => {
  const { call } = await world();
  const get = await call('/api/public/v1/sections');
  const etag = get.headers.get('ETag');
  assert.match(etag ?? '', /^W\/"[0-9a-f]{32}"$/);
  assert.match(get.headers.get('Cache-Control') ?? '', /^public, max-age=\d+, s-maxage=\d+$/);
  const head = await call('/api/public/v1/sections', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.equal(head.headers.get('ETag'), etag);
  const again = await call('/api/public/v1/sections', { headers: { 'If-None-Match': etag! } });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0);
});

test('over the limit: 429 with Retry-After; the limit counts per IP', async () => {
  const { call, raw } = await world();
  const now = Math.floor(Date.now() / 1000);
  raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)').run(`public-v1:${IP}`, now - (now % 60), 240);
  const res = await call('/api/public/v1/site');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal(((await res.json()) as { code: string }).code, 'RATE_LIMITED');
  const other = await call('/api/public/v1/site', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal(other.status, 200, 'another address is not affected');
});

test('pagination visits every product exactly once, and the total agrees', async () => {
  const { call } = await world();
  const seen: string[] = [];
  let url: string | null = '/api/public/v1/products?limit=4';
  let total: number | null = null;
  for (let guard = 0; url && guard < 20; guard++) {
    const body = (await (await call(url)).json()) as {
      data: Array<{ slug: string }>;
      meta: { pagination: { total: number | null; next_cursor: string | null } };
      links: { next: string | null };
    };
    total = body.meta.pagination.total;
    seen.push(...body.data.map((p) => p.slug));
    url = body.links.next ? body.links.next.replace(ORIGIN, '') : null;
  }
  assert.equal(new Set(seen).size, seen.length, 'no product twice');
  assert.equal(seen.length, total);
  assert.ok(!seen.includes('draft-secret-product'));
});

test('parameters are validated; an unknown one is ignored; a forged cursor is refused', async () => {
  const { call } = await world();
  const bad = await call('/api/public/v1/products?min_price=cheap');
  assert.equal(bad.status, 400);
  assert.deepEqual(((await bad.json()) as { code: string; details: unknown }).code, 'BAD_PARAM');
  const sort = await call('/api/public/v1/products?sort=random');
  assert.equal(sort.status, 400);
  const cursor = await call('/api/public/v1/products?cursor=not-a-cursor');
  assert.equal(cursor.status, 400);
  assert.equal(((await cursor.json()) as { code: string }).code, 'INVALID_CURSOR');
  const ignored = (await (await call('/api/public/v1/brands?utm_source=agent')).json()) as { links: { self: string } };
  assert.equal(ignored.links.self, `${ORIGIN}/api/public/v1/brands`, 'an undeclared parameter never reaches the query or the cache key');
  const big = (await (await call('/api/public/v1/products?limit=1000')).json()) as { meta: { pagination: { limit: number } } };
  assert.equal(big.meta.pagination.limit, 50, 'a large limit is clamped, not refused');
  const search = await call('/api/public/v1/search');
  assert.equal(search.status, 400, 'q is required');
});

test('pictures are absolute URLs to the original public files — never a supplier link', async () => {
  const { call, first } = await world();
  const body = (await (await call(`/api/public/v1/products/${first.slug}`)).json()) as {
    data: { images: Array<{ url: string; width: number; height: number; alt: { en: string } }>; name: { ar: string } };
  };
  assert.deepEqual(body.data.images, [
    { url: `${ORIGIN}/files/${GALLERY_KEY}`, width: 1600, height: 1600, alt: { ar: 'صورة', en: 'Picture', ckb: '' } },
  ]);
  assert.equal(body.data.name.ar, 'منتج عام');
  const list = (await (await call('/api/public/v1/products?limit=50')).json()) as { data: Array<{ slug: string; image: { url: string } | null }> };
  assert.equal(list.data.find((p) => p.slug === first.slug)?.image?.url, `${ORIGIN}/files/${GALLERY_KEY}`);
});

test('the main site only: a store\'s subdomain does not serve the platform API', async () => {
  const { call } = await world();
  const res = await call('/api/public/v1/site', { host: MERCHANT_HOST });
  assert.equal(res.status, 404);
});

test('the index answers at /api/public/v1 and /api/public/v1/', async () => {
  const { call } = await world();
  for (const path of ['/api/public/v1', '/api/public/v1/']) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    const body = (await res.json()) as { context_url: string; read_only: boolean };
    assert.equal(body.context_url, `${ORIGIN}/api/public/v1/context`);
    assert.equal(body.read_only, true);
  }
});

test('robots.txt lets agents fetch the public API while /api/ stays disallowed', async () => {
  const { call } = await world();
  const robots = await (await call('/robots.txt')).text();
  assert.match(robots, /^Allow: \/api\/public\/v1\/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.ok(robots.indexOf('Allow: /api/public/v1/') < robots.indexOf('Disallow: /api/'));
});
