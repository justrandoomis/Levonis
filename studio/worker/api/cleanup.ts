/**
 * CLEANUP (docs/STUDIO_PLAN.md decision 4, step 5; risk register #7).
 *
 * D1 and R2 are not one transaction, so the upload protocol deliberately
 * leaves debris behind in failure cases: 'pending' revisions whose client
 * died, 'abandoned' revisions, soft-deleted projects, and (after crashes
 * between R2 and D1 writes) R2 objects with no row. This module reclaims all
 * of it on a schedule:
 *
 *   1. expired studio_sessions rows,
 *   2. 'abandoned' revisions and 'pending' revisions older than the
 *      configured TTL (default 24h) — R2 objects first, then rows,
 *   3. soft-deleted projects past the retention window (default 30 days),
 *   4. committed-revision retention: keep the newest N per project (default
 *      20) but NEVER the head and NEVER the newest committed 'full' snapshot
 *      (mandate §4: the last full snapshot is protected),
 *   5. low-frequency R2↔D1 reconciliation over the projects/ prefix,
 *      deleting objects >48h old that no project_files row references.
 *
 * Wiring: studio/worker/index.ts must export a `scheduled` handler calling
 * runCleanup (plus a cron in studio/wrangler.jsonc). Those two files belong
 * to other slices — until they are wired, cleanup honestly does not run on
 * its own; nothing here pretends otherwise.
 */
import { type StudioApiCtx, type StudioApiEnv, nowIso } from "./router";
import { studioLimits } from "./quota";

export interface CleanupReport {
  expired_sessions: number;
  purged_revisions: number;
  purged_files: number;
  purged_projects: number;
  pruned_committed_revisions: number;
  reconciled_orphan_objects: number;
}

// Per-run work caps so a single cron invocation stays well inside limits.
const MAX_REVISIONS_PER_RUN = 100;
const MAX_PROJECTS_PER_RUN = 20;
const MAX_RETENTION_PROJECTS_PER_RUN = 20;
const MAX_RECONCILE_PAGES = 2;
const RECONCILE_MIN_AGE_MS = 48 * 3_600_000;
const SQL_IN_CHUNK = 50;

function isoAgo(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

/**
 * Deletes one revision's R2 objects, then its file rows, then the revision
 * row (R2 first: a failed object delete leaves rows behind for the next run,
 * never the other way around). Refuses to purge a revision that is currently
 * a project head — the commit crash-recovery path owns that window.
 */
export async function purgeRevisionById(db: D1Database, bucket: R2Bucket, revisionId: string): Promise<number> {
  const isHead = await db
    .prepare(`SELECT 1 AS x FROM projects WHERE head_revision_id = ? LIMIT 1`)
    .bind(revisionId)
    .first();
  if (isHead) return 0;

  const { results } = await db
    .prepare(`SELECT id, r2_key FROM project_files WHERE revision_id = ?`)
    .bind(revisionId)
    .all<{ id: string; r2_key: string }>();
  const files = results || [];
  for (let i = 0; i < files.length; i += SQL_IN_CHUNK) {
    const keys = files.slice(i, i + SQL_IN_CHUNK).map((f) => f.r2_key);
    await bucket.delete(keys);
  }
  await db.prepare(`DELETE FROM project_files WHERE revision_id = ?`).bind(revisionId).run();
  await db.prepare(`DELETE FROM project_revisions WHERE id = ?`).bind(revisionId).run();
  return files.length;
}

async function purgeProject(db: D1Database, bucket: R2Bucket, projectId: string): Promise<number> {
  // Break the head reference first so purgeRevisionById can take every
  // revision of this (already soft-deleted, past-retention) project.
  await db.prepare(`UPDATE projects SET head_revision_id = NULL, thumbnail_key = NULL WHERE id = ?`).bind(projectId).run();
  const { results } = await db
    .prepare(`SELECT id FROM project_revisions WHERE project_id = ?`)
    .bind(projectId)
    .all<{ id: string }>();
  let purgedFiles = 0;
  for (const rev of results || []) {
    purgedFiles += await purgeRevisionById(db, bucket, rev.id);
  }
  await db.prepare(`DELETE FROM projects WHERE id = ?`).bind(projectId).run();
  return purgedFiles;
}

async function existingKeys(db: D1Database, keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += SQL_IN_CHUNK) {
    const chunk = keys.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT r2_key FROM project_files WHERE r2_key IN (${placeholders})`)
      .bind(...chunk)
      .all<{ r2_key: string }>();
    for (const row of results || []) found.add(row.r2_key);
  }
  return found;
}

export async function runCleanup(env: StudioApiEnv, now: number = Date.now()): Promise<CleanupReport> {
  const db = env.DB;
  const bucket = env.BUCKET ?? null;
  const limits = studioLimits(env);
  const report: CleanupReport = {
    expired_sessions: 0,
    purged_revisions: 0,
    purged_files: 0,
    purged_projects: 0,
    pruned_committed_revisions: 0,
    reconciled_orphan_objects: 0,
  };

  // 1. Expired sessions (table owned by the auth layer; tolerate its absence).
  try {
    const res = await db.prepare(`DELETE FROM studio_sessions WHERE expires_at < ?`).bind(nowIso()).run();
    report.expired_sessions = res.meta.changes ?? 0;
  } catch {
    /* studio_sessions not provisioned yet — nothing to clean */
  }

  if (!bucket) return report; // Without R2 there are no objects to reclaim.

  // 2. Abandoned revisions + stale pendings past the TTL.
  const pendingCutoff = isoAgo(now, limits.pendingTtlMs);
  const { results: staleRevs } = await db
    .prepare(
      `SELECT id FROM project_revisions
        WHERE (state = 'abandoned' OR (state = 'pending' AND created_at < ?))
          AND id NOT IN (SELECT head_revision_id FROM projects WHERE head_revision_id IS NOT NULL)
        LIMIT ${MAX_REVISIONS_PER_RUN}`
    )
    .bind(pendingCutoff)
    .all<{ id: string }>();
  for (const rev of staleRevs || []) {
    report.purged_files += await purgeRevisionById(db, bucket, rev.id);
    report.purged_revisions += 1;
  }

  // 3. Soft-deleted projects past retention.
  const deletedCutoff = isoAgo(now, limits.deletedRetentionMs);
  const { results: deadProjects } = await db
    .prepare(`SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ${MAX_PROJECTS_PER_RUN}`)
    .bind(deletedCutoff)
    .all<{ id: string }>();
  for (const project of deadProjects || []) {
    report.purged_files += await purgeProject(db, bucket, project.id);
    report.purged_projects += 1;
  }

  // 4. Committed-revision retention (keep newest N; head and the newest
  //    committed 'full' snapshot are always protected).
  const { results: crowded } = await db
    .prepare(
      `SELECT project_id, COUNT(*) AS n FROM project_revisions
        WHERE state = 'committed' GROUP BY project_id HAVING n > ? LIMIT ${MAX_RETENTION_PROJECTS_PER_RUN}`
    )
    .bind(limits.keepCommittedRevisions)
    .all<{ project_id: string; n: number }>();
  for (const entry of crowded || []) {
    const { results: committed } = await db
      .prepare(
        `SELECT r.id, r.snapshot_kind, p.head_revision_id AS head_id
           FROM project_revisions r JOIN projects p ON p.id = r.project_id
          WHERE r.project_id = ? AND r.state = 'committed'
          ORDER BY r.revision DESC`
      )
      .bind(entry.project_id)
      .all<{ id: string; snapshot_kind: string; head_id: string | null }>();
    const rows = committed || [];
    const keep = new Set<string>(rows.slice(0, limits.keepCommittedRevisions).map((r) => r.id));
    const newestFull = rows.find((r) => r.snapshot_kind === "full");
    if (newestFull) keep.add(newestFull.id);
    if (rows[0]?.head_id) keep.add(rows[0].head_id);
    for (const r of rows) {
      if (keep.has(r.id)) continue;
      report.purged_files += await purgeRevisionById(db, bucket, r.id);
      report.pruned_committed_revisions += 1;
    }
  }

  // 5. Low-frequency R2 ↔ D1 reconciliation (bounded pages per run).
  let cursor: string | undefined;
  for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
    const listing = await bucket.list({ prefix: "projects/", cursor, limit: 500 });
    const oldEnough = listing.objects.filter((o) => now - o.uploaded.getTime() > RECONCILE_MIN_AGE_MS);
    if (oldEnough.length > 0) {
      const known = await existingKeys(
        db,
        oldEnough.map((o) => o.key)
      );
      const orphans = oldEnough.filter((o) => !known.has(o.key)).map((o) => o.key);
      for (let i = 0; i < orphans.length; i += SQL_IN_CHUNK) {
        await bucket.delete(orphans.slice(i, i + SQL_IN_CHUNK));
      }
      report.reconciled_orphan_objects += orphans.length;
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }

  return report;
}

/**
 * Scheduled-event glue for the worker entry (S2/S1 wiring):
 *
 *   import { scheduledCleanup } from "./api/cleanup";
 *   export default {
 *     fetch: ...,
 *     scheduled(event, env, ctx) { scheduledCleanup(env, ctx); },
 *   };
 *
 * plus a cron expression in studio/wrangler.jsonc `triggers.crons`.
 */
export function scheduledCleanup(env: StudioApiEnv, ctx: StudioApiCtx): void {
  ctx.waitUntil(
    runCleanup(env).catch((error) => {
      console.error("studio cleanup failed:", error);
    })
  );
}
