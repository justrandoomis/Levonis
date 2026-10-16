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
  // The allow-list itself is store.bblcdn.com over https, whatever fetcher is behind it.
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
