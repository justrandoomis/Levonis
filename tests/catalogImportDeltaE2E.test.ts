/**
 * THE DELTA RUN, END TO END IN PROCESS (Bambu import spec §O): the REAL runner (scripts/bambu-import/run.ts, mode
 * delta) against the REAL Worker (worker/index.ts on the migrated D1 shim, the R2 / IMAGES doubles, a CDN double for
 * store.bblcdn.com) and a fake store serving the committed AMS 2 Pro and filament-buffer pages, robots.txt and the
 * sitemaps.
 *
 *   the door      every delta path answers the uniform 404 without the job token, and for a closed run; /manifest
 *                 refuses the reserved markers; a media item's /stage and /media outside its plan are refused
 *   the delta     run A (closed, partial) wrote the AMS 2 Pro with two gallery pictures failed; the sitemap lists a
 *                 product no run held. mode=delta opens nothing itself (the run row is cf.mjs's), reads robots.txt
 *                 and the sitemaps, plans, reads the new product's page once, registers the media item first and the
 *                 new product last, takes the snapshot `before`, then works the queue (max_items 1): the media item
 *                 walks the state graph to COMPLETE on the public product's own answer, the two pictures attached at
 *                 their original slots, nothing else of the product changed, the new product queued
 *   §E.1 gate     the new product's /stage: refused while an existing Bambu product is a candidate the reviewed
 *                 matches file does not settle (REVIEWED_SCOPE_REFUSED), staged once a reviewed `distinct` entry is
 *                 bundled
 *   a rename      the sitemap lists a handle no run held whose page gives a source id run A holds (the store renamed
 *                 the handle): the row is left out and counted, the media item is registered and worked all the same;
 *                 the media item's OWN page renamed (its reviewed handle 301s to another): moot, COMPLETE with nothing
 *                 attached, and the delta run closes
 *   withdraw      a delta run's NEW product gone at the source: mode=withdraw finds its row (the Worker registered
 *                 it; the reviewed manifest never names it) and withdraws it
 *   content       mode=delta item=content (§O.6): run A wrote the AMS 2 Pro with two description pictures and its box
 *                 picture failed; the content pass reads robots.txt and the page only (no sitemap), puts the three back
 *                 where the import meant them, VERIFY passes on /api/products/<slug> and its /knowledge, nothing else
 *                 of the product moves, and a second content delta queues nothing; an owner's Arabic edit since the
 *                 import leaves the description untouched (owner_edited) while the box picture goes in; a page gone
 *                 at the store is moot (source_gone): COMPLETE, nothing written; the content doors refuse what is not
 *                 a content item's, and an unknown delta marker fails closed
 *
 * Run: node --import tsx --test tests/catalogImportDeltaE2E.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFor, complete, count, newWorld, rebundle, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import { installCdnDouble, openRun, OPS, opsWorld, restoreFetch, setBundle, TOKEN, type OpsWorld } from './fixtures/catalogImportOps';
import { FakeClock } from './fixtures/bambuImportWorld';
import { BAMBU_FIXTURES, pageOf } from './fixtures/bambu/load';
import { REVIEWED_FILES } from '../worker/lib/catalogImport/reviewed';
import { loadReviewedBundle } from '../scripts/bambu-import/discover';
import { ImportLog } from '../scripts/bambu-import/log';
import { SummaryWriter } from '../scripts/bambu-import/summary';
import { contentOnlyPayload, Importer, mediaOnlyPayload, type RunConfig } from '../scripts/bambu-import/run';
import type { PayloadBoxItem } from '../packages/catalog/src/bambuImport/payload';
import { OpsClient } from '../scripts/bambu-import/opsClient';
import { Deadline } from '../scripts/bambu-import/deadline';

after(() => {
  restoreFetch();
  setBundle(null);
});

const SITE = 'https://levonis-iq.com';
const STORE = 'https://us.store.bambulab.com';
const DELTA = 'cir_d0d0d0d0d0d0d0d0d0d0d0d0';
const PAGES: Record<string, string> = {
  'ams-2-pro': readFileSync(join(BAMBU_FIXTURES, 'ams-2-pro.page.html'), 'utf8'),
  'filament-buffer': readFileSync(join(BAMBU_FIXTURES, 'filament-buffer.page.html'), 'utf8'),
};

/** The store: robots.txt, the three sitemaps (listing `listed`), the redirects of renamed handles, and the committed pages. */
function storeAnswer(path: string, listed: readonly string[], seen: string[], redirects: Readonly<Record<string, string>> = {}): Response {
  seen.push(path);
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /cart\n', { status: 200 });
  if (path === '/sitemap_products_1.xml') return new Response(`<urlset>${listed.map((h) => `<url><loc>${STORE}/products/${h}</loc></url>`).join('')}</urlset>`, { status: 200 });
  if (path.endsWith('.xml')) return new Response('<urlset></urlset>', { status: 200 });
  if (redirects[path]) return new Response('', { status: 301, headers: { location: redirects[path] } });
  const m = /^\/products\/([^/]+)$/.exec(path);
  const page = m ? PAGES[decodeURIComponent(m[1])] : undefined;
  return page ? new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('gone', { status: 404 });
}

/** The reviewed files of the world, written where the runner reads them (the Worker gets the same texts). */
function writeBundle(w: World, dir: string): string {
  const data = join(dir, 'data');
  for (const [key, file] of Object.entries(REVIEWED_FILES)) {
    const path = join(data, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, w.texts[key as keyof typeof REVIEWED_FILES]);
  }
  setBundle(w.texts);
  return data;
}

/** Run A: the AMS 2 Pro written with two non-primary gallery pictures failed, then the run closed partial. */
async function closedRunA(before?: (w: World) => void): Promise<{ w: World; sid: string; productId: string; failed: string[] }> {
  const w = newWorld();
  const x = pageOf('ams-2-pro').extraction;
  const { payload } = buildFor(w, x);
  const primary = new Set(payload.images.filter((i) => i.is_primary).map((i) => i.source_media_id));
  const failed = [...new Set(payload.images.filter((i) => !primary.has(i.source_media_id)).map((i) => i.source_media_id))].slice(0, 2);
  const s = stage(w, x, { skipMedia: (id) => failed.includes(id) });
  const { result } = await write(w, s);
  for (const id of failed) {
    const url = payload.images.find((i) => i.source_media_id === id)!.source_url;
    w.raw
      .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, error_code) VALUES (?, ?, ?, 'gallery', ?, 'failed', 'IMAGE_CONVERT_FAILED')")
      .run(RUN_ID, x.sourceProductId, id, url);
  }
  complete(w, s.itemId);
  before?.(w);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'partial' WHERE id = ?").run(RUN_ID);
  return { w, sid: x.sourceProductId, productId: result.product_id, failed };
}

function opsOf(w: World): OpsWorld {
  return opsWorld({ raw: w.raw, env: { BUCKET: w.bucket, R2_PUBLIC: w.bucket, R2_PRIVATE: w.media.R2_PRIVATE, IMAGES: w.images.binding } });
}

const imagesOf = (w: World, productId: string) =>
  w.raw.prepare('SELECT id, sort_order, is_primary, option_value_id, variant_id, r2_key FROM product_images WHERE product_id = ? ORDER BY id').all(productId) as Array<Record<string, unknown>>;
const productRow = (w: World, productId: string) => {
  const r = w.raw.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown>;
  const { updated_at: _u, ...rest } = r;
  void _u;
  return rest;
};

test('the delta paths answer the uniform 404 without the job token or for a closed run; /manifest refuses the reserved markers', async () => {
  const { w } = await closedRunA();
  const ops = opsOf(w);
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-door-'));
  writeBundle(w, dir);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const paths: Array<[string, unknown]> = [
    ['/delta/plan', { from_run: RUN_ID, sitemap_handles: [] }],
    ['/delta/manifest', { from_run: RUN_ID, rows: [] }],
    ['/delta/rows', undefined],
    ['/items/123/media-plan', { lease_token: 'x' }],
    ['/items/123/media-attach', { lease_token: 'x' }],
    ['/items/123/media-complete', { lease_token: 'x' }],
  ];
  // No open run: the door is shut.
  for (const [p, body] of paths) {
    const r = await ops.call(`${OPS}${p}`, { body });
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: 'Not found' });
  }
  openRun(w.raw, { id: DELTA });
  for (const [p, body] of paths) {
    const r = await ops.call(`${OPS}${p}`, { body, token: null });
    assert.equal(r.status, 404, `${p} without a token`);
    assert.deepEqual(await r.json(), { error: 'Not found' });
  }
  // The reserved markers never pass the reviewed manifest's door.
  const row = { ...w.manifestRows[0], discovery_sources: ['media_retry:cir_aaaaaaaaaaaaaaaaaaaaaaaa'], discovered_at: '2026-10-19T00:00:00.000Z' };
  const m = await ops.call(`${OPS}/manifest`, { body: { rows: [row] } });
  assert.equal(m.status, 400);
  // A delta taken from an open run, or from itself: refused.
  const self = await ops.call(`${OPS}/delta/plan`, { body: { from_run: DELTA, sitemap_handles: [] } });
  assert.equal(self.status, 409);
  assert.equal(((await self.json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED');
  // A media item: registered, then refused where it has no business — /stage, and /media outside its plan.
  const plan = (await (await ops.call(`${OPS}/delta/plan`, { body: { from_run: RUN_ID, sitemap_handles: ['ams-2-pro'] } })).json()) as { media: Array<{ source_product_id: string }>; new_handles: string[] };
  assert.deepEqual(plan.new_handles, []);
  const sid = plan.media[0].source_product_id;
  assert.equal((await ops.call(`${OPS}/delta/manifest`, { body: { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: '2026-10-19T00:00:00.000Z' }] } })).status, 200);
  const hello = (await (await ops.call(`${OPS}/hello`, { body: { protocol: 2 } })).json()) as { run: { delta: boolean } };
  assert.equal(hello.run.delta, true, '/hello says the run is a delta');
  const lease = (await (await ops.call(`${OPS}/items/${sid}/lease`, { body: { lease_token: '' } })).json()) as { lease_token: string };
  for (const [state, outcome] of [['EXTRACTING', 'start'], ['ENRICHING', 'ok'], ['VALIDATING', 'ok']]) {
    assert.equal((await ops.call(`${OPS}/items/${sid}/event`, { body: { lease_token: lease.lease_token, state, outcome } })).status, 200, state);
  }
  const payload = mediaOnlyPayload(buildFor(w, pageOf('ams-2-pro').extraction).payload);
  const staged = await ops.call(`${OPS}/items/${sid}/stage`, { body: { lease_token: lease.lease_token, payload } });
  assert.equal(staged.status, 409);
  assert.equal(((await staged.json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED', 'a media item never stages (nor writes)');
  assert.equal((await ops.call(`${OPS}/items/${sid}/media-plan`, { body: { lease_token: lease.lease_token, payload } })).status, 200);
  assert.equal((await ops.call(`${OPS}/items/${sid}/event`, { body: { lease_token: lease.lease_token, state: 'INGESTING_MEDIA', outcome: 'ok' } })).status, 200);
  const primary = payload.images.find((i) => i.is_primary)!;
  const media = await ops.call(`${OPS}/items/${sid}/media`, { body: { lease_token: lease.lease_token, media: [{ source_media_id: primary.source_media_id, role: 'gallery', source_url: primary.source_url }] } });
  assert.equal(media.status, 409);
  assert.equal(((await media.json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED', 'only the failed media of the closed run are fetched again');
  // Closed: the same 404.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(DELTA);
  for (const [p, body] of paths) assert.equal((await ops.call(`${OPS}${p}`, { body })).status, 404, `${p} on a closed run`);
});

test('mode=delta end to end: the media item COMPLETE with its failed pictures attached, nothing else moved, the new product queued behind it; the §E.1 gate', async () => {
  const { w, sid, productId, failed } = await closedRunA();
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-e2e-'));
  try {
    const ops = opsOf(w);
    const dataDir = writeBundle(w, dir);
    installCdnDouble(ops);
    openRun(w.raw, { id: DELTA });
    const beforeImages = imagesOf(w, productId);
    const beforeRow = productRow(w, productId);
    const beforeValues = w.raw.prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id').all(productId);
    const beforeVariants = w.raw.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id').all(productId);

    const clock = new FakeClock(Date.now());
    const storeSeen: string[] = [];
    const listed = ['ams-2-pro', 'filament-buffer'];
    const fetchLike = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.origin === STORE) return storeAnswer(u.pathname, listed, storeSeen);
      if (u.origin === SITE) return ops.fetch(url, init);
      return new Response('no', { status: 404 });
    };
    const lines: string[] = [];
    const outputs: Record<string, string> = {};
    const sealed: string[] = [];
    const cfg: RunConfig = {
      mode: 'delta', runId: '', fromRun: RUN_ID, maxItems: 1, resume: false, chain: false, chainCount: 0, autoWithdraw: false, item: '',
      siteOrigin: SITE, storeOrigin: STORE, dataDir, outDir: join(dir, 'out'), sealKey: 'k'.repeat(43), githubRunId: '1', codeCommit: '', deadlineMs: clock.now() + 330 * 60_000,
    };
    const importer = new Importer(cfg, {
      clock,
      fetch: fetchLike,
      log: new ImportLog((l) => lines.push(l), { siteOrigin: SITE }),
      token: TOKEN,
      bundle: loadReviewedBundle(dataDir),
      seal: (name, data) => {
        sealed.push(name);
        return data.length;
      },
      output: (k, v) => {
        outputs[k] = v;
      },
      summary: new SummaryWriter(undefined),
      openedRunId: DELTA,
      browser: async () => ({ check: async () => assert.fail('a media item never opens the browser'), close: async () => {} }),
    });
    const code = await importer.main();
    assert.equal(code, 0, lines.join('\n'));
    assert.deepEqual(outputs, { more: 'true', blocked: 'false', run_id: DELTA }, lines.join('\n'));

    // The store: robots.txt and the sitemaps first, the new product's page once, the media item's page; ≥ 11 s apart.
    assert.deepEqual(storeSeen, ['/robots.txt', '/sitemap.xml', '/sitemap_products_1.xml', '/sitemap_collections_1.xml', '/products/filament-buffer', '/products/ams-2-pro']);

    // The queue: the media item first (COMPLETE), the new product last (queued).
    const items = w.raw.prepare('SELECT source_product_id, handle, queue_position, processing_state, discovery_sources, breadcrumbs FROM catalog_import_items WHERE run_id = ? ORDER BY queue_position').all(DELTA) as Array<Record<string, string>>;
    assert.equal(items.length, 2);
    assert.deepEqual([items[0].source_product_id, items[0].processing_state, items[0].discovery_sources], [sid, 'COMPLETE', `["media_retry:${RUN_ID}"]`]);
    assert.deepEqual([items[1].handle, items[1].processing_state, items[1].discovery_sources], ['filament-buffer', 'DISCOVERED', '["sitemap","delta_new"]']);
    assert.equal(items[1].breadcrumbs, pageOf('filament-buffer').extraction.route, 'the store route the page gave');
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_protected WHERE run_id = ? AND phase = 'before'", DELTA) > 0, true, 'the protected snapshot before');

    // The product: the two failed pictures attached, at the slots the original write meant; nothing else moved.
    const afterImages = imagesOf(w, productId);
    for (const b of beforeImages) assert.deepEqual(afterImages.find((a) => a.id === b.id), b, 'an existing picture never moves');
    const added = afterImages.filter((a) => !beforeImages.some((b) => b.id === a.id));
    const payload = buildFor(w, pageOf('ams-2-pro').extraction).payload;
    const expected = payload.images.filter((i) => failed.includes(i.source_media_id));
    assert.deepEqual(
      added.map((a) => [a.id, a.sort_order, a.option_value_id, a.variant_id, a.is_primary]).sort(),
      expected.map((i) => [i.id, i.sort_order, i.option_value_id, i.variant_id, 0]).sort()
    );
    assert.deepEqual(productRow(w, productId), beforeRow, 'the product row is untouched');
    assert.deepEqual(w.raw.prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id').all(productId), beforeValues);
    assert.deepEqual(w.raw.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id').all(productId), beforeVariants);
    // The log carries counts, codes and handles: never a store URL or a Levonis id.
    const log = lines.join('\n');
    assert.match(log, /media-only: 2 media attached/);
    assert.doesNotMatch(log, /bblcdn|https:\/\/us\.store|p_[0-9a-f]{20}/);
    assert.ok(sealed.includes('delta-open-report.json'));

    // §E.1 for the new product: an existing Bambu product the rule flags stops the create until the owner decides.
    const nid = items[1].source_product_id;
    w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, brand_id, options, colors, images)
      VALUES ('p_owner_buffer', 'bambu-filament-buffer-old', 'Bambu Lab Filament Buffer', 'x', 'x', 'active', 0, 'brd_bambu', '[]', '[]', '[]')`);
    const client = new OpsClient({ siteOrigin: SITE, token: TOKEN, fetch: (u, i) => ops.fetch(u, i), clock, deadline: new Deadline(clock.now() + 3600_000, clock) });
    const fb = buildFor({ queue: 1 }, pageOf('filament-buffer').extraction).payload;
    const lease = await client.lease(nid);
    let token = lease.lease_token;
    for (const [state, outcome] of [['EXTRACTING', 'start'], ['ENRICHING', 'ok'], ['VALIDATING', 'ok']] as const) {
      await client.event(nid, token, { state, outcome });
    }
    await assert.rejects(() => client.stage(nid, token, fb, []), (e: unknown) => (e as { code?: string }).code === 'REVIEWED_SCOPE_REFUSED');
    // The owner's reviewed decision: not the same product (a committed `distinct` entry), deployed: the stage passes.
    w.matches.push({ source_product_id: nid, source_handle: 'filament-buffer', levonis_product_id: 'p_owner_buffer', decision: 'distinct', value_map: {}, unmapped_variants: [], reason: 'owner_decision', reviewed_by: 't', reviewed_at: 'd' });
    rebundle(w);
    setBundle(w.texts);
    token = (await client.lease(nid, token)).lease_token || token;
    const staged = await client.stage(nid, token, fb, []);
    assert.match(staged.payload_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

test('mode=delta: a renamed store handle (its source id held by an earlier run) is left out and counted, never a refusal of the media items', async () => {
  const fbSid = pageOf('filament-buffer').extraction.sourceProductId;
  const { w, sid } = await closedRunA((world) => {
    // Run A held the filament buffer under its old handle; the store renamed it, and its sitemap lists the new one.
    world.raw
      .prepare(
        `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at)
         VALUES ('cii_fb_old', ?, 'bambu_us', ?, 'filament-buffer-old', 'x', 999, '2026-10-15T00:00:00.000Z')`
      )
      .run(RUN_ID, fbSid);
  });
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-rename-'));
  try {
    const ops = opsOf(w);
    const dataDir = writeBundle(w, dir);
    installCdnDouble(ops);
    openRun(w.raw, { id: DELTA });
    const clock = new FakeClock(Date.now());
    const storeSeen: string[] = [];
    const listed = ['ams-2-pro', 'filament-buffer'];
    const fetchLike = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.origin === STORE) return storeAnswer(u.pathname, listed, storeSeen);
      if (u.origin === SITE) return ops.fetch(url, init);
      return new Response('no', { status: 404 });
    };
    const lines: string[] = [];
    const outputs: Record<string, string> = {};
    const cfg: RunConfig = {
      mode: 'delta', runId: '', fromRun: RUN_ID, maxItems: 1, resume: false, chain: false, chainCount: 0, autoWithdraw: false, item: '',
      siteOrigin: SITE, storeOrigin: STORE, dataDir, outDir: join(dir, 'out'), sealKey: 'k'.repeat(43), githubRunId: '1', codeCommit: '', deadlineMs: clock.now() + 330 * 60_000,
    };
    const importer = new Importer(cfg, {
      clock,
      fetch: fetchLike,
      log: new ImportLog((l) => lines.push(l), { siteOrigin: SITE }),
      token: TOKEN,
      bundle: loadReviewedBundle(dataDir),
      seal: (_name, data) => data.length,
      output: (k, v) => {
        outputs[k] = v;
      },
      summary: new SummaryWriter(undefined),
      openedRunId: DELTA,
      browser: async () => ({ check: async () => assert.fail('a media item never opens the browser'), close: async () => {} }),
    });
    const code = await importer.main();
    const log = lines.join('\n');
    assert.equal(code, 0, log);
    assert.equal(outputs.blocked, 'false', log);
    // The plan saw the new handle; its page was read once and gave the source id run A holds.
    assert.ok(storeSeen.includes('/products/filament-buffer'));
    assert.match(log, /left out: 1 new rows whose product an earlier run or a product already holds, 0 media items whose product is gone, 0 media items an earlier delta already settled/);
    // The media item registered and worked to COMPLETE; nothing registered for the renamed handle.
    const items = w.raw.prepare('SELECT source_product_id, processing_state FROM catalog_import_items WHERE run_id = ? ORDER BY queue_position').all(DELTA) as Array<Record<string, string>>;
    assert.deepEqual(items.map((i) => [i.source_product_id, i.processing_state]), [[sid, 'COMPLETE']]);
    assert.match(log, /media-only: 2 media attached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

/** The real runner on the real Worker of `w`, against the fake store (`listed`, `redirects`, the committed pages). */
function importerOf(
  w: World,
  ops: OpsWorld,
  dataDir: string,
  dir: string,
  clock: FakeClock,
  part: Partial<RunConfig>,
  store: { listed: string[]; redirects?: Record<string, string>; seen: string[] },
  opened = DELTA
) {
  const fetchLike = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.origin === STORE) return storeAnswer(u.pathname, store.listed, store.seen, store.redirects);
    if (u.origin === SITE) return ops.fetch(url, init);
    return new Response('no', { status: 404 });
  };
  const lines: string[] = [];
  const outputs: Record<string, string> = {};
  const cfg: RunConfig = {
    mode: 'delta', runId: '', fromRun: RUN_ID, maxItems: 0, resume: false, chain: false, chainCount: 0, autoWithdraw: false, item: '',
    siteOrigin: SITE, storeOrigin: STORE, dataDir, outDir: join(dir, 'out'), sealKey: 'k'.repeat(43), githubRunId: '1', codeCommit: '', deadlineMs: clock.now() + 330 * 60_000,
    ...part,
  };
  const importer = new Importer(cfg, {
    clock,
    fetch: fetchLike,
    log: new ImportLog((l) => lines.push(l), { siteOrigin: SITE }),
    token: TOKEN,
    bundle: loadReviewedBundle(dataDir),
    seal: (_name, data) => data.length,
    output: (k, v) => {
      outputs[k] = v;
    },
    summary: new SummaryWriter(undefined),
    openedRunId: cfg.mode === 'delta' ? opened : undefined,
    browser: async () => ({ check: async () => assert.fail('a media item never opens the browser'), close: async () => {} }),
  });
  return { importer, lines, outputs };
}

test('mode=delta: the media item\'s own page renamed at the store (its handle 301s to another) is moot — COMPLETE with nothing attached — and the delta run closes', async () => {
  const { w, sid, productId } = await closedRunA();
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-moot-'));
  try {
    const ops = opsOf(w);
    const dataDir = writeBundle(w, dir);
    installCdnDouble(ops);
    openRun(w.raw, { id: DELTA });
    const beforeImages = imagesOf(w, productId);
    const clock = new FakeClock(Date.now());
    // The store renamed ams-2-pro: the old handle answers 301 to the new one, and the sitemap lists the new one.
    PAGES['ams-2-pro-new'] = PAGES['ams-2-pro'];
    const store = { listed: ['ams-2-pro-new'], redirects: { '/products/ams-2-pro': '/products/ams-2-pro-new' }, seen: [] as string[] };
    const a = importerOf(w, ops, dataDir, dir, clock, {}, store);
    const code = await a.importer.main();
    const log = a.lines.join('\n');
    assert.equal(code, 0, log);
    assert.deepEqual([a.outputs.more, a.outputs.blocked], ['false', 'false'], log);
    assert.ok(store.seen.includes('/products/ams-2-pro'), 'the media item read its reviewed handle');
    assert.match(log, /the page no longer reads as this product \(identity_changed\)/);
    assert.match(log, /page no longer this product 2/);
    const item = w.raw.prepare('SELECT processing_state, blocker_code, stage_data FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(DELTA, sid) as Record<string, string>;
    assert.deepEqual([item.processing_state, item.blocker_code], ['COMPLETE', ''], log);
    assert.deepEqual(JSON.parse(item.stage_data).media_retry.rows, []);
    assert.deepEqual(imagesOf(w, productId), beforeImages, 'nothing attached');

    // The run closes the normal way.
    const c = importerOf(w, ops, dataDir, dir, clock, { mode: 'close', runId: DELTA, fromRun: '' }, store);
    const closed = await c.importer.main();
    assert.equal(closed, 0, c.lines.join('\n'));
    assert.equal((w.raw.prepare('SELECT state FROM catalog_import_runs WHERE id = ?').get(DELTA) as { state: string }).state, 'closed');
  } finally {
    delete PAGES['ams-2-pro-new'];
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

test('mode=withdraw: a delta run\'s NEW product gone at the source is found by the row the Worker registered, and withdrawn', async () => {
  const { w } = await closedRunA();
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-withdraw-'));
  try {
    const ops = opsOf(w);
    const dataDir = writeBundle(w, dir);
    openRun(w.raw, { id: DELTA });
    const x = pageOf('filament-buffer').extraction;
    const client = new OpsClient({ siteOrigin: SITE, token: TOKEN, fetch: (u, i) => ops.fetch(u, i), clock: new FakeClock(Date.now()), deadline: new Deadline(Date.now() + 3600_000, new FakeClock(Date.now())) });
    const reg = await client.deltaManifest(RUN_ID, [{ kind: 'new', source_product_id: x.sourceProductId, handle: 'filament-buffer', route: x.route, discovered_at: '2026-10-19T00:00:00.000Z' }]);
    assert.equal(reg.new, 1);
    const lease = await client.lease(x.sourceProductId);
    await client.event(x.sourceProductId, lease.lease_token, { state: 'EXTRACTING', outcome: 'start' });
    await client.event(x.sourceProductId, lease.lease_token, { state: 'BLOCKED', outcome: 'blocked', code: 'SOURCE_WITHDRAWN' });
    // The block was seven hours ago; the page is still gone and the sitemap no longer lists it.
    w.raw.prepare("UPDATE catalog_import_events SET at = ? WHERE run_id = ? AND outcome = 'blocked'").run(new Date(Date.now() - 7 * 3600_000).toISOString(), DELTA);
    delete PAGES['filament-buffer'];
    const clock = new FakeClock(Date.now());
    const store = { listed: ['ams-2-pro'], seen: [] as string[] };
    const r = importerOf(w, ops, dataDir, dir, clock, { mode: 'withdraw', runId: DELTA, fromRun: '', item: x.sourceProductId }, store);
    const code = await r.importer.main();
    assert.equal(code, 0, r.lines.join('\n'));
    assert.ok(store.seen.includes('/products/filament-buffer'), 'the second fetch of the registered handle');
    const state = (w.raw.prepare('SELECT processing_state AS s FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(DELTA, x.sourceProductId) as { s: string }).s;
    assert.equal(state, 'WITHDRAWN_AT_SOURCE');
  } finally {
    PAGES['filament-buffer'] = readFileSync(join(BAMBU_FIXTURES, 'filament-buffer.page.html'), 'utf8');
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

// ---------------------------------------------------------------- the content pass (§O.6)

const DELTA2 = 'cir_d1d1d1d1d1d1d1d1d1d1d1d1';

/** Run A for the content pass: the AMS 2 Pro written with two description pictures and its in-the-box picture failed. */
async function closedRunContent(before?: (w: World, productId: string) => void) {
  const w = newWorld();
  const x = pageOf('ams-2-pro').extraction;
  const { payload } = buildFor(w, x);
  const images = payload.content_blocks.filter((b) => b.kind === 'image' && b.source_media_id);
  const box = payload.specs
    .filter((s) => s.key === 'package.contents')
    .flatMap((s) => s.value_list)
    .find((v): v is PayloadBoxItem => !!v && typeof v === 'object' && !!(v as PayloadBoxItem).source_media_id)!;
  const failed = [
    { id: images[1].source_media_id, role: 'description', url: images[1].source_url },
    { id: images[4].source_media_id, role: 'description', url: images[4].source_url },
    { id: box.source_media_id, role: 'in_the_box', url: box.source_url },
  ];
  const s = stage(w, x, { skipMedia: (id) => failed.some((f) => f.id === id) });
  const { result } = await write(w, s);
  for (const f of failed) {
    w.raw
      .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, error_code) VALUES (?, ?, ?, ?, ?, 'failed', 'IMAGE_CONVERT_FAILED')")
      .run(RUN_ID, x.sourceProductId, f.id, f.role, f.url);
  }
  complete(w, s.itemId);
  before?.(w, result.product_id);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'partial' WHERE id = ?").run(RUN_ID);
  return { w, sid: x.sourceProductId, productId: result.product_id, failed, payload };
}

/** Every row of every table the import could write for the product, every column (the dump shows what moved). */
function everything(w: World, productId: string): Record<string, unknown[]> {
  const q = (sql: string) => w.raw.prepare(sql).all(productId);
  return {
    products: q('SELECT * FROM products WHERE id = ?'),
    specs: q('SELECT * FROM product_spec_values WHERE product_id = ? ORDER BY id'),
    translations: q('SELECT * FROM product_translations WHERE product_id = ? ORDER BY field'),
    images: q('SELECT * FROM product_images WHERE product_id = ? ORDER BY id'),
    values: q('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id'),
    variants: q('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id'),
    documents: q('SELECT * FROM product_documents WHERE product_id = ? ORDER BY id'),
    relations: q('SELECT * FROM product_relations WHERE product_id = ? ORDER BY id'),
    refs: q('SELECT * FROM product_option_source_refs WHERE product_id = ? ORDER BY kind, source_id, levonis_id'),
    sources: q('SELECT * FROM product_source_refs WHERE product_id = ?'),
  };
}

function movedColumns(a: Record<string, unknown[]>, b: Record<string, unknown[]>): string[] {
  const out = new Set<string>();
  for (const t of Object.keys(a)) {
    if (a[t].length !== b[t].length) out.add(`${t}:rows`);
    else
      a[t].forEach((row, i) => {
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) if (JSON.stringify(v) !== JSON.stringify((b[t][i] as Record<string, unknown>)[k])) out.add(`${t}.${k}`);
      });
  }
  return [...out].sort();
}

test('mode=delta item=content end to end: the description and box pictures put back where the import meant them, verified on the public answers, nothing else moved; a second content delta queues nothing', async () => {
  const { w, sid, productId, failed } = await closedRunContent();
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-content-'));
  try {
    const ops = opsOf(w);
    const dataDir = writeBundle(w, dir);
    installCdnDouble(ops);
    openRun(w.raw, { id: DELTA });
    const before = everything(w, productId);
    const clock = new FakeClock(Date.now());
    const store = { listed: [] as string[], seen: [] as string[] };
    const a = importerOf(w, ops, dataDir, dir, clock, { deltaPass: 'content' }, store);
    const code = await a.importer.main();
    const log = a.lines.join('\n');
    assert.equal(code, 0, log);
    assert.deepEqual([a.outputs.more, a.outputs.blocked, a.outputs.run_id], ['false', 'false', DELTA], log);
    // No sitemap, no other page: robots.txt and the product's own page, once.
    assert.deepEqual(store.seen, ['/robots.txt', '/products/ams-2-pro']);
    assert.deepEqual(ops.cdn.served.map((u) => u.split('?')[0]).sort(), failed.map((f) => f.url).sort(), 'only the three failed pictures fetched again');
    const item = w.raw.prepare('SELECT processing_state, discovery_sources, match_kind FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(DELTA, sid) as Record<string, string>;
    assert.deepEqual([item.processing_state, item.discovery_sources, item.match_kind], ['COMPLETE', `["content_media:${RUN_ID}"]`, ''], log);
    assert.match(log, /content pass from run cir_0123456789abcdef01234567: 3 description and in-the-box pictures failed in the closed run; 1 items with 3 to put back \(2 description, 1 in the box\)/);
    assert.match(log, /content pass: 3 of the pictures to put back failed with IMAGE_CONVERT_FAILED/);
    assert.match(log, /content pass: 3 put back \(2 description, 1 in the box\)/);
    assert.match(log, /content pass verify: 2\/2 description and 1\/1 in-the-box pictures on the public answers \(HTTP 200\/200\)/);
    assert.doesNotMatch(log, /bblcdn|https:\/\/us\.store|p_[0-9a-f]{20}|products\/import|content:[0-9a-f]|box:[0-9a-f]/);
    assert.deepEqual(movedColumns(before, everything(w, productId)), ['products.content_blocks', 'products.updated_at', 'specs.value_list']);

    // The run closes the normal way; a second content delta from the same closed run queues nothing.
    const c = importerOf(w, ops, dataDir, dir, clock, { mode: 'close', runId: DELTA, fromRun: '' }, store);
    assert.equal(await c.importer.main(), 0, c.lines.join('\n'));
    openRun(w.raw, { id: DELTA2 });
    const again = everything(w, productId);
    const b = importerOf(w, ops, dataDir, dir, clock, { deltaPass: 'content' }, store, DELTA2);
    assert.equal(await b.importer.main(), 0, b.lines.join('\n'));
    const log2 = b.lines.join('\n');
    assert.deepEqual([b.outputs.more, b.outputs.blocked], ['false', 'false'], log2);
    assert.match(log2, /1 items with nothing left/);
    assert.match(log2, /content queue registered: 0 items/);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM catalog_import_items WHERE run_id = ?').get(DELTA2)!.n, 0);
    assert.deepEqual(movedColumns(again, everything(w, productId)), [], 'running it twice changes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

test('mode=delta item=content: an owner\'s Arabic edit since the import leaves the description untouched (owner_edited) while the box picture goes in; a store page gone is moot (source_gone): COMPLETE, nothing written', async () => {
  {
    const { w, sid, productId } = await closedRunContent((world, id) => {
      const row = world.raw.prepare('SELECT content_blocks FROM products WHERE id = ?').get(id) as { content_blocks: string };
      const blocks = JSON.parse(row.content_blocks) as Array<Record<string, unknown>>;
      const t = blocks.find((b) => b.kind === 'text')!;
      t.body_ar = 'وصف كتبه المالك بنفسه';
      world.raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(blocks), id);
    });
    const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-content-edit-'));
    try {
      const ops = opsOf(w);
      const dataDir = writeBundle(w, dir);
      installCdnDouble(ops);
      openRun(w.raw, { id: DELTA });
      const t0 = (w.raw.prepare('SELECT content_blocks FROM products WHERE id = ?').get(productId) as { content_blocks: string }).content_blocks;
      const a = importerOf(w, ops, dataDir, dir, new FakeClock(Date.now()), { deltaPass: 'content' }, { listed: [], seen: [] });
      const code = await a.importer.main();
      const log = a.lines.join('\n');
      assert.equal(code, 0, log);
      assert.match(log, /edited since the import 2/);
      assert.match(log, /content pass: 1 put back \(0 description, 1 in the box\)/);
      assert.equal((w.raw.prepare('SELECT content_blocks FROM products WHERE id = ?').get(productId) as { content_blocks: string }).content_blocks, t0, 'the owner\'s description untouched');
      const item = w.raw.prepare('SELECT processing_state, stage_data FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(DELTA, sid) as Record<string, string>;
      assert.equal(item.processing_state, 'COMPLETE', log);
      assert.deepEqual(Object.values(JSON.parse(item.stage_data).content_media.media).sort(), ['attached', 'owner_edited', 'owner_edited']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreFetch();
    }
  }
  {
    const { w, sid, productId } = await closedRunContent();
    const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-content-gone-'));
    const page = PAGES['ams-2-pro'];
    try {
      const ops = opsOf(w);
      const dataDir = writeBundle(w, dir);
      installCdnDouble(ops);
      openRun(w.raw, { id: DELTA });
      const before = everything(w, productId);
      delete PAGES['ams-2-pro'];
      const a = importerOf(w, ops, dataDir, dir, new FakeClock(Date.now()), { deltaPass: 'content' }, { listed: [], seen: [] });
      const code = await a.importer.main();
      const log = a.lines.join('\n');
      assert.equal(code, 0, log);
      assert.deepEqual([a.outputs.more, a.outputs.blocked], ['false', 'false'], log);
      assert.match(log, /the page reads source_gone/);
      assert.match(log, /store page gone 3/);
      const item = w.raw.prepare('SELECT processing_state, stage_data FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(DELTA, sid) as Record<string, string>;
      assert.equal(item.processing_state, 'COMPLETE', log);
      assert.deepEqual(movedColumns(before, everything(w, productId)), []);
      assert.deepEqual(Object.values(JSON.parse(item.stage_data).content_media.media), ['source_gone', 'source_gone', 'source_gone'], 'passing: a later pass takes them again');
    } finally {
      PAGES['ams-2-pro'] = page;
      rmSync(dir, { recursive: true, force: true });
      restoreFetch();
    }
  }
});

test('the content doors: a content item never stages, writes or completes, fetches only its failed media of its roles; an unknown delta marker fails closed at every door', async () => {
  const { w, sid } = await closedRunContent();
  const ops = opsOf(w);
  const dir = mkdtempSync(join(tmpdir(), 'levonis-delta-content-door-'));
  try {
    writeBundle(w, dir);
    openRun(w.raw, { id: DELTA });
    // /delta/plan for the content pass reads no sitemap: one given is refused.
    const bad = await ops.call(`${OPS}/delta/plan`, { body: { from_run: RUN_ID, pass: 'content', sitemap_handles: ['ams-2-pro'] } });
    assert.equal(bad.status, 400);
    const plan = (await (await ops.call(`${OPS}/delta/plan`, { body: { from_run: RUN_ID, pass: 'content' } })).json()) as { content: Array<{ source_product_id: string; failed: number }>; counts: Record<string, number> };
    assert.deepEqual(plan.content.map((c) => [c.source_product_id, c.failed]), [[sid, 3]]);
    assert.equal(plan.counts.content_failed_total, 3);
    // A content run never takes a media row, and a media run never a content row.
    const mixed = await ops.call(`${OPS}/delta/manifest`, { body: { from_run: RUN_ID, rows: [{ kind: 'content', source_product_id: sid, discovered_at: '2026-10-19T00:00:00.000Z' }, { kind: 'new', source_product_id: '999', handle: 'x-y', route: '1', discovered_at: '2026-10-19T00:00:00.000Z' }] } });
    assert.equal(mixed.status, 409);
    assert.equal((await ops.call(`${OPS}/delta/manifest`, { body: { from_run: RUN_ID, rows: [{ kind: 'content', source_product_id: sid, discovered_at: '2026-10-19T00:00:00.000Z' }] } })).status, 200);
    const media = await ops.call(`${OPS}/delta/manifest`, { body: { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: '2026-10-19T00:00:00.000Z' }] } });
    assert.equal(media.status, 409);
    const lease = (await (await ops.call(`${OPS}/items/${sid}/lease`, { body: { lease_token: '' } })).json()) as { lease_token: string };
    for (const [state, outcome] of [['EXTRACTING', 'start'], ['ENRICHING', 'ok'], ['VALIDATING', 'ok']]) {
      assert.equal((await ops.call(`${OPS}/items/${sid}/event`, { body: { lease_token: lease.lease_token, state, outcome } })).status, 200, state);
    }
    const payload = buildFor(w, pageOf('ams-2-pro').extraction).payload;
    // The content door takes the description and box rows only: the whole payload is refused, the content-only one planned.
    assert.equal((await ops.call(`${OPS}/items/${sid}/content-plan`, { body: { lease_token: lease.lease_token, payload } })).status, 400);
    const cplan = await ops.call(`${OPS}/items/${sid}/content-plan`, { body: { lease_token: lease.lease_token, payload: contentOnlyPayload(payload) } });
    assert.equal(cplan.status, 200);
    assert.equal(((await cplan.json()) as { media: unknown[] }).media.length, 3);
    assert.equal((await ops.call(`${OPS}/items/${sid}/event`, { body: { lease_token: lease.lease_token, state: 'INGESTING_MEDIA', outcome: 'ok' } })).status, 200);
    // The media doors of a media item are not a content item's.
    assert.equal(((await (await ops.call(`${OPS}/items/${sid}/media-plan`, { body: { lease_token: lease.lease_token, payload: mediaOnlyPayload(payload) } })).json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED');
    for (const door of ['stage', 'write', 'complete']) {
      const r = await ops.call(`${OPS}/items/${sid}/${door}`, { body: { lease_token: lease.lease_token, payload, payload_sha256: 'x' } });
      assert.equal(r.status, 409, door);
      assert.equal(((await r.json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED', door);
    }
    const gallery = payload.images.find((i) => !i.is_primary)!;
    const r = await ops.call(`${OPS}/items/${sid}/media`, { body: { lease_token: lease.lease_token, media: [{ source_media_id: gallery.source_media_id, role: 'gallery', source_url: gallery.source_url }] } });
    assert.equal(((await r.json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED', 'a gallery picture is never a content item\'s');

    // An item with a reserved marker this code does not read: every door refuses it (never an ordinary item).
    w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(DELTA);
    openRun(w.raw, { id: DELTA2 });
    w.raw
      .prepare(
        `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovery_sources, discovered_at)
         VALUES ('cii_unknown', ?, 'bambu_us', '424242', 'ams-2-pro-x', 'x', 50, '["content_media:not-a-run"]', '2026-10-19T00:00:00.000Z')`
      )
      .run(DELTA2);
    const l2 = (await (await ops.call(`${OPS}/items/424242/lease`, { body: { lease_token: '' } })).json()) as { lease_token: string };
    for (const [state, outcome] of [['EXTRACTING', 'start'], ['ENRICHING', 'ok'], ['VALIDATING', 'ok']]) await ops.call(`${OPS}/items/424242/event`, { body: { lease_token: l2.lease_token, state, outcome } });
    for (const door of ['stage', 'write', 'complete', 'media', 'content-plan', 'media-plan']) {
      const body = door === 'media' ? { lease_token: l2.lease_token, media: [{ source_media_id: 'box:1', role: 'in_the_box', source_url: 'https://store.bblcdn.com/a.png' }] } : { lease_token: l2.lease_token, payload, payload_sha256: 'x' };
      const x = await ops.call(`${OPS}/items/424242/${door}`, { body });
      assert.equal(x.status, 409, door);
      assert.equal(((await x.json()) as { code: string }).code, 'IMPORT_DELTA_REFUSED', door);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
