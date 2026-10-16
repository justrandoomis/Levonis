/**
 * THE RUN-LEVEL OPS CALLS (Bambu import spec §A.3, §A.9, §D.2, §E.4; the
 * runner's contract, scripts/bambu-import/opsClient.ts):
 *
 *   /hello                 protocol, migrations, the reviewed files' SHA-256s
 *   /manifest              the queue, row by row, only as the bundled manifest has it
 *   /run/prepare-taxonomy  insert-only: the map's missing nodes, the brand, the synonyms
 *   /run/protect-snapshot  §E.4 per-run fingerprints, phase before | after
 *   /run/finish            closed or partial; the token cleared
 *   /items/:sid/withdraw   BLOCKED SOURCE_WITHDRAWN → WITHDRAWN_AT_SOURCE, with evidence
 *   /items/:sid/readback   the write's recorded verifyApplied + live ownership checks
 *
 * Digests of protected material are stored, never answered and never logged:
 * an answer carries counts only.
 */
import type { Env } from '../types';
import { newId } from '../crypto';
import { fence, isFenceMiss } from '../operations';
import { EXPECTED_MIGRATION } from '../schemaVersion';
import { importObjectPresence } from './media';
import { canonicalJson } from '@levonis/catalog/bambuImport/fingerprint';
import { H, sha256Hex } from '@levonis/catalog/bambuImport/hash';
import { NOW_SQL, OpsRefusal, IMPORT_PROTOCOL, type ImportRun } from './auth';
import { packedInserts } from './budget';
import { currentAndNext } from './report';
import { taxonomyNodeId, type ReviewedBundle, type TaxonomyCreateNode } from './reviewed';
import { stageDataOf, type ItemRow } from './items';
import { FINGERPRINT_QUERIES } from './writer';

// ---------------------------------------------------------------- /hello

/** Which migrations the import needs are installed: one presence probe per table. */
export async function migrationsPresent(db: D1Database): Promise<Record<'0193' | '0194' | '0195', boolean>> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('product_price_requests','product_spec_values','catalog_import_runs')")
    .all<{ name: string }>();
  const have = new Set((results ?? []).map((r) => r.name));
  return { '0193': have.has('product_price_requests'), '0194': have.has('product_spec_values'), '0195': have.has('catalog_import_runs') };
}

export const WORKER_BUILD = `catalog-import-ops/${IMPORT_PROTOCOL};${EXPECTED_MIGRATION}`;

/**
 * Records the job on the run (its GitHub run id and commit, the reviewed bundle it runs under) and answers the
 * cursor: the queue position of the item in flight, else of the next one.
 */
export async function helloRecord(db: D1Database, run: ImportRun, body: Record<string, unknown>, bundleDigest: string): Promise<{ cursor: number | null }> {
  if (body.protocol !== IMPORT_PROTOCOL) throw new OpsRefusal(409, 'IMPORT_PROTOCOL_MISMATCH');
  const gh = typeof body.github_run_id === 'string' && /^\d{1,20}$/.test(body.github_run_id) ? body.github_run_id : '';
  const commit = typeof body.code_commit === 'string' && /^[0-9a-f]{40}$/.test(body.code_commit) ? body.code_commit : '';
  await db
    .prepare(
      `UPDATE catalog_import_runs SET github_run_id = CASE WHEN ? <> '' THEN ? ELSE github_run_id END,
              code_commit = CASE WHEN ? <> '' THEN ? ELSE code_commit END,
              reviewed_bundle_sha256 = CASE WHEN ? <> '' THEN ? ELSE reviewed_bundle_sha256 END
        WHERE id = ?`
    )
    .bind(gh, gh, commit, commit, bundleDigest, bundleDigest, run.id)
    .run();
  const { current, next } = await currentAndNext(db, run.id);
  return { cursor: current?.queue_position ?? next?.queue_position ?? null };
}

// ---------------------------------------------------------------- /manifest

const ISOISH = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/;
const strList = (v: unknown, max: number, len: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= len) ? (v as string[]) : null;

/**
 * Up to 100 rows. Each must be the bundled manifest's row — the same source id, handle, type, curated flag,
 * hold code and queue position (and canonical URL when one is sent) — or the whole call is refused (the answer
 * names no id: an unlisted id is the caller's input, never echoed). Discovery fields are written only while the item is new or still DISCOVERED; an item that
 * has moved on is left as it is (the insert trigger would refuse it) and still counts as accepted.
 */
export async function acceptManifest(db: D1Database, run: ImportRun, bundle: ReviewedBundle, body: Record<string, unknown>): Promise<{ accepted: number }> {
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length > 100) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const values: unknown[][] = [];
  const sids: string[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    const r = raw as Record<string, unknown>;
    const sid = typeof r.source_product_id === 'string' && /^\d{1,24}$/.test(r.source_product_id) ? r.source_product_id : '';
    if (!sid) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    const m = bundle.manifest.bySourceId.get(sid);
    const same =
      !!m &&
      r.handle === m.handle &&
      (r.type ?? '') === m.type &&
      (r.curated === true) === m.curated &&
      (r.hold_code ?? '') === m.hold_code &&
      r.queue_position === m.queue_position &&
      (!r.canonical_url || r.canonical_url === m.canonical_url);
    if (!same) throw new OpsRefusal(409, 'REVIEWED_SCOPE_REFUSED');
    const collections = strList(r.source_collections ?? [], 50, 200);
    const sources = strList(r.discovery_sources ?? [], 10, 40);
    const breadcrumbs = typeof r.breadcrumbs === 'string' && r.breadcrumbs.length <= 500 ? r.breadcrumbs : r.breadcrumbs === undefined ? '' : null;
    const discoveredAt = typeof r.discovered_at === 'string' && ISOISH.test(r.discovered_at) ? r.discovered_at : null;
    if (!collections || !sources || breadcrumbs === null || !discoveredAt) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    sids.push(sid);
    values.push([
      `cii_${H(`${run.id}:bambu_us:${sid}`)}`, run.id, sid, m!.handle, m!.canonical_url, m!.type, m!.queue_position, m!.curated ? 1 : 0, m!.hold_code,
      JSON.stringify(collections), breadcrumbs, JSON.stringify(sources), discoveredAt,
    ]);
  }
  if (!values.length) return { accepted: 0 };
  // Items that already left DISCOVERED are not re-sent (trg_cii_insert refuses an insert over them).
  const { results } = await db
    .prepare(
      `SELECT source_product_id FROM catalog_import_items WHERE run_id = ? AND processing_state <> 'DISCOVERED'
          AND source_product_id IN (SELECT value FROM json_each(?))`
    )
    .bind(run.id, JSON.stringify(sids))
    .all<{ source_product_id: string }>();
  const movedOn = new Set((results ?? []).map((r) => String(r.source_product_id)));
  const fresh = values.filter((v) => !movedOn.has(String(v[2])));
  if (fresh.length) {
    await db.batch(
      packedInserts(
        db,
        `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, product_type, queue_position, curated_scope, hold_code,
            source_collections, breadcrumbs, discovery_sources, discovered_at)`,
        "(?, ?, 'bambu_us', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        fresh,
        `ON CONFLICT (run_id, source, source_product_id) DO UPDATE SET source_collections = excluded.source_collections,
            breadcrumbs = excluded.breadcrumbs, discovery_sources = excluded.discovery_sources, discovered_at = excluded.discovered_at,
            updated_at = ${NOW_SQL}
          WHERE catalog_import_items.processing_state = 'DISCOVERED'`
      )
    );
  }
  return { accepted: values.length };
}

// ---------------------------------------------------------------- /run/prepare-taxonomy

/** The map's created nodes, parents first (a node may sit under another created node). */
export function nodesInOrder(create: readonly TaxonomyCreateNode[]): TaxonomyCreateNode[] {
  const byKey = new Map(create.map((n) => [n.key, n]));
  const out: TaxonomyCreateNode[] = [];
  const placed = new Set<string>();
  const visit = (n: TaxonomyCreateNode, depth: number) => {
    if (placed.has(n.key) || depth > 20) return;
    if (n.parent.startsWith('@')) {
      const p = byKey.get(n.parent.slice(1));
      if (p) visit(p, depth + 1);
    }
    placed.add(n.key);
    out.push(n);
  };
  for (const n of create) visit(n, 0);
  return out;
}

export const BAMBU_BRAND = Object.freeze({ id: 'brd_bambu_lab', slug: 'bambu-lab', name: 'Bambu Lab' });

/**
 * One insert-only batch: the nodes the map creates (as `cat_bi_<key>`), the brand, and the reviewed ar/ckb
 * synonyms. `INSERT OR IGNORE` everywhere: an existing node, brand or synonym — the owner's included — is never
 * overwritten. A node whose seeded parent does not exist refuses the whole call (TAXONOMY_UNMAPPED), before
 * anything is written.
 */
export async function prepareTaxonomy(db: D1Database, bundle: ReviewedBundle): Promise<{ created_nodes: number; brand_created: boolean; synonyms_inserted: number }> {
  const nodes = nodesInOrder(bundle.taxonomy.create);
  const seededParents = [...new Set(nodes.map((n) => n.parent).filter((p) => !p.startsWith('@')))];
  if (seededParents.length) {
    const { results } = await db
      .prepare('SELECT id FROM catalogs WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(seededParents))
      .all<{ id: string }>();
    const have = new Set((results ?? []).map((r) => String(r.id)));
    const missing = seededParents.filter((p) => !have.has(p));
    if (missing.length) throw new OpsRefusal(409, 'TAXONOMY_UNMAPPED', missing.slice(0, 3));
  }
  const statements: D1PreparedStatement[] = [];
  const nodeAt: number[] = [];
  for (const n of nodes) {
    nodeAt.push(statements.length);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active, template_family)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .bind(taxonomyNodeId(n.key), n.parent.startsWith('@') ? taxonomyNodeId(n.parent) : n.parent, n.slug, n.name_ar, n.name_en, n.name_ckb, n.sort, n.is_printer_catalog, n.template_family)
    );
  }
  const brandAt = statements.length;
  statements.push(
    db
      .prepare('INSERT OR IGNORE INTO brands (id, slug, name_ar, name_en, name_ckb) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM brands WHERE slug = ?)')
      .bind(BAMBU_BRAND.id, BAMBU_BRAND.slug, BAMBU_BRAND.name, BAMBU_BRAND.name, BAMBU_BRAND.name, BAMBU_BRAND.slug)
  );
  const synAt = statements.length;
  statements.push(...packedInserts(db, 'INSERT OR IGNORE INTO search_synonyms (term, canonical)', '(?, ?)', bundle.synonyms.map((s) => [s.term, s.canonical])));
  const results = (statements.length ? await db.batch(statements) : []) as Array<{ meta?: { changes?: number } }>;
  const changes = (i: number) => Number(results[i]?.meta?.changes ?? 0);
  return {
    created_nodes: nodeAt.reduce((n, i) => n + changes(i), 0),
    brand_created: changes(brandAt) > 0,
    synonyms_inserted: results.slice(synAt).reduce((n, r) => n + Number(r?.meta?.changes ?? 0), 0),
  };
}

// ---------------------------------------------------------------- /run/protect-snapshot (§E.4)

/**
 * The per-run fingerprints, one table per statement over ALL products (the per-write material of §E.4,
 * FINGERPRINT_QUERIES, grouped by product here instead of bound to one), and the global counters.
 */
const IN_SUBJECTS = 'IN (SELECT value FROM json_each(?))';
export const PRODUCT_MATERIAL: ReadonlyArray<{ table: string; sql: string }> = FINGERPRINT_QUERIES.map((q) => {
  if (q.sql.includes('WHERE id = ?')) {
    return { table: q.table, sql: q.sql.replace('SELECT id,', 'SELECT id AS pid, id,').replace('WHERE id = ?', `WHERE id ${IN_SUBJECTS} ORDER BY id`) };
  }
  if (/COUNT\(\*\)/.test(q.sql)) {
    return { table: q.table, sql: q.sql.replace('SELECT ', 'SELECT product_id AS pid, ').replace('WHERE product_id = ?', `WHERE product_id ${IN_SUBJECTS} GROUP BY product_id ORDER BY product_id`) };
  }
  const rows = q.sql.replace(/^SELECT /, 'SELECT product_id AS pid, ').replace('WHERE product_id = ?', `WHERE product_id ${IN_SUBJECTS}`);
  return { table: q.table, sql: rows.includes('ORDER BY ') ? rows.replace('ORDER BY ', 'ORDER BY product_id, ') : `${rows} ORDER BY product_id` };
});

/** Global counters (§E.4 "Per run"): rows and sums, each table on its own; a table that is absent is recorded so. */
export const GLOBAL_COUNTERS: ReadonlyArray<{ table: string; sums: readonly string[] }> = [
  { table: 'orders', sums: ['total_iqd', 'subtotal_iqd'] },
  { table: 'order_items', sums: ['qty', 'line_total_iqd'] },
  { table: 'wallet_transactions', sums: ['amount_iqd'] },
  { table: 'accounting_entries', sums: [] },
  { table: 'inventory_lots', sums: ['qty_received', 'qty_remaining', 'total_cost_iqd'] },
  { table: 'inventory_ledger', sums: ['qty'] },
  { table: 'price_history', sums: ['new_iqd'] },
  { table: 'product_sku_prices', sums: ['regular_price_iqd'] },
  { table: 'pricing_v2_sku_results', sums: ['final_price_iqd'] },
  { table: 'product_pricing_state', sums: [] },
  { table: 'coupons', sums: [] },
  { table: 'coupon_redemptions', sums: ['amount_iqd'] },
  { table: 'investments', sums: ['amount_usd_cents'] },
  { table: 'investment_contracts', sums: ['principal_iqd'] },
  { table: 'investor_finance_events', sums: ['amount_iqd'] },
  { table: 'finance_wage_targets', sums: ['amount_iqd'] },
  { table: 'finance_wage_versions', sums: [] },
];

const digestOf = (v: unknown) => sha256Hex(canonicalJson(v));

/** Every subject's digest: `product:<id>` for each product, `global:<table>` for each counter. */
export async function protectedDigests(db: D1Database, productIds: readonly string[] | null): Promise<Map<string, string>> {
  const material = new Map<string, Record<string, unknown[]>>();
  const subjects = productIds ?? ((await db.prepare('SELECT id FROM products ORDER BY id').all<{ id: string }>()).results ?? []).map((p) => String(p.id));
  for (const id of subjects) material.set(id, {});
  const ids = JSON.stringify(subjects);
  const results = (await db.batch(PRODUCT_MATERIAL.map((q) => db.prepare(q.sql).bind(ids)))) as Array<{ results?: Array<Record<string, unknown>> }>;
  PRODUCT_MATERIAL.forEach((q, i) => {
    for (const row of results[i]?.results ?? []) {
      const pid = String(row.pid);
      const m = material.get(pid);
      if (!m) continue;
      const { pid: _pid, ...rest } = row;
      void _pid;
      (m[q.table] ??= []).push(rest);
    }
  });
  const out = new Map<string, string>();
  for (const [pid, m] of material) out.set(`product:${pid}`, digestOf(m));
  for (const g of GLOBAL_COUNTERS) {
    try {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n, MAX(rowid) AS last${g.sums.map((c, i) => `, total(${c}) AS s${i}`).join('')} FROM ${g.table}`)
        .first<Record<string, unknown>>();
      out.set(`global:${g.table}`, digestOf(row ?? {}));
    } catch {
      out.set(`global:${g.table}`, digestOf('absent'));
    }
  }
  return out;
}

/**
 * phase 'before': every product that exists now, and the counters. phase 'after': the subjects of the run's
 * first 'before' snapshot, compared with it (`changed` = how many differ; the close report explains them).
 */
export async function protectSnapshot(db: D1Database, run: ImportRun, body: Record<string, unknown>): Promise<{ subjects: number; changed: number | null }> {
  const phase = body.phase;
  if (phase !== 'before' && phase !== 'after') throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  let before: Map<string, string> | null = null;
  if (phase === 'after') {
    const { results } = await db
      .prepare(
        `SELECT subject, digest FROM catalog_import_protected p WHERE run_id = ? AND phase = 'before'
            AND at = (SELECT MIN(at) FROM catalog_import_protected q WHERE q.run_id = p.run_id AND q.phase = 'before' AND q.subject = p.subject)`
      )
      .bind(run.id)
      .all<{ subject: string; digest: string }>();
    before = new Map((results ?? []).map((r) => [String(r.subject), String(r.digest)]));
  }
  const ids = before ? [...before.keys()].filter((s) => s.startsWith('product:')).map((s) => s.slice('product:'.length)) : null;
  const now = await protectedDigests(db, ids);
  const at = new Date().toISOString();
  await db.batch(
    packedInserts(
      db,
      'INSERT OR IGNORE INTO catalog_import_protected (run_id, phase, subject, digest, at)',
      '(?, ?, ?, ?, ?)',
      [...now].map(([subject, digest]) => [run.id, phase, subject, digest, at])
    )
  );
  if (!before) return { subjects: now.size, changed: null };
  let changed = 0;
  for (const [subject, digest] of before) if (now.get(subject) !== digest) changed++;
  return { subjects: now.size, changed };
}

// ---------------------------------------------------------------- /run/finish

/** A queued item the reviewed manifest still holds (§B.5 holds, queued last): it waits for the owner, not the queue. */
export interface HeldItem {
  source_product_id: string;
  handle: string;
  queue_position: number;
  hold_code: string;
}

/** The source ids the bundled manifest holds today (a hold the owner has since answered is no longer one). */
export const heldSourceIds = (bundle: Pick<ReviewedBundle, 'manifest'>): string[] =>
  bundle.manifest.rows.filter((r) => r.hold_code !== '').map((r) => r.source_product_id);

/** The DISCOVERED items of the run that the manifest holds: they can never start while another hold is BLOCKED. */
export async function heldItems(db: D1Database, runId: string, bundle: Pick<ReviewedBundle, 'manifest'>): Promise<HeldItem[]> {
  const held = heldSourceIds(bundle);
  if (!held.length) return [];
  const { results } = await db
    .prepare(
      `SELECT source_product_id, handle, queue_position, hold_code FROM catalog_import_items
        WHERE run_id = ? AND processing_state = 'DISCOVERED' AND source_product_id IN (SELECT value FROM json_each(?)) ORDER BY queue_position`
    )
    .bind(runId, JSON.stringify(held))
    .all<HeldItem>();
  const byId = new Map(bundle.manifest.rows.map((r) => [r.source_product_id, r.hold_code]));
  return (results ?? []).map((r) => ({ ...r, queue_position: Number(r.queue_position), hold_code: byId.get(String(r.source_product_id)) || r.hold_code }));
}

/**
 * closed, or partial when an item is BLOCKED or WITHDRAWN_AT_SOURCE, or still held (§K.2 step 13: "no DISCOVERED …
 * item remains except the end-of-queue holds"; R-19, L-7: the run closes partial and names them). The holds are
 * the DISCOVERED items the bundled manifest holds: with two or more of them, the first blocks at its turn and the
 * in-flight index keeps every later one queued for good, so they cannot keep the run open. Refused while any other
 * item is queued or in flight. The token is cleared; the answer names the held items.
 */
export async function finishRun(db: D1Database, run: ImportRun, bundle: Pick<ReviewedBundle, 'manifest'>): Promise<{ state: 'closed' | 'partial'; held: HeldItem[] }> {
  const heldSources = JSON.stringify(heldSourceIds(bundle));
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN processing_state IN ('BLOCKED','WITHDRAWN_AT_SOURCE') THEN 1 ELSE 0 END) AS partial,
              SUM(CASE WHEN processing_state = 'DISCOVERED' AND source_product_id IN (SELECT value FROM json_each(?2)) THEN 1 ELSE 0 END) AS held,
              SUM(CASE WHEN processing_state NOT IN ('COMPLETE','BLOCKED','WITHDRAWN_AT_SOURCE')
                        AND NOT (processing_state = 'DISCOVERED' AND source_product_id IN (SELECT value FROM json_each(?2))) THEN 1 ELSE 0 END) AS open
         FROM catalog_import_items WHERE run_id = ?1`
    )
    .bind(run.id, heldSources)
    .first<{ partial: number | null; held: number | null; open: number | null }>();
  if (Number(row?.open ?? 0) > 0) throw new OpsRefusal(409, 'IMPORT_RUN_NOT_FINISHED', [run.id]);
  const held = Number(row?.held ?? 0) > 0 ? await heldItems(db, run.id, bundle) : [];
  const state = Number(row?.partial ?? 0) > 0 || held.length > 0 ? 'partial' : 'closed';
  await db
    .prepare(`UPDATE catalog_import_runs SET state = ?, token_sha256 = '', closed_at = ${NOW_SQL} WHERE id = ? AND state IN ('open','running','blocked')`)
    .bind(state, run.id)
    .run();
  return { state, held };
}

// ---------------------------------------------------------------- /items/:sid/withdraw

const DAY_MS = 24 * 3_600_000;
const APPROVAL = /^workflow-60-run-(?:\d{1,20}|local)$/;
const WITHDRAWN_STATUS = new Set([301, 302, 303, 307, 308, 404, 410]);

/**
 * BLOCKED SOURCE_WITHDRAWN → WITHDRAWN_AT_SOURCE (§1 row 20): the owner's approval reference (workflow 60's run),
 * a second fetch at least 24 h after the block that still finds the page gone, and the sitemap no longer listing
 * it. Terminal: never COMPLETE.
 */
export async function withdrawItem(db: D1Database, run: ImportRun, item: ItemRow, body: Record<string, unknown>): Promise<{ state: string }> {
  const approval = typeof body.approval_ref === 'string' && APPROVAL.test(body.approval_ref) ? body.approval_ref : '';
  const ev = body.evidence && typeof body.evidence === 'object' ? (body.evidence as Record<string, unknown>) : {};
  const second = ev.second_fetch && typeof ev.second_fetch === 'object' ? (ev.second_fetch as Record<string, unknown>) : {};
  const secondAt = typeof second.at === 'string' ? Date.parse(second.at) : NaN;
  if (item.processing_state !== 'BLOCKED' || item.blocker_code !== 'SOURCE_WITHDRAWN' || !approval) throw new OpsRefusal(409, 'IMPORT_WITHDRAW_REFUSED', [item.id]);
  const blocked = await db
    .prepare("SELECT MAX(at) AS at FROM catalog_import_events WHERE run_id = ? AND item_id = ? AND outcome = 'blocked' AND code = 'SOURCE_WITHDRAWN'")
    .bind(run.id, item.id)
    .first<{ at: string | null }>();
  const firstAt = blocked?.at ? Date.parse(blocked.at) : NaN;
  const ok =
    Number.isFinite(firstAt) &&
    Number.isFinite(secondAt) &&
    secondAt - firstAt >= DAY_MS &&
    secondAt <= Date.now() + 60_000 &&
    second.outcome === 'withdrawn' &&
    typeof second.status === 'number' &&
    WITHDRAWN_STATUS.has(second.status) &&
    ev.sitemap_absent === true;
  if (!ok) throw new OpsRefusal(409, 'IMPORT_WITHDRAW_REFUSED', [item.id]);
  const evidence = { first_at: new Date(firstAt).toISOString(), second_fetch: { at: new Date(secondAt).toISOString(), outcome: 'withdrawn', status: second.status }, sitemap_absent: true };
  // Fenced on the state this call read: an item that moved meanwhile gets no 'withdrawn' event (409, stale).
  const [fenceIn, fenceOut] = fence(db, `EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND processing_state = 'BLOCKED' AND blocker_code = 'SOURCE_WITHDRAWN')`, [item.id]);
  try {
    await db.batch([
      fenceIn,
      db
        .prepare(
          `UPDATE catalog_import_items SET processing_state = 'WITHDRAWN_AT_SOURCE', withdrawn_evidence = ?, withdrawn_by = ?, updated_at = ${NOW_SQL}
            WHERE id = ? AND processing_state = 'BLOCKED' AND blocker_code = 'SOURCE_WITHDRAWN'`
        )
        .bind(JSON.stringify(evidence), approval, item.id),
      db
        .prepare(
          `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), 'WITHDRAWN_AT_SOURCE', 'withdrawn', 'SOURCE_WITHDRAWN', '', '{}', '', ?)`
        )
        .bind(newId('cie'), run.id, item.id, run.id, run.github_run_id),
      fenceOut,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
    throw e;
  }
  return { state: 'WITHDRAWN_AT_SOURCE' };
}

// ---------------------------------------------------------------- /items/:sid/readback

/**
 * The admin-side half of §I.1.6: the write's own verifyApplied over this payload's plan (recorded by the write,
 * `stage_data.readback`), and — live — every bound value, variant and colour id belongs to the product, every
 * value to a group of the product, every swatch to a value of the product, every variant's combination to values
 * of the product, and every stored key exists in R2. Counts and check names only. A verification that has not run,
 * or an R2 that does not answer, is a transient 503 — never a failed check.
 */
export async function readbackItem(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  item: ItemRow
): Promise<{ ok: boolean; mismatches: number; checks: Record<string, boolean>; counts: Record<string, number> }> {
  const db = env.DB;
  const pid = item.levonis_product_id;
  if (!pid) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  const recorded = (stageDataOf(item).readback ?? null) as { ran?: boolean; mismatches?: number | null } | null;
  // The write's own verification has not RUN (a passing failure after its commit, or no record yet): not a
  // verdict. Transient for the runner (5xx) — never `ok: false`, which VERIFY reads as a failed check.
  const ran = !!recorded && recorded.ran !== false && typeof recorded.mismatches === 'number' && recorded.mismatches >= 0;
  if (!ran) throw new OpsRefusal(503, 'IMPORT_READBACK_PENDING', [item.id]);
  const own = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE id = ?1) AS product,
         (SELECT COUNT(*) FROM product_images i WHERE i.product_id = ?1 AND (
             (i.option_value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.id = i.option_value_id AND v.product_id = ?1))
          OR (i.variant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_variants x WHERE x.id = i.variant_id AND x.product_id = ?1))
          OR (i.color_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_colors k WHERE k.id = i.color_id AND k.product_id = ?1)))) AS foreign_bindings,
         (SELECT COUNT(*) FROM product_option_values v WHERE v.product_id = ?1
             AND NOT EXISTS (SELECT 1 FROM product_option_groups g WHERE g.id = v.group_id AND g.product_id = ?1)) AS foreign_values,
         (SELECT COUNT(*) FROM product_option_value_swatches s WHERE s.product_id = ?1
             AND NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.id = s.option_value_id AND v.product_id = ?1)) AS foreign_swatches,
         (SELECT COUNT(*) FROM product_images WHERE product_id = ?1) AS images`
    )
    .bind(pid)
    .first<{ product: number; foreign_bindings: number; foreign_values: number; foreign_swatches: number; images: number }>();
  const { results: variants } = await db.prepare('SELECT combo_key FROM product_variants WHERE product_id = ?').bind(pid).all<{ combo_key: string }>();
  const { results: valueRows } = await db.prepare('SELECT id FROM product_option_values WHERE product_id = ?').bind(pid).all<{ id: string }>();
  const values = new Set((valueRows ?? []).map((v) => String(v.id)));
  const foreignCombos = (variants ?? []).filter((v) =>
    String(v.combo_key ?? '')
      .split('|')
      .filter((p) => p.startsWith('o:'))
      .some((p) => !values.has(p.slice(2)))
  ).length;
  const { results: keyRows } = await db
    .prepare(
      `SELECT DISTINCT r2_key FROM product_images WHERE product_id = ?1 AND r2_key <> ''
       UNION SELECT DISTINCT r2_key FROM product_option_value_swatches WHERE product_id = ?1 AND r2_key <> '' LIMIT 400`
    )
    .bind(pid)
    .all<{ r2_key: string }>();
  let missingKeys = 0;
  for (const k of keyRows ?? []) {
    const presence = await importObjectPresence(env, String(k.r2_key));
    // A storage error is not a missing object: the whole answer is transient, asked again.
    if (presence === 'unknown') throw new OpsRefusal(503, 'IMPORT_STORAGE_UNAVAILABLE', [item.id]);
    if (presence === 'absent') missingKeys++;
  }
  const checks = {
    product: Number(own?.product ?? 0) === 1,
    write_verified: recorded!.mismatches === 0,
    bindings_own: Number(own?.foreign_bindings ?? 0) === 0,
    values_own: Number(own?.foreign_values ?? 0) === 0,
    swatches_own: Number(own?.foreign_swatches ?? 0) === 0,
    variants_own: foreignCombos === 0,
    keys_exist: missingKeys === 0,
  };
  const mismatches =
    (checks.product ? 0 : 1) +
    Number(recorded!.mismatches) +
    Number(own?.foreign_bindings ?? 0) +
    Number(own?.foreign_values ?? 0) +
    Number(own?.foreign_swatches ?? 0) +
    foreignCombos +
    missingKeys;
  return {
    ok: mismatches === 0,
    mismatches,
    checks,
    counts: { images: Number(own?.images ?? 0), keys: (keyRows ?? []).length, missing_keys: missingKeys, foreign_combos: foreignCombos },
  };
}
