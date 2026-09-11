/**
 * Local draft store (slice S5 — docs/STUDIO_PLAN.md decision 4, client layer).
 *
 * IndexedDB here is CRASH-RECOVERY DRAFTS ONLY. It is never presented as
 * "synced" — account sync happens through project-sync.ts against the server
 * revision protocol, and only a 200 on COMMIT may ever claim that state
 * (owner mandate §4).
 *
 * v2 schema: every draft lives under a namespace — `user:<id>` for a signed-in
 * user, `guest` for guest editing, `legacy` for records written by the old
 * origin-wide v1 store. Namespaces never leak into each other:
 *   - reads/writes/lists/deletes all require a namespace and filter on it,
 *   - v1 records are migrated to the `legacy` namespace and are NOT adopted
 *     by any user automatically — importing one is an explicit user action
 *     (importLegacyDraft), per the mandate ("لا تتبنَّ مشاريع ضيف أو مستخدم
 *     سابق تلقائيًا").
 *
 * Honest snapshot kinds: a draft records whether its files are a full project
 * snapshot (3MF v2 — geometry + plates + transforms + settings) or raw source
 * files only. A source-only save NEVER overwrites the last successful full
 * snapshot — it is preserved on the record (`fullSnapshot`) so "restore last
 * full save" always has something real to restore.
 *
 * The legacy function exports (saveStoredProject & co.) keep the exact
 * signatures slicer-client.tsx uses today; they operate on the ACTIVE
 * namespace (set by use-project-persistence when the signed-in user changes,
 * `guest` otherwise) so the monolith keeps compiling and behaving sanely
 * until its persistence calls are routed through the hook.
 */
import type { SlicerSettings } from "three-slicer";

export type SnapshotKind = "full" | "source-only";

export interface StoredLevoProject {
  id: string;
  name: string;
  updatedAt: number;
  files: File[];
  profileId: string;
  quality: string;
  strength: string;
  support: boolean;
  settings?: SlicerSettings;
  objectCount?: number;
  plateCount?: number;
  /** Legacy marker kept for the monolith: 2 === full engine snapshot. */
  snapshotVersion?: 2;
  /** Honest kind of `files`; derived from snapshotVersion when absent. */
  snapshotKind?: SnapshotKind;
  /** sha256 (lowercase hex) of the snapshot content, when known. */
  contentHash?: string | null;
  /** Real captured thumbnail for the drafts list (never a placeholder). */
  thumbnail?: Blob | null;
  /**
   * Last successful FULL snapshot, protected against being replaced by a
   * degraded source-only save (mandate §4).
   */
  fullSnapshot?: { file: File; updatedAt: number; contentHash?: string | null } | null;
  /**
   * Link to the server copy — bookkeeping only; presence of this field does
   * NOT mean "synced". Sync state is owned by project-sync.ts at runtime.
   */
  remote?: {
    projectId: string;
    revision: number;
    revisionId?: string;
    syncedAt: number;
    contentHash?: string | null;
    snapshotKind: SnapshotKind;
  } | null;
}

/** Record shape actually stored (draft + namespace bookkeeping). */
export interface DraftRecord extends StoredLevoProject {
  key: string;
  namespace: string;
}

export const GUEST_NAMESPACE = "guest";
export const LEGACY_NAMESPACE = "legacy";

const DB_NAME = "levo-studio-projects";
const DB_VERSION = 2;
const DRAFTS_STORE = "drafts";
const V1_STORE = "projects";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/project-sync.test.mjs)
// ---------------------------------------------------------------------------

/** Namespace for a user id (opaque users.id text) or guest when signed out. */
export function namespaceForUser(userId: string | null | undefined): string {
  if (typeof userId !== "string" || userId.length === 0) return GUEST_NAMESPACE;
  return `user:${userId}`;
}

/** Composite primary key — always built from (namespace, id), never parsed. */
export function draftKey(namespace: string, id: string): string {
  return `${namespace}/${id}`;
}

/** Honest kind for a draft, deriving from the legacy snapshotVersion marker. */
export function resolveSnapshotKind(draft: Pick<StoredLevoProject, "snapshotKind" | "snapshotVersion">): SnapshotKind {
  if (draft.snapshotKind === "full" || draft.snapshotKind === "source-only") return draft.snapshotKind;
  return draft.snapshotVersion === 2 ? "full" : "source-only";
}

/** v1 (origin-wide) record → legacy-namespace draft. Adopted by nobody. */
export function legacyRecordToDraft(value: StoredLevoProject): DraftRecord {
  const kind = resolveSnapshotKind(value);
  return {
    ...value,
    snapshotKind: kind,
    fullSnapshot:
      kind === "full" && value.files.length > 0
        ? { file: value.files[0], updatedAt: value.updatedAt, contentHash: value.contentHash ?? null }
        : value.fullSnapshot ?? null,
    namespace: LEGACY_NAMESPACE,
    key: draftKey(LEGACY_NAMESPACE, value.id),
  };
}

/**
 * Merge an incoming save with the existing record. Pure, so the protection
 * rule is testable: a source-only save keeps the previous full snapshot (and
 * keeps the remote link), a full save refreshes the protected full snapshot.
 */
export function mergeDraftForSave(
  existing: DraftRecord | undefined,
  incoming: StoredLevoProject,
  namespace: string
): DraftRecord {
  const kind = resolveSnapshotKind(incoming);
  let fullSnapshot = existing?.fullSnapshot ?? null;
  if (kind === "full" && incoming.files.length > 0) {
    fullSnapshot = {
      file: incoming.files[0],
      updatedAt: incoming.updatedAt,
      contentHash: incoming.contentHash ?? null,
    };
  } else if (incoming.fullSnapshot) {
    fullSnapshot = incoming.fullSnapshot;
  }
  return {
    ...incoming,
    snapshotKind: kind,
    fullSnapshot,
    // The remote link survives saves that do not restate it.
    remote: incoming.remote !== undefined ? incoming.remote : existing?.remote ?? null,
    thumbnail: incoming.thumbnail !== undefined ? incoming.thumbnail : existing?.thumbnail ?? null,
    namespace,
    key: draftKey(namespace, incoming.id),
  };
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

function database(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
        const drafts = db.createObjectStore(DRAFTS_STORE, { keyPath: "key" });
        drafts.createIndex("namespace", "namespace", { unique: false });
      }
      // v1 → v2: move origin-wide records into the `legacy` namespace. They
      // are NOT adopted by guest or by any user — explicit import only.
      if (event.oldVersion > 0 && event.oldVersion < 2 && tx && db.objectStoreNames.contains(V1_STORE)) {
        const source = tx.objectStore(V1_STORE);
        const drafts = tx.objectStore(DRAFTS_STORE);
        const cursorRequest = source.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            try {
              drafts.put(legacyRecordToDraft(cursor.value as StoredLevoProject));
            } catch {
              // A single unreadable v1 record must not block the upgrade.
            }
            cursor.continue();
          } else {
            db.deleteObjectStore(V1_STORE);
          }
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The local draft database is blocked by another tab."));
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, mode);
      const request = run(tx.objectStore(DRAFTS_STORE));
      let result!: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("The draft save was aborted."));
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Namespaced draft API (what the persistence hook + projects panel use)
// ---------------------------------------------------------------------------

/**
 * Saves a draft under `namespace`, applying the full-snapshot protection
 * merge (get + put in one readwrite transaction).
 */
export async function saveDraft(namespace: string, project: StoredLevoProject): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, "readwrite");
      const store = tx.objectStore(DRAFTS_STORE);
      const getRequest = store.get(draftKey(namespace, project.id));
      getRequest.onsuccess = () => {
        try {
          store.put(mergeDraftForSave(getRequest.result as DraftRecord | undefined, project, namespace));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("The draft save was aborted."));
    });
  } finally {
    db.close();
  }
}

export async function loadDraft(namespace: string, id: string): Promise<StoredLevoProject | undefined> {
  const record = await transact<DraftRecord | undefined>("readonly", (store) =>
    store.get(draftKey(namespace, id)) as IDBRequest<DraftRecord | undefined>
  );
  // Defence in depth: a record is only returned to its own namespace.
  if (record && record.namespace !== namespace) return undefined;
  return record;
}

export async function listDrafts(namespace: string): Promise<StoredLevoProject[]> {
  const db = await database();
  try {
    const records = await new Promise<DraftRecord[]>((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, "readonly");
      const index = tx.objectStore(DRAFTS_STORE).index("namespace");
      const request = index.getAll(namespace) as IDBRequest<DraftRecord[]>;
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export async function deleteDraft(namespace: string, id: string): Promise<void> {
  await transact("readwrite", (store) => store.delete(draftKey(namespace, id)));
}

/** Drafts written by the old origin-wide store — shown ONLY behind an explicit import UI. */
export function listLegacyDrafts(): Promise<StoredLevoProject[]> {
  return listDrafts(LEGACY_NAMESPACE);
}

/**
 * Explicit user action (mandate §4): moves one legacy draft into the target
 * namespace. Never called automatically.
 */
export async function importLegacyDraft(id: string, targetNamespace: string): Promise<StoredLevoProject | undefined> {
  const legacy = await loadDraft(LEGACY_NAMESPACE, id);
  if (!legacy) return undefined;
  const imported: StoredLevoProject = { ...legacy, remote: null };
  await saveDraft(targetNamespace, imported);
  await deleteDraft(LEGACY_NAMESPACE, id);
  return imported;
}

// ---------------------------------------------------------------------------
// Active-namespace bridge (legacy call sites in slicer-client.tsx)
// ---------------------------------------------------------------------------

let activeNamespace: string = GUEST_NAMESPACE;

/**
 * Set by use-project-persistence when the signed-in user changes so the
 * monolith's un-migrated calls land in the right namespace. Guest by default.
 */
export function setActiveDraftNamespace(namespace: string): void {
  activeNamespace = namespace || GUEST_NAMESPACE;
}

export function getActiveDraftNamespace(): string {
  return activeNamespace;
}

/** @deprecated Use saveDraft(namespace, project). Operates on the active namespace. */
export function saveStoredProject(project: StoredLevoProject): Promise<void> {
  return saveDraft(activeNamespace, project);
}

/** @deprecated Use loadDraft(namespace, id). Operates on the active namespace. */
export function loadStoredProject(id: string): Promise<StoredLevoProject | undefined> {
  return loadDraft(activeNamespace, id);
}

/** @deprecated Use listDrafts(namespace). Operates on the active namespace. */
export function listStoredProjects(): Promise<StoredLevoProject[]> {
  return listDrafts(activeNamespace);
}

/** @deprecated Use deleteDraft(namespace, id). Operates on the active namespace. */
export function deleteStoredProject(id: string): Promise<void> {
  return deleteDraft(activeNamespace, id);
}
