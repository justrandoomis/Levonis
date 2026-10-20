/**
 * THE OPS DOOR: ONE 404 FOR EVERY MISS, AND THE REVIEWED SCOPE (Bambu import
 * spec §A.3; worker/lib/catalogImport/auth.ts, worker/routes/catalogImportOps.ts).
 *
 *   uniformity  no header, no protocol header, another protocol, a malformed
 *               bearer, an unknown token, an expired token, a revoked token, a
 *               closed run, a partial run, a database without 0195 — the same
 *               404 body, `private, no-store`, and the same work (one statement)
 *   no-store    every answer, a 200 included
 *   rate limit  600 a minute per run: the 601st call is 429 RATE_LIMITED
 *   the gate    the deception gate knows the prefix (server to server): a tool's
 *               bad-token storm is not probing, and a blocked network still reaches it
 *   errors      `{code, message}` only, ≤ 300 characters, nothing the caller sent
 *   the scope   an unlisted id at /manifest, a manifest row that differs from the
 *               bundle, an unlisted merge and a create for a merge source at /stage
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { dbThrough } from './fixtures/app';
import { countingD1 } from '../worker/lib/catalogImport/budget';
import { buildFor, bundleTexts, manifestRowOf } from './fixtures/catalogImportWorld';
import { sample } from './fixtures/bambu/load';
import { OPS, OPS_RUN, openRun, opsWorld, setBundle, TOKEN, tokenHash, type OpsWorld } from './fixtures/catalogImportOps';
import { deceptionWorld, TOOL } from './fixtures/deception';
import { SERVER_TO_SERVER, serverToServer } from '../worker/lib/deception/gate';
import { NO_STORE } from '../worker/lib/catalogImport/auth';
import { newProductIdOf } from '../worker/lib/catalogImport/reviewed';

after(() => setBundle(null));

const NOT_FOUND = { error: 'Not found' };

async function expect404(w: OpsWorld, label: string, opts: Parameters<OpsWorld['call']>[1] = {}, path = `${OPS}/hello`) {
  const r = await w.call(path, { body: { protocol: 2 }, ...opts });
  assert.equal(r.status, 404, label);
  assert.equal(r.headers.get('cache-control'), NO_STORE, `${label}: no-store`);
  assert.deepEqual(await r.json(), NOT_FOUND, `${label}: the uniform body`);
}

test('every miss answers the same 404 with the same work: no header, a bad, expired or revoked token, a closed or partial run, no 0195', async () => {
  const w = opsWorld();
  const counted = countingD1(w.env.DB as D1Database);
  w.env.DB = counted.db;
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(w.raw);
  const work = async (label: string, opts: Parameters<OpsWorld['call']>[1]) => {
    const before = counted.counter.count;
    await expect404(w, label, opts);
    return counted.counter.count - before;
  };
  // The first request of an isolate warms what other middleware reads once (not the door's work): discarded.
  await expect404(w, 'warm-up', { token: null, protocol: null });
  const costs = new Map<string, number>();
  costs.set('no header', await work('no header', { token: null, protocol: null }));
  costs.set('no protocol header', await work('no protocol header', { protocol: null }));
  costs.set('protocol 3', await work('protocol 3', { protocol: '3' }));
  costs.set('malformed bearer', await work('malformed bearer', { token: 'not-hex' }));
  costs.set('uppercase hex', await work('uppercase hex', { token: TOKEN.toUpperCase() }));
  costs.set('unknown token', await work('unknown token', { token: 'b'.repeat(64) }));
  // Expired, revoked, closed, partial.
  w.raw.prepare("UPDATE catalog_import_runs SET token_expires_at = '2020-01-01T00:00:00.000Z'").run();
  costs.set('expired', await work('expired', {}));
  w.raw.prepare('UPDATE catalog_import_runs SET token_expires_at = ?, token_sha256 = ?').run(new Date(Date.now() + 3600_000).toISOString(), '');
  costs.set('revoked', await work('revoked', {}));
  w.raw.prepare("UPDATE catalog_import_runs SET token_sha256 = ?, state = 'closed'").run(tokenHash(TOKEN));
  costs.set('closed', await work('closed', {}));
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'partial'").run();
  costs.set('partial', await work('partial', {}));
  // A merchant subdomain, with the right token on an open run: the same 404, after the same read.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'open'").run();
  costs.set('merchant host', await work('merchant host', { host: 'somestore.levonis-iq.com' }));
  assert.deepEqual(new Set(costs.values()), new Set([1]), `every miss costs one statement: ${JSON.stringify([...costs])}`);
  // Each path, GET and POST, without a token.
  for (const p of ['/manifest', '/items/123/lease', '/items/123/stage', '/run/finish', '/run/translations']) await expect404(w, p, { token: null }, `${OPS}${p}`);
  for (const p of ['/items/123/readback', '/run/status']) {
    const r = await w.call(`${OPS}${p}`, { token: null });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), NOT_FOUND);
  }
  // A database without migration 0195 (a deploy ahead of its migration): the same 404, never a 500.
  const old = opsWorld({ raw: dbThrough('0194_catalog_knowledge.sql') });
  await expect404(old, 'no 0195', {});
});

test('a valid token: every answer no-store; an unknown path under the prefix is the same 404; errors are {code, message} and echo nothing', async () => {
  const w = opsWorld();
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(w.raw);
  const hello = await w.call(`${OPS}/hello`, { body: { protocol: 2 } });
  assert.equal(hello.status, 200);
  assert.equal(hello.headers.get('cache-control'), NO_STORE);
  const status = await w.call(`${OPS}/run/status`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), NO_STORE);
  const unknown = await w.call(`${OPS}/no/such/route`, { body: {} });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), NOT_FOUND);
  // Errors: the shape, the length, nothing of the input.
  const PLANT = 'PLANTED-9f8e7d';
  const cases: Array<[string, unknown, number, string]> = [
    ['/hello', { protocol: 3, github_run_id: PLANT }, 409, 'IMPORT_PROTOCOL_MISMATCH'],
    ['/manifest', { rows: [{ source_product_id: '999999', handle: PLANT, queue_position: 1, discovered_at: '2026-10-15' }] }, 409, 'REVIEWED_SCOPE_REFUSED'],
    ['/items/999999/lease', { lease_token: PLANT }, 404, 'IMPORT_ITEM_NOT_FOUND'],
    ['/items/abc/lease', { lease_token: PLANT }, 404, 'IMPORT_ITEM_NOT_FOUND'],
    ['/run/protect-snapshot', { phase: PLANT }, 400, 'IMPORT_BAD_REQUEST'],
  ];
  for (const [path, body, code, name] of cases) {
    const r = await w.call(`${OPS}${path}`, { body });
    assert.equal(r.status, code, path);
    assert.equal(r.headers.get('cache-control'), NO_STORE);
    const text = await r.text();
    const j = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(j).sort(), ['code', 'message'], path);
    assert.equal(j.code, name, path);
    assert.ok(String(j.message).length <= 300);
    assert.ok(!text.includes(PLANT) && !text.includes('999999') && !/select|insert|sqlite/i.test(text), `${path}: no echo`);
  }
  // A body over 2 MB.
  const big = await w.call(`${OPS}/run/protect-snapshot`, { body: { phase: 'before', pad: 'x'.repeat(2 * 1024 * 1024 + 10) } });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { code: string }).code, 'IMPORT_BODY_TOO_LARGE');
});

test('the rate limit: 600 calls a minute per run, then 429 RATE_LIMITED with Retry-After', async () => {
  const w = opsWorld();
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(w.raw);
  assert.equal((await w.call(`${OPS}/run/status`)).status, 200);
  // The bucket is keyed by the run id, whatever address the job's calls come from.
  const row = w.raw.prepare('SELECT key, window_start FROM rate_limits WHERE key LIKE ?').get('catalog-import-ops:%') as { key: string; window_start: number };
  assert.equal(row.key, `catalog-import-ops:k:${OPS_RUN}`);
  w.raw.prepare('UPDATE rate_limits SET count = 600 WHERE key = ?').run(row.key);
  const r = await w.call(`${OPS}/run/status`, { ip: '198.51.100.99' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.equal(r.headers.get('cache-control'), NO_STORE);
  assert.equal(((await r.json()) as { code: string }).code, 'RATE_LIMITED');
});

test('the deception gate knows the prefix: a bad-token storm from a tool is not probing, and a network block never reaches the door', async () => {
  assert.ok(SERVER_TO_SERVER.includes('/api/ops/catalog-import/'));
  assert.ok(serverToServer('/api/ops/catalog-import/hello'));
  const d = await deceptionWorld();
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(d.raw);
  const ops = (headers: Record<string, string>, ip = '203.0.113.7') => d.call(`${OPS}/run/status`, { ip, headers: { ...TOOL, ...headers } });
  for (let i = 0; i < 30; i++) assert.equal((await ops({ Authorization: `Bearer ${'d'.repeat(64)}`, 'X-Levonis-Import-Protocol': '2' }, '198.51.100.31')).status, 404);
  const events = d.raw.prepare('SELECT COUNT(*) AS n FROM security_events').get() as { n: number };
  const blocks = d.raw.prepare('SELECT COUNT(*) AS n FROM security_blocks').get() as { n: number };
  assert.equal(Number(events.n), 0, 'no security event for the door\'s uniform 404s');
  assert.equal(Number(blocks.n), 0, 'and no block');
  // A tool's decoy hit blocks its network for tools; the runner on that shared address still reaches its door.
  await d.call('/.env', { headers: TOOL });
  assert.equal((await d.call('/api/products', { headers: TOOL })).status, 403, 'the network is blocked for tools');
  const r = await ops({ Authorization: `Bearer ${TOKEN}`, 'X-Levonis-Import-Protocol': '2' });
  assert.equal(r.status, 200, 'the ops door is server to server: never a network block');
});

// ---------------------------------------------------------------- the reviewed scope, through the routes

async function toValidating(w: OpsWorld, sid: string): Promise<string> {
  const lease = (await (await w.call(`${OPS}/items/${sid}/lease`, { body: { lease_token: '' } })).json()) as { lease_token: string };
  const t = lease.lease_token;
  for (const [state, outcome] of [['EXTRACTING', 'start'], ['ENRICHING', 'ok'], ['VALIDATING', 'ok']]) {
    const r = await w.call(`${OPS}/items/${sid}/event`, { body: { lease_token: t, state, outcome, code: '', message: '', retry_at: '', release: false, detail: {} } });
    assert.equal(r.status, 200, `${state}: ${await r.clone().text()}`);
  }
  return t;
}

test('the reviewed scope through the routes: an unlisted id at /manifest, a differing row, an unlisted merge and a create for a merge source', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  const a1 = sample('a1');
  const rows = [manifestRowOf(x, 1), manifestRowOf(a1, 2)];
  // The A1 is listed as a merge into an existing product; the AMS feeder is not listed at all.
  const matches = [{ source_product_id: a1.sourceProductId, source_handle: a1.handle, levonis_product_id: 'p_existing_a1', decision: 'merge', value_map: {}, reason: 'same_model', reviewed_by: 't', reviewed_at: '2026-10-15' }];
  setBundle(bundleTexts({ manifestRows: rows, matches }));
  openRun(w.raw);
  const row = (r: Record<string, unknown>) => ({ ...r, source_collections: [], breadcrumbs: '', discovery_sources: ['sitemap'], discovered_at: '2026-10-15T00:00:00.000Z' });
  const manifest = (rs: unknown[]) => w.call(`${OPS}/manifest`, { body: { rows: rs } });
  // An unlisted source id.
  let r = await manifest([row({ ...rows[0], source_product_id: '123456789' })]);
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { code: string }).code, 'REVIEWED_SCOPE_REFUSED');
  // A listed id whose handle, queue position or hold differs from the bundle.
  for (const bad of [{ handle: 'another-handle' }, { queue_position: 9 }, { hold_code: 'OWNER_HIDDEN' }, { curated: true }]) {
    r = await manifest([row({ ...rows[0], ...bad })]);
    assert.equal(r.status, 409, JSON.stringify(bad));
  }
  assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM catalog_import_items').get() as { n: number }).n), 0, 'a refused call writes nothing');
  // The rows as the bundle has them: accepted, idempotent.
  for (let i = 0; i < 2; i++) assert.deepEqual(await (await manifest(rows.map(row))).json(), { accepted: 2 });
  assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM catalog_import_items').get() as { n: number }).n), 2);
  await w.call(`${OPS}/run/prepare-taxonomy`, { body: {} });
  // An unlisted merge: the feeder sent as a merge into some product.
  const t = await toValidating(w, x.sourceProductId);
  const merge = buildFor({ queue: 0 }, 'ams-2-pro-feeder-unit', { writeMode: 'merge', mergeProductId: 'p_some_product' }).payload;
  r = await w.call(`${OPS}/items/${x.sourceProductId}/stage`, { body: { lease_token: t, payload: merge, document_checks: [] } });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { code: string }).code, 'IMPORT_REVIEWED_SCOPE_REFUSED');
  // The same item staged as the create it is: accepted (the run's one in-flight slot is this item's).
  const create = buildFor({ queue: 0 }, 'ams-2-pro-feeder-unit').payload;
  r = await w.call(`${OPS}/items/${x.sourceProductId}/stage`, { body: { lease_token: t, payload: create, document_checks: [] } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(create.product_id, newProductIdOf(x.sourceProductId));
  // A create for a source the matches file lists as a merge, refused even before its turn could matter.
  const w2 = opsWorld();
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(a1, 1)], matches }));
  openRun(w2.raw);
  await w2.call(`${OPS}/manifest`, { body: { rows: [row(manifestRowOf(a1, 1))] } });
  await w2.call(`${OPS}/run/prepare-taxonomy`, { body: {} });
  const t2 = await toValidating(w2, a1.sourceProductId);
  const a1Create = buildFor({ queue: 0 }, 'a1').payload;
  r = await w2.call(`${OPS}/items/${a1.sourceProductId}/stage`, { body: { lease_token: t2, payload: a1Create, document_checks: [] } });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { code: string }).code, 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(Number((w2.raw.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n), 0);
});

test('the dev media stand-in: absent from every wrangler.jsonc block, and refused unless the Worker was reached on a loopback host', async () => {
  const text = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  assert.doesNotMatch(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), /CATALOG_IMPORT_MEDIA_ORIGIN/, 'no environment declares the stand-in');
  const { standInFetcher, mediaUrlAllowed } = await import('../worker/lib/catalogImport/media');
  const env = { CATALOG_IMPORT_MEDIA_ORIGIN: 'http://127.0.0.1:8899' };
  assert.equal(standInFetcher(env, 'https://levonis-iq.com/api/ops/catalog-import/items/1/media'), undefined, 'the live host: never');
  assert.equal(standInFetcher(env, 'https://levonis-staging.example.workers.dev/x'), undefined);
  assert.equal(standInFetcher({ CATALOG_IMPORT_MEDIA_ORIGIN: 'https://evil.example' }, 'http://127.0.0.1:8787/x'), undefined, 'a non-loopback origin: never');
  assert.equal(standInFetcher({ CATALOG_IMPORT_MEDIA_ORIGIN: 'http://127.0.0.1:8899/path' }, 'http://127.0.0.1:8787/x'), undefined, 'an origin with a path: never');
  assert.equal(typeof standInFetcher(env, 'http://127.0.0.1:8787/api/ops/catalog-import/items/1/media'), 'function', 'wrangler dev --local only');
  // The allow-list itself is the CDN's hosts over https, whatever fetcher is behind it.
  assert.equal(mediaUrlAllowed('https://store.bblcdn.com/s1/x.png'), true);
  for (const bad of ['http://store.bblcdn.com/x.png', 'https://store-dev.bblcdn.com/x.png', 'https://evil.example/x.png', 'https://u:p@store.bblcdn.com/x.png', 'https://store.bblcdn.com.evil.example/x.png']) {
    assert.equal(mediaUrlAllowed(bad), false, bad);
  }
});

test('media: store.bblcdn.com over https on every hop; any other host is MEDIA_HOST_NOT_ALLOWED and never asked', async () => {
  const { ingestProductMediaUrl } = await import('../worker/lib/productMediaIngest');
  const { GuardedFetchError } = await import('../worker/lib/fetchGuard');
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(new URL(url).hostname);
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } });
  }) as unknown as typeof fetch;
  const allowHost = (h: string) => h === 'store.bblcdn.com';
  const env = { DB: null, BUCKET: null, R2_PUBLIC: null, R2_PRIVATE: null, IMAGES: null } as never;
  await assert.rejects(() => ingestProductMediaUrl(env, 'https://evil.example/x.png', { allowHost, fetcher }), (e: unknown) => e instanceof GuardedFetchError && e.code === 'HOST_NOT_ALLOWED');
  assert.deepEqual(asked, [], 'a host off the list is never asked');
  await assert.rejects(() => ingestProductMediaUrl(env, 'https://store.bblcdn.com/x.png', { allowHost, fetcher }), (e: unknown) => e instanceof GuardedFetchError && e.code === 'HOST_NOT_ALLOWED');
  assert.deepEqual(asked, ['store.bblcdn.com'], 'a redirect off the list stops before its request');
  // Through the route: the answer says MEDIA_HOST_NOT_ALLOWED, nothing is fetched, the row records the failure.
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  const { installCdnDouble, restoreFetch } = await import('./fixtures/catalogImportOps');
  installCdnDouble(w);
  try {
    await w.call(`${OPS}/manifest`, { body: { rows: [{ ...manifestRowOf(x, 1), source_collections: [], breadcrumbs: '', discovery_sources: ['sitemap'], discovered_at: '2026-10-15' }] } });
    await w.call(`${OPS}/run/prepare-taxonomy`, { body: {} });
    const t = await toValidating(w, x.sourceProductId);
    const payload = buildFor({ queue: 0 }, 'ams-2-pro-feeder-unit').payload;
    assert.equal((await w.call(`${OPS}/items/${x.sourceProductId}/stage`, { body: { lease_token: t, payload, document_checks: [] } })).status, 200);
    await w.call(`${OPS}/items/${x.sourceProductId}/event`, { body: { lease_token: t, state: 'INGESTING_MEDIA', outcome: 'ok', code: '', message: '', retry_at: '', release: false, detail: {} } });
    const r = await w.call(`${OPS}/items/${x.sourceProductId}/media`, {
      body: { lease_token: t, media: [{ source_media_id: 'm1', role: 'gallery', source_url: 'https://evil.example/a.png' }, { source_media_id: 'm2', role: 'gallery', source_url: 'http://store.bblcdn.com/b.png' }] },
    });
    assert.equal(r.status, 200);
    const media = ((await r.json()) as { media: Array<{ status: string; error_code: string }> }).media;
    assert.deepEqual(media.map((m) => `${m.status}:${m.error_code}`), ['failed:MEDIA_HOST_NOT_ALLOWED', 'failed:MEDIA_HOST_NOT_ALLOWED']);
    assert.deepEqual(w.cdn.served, []);
    assert.deepEqual(w.cdn.refused, []);
    // Five media in one call are refused before anything.
    const five = Array.from({ length: 5 }, (_, i) => ({ source_media_id: `n${i}`, role: 'gallery', source_url: 'https://store.bblcdn.com/x.png' }));
    const r5 = await w.call(`${OPS}/items/${x.sourceProductId}/media`, { body: { lease_token: t, media: five } });
    assert.equal(r5.status, 400);
    assert.equal(((await r5.json()) as { code: string }).code, 'MEDIA_BATCH_SIZE');
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------- review 6b

/** An item of the world at INGESTING_MEDIA through the routes, its create staged; the lease token. */
async function toIngesting(w: OpsWorld, handle: 'ams-2-pro-feeder-unit' = 'ams-2-pro-feeder-unit'): Promise<{ sid: string; t: string }> {
  const x = sample(handle);
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  await w.call(`${OPS}/manifest`, { body: { rows: [{ ...manifestRowOf(x, 1), source_collections: [], breadcrumbs: '', discovery_sources: ['sitemap'], discovered_at: '2026-10-15' }] } });
  await w.call(`${OPS}/run/prepare-taxonomy`, { body: {} });
  const t = await toValidating(w, x.sourceProductId);
  const payload = buildFor({ queue: 0 }, handle).payload;
  assert.equal((await w.call(`${OPS}/items/${x.sourceProductId}/stage`, { body: { lease_token: t, payload, document_checks: [] } })).status, 200);
  await w.call(`${OPS}/items/${x.sourceProductId}/event`, { body: { lease_token: t, state: 'INGESTING_MEDIA', outcome: 'ok', code: '', message: '', retry_at: '', release: false, detail: {} } });
  return { sid: x.sourceProductId, t };
}

test('review 6b: /stage refuses a payload whose route is not the one the manifest row was reviewed for', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  await w.call(`${OPS}/manifest`, { body: { rows: [{ ...manifestRowOf(x, 1), source_collections: [], breadcrumbs: '', discovery_sources: ['sitemap'], discovered_at: '2026-10-15' }] } });
  await w.call(`${OPS}/run/prepare-taxonomy`, { body: {} });
  const t = await toValidating(w, x.sourceProductId);
  // The printers' route: a section the map knows, but not this row's.
  const moved = { ...buildFor({ queue: 0 }, 'ams-2-pro-feeder-unit').payload, route: '552709755391528960>552709755467026432>552709755534135296' };
  const r = await w.call(`${OPS}/items/${x.sourceProductId}/stage`, { body: { lease_token: t, payload: moved, document_checks: [] } });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { code: string }).code, 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n), 0);
});

test('review 6b: a passing D1 error on the door\'s own token read is a transient 503 — only a missing 0195 is the 404', async () => {
  const w = opsWorld();
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(w.raw);
  const db = w.env.DB as D1Database & Record<string, unknown>;
  let fail = '';
  w.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          if (fail && /FROM catalog_import_runs/.test(sql) && /token_sha256 = \?/.test(sql)) {
            const message = fail;
            fail = '';
            const st = { bind: () => st, first: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, run: async () => { throw new Error(message); } };
            return st;
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  for (const message of ['D1_ERROR: Network connection lost.', 'D1 DB is overloaded. Requests queued for too long.', 'D1_ERROR: D1 DB reset because its code was updated.']) {
    fail = message;
    const r = await w.call(`${OPS}/run/status`);
    assert.equal(r.status, 503, message);
    assert.equal(((await r.json()) as { code: string }).code, 'D1_OVERLOADED');
    assert.equal(r.headers.get('cache-control'), NO_STORE);
    assert.equal((await w.call(`${OPS}/run/status`)).status, 200, 'the next call answers');
  }
  fail = 'no such table: catalog_import_runs';
  assert.equal((await w.call(`${OPS}/run/status`)).status, 404, 'a database without 0195: the door does not exist');
});

test('review 6b: media over https on the default port on EVERY hop — a redirect to http:// or to another port is refused, never fetched', async () => {
  const { ingestProductMediaUrl } = await import('../worker/lib/productMediaIngest');
  const { GuardedFetchError } = await import('../worker/lib/fetchGuard');
  const { mediaUrlAllowed } = await import('../worker/lib/catalogImport/media');
  const env = { DB: null, BUCKET: null, R2_PUBLIC: null, R2_PRIVATE: null, IMAGES: null } as never;
  const allowHost = (h: string) => h === 'store.bblcdn.com';
  const allowUrl = (u: URL) => u.protocol === 'https:' && u.port === '';
  for (const location of ['http://store.bblcdn.com/s1/plain.png', 'http://store.bblcdn.com:80/s1/plain.png', 'https://store.bblcdn.com:8443/s1/other.png']) {
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return new Response(null, { status: 302, headers: { location } });
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => ingestProductMediaUrl(env, 'https://store.bblcdn.com/s1/a.png', { allowHost, allowUrl, fetcher }),
      (e: unknown) => e instanceof GuardedFetchError && e.code === 'HOST_NOT_ALLOWED',
      location
    );
    assert.deepEqual(asked, ['https://store.bblcdn.com/s1/a.png'], `${location}: the downgraded hop is never requested`);
  }
  assert.equal(mediaUrlAllowed('https://store.bblcdn.com:8443/x.png'), false, 'nor a first hop on another port');
  assert.equal(mediaUrlAllowed('https://store.bblcdn.com:443/x.png'), true, 'the default port, spelled out');
  // Through the route: the store answers a redirect to plain http; the medium fails MEDIA_HOST_NOT_ALLOWED, the http URL is never asked.
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(url);
    return new Response(null, { status: 302, headers: { location: 'http://store.bblcdn.com/s1/plain.png' } });
  }) as typeof fetch;
  try {
    const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: [{ source_media_id: 'm1', role: 'gallery', source_url: 'https://store.bblcdn.com/s1/a.png' }] } });
    const media = ((await r.json()) as { media: Array<{ status: string; error_code: string }> }).media;
    assert.deepEqual(media.map((m) => `${m.status}:${m.error_code}`), ['failed:MEDIA_HOST_NOT_ALLOWED']);
    assert.deepEqual(asked, ['https://store.bblcdn.com/s1/a.png']);
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------------------------------------------------------- the allow-list's two hosts, and what is not a picture (§C.4)

/** The global fetch, as the guard sees it: a redirect where `redirects` names one, else a PNG; every URL asked recorded. */
async function withStoreFetch<T>(redirects: Record<string, string>, body: (asked: string[]) => Promise<T>): Promise<T> {
  const { pngBytes } = await import('./fixtures/imageDoubles');
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(url);
    const location = redirects[url];
    if (location) return new Response(null, { status: 302, headers: { location } });
    return new Response(pngBytes(320, 240) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  try {
    return await body(asked);
  } finally {
    globalThis.fetch = real;
  }
}

test('media allow-list: exactly store.bblcdn.com and store.bblcdn.eu, https on the default port; nothing near them', async () => {
  const { MEDIA_HOSTS, mediaHostAllowed, mediaUrlAllowed } = await import('../worker/lib/catalogImport/media');
  assert.deepEqual([...MEDIA_HOSTS].sort(), ['store.bblcdn.com', 'store.bblcdn.eu'], 'the two exact hosts: any widening fails here');
  for (const ok of ['https://store.bblcdn.eu/s8/default/0a1b/feature.png', 'https://store.bblcdn.eu:443/s8/feature.png', 'https://STORE.BBLCDN.EU/s8/feature.png', 'https://store.bblcdn.com/s7/a.jpg']) {
    assert.equal(mediaUrlAllowed(ok), true, ok);
  }
  for (const bad of [
    'http://store.bblcdn.eu/s8/feature.png',
    'https://store.bblcdn.eu:8443/s8/feature.png',
    'https://u:p@store.bblcdn.eu/s8/feature.png',
    'https://store.bblcdn.eu.evil.example/s8/feature.png',
    'https://x.store.bblcdn.eu/s8/feature.png',
    'https://bblcdn.eu/s8/feature.png',
    'https://store.bblcdn.eu./s8/feature.png',
    'https://store-dev.bblcdn.eu/s8/feature.png',
    'https://cdn.shopify.com/s/files/1/0584/7236/6216/files/feature.png?v=1',
    'not a url',
  ]) {
    assert.equal(mediaUrlAllowed(bad), false, bad);
  }
  for (const host of ['bblcdn.eu', 'x.store.bblcdn.eu', 'store.bblcdn.eu.evil.example', 'cdn.shopify.com', 'store.bblcdn.net', '']) assert.equal(mediaHostAllowed(host), false, host);
});

test('media allow-list on EVERY hop, through the route (the real allowHost and allowUrl): .com → .eu is followed; .eu → another host, http:// or another port is refused and never asked', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const call = async (media: Array<{ source_media_id: string; source_url: string }>) => {
    const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: media.map((m) => ({ ...m, role: 'description' })) } });
    assert.equal(r.status, 200);
    return ((await r.json()) as { media: Array<{ status: string; error_code: string }> }).media.map((m) => `${m.status}:${m.error_code}`);
  };
  await withStoreFetch(
    {
      'https://store.bblcdn.com/s7/moved.png': 'https://store.bblcdn.eu/s8/moved.png',
      'https://store.bblcdn.eu/s8/to-shop.png': 'https://cdn.shopify.com/s/files/1/0584/7236/6216/files/to-shop.png',
      'https://store.bblcdn.eu/s8/to-http.png': 'http://store.bblcdn.eu/s8/to-http.png',
      'https://store.bblcdn.eu/s8/to-port.png': 'https://store.bblcdn.eu:8443/s8/to-port.png',
    },
    async (asked) => {
      assert.deepEqual(await call([{ source_media_id: 'h1', source_url: 'https://store.bblcdn.com/s7/moved.png' }, { source_media_id: 'h2', source_url: 'https://store.bblcdn.eu/s8/plain.png' }]), ['stored:', 'stored:']);
      assert.deepEqual(asked, ['https://store.bblcdn.com/s7/moved.png', 'https://store.bblcdn.eu/s8/moved.png', 'https://store.bblcdn.eu/s8/plain.png']);
      asked.length = 0;
      assert.deepEqual(
        await call([
          { source_media_id: 'h3', source_url: 'https://store.bblcdn.eu/s8/to-shop.png' },
          { source_media_id: 'h4', source_url: 'https://store.bblcdn.eu/s8/to-http.png' },
          { source_media_id: 'h5', source_url: 'https://store.bblcdn.eu/s8/to-port.png' },
        ]),
        ['failed:MEDIA_HOST_NOT_ALLOWED', 'failed:MEDIA_HOST_NOT_ALLOWED', 'failed:MEDIA_HOST_NOT_ALLOWED']
      );
      assert.deepEqual(asked, ['https://store.bblcdn.eu/s8/to-shop.png', 'https://store.bblcdn.eu/s8/to-http.png', 'https://store.bblcdn.eu/s8/to-port.png'], 'only the first hop of each');
    }
  );
});

test('nonImageKindOf: a video or vector file by the PATH of its address only', async () => {
  const { nonImageKindOf } = await import('../worker/lib/catalogImport/media');
  const table: Array<[string, string | null]> = [
    ['https://store.bblcdn.com/s7/a/tvc.mp4', 'video_file'],
    ['https://store.bblcdn.com/s7/a/TVC.MP4', 'video_file'],
    ['https://store.bblcdn.eu/s8/a/clip.webm?v=2', 'video_file'],
    ['https://store.bblcdn.com/s7/a/clip.mov', 'video_file'],
    ['https://store.bblcdn.com/s7/a/clip.m4v', 'video_file'],
    ['https://store.bblcdn.com/s7/a/clip.ogv', 'video_file'],
    ['https://store.bblcdn.com/s7/a/live.m3u8', 'video_file'],
    ['https://store.bblcdn.com/s7/a/3d.svg', 'vector_file'],
    ['https://store.bblcdn.com/s7/a/2D.SVGZ', 'vector_file'],
    ['https://cdn.shopify.com/s/files/1/x/3d.svg?v=17', 'vector_file'],
    ['https://store.bblcdn.com/s7/a/x.mp4.png', null],
    ['https://store.bblcdn.com/svg/x.png', null],
    ['https://store.bblcdn.com/s7/mp4', null],
    ['https://store.bblcdn.com/s7/x.png?f=.mp4', null],
    ['https://store.bblcdn.com/s7/x.png#a.svg', null],
    ['https://store.bblcdn.com/s7/x.gif', null],
    ['https://store.bblcdn.com/s7/x.jpg', null],
    ['not a url', null],
  ];
  for (const [url, kind] of table) assert.equal(nonImageKindOf(url), kind, url);
});

test('media: a video or vector address is MEDIA_NOT_AN_IMAGE before any request, on any host, with no try counted; an .eu picture is fetched and stored', async () => {
  const { eventCode } = await import('../worker/lib/catalogImport/auth');
  assert.equal(eventCode('MEDIA_NOT_AN_IMAGE'), 'MEDIA_NOT_AN_IMAGE', 'a code the events know');
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { installCdnDouble, restoreFetch } = await import('./fixtures/catalogImportOps');
  installCdnDouble(w);
  try {
    const media = [
      { source_media_id: 'v1', role: 'description', source_url: 'https://store.bblcdn.com/s7/a/tvc.mp4' },
      { source_media_id: 'v2', role: 'description', source_url: 'https://store.bblcdn.eu/s8/a/3d.svg' },
      { source_media_id: 'v3', role: 'in_the_box', source_url: 'https://cdn.shopify.com/s/files/1/x/2d.svg?v=3' },
      { source_media_id: 'v4', role: 'description', source_url: 'https://cdn.shopify.com/s/files/1/x/feature.png?v=3' },
    ];
    for (const round of [1, 2]) {
      const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media } });
      assert.equal(r.status, 200);
      const answers = ((await r.json()) as { media: Array<{ status: string; error_code: string }> }).media;
      assert.deepEqual(answers.map((m) => `${m.status}:${m.error_code}`), ['failed:MEDIA_NOT_AN_IMAGE', 'failed:MEDIA_NOT_AN_IMAGE', 'failed:MEDIA_NOT_AN_IMAGE', 'failed:MEDIA_HOST_NOT_ALLOWED'], `round ${round}`);
    }
    assert.deepEqual(w.cdn.served, [], 'nothing requested');
    assert.deepEqual(w.cdn.refused, [], 'not even asked of the double');
    const rows = w.raw.prepare("SELECT source_media_id, status, error_code, attempts FROM catalog_import_media WHERE source_media_id LIKE 'v%' ORDER BY source_media_id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((x) => ({ ...x })), [
      { source_media_id: 'v1', status: 'failed', error_code: 'MEDIA_NOT_AN_IMAGE', attempts: 0 },
      { source_media_id: 'v2', status: 'failed', error_code: 'MEDIA_NOT_AN_IMAGE', attempts: 0 },
      { source_media_id: 'v3', status: 'failed', error_code: 'MEDIA_NOT_AN_IMAGE', attempts: 0 },
      { source_media_id: 'v4', status: 'failed', error_code: 'MEDIA_HOST_NOT_ALLOWED', attempts: 0 },
    ]);
    // The second host is served like the first: fetched once, stored, one try.
    const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: [{ source_media_id: 'e1', role: 'description', source_url: 'https://store.bblcdn.eu/s8/default/0a1b/feature.png' }] } });
    assert.deepEqual(((await r.json()) as { media: Array<{ status: string }> }).media.map((m) => m.status), ['stored']);
    assert.deepEqual(w.cdn.served, ['https://store.bblcdn.eu/s8/default/0a1b/feature.png']);
    assert.equal(Number((w.raw.prepare("SELECT attempts FROM catalog_import_media WHERE source_media_id = 'e1'").get() as { attempts: number }).attempts), 1);
  } finally {
    restoreFetch();
  }
});

test('review 6b: an original over the source cap is fetched once more as the CDN\'s 2400-px rendition, recorded cdn_resized', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const real = globalThis.fetch;
  const asked: Array<{ url: string; accept: string }> = [];
  const { pngBytes } = await import('./fixtures/imageDoubles');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    asked.push({ url, accept: new Headers(init?.headers).get('accept') ?? '' });
    if (url.includes('__op__')) return new Response(pngBytes(320, 240) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response(new Uint8Array(9 * 1024 * 1024) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) } });
  }) as typeof fetch;
  try {
    const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: [{ source_media_id: 'huge1', role: 'gallery', source_url: 'https://store.bblcdn.com/s1/huge.png' }] } });
    const media = ((await r.json()) as { media: Array<{ status: string; r2_key: string; error_code: string }> }).media;
    assert.equal(media[0].status, 'stored', JSON.stringify(media));
    assert.deepEqual(asked.map((a) => a.url), ['https://store.bblcdn.com/s1/huge.png', 'https://store.bblcdn.com/s1/huge.png__op__resize,m_lfit,w_2400__op__format,f_auto__op__quality,q_90']);
    assert.equal(asked[1].accept, 'image/jpeg,image/png');
    const row = w.raw.prepare("SELECT status, fetched_variant, source_url FROM catalog_import_media WHERE source_media_id = 'huge1'").get() as Record<string, string>;
    assert.deepEqual({ ...row }, { status: 'stored', fetched_variant: 'cdn_resized', source_url: 'https://store.bblcdn.com/s1/huge.png' }, 'the provenance stays the original');
  } finally {
    globalThis.fetch = real;
  }
});

test('review 6b, 2: an original the IMAGES binding refuses for its input size (under the 8 MB cap) is fetched once more as the 2400-px rendition', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { imagesDouble, pngBytes } = await import('./fixtures/imageDoubles');
  // The binding's area refusal (§R-4 "huge PNGs"): an input wider than 10 000 px is refused, anything else converted.
  const base = imagesDouble();
  const widthOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(16);
  w.env.IMAGES = {
    info: base.binding.info,
    input(stream: ReadableStream<Uint8Array>) {
      const bytes = new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
      let box: Record<string, unknown> | null = null;
      const handle = {
        transform(x: Record<string, unknown>) {
          box = x;
          return handle;
        },
        async output(o: { format: string; quality?: number }) {
          const b = await bytes;
          if (widthOf(b) > 10_000) throw Object.assign(new Error('ERROR 9413: Image exceeds the maximum area (100 megapixels)'), { code: 9413 });
          let inner = base.binding.input(new Blob([b]).stream());
          if (box) inner = inner.transform(box as never);
          return inner.output(o);
        },
      };
      return handle;
    },
  };
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(url);
    const bytes = url.includes('__op__') ? pngBytes(2400, 2400) : pngBytes(12_000, 12_000);
    return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  try {
    const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: [{ source_media_id: 'area1', role: 'gallery', source_url: 'https://store.bblcdn.com/s1/big.png' }] } });
    const media = ((await r.json()) as { media: Array<{ status: string; error_code: string }> }).media;
    assert.equal(media[0].status, 'stored', JSON.stringify(media));
    assert.deepEqual(asked, ['https://store.bblcdn.com/s1/big.png', 'https://store.bblcdn.com/s1/big.png__op__resize,m_lfit,w_2400__op__format,f_auto__op__quality,q_90']);
    const row = w.raw.prepare("SELECT status, fetched_variant, source_url, attempts FROM catalog_import_media WHERE source_media_id = 'area1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: 'stored', fetched_variant: 'cdn_resized', source_url: 'https://store.bblcdn.com/s1/big.png', attempts: 1 });
    // A rendition the converter refuses too is failed at once (permanent), after exactly one more request.
    asked.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(pngBytes(12_000, 12_000) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    const r2 = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: [{ source_media_id: 'area2', role: 'gallery', source_url: 'https://store.bblcdn.com/s1/big2.png' }] } });
    const m2 = ((await r2.json()) as { media: Array<{ status: string; error_code: string }> }).media;
    assert.deepEqual(m2.map((m) => [m.status, m.error_code]), [['failed', 'IMAGE_CONVERT_FAILED']]);
    assert.equal(asked.length, 2, 'one rendition request, never a loop');
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------------------------------------------------------- an animated GIF stored as its first frame (§C.4 step 2b, DECISIONS row 264)

const GIF_URL = 'https://store.bblcdn.com/s7/default/9f2e/feature.gif';
const FIRST_FRAME = `${GIF_URL}__op__resize,m_lfit,w_2400__op__format,f_png`;

/** The global fetch as the CDN: `answer(url)` per address (a Response, or bytes served 200), every request recorded. */
async function withCdn<T>(answer: (url: string) => Response | Uint8Array, body: (asked: Array<{ url: string; accept: string }>) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const asked: Array<{ url: string; accept: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    asked.push({ url, accept: new Headers(init?.headers).get('accept') ?? '' });
    const a = answer(url);
    return a instanceof Response ? a : new Response(a as unknown as BodyInit, { status: 200 });
  }) as typeof fetch;
  try {
    return await body(asked);
  } finally {
    globalThis.fetch = real;
  }
}

async function mediaCall(w: OpsWorld, sid: string, t: string, media: Array<{ source_media_id: string; source_url: string; role?: string }>) {
  const r = await w.call(`${OPS}/items/${sid}/media`, { body: { lease_token: t, media: media.map((m) => ({ role: 'description', ...m })) } });
  assert.equal(r.status, 200);
  return ((await r.json()) as { media: Array<{ status: string; r2_key: string; width: number | null; height: number | null; error_code: string }> }).media;
}

const mediaRow = (w: OpsWorld, id: string) =>
  ({ ...(w.raw.prepare('SELECT status, fetched_variant, derivation, source_url, error_code, attempts, width, height, r2_key FROM catalog_import_media WHERE source_media_id = ?').get(id) as Record<string, unknown>) });

test('an animated GIF is stored as its first frame: the CDN\'s f_png rendition on the same host, verified a still PNG, stored as WebP, its row gif_first_frame; never fetched again; the same key when re-ingested', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes, pngBytes } = await import('./fixtures/imageDoubles');
  const { CDN_FIRST_FRAME_OPS, cdnFirstFrameUrl } = await import('../worker/lib/catalogImport/media');
  assert.equal(cdnFirstFrameUrl(GIF_URL), FIRST_FRAME);
  assert.equal(cdnFirstFrameUrl(`${GIF_URL}?v=3`), `${FIRST_FRAME}?v=3`, 'the operations follow the path; a query stays a query');
  assert.match(CDN_FIRST_FRAME_OPS, /__op__format,f_png$/);
  await withCdn(
    (url) => (url === FIRST_FRAME ? pngBytes(640, 360) : gifBytes(640, 360, 12)),
    async (asked) => {
      const [m] = await mediaCall(w, sid, t, [{ source_media_id: 'gif1', source_url: GIF_URL }]);
      assert.deepEqual([m.status, m.error_code, m.width, m.height], ['stored', '', 640, 360]);
      assert.match(m.r2_key, /^products\/import\/gallery\/[0-9a-f]{64}\.webp$/);
      assert.deepEqual(asked.map((a) => a.url), [GIF_URL, FIRST_FRAME], 'one more request, never a loop');
      assert.equal(asked[1].accept, 'image/jpeg,image/png');
      assert.deepEqual(mediaRow(w, 'gif1'), {
        status: 'stored', fetched_variant: 'cdn_resized', derivation: 'gif_first_frame', source_url: GIF_URL, error_code: '', attempts: 1, width: 640, height: 360, r2_key: m.r2_key,
      }, 'the provenance stays the original; the row says it is a first frame');
      assert.equal(w.bucket.objects.get(m.r2_key)?.contentType, 'image/webp', 'stored as WebP like any picture');
      // Asked again: stored and in R2, never fetched again.
      asked.length = 0;
      const [again] = await mediaCall(w, sid, t, [{ source_media_id: 'gif1', source_url: GIF_URL }]);
      assert.deepEqual([again.status, again.r2_key], ['stored', m.r2_key]);
      assert.equal(asked.length, 0, 'never fetched again');
      // The object gone: re-ingested through the same two requests, to the same key (content-addressed: deterministic).
      await w.bucket.delete(m.r2_key);
      const [re] = await mediaCall(w, sid, t, [{ source_media_id: 'gif1', source_url: GIF_URL }]);
      assert.deepEqual([re.status, re.r2_key], ['stored', m.r2_key]);
      assert.deepEqual(asked.map((a) => a.url), [GIF_URL, FIRST_FRAME]);
      assert.equal(mediaRow(w, 'gif1').derivation, 'gif_first_frame');
      // Another medium showing the same GIF: the same key.
      const [twin] = await mediaCall(w, sid, t, [{ source_media_id: 'gif2', source_url: GIF_URL }]);
      assert.equal(twin.r2_key, m.r2_key);
    }
  );
  const { runProgress } = await import('../worker/lib/catalogImport/report');
  const progress = await runProgress(w.env.DB as never, OPS_RUN);
  assert.equal(progress.first_frame_media_count, 2, 'the run report counts the first frames');
  assert.equal(progress.saved_media_count, 2);
});

test('an animated GIF whose first-frame rendition is still an animation, a still GIF, an APNG, not a picture, a 4xx or a 5xx stays IMAGE_ANIMATED_GIF (failed; pending only while a passing refusal has tries left); nothing stored', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { apngBytes, gifBytes } = await import('./fixtures/imageDoubles');
  const cases: Array<[string, () => Response | Uint8Array, string]> = [
    ['animated', () => gifBytes(640, 360, 12), 'failed'],
    ['gif_still', () => gifBytes(640, 360, 1), 'failed'],
    ['apng', () => apngBytes(640, 360), 'failed'],
    ['html', () => new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } }), 'failed'],
    ['http404', () => new Response('no', { status: 404 }), 'failed'],
    ['http503', () => new Response('busy', { status: 503 }), 'pending'],
  ];
  for (const [name, rendition, status] of cases) {
    const url = `https://store.bblcdn.com/s7/a/${name}.gif`;
    await withCdn(
      (u) => (u.includes('__op__') ? rendition() : gifBytes(320, 240, 3)),
      async (asked) => {
        const [m] = await mediaCall(w, sid, t, [{ source_media_id: name, source_url: url }]);
        assert.deepEqual([m.status, m.error_code, m.r2_key], [status, 'IMAGE_ANIMATED_GIF', ''], name);
        assert.deepEqual(asked.map((a) => a.url), [url, `${url}__op__resize,m_lfit,w_2400__op__format,f_png`], `${name}: one rendition request`);
        assert.deepEqual(
          { ...mediaRow(w, name), r2_key: undefined },
          { status, fetched_variant: 'cdn_resized', derivation: '', source_url: url, error_code: 'IMAGE_ANIMATED_GIF', attempts: 1, width: null, height: null, r2_key: undefined },
          name
        );
      }
    );
  }
  // The passing one: pending until its third try, then failed, still IMAGE_ANIMATED_GIF.
  await withCdn(
    (u) => (u.includes('__op__') ? new Response('busy', { status: 503 }) : gifBytes(320, 240, 3)),
    async () => {
      const second = await mediaCall(w, sid, t, [{ source_media_id: 'http503', source_url: 'https://store.bblcdn.com/s7/a/http503.gif' }]);
      assert.deepEqual(second.map((m) => `${m.status}:${m.error_code}`), ['pending:IMAGE_ANIMATED_GIF']);
      const third = await mediaCall(w, sid, t, [{ source_media_id: 'http503', source_url: 'https://store.bblcdn.com/s7/a/http503.gif' }]);
      assert.deepEqual(third.map((m) => `${m.status}:${m.error_code}`), ['failed:IMAGE_ANIMATED_GIF']);
    }
  );
  assert.equal(Number((w.raw.prepare("SELECT COUNT(*) AS n FROM catalog_import_media WHERE status = 'stored'").get() as { n: number }).n), 0);
  assert.equal(w.bucket.objects.size, 0, 'nothing put in R2');
});

test('a still GIF is unaffected: fetched once, converted and stored as the original, no first frame', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes } = await import('./fixtures/imageDoubles');
  const url = 'https://store.bblcdn.com/s7/a/still.gif';
  await withCdn(
    () => gifBytes(320, 240, 1),
    async (asked) => {
      const [m] = await mediaCall(w, sid, t, [{ source_media_id: 'still', source_url: url }]);
      assert.deepEqual([m.status, m.error_code], ['stored', '']);
      assert.deepEqual(asked.map((a) => a.url), [url]);
      assert.deepEqual(
        { ...mediaRow(w, 'still'), r2_key: undefined, width: undefined, height: undefined },
        { status: 'stored', fetched_variant: 'original', derivation: '', source_url: url, error_code: '', attempts: 1, width: undefined, height: undefined, r2_key: undefined }
      );
    }
  );
});

test('a first-frame rendition redirected to another host — the other allow-listed name included — is refused and never asked (IMAGE_ANIMATED_GIF); one redirected on the same host is followed and stored', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes, pngBytes } = await import('./fixtures/imageDoubles');
  const redirects: Record<string, string> = {
    'https://store.bblcdn.com/s7/a/to-eu.gif__op__resize,m_lfit,w_2400__op__format,f_png': 'https://store.bblcdn.eu/s8/a/to-eu.gif__op__format,f_png',
    'https://store.bblcdn.com/s7/a/to-shop.gif__op__resize,m_lfit,w_2400__op__format,f_png': 'https://cdn.shopify.com/s/files/1/x/to-shop.png',
    'https://store.bblcdn.com/s7/a/to-http.gif__op__resize,m_lfit,w_2400__op__format,f_png': 'http://store.bblcdn.com/s7/a/to-http.gif__op__format,f_png',
    // The CDN's own answer for a large animation (2026-10-20): a 302 to a smaller rendition of the same object.
    'https://store.bblcdn.com/s7/a/big.gif__op__resize,m_lfit,w_2400__op__format,f_png': 'https://store.bblcdn.com/s7/a/big.gif__op__resize,m_lfit,w_1200__op__format,f_png',
  };
  await withCdn(
    (url) => {
      const location = redirects[url];
      if (location) return new Response(null, { status: 302, headers: { location } });
      return url.includes('__op__') ? pngBytes(1200, 675) : gifBytes(2400, 1350, 40);
    },
    async (asked) => {
      const media = await mediaCall(w, sid, t, [
        { source_media_id: 'r1', source_url: 'https://store.bblcdn.com/s7/a/to-eu.gif' },
        { source_media_id: 'r2', source_url: 'https://store.bblcdn.com/s7/a/to-shop.gif' },
        { source_media_id: 'r3', source_url: 'https://store.bblcdn.com/s7/a/to-http.gif' },
        { source_media_id: 'r4', source_url: 'https://store.bblcdn.com/s7/a/big.gif' },
      ]);
      assert.deepEqual(media.map((m) => `${m.status}:${m.error_code}`), ['failed:IMAGE_ANIMATED_GIF', 'failed:IMAGE_ANIMATED_GIF', 'failed:IMAGE_ANIMATED_GIF', 'stored:']);
      const hosts = asked.map((a) => new URL(a.url).host);
      assert.ok(hosts.every((h) => h === 'store.bblcdn.com'), `only the original's host was asked: ${hosts.join(',')}`);
      assert.ok(!asked.some((a) => a.url.startsWith('http://')), 'never over http');
      assert.equal(asked.filter((a) => a.url.startsWith('https://store.bblcdn.com/s7/a/big.gif')).length, 3, 'the original, the rendition, its same-host redirect');
      assert.deepEqual([mediaRow(w, 'r4').derivation, mediaRow(w, 'r4').width], ['gif_first_frame', 1200]);
    }
  );
});

test('an animated GIF over the source cap: the 2400-px rendition (still animated) and then its first frame — three requests at most, stored gif_first_frame', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes, pngBytes } = await import('./fixtures/imageDoubles');
  const url = 'https://store.bblcdn.com/s7/a/huge.gif';
  await withCdn(
    (u) => {
      if (u.endsWith('f_png')) return pngBytes(2400, 1350);
      if (u.includes('__op__')) return gifBytes(2400, 1350, 60);
      return new Response(new Uint8Array(9 * 1024 * 1024) as unknown as BodyInit, { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } });
    },
    async (asked) => {
      const [m] = await mediaCall(w, sid, t, [{ source_media_id: 'huge', source_url: url }]);
      assert.deepEqual([m.status, m.error_code], ['stored', '']);
      assert.deepEqual(asked.map((a) => a.url), [url, `${url}__op__resize,m_lfit,w_2400__op__format,f_auto__op__quality,q_90`, `${url}__op__resize,m_lfit,w_2400__op__format,f_png`]);
      assert.deepEqual([mediaRow(w, 'huge').fetched_variant, mediaRow(w, 'huge').derivation, mediaRow(w, 'huge').attempts], ['cdn_resized', 'gif_first_frame', 1]);
    }
  );
});

/** An answer over the 8 MiB source cap: the existing double (a declared Content-Length), or a body cut off as it streams. */
function oversize(opts: { contentType?: string; lead?: Uint8Array; streamed?: boolean } = {}): Response {
  const size = 9 * 1024 * 1024;
  const headers: Record<string, string> = opts.contentType ? { 'content-type': opts.contentType } : {};
  if (!opts.streamed) return new Response(new Uint8Array(size) as unknown as BodyInit, { status: 200, headers: { ...headers, 'content-length': String(size) } });
  const lead = opts.lead ?? new Uint8Array(0);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === 0) {
        sent = lead.byteLength || 1;
        controller.enqueue(lead.byteLength ? lead : new Uint8Array(1));
        return;
      }
      if (sent >= size) return controller.close();
      const chunk = new Uint8Array(1024 * 1024);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Response(body, { status: 200, headers });
}

test('a first-frame rendition redirected to an address the outbound guard refuses (credentials, an IP literal) fails at once IMAGE_ANIMATED_GIF, never asked, never retried; an original redirected there is MEDIA_REDIRECT_REFUSED', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes } = await import('./fixtures/imageDoubles');
  const bad = ['https://u:p@store.bblcdn.com/x.png', 'https://127.0.0.1/x.png'];
  const redirects: Record<string, string> = {
    'https://store.bblcdn.com/s7/a/to-cred.gif__op__resize,m_lfit,w_2400__op__format,f_png': bad[0],
    'https://store.bblcdn.com/s7/a/to-ip.gif__op__resize,m_lfit,w_2400__op__format,f_png': bad[1],
    'https://store.bblcdn.com/s7/a/orig-cred.png': bad[0],
    'https://store.bblcdn.com/s7/a/orig-ip.png': bad[1],
  };
  await withCdn(
    (url) => {
      const location = redirects[url];
      if (location) return new Response(null, { status: 302, headers: { location } });
      return gifBytes(640, 360, 12);
    },
    async (asked) => {
      const media = await mediaCall(w, sid, t, [
        { source_media_id: 'g1', source_url: 'https://store.bblcdn.com/s7/a/to-cred.gif' },
        { source_media_id: 'g2', source_url: 'https://store.bblcdn.com/s7/a/to-ip.gif' },
        { source_media_id: 'o1', source_url: 'https://store.bblcdn.com/s7/a/orig-cred.png' },
        { source_media_id: 'o2', source_url: 'https://store.bblcdn.com/s7/a/orig-ip.png' },
      ]);
      assert.deepEqual(media.map((m) => `${m.status}:${m.error_code}`), ['failed:IMAGE_ANIMATED_GIF', 'failed:IMAGE_ANIMATED_GIF', 'failed:MEDIA_REDIRECT_REFUSED', 'failed:MEDIA_REDIRECT_REFUSED']);
      const urls = asked.map((a) => a.url);
      for (const b of bad) assert.ok(!urls.some((u) => u.includes('u:p@') || u.includes('127.0.0.1') || u === b), `never asked: ${b}`);
      assert.equal(urls.length, 6, 'each GIF: the original and its first frame; each original: one request');
      assert.deepEqual([mediaRow(w, 'g1').attempts, mediaRow(w, 'g2').attempts, mediaRow(w, 'o1').attempts], [1, 1, 1]);
    }
  );
});

test('an animated GIF over the source cap whose 2400-px rendition is over the cap too gets its one first-frame request — a GIF by its .gif path, its declared image/gif, or the GIF8 its cut-off body began with; not a GIF: failed IMAGE_SOURCE_TOO_LARGE after two', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes, pngBytes } = await import('./fixtures/imageDoubles');
  const cases: Array<[string, string, () => Response, () => Response, string]> = [
    ['by_path', 'https://store.bblcdn.com/s7/a/by-path.gif', () => oversize(), () => oversize(), 'stored:'],
    ['by_type', 'https://store.bblcdn.com/s7/a/by-type', () => oversize({ contentType: 'image/gif; charset=binary' }), () => oversize(), 'stored:'],
    ['by_bytes', 'https://store.bblcdn.com/s7/a/by-bytes', () => oversize({ streamed: true, lead: gifBytes(4000, 4000, 2) }), () => oversize(), 'stored:'],
    ['by_rendition', 'https://store.bblcdn.com/s7/a/by-rendition', () => oversize(), () => oversize({ contentType: 'image/gif' }), 'stored:'],
    ['not_gif', 'https://store.bblcdn.com/s7/a/not-gif.png', () => oversize({ contentType: 'image/png' }), () => oversize({ streamed: true, lead: pngBytes(4000, 4000) }), 'failed:IMAGE_SOURCE_TOO_LARGE'],
  ];
  for (const [name, url, original, rendition, outcome] of cases) {
    await withCdn(
      (u) => (u.endsWith('f_png') ? pngBytes(2400, 1350) : u.includes('__op__') ? rendition() : original()),
      async (asked) => {
        const [m] = await mediaCall(w, sid, t, [{ source_media_id: name, source_url: url }]);
        assert.equal(`${m.status}:${m.error_code}`, outcome, name);
        const resized = `${url}__op__resize,m_lfit,w_2400__op__format,f_auto__op__quality,q_90`;
        const expected = outcome === 'stored:' ? [url, resized, `${url}__op__resize,m_lfit,w_2400__op__format,f_png`] : [url, resized];
        assert.deepEqual(asked.map((a) => a.url), expected, `${name}: at most three requests`);
        const row = mediaRow(w, name);
        assert.deepEqual([row.fetched_variant, row.derivation, row.attempts], ['cdn_resized', outcome === 'stored:' ? 'gif_first_frame' : '', 1], name);
      }
    );
  }
});

test('an animated GIF over the source cap whose 2400-px rendition comes back ONE still PNG or JPEG is stored as its first frame (derivation gif_first_frame, two requests); a picture that was not a GIF is not', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  const { gifBytes, jpegBytes, pngBytes } = await import('./fixtures/imageDoubles');
  const cases: Array<[string, string, () => Response, () => Uint8Array, string]> = [
    ['png_by_path', 'https://store.bblcdn.com/s7/a/still-png.gif', () => oversize(), () => pngBytes(2400, 1350), 'gif_first_frame'],
    ['jpeg_by_type', 'https://store.bblcdn.com/s7/a/still-jpeg', () => oversize({ contentType: 'image/gif' }), () => jpegBytes(2400, 1350), 'gif_first_frame'],
    ['png_by_bytes', 'https://store.bblcdn.com/s7/a/still-bytes', () => oversize({ streamed: true, lead: gifBytes(4000, 4000, 2) }), () => pngBytes(2400, 1351), 'gif_first_frame'],
    ['photo', 'https://store.bblcdn.com/s7/a/photo.png', () => oversize({ contentType: 'image/png' }), () => pngBytes(2400, 1352), ''],
  ];
  for (const [name, url, original, rendition, derivation] of cases) {
    await withCdn(
      (u) => (u.includes('__op__') ? rendition() : original()),
      async (asked) => {
        const [m] = await mediaCall(w, sid, t, [{ source_media_id: name, source_url: url }]);
        assert.deepEqual([m.status, m.error_code], ['stored', ''], name);
        assert.deepEqual(asked.map((a) => a.url), [url, `${url}__op__resize,m_lfit,w_2400__op__format,f_auto__op__quality,q_90`], `${name}: no first-frame request`);
        const row = mediaRow(w, name);
        assert.deepEqual([row.status, row.fetched_variant, row.derivation, row.source_url], ['stored', 'cdn_resized', derivation, url], name);
      }
    );
  }
});

test('a database before 0207 (no derivation column): the first frame is stored and recorded all the same, without the note; every read counts none', async () => {
  const w = opsWorld();
  const { sid, t } = await toIngesting(w);
  w.raw.exec('ALTER TABLE catalog_import_media DROP COLUMN derivation');
  const { gifBytes, pngBytes } = await import('./fixtures/imageDoubles');
  await withCdn(
    (url) => (url === FIRST_FRAME ? pngBytes(640, 360) : gifBytes(640, 360, 12)),
    async () => {
      const [m] = await mediaCall(w, sid, t, [{ source_media_id: 'old1', source_url: GIF_URL }]);
      assert.deepEqual([m.status, m.error_code], ['stored', '']);
      const row = w.raw.prepare("SELECT status, fetched_variant, attempts FROM catalog_import_media WHERE source_media_id = 'old1'").get() as Record<string, unknown>;
      assert.deepEqual({ ...row }, { status: 'stored', fetched_variant: 'cdn_resized', attempts: 1 });
    }
  );
  const { firstFrameMediaIds } = await import('../worker/lib/catalogImport/media');
  assert.deepEqual([...(await firstFrameMediaIds(w.env.DB as never, OPS_RUN, sid, ['old1']))], []);
  const { runProgress } = await import('../worker/lib/catalogImport/report');
  const progress = await runProgress(w.env.DB as never, OPS_RUN);
  assert.deepEqual([progress.saved_media_count, progress.first_frame_media_count], [1, 0]);
});

test('review 6b: a passing R2 error on a stored medium answers pending at /media (WRITING: no re-fetch; VERIFYING_LIVE: never failed), in both binding shapes', async () => {
  const { newWorld, stage, write, RUN_ID } = await import('./fixtures/catalogImportWorld');
  const { R2Double } = await import('./fixtures/imageDoubles');
  const { ingestImportMedia } = await import('../worker/lib/catalogImport/media');
  const { itemBySource, finishPublishing } = await import('../worker/lib/catalogImport/items');
  const run = { id: RUN_ID, state: 'running', token_expires_at: '', github_run_id: 'x', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: '' };
  for (const shape of ['one bucket (the fixtures)', 'R2_PUBLIC apart from the legacy BUCKET (wrangler.jsonc)'] as const) {
    const w = newWorld();
    const s = stage(w, 'ams-2-pro-feeder-unit');
    const env = { DB: w.db, BUCKET: shape.startsWith('one') ? w.bucket : new R2Double(), R2_PUBLIC: w.bucket, R2_PRIVATE: new R2Double(), IMAGES: w.images.binding } as never;
    const primary = s.payload.images.find((i) => i.is_primary)!;
    const req = [{ source_media_id: primary.source_media_id, role: 'gallery', source_url: primary.source_url }];
    const head = w.bucket.head.bind(w.bucket);
    const throwOnce = () => {
      let once = true;
      w.bucket.head = (async (key: string) => {
        if (once) {
          once = false;
          throw new Error('R2 internal error (10001)');
        }
        return head(key);
      }) as typeof w.bucket.head;
    };
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      throw new Error('no network in this test');
    }) as typeof fetch;
    try {
      const media = async () => ingestImportMedia(env, 'https://levonis-iq.com/x', run, await itemBySource(w.db, RUN_ID, s.payload.source_product_id), req);
      // WRITING: the HEAD failed — pending, and the stored medium is not fetched again.
      throwOnce();
      assert.deepEqual((await media()).map((m) => [m.status, m.error_code]), [['pending', 'IMAGE_STORAGE_FAILED']], shape);
      assert.deepEqual(asked, [], `${shape}: nothing re-fetched`);
      w.bucket.head = head as typeof w.bucket.head;
      // VERIFYING_LIVE (a resumed runner learning its keys): pending, never failed MEDIA_NOT_STORED.
      await write(w, s);
      await finishPublishing(w.db, run, await itemBySource(w.db, RUN_ID, s.payload.source_product_id));
      throwOnce();
      assert.deepEqual((await media()).map((m) => m.status), ['pending'], shape);
      w.bucket.head = head as typeof w.bucket.head;
      const stored = await media();
      assert.equal(stored[0].status, 'stored', `${shape}: answered stored once R2 answers`);
      // An object R2 positively does not have is still failed MEDIA_NOT_STORED.
      w.bucket.objects.delete(stored[0].r2_key);
      assert.deepEqual((await media()).map((m) => [m.status, m.error_code]), [['failed', 'MEDIA_NOT_STORED']], shape);
    } finally {
      globalThis.fetch = real;
      w.bucket.head = head as typeof w.bucket.head;
    }
  }
});
