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
 *                    (every medium already_present); a merged product's pictures are appended after its own
 *   COMPLETE         only when the runner saw every attached picture and D1 and R2 hold them
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
import { finishPublishing, itemBySource, type ItemRow } from '../worker/lib/catalogImport/items';
import { acceptDeltaRows, DELTA_NEW_MAX, deltaMarkOf, deltaQueue, deltaSources, isReservedSource, withDeltaRows, deltaRowsOf } from '../worker/lib/catalogImport/delta';
import { attachRetriedMedia, completeMediaRetry, planMediaRetry, retryPlan } from '../worker/lib/catalogImport/mediaRetry';
import { ConfigError, configFromEnv, DELTA_NEW_MAX as RUNNER_NEW_MAX, mediaOnlyPayload } from '../scripts/bambu-import/run';

const RUN_B = 'cir_bbbbbbbbbbbbbbbbbbbbbbbb';
const RUN_C = 'cir_cccccccccccccccccccccccc';
const AT = '2026-10-19T00:00:00.000Z';
const ORIGIN = 'https://levonis-iq.com';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The Worker's media bindings and D1 of a world, as /media-attach takes them. */
const envOf = (w: World) => ({ DB: w.db, ...w.media }) as never;

const runOf = (id: string): ImportRun => ({ id, state: 'open', token_expires_at: '', github_run_id: '', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: AT });

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
  assert.deepEqual(q.counts, { listed: 7, known: 4, new: 2, unusable_handles: 1, media_items: 2, media_failed: 4, failed_not_complete: 3, withdrawn_listed: 1 });
  // Nothing new, nothing failed: an empty delta.
  const empty = deltaQueue({ listedHandles: ['done-clean'], prior, fromRun: A, failedBySid: new Map() });
  assert.deepEqual([empty.newHandles, empty.media], [[], []]);
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
  assert.deepEqual(r, { accepted: 1, new: 0, media: 1 });
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

  // IDEMPOTENT: a later delta from the same closed run attaches nothing, and the product does not move.
  const settled = productState(w, productId);
  const again = await deltaItem(w, RUN_C, sid);
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
  // A "new" product that run A already held (by id), or that a product carries as its source.
  await refuses({ from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: sid, handle: 'pla-basic-new', route: '1>2', discovered_at: AT }] });
  await refuses({ from_run: RUN_ID, rows: [{ kind: 'new', source_product_id: '999', handle: 'pla-basic-filament', route: '1>2', discovered_at: AT }] });
});

test('a merged product: the retried pictures are appended after its own, bound only through the reviewed map; again: nothing', async () => {
  const setup = (w: World) => {
    w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images)
      VALUES ('p_a1m', 'bambu-a1-m', 'Bambu Lab A1', 'بامبو A1', 'بامبو A1', 'active', 0, 'cat_printers', '[]', '[]', '[]')`);
    w.raw.exec("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1m', 'cat_printers', 1)");
    const x = buildFor(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1m' }).payload;
    w.matches.push({ source_product_id: x.source_product_id, source_handle: x.handle, levonis_product_id: 'p_a1m', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  };
  const pick = (p: ImportPayload): Failed[] =>
    [...new Map(notPrimary(p).map((i) => [i.source_media_id, i])).values()].slice(0, 2).map((i) => ({ id: i.source_media_id, role: 'gallery' as const, url: i.source_url }));
  const opts = { writeMode: 'merge' as const, mergeProductId: 'p_a1m', setup };
  const { w, sid } = await closedRunWithFailures('a1', pick, opts);
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
  assert.deepEqual(r, { accepted: 1, new: 1, media: 0 });
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
