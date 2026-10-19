/**
 * P1-09 client half: guest work across sign-in, account switches, the
 * explicit sign-out purge, and the lifecycle/history API client.
 *
 * Drives the REAL app/project-store.ts namespace logic (through its storage
 * seam, an in-memory engine standing in for IndexedDB, which node lacks), the
 * REAL app/project-sync.ts client and draft upload, and the manifest builder
 * the persistence hook uses. The server half lives in api-projects.test.mjs;
 * the browser half (a real account switch in Chromium) is
 * tests/browser-account-switch.mjs.
 *
 * Acceptance ids: 02 (no previous user's drafts/thumbnails/cache after an
 * account switch) and 05, Studio half (a guest edit survives sign-in and is
 * adopted only on consent).
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

const store = await import("../app/project-store.ts");
const sync = await import("../app/project-sync.ts");
const hook = await import("../app/hooks/use-project-persistence.ts");

const {
  GUEST_NAMESPACE,
  adoptGuestDraft,
  deleteDraft,
  listDrafts,
  listGuestDrafts,
  loadDraft,
  namespaceForUser,
  purgeNamespaceDrafts,
  saveDraft,
  setDraftBackendForTests,
} = store;
const { createStudioProjectsApi, openRemoteProject, sha256HexOf, uploadDraftToAccount, StudioApiError } = sync;

// ---------------------------------------------------------------------------
// In-memory storage engine with IndexedDB's contract (keyPath "key", a
// "namespace" index, atomic read-modify-write).
// ---------------------------------------------------------------------------

function memoryBackend() {
  const records = new Map();
  return {
    records,
    async get(key) {
      return records.get(key);
    },
    async update(key, next) {
      records.set(key, structuredClone(next(records.get(key))));
    },
    async delete(key) {
      records.delete(key);
    },
    async listNamespace(namespace) {
      return [...records.values()].filter((r) => r.namespace === namespace);
    },
  };
}

function freshStore() {
  const backend = memoryBackend();
  setDraftBackendForTests(backend);
  return backend;
}

test.after(() => setDraftBackendForTests(null));

const snapshotFile = (label) => new File([`3mf-bytes-${label}`], `${label}.3mf`, { type: "model/3mf" });

function draft(id, name, extra = {}) {
  return {
    id,
    name,
    updatedAt: Date.now(),
    files: [snapshotFile(name)],
    profileId: "bambu-x1c",
    quality: "standard",
    strength: "strong",
    support: true,
    infill: "gyroid",
    plateCount: 2,
    snapshotVersion: 2,
    snapshotKind: "full",
    thumbnail: new Blob(["png-bytes"], { type: "image/png" }),
    ...extra,
  };
}

/** Scripted fake of the API surface uploadDraftToAccount uses. */
function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    async createProject(name) {
      calls.push({ name: "createProject", args: { name } });
      return { id: "proj-adopted", name, head_revision: null, head_revision_id: null };
    },
    async getProject(id) {
      calls.push({ name: "getProject", args: { id } });
      return { id, name: "adopted", head_revision: 1, head_revision_id: "rev-1", has_thumbnail: true };
    },
    async deleteProject(id) {
      calls.push({ name: "deleteProject", args: { id } });
    },
    async openRevision(projectId, body) {
      calls.push({ name: "openRevision", args: { projectId, body } });
      if (overrides.openRevision) return overrides.openRevision(projectId, body);
      return {
        revision_id: "rev-1",
        revision: 1,
        files: body.files.map((f, i) => ({ id: `file-${i}`, kind: f.kind, sha256: f.sha256, size_bytes: f.size_bytes, state: "pending" })),
      };
    },
    async uploadFile(fileId, blob) {
      calls.push({ name: "uploadFile", args: { fileId, size: blob.size } });
    },
    async commitRevision(projectId, revisionId) {
      calls.push({ name: "commitRevision", args: { projectId, revisionId } });
      return { revision: 1, revision_id: revisionId, committed_at: "now" };
    },
    async abandonRevision(projectId, revisionId) {
      calls.push({ name: "abandonRevision", args: { projectId, revisionId } });
    },
  };
  return api;
}

const named = (calls, name) => calls.filter((c) => c.name === name);

// ---------------------------------------------------------------------------
// 05 (Studio half): a guest edit survives sign-in and is adopted only on consent
// ---------------------------------------------------------------------------

test("a guest edit survives sign-in untouched, and nothing adopts it without the explicit action", async () => {
  freshStore();
  await saveDraft(GUEST_NAMESPACE, draft("guest-1", "عمل الضيف"));

  // Sign-in = the namespace switches. Nothing moves.
  const userNs = namespaceForUser("user-A");
  assert.deepEqual(await listDrafts(userNs), [], "the account sees no guest work as its own");
  const survivors = await listGuestDrafts();
  assert.equal(survivors.length, 1, "the guest work is still on the device after sign-in");
  assert.equal(survivors[0].name, "عمل الضيف");
  assert.equal(await loadDraft(userNs, "guest-1"), undefined);

  // The hook's user-change effect (the only code that runs on sign-in) never
  // reaches adoption: it builds a controller and nothing else.
  const source = await readFile(new URL("../app/hooks/use-project-persistence.ts", import.meta.url), "utf8");
  const effect = /useEffect\(\(\) => \{([\s\S]*?)\}, \[userId, namespace, api\]\);/.exec(source);
  assert.ok(effect, "the user-change effect moved — re-pin this test");
  for (const forbidden of ["adoptGuestDraft", "uploadDraftToAccount", "GUEST_NAMESPACE", "listGuestDrafts"]) {
    assert.ok(!effect[1].includes(forbidden), `sign-in must not reach ${forbidden}`);
  }
  // And the only caller of the adoption is the hook's explicit action.
  const shell = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  assert.ok(!/adoptGuestDraft\(|uploadDraftToAccount\(/.test(shell), "the shell never adopts by itself");
  assert.match(shell, /onAdoptGuestDraft=\{persistence\.adoptGuestDraftProject\}/);
  const panel = await readFile(new URL("../app/components/projects-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /onClick=\{\(\) => handleAdoptGuest\(draft\)\}/, "adoption is a click, per draft");
  assert.match(panel, /adoptGuest: "احفظ عملك في حسابي"/, "the Arabic action says exactly what it does");
});

test("on consent the guest draft is uploaded as a new account project, then moved into the account", async () => {
  freshStore();
  const guest = draft("guest-2", "حامل هاتف");
  await saveDraft(GUEST_NAMESPACE, guest);
  const userNs = namespaceForUser("user-A");
  const api = fakeApi();

  const loaded = await loadDraft(GUEST_NAMESPACE, "guest-2");
  const result = await uploadDraftToAccount(
    {
      name: loaded.name,
      files: loaded.files,
      snapshotKind: "full",
      thumbnail: loaded.thumbnail,
      manifest: hook.manifestForDraft(loaded),
    },
    { api, sleep: async () => {} }
  );
  assert.equal(result.ok, true);
  assert.equal(named(api.calls, "createProject")[0].args.name, "حامل هاتف");
  const open = named(api.calls, "openRevision")[0].args.body;
  assert.equal(open.base_revision, null, "a brand-new project, never someone else's head");
  assert.deepEqual(open.files.map((f) => f.kind).sort(), ["snapshot3mf", "thumbnail"]);
  assert.equal(open.content_hash, await sha256HexOf(guest.files[0]), "the draft's own bytes, unaltered");
  assert.equal(open.manifest.adopted_from, "guest-draft");
  assert.equal(open.manifest.printer.profileId, "bambu-x1c");
  assert.equal(open.manifest.settings.infill, "gyroid");
  assert.equal(named(api.calls, "commitRevision").length, 1);

  const adopted = await adoptGuestDraft("guest-2", userNs, {
    projectId: result.project.id,
    revision: result.revision,
    revisionId: result.revisionId,
    syncedAt: Date.now(),
    contentHash: result.contentHash,
    snapshotKind: result.snapshotKind,
  });
  assert.equal(adopted.id, "proj-adopted", "re-keyed by the account project id");
  assert.deepEqual(await listGuestDrafts(), [], "it left the guest namespace");
  const mine = await listDrafts(userNs);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].remote.projectId, "proj-adopted");
  assert.equal(mine[0].name, "حامل هاتف");
  // Adoption is only ever into a signed-in account.
  await saveDraft(GUEST_NAMESPACE, draft("guest-3", "x"));
  await assert.rejects(() => adoptGuestDraft("guest-3", GUEST_NAMESPACE, mine[0].remote));
  await assert.rejects(() => adoptGuestDraft("guest-3", "legacy", mine[0].remote));
});

test("a refused upload leaves the guest draft exactly where it was and no empty project behind", async () => {
  freshStore();
  await saveDraft(GUEST_NAMESPACE, draft("guest-4", "كبير جدًا"));
  const api = fakeApi({
    openRevision() {
      throw new StudioApiError(413, "QUOTA_EXCEEDED", "Storage quota exceeded");
    },
  });
  const loaded = await loadDraft(GUEST_NAMESPACE, "guest-4");
  const result = await uploadDraftToAccount(
    { name: loaded.name, files: loaded.files, snapshotKind: "full", manifest: hook.manifestForDraft(loaded) },
    { api, sleep: async () => {} }
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, "quota");
  assert.equal(named(api.calls, "deleteProject")[0].args.id, "proj-adopted", "the empty project goes to the trash");
  assert.equal((await listGuestDrafts()).length, 1, "the guest work is untouched");

  const empty = await uploadDraftToAccount(
    { name: "x", files: [], snapshotKind: "full", manifest: { version: 1, generator: "levo-studio", project: { name: "x" } } },
    { api }
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, "local");
});

test("a source-only guest draft is adopted honestly as source-only", async () => {
  freshStore();
  const api = fakeApi();
  const sources = [new File(["stl-a"], "a.stl"), new File(["stl-b"], "b.stl")];
  const result = await uploadDraftToAccount(
    {
      name: "مصدر",
      files: sources,
      snapshotKind: "source-only",
      manifest: hook.manifestForDraft(draft("g", "مصدر", { files: sources, snapshotVersion: undefined, snapshotKind: "source-only" })),
    },
    { api, sleep: async () => {} }
  );
  assert.equal(result.ok, true);
  const open = named(api.calls, "openRevision")[0].args.body;
  assert.equal(open.snapshot_kind, "source-only");
  assert.deepEqual(open.files.map((f) => f.kind), ["source", "source"]);
  assert.equal(open.manifest.snapshot_kind, "source-only");
});

// ---------------------------------------------------------------------------
// 02: an account switch shows nothing of the previous user; explicit purge
// ---------------------------------------------------------------------------

test("an account switch shows no previous user's drafts or thumbnails", async () => {
  freshStore();
  const nsA = namespaceForUser("user-A");
  const nsB = namespaceForUser("user-B");
  await saveDraft(nsA, draft("a-1", "سر المستخدم أ"));
  await saveDraft(nsA, draft("shared-id", "أ بنفس المعرّف"));
  await saveDraft(nsB, draft("b-1", "مشروع ب"));

  const seenByB = await listDrafts(nsB);
  assert.deepEqual(seenByB.map((d) => d.name), ["مشروع ب"]);
  assert.ok(!JSON.stringify(seenByB.map((d) => d.name)).includes("أ"), "nothing of A in B's list");
  assert.equal(await loadDraft(nsB, "a-1"), undefined, "a guessed id never crosses namespaces");
  assert.equal(await loadDraft(nsB, "shared-id"), undefined, "even an identical draft id stays A's");
  // The panel's draft thumbnails are built from the namespace's own list only,
  // and the panel itself is re-created per account (no state carried over).
  const shell = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  assert.match(shell, /<ProjectsPanel[\s\S]{0,400}key=\{user\?\.id \?\? "guest"\}/);
  const panel = await readFile(new URL("../app/components/projects-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /listDrafts\(namespace\)/);
  assert.ok(!/localStorage|sessionStorage|caches\./.test(panel), "the panel keeps no cross-account cache");
});

test("explicit sign-out purge removes only that account's drafts; guest and other accounts stay", async () => {
  freshStore();
  const nsA = namespaceForUser("user-A");
  const nsB = namespaceForUser("user-B");
  await saveDraft(nsA, draft("a-1", "A1"));
  await saveDraft(nsA, draft("a-2", "A2"));
  await saveDraft(nsB, draft("b-1", "B1"));
  await saveDraft(GUEST_NAMESPACE, draft("g-1", "G1"));

  assert.equal(await purgeNamespaceDrafts(nsA), 2);
  assert.deepEqual(await listDrafts(nsA), []);
  assert.equal((await listDrafts(nsB)).length, 1);
  assert.equal((await listGuestDrafts()).length, 1);
  await assert.rejects(() => purgeNamespaceDrafts(GUEST_NAMESPACE), /signed-in/);
  await assert.rejects(() => purgeNamespaceDrafts("legacy"));
  await assert.rejects(() => purgeNamespaceDrafts("user:"));

  // The hook stops the autosave controller BEFORE purging, so no pending save
  // can write a draft back; and the sheet makes the purge an opt-in tick.
  const source = await readFile(new URL("../app/hooks/use-project-persistence.ts", import.meta.url), "utf8");
  const purge = /const purgeLocalDraftsForSignOut = useCallback\(async \(\) => \{([\s\S]*?)\}, \[namespace\]\);/.exec(source);
  assert.ok(purge);
  assert.ok(purge[1].indexOf("dispose()") < purge[1].indexOf("purgeNamespaceDrafts("), "dispose first, then purge");
  const sheet = await readFile(new URL("../app/components/sheets/sign-out.tsx", import.meta.url), "utf8");
  assert.match(sheet, /useState\(false\)/, "the purge box starts unticked");
});

test("deleting one draft never touches another namespace's record with the same id", async () => {
  freshStore();
  await saveDraft(namespaceForUser("u1"), draft("same", "one"));
  await saveDraft(namespaceForUser("u2"), draft("same", "two"));
  await deleteDraft(namespaceForUser("u1"), "same");
  assert.equal((await loadDraft(namespaceForUser("u2"), "same")).name, "two");
});

// ---------------------------------------------------------------------------
// Lifecycle / history API client
// ---------------------------------------------------------------------------

test("lifecycle and history client calls hit the right same-origin routes and verbs", async () => {
  const seen = [];
  const api = createStudioProjectsApi(async (input, init = {}) => {
    seen.push({ input, method: init.method ?? "GET", body: init.body ?? null, credentials: init.credentials });
    return new Response(
      JSON.stringify({ success: true, project: { id: "p" }, projects: [], revisions: [], head_revision_id: null, pinned: true, pin_reasons: ["user"], revision: 3, revision_id: "r3" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  await api.listProjects({ view: "archived" });
  await api.listProjects({ view: "trash", q: "x" });
  await api.listProjects({ view: "active" });
  await api.archiveProject("p1", true);
  await api.archiveProject("p1", false);
  await api.restoreProject("p1");
  await api.listRevisions("p1", undefined, { committedOnly: true });
  await api.restoreRevision("p1", "r1", 2);
  await api.setRevisionKept("p1", "r1", true);
  await api.setRevisionKept("p1", "r1", false);
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.input}`),
    [
      "GET /api/projects?view=archived",
      "GET /api/projects?q=x&view=trash",
      "GET /api/projects",
      "POST /api/projects/p1/archive",
      "POST /api/projects/p1/unarchive",
      "POST /api/projects/p1/restore",
      "GET /api/projects/p1/revisions?state=committed",
      "POST /api/projects/p1/revisions/r1/restore",
      "POST /api/projects/p1/revisions/r1/pin",
      "DELETE /api/projects/p1/revisions/r1/pin",
    ]
  );
  assert.deepEqual(JSON.parse(seen[7].body), { base_revision: 2 }, "the restore carries the head the user saw");
  assert.ok(seen.every((s) => s.credentials === "same-origin"));
});

test("opening a kept revision downloads THAT revision, not the head", async () => {
  const calls = [];
  const api = {
    async getProject(id) {
      return { id, name: "P", head_revision_id: "head-rev" };
    },
    async getRevision(projectId, revisionId) {
      calls.push(revisionId);
      return {
        revision: { id: revisionId, revision: 2, snapshot_kind: "full", manifest: { files: [] } },
        files: [{ id: "f1", kind: "snapshot3mf", sha256: "a".repeat(64), size_bytes: 3, content_type: "model/3mf" }],
      };
    },
    async downloadFile() {
      return new Blob(["old"]);
    },
  };
  const opened = await openRemoteProject("p1", { api, revisionId: "old-rev" });
  assert.deepEqual(calls, ["old-rev"]);
  assert.equal(opened.revision.id, "old-rev");
  assert.equal(opened.files.length, 1);
  const head = await openRemoteProject("p1", { api });
  assert.equal(head.revision.id, "head-rev");
});

test("the copy opened from history is never linked to the account project", async () => {
  const shell = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const body = /const openRevisionCopyInEditor = useCallback\(async \([^)]*\) => \{([\s\S]*?)\n  \}, \[/.exec(shell);
  assert.ok(body, "openRevisionCopyInEditor moved — re-pin this test");
  assert.match(body[1], /crypto\.randomUUID\(\)/, "a fresh local id");
  assert.ok(!body[1].includes("linkRemoteProject"), "no account link");
  assert.match(body[1], /restoreProjectRecord\(recordFromOpened\(opened, crypto\.randomUUID\(\), name\)\)/,
    "restored with the default relink, which unlinks a record without a remote");
});

test("manifestForDraft carries only what the draft knows", () => {
  const manifest = hook.manifestForDraft(draft("x", "اسم"));
  assert.deepEqual(Object.keys(manifest).sort(), [
    "adopted_from",
    "generator",
    "plates",
    "printer",
    "project",
    "settings",
    "snapshot_kind",
    "version",
  ]);
  assert.equal(manifest.project.name, "اسم");
  assert.equal(manifest.snapshot_kind, "full");
  assert.equal(manifest.plates.count, 2);
  assert.equal(manifest.objects, undefined, "no invented objects list");
});
