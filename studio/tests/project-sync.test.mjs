/**
 * Behavioral tests for the S5 client sync layer (docs/STUDIO_PLAN.md decision
 * 4 client side; acceptance tests T5/T6 client half).
 *
 * Drives the REAL app/project-sync.ts protocol runner and controller (loaded
 * through Node's built-in TypeScript type stripping) against a scripted fake
 * of the S3 API surface, plus the pure namespace/merge helpers from
 * app/project-store.ts and the pure blank-detection from app/thumbnail.ts.
 *
 * What this deliberately does NOT cover (honest limits):
 *  - IndexedDB itself (no IDB in node) — only the pure merge/migration
 *    helpers the store is built from;
 *  - the real worker API (covered by tests/api-projects.test.mjs);
 *  - React (the hook is a thin binding over the controller tested here);
 *  - real canvas capture (DOM-only; only the uniform-image detector runs).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-zA-Z]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall back */
      }
    }
    return nextResolve(specifier, context);
  },
});

const sync = await import("../app/project-sync.ts");
const store = await import("../app/project-store.ts");
const thumb = await import("../app/thumbnail.ts");

const {
  ProjectSyncController,
  uploadSnapshotRevision,
  createStudioProjectsApi,
  sha256HexOf,
  combinedContentHash,
  StudioApiError,
} = sync;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const settle = async () => {
  // Mix of immediates and 1 ms timers: crypto.subtle digests resolve on the
  // threadpool, so pure-microtask flushing is not enough under load.
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (i % 3 === 2) await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** Waits for a controller's save chain to fully quiesce. */
const idle = async (controller) => {
  await settle();
  await controller.whenIdle();
  await settle();
};

function makeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const timers = {
    set(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    now() {
      return now;
    },
  };
  const advance = async (ms) => {
    now += ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
        await settle();
      }
    }
  };
  return { timers, advance, pendingCount: () => pending.size };
}

/** Minimal fake of the StudioProjectsApi surface the controller/uploader use. */
function makeFakeApi(overrides = {}) {
  const calls = [];
  const record = (name, args) => calls.push({ name, args });
  let revisionSeq = 0;
  let lastOpenedRevision = 0;
  const api = {
    calls,
    async listProjects(opts = {}) {
      record("listProjects", opts);
      return overrides.projects ?? [];
    },
    async createProject(name) {
      record("createProject", { name });
      return { id: "proj-new", name, head_revision: null };
    },
    async getProject(id) {
      record("getProject", { id });
      if (overrides.getProject) return overrides.getProject(id);
      return { id, name: "P", head_revision: overrides.headRevision ?? null, head_revision_id: null };
    },
    async renameProject(id, name) {
      record("renameProject", { id, name });
      return { id, name };
    },
    async deleteProject(id) {
      record("deleteProject", { id });
    },
    async duplicateProject(id, name) {
      record("duplicateProject", { id, name });
      return { id: `${id}-copy`, name: name ?? "copy" };
    },
    async listRevisions(id) {
      record("listRevisions", { id });
      return { head_revision_id: null, revisions: [] };
    },
    async getRevision(projectId, revisionId) {
      record("getRevision", { projectId, revisionId });
      return overrides.getRevision(projectId, revisionId);
    },
    async openRevision(projectId, body, _signal) {
      record("openRevision", { projectId, body });
      if (overrides.openRevision) return overrides.openRevision(projectId, body);
      revisionSeq += 1;
      lastOpenedRevision = (body.base_revision ?? 0) + 1;
      return {
        revision_id: `rev-${revisionSeq}`,
        revision: lastOpenedRevision,
        files: body.files.map((f, i) => ({
          id: `file-${revisionSeq}-${i}`,
          kind: f.kind,
          sha256: f.sha256,
          size_bytes: f.size_bytes,
          content_type: f.content_type ?? null,
          state: "pending",
          upload_url: `/api/uploads/file-${revisionSeq}-${i}`,
        })),
      };
    },
    async uploadFile(fileId, blob, _signal) {
      record("uploadFile", { fileId, size: blob.size });
      if (overrides.uploadFile) return overrides.uploadFile(fileId, blob);
    },
    async commitRevision(projectId, revisionId) {
      record("commitRevision", { projectId, revisionId });
      if (overrides.commitRevision) return overrides.commitRevision(projectId, revisionId);
      return { revision: lastOpenedRevision || 1, revision_id: revisionId, committed_at: "now" };
    },
    async abandonRevision(projectId, revisionId) {
      record("abandonRevision", { projectId, revisionId });
    },
    async downloadFile(projectId, fileId) {
      record("downloadFile", { projectId, fileId });
      return overrides.downloadFile(projectId, fileId);
    },
    async quota() {
      return { usage_bytes: 0, quota_bytes: 1, remaining_bytes: 1 };
    },
    thumbnailUrl(projectId) {
      return `/api/projects/${projectId}/thumbnail`;
    },
  };
  return api;
}

const named = (calls, name) => calls.filter((c) => c.name === name);

// ---------------------------------------------------------------------------
// project-store pure helpers
// ---------------------------------------------------------------------------

test("namespaceForUser separates users, guests never share a user namespace", () => {
  assert.equal(store.namespaceForUser("u-1"), "user:u-1");
  assert.equal(store.namespaceForUser("u-2"), "user:u-2");
  assert.equal(store.namespaceForUser(null), store.GUEST_NAMESPACE);
  assert.equal(store.namespaceForUser(undefined), "guest");
  assert.equal(store.namespaceForUser(""), "guest");
  assert.notEqual(store.namespaceForUser("guest"), "guest"); // a user literally named "guest" stays distinct
  assert.equal(store.draftKey("user:u-1", "p1"), "user:u-1/p1");
});

test("legacy v1 records migrate into the legacy namespace, adopted by nobody", () => {
  const file = new File(["x"], "part.3mf", { type: "model/3mf" });
  const migrated = store.legacyRecordToDraft({
    id: "old-1",
    name: "Old",
    updatedAt: 5,
    files: [file],
    profileId: "p",
    quality: "standard",
    strength: "standard",
    support: false,
    snapshotVersion: 2,
  });
  assert.equal(migrated.namespace, store.LEGACY_NAMESPACE);
  assert.equal(migrated.key, "legacy/old-1");
  assert.equal(migrated.snapshotKind, "full");
  assert.ok(migrated.fullSnapshot, "a v2 snapshot is protected as the full snapshot");
  // A record without the v2 marker is honestly source-only.
  const degraded = store.legacyRecordToDraft({
    id: "old-2", name: "Old2", updatedAt: 6, files: [file],
    profileId: "p", quality: "q", strength: "s", support: true,
  });
  assert.equal(degraded.snapshotKind, "source-only");
  assert.equal(degraded.fullSnapshot, null);
});

test("mergeDraftForSave: a source-only save never replaces the last full snapshot", () => {
  const fullFile = new File(["full"], "proj.3mf", { type: "model/3mf" });
  const srcFile = new File(["stl"], "part.stl");
  const base = store.mergeDraftForSave(
    undefined,
    {
      id: "p1", name: "P", updatedAt: 10, files: [fullFile],
      profileId: "pr", quality: "q", strength: "s", support: false,
      snapshotKind: "full", contentHash: "aa",
      remote: { projectId: "r1", revision: 3, syncedAt: 10, snapshotKind: "full" },
    },
    "user:u-1"
  );
  assert.equal(base.fullSnapshot?.file, fullFile);
  assert.equal(base.key, "user:u-1/p1");

  const afterDegraded = store.mergeDraftForSave(
    base,
    {
      id: "p1", name: "P", updatedAt: 20, files: [srcFile],
      profileId: "pr", quality: "q", strength: "s", support: false,
      snapshotKind: "source-only", contentHash: "bb",
    },
    "user:u-1"
  );
  assert.equal(afterDegraded.snapshotKind, "source-only", "degraded save stays honestly labeled");
  assert.equal(afterDegraded.fullSnapshot?.file, fullFile, "last FULL snapshot survives a degraded save");
  assert.equal(afterDegraded.fullSnapshot?.updatedAt, 10);
  assert.equal(afterDegraded.remote?.projectId, "r1", "remote link survives saves that do not restate it");

  const afterNewFull = store.mergeDraftForSave(
    afterDegraded,
    {
      id: "p1", name: "P", updatedAt: 30, files: [fullFile],
      profileId: "pr", quality: "q", strength: "s", support: false,
      snapshotVersion: 2, contentHash: "cc",
    },
    "user:u-1"
  );
  assert.equal(afterNewFull.snapshotKind, "full", "snapshotVersion 2 maps to full");
  assert.equal(afterNewFull.fullSnapshot?.updatedAt, 30, "a new full save refreshes the protected snapshot");
});

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

test("sha256HexOf matches the known vector; combinedContentHash is order-insensitive", async () => {
  assert.equal(
    await sha256HexOf(new Blob(["abc"])),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  const a = await combinedContentHash(["11", "22"]);
  const b = await combinedContentHash(["22", "11"]);
  assert.equal(a, b);
  assert.notEqual(a, await combinedContentHash(["11", "33"]));
});

// ---------------------------------------------------------------------------
// thumbnail blank detection (pure part)
// ---------------------------------------------------------------------------

test("isUniformImage detects blank read-backs and passes real content", () => {
  const w = 24;
  const h = 24;
  const blank = new Uint8ClampedArray(w * h * 4).fill(16);
  assert.equal(thumb.isUniformImage(blank, w, h), true, "uniform pixels ⇒ blank");
  const painted = new Uint8ClampedArray(blank);
  // (13,13) falls on the detector's 12×12 sampling grid for a 24×24 image.
  const i = (13 * w + 13) * 4;
  painted[i] = 250;
  painted[i + 1] = 40;
  assert.equal(thumb.isUniformImage(painted, w, h), false, "a differing sampled pixel ⇒ content");
});

// ---------------------------------------------------------------------------
// API client path construction
// ---------------------------------------------------------------------------

test("api client calls same-origin /api paths with credentials and encodes ids", async () => {
  const seen = [];
  const api = createStudioProjectsApi(async (input, init = {}) => {
    seen.push({ input, init });
    return new Response(JSON.stringify({ success: true, project: { id: "x" }, projects: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await api.listProjects({ q: "بحث" });
  await api.getProject("abc/../def"); // hostile id stays inside /api/projects/<encoded>
  await api.renameProject("p1", "الاسم");
  for (const { input, init } of seen) {
    assert.ok(input.startsWith("/api/"), `same-origin relative path: ${input}`);
    assert.equal(init.credentials, "same-origin");
  }
  assert.ok(seen[1].input.includes(encodeURIComponent("abc/../def")), "path segments are encoded");
  assert.equal(api.thumbnailUrl("p2"), "/api/projects/p2/thumbnail");
});

test("api client surfaces API errors as typed StudioApiError", async () => {
  const api = createStudioProjectsApi(async () =>
    new Response(JSON.stringify({ success: false, code: "QUOTA_EXCEEDED", error: "full", usage_bytes: 9 }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    })
  );
  await assert.rejects(
    () => api.createProject("x"),
    (error) => error instanceof StudioApiError && error.code === "QUOTA_EXCEEDED" && error.status === 413 && error.extra.usage_bytes === 9
  );
});

// ---------------------------------------------------------------------------
// uploadSnapshotRevision — the OPEN → UPLOAD → COMMIT protocol
// ---------------------------------------------------------------------------

const fullInput = (api, extra = {}) => ({
  projectId: "proj-1",
  baseRevision: 2,
  snapshotKind: "full",
  manifest: { version: 1, generator: "levo-studio", project: { name: "P" } },
  schemaVersion: 2,
  engineVersion: "three-slicer@0.2.2",
  files: [
    { kind: "snapshot3mf", name: "P.3mf", blob: new Blob(["3mf-bytes"]), contentType: "model/3mf" },
    { kind: "thumbnail", name: "thumbnail.png", blob: new Blob(["png"]), contentType: "image/png" },
  ],
  ...extra,
});

test("upload happy path: OPEN declares hash/size/base, uploads every file, commits", async () => {
  const api = makeFakeApi();
  const result = await uploadSnapshotRevision(fullInput(api), { api, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 3);
  assert.equal(result.snapshotKind, "full");
  assert.equal(result.contentHash, await sha256HexOf(new Blob(["3mf-bytes"])), "content hash = snapshot sha256");

  const open = named(api.calls, "openRevision")[0].args.body;
  assert.equal(open.base_revision, 2);
  assert.equal(open.snapshot_kind, "full");
  assert.equal(open.files.length, 2);
  assert.equal(open.files[0].sha256, result.contentHash);
  assert.equal(open.files[0].size_bytes, 9);
  assert.ok(Array.isArray(open.manifest.files), "manifest carries the name↔hash map");
  assert.equal(open.manifest.files[0].name, "P.3mf");

  assert.equal(named(api.calls, "uploadFile").length, 2);
  assert.equal(named(api.calls, "commitRevision").length, 1);
  assert.equal(named(api.calls, "abandonRevision").length, 0);
});

test("dishonest shapes are rejected locally (full needs exactly one snapshot3mf)", async () => {
  const api = makeFakeApi();
  const result = await uploadSnapshotRevision(
    fullInput(api, { files: [{ kind: "source", name: "a.stl", blob: new Blob(["s"]) }] }),
    { api }
  );
  assert.deepEqual([result.ok, result.kind], [false, "local"]);
  assert.equal(api.calls.length, 0, "nothing reaches the network");
});

test("OPEN 409 surfaces a conflict with the server head — nothing uploaded, nothing clobbered", async () => {
  const api = makeFakeApi({
    openRevision() {
      throw new StudioApiError(409, "REVISION_CONFLICT", "moved", { head: { revision: 7, revision_id: "r7" } });
    },
  });
  const result = await uploadSnapshotRevision(fullInput(api), { api, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "conflict");
  assert.deepEqual(result.head, { revision: 7, revision_id: "r7" });
  assert.equal(named(api.calls, "uploadFile").length, 0);
  assert.equal(named(api.calls, "commitRevision").length, 0);
});

test("COMMIT 409 surfaces a conflict and abandons the pending revision", async () => {
  const api = makeFakeApi({
    commitRevision() {
      throw new StudioApiError(409, "REVISION_CONFLICT", "another device", { head: { revision: 9, revision_id: "r9" } });
    },
  });
  const result = await uploadSnapshotRevision(fullInput(api), { api, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "conflict");
  assert.equal(result.head.revision, 9);
  await settle();
  assert.equal(named(api.calls, "abandonRevision").length, 1);
});

test("network failures on UPLOAD retry with backoff, then fail retryable + abandon", async () => {
  let puts = 0;
  const delays = [];
  const api = makeFakeApi({
    uploadFile() {
      puts += 1;
      throw new TypeError("fetch failed");
    },
  });
  const result = await uploadSnapshotRevision(fullInput(api), {
    api,
    networkAttempts: 3,
    retryDelayMs: (attempt) => {
      delays.push(attempt);
      return 0;
    },
    sleep: async () => {},
  });
  assert.equal(puts, 3, "3 attempts for the first file");
  assert.deepEqual(delays, [1, 2]);
  assert.deepEqual([result.ok, result.kind, result.retryable], [false, "network", true]);
  await settle();
  assert.equal(named(api.calls, "abandonRevision").length, 1, "orphaned pending revision is released");
});

test("transient UPLOAD failure recovers on retry (idempotent PUT)", async () => {
  let puts = 0;
  const api = makeFakeApi({
    uploadFile() {
      puts += 1;
      if (puts === 1) throw new TypeError("fetch failed");
    },
  });
  const result = await uploadSnapshotRevision(fullInput(api), { api, sleep: async () => {}, retryDelayMs: () => 0 });
  assert.equal(result.ok, true);
  assert.equal(puts, 3, "1 failed + retried + second file");
});

test("abort cancels the run: cancelled result, pending revision abandoned", async () => {
  const controller = new AbortController();
  const api = makeFakeApi({
    uploadFile() {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  });
  const result = await uploadSnapshotRevision(fullInput(api), { api, signal: controller.signal, sleep: async () => {} });
  assert.deepEqual([result.ok, result.kind], [false, "cancelled"]);
  await settle();
  assert.equal(named(api.calls, "abandonRevision").length, 1);
});

test("401 anywhere is an auth failure, never retried as network", async () => {
  const api = makeFakeApi({
    openRevision() {
      throw new StudioApiError(401, "AUTH_REQUIRED", "sign in");
    },
  });
  const result = await uploadSnapshotRevision(fullInput(api), { api, sleep: async () => {} });
  assert.deepEqual([result.ok, result.kind], [false, "auth"]);
  assert.equal(named(api.calls, "openRevision").length, 1, "no retries on auth");
});

// ---------------------------------------------------------------------------
// ProjectSyncController — the five states, debounce, cancel, conflict choice
// ---------------------------------------------------------------------------

function makeCallbacks(overrides = {}) {
  const persisted = [];
  const callbacks = {
    persisted,
    async captureSnapshot() {
      return overrides.captureSnapshot === null
        ? null
        : { file: new Blob(["snapshot"]), name: "P.3mf" };
    },
    getSourceFiles() {
      return overrides.sourceFiles ?? [new File(["src"], "part.stl")];
    },
    async captureThumbnail() {
      return null; // honest: no canvas in node, no fake thumbnail
    },
    buildManifest() {
      return { version: 1, generator: "levo-studio", project: { name: "P" } };
    },
    getMeta() {
      return { schemaVersion: 2, engineVersion: "three-slicer@0.2.2" };
    },
    async persistDraft(payload) {
      persisted.push(payload);
    },
  };
  return callbacks;
}

test("guest: debounced edit → captured, persisted locally, NEVER presented as synced", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  const statuses = [];
  let uploaderCalls = 0;
  const controller = new ProjectSyncController({
    userId: null,
    callbacks,
    timers,
    debounceMs: 1000,
    uploader: async () => {
      uploaderCalls += 1;
      return { ok: true, revision: 1, revisionId: "x", committedAt: null, contentHash: "h", snapshotKind: "full" };
    },
  });
  controller.subscribe((s) => statuses.push(s.status));

  controller.markDirty();
  assert.equal(controller.getState().status, "unsaved");
  await advance(999);
  assert.equal(callbacks.persisted.length, 0, "debounce not elapsed yet");
  await advance(1);
  await idle(controller);

  assert.equal(callbacks.persisted.length, 1);
  assert.equal(callbacks.persisted[0].kind, "full");
  assert.equal(controller.getState().status, "saved-local");
  assert.equal(uploaderCalls, 0, "guests upload nothing");
  assert.ok(!statuses.includes("synced"), "local save is never shown as synced");
  controller.dispose();
});

test("engine snapshot failure degrades honestly to source-only", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks({ captureSnapshot: null });
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 10 });
  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.persisted[0].kind, "source-only");
  assert.equal(controller.getState().lastLocalKind, "source-only");
  controller.dispose();
});

test("signed-in + linked: unsaved → saved-local → uploading → synced, and unchanged content skips re-upload", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  const api = makeFakeApi();
  const statuses = [];
  const uploaderInputs = [];
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api,
    debounceMs: 500,
    uploader: async (input) => {
      uploaderInputs.push(input);
      return {
        ok: true,
        revision: (input.baseRevision ?? 0) + 1,
        revisionId: "rev-a",
        committedAt: "now",
        contentHash: input.contentHash ?? "h",
        snapshotKind: input.snapshotKind,
      };
    },
  });
  controller.subscribe((s) => statuses.push(s.status));
  controller.linkRemoteProject("proj-1", 4);

  controller.markDirty();
  await advance(500);
  await idle(controller);

  assert.equal(uploaderInputs.length, 1);
  assert.equal(uploaderInputs[0].baseRevision, 4);
  assert.equal(uploaderInputs[0].projectId, "proj-1");
  const state = controller.getState();
  assert.equal(state.status, "synced");
  assert.equal(state.lastSyncedRevision, 5);
  assert.equal(state.lastSyncedKind, "full");
  for (const expected of ["unsaved", "saved-local", "uploading", "synced"]) {
    assert.ok(statuses.includes(expected), `state ${expected} was visible`);
  }
  // linkRemoteProject legitimately reports "synced" once (server head just
  // loaded); the COMMIT-driven synced must come after the upload.
  assert.ok(statuses.lastIndexOf("synced") > statuses.indexOf("uploading"));

  // Same content again → incremental skip: no second uploader run.
  controller.markDirty();
  await advance(500);
  await idle(controller);
  assert.equal(uploaderInputs.length, 1, "unchanged hash is not re-uploaded");
  assert.equal(controller.getState().status, "synced");
  controller.dispose();
});

test("conflict: surfaced with a real choice; overwrite rebases onto the fresh server head", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  const api = makeFakeApi({ getProject: () => ({ id: "proj-1", name: "P", head_revision: 9, head_revision_id: "r9" }) });
  const uploaderInputs = [];
  let fail = true;
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api,
    debounceMs: 100,
    uploader: async (input) => {
      uploaderInputs.push(input);
      if (fail) return { ok: false, kind: "conflict", head: { revision: 8, revision_id: "r8" } };
      return { ok: true, revision: input.baseRevision + 1, revisionId: "r10", committedAt: "now", contentHash: input.contentHash ?? "h", snapshotKind: input.snapshotKind };
    },
  });
  controller.linkRemoteProject("proj-1", 4);
  controller.markDirty();
  await advance(100);
  await idle(controller);

  let state = controller.getState();
  assert.equal(state.status, "failed");
  assert.deepEqual(state.conflict, { head: { revision: 8, revision_id: "r8" } });
  assert.equal(state.nextRetryAt, null, "conflicts are never auto-retried into an overwrite");

  // Editing while the conflict is pending never uploads silently.
  controller.markDirty();
  await advance(100);
  await idle(controller);
  assert.equal(uploaderInputs.length, 1, "unresolved conflict blocks uploads");

  fail = false;
  await controller.resolveConflict("overwrite");
  await settle();
  state = controller.getState();
  assert.equal(uploaderInputs.length, 2);
  assert.equal(uploaderInputs[1].baseRevision, 9, "rebased onto the FRESH server head, not the stale 409 head");
  assert.equal(state.status, "synced");
  assert.equal(state.conflict, null);
  controller.dispose();
});

test("conflict: keep-remote clears the conflict without uploading anything", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  const uploaderInputs = [];
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api: makeFakeApi(),
    debounceMs: 100,
    uploader: async (input) => {
      uploaderInputs.push(input);
      return { ok: false, kind: "conflict", head: { revision: 8, revision_id: "r8" } };
    },
  });
  controller.linkRemoteProject("proj-1", 4);
  controller.markDirty();
  await advance(100);
  await idle(controller);
  assert.equal(controller.getState().status, "failed");

  await controller.resolveConflict("keep-remote");
  const state = controller.getState();
  assert.equal(state.conflict, null);
  assert.equal(state.status, "saved-local", "the local draft honestly stays local");
  assert.equal(uploaderInputs.length, 1, "keep-remote uploads nothing");
  controller.dispose();
});

test("conflict: fork saves this device's content as a NEW project, other head untouched", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  const api = makeFakeApi();
  const uploaderInputs = [];
  let fail = true;
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api,
    debounceMs: 100,
    uploader: async (input) => {
      uploaderInputs.push(input);
      if (fail) return { ok: false, kind: "conflict", head: { revision: 8, revision_id: "r8" } };
      return { ok: true, revision: 1, revisionId: "r-fork", committedAt: "now", contentHash: input.contentHash ?? "h", snapshotKind: input.snapshotKind };
    },
  });
  controller.linkRemoteProject("proj-1", 4);
  controller.markDirty();
  await advance(100);
  await idle(controller);
  assert.equal(controller.getState().status, "failed");

  fail = false;
  await controller.resolveConflict("fork");
  await idle(controller);
  const state = controller.getState();
  assert.equal(named(api.calls, "createProject").length, 1, "a new project was created");
  assert.equal(state.remoteProjectId, "proj-new", "the session now targets the fork");
  assert.equal(uploaderInputs.length, 2);
  assert.equal(uploaderInputs[1].projectId, "proj-new");
  assert.equal(uploaderInputs[1].baseRevision, null, "the fork starts from an empty base");
  assert.equal(state.status, "synced");
  assert.equal(state.conflict, null);
  controller.dispose();
});

test("retryable failure: failed-retry state with backoff, auto-retry succeeds", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  let attempts = 0;
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api: makeFakeApi(),
    debounceMs: 100,
    retryDelayMs: () => 2000,
    uploader: async (input) => {
      attempts += 1;
      if (attempts === 1) return { ok: false, kind: "network", message: "offline", retryable: true };
      return { ok: true, revision: 5, revisionId: "r", committedAt: "now", contentHash: input.contentHash ?? "h", snapshotKind: input.snapshotKind };
    },
  });
  controller.linkRemoteProject("proj-1", 4);
  controller.markDirty();
  await advance(100);
  await idle(controller);

  let state = controller.getState();
  assert.equal(state.status, "failed");
  assert.equal(state.failure.kind, "network");
  assert.equal(state.failure.retryable, true);
  assert.equal(state.nextRetryAt, timers.now() + 2000);

  await advance(2000);
  await idle(controller);
  state = controller.getState();
  assert.equal(state.status, "synced");
  assert.equal(state.retryCount, 0);
  controller.dispose();
});

test("auth/quota failures are terminal: no auto-retry timer", async () => {
  for (const kind of ["auth", "quota"]) {
    const { timers, advance, pendingCount } = makeTimers();
    const callbacks = makeCallbacks();
    const controller = new ProjectSyncController({
      userId: "u-1",
      callbacks,
      timers,
      api: makeFakeApi(),
      debounceMs: 100,
      uploader: async () => ({ ok: false, kind, message: kind }),
    });
    controller.linkRemoteProject("proj-1", 1);
    controller.markDirty();
    await advance(100);
    await idle(controller);
    const state = controller.getState();
    assert.equal(state.status, "failed");
    assert.equal(state.failure.kind, kind);
    assert.equal(state.failure.retryable, false);
    assert.equal(pendingCount(), 0, `no retry timer scheduled after ${kind}`);
    controller.dispose();
  }
});

test("dispose (logout/account switch) cancels timers and blocks every later write", async () => {
  const { timers, advance, pendingCount } = makeTimers();
  const callbacks = makeCallbacks();
  let uploaderCalls = 0;
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api: makeFakeApi(),
    debounceMs: 1000,
    uploader: async () => {
      uploaderCalls += 1;
      return { ok: true, revision: 2, revisionId: "r", committedAt: "now", contentHash: "h", snapshotKind: "full" };
    },
  });
  controller.linkRemoteProject("proj-1", 1);
  controller.markDirty();
  assert.ok(pendingCount() > 0, "debounce timer armed");

  controller.dispose(); // account switch happens BEFORE the debounce fires
  assert.equal(pendingCount(), 0, "timers cleared on dispose");
  await advance(5000);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 0, "no draft written after dispose");
  assert.equal(uploaderCalls, 0, "no upload started after dispose");
  assert.equal(controller.isDisposed, true);

  // Post-dispose calls are inert (never adopt into the next session).
  controller.markDirty();
  await controller.saveNow();
  await settle();
  assert.equal(callbacks.persisted.length, 0);
  controller.dispose();
});

test("dispose mid-upload: the in-flight result is dropped, state frozen", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api: makeFakeApi(),
    debounceMs: 10,
    uploader: async (_input, opts) => {
      await gate;
      assert.equal(opts.signal.aborted, true, "dispose aborts the upload signal");
      return { ok: true, revision: 99, revisionId: "r", committedAt: "now", contentHash: "h", snapshotKind: "full" };
    },
  });
  controller.linkRemoteProject("proj-1", 1);
  controller.markDirty();
  await advance(10);
  // NOTE: plain settle here — the upload is deliberately gated open, so
  // waiting for full idleness would deadlock.
  await settle();
  assert.equal(controller.getState().status, "uploading");

  controller.dispose();
  release();
  await settle();
  await controller.whenIdle();
  assert.equal(controller.getState().status, "uploading", "no state adopted after dispose");
  assert.equal(controller.getState().lastSyncedRevision, 1, "still the link-time base — the dropped 99 never lands");
});

test("edits during an upload coalesce into a follow-up save", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  let snapshotCount = 0;
  const original = callbacks.captureSnapshot;
  callbacks.captureSnapshot = async () => {
    snapshotCount += 1;
    return { file: new Blob([`snapshot-${snapshotCount}`]), name: "P.3mf" };
  };
  void original;
  const uploaderInputs = [];
  const controller = new ProjectSyncController({
    userId: "u-1",
    callbacks,
    timers,
    api: makeFakeApi(),
    debounceMs: 100,
    uploader: async (input) => {
      uploaderInputs.push(input);
      return { ok: true, revision: (input.baseRevision ?? 0) + 1, revisionId: `r${uploaderInputs.length}`, committedAt: "now", contentHash: input.contentHash ?? "h", snapshotKind: input.snapshotKind };
    },
  });
  controller.linkRemoteProject("proj-1", 1);
  controller.markDirty();
  await advance(100);
  // While the save chain runs, another edit arrives.
  void controller.saveNow();
  await settle();
  await advance(1000);
  await idle(controller);
  assert.ok(uploaderInputs.length >= 2, "queued edit produced a follow-up save");
  assert.equal(uploaderInputs[1].baseRevision, 2, "follow-up builds on the committed revision");
  assert.equal(controller.getState().status, "synced");
  controller.dispose();
});

// ---------------------------------------------------------------------------
// Autosave cost: the expensive capture is skipped when nothing changed
// ---------------------------------------------------------------------------
//
// A save is a full engine 3MF export, a canvas read-back and a SHA-256 over
// the whole file — the most expensive thing the editor does off the slice
// path. The content HASH can only skip the upload, because it is computed
// from the file the export already produced. `contentSignature` runs first and
// skips the work itself. These tests pin that it only ever skips work that
// would have produced identical bytes.

function countingCallbacks(signature) {
  const persisted = [];
  let captures = 0;
  let thumbnails = 0;
  const callbacks = {
    persisted,
    get captures() { return captures; },
    get thumbnails() { return thumbnails; },
    async captureSnapshot() {
      captures += 1;
      return { file: new Blob(["snapshot"]), name: "P.3mf" };
    },
    getSourceFiles() { return [new File(["src"], "part.stl")]; },
    async captureThumbnail() { thumbnails += 1; return null; },
    buildManifest() { return { version: 1, generator: "levo-studio", project: { name: "P" } }; },
    getMeta() { return { schemaVersion: 2, engineVersion: "three-slicer@0.2.2" }; },
    async persistDraft(payload) { persisted.push(payload); },
    contentSignature: () => signature.value,
  };
  return callbacks;
}

test("an unchanged scene costs no export, no thumbnail and no hash", async () => {
  const { timers, advance } = makeTimers();
  const signature = { value: "scene-a" };
  const callbacks = countingCallbacks(signature);
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 10 });

  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.captures, 1);
  assert.equal(callbacks.persisted.length, 1);
  assert.equal(controller.getState().status, "saved-local");

  // The editor marks dirty on every objects/settings identity change, which is
  // far more often than the project changes. None of these may cost anything.
  for (let i = 0; i < 5; i += 1) {
    controller.markDirty();
    await advance(10);
    await idle(controller);
  }
  assert.equal(callbacks.captures, 1, "an unchanged scene must not be re-exported");
  assert.equal(callbacks.thumbnails, 1, "an unchanged scene must not be re-captured");
  assert.equal(callbacks.persisted.length, 1, "an unchanged scene must not be re-written");
  // And the UI must not be left claiming unsaved work that does not exist.
  assert.equal(controller.getState().status, "saved-local");
  assert.equal(controller.getState().dirty, false);
  controller.dispose();
});

test("a real change is always saved — the skip never hides work", async () => {
  const { timers, advance } = makeTimers();
  const signature = { value: "scene-a" };
  const callbacks = countingCallbacks(signature);
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 10 });

  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.captures, 1);

  signature.value = "scene-b";
  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.captures, 2, "a changed scene must be captured");
  assert.equal(callbacks.persisted.length, 2);
  controller.dispose();
});

test("a degraded source-only save is retried, never suppressed by a matching signature", async () => {
  const { timers, advance } = makeTimers();
  const signature = { value: "scene-a" };
  const callbacks = countingCallbacks(signature);
  // The engine did not answer: the save degrades to source-only. The next run
  // must try the full export again rather than decide it already saved.
  callbacks.captureSnapshot = async () => null;

  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 10 });
  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.persisted[0].kind, "source-only");

  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 2, "a degraded save must be retried");
  controller.dispose();
});

test("a failed upload is retried, never suppressed by a matching signature", async () => {
  const { timers, advance } = makeTimers();
  const signature = { value: "scene-a" };
  const callbacks = countingCallbacks(signature);
  let uploads = 0;
  const controller = new ProjectSyncController({
    userId: "u1",
    callbacks,
    timers,
    debounceMs: 10,
    remoteProjectId: "p1",
    uploader: async () => {
      uploads += 1;
      return uploads === 1
        ? { ok: false, kind: "network", message: "offline", retryable: true }
        : { ok: true, revision: 1, revisionId: "r", committedAt: null, contentHash: "h", snapshotKind: "full" };
    },
  });

  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(uploads, 1);
  assert.equal(controller.getState().status, "failed");

  // Same scene, but the upload never landed — the retry must run the whole
  // save, not find a matching signature and report success.
  await controller.retryNow();
  await idle(controller);
  assert.equal(uploads, 2, "a failed upload must be retried");
  assert.equal(controller.getState().status, "synced");

  // Now it really is synced, so an identical run may skip.
  const capturesAfterSync = callbacks.captures;
  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.captures, capturesAfterSync);
  assert.equal(controller.getState().status, "synced");
  controller.dispose();
});

test("switching projects clears the skip mark — a new project always saves", async () => {
  const { timers, advance } = makeTimers();
  const signature = { value: "scene-a" };
  const callbacks = countingCallbacks(signature);
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 10 });

  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.captures, 1);

  // Same content, different destination: the bytes exist nowhere in the new
  // project yet, so "already saved" must not carry over.
  controller.linkRemoteProject("p2", null);
  controller.markDirty();
  await advance(10);
  await idle(controller);
  assert.equal(callbacks.captures, 2, "linking a project must clear the skip mark");
  controller.dispose();
});

test("no signature at all means the old always-save behaviour, unchanged", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = countingCallbacks({ value: null });
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 10 });
  for (let i = 0; i < 3; i += 1) {
    controller.markDirty();
    await advance(10);
    await idle(controller);
  }
  assert.equal(callbacks.captures, 3);
  controller.dispose();
});

/**
 * WHAT AN AUTOSAVE COSTS A GUEST.
 *
 * `sha256HexOf` reads the whole snapshot into one contiguous ArrayBuffer to
 * digest it — for a real project, the entire 3MF, in one allocation, on the
 * main thread, on a phone whose JS heap shares a per-tab budget with the slice
 * worker. Every 9 seconds for as long as the tab is open.
 *
 * It buys exactly one thing: the incremental-upload skip, which compares it
 * with `lastSyncedHash`. A guest never uploads. Neither does an unlinked
 * project or one held by a conflict — the same three conditions the upload
 * step already returns on. The hash was being computed and thrown away.
 *
 * These are source guards because the defect is an allocation, not an output:
 * every assertion about the RESULT passes either way, which is why it survived
 * this long.
 */
test("the autosave hash is only computed when there is an upload to key", async () => {
  const source = await readFile(new URL("../app/project-sync.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // One resolved target, gating both the hash and the upload.
  assert.match(
    code,
    /const uploadTarget\s*=\s*\n?\s*this\.opts\.userId !== null && !this\.state\.conflict \? this\.state\.remoteProjectId : null;/,
    "the upload target must be resolved once"
  );
  assert.match(code, /if \(uploadTarget\) \{[\s\S]*?await hash\(/, "the hash must sit inside that gate");
  assert.match(code, /if \(!uploadTarget\) return;/, "and the upload step must read the same value");

  // The request uses the resolved value rather than re-reading the state it
  // was derived from — two reads across an await are two chances to differ.
  assert.match(code, /projectId: uploadTarget,/);
  const afterGate = code.slice(code.indexOf("if (!uploadTarget) return;"));
  assert.ok(
    !afterGate.includes("this.state.remoteProjectId"),
    "nothing after the gate may re-read remoteProjectId"
  );
});

test("a null content hash stays an ordinary value, not a new state", async () => {
  // Skipping the hash is only safe because null was always allowed: the local
  // draft stores it and NOTHING reads it back, and every downstream type
  // already says `string | null`. If a reader ever appears, this fails.
  const store = await readFile(new URL("../app/project-store.ts", import.meta.url), "utf8");
  const persistence = await readFile(new URL("../app/hooks/use-project-persistence.ts", import.meta.url), "utf8");
  assert.match(store, /contentHash\?: string \| null;/);
  // `project-store` writes it and never compares it.
  assert.ok(!/contentHash\s*===|===\s*\w*\.?contentHash/.test(store), "the draft hash must stay write-only");
  // The one place a hash IS compared reads the REMOTE revision's, from the
  // server — not the local draft's.
  assert.match(persistence, /opened\.revision\.content_hash/);
});

// ---------------------------------------------------------------------------
// A DEBOUNCED SAVE MUST NOT LAND INSIDE A SLICE
// ---------------------------------------------------------------------------

test("a debounce armed before a slice waits for it — the capture never runs mid-slice", async () => {
  /**
   * The shell already refuses to call markDirty() while `status === "slicing"`.
   * That is not enough: on a constrained device the debounce is NINE SECONDS,
   * so the timer armed by the edit that preceded the slice fires squarely
   * inside it — and the capture is a full engine 3MF export plus a canvas
   * read-back plus a SHA-256 over the whole file, on the main thread, while
   * the kernel owns the CPU and the phone's memory is already spent on the
   * WASM heap. It is the lag and the dead slice worker at the same time.
   */
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  let slicing = true;
  callbacks.busy = () => slicing;
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 100 });

  controller.markDirty();
  await advance(100);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 0, "nothing was captured while the slice was running");
  assert.equal(controller.getState().dirty, true, "and the edit is still owed a save");

  // Still waiting one whole debounce later — deferral is not a single skip.
  await advance(100);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 0);

  slicing = false;
  await advance(100);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 1, "the save happens one debounce after the editor is free");
  assert.equal(controller.getState().dirty, false);
  controller.dispose();
});

test("an EXPLICIT save is never deferred — intent and teardown outrank the guard", async () => {
  // The Save button pressed during a slice is the user's call, and the flush
  // on unmount must not be refused or the work is lost.
  const { timers } = makeTimers();
  const callbacks = makeCallbacks();
  callbacks.busy = () => true;
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 100 });

  await controller.saveNow();
  await idle(controller);
  assert.equal(callbacks.persisted.length, 1, "saveNow() bypasses the busy guard");
  controller.dispose();
});

test("a busy() that throws is read as not busy — a broken guard must not stop saving", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  callbacks.busy = () => { throw new Error("no"); };
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 100 });

  controller.markDirty();
  await advance(100);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 1, "the save still happened");
  controller.dispose();
});

test("no busy() at all behaves exactly as before", async () => {
  const { timers, advance } = makeTimers();
  const callbacks = makeCallbacks();
  const controller = new ProjectSyncController({ userId: null, callbacks, timers, debounceMs: 100 });
  controller.markDirty();
  await advance(100);
  await idle(controller);
  assert.equal(callbacks.persisted.length, 1);
  controller.dispose();
});
