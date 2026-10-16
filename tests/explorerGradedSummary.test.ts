/**
 * «كل الفئات» READS TWO FACTS FOR ITS «المستعمل» BANNER, NOT THE HOME PAGE
 * (speed audit 2026-10-16: the explorer downloaded the whole /api/home — 10 KB
 * on the wire, 47 KB of JSON — to read `open_box`, beside its own 3 KB map).
 *
 *  - `GET /api/home/graded` answers how many graded products the home shelf
 *    holds (its own rows, ≤ 12) and one photograph — off the same cards; no
 *    price, no stock figure; one body for every guest; purged with /api/home;
 *    a database one migration behind (no `condition_doc`) is an empty shelf;
 *  - the explorer asks for it (and for the bundles) once its map has landed,
 *    never beside it; against a Worker without the route (404) it asks the
 *    old way.
 *
 * Run: node --import tsx --test tests/explorerGradedSummary.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { APEX, asD1, ctx, dbThrough, freshDb, json, stubApp } from './fixtures/app';
import { homeRoutes } from '../worker/routes/products';
import { cataloguePaths } from '../worker/lib/edgePolicy';
import { loadGradedSummary } from '../src/lib/catalog/data';
import { clearApiSessionRequests } from '../src/lib/api';

const app = (db: unknown) =>
  stubApp(db as never, null, (a) => a.route('/api/home', homeRoutes), {
    host: APEX,
    env: { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
const read = (a: ReturnType<typeof app>, path: string) => a.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);

function seed(raw: ReturnType<typeof freshDb>, id: string, minute: number, image = '') {
  raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status, images, created_at)
     VALUES (?, ?, ?, '', 100000, 'active', ?, ?)`
  ).run(id, id, id, image ? JSON.stringify([image]) : '[]', `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`);
}
const grade = (raw: ReturnType<typeof freshDb>, id: string) =>
  raw.prepare('UPDATE products SET condition_doc = ? WHERE id = ?').run(JSON.stringify({ kind: 'open_box', grade: 'like_new', warranty_months: 12 }), id);

test('the count and the photograph are the home shelf\'s own — newest first, the first that has a picture', async () => {
  const raw = freshDb();
  seed(raw, 'prd_new', 50, '/files/products/new.webp');
  seed(raw, 'prd_used_a', 40); // the newest graded product has no picture
  seed(raw, 'prd_used_b', 30, '/files/products/used-b.webp');
  seed(raw, 'prd_used_c', 20, '/files/products/used-c.webp');
  for (const id of ['prd_used_a', 'prd_used_b', 'prd_used_c']) grade(raw, id);
  const a = app(asD1(raw));
  const res = await read(a, '/api/home/graded');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /public/, 'one body for every guest');
  const body = await json(res);
  assert.deepEqual(body, { success: true, count: 3, photo: { src: '/files/products/used-b.webp', product_id: 'prd_used_b' } });
  const home = await json(await read(a, '/api/home'));
  assert.equal(home.open_box.length, body.count, 'the very shelf the home page draws');
  assert.equal(home.open_box[1].id, body.photo.product_id);
});

test('nothing graded: zero and no photograph; a database without condition_doc is an empty shelf, not an error', async () => {
  const raw = freshDb();
  seed(raw, 'prd_new', 50, '/files/products/new.webp');
  assert.deepEqual(await json(await read(app(asD1(raw)), '/api/home/graded')), { success: true, count: 0, photo: null });
  const behind = dbThrough('0083');
  const res = await read(app(asD1(behind)), '/api/home/graded');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { success: true, count: 0, photo: null });
});

test('it is purged with the home page', () => {
  assert.ok(cataloguePaths([]).includes('/api/home/graded'));
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiSessionRequests();
});

test('the explorer\'s loader: the two facts; against a Worker without the route, the old read', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (path: string) => {
    asked.push(path);
    return Response.json({ success: true, count: 2, photo: { src: '/files/products/u.webp', product_id: 'p1' } });
  }) as typeof fetch;
  assert.deepEqual(await loadGradedSummary(), { count: 2, photo: { src: '/files/products/u.webp', product_id: 'p1' } });
  globalThis.fetch = (async (path: string) => {
    asked.push(path);
    if (path === '/api/home/graded') return Response.json({ success: false, error: 'Not found' }, { status: 404 });
    return Response.json({ success: true, open_box: [{ id: 'p9', images: [] }, { id: 'p8', images: ['/files/products/p8.webp'] }] });
  }) as typeof fetch;
  assert.deepEqual(await loadGradedSummary(), { count: 2, photo: { src: '/files/products/p8.webp', product_id: 'p8' } });
  assert.deepEqual(asked, ['/api/home/graded', '/api/home/graded', '/api/home']);
});

test('the explorer asks for its two extra banners once the map has landed, and never reads /api/home', () => {
  const page = readFileSync(join(ROOT, 'src/pages/CategoriesExplorer.tsx'), 'utf8');
  assert.doesNotMatch(page, /fetchGradedStock|\/api\/home['"`]/);
  assert.match(page, /const mapped = !!tree;\s+useEffect\(\(\) => \{\s+if \(!mapped\) return;\s+let alive = true;\s+loadGradedSummary\(\)/);
  assert.match(page, /\}, \[mapped\]\);/);
});
