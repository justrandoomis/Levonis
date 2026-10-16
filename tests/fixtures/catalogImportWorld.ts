/**
 * A migrated database ready for the catalogue import's writer (Bambu import
 * spec §A.4, §A.5; tests/catalogImport*.test.ts): every migration on
 * node:sqlite behind `LimitD1` (D1's 100-parameter and 5-term limits), the
 * Bambu Lab brand and the taxonomy nodes `/run/prepare-taxonomy` would insert,
 * an open run, the reviewed bundle built from the committed P0 drafts and the
 * step-4 fixtures, and media stored the way `/media` stores it (content-
 * addressed WebP objects in an R2 double, decodable by an IMAGES double, one
 * `catalog_import_media` row each).
 *
 * `stage(world, handle)` puts one product's item at WRITING under a live lease
 * with its staged payload; `write(world, handle)` plans and runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb } from './app';
import { ROOT } from './d1';
import { limitD1 } from './d1Limits';
import { R2Double, imagesDouble, webpBytes } from './imageDoubles';
import { fixtureJson, sample, type SampleHandle } from './bambu/load';
import { buildImportPayload, type ImportPayload } from '../../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../../packages/catalog/src/bambuImport/fingerprint';
import type { CompatTargets } from '../../packages/catalog/src/bambuImport/relations';
import type { Extraction } from '../../packages/catalog/src/bambuImport/extract';
import {
  emptyReviewedTexts,
  parseReviewedBundle,
  payloadSha256,
  taxonomyNodeId,
  type ReviewedBundle,
  type ReviewedTexts,
} from '../../worker/lib/catalogImport/reviewed';
import {
  importWriteContext,
  planImportWrite,
  runImportWrite,
  type ImportWritePlan,
  type ImportWriteResult,
} from '../../worker/lib/catalogImport/writer';

export const RUN_ID = 'cir_0123456789abcdef01234567';
export const LEASE = 'lease_test_0001';
const P0 = join(ROOT, 'docs', 'bambu-import', 'p0');

export const p0Json = <T = Record<string, unknown>>(file: string): T => JSON.parse(readFileSync(join(P0, file), 'utf8')) as T;

export interface World {
  raw: DatabaseSync;
  db: D1Database;
  bucket: R2Double;
  images: ReturnType<typeof imagesDouble>;
  media: { BUCKET: unknown; R2_PUBLIC: unknown; R2_PRIVATE: unknown; IMAGES: unknown };
  texts: ReviewedTexts;
  bundle: ReviewedBundle;
  /** Rows added to the reviewed files (rebuild the bundle with `rebundle`). */
  manifestRows: Array<Record<string, unknown>>;
  matches: Array<Record<string, unknown>>;
  queue: number;
  /** The reviewed compat-targets file, when a test fills in existing Levonis ids (the step-2 snapshot); else the fixture's. */
  compat?: CompatTargets;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** The manifest row of a fixture: the P0 draft's when it has one (SKU codes, value labels), else from the extraction. */
export function manifestRowOf(x: Extraction, queue: number): Record<string, unknown> {
  const p0 = (p0Json<{ rows: Array<Record<string, unknown>> }>('manifest.json').rows.find((r) => r.handle === x.handle) ?? {}) as Record<string, unknown>;
  return {
    queue_position: queue,
    source: 'bambu_us',
    source_product_id: x.sourceProductId,
    handle: x.handle,
    canonical_url: x.canonicalUrl.startsWith('https://') ? x.canonicalUrl : `https://us.store.bambulab.com/products/${x.handle}`,
    title: x.title,
    type: String(p0.type ?? 'spare_part'),
    currentAllIdRoute: x.route,
    leaf: String(p0.leaf ?? ''),
    also: (p0.also as string[]) ?? [],
    curated: false,
    hold_code: '',
    sku_codes: (p0.sku_codes as Record<string, string>) ?? {},
    value_labels: (p0.value_labels as Record<string, unknown>) ?? {},
  };
}

export function bundleTexts(world: Pick<World, 'manifestRows' | 'matches' | 'compat'>, extra: Partial<ReviewedTexts> = {}): ReviewedTexts {
  const empty = emptyReviewedTexts();
  return {
    ...empty,
    manifest: JSON.stringify({ version: 1, source: 'bambu_us', rows: world.manifestRows }),
    taxonomyMap: readFileSync(join(P0, 'taxonomy-map.json'), 'utf8'),
    existingMatches: JSON.stringify({ version: 1, entries: world.matches }),
    compatTargets: JSON.stringify(world.compat ?? fixtureJson('compat-targets.json')),
    identityMap: readFileSync(join(P0, 'identity-map.json'), 'utf8'),
    ...extra,
  };
}

export function rebundle(world: World, extra: Partial<ReviewedTexts> = {}): void {
  world.texts = bundleTexts(world, extra);
  world.bundle = parseReviewedBundle(world.texts);
}

/** A fresh world: migrations, brand, taxonomy nodes, an open run. */
export function newWorld(): World {
  const raw = freshDb();
  raw.exec("INSERT INTO brands (id, slug, name_ar, name_en, name_ckb) VALUES ('brd_bambu', 'bambu-lab', 'Bambu Lab', 'Bambu Lab', 'Bambu Lab')");
  const tax = p0Json<{ create: Array<Record<string, unknown>> }>('taxonomy-map.json');
  for (const n of tax.create) {
    const parent = String(n.parent);
    raw
      .prepare(
        `INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(taxonomyNodeId(String(n.key)), parent.startsWith('@') ? taxonomyNodeId(parent) : parent, String(n.slug), String(n.name_ar), String(n.name_en), String(n.name_ckb), Number(n.sort ?? 0), Number(n.is_printer_catalog ?? 0), String(n.template_family));
  }
  raw.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'running')").run(RUN_ID);
  const bucket = new R2Double();
  const images = imagesDouble();
  const world: World = {
    raw,
    db: limitD1(raw),
    bucket,
    images,
    media: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: new R2Double(), IMAGES: images.binding },
    texts: emptyReviewedTexts(),
    bundle: parseReviewedBundle(emptyReviewedTexts()),
    manifestRows: [],
    matches: [],
    queue: 0,
  };
  return world;
}

let pad = 0;
/** Stores one medium the way /media does: a content-addressed WebP and its catalog_import_media row. */
export function storeMedium(world: World, sourceProductId: string, sourceMediaId: string, role: string, sourceUrl: string): string {
  const bytes = webpBytes(64 + (pad % 50), 48 + (pad % 30), { pad: ++pad });
  const key = `products/import/gallery/${sha(bytes)}.webp`;
  world.bucket.seed(key, bytes, { contentType: 'image/webp' });
  world.raw
    .prepare(
      `INSERT OR REPLACE INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height, bytes, sha256)
       VALUES (?, ?, ?, ?, ?, 'stored', ?, 64, 48, ?, ?)`
    )
    .run(RUN_ID, sourceProductId, sourceMediaId, role, sourceUrl || 'https://store.bblcdn.com/x.jpg', key, bytes.byteLength, sha(bytes));
  return key;
}

export interface Staged {
  payload: ImportPayload;
  itemId: string;
  extraction: Extraction;
}

/** A fixture's payload as the runner builds it (the P0 manifest row and identity entry, the compat targets). */
export function buildFor(
  world: Pick<World, 'queue' | 'compat'>,
  handle: SampleHandle | Extraction,
  opts: { writeMode?: 'create' | 'merge'; mergeProductId?: string } = {}
): { payload: ImportPayload; extraction: Extraction; row: Record<string, unknown> } {
  const x = typeof handle === 'string' ? sample(handle) : handle;
  const identity = p0Json<{ entries: Record<string, Record<string, string>> }>('identity-map.json').entries[x.handle] ?? null;
  const row = manifestRowOf(x, world.queue + 1);
  const built = buildImportPayload({
    extraction: x,
    writeMode: opts.writeMode ?? 'create',
    mergeProductId: opts.mergeProductId,
    extractionSha256: extractionFingerprint(x),
    manifestRow: row as never,
    identity: identity ? { model: identity.model, series: identity.series, family: identity.family } : null,
    targets: world.compat ?? fixtureJson<CompatTargets>('compat-targets.json'),
    retrievedAt: '2026-10-15T00:00:00.000Z',
  });
  return { payload: built.payload, extraction: x, row };
}

/** Builds a fixture's payload, lists it in the manifest, stores its media and puts its item at WRITING. */
export function stage(
  world: World,
  handle: SampleHandle | Extraction,
  opts: { writeMode?: 'create' | 'merge'; mergeProductId?: string; mutate?: (p: ImportPayload) => void; skipMedia?: (id: string) => boolean } = {}
): Staged {
  const { payload, extraction: x, row } = buildFor(world, handle, opts);
  opts.mutate?.(payload);
  const known = world.manifestRows.find((r) => r.source_product_id === x.sourceProductId);
  if (!known) {
    world.queue += 1;
    world.manifestRows.push(row);
  }
  rebundle(world);
  const queue = Number((known ?? row).queue_position);
  // Media, as /media stores it.
  const mediaIds = new Map<string, string>();
  for (const i of payload.images) mediaIds.set(i.source_media_id, i.source_url);
  for (const s of payload.swatches) mediaIds.set(s.source_media_id, s.source_url);
  for (const b of payload.content_blocks) if (b.kind === 'image' && b.source_media_id) mediaIds.set(b.source_media_id, b.source_url);
  for (const s of payload.specs) for (const v of s.value_list) if (v && typeof v === 'object' && v.source_media_id) mediaIds.set(v.source_media_id, v.source_url);
  for (const [id, url] of mediaIds) if (!opts.skipMedia?.(id)) storeMedium(world, x.sourceProductId, id, 'gallery', url);
  const itemId = `cii_${x.handle}`;
  // trg_cii_insert refuses even an INSERT OR IGNORE over an item that has moved on: insert only a new one.
  if (!world.raw.prepare('SELECT 1 AS x FROM catalog_import_items WHERE id = ?').get(itemId)) {
    world.raw
      .prepare(
        `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at)
         VALUES (?, ?, 'bambu_us', ?, ?, ?, ?, '2026-10-15T00:00:00.000Z')`
      )
      .run(itemId, RUN_ID, x.sourceProductId, x.handle, String(row.canonical_url), queue);
  }
  setWriting(world, itemId, payload);
  return { payload, itemId, extraction: x };
}

const PATH = ['DISCOVERED', 'EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING'];

/** Walks an item to WRITING under a live lease with the payload staged (what /lease, /event and /stage leave behind). */
export function setWriting(world: World, itemId: string, payload: ImportPayload): void {
  let cur = (world.raw.prepare('SELECT processing_state AS s FROM catalog_import_items WHERE id = ?').get(itemId) as { s: string }).s;
  while (cur !== 'WRITING') {
    const i = PATH.indexOf(cur);
    if (i < 0) throw new Error(`setWriting: the item is ${cur}`);
    const next = PATH[i + 1];
    world.raw
      .prepare('UPDATE catalog_import_items SET processing_state = ?, last_completed_stage = ? WHERE id = ?')
      .run(next, cur === 'DISCOVERED' ? '' : cur, itemId);
    cur = next;
  }
  world.raw
    .prepare("UPDATE catalog_import_items SET lease_token = ?, lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'), payload_sha256 = ? WHERE id = ?")
    .run(LEASE, payloadSha256(payload), itemId);
}

export async function plan(world: World, staged: Staged, overrides: { mode?: 'stage' | 'write'; lease?: string; payload?: unknown; skipAllowList?: boolean } = {}): Promise<{ plan: ImportWritePlan; ctx: ReturnType<typeof importWriteContext> }> {
  const ctx = importWriteContext(world.db, world.media as never);
  const p = await planImportWrite(ctx, {
    mode: overrides.mode ?? 'write',
    payload: overrides.payload ?? staged.payload,
    bundle: world.bundle,
    runId: RUN_ID,
    itemId: staged.itemId,
    leaseToken: overrides.lease ?? LEASE,
    retrievedAt: '2026-10-15T00:00:00.000Z',
    ...(overrides.skipAllowList ? { unsafeSkipAllowListForTests: true as const } : {}),
  });
  return { plan: p, ctx };
}

export async function write(world: World, staged: Staged): Promise<{ plan: ImportWritePlan; result: ImportWriteResult }> {
  const { plan: p, ctx } = await plan(world, staged);
  const result = await runImportWrite(ctx, p);
  return { plan: p, result };
}

export const count = (raw: DatabaseSync, sql: string, ...params: unknown[]): number =>
  Number((raw.prepare(sql).get(...(params as never[])) as { n: number }).n);

/** Walks a written item (PUBLISHING) to COMPLETE, so the run's one in-flight slot frees for the next product. */
export function complete(world: World, itemId: string): void {
  world.raw.prepare("UPDATE catalog_import_items SET processing_state = 'VERIFYING_LIVE', last_completed_stage = 'PUBLISHING' WHERE id = ?").run(itemId);
  world.raw
    .prepare(
      `UPDATE catalog_import_items SET processing_state = 'COMPLETE', last_completed_stage = 'VERIFYING_LIVE', live_url = 'https://levonis-iq.com/product/x',
              verified_at = '2026-10-15T00:00:00.000Z', d1_checks = '{"ok":true}', edge_evidence = '{"ok":true}' WHERE id = ?`
    )
    .run(itemId);
}

/**
 * A D1 binding that fails around the import's WRITE BATCH (the batch that carries the write's checkpoint) once
 * armed — review 6c, the post-commit record:
 *
 *   'tail'  the batch commits; then every statement and batch fails (D1's ambiguous "Network connection lost")
 *           until `heal()`: a short outage after the commit, or an invocation that ends right after it —
 *           either way nothing after the commit lands;
 *   'lost'  the batch commits and its answer is lost (the same error thrown from the batch call itself); the
 *           binding is healthy again at once.
 *
 * Every other statement, before the batch and after `heal()`, goes through untouched.
 */
export function postCommitFaultD1(inner: D1Database, mode: 'tail' | 'lost'): { db: D1Database; arm: () => void; heal: () => void; refused: () => number } {
  const state = { armed: false, down: false, refused: 0 };
  const sqlOf = new WeakMap<object, string>();
  const innerOf = new WeakMap<object, D1PreparedStatement>();
  const fail = () => {
    state.refused++;
    return Promise.reject(new Error('D1_ERROR: Network connection lost.'));
  };
  const wrap = (sql: string, st: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...v: unknown[]) => wrap(sql, st.bind(...v)),
      first: (col?: string) => (state.down ? fail() : col === undefined ? st.first() : st.first(col)),
      all: () => (state.down ? fail() : st.all()),
      run: () => (state.down ? fail() : st.run()),
      raw: (o?: { columnNames?: boolean }) => (state.down ? fail() : st.raw(o as never)),
    };
    sqlOf.set(w, sql);
    innerOf.set(w, st);
    return w as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string) => wrap(sql, inner.prepare(sql)),
    batch: async (stmts: D1PreparedStatement[]) => {
      if (state.down) return fail();
      const isWrite = state.armed && stmts.some((s) => /last_completed_stage = 'WRITING'/.test(sqlOf.get(s as object) ?? ''));
      const r = await inner.batch(stmts.map((s) => innerOf.get(s as object) ?? s));
      if (!isWrite) return r;
      state.armed = false;
      if (mode === 'lost') return fail();
      state.down = true;
      return r;
    },
    exec: (q: string) => inner.exec(q),
    dump: () => (inner as unknown as { dump: () => Promise<ArrayBuffer> }).dump(),
  };
  return {
    db: db as unknown as D1Database,
    arm: () => (state.armed = true),
    heal: () => (state.down = false),
    refused: () => state.refused,
  };
}
