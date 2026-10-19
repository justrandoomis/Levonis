/**
 * THE DELTA RUN (Bambu import spec §O; worker/lib/catalogImport/delta.ts, mediaRetry.ts).
 *
 *   the queue        new vs completed vs withdrawn: a listed handle no earlier run held is new; a COMPLETE item of
 *                    the closed run with failed media is retried; a withdrawn or blocked one never is; a known
 *                    handle is never new; an unusable handle is counted, not queued
 *   the markers      `delta_new` / `media_retry:<run>` are read back, and reserved
 *   the plan         gallery and swatch media the page still shows are fetched again; description and in-the-box
 *                    pictures, media gone from the page and a would-be primary are counted, never attached
 *   the stage        a created product gets exactly the rows the original write would have written for the media
 *                    that failed — same ids, bindings, slots and alt texts — and NOTHING else of the product moves
 *                    (its row, groups, values, variants, specs, documents, relations, translations, search tokens,
 *                    its other images); the batch runs under the import guard row; a second delta changes nothing
 *                    (every medium already_present); a merged product's pictures are appended after its own; a
 *                    picture shown only under another value is attached for its own value (content_duplicate)
 *   COMPLETE         only when the runner saw every attached picture and D1 and R2 hold them
 *   moot rows        a known source id (a renamed handle), a product the owner deleted, an item an earlier delta
 *                    completed: left out and counted at /delta/plan and /delta/manifest, never a refusal; an item
 *                    queued before its product was deleted completes with nothing attached
 *   resume           a merged product's media item BLOCKED at VERIFY resumes at VERIFYING_LIVE (runner = Worker)
 *
 * Run: node --import tsx --test tests/catalogImportDelta.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildFor, complete, count, LEASE, newWorld, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import { webpBytes } from './fixtures/imageDoubles';
import type { ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import type { ImportRun } from '../worker/lib/catalogImport/auth';
import { OpsRefusal } from '../worker/lib/catalogImport/auth';
import { applyEvent, finishPublishing, itemBySource, type ItemRow } from '../worker/lib/catalogImport/items';
import {
  acceptDeltaRows,
  contentDeltaPlan,
  contentPartsOf,
  contentQueue,
  DELTA_ITEM_SQL,
  DELTA_NEW_MAX,
  deltaDoorKindOf,
  deltaMarkOf,
  deltaPlan,
  deltaQueue,
  deltaSources,
  isReservedSource,
  retrySettled,
  withDeltaRows,
  deltaRowsOf,
} from '../worker/lib/catalogImport/delta';
import { attachRetriedMedia, completeMediaRetry, MOOT_IDENTITY, MOOT_SHA256, planMediaRetry, retryPlan } from '../worker/lib/catalogImport/mediaRetry';
import { deleteProductPermanently } from '../worker/lib/productDeletion';
import { ConfigError, configFromEnv, DELTA_NEW_MAX as RUNNER_NEW_MAX, mediaOnlyPayload, resumeTargetOf } from '../scripts/bambu-import/run';

const RUN_B = 'cir_bbbbbbbbbbbbbbbbbbbbbbbb';
const RUN_C = 'cir_cccccccccccccccccccccccc';
const AT = '2026-10-19T00:00:00.000Z';
const ORIGIN = 'https://levonis-iq.com';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The Worker's media bindings and D1 of a world, as /media-attach takes them. */
const envOf = (w: World) => ({ DB: w.db, ...w.media }) as never;

const runOf = (id: string): ImportRun => ({ id, state: 'open', token_expires_at: '', github_run_id: '', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: AT });

/** /delta/manifest's answer with nothing left out. */
const NONE_SKIPPED = { known: 0, media_product_gone: 0, media_already_retried: 0, content_already_settled: 0 };

// ---------------------------------------------------------------- the queue (pure)

test('queue construction: new vs completed vs withdrawn, by every earlier run', () => {
  const A = 'cir_aaaaaaaaaaaaaaaaaaaaaaaa';
  const Z = 'cir_000000000000000000000000';
  const prior = [
    { run_id: A, source_product_id: '1', handle: 'done-with-failures', state: 'COMPLETE', queue_position: 3 },
    { run_id: A, source_product_id: '2', handle: 'done-clean', state: 'COMPLETE', queue_position: 1 },
    { run_id: A, source_product_id: '3', handle: 'withdrawn-but-back', state: 'WITHDRAWN_AT_SOURCE', queue_position: 2 },
    { run_id: A, source_product_id: '4', handle: 'blocked-with-failures', state: 'BLOCKED', queue_position: 4 },
    { run_id: A, source_product_id: '6', handle: 'done-too', state: 'COMPLETE', queue_position: 0 },
    // An older run (not the one retried): its handle is known, so never new; its failures are not this delta's.
    { run_id: Z, source_product_id: '5', handle: 'older-run-product', state: 'COMPLETE', queue_position: 1 },
  ];
  const q = deltaQueue({
    listedHandles: ['done-with-failures', 'done-clean', 'withdrawn-but-back', 'older-run-product', 'brand-new-thing', 'Bad Handle!', 'another-new'],
    prior,
    fromRun: A,
    failedBySid: new Map([['1', 3], ['3', 2], ['4', 1], ['5', 9], ['6', 1]]),
  });
  assert.deepEqual(q.newHandles, ['another-new', 'brand-new-thing'], 'only handles no run ever held, sorted');
  assert.deepEqual(q.media, [
    { source_product_id: '6', handle: 'done-too', failed: 1 },
    { source_product_id: '1', handle: 'done-with-failures', failed: 3 },
  ], 'COMPLETE items of the closed run with failed media, in queue order');
  assert.deepEqual(q.counts, {
    listed: 7, known: 4, new: 2, unusable_handles: 1, media_items: 2, media_failed: 4, failed_not_complete: 3, withdrawn_listed: 1, media_product_gone: 0, media_already_retried: 0,
  });
  // Nothing new, nothing failed: an empty delta.
  const empty = deltaQueue({ listedHandles: ['done-clean'], prior, fromRun: A, failedBySid: new Map() });
  assert.deepEqual([empty.newHandles, empty.media], [[], []]);
});

test('queue construction: a handle a source ref or the reviewed manifest holds is never new; a gone product and an item an earlier delta completed are never retried', () => {
  const A = 'cir_aaaaaaaaaaaaaaaaaaaaaaaa';
  const prior = [
    { run_id: A, source_product_id: '1', handle: 'still-here', state: 'COMPLETE', queue_position: 1, levonis_product_id: 'p_1' },
    { run_id: A, source_product_id: '2', handle: 'deleted-by-owner', state: 'COMPLETE', queue_position: 2, levonis_product_id: 'p_2' },
    { run_id: A, source_product_id: '3', handle: 'source-moved', state: 'COMPLETE', queue_position: 3, levonis_product_id: 'p_3' },
    { run_id: A, source_product_id: '4', handle: 'retried-before', state: 'COMPLETE', queue_position: 4, levonis_product_id: 'p_4' },
  ];
  const q = deltaQueue({
    listedHandles: ['still-here', 'carried-handle', 'reviewed-handle', 'truly-new'],
    prior,
    fromRun: A,
    failedBySid: new Map([['1', 1], ['2', 2], ['3', 3], ['4', 4]]),
    knownHandles: ['carried-handle', 'reviewed-handle'],
    // '2' has no live product (deleted with its source ref); '3' is carried by another product now.
    liveProductBySid: new Map([['1', 'p_1'], ['3', 'p_other'], ['4', 'p_4']]),
    alreadyRetried: new Set(['4']),
  });
  assert.deepEqual(q.newHandles, ['truly-new']);
  assert.deepEqual(q.media.map((m) => m.source_product_id), ['1']);
  assert.deepEqual([q.counts.known, q.counts.new, q.counts.media_items, q.counts.media_failed, q.counts.media_product_gone, q.counts.media_already_retried], [3, 1, 1, 1, 2, 1]);
});

test('the delta markers are read back from discovery_sources, and reserved', () => {
  assert.deepEqual(deltaMarkOf(JSON.stringify(deltaSources('new'))), { kind: 'new', fromRun: '' });
  assert.deepEqual(deltaMarkOf(JSON.stringify(deltaSources('media', RUN_ID))), { kind: 'media', fromRun: RUN_ID });
  assert.equal(deltaMarkOf('["sitemap"]'), null);
  assert.equal(deltaMarkOf('["media_retry:cir_bad"]'), null, 'a malformed run id is no mark');
  assert.equal(deltaMarkOf('not json'), null);
  assert.ok(isReservedSource('delta_new') && isReservedSource(`media_retry:${RUN_ID}`) && !isReservedSource('sitemap'));
  // Every media marker fits /manifest's 40-character discovery source.
  assert.ok(deltaSources('media', RUN_ID)[0].length <= 40);
  // The content pass's marker (§O.6): its own kind, reserved, matched by the delta SQL; a malformed one fails closed.
  assert.deepEqual(deltaSources('content', RUN_ID), [`content_media:${RUN_ID}`]);
  assert.deepEqual(deltaMarkOf(JSON.stringify(deltaSources('content', RUN_ID))), { kind: 'content', fromRun: RUN_ID });
  assert.ok(isReservedSource(`content_media:${RUN_ID}`) && isReservedSource('content_media:x'));
  assert.ok(DELTA_ITEM_SQL.includes(`'%"content_media:%'`));
  assert.equal(deltaDoorKindOf('["sitemap"]'), 'none');
  assert.equal(deltaDoorKindOf(JSON.stringify(deltaSources('new'))), 'new');
  assert.equal(deltaDoorKindOf(JSON.stringify(deltaSources('media', RUN_ID))), 'media');
  assert.equal(deltaDoorKindOf(JSON.stringify(deltaSources('content', RUN_ID))), 'content');
  assert.equal(deltaDoorKindOf('["content_media:cir_bad"]'), 'unknown', 'a marker this code does not read: refused at every door');
  assert.equal(deltaDoorKindOf(JSON.stringify([...deltaSources('content', RUN_ID), ...deltaSources('media', RUN_ID)])), 'unknown', 'two kinds on one item');
  assert.equal(deltaDoorKindOf('not json'), 'unknown');
  const w = newWorld();
  w.raw.exec(`INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovery_sources, discovered_at)
    VALUES ('cii_c', '${RUN_ID}', 'bambu_us', '1', 'a', 'x', 1, '["content_media:${RUN_ID}"]', '${AT}')`);
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM catalog_import_items WHERE ${DELTA_ITEM_SQL}`), 1);
});

test('the content queue (pure): the closed run\'s COMPLETE product writers with unsettled failed description or box media; every failed medium in exactly one part', () => {
  const item = (sid: string, state = 'COMPLETE', kind: 'none' | 'new' | 'media' = 'none', pos = Number(sid)) => ({
    source_product_id: sid, handle: `h-${sid}`, state, queue_position: pos, levonis_product_id: `p_${sid}`, kind, written_recorded: sid !== '6',
  });
  const f = (sid: string, id: string, role = 'description', code = 'IMAGE_CONVERT_FAILED') => ({ source_product_id: sid, source_media_id: id, role, error_code: code });
  const q = contentQueue({
    items: [item('1'), item('2'), item('3', 'BLOCKED'), item('4'), item('5'), item('6'), item('7', 'COMPLETE', 'new'), item('8', 'COMPLETE', 'media')],
    failed: [
      f('1', 'content:a'), f('1', 'box:b', 'in_the_box', 'IMAGE_SOURCE_TOO_LARGE'), f('1', 'gallery:x', 'gallery'),
      f('2', 'content:c'), f('3', 'content:d'), f('4', 'content:e'), f('5', 'content:f'), f('5', 'box:g', 'in_the_box'), f('6', 'content:h'),
      f('7', 'box:i', 'in_the_box'), f('8', 'content:j'), f('9', 'content:k'),
    ],
    liveProductBySid: new Map(['1', '2', '3', '5', '6', '7', '8'].map((s) => [s, `p_${s}`])),
    // An earlier content pass settled media of 2 (all) and of 5 (one of two); a media item's role_not_attachable settles nothing.
    settled: new Map([['2', new Set(['content:c'])], ['5', new Set(['content:f'])]]),
    reviewed: () => true,
  });
  assert.deepEqual(q.content, [
    { source_product_id: '1', handle: 'h-1', failed: 2 },
    { source_product_id: '5', handle: 'h-5', failed: 1 },
    { source_product_id: '6', handle: 'h-6', failed: 1 },
    { source_product_id: '7', handle: 'h-7', failed: 1 },
  ]);
  assert.deepEqual(q.counts, {
    content_failed_total: 11,
    content_items: 4,
    content_failed: 5,
    content_failed_description: 2,
    content_failed_in_the_box: 3,
    content_failed_not_complete: 3,
    media_product_gone: 1,
    content_failed_product_gone: 1,
    content_not_reviewed: 0,
    content_failed_not_reviewed: 0,
    content_failed_settled: 2,
    content_already_settled: 1,
    content_items_unrecorded: 1,
  });
  assert.equal(contentPartsOf(q.counts), q.counts.content_failed_total, 'the parts reconcile');
  assert.deepEqual(q.failed_by_error, { IMAGE_CONVERT_FAILED: 4, IMAGE_SOURCE_TOO_LARGE: 1 });
  // Not in the reviewed manifest: counted, never queued (a delta's new product needs no reviewed row).
  const r = contentQueue({ items: [item('1'), item('7', 'COMPLETE', 'new')], failed: [f('1', 'content:a'), f('7', 'content:z')], liveProductBySid: new Map([['1', 'p_1'], ['7', 'p_7']]), settled: new Map(), reviewed: () => false });
  assert.deepEqual([r.content.map((c) => c.source_product_id), r.counts.content_not_reviewed, r.counts.content_failed_not_reviewed], [['7'], 1, 1]);
});

test('content rows: registered only for a product writer of the closed run with failed content media; a content run takes content rows only, and a media run none', async () => {
  const { w, sid } = await closedRunWithFailures('pla-basic-filament', (p) => {
    const block = p.content_blocks.find((b) => b.kind === 'image' && b.source_media_id)!;
    return [{ id: block.source_media_id, role: 'description', url: block.source_url }];
  });
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_B);
  const plan = await contentDeltaPlan(w.db, runOf(RUN_B), { from_run: RUN_ID, pass: 'content' }, w.bundle);
  assert.deepEqual(plan.content.map((c) => [c.source_product_id, c.failed]), [[sid, 1]]);
  await assert.rejects(() => contentDeltaPlan(w.db, runOf(RUN_B), { from_run: RUN_ID, pass: 'content', sitemap_handles: ['x'] }, w.bundle), (e: unknown) => e instanceof OpsRefusal && e.status === 400);
  await assert.rejects(() => deltaPlan(w.db, runOf(RUN_B), { from_run: RUN_ID, pass: 'content', sitemap_handles: [] }, w.bundle), (e: unknown) => e instanceof OpsRefusal && e.status === 400, 'the media plan is not the content pass');
  const refuse = (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_DELTA_REFUSED';
  const content = { kind: 'content', source_product_id: sid, discovered_at: AT };
  await assert.rejects(() => acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [content, { kind: 'new', source_product_id: '77', handle: 'new-thing', route: '1', discovered_at: AT }] }), refuse);
  // A product without a failed content medium is no content row.
  w.raw.prepare("UPDATE catalog_import_media SET role = 'gallery' WHERE run_id = ? AND status = 'failed'").run(RUN_ID);
  await assert.rejects(() => acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [content] }), refuse);
  w.raw.prepare("UPDATE catalog_import_media SET role = 'description' WHERE run_id = ? AND status = 'failed'").run(RUN_ID);
  assert.deepEqual(await acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [content] }), { accepted: 1, new: 0, media: 0, content: 1, skipped: NONE_SKIPPED });
  assert.deepEqual((await deltaRowsOf(w.db, RUN_B)).map((r) => [r.kind, r.from_run, r.source_product_id, r.route]), [['content', RUN_ID, sid, '']]);
  await assert.rejects(() => acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: AT }] }), refuse, 'a content run takes no media row');
  // A media run takes no content row.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [] });
  w.raw
    .prepare(`INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovery_sources, discovered_at) VALUES ('cii_m', ?, 'bambu_us', '555', 'h', 'x', 1, ?, ?)`)
    .run(RUN_C, JSON.stringify(deltaSources('media', RUN_ID)), AT);
  await assert.rejects(() => acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [content] }), refuse);
});

test('the importer\'s delta configuration: run_id is the CLOSED run, the run worked on is the one the job opened', () => {
  const key = 'A'.repeat(43);
  const env = { IN_MODE: 'delta', IN_RUN_ID: RUN_ID, IN_MAX_ITEMS: '0', IN_CHAIN: 'true', IN_CHAIN_COUNT: '0', IN_AUTO_WITHDRAW: 'true', IN_SEAL_PUBKEY: key, DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 3600) };
  const cfg = configFromEnv(env, '/tmp');
  assert.deepEqual([cfg.mode, cfg.runId, cfg.fromRun, cfg.chain, cfg.autoWithdraw], ['delta', '', RUN_ID, true, true]);
  assert.throws(() => configFromEnv({ ...env, IN_RUN_ID: '' }, '/tmp'), ConfigError, 'a delta needs the closed run');
  assert.throws(() => configFromEnv({ ...env, IN_MAX_ITEMS: '1' }, '/tmp'), ConfigError, 'a bounded delta never chains');
  assert.throws(() => configFromEnv({ ...env, IN_RUN_ID: 'cir_x' }, '/tmp'), ConfigError);
  // mode=run keeps its run_id; it takes no source run.
  const run = configFromEnv({ ...env, IN_MODE: 'run' }, '/tmp');
  assert.deepEqual([run.runId, run.fromRun], [RUN_ID, '']);
  // The runner stops before reading a page when the Worker would refuse the registration anyway.
  assert.equal(RUNNER_NEW_MAX, DELTA_NEW_MAX);
});

// ---------------------------------------------------------------- the plan (pure)

test('the plan: gallery and swatch media the page still shows; text media, vanished media and a new primary are counted', () => {
  const { payload } = buildFor({ queue: 0 }, 'pla-basic-filament');
  const primary = payload.images.find((i) => i.is_primary)!;
  const gallery = payload.images.find((i) => i.source_media_id !== primary.source_media_id && i.option_value_id)!;
  const swatch = payload.swatches[0];
  const block = payload.content_blocks.find((b) => b.kind === 'image' && b.source_media_id)!;
  const plan = retryPlan(payload, [
    { source_media_id: gallery.source_media_id, role: 'gallery' },
    { source_media_id: gallery.source_media_id, role: 'gallery' },
    { source_media_id: swatch.source_media_id, role: 'swatch' },
    { source_media_id: block.source_media_id, role: 'description' },
    { source_media_id: 'witb:0000', role: 'in_the_box' },
    { source_media_id: 'gone-from-page', role: 'gallery' },
    { source_media_id: primary.source_media_id, role: 'gallery' },
  ]);
  assert.deepEqual(plan.requests, [
    { source_media_id: gallery.source_media_id, role: 'gallery', source_url: gallery.source_url },
    { source_media_id: swatch.source_media_id, role: 'swatch', source_url: swatch.source_url },
  ]);
  assert.equal(plan.skipped.role_not_attachable, 2);
  assert.equal(plan.skipped.not_in_source, 1);
  assert.equal(plan.skipped.primary_unchanged, 1);
});

// ---------------------------------------------------------------- the media-only stage, on the writer's own world

/** Every row of the product the import could ever write, without clocks; the image rows by id. */
function productState(w: World, productId: string): Record<string, unknown[]> {
  const drop = new Set(['created_at', 'updated_at', 'at', 'retrieved_at', 'fetched_at', 'resolved_at']);
  const q = (sql: string) => (w.raw.prepare(sql).all(productId) as object[]).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k))));
  return {
    product: q('SELECT * FROM products WHERE id = ?'),
    groups: q('SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY id'),
    values: q('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id'),
    variants: q('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id'),
    colors: q('SELECT * FROM product_colors WHERE product_id = ? ORDER BY id'),
    catalogs: q('SELECT * FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id'),
    source: q('SELECT * FROM product_source_refs WHERE product_id = ?'),
    specs: q('SELECT * FROM product_spec_values WHERE product_id = ? ORDER BY id'),
    documents: q('SELECT * FROM product_documents WHERE product_id = ? ORDER BY id'),
    externalIds: q('SELECT * FROM product_external_ids WHERE product_id = ? ORDER BY scope_kind, scope_id, id_type, value'),
    relations: q('SELECT * FROM product_relations WHERE product_id = ? ORDER BY id'),
    translations: q('SELECT * FROM product_translations WHERE product_id = ? ORDER BY field'),
    tokens: q('SELECT token, weight FROM search_tokens WHERE product_id = ? ORDER BY token'),
    nonImageRefs: q("SELECT * FROM product_option_source_refs WHERE product_id = ? AND kind <> 'image' ORDER BY kind, source_id, levonis_id"),
    images: q('SELECT * FROM product_images WHERE product_id = ? ORDER BY id'),
    imageRefs: q("SELECT kind, source, source_id, levonis_id, source_label, binding_rule, via_variant_id FROM product_option_source_refs WHERE product_id = ? AND kind = 'image' ORDER BY source_id, levonis_id"),
    swatches: q('SELECT option_value_id, product_id, width, height, source_url FROM product_option_value_swatches WHERE product_id = ? ORDER BY option_value_id'),
  };
}

/** Stores one medium for `runId` the way /media does (a content-addressed WebP and its catalog_import_media row). */
let pad = 500;
function storeFor(w: World, runId: string, sid: string, mediaId: string, role: string, url: string, bytes?: Uint8Array): string {
  const b = bytes ?? webpBytes(80 + (pad % 40), 60 + (pad % 20), { pad: ++pad });
  const key = `products/import/gallery/${sha(b)}.webp`;
  w.bucket.seed(key, b, { contentType: 'image/webp' });
  w.raw
    .prepare(
      `INSERT OR REPLACE INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height, bytes, sha256)
       VALUES (?, ?, ?, ?, ?, 'stored', ?, 80, 60, ?, ?)`
    )
    .run(runId, sid, mediaId, role, url, key, b.byteLength, sha(b));
  return key;
}

const walk = (w: World, itemId: string, to: string) => {
  const path = ['DISCOVERED', 'EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING'];
  let cur = (w.raw.prepare('SELECT processing_state AS s FROM catalog_import_items WHERE id = ?').get(itemId) as { s: string }).s;
  while (cur !== to) {
    const next = path[path.indexOf(cur) + 1];
    w.raw.prepare('UPDATE catalog_import_items SET processing_state = ?, last_completed_stage = ? WHERE id = ?').run(next, cur === 'DISCOVERED' ? '' : cur, itemId);
    cur = next;
  }
  w.raw.prepare("UPDATE catalog_import_items SET lease_token = ?, lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') WHERE id = ?").run(LEASE, itemId);
};

interface Failed {
  id: string;
  role: 'gallery' | 'swatch' | 'description';
  url: string;
}

/** Run A wrote the product with `failed` media left out (recorded failed), and closed partial. */
async function closedRunWithFailures(handle: 'pla-basic-filament' | 'a1', pick: (p: ImportPayload) => Failed[], opts: { writeMode?: 'create' | 'merge'; mergeProductId?: string; setup?: (w: World) => void } = {}) {
  const w = newWorld();
  opts.setup?.(w);
  const failed = pick(buildFor(w, handle, opts).payload);
  const ids = new Set(failed.map((f) => f.id));
  const s = stage(w, handle, { ...opts, skipMedia: (id) => ids.has(id) });
  const { result } = await write(w, s);
  const sid = s.payload.source_product_id;
  for (const f of failed) {
    w.raw
      .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, error_code) VALUES (?, ?, ?, ?, ?, 'failed', 'IMAGE_CONVERT_FAILED')")
      .run(RUN_ID, sid, f.id, f.role, f.url);
  }
  complete(w, s.itemId);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'partial' WHERE id = ?").run(RUN_ID);
  return { w, s, sid, productId: result.product_id, failed };
}

/** A delta run from run A: the media item registered, walked to VALIDATING under a lease. */
async function deltaItem(w: World, runId: string, sid: string): Promise<ItemRow> {
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(runId);
  const r = await acceptDeltaRows(w.db, runOf(runId), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: AT }] });
  assert.deepEqual(r, { accepted: 1, new: 0, media: 1, content: 0, skipped: NONE_SKIPPED });
  const item = await itemBySource(w.db, runId, sid);
  walk(w, item.id, 'VALIDATING');
  return itemBySource(w.db, runId, sid);
}

/** Media none of whose rows is the primary (a failed primary blocks the original write, §B.5). */
const notPrimary = (p: ImportPayload) => {
  const primary = new Set(p.images.filter((i) => i.is_primary).map((i) => i.source_media_id));
  return p.images.filter((i) => !primary.has(i.source_media_id));
};

const PICK_PLA = (p: ImportPayload): Failed[] => {
  const nonPrimary = notPrimary(p);
  const byValue = nonPrimary.find((i) => i.binding_rule === 'value')!;
  const representative = nonPrimary.find((i) => i.binding_rule === 'representative' && i.source_media_id !== byValue.source_media_id)!;
  const block = p.content_blocks.find((b) => b.kind === 'image' && b.source_media_id)!;
  const swatch = p.swatches[3];
  return [
    { id: byValue.source_media_id, role: 'gallery', url: byValue.source_url },
    { id: representative.source_media_id, role: 'gallery', url: representative.source_url },
    { id: swatch.source_media_id, role: 'swatch', url: swatch.source_url },
    { id: block.source_media_id, role: 'description', url: block.source_url },
  ];
};

test('the media-only stage attaches exactly what the original write would have, under the guard, and nothing else moves', async () => {
  const { w, sid, productId, failed } = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
  // The reference: the same product written with every medium stored.
  const ref = newWorld();
  const refStaged = stage(ref, 'pla-basic-filament');
  await write(ref, refStaged);
  const refState = productState(ref, productId);

  const before = productState(w, productId);
  const failedGallery = new Set(failed.filter((f) => f.role === 'gallery').map((f) => f.id));
  const expectedRows = (refState.images as Array<Record<string, unknown>>).filter((r) => (before.images as Array<Record<string, unknown>>).every((b) => b.id !== r.id));
  assert.ok(expectedRows.length >= 2, 'the failed gallery media left rows out of the write');

  const item = await deltaItem(w, RUN_B, sid);
  const full = buildFor(w, 'pla-basic-filament').payload;
  // The media-only door never takes prose: the payload with its description, specs or documents is refused.
  await assert.rejects(() => planMediaRetry(w.db, item, full), (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_BAD_REQUEST');
  const payload = mediaOnlyPayload(full);
  const plan = await planMediaRetry(w.db, item, payload);
  assert.equal(plan.failed, 4);
  assert.deepEqual(plan.media.map((m) => m.role).sort(), ['gallery', 'gallery', 'swatch']);
  assert.equal(plan.skipped.role_not_attachable, 1, 'the description picture is counted, never attached');
  // /media, as the Worker stores it for the delta run.
  for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
  walk(w, item.id, 'WRITING');
  // The import guard row is armed while every row goes in.
  w.raw.exec("CREATE TABLE guard_probe (armed INTEGER); CREATE TRIGGER trg_guard_probe BEFORE INSERT ON product_images BEGIN INSERT INTO guard_probe SELECT COUNT(*) FROM ops_guards WHERE id = 'catalog-import-batch'; END;");
  const writing = await itemBySource(w.db, RUN_B, sid);
  const a = await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload });
  assert.equal(a.counts.attached, 3);
  assert.equal(a.counts.role_not_attachable, 1);
  assert.equal(a.rows.length, expectedRows.length);
  assert.equal(a.swatches.length, 1);
  assert.deepEqual(w.raw.prepare('SELECT armed FROM guard_probe').all().map((r) => (r as { armed: number }).armed), expectedRows.map(() => 1), 'every image row went in under the guard row');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'the guard row is gone after the batch');

  const after = productState(w, productId);
  // Nothing but pictures moved: the product row, its options, variants, specs, documents, relations, translations,
  // search tokens and every other provenance row are byte for byte what they were.
  for (const k of Object.keys(before)) if (!['images', 'imageRefs', 'swatches'].includes(k)) assert.deepEqual(after[k], before[k], `${k} changed`);
  // Every image row that was there is there, unchanged (no move, no re-bind, no removal; the primary is the same).
  for (const b of before.images as Array<Record<string, unknown>>) assert.deepEqual((after.images as Array<Record<string, unknown>>).find((x) => x.id === b.id), b);
  // The new rows are the original write's: the same ids, bindings, slots and alt texts (the bytes are this world's).
  const scrub = (r: Record<string, unknown>) => {
    const { url: _u, r2_key: _k, bytes: _b, width: _w, height: _h, ...rest } = r;
    void _u; void _k; void _b; void _w; void _h;
    return rest;
  };
  const added = (after.images as Array<Record<string, unknown>>).filter((x) => !(before.images as Array<Record<string, unknown>>).some((b) => b.id === x.id));
  assert.deepEqual(added.map(scrub), expectedRows.map(scrub));
  assert.ok(added.every((r) => failedGallery.has(String((refState.imageRefs as Array<Record<string, unknown>>).find((x) => x.levonis_id === r.id)?.source_id))));
  const refRefs = (refState.imageRefs as Array<Record<string, unknown>>).filter((r) => added.some((x) => x.id === r.levonis_id));
  assert.deepEqual((after.imageRefs as unknown[]).filter((r) => added.some((x) => x.id === (r as Record<string, unknown>).levonis_id)), refRefs, 'the image provenance rows of the original write');
  const swatch = failed.find((f) => f.role === 'swatch')!;
  const refSwatch = (refState.swatches as Array<Record<string, unknown>>).find((r) => r.source_url === swatch.url)!;
  assert.ok((after.swatches as Array<Record<string, unknown>>).some((r) => r.option_value_id === refSwatch.option_value_id), 'the swatch on the value the original write gave it');
  assert.equal((after.swatches as unknown[]).length, (before.swatches as unknown[]).length + 1);

  // The item moved to PUBLISHING with its product and the attached rows recorded.
  const published = await itemBySource(w.db, RUN_B, sid);
  assert.equal(published.processing_state, 'PUBLISHING');
  assert.equal(published.levonis_product_id, productId);
  // A second attach in the same run is refused: the item has moved on.
  await assert.rejects(
    () => attachRetriedMedia(envOf(w), runOf(RUN_B), published, w.bundle, { payload_sha256: published.payload_sha256, payload }),
    (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_ILLEGAL_TRANSITION'
  );

  // COMPLETE: only when the runner saw every attached picture, and D1 and R2 hold them.
  await finishPublishing(w.db, runOf(RUN_B), published);
  const verifying = await itemBySource(w.db, RUN_B, sid);
  const env = { DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
  const live = `${ORIGIN}/product/${verifying.slug}`;
  const evidence = (rows: number) => ({ lease_token: LEASE, live_url: live, edge_evidence: { version: 1, live_url: live, round: 1, status: 200, rows_seen: rows, swatches_seen: 1 } });
  const short = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), verifying, evidence(a.rows.length - 1));
  assert.equal(short.state, 'VERIFYING_LIVE', 'a picture the public product does not show: nothing moves');
  const done = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid), evidence(a.rows.length));
  assert.equal(done.state, 'COMPLETE');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE run_id = ? AND stage = 'COMPLETED'", RUN_B), 1);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);

  // A later delta from the same closed run does not queue it again: an earlier delta completed it (the owner may have
  // removed one of its pictures since; it must not come back).
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  const planC = await deltaPlan(w.db, runOf(RUN_C), { from_run: RUN_ID, sitemap_handles: ['pla-basic-filament'] }, w.bundle);
  assert.deepEqual([planC.media, planC.counts.media_already_retried, planC.counts.media_product_gone], [[], 1, 0]);
  const regC = await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: AT }] });
  assert.deepEqual(regC, { accepted: 0, new: 0, media: 0, content: 0, skipped: { ...NONE_SKIPPED, media_already_retried: 1 } });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM catalog_import_items WHERE run_id = ?', RUN_C), 0);

  // IDEMPOTENT all the same: a media item registered anyway (by hand here: a delta whose item never completed is the
  // real case) attaches nothing, and the product does not move. A picture the owner quarantined since is not
  // inserted again either (its id is there; the insert would be a no-op counted as attached).
  const quarantined = added[0];
  w.raw.prepare("UPDATE product_images SET quarantined = 1, quarantine_reason = 'owner_hidden', url = '', r2_key = '' WHERE id = ?").run(String(quarantined.id));
  const settled = productState(w, productId);
  w.raw
    .prepare(
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovery_sources, discovered_at)
       VALUES ('cii_by_hand', ?, 'bambu_us', ?, 'pla-basic-filament', 'x', 1, ?, ?)`
    )
    .run(RUN_C, sid, JSON.stringify(deltaSources('media', RUN_ID)), AT);
  walk(w, 'cii_by_hand', 'VALIDATING');
  const again = await itemBySource(w.db, RUN_C, sid);
  const plan2 = await planMediaRetry(w.db, again, payload);
  for (const m of plan2.media) {
    const old = w.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_product_id = ? AND source_media_id = ?').get(RUN_B, sid, m.source_media_id) as { r2_key: string };
    w.raw
      .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height) VALUES (?, ?, ?, ?, ?, 'stored', ?, 80, 60)")
      .run(RUN_C, sid, m.source_media_id, m.role, m.source_url, old.r2_key);
  }
  walk(w, again.id, 'WRITING');
  const writing2 = await itemBySource(w.db, RUN_C, sid);
  const b = await attachRetriedMedia(envOf(w), runOf(RUN_C), writing2, w.bundle, { payload_sha256: writing2.payload_sha256, payload });
  assert.equal(b.counts.attached, 0);
  assert.equal(b.counts.already_present, 3);
  assert.deepEqual([b.rows, b.swatches], [[], []]);
  assert.deepEqual(productState(w, productId), settled, 'a second delta changes nothing');
});

test('the media-only stage refuses what is not its own: another payload, a stale digest, a media row it was not given', async () => {
  const { w, sid } = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
  const item = await deltaItem(w, RUN_B, sid);
  const payload = mediaOnlyPayload(buildFor(w, 'pla-basic-filament').payload);
  // Another product's payload under this item.
  const other = mediaOnlyPayload(buildFor(w, 'a1').payload);
  await assert.rejects(() => planMediaRetry(w.db, item, other), (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_IDENTITY_AMBIGUOUS');
  // The same source, sent as a merge into some product: refused.
  await assert.rejects(() => planMediaRetry(w.db, item, { ...payload, write_mode: 'merge' }), (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_IDENTITY_AMBIGUOUS');
  await planMediaRetry(w.db, item, payload);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  await assert.rejects(
    () => attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: 'f'.repeat(64), payload }),
    (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_NOT_STAGED'
  );
  // The registration itself: an item that is not a COMPLETE one with failures, a run that is not closed.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  const refuses = async (body: Record<string, unknown>, run = RUN_C) =>
    assert.rejects(() => acceptDeltaRows(w.db, runOf(run), w.bundle, body), (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_DELTA_REFUSED');
  await refuses({ from_run: RUN_C, rows: [] }, RUN_C);
  await refuses({ from_run: 'cir_dddddddddddddddddddddddd', rows: [] });
  // From run B (the delta itself, now closed): its item is a media item, not COMPLETE.
  await refuses({ from_run: RUN_B, rows: [{ kind: 'media', source_product_id: sid, discovered_at: AT }] });
  // A "new" product that run A already held (by id: a store handle renamed), or by handle, or that a product carries
  // as its source: left out and counted, never refused — a refusal would take the call's media rows with it.
  const known = { ...NONE_SKIPPED, known: 1 };
  assert.deepEqual(
    await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: sid, handle: 'pla-basic-renamed', route: '1>2', discovered_at: AT }] }),
    { accepted: 0, new: 0, media: 0, content: 0, skipped: known }
  );
  assert.deepEqual(
    await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: '999', handle: 'pla-basic-filament', route: '1>2', discovered_at: AT }] }),
    { accepted: 0, new: 0, media: 0, content: 0, skipped: known }
  );
  // In one call with a media row: the media row is registered, the known new row left out.
  assert.deepEqual(
    await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, {
      from_run: RUN_ID,
      rows: [
        { kind: 'media', source_product_id: sid, discovered_at: AT },
        { kind: 'new', source_product_id: '999', handle: 'pla-basic-filament', route: '1>2', discovered_at: AT },
      ],
    }),
    { accepted: 1, new: 0, media: 1, content: 0, skipped: known }
  );
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM catalog_import_items WHERE run_id = ?', RUN_C), 1);
});

/** The A1 merged into an owner product (an empty reviewed value map), two non-primary gallery pictures failed. */
const A1_MERGE = {
  writeMode: 'merge' as const,
  mergeProductId: 'p_a1m',
  setup: (w: World) => {
    w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images)
      VALUES ('p_a1m', 'bambu-a1-m', 'Bambu Lab A1', 'بامبو A1', 'بامبو A1', 'active', 0, 'cat_printers', '[]', '[]', '[]')`);
    w.raw.exec("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1m', 'cat_printers', 1)");
    const x = buildFor(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1m' }).payload;
    w.matches.push({ source_product_id: x.source_product_id, source_handle: x.handle, levonis_product_id: 'p_a1m', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  },
};
const PICK_A1 = (p: ImportPayload): Failed[] =>
  [...new Map(notPrimary(p).map((i) => [i.source_media_id, i])).values()].slice(0, 2).map((i) => ({ id: i.source_media_id, role: 'gallery' as const, url: i.source_url }));

test('a merged product: the retried pictures are appended after its own, bound only through the reviewed map; again: nothing', async () => {
  const { w, sid } = await closedRunWithFailures('a1', PICK_A1, A1_MERGE);
  const before = productState(w, 'p_a1m');
  const maxSort = Math.max(...(before.images as Array<{ sort_order: number }>).map((i) => i.sort_order));
  const item = await deltaItem(w, RUN_B, sid);
  const payload = mediaOnlyPayload(buildFor(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1m' }).payload);
  const plan = await planMediaRetry(w.db, item, payload);
  for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  const a = await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload });
  assert.equal(a.counts.attached, plan.media.length);
  const after = productState(w, 'p_a1m');
  for (const k of Object.keys(before)) if (!['images', 'imageRefs'].includes(k)) assert.deepEqual(after[k], before[k], `${k} changed`);
  const added = (after.images as Array<Record<string, unknown>>).filter((x) => !(before.images as Array<Record<string, unknown>>).some((b) => b.id === x.id));
  assert.equal(added.length, a.rows.length);
  assert.ok(added.every((r) => Number(r.sort_order) > maxSort && Number(r.is_primary) === 0), 'appended after the product\'s own pictures, never the primary');
  assert.ok(added.every((r) => r.option_value_id === null && r.variant_id === null), 'an empty value map binds nothing');
  for (const b of before.images as Array<Record<string, unknown>>) assert.deepEqual((after.images as Array<Record<string, unknown>>).find((x) => x.id === b.id), b);
});

test('a delta run\'s new product: the Worker\'s manifest row for it, placed by the reviewed taxonomy map', async () => {
  const w = newWorld();
  // A product the reviewed manifest does not hold: registered into a delta run as new.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_ID);
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_B);
  const x = buildFor(w, 'ams-2-pro-feeder-unit');
  const route = String(x.row.currentAllIdRoute);
  const r = await acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: x.payload.source_product_id, handle: x.payload.handle, route, discovered_at: AT }] });
  assert.deepEqual(r, { accepted: 1, new: 1, media: 0, content: 0, skipped: NONE_SKIPPED });
  const rows = await deltaRowsOf(w.db, RUN_B);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'new');
  assert.equal(rows[0].route, route);
  assert.equal(rows[0].canonical_url, `https://us.store.bambulab.com/products/${x.payload.handle}`);
  const bundle = withDeltaRows(w.bundle, rows);
  const row = bundle.manifest.bySourceId.get(x.payload.source_product_id)!;
  assert.deepEqual([row.handle, row.currentAllIdRoute, row.curated, row.hold_code, row.leaf], [x.payload.handle, route, false, '', '']);
  assert.ok(!w.bundle.manifest.bySourceId.has(x.payload.source_product_id), 'the reviewed bundle itself is untouched');
  // Registered again (a lost answer): the same item, the same position.
  await acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: x.payload.source_product_id, handle: x.payload.handle, route, discovered_at: AT }] });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM catalog_import_items WHERE run_id = ?', RUN_B), 1);
  // A run that holds an ordinary item takes no delta row.
  w.raw
    .prepare("INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at) VALUES ('cii_plain', ?, 'bambu_us', '42', 'plain-item', 'x', 9, ?)")
    .run(RUN_B, AT);
  await assert.rejects(
    () => acceptDeltaRows(w.db, runOf(RUN_B), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: '43', handle: 'another-one', route: route, discovered_at: AT }] }),
    (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_DELTA_REFUSED'
  );
});

test('a merged product\'s media item BLOCKED at VERIFY resumes where the Worker expects it (VERIFYING_LIVE), never at WRITING', async () => {
  const { w, sid } = await closedRunWithFailures('a1', PICK_A1, A1_MERGE);
  const item = await deltaItem(w, RUN_B, sid);
  const payload = mediaOnlyPayload(buildFor(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1m' }).payload);
  const plan = await planMediaRetry(w.db, item, payload);
  for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload });
  await finishPublishing(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid));
  // The runner's VERIFY saw a picture missing after the purge and the wait: BLOCKED VERIFY_FAILED_PERSISTENT.
  await applyEvent(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid), { state: 'BLOCKED', outcome: 'blocked', code: 'VERIFY_FAILED_PERSISTENT', retry_at: '', release: false, detail: {} });
  const blocked = await itemBySource(w.db, RUN_B, sid);
  assert.deepEqual([blocked.processing_state, blocked.blocker_code, blocked.last_completed_stage, blocked.levonis_product_id], ['BLOCKED', 'VERIFY_FAILED_PERSISTENT', 'PUBLISHING', 'p_a1m']);
  assert.equal(blocked.match_kind, '', 'a media item never records a write mode: /media-attach writes no product');
  // The runner's rule, with what it knows of this item (the bundle says merge; the lease names the product).
  const target = resumeTargetOf({ kind: 'media', merge: true, blockerCode: blocked.blocker_code, lastCompleted: blocked.last_completed_stage, productId: blocked.levonis_product_id });
  assert.equal(target, 'VERIFYING_LIVE');
  // The Worker refuses the rewrite edge for it, and takes the runner's target.
  await assert.rejects(
    () => applyEvent(w.db, runOf(RUN_B), blocked, { state: 'WRITING', outcome: 'resume', code: '', retry_at: '', release: false, detail: {} }),
    (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_ILLEGAL_TRANSITION'
  );
  await applyEvent(w.db, runOf(RUN_B), blocked, { state: target!, outcome: 'resume', code: '', retry_at: '', release: false, detail: {} });
  assert.equal((await itemBySource(w.db, RUN_B, sid)).processing_state, 'VERIFYING_LIVE');
  // An ordinary merged item keeps the rewrite (the shared rule): only the media kind is exempt.
  assert.equal(resumeTargetOf({ kind: 'item', merge: true, blockerCode: 'VERIFY_FAILED_PERSISTENT', lastCompleted: 'PUBLISHING', productId: 'p_a1m' }), 'WRITING');
  assert.equal(resumeTargetOf({ kind: 'media', merge: false, blockerCode: 'IMAGE_STORAGE_FAILED', lastCompleted: 'VALIDATING', productId: '' }), 'INGESTING_MEDIA');
});

test('a product the owner deleted after the closed run: never queued; one already queued completes with nothing attached instead of blocking the queue', async () => {
  // Queued before the deletion: registered, then the product deleted while the item waits its turn.
  const early = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
  const item = await deltaItem(early.w, RUN_B, early.sid);
  const closedSlug = (early.w.raw.prepare('SELECT slug FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(RUN_ID, early.sid) as { slug: string }).slug;
  assert.equal((await deleteProductPermanently(early.w.db, early.productId)).product_deleted, true);
  assert.equal(count(early.w.raw, "SELECT COUNT(*) AS n FROM product_source_refs WHERE source_product_id = ?", early.sid), 0, 'the source ref goes with the product');
  const payload = mediaOnlyPayload(buildFor(early.w, 'pla-basic-filament').payload);
  const plan = await planMediaRetry(early.w.db, item, payload);
  assert.equal(plan.media.length, 0, 'nothing to fetch for a product that is gone');
  assert.equal(plan.skipped.product_not_public, 3, 'the planned media are counted product_not_public');
  walk(early.w, item.id, 'WRITING');
  const writing = await itemBySource(early.w.db, RUN_B, early.sid);
  const a = await attachRetriedMedia(envOf(early.w), runOf(RUN_B), writing, early.w.bundle, { payload_sha256: writing.payload_sha256, payload });
  assert.deepEqual([a.rows, a.swatches, a.counts.attached, a.slug], [[], [], 0, closedSlug]);
  assert.equal(count(early.w.raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', early.productId), 0, 'nothing written for a product that is gone');
  await finishPublishing(early.w.db, runOf(RUN_B), await itemBySource(early.w.db, RUN_B, early.sid));
  const verifying = await itemBySource(early.w.db, RUN_B, early.sid);
  const env = { DB: early.w.db, BUCKET: early.w.bucket as never, R2_PUBLIC: early.w.bucket as never, R2_PRIVATE: early.w.media.R2_PRIVATE as never };
  const live = `${ORIGIN}/product/${verifying.slug}`;
  const done = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), verifying, {
    lease_token: LEASE,
    live_url: live,
    edge_evidence: { version: 1, live_url: live, round: 1, status: 0, rows_seen: 0, swatches_seen: 0 },
  });
  assert.equal(done.state, 'COMPLETE', 'the queue behind it is free');

  // Planned after the deletion: /delta/plan and /delta/manifest leave it out, counted.
  const late = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
  await deleteProductPermanently(late.w.db, late.productId);
  late.w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_B);
  const p = await deltaPlan(late.w.db, runOf(RUN_B), { from_run: RUN_ID, sitemap_handles: ['pla-basic-filament'] }, late.w.bundle);
  assert.deepEqual([p.media, p.counts.media_items, p.counts.media_product_gone], [[], 0, 1]);
  const r = await acceptDeltaRows(late.w.db, runOf(RUN_B), late.w.bundle, { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: late.sid, discovered_at: AT }] });
  assert.deepEqual(r, { accepted: 0, new: 0, media: 0, content: 0, skipped: { ...NONE_SKIPPED, media_product_gone: 1 } });
  assert.equal(count(late.w.raw, 'SELECT COUNT(*) AS n FROM catalog_import_items WHERE run_id = ?', RUN_B), 0);
});

test('a retried picture byte-identical to one shown under ANOTHER value is attached for its own value, as the original write would have', async () => {
  // Two non-primary pictures bound to different values (A earlier than B); B failed, and its bytes are A's.
  let pair: { a: ImportPayload['images'][number]; b: ImportPayload['images'][number] } | null = null;
  const pick = (p: ImportPayload): Failed[] => {
    const rows = notPrimary(p).filter((i) => i.binding_rule === 'value' && i.option_value_id);
    const single = rows.filter((i) => p.images.filter((x) => x.source_media_id === i.source_media_id).length === 1);
    for (const a of single) {
      const b = single.find((x) => x.source_media_id !== a.source_media_id && x.option_value_id !== a.option_value_id && x.sort_order > a.sort_order);
      if (b) {
        pair = { a, b };
        break;
      }
    }
    assert.ok(pair, 'the fixture has two value-bound pictures');
    return [{ id: pair!.b.source_media_id, role: 'gallery', url: pair!.b.source_url }];
  };
  const { w, sid, productId } = await closedRunWithFailures('pla-basic-filament', pick);
  const { a, b } = pair!;
  const keyOfA = (w.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(RUN_ID, a.source_media_id) as { r2_key: string }).r2_key;

  // The reference: the same product written with both stored, B's bytes being A's (one content-addressed key).
  const ref = newWorld();
  const refStaged = stage(ref, 'pla-basic-filament');
  const refKeyOfA = (ref.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(RUN_ID, a.source_media_id) as { r2_key: string }).r2_key;
  ref.raw.prepare('UPDATE catalog_import_media SET r2_key = ? WHERE run_id = ? AND source_media_id = ?').run(refKeyOfA, RUN_ID, b.source_media_id);
  await write(ref, refStaged);
  const refB = ref.raw.prepare('SELECT id, sort_order, option_value_id, variant_id FROM product_images WHERE product_id = ? AND id = ?').get(productId, b.id) as Record<string, unknown>;
  const refRule = (ref.raw.prepare("SELECT binding_rule FROM product_option_source_refs WHERE product_id = ? AND kind = 'image' AND levonis_id = ?").get(productId, b.id) as { binding_rule: string }).binding_rule;
  assert.ok(refB, 'the original write keeps the second binding of the same picture');
  assert.equal(refRule, 'content_duplicate');

  const item = await deltaItem(w, RUN_B, sid);
  const payload = mediaOnlyPayload(buildFor(w, 'pla-basic-filament').payload);
  const plan = await planMediaRetry(w.db, item, payload);
  assert.deepEqual(plan.media.map((m) => m.source_media_id), [b.source_media_id]);
  w.raw
    .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height) VALUES (?, ?, ?, 'gallery', ?, 'stored', ?, 64, 48)")
    .run(RUN_B, sid, b.source_media_id, b.source_url, keyOfA);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  const r = await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload });
  assert.deepEqual([r.counts.attached, r.counts.duplicate_content], [1, 0], 'not "the same picture already shown": it is not shown for this value');
  const got = w.raw.prepare('SELECT id, sort_order, option_value_id, variant_id FROM product_images WHERE product_id = ? AND id = ?').get(productId, b.id) as Record<string, unknown>;
  assert.deepEqual(got, refB, 'the row, binding and slot of the original write');
  const rule = (w.raw.prepare("SELECT binding_rule FROM product_option_source_refs WHERE product_id = ? AND kind = 'image' AND levonis_id = ?").get(productId, b.id) as { binding_rule: string }).binding_rule;
  assert.equal(rule, refRule);
  // The same picture under the SAME value again is still left out (a later delta, registered by hand).
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  w.raw
    .prepare(
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovery_sources, discovered_at)
       VALUES ('cii_again', ?, 'bambu_us', ?, 'pla-basic-filament', 'x', 1, ?, ?)`
    )
    .run(RUN_C, sid, JSON.stringify(deltaSources('media', RUN_ID)), AT);
  // As if B had never gone in (its row and its source ref gone: a row the import wrote and the owner removed is
  // `owner_removed`, tested below): the owner shows the same picture under the same value themselves.
  w.raw.prepare('DELETE FROM product_images WHERE id = ?').run(b.id);
  w.raw.prepare("DELETE FROM product_option_source_refs WHERE product_id = ? AND kind = 'image' AND levonis_id = ?").run(productId, b.id);
  w.raw.prepare("INSERT INTO product_images (id, product_id, url, sort_order, is_primary, option_value_id, r2_key, source_url) VALUES ('pi_owner_copy', ?, ?, 99, 0, ?, ?, 'https://levonis-iq.com/x')").run(productId, `/files/${keyOfA}`, b.option_value_id, keyOfA);
  walk(w, 'cii_again', 'VALIDATING');
  const again = await itemBySource(w.db, RUN_C, sid);
  await planMediaRetry(w.db, again, payload);
  w.raw
    .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height) VALUES (?, ?, ?, 'gallery', ?, 'stored', ?, 64, 48)")
    .run(RUN_C, sid, b.source_media_id, b.source_url, keyOfA);
  walk(w, 'cii_again', 'WRITING');
  const writing2 = await itemBySource(w.db, RUN_C, sid);
  const r2 = await attachRetriedMedia(envOf(w), runOf(RUN_C), writing2, w.bundle, { payload_sha256: writing2.payload_sha256, payload });
  assert.deepEqual([r2.counts.attached, r2.counts.duplicate_content], [0, 1], 'shown already under the same value: left out');
});

// ---------------------------------------------------------------- an earlier delta, the owner, a renamed page

/** The ids of the rows of one medium the attach answered (the payload's rows of that medium). */
const rowsOfMedium = (payload: ImportPayload, attached: ReadonlyArray<{ id: string }>, mediumId: string) =>
  attached.filter((r) => payload.images.some((i) => i.id === r.id && i.source_media_id === mediumId)).map((r) => r.id);

/** A media item registered in `runId` by hand (as a later delta would), walked to VALIDATING. */
async function byHand(w: World, runId: string, sid: string, id: string): Promise<ItemRow> {
  w.raw
    .prepare(
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovery_sources, discovered_at)
       VALUES (?, ?, 'bambu_us', ?, 'pla-basic-filament', 'x', 1, ?, ?)`
    )
    .run(id, runId, sid, JSON.stringify(deltaSources('media', RUN_ID)), AT);
  walk(w, id, 'VALIDATING');
  return itemBySource(w.db, runId, sid);
}

test('a picture or swatch an earlier delta attached is never put back once the owner removed it, even when that delta never reached COMPLETE', async () => {
  const { w, sid, productId } = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
  const payload = mediaOnlyPayload(buildFor(w, 'pla-basic-filament').payload);
  // Delta B attaches and publishes, then its VERIFY blocks; run B closes partial.
  const item = await deltaItem(w, RUN_B, sid);
  const plan = await planMediaRetry(w.db, item, payload);
  for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  const a = await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload });
  assert.equal(a.swatches.length, 1);
  await finishPublishing(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid));
  await applyEvent(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid), { state: 'BLOCKED', outcome: 'blocked', code: 'VERIFY_FAILED_PERSISTENT', retry_at: '', release: false, detail: {} });
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'partial' WHERE id = ?").run(RUN_B);
  // The owner removes one retried picture (every row of it) and the swatch: the admin save deletes the rows it does
  // not keep, never their source refs.
  const gone = plan.media.find((m) => m.role === 'gallery')!.source_media_id;
  const removed = rowsOfMedium(payload, a.rows, gone);
  assert.ok(removed.length >= 1);
  for (const id of removed) w.raw.prepare('DELETE FROM product_images WHERE id = ?').run(id);
  w.raw.prepare('DELETE FROM product_option_value_swatches WHERE option_value_id = ?').run(a.swatches[0].option_value_id);
  const settled = productState(w, productId);

  // Delta C from the same closed run: B attached, so the item is settled — never queued, never registered.
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  const planC = await deltaPlan(w.db, runOf(RUN_C), { from_run: RUN_ID, sitemap_handles: ['pla-basic-filament'] }, w.bundle);
  assert.deepEqual([planC.media, planC.counts.media_items, planC.counts.media_already_retried], [[], 0, 1]);
  const regC = await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: AT }] });
  assert.deepEqual(regC, { accepted: 0, new: 0, media: 0, content: 0, skipped: { ...NONE_SKIPPED, media_already_retried: 1 } });

  // And an item registered anyway puts back neither: the image rows' source refs, and B's checkpoint for the
  // swatch, say the owner removed them.
  const again = await byHand(w, RUN_C, sid, 'cii_by_hand');
  const plan2 = await planMediaRetry(w.db, again, payload);
  for (const m of plan2.media) {
    const old = w.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_product_id = ? AND source_media_id = ?').get(RUN_B, sid, m.source_media_id) as { r2_key: string };
    w.raw
      .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height) VALUES (?, ?, ?, ?, ?, 'stored', ?, 80, 60)")
      .run(RUN_C, sid, m.source_media_id, m.role, m.source_url, old.r2_key);
  }
  walk(w, again.id, 'WRITING');
  const writing2 = await itemBySource(w.db, RUN_C, sid);
  const c = await attachRetriedMedia(envOf(w), runOf(RUN_C), writing2, w.bundle, { payload_sha256: writing2.payload_sha256, payload });
  assert.deepEqual([c.counts.attached, c.counts.owner_removed, c.counts.already_present], [0, 2, 1], JSON.stringify(c.counts));
  assert.deepEqual([c.rows, c.swatches], [[], []]);
  assert.deepEqual(productState(w, productId), settled, 'nothing the owner removed came back');
});

test('a failed swatch for a value the owner hid since, or a value of a hidden group, is never attached (it could never be seen); VERIFY expects only what the product still holds and shows', async () => {
  for (const hide of ['value', 'group'] as const) {
    const { w, sid, productId, failed } = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
    const payload = mediaOnlyPayload(buildFor(w, 'pla-basic-filament').payload);
    const valueId = payload.swatches.find((s) => s.source_media_id === failed.find((f) => f.role === 'swatch')!.id)!.value_id;
    if (hide === 'value') w.raw.prepare('UPDATE product_option_values SET active = 0 WHERE id = ? AND product_id = ?').run(valueId, productId);
    else w.raw.prepare('UPDATE product_option_groups SET active = 0 WHERE id = (SELECT group_id FROM product_option_values WHERE id = ?) AND product_id = ?').run(valueId, productId);
    const item = await deltaItem(w, RUN_B, sid);
    const plan = await planMediaRetry(w.db, item, payload);
    for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
    walk(w, item.id, 'WRITING');
    const writing = await itemBySource(w.db, RUN_B, sid);
    const a = await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload });
    assert.deepEqual([a.swatches, a.counts.target_missing, a.counts.attached], [[], 1, 2], `${hide}: ${JSON.stringify(a.counts)}`);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_option_value_swatches WHERE option_value_id = ?', valueId), 0);
    assert.ok(a.rows.length >= 2);

    await finishPublishing(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid));
    const verifying = await itemBySource(w.db, RUN_B, sid);
    const env = { DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
    const live = `${ORIGIN}/product/${verifying.slug}`;
    const evidence = (status: number, rows: number) => ({ lease_token: LEASE, live_url: live, edge_evidence: { version: 1, live_url: live, round: 1, status, rows_seen: rows, swatches_seen: 0 } });
    if (hide === 'value') {
      // The owner removed one attached row before VERIFY: no longer expected (it could never be seen again).
      w.raw.prepare('DELETE FROM product_images WHERE id = ?').run(a.rows[0].id);
      const short = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), verifying, evidence(200, a.rows.length - 2));
      assert.equal(short.state, 'VERIFYING_LIVE', 'a row still held that the public product does not show: nothing moves');
      const done = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid), evidence(200, a.rows.length - 1));
      assert.equal(done.state, 'COMPLETE');
      assert.deepEqual((done.d1_checks.media_retry as Record<string, unknown>).rows_present, a.rows.length - 1);
    } else {
      // The owner hid the product before VERIFY: nothing to see, nothing held back.
      w.raw.prepare("UPDATE products SET status = 'draft' WHERE id = ?").run(productId);
      const done = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), verifying, evidence(404, 0));
      assert.equal(done.state, 'COMPLETE');
    }
  }
});

test('a media item whose page no longer reads as its product (a renamed store handle) is moot: nothing fetched or attached, COMPLETE, and a later delta takes it again', async () => {
  const { w, sid, productId } = await closedRunWithFailures('pla-basic-filament', PICK_PLA);
  const before = productState(w, productId);
  const payload = mediaOnlyPayload(buildFor(w, 'pla-basic-filament').payload);
  const item = await deltaItem(w, RUN_B, sid);
  const bad = (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_BAD_REQUEST';
  const notStaged = (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_NOT_STAGED';
  // The moot never comes with a payload, and is the one word.
  await assert.rejects(() => planMediaRetry(w.db, item, payload, MOOT_IDENTITY), bad);
  await assert.rejects(() => planMediaRetry(w.db, item, undefined, 'gone'), bad);
  const plan = await planMediaRetry(w.db, item, undefined, MOOT_IDENTITY);
  assert.deepEqual([plan.media, plan.failed, plan.skipped.identity_changed, plan.payload_sha256], [[], 4, 4, MOOT_SHA256]);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  // A payload never stands in for the moot plan.
  await assert.rejects(() => attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload }), notStaged);
  const a = await attachRetriedMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, moot: MOOT_IDENTITY });
  assert.deepEqual([a.rows, a.swatches, a.counts.attached, a.counts.identity_changed, a.product_id], [[], [], 0, 4, productId]);
  await finishPublishing(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid));
  const verifying = await itemBySource(w.db, RUN_B, sid);
  const env = { DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
  const live = `${ORIGIN}/product/${verifying.slug}`;
  const done = await completeMediaRetry(env, `${ORIGIN}/api/ops/catalog-import/x`, runOf(RUN_B), verifying, {
    lease_token: LEASE,
    live_url: live,
    edge_evidence: { version: 1, live_url: live, round: 1, status: 0, rows_seen: 0, swatches_seen: 0 },
  });
  assert.equal(done.state, 'COMPLETE', 'the queue behind it is free; the run can close');
  assert.deepEqual(productState(w, productId), before, 'nothing written');
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);

  // Nothing was attached, for a passing reason: a later delta from the same closed run takes it again.
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  const planC = await deltaPlan(w.db, runOf(RUN_C), { from_run: RUN_ID, sitemap_handles: ['pla-basic-filament'] }, w.bundle);
  assert.deepEqual([planC.media.map((m) => m.source_product_id), planC.counts.media_already_retried], [[sid], 0]);
  // There the page reads as the product again: the payload's plan, and the moot never stands in for it.
  const regC = await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'media', source_product_id: sid, discovered_at: AT }] });
  assert.deepEqual(regC, { accepted: 1, new: 0, media: 1, content: 0, skipped: NONE_SKIPPED });
  walk(w, (await itemBySource(w.db, RUN_C, sid)).id, 'VALIDATING');
  const itemC = await itemBySource(w.db, RUN_C, sid);
  const planned = await planMediaRetry(w.db, itemC, payload);
  assert.equal(planned.media.length, 3);
  walk(w, itemC.id, 'WRITING');
  const writingC = await itemBySource(w.db, RUN_C, sid);
  await assert.rejects(() => attachRetriedMedia(envOf(w), runOf(RUN_C), writingC, w.bundle, { payload_sha256: writingC.payload_sha256, moot: MOOT_IDENTITY }), notStaged);
});

test('an earlier delta settles a media item when it attached something (COMPLETE or not), or completed with nothing left for a passing reason', () => {
  const sd = (rows: number, swatches: number, counts: Record<string, number> = {}) =>
    JSON.stringify({
      media_retry: {
        counts,
        rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, r2_key: 'k' })),
        swatches: Array.from({ length: swatches }, (_, i) => ({ option_value_id: `v${i}`, r2_key: 'k' })),
      },
    });
  // Attached: settled whatever became of the item (a picture the owner removed since must not come back).
  assert.equal(retrySettled('BLOCKED', sd(1, 0)), true);
  assert.equal(retrySettled('PUBLISHING', sd(0, 1)), true);
  assert.equal(retrySettled('COMPLETE', sd(2, 1)), true);
  // Nothing attached, COMPLETE: settled unless a medium was left for a passing reason.
  assert.equal(retrySettled('COMPLETE', sd(0, 0, { role_not_attachable: 1, already_present: 2, not_in_source: 1 })), true);
  assert.equal(retrySettled('COMPLETE', sd(0, 0, { product_not_public: 3 })), false, 'the product was hidden: retried once it is shown');
  assert.equal(retrySettled('COMPLETE', sd(0, 0, { not_stored: 1 })), false, 'a fetch failed again');
  assert.equal(retrySettled('COMPLETE', sd(0, 0, { identity_changed: 2 })), false, 'the page read as another product');
  // Never reached its attach, or attached nothing and stopped: not settled.
  assert.equal(retrySettled('BLOCKED', sd(0, 0)), false);
  assert.equal(retrySettled('BLOCKED', '{}'), false);
  assert.equal(retrySettled('COMPLETE', 'not json'), false);
});
