/**
 * THE RUN'S PROGRESS AND ITS COVERAGE REPORT, FROM D1 ONLY (Bambu import spec
 * §H.1, §H.3; the brief's §15).
 *
 * Counts and public URLs only: no price, cost, stock fact, no conflict detail,
 * no source URL, no protected digest, no name or slug of a product that is not
 * active. `runProgress` feeds `/run/status` (the runner's job summary after
 * every product), the owner's dashboard and `report.json`; `itemReportRows`
 * is the per-item table of `report.json` / `report.csv`, streamed in pages.
 */
import { firstFrameMediaCount } from './media';

export interface ItemRef {
  source_product_id: string;
  handle: string;
  queue_position: number;
  state: string;
  last_completed_stage: string;
}

const REF_COLUMNS = 'source_product_id, handle, queue_position, processing_state AS state, last_completed_stage';

/** The item in flight (one at most, ux_cii_inflight) and the next one of the queue. */
export async function currentAndNext(db: D1Database, runId: string): Promise<{ current: ItemRef | null; next: ItemRef | null }> {
  const current = await db
    .prepare(`SELECT ${REF_COLUMNS} FROM catalog_import_items WHERE run_id = ? AND processing_state NOT IN ('DISCOVERED','COMPLETE','WITHDRAWN_AT_SOURCE') ORDER BY queue_position LIMIT 1`)
    .bind(runId)
    .first<ItemRef>();
  const next = await db
    .prepare(`SELECT ${REF_COLUMNS} FROM catalog_import_items WHERE run_id = ? AND processing_state = 'DISCOVERED' ORDER BY queue_position LIMIT 1`)
    .bind(runId)
    .first<ItemRef>();
  const ref = (r: ItemRef | null) => (r ? { ...r, queue_position: Number(r.queue_position) } : null);
  return { current: ref(current), next: ref(next) };
}

export async function stateCounts(db: D1Database, runId: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT processing_state AS s, COUNT(*) AS n FROM catalog_import_items WHERE run_id = ? GROUP BY processing_state')
    .bind(runId)
    .all<{ s: string; n: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.s, Number(r.n)]));
}

/** The §H.3 progress fields (the brief's §15): D1 aggregates, counts only. */
export async function runProgress(db: D1Database, runId: string): Promise<Record<string, unknown>> {
  const counts = await stateCounts(db, runId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const n = (s: string) => counts[s] ?? 0;
  const w = (path: string) => `COALESCE(SUM(CASE WHEN json_valid(stage_data) THEN json_extract(stage_data, '$.written.${path}') END), 0)`;
  const agg = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN match_kind = 'created' THEN 1 ELSE 0 END) AS created,
         SUM(CASE WHEN match_kind = 'merged' THEN 1 ELSE 0 END) AS merged,
         SUM(CASE WHEN json_valid(source_collections) AND json_array_length(source_collections) > 1 THEN 1 ELSE 0 END) AS deduplicated,
         ${w('groups')} AS groups, ${w('values')} AS option_values, ${w('variants')} AS variants, ${w('swatches')} AS swatches,
         ${w('images')} AS images, ${w('image_bindings.variant')} AS variant_images, ${w('specs')} AS specs,
         ${w('specs_by_status.verified')} AS verified_specs, ${w('documents')} AS documents, ${w('relations')} AS relations,
         SUM(attempts) AS attempts
       FROM catalog_import_items WHERE run_id = ?`
    )
    .bind(runId)
    .first<Record<string, number | null>>();
  const media = await db
    .prepare("SELECT SUM(CASE WHEN status = 'stored' THEN 1 ELSE 0 END) AS stored, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'omitted_cap' THEN 1 ELSE 0 END) AS omitted FROM catalog_import_media WHERE run_id = ?")
    .bind(runId)
    .first<{ stored: number | null; failed: number | null; omitted: number | null }>();
  const firstFrames = await firstFrameMediaCount(db, runId);
  const links = await db
    .prepare(
      `SELECT COUNT(*) AS memberships,
              (SELECT COUNT(*) FROM products p WHERE p.id IN (SELECT levonis_product_id FROM catalog_import_items WHERE run_id = ?1 AND levonis_product_id <> '') AND p.sub_category_id IS NOT NULL) AS subcategory_links
         FROM product_catalogs pc WHERE pc.product_id IN (SELECT levonis_product_id FROM catalog_import_items WHERE run_id = ?1 AND levonis_product_id <> '')`
    )
    .bind(runId)
    .first<{ memberships: number; subcategory_links: number }>();
  const docs = await db
    .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN kind = 'tds' THEN 1 ELSE 0 END) AS tds, SUM(CASE WHEN kind = 'sds' THEN 1 ELSE 0 END) AS sds, SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS dead FROM product_documents WHERE import_run_id = ?")
    .bind(runId)
    .first<{ n: number; tds: number | null; sds: number | null; dead: number | null }>();
  const { results: missing } = await db
    .prepare("SELECT missing_reason AS r, COUNT(*) AS n FROM product_spec_values WHERE import_run_id = ? AND status IN ('not_found','not_published','unknown') GROUP BY missing_reason")
    .bind(runId)
    .all<{ r: string; n: number }>();
  const guard = await db
    .prepare("SELECT COUNT(*) AS n FROM catalog_import_events WHERE run_id = ? AND code = 'IMPORT_FINANCIAL_WRITE_REFUSED'")
    .bind(runId)
    .first<{ n: number }>();
  const protectedRows = await db
    .prepare('SELECT phase, COUNT(*) AS n FROM catalog_import_protected WHERE run_id = ? GROUP BY phase')
    .bind(runId)
    .all<{ phase: string; n: number }>();
  const { current } = await currentAndNext(db, runId);
  const blocked = current && current.state === 'BLOCKED' ? current : null;
  const num = (v: unknown) => Number(v ?? 0);
  return {
    discovered_total: total,
    queued_total: n('DISCOVERED'),
    complete_count: n('COMPLETE'),
    current_product: current?.handle ?? '',
    blocked_count: n('BLOCKED'),
    withdrawn_count: n('WITHDRAWN_AT_SOURCE'),
    remaining_count: total - n('COMPLETE') - n('WITHDRAWN_AT_SOURCE'),
    created_count: num(agg?.created),
    updated_existing_count: num(agg?.merged),
    deduplicated_references: num(agg?.deduplicated),
    category_links: num(links?.memberships),
    subcategory_links: num(links?.subcategory_links),
    group_count: num(agg?.groups),
    option_count: num(agg?.option_values),
    variant_count: num(agg?.variants),
    color_count: num(agg?.swatches),
    saved_media_count: num(media?.stored),
    linked_variant_media_count: num(agg?.variant_images),
    failed_media_count: num(media?.failed),
    /** Of the saved: animated GIFs stored as their first frame (DECISIONS row 264). */
    first_frame_media_count: firstFrames,
    omitted_media_count: num(media?.omitted),
    extracted_specs_count: num(agg?.specs),
    verified_specs_count: num(agg?.verified_specs),
    missing_info_by_reason: Object.fromEntries((missing ?? []).map((m) => [m.r || 'unspecified', Number(m.n)])),
    document_count: num(docs?.n),
    dead_document_count: num(docs?.dead),
    tds_count: num(docs?.tds),
    sds_count: num(docs?.sds),
    relation_count: num(agg?.relations),
    attempts: num(agg?.attempts),
    failed_stage: blocked?.last_completed_stage ?? '',
    blocker: blocked ? (await db.prepare('SELECT blocker_code AS b FROM catalog_import_items WHERE run_id = ? AND source_product_id = ?').bind(runId, blocked.source_product_id).first<{ b: string }>())?.b ?? '' : '',
    resumption_instruction: blocked ? 'workflow 60, mode=run, resume=true' : '',
    finance_protection: {
      guard_hits: num(guard?.n),
      snapshots: Object.fromEntries((protectedRows.results ?? []).map((r) => [r.phase, Number(r.n)])),
    },
  };
}

/** The per-item columns of report.json / report.csv (§H.3), in order. */
export const ITEM_REPORT_COLUMNS = [
  'queue_position', 'source_product_id', 'handle', 'state', 'match_kind', 'levonis_product_id', 'slug', 'live_url',
  'groups', 'values', 'variants', 'images', 'image_bindings', 'swatches', 'specs', 'verified_specs', 'specs_by_status', 'specs_by_region',
  'documents', 'dead_documents', 'relations', 'relations_by_state', 'box_items', 'translations', 'conflicts', 'conflicts_by_kind',
  'media_stored', 'media_failed', 'media_omitted', 'attempts', 'stage_attempts',
  'first_at', 'last_at', 'blocker_code',
] as const;
export type ItemReportRow = Record<(typeof ITEM_REPORT_COLUMNS)[number], string | number>;

/**
 * One page of the per-item report, by queue position after `after`. A slug and a live URL appear only for a
 * product that is active today (§A.8: no slug of a hidden product leaves D1).
 */
export async function itemReportRows(db: D1Database, runId: string, after: number, limit = 100): Promise<ItemReportRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.queue_position, i.source_product_id, i.handle, i.processing_state AS state, i.match_kind, i.levonis_product_id,
              CASE WHEN p.status = 'active' THEN i.slug ELSE '' END AS slug,
              CASE WHEN p.status = 'active' THEN i.live_url ELSE '' END AS live_url,
              CASE WHEN json_valid(i.stage_data) THEN i.stage_data ELSE '{}' END AS stage_data,
              i.attempts, i.stage_attempts, i.discovered_at AS first_at, i.updated_at AS last_at, i.blocker_code,
              (SELECT COUNT(*) FROM catalog_import_media m WHERE m.run_id = i.run_id AND m.source_product_id = i.source_product_id AND m.status = 'stored') AS media_stored,
              (SELECT COUNT(*) FROM catalog_import_media m WHERE m.run_id = i.run_id AND m.source_product_id = i.source_product_id AND m.status = 'failed') AS media_failed,
              (SELECT COUNT(*) FROM catalog_import_media m WHERE m.run_id = i.run_id AND m.source_product_id = i.source_product_id AND m.status = 'omitted_cap') AS media_omitted,
              (SELECT COUNT(*) FROM product_documents d WHERE d.product_id = i.levonis_product_id AND d.import_run_id = i.run_id AND d.active = 0) AS dead_documents,
              (SELECT group_concat(k || ':' || n, ';') FROM (SELECT kind AS k, COUNT(*) AS n FROM catalog_import_conflicts c WHERE c.item_id = i.id GROUP BY kind ORDER BY kind)) AS conflicts_by_kind
         FROM catalog_import_items i LEFT JOIN products p ON p.id = i.levonis_product_id
        WHERE i.run_id = ? AND i.queue_position > ?
        ORDER BY i.queue_position LIMIT ?`
    )
    .bind(runId, after, Math.min(Math.max(limit, 1), 200))
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => {
    let written: Record<string, unknown> = {};
    try {
      written = ((JSON.parse(String(r.stage_data)) as { written?: Record<string, unknown> }).written ?? {}) as Record<string, unknown>;
    } catch {
      written = {};
    }
    const wn = (k: string) => Number(written[k] ?? 0);
    const byStatus = (written.specs_by_status ?? {}) as Record<string, number>;
    /** A tally as `key:n;key:n`, keys sorted (a CSV cell, never a nested object). */
    const tally = (v: unknown) =>
      v && typeof v === 'object'
        ? Object.entries(v as Record<string, unknown>)
            .filter(([, n]) => typeof n === 'number')
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, n]) => `${k}:${n}`)
            .join(';')
        : '';
    return {
      queue_position: Number(r.queue_position),
      source_product_id: String(r.source_product_id),
      handle: String(r.handle),
      state: String(r.state),
      match_kind: String(r.match_kind ?? ''),
      levonis_product_id: String(r.levonis_product_id ?? ''),
      slug: String(r.slug ?? ''),
      live_url: String(r.live_url ?? ''),
      groups: wn('groups'),
      values: wn('values'),
      variants: wn('variants'),
      images: wn('images'),
      image_bindings: tally(written.image_bindings),
      swatches: wn('swatches'),
      specs: wn('specs'),
      verified_specs: Number(byStatus.verified ?? 0),
      specs_by_status: tally(written.specs_by_status),
      specs_by_region: tally(written.specs_by_region),
      documents: wn('documents'),
      dead_documents: Number(r.dead_documents ?? 0),
      relations: wn('relations'),
      relations_by_state: tally(written.relations_by_state),
      box_items: wn('box_items'),
      translations: wn('translations'),
      conflicts: wn('conflicts'),
      conflicts_by_kind: String(r.conflicts_by_kind ?? ''),
      media_stored: Number(r.media_stored ?? 0),
      media_failed: Number(r.media_failed ?? 0),
      media_omitted: Number(r.media_omitted ?? 0),
      attempts: Number(r.attempts ?? 0),
      stage_attempts: Number(r.stage_attempts ?? 0),
      first_at: String(r.first_at ?? ''),
      last_at: String(r.last_at ?? ''),
      blocker_code: String(r.blocker_code ?? ''),
    };
  });
}

/** A CSV cell: quoted when it must be, and never read as a formula by a spreadsheet. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The last verified public URL of the run (the most recent COMPLETE item, an active product). */
export async function lastVerifiedUrl(db: D1Database, runId: string): Promise<string> {
  const r = await db
    .prepare(
      `SELECT i.live_url FROM catalog_import_items i JOIN products p ON p.id = i.levonis_product_id AND p.status = 'active'
        WHERE i.run_id = ? AND i.processing_state = 'COMPLETE' ORDER BY i.completed_at DESC LIMIT 1`
    )
    .bind(runId)
    .first<{ live_url: string }>();
  return r?.live_url ?? '';
}

/** Items completed per hour over the run so far (an estimate; null before the first COMPLETE). */
export async function measuredRate(db: D1Database, runId: string): Promise<{ per_hour: number | null; eta_hours_estimate: number | null }> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(completed_at) AS first, MAX(completed_at) AS last,
              (SELECT COUNT(*) FROM catalog_import_items WHERE run_id = ?1 AND processing_state NOT IN ('COMPLETE','WITHDRAWN_AT_SOURCE')) AS left
         FROM catalog_import_items WHERE run_id = ?1 AND processing_state = 'COMPLETE' AND completed_at <> ''`
    )
    .bind(runId)
    .first<{ n: number; first: string | null; last: string | null; left: number }>();
  const hours = r?.first && r?.last ? (Date.parse(r.last) - Date.parse(r.first)) / 3_600_000 : 0;
  if (!r || Number(r.n) < 2 || hours <= 0) return { per_hour: null, eta_hours_estimate: null };
  const perHour = Number(r.n) / hours;
  return { per_hour: Math.round(perHour * 10) / 10, eta_hours_estimate: Math.round((Number(r.left) / perHour) * 10) / 10 };
}


const NEXT_OF: Readonly<Record<string, string>> = {
  EXTRACTING: 'ENRICHING',
  ENRICHING: 'VALIDATING',
  VALIDATING: 'INGESTING_MEDIA',
  INGESTING_MEDIA: 'WRITING',
  WRITING: 'PUBLISHING',
  PUBLISHING: 'VERIFYING_LIVE',
  VERIFYING_LIVE: 'COMPLETE',
};

/** The state an item is in after one of its events (ok events name the stage they completed). */
function stateAfter(stage: string, outcome: string): string | null {
  if (outcome === 'start' || outcome === 'resume') return stage;
  if (outcome === 'ok') return stage === 'WRITTEN' ? 'PUBLISHING' : stage === 'COMPLETED' ? 'COMPLETE' : NEXT_OF[stage] ?? null;
  if (outcome === 'retry') return 'RETRYING';
  if (outcome === 'blocked') return 'BLOCKED';
  return null;
}

const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/**
 * The measured time per working stage (§H.1: median and p90), in seconds, from the run's event sequence: the
 * span between an event that puts an item in a stage and that item's next event. An estimate of the run's
 * own pace, never a promise.
 */
export async function stageTimings(db: D1Database, runId: string): Promise<Record<string, { n: number; median_s: number | null; p90_s: number | null }>> {
  const { results } = await db
    .prepare('SELECT item_id, stage, outcome, at FROM catalog_import_events WHERE run_id = ? ORDER BY item_id, seq LIMIT 50000')
    .bind(runId)
    .all<{ item_id: string; stage: string; outcome: string; at: string }>();
  const spans = new Map<string, number[]>();
  const rows = results ?? [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (a.item_id !== b.item_id) continue;
    const state = stateAfter(a.stage, a.outcome);
    if (!state || !(state in NEXT_OF)) continue;
    const ms = Date.parse(b.at) - Date.parse(a.at);
    if (!Number.isFinite(ms) || ms < 0) continue;
    (spans.get(state) ?? spans.set(state, []).get(state)!).push(ms / 1000);
  }
  const out: Record<string, { n: number; median_s: number | null; p90_s: number | null }> = {};
  for (const stage of Object.keys(NEXT_OF)) {
    const xs = spans.get(stage) ?? [];
    out[stage] = { n: xs.length, median_s: percentile(xs, 50), p90_s: percentile(xs, 90) };
  }
  return out;
}
