/**
 * CLEANUP (docs/STUDIO_PLAN.md decision 4, step 5; risk register #7).
 *
 * D1 and R2 are not one transaction, so the upload protocol deliberately
 * leaves debris behind in failure cases: 'pending' revisions whose client
 * died, 'abandoned' revisions, soft-deleted projects, and (after crashes
 * between R2 and D1 writes) R2 objects with no row. This module reclaims all
 * of it on a schedule:
 *
 *   1. expired studio_sessions rows, and rate-limit windows older than a
 *      day (P1-10, worker/api/ratelimit.ts),
 *   2. 'abandoned' revisions and 'pending' revisions older than the
 *      configured TTL (default 24h) — R2 objects first, then rows,
 *   3. soft-deleted projects past the retention window (default 30 days),
 *   4. committed-revision retention: keep the newest N unpinned revisions per
 *      project (default 20) but NEVER the head and NEVER the newest committed
 *      'full' snapshot (mandate §4: the last full snapshot is protected),
 *   5. low-frequency R2↔D1 reconciliation over the projects/ prefix,
 *      deleting objects >48h old that no project_files row references.
 *
 * PINNED REVISIONS ARE NEVER PRUNED OR PURGED (P1-09, worker/api/pins.ts).
 * A revision held by a request, an order or the owner's "keep this version"
 * survives every step above: purgeRevisionById refuses it, retention keeps it
 * outside the N count, and a deleted project past retention is purged only
 * down to its pinned revisions — the project row stays behind as a deleted
 * tombstone holding them (never listed, never restorable, still owner-scoped)
 * and is not selected again until something unpinned is left to reclaim.
 * The pins table's foreign key makes the database refuse such a delete too.
 *
 * Archived projects (project_archive) are NOT deleted and nothing here
 * touches them; only their archive row goes when the project itself is
 * purged after a delete.
 *
 * Wiring: studio/worker/index.ts exports the `scheduled` handler calling
 * scheduledCleanup, and studio/wrangler.jsonc carries the hourly cron
 * (`triggers.crons`).
 */
import { type StudioApiCtx, type StudioApiEnv, ensureStudioTables, nowIso } from "./router";
import { studioLimits } from "./quota";
import { isRevisionPinned } from "./pins";
import { purgeStaleRateLimitWindows } from "./ratelimit";

export interface CleanupReport {
  expired_sessions: number;
  /** P1-10: rate-limit windows older than a day. */
  expired_rate_limit_windows: number;
  purged_revisions: number;
  purged_files: number;
  purged_projects: number;
  pruned_committed_revisions: number;
  /** Revisions a step would have reclaimed but a pin held (never purged). */
  kept_pinned_revisions: number;
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
 * a project head — the commit crash-recovery path owns that window — and a
 * revision that any holder pins (P1-09: pinned revisions are never purged).
 */
export async function purgeRevisionById(db: D1Database, bucket: R2Bucket, revisionId: string): Promise<number> {
  const isHead = await db
    .prepare(`SELECT 1 AS x FROM projects WHERE head_revision_id = ? LIMIT 1`)
    .bind(revisionId)
    .first();
  if (isHead) return 0;
  if (await isRevisionPinned(db, revisionId)) return 0;

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

/**
 * Purges a soft-deleted, past-retention project. Every unpinned revision goes;
 * pinned revisions stay, and while any remains the project row stays as a
 * deleted tombstone that owns them (the revision rows reference it).
 */
async function purgeProject(
  db: D1Database,
  bucket: R2Bucket,
  projectId: string
): Promise<{ files: number; purged: boolean; keptPinned: number }> {
  // Break the head reference first so purgeRevisionById can take every
  // revision of this (already soft-deleted, past-retention) project.
  await db.prepare(`UPDATE projects SET head_revision_id = NULL, thumbnail_key = NULL WHERE id = ?`).bind(projectId).run();
  const { results } = await db
    .prepare(
      `SELECT r.id, EXISTS (SELECT 1 FROM project_revision_pins k WHERE k.revision_id = r.id) AS pinned
         FROM project_revisions r WHERE r.project_id = ?`
    )
    .bind(projectId)
    .all<{ id: string; pinned: number }>();
  let files = 0;
  let keptPinned = 0;
  for (const rev of results || []) {
    if (rev.pinned) {
      keptPinned += 1;
      continue;
    }
    files += await purgeRevisionById(db, bucket, rev.id);
  }
  if (keptPinned > 0) return { files, purged: false, keptPinned };
  await db.prepare(`DELETE FROM project_archive WHERE project_id = ?`).bind(projectId).run();
  await db.prepare(`DELETE FROM projects WHERE id = ?`).bind(projectId).run();
  return { files, purged: true, keptPinned: 0 };
}

async function revisionExists(db: D1Database, revisionId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 AS x FROM project_revisions WHERE id = ?`).bind(revisionId).first());
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
    expired_rate_limit_windows: 0,
    purged_revisions: 0,
    purged_files: 0,
    purged_projects: 0,
    pruned_committed_revisions: 0,
    kept_pinned_revisions: 0,
    reconciled_orphan_objects: 0,
  };

  // The P1-09 side tables (pins, archive) may not exist yet on a database the
  // 0001 migration has not reached; the API bootstrap creates them
  // idempotently, and the cron must not depend on an API call having run.
  await ensureStudioTables(db);

  // 1. Expired sessions (table owned by the auth layer; tolerate its absence).
  try {
    const res = await db.prepare(`DELETE FROM studio_sessions WHERE expires_at < ?`).bind(nowIso()).run();
    report.expired_sessions = res.meta.changes ?? 0;
  } catch {
    /* studio_sessions not provisioned yet — nothing to clean */
  }
  report.expired_rate_limit_windows = await purgeStaleRateLimitWindows(db, now);

  if (!bucket) return report; // Without R2 there are no objects to reclaim.

  // 2. Abandoned revisions + stale pendings past the TTL.
  const pendingCutoff = isoAgo(now, limits.pendingTtlMs);
  const { results: staleRevs } = await db
    .prepare(
      `SELECT id FROM project_revisions
        WHERE (state = 'abandoned' OR (state = 'pending' AND created_at < ?))
          AND id NOT IN (SELECT head_revision_id FROM projects WHERE head_revision_id IS NOT NULL)
          AND id NOT IN (SELECT revision_id FROM project_revision_pins)
        LIMIT ${MAX_REVISIONS_PER_RUN}`
    )
    .bind(pendingCutoff)
    .all<{ id: string }>();
  for (const rev of staleRevs || []) {
    report.purged_files += await purgeRevisionById(db, bucket, rev.id);
    report.purged_revisions += 1;
  }

  // 3. Soft-deleted projects past retention — only those with something left
  //    to reclaim: a tombstone holding nothing but pinned revisions is not
  //    selected again (it would starve the per-run cap forever).
  const deletedCutoff = isoAgo(now, limits.deletedRetentionMs);
  const { results: deadProjects } = await db
    .prepare(
      `SELECT p.id FROM projects p
        WHERE p.deleted_at IS NOT NULL AND p.deleted_at < ?
          AND (p.head_revision_id IS NOT NULL
               OR NOT EXISTS (SELECT 1 FROM project_revisions r
                               WHERE r.project_id = p.id
                                 AND r.id IN (SELECT revision_id FROM project_revision_pins))
               OR EXISTS (SELECT 1 FROM project_revisions r
                           WHERE r.project_id = p.id
                             AND r.id NOT IN (SELECT revision_id FROM project_revision_pins)))
        LIMIT ${MAX_PROJECTS_PER_RUN}`
    )
    .bind(deletedCutoff)
    .all<{ id: string }>();
  for (const project of deadProjects || []) {
    const result = await purgeProject(db, bucket, project.id);
    report.purged_files += result.files;
    if (result.purged) report.purged_projects += 1;
    report.kept_pinned_revisions += result.keptPinned;
  }

  // 4. Committed-revision retention: keep the newest N UNPINNED revisions;
  //    pinned revisions sit outside that count and are always kept, as are
  //    the head and the newest committed 'full' snapshot. Only projects with
  //    more than N unpinned committed revisions are selected, so pins alone
  //    can never keep a project in the queue.
  const { results: crowded } = await db
    .prepare(
      `SELECT project_id, COUNT(*) AS n FROM project_revisions
        WHERE state = 'committed' AND id NOT IN (SELECT revision_id FROM project_revision_pins)
        GROUP BY project_id HAVING n > ? LIMIT ${MAX_RETENTION_PROJECTS_PER_RUN}`
    )
    .bind(limits.keepCommittedRevisions)
    .all<{ project_id: string; n: number }>();
  for (const entry of crowded || []) {
    const { results: committed } = await db
      .prepare(
        `SELECT r.id, r.snapshot_kind, p.head_revision_id AS head_id,
                EXISTS (SELECT 1 FROM project_revision_pins k WHERE k.revision_id = r.id) AS pinned
           FROM project_revisions r JOIN projects p ON p.id = r.project_id
          WHERE r.project_id = ? AND r.state = 'committed'
          ORDER BY r.revision DESC`
      )
      .bind(entry.project_id)
      .all<{ id: string; snapshot_kind: string; head_id: string | null; pinned: number }>();
    const rows = committed || [];
    const unpinned = rows.filter((r) => !r.pinned);
    const keep = new Set<string>(unpinned.slice(0, limits.keepCommittedRevisions).map((r) => r.id));
    for (const r of rows) if (r.pinned) keep.add(r.id);
    const newestFull = rows.find((r) => r.snapshot_kind === "full");
    if (newestFull) keep.add(newestFull.id);
    if (rows[0]?.head_id) keep.add(rows[0].head_id);
    for (const r of rows) {
      if (keep.has(r.id)) continue;
      const files = await purgeRevisionById(db, bucket, r.id);
      // purgeRevisionById re-checks head and pins at delete time; a revision
      // pinned between the read above and now is kept, and counted as such.
      if (await revisionExists(db, r.id)) {
        report.kept_pinned_revisions += 1;
        continue;
      }
      report.purged_files += files;
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
