/**
 * GET /store-icon/<name> — EVERY HOST'S OWN HOME-SCREEN AND TAB ICON
 * (merchant platform W2-D).
 *
 * `index.html` is one document on every host, so it links these stable paths
 * and the Worker answers each per Host: a store's host gets the store's PNG
 * rendition of its CURRENT logo; the apex — and every host with no servable
 * store icon — gets the platform's committed PNG for the same role, read
 * through the asset binding. Driven through the real Worker entry point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APEX, MERCHANT_HOST, asD1, ctx, freshDb, pending } from './fixtures/app';
import { fixtureWebp, iconEnv, imagesStub } from './fixtures/storeIcons';
import worker from '../worker/index';
import { PLATFORM_ICON_FOR_ROLE, STORE_ICON_PATHS, refreshStoreIcons } from '../worker/lib/storeIcons';
import { STORE_ICON_CACHE_CONTROL } from '../worker/routes/manifest';

const repo = (p: string) => new URL(`../${p}`, import.meta.url);
const LOGO = 'merchants/u1/public/abc12345.webp';

/** The asset layer: the committed PNGs under /icons/, the SPA shell for anything else. */
const assets = {
  fetches: [] as string[],
  async fetch(input: Request | string) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assets.fetches.push(url.pathname);
    if (url.pathname.startsWith('/icons/') && url.pathname.endsWith('.png')) {
      try {
        const bytes = readFileSync(repo(`public${url.pathname}`));
        return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
      } catch {
        /* fall through to the shell, exactly like not_found_handling */
      }
    }
    return new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } });
  },
};

function seed(status = 'active') {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','A','a@x.co','h')`);
  raw.exec(`INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1','Ali 3D')`);
  raw
    .prepare(
      `INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,logo_key,status) VALUES ('s1','m1','u1','somestore','Ali 3D',?,?)`
    )
    .run(LOGO, status);
  return raw;
}

function counting(db: D1Database) {
  const reads = { n: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          reads.n += 1;
          return (target as D1Database).prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as D1Database, reads };
}

function envOf(db: unknown, bound?: ReturnType<typeof iconEnv>, images?: ImagesBinding) {
  return {
    DB: db,
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: assets,
    ...(bound ? { R2_PUBLIC: bound.env.R2_PUBLIC, BUCKET: bound.env.BUCKET, R2_PRIVATE: bound.env.R2_PRIVATE } : {}),
    ...(images ? { IMAGES: images } : {}),
  } as never;
}

const get = (host: string, path: string, env: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', ...headers } }),
    env as never,
    ctx
  );

async function withRenditions(status = 'active') {
  const raw = seed(status);
  const images = imagesStub();
  const bound = iconEnv(asD1(raw), images.binding);
  bound.publicBucket.seed(LOGO, fixtureWebp(640, 640));
  const out = await refreshStoreIcons(bound.env, { id: 's1', user_id: 'u1', logo_key: LOGO, accent: 'default' });
  assert.equal(out.outcome, 'ready');
  const rev = (raw.prepare(`SELECT rev FROM merchant_store_icons`).get() as { rev: string }).rev;
  return { raw, bound, images, rev };
}

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

// ------------------------------------------------------------------- the apex

test('the apex is answered with the PLATFORM icon for each role, from the committed PNGs, without a query', async () => {
  const raw = seed();
  const { db, reads } = counting(asD1(raw));
  for (const [name, role] of Object.entries(STORE_ICON_PATHS)) {
    const res = await get(APEX, `/store-icon/${name}`, envOf(db));
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), STORE_ICON_CACHE_CONTROL);
    assert.equal(res.headers.get('etag'), `"platform-bc80fc2b-${role}"`);
    assert.deepEqual(await bytesOf(res), new Uint8Array(readFileSync(repo(`public${PLATFORM_ICON_FOR_ROLE[role]}`))), name);
  }
  assert.equal(reads.n, 0, 'the apex has no store to look up — not even the session');
});

test('the cache revalidates, and a revalidation that finds nothing new is a 304 with no body', async () => {
  assert.equal(STORE_ICON_CACHE_CONTROL, 'public, max-age=300, must-revalidate');
  assert.doesNotMatch(STORE_ICON_CACHE_CONTROL, /immutable/, 'the bytes behind one URL change with the logo');
  const raw = seed();
  const res = await get(APEX, '/store-icon/apple-touch.png', envOf(asD1(raw)), { 'If-None-Match': '"platform-bc80fc2b-apple180"' });
  assert.equal(res.status, 304);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
  assert.equal(res.headers.get('etag'), '"platform-bc80fc2b-apple180"');
  // No `Vary: Host` — the host is part of the URL (the manifest's reasoning).
  assert.equal(res.headers.get('vary'), null);
});

test('an unknown icon name is a bare 404 — never the SPA shell', async () => {
  const raw = seed();
  for (const path of ['/store-icon/logo.webp', '/store-icon/192', '/store-icon/..%2Fsecret', '/store-icon/constructor']) {
    const res = await get(MERCHANT_HOST, path, envOf(asD1(raw)));
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/html/, path);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

// ------------------------------------------------------------- a store's host

test('a store host is answered with the STORE\'s rendition of its current logo', async () => {
  const { raw, bound, rev } = await withRenditions();
  for (const [name, role] of Object.entries(STORE_ICON_PATHS)) {
    const res = await get(MERCHANT_HOST, `/store-icon/${name}`, envOf(asD1(raw), bound));
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('etag'), `"${rev}-${role}"`);
    assert.equal(res.headers.get('cache-control'), STORE_ICON_CACHE_CONTROL);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    const stored = bound.publicBucket.objects.get(`merchants/u1/logos/appicon-${rev}-${role}.png`)!;
    assert.deepEqual(await bytesOf(res), stored.bytes, name);
  }
});

test('a store icon revalidates to a 304 without reading R2', async () => {
  const { raw, bound, rev } = await withRenditions();
  let r2Reads = 0;
  const original = bound.publicBucket.get.bind(bound.publicBucket);
  bound.publicBucket.get = async (key: string) => {
    r2Reads += 1;
    return original(key);
  };
  const res = await get(MERCHANT_HOST, '/store-icon/apple-touch.png', envOf(asD1(raw), bound), { 'If-None-Match': `"${rev}-apple180"` });
  assert.equal(res.status, 304);
  assert.equal(r2Reads, 0);
});

test('after a logo change the old rendition is NOT served: the platform icon stands in and the new one is cut', async () => {
  const { raw, bound, images } = await withRenditions();
  const NEW = 'merchants/u1/public/fff99999.webp';
  bound.publicBucket.seed(NEW, fixtureWebp(512, 512));
  raw.prepare(`UPDATE merchant_stores SET logo_key = ? WHERE id = 's1'`).run(NEW);

  pending.length = 0;
  const res = await get(MERCHANT_HOST, '/store-icon/apple-touch.png', envOf(asD1(raw), bound, images.binding));
  assert.match(res.headers.get('etag') ?? '', /^"platform-/, 'never the removed logo\'s icon');
  await Promise.all(pending.splice(0));
  const again = await get(MERCHANT_HOST, '/store-icon/apple-touch.png', envOf(asD1(raw), bound, images.binding));
  const rev = (raw.prepare(`SELECT rev FROM merchant_store_icons`).get() as { rev: string }).rev;
  assert.equal(again.headers.get('etag'), `"${rev}-apple180"`, 'the lazy backfill cut the new logo');
  assert.equal(images.calls.length, 10, 'five for the first logo, five for the new one');
});

test('a suspended store — or a store whose merchant is suspended — gets the platform icon, and nothing is scheduled', async () => {
  for (const sql of [
    "UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'",
    "UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'",
  ]) {
    const { raw, bound, images } = await withRenditions();
    raw.exec(sql);
    pending.length = 0;
    const res = await get(MERCHANT_HOST, '/store-icon/192.png', envOf(asD1(raw), bound, images.binding));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"platform-bc80fc2b-icon192"', sql);
    assert.equal(pending.length, 0, sql);
  }
});

test('an unknown store, a system host and a spoofed host are the platform', async () => {
  const { raw, bound } = await withRenditions();
  for (const host of [`nosuchstore.${APEX}`, `studio.${APEX}`, 'somestore.evil.example']) {
    const res = await get(host, '/store-icon/apple-touch.png', envOf(asD1(raw), bound));
    assert.equal(res.status, 200, host);
    assert.equal(res.headers.get('etag'), '"platform-bc80fc2b-apple180"', host);
  }
});

test('a database that throws, or a rendition missing from R2, still answers 200 with the platform icon', async () => {
  const broken = { prepare() { throw new Error('D1_ERROR: network'); } };
  const res = await get(MERCHANT_HOST, '/store-icon/apple-touch.png', envOf(broken));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');

  const { raw, bound, rev } = await withRenditions();
  bound.publicBucket.objects.delete(`merchants/u1/logos/appicon-${rev}-apple180.png`);
  const missing = await get(MERCHANT_HOST, '/store-icon/apple-touch.png', envOf(asD1(raw), bound));
  assert.equal(missing.status, 200);
  assert.equal(missing.headers.get('etag'), '"platform-bc80fc2b-apple180"');
});

test('with no asset binding able to supply the platform PNG the answer is a 404, never HTML', async () => {
  const raw = seed();
  const env = { ...(envOf(asD1(raw)) as Record<string, unknown>), ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) } };
  const res = await get(APEX, '/store-icon/apple-touch.png', env);
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.headers.get('content-type') ?? '', /html/);
});

// ------------------------------------------------------ the routing around it

test('all three run_worker_first arrays carry /store-icon/*, or index.html links the SPA shell as an icon', () => {
  const wrangler = readFileSync(repo('wrangler.jsonc'), 'utf8');
  const blocks = wrangler.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(blocks.length, 3);
  for (const block of blocks) assert.ok(block.includes('"/store-icon/*"'), block);
});

test('the Worker mounts the route above the SPA fallback, and skips the session for it', () => {
  const index = readFileSync(repo('worker/index.ts'), 'utf8');
  const mount = index.indexOf("app.get('/store-icon/:name', storeIconRoute)");
  assert.ok(mount > 0, 'not mounted');
  assert.ok(mount < index.indexOf('app.notFound('), 'a route after notFound never runs');
  assert.match(index, /path\.startsWith\('\/store-icon\/'\)/);
});
