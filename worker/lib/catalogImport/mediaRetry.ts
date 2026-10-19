/**
 * THE MEDIA-ONLY STAGE OF A DELTA RUN (Bambu import spec §O.3; ./delta.ts).
 *
 * A COMPLETE item of the closed run whose media failed is queued again in the delta run as a `media` item. It walks
 * the ordinary state graph (§B.3), but writes nothing but pictures:
 *
 *   EXTRACTING       the runner reads the store page again (robots.txt, ≥ 11 s apart) and rebuilds the payload
 *                    exactly as the importer does (buildImportPayload, the reviewed bundle);
 *   VALIDATING       POST /items/:sid/media-plan: the Worker proves the payload is this item's (source id, handle,
 *                    the product the import wrote and how: product_source_refs), and plans: of the media the closed
 *                    run recorded `failed` for this product, which the page still shows and where (`retryPlan`).
 *                    Description and in-the-box pictures are counted, never attached (that would rewrite the
 *                    product's text or specifications); a failed medium the page no longer shows is counted;
 *   INGESTING_MEDIA  the ordinary /media, which for a media item takes ONLY the planned failed media;
 *   WRITING          POST /items/:sid/media-attach: ONE guarded batch (the import guard row armed, so every money,
 *                    stock and package trigger refuses), INSERT-only — new `product_images` rows on the slot the
 *                    original write gave them (create) or appended after the product's own pictures through the
 *                    reviewed value map (merge), their `product_option_source_refs`, and swatches for a value that
 *                    has none — then the lease-fenced WRITTEN event and the checkpoint. Never an UPDATE or DELETE of
 *                    a product, image, option, variant, price or stock row: an existing image is never moved,
 *                    re-bound or removed, the primary never changes. A row whose id is already there (quarantined
 *                    included), or whose picture the product already shows for the same binding, is counted and
 *                    left out: the stage is idempotent. A product deleted since the closed run gets nothing (its
 *                    plan is empty) and the item completes, so it never stops the queue;
 *   PUBLISHING       the ordinary /publish-finish (recompute, purge);
 *   VERIFYING_LIVE   POST /items/:sid/media-complete: the runner's public read of the product (every attached
 *                    picture shown) and the Worker's own recompute (every attached row in D1, every object in R2).
 *
 * Counts only in answers and events; the attached rows' ids and keys stay in stage_data (what VERIFY reads back).
 */
import type { Env } from '../types';
import { newId } from '../crypto';
import { fence, isFenceMiss } from '../operations';
import { HttpError } from '../http';
import { loadRelationsResponse } from '../productPersistence';
import { verifyAndNormalizeProductMedia } from '../productMediaWrite';
import type { ProductDoc } from '../productModel';
import { assertImportPayload, type ImportPayload } from '@levonis/catalog/bambuImport/payload';
import { collapseContentDuplicates } from '@levonis/catalog/bambuImport/mediaCollapse';
import { NOW_SQL, OpsRefusal, type ImportRun } from './auth';
import { liveUrlOf } from './complete';
import { deltaMarkOf, type DeltaMark } from './delta';
import { stageDataOf, type ItemRow } from './items';
import { importObjectHead } from './media';
import { IMPORT_GUARD_ID } from './protectedTables';
import { payloadSha256, type ReviewedBundle } from './reviewed';
import { ckbNotCopy, imageRowOf, loadMedia, mergeImages, mergeMapping, refusalOfBatch, wireImage, type ImportImageRow } from './writer';

type MediaEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>;

/** The roles a media-only stage attaches; the others would rewrite the product's description or specifications. */
export const ATTACHABLE_ROLES: ReadonlySet<string> = new Set(['gallery', 'swatch']);

/** What became of one failed medium. */
export const RETRY_OUTCOMES = [
  'attached',
  'already_present',
  'duplicate_content',
  'target_missing',
  'not_stored',
  'role_not_attachable',
  'not_in_source',
  'primary_unchanged',
  'product_not_public',
] as const;
export type RetryOutcome = (typeof RETRY_OUTCOMES)[number];
export type RetryCounts = Record<RetryOutcome, number>;

export const emptyRetryCounts = (): RetryCounts => Object.fromEntries(RETRY_OUTCOMES.map((k) => [k, 0])) as RetryCounts;

export interface FailedMedium {
  source_media_id: string;
  role: string;
}

export interface RetryRequest {
  source_media_id: string;
  role: 'gallery' | 'swatch';
  source_url: string;
}

export interface RetryPlan {
  /** The failed media to fetch again, with the page's own address for each. */
  requests: RetryRequest[];
  /** The failed media planned out, by reason (counted per medium). */
  skipped: RetryCounts;
}

/**
 * Pure: of the media the closed run recorded `failed`, the ones the rebuilt payload still shows where the original
 * write would have put them. A gallery picture the payload now makes the primary is left out (the primary never
 * changes here); a failed medium the page no longer shows is `not_in_source`.
 */
export function retryPlan(payload: ImportPayload, failed: readonly FailedMedium[]): RetryPlan {
  const skipped = emptyRetryCounts();
  const requests: RetryRequest[] = [];
  const seen = new Set<string>();
  for (const f of failed) {
    if (seen.has(f.source_media_id)) continue;
    seen.add(f.source_media_id);
    if (!ATTACHABLE_ROLES.has(f.role)) {
      skipped.role_not_attachable++;
      continue;
    }
    if (f.role === 'gallery') {
      const rows = payload.images.filter((i) => i.source_media_id === f.source_media_id);
      if (!rows.length) skipped.not_in_source++;
      else if (rows.some((i) => i.is_primary)) skipped.primary_unchanged++;
      else requests.push({ source_media_id: f.source_media_id, role: 'gallery', source_url: rows[0].source_url });
      continue;
    }
    const sw = payload.swatches.find((s) => s.source_media_id === f.source_media_id);
    if (!sw) skipped.not_in_source++;
    else requests.push({ source_media_id: f.source_media_id, role: 'swatch', source_url: sw.source_url });
  }
  return { requests, skipped };
}

// ---------------------------------------------------------------- the item, its closed run and the product

export interface RetryContext {
  mark: DeltaMark;
  productId: string;
  slug: string;
  merge: boolean;
  /** The product is active: a hidden one gets nothing (COMPLETE needs public evidence of what was attached). */
  active: boolean;
  /**
   * The product the closed run wrote is gone (deleted since, or no longer carrying this source): nothing to attach to.
   * The item is still worked to COMPLETE with nothing attached (every planned medium `product_not_public`), so it can
   * never stop the queue behind it; its id, slug and write mode are the closed run's item's.
   */
  gone: boolean;
  failed: FailedMedium[];
}

/**
 * A media item of this run, with what it retries: the closed run's COMPLETE item, the product the import wrote for
 * this source (product_source_refs: its id and whether it was created or merged), and the media recorded failed.
 */
export async function retryContext(db: D1Database, item: ItemRow): Promise<RetryContext> {
  const row = await db.prepare('SELECT discovery_sources FROM catalog_import_items WHERE id = ?').bind(item.id).first<{ discovery_sources: string }>();
  const mark = deltaMarkOf(row?.discovery_sources ?? '');
  if (!mark || mark.kind !== 'media') throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  const from = await db
    .prepare("SELECT levonis_product_id, slug, match_kind FROM catalog_import_items WHERE run_id = ? AND source = 'bambu_us' AND source_product_id = ? AND processing_state = 'COMPLETE'")
    .bind(mark.fromRun, item.source_product_id)
    .first<{ levonis_product_id: string; slug: string; match_kind: string }>();
  if (!from?.levonis_product_id) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  const ref = await db
    .prepare("SELECT r.product_id, r.match_kind, p.slug, p.status FROM product_source_refs r JOIN products p ON p.id = r.product_id WHERE r.source = 'bambu_us' AND r.source_product_id = ?")
    .bind(item.source_product_id)
    .first<{ product_id: string; match_kind: string; slug: string; status: string }>();
  const { results } = await db
    .prepare("SELECT source_media_id, role FROM catalog_import_media WHERE run_id = ? AND source_product_id = ? AND status = 'failed' ORDER BY source_media_id")
    .bind(mark.fromRun, item.source_product_id)
    .all<FailedMedium>();
  const failed = results ?? [];
  if (!ref || ref.product_id !== from.levonis_product_id || (ref.match_kind !== 'created' && ref.match_kind !== 'merged')) {
    // The owner deleted the product after the closed run (productDeletion.ts removes its source ref with it), or the
    // source now names another product: nothing of this item can be attached, and a refusal here would block it
    // for good (a resume plans again; it is not SOURCE_WITHDRAWN, so it cannot be withdrawn).
    return { mark, productId: from.levonis_product_id, slug: String(from.slug ?? ''), merge: from.match_kind === 'merged', active: false, gone: true, failed };
  }
  return { mark, productId: ref.product_id, slug: ref.slug, merge: ref.match_kind === 'merged', active: ref.status === 'active', gone: false, failed };
}

/** The plan for this item: `retryPlan`, and nothing at all for a product that is not public. */
export function planFor(ctx: Pick<RetryContext, 'failed' | 'active'>, payload: ImportPayload): RetryPlan {
  const plan = retryPlan(payload, ctx.failed);
  if (ctx.active) return plan;
  return { requests: [], skipped: { ...plan.skipped, product_not_public: plan.skipped.product_not_public + plan.requests.length } };
}

/**
 * The payload, allow-listed, and proved to be this item's product as the import wrote it. The media-only door takes
 * the payload WITHOUT its prose (the runner's mediaOnlyPayload): no description block, spec, document, relation,
 * external id or note reaches it, so nothing of that kind could be written even by mistake.
 */
export function retryPayloadOf(raw: unknown, item: ItemRow, ctx: RetryContext): ImportPayload {
  const payload = assertImportPayload(raw);
  const prose =
    payload.content_blocks.length + payload.specs.length + payload.documents.length + payload.relations.length + payload.external_ids.length + payload.notes.length +
    payload.product.usage_steps.length + (payload.product.short_description_en ? 1 : 0) + (payload.product.usage_official_url ? 1 : 0);
  if (prose > 0) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  if (
    payload.source_product_id !== item.source_product_id ||
    payload.handle !== item.handle ||
    payload.product_id !== ctx.productId ||
    // A gone product gets nothing written: its write mode proves nothing (an older item may not record it).
    (!ctx.gone && payload.write_mode !== (ctx.merge ? 'merge' : 'create'))
  ) {
    throw new OpsRefusal(409, 'IMPORT_IDENTITY_AMBIGUOUS', [item.id]);
  }
  return payload;
}

/** /media for a media item: only the failed media of the closed run, in an attachable role. */
export function assertRetryRequests(ctx: RetryContext, item: ItemRow, requests: ReadonlyArray<{ source_media_id: string; role: string }>): void {
  const failed = new Map(ctx.failed.map((f) => [f.source_media_id, f.role]));
  for (const r of requests) {
    if (failed.get(r.source_media_id) !== r.role || !ATTACHABLE_ROLES.has(r.role)) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  }
}

// ---------------------------------------------------------------- /media-plan

export const PLAN_STATES = new Set(['VALIDATING', 'INGESTING_MEDIA', 'WRITING']);

/** POST /items/:sid/media-plan (after holdLease): records the payload's digest and answers what to fetch again. */
export async function planMediaRetry(db: D1Database, item: ItemRow, raw: unknown): Promise<{ payload_sha256: string; media: RetryRequest[]; skipped: RetryCounts; failed: number }> {
  if (!PLAN_STATES.has(item.processing_state)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  const ctx = await retryContext(db, item);
  const payload = retryPayloadOf(raw, item, ctx);
  const plan = planFor(ctx, payload);
  const sha = payloadSha256(payload);
  const r = await db
    .prepare(
      `UPDATE catalog_import_items
          SET payload_sha256 = ?,
              stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.media_retry_plan', json(?)),
              updated_at = ${NOW_SQL}
        WHERE id = ? AND lease_token = ? AND processing_state IN ('VALIDATING','INGESTING_MEDIA','WRITING')`
    )
    .bind(sha, JSON.stringify({ failed: ctx.failed.length, requests: plan.requests.length, skipped: plan.skipped }), item.id, item.lease_token)
    .run();
  if (Number(r.meta?.changes ?? 0) !== 1) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  return { payload_sha256: sha, media: plan.requests, skipped: plan.skipped, failed: ctx.failed.length };
}

// ---------------------------------------------------------------- /media-attach

export interface AttachedRows {
  rows: Array<{ id: string; r2_key: string }>;
  swatches: Array<{ option_value_id: string; r2_key: string }>;
}

export interface AttachAnswer extends AttachedRows {
  product_id: string;
  slug: string;
  counts: RetryCounts;
}

interface PlannedRow {
  row: ImportImageRow;
  alt: { en: string; ar: string; ckb: string; source_url: string };
}

/** The outcome of a medium whose rows had these outcomes: attached when any row went in. */
function mediumOutcome(rows: readonly RetryOutcome[]): RetryOutcome {
  for (const o of ['attached', 'already_present', 'duplicate_content', 'not_stored'] as const) if (rows.includes(o)) return o;
  return 'target_missing';
}

const GALLERY_INSERT = `INSERT INTO product_images
   (id, product_id, url, alt_en, sort_order, is_primary, option_value_id, color_id, variant_id,
    width, height, bytes, content_type, alt_ar, alt_ckb, r2_key, source_url, quarantined, quarantine_reason)
 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
 ON CONFLICT (id) DO NOTHING`;

/**
 * POST /items/:sid/media-attach (after holdLease): the planned media now stored, attached in ONE guarded batch
 * (see the head of this file). Answers counts per medium and the rows it inserted.
 */
export async function attachRetriedMedia(env: MediaEnv, run: ImportRun, item: ItemRow, bundle: ReviewedBundle, body: Record<string, unknown>): Promise<AttachAnswer> {
  const db = env.DB;
  if (item.processing_state !== 'WRITING') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  if (typeof body.payload_sha256 !== 'string' || body.payload_sha256 !== item.payload_sha256) throw new OpsRefusal(409, 'IMPORT_NOT_STAGED', [item.id]);
  const ctx = await retryContext(db, item);
  const payload = retryPayloadOf(body.payload, item, ctx);
  if (payloadSha256(payload) !== item.payload_sha256) throw new OpsRefusal(409, 'IMPORT_NOT_STAGED', [item.id]);
  const plan = planFor(ctx, payload);
  const counts: RetryCounts = { ...plan.skipped };
  const stored = await loadMedia(db, run.id, item.source_product_id);
  const keyOf = (id: string) => {
    const m = stored.get(id);
    return m && m.status === 'stored' && m.r2_key ? m.r2_key : '';
  };
  const productId = ctx.productId;

  // The product as it stands: its images (every one, so a picture it already shows is never added twice), values
  // and variants (a create's rows name only ids the original write gave it). A gone product has none: its plan is
  // empty (planFor), so nothing below adds a row, and the checkpoint records nothing attached.
  const loaded = ctx.gone ? null : await loadRelationsResponse(db, productId);
  if (!loaded && !ctx.gone) throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  const rel = loaded;
  const relImages = rel?.images ?? [];
  // A quarantined row keeps its id (its key is cleared): re-inserting its id is a no-op, never an attach.
  const existingIds = new Set([...relImages, ...(rel?.quarantined_images ?? [])].map((i) => String(i.id)));
  const existingKeys = new Set(relImages.map((i) => String(i.r2_key ?? '')).filter(Boolean));
  // The writer's own duplicate rule (mergeImages, collapseContentDuplicates): a picture is "already shown" for a
  // binding only when the same key is shown under the same binding.
  const bindingOf = (r: { r2_key?: unknown; option_value_id?: unknown; variant_id?: unknown; color_id?: unknown }) =>
    `${String(r.r2_key ?? '')}|${String(r.option_value_id ?? '')}|${String(r.variant_id ?? '')}|${String(r.color_id ?? '')}`;
  const existingBindings = new Set(relImages.map(bindingOf));
  /** The earliest slot a key is shown at (a bound copy of it joins that slot, as the writer's collapse puts it). */
  const firstSlotOfKey = new Map<string, number>();
  for (const i of relImages) {
    const k = String(i.r2_key ?? '');
    const at = Number(i.sort_order) || 0;
    if (k && (!firstSlotOfKey.has(k) || at < firstSlotOfKey.get(k)!)) firstSlotOfKey.set(k, at);
  }
  const ownValues = new Set((rel?.values ?? []).map((v) => String(v.id)));
  const ownVariants = new Set((rel?.variants ?? []).map((v) => String(v.id)));
  const match = ctx.merge ? bundle.matches.bySourceId.get(item.source_product_id) ?? null : null;
  const mergeOk = !ctx.merge || (!!match && (match.decision === 'merge' || match.decision === 'merge_publish') && match.levonis_product_id === productId);
  const mapping = ctx.merge && mergeOk && rel ? mergeMapping(payload, match!, rel) : null;

  // ---- the gallery rows
  const galleryIds = new Set(plan.requests.filter((r) => r.role === 'gallery').map((r) => r.source_media_id));
  const outcomes = new Map<string, RetryOutcome[]>();
  const note = (sid: string, o: RetryOutcome) => outcomes.set(sid, [...(outcomes.get(sid) ?? []), o]);
  let rows: ImportImageRow[] = [];
  const alts = new Map<string, PlannedRow['alt']>();
  for (const img of payload.images) {
    if (!galleryIds.has(img.source_media_id)) continue;
    const key = keyOf(img.source_media_id);
    if (!key) {
      note(img.source_media_id, 'not_stored');
      continue;
    }
    rows.push({ ...imageRowOf(img, key), is_primary: false });
    alts.set(img.id, { en: img.alt_en, ar: img.alt_ar, ckb: ckbNotCopy(img.alt_ar, img.alt_ckb), source_url: img.source_url });
  }
  if (!mergeOk) {
    for (const r of rows) note(r.source_media_id, 'target_missing');
    rows = [];
  } else if (mapping && rel) {
    // A merge: bound only through the reviewed value map, appended after the product's own pictures (§E.2).
    const m = mergeImages(rows, mapping, rel);
    const kept = new Set(m.rows.map((r) => r.id));
    for (const r of m.written) note(r.source_media_id, 'already_present');
    for (const r of rows) if (!kept.has(r.id) && !m.written.some((w) => w.id === r.id)) note(r.source_media_id, existingIds.has(r.id) ? 'already_present' : 'duplicate_content');
    rows = m.rows.map((r) => ({ ...r, is_primary: false }));
  } else {
    // A create: the slot and the binding the original write would have given it (the payload's own ids), when the
    // product still has that value or variant. Byte-identical new copies collapse as the writer collapses them.
    const scoped: ImportImageRow[] = [];
    for (const r of rows) {
      const okScope =
        (!r.option_value_id || ownValues.has(r.option_value_id)) && (!r.variant_id || ownVariants.has(r.variant_id)) && (!r.via_variant_id || ownVariants.has(r.via_variant_id));
      if (okScope) scoped.push(r);
      else note(r.source_media_id, 'target_missing');
    }
    const collapsed = collapseContentDuplicates(scoped);
    const kept = new Set(collapsed.rows.map((r) => r.id));
    for (const r of scoped) if (!kept.has(r.id)) note(r.source_media_id, 'duplicate_content');
    rows = collapsed.rows.map((r) => ({ ...r, is_primary: false }));
  }
  // Never twice: an id already written (this stage ran before), or a picture the product already shows for the same
  // binding — a general row whose picture is shown at all, a bound row whose picture is shown under that binding.
  // A bound row whose picture is shown only under ANOTHER binding is what the original write would have kept
  // (collapseContentDuplicates keeps each binding once; mergeImages dedupes on key and binding): it goes in, as
  // the writer's collapse has it — `content_duplicate` (a representative or a reviewed override keeps its rule) and,
  // for a create, in the slot the picture is already shown at.
  const fresh: ImportImageRow[] = [];
  for (const r of rows) {
    const bound = !!(r.option_value_id || r.variant_id || r.color_id);
    if (existingIds.has(r.id)) note(r.source_media_id, 'already_present');
    else if (existingBindings.has(bindingOf(r)) || (!bound && existingKeys.has(r.r2_key))) note(r.source_media_id, 'duplicate_content');
    else if (existingKeys.has(r.r2_key)) {
      const keeps = r.binding_rule === 'representative' || r.binding_rule === 'reviewed_override';
      fresh.push({
        ...r,
        sort_order: mapping ? r.sort_order : firstSlotOfKey.get(r.r2_key) ?? r.sort_order,
        binding_rule: keeps ? r.binding_rule : 'content_duplicate',
        via_variant_id: keeps ? r.via_variant_id : '',
      });
    } else fresh.push(r);
  }
  // An id the product does not hold but another product does cannot be inserted (ids are per product, §B.8).
  const elsewhere = new Set<string>();
  if (fresh.length) {
    const { results } = await db
      .prepare('SELECT id FROM product_images WHERE id IN (SELECT value FROM json_each(?)) AND product_id <> ?')
      .bind(JSON.stringify(fresh.map((r) => r.id)), productId)
      .all<{ id: string }>();
    for (const x of results ?? []) elsewhere.add(String(x.id));
  }
  // Bytes, decode and the cleanup guard of every new row (§A.4 step 4), one picture at a time: a picture the store
  // gave that will not verify is left out; a storage that does not answer refuses the call (the runner retries).
  const verified: Array<PlannedRow & { wire: Record<string, unknown> }> = [];
  for (const r of fresh) {
    if (elsewhere.has(r.id)) {
      note(r.source_media_id, 'target_missing');
      continue;
    }
    const wire = wireImage(r, alts.get(r.id));
    try {
      await verifyAndNormalizeProductMedia(env, { media: [] } as unknown as ProductDoc, [wire]);
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) throw new OpsRefusal(503, 'IMAGE_STORAGE_FAILED', [item.id]);
      if (e instanceof HttpError) {
        note(r.source_media_id, 'not_stored');
        continue;
      }
      throw e;
    }
    verified.push({ row: r, alt: alts.get(r.id)!, wire });
    note(r.source_media_id, 'attached');
  }

  // ---- the swatches: a value of this product (create) or a mapped option value (merge) that has none yet
  const swatches: Array<{ valueId: string; key: string; width: number | null; height: number | null; sourceUrl: string }> = [];
  const swatchIds = new Set(plan.requests.filter((r) => r.role === 'swatch').map((r) => r.source_media_id));
  const wantedSwatches = payload.swatches.filter((s) => swatchIds.has(s.source_media_id));
  const targets = wantedSwatches.map((s) => (ctx.merge ? (mapping?.values.get(s.value_id)?.optionValueId ?? '') : ownValues.has(s.value_id) ? s.value_id : ''));
  const { results: haveRows } = await db
    .prepare('SELECT option_value_id FROM product_option_value_swatches WHERE option_value_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(targets.filter(Boolean)))
    .all<{ option_value_id: string }>();
  const have = new Set((haveRows ?? []).map((h) => String(h.option_value_id)));
  for (let i = 0; i < wantedSwatches.length; i++) {
    const s = wantedSwatches[i];
    const target = targets[i];
    const key = keyOf(s.source_media_id);
    if (!target) note(s.source_media_id, 'target_missing');
    else if (have.has(target) || swatches.some((x) => x.valueId === target)) note(s.source_media_id, 'already_present');
    else if (!key) note(s.source_media_id, 'not_stored');
    else {
      const head = await importObjectHead(env, key);
      if (head.presence === 'unknown') throw new OpsRefusal(503, 'IMAGE_STORAGE_FAILED', [item.id]);
      if (head.presence !== 'present' || (head.contentType && head.contentType !== 'image/webp')) {
        note(s.source_media_id, 'not_stored');
        continue;
      }
      const m = stored.get(s.source_media_id)!;
      swatches.push({ valueId: target, key, width: m.width, height: m.height, sourceUrl: s.source_url });
      note(s.source_media_id, 'attached');
    }
  }
  for (const [, list] of outcomes) counts[mediumOutcome(list)]++;
  // A planned medium that produced no row at all (its every payload row filtered before a note): target_missing.
  for (const r of plan.requests) if (!outcomes.has(r.source_media_id)) counts.target_missing++;

  const attached: AttachedRows = {
    rows: verified.map((v) => ({ id: v.row.id, r2_key: String(v.wire.r2_key ?? v.row.r2_key) })),
    swatches: swatches.map((s) => ({ option_value_id: s.valueId, r2_key: s.key })),
  };

  // ---- ONE batch: the guard row (fenced on the item, its lease and its staged payload), INSERTs only, the fenced
  //      WRITTEN event, the checkpoint, the guard row removed.
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO ops_guards (id, ok) SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM catalog_import_items i JOIN catalog_import_runs r ON r.id = i.run_id
            WHERE i.id = ? AND i.run_id = ? AND i.processing_state = 'WRITING' AND i.lease_token = ? AND i.lease_token <> ''
              AND i.lease_until > ${NOW_SQL} AND i.payload_sha256 = ? AND r.state IN ('open','running')) THEN 1 ELSE 0 END`
      )
      .bind(IMPORT_GUARD_ID, item.id, run.id, item.lease_token, item.payload_sha256),
  ];
  for (const v of verified) {
    const w = v.wire;
    statements.push(
      db
        .prepare(GALLERY_INSERT)
        .bind(
          v.row.id, productId, String(w.url), v.alt.en, v.row.sort_order, v.row.option_value_id, v.row.color_id, v.row.variant_id,
          (w.width as number | null) ?? null, (w.height as number | null) ?? null, (w.bytes as number | null) ?? null, String(w.content_type ?? 'image/webp'),
          v.alt.ar, v.alt.ckb, String(w.r2_key ?? v.row.r2_key), v.alt.source_url
        )
    );
    const rule = v.row.binding_rule === 'representative' && !v.row.via_variant_id ? 'value' : v.row.binding_rule;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO product_option_source_refs (product_id, kind, source, source_id, levonis_id, source_label, binding_rule, via_variant_id, import_run_id)
           VALUES (?, 'image', 'bambu_us', ?, ?, '', ?, ?, ?)`
        )
        .bind(productId, v.row.source_media_id, v.row.id, rule, rule === 'representative' ? v.row.via_variant_id : '', run.id)
    );
  }
  for (const s of swatches) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, width, height, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(s.valueId, productId, `/files/${s.key}`, s.key, s.width, s.height, s.sourceUrl)
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), 'WRITTEN', 'ok', '', '', ?, ?, ?)`
      )
      .bind(newId('cie'), run.id, item.id, run.id, JSON.stringify({ media_only: true, rows: attached.rows.length, swatches: attached.swatches.length, ...counts }), item.lease_token, run.github_run_id),
    db
      .prepare(
        `UPDATE catalog_import_items
            SET processing_state = 'PUBLISHING', last_completed_stage = 'WRITING', levonis_product_id = ?, slug = ?, stage_attempts = 0, retry_at = '',
                stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.media_retry', json(?)),
                updated_at = ${NOW_SQL}
          WHERE id = ? AND run_id = ? AND lease_token = ?`
      )
      .bind(productId, ctx.slug, JSON.stringify({ counts, ...attached }), item.id, run.id, item.lease_token),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID)
  );
  try {
    await db.batch(statements);
  } catch (e) {
    throw refusalOfBatch(e);
  }
  return { product_id: productId, slug: ctx.slug, counts, ...attached };
}

// ---------------------------------------------------------------- /media-complete

export interface RetryEvidence {
  version: 1;
  live_url: string;
  round: number;
  status: number;
  rows_seen: number;
  swatches_seen: number;
}

const int = (v: unknown, max = 100_000): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/** The attached rows the write's checkpoint recorded (stage_data.media_retry). */
export function attachedOf(item: Pick<ItemRow, 'stage_data'>): AttachedRows {
  const m = stageDataOf(item).media_retry;
  const rec = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  const sw = Array.isArray(rec.swatches) ? rec.swatches : [];
  return {
    rows: rows.flatMap((r) => (r && typeof r === 'object' && typeof (r as Record<string, unknown>).id === 'string' ? [{ id: String((r as Record<string, unknown>).id), r2_key: String((r as Record<string, unknown>).r2_key ?? '') }] : [])),
    swatches: sw.flatMap((r) =>
      r && typeof r === 'object' && typeof (r as Record<string, unknown>).option_value_id === 'string'
        ? [{ option_value_id: String((r as Record<string, unknown>).option_value_id), r2_key: String((r as Record<string, unknown>).r2_key ?? '') }]
        : []
    ),
  };
}

/**
 * POST /items/:sid/media-complete (after holdLease): COMPLETE only when the runner saw every attached picture on the
 * public product and the Worker finds every attached row in D1 and every object in R2. Otherwise nothing moves (the
 * runner purges, waits and asks once more, then blocks VERIFY_FAILED_PERSISTENT).
 */
export async function completeMediaRetry(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  requestUrl: string,
  run: ImportRun,
  item: ItemRow,
  body: Record<string, unknown>
): Promise<{ state: 'COMPLETE' | 'VERIFYING_LIVE'; seq: number | null; d1_checks: Record<string, unknown> }> {
  if (item.processing_state !== 'VERIFYING_LIVE') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  const mark = deltaMarkOf((await env.DB.prepare('SELECT discovery_sources FROM catalog_import_items WHERE id = ?').bind(item.id).first<{ discovery_sources: string }>())?.discovery_sources ?? '');
  if (!mark || mark.kind !== 'media') throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  const liveUrl = liveUrlOf(body.live_url, requestUrl, item.slug);
  if (!liveUrl) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  const e = body.edge_evidence && typeof body.edge_evidence === 'object' ? (body.edge_evidence as Record<string, unknown>) : null;
  const round = int(e?.round, 10);
  const status = int(e?.status, 999);
  const rowsSeen = int(e?.rows_seen);
  const swatchesSeen = int(e?.swatches_seen);
  if (!e || e.version !== 1 || e.live_url !== liveUrl || round === null || status === null || rowsSeen === null || swatchesSeen === null) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  const evidence: RetryEvidence = { version: 1, live_url: liveUrl, round, status, rows_seen: rowsSeen, swatches_seen: swatchesSeen };
  const db = env.DB;
  const attached = attachedOf(item);
  const { results: imageRows } = await db
    .prepare('SELECT id, r2_key FROM product_images WHERE product_id = ? AND id IN (SELECT value FROM json_each(?))')
    .bind(item.levonis_product_id, JSON.stringify(attached.rows.map((r) => r.id)))
    .all<{ id: string; r2_key: string }>();
  const imageKey = new Map((imageRows ?? []).map((r) => [String(r.id), String(r.r2_key)]));
  const { results: swatchRows } = await db
    .prepare('SELECT option_value_id, r2_key FROM product_option_value_swatches WHERE product_id = ? AND option_value_id IN (SELECT value FROM json_each(?))')
    .bind(item.levonis_product_id, JSON.stringify(attached.swatches.map((s) => s.option_value_id)))
    .all<{ option_value_id: string; r2_key: string }>();
  const swatchKey = new Map((swatchRows ?? []).map((r) => [String(r.option_value_id), String(r.r2_key)]));
  const rowsPresent = attached.rows.filter((r) => imageKey.get(r.id) === r.r2_key).length;
  const swatchesPresent = attached.swatches.filter((s) => swatchKey.get(s.option_value_id) === s.r2_key).length;
  let objects = 0;
  const keys = [...new Set([...attached.rows.map((r) => r.r2_key), ...attached.swatches.map((s) => s.r2_key)])];
  for (const key of keys) {
    const p = (await importObjectHead(env, key)).presence;
    if (p === 'unknown') throw new OpsRefusal(503, 'IMPORT_STORAGE_UNAVAILABLE', [item.id]);
    if (p === 'present') objects++;
  }
  const d1Ok = rowsPresent === attached.rows.length && swatchesPresent === attached.swatches.length && objects === keys.length;
  // Nothing attached: nothing to see (a product that is not public included); else the public product shows it all.
  const nothing = attached.rows.length + attached.swatches.length === 0;
  const edgeOk = rowsSeen === attached.rows.length && swatchesSeen === attached.swatches.length && (nothing || status === 200);
  const d1Checks = {
    ok: d1Ok && edgeOk,
    media_retry: { rows: attached.rows.length, rows_present: rowsPresent, swatches: attached.swatches.length, swatches_present: swatchesPresent, objects: keys.length, objects_present: objects },
    agreement: { edge_ok: edgeOk, counts_agree: d1Ok },
  };
  const [fenceIn, fenceOut] = fence(db, `EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND processing_state = 'VERIFYING_LIVE' AND lease_token = ?)`, [item.id, item.lease_token]);
  const event = (stage: string, outcome: string, code: string, detail: Record<string, unknown>) =>
    db
      .prepare(
        `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), ?, ?, ?, '', ?, ?, ?)`
      )
      .bind(newId('cie'), run.id, item.id, run.id, stage, outcome, code, JSON.stringify(detail), item.lease_token, run.github_run_id);
  const batch = async (statements: D1PreparedStatement[]) => {
    try {
      await db.batch(statements);
    } catch (err) {
      if (isFenceMiss(err)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      throw refusalOfBatch(err);
    }
  };
  if (!d1Checks.ok) {
    await batch([
      fenceIn,
      db
        .prepare(`UPDATE catalog_import_items SET d1_checks = ?, edge_evidence = ?, updated_at = ${NOW_SQL} WHERE id = ? AND lease_token = ? AND processing_state = 'VERIFYING_LIVE'`)
        .bind(JSON.stringify(d1Checks), JSON.stringify(evidence), item.id, item.lease_token),
      event('VERIFYING_LIVE', 'info', 'IMPORT_VERIFY_DISAGREES', { round, rows: attached.rows.length, rows_seen: rowsSeen }),
      fenceOut,
    ]);
    return { state: 'VERIFYING_LIVE', seq: null, d1_checks: d1Checks };
  }
  await batch([
    fenceIn,
    db
      .prepare(
        `UPDATE catalog_import_items
            SET processing_state = 'COMPLETE', last_completed_stage = 'VERIFYING_LIVE', live_url = ?, verified_at = ${NOW_SQL},
                completed_at = ${NOW_SQL}, d1_checks = ?, edge_evidence = ?, stage_attempts = 0, retry_at = '', updated_at = ${NOW_SQL}
          WHERE id = ? AND lease_token = ? AND processing_state = 'VERIFYING_LIVE'`
      )
      .bind(liveUrl, JSON.stringify(d1Checks), JSON.stringify(evidence), item.id, item.lease_token),
    // Fenced by trg_cie_lease_fence (stage COMPLETED): a stale executor's COMPLETE aborts whole.
    event('COMPLETED', 'ok', '', { round, media_only: true, rows: attached.rows.length, swatches: attached.swatches.length }),
    fenceOut,
  ]);
  const seq = await db
    .prepare("SELECT seq FROM catalog_import_events WHERE run_id = ? AND item_id = ? AND stage = 'COMPLETED' ORDER BY seq DESC LIMIT 1")
    .bind(run.id, item.id)
    .first<{ seq: number }>();
  return { state: 'COMPLETE', seq: seq?.seq ?? null, d1_checks: d1Checks };
}
