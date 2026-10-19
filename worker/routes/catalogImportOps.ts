/**
 * THE CATALOGUE IMPORT'S OPS ENDPOINT — `/api/ops/catalog-import/*` (Bambu
 * import spec §A.1, §A.3, §A.7, §A.9, §A.10, §B.5, §I.1; DECISIONS row 241).
 *
 * The runner (scripts/bambu-import/run.ts, workflow 60) is its only caller, through
 * a per-job bearer token whose SHA-256 sits on the open run row
 * (worker/lib/catalogImport/auth.ts `requireImportToken`). With no open run —
 * every day but the import's — every path answers the same 404 as a path that
 * does not exist.
 *
 *   POST /hello                         protocol, migrations, the reviewed files' SHA-256s, the run
 *   POST /manifest                      ≤ 100 rows, only as the bundled manifest has them
 *   POST /items/:sid/lease              take or renew the item's lease (15 min)
 *   POST /items/:sid/event              a transition the runner performed (§B.5)
 *   POST /items/:sid/stage              preview: allow-list, reviewed scope, taxonomy, plan size
 *   POST /items/:sid/media              ≤ 4 media, store.bblcdn.com only, 45 s
 *   POST /items/:sid/write              ONE guarded batch (worker/lib/catalogImport/writer.ts)
 *   POST /items/:sid/publish-finish     republish if hidden on block; recompute; purge; VERIFYING_LIVE
 *   GET  /items/:sid/readback           the write's verifyApplied + live ownership checks (run here, against the plan the
 *                                       write committed, when the write could not record it; 503 while hidden on a block)
 *   POST /items/:sid/complete           runner evidence + the Worker's own D1 recompute
 *   POST /items/:sid/withdraw           BLOCKED SOURCE_WITHDRAWN → WITHDRAWN_AT_SOURCE
 *   POST /run/prepare-taxonomy          insert-only nodes, brand, synonyms
 *   POST /run/protect-snapshot          §E.4 fingerprints, before | after
 *   POST /run/finish                    closed | partial (the BLOCKED, WITHDRAWN and still-held items); the token cleared
 *   POST /run/translations              one committed translations part, proved against the bundled index and row by
 *                                       row, written in one batch; its products purged (I18N-DESIGN §A.4)
 *   GET  /run/status                    counts by state, current, next, the held items, last verified URL, §H.3 progress
 *
 * The delta run (workflow 60 mode=delta; spec §O, worker/lib/catalogImport/delta.ts and mediaRetry.ts):
 *
 *   POST /delta/plan                    the closed run and the sitemap's handles → the new handles, the media items
 *   POST /delta/manifest                ≤ 100 delta rows (new products, media items), each checked against D1
 *   GET  /delta/rows                    the run's delta items (the runner's view of rows the bundle does not hold)
 *   POST /items/:sid/media-plan         a media item: its rebuilt payload proved, the failed media still shown planned
 *   POST /items/:sid/media-attach       a media item: ONE guarded, INSERT-only batch of the pictures now stored
 *   POST /items/:sid/media-complete     a media item: the runner's public read + the Worker's recompute → COMPLETE
 *
 * A new product of a delta run goes through /stage, /write and /complete like any item, its manifest row the one the
 * Worker registered (the bundle extended by delta.ts runBundle), behind the §E.1 candidate gate; a media item never
 * does: those three refuse it.
 *
 * Every answer is `private, no-store`; every error `{code, message}` from the
 * fixed catalogue; no input, SQL text or stack is ever echoed.
 */
import { Hono, type Context } from 'hono';
import { HttpError } from '../lib/http';
import { ImportPayloadRefused } from '@levonis/catalog/bambuImport/payload';
import {
  opsError,
  opsInvocation,
  OpsRefusal,
  readBody,
  requireImportToken,
  SOURCE_ID,
  IMPORT_PROTOCOL,
  OPS_MESSAGES,
  type OpsContext,
  type OpsEnv,
} from '../lib/catalogImport/auth';
import { currentReviewedBundle } from '../lib/catalogImport/bundle';
import type { ReviewedBundle } from '../lib/catalogImport/reviewed';
import {
  applyEvent,
  eventBodyOf,
  finishPublishing,
  holdLease,
  itemBySource,
  leaseItem,
  recordStaged,
  STAGE_STATES,
  type ItemRow,
} from '../lib/catalogImport/items';
import { ingestImportMedia, mediaRequestsOf } from '../lib/catalogImport/media';
import { affectedProducts, recomputeAndPurge } from '../lib/catalogImport/purge';
import { completeItem } from '../lib/catalogImport/complete';
import { acceptManifest, finishRun, heldItems, helloRecord, migrationsPresent, prepareTaxonomy, protectSnapshot, readbackItem, withdrawItem, WORKER_BUILD } from '../lib/catalogImport/runOps';
import { currentAndNext, lastVerifiedUrl, measuredRate, runProgress, stateCounts } from '../lib/catalogImport/report';
import { ImportWriteRefused, planImportWrite, runImportWrite, type DocumentCheck, type ImportWriteContext } from '../lib/catalogImport/writer';
import { republishAfterBlock } from '../lib/catalogImport/unpublish';
import { loadTranslationPart, PART_NAME, purgeTranslatedProducts } from '../lib/catalogImport/translations';
import { EXPECTED_MIGRATION } from '../lib/schemaVersion';
import { acceptDeltaRows, deltaMatchGate, deltaPlan, deltaRowsView, itemMark, runBundle } from '../lib/catalogImport/delta';
import { assertRetryRequests, attachRetriedMedia, completeMediaRetry, planMediaRetry, retryContext } from '../lib/catalogImport/mediaRetry';

export const catalogImportOpsRoutes = new Hono<OpsEnv>();

catalogImportOpsRoutes.use('*', opsInvocation);
catalogImportOpsRoutes.use('*', requireImportToken);

// ---------------------------------------------------------------- answers

/** A D1 overload or a busy database: transient for the runner (5xx). */
const BUSY = /SQLITE_BUSY|database is locked|D1_ERROR.*(overload|too many|timeout)|Network connection lost|storage operation exceeded/i;

/** Every failure as `{code, message}` from the catalogue — never the error's own text. */
function answerError(c: OpsContext, e: unknown): Response {
  if (e instanceof OpsRefusal) return opsError(c, e.status, e.code, e.ids);
  if (e instanceof ImportPayloadRefused) return opsError(c, 400, 'IMPORT_PAYLOAD_KEY_REFUSED');
  if (e instanceof ImportWriteRefused) {
    // A planner code outside the catalogue answers its blocker (PAYLOAD_REFUSED for a structure the app refuses).
    const code = OPS_MESSAGES[e.code] || /^IMAGE_/.test(e.code) ? e.code : e.blocker || 'PAYLOAD_REFUSED';
    return opsError(c, e.status, code);
  }
  if (e instanceof HttpError && e.status === 429) return opsError(c, 429, 'RATE_LIMITED', [], { 'Retry-After': '60' });
  const text = e instanceof Error ? e.message : String(e);
  if (BUSY.test(text)) return opsError(c, 503, 'D1_OVERLOADED');
  console.error('catalog_import_ops_failed', JSON.stringify({ code: 'IMPORT_INTERNAL', name: e instanceof Error ? e.name : typeof e }));
  return opsError(c, 500, 'IMPORT_INTERNAL');
}

type Handler = (c: OpsContext) => Promise<Response>;
const handle = (fn: Handler) => async (c: OpsContext) => {
  try {
    return await fn(c);
  } catch (e) {
    return answerError(c, e);
  }
};

function bundleOrRefuse(): ReviewedBundle {
  const state = currentReviewedBundle();
  if (state.ok) return state.bundle;
  throw new OpsRefusal(state.code === 'REVIEWED_BUNDLE_UNAVAILABLE' ? 503 : 409, state.code, state.file ? [state.file] : []);
}

/** The bundle this run's item calls read: the reviewed one, plus the manifest rows of a delta run's new products. */
const runBundleOf = (c: OpsContext): Promise<ReviewedBundle> => runBundle(c.env.DB, c.get('importRun').id, bundleOrRefuse());

/** A media item of a delta run writes no product: /stage, /write and /complete refuse it. */
async function refuseMediaItem(c: OpsContext, item: ItemRow): Promise<'new' | null> {
  const mark = await itemMark(c.env.DB, item.id);
  if (mark?.kind === 'media') throw new OpsRefusal(409, 'IMPORT_DELTA_REFUSED', [item.id]);
  return mark?.kind === 'new' ? 'new' : null;
}

const sidOf = (c: OpsContext): string => {
  const sid = c.req.param('sid') ?? '';
  if (!SOURCE_ID.test(sid)) throw new OpsRefusal(404, 'IMPORT_ITEM_NOT_FOUND');
  return sid;
};

const mediaEnv = (c: OpsContext) => ({ BUCKET: c.env.BUCKET, R2_PUBLIC: c.env.R2_PUBLIC, R2_PRIVATE: c.env.R2_PRIVATE, IMAGES: c.env.IMAGES });

const writeContext = (c: OpsContext): ImportWriteContext => ({ db: c.env.DB, counter: c.get('opsCounter'), media: mediaEnv(c) });

/** The runner's document checks (§A.3 /stage and /write), validated; a malformed entry refuses the call. */
function documentChecksOf(raw: unknown): DocumentCheck[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 400) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  return raw.map((r) => {
    const k = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    const ok =
      !!k &&
      typeof k.document_id === 'string' && k.document_id.length <= 80 &&
      typeof k.check_status === 'number' && Number.isInteger(k.check_status) && k.check_status >= 0 && k.check_status < 1000 &&
      typeof k.content_type === 'string' && k.content_type.length <= 120 &&
      (k.byte_size === null || (typeof k.byte_size === 'number' && Number.isInteger(k.byte_size) && k.byte_size >= 0)) &&
      typeof k.content_sha256 === 'string' && (k.content_sha256 === '' || /^[0-9a-f]{64}$/.test(k.content_sha256)) &&
      typeof k.checked_at === 'string' && k.checked_at.length <= 40 &&
      typeof k.tracker_source === 'string' && (k.tracker_source === '' || (/^https:\/\//.test(k.tracker_source) && k.tracker_source.length <= 500));
    if (!ok) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    return {
      document_id: k!.document_id as string,
      check_status: k!.check_status as number,
      content_type: k!.content_type as string,
      byte_size: k!.byte_size as number | null,
      content_sha256: k!.content_sha256 as string,
      checked_at: k!.checked_at as string,
      tracker_source: k!.tracker_source as string,
    };
  });
}

/** Recompute and purge the product and the products whose relations name it. Never fails the call. */
async function refreshProduct(c: OpsContext, item: Pick<ItemRow, 'levonis_product_id'>): Promise<void> {
  if (!item.levonis_product_id) return;
  try {
    const ids = await affectedProducts(c.env.DB, item.levonis_product_id);
    await recomputeAndPurge(c.env, c.req.url, ids);
  } catch (e) {
    console.error('catalog_import_refresh_failed', JSON.stringify({ code: 'IMPORT_PURGE_FAILED', name: e instanceof Error ? e.name : typeof e }));
  }
}

// ---------------------------------------------------------------- the run

catalogImportOpsRoutes.post(
  '/hello',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const state = currentReviewedBundle();
    const { cursor, delta } = await helloRecord(c.env.DB, run, body, state.digest);
    const migrations = await migrationsPresent(c.env.DB);
    return c.json({
      protocol: IMPORT_PROTOCOL,
      expected_migration: EXPECTED_MIGRATION,
      migrations_present: migrations,
      reviewed: state.sha256,
      reviewed_bundle_sha256: state.digest,
      reviewed_bundle_valid: state.ok,
      run: { id: run.id, state: run.state, cursor, delta },
      worker_build: WORKER_BUILD,
    });
  })
);

catalogImportOpsRoutes.post(
  '/manifest',
  handle(async (c) => {
    const body = await readBody(c);
    return c.json(await acceptManifest(c.env.DB, c.get('importRun'), bundleOrRefuse(), body));
  })
);

catalogImportOpsRoutes.post(
  '/run/prepare-taxonomy',
  handle(async (c) => {
    await readBody(c);
    return c.json(await prepareTaxonomy(c.env.DB, bundleOrRefuse()));
  })
);

catalogImportOpsRoutes.post(
  '/run/protect-snapshot',
  handle(async (c) => c.json(await protectSnapshot(c.env.DB, c.get('importRun'), await readBody(c))))
);

catalogImportOpsRoutes.post(
  '/run/finish',
  handle(async (c) => {
    await readBody(c);
    return c.json(await finishRun(c.env.DB, c.get('importRun'), bundleOrRefuse()));
  })
);

/**
 * One committed part of the translation memory (docs/bambu-import/I18N-DESIGN.md §A.4): `{ part, text }`, the text
 * the file's exact bytes. Proved against the BUNDLED index (its SHA-256) and row by row, written in one batch, then
 * the products whose shown text changed are purged. Counts only in the answer, never text.
 */
catalogImportOpsRoutes.post(
  '/run/translations',
  handle(async (c) => {
    const body = await readBody(c);
    const part = typeof body.part === 'string' ? body.part : '';
    const text = typeof body.text === 'string' ? body.text : null;
    if (!PART_NAME.test(part) || part.length > 40 || text === null) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    const { purge_targets: targets, ...r } = await loadTranslationPart(c.env.DB, c.get('importRun'), part, text, c.get('opsCounter'));
    const purged = r.skipped ? { products: 0, paths: 0, keys: 0 } : await purgeTranslatedProducts(c.env, c.req.url, targets);
    return c.json({ ...r, purged_products: purged.products });
  })
);

catalogImportOpsRoutes.get(
  '/run/status',
  handle(async (c) => {
    const run = c.get('importRun');
    const db = c.env.DB;
    const [counts, { current, next }, url, rate, progress] = [
      await stateCounts(db, run.id),
      await currentAndNext(db, run.id),
      await lastVerifiedUrl(db, run.id),
      await measuredRate(db, run.id),
      await runProgress(db, run.id),
    ];
    // The queued items the reviewed manifest holds (§K.2 step 13): /run/finish closes the run partial around them.
    const bundle = currentReviewedBundle();
    const held = bundle.ok ? await heldItems(db, run.id, bundle.bundle) : [];
    return c.json({ run: { id: run.id, state: run.state }, counts, current, next, held, last_verified_url: url, ...progress, rate });
  })
);

// ---------------------------------------------------------------- one item

catalogImportOpsRoutes.post(
  '/items/:sid/lease',
  handle(async (c) => {
    const body = await readBody(c);
    const token = typeof body.lease_token === 'string' ? body.lease_token : '';
    return c.json(await leaseItem(c.env.DB, c.get('importRun'), sidOf(c), token));
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/event',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    const answer = await applyEvent(c.env.DB, run, item, eventBodyOf(body));
    // A product hidden on block, or put back on resume: its pages change (§A.10 "then a purge").
    if (answer.unpublished || answer.republished) await refreshProduct(c, item);
    return c.json({ state: answer.state, last_completed_stage: answer.last_completed_stage, stage_attempts: answer.stage_attempts, seq: answer.seq });
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/stage',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const bundle = await runBundleOf(c);
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    if (!STAGE_STATES.has(item.processing_state)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
    if ((await refuseMediaItem(c, item)) === 'new') await deltaMatchGate(c.env.DB, bundle, item.id, body.payload);
    const plan = await planImportWrite(writeContext(c), {
      mode: 'stage',
      payload: body.payload,
      bundle,
      runId: run.id,
      itemId: item.id,
      leaseToken: item.lease_token,
      documentChecks: documentChecksOf(body.document_checks),
    });
    await recordStaged(c.env.DB, item, plan.payloadSha256, plan.estimate.total);
    return c.json({ payload_sha256: plan.payloadSha256, invocation_estimate: plan.estimate.total, conflicts: plan.conflicts, warnings: plan.warnings });
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/media',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    const requests = mediaRequestsOf(body.media);
    // A media item of a delta run fetches only the failed media of the closed run it retries (mediaRetry.ts).
    if ((await itemMark(c.env.DB, item.id))?.kind === 'media') assertRetryRequests(await retryContext(c.env.DB, item), item, requests);
    const media = await ingestImportMedia({ ...mediaEnv(c), DB: c.env.DB, CATALOG_IMPORT_MEDIA_ORIGIN: c.env.CATALOG_IMPORT_MEDIA_ORIGIN }, c.req.url, run, item, requests);
    return c.json({ media });
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/write',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const bundle = await runBundleOf(c);
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    if (typeof body.payload_sha256 !== 'string' || body.payload_sha256 !== item.payload_sha256) throw new OpsRefusal(409, 'IMPORT_NOT_STAGED', [item.id]);
    if ((await refuseMediaItem(c, item)) === 'new') await deltaMatchGate(c.env.DB, bundle, item.id, body.payload);
    const ctx = writeContext(c);
    const plan = await planImportWrite(ctx, {
      mode: 'write',
      payload: body.payload,
      bundle,
      runId: run.id,
      itemId: item.id,
      leaseToken: item.lease_token,
      documentChecks: documentChecksOf(body.document_checks),
    });
    const r = await runImportWrite(ctx, plan);
    return c.json({ ...r, match_kind: r.created ? 'created' : 'merged', invocation_estimate: plan.estimate.total });
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/publish-finish',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    if (item.processing_state !== 'PUBLISHING' && item.processing_state !== 'VERIFYING_LIVE') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
    // §A.10: a product the import hid on a block is active again before anything is verified.
    if (Number(item.unpublished_on_block) === 1 && item.levonis_product_id) {
      await republishAfterBlock(c.env.DB, { runId: run.id, itemId: item.id, leaseToken: item.lease_token, productId: item.levonis_product_id });
    }
    await refreshProduct(c, item);
    const state = await finishPublishing(c.env.DB, run, item);
    return c.json({ state });
  })
);

catalogImportOpsRoutes.get(
  '/items/:sid/readback',
  handle(async (c) => {
    const item = await itemBySource(c.env.DB, c.get('importRun').id, sidOf(c));
    return c.json(await readbackItem({ ...mediaEnv(c), DB: c.env.DB }, item));
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/complete',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const bundle = await runBundleOf(c);
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    await refuseMediaItem(c, item);
    return c.json(await completeItem({ ...mediaEnv(c), DB: c.env.DB }, c.req.url, run, item, bundle, body));
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/withdraw',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const item = await itemBySource(c.env.DB, run.id, sidOf(c));
    return c.json(await withdrawItem(c.env.DB, run, item, body));
  })
);

// ---------------------------------------------------------------- the delta run (§O)

catalogImportOpsRoutes.post(
  '/delta/plan',
  handle(async (c) => {
    const body = await readBody(c);
    return c.json(await deltaPlan(c.env.DB, c.get('importRun'), body, bundleOrRefuse()));
  })
);

catalogImportOpsRoutes.post(
  '/delta/manifest',
  handle(async (c) => {
    const body = await readBody(c);
    return c.json(await acceptDeltaRows(c.env.DB, c.get('importRun'), bundleOrRefuse(), body));
  })
);

catalogImportOpsRoutes.get(
  '/delta/rows',
  handle(async (c) => c.json({ rows: await deltaRowsView(c.env.DB, c.get('importRun').id, bundleOrRefuse()) }))
);

catalogImportOpsRoutes.post(
  '/items/:sid/media-plan',
  handle(async (c) => {
    const body = await readBody(c);
    const item = await holdLease(c.env.DB, c.get('importRun'), sidOf(c), body.lease_token);
    return c.json(await planMediaRetry(c.env.DB, item, body.payload));
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/media-attach',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const bundle = bundleOrRefuse();
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    return c.json(await attachRetriedMedia({ ...mediaEnv(c), DB: c.env.DB }, run, item, bundle, body));
  })
);

catalogImportOpsRoutes.post(
  '/items/:sid/media-complete',
  handle(async (c) => {
    const body = await readBody(c);
    const run = c.get('importRun');
    const item = await holdLease(c.env.DB, run, sidOf(c), body.lease_token);
    return c.json(await completeMediaRetry({ ...mediaEnv(c), DB: c.env.DB }, c.req.url, run, item, body));
  })
);

// Anything else under the prefix, with a valid token: the same uniform 404 as without one.
catalogImportOpsRoutes.all('*', (c: Context) => c.json({ error: 'Not found' }, 404));
