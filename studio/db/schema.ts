/**
 * LEVO Studio D1 schema — the SEPARATE `levonis-studio-db` database
 * (docs/STUDIO_PLAN.md, decision 4). This database holds project data ONLY:
 * identity stays in the store's `levonis-db`; Studio stores the opaque
 * `owner_id` string and never joins any store table.
 *
 * Migrations are generated from this file with drizzle-kit into ./drizzle
 * (`npx drizzle-kit generate` from studio/) and applied by the deploy
 * workflows via `wrangler d1 migrations apply` (migrations_dir "drizzle" in
 * studio/wrangler.jsonc).
 *
 * Upload protocol encoded in the states below (plan decision 4):
 *   OPEN    → project_revisions row state='pending' + project_files rows
 *             state='pending' with server-generated R2 keys.
 *   UPLOAD  → each file streams to R2; a matching sha256/size flips the file
 *             row to state='verified'.
 *   COMMIT  → only when every file is verified AND the project head still
 *             equals the revision's base (optimistic concurrency — otherwise
 *             409, never a silent clobber): revision becomes 'committed' and
 *             the project head/last_saved_at/thumbnail move forward.
 *   CLEANUP → a cron purges stale 'pending' and 'abandoned' revisions and
 *             their R2 objects after a timeout (worker/api/cleanup.ts).
 *
 * Timestamps are ISO-8601 UTC strings (sortable lexicographically), matching
 * the studio_sessions convention established by worker/auth/session.ts.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One saved project per row. `owner_id` is the store's opaque users.id —
 * every read/write/thumbnail/revision/export path MUST filter on it.
 * `head_revision_id` points at the latest committed revision (no FK: the
 * reference is circular with project_revisions and is maintained by the
 * commit protocol). `deleted_at` implements soft delete; the cleanup cron
 * purges rows and R2 objects after the configured retention.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    thumbnailKey: text("thumbnail_key"),
    schemaVersion: integer("schema_version").notNull(),
    headRevisionId: text("head_revision_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSavedAt: text("last_saved_at"),
    deletedAt: text("deleted_at"),
  },
  (t) => [index("idx_projects_owner_updated").on(t.ownerId, t.updatedAt)]
);

/**
 * Immutable snapshots of a project. `revision` is a per-project monotonically
 * increasing number assigned at OPEN (gaps are normal: a revision that never
 * commits keeps its number). `parent_revision` records the base the client
 * edited from — commit succeeds only while the head still equals it.
 * `snapshot_kind` honestly distinguishes a full snapshot from a degraded
 * source-only save (mandate §4: source-only must never masquerade as a full
 * sync nor replace the last full snapshot).
 */
export const projectRevisions = sqliteTable(
  "project_revisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    revision: integer("revision").notNull(),
    parentRevision: integer("parent_revision"),
    schemaVersion: integer("schema_version"),
    engineVersion: text("engine_version"),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes"),
    manifestJson: text("manifest_json").notNull(),
    snapshotKind: text("snapshot_kind", { enum: ["full", "source-only"] }).notNull(),
    state: text("state", { enum: ["pending", "committed", "abandoned"] })
      .notNull()
      .default("pending"),
    createdAt: text("created_at").notNull(),
    committedAt: text("committed_at"),
  },
  (t) => [
    uniqueIndex("uq_project_revisions_project_revision").on(t.projectId, t.revision),
    index("idx_project_revisions_state_created").on(t.state, t.createdAt),
    check("chk_project_revisions_snapshot_kind", sql`${t.snapshotKind} IN ('full','source-only')`),
    check("chk_project_revisions_state", sql`${t.state} IN ('pending','committed','abandoned')`),
  ]
);

/**
 * One R2 object per row. `r2_key` is ALWAYS server-generated
 * (`projects/{projectId}/rev/{revisionId}/{fileId}`) — a client-supplied key
 * is never accepted (plan decision 4). `sha256`/`size_bytes` are the client's
 * declaration from OPEN; the upload endpoint verifies both while streaming
 * and only then flips `state` to 'verified'.
 */
export const projectFiles = sqliteTable(
  "project_files",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => projectRevisions.id),
    kind: text("kind", { enum: ["snapshot3mf", "source", "thumbnail", "asset"] }).notNull(),
    r2Key: text("r2_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentType: text("content_type"),
    state: text("state", { enum: ["pending", "verified"] }).notNull().default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_project_files_revision").on(t.revisionId),
    index("idx_project_files_state_created").on(t.state, t.createdAt),
    check("chk_project_files_kind", sql`${t.kind} IN ('snapshot3mf','source','thumbnail','asset')`),
    check("chk_project_files_state", sql`${t.state} IN ('pending','verified')`),
  ]
);

/**
 * Studio sessions (auth slice, worker/auth/session.ts). The table shape must
 * stay EXACTLY in sync with SESSION_TABLE_SQL there: the auth layer also
 * provisions it idempotently (CREATE TABLE IF NOT EXISTS) so sign-in never
 * dead-ends on a database the migrations have not reached yet. For the same
 * reason the generated migration for THIS table is hand-adjusted to
 * IF NOT EXISTS (see drizzle/0000_*.sql) — a worker boot may have created it
 * before the migration gate runs.
 */
export const studioSessions = sqliteTable(
  "studio_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull().default(""),
    locale: text("locale").notNull().default("ar"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    expiresAt: text("expires_at").notNull(),
    userAgent: text("user_agent").notNull().default(""),
  },
  (t) => [
    index("idx_studio_sessions_user").on(t.userId),
    index("idx_studio_sessions_expires").on(t.expiresAt),
  ]
);
