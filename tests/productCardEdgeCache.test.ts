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
 * Run: node --import tsx --test tests/productCardEdgeCache.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, MERCHANT_HOST, ctx, freshDb, pending } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { countingD1 } from './fixtures/d1RoundTrips';
import worker from '../worker/index';
import { MANIFEST_PATH, PRODUCT_CARD_REVISION, resolveProductPreview } from '../worker/lib/socialPreview';
import {
  ANONYMOUS_LIFETIME,
  PURGE_MARKER_CACHE,
  STORED_AT_HEADER,
  canonicalKey,
  cataloguePaths,
  edgeMemo,
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

/** The card's own reads in the counter's log: the product row (or a merchant's) and the pictures. */
const CARD_SQL = /FROM products WHERE slu|FROM product_images|FROM community_produc/;

async function liveWorker() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1', 'bambu-a1', 'Bambu Lab A1', 'طابعة A1', 100000, 'active');
    INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order, width, height)
      VALUES ('pi1','p1','${MAIN}','products/a1/main.webp',1,0,1254,1254);
  `);
  // What `fetchPublished` does for a customer path, once: the counting adapter hides the raw rows from it.
  await publishSeededV2(raw);
  const { db, counter } = countingD1(raw);
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
  const call = async (path: string, headers: Record<string, string> = {}, host = APEX) => {
    counter.reset();
    const res = await worker.fetch(new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', ...headers } }), env as never, ctx);
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
    assert.deepEqual(Object.keys(kept).sort(), ['description', 'image', 'lead', 'title'], 'the card and nothing else');
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
