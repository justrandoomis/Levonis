/**
 * Declared storage limits and per-user quota (docs/STUDIO_PLAN.md decision 4,
 * mandate §4: "حدود معلنة وقابلة للضبط للحجم والتخزين؛ لا تعد بحفظ غير محدود").
 *
 * Every number below is CONFIGURABLE through wrangler vars (studio/
 * wrangler.jsonc "vars", overridable per environment) and ships with an
 * honest, conservative default. The final production numbers are a PENDING
 * OWNER DECISION — the plan's CLEANUP step places per-user quota and
 * committed-revision retention "ضمن قرارات المالك" (docs/STUDIO_PLAN.md,
 * decision 4; a register row for it belongs in docs/DECISIONS.md). Until the
 * owner decides, these defaults apply and the UI must present them as the
 * current limits, not as promises.
 */
import type { StudioSession } from "../auth/session";
import { type StudioApiEnv, jsonResponse } from "./router";

export interface StudioLimits {
  /** Total bytes of stored project files per user (default 200 MiB). */
  userQuotaBytes: number;
  /** Largest single file accepted at OPEN (default 64 MiB — Workers-friendly). */
  maxFileBytes: number;
  /** Largest thumbnail accepted (default 4 MiB). */
  thumbnailMaxBytes: number;
  /** Files per revision (default 64). */
  maxFilesPerRevision: number;
  /** Serialized manifest_json budget (default 256 KiB). */
  maxManifestBytes: number;
  /** Pending revisions older than this are orphans for the cleanup cron (default 24h). */
  pendingTtlMs: number;
  /** Soft-deleted projects are purged after this (default 30 days). */
  deletedRetentionMs: number;
  /** Committed revisions kept per project, head + latest full always kept (default 20). */
  keepCommittedRevisions: number;
}

function intVar(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const MiB = 1024 * 1024;

export function studioLimits(env: StudioApiEnv): StudioLimits {
  return {
    userQuotaBytes: intVar(env.STUDIO_USER_QUOTA_BYTES, 200 * MiB, 1 * MiB, 100 * 1024 * MiB),
    maxFileBytes: intVar(env.STUDIO_MAX_FILE_BYTES, 64 * MiB, 1024, 512 * MiB),
    thumbnailMaxBytes: intVar(env.STUDIO_THUMBNAIL_MAX_BYTES, 4 * MiB, 1024, 32 * MiB),
    maxFilesPerRevision: intVar(env.STUDIO_MAX_FILES_PER_REVISION, 64, 1, 512),
    maxManifestBytes: intVar(env.STUDIO_MAX_MANIFEST_BYTES, 256 * 1024, 1024, 8 * MiB),
    pendingTtlMs: intVar(env.STUDIO_PENDING_TTL_HOURS, 24, 1, 24 * 30) * 3_600_000,
    deletedRetentionMs: intVar(env.STUDIO_DELETED_RETENTION_DAYS, 30, 1, 3650) * 86_400_000,
    keepCommittedRevisions: intVar(env.STUDIO_KEEP_COMMITTED_REVISIONS, 20, 1, 1000),
  };
}

/**
 * Bytes currently held for one owner: every project_files row of every
 * revision of every not-yet-purged project, pending reservations included —
 * pending uploads occupy real R2 space, so counting them prevents quota
 * overshoot through parallel OPENs. Soft-deleted projects still count until
 * the cleanup cron purges them (their bytes are genuinely still stored).
 */
export async function ownerUsageBytes(db: D1Database, ownerId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(f.size_bytes), 0) AS used
         FROM project_files f
         JOIN project_revisions r ON r.id = f.revision_id
         JOIN projects p ON p.id = r.project_id
        WHERE p.owner_id = ?`
    )
    .bind(ownerId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/** GET /api/quota — the UI shows real numbers, never "unlimited". */
export async function handleQuotaRoute(env: StudioApiEnv, session: StudioSession): Promise<Response> {
  const limits = studioLimits(env);
  const used = await ownerUsageBytes(env.DB, session.user.id);
  return jsonResponse({
    success: true,
    usage_bytes: used,
    quota_bytes: limits.userQuotaBytes,
    remaining_bytes: Math.max(0, limits.userQuotaBytes - used),
    limits: {
      max_file_bytes: limits.maxFileBytes,
      thumbnail_max_bytes: limits.thumbnailMaxBytes,
      max_files_per_revision: limits.maxFilesPerRevision,
      max_manifest_bytes: limits.maxManifestBytes,
      kept_committed_revisions: limits.keepCommittedRevisions,
    },
    // Honest provenance: defaults, adjustable per environment, final numbers
    // pending an owner decision (docs/STUDIO_PLAN.md decision 4).
    configurable: true,
  });
}
