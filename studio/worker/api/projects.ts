/**
 * /api/projects/* — project metadata, the revision protocol (OPEN / COMMIT /
 * ABANDON) and ownership-checked reads (docs/STUDIO_PLAN.md decision 4).
 *
 * Ownership: every SQL statement in this file filters on p.owner_id — a
 * non-owner (or a guessed id) gets 404 with zero information leakage, which
 * is what acceptance test T3 demands. Reads of files and thumbnails resolve
 * the D1 row FIRST and only then stream the private R2 object through the
 * worker (no public/signed R2 URLs).
 *
 * Optimistic concurrency (T6): a revision records the base (parent_revision)
 * it was opened from. OPEN fails fast with 409 when the head has already
 * moved; COMMIT re-checks and swaps the head with a compare-and-set UPDATE —
 * the loser of a race receives 409 plus the server head so the client can
 * rebase or fork. A newer version is never silently clobbered.
 *
 * Lifecycle (P1-09) — three separate states, never conflated:
 *   active    the default list;
 *   archived  POST /:id/archive · /:id/unarchive — out of the default list,
 *             fully readable and writable, NEVER deleted by archiving
 *             (project_archive side table);
 *   trash     DELETE /:id (soft) · POST /:id/restore — restorable while
 *             deleted_at is inside the retention window, after which the
 *             cleanup cron purges it (pinned revisions excepted).
 * GET /api/projects?view=active|archived|trash lists each one.
 *
 * Revision history (P1-09): GET /:id/revisions reports each revision's pins;
 * POST /:id/revisions/:rev/restore copies a kept committed revision into a
 * NEW head (never rewrites history, compare-and-set like COMMIT);
 * POST|DELETE /:id/revisions/:rev/pin is the owner's own "keep this version"
 * (worker/api/pins.ts — request/order pins are server-side only).
 */
import type { StudioSession } from "../auth/session";
import {
  type StudioApiCtx,
  type StudioApiEnv,
  apiError,
  isSha256Hex,
  isValidId,
  jsonResponse,
  methodNotAllowed,
  newId,
  nowIso,
  r2KeyFor,
  requireBucket,
} from "./router";
import { ownerUsageBytes, studioLimits } from "./quota";
import { purgeRevisionById } from "./cleanup";
import { pinReasonsFor, pinRevision, unpinRevision } from "./pins";

// Row shapes -------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  thumbnail_key: string | null;
  schema_version: number;
  head_revision_id: string | null;
  created_at: string;
  updated_at: string;
  last_saved_at: string | null;
  deleted_at: string | null;
}

export interface RevisionRow {
  id: string;
  project_id: string;
  revision: number;
  parent_revision: number | null;
  schema_version: number | null;
  engine_version: string | null;
  content_hash: string;
  size_bytes: number | null;
  manifest_json: string;
  snapshot_kind: "full" | "source-only";
  state: "pending" | "committed" | "abandoned";
  created_at: string;
  committed_at: string | null;
}

export interface FileRow {
  id: string;
  revision_id: string;
  kind: "snapshot3mf" | "source" | "thumbnail" | "asset";
  r2_key: string;
  sha256: string;
  size_bytes: number;
  content_type: string | null;
  state: "pending" | "verified";
  created_at: string;
}

const FILE_KINDS = new Set(["snapshot3mf", "source", "thumbnail", "asset"]);
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Small helpers ----------------------------------------------------------------

async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return apiError(400, "BAD_BODY", "Could not read request body");
  }
  if (text.length > maxBytes) return apiError(413, "BODY_TOO_LARGE", "Request body too large");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return apiError(400, "BAD_JSON", "Expected a JSON object body");
}

/** 1..120 visible characters, control characters stripped. */
function cleanProjectName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 120) return null;
  return name;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

interface ProjectListRow extends ProjectRow {
  head_revision: number | null;
  head_snapshot_kind: string | null;
  head_committed_at: string | null;
  archived_at: string | null;
}

/**
 * Owner-facing project DTO. `deleted_at`/`purge_after` appear only for a
 * project in the trash (the only reads that can see one), so the active and
 * archived lists carry exactly the fields they always did plus archived_at.
 */
function projectJson(row: ProjectListRow, retentionMs?: number): Record<string, unknown> {
  const trash: Record<string, unknown> = {};
  if (row.deleted_at) {
    trash.deleted_at = row.deleted_at;
    const deletedMs = Date.parse(row.deleted_at);
    if (retentionMs && Number.isFinite(deletedMs)) {
      trash.purge_after = new Date(deletedMs + retentionMs).toISOString();
    }
  }
  return {
    ...trash,
    id: row.id,
    name: row.name,
    schema_version: row.schema_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_saved_at: row.last_saved_at,
    has_thumbnail: Boolean(row.thumbnail_key),
    head_revision_id: row.head_revision_id,
    head_revision: row.head_revision,
    // Honest sync state for the UI: 'source-only' must never be presented as
    // a full snapshot (mandate §4).
    head_snapshot_kind: row.head_snapshot_kind,
    head_committed_at: row.head_committed_at,
    archived_at: row.archived_at ?? null,
  };
}

function revisionJson(row: RevisionRow, pins?: string[]): Record<string, unknown> {
  const pinInfo = pins === undefined ? {} : { pinned: pins.length > 0, pin_reasons: pins };
  return {
    ...pinInfo,
    id: row.id,
    project_id: row.project_id,
    revision: row.revision,
    parent_revision: row.parent_revision,
    schema_version: row.schema_version,
    engine_version: row.engine_version,
    content_hash: row.content_hash,
    size_bytes: row.size_bytes,
    snapshot_kind: row.snapshot_kind,
    state: row.state,
    created_at: row.created_at,
    committed_at: row.committed_at,
  };
}

function fileJson(row: FileRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    state: row.state,
    upload_url: `/api/uploads/${row.id}`,
  };
}

const PROJECT_SELECT = `SELECT p.*, h.revision AS head_revision, h.snapshot_kind AS head_snapshot_kind,
       h.committed_at AS head_committed_at, a.archived_at AS archived_at
  FROM projects p
  LEFT JOIN project_revisions h ON h.id = p.head_revision_id
  LEFT JOIN project_archive a ON a.project_id = p.id`;

/** Owner-scoped project load; null ⇒ respond 404 (existence never revealed). */
async function loadOwnedProject(
  env: StudioApiEnv,
  ownerId: string,
  projectId: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<ProjectListRow | null> {
  const where = opts.includeDeleted ? "" : " AND p.deleted_at IS NULL";
  return await env.DB.prepare(`${PROJECT_SELECT} WHERE p.id = ? AND p.owner_id = ?${where}`)
    .bind(projectId, ownerId)
    .first<ProjectListRow>();
}

const notFound = () => apiError(404, "NOT_FOUND", "Not found");

// Route dispatch ----------------------------------------------------------------

/** rest = path segments after "/api/projects". */
export async function handleProjectsRoute(
  request: Request,
  env: StudioApiEnv,
  ctx: StudioApiCtx,
  session: StudioSession,
  rest: string[]
): Promise<Response> {
  if (rest.length === 0) {
    if (request.method === "GET") return listProjects(request, env, session);
    if (request.method === "POST") return createProject(request, env, session);
    return methodNotAllowed("GET, POST");
  }

  const projectId = rest[0];
  if (!isValidId(projectId)) return notFound();

  if (rest.length === 1) {
    if (request.method === "GET") return getProject(env, session, projectId);
    if (request.method === "PATCH") return renameProject(request, env, session, projectId);
    if (request.method === "DELETE") return deleteProject(env, session, projectId);
    return methodNotAllowed("GET, PATCH, DELETE");
  }

  if (rest.length === 2 && rest[1] === "duplicate") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return duplicateProject(request, env, session, projectId);
  }

  if (rest.length === 2 && (rest[1] === "archive" || rest[1] === "unarchive")) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return setArchived(env, session, projectId, rest[1] === "archive");
  }

  if (rest.length === 2 && rest[1] === "restore") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return restoreFromTrash(env, session, projectId);
  }

  if (rest.length === 2 && rest[1] === "thumbnail") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return getThumbnail(request, env, session, projectId);
  }

  if (rest[1] === "revisions") {
    if (rest.length === 2) {
      if (request.method === "GET") return listRevisions(request, env, session, projectId);
      if (request.method === "POST") return openRevision(request, env, session, projectId);
      return methodNotAllowed("GET, POST");
    }
    const revisionId = rest[2];
    if (!isValidId(revisionId)) return notFound();
    if (rest.length === 3) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getRevision(env, session, projectId, revisionId);
    }
    if (rest.length === 4 && rest[3] === "commit") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return commitRevision(env, session, projectId, revisionId);
    }
    if (rest.length === 4 && rest[3] === "abandon") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return abandonRevision(env, ctx, session, projectId, revisionId);
    }
    if (rest.length === 4 && rest[3] === "restore") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return restoreRevision(request, env, session, projectId, revisionId);
    }
    if (rest.length === 4 && rest[3] === "pin") {
      if (request.method === "POST") return setUserPin(env, session, projectId, revisionId, true);
      if (request.method === "DELETE") return setUserPin(env, session, projectId, revisionId, false);
      return methodNotAllowed("POST, DELETE");
    }
    return notFound();
  }

  if (rest.length === 3 && rest[1] === "files") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const fileId = rest[2];
    if (!isValidId(fileId)) return notFound();
    return getFile(request, env, session, projectId, fileId);
  }

  return notFound();
}

// Projects ----------------------------------------------------------------------

const PROJECT_VIEWS = new Set(["active", "archived", "trash"]);

/**
 * GET /api/projects?view=active|archived|trash (default active).
 * The trash lists only what is still restorable (inside the retention window);
 * anything older is the cleanup cron's, and never offered as restorable.
 */
async function listProjects(request: Request, env: StudioApiEnv, session: StudioSession): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
  const limit = intParam(url.searchParams.get("limit"), 50, 1, 100);
  const offset = intParam(url.searchParams.get("offset"), 0, 0, 100_000);
  const view = url.searchParams.get("view") || "active";
  if (!PROJECT_VIEWS.has(view)) return apiError(400, "BAD_VIEW", "view must be active, archived or trash");
  const limits = studioLimits(env);

  const filters: string[] = ["p.owner_id = ?"];
  const binds: unknown[] = [session.user.id];
  if (view === "trash") {
    filters.push("p.deleted_at IS NOT NULL", "p.deleted_at >= ?");
    binds.push(new Date(Date.now() - limits.deletedRetentionMs).toISOString());
  } else {
    filters.push("p.deleted_at IS NULL", view === "archived" ? "a.project_id IS NOT NULL" : "a.project_id IS NULL");
  }
  if (q) {
    filters.push("p.name LIKE ? ESCAPE '\\'");
    binds.push(`%${escapeLike(q)}%`);
  }
  const order = view === "trash" ? "p.deleted_at DESC" : view === "archived" ? "a.archived_at DESC" : "p.updated_at DESC";

  const { results } = await env.DB.prepare(
    `${PROJECT_SELECT} WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all<ProjectListRow>();

  return jsonResponse({
    success: true,
    view,
    projects: (results || []).map((row) => projectJson(row, limits.deletedRetentionMs)),
    limit,
    offset,
    ...(view === "trash" ? { retention_days: Math.round(limits.deletedRetentionMs / 86_400_000) } : {}),
  });
}

async function createProject(request: Request, env: StudioApiEnv, session: StudioSession): Promise<Response> {
  const body = await readJsonBody(request, 16 * 1024);
  if (body instanceof Response) return body;
  const name = cleanProjectName(body.name);
  if (!name) return apiError(400, "BAD_NAME", "Project name must be 1-120 characters");
  const schemaVersion =
    typeof body.schema_version === "number" && Number.isInteger(body.schema_version) && body.schema_version >= 1 && body.schema_version <= 1000
      ? body.schema_version
      : 1;

  const id = newId();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO projects (id, owner_id, name, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, session.user.id, name, schemaVersion, now, now)
    .run();

  const row = await loadOwnedProject(env, session.user.id, id);
  return jsonResponse({ success: true, project: row ? projectJson(row) : { id, name } }, 201);
}

async function getProject(env: StudioApiEnv, session: StudioSession, projectId: string): Promise<Response> {
  const row = await loadOwnedProject(env, session.user.id, projectId);
  if (!row) return notFound();
  return jsonResponse({ success: true, project: projectJson(row) });
}

async function renameProject(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string
): Promise<Response> {
  const body = await readJsonBody(request, 16 * 1024);
  if (body instanceof Response) return body;
  const name = cleanProjectName(body.name);
  if (!name) return apiError(400, "BAD_NAME", "Project name must be 1-120 characters");

  const result = await env.DB.prepare(
    `UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`
  )
    .bind(name, nowIso(), projectId, session.user.id)
    .run();
  if (!result.meta.changes) return notFound();
  const row = await loadOwnedProject(env, session.user.id, projectId);
  return jsonResponse({ success: true, project: row ? projectJson(row) : { id: projectId, name } });
}

/**
 * Soft delete (move to trash): the row is marked and disappears from every
 * read except the trash list; POST /:id/restore brings it back while it is
 * inside the retention window, after which the cleanup cron purges rows + R2
 * objects (pinned revisions excepted). Archive is a different action and
 * never reaches this path.
 */
async function deleteProject(env: StudioApiEnv, session: StudioSession, projectId: string): Promise<Response> {
  const existing = await loadOwnedProject(env, session.user.id, projectId, { includeDeleted: true });
  if (!existing) return notFound();
  const retentionMs = studioLimits(env).deletedRetentionMs;
  const purgeAfter = (deletedAt: string) => new Date(Date.parse(deletedAt) + retentionMs).toISOString();
  if (existing.deleted_at) {
    return jsonResponse({
      success: true,
      already: true,
      deleted_at: existing.deleted_at,
      purge_after: purgeAfter(existing.deleted_at),
    });
  }
  const now = nowIso();
  await env.DB.prepare(`UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?`)
    .bind(now, now, projectId, session.user.id)
    .run();
  return jsonResponse({ success: true, deleted_at: now, purge_after: purgeAfter(now) });
}

/**
 * Archive / unarchive. Only a live (not deleted) owned project; idempotent.
 * Archiving changes no content, so updated_at — the active list's order —
 * is left alone.
 */
async function setArchived(
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string,
  archived: boolean
): Promise<Response> {
  const existing = await loadOwnedProject(env, session.user.id, projectId);
  if (!existing) return notFound();
  if (archived) {
    await env.DB.prepare(`INSERT OR IGNORE INTO project_archive (project_id, archived_at) VALUES (?, ?)`)
      .bind(projectId, nowIso())
      .run();
  } else {
    await env.DB.prepare(`DELETE FROM project_archive WHERE project_id = ?`).bind(projectId).run();
  }
  const row = await loadOwnedProject(env, session.user.id, projectId);
  return jsonResponse({ success: true, project: row ? projectJson(row) : { id: projectId } });
}

/**
 * Restore from the trash, only inside the retention window. Past it the
 * project belongs to the cleanup cron (which may already have purged it, or
 * kept only its pinned revisions) and the honest answer is 410.
 */
async function restoreFromTrash(env: StudioApiEnv, session: StudioSession, projectId: string): Promise<Response> {
  const existing = await loadOwnedProject(env, session.user.id, projectId, { includeDeleted: true });
  if (!existing) return notFound();
  if (!existing.deleted_at) {
    return jsonResponse({ success: true, already: true, project: projectJson(existing) });
  }
  const cutoff = new Date(Date.now() - studioLimits(env).deletedRetentionMs).toISOString();
  const result = await env.DB.prepare(
    `UPDATE projects SET deleted_at = NULL, updated_at = ?
      WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ?`
  )
    .bind(nowIso(), projectId, session.user.id, cutoff)
    .run();
  if (!result.meta.changes) {
    return apiError(410, "RETENTION_EXPIRED", "This project is past the restore window");
  }
  const row = await loadOwnedProject(env, session.user.id, projectId);
  return jsonResponse({ success: true, project: row ? projectJson(row) : { id: projectId } });
}

/**
 * Duplicates a project's head committed revision into a brand-new project
 * (copying R2 objects — quota-checked). A project without a committed head
 * duplicates as an empty project.
 */
async function duplicateProject(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string
): Promise<Response> {
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const body = await readJsonBody(request, 16 * 1024);
  if (body instanceof Response) return body;

  const src = await loadOwnedProject(env, session.user.id, projectId);
  if (!src) return notFound();
  const name = cleanProjectName(body.name) || `${src.name}`.slice(0, 110) + " (2)";

  const now = nowIso();
  const newProjectId = newId();

  const head = src.head_revision_id
    ? await env.DB.prepare(`SELECT * FROM project_revisions WHERE id = ? AND project_id = ? AND state = 'committed'`)
        .bind(src.head_revision_id, src.id)
        .first<RevisionRow>()
    : null;

  if (!head) {
    await env.DB.prepare(
      `INSERT INTO projects (id, owner_id, name, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(newProjectId, session.user.id, name, src.schema_version, now, now)
      .run();
    const row = await loadOwnedProject(env, session.user.id, newProjectId);
    return jsonResponse({ success: true, project: row ? projectJson(row) : { id: newProjectId, name } }, 201);
  }

  const { results: srcFiles } = await env.DB.prepare(
    `SELECT * FROM project_files WHERE revision_id = ? AND state = 'verified'`
  )
    .bind(head.id)
    .all<FileRow>();
  const files = srcFiles || [];

  const totalSize = files.reduce((sum, f) => sum + f.size_bytes, 0);
  const limits = studioLimits(env);
  const used = await ownerUsageBytes(env.DB, session.user.id);
  if (used + totalSize > limits.userQuotaBytes) {
    return apiError(413, "QUOTA_EXCEEDED", "Storage quota exceeded", {
      usage_bytes: used,
      quota_bytes: limits.userQuotaBytes,
      requested_bytes: totalSize,
    });
  }

  // RESERVE BEFORE COPYING (as an OPEN does): the new project — headless,
  // exactly like any new empty project — its 'pending' revision and 'pending'
  // file rows go in right after the quota check, so ownerUsageBytes counts
  // these bytes for the whole R2 copy window and a parallel OPEN, restore or
  // duplicate cannot push the account past its quota. On any failure the
  // reservation goes through the purge path and the empty shell is removed;
  // a worker that dies mid-copy leaves a pending revision the cleanup cron
  // reclaims (step 2) and an empty project the owner can see and delete.
  const newRevisionId = newId();
  const copies: Array<{ src: FileRow; newId: string; newKey: string }> = files.map((f) => {
    const fileId = newId();
    return { src: f, newId: fileId, newKey: r2KeyFor(newProjectId, newRevisionId, fileId) };
  });
  const thumbCopy = copies.find((c) => c.src.kind === "thumbnail");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO projects (id, owner_id, name, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(newProjectId, session.user.id, name, src.schema_version, now, now),
    env.DB.prepare(
      `INSERT INTO project_revisions (id, project_id, revision, parent_revision, schema_version, engine_version, content_hash, size_bytes, manifest_json, snapshot_kind, state, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      newRevisionId,
      newProjectId,
      head.schema_version,
      head.engine_version,
      head.content_hash,
      head.size_bytes,
      head.manifest_json,
      head.snapshot_kind,
      now
    ),
    ...copies.map((c) =>
      env.DB.prepare(
        `INSERT INTO project_files (id, revision_id, kind, r2_key, sha256, size_bytes, content_type, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).bind(c.newId, newRevisionId, c.src.kind, c.newKey, c.src.sha256, c.src.size_bytes, c.src.content_type, now)
    ),
  ]);
  const releaseReservation = async () => {
    await purgeRevisionById(env.DB, bucket, newRevisionId).catch(() => 0);
    // The empty shell goes too, unless something else landed in it meanwhile.
    await env.DB.prepare(
      `DELETE FROM projects WHERE id = ? AND owner_id = ? AND head_revision_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM project_revisions WHERE project_id = ?)
          AND NOT EXISTS (SELECT 1 FROM project_archive WHERE project_id = ?)`
    )
      .bind(newProjectId, session.user.id, newProjectId, newProjectId)
      .run()
      .catch(() => undefined);
  };

  try {
    for (const copy of copies) {
      const obj = await bucket.get(copy.src.r2_key);
      if (!obj) {
        await releaseReservation();
        return apiError(502, "SOURCE_OBJECT_MISSING", "A stored file is missing; the project cannot be duplicated");
      }
      const data = await obj.arrayBuffer();
      await bucket.put(copy.newKey, data, {
        httpMetadata: copy.src.content_type ? { contentType: copy.src.content_type } : undefined,
      });
    }
    await env.DB.prepare(`UPDATE project_files SET state = 'verified' WHERE revision_id = ? AND state = 'pending'`)
      .bind(newRevisionId)
      .run();
  } catch (error) {
    await releaseReservation();
    throw error;
  }

  // The copy becomes the new project's head by the same guarded CAS COMMIT
  // uses (a device that saved into the fresh project meanwhile wins).
  const cas = await env.DB.prepare(
    `UPDATE projects
        SET head_revision_id = ?, thumbnail_key = ?, last_saved_at = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND head_revision_id IS NULL
        AND EXISTS (SELECT 1 FROM project_revisions WHERE id = ? AND state = 'pending')`
  )
    .bind(newRevisionId, thumbCopy ? thumbCopy.newKey : null, now, now, newProjectId, session.user.id, newRevisionId)
    .run();
  if (!cas.meta.changes) {
    await releaseReservation();
    return apiError(409, "REVISION_CONFLICT", "The new project changed while it was being copied");
  }
  await env.DB.prepare(`UPDATE project_revisions SET state = 'committed', committed_at = ? WHERE id = ? AND state = 'pending'`)
    .bind(now, newRevisionId)
    .run();

  const row = await loadOwnedProject(env, session.user.id, newProjectId);
  return jsonResponse({ success: true, project: row ? projectJson(row) : { id: newProjectId, name } }, 201);
}

// Revisions ----------------------------------------------------------------------

/**
 * GET /:id/revisions[?state=committed] — newest first, each with its pins
 * (reasons only). `state=committed` is what the history sheet asks for: the
 * versions that can be opened or restored, without upload debris.
 */
async function listRevisions(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string
): Promise<Response> {
  const project = await loadOwnedProject(env, session.user.id, projectId);
  if (!project) return notFound();
  const committedOnly = new URL(request.url).searchParams.get("state") === "committed";
  const { results } = await env.DB.prepare(
    `SELECT * FROM project_revisions WHERE project_id = ?${committedOnly ? " AND state = 'committed'" : ""}
      ORDER BY revision DESC LIMIT 100`
  )
    .bind(projectId)
    .all<RevisionRow>();
  const rows = results || [];
  const pins = await pinReasonsFor(
    env.DB,
    rows.map((r) => r.id)
  );
  return jsonResponse({
    success: true,
    head_revision_id: project.head_revision_id,
    kept_committed_revisions: studioLimits(env).keepCommittedRevisions,
    revisions: rows.map((r) => revisionJson(r, pins.get(r.id) ?? [])),
  });
}

/**
 * RESTORE a kept revision as a NEW head. History is never rewritten: the
 * chosen revision's verified files are copied into a fresh revision whose
 * parent is the CURRENT head (quota-checked, and the bytes RESERVED as a
 * pending revision before the first R2 copy — as an OPEN does), and the head moves by
 * the same compare-and-set COMMIT uses — a head that moved meanwhile (another
 * device) gets 409 with the fresh head, never a silent clobber. The client
 * may send `base_revision` (its view of the head) to fail fast the same way.
 */
async function restoreRevision(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string,
  revisionId: string
): Promise<Response> {
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const body = await readJsonBody(request, 16 * 1024);
  if (body instanceof Response) return body;

  const project = await loadOwnedProject(env, session.user.id, projectId);
  if (!project) return notFound();
  const source = await env.DB.prepare(
    `SELECT * FROM project_revisions WHERE id = ? AND project_id = ? AND state = 'committed'`
  )
    .bind(revisionId, projectId)
    .first<RevisionRow>();
  if (!source) return notFound();

  const base = body.base_revision;
  if (base !== undefined) {
    if (!(base === null || (typeof base === "number" && Number.isInteger(base) && base >= 1))) {
      return apiError(400, "BAD_BASE", "base_revision must be null or a positive integer");
    }
    if ((project.head_revision ?? null) !== base) {
      return apiError(409, "REVISION_CONFLICT", "The project head moved since this base", {
        head: { revision: project.head_revision, revision_id: project.head_revision_id },
      });
    }
  }
  if (project.head_revision_id === source.id) {
    return jsonResponse({ success: true, already: true, revision: source.revision, revision_id: source.id });
  }

  const { results: srcFiles } = await env.DB.prepare(
    `SELECT * FROM project_files WHERE revision_id = ? AND state = 'verified'`
  )
    .bind(source.id)
    .all<FileRow>();
  const files = srcFiles || [];
  if (files.length === 0) return apiError(409, "NOTHING_TO_RESTORE", "This revision has no stored files");

  const limits = studioLimits(env);
  const totalSize = files.reduce((sum, f) => sum + f.size_bytes, 0);
  const used = await ownerUsageBytes(env.DB, session.user.id);
  if (used + totalSize > limits.userQuotaBytes) {
    return apiError(413, "QUOTA_EXCEEDED", "Storage quota exceeded", {
      usage_bytes: used,
      quota_bytes: limits.userQuotaBytes,
      requested_bytes: totalSize,
    });
  }

  // The restored revision says where it came from; a manifest already at the
  // size budget is carried over unchanged rather than refused.
  let manifestJson = source.manifest_json;
  try {
    const parsed: unknown = JSON.parse(source.manifest_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const annotated = JSON.stringify({
        ...(parsed as Record<string, unknown>),
        restored_from: { revision: source.revision, revision_id: source.id },
      });
      if (annotated.length <= limits.maxManifestBytes) manifestJson = annotated;
    }
  } catch {
    /* keep the stored manifest verbatim */
  }

  const newRevisionId = newId();
  const now = nowIso();
  const copies = files.map((f) => {
    const fileId = newId();
    return { src: f, newId: fileId, newKey: r2KeyFor(projectId, newRevisionId, fileId) };
  });

  // RESERVE BEFORE COPYING. ownerUsageBytes counts rows, so the pending
  // revision and its 'pending' file rows go in right after the check above,
  // exactly as an OPEN's do: for the whole R2 copy window these bytes count,
  // and a parallel OPEN, duplicate or restore on another tab or device sees
  // them and cannot push the account past its quota. Any failure from here on
  // hands the reservation (rows and whatever was copied) to the purge path.
  const headId = project.head_revision_id;
  let revisionNumber = 0;
  for (let attempt = 0; ; attempt++) {
    const maxRow = await env.DB.prepare(
      `SELECT COALESCE(MAX(revision), 0) AS max_rev FROM project_revisions WHERE project_id = ?`
    )
      .bind(projectId)
      .first<{ max_rev: number }>();
    revisionNumber = (maxRow?.max_rev ?? 0) + 1;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO project_revisions (id, project_id, revision, parent_revision, schema_version, engine_version, content_hash, size_bytes, manifest_json, snapshot_kind, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(
          newRevisionId,
          projectId,
          revisionNumber,
          project.head_revision ?? null,
          source.schema_version,
          source.engine_version,
          source.content_hash,
          totalSize,
          manifestJson,
          source.snapshot_kind,
          now
        ),
        ...copies.map((c) =>
          env.DB.prepare(
            `INSERT INTO project_files (id, revision_id, kind, r2_key, sha256, size_bytes, content_type, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(c.newId, newRevisionId, c.src.kind, c.newKey, c.src.sha256, c.src.size_bytes, c.src.content_type, now)
        ),
      ]);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 3 && /UNIQUE/i.test(message)) continue;
      throw error;
    }
  }
  const releaseReservation = () => purgeRevisionById(env.DB, bucket, newRevisionId).catch(() => 0);

  try {
    for (const copy of copies) {
      const obj = await bucket.get(copy.src.r2_key);
      if (!obj) {
        await releaseReservation();
        return apiError(502, "SOURCE_OBJECT_MISSING", "A stored file is missing; this revision cannot be restored");
      }
      const data = await obj.arrayBuffer();
      await bucket.put(copy.newKey, data, {
        httpMetadata: copy.src.content_type ? { contentType: copy.src.content_type } : undefined,
      });
    }
    // Copied byte-for-byte from verified sources: the copies are verified.
    await env.DB.prepare(`UPDATE project_files SET state = 'verified' WHERE revision_id = ? AND state = 'pending'`)
      .bind(newRevisionId)
      .run();
  } catch (error) {
    await releaseReservation();
    throw error;
  }

  const thumbnail = copies.find((c) => c.src.kind === "thumbnail");
  const cas = await env.DB.prepare(
    `UPDATE projects
        SET head_revision_id = ?, last_saved_at = ?, updated_at = ?,
            thumbnail_key = CASE WHEN ? IS NOT NULL THEN ? ELSE thumbnail_key END
      WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND ${headId ? "head_revision_id = ?" : "head_revision_id IS NULL"}
        AND EXISTS (SELECT 1 FROM project_revisions WHERE id = ? AND state = 'pending')`
  )
    .bind(
      newRevisionId,
      now,
      now,
      thumbnail ? thumbnail.newKey : null,
      thumbnail ? thumbnail.newKey : null,
      projectId,
      session.user.id,
      ...(headId ? [headId] : []),
      newRevisionId
    )
    .run();
  if (!cas.meta.changes) {
    await releaseReservation();
    const fresh = await loadOwnedProject(env, session.user.id, projectId);
    return apiError(409, "REVISION_CONFLICT", "Another device committed first", {
      head: fresh ? { revision: fresh.head_revision, revision_id: fresh.head_revision_id } : null,
    });
  }
  await env.DB.prepare(`UPDATE project_revisions SET state = 'committed', committed_at = ? WHERE id = ? AND state = 'pending'`)
    .bind(now, newRevisionId)
    .run();

  return jsonResponse(
    {
      success: true,
      revision: revisionNumber,
      revision_id: newRevisionId,
      committed_at: now,
      snapshot_kind: source.snapshot_kind,
      restored_from: { revision: source.revision, revision_id: source.id },
    },
    201
  );
}

/**
 * The owner's own "keep this version" pin (reason 'user'). Releasing it never
 * touches a request/order pin, which only server code can create or release.
 */
async function setUserPin(
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string,
  revisionId: string,
  pin: boolean
): Promise<Response> {
  const input = { ownerId: session.user.id, projectId, revisionId, reason: "user" as const };
  if (pin) {
    const result = await pinRevision(env.DB, input);
    if (!result.ok) {
      if (result.code === "NOT_COMMITTED") {
        return apiError(409, "NOT_COMMITTED", "Only a committed revision can be kept");
      }
      return notFound();
    }
  } else {
    const result = await unpinRevision(env.DB, input);
    if (!result.ok) return notFound();
  }
  const reasons = (await pinReasonsFor(env.DB, [revisionId])).get(revisionId) ?? [];
  return jsonResponse({ success: true, revision_id: revisionId, pinned: reasons.length > 0, pin_reasons: reasons });
}

interface OpenFileDecl {
  kind: FileRow["kind"];
  sha256: string;
  size_bytes: number;
  content_type: string | null;
}

function parseFileDecls(value: unknown, limits: ReturnType<typeof studioLimits>): OpenFileDecl[] | string {
  if (!Array.isArray(value) || value.length === 0) return "files must be a non-empty array";
  if (value.length > limits.maxFilesPerRevision) return `at most ${limits.maxFilesPerRevision} files per revision`;
  const out: OpenFileDecl[] = [];
  let thumbnails = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "each file must be an object";
    const f = entry as Record<string, unknown>;
    const kind = typeof f.kind === "string" && FILE_KINDS.has(f.kind) ? (f.kind as FileRow["kind"]) : null;
    if (!kind) return "file kind must be one of snapshot3mf|source|thumbnail|asset";
    if (!isSha256Hex(f.sha256)) return "each file needs a lowercase hex sha256";
    const size = f.size_bytes;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return "size_bytes must be a positive integer";
    const cap = kind === "thumbnail" ? limits.thumbnailMaxBytes : limits.maxFileBytes;
    if (size > cap) return `file too large (max ${cap} bytes for ${kind})`;
    if (kind === "thumbnail" && ++thumbnails > 1) return "at most one thumbnail per revision";
    let contentType: string | null = null;
    if (typeof f.content_type === "string") {
      const ct = f.content_type.trim().slice(0, 100);
      if (/^[\w!#$&^./+-]+$/.test(ct)) contentType = ct;
    }
    out.push({ kind, sha256: f.sha256, size_bytes: size, content_type: contentType });
  }
  return out;
}

/**
 * OPEN: validates session + ownership + quota, then creates a pending
 * revision and pending file rows with server-generated R2 keys. Fails fast
 * with 409 when base_revision no longer matches the head.
 */
async function openRevision(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string
): Promise<Response> {
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const limits = studioLimits(env);
  const body = await readJsonBody(request, limits.maxManifestBytes + 64 * 1024);
  if (body instanceof Response) return body;

  const project = await loadOwnedProject(env, session.user.id, projectId);
  if (!project) return notFound();

  // base_revision: null = "I based this on an empty project".
  const base = body.base_revision;
  if (!(base === null || base === undefined || (typeof base === "number" && Number.isInteger(base) && base >= 1))) {
    return apiError(400, "BAD_BASE", "base_revision must be null or a positive integer");
  }
  const baseRevision = base === undefined ? null : (base as number | null);

  if (!isSha256Hex(body.content_hash)) {
    return apiError(400, "BAD_CONTENT_HASH", "content_hash must be a lowercase hex sha256");
  }
  const snapshotKind = body.snapshot_kind;
  if (snapshotKind !== "full" && snapshotKind !== "source-only") {
    return apiError(400, "BAD_SNAPSHOT_KIND", "snapshot_kind must be 'full' or 'source-only'");
  }
  if (!body.manifest || typeof body.manifest !== "object" || Array.isArray(body.manifest)) {
    return apiError(400, "BAD_MANIFEST", "manifest must be a JSON object");
  }
  const manifestJson = JSON.stringify(body.manifest);
  if (manifestJson.length > limits.maxManifestBytes) {
    return apiError(413, "MANIFEST_TOO_LARGE", `manifest exceeds ${limits.maxManifestBytes} bytes`);
  }
  const schemaVersion =
    typeof body.schema_version === "number" && Number.isInteger(body.schema_version) ? body.schema_version : null;
  const engineVersion = typeof body.engine_version === "string" ? body.engine_version.slice(0, 100) : null;

  const files = parseFileDecls(body.files, limits);
  if (typeof files === "string") return apiError(400, "BAD_FILES", files);
  const snapshotCount = files.filter((f) => f.kind === "snapshot3mf").length;
  if (snapshotKind === "full" && snapshotCount !== 1) {
    return apiError(400, "BAD_FILES", "a 'full' snapshot needs exactly one snapshot3mf file");
  }
  if (snapshotKind === "source-only" && (snapshotCount !== 0 || !files.some((f) => f.kind === "source"))) {
    return apiError(
      400,
      "BAD_FILES",
      "a 'source-only' save carries source files and no snapshot3mf (it must stay honestly degraded)"
    );
  }

  // Optimistic-concurrency fast path: reject stale bases before any upload
  // bandwidth is spent. COMMIT re-verifies (this check alone is not enough).
  if ((project.head_revision ?? null) !== baseRevision) {
    return apiError(409, "REVISION_CONFLICT", "The project head moved since this base", {
      head: { revision: project.head_revision, revision_id: project.head_revision_id },
    });
  }

  // Quota: committed + pending reservations + this request.
  const incoming = files.reduce((sum, f) => sum + f.size_bytes, 0);
  const used = await ownerUsageBytes(env.DB, session.user.id);
  if (used + incoming > limits.userQuotaBytes) {
    return apiError(413, "QUOTA_EXCEEDED", "Storage quota exceeded", {
      usage_bytes: used,
      quota_bytes: limits.userQuotaBytes,
      requested_bytes: incoming,
    });
  }

  const revisionId = newId();
  const now = nowIso();
  const fileRows: FileRow[] = files.map((f) => {
    const id = newId();
    return {
      id,
      revision_id: revisionId,
      kind: f.kind,
      r2_key: r2KeyFor(projectId, revisionId, id),
      sha256: f.sha256,
      size_bytes: f.size_bytes,
      content_type: f.content_type,
      state: "pending",
      created_at: now,
    };
  });

  // Concurrent OPENs may race for the same next revision number; the UNIQUE
  // (project_id, revision) index arbitrates and we retry with a fresh number.
  let revisionNumber = 0;
  for (let attempt = 0; ; attempt++) {
    const maxRow = await env.DB.prepare(
      `SELECT COALESCE(MAX(revision), 0) AS max_rev FROM project_revisions WHERE project_id = ?`
    )
      .bind(projectId)
      .first<{ max_rev: number }>();
    revisionNumber = (maxRow?.max_rev ?? 0) + 1;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO project_revisions (id, project_id, revision, parent_revision, schema_version, engine_version, content_hash, size_bytes, manifest_json, snapshot_kind, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(
          revisionId,
          projectId,
          revisionNumber,
          baseRevision,
          schemaVersion,
          engineVersion,
          body.content_hash,
          incoming,
          manifestJson,
          snapshotKind,
          now
        ),
        ...fileRows.map((f) =>
          env.DB.prepare(
            `INSERT INTO project_files (id, revision_id, kind, r2_key, sha256, size_bytes, content_type, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(f.id, f.revision_id, f.kind, f.r2_key, f.sha256, f.size_bytes, f.content_type, f.created_at)
        ),
      ]);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 3 && /UNIQUE/i.test(message)) continue;
      throw error;
    }
  }

  return jsonResponse(
    {
      success: true,
      project_id: projectId,
      revision_id: revisionId,
      revision: revisionNumber,
      state: "pending",
      files: fileRows.map(fileJson),
    },
    201
  );
}

async function getRevision(
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string,
  revisionId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r.* FROM project_revisions r JOIN projects p ON p.id = r.project_id
      WHERE r.id = ? AND r.project_id = ? AND p.owner_id = ? AND p.deleted_at IS NULL`
  )
    .bind(revisionId, projectId, session.user.id)
    .first<RevisionRow>();
  if (!row) return notFound();
  const { results } = await env.DB.prepare(`SELECT * FROM project_files WHERE revision_id = ?`)
    .bind(revisionId)
    .all<FileRow>();
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(row.manifest_json);
  } catch {
    manifest = null;
  }
  return jsonResponse({
    success: true,
    revision: { ...revisionJson(row), manifest },
    files: (results || []).map(fileJson),
  });
}

/**
 * COMMIT: single decision point of the protocol. Requires the session owner,
 * every file verified, and head == base — otherwise 409 with the server head
 * (rebase/fork; never a silent clobber). The head swap is a compare-and-set
 * UPDATE so two racing commits cannot both win.
 */
async function commitRevision(
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string,
  revisionId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r.*, p.head_revision_id AS project_head_id FROM project_revisions r
       JOIN projects p ON p.id = r.project_id
      WHERE r.id = ? AND r.project_id = ? AND p.owner_id = ? AND p.deleted_at IS NULL`
  )
    .bind(revisionId, projectId, session.user.id)
    .first<RevisionRow & { project_head_id: string | null }>();
  if (!row) return notFound();

  // Idempotent retry: an already-committed revision reports success again.
  if (row.state === "committed") {
    return jsonResponse({ success: true, already: true, revision: row.revision, revision_id: row.id });
  }
  if (row.state === "abandoned") {
    return apiError(409, "REVISION_ABANDONED", "This revision was abandoned and cannot be committed");
  }

  const { results } = await env.DB.prepare(`SELECT * FROM project_files WHERE revision_id = ?`)
    .bind(revisionId)
    .all<FileRow>();
  const files = results || [];
  const unverified = files.filter((f) => f.state !== "verified");
  if (files.length === 0 || unverified.length > 0) {
    return apiError(409, "FILES_NOT_VERIFIED", "Not every declared file finished a verified upload", {
      unverified: unverified.map((f) => ({ id: f.id, kind: f.kind, state: f.state })),
    });
  }

  const now = nowIso();
  const headId = row.project_head_id;

  // Crash recovery: a previous commit attempt may have swapped the head and
  // died before flipping the state. Resume by finishing the state flip.
  if (headId === revisionId) {
    await env.DB.prepare(`UPDATE project_revisions SET state = 'committed', committed_at = ? WHERE id = ? AND state = 'pending'`)
      .bind(now, revisionId)
      .run();
    return jsonResponse({ success: true, revision: row.revision, revision_id: row.id, committed_at: now, resumed: true });
  }

  const headRevisionNumber = headId
    ? (
        await env.DB.prepare(`SELECT revision FROM project_revisions WHERE id = ?`).bind(headId).first<{ revision: number }>()
      )?.revision ?? null
    : null;
  if (headRevisionNumber !== (row.parent_revision ?? null)) {
    return apiError(409, "REVISION_CONFLICT", "The project head moved since this revision's base", {
      head: { revision: headRevisionNumber, revision_id: headId },
      base_revision: row.parent_revision,
    });
  }

  const thumbnail = files.find((f) => f.kind === "thumbnail");
  // Compare-and-set on the previous head id — the loser of a device race
  // changes zero rows and gets the fresh head in a 409. The head only moves
  // onto a revision that is still 'pending': the cleanup cron claims a
  // revision (→ 'abandoned') before deleting its files, and a claimed
  // revision must never become a head.
  const cas = await env.DB.prepare(
    `UPDATE projects
        SET head_revision_id = ?, last_saved_at = ?, updated_at = ?,
            thumbnail_key = CASE WHEN ? IS NOT NULL THEN ? ELSE thumbnail_key END
      WHERE id = ? AND owner_id = ? AND ${headId ? "head_revision_id = ?" : "head_revision_id IS NULL"}
        AND EXISTS (SELECT 1 FROM project_revisions WHERE id = ? AND state = 'pending')`
  )
    .bind(
      revisionId,
      now,
      now,
      thumbnail ? thumbnail.r2_key : null,
      thumbnail ? thumbnail.r2_key : null,
      projectId,
      session.user.id,
      ...(headId ? [headId] : []),
      revisionId
    )
    .run();
  if (!cas.meta.changes) {
    const state = await env.DB.prepare(`SELECT state FROM project_revisions WHERE id = ?`)
      .bind(revisionId)
      .first<{ state: string }>();
    if (!state || state.state === "abandoned") {
      return apiError(409, "REVISION_ABANDONED", "This revision was abandoned and cannot be committed");
    }
    const fresh = await loadOwnedProject(env, session.user.id, projectId);
    return apiError(409, "REVISION_CONFLICT", "Another device committed first", {
      head: fresh ? { revision: fresh.head_revision, revision_id: fresh.head_revision_id } : null,
    });
  }

  await env.DB.prepare(`UPDATE project_revisions SET state = 'committed', committed_at = ? WHERE id = ? AND state = 'pending'`)
    .bind(now, revisionId)
    .run();

  return jsonResponse({
    success: true,
    revision: row.revision,
    revision_id: row.id,
    committed_at: now,
    snapshot_kind: row.snapshot_kind,
  });
}

/** Client-initiated cancel (e.g. account switch): pending → abandoned, purge async. */
async function abandonRevision(
  env: StudioApiEnv,
  ctx: StudioApiCtx,
  session: StudioSession,
  projectId: string,
  revisionId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.state, p.head_revision_id AS project_head_id FROM project_revisions r
       JOIN projects p ON p.id = r.project_id
      WHERE r.id = ? AND r.project_id = ? AND p.owner_id = ?`
  )
    .bind(revisionId, projectId, session.user.id)
    .first<{ id: string; state: RevisionRow["state"]; project_head_id: string | null }>();
  if (!row) return notFound();
  if (row.state === "committed") {
    return apiError(409, "REVISION_COMMITTED", "A committed revision cannot be abandoned");
  }
  if (row.project_head_id === revisionId) {
    // Mid-commit crash window — let the commit resume path win, never purge.
    return apiError(409, "REVISION_IS_HEAD", "This revision is the project head");
  }
  if (row.state === "pending") {
    await env.DB.prepare(`UPDATE project_revisions SET state = 'abandoned' WHERE id = ? AND state = 'pending'`)
      .bind(revisionId)
      .run();
  }
  if (env.BUCKET) {
    ctx.waitUntil(purgeRevisionById(env.DB, env.BUCKET, revisionId).catch(() => {}));
  }
  return jsonResponse({ success: true, state: "abandoned" });
}

// Reads (files / thumbnail) ------------------------------------------------------

function attachmentHeaders(file: FileRow): Record<string, string> {
  const ext = file.kind === "snapshot3mf" ? ".3mf" : file.kind === "thumbnail" ? ".png" : ".bin";
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${file.kind}-${file.id.slice(0, 8)}${ext}"`,
  };
}

/**
 * Streams one stored file through the worker. Covers project open, old
 * revisions and export alike (T3: ownership enforced on every one of them).
 * Non-image kinds are always served as an octet-stream attachment; only
 * verified image thumbnails render inline.
 */
async function getFile(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string,
  fileId: string
): Promise<Response> {
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const row = await env.DB.prepare(
    `SELECT f.* FROM project_files f
       JOIN project_revisions r ON r.id = f.revision_id
       JOIN projects p ON p.id = r.project_id
      WHERE f.id = ? AND r.project_id = ? AND p.id = ? AND p.owner_id = ? AND p.deleted_at IS NULL`
  )
    .bind(fileId, projectId, projectId, session.user.id)
    .first<FileRow>();
  if (!row) return notFound();
  if (row.state !== "verified") {
    return apiError(409, "FILE_NOT_READY", "This file has no verified upload yet");
  }

  const inlineImage = row.kind === "thumbnail" && row.content_type && INLINE_IMAGE_TYPES.has(row.content_type);
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store",
    "Content-Length": String(row.size_bytes),
    "X-Content-Type-Options": "nosniff",
    ...(inlineImage ? { "Content-Type": row.content_type as string } : attachmentHeaders(row)),
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const obj = await bucket.get(row.r2_key);
  if (!obj) return apiError(404, "OBJECT_MISSING", "The stored object is missing");
  return new Response(obj.body, { status: 200, headers });
}

async function getThumbnail(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  projectId: string
): Promise<Response> {
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const project = await loadOwnedProject(env, session.user.id, projectId);
  if (!project || !project.thumbnail_key) return notFound();

  // Resolve back to the file row (r2_key is unique) and re-verify it belongs
  // to THIS project — defense in depth against any key mixup.
  const row = await env.DB.prepare(
    `SELECT f.* FROM project_files f
       JOIN project_revisions r ON r.id = f.revision_id
      WHERE f.r2_key = ? AND r.project_id = ? AND f.state = 'verified' AND f.kind = 'thumbnail'`
  )
    .bind(project.thumbnail_key, projectId)
    .first<FileRow>();
  if (!row || !row.content_type || !INLINE_IMAGE_TYPES.has(row.content_type)) return notFound();

  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store",
    "Content-Type": row.content_type,
    "Content-Length": String(row.size_bytes),
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const obj = await bucket.get(row.r2_key);
  if (!obj) return notFound();
  return new Response(obj.body, { status: 200, headers });
}
