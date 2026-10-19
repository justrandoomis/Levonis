/**
 * Behavioral tests for the Studio storage API (slice S3 — docs/STUDIO_PLAN.md
 * decision 4; acceptance tests T3 and T6).
 *
 * These are real request/response tests against the actual worker/api/*
 * handlers: the TypeScript sources are loaded through Node's built-in type
 * stripping (a resolve hook appends the .ts extension), D1 is backed by a
 * genuine SQLite database (node:sqlite) running the SAME migration SQL from
 * studio/drizzle/, and R2 is an in-memory bucket with the operations the
 * handlers use. What this deliberately does NOT cover (verify agent /
 * staging): the Cloudflare-only streaming primitives (DigestStream /
 * FixedLengthStream — the buffered fallback path is what runs here) and the
 * real wrangler/miniflare runtime.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Resolve extensionless relative imports inside the studio sources to .ts so
// Node's type stripping can load them (bundler-style specifiers otherwise
// fail under plain node).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-zA-Z]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through to default resolution */
      }
    }
    return nextResolve(specifier, context);
  },
});

const routerMod = await import("../worker/api/router.ts");
const cleanupMod = await import("../worker/api/cleanup.ts");
const { apiRouter, resetEnsuredTablesForTests } = routerMod;
const { runCleanup } = cleanupMod;

// ---------------------------------------------------------------------------
// Fakes: D1 over node:sqlite, R2 over a Map.
// ---------------------------------------------------------------------------

class FakeStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new FakeStatement(this.db, this.sql, params.map((p) => (p === undefined ? null : p)));
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

class FakeD1 {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new FakeStatement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, options = {}) {
    let data;
    if (value instanceof Uint8Array) data = new Uint8Array(value);
    else if (value instanceof ArrayBuffer) data = new Uint8Array(value.slice(0));
    else if (typeof value === "string") data = new TextEncoder().encode(value);
    else data = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { data, uploaded: new Date(), httpMetadata: options.httpMetadata || {} });
    return { key, size: data.byteLength };
  }
  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    const data = entry.data;
    return {
      key,
      size: data.byteLength,
      uploaded: entry.uploaded,
      body: new Response(data).body,
      arrayBuffer: async () => data.slice().buffer,
    };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => ({
        key: k,
        uploaded: this.objects.get(k).uploaded,
        size: this.objects.get(k).data.byteLength,
      })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Harness helpers.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(new URL("../drizzle/0000_studio_projects.sql", import.meta.url), "utf8");
const MIGRATION_0001_SQL = readFileSync(new URL("../drizzle/0001_project_archive_pins.sql", import.meta.url), "utf8");
const MIGRATION_0002_SQL = readFileSync(new URL("../drizzle/0002_user_prefs.sql", import.meta.url), "utf8");

function applySql(raw, sql) {
  for (const part of sql.split("--> statement-breakpoint")) {
    const stmt = part.trim();
    if (stmt) raw.exec(stmt);
  }
}

/**
 * applyMigration: true = every migration (the live database's shape), "0000"
 * = a database the P1-09 migration has not reached yet, false = none at all.
 */
function makeEnv({ applyMigration = true, vars = {} } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  if (applyMigration) {
    applySql(raw, MIGRATION_SQL);
    if (applyMigration === true) {
      applySql(raw, MIGRATION_0001_SQL);
      applySql(raw, MIGRATION_0002_SQL);
    }
  }
  resetEnsuredTablesForTests();
  const bucket = new FakeR2();
  return { env: { DB: new FakeD1(raw), BUCKET: bucket, ...vars }, raw, bucket };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise).catch(() => {}));
    },
    async flush() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}

function sessionFor(userId) {
  return { sessionId: `sess-${userId}`, user: { id: userId, display_name: userId, locale: "ar" } };
}

const USER_A = sessionFor("a1b2c3d4-user-a");
const USER_B = sessionFor("e5f6a7b8-user-b");

async function call(env, ctx, session, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Uint8Array) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
  }
  const response = await apiRouter(new Request(`https://studio.local${path}`, init), env, ctx, session);
  let json = null;
  const type = response.headers.get("Content-Type") || "";
  if (type.includes("application/json")) json = await response.json();
  return { response, json };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const HASH64 = "a".repeat(64);

async function fileDecl(kind, bytes, contentType) {
  return { kind, sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength, content_type: contentType };
}

/** OPEN with a full snapshot (+thumbnail/source), returning ids + payload bytes. */
async function openFullRevision(env, ctx, session, projectId, baseRevision, label = "v1") {
  const snapshot = new TextEncoder().encode(`3mf-snapshot-${label}-${projectId}`);
  const thumb = new TextEncoder().encode(`png-thumb-${label}`);
  const source = new TextEncoder().encode(`stl-source-${label}`);
  const { response, json } = await call(env, ctx, session, "POST", `/api/projects/${projectId}/revisions`, {
    base_revision: baseRevision,
    schema_version: 2,
    engine_version: "three-slicer@0.2.2",
    content_hash: await sha256Hex(snapshot),
    snapshot_kind: "full",
    manifest: { models: [{ name: "cube", unit: "mm" }], plates: 1, label },
    files: [
      await fileDecl("snapshot3mf", snapshot, "model/3mf"),
      await fileDecl("thumbnail", thumb, "image/png"),
      await fileDecl("source", source, "application/octet-stream"),
    ],
  });
  return { response, json, payloads: { snapshot, thumb, source } };
}

async function uploadAll(env, ctx, session, open) {
  const byKind = Object.fromEntries(open.json.files.map((f) => [f.kind, f]));
  for (const [kind, bytes] of [
    ["snapshot3mf", open.payloads.snapshot],
    ["thumbnail", open.payloads.thumb],
    ["source", open.payloads.source],
  ]) {
    const { response } = await call(env, ctx, session, "PUT", byKind[kind].upload_url, bytes);
    assert.equal(response.status, 200, `upload of ${kind} should succeed`);
  }
  return byKind;
}

async function commit(env, ctx, session, projectId, revisionId) {
  return call(env, ctx, session, "POST", `/api/projects/${projectId}/revisions/${revisionId}/commit`);
}

async function createProject(env, ctx, session, name) {
  const { response, json } = await call(env, ctx, session, "POST", "/api/projects", { name });
  assert.equal(response.status, 201);
  return json.project.id;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test("guests get 401 on every account endpoint (guest editing is client-side)", async () => {
  const { env } = makeEnv();
  const ctx = makeCtx();
  for (const [method, path] of [
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects/aaaabbbbccccdddd/files/aaaabbbbccccdddd"],
    ["PUT", "/api/uploads/aaaabbbbccccdddd"],
    ["GET", "/api/quota"],
  ]) {
    const { response, json } = await call(env, ctx, null, method, path);
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(json.code, "AUTH_REQUIRED");
  }
  // /api/health stays public and honest about bindings.
  const health = await call(env, ctx, null, "GET", "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.json.r2, true);
  assert.equal(health.response.headers.get("Cache-Control"), "private, no-store");
});

test("table bootstrap works on a database the migrations never reached", async () => {
  const { env } = makeEnv({ applyMigration: false });
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "مشروع اختبار");
  const { response, json } = await call(env, ctx, USER_A, "GET", `/api/projects/${id}`);
  assert.equal(response.status, 200);
  assert.equal(json.project.name, "مشروع اختبار");
});

test("project CRUD, search, and strict cross-user isolation (T3)", async () => {
  const { env } = makeEnv();
  const ctx = makeCtx();
  const idA1 = await createProject(env, ctx, USER_A, "قارب البط");
  const idA2 = await createProject(env, ctx, USER_A, "حامل الهاتف");

  const list = await call(env, ctx, USER_A, "GET", "/api/projects");
  assert.equal(list.json.projects.length, 2);

  const search = await call(env, ctx, USER_A, "GET", "/api/projects?q=%D8%A8%D8%B7"); // بط
  assert.equal(search.json.projects.length, 1);
  assert.equal(search.json.projects[0].id, idA1);

  const rename = await call(env, ctx, USER_A, "PATCH", `/api/projects/${idA2}`, { name: "حامل آيباد" });
  assert.equal(rename.response.status, 200);
  assert.equal(rename.json.project.name, "حامل آيباد");

  // User B sees NOTHING of user A — list, direct get, rename, delete,
  // thumbnail, revisions — even with the exact ids (guessing included).
  const listB = await call(env, ctx, USER_B, "GET", "/api/projects");
  assert.equal(listB.json.projects.length, 0);
  for (const [method, path, body] of [
    ["GET", `/api/projects/${idA1}`],
    ["PATCH", `/api/projects/${idA1}`, { name: "x" }],
    ["DELETE", `/api/projects/${idA1}`],
    ["GET", `/api/projects/${idA1}/thumbnail`],
    ["GET", `/api/projects/${idA1}/revisions`],
    ["POST", `/api/projects/${idA1}/duplicate`, {}],
  ]) {
    const { response } = await call(env, ctx, USER_B, method, path, body);
    assert.equal(response.status, 404, `${method} ${path} must 404 for a non-owner`);
  }

  // Malformed / guessed ids never reach the database.
  const weird = await call(env, ctx, USER_A, "GET", "/api/projects/%2e%2e%2fetc");
  assert.equal(weird.response.status, 404);

  // Soft delete hides the project from every read.
  const del = await call(env, ctx, USER_A, "DELETE", `/api/projects/${idA1}`);
  assert.equal(del.response.status, 200);
  const afterDelete = await call(env, ctx, USER_A, "GET", `/api/projects/${idA1}`);
  assert.equal(afterDelete.response.status, 404);
});

test("OPEN validates its declaration honestly", async () => {
  const { env } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "فحص");
  const base = {
    base_revision: null,
    content_hash: HASH64,
    snapshot_kind: "full",
    manifest: { plates: 1 },
  };
  const cases = [
    [{ ...base, files: [] }, "BAD_FILES"],
    [{ ...base, files: [{ kind: "evil", sha256: HASH64, size_bytes: 4 }] }, "BAD_FILES"],
    [{ ...base, files: [{ kind: "snapshot3mf", sha256: "xyz", size_bytes: 4 }] }, "BAD_FILES"],
    [{ ...base, files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 0 }] }, "BAD_FILES"],
    [
      {
        ...base,
        files: [
          { kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 },
          { kind: "thumbnail", sha256: HASH64, size_bytes: 4 },
          { kind: "thumbnail", sha256: HASH64, size_bytes: 4 },
        ],
      },
      "BAD_FILES",
    ],
    // source-only must stay honestly degraded: no snapshot3mf allowed.
    [
      { ...base, snapshot_kind: "source-only", files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 }] },
      "BAD_FILES",
    ],
    [{ ...base, snapshot_kind: "partial", files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 }] }, "BAD_SNAPSHOT_KIND"],
    [{ ...base, content_hash: "nope", files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 }] }, "BAD_CONTENT_HASH"],
    [{ ...base, manifest: "not-an-object", files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 }] }, "BAD_MANIFEST"],
  ];
  for (const [body, code] of cases) {
    const { response, json } = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, body);
    assert.equal(response.status, code === "BAD_FILES" ? 400 : 400, JSON.stringify(body).slice(0, 80));
    assert.equal(json.code, code);
  }
  // Stale base fails fast with the server head.
  const conflict = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, {
    ...base,
    base_revision: 7,
    files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 }],
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.code, "REVISION_CONFLICT");
  assert.equal(conflict.json.head.revision, null);
});

test("full protocol: OPEN → UPLOAD (verified) → COMMIT → READ (T4/T6 core)", async () => {
  const { env, bucket } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "دورة كاملة");

  const open = await openFullRevision(env, ctx, USER_A, id, null);
  assert.equal(open.response.status, 201);
  assert.equal(open.json.revision, 1);
  assert.equal(open.json.files.length, 3);
  const byKind = Object.fromEntries(open.json.files.map((f) => [f.kind, f]));
  const revId = open.json.revision_id;

  // Reading a file before its upload is an honest 409, not empty bytes.
  const early = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/files/${byKind.snapshot3mf.id}`);
  assert.equal(early.response.status, 409);
  assert.equal(early.json.code, "FILE_NOT_READY");

  // Committing before verification is refused.
  const earlyCommit = await commit(env, ctx, USER_A, id, revId);
  assert.equal(earlyCommit.response.status, 409);
  assert.equal(earlyCommit.json.code, "FILES_NOT_VERIFIED");

  // Wrong content (same declared length, different bytes): 422, object NOT
  // kept, row stays pending for a retry.
  const tampered = new Uint8Array(open.payloads.snapshot.length).fill(0x58); // 'XXXX…'
  const bad = await call(env, ctx, USER_A, "PUT", byKind.snapshot3mf.upload_url, tampered);
  assert.equal(bad.response.status, 422);
  assert.equal(bad.json.code, "HASH_MISMATCH");
  assert.equal(bucket.objects.size, 0);

  // Wrong size: 400.
  const short = await call(env, ctx, USER_A, "PUT", byKind.snapshot3mf.upload_url, open.payloads.snapshot.slice(0, 4));
  assert.equal(short.response.status, 400);
  assert.equal(short.json.code, "SIZE_MISMATCH");

  // User B cannot upload into A's slot even knowing the file id (T3 write path).
  const forged = await call(env, ctx, USER_B, "PUT", byKind.snapshot3mf.upload_url, open.payloads.snapshot);
  assert.equal(forged.response.status, 404);

  await uploadAll(env, ctx, USER_A, open);

  // Idempotent retry of a finished upload.
  const again = await call(env, ctx, USER_A, "PUT", byKind.snapshot3mf.upload_url, open.payloads.snapshot);
  assert.equal(again.response.status, 200);
  assert.equal(again.json.already, true);

  const committed = await commit(env, ctx, USER_A, id, revId);
  assert.equal(committed.response.status, 200);
  assert.equal(committed.json.snapshot_kind, "full");

  // Commit retry is idempotent too.
  const recommit = await commit(env, ctx, USER_A, id, revId);
  assert.equal(recommit.response.status, 200);
  assert.equal(recommit.json.already, true);

  const project = await call(env, ctx, USER_A, "GET", `/api/projects/${id}`);
  assert.equal(project.json.project.head_revision, 1);
  assert.equal(project.json.project.head_snapshot_kind, "full");
  assert.equal(project.json.project.has_thumbnail, true);
  assert.ok(project.json.project.last_saved_at);

  // Round-trip the snapshot bytes through the worker (export path).
  const download = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/files/${byKind.snapshot3mf.id}`);
  assert.equal(download.response.status, 200);
  assert.equal(download.response.headers.get("Content-Type"), "application/octet-stream");
  assert.match(download.response.headers.get("Content-Disposition") || "", /^attachment/);
  const bytes = new Uint8Array(await download.response.arrayBuffer());
  assert.deepEqual(bytes, open.payloads.snapshot);

  // Thumbnail renders inline; B still gets nothing.
  const thumb = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/thumbnail`);
  assert.equal(thumb.response.status, 200);
  assert.equal(thumb.response.headers.get("Content-Type"), "image/png");
  const thumbB = await call(env, ctx, USER_B, "GET", `/api/projects/${id}/thumbnail`);
  assert.equal(thumbB.response.status, 404);
  const fileB = await call(env, ctx, USER_B, "GET", `/api/projects/${id}/files/${byKind.snapshot3mf.id}`);
  assert.equal(fileB.response.status, 404);

  // Old revisions stay ownership-checked after the head moves on.
  const open2 = await openFullRevision(env, ctx, USER_A, id, 1, "v2");
  await uploadAll(env, ctx, USER_A, open2);
  await commit(env, ctx, USER_A, id, open2.json.revision_id);
  const oldRev = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/revisions/${revId}`);
  assert.equal(oldRev.response.status, 200);
  assert.equal(oldRev.json.revision.state, "committed");
  assert.equal(oldRev.json.revision.manifest.label, "v1");
  const oldRevB = await call(env, ctx, USER_B, "GET", `/api/projects/${id}/revisions/${revId}`);
  assert.equal(oldRevB.response.status, 404);
});

test("two-device conflict ends in 409 with the server head — no silent clobber (T6)", async () => {
  const { env } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "جهازان");

  const first = await openFullRevision(env, ctx, USER_A, id, null, "seed");
  await uploadAll(env, ctx, USER_A, first);
  await commit(env, ctx, USER_A, id, first.json.revision_id);

  // Both devices open from head=1 (allowed), then race to commit.
  const deviceA = await openFullRevision(env, ctx, USER_A, id, 1, "devA");
  const deviceB = await openFullRevision(env, ctx, USER_A, id, 1, "devB");
  assert.equal(deviceA.response.status, 201);
  assert.equal(deviceB.response.status, 201);
  assert.notEqual(deviceA.json.revision, deviceB.json.revision);

  await uploadAll(env, ctx, USER_A, deviceA);
  await uploadAll(env, ctx, USER_A, deviceB);
  const winA = await commit(env, ctx, USER_A, id, deviceA.json.revision_id);
  assert.equal(winA.response.status, 200);

  const loseB = await commit(env, ctx, USER_A, id, deviceB.json.revision_id);
  assert.equal(loseB.response.status, 409);
  assert.equal(loseB.json.code, "REVISION_CONFLICT");
  assert.equal(loseB.json.head.revision_id, deviceA.json.revision_id);

  // Head still belongs to the winner — nothing was clobbered.
  const project = await call(env, ctx, USER_A, "GET", `/api/projects/${id}`);
  assert.equal(project.json.project.head_revision_id, deviceA.json.revision_id);

  // A device with a stale base is refused at OPEN already.
  const stale = await openFullRevision(env, ctx, USER_A, id, 1, "stale");
  assert.equal(stale.response.status, 409);
  assert.equal(stale.json.code, "REVISION_CONFLICT");
});

test("quota is enforced at OPEN, counting pending reservations", async () => {
  const MiB = 1024 * 1024;
  const { env } = makeEnv({ vars: { STUDIO_USER_QUOTA_BYTES: String(1 * MiB) } });
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "الحصة");

  const decl = (bytes) => ({
    base_revision: null,
    content_hash: HASH64,
    snapshot_kind: "full",
    manifest: {},
    files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: bytes }],
  });

  const over = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, decl(2 * MiB));
  assert.equal(over.response.status, 413);
  assert.equal(over.json.code, "QUOTA_EXCEEDED");
  assert.equal(over.json.quota_bytes, 1 * MiB);

  const first = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, decl(600 * 1024));
  assert.equal(first.response.status, 201);
  // The pending reservation counts — a second OPEN pushing past the quota fails.
  const second = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, decl(600 * 1024));
  assert.equal(second.response.status, 413);

  const quota = await call(env, ctx, USER_A, "GET", "/api/quota");
  assert.equal(quota.response.status, 200);
  assert.equal(quota.json.usage_bytes, 600 * 1024);
  assert.equal(quota.json.quota_bytes, 1 * MiB);
  assert.equal(quota.json.configurable, true);
});

test("duplicate copies the head revision into a new isolated project", async () => {
  const { env, bucket } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "الأصل");
  const open = await openFullRevision(env, ctx, USER_A, id, null, "dup");
  await uploadAll(env, ctx, USER_A, open);
  await commit(env, ctx, USER_A, id, open.json.revision_id);
  const objectsBefore = bucket.objects.size;

  const dup = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/duplicate`, { name: "الأصل (نسخة)" });
  assert.equal(dup.response.status, 201);
  assert.equal(dup.json.project.name, "الأصل (نسخة)");
  assert.equal(dup.json.project.head_revision, 1);
  assert.equal(dup.json.project.has_thumbnail, true);
  assert.equal(bucket.objects.size, objectsBefore * 2);

  // The copy round-trips its own snapshot bytes.
  const rev = await call(env, ctx, USER_A, "GET", `/api/projects/${dup.json.project.id}/revisions/${dup.json.project.head_revision_id}`);
  const snap = rev.json.files.find((f) => f.kind === "snapshot3mf");
  const download = await call(env, ctx, USER_A, "GET", `/api/projects/${dup.json.project.id}/files/${snap.id}`);
  assert.deepEqual(new Uint8Array(await download.response.arrayBuffer()), open.payloads.snapshot);
});

test("abandon purges its uploads; cleanup reclaims stale pendings, deleted projects, sessions and R2 orphans", async () => {
  const { env, bucket, raw } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "التنظيف");

  // Committed head that must SURVIVE every cleanup below.
  const keeper = await openFullRevision(env, ctx, USER_A, id, null, "keeper");
  await uploadAll(env, ctx, USER_A, keeper);
  await commit(env, ctx, USER_A, id, keeper.json.revision_id);
  const keeperObjects = [...bucket.objects.keys()];

  // 1. Explicit abandon purges rows + objects right away (account switch).
  const ab = await openFullRevision(env, ctx, USER_A, id, 1, "abandoned");
  await uploadAll(env, ctx, USER_A, ab);
  const abandoned = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${ab.json.revision_id}/abandon`);
  assert.equal(abandoned.response.status, 200);
  await ctx.flush();
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM project_revisions WHERE id = ?").get(ab.json.revision_id).n,
    0
  );
  for (const key of keeperObjects) assert.ok(bucket.objects.has(key), "committed objects must survive abandon");

  // A committed revision refuses to be committed after abandon and vice versa.
  const abCommit = await commit(env, ctx, USER_A, id, ab.json.revision_id);
  assert.equal(abCommit.response.status, 404); // purged — gone entirely

  // 2. Stale pending (older than the TTL) is reclaimed by the cron.
  const stale = await openFullRevision(env, ctx, USER_A, id, 1, "stale-pending");
  await uploadAll(env, ctx, USER_A, stale);
  raw.prepare("UPDATE project_revisions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(
    stale.json.revision_id
  );
  // 3. Sessions: one expired, one live.
  raw.exec(`CREATE TABLE IF NOT EXISTS studio_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
    locale TEXT NOT NULL DEFAULT 'ar', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '')`);
  raw.prepare("INSERT INTO studio_sessions (id, user_id, expires_at) VALUES ('dead', 'u', '2020-01-01T00:00:00.000Z')").run();
  raw.prepare("INSERT INTO studio_sessions (id, user_id, expires_at) VALUES ('live', 'u', '2999-01-01T00:00:00.000Z')").run();
  // 4. R2 orphan (no DB row) old enough to reconcile, plus a fresh one to keep.
  await bucket.put("projects/orphan/rev/x/y", new TextEncoder().encode("orphan"));
  bucket.objects.get("projects/orphan/rev/x/y").uploaded = new Date(Date.now() - 72 * 3_600_000);
  await bucket.put("projects/fresh/rev/x/y", new TextEncoder().encode("fresh"));

  const report = await runCleanup(env);
  assert.equal(report.expired_sessions, 1);
  assert.equal(report.purged_revisions, 1);
  assert.ok(report.purged_files >= 3);
  assert.equal(report.reconciled_orphan_objects, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM studio_sessions").get().n, 1);
  assert.ok(!bucket.objects.has("projects/orphan/rev/x/y"));
  assert.ok(bucket.objects.has("projects/fresh/rev/x/y"), "recent orphan must wait for the age threshold");
  for (const key of keeperObjects) assert.ok(bucket.objects.has(key), "committed objects must survive cleanup");
  const project = await call(env, ctx, USER_A, "GET", `/api/projects/${id}`);
  assert.equal(project.json.project.head_revision, 1, "head untouched by cleanup");

  // 5. Soft-deleted project: kept during retention, purged after it.
  await call(env, ctx, USER_A, "DELETE", `/api/projects/${id}`);
  const early = await runCleanup(env);
  assert.equal(early.purged_projects, 0);
  raw.prepare("UPDATE projects SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  const late = await runCleanup(env);
  assert.equal(late.purged_projects, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM project_files").get().n, 0);
  for (const key of keeperObjects) assert.ok(!bucket.objects.has(key), "purged project leaves no R2 objects");
});

test("revision retention keeps the newest N plus the head and the newest full snapshot", async () => {
  const { env, raw } = makeEnv({ vars: { STUDIO_KEEP_COMMITTED_REVISIONS: "1" } });
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "الاحتفاظ");

  // rev1: full snapshot.
  const rev1 = await openFullRevision(env, ctx, USER_A, id, null, "r1");
  await uploadAll(env, ctx, USER_A, rev1);
  await commit(env, ctx, USER_A, id, rev1.json.revision_id);

  // rev2 + rev3: honest source-only saves.
  let base = 1;
  const sourceOnlyIds = [];
  for (const label of ["r2", "r3"]) {
    const source = new TextEncoder().encode(`source-${label}`);
    const open = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, {
      base_revision: base,
      content_hash: await sha256Hex(source),
      snapshot_kind: "source-only",
      manifest: { degraded: true },
      files: [await fileDecl("source", source)],
    });
    assert.equal(open.response.status, 201);
    const { response } = await call(env, ctx, USER_A, "PUT", open.json.files[0].upload_url, source);
    assert.equal(response.status, 200);
    const done = await commit(env, ctx, USER_A, id, open.json.revision_id);
    assert.equal(done.response.status, 200);
    sourceOnlyIds.push(open.json.revision_id);
    base = open.json.revision;
  }

  const report = await runCleanup(env);
  assert.equal(report.pruned_committed_revisions, 1, "only the unprotected middle revision is pruned");
  const remaining = raw.prepare("SELECT id, snapshot_kind FROM project_revisions ORDER BY revision").all();
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].id, rev1.json.revision_id, "newest FULL snapshot is protected from retention");
  assert.equal(remaining[1].id, sourceOnlyIds[1], "head is protected");
});

test("uploads into a closed revision are refused", async () => {
  const { env } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "مغلق");
  const open = await openFullRevision(env, ctx, USER_A, id, null, "closed");
  await uploadAll(env, ctx, USER_A, open);
  await commit(env, ctx, USER_A, id, open.json.revision_id);

  // All files verified already → idempotent 200, never a rewrite of committed data.
  const byKind = Object.fromEntries(open.json.files.map((f) => [f.kind, f]));
  const rePut = await call(env, ctx, USER_A, "PUT", byKind.source.upload_url, open.payloads.source);
  assert.equal(rePut.response.status, 200);
  assert.equal(rePut.json.already, true);

  // A pending row under an abandoned revision refuses uploads.
  const open2 = await openFullRevision(env, ctx, USER_A, id, 1, "half");
  const revId2 = open2.json.revision_id;
  // Abandon WITHOUT the async purge having run yet: mark directly.
  const { env: _unused } = { env }; // keep signature obvious
  await call(env, { waitUntil() {}, flush: async () => {} }, USER_A, "POST", `/api/projects/${id}/revisions/${revId2}/abandon`);
  const putClosed = await call(env, ctx, USER_A, "PUT", open2.json.files[0].upload_url, open2.payloads.snapshot);
  assert.ok([404, 409].includes(putClosed.response.status), "abandoned revision must not accept uploads");
});

test("storage without an R2 binding answers an honest 503, never a fake success", async () => {
  const { env } = makeEnv();
  delete env.BUCKET;
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "بلا تخزين");
  const open = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions`, {
    base_revision: null,
    content_hash: HASH64,
    snapshot_kind: "full",
    manifest: {},
    files: [{ kind: "snapshot3mf", sha256: HASH64, size_bytes: 4 }],
  });
  assert.equal(open.response.status, 503);
  assert.equal(open.json.code, "STORAGE_NOT_CONFIGURED");
  const health = await call(env, ctx, null, "GET", "/api/health");
  assert.equal(health.json.r2, false);
});

// ---------------------------------------------------------------------------
// P1-09: project lifecycle (archive ≠ delete, trash), revision history and
// pinned revisions.
// ---------------------------------------------------------------------------

const pinsMod = await import("../worker/api/pins.ts");
const quotaMod = await import("../worker/api/quota.ts");

const DAY_MS = 86_400_000;
const MiB = 1024 * 1024;

async function committedFullRevision(env, ctx, session, projectId, base, label) {
  const open = await openFullRevision(env, ctx, session, projectId, base, label);
  assert.equal(open.response.status, 201, `OPEN ${label}`);
  await uploadAll(env, ctx, session, open);
  const done = await commit(env, ctx, session, projectId, open.json.revision_id);
  assert.equal(done.response.status, 200, `COMMIT ${label}`);
  return { id: open.json.revision_id, revision: open.json.revision, payloads: open.payloads, files: open.json.files };
}

async function listView(env, ctx, session, view) {
  const { response, json } = await call(env, ctx, session, "GET", `/api/projects?view=${view}`);
  assert.equal(response.status, 200, `list ${view}`);
  return json;
}

/** No storage internals or other holders' ids in an owner-facing DTO. */
function assertNoInternals(json, extraSecrets = []) {
  const text = JSON.stringify(json);
  for (const leak of ["owner_id", "thumbnail_key", "r2_key", "pin_ref", "projects/", ...extraSecrets]) {
    assert.ok(!text.includes(leak), `response leaks ${leak}: ${text.slice(0, 300)}`);
  }
}

test("archive is not delete: an archived project leaves the default list, stays readable, and cleanup never purges it", async () => {
  const { env, raw, bucket } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "أرشيف");
  await committedFullRevision(env, ctx, USER_A, id, null, "arch");
  const stored = [...bucket.objects.keys()];
  assert.ok(stored.length >= 3);

  const archived = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/archive`);
  assert.equal(archived.response.status, 200);
  assert.match(archived.json.project.archived_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(archived.json.project.deleted_at, undefined, "archiving never marks a delete");
  const again = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/archive`);
  assert.equal(again.json.project.archived_at, archived.json.project.archived_at, "archive is idempotent");
  assert.equal(raw.prepare("SELECT deleted_at FROM projects WHERE id = ?").get(id).deleted_at, null);

  assert.equal((await listView(env, ctx, USER_A, "active")).projects.length, 0);
  const archivedList = await listView(env, ctx, USER_A, "archived");
  assert.deepEqual(archivedList.projects.map((p) => p.id), [id]);
  assertNoInternals(archivedList);
  assert.equal((await listView(env, ctx, USER_A, "trash")).projects.length, 0, "an archived project is not in the trash");

  // Still fully readable: project, history, thumbnail.
  assert.equal((await call(env, ctx, USER_A, "GET", `/api/projects/${id}`)).response.status, 200);
  assert.equal((await call(env, ctx, USER_A, "GET", `/api/projects/${id}/revisions`)).response.status, 200);
  assert.equal((await call(env, ctx, USER_A, "GET", `/api/projects/${id}/thumbnail`)).response.status, 200);

  // Ten years of cron runs later, nothing of it is gone.
  const report = await runCleanup(env, Date.now() + 3650 * DAY_MS);
  assert.equal(report.purged_projects, 0);
  assert.equal(report.purged_revisions, 0);
  for (const key of stored) assert.ok(bucket.objects.has(key), "an archived project's objects are never reclaimed");

  // Another user can neither see nor move it.
  for (const action of ["archive", "unarchive", "restore"]) {
    const { response } = await call(env, ctx, USER_B, "POST", `/api/projects/${id}/${action}`);
    assert.equal(response.status, 404, `${action} must 404 for a non-owner`);
  }
  assert.equal((await listView(env, ctx, USER_B, "archived")).projects.length, 0);

  // Delete is its own state: an archived project moved to the trash shows in
  // the trash only, and a restore brings it back archived, as it was.
  await call(env, ctx, USER_A, "DELETE", `/api/projects/${id}`);
  assert.equal((await listView(env, ctx, USER_A, "archived")).projects.length, 0);
  assert.deepEqual((await listView(env, ctx, USER_A, "trash")).projects.map((p) => p.id), [id]);
  const restored = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/restore`);
  assert.equal(restored.response.status, 200);
  assert.ok(restored.json.project.archived_at, "restore keeps the archive state");

  // Unarchive returns it to the default list.
  const back = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/unarchive`);
  assert.equal(back.response.status, 200);
  assert.equal(back.json.project.archived_at, null);
  assert.deepEqual((await listView(env, ctx, USER_A, "active")).projects.map((p) => p.id), [id]);

  const badView = await call(env, ctx, USER_A, "GET", "/api/projects?view=everything");
  assert.equal(badView.response.status, 400);
});

test("delete moves to the trash: restorable inside the retention window, 410 after it, then purged", async () => {
  const { env, raw, bucket } = makeEnv({ vars: { STUDIO_DELETED_RETENTION_DAYS: "30" } });
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "سلة المحذوفات");
  await committedFullRevision(env, ctx, USER_A, id, null, "trash");

  const del = await call(env, ctx, USER_A, "DELETE", `/api/projects/${id}`);
  assert.equal(del.response.status, 200);
  assert.equal(Date.parse(del.json.purge_after) - Date.parse(del.json.deleted_at), 30 * DAY_MS);
  assert.equal((await call(env, ctx, USER_A, "GET", `/api/projects/${id}`)).response.status, 404);
  assert.equal((await listView(env, ctx, USER_A, "active")).projects.length, 0);
  const trash = await listView(env, ctx, USER_A, "trash");
  assert.equal(trash.retention_days, 30);
  assert.equal(trash.projects.length, 1);
  assert.equal(trash.projects[0].purge_after, del.json.purge_after);
  assertNoInternals(trash);
  assert.equal((await listView(env, ctx, USER_B, "trash")).projects.length, 0, "the trash is per owner");

  const restored = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/restore`);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.json.project.head_revision, 1, "a restore brings back the saved head untouched");
  assert.equal((await call(env, ctx, USER_A, "GET", `/api/projects/${id}`)).response.status, 200);
  assert.equal((await call(env, ctx, USER_A, "POST", `/api/projects/${id}/restore`)).json.already, true);

  // Past the window: not offered, not restorable, then purged by the cron.
  await call(env, ctx, USER_A, "DELETE", `/api/projects/${id}`);
  raw.prepare("UPDATE projects SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  assert.equal((await listView(env, ctx, USER_A, "trash")).projects.length, 0);
  const late = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/restore`);
  assert.equal(late.response.status, 410);
  assert.equal(late.json.code, "RETENTION_EXPIRED");
  const report = await runCleanup(env);
  assert.equal(report.purged_projects, 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await call(env, ctx, USER_A, "POST", `/api/projects/${id}/restore`)).response.status, 404);
});

test("a pinned revision survives retention, the deleted-project purge and every later cleanup run", async () => {
  const { env, raw, bucket } = makeEnv({ vars: { STUDIO_KEEP_COMMITTED_REVISIONS: "1" } });
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "مثبت");
  const rev1 = await committedFullRevision(env, ctx, USER_A, id, null, "r1");

  // A (test) request holds revision 1 — server code, never a client route.
  const pin = await pinsMod.pinRevision(env.DB, {
    ownerId: USER_A.user.id,
    projectId: id,
    revisionId: rev1.id,
    reason: "request",
    ref: "REQ-test-1",
  });
  assert.equal(pin.ok, true);
  const pinAgain = await pinsMod.pinRevision(env.DB, {
    ownerId: USER_A.user.id,
    projectId: id,
    revisionId: rev1.id,
    reason: "request",
    ref: "REQ-test-1",
  });
  assert.equal(pinAgain.already, true, "pinning twice for the same holder is idempotent");
  const rev1Keys = [...bucket.objects.keys()];

  let base = rev1.revision;
  const later = [];
  for (const label of ["r2", "r3", "r4"]) {
    const rev = await committedFullRevision(env, ctx, USER_A, id, base, label);
    later.push(rev);
    base = rev.revision;
  }

  // Retention keeps 1 unpinned revision (the head, r4): r2 and r3 go, the
  // pinned r1 — older than all of them — stays with every byte.
  const report = await runCleanup(env);
  assert.equal(report.pruned_committed_revisions, 2);
  const ids = raw.prepare("SELECT id FROM project_revisions ORDER BY revision").all().map((r) => r.id);
  assert.deepEqual(ids, [rev1.id, later[2].id]);
  for (const key of rev1Keys) assert.ok(bucket.objects.has(key), "a pinned revision keeps its objects");

  // Still readable by its owner after the forced run (the P1-09 done-when).
  const read = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/revisions/${rev1.id}`);
  assert.equal(read.response.status, 200);
  const snap = read.json.files.find((f) => f.kind === "snapshot3mf");
  const bytes = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/files/${snap.id}`);
  assert.equal(bytes.response.status, 200);
  assert.deepEqual(new Uint8Array(await bytes.response.arrayBuffer()), rev1.payloads.snapshot);

  // History reports the pin by reason only — never the holder's id.
  const history = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/revisions?state=committed`);
  const entry = history.json.revisions.find((r) => r.id === rev1.id);
  assert.equal(entry.pinned, true);
  assert.deepEqual(entry.pin_reasons, ["request"]);
  assert.equal(history.json.revisions.find((r) => r.id === later[2].id).pinned, false);
  assertNoInternals(history.json, ["REQ-test-1"]);

  // A second run finds nothing more to do (pins never keep a project queued).
  const quiet = await runCleanup(env);
  assert.equal(quiet.pruned_committed_revisions, 0);

  // Deleted and past retention: everything unpinned goes, the pinned revision
  // and a deleted tombstone that owns it stay.
  await call(env, ctx, USER_A, "DELETE", `/api/projects/${id}`);
  raw.prepare("UPDATE projects SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  const purge = await runCleanup(env);
  assert.equal(purge.purged_projects, 0, "a project holding a pinned revision is not purged");
  assert.equal(purge.kept_pinned_revisions, 1);
  assert.deepEqual(raw.prepare("SELECT id FROM project_revisions").all().map((r) => r.id), [rev1.id]);
  const tomb = raw.prepare("SELECT deleted_at, head_revision_id FROM projects WHERE id = ?").get(id);
  assert.ok(tomb.deleted_at);
  assert.equal(tomb.head_revision_id, null);
  assert.deepEqual([...bucket.objects.keys()].sort(), [...rev1Keys].sort());
  assert.equal((await listView(env, ctx, USER_A, "trash")).projects.length, 0, "a tombstone is never offered");

  // Later runs neither re-select the tombstone nor touch the pin.
  const after = await runCleanup(env, Date.now() + 3650 * DAY_MS);
  assert.equal(after.kept_pinned_revisions, 0);
  assert.equal(after.purged_files, 0);
  for (const key of rev1Keys) assert.ok(bucket.objects.has(key));

  // Belt and braces: the purge helper refuses it, and so does the database.
  assert.equal(await cleanupMod.purgeRevisionById(env.DB, bucket, rev1.id), 0);
  assert.throws(() => raw.prepare("DELETE FROM project_revisions WHERE id = ?").run(rev1.id), /FOREIGN KEY/);

  // Releasing the last holder hands it back to the cron.
  const release = await pinsMod.unpinRevision(env.DB, {
    ownerId: USER_A.user.id,
    projectId: id,
    revisionId: rev1.id,
    reason: "request",
    ref: "REQ-test-1",
  });
  assert.deepEqual(release, { ok: true, released: true });
  const final = await runCleanup(env);
  assert.equal(final.purged_projects, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 0);
  assert.equal(bucket.objects.size, 0);
});

test("pins: the owner's keep-this-version is the only pin a client can set or release", async () => {
  const { env } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "احتفظ");
  const rev1 = await committedFullRevision(env, ctx, USER_A, id, null, "k1");

  const pinned = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${rev1.id}/pin`);
  assert.equal(pinned.response.status, 200);
  assert.deepEqual(pinned.json.pin_reasons, ["user"]);
  assert.equal(await pinsMod.isRevisionPinned(env.DB, rev1.id), true);

  // Non-owners: 404 on both verbs, and the pin is untouched.
  for (const method of ["POST", "DELETE"]) {
    const { response } = await call(env, ctx, USER_B, method, `/api/projects/${id}/revisions/${rev1.id}/pin`);
    assert.equal(response.status, 404);
  }
  assert.equal(
    (await pinsMod.pinRevision(env.DB, { ownerId: USER_B.user.id, projectId: id, revisionId: rev1.id, reason: "user" })).ok,
    false
  );

  // A pending upload is not a version anyone can hold.
  const pending = await openFullRevision(env, ctx, USER_A, id, 1, "pending");
  const pendingPin = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${pending.json.revision_id}/pin`);
  assert.equal(pendingPin.response.status, 409);
  assert.equal(pendingPin.json.code, "NOT_COMMITTED");

  // Server-side holders: a reason must be known and carry a holder id.
  for (const bad of [
    { reason: "forever", ref: "x" },
    { reason: "request", ref: "" },
    { reason: "order", ref: "has spaces" },
  ]) {
    const result = await pinsMod.pinRevision(env.DB, { ownerId: USER_A.user.id, projectId: id, revisionId: rev1.id, ...bad });
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  await pinsMod.pinRevision(env.DB, { ownerId: USER_A.user.id, projectId: id, revisionId: rev1.id, reason: "order", ref: "ORD-1" });

  // Releasing the owner's pin leaves the order's pin in place.
  const released = await call(env, ctx, USER_A, "DELETE", `/api/projects/${id}/revisions/${rev1.id}/pin`);
  assert.equal(released.response.status, 200);
  assert.equal(released.json.pinned, true);
  assert.deepEqual(released.json.pin_reasons, ["order"]);
  assertNoInternals(released.json, ["ORD-1"]);
});

test("history: restoring a kept revision makes a NEW head with its content; history is never rewritten", async () => {
  const { env, raw } = makeEnv();
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "سجل");
  const rev1 = await committedFullRevision(env, ctx, USER_A, id, null, "r1");
  const rev2 = await committedFullRevision(env, ctx, USER_A, id, 1, "r2");

  const restore = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${rev1.id}/restore`, {
    base_revision: 2,
  });
  assert.equal(restore.response.status, 201);
  assert.equal(restore.json.revision, 3);
  assert.deepEqual(restore.json.restored_from, { revision: 1, revision_id: rev1.id });

  const project = await call(env, ctx, USER_A, "GET", `/api/projects/${id}`);
  assert.equal(project.json.project.head_revision, 3);
  assert.equal(project.json.project.head_revision_id, restore.json.revision_id);

  // The new head carries revision 1's manifest and bytes, and points back.
  const head = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/revisions/${restore.json.revision_id}`);
  assert.equal(head.json.revision.parent_revision, 2, "the restore is built on the head it replaced");
  assert.equal(head.json.revision.manifest.label, "r1");
  assert.equal(head.json.revision.manifest.restored_from.revision, 1);
  const snap = head.json.files.find((f) => f.kind === "snapshot3mf");
  const bytes = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/files/${snap.id}`);
  assert.deepEqual(new Uint8Array(await bytes.response.arrayBuffer()), rev1.payloads.snapshot);
  const thumb = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/thumbnail`);
  assert.deepEqual(new Uint8Array(await thumb.response.arrayBuffer()), rev1.payloads.thumb);

  // Nothing was rewritten: revisions 1 and 2 are still committed, with files.
  const states = raw.prepare("SELECT id, state FROM project_revisions ORDER BY revision").all();
  assert.deepEqual(
    states.map((r) => r.state),
    ["committed", "committed", "committed"]
  );
  assert.equal(states[1].id, rev2.id);

  // A stale view of the head never clobbers: 409 with the fresh head.
  const stale = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${rev2.id}/restore`, {
    base_revision: 2,
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.json.head.revision, 3);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM project_revisions").get().n, 3, "a refused restore adds nothing");

  // Restoring the head is a no-op; a pending or foreign revision is not found.
  const same = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${restore.json.revision_id}/restore`, {});
  assert.equal(same.json.already, true);
  const pending = await openFullRevision(env, ctx, USER_A, id, 3, "p");
  const pendingRestore = await call(env, ctx, USER_A, "POST", `/api/projects/${id}/revisions/${pending.json.revision_id}/restore`, {});
  assert.equal(pendingRestore.response.status, 404);
  const foreign = await call(env, ctx, USER_B, "POST", `/api/projects/${id}/revisions/${rev2.id}/restore`, {});
  assert.equal(foreign.response.status, 404);

  // The history sheet's list: committed only, newest first, pins reported.
  const history = await call(env, ctx, USER_A, "GET", `/api/projects/${id}/revisions?state=committed`);
  assert.deepEqual(
    history.json.revisions.map((r) => r.revision),
    [3, 2, 1]
  );
  assert.ok(history.json.revisions.every((r) => r.pinned === false && Array.isArray(r.pin_reasons)));
  assert.equal(history.json.kept_committed_revisions, 20);
  assertNoInternals(history.json);
});

test("migration 0001 is safe on every path: after 0000, after the bootstrap made its tables, and applied twice", async () => {
  // A database at 0000 (the live shape before this push) serves the new code:
  // the bootstrap creates the side tables, archive and pins just work.
  const { env, raw } = makeEnv({ applyMigration: "0000" });
  const ctx = makeCtx();
  const id = await createProject(env, ctx, USER_A, "قبل الترحيل");
  assert.equal((await call(env, ctx, USER_A, "POST", `/api/projects/${id}/archive`)).response.status, 200);
  assert.equal((await listView(env, ctx, USER_A, "archived")).projects.length, 1);
  // The workflow then applies 0001 over tables the worker already made.
  assert.doesNotThrow(() => applySql(raw, MIGRATION_0001_SQL));
  assert.doesNotThrow(() => applySql(raw, MIGRATION_0001_SQL));
  assert.equal((await listView(env, ctx, USER_A, "archived")).projects.length, 1, "no data lost");
  // And a cron run on a database no API call has touched yet still works.
  const cold = makeEnv({ applyMigration: "0000" });
  const report = await runCleanup(cold.env);
  assert.equal(report.purged_projects, 0);
});

test("the per-user quota defaults to 1 GiB (owner decision Q7); the env override still wins; max file stays 64 MiB", async () => {
  assert.equal(quotaMod.DEFAULT_USER_QUOTA_BYTES, 1024 * 1024 * 1024);
  const { env } = makeEnv();
  const ctx = makeCtx();
  const quota = await call(env, ctx, USER_A, "GET", "/api/quota");
  assert.equal(quota.json.quota_bytes, 1024 * 1024 * 1024);
  assert.equal(quota.json.limits.max_file_bytes, 64 * MiB);
  const small = makeEnv({ vars: { STUDIO_USER_QUOTA_BYTES: String(5 * MiB) } });
  const overridden = await call(small.env, ctx, USER_A, "GET", "/api/quota");
  assert.equal(overridden.json.quota_bytes, 5 * MiB);
});
