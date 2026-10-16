/**
 * THE OWNER'S VIEW OF THE CATALOGUE IMPORT — `/api/admin/catalog-import/*`
 * (Bambu import spec §H.1, §H.3; DECISIONS row 241).
 *
 * OWNER ONLY (`requireOwner`, worker/lib/costAccess.ts) and READ-ONLY: GET
 * routes only. There is no skip, no "advance cursor", no retry button: an item
 * moves only through the runner's ops door, and a blocked item is resumed by
 * workflow 60 (the resume instruction says so in ar / en / ckb).
 *
 *   GET /runs                       every run with its counts by state
 *   GET /runs/:id                   the run, its §H.3 progress, the current item, the rate (an estimate)
 *   GET /runs/:id/items             paged 50, `state=` and `q=` (handle or source id), `cursor=`
 *   GET /items/:id                  one item: events, media, conflicts, missing info, d1_checks next to edge_evidence
 *   GET /runs/:id/report.json       §H.3, streamed from D1 (counts and public URLs only)
 *   GET /runs/:id/report.csv        the same table as CSV
 *
 * Nothing here returns a protected digest, a lease token, a token hash, a cost,
 * a price or a source URL. A database without migration 0195 answers empty
 * lists and 404s (the deploy-ahead rule), never a 500.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireOwner } from '../lib/costAccess';
import { notFound } from '../lib/http';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { currentAndNext, csvCell, ITEM_REPORT_COLUMNS, itemReportRows, lastVerifiedUrl, measuredRate, runProgress, stageTimings, stateCounts } from '../lib/catalogImport/report';
import { stageDataOf } from '../lib/catalogImport/items';

export const adminCatalogImportRoutes = new Hono<AppContext>();
adminCatalogImportRoutes.use('*', requireOwner);

const PAGE = 50;
const RUN_ID = /^cir_[0-9a-f]{24}$/;
const STATES = new Set(['DISCOVERED', 'EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE', 'COMPLETE', 'RETRYING', 'BLOCKED', 'WITHDRAWN_AT_SOURCE']);

const missingTable = (e: unknown) => /no such table:?\s*catalog_import_/i.test(e instanceof Error ? e.message : String(e));

/** The run columns the owner sees (never the token hash or its expiry). */
const RUN_COLUMNS = 'id, source, state, github_run_id, manifest_total, reviewed_bundle_sha256, code_commit, started_at, closed_at';

const parseJson = (s: unknown): unknown => {
  try {
    return JSON.parse(String(s ?? '{}'));
  } catch {
    return {};
  }
};

adminCatalogImportRoutes.get('/runs', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`SELECT ${RUN_COLUMNS} FROM catalog_import_runs ORDER BY started_at DESC LIMIT 50`).all<Record<string, unknown>>();
    const runs = [];
    for (const r of results ?? []) runs.push({ ...r, counts: await stateCounts(c.env.DB, String(r.id)) });
    return c.json({ runs });
  } catch (e) {
    if (missingTable(e)) return c.json({ runs: [] });
    throw e;
  }
});

async function runOr404(db: D1Database, id: string): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(id)) throw notFound('Run not found');
  try {
    const run = await db.prepare(`SELECT ${RUN_COLUMNS} FROM catalog_import_runs WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (!run) throw notFound('Run not found');
    return run;
  } catch (e) {
    if (missingTable(e)) throw notFound('Run not found');
    throw e;
  }
}

adminCatalogImportRoutes.get('/runs/:id', async (c) => {
  const run = await runOr404(c.env.DB, c.req.param('id'));
  const id = String(run.id);
  const { current, next } = await currentAndNext(c.env.DB, id);
  let currentDetail: Record<string, unknown> | null = null;
  if (current) {
    const row = await c.env.DB
      .prepare(
        `SELECT i.processing_state AS state, i.last_completed_stage, i.updated_at AS last_checkpoint_at, i.blocker_code, i.resume_instruction, i.stage_data,
                (SELECT COUNT(*) FROM catalog_import_media m WHERE m.run_id = i.run_id AND m.source_product_id = i.source_product_id AND m.status = 'stored') AS media_stored
           FROM catalog_import_items i WHERE i.run_id = ? AND i.source_product_id = ?`
      )
      .bind(id, current.source_product_id)
      .first<Record<string, unknown>>();
    if (row) {
      const written = (stageDataOf({ stage_data: String(row.stage_data ?? '{}') }).written ?? {}) as Record<string, unknown>;
      currentDetail = {
        ...current,
        last_checkpoint_at: row.last_checkpoint_at,
        blocker_code: row.blocker_code,
        resume_instruction: row.resume_instruction,
        media_stored: Number(row.media_stored ?? 0),
        option_values: Number(written.values ?? 0),
      };
    }
  }
  return c.json({
    run: { ...run, counts: await stateCounts(c.env.DB, id) },
    progress: await runProgress(c.env.DB, id),
    current: currentDetail,
    next,
    last_verified_url: await lastVerifiedUrl(c.env.DB, id),
    rate: { ...(await measuredRate(c.env.DB, id)), stages: await stageTimings(c.env.DB, id), estimate: true },
  });
});

adminCatalogImportRoutes.get('/runs/:id/items', async (c) => {
  const run = await runOr404(c.env.DB, c.req.param('id'));
  const state = c.req.query('state') ?? '';
  const q = (c.req.query('q') ?? '').trim();
  const cursor = Number(c.req.query('cursor') ?? '0');
  const where = ['run_id = ?', 'queue_position > ?'];
  const args: unknown[] = [run.id, Number.isInteger(cursor) && cursor > 0 ? cursor : 0];
  if (state && STATES.has(state)) {
    where.push('processing_state = ?');
    args.push(state);
  }
  if (q) {
    where.push(`(${sqlLikeClause(['handle', 'source_product_id'])})`);
    args.push(likePattern(q));
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, queue_position, source_product_id, handle, processing_state AS state, last_completed_stage, match_kind, attempts, stage_attempts,
              blocker_code, updated_at
         FROM catalog_import_items WHERE ${where.join(' AND ')} ORDER BY queue_position LIMIT ${PAGE + 1}`
    )
    .bind(...args)
    .all<Record<string, unknown>>();
  const rows = (results ?? []).slice(0, PAGE);
  const more = (results ?? []).length > PAGE;
  return c.json({ items: rows, next_cursor: more ? Number(rows[rows.length - 1]?.queue_position ?? 0) : null });
});

adminCatalogImportRoutes.get('/items/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^cii_[0-9a-z_]{4,80}$/i.test(id)) throw notFound('Item not found');
  let item: Record<string, unknown> | null = null;
  try {
    item = await c.env.DB
      .prepare(
        `SELECT i.id, i.run_id, i.queue_position, i.source_product_id, i.handle, i.processing_state AS state, i.last_completed_stage, i.attempts,
                i.stage_attempts, i.retry_at, i.last_error_code, i.blocker_code, i.resume_instruction, i.stage_data, i.match_kind,
                i.levonis_product_id, CASE WHEN p.status = 'active' THEN i.slug ELSE '' END AS slug,
                CASE WHEN p.status = 'active' THEN i.live_url ELSE '' END AS live_url, i.unpublished_on_block, i.quality, i.d1_checks,
                i.edge_evidence, i.verified_at, i.completed_at, i.updated_at
           FROM catalog_import_items i LEFT JOIN products p ON p.id = i.levonis_product_id WHERE i.id = ?`
      )
      .bind(id)
      .first<Record<string, unknown>>();
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  if (!item) throw notFound('Item not found');
  const db = c.env.DB;
  const { results: events } = await db
    .prepare('SELECT seq, stage, outcome, code, detail, at FROM catalog_import_events WHERE item_id = ? ORDER BY seq LIMIT 500')
    .bind(id)
    .all<Record<string, unknown>>();
  const { results: media } = await db
    .prepare('SELECT source_media_id, role, status, r2_key, width, height, error_code, attempts FROM catalog_import_media WHERE run_id = ? AND source_product_id = ? ORDER BY role, source_media_id')
    .bind(item.run_id, item.source_product_id)
    .all<Record<string, unknown>>();
  const { results: conflicts } = await db
    .prepare('SELECT kind, field, resolved, at FROM catalog_import_conflicts WHERE item_id = ? ORDER BY at LIMIT 500')
    .bind(id)
    .all<Record<string, unknown>>();
  const { results: missing } = item.levonis_product_id
    ? await db
        .prepare("SELECT status, missing_reason AS reason, COUNT(*) AS n FROM product_spec_values WHERE product_id = ? AND status IN ('not_found','not_published','unknown') GROUP BY status, missing_reason")
        .bind(item.levonis_product_id)
        .all<Record<string, unknown>>()
    : { results: [] as Array<Record<string, unknown>> };
  const { stage_data, d1_checks, edge_evidence, quality, ...rest } = item;
  return c.json({
    item: {
      ...rest,
      stage_data: stageDataOf({ stage_data: String(stage_data ?? '{}') }),
      quality: parseJson(quality),
      d1_checks: parseJson(d1_checks),
      edge_evidence: parseJson(edge_evidence),
    },
    events: (events ?? []).map((e) => ({ ...e, detail: parseJson(e.detail) })),
    media: media ?? [],
    conflicts: conflicts ?? [],
    missing_info: missing ?? [],
  });
});

adminCatalogImportRoutes.get('/runs/:id/report.json', async (c) => {
  const run = await runOr404(c.env.DB, c.req.param('id'));
  const db = c.env.DB;
  const id = String(run.id);
  const progress = await runProgress(db, id);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(`{"run":${JSON.stringify({ ...run, counts: await stateCounts(db, id) })},"progress":${JSON.stringify(progress)},"items":[`));
      let after = 0;
      let first = true;
      for (;;) {
        const rows = await itemReportRows(db, id, after, 100);
        for (const r of rows) {
          controller.enqueue(enc.encode(`${first ? '' : ','}${JSON.stringify(r)}`));
          first = false;
        }
        if (rows.length < 100) break;
        after = Number(rows[rows.length - 1].queue_position);
      }
      controller.enqueue(enc.encode(']}'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${id}-report.json"` },
  });
});

adminCatalogImportRoutes.get('/runs/:id/report.csv', async (c) => {
  const run = await runOr404(c.env.DB, c.req.param('id'));
  const db = c.env.DB;
  const id = String(run.id);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(`${ITEM_REPORT_COLUMNS.join(',')}\n`));
      let after = 0;
      for (;;) {
        const rows = await itemReportRows(db, id, after, 100);
        for (const r of rows) controller.enqueue(enc.encode(`${ITEM_REPORT_COLUMNS.map((k) => csvCell(r[k])).join(',')}\n`));
        if (rows.length < 100) break;
        after = Number(rows[rows.length - 1].queue_position);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${id}-report.csv"` },
  });
});
