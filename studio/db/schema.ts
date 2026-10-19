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
 * Archive marker (P1-09). A row means "archived": the project leaves the
 * default list but stays fully readable, and archiving NEVER deletes —
 * archive and delete are separate states (delete is `projects.deleted_at`,
 * restorable from the trash within the retention window).
 *
 * A side table rather than a `projects.archived_at` column: the Studio
 * migration gate (scripts/check-migrations-additive.mjs, workflow 13) admits
 * CREATE statements only and refuses every ALTER TABLE. The row is removed on
 * unarchive, and when the cleanup cron purges the project.
 */
export const projectArchive = sqliteTable("project_archive", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id),
  archivedAt: text("archived_at").notNull(),
});

/**
 * Revision pins (P1-09; GAP-MAP conflict 19). A pinned revision is NEVER
 * pruned by retention nor purged with a deleted project — a request, an order
 * or the owner's own "keep this version" holds it. One row per holder, so
 * releasing one holder (a withdrawn request) never unpins a revision another
 * holder (an order) still needs.
 *
 *   pin_reason  'user' | 'request' | 'order' (validated in worker/api/pins.ts;
 *               deliberately no CHECK — a new holder must not need a rebuild)
 *   pin_ref     the holder's id ('' for the owner's own pin)
 *
 * The foreign key doubles as a database-level guard: with foreign keys on, a
 * revision row that still has a pin cannot be deleted at all.
 */
export const projectRevisionPins = sqliteTable(
  "project_revision_pins",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => projectRevisions.id),
    pinnedAt: text("pinned_at").notNull(),
    pinReason: text("pin_reason").notNull(),
    pinRef: text("pin_ref").notNull().default(""),
  },
  (t) => [uniqueIndex("uq_project_revision_pins_holder").on(t.revisionId, t.pinReason, t.pinRef)]
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

/**
 * Studio user preferences (P1-10; owner decisions S6/S7, worker/api/prefs.ts).
 * One row per account that has ever chosen; no row means Simple, the default
 * for everyone. `mode` is validated in code, deliberately without a CHECK: a
 * future mode must not need a table rebuild (the migration gate admits CREATE
 * only). The migration is hand-adjusted to IF NOT EXISTS because the API
 * bootstrap (worker/api/router.ts) may create the table first.
 */
export const studioUserPrefs = sqliteTable("studio_user_prefs", {
  ownerId: text("owner_id").primaryKey(),
  mode: text("mode").notNull().default("simple"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * D1 fixed-window rate limit (P1-10, worker/api/ratelimit.ts) — the main
 * site's `rate_limits` shape. `key` is `<bucket>:u:<userId>` (or
 * `<bucket>:<ip>`); `window_start` is epoch seconds. Windows older than a day
 * are deleted by the cleanup cron.
 */
export const studioRateLimits = sqliteTable(
  "studio_rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [index("idx_studio_rate_limits_window").on(t.windowStart)]
);
