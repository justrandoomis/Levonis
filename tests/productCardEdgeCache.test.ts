/**
 * A PRODUCT DOCUMENT NO LONGER READS D1 ON EVERY VIEW (S1, 2026-11-11; DECISIONS row 314).
 *
 * Measured live: every `/product/<slug>` document spent 330–530 ms in the
 * Worker (server-timing `cfWorker`) reading its share card from D1 — two
 * dependent round trips (the row, then its pictures) from the colo serving
 * Iraq (Sofia) to the primary in western North America — while the home
 * document took 5 ms and the page's own answer was already a colo hit. The
 * card is now kept in the colo like a guest's answer (`edgeMemo`,
 * worker/lib/edgePolicy.ts; worker/index.ts `catalogueCard`), under the
 * product answer's own path, so:
 *
 *   - a second view is answered without touching the product's rows (counted
 *     here: two D1 reads before, none after);
 *   - the catalogue purge of that answer (`cataloguePaths`: every admin product
 *     write, a visibility flip, the FX and repricing jobs) retires the card in
 *     that colo at once, and another colo keeps it no longer than the answer;
 *   - the card is one for every viewer and carries nothing of one;
 *   - a product with no card (unknown, hidden), a card without its picture and
 *     a slug its purge would spell differently are never kept;
 *   - a store-scoped card is read exactly as before;
 *   - a cache that fails is today's behaviour: the rows, on every view.
 *
 * And what the independent review of S1 found (2026-11-11), each proven
 * through the real routes: a bundle's, a mystery box's or a merchant's card is
 * never kept (their writes never purge `/api/products/<slug>`); the real admin
 * product routes, an opt-in slug change, a CSV import, a TXT template and a
 * structure save each retire the card at once; a purge whose marker cannot be
 * written still drops it by name; a held product gets no card while D1 fails
 * the completeness probe; a kept-card document answers GET, HEAD and a 304
 * like a built one; and the card's code and its revision move together.
 *
 * Run: node --import tsx --test tests/productCardEdgeCache.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APEX, MERCHANT_HOST, OWNER, approveMerchants, ctx, freshDb, get, json, patch, pending, post, stubApp, type Mount } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { ROOT } from './fixtures/d1';
import { countingD1 } from './fixtures/d1RoundTrips';
import { productMediaFixtureEnv } from './fixtures/productMedia';
import worker from '../worker/index';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { templateRoutes } from '../worker/routes/template';
import { toCsv } from '../worker/lib/importCsv';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire } from '../src/components/adminProducts/form/model';
import { docWithoutLegacyMoney, withoutLegacyMoney } from '../src/components/adminProducts/form/v2/v2Model';
import { MANIFEST_PATH, resolveProductPreview } from '../worker/lib/socialPreview';
import {
  ANONYMOUS_LIFETIME,
  PRODUCT_CARD_REVISION,
  PURGE_MARKER_CACHE,
  STORED_AT_HEADER,
  canonicalKey,
  cataloguePaths,
  edgeMemo,
  productCardKey,
  productPurgePath,
  purgeAnonymousCache,
  purgeCatalogueFromJob,
} from '../worker/lib/edgePolicy';
import { DOCUMENT_CACHE_CONTROL } from '../worker/lib/securityPolicy';

const SHELL = '<!doctype html><html><head><title>LEVONIS</title><meta property="og:title" content="LEVONIS" /><meta property="og:image" content="https://levonis-iq.com/x.webp" /></head><body></body></html>';
const MAIN = '/files/products/a1/main.webp';

/**
 * caches.default and the purge markers' named cache, as Map-backed stand-ins
 * that keep what was put — and hand out a CLONE of it, as the stand-ins of
 * tests/productLeadPreload.test.ts do. Releasing an unread clone settles only
 * once its other branch is read, so a copy the code does not read must never
 * be awaited: the first version of `edgeMemo` hung every test here on it.
 */
function standInCaches() {
  const store = () => {
    const m = new Map<string, Response>();
    return {
      m,
      async match(r: Request) { const x = m.get(r.url); return x ? x.clone() : undefined; },
      async put(r: Request, res: Response) { m.set(r.url, new Response(await res.arrayBuffer(), res)); },
      async delete(r: Request) { return m.delete(r.url); },
    };
  };
  const main = store();
  const markers = store();
  return { main, markers, scope: { default: main, open: async (name: string) => (name === PURGE_MARKER_CACHE ? markers : store()) } };
}
type StandIn = ReturnType<typeof standInCaches>;

async function withCaches(run: (c: StandIn) => Promise<void>, scope?: unknown) {
  const global = globalThis as { caches?: unknown };
  const c = standInCaches();
  global.caches = scope ?? c.scope;
  try {
    await run(c);
  } finally {
    delete global.caches;
  }
}

/**
 * The card's own reads in the counter's log (each line is cut at 90 characters):
 * the product row, a merchant's, and the pictures.
 */
const CARD_SQL = /SELECT id, name, name_ar, description, description_ar, light_image|FROM product_images|FROM community_produc/;

/**
 * `refuse(sql)` makes that statement fail as a dropped D1 connection does, at the
 * moment it is sent — a transient error the test can switch on and off.
 */
async function liveWorker(opts: { refuse?: (sql: string) => boolean } = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1', 'bambu-a1', 'Bambu Lab A1', 'طابعة A1', 100000, 'active');
    INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order, width, height)
      VALUES ('pi1','p1','${MAIN}','products/a1/main.webp',1,0,1254,1254);
  `);
  // What `fetchPublished` does for a customer path, once: the counting adapter hides the raw rows from it.
  await publishSeededV2(raw);
  const { db: counted, counter } = countingD1(raw);
  const refused = async () => {
    throw new Error('D1_ERROR: Network connection lost.');
  };
  const db = opts.refuse
    ? ({
        ...(counted as unknown as Record<string, unknown>),
        prepare: (sql: string) => {
          if (!opts.refuse!(sql)) return counted.prepare(sql);
          const statement = { bind: () => statement, first: refused, all: refused, run: refused, raw: refused };
          return statement;
        },
      } as unknown as D1Database)
    : counted;
  const env = {
    DB: db,
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async (req: Request) => new URL(req.url).pathname === MANIFEST_PATH
        ? new Response('{}', { headers: { 'content-type': 'application/json' } })
        : new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': DOCUMENT_CACHE_CONTROL } }),
    },
  };
  let reads = 0;
  const call = async (path: string, headers: Record<string, string> = {}, host = APEX, method = 'GET') => {
    counter.reset();
    const res = await worker.fetch(new Request(`https://${host}${path}`, { method, headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', ...headers } }), env as never, ctx);
    await Promise.all(pending.splice(0));
    reads = counter.log.filter((line) => CARD_SQL.test(line)).length;
    return res;
  };
  const view = async (path: string, headers: Record<string, string> = {}, host = APEX) => {
    const res = await call(path, headers, host);
    assert.equal(res.status, 200, path);
    return res.text();
  };
  return { raw, db, env, call, view, cardReads: () => reads };
}

const ogTitle = (html: string) => /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? null;
const ogImage = (html: string) => /<meta property="og:image" content="([^"]*)"/.exec(html)?.[1] ?? null;
const cardKeys = (c: StandIn) => [...c.main.m.keys()].filter((k) => k.includes('__card'));

/** Make the kept copy under `url` look `seconds` old. */
async function age(c: StandIn, url: string, seconds: number) {
  const stored = c.main.m.get(url)!;
  const headers = new Headers(stored.headers);
  headers.set(STORED_AT_HEADER, String(Date.now() - seconds * 1000));
  c.main.m.set(url, new Response(await stored.clone().arrayBuffer(), { status: 200, headers }));
}

// ------------------------------------------------------------- the document

test('the second view of a product is carded from the colo, not from its rows; the product purge retires the card', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', 'the first view reads the rows');
    assert.equal(w.cardReads(), 2, 'two reads, one after the other: the row, then its pictures');
    // The rows change, but nobody purged: the colo's card answers.
    w.raw.prepare("UPDATE products SET name_ar = 'اسم جديد' WHERE id = 'p1'").run();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', 'the second view is the kept card');
    assert.equal(w.cardReads(), 0, 'and reads nothing of the product');
    // Every other product path names the same card.
    assert.equal(ogTitle(await w.view('/p/bambu-a1')), 'طابعة A1');
    assert.equal(w.cardReads(), 0);
    // An admin product write purges the product's answer in this colo — and with it the card.
    await purgeAnonymousCache(`https://${APEX}`, cataloguePaths(['bambu-a1']));
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'اسم جديد', 'the purge retired the card');
    assert.equal(w.cardReads(), 2);
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'اسم جديد', 'and the rebuilt card is kept');
    assert.equal(w.cardReads(), 0);
  });
});

test('a job\'s purge (FX-5, a repricing, a completeness flip on the cron) retires the card too', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    await w.view('/product/bambu-a1');
    w.raw.prepare("UPDATE product_images SET url = '/files/products/a1/new.webp', r2_key = 'products/a1/new.webp' WHERE id = 'pi1'").run();
    assert.equal(ogImage(await w.view('/product/bambu-a1')), `https://${APEX}${MAIN}`, 'kept');
    await purgeCatalogueFromJob(w.env as never, ['bambu-a1']);
    assert.equal(ogImage(await w.view('/product/bambu-a1')), `https://${APEX}/files/products/a1/new.webp`, 'the new photo, at once');
  });
});

test('a product hidden here is never carded again; in another colo its card lives no longer than the answer', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    await w.view('/product/bambu-a1');
    // THIS colo took the write: the purge retires the card, and a hidden product is never kept.
    w.raw.prepare("UPDATE products SET status = 'draft' WHERE id = 'p1'").run();
    await purgeAnonymousCache(`https://${APEX}`, cataloguePaths(['bambu-a1']));
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS', 'the shop\'s card, not the hidden product\'s');
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS');
    assert.equal(w.cardReads(), 2, 'nothing was kept for it: every view asks the rows, as before');
  });
  await withCaches(async (c) => {
    // ANOTHER colo never heard of the write: its copy keeps the product answer's ladder.
    const w = await liveWorker();
    await w.view('/product/bambu-a1');
    const [key] = cardKeys(c);
    w.raw.prepare("UPDATE products SET status = 'draft' WHERE id = 'p1'").run();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', 'fresh: as the product answer would be');
    await age(c, key, 90); // past s-maxage / 2: served once more, rebuilt behind it
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1');
    assert.equal(c.main.m.has(key), false, 'the rebuild found the product hidden and dropped the copy');
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS');
    // And a copy past the product answer's own window (s-maxage + stale-while-revalidate) is never served.
    w.raw.prepare("UPDATE products SET status = 'active' WHERE id = 'p1'").run();
    await w.view('/product/bambu-a1');
    w.raw.prepare("UPDATE products SET status = 'draft' WHERE id = 'p1'").run();
    await age(c, key, ANONYMOUS_LIFETIME.sMaxAge + ANONYMOUS_LIFETIME.staleWhileRevalidate + 1);
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS', 'expired: built, and the product is hidden');
  });
});

test('an unknown slug keeps the shop card and leaves nothing in the cache', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    assert.equal(ogTitle(await w.view('/product/no-such-thing')), 'LEVONIS');
    assert.deepEqual(cardKeys(c), [], 'a missing card is never stored');
  });
});

test('the card is not reachable through the product route: its key carries a parameter no route declares', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    await w.view('/product/bambu-a1');
    const keys = cardKeys(c);
    assert.equal(keys.length, 1, keys.join(' '));
    const key = new URL(keys[0]);
    assert.equal(`${key.origin}${key.pathname}`, `https://${APEX}/api/products/bambu-a1`, 'the product answer\'s own path, on the origin the card names');
    assert.equal(key.searchParams.get('__card'), PRODUCT_CARD_REVISION, 'and the shape it was built in');
    assert.equal(keys[0], productCardKey(`https://${APEX}`, 'bambu-a1')?.url, 'the very key the product purge drops by name');
    assert.equal(productCardKey(`https://${APEX}`, 'a?b'), null, 'and none for a slug its purge would spell differently');
    const card = await c.main.m.get(keys[0])!.clone().json();
    for (const path of ['/api/products/bambu-a1', `/api/products/bambu-a1?__card=${PRODUCT_CARD_REVISION}`]) {
      const answer = await w.call(path);
      assert.equal(answer.status, 200, path);
      const body = (await answer.json()) as { success?: boolean; product?: unknown; title?: unknown };
      assert.equal(body.success, true, path);
      assert.ok(body.product, `${path}: the route answered its own body, not the card`);
      assert.equal(body.title, undefined, path);
    }
    assert.deepEqual(await c.main.m.get(keys[0])!.clone().json(), card, 'and the route never wrote over the card');
  });
});

test('one card for every viewer, and it carries nothing of one: no price, no session, no language, no theme', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    const first = await w.view('/product/bambu-a1');
    const viewers: Record<string, string>[] = [
      { Cookie: 'levonis_session=not-a-live-session' },
      { 'Accept-Language': 'en' },
      { 'Accept-Language': 'ckb' },
      { Cookie: 'theme=light' },
    ];
    for (const headers of viewers) {
      const html = await w.view('/product/bambu-a1', headers);
      assert.equal(w.cardReads(), 0, JSON.stringify(headers));
      assert.equal(ogTitle(html), ogTitle(first), JSON.stringify(headers));
      assert.equal(ogImage(html), ogImage(first), JSON.stringify(headers));
    }
    const keys = cardKeys(c);
    assert.equal(keys.length, 1, 'one entry, whoever asked');
    const kept = (await c.main.m.get(keys[0])!.clone().json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(kept).sort(), ['description', 'image', 'kind', 'lead', 'title'], 'the card and nothing else');
    assert.equal(kept.kind, 'catalogue', 'only a catalogue card is ever kept');
    assert.doesNotMatch(JSON.stringify(kept), /price|stock|iqd|usd|session|user/i);
    assert.deepEqual(kept, JSON.parse(JSON.stringify(await resolveProductPreview(w.db, 'bambu-a1', `https://${APEX}`))), 'exactly what the rows give');
  });
});

test('a card without its picture (a failed or empty picture read) is served, and never kept', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    w.raw.prepare("DELETE FROM product_images WHERE product_id = 'p1'").run();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', 'the product\'s own name');
    assert.deepEqual(cardKeys(c), [], 'not kept');
    w.raw.prepare(`INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order) VALUES ('pi2','p1','${MAIN}','products/a1/main.webp',1,0)`).run();
    assert.equal(ogImage(await w.view('/product/bambu-a1')), `https://${APEX}${MAIN}`, 'the picture the moment it is there');
    assert.equal(cardKeys(c).length, 1, 'and only now is the card kept');
  });
});

test('a slug its purge would spell differently is read on every view, never kept — and never under another product\'s key', async () => {
  assert.equal(productPurgePath('bambu-a1'), '/api/products/bambu-a1');
  assert.equal(productPurgePath('طابعة-a1'), `/api/products/${encodeURIComponent('طابعة-a1')}`);
  for (const odd of ['a?b', 'a#b', 'a/b', 'a%41', 'a@b', 'a+b', 'a:b', '']) assert.equal(productPurgePath(odd), null, odd);
  await withCaches(async (c) => {
    const w = await liveWorker();
    w.raw.exec(`
      INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p2', 'bambu-a1?combo', 'A1 Combo', 'كومبو A1', 100000, 'active');
      INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order) VALUES ('pi3','p2','/files/products/a1/combo.webp','products/a1/combo.webp',1,0);
    `);
    assert.equal(ogTitle(await w.view('/product/bambu-a1%3Fcombo')), 'كومبو A1');
    assert.deepEqual(cardKeys(c), [], 'not kept: its purge would mark /api/products/bambu-a1');
    w.raw.prepare("UPDATE products SET name_ar = 'كومبو A1 الجديد' WHERE id = 'p2'").run();
    assert.equal(ogTitle(await w.view('/product/bambu-a1%3Fcombo')), 'كومبو A1 الجديد', 'read again, as before');
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', 'the other product\'s card is its own');
  });
});

test('a store-scoped card never reads the catalogue\'s kept card', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    await w.view('/product/bambu-a1');
    // The main site's page of a store's product: scoped to that store, which has no such product.
    assert.equal(ogTitle(await w.view('/community/store/no-such-store/p/bambu-a1')), 'LEVONIS');
    // A merchant's own host: the same.
    const onStore = await w.call('/p/bambu-a1', {}, MERCHANT_HOST);
    assert.equal(ogTitle(await onStore.text()), 'LEVONIS');
    assert.equal(cardKeys(c).length, 1, 'only the catalogue card, under the apex');
  });
});

test('a cache that fails is today\'s behaviour: every view reads the rows and shows the card', async () => {
  const down = async () => {
    throw new Error('cache unavailable');
  };
  const broken = { match: down, put: down, delete: down };
  const fine = standInCaches();
  for (const [what, scope] of [
    ['every cache down', { default: broken, open: down }],
    ['the answers\' cache down, the purge markers fine', { default: broken, open: async () => fine.markers }],
    ['the purge markers down, the answers\' cache fine', { default: fine.main, open: down }],
  ] as const) {
    await withCaches(async () => {
      const w = await liveWorker();
      assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', what);
      assert.equal(w.cardReads(), 2, what);
      w.raw.prepare("UPDATE products SET name_ar = 'اسم جديد' WHERE id = 'p1'").run();
      assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'اسم جديد', `${what}: nothing kept, nothing stale`);
      assert.equal(w.cardReads(), 2, what);
    }, scope);
  }
  assert.equal([...fine.main.m.keys()].filter((k) => k.includes('__card')).length, 0, 'no card is kept where its purge could not retire it');
});

// ------------------------------------------- only a card its writes retire is kept
//
// The S1 review (2026-11-11): a card may live in the colo only where every write
// that changes it purges `/api/products/<slug>` — a plain catalogue product.

/**
 * The real admin routers, signed in as the owner, on the Worker's own database
 * and in its colo: a write here is the one the panel sends, seams included.
 */
function panel(w: Awaited<ReturnType<typeof liveWorker>>, mount: Mount, env: Record<string, unknown> = {}) {
  w.raw
    .prepare('INSERT OR IGNORE INTO users (id, name, email, password_hash, role, username) VALUES (?, ?, ?, ?, ?, ?)')
    .run(OWNER.id, 'Owner', OWNER.email, 'h', 'admin', OWNER.id);
  return stubApp(w.db, OWNER, mount, { env: { STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, ...env } });
}

/** An admin write, once what it left for after its answer (`waitUntil`) has settled. */
async function settled(res: Response | Promise<Response>): Promise<Response> {
  const out = await res;
  await Promise.all(pending.splice(0));
  return out;
}

test('a bundle or a mystery box is carded from its rows on every view, never kept: a disable in the bundles panel shows at once', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    w.raw.exec(`
      INSERT INTO products (id, slug, name, name_ar, price_iqd, status, composition, stock) VALUES
        ('b1', 'a1-combo', 'A1 Combo', 'كومبو A1', 100000, 'active', 'bundle', NULL),
        ('mb1', 'pla-mystery', 'PLA mystery box', 'صندوق مفاجآت', 20000, 'active', 'mystery', NULL);
      INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order) VALUES
        ('bi1', 'b1', '/files/products/a1/combo.webp', 'products/a1/combo.webp', 1, 0),
        ('mi1', 'mb1', '/files/products/pla/box.webp', 'products/pla/box.webp', 1, 0);
    `);
    // A composition's page reads /api/bundles/<slug>, which no colo keeps and no catalogue purge names.
    for (const [path, title] of [['/bundles/a1-combo', 'كومبو A1'], ['/product/a1-combo', 'كومبو A1'], ['/bundles/pla-mystery', 'صندوق مفاجآت']]) {
      assert.equal(ogTitle(await w.view(path)), title, path);
      assert.equal(ogTitle(await w.view(path)), title, path);
      assert.equal(w.cardReads(), 2, `${path}: the second view reads its rows too, as before S1`);
    }
    assert.deepEqual(cardKeys(c), [], 'a composition\'s card is never kept');
    // The owner disables the bundle in its own panel, which purges nothing: every document says so at once.
    const res = await settled(patch(panel(w, (a) => a.route('/api/admin/bundles', adminBundlesRoutes)), '/api/admin/bundles/b1/status', { action: 'disable' }));
    assert.equal(res.status, 200, await res.clone().text());
    for (const path of ['/bundles/a1-combo', '/product/a1-combo']) assert.equal(ogTitle(await w.view(path)), 'LEVONIS', `${path}: the hidden bundle's card is gone`);
  });
});

test('a merchant\'s product on the main site is carded from its rows on every view, never kept: a hide by LEVONIS shows at once', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    w.raw.exec(`
      INSERT INTO users (id, name, email, password_hash, role) VALUES ('ali', 'Ali', 'ali@x.co', 'h', 'merchant');
      INSERT INTO community_merchants (id, user_id, name) VALUES ('cm1', 'ali', 'Ali 3D');
      INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st1', 'cm1', 'ali', 'ali3d', 'Ali 3D');
      INSERT INTO community_products (id, merchant_id, store_id, slug, name, name_ar, description_ar, images, status, lifecycle, price_iqd) VALUES
        ('cp1', 'cm1', 'st1', 'ali3d-bracket', 'Bracket', 'حامل رف', 'حامل متين', '["/files/merchants/ali/public/aaaa1111.webp"]', 'active', 'active', 7000);
    `);
    approveMerchants(w.raw);
    // The community hub links these at /product/<slug> on the main site (src/components/community/hub/ProductTile.tsx).
    for (const path of ['/product/ali3d-bracket', '/p/ali3d-bracket', '/bundles/ali3d-bracket']) {
      assert.equal(ogTitle(await w.view(path)), 'حامل رف', path);
    }
    assert.deepEqual(cardKeys(c), [], 'a merchant\'s card is never kept: its writes purge the storefront, never /api/products/<slug>');
    // The merchant renames it in the store's own editor: the next view says so.
    w.raw.prepare("UPDATE community_products SET name_ar = 'حامل رف معدني' WHERE id = 'cp1'").run();
    assert.equal(ogTitle(await w.view('/product/ali3d-bracket')), 'حامل رف معدني');
    // LEVONIS hides it for its picture (DECISIONS row 256): no card names it any more, in this colo or any other.
    const res = await settled(post(panel(w, (a) => a.route('/api/admin/community', adminCommunityRoutes)), '/api/admin/community/products/cp1/hide', { reason: 'offensive picture' }));
    assert.equal(res.status, 200, await res.clone().text());
    for (const path of ['/product/ali3d-bracket', '/p/ali3d-bracket']) assert.equal(ogTitle(await w.view(path)), 'LEVONIS', path);
  });
});

test('the admin product routes retire the card in the colo that took the write: a hide, a show, a delete', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1');
    assert.equal(cardKeys(c).length, 1);
    const admin = panel(w, (a) => a.route('/api/admin/products-v2', adminProductsRoutes));
    const hidden = await settled(patch(admin, '/api/admin/products-v2/p1/status', { status: 'hidden' }));
    assert.equal(hidden.status, 200, await hidden.clone().text());
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS', 'hidden: the shop\'s card at once');
    const shown = await settled(patch(admin, '/api/admin/products-v2/p1/status', { status: 'active' }));
    assert.equal(shown.status, 200, await shown.clone().text());
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1', 'shown again: its card at once');
    assert.equal(cardKeys(c).length, 1, 'and kept again');
    const gone = await settled(admin.request('/api/admin/products-v2/p1', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx));
    assert.equal(gone.status, 200, await gone.clone().text());
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS', 'deleted: the shop\'s card at once');
  });
});

test('an opt-in slug change retires the card of the address the product left, at once', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1');
    const media = productMediaFixtureEnv();
    const admin = panel(w, (a) => {
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
    }, media.env as unknown as Record<string, unknown>);
    // What the product form posts (ProductForm `save`), with the slug the owner typed and the box ticked.
    const product = (await json(await get(admin, '/api/admin/products-v2/p1'))).product;
    const rel = await json(await get(admin, '/api/admin/products/p1/relations'));
    const { options: _o, colors: _c, media: _m, ...fields } = toEditorDoc(product as never) as unknown as Record<string, unknown>;
    void _o; void _c; void _m;
    const relations = withoutLegacyMoney(relationsToWire(hydrateRelations(rel as never, product as never)) as never);
    const res = await settled(post(admin, '/api/admin/products-v2', {
      ...docWithoutLegacyMoney(fields), relations, expected_updated_at: product.updated_at, slug: 'bambu-lab-a1', allow_slug_change: true,
    }));
    assert.equal(res.status, 200, (await res.clone().text()).slice(0, 400));
    assert.equal(w.raw.prepare("SELECT slug FROM products WHERE id = 'p1'").get()?.slug, 'bambu-lab-a1');
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS', 'the old address names no product any more');
    // The save writes the Arabic copy from the English name (the form sends no Arabic): the card is the rows' now.
    const now = await resolveProductPreview(w.db, 'bambu-lab-a1', `https://${APEX}`);
    assert.ok(now?.title);
    assert.equal(ogTitle(await w.view('/product/bambu-lab-a1')), now.title, 'the new one does');
  });
});

test('a CSV import that rewrites a product retires its card at once', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    w.raw.exec(`
      INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, template_family, is_printer_catalog, active)
        VALUES ('tpl_printers', NULL, 'tpl-printers', 'طابعات', 'Printers', 'devices', 1, 1);
    `);
    assert.equal(ogImage(await w.view('/product/bambu-a1')), `https://${APEX}${MAIN}`, 'kept with its picture');
    const admin = panel(w, (a) => a.route('/api/admin/import', adminImportRoutes));
    // A product row with no picture rows replaces the product's pictures with none (worker/routes/adminImport.ts).
    const form = new FormData();
    form.set('file', new File([toCsv([
      ['row_type', 'key', 'name', 'description', 'status', 'category', 'price_iqd', 'stock'],
      ['product', 'bambu-a1', 'Bambu Lab A1 Combo', 'The A1 with the AMS lite', 'active', 'tpl-printers', '100000', '5'],
    ])], 'data.csv', { type: 'text/csv' }));
    form.set('category', 'tpl_printers');
    const preview = await json(await settled(admin.request('/api/admin/import/preview', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx)));
    assert.equal(preview.rows?.[0]?.action, 'update', JSON.stringify(preview).slice(0, 400));
    const confirmed = await settled(post(admin, '/api/admin/import/confirm', { import_id: preview.import_id }));
    const body = await json(confirmed.clone());
    assert.equal(confirmed.status, 200, JSON.stringify(body).slice(0, 400));
    assert.equal(body.summary?.updated, 1, JSON.stringify(body).slice(0, 400));
    const html = await w.view('/product/bambu-a1');
    assert.notEqual(ogImage(html), `https://${APEX}${MAIN}`, 'the picture the import removed is not the card\'s any more');
    const now = await resolveProductPreview(w.db, 'bambu-a1', `https://${APEX}`);
    assert.equal(ogTitle(html), now?.title, 'the card is what the rows say now');
  });
});

test('a TXT template applied over a product retires its card at once', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1');
    const admin = panel(w, (a) => a.route('/api/admin/template', templateRoutes), productMediaFixtureEnv().env as unknown as Record<string, unknown>);
    const exported = await get(admin, '/api/admin/template/export/p1');
    assert.equal(exported.status, 200);
    const text = (await exported.text()).replace(/^name_ar=.*$/m, 'name_ar=طابعة A1 كومبو');
    const res = await settled(post(admin, '/api/admin/template/apply', { text, mode: 'update', confirm: true }));
    assert.equal(res.status, 200, (await res.clone().text()).slice(0, 400));
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'طابعة A1 كومبو', 'the name the file wrote, at once');
  });
});

test('a structure save that takes the product\'s pictures away retires its card at once', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    assert.equal(ogImage(await w.view('/product/bambu-a1')), `https://${APEX}${MAIN}`);
    const admin = panel(w, (a) => {
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
    }, productMediaFixtureEnv().env as unknown as Record<string, unknown>);
    const product = (await json(await get(admin, '/api/admin/products-v2/p1'))).product;
    const rel = await json(await get(admin, '/api/admin/products/p1/relations'));
    const wire = withoutLegacyMoney(relationsToWire(hydrateRelations(rel as never, product as never)) as never) as unknown as Record<string, unknown>;
    const res = await settled(admin.request('/api/admin/products/p1/relations', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ ...wire, images: [] }),
    }, undefined, ctx));
    assert.equal(res.status, 200, (await res.clone().text()).slice(0, 400));
    assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p1'").get()?.n, 0);
    assert.notEqual(ogImage(await w.view('/product/bambu-a1')), `https://${APEX}${MAIN}`, 'the picture the save removed is not the card\'s any more');
  });
});

test('a purge whose marker cannot be written still drops the card in its colo, by name', async () => {
  await withCaches(async (c) => {
    const w = await liveWorker();
    await w.view('/product/bambu-a1');
    assert.equal(cardKeys(c).length, 1);
    w.raw.prepare("UPDATE products SET name_ar = 'اسم جديد' WHERE id = 'p1'").run();
    c.markers.put = async () => {
      throw new Error('marker write failed');
    };
    // The product answer is dropped by name here; so is the card that names it.
    await purgeAnonymousCache(`https://${APEX}`, cataloguePaths(['bambu-a1']));
    assert.deepEqual(cardKeys(c), [], 'the card went with the product answer');
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'اسم جديد');
  });
});

test('a product held for a catalogue gap never gets a card, even while D1 fails the completeness probe: the read fails closed', async () => {
  let flaky = true;
  await withCaches(async (c) => {
    // A cold isolate whose first probe of the held table is lost on the way (a transient D1 error).
    const w = await liveWorker({ refuse: (sql) => flaky && /FROM product_completeness LIMIT 1/.test(sql) });
    w.raw.exec(`INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
                VALUES ('p1', 0, 1, '[{"c":"CATEGORY"}]', 1, '2026-11-11T00:00:00.000Z')`);
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS', 'held: the shop\'s card, as its page answers 404');
    assert.deepEqual(cardKeys(c), [], 'nothing kept for it');
    flaky = false;
    assert.equal(ogTitle(await w.view('/product/bambu-a1')), 'LEVONIS');
    assert.equal((await w.call('/api/products/bambu-a1')).status, 404, 'the page\'s own answer agrees');
  });
});

// ------------------------------------------------------------------ the document

test('a document carded from the colo answers exactly as one carded from the rows: the same bytes and headers, and HEAD without a body', async () => {
  await withCaches(async () => {
    const w = await liveWorker();
    const headersOf = (r: Response) => {
      const out: Record<string, string> = {};
      r.headers.forEach((value, name) => {
        if (!/^(date|server-timing)$/i.test(name)) out[name] = value;
      });
      return out;
    };
    const miss = await w.call('/product/bambu-a1');
    const missBody = await miss.text();
    assert.equal(w.cardReads(), 2, 'built from the rows');
    const hit = await w.call('/product/bambu-a1');
    const hitBody = await hit.text();
    assert.equal(w.cardReads(), 0, 'from the colo');
    assert.equal(hitBody, missBody, 'the same document');
    assert.deepEqual(headersOf(hit), headersOf(miss), 'the same validator, policy and hints');
    const head = await w.call('/product/bambu-a1', {}, APEX, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '', 'HEAD has no body');
    assert.equal(w.cardReads(), 0, 'and reads nothing either');
    assert.equal(head.headers.get('ETag'), hit.headers.get('ETag'));
    assert.equal(head.headers.get('Cache-Control'), hit.headers.get('Cache-Control'));
    const revalidated = await w.call('/product/bambu-a1', { 'If-None-Match': hit.headers.get('ETag')! });
    assert.equal(revalidated.status, 304, 'and a browser holding it revalidates to a bodiless 304');
  });
});

// ------------------------------------------------------------------ the revision

/**
 * THE CARD'S CODE AND ITS REVISION MOVE TOGETHER (the S1 review). A kept card
 * built by an older shape or rule would be served for up to twelve minutes
 * after a deploy unless `PRODUCT_CARD_REVISION` (in the key) moves with the code
 * that builds the card. Change that code (comments and blank lines aside) and
 * this fails until the revision is bumped and both constants below are updated
 * in the same commit; a bump made for another reason fails it too.
 */
// card-2026-11-11b: the card says what it is of (`kind`; only a catalogue card is kept), and its row is read
// with the optimistic VISIBLE predicate (the S1 review).
const CARD_REVISION = 'card-2026-11-11b';
const CARD_DIGEST = '7fac65bc0156479e275598a3346e81671359379b631536d119ddf8e8bd37248a';

test('the code that builds a kept card and PRODUCT_CARD_REVISION move together', () => {
  const source = readFileSync(join(ROOT, 'worker/lib/socialPreview.ts'), 'utf8').replace(/\r\n/g, '\n');
  const hash = createHash('sha256');
  for (const start of ['interface PreviewRow', 'interface ProductPreview', 'function pickText', 'export async function resolveProductPreview', 'async function previewFrom']) {
    const at = source.indexOf(`\n${start}`);
    assert.ok(at >= 0, `worker/lib/socialPreview.ts: ${start} not found`);
    const end = source.indexOf('\n}\n', at);
    const code = source
      .slice(at, end + 2)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^(\/\/|\/\*|\*)/.test(line));
    hash.update(start);
    hash.update('\0');
    hash.update(code.join('\n'));
  }
  assert.deepEqual(
    { revision: PRODUCT_CARD_REVISION, digest: hash.digest('hex') },
    { revision: CARD_REVISION, digest: CARD_DIGEST },
    'the card\'s code or its revision changed on its own. They are one thing: a card of a new shape or rule needs a new ' +
      'PRODUCT_CARD_REVISION (worker/lib/edgePolicy.ts), or a colo keeps answering with copies the old code built. Bump it, ' +
      'then update both constants in this test.'
  );
});

// ------------------------------------------------------------------ the ladder

function memoHarness() {
  const waits: Promise<unknown>[] = [];
  const c = { executionCtx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } } as never;
  const key = canonicalKey(`https://${APEX}/api/products/x?__card=1`, ['__card'], APEX);
  return { c, key, settle: async () => { while (waits.length) await Promise.all(waits.splice(0)); } };
}

test('edgeMemo: fresh is served, past half its s-maxage it is served and rebuilt, stale within the window likewise, expired is a miss', async () => {
  await withCaches(async (caches) => {
    const { c, key, settle } = memoHarness();
    let builds = 0;
    const build = async () => ({ n: ++builds });
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 });
    await settle();
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 }, 'fresh');
    assert.equal(builds, 1);

    await age(caches, key.url, 90); // past s-maxage / 2 (60 s): served, rebuilt behind it
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 });
    await settle();
    assert.equal(builds, 2, 'rebuilt in the background');
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 2 });

    await age(caches, key.url, 400); // inside the stale window (120 + 600 s): served at once, rebuilt
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 2 });
    await settle();
    assert.equal(builds, 3);

    await age(caches, key.url, 800); // past it: a miss, built inline (and the unread copy is not waited on)
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 4 });
  });
});

test('edgeMemo: nothing found, or a value keep refuses, is not stored, and a refresh that builds either drops the copy', async () => {
  await withCaches(async (caches) => {
    const { c, key, settle } = memoHarness();
    let found: { name: string; image: string } | null = { name: 'A1', image: 'x' };
    const build = async () => found;
    const keep = (v: { image: string }) => !!v.image;
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build, keep), { name: 'A1', image: 'x' });
    await settle();
    found = null;
    await age(caches, key.url, 90);
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build, keep), { name: 'A1', image: 'x' }, 'served while it is rebuilt');
    await settle();
    assert.equal(caches.main.m.has(key.url), false, 'the rebuild found nothing and dropped the copy');
    assert.equal(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build, keep), null);
    await settle();
    assert.equal(caches.main.m.has(key.url), false, 'and nothing is stored for a null');

    found = { name: 'A1', image: '' };
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build, keep), { name: 'A1', image: '' }, 'served as built');
    await settle();
    assert.equal(caches.main.m.has(key.url), false, 'but not kept');
    found = { name: 'A1', image: 'x' };
    await edgeMemo(c, key, ANONYMOUS_LIFETIME, build, keep);
    await settle();
    found = { name: 'A1', image: '' };
    await age(caches, key.url, 90);
    await edgeMemo(c, key, ANONYMOUS_LIFETIME, build, keep);
    await settle();
    assert.equal(caches.main.m.has(key.url), false, 'a refresh that builds a refused value drops the copy');
  });
});

test('edgeMemo: a purge while the value is being built retires what that build stores', async () => {
  await withCaches(async () => {
    const { c, key, settle } = memoHarness();
    let builds = 0;
    let purgeNow: (() => Promise<void>) | null = () => purgeAnonymousCache(`https://${APEX}`, ['/api/products/x']);
    const build = async () => {
      builds += 1;
      if (purgeNow) {
        const purge = purgeNow;
        purgeNow = null;
        await new Promise((resolve) => setTimeout(resolve, 2));
        await purge(); // the admin write lands after the rows were read
      }
      return { n: builds };
    };
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 });
    await settle();
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 2 }, 'the copy read before the purge is a miss');
  });
});

test('edgeMemo: a purge marker that cannot be read is a miss — never a copy nothing can vouch for', async () => {
  await withCaches(async (caches) => {
    const { c, key, settle } = memoHarness();
    let builds = 0;
    const build = async () => ({ n: ++builds });
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 });
    await settle();
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 }, 'kept');
    caches.markers.match = async () => {
      throw new Error('marker read failed');
    };
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 2 }, 'built, not the copy it could not check');
  });
});

test('edgeMemo: with no cache at all (Node, a test of one router), or one that throws outright, it simply builds', async () => {
  const { c, key, settle } = memoHarness();
  let builds = 0;
  const build = async () => ({ n: ++builds });
  assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 1 });
  assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 2 });
  const throws = () => {
    throw new Error('cache unavailable');
  };
  const fine = standInCaches();
  // The answers' cache throws on every call, synchronously; the purge markers are fine.
  await withCaches(async () => {
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 3 });
    await settle();
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 4 });
    await settle();
  }, { default: { match: throws, put: throws, delete: throws }, open: async () => fine.markers });
  // The purge markers cannot be opened: nothing is kept, though the answers' cache works.
  await withCaches(async () => {
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 5 });
    await settle();
    assert.deepEqual(await edgeMemo(c, key, ANONYMOUS_LIFETIME, build), { n: 6 });
    await settle();
  }, { default: fine.main, open: throws });
  assert.equal(fine.main.m.size, 0, 'a value its purge could not retire is never stored');
});
