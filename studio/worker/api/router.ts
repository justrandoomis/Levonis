/**
 * LEVO Studio storage API router (docs/STUDIO_PLAN.md, decision 4 + slice S3).
 *
 * Mounted by worker/index.ts BEFORE vinext delegation for every /api/* path:
 *
 *   apiRouter(request, env, ctx, session)
 *
 * `session` is the Studio session already validated by worker/auth/session.ts
 * (null for guests — guest editing stays fully client-side; every account
 * endpoint here requires a session and answers 401 otherwise).
 *
 * Protocol implemented across worker/api/*:
 *   OPEN    POST /api/projects/:id/revisions       (projects.ts)
 *   UPLOAD  PUT  /api/uploads/:fileId              (uploads.ts)
 *   COMMIT  POST /api/projects/:id/revisions/:revId/commit
 *   READ    GET  /api/projects/:id/files/:fileId, /thumbnail, /revisions...
 *   CLEANUP runCleanup / scheduled handler         (cleanup.ts)
 *
 * Security invariants (mandate §4, tests T3/T6):
 *   - EVERY read/write/thumbnail/old-revision/export checks ownership in D1
 *     (queries always filter on owner_id; a non-owner sees 404, never data).
 *   - R2 keys are server-generated only; no public or signed R2 URLs — every
 *     byte streams through this worker.
 *   - Optimistic concurrency via base revision: conflicting commits get 409
 *     with the server head, never a silent clobber.
 *   - All /api responses are `Cache-Control: private, no-store` (mandate §13).
 */
import type { StudioSession } from "../auth/session";
import { handleProjectsRoute } from "./projects";
import { handleUploadRoute } from "./uploads";
import { handleQuotaRoute } from "./quota";

// Environment contract ---------------------------------------------------------

/**
 * Bindings/vars the storage API needs from studio/wrangler.jsonc.
 * `BUCKET` is optional in the TYPE only so the worker entry's narrower Env
 * still typechecks; at runtime a missing binding produces an honest 503
 * (STORAGE_NOT_CONFIGURED), never a fake success.
 * The STUDIO_* vars are the declared, configurable limits (see quota.ts for
 * defaults and the pending owner decision on the numbers).
 */
export interface StudioApiEnv {
  DB: D1Database;
  BUCKET?: R2Bucket;
  STUDIO_USER_QUOTA_BYTES?: string;
  STUDIO_MAX_FILE_BYTES?: string;
  STUDIO_THUMBNAIL_MAX_BYTES?: string;
  STUDIO_MAX_FILES_PER_REVISION?: string;
  STUDIO_MAX_MANIFEST_BYTES?: string;
  STUDIO_PENDING_TTL_HOURS?: string;
  STUDIO_DELETED_RETENTION_DAYS?: string;
  STUDIO_KEEP_COMMITTED_REVISIONS?: string;
}

/** Minimal execution-context surface the API uses (structural match). */
export interface StudioApiCtx {
  waitUntil(promise: Promise<unknown>): void;
}

// Shared helpers ---------------------------------------------------------------

const NO_STORE = "private, no-store";

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": NO_STORE,
      ...extraHeaders,
    },
  });
}

export function apiError(status: number, code: string, error: string, extra?: Record<string, unknown>): Response {
  return jsonResponse({ success: false, code, error, ...extra }, status);
}

export function methodNotAllowed(allow: string): Response {
  return jsonResponse({ success: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" }, 405, {
    Allow: allow,
  });
}

/** 32-hex-char random id (also the last path segment of R2 keys). */
export function newId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Server-generated ids only — anything else short-circuits to 404. */
const ID_RE = /^[0-9a-f]{16,64}$/;
export function isValidId(value: string): boolean {
  return ID_RE.test(value);
}

/**
 * R2 key layout (plan decision 4): server-generated only, never accepted from
 * a client. Every object is reachable from its project_files row.
 */
export function r2KeyFor(projectId: string, revisionId: string, fileId: string): string {
  return `projects/${projectId}/rev/${revisionId}/${fileId}`;
}

/** Honest 503 when the R2 binding is not wired (never a fake success). */
export function requireBucket(env: StudioApiEnv): R2Bucket | Response {
  if (!env.BUCKET) {
    return apiError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Project file storage (R2) is not configured on this deployment. Local editing keeps working."
    );
  }
  return env.BUCKET;
}

// Table bootstrap --------------------------------------------------------------
//
// The generated migration in studio/drizzle/ is the source of truth and is
// applied by the deploy workflows. This idempotent mirror (IF NOT EXISTS,
// same DDL) only exists so `wrangler dev`/preview databases that never ran
// the migration pipeline fail soft instead of 500ing — the same pattern
// worker/auth/session.ts uses for studio_sessions. Keep it byte-equivalent
// to drizzle/0000_studio_projects.sql; tests exercise both paths.

const TABLE_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    thumbnail_key text,
    schema_version integer NOT NULL,
    head_revision_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    last_saved_at text,
    deleted_at text
  )`,
  "CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects (owner_id,updated_at)",
  `CREATE TABLE IF NOT EXISTS project_revisions (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    revision integer NOT NULL,
    parent_revision integer,
    schema_version integer,
    engine_version text,
    content_hash text NOT NULL,
    size_bytes integer,
    manifest_json text NOT NULL,
    snapshot_kind text NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    created_at text NOT NULL,
    committed_at text,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    CONSTRAINT chk_project_revisions_snapshot_kind CHECK(snapshot_kind IN ('full','source-only')),
    CONSTRAINT chk_project_revisions_state CHECK(state IN ('pending','committed','abandoned'))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_project_revisions_project_revision ON project_revisions (project_id,revision)",
  "CREATE INDEX IF NOT EXISTS idx_project_revisions_state_created ON project_revisions (state,created_at)",
  `CREATE TABLE IF NOT EXISTS project_files (
    id text PRIMARY KEY NOT NULL,
    revision_id text NOT NULL,
    kind text NOT NULL,
    r2_key text NOT NULL,
    sha256 text NOT NULL,
    size_bytes integer NOT NULL,
    content_type text,
    state text DEFAULT 'pending' NOT NULL,
    created_at text NOT NULL,
    FOREIGN KEY (revision_id) REFERENCES project_revisions(id),
    CONSTRAINT chk_project_files_kind CHECK(kind IN ('snapshot3mf','source','thumbnail','asset')),
    CONSTRAINT chk_project_files_state CHECK(state IN ('pending','verified'))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS project_files_r2_key_unique ON project_files (r2_key)",
  "CREATE INDEX IF NOT EXISTS idx_project_files_revision ON project_files (revision_id)",
  "CREATE INDEX IF NOT EXISTS idx_project_files_state_created ON project_files (state,created_at)",
];

let tablesEnsured = false;

export async function ensureStudioTables(db: D1Database): Promise<void> {
  if (tablesEnsured) return;
  for (const sql of TABLE_SQL) await db.prepare(sql).run();
  tablesEnsured = true;
}

/** Test hook: force the next ensureStudioTables call to run again. */
export function resetEnsuredTablesForTests(): void {
  tablesEnsured = false;
}

// Router -----------------------------------------------------------------------

function requireSession(session: StudioSession | null): Response | StudioSession {
  if (!session) {
    return apiError(
      401,
      "AUTH_REQUIRED",
      "Sign in to use account project storage. Guest editing keeps working locally."
    );
  }
  return session;
}

/**
 * Entry point mounted by worker/index.ts. The caller has already stripped
 * untrusted `oai-` / `x-levo-` prefixed headers and wraps the returned
 * response with the global security headers.
 */
export async function apiRouter(
  request: Request,
  env: StudioApiEnv,
  ctx: StudioApiCtx,
  session: StudioSession | null
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // segments[0] === 'api' — guaranteed by the mount, but never assumed.
  if (segments[0] !== "api") return apiError(404, "NOT_FOUND", "Not found");
  const rest = segments.slice(1);

  try {
    if (rest.length === 1 && rest[0] === "health") {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      // Honest capability report — no claimed bindings that are not there.
      return jsonResponse({ success: true, service: "levo-studio-api", d1: Boolean(env.DB), r2: Boolean(env.BUCKET) });
    }

    if (rest.length === 1 && rest[0] === "quota") {
      const s = requireSession(session);
      if (s instanceof Response) return s;
      if (request.method !== "GET") return methodNotAllowed("GET");
      await ensureStudioTables(env.DB);
      return handleQuotaRoute(env, s);
    }

    if (rest[0] === "projects") {
      const s = requireSession(session);
      if (s instanceof Response) return s;
      await ensureStudioTables(env.DB);
      return handleProjectsRoute(request, env, ctx, s, rest.slice(1));
    }

    if (rest[0] === "uploads" && rest.length === 2) {
      const s = requireSession(session);
      if (s instanceof Response) return s;
      await ensureStudioTables(env.DB);
      return handleUploadRoute(request, env, s, rest[1]);
    }

    return apiError(404, "NOT_FOUND", "Not found");
  } catch (error) {
    // Never leak internals (and there are no tokens to log here by design).
    console.error("studio api error:", request.method, url.pathname, error);
    return apiError(500, "INTERNAL", "Internal error");
  }
}
