/**
 * THE CONTENT PASS (Bambu import spec §O.6; worker/lib/catalogImport/contentMedia.ts), on the writer's own world: the
 * migrated D1 shim (LimitD1: 100 parameters a statement), the R2 / IMAGES doubles, the real writer for run A.
 *
 *   the proof      the description and the box rows rebuilt with the writer's own functions are byte for byte what
 *                  the writer stored; every owner edit (any language, a translation record, the meta, a deleted
 *                  picture, the in-the-box mirror) is counted and nothing is written; a merge's field the import did
 *                  not fill is `not_imported`; a changed page is `source_changed`
 *   the write      ONE guarded batch: only `content_blocks` (+ `updated_at`) and the box row's `value_list` move; T1 is
 *                  the field the writer would have written with every picture stored; the undo gives T0 back; a field
 *                  changed between the read and the batch aborts it, the Worker decides once more on a fresh read
 *   idempotency    a second pass after an attach still proves the field (no meta, no row on the inserted blocks) and
 *                  takes the picture that failed again; what an earlier pass put in and the owner removed is never
 *                  put back
 *   verify         /content-complete expects only what the product still holds and shows
 *
 * Run: node --import tsx --test tests/catalogImportContentMedia.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildFor, complete, LEASE, newWorld, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import { webpBytes } from './fixtures/imageDoubles';
import { pageOf } from './fixtures/bambu/load';
import type { ImportPayload, PayloadBoxItem } from '../packages/catalog/src/bambuImport/payload';
import { OpsRefusal, type ImportRun } from '../worker/lib/catalogImport/auth';
import { applyEvent, finishPublishing, itemBySource, type ItemRow } from '../worker/lib/catalogImport/items';
import { acceptDeltaRows, contentSettledIds, CONTENT_FINAL, CONTENT_OUTCOMES, CONTENT_PASSING, CONTENT_RULE } from '../worker/lib/catalogImport/delta';
import { H } from '../packages/catalog/src/bambuImport/hash';
import { stripQuery } from '../packages/catalog/src/bambuImport/normalize';
import {
  attachContentMedia,
  bestOutcome,
  completeContentMedia,
  contentBatch,
  contentContext,
  contentPayloadOf,
  contentUndoOf,
  insertedOf,
  planContent,
  planContentMedia,
  proveBox,
  proveDescription,
  withReviewed,
  type ContentCheckpoint,
} from '../worker/lib/catalogImport/contentMedia';
import { contentOnlyPayload, resumeTargetOf } from '../scripts/bambu-import/run';
import { parseProductRow } from '../worker/lib/productModel';
import { localizeRespectingAuthored, planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { payloadSha256 } from '../worker/lib/catalogImport/reviewed';

const RUN_B = 'cir_bbbbbbbbbbbbbbbbbbbbbbbb';
const RUN_C = 'cir_cccccccccccccccccccccccc';
const RUN_E = 'cir_eeeeeeeeeeeeeeeeeeeeeeee';
const AT = '2026-10-19T00:00:00.000Z';
const ORIGIN = 'https://levonis-iq.com';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const envOf = (w: World) => ({ DB: w.db, ...w.media }) as never;
const runOf = (id: string): ImportRun => ({ id, state: 'open', token_expires_at: '', github_run_id: '', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: AT });
const AMS = () => pageOf('ams-2-pro').extraction;

interface Failed {
  id: string;
  role: 'description' | 'in_the_box';
  url: string;
}

const boxItemsOf = (p: ImportPayload) =>
  p.specs.filter((s) => s.key === 'package.contents').flatMap((s) => s.value_list.filter((v): v is PayloadBoxItem => !!v && typeof v === 'object' && !!(v as PayloadBoxItem).source_media_id));
const imageBlocksOf = (p: ImportPayload) => p.content_blocks.filter((b) => b.kind === 'image' && b.source_media_id);

/** Two description pictures (the 2nd and 5th) and the in-the-box picture of the AMS 2 Pro. */
const PICK_AMS = (p: ImportPayload): Failed[] => {
  const images = imageBlocksOf(p);
  const box = boxItemsOf(p)[0];
  return [
    { id: images[1].source_media_id, role: 'description', url: images[1].source_url },
    { id: images[4].source_media_id, role: 'description', url: images[4].source_url },
    { id: box.source_media_id, role: 'in_the_box', url: box.source_url },
  ];
};

type Handle = Parameters<typeof buildFor>[1];

/** Run A wrote the product with `failed` media left out (recorded failed in their roles), and closed partial. */
async function closedRun(
  handle: Handle,
  pick: (p: ImportPayload) => Failed[],
  opts: { writeMode?: 'create' | 'merge'; mergeProductId?: string; setup?: (w: World) => void; mutate?: (p: ImportPayload) => void } = {}
) {
  const w = newWorld();
  opts.setup?.(w);
  const built = buildFor(w, handle, opts).payload;
  opts.mutate?.(built);
  const failed = pick(built);
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
  return { w, s, sid, productId: result.product_id, failed, payload: s.payload };
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

/** A content run from run A: the content item registered and walked to VALIDATING under a lease. */
async function contentItem(w: World, runId: string, sid: string): Promise<ItemRow> {
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(runId);
  const r = await acceptDeltaRows(w.db, runOf(runId), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'content', source_product_id: sid, discovered_at: AT }] });
  assert.equal(r.content, 1);
  const item = await itemBySource(w.db, runId, sid);
  walk(w, item.id, 'VALIDATING');
  return itemBySource(w.db, runId, sid);
}

let pad = 900;
/** Stores one medium for `runId` the way /media does. */
function storeFor(w: World, runId: string, sid: string, mediaId: string, role: string, url: string, opts: { seed?: boolean } = {}): string {
  const b = webpBytes(80 + (pad % 40), 60 + (pad % 20), { pad: ++pad });
  const key = `products/import/gallery/${sha(b)}.webp`;
  if (opts.seed !== false) w.bucket.seed(key, b, { contentType: 'image/webp' });
  w.raw
    .prepare(
      `INSERT OR REPLACE INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height, bytes, sha256)
       VALUES (?, ?, ?, ?, ?, 'stored', ?, 80, 60, ?, ?)`
    )
    .run(runId, sid, mediaId, role, url, key, b.byteLength, sha(b));
  return key;
}

/** The whole content pass of one item: plan, the planned media stored (but `skip`), attach. */
async function pass(w: World, runId: string, sid: string, payload: ImportPayload, opts: { skip?: (id: string) => boolean; absent?: (id: string) => boolean } = {}) {
  const item = await contentItem(w, runId, sid);
  const body = contentOnlyPayload(payload);
  const plan = await planContentMedia(w.db, item, w.bundle, body);
  for (const m of plan.media) if (!opts.skip?.(m.source_media_id)) storeFor(w, runId, sid, m.source_media_id, m.role, m.source_url, { seed: !opts.absent?.(m.source_media_id) });
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, runId, sid);
  const a = await attachContentMedia(envOf(w), runOf(runId), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload: body });
  return { item, plan, a, body };
}

/** Every column of every row the import could write, by table (no clock dropped: the dump shows what moved). */
function dump(w: World, productId: string): Record<string, Array<Record<string, unknown>>> {
  const q = (sql: string) => w.raw.prepare(sql).all(productId) as Array<Record<string, unknown>>;
  return {
    products: q('SELECT * FROM products WHERE id = ?'),
    specs: q('SELECT * FROM product_spec_values WHERE product_id = ? ORDER BY id'),
    translations: q('SELECT * FROM product_translations WHERE product_id = ? ORDER BY field'),
    images: q('SELECT * FROM product_images WHERE product_id = ? ORDER BY id'),
    groups: q('SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY id'),
    values: q('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id'),
    variants: q('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id'),
    documents: q('SELECT * FROM product_documents WHERE product_id = ? ORDER BY id'),
    relations: q('SELECT * FROM product_relations WHERE product_id = ? ORDER BY id'),
    sources: q('SELECT * FROM product_source_refs WHERE product_id = ?'),
    optionRefs: q('SELECT * FROM product_option_source_refs WHERE product_id = ? ORDER BY kind, source_id, levonis_id'),
    swatches: q('SELECT * FROM product_option_value_swatches WHERE product_id = ? ORDER BY option_value_id'),
    catalogs: q('SELECT * FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id'),
  };
}

/** The columns of each row that differ between two dumps. */
function moved(before: ReturnType<typeof dump>, after: ReturnType<typeof dump>): string[] {
  const out: string[] = [];
  for (const table of Object.keys(before)) {
    const a = before[table];
    const b = after[table];
    if (a.length !== b.length) {
      out.push(`${table}:rows`);
      continue;
    }
    a.forEach((row, i) => {
      for (const k of Object.keys(row)) if (JSON.stringify(row[k]) !== JSON.stringify(b[i][k])) out.push(`${table}.${k}`);
    });
  }
  return [...new Set(out)].sort();
}

const productRow = (w: World, id: string) => w.raw.prepare('SELECT content_blocks, translation_meta, spec_fields, status, updated_at FROM products WHERE id = ?').get(id) as Record<string, string>;
const boxRow = (w: World, id: string) => w.raw.prepare("SELECT id, value_list FROM product_spec_values WHERE product_id = ? AND canonical_key = 'package.contents' ORDER BY id").all(id) as Array<{ id: string; value_list: string }>;
const checkpointOf = (w: World, runId: string, sid: string) => JSON.parse((w.raw.prepare('SELECT stage_data FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(runId, sid) as { stage_data: string }).stage_data).content_media as ContentCheckpoint;

// ---------------------------------------------------------------- the write

test('a content item puts the failed description and box pictures where the import meant them; only content_blocks (with its meta and the new alt rows), updated_at and the box row move; T1, its meta and rows are the writer\'s own with every picture stored; the undo gives T0 back', async () => {
  const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
  const before = dump(w, productId);
  const t0 = productRow(w, productId).content_blocks;
  const v0 = boxRow(w, productId);
  const { plan, a } = await pass(w, RUN_B, sid, payload);
  assert.deepEqual(plan.media.map((m) => m.source_media_id).sort(), failed.map((f) => f.id).sort(), 'every failed picture is planned (both fields as the import wrote them)');
  assert.equal(plan.failed, 3);
  assert.equal(a.counts.attached, 3);
  assert.deepEqual([a.counts.blocks, a.counts.box], [2, 1]);
  const after = dump(w, productId);
  // The description, its translation meta (the new pictures' alt entries appended) and the new pictures' alt rows.
  assert.deepEqual(moved(before, after), ['products.content_blocks', 'products.translation_meta', 'products.updated_at', 'specs.value_list', 'translations:rows']);
  const m0 = String(before.products[0].translation_meta);
  const m1 = productRow(w, productId).translation_meta;
  assert.ok(m1.startsWith(m0.slice(0, -1)), 'every byte of the meta read is kept; the entries are appended');
  assert.equal(after.translations.length, before.translations.length + 2);
  // The box row: the same items, the failed one now with its key, nothing else.
  const v1 = boxRow(w, productId);
  const x0 = JSON.parse(v0[0].value_list) as Array<Record<string, unknown>>;
  const x1 = JSON.parse(v1[0].value_list) as Array<Record<string, unknown>>;
  assert.equal(x1.length, x0.length);
  assert.ok(x1.some((it, i) => !x0[i].media_key && typeof it.media_key === 'string'));
  for (let i = 0; i < x0.length; i++) assert.deepEqual({ ...x1[i], media_key: undefined }, { ...x0[i], media_key: undefined });
  // The description: the two pictures at their payload positions, orders 0..n-1, every other block byte for byte.
  const t1 = productRow(w, productId).content_blocks;
  const blocks = JSON.parse(t1) as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.map((b) => b.order), blocks.map((_b, i) => i));
  const ids = blocks.map((b) => String(b.id));
  const wanted = payload.content_blocks.filter((b) => ids.includes(b.id)).map((b) => b.id);
  assert.deepEqual(ids, wanted, 'in the payload order');
  const cp = checkpointOf(w, RUN_B, sid);
  assert.equal(cp.rule, CONTENT_RULE);
  assert.equal(cp.sha.t0, sha(t0));
  assert.equal(cp.sha.t1, sha(t1));
  assert.deepEqual(Object.values(cp.media).sort(), ['attached', 'attached', 'attached']);
  for (const b of cp.inserted.blocks) {
    const at = blocks.find((x) => x.id === b.id)!;
    assert.deepEqual([at.kind, at.url, at.media_key, at.alt_ar, at.alt_ckb], ['image', `/files/${b.r2_key}`, b.r2_key, `صورة ${payload.product.title_en}`, `وێنەی ${payload.product.title_en}`]);
  }

  // T1 is what the writer itself writes for this page with every picture stored (the same objects): a fresh world.
  const keys = new Map<string, string>();
  for (const r of w.raw.prepare('SELECT source_media_id, r2_key FROM catalog_import_media WHERE source_product_id = ? AND status = ?').all(sid, 'stored') as Array<{ source_media_id: string; r2_key: string }>) keys.set(r.source_media_id, r.r2_key);
  const b = newWorld();
  const s = stage(b, AMS(), { skipMedia: () => true });
  for (const [id, key] of keys) {
    const obj = await w.bucket.get(key);
    b.bucket.seed(key, new Uint8Array(await obj!.arrayBuffer()), { contentType: 'image/webp' });
    b.raw
      .prepare("INSERT OR REPLACE INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height, bytes, sha256) VALUES (?, ?, ?, 'gallery', 'https://store.bblcdn.com/x.jpg', 'stored', ?, 80, 60, 10, '')")
      .run(RUN_ID, sid, id, key);
  }
  await write(b, s);
  const written = b.raw.prepare('SELECT content_blocks, translation_meta FROM products WHERE id = ?').get(productId) as { content_blocks: string; translation_meta: string };
  assert.equal(t1, written.content_blocks, 'T1 is byte for byte the writer\'s field with every picture stored');
  assert.deepEqual(boxRow(b, productId).map((r) => r.value_list), v1.map((r) => r.value_list), 'the box row too');
  // The bookkeeping too: the same meta entries (the alt approved at the same src_rev) and the same block rows.
  const canon = (t: string) => JSON.stringify(Object.entries(JSON.parse(t) as Record<string, unknown>).sort(([a], [z]) => (a < z ? -1 : 1)));
  assert.equal(canon(m1), canon(written.translation_meta), 'the meta is the writer\'s');
  const blockRows = (x: World) =>
    x.raw.prepare("SELECT field, source_en, source_hash, text_ar, text_ckb, status, translation_version FROM product_translations WHERE product_id = ? AND field LIKE 'block:%' ORDER BY field").all(productId);
  assert.deepEqual(blockRows(w), blockRows(b), 'the block translation rows are the writer\'s');

  // Reversible: the undo of the checkpoint gives T0, M0 and V0 back exactly, and names the rows it inserted.
  const undo = contentUndoOf(cp, { content_blocks: t1, translation_meta: m1, rows: new Map(v1.map((r) => [r.id, r.value_list])) });
  assert.equal(undo.content_blocks, t0);
  assert.equal(undo.translation_meta, m0);
  assert.deepEqual(undo.translations.sort(), cp.inserted.blocks.map((x) => `block:${x.id}:alt`).sort());
  assert.deepEqual(undo.rows.map((r) => r.to), v0.map((r) => r.value_list));
  // An owner's change to the meta since: no automatic undo of the description either.
  assert.equal(contentUndoOf(cp, { content_blocks: t1, translation_meta: `${m1} `, rows: new Map() }).content_blocks, null);
});

test('VERIFY: COMPLETE on the public answers the item needed; only blocks inserted needs no knowledge answer; a box row the owner hid since is not expected', async () => {
  const { w, sid, payload } = await closedRun(AMS(), PICK_AMS);
  const { a } = await pass(w, RUN_B, sid, payload);
  const item = await itemBySource(w.db, RUN_B, sid);
  await finishPublishing(w.db, runOf(RUN_B), item);
  const v = await itemBySource(w.db, RUN_B, sid);
  const url = `${ORIGIN}/product/${v.slug}`;
  const ev = (o: Record<string, number>) => ({ live_url: url, edge_evidence: { version: 1, live_url: url, round: 1, status: 200, knowledge_status: 200, blocks_seen: 2, box_seen: 1, ...o } });
  // The runner saw one block fewer: not COMPLETE.
  const short = await completeContentMedia(envOf(w), `${ORIGIN}/api/ops`, runOf(RUN_B), v, ev({ blocks_seen: 1 }));
  assert.equal(short.state, 'VERIFYING_LIVE');
  // No box picture seen on the knowledge answer: not COMPLETE either.
  assert.equal((await completeContentMedia(envOf(w), `${ORIGIN}/api/ops`, runOf(RUN_B), v, ev({ box_seen: 0 }))).state, 'VERIFYING_LIVE');
  // The owner hid the box row's scope? The AMS box row is product-scoped: make it owner-only instead (hidden from the answer).
  w.raw.prepare("UPDATE product_spec_values SET visibility = 'owner' WHERE product_id = ? AND canonical_key = 'package.contents'").run(v.levonis_product_id);
  const done = await completeContentMedia(envOf(w), `${ORIGIN}/api/ops`, runOf(RUN_B), v, ev({ box_seen: 0, knowledge_status: 0 }));
  assert.equal(done.state, 'COMPLETE', JSON.stringify(done.d1_checks));
  assert.equal((done.d1_checks.content_media as Record<string, number>).box_shown, 0);
  assert.equal(a.inserted.blocks.length, 2);
});

test('only description pictures inserted: COMPLETE with no knowledge answer at all (status 0)', async () => {
  const { w, sid, payload } = await closedRun(AMS(), (p) => PICK_AMS(p).filter((f) => f.role === 'description'));
  await pass(w, RUN_B, sid, payload);
  const item = await itemBySource(w.db, RUN_B, sid);
  await finishPublishing(w.db, runOf(RUN_B), item);
  const v = await itemBySource(w.db, RUN_B, sid);
  const url = `${ORIGIN}/product/${v.slug}`;
  const done = await completeContentMedia(envOf(w), `${ORIGIN}/api/ops`, runOf(RUN_B), v, { live_url: url, edge_evidence: { version: 1, live_url: url, round: 1, status: 200, knowledge_status: 0, blocks_seen: 2, box_seen: 0 } });
  assert.equal(done.state, 'COMPLETE', JSON.stringify(done.d1_checks));
});

// ---------------------------------------------------------------- idempotency and never putting back

test('a second pass after an attach: the inserted blocks (their alt meta and row as the batch wrote them) still prove the field; the picture that failed again is taken and attached; then nothing is queued', async () => {
  const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
  const again = failed[1].id;
  const first = await pass(w, RUN_B, sid, payload, { skip: (id) => id === again });
  assert.equal(first.a.counts.attached, 2);
  assert.equal(first.a.counts.not_stored, 1);
  assert.deepEqual([...contentSettledIds({ content_media: checkpointOf(w, RUN_B, sid) })].sort(), failed.filter((f) => f.id !== again).map((f) => f.id).sort(), 'not_stored passes');
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  // The second pass: the item queued for the one left; the field (with the first pass's blocks) still the import's.
  const second = await pass(w, RUN_C, sid, payload);
  assert.deepEqual(second.plan.media.map((m) => m.source_media_id), [again]);
  assert.equal(second.a.counts.attached, 1);
  // Directly: the first pass's pictures are already_present to any later plan.
  const ctx = await contentContext(w.db, await itemBySource(w.db, RUN_C, sid));
  const p = planContent(ctx.state, payload, failed.map((f) => ({ source_media_id: f.id, role: f.role })), true);
  assert.deepEqual([...p.outcomes.values()], ['already_present', 'already_present', 'already_present']);
  // A third content delta queues nothing: every picture settled.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_C);
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_E);
  const r = await acceptDeltaRows(w.db, runOf(RUN_E), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'content', source_product_id: sid, discovered_at: AT }] });
  assert.deepEqual([r.content, r.skipped.content_already_settled], [0, 1]);
  void productId;
});

test('an owner\'s unchanged save after a pass keeps every picture\'s authored Arabic and Sorani alt, and the field stays provable: a later pass takes the picture that failed again', async () => {
  const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
  await pass(w, RUN_B, sid, payload, { skip: (id) => id === failed[1].id });
  const cp = checkpointOf(w, RUN_B, sid);
  // The admin route's save (adminProducts.ts): the localiser over the stored document with nothing typed, the plan, the batch.
  const stored = w.raw.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown>;
  const doc = parseProductRow(stored);
  const prev = parseProductRow(stored);
  const localized = localizeRespectingAuthored(doc, prev, {});
  const slot = `block:${cp.inserted.blocks[0].id}:alt`;
  assert.deepEqual(localized.kept.filter((k) => k.startsWith(slot)).sort(), [`${slot}.ar`, `${slot}.ckb`], 'the inserted alt is authored: its stored copy is kept');
  const plan = await planProductSave(w.db, { mode: 'update', doc, prev, relations: null as never, actor: { adminId: 'owner', money: false }, translations: localized.fields } as Parameters<typeof planProductSave>[1]);
  await saveProductAtomic(w.db, plan);
  const now = productRow(w, productId);
  assert.equal(now.content_blocks, stored.content_blocks, 'the save leaves the description byte for byte');
  assert.equal(now.translation_meta, stored.translation_meta, 'and its meta');
  const ins = (JSON.parse(now.content_blocks) as Array<Record<string, unknown>>).find((b) => b.id === cp.inserted.blocks[0].id)!;
  assert.deepEqual([ins.alt_ar, ins.alt_ckb], [`صورة ${payload.product.title_en}`, `وێنەی ${payload.product.title_en}`]);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  const second = await pass(w, RUN_C, sid, payload);
  assert.deepEqual(second.plan.media.map((m) => m.source_media_id), [failed[1].id], 'not owner_edited: the retry is still taken');
  assert.equal(second.a.counts.attached, 1);
});

test('what an earlier pass put in and the owner removed is never put back (owner_removed); the field is then not the import\'s for the rest', async () => {
  const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
  await pass(w, RUN_B, sid, payload, { skip: (id) => id === failed[1].id });
  const cp = checkpointOf(w, RUN_B, sid);
  // The owner removes the first inserted block in the admin (the form renumbers).
  const blocks = (JSON.parse(productRow(w, productId).content_blocks) as Array<Record<string, unknown>>).filter((b) => b.id !== cp.inserted.blocks[0].id).map((b, i) => ({ ...b, order: i }));
  w.raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(blocks), productId);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  const item = await contentItem(w, RUN_C, sid);
  const ctx = await contentContext(w.db, item);
  const p = planContent(ctx.state, payload, failed.map((f) => ({ source_media_id: f.id, role: f.role })), true);
  assert.equal(p.outcomes.get(failed[0].id), 'owner_removed');
  assert.equal(p.outcomes.get(failed[1].id), 'owner_edited', 'the rest of the field is the owner\'s now');
  assert.equal(p.outcomes.get(failed[2].id), 'already_present');
});

// ---------------------------------------------------------------- owner edits: counted, never written

async function planned(w: World, sid: string, payload: ImportPayload) {
  const item = await contentItem(w, RUN_B, sid);
  const ctx = await contentContext(w.db, item);
  const p = planContent(ctx.state, payload, ctx.failed, ctx.active);
  return { item, ctx, p, outcomes: Object.fromEntries([...p.outcomes].map(([k, v]) => [k, v])) as Record<string, string> };
}

const firstTextBlock = (t0: string) => (JSON.parse(t0) as Array<Record<string, unknown>>).findIndex((b) => b.kind === 'text');

test('owner_edited: the Arabic or the Sorani of a text block no longer the import\'s translation row; the box row still proves itself and is planned', async () => {
  for (const lang of ['body_ar', 'body_ckb'] as const) {
    const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
    const row = productRow(w, productId);
    const blocks = JSON.parse(row.content_blocks) as Array<Record<string, unknown>>;
    blocks[firstTextBlock(row.content_blocks)][lang] = 'نص عدله المالك';
    w.raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(blocks), productId);
    const { p, outcomes } = await planned(w, sid, payload);
    assert.equal(p.description?.reason, 'lang', lang);
    assert.deepEqual([outcomes[failed[0].id], outcomes[failed[1].id], outcomes[failed[2].id]], ['owner_edited', 'owner_edited', 'planned'], lang);
  }
});

test('owner_edited: a block slot\'s meta changed (approved), a translation row rewritten after the write, T0 not canonical JSON, an import picture the owner deleted', async () => {
  const cases: Array<[string, (w: World, productId: string) => void]> = [
    [
      'meta',
      (w, productId) => {
        const row = productRow(w, productId);
        const id = (JSON.parse(row.content_blocks) as Array<Record<string, unknown>>)[firstTextBlock(row.content_blocks)].id;
        const meta = JSON.parse(row.translation_meta);
        meta[`block:${id}:body`].ar.status = 'approved';
        w.raw.prepare('UPDATE products SET translation_meta = ? WHERE id = ?').run(JSON.stringify(meta), productId);
      },
    ],
    [
      'translation',
      (w, productId) =>
        w.raw.prepare("UPDATE product_translations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours') WHERE product_id = ? AND field LIKE 'block:%:body'").run(productId),
    ],
    ['json', (w, productId) => w.raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(JSON.parse(productRow(w, productId).content_blocks), null, 1), productId)],
    [
      'count',
      (w, productId) => {
        const blocks = (JSON.parse(productRow(w, productId).content_blocks) as Array<Record<string, unknown>>).filter((b, i, all) => i !== all.findIndex((x) => x.kind === 'image')).map((b, i) => ({ ...b, order: i }));
        w.raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(blocks), productId);
      },
    ],
  ];
  for (const [reason, edit] of cases) {
    const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
    edit(w, productId);
    const before = productRow(w, productId).content_blocks;
    const { p, outcomes } = await planned(w, sid, payload);
    assert.equal(p.description?.reason, reason, reason);
    assert.deepEqual([outcomes[failed[0].id], outcomes[failed[1].id]], ['owner_edited', 'owner_edited'], reason);
    // Nothing of the description is ever written for it.
    const { a } = await (async () => {
      const item = await itemBySource(w.db, RUN_B, sid);
      const body = contentOnlyPayload(payload);
      const plan = await planContentMedia(w.db, item, w.bundle, body);
      for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
      walk(w, item.id, 'WRITING');
      const writing = await itemBySource(w.db, RUN_B, sid);
      return { a: await attachContentMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload: body }) };
    })();
    assert.equal(a.counts.blocks, 0, reason);
    assert.equal(productRow(w, productId).content_blocks, before, reason);
  }
});

test('the page: English the rebuild disagrees with is owner_edited when the store page is unchanged, source_changed when it changed', async () => {
  const { w, sid, failed, payload } = await closedRun(AMS(), PICK_AMS);
  const item = await contentItem(w, RUN_B, sid);
  const ctx = await contentContext(w.db, item);
  const changed = structuredClone(payload);
  const t = changed.content_blocks.find((b) => b.kind === 'text')!;
  t.body_en = `${t.body_en} (new words on the store page)`;
  assert.deepEqual([proveDescription(ctx.state!, changed).label, proveDescription(ctx.state!, changed).reason], ['owner_edited', 'en']);
  changed.extraction_sha256 = 'f'.repeat(64);
  assert.equal(proveDescription(ctx.state!, changed).label, 'source_changed');
  const p = planContent(ctx.state, changed, ctx.failed, true);
  assert.equal(p.outcomes.get(failed[0].id), 'source_changed');
  assert.equal(proveDescription(ctx.state!, payload).ok, true, 'the page as it was: provable');
});

test('a merge: the description it kept (the owner\'s own) is not_imported; one it filled is provable; one it never recorded, or with nothing filled, is not_imported', async () => {
  const merge = (owned: boolean) => ({
    writeMode: 'merge' as const,
    mergeProductId: 'p_amsm',
    setup: (w: World) => {
      const blocks = owned ? JSON.stringify([{ id: 'cb_owner', kind: 'text', order: 0, body_ar: '', body_en: 'The owner\'s own words.', body_ckb: '', caption_ar: '', caption_en: '', caption_ckb: '', alt_ar: '', alt_en: '', alt_ckb: '', url: '', media_key: '' }]) : '[]';
      w.raw.prepare(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images, content_blocks)
        VALUES ('p_amsm', 'ams-2-pro-m', 'AMS 2 Pro', 'AMS 2 Pro', 'AMS 2 Pro', 'active', 0, 'cat_printers', '[]', '[]', '[]', ?)`).run(blocks);
      const x = buildFor(w, AMS(), { writeMode: 'merge', mergeProductId: 'p_amsm' }).payload;
      w.matches.push({ source_product_id: x.source_product_id, source_handle: x.handle, levonis_product_id: 'p_amsm', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
    },
  });
  {
    const { w, sid, failed, payload } = await closedRun(AMS(), PICK_AMS, merge(true));
    const { p, outcomes } = await planned(w, sid, payload);
    assert.equal(p.description?.reason, 'kept_existing');
    assert.deepEqual([outcomes[failed[0].id], outcomes[failed[1].id]], ['not_imported', 'not_imported']);
  }
  {
    const { w, sid, failed, payload } = await closedRun(AMS(), PICK_AMS, merge(false));
    const { p, outcomes } = await planned(w, sid, payload);
    assert.equal(p.description?.ok, true, p.description?.reason);
    assert.deepEqual([outcomes[failed[0].id], outcomes[failed[1].id]], ['planned', 'planned']);
    // The same field, had the merge written nothing of it (a count of 0), or the rows predate the write: not_imported.
    const state = (await contentContext(w.db, await itemBySource(w.db, RUN_B, sid))).state!;
    assert.deepEqual([proveDescription({ ...state, writtenBlocks: 0 }, payload).label, proveDescription({ ...state, writtenBlocks: 0 }, payload).reason], ['not_imported', 'merge_unfilled']);
    const old = new Map([...state.translations].map(([k, r]) => [k, { ...r, updated_at: '2020-01-01T00:00:00.000Z' }]));
    assert.deepEqual([proveDescription({ ...state, translations: old }, payload).label, proveDescription({ ...state, translations: old }, payload).reason], ['not_imported', 'translation']);
    assert.deepEqual([proveDescription({ ...state, writtenBlocks: null }, payload).label], ['not_imported']);
  }
});

test('a merge rewritten on resume an hour after its first write (VERIFY failed): the description it filled is still provable — its rows are dated by the first write, any of the item\'s writes counts', async () => {
  const w = newWorld();
  w.raw.prepare(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images, content_blocks)
    VALUES ('p_amsm', 'ams-2-pro-m', 'AMS 2 Pro', 'AMS 2 Pro', 'AMS 2 Pro', 'active', 0, 'cat_printers', '[]', '[]', '[]', '[]')`).run();
  const x = buildFor(w, AMS(), { writeMode: 'merge', mergeProductId: 'p_amsm' }).payload;
  w.matches.push({ source_product_id: x.source_product_id, source_handle: x.handle, levonis_product_id: 'p_amsm', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' } as never);
  const failed = PICK_AMS(buildFor(w, AMS(), { writeMode: 'merge', mergeProductId: 'p_amsm' }).payload);
  const ids = new Set(failed.map((f) => f.id));
  const s = stage(w, AMS(), { writeMode: 'merge', mergeProductId: 'p_amsm', skipMedia: (id) => ids.has(id) });
  await write(w, s);
  // The first write happened an hour ago (its block rows and its WRITTEN event).
  w.raw.prepare("UPDATE product_translations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE product_id = 'p_amsm'").run();
  w.raw.prepare("UPDATE catalog_import_events SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE item_id = ? AND stage = 'WRITTEN'").run(s.itemId);
  // VERIFY failed, BLOCKED, resumed (merge.ts rewritesOnResume): the write runs again now and fills nothing.
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'VERIFYING_LIVE', last_completed_stage = 'PUBLISHING' WHERE id = ?").run(s.itemId);
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'BLOCKED', blocker_code = 'VERIFY_FAILED_PERSISTENT', resume_instruction = 'x' WHERE id = ?").run(s.itemId);
  w.raw
    .prepare("UPDATE catalog_import_items SET processing_state = 'WRITING', last_completed_stage = 'INGESTING_MEDIA', blocker_code = '', resume_instruction = '', lease_token = ?, lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'), payload_sha256 = ? WHERE id = ?")
    .run(LEASE, payloadSha256(s.payload), s.itemId);
  await write(w, s);
  assert.equal((w.raw.prepare("SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND stage = 'WRITTEN' AND outcome = 'ok'").get(s.itemId) as { n: number }).n, 2);
  const sid = s.payload.source_product_id;
  for (const f of failed) {
    w.raw.prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, error_code) VALUES (?, ?, ?, ?, ?, 'failed', 'IMAGE_CONVERT_FAILED')").run(RUN_ID, sid, f.id, f.role, f.url);
  }
  complete(w, s.itemId);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'partial' WHERE id = ?").run(RUN_ID);
  const { ctx, p } = await planned(w, sid, s.payload);
  assert.equal(p.description?.ok, true, p.description?.reason);
  assert.deepEqual([p.outcomes.get(failed[0].id), p.outcomes.get(failed[1].id)], ['planned', 'planned']);
  // Against the same writes: a row dated between them (neither write's) was rewritten since; one before the first is
  // the owner's own, the merge's not_imported.
  const state = ctx.state!;
  const [first, last] = state.writtenTimes.map((t) => Date.parse(t));
  const dated = (ms: number) => new Map([...state.translations].map(([k, r]) => [k, { ...r, updated_at: new Date(ms).toISOString() }]));
  assert.deepEqual([proveDescription({ ...state, translations: dated((first + last) / 2) }, s.payload).label, proveDescription({ ...state, translations: dated((first + last) / 2) }, s.payload).reason], ['owner_edited', 'translation']);
  assert.equal(proveDescription({ ...state, translations: dated(first - 3_600_000) }, s.payload).label, 'not_imported');
  assert.equal(proveDescription({ ...state, translations: dated(last + 3_600_000) }, s.payload).label, 'owner_edited');
});

// ---------------------------------------------------------------- the box

test('the box: V0 is the stored row byte for byte; a curated string row is not_imported; the in-the-box mirror edited is owner_edited', async () => {
  const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
  const item = await contentItem(w, RUN_B, sid);
  const ctx = await contentContext(w.db, item);
  const proofs = proveBox(ctx.state!, payload);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].ok, true, proofs[0].reason);
  assert.equal(proofs[0].v0, boxRow(w, productId)[0].value_list);
  // A curated list (plain strings) in place of the item rows: never the import's items.
  const curated = { ...ctx.state!, boxRows: ctx.state!.boxRows.map((r) => ({ ...r, value_list: JSON.stringify(['AMS 2 Pro', 'Cable']) })) };
  assert.deepEqual([proveBox(curated, payload)[0].label, proveBox(curated, payload)[0].reason], ['not_imported', 'curated']);
  // The mirror the owner edits in the form (spec_fields.in_the_box), no longer the row's text.
  const sf = JSON.parse(ctx.state!.specFields || '{}');
  const mirrored = { ...ctx.state!, specFields: JSON.stringify({ ...sf, in_the_box: 'The owner\'s list' }) };
  assert.deepEqual([proveBox(mirrored, payload)[0].label, proveBox(mirrored, payload)[0].reason], ['owner_edited', 'mirror']);
  assert.equal(planContent(mirrored, payload, ctx.failed, true).outcomes.get(failed[2].id), 'owner_edited');
  // The mirror's key deleted (the form drops a field outside the section's template when emptied): the import's field
  // only where the write never mirrored this box; one it mirrored, or with no evidence of what it did, is not.
  const { in_the_box: _gone, ...rest } = sf;
  void _gone;
  const deleted = { ...ctx.state!, specFields: JSON.stringify(rest) };
  for (const [expected, label] of [[true, 'owner_edited'], [null, 'owner_edited'], [false, '']] as const) {
    const p = proveBox({ ...deleted, mirrorExpected: expected }, payload)[0];
    assert.deepEqual([p.ok, p.ok ? '' : p.label, p.ok ? '' : p.reason], [label === '', label, label ? 'mirror' : ''], String(expected));
  }
});

test('the mirror\'s evidence: the readback target when it survives, else the reviewed placement\'s template; a deleted mirror the write made is owner_edited, nothing written', async () => {
  const { w, s, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
  // No readback target survives (the readback ran): the reviewed placement's template declares in_the_box.
  const item = await contentItem(w, RUN_B, sid);
  const ctx = await contentContext(w.db, item);
  assert.equal(ctx.state!.mirrorExpected, null);
  await withReviewed(w.db, ctx, payload, w.bundle, item);
  assert.equal(ctx.state!.mirrorExpected, true, 'the AMS 2 Pro\'s template mirrors the box');
  // The owner deletes the key: the box picture is owner_edited at the plan and at the attach, the row untouched.
  const sf = JSON.parse(productRow(w, productId).spec_fields) as Record<string, string>;
  delete sf.in_the_box;
  w.raw.prepare('UPDATE products SET spec_fields = ? WHERE id = ?').run(JSON.stringify(sf), productId);
  const v0 = boxRow(w, productId);
  const plan = await planContentMedia(w.db, item, w.bundle, contentOnlyPayload(payload));
  assert.deepEqual(plan.media.map((m) => m.role).sort(), ['description', 'description']);
  assert.equal(plan.skipped.owner_edited, 1);
  for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
  walk(w, item.id, 'WRITING');
  const writing = await itemBySource(w.db, RUN_B, sid);
  const a = await attachContentMedia(envOf(w), runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload: contentOnlyPayload(payload) });
  assert.deepEqual([a.counts.box, a.counts.owner_edited], [0, 1]);
  assert.deepEqual(boxRow(w, productId), v0, 'the box row untouched');
  assert.equal(checkpointOf(w, RUN_B, sid).media[failed[2].id], 'owner_edited');
  // A surviving readback target says it directly: one whose document had no in_the_box (the write never mirrored it).
  const target = { v: 1, product_id: productId, doc: { content_blocks: [], spec_fields: { other: 'x' } }, requested: null, catalog_ids: null, printer_fits: null, money: false };
  w.raw.prepare("UPDATE catalog_import_items SET stage_data = json_set(stage_data, '$.readback_target', json(?)) WHERE id = ?").run(JSON.stringify(target), s.itemId);
  assert.equal((await contentContext(w.db, writing)).state!.mirrorExpected, false);
  target.doc.spec_fields = { in_the_box: 'Bambu AMS 2 Pro' } as never;
  w.raw.prepare("UPDATE catalog_import_items SET stage_data = json_set(stage_data, '$.readback_target', json(?)) WHERE id = ?").run(JSON.stringify(target), s.itemId);
  assert.equal((await contentContext(w.db, writing)).state!.mirrorExpected, true);
});

test('one box picture shown in several rows: every row gets its key, each row compare-and-set on its own text', async () => {
  // The A1's option row shares its first picture with the product row (a page that shows the same item twice).
  const share = (p: ImportPayload) => {
    const rows = p.specs.filter((s) => s.key === 'package.contents');
    const a = rows[0].value_list.find((v) => !!v && typeof v === 'object') as PayloadBoxItem;
    const b = rows[1].value_list.find((v) => !!v && typeof v === 'object') as PayloadBoxItem;
    b.source_media_id = a.source_media_id;
    b.source_url = a.source_url;
  };
  const pick = (p: ImportPayload): Failed[] => {
    const a = p.specs.filter((s) => s.key === 'package.contents')[0].value_list.find((v) => !!v && typeof v === 'object') as PayloadBoxItem;
    return [{ id: a.source_media_id, role: 'in_the_box', url: a.source_url }];
  };
  const { w, sid, productId, payload } = await closedRun('a1', pick, { mutate: share });
  const fresh = buildFor(w, 'a1').payload;
  share(fresh);
  const before = boxRow(w, productId);
  const { a } = await pass(w, RUN_B, sid, fresh);
  assert.equal(a.counts.attached, 1);
  assert.equal(a.inserted.box.length, 2, 'both occurrences');
  const after = boxRow(w, productId);
  assert.equal(after.filter((r, i) => r.value_list !== before[i].value_list).length, 2, 'both rows written');
  assert.equal(new Set(a.inserted.box.map((b) => b.r2_key)).size, 1, 'one key');
  void payload;
});

test('a 25-row box: every statement of the batch stays at 100 parameters or fewer', () => {
  const binds: number[] = [];
  const fake = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        binds.push(args.length);
        return {} as D1PreparedStatement;
      },
    }),
  } as unknown as D1Database;
  const rows = Array.from({ length: 25 }, (_v, i) => ({ rowId: `sv_${i}`, v0: '[]', v1: '[]' }));
  const statements = contentBatch(
    fake,
    { id: RUN_B, github_run_id: '' },
    { id: 'cii_x', lease_token: LEASE, payload_sha256: 'a'.repeat(64) },
    {
      productId: 'p_x',
      slug: 'x',
      mark: { kind: 'content', fromRun: RUN_ID },
      state: { t0: '[]', m0: '{}', specFields: '{}' } as never,
      translationsDigest: '0:',
    },
    {
      t0: '[]',
      t1: '[1]',
      m0: '{}',
      m1: '{"block:cb_1:alt":{}}',
      altRows: [1, 2].map((i) => ({ field: `block:cb_${i}:alt`, source_en: 'x', source_hash: 'h', text_ar: 'ع', text_ckb: 'ک' })),
      boxWrites: rows,
      inserted: { blocks: [], box: [] },
      counts: {} as never,
      checkpoint: {} as never,
    }
  );
  assert.equal(statements.length, 1 + 25 + 1 + 2 + 25 + 3);
  assert.ok(Math.max(...binds) <= 100, `max ${Math.max(...binds)}`);
  assert.ok(Math.max(...binds) <= 10);
});

// ---------------------------------------------------------------- the batch under the guard

/** A D1 binding that changes the stored description just before each batch (an owner's save between read and write). */
function racingD1(inner: D1Database, raw: World['raw'], productId: string, times: number): D1Database {
  let left = times;
  return new Proxy(inner, {
    get(target, key, receiver) {
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (left-- > 0) {
            const row = raw.prepare('SELECT content_blocks FROM products WHERE id = ?').get(productId) as { content_blocks: string };
            const blocks = JSON.parse(row.content_blocks) as Array<Record<string, unknown>>;
            const i = blocks.findIndex((b) => b.kind === 'text');
            blocks[i].body_ar = `${String(blocks[i].body_ar)} …`;
            raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(blocks), productId);
          }
          return target.batch(statements);
        };
      }
      const v = Reflect.get(target, key, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('a field changed between the read and the batch: the guard aborts the batch whole, the Worker decides once more on the fresh read (owner_edited, nothing of the description written); twice: transient', async () => {
  for (const times of [1, 2]) {
    const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
    const item = await contentItem(w, RUN_B, sid);
    const body = contentOnlyPayload(payload);
    const plan = await planContentMedia(w.db, item, w.bundle, body);
    for (const m of plan.media) storeFor(w, RUN_B, sid, m.source_media_id, m.role, m.source_url);
    walk(w, item.id, 'WRITING');
    const writing = await itemBySource(w.db, RUN_B, sid);
    const env = { ...(envOf(w) as Record<string, unknown>), DB: racingD1(w.db, w.raw, productId, times) } as never;
    const t0 = productRow(w, productId).content_blocks;
    if (times === 1) {
      const a = await attachContentMedia(env, runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload: body });
      assert.deepEqual([a.counts.owner_edited, a.counts.attached, a.counts.blocks, a.counts.box], [2, 1, 0, 1]);
      const now = productRow(w, productId).content_blocks;
      assert.notEqual(now, t0, 'the racing edit stands');
      assert.equal((JSON.parse(now) as unknown[]).length, (JSON.parse(t0) as unknown[]).length, 'no picture went into the edited field');
      assert.equal(checkpointOf(w, RUN_B, sid).media[failed[0].id], 'owner_edited');
    } else {
      await assert.rejects(
        () => attachContentMedia(env, runOf(RUN_B), writing, w.bundle, { payload_sha256: writing.payload_sha256, payload: body }),
        (e: unknown) => e instanceof OpsRefusal && e.status === 503 && e.code === 'IMPORT_ITEM_CHANGED'
      );
      assert.equal((await itemBySource(w.db, RUN_B, sid)).processing_state, 'WRITING', 'nothing committed');
    }
  }
});

test('an object R2 no longer holds at the attach is not_stored (a later pass takes it again); a hidden product gets nothing (product_not_public)', async () => {
  {
    const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_AMS);
    const t0 = productRow(w, productId).content_blocks;
    const { a } = await pass(w, RUN_B, sid, payload, { absent: (id) => id === failed[0].id });
    assert.equal(a.counts.not_stored, 1);
    assert.equal(a.counts.attached, 2);
    assert.equal((JSON.parse(productRow(w, productId).content_blocks) as unknown[]).length, (JSON.parse(t0) as unknown[]).length + 1);
  }
  {
    const { w, sid, productId, payload } = await closedRun(AMS(), PICK_AMS);
    w.raw.prepare("UPDATE products SET status = 'hidden' WHERE id = ?").run(productId);
    const before = dump(w, productId);
    const { plan, a } = await pass(w, RUN_B, sid, payload);
    assert.deepEqual([plan.media.length, a.counts.product_not_public], [0, 3]);
    assert.deepEqual(moved(before, dump(w, productId)), []);
  }
});

/** The owner's completeness switch holding the product for a catalog-blocking gap (status stays 'active'). */
const hold = (w: World, productId: string, code: 'IMAGE' | 'CATEGORY') =>
  w.raw
    .prepare(`INSERT OR REPLACE INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at) VALUES (?, 0, 1, ?, 1, '2026-10-19T00:00:00.000Z')`)
    .run(productId, JSON.stringify([{ c: code }]));

test('a product the completeness switch holds (active, but 404 on both public answers) is not public: nothing is inserted, the item COMPLETEs; one held after the attach COMPLETEs on 404s too (never VERIFY_FAILED_PERSISTENT)', async () => {
  {
    const { w, sid, productId, payload } = await closedRun(AMS(), PICK_AMS);
    hold(w, productId, 'IMAGE');
    const before = dump(w, productId);
    const { plan, a } = await pass(w, RUN_B, sid, payload);
    assert.deepEqual([plan.media.length, a.counts.product_not_public, a.counts.attached], [0, 3, 0]);
    assert.deepEqual(moved(before, dump(w, productId)), [], 'nothing written');
    await finishPublishing(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid));
    const v = await itemBySource(w.db, RUN_B, sid);
    const url = `${ORIGIN}/product/${v.slug}`;
    const done = await completeContentMedia(envOf(w), `${ORIGIN}/api/ops`, runOf(RUN_B), v, { live_url: url, edge_evidence: { version: 1, live_url: url, round: 1, status: 0, knowledge_status: 0, blocks_seen: 0, box_seen: 0 } });
    assert.equal(done.state, 'COMPLETE', JSON.stringify(done.d1_checks));
    assert.deepEqual(Object.values(checkpointOf(w, RUN_B, sid).media), ['product_not_public', 'product_not_public', 'product_not_public'], 'passing: a later pass takes them again');
  }
  {
    const { w, sid, productId, payload } = await closedRun(AMS(), PICK_AMS);
    const { a } = await pass(w, RUN_B, sid, payload);
    assert.equal(a.counts.attached, 3);
    await finishPublishing(w.db, runOf(RUN_B), await itemBySource(w.db, RUN_B, sid));
    hold(w, productId, 'CATEGORY');
    const v = await itemBySource(w.db, RUN_B, sid);
    const url = `${ORIGIN}/product/${v.slug}`;
    const ev = (round: number) => ({ live_url: url, edge_evidence: { version: 1, live_url: url, round, status: 404, knowledge_status: 404, blocks_seen: 0, box_seen: 0 } });
    const done = await completeContentMedia(envOf(w), `${ORIGIN}/api/ops`, runOf(RUN_B), v, ev(1));
    assert.equal(done.state, 'COMPLETE', JSON.stringify(done.d1_checks));
    assert.equal((done.d1_checks.content_media as Record<string, unknown>).product_shown, false);
  }
});

// ---------------------------------------------------------------- not a picture, or not fetchable: decided from the address

const pathOf = (url: string) => new URL(url).pathname;
const isVideo = (url: string) => /\.mp4$/i.test(pathOf(url));
const contentIdOf = (url: string) => `content:${H(stripQuery(url))}`;

/** The h2d page's five description MP4s (in its 40 picture blocks) and one JPEG picture, failed in run A. */
const PICK_H2D = (p: ImportPayload): Failed[] => {
  const images = imageBlocksOf(p);
  const jpg = images.find((b) => /\.jpe?g$/i.test(pathOf(b.source_url)))!;
  return [...images.filter((b) => isVideo(b.source_url)), jpg].map((b) => ({ id: b.source_media_id, role: 'description' as const, url: b.source_url }));
};

test('the h2d page: its five description MP4s are not_an_image (video_file) and never requested; the picture failed beside them is put back; the checkpoint settles all six', async () => {
  const { w, sid, failed, payload } = await closedRun('h2d', PICK_H2D);
  // The extractor is unchanged: the MP4s keep their block ids and places (the text split at 60 included) under the 40 cap.
  assert.equal(imageBlocksOf(payload).length, 40);
  assert.deepEqual(payload.content_blocks.flatMap((b, i) => (b.kind === 'image' && isVideo(b.source_url) ? [i] : [])), [22, 23, 44, 45, 60]);
  assert.equal(failed.length, 6);
  const videos = failed.slice(0, 5).map((f) => f.id);
  const jpg = failed[5].id;
  const { plan, a } = await pass(w, RUN_B, sid, payload);
  assert.deepEqual(plan.media.map((m) => m.source_media_id), [jpg], 'only the picture is fetched');
  assert.deepEqual([plan.failed, plan.skipped.not_an_image, plan.skipped.host_not_allowed], [6, 5, 0]);
  assert.deepEqual([a.counts.attached, a.counts.not_an_image, a.counts.not_stored, a.counts.blocks], [1, 5, 0, 1]);
  const cp = checkpointOf(w, RUN_B, sid);
  for (const id of videos) assert.deepEqual([cp.media[id], cp.reasons[id]], ['not_an_image', 'video_file']);
  assert.equal(cp.media[jpg], 'attached');
  assert.deepEqual([...contentSettledIds({ content_media: cp })].sort(), failed.map((f) => f.id).sort(), 'all six settled');
  // A later content delta queues nothing for this product.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  w.raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'open')").run(RUN_C);
  const r = await acceptDeltaRows(w.db, runOf(RUN_C), w.bundle, { from_run: RUN_ID, rows: [{ kind: 'content', source_product_id: sid, discovered_at: AT }] });
  assert.deepEqual([r.content, r.skipped.content_already_settled], [0, 1]);
});

test('a video an earlier pass left not_stored (fetched and refused before this rule knew videos) is taken again, settles as not_an_image, and nothing is requested', async () => {
  const { w, sid, productId, failed, payload } = await closedRun('h2d', PICK_H2D);
  const videos = failed.slice(0, 5).map((f) => f.id);
  await pass(w, RUN_B, sid, payload);
  // What the canary item recorded: the five videos fetched, refused (IMAGE_NOT_SUPPORTED), not_stored.
  const sd = JSON.parse((w.raw.prepare('SELECT stage_data FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').get(RUN_B, sid) as { stage_data: string }).stage_data);
  for (const id of videos) {
    sd.content_media.media[id] = 'not_stored';
    delete sd.content_media.reasons[id];
  }
  w.raw.prepare('UPDATE catalog_import_items SET stage_data = ? WHERE run_id = ? AND source_product_id = ?').run(JSON.stringify(sd), RUN_B, sid);
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_B);
  const t1 = productRow(w, productId).content_blocks;
  const { plan, a } = await pass(w, RUN_C, sid, payload);
  assert.deepEqual([plan.failed, plan.media.length, a.counts.not_an_image, a.counts.attached], [5, 0, 5, 0]);
  assert.equal(productRow(w, productId).content_blocks, t1, 'nothing written');
  assert.deepEqual([...contentSettledIds({ content_media: checkpointOf(w, RUN_C, sid) })].sort(), [...videos].sort());
});

/** AMS 2 Pro description pictures moved to a vector file, a Shopify-hosted picture, a store.bblcdn.eu picture (each id the builder's for its URL). */
const ODD = {
  svg: 'https://store.bblcdn.com/s7/default/0a1b2c3d/3d.svg',
  shop: 'https://cdn.shopify.com/s/files/1/0584/7236/6216/files/feature.png?v=17',
  eu: 'https://store.bblcdn.eu/s8/default/0a1b2c3d/feature.png',
  shopKept: 'https://cdn.shopify.com/s/files/1/0584/7236/6216/files/kept.png?v=3',
  boxShop: 'https://cdn.shopify.com/s/files/1/0645/5876/0155/files/box.png',
};
const ODD_AT: ReadonlyArray<[number, string]> = [
  [1, ODD.svg],
  [4, ODD.shop],
  [6, ODD.eu],
  [8, ODD.shopKept],
];
const oddAms = (p: ImportPayload) => {
  const images = imageBlocksOf(p);
  for (const [i, url] of ODD_AT) {
    images[i].source_url = url;
    images[i].source_media_id = contentIdOf(url);
  }
  const box = boxItemsOf(p)[0];
  box.source_url = ODD.boxShop;
  box.source_media_id = `box:${H(stripQuery(ODD.boxShop))}`;
};
/** The vector, Shopify and .eu pictures and the Shopify box picture failed in run A; the second Shopify picture was stored. */
const PICK_ODD = (p: ImportPayload): Failed[] => {
  const images = imageBlocksOf(p);
  const box = boxItemsOf(p)[0];
  return [
    ...[1, 4, 6].map((i) => ({ id: images[i].source_media_id, role: 'description' as const, url: images[i].source_url })),
    { id: box.source_media_id, role: 'in_the_box', url: box.source_url },
  ];
};

test('a vector file is not_an_image (vector_file), a Shopify-hosted picture host_not_allowed (description and in the box), neither requested; a store.bblcdn.eu picture is planned and put back', async () => {
  const { w, sid, failed, payload } = await closedRun(AMS(), PICK_ODD, { mutate: oddAms });
  const [svg, shop, eu, box] = failed.map((f) => f.id);
  assert.deepEqual(failed.map((f) => f.url), [ODD.svg, ODD.shop, ODD.eu, ODD.boxShop]);
  const { plan, a } = await pass(w, RUN_B, sid, payload);
  assert.deepEqual(plan.media.map((m) => [m.source_media_id, m.source_url]), [[eu, ODD.eu]], 'only the .eu picture is fetched');
  assert.deepEqual([plan.skipped.not_an_image, plan.skipped.host_not_allowed], [1, 2]);
  assert.deepEqual([a.counts.attached, a.counts.not_an_image, a.counts.host_not_allowed, a.counts.blocks, a.counts.box], [1, 1, 2, 1, 0]);
  const cp = checkpointOf(w, RUN_B, sid);
  assert.deepEqual(
    [svg, shop, eu, box].map((id) => [cp.media[id], cp.reasons[id] ?? '']),
    [
      ['not_an_image', 'vector_file'],
      ['host_not_allowed', 'cdn.shopify.com'],
      ['attached', ''],
      ['host_not_allowed', 'cdn.shopify.com'],
    ]
  );
  assert.deepEqual([...contentSettledIds({ content_media: cp })].sort(), [svg, shop, eu, box].sort(), 'settled under this rule');
});

test('the address decides before the field\'s proof: on an edited field the vector file is still not_an_image; a host-refused picture the field already holds stays already_present', async () => {
  const { w, sid, productId, failed, payload } = await closedRun(AMS(), PICK_ODD, { mutate: oddAms });
  const [svg, shop, eu, box] = failed.map((f) => f.id);
  const kept = contentIdOf(ODD.shopKept);
  {
    const item = await contentItem(w, RUN_B, sid);
    const ctx = await contentContext(w.db, item);
    const p = planContent(ctx.state, payload, [...ctx.failed, { source_media_id: kept, role: 'description' }], true);
    assert.equal(p.outcomes.get(kept), 'already_present', 'what the field holds is never re-decided by its address');
    assert.equal(p.outcomes.get(eu), 'planned');
  }
  // The owner edits the Arabic of a text block: the description is not provable any more.
  const row = productRow(w, productId);
  const blocks = JSON.parse(row.content_blocks) as Array<Record<string, unknown>>;
  blocks[firstTextBlock(row.content_blocks)].body_ar = 'نص عدله المالك';
  w.raw.prepare('UPDATE products SET content_blocks = ? WHERE id = ?').run(JSON.stringify(blocks), productId);
  const ctx = await contentContext(w.db, await itemBySource(w.db, RUN_B, sid));
  const p = planContent(ctx.state, payload, ctx.failed, true);
  assert.deepEqual(
    [svg, shop, eu, box].map((id) => [p.outcomes.get(id), p.reasons.get(id) ?? '']),
    [
      ['not_an_image', 'vector_file'],
      ['host_not_allowed', 'cdn.shopify.com'],
      ['owner_edited', 'lang'],
      ['host_not_allowed', 'cdn.shopify.com'],
    ]
  );
  assert.deepEqual(p.requests, []);
});

test('a planned picture /media answered failed is not_stored with its media code as the reason (diagnosis only): still passing', async () => {
  const { w, sid, failed, payload } = await closedRun(AMS(), PICK_AMS);
  const gif = failed[0].id;
  const { a } = await pass(w, RUN_B, sid, payload, {
    skip: (id) => {
      if (id !== gif) return false;
      w.raw
        .prepare("INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, error_code, attempts) VALUES (?, ?, ?, 'description', ?, 'failed', 'IMAGE_ANIMATED_GIF', 1)")
        .run(RUN_B, sid, gif, failed[0].url);
      return true;
    },
  });
  assert.deepEqual([a.counts.attached, a.counts.not_stored], [2, 1]);
  const cp = checkpointOf(w, RUN_B, sid);
  assert.deepEqual([cp.media[gif], cp.reasons[gif]], ['not_stored', 'IMAGE_ANIMATED_GIF']);
  assert.ok(!contentSettledIds({ content_media: cp }).has(gif), 'a later pass takes it again');
});

test('the two outcomes decided from the address: appended after every existing key, settled under the rule they were recorded with, taken again under a later rule', () => {
  assert.deepEqual(CONTENT_OUTCOMES.slice(0, 11), [
    'attached', 'already_present', 'owner_removed', 'owner_edited', 'not_imported', 'source_changed', 'not_on_page', 'not_stored', 'product_not_public', 'identity_changed', 'source_gone',
  ], 'the report keys keep their order');
  assert.deepEqual(CONTENT_OUTCOMES.slice(11), ['not_an_image', 'host_not_allowed']);
  for (const o of ['not_an_image', 'host_not_allowed']) assert.ok(!CONTENT_PASSING.has(o) && !CONTENT_FINAL.has(o), o);
  const media = { v: 'not_an_image', h: 'host_not_allowed', s: 'not_stored', a: 'attached' };
  assert.deepEqual([...contentSettledIds({ content_media: { rule: CONTENT_RULE, media } })].sort(), ['a', 'h', 'v']);
  assert.deepEqual([...contentSettledIds({ content_media: { rule: CONTENT_RULE, media } }, CONTENT_RULE + 1)].sort(), ['a'], 'an allow-list change (a new rule) takes them again');
});

// ---------------------------------------------------------------- the door

test('the content door: the payload with its description and box rows only, this product\'s, its blocks the builder\'s own', async () => {
  const { w, sid, payload } = await closedRun(AMS(), PICK_AMS);
  const item = await contentItem(w, RUN_B, sid);
  const ctx = await contentContext(w.db, item);
  const ok = contentOnlyPayload(payload);
  assert.doesNotThrow(() => contentPayloadOf(ok, item, ctx));
  const refused = (p: ImportPayload, code: string) =>
    assert.throws(
      () => contentPayloadOf(p, item, ctx),
      (e: unknown) => e instanceof OpsRefusal && e.code === code
    );
  refused({ ...ok, specs: payload.specs }, 'IMPORT_BAD_REQUEST');
  refused({ ...ok, documents: payload.documents.length ? payload.documents : [{ ...((payload.documents[0] ?? {}) as object) } as never] }, payload.documents.length ? 'IMPORT_BAD_REQUEST' : 'IMPORT_PAYLOAD_KEY_REFUSED');
  const dup = structuredClone(ok);
  dup.content_blocks[1].id = dup.content_blocks[0].id;
  refused(dup, 'IMPORT_BAD_REQUEST');
  const alt = structuredClone(ok);
  imageBlocksOf(alt)[0].alt_ar = 'نص آخر';
  refused(alt, 'IMPORT_BAD_REQUEST');
  const moved = structuredClone(ok);
  imageBlocksOf(moved)[0].source_url = 'https://store.bblcdn.com/elsewhere.png';
  refused(moved, 'IMPORT_BAD_REQUEST');
  refused({ ...ok, handle: 'another-product' }, 'IMPORT_IDENTITY_AMBIGUOUS');
});

test('the checkpoint settles per medium: passing outcomes pass, terminal ones settle; an older rule settles only what was written or must never come back', () => {
  const media = { a: 'attached', b: 'already_present', c: 'owner_removed', d: 'owner_edited', e: 'not_imported', f: 'source_changed', g: 'not_on_page', h: 'not_stored', i: 'product_not_public', j: 'identity_changed', k: 'source_gone', l: 'a_later_code' };
  assert.deepEqual([...contentSettledIds({ content_media: { rule: CONTENT_RULE, media } })].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'l']);
  assert.deepEqual([...contentSettledIds(JSON.stringify({ content_media: { rule: CONTENT_RULE - 1, media } }))].sort(), ['a', 'b', 'c', 'l']);
  assert.deepEqual([...contentSettledIds('{"media_retry":{"counts":{"role_not_attachable":3}}}')], [], 'a media item settles no content');
  assert.deepEqual([...contentSettledIds('not json')], []);
  assert.equal(bestOutcome(['owner_edited', 'attached']), 'attached');
  assert.equal(bestOutcome(['not_imported', 'source_changed', 'owner_edited']), 'owner_edited');
  assert.equal(bestOutcome(['not_on_page', 'not_stored']), 'not_stored');
  assert.deepEqual(insertedOf('{"content_media":{"inserted":{"blocks":[{"id":"cb_1","r2_key":"k"}],"box":[{"row_id":"sv_1","index":2,"r2_key":"k"}]}}}'), {
    blocks: [{ id: 'cb_1', r2_key: 'k' }],
    box: [{ row_id: 'sv_1', index: 2, r2_key: 'k' }],
  });
});

test('a content item BLOCKED at VERIFY resumes at VERIFYING_LIVE on both sides (it never rewrites)', async () => {
  const { w, sid, payload } = await closedRun(AMS(), PICK_AMS, {});
  await pass(w, RUN_B, sid, payload);
  const item = await itemBySource(w.db, RUN_B, sid);
  await finishPublishing(w.db, runOf(RUN_B), item);
  let v = await itemBySource(w.db, RUN_B, sid);
  await applyEvent(w.db, runOf(RUN_B), v, { state: 'BLOCKED', outcome: 'blocked', code: 'VERIFY_FAILED_PERSISTENT', message: '', detail: {}, retry_at: '', release: false } as never);
  v = await itemBySource(w.db, RUN_B, sid);
  assert.equal(v.processing_state, 'BLOCKED');
  // The runner's target, for a content item of a merged product too: VERIFYING_LIVE, never WRITING.
  const target = resumeTargetOf({ kind: 'content', merge: true, blockerCode: 'VERIFY_FAILED_PERSISTENT', lastCompleted: v.last_completed_stage, productId: v.levonis_product_id });
  assert.equal(target, 'VERIFYING_LIVE');
  assert.equal(resumeTargetOf({ kind: 'item', merge: true, blockerCode: 'VERIFY_FAILED_PERSISTENT', lastCompleted: 'PUBLISHING', productId: 'p_x' }), 'WRITING');
  const back = await applyEvent(w.db, runOf(RUN_B), v, { state: target!, outcome: 'resume', code: '', message: '', detail: {}, retry_at: '', release: false } as never);
  assert.equal(back.state, 'VERIFYING_LIVE', 'the Worker agrees');
});
