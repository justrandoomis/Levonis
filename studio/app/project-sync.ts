/**
 * Account project sync client (slice S5 — docs/STUDIO_PLAN.md decision 4,
 * client layer; owner mandate §4).
 *
 * Three layers, all framework-free so node tests can drive them directly:
 *
 *  1. `StudioProjectsApi` — a thin typed client over the S3 storage API.
 *     Same-origin `/api/*` fetches with `credentials: "same-origin"` ONLY;
 *     paths are built from constants + encodeURIComponent, never from
 *     caller-supplied URLs. No tokens are handled or logged here — auth is
 *     the HttpOnly session cookie, invisible to this code by design.
 *
 *  2. `uploadSnapshotRevision` — one full OPEN → UPLOAD → COMMIT run of the
 *     server revision protocol, with hash/size declarations, idempotent
 *     retries on network failures, best-effort ABANDON on definitive failure,
 *     and 409 surfaced as a typed conflict (never a silent overwrite).
 *
 *  3. `ProjectSyncController` — the debounced autosave/upload state machine
 *     behind use-project-persistence. It owns the five distinct visible
 *     states (unsaved / saved-locally / uploading / synced / failed-retry),
 *     the "synced only after COMMIT 200" rule, hash-based skip of unchanged
 *     content (incremental — no full re-upload per scroll/gesture), bounded
 *     auto-retries with backoff, and cancellation: `dispose()` clears every
 *     timer, aborts in-flight uploads and stops all callbacks, so a logout /
 *     account switch can never upload into (or adopt drafts from) another
 *     namespace.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type SnapshotKind = "full" | "source-only";
export type RemoteFileKind = "snapshot3mf" | "source" | "thumbnail" | "asset";

/** Project row as returned by GET/POST /api/projects (S3 contract). */
export interface RemoteProjectSummary {
  id: string;
  name: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
  last_saved_at: string | null;
  has_thumbnail: boolean;
  head_revision_id: string | null;
  head_revision: number | null;
  head_snapshot_kind: SnapshotKind | null;
  head_committed_at: string | null;
}

export interface RemoteRevision {
  id: string;
  project_id: string;
  revision: number;
  parent_revision: number | null;
  schema_version: number | null;
  engine_version: string | null;
  content_hash: string;
  size_bytes: number | null;
  snapshot_kind: SnapshotKind;
  state: "pending" | "committed" | "abandoned";
  created_at: string;
  committed_at: string | null;
  manifest?: unknown;
}

export interface RemoteFile {
  id: string;
  kind: RemoteFileKind;
  sha256: string;
  size_bytes: number;
  content_type: string | null;
  state: "pending" | "verified";
  upload_url: string;
}

export interface QuotaInfo {
  usage_bytes: number;
  quota_bytes: number;
  remaining_bytes: number;
}

/**
 * Manifest carried with every revision (plan decision 4): everything needed
 * to describe the project beyond the 3MF bytes. All sections optional — the
 * shell fills in what the engine actually exposes; nothing here is invented.
 */
export interface ProjectManifest {
  version: 1;
  generator: "levo-studio";
  project: { name: string };
  engine?: { name: string; version?: string };
  printer?: {
    profileId?: string;
    model?: string;
    nozzle?: number;
    bed?: { width: number; depth: number; height?: number };
    materials?: Array<{ slot: number; name?: string; color?: string }>;
  };
  settings?: {
    quality?: string;
    strength?: string;
    support?: boolean;
    global?: Record<string, unknown>;
    perObject?: Record<string, Record<string, unknown>>;
  };
  objects?: Array<{
    id?: number;
    name?: string;
    unit?: "mm";
    transform?: {
      pos?: { x: number; y: number; z: number };
      rot?: { x: number; y: number; z: number };
      scale?: { x: number; y: number; z: number };
    };
    plate?: number;
    extruder?: number;
  }>;
  plates?: { count: number };
  painting?: { supportPaint?: boolean; surfacePaint?: boolean; extruderAssignments?: boolean };
  /** Names by hash so a re-open can restore real file names. */
  files?: Array<{ kind: RemoteFileKind; name: string; sha256: string; size_bytes?: number }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export async function sha256HexOf(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable combined hash for a multi-file (source-only) save. */
export async function combinedContentHash(hashes: readonly string[]): Promise<string> {
  const joined = [...hashes].sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export class StudioApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "StudioApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API_BASE = "/api";

async function parseApiResponse<T>(response: Response): Promise<T> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok || body.success === false) {
    const { success: _success, code, error, ...extra } = body;
    throw new StudioApiError(
      response.status,
      typeof code === "string" ? code : "HTTP_ERROR",
      typeof error === "string" ? error : `Request failed (${response.status})`,
      extra
    );
  }
  return body as T;
}

export interface StudioProjectsApi {
  listProjects(opts?: { q?: string; limit?: number; offset?: number; signal?: AbortSignal }): Promise<RemoteProjectSummary[]>;
  createProject(name: string, signal?: AbortSignal): Promise<RemoteProjectSummary>;
  getProject(id: string, signal?: AbortSignal): Promise<RemoteProjectSummary>;
  renameProject(id: string, name: string, signal?: AbortSignal): Promise<RemoteProjectSummary>;
  deleteProject(id: string, signal?: AbortSignal): Promise<void>;
  duplicateProject(id: string, name?: string, signal?: AbortSignal): Promise<RemoteProjectSummary>;
  listRevisions(id: string, signal?: AbortSignal): Promise<{ head_revision_id: string | null; revisions: RemoteRevision[] }>;
  getRevision(projectId: string, revisionId: string, signal?: AbortSignal): Promise<{ revision: RemoteRevision; files: RemoteFile[] }>;
  openRevision(
    projectId: string,
    body: {
      base_revision: number | null;
      content_hash: string;
      snapshot_kind: SnapshotKind;
      manifest: Record<string, unknown>;
      schema_version?: number;
      engine_version?: string;
      files: Array<{ kind: RemoteFileKind; sha256: string; size_bytes: number; content_type?: string | null }>;
    },
    signal?: AbortSignal
  ): Promise<{ revision_id: string; revision: number; files: RemoteFile[] }>;
  uploadFile(fileId: string, blob: Blob, signal?: AbortSignal): Promise<void>;
  commitRevision(
    projectId: string,
    revisionId: string,
    signal?: AbortSignal
  ): Promise<{ revision: number; revision_id: string; committed_at?: string; snapshot_kind?: SnapshotKind }>;
  abandonRevision(projectId: string, revisionId: string): Promise<void>;
  downloadFile(projectId: string, fileId: string, signal?: AbortSignal): Promise<Blob>;
  quota(signal?: AbortSignal): Promise<QuotaInfo>;
  /** Same-origin thumbnail URL for <img> (worker checks ownership per request). */
  thumbnailUrl(projectId: string): string;
}

export function createStudioProjectsApi(fetchImpl?: FetchLike): StudioProjectsApi {
  const doFetch: FetchLike = (input, init) => {
    const impl = fetchImpl ?? (globalThis.fetch as FetchLike);
    return impl(input, { credentials: "same-origin", ...init });
  };
  const json = (body: unknown): RequestInit => ({
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const enc = encodeURIComponent;

  return {
    async listProjects(opts = {}) {
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.offset) params.set("offset", String(opts.offset));
      const suffix = params.size ? `?${params}` : "";
      const body = await parseApiResponse<{ projects: RemoteProjectSummary[] }>(
        await doFetch(`${API_BASE}/projects${suffix}`, { signal: opts.signal })
      );
      return body.projects;
    },
    async createProject(name, signal) {
      const body = await parseApiResponse<{ project: RemoteProjectSummary }>(
        await doFetch(`${API_BASE}/projects`, { method: "POST", signal, ...json({ name }) })
      );
      return body.project;
    },
    async getProject(id, signal) {
      const body = await parseApiResponse<{ project: RemoteProjectSummary }>(
        await doFetch(`${API_BASE}/projects/${enc(id)}`, { signal })
      );
      return body.project;
    },
    async renameProject(id, name, signal) {
      const body = await parseApiResponse<{ project: RemoteProjectSummary }>(
        await doFetch(`${API_BASE}/projects/${enc(id)}`, { method: "PATCH", signal, ...json({ name }) })
      );
      return body.project;
    },
    async deleteProject(id, signal) {
      await parseApiResponse(await doFetch(`${API_BASE}/projects/${enc(id)}`, { method: "DELETE", signal }));
    },
    async duplicateProject(id, name, signal) {
      const body = await parseApiResponse<{ project: RemoteProjectSummary }>(
        await doFetch(`${API_BASE}/projects/${enc(id)}/duplicate`, {
          method: "POST",
          signal,
          ...json(name ? { name } : {}),
        })
      );
      return body.project;
    },
    async listRevisions(id, signal) {
      return parseApiResponse(await doFetch(`${API_BASE}/projects/${enc(id)}/revisions`, { signal }));
    },
    async getRevision(projectId, revisionId, signal) {
      return parseApiResponse(
        await doFetch(`${API_BASE}/projects/${enc(projectId)}/revisions/${enc(revisionId)}`, { signal })
      );
    },
    async openRevision(projectId, body, signal) {
      return parseApiResponse(
        await doFetch(`${API_BASE}/projects/${enc(projectId)}/revisions`, { method: "POST", signal, ...json(body) })
      );
    },
    async uploadFile(fileId, blob, signal) {
      await parseApiResponse(await doFetch(`${API_BASE}/uploads/${enc(fileId)}`, { method: "PUT", body: blob, signal }));
    },
    async commitRevision(projectId, revisionId, signal) {
      return parseApiResponse(
        await doFetch(`${API_BASE}/projects/${enc(projectId)}/revisions/${enc(revisionId)}/commit`, {
          method: "POST",
          signal,
        })
      );
    },
    async abandonRevision(projectId, revisionId) {
      await parseApiResponse(
        await doFetch(`${API_BASE}/projects/${enc(projectId)}/revisions/${enc(revisionId)}/abandon`, {
          method: "POST",
          keepalive: true,
        })
      );
    },
    async downloadFile(projectId, fileId, signal) {
      const response = await doFetch(`${API_BASE}/projects/${enc(projectId)}/files/${enc(fileId)}`, { signal });
      if (!response.ok) {
        throw new StudioApiError(response.status, "DOWNLOAD_FAILED", `File download failed (${response.status})`);
      }
      return response.blob();
    },
    async quota(signal) {
      return parseApiResponse(await doFetch(`${API_BASE}/quota`, { signal }));
    },
    thumbnailUrl(projectId) {
      return `${API_BASE}/projects/${enc(projectId)}/thumbnail`;
    },
  };
}

/** Default client bound to the page's own origin. */
export const studioProjectsApi: StudioProjectsApi = createStudioProjectsApi();

// ---------------------------------------------------------------------------
// Upload protocol (OPEN → UPLOAD → COMMIT)
// ---------------------------------------------------------------------------

export interface SnapshotUploadFile {
  kind: RemoteFileKind;
  name: string;
  blob: Blob;
  contentType?: string | null;
}

export interface SnapshotUploadInput {
  projectId: string;
  /** Revision number this save is based on; null = based on empty project. */
  baseRevision: number | null;
  snapshotKind: SnapshotKind;
  manifest: ProjectManifest;
  schemaVersion?: number;
  engineVersion?: string;
  files: SnapshotUploadFile[];
  /** Precomputed content hash; computed from the files when omitted. */
  contentHash?: string;
}

export type SyncFailureKind = "auth" | "quota" | "conflict" | "network" | "server" | "local" | "cancelled";

export type SnapshotUploadResult =
  | {
      ok: true;
      revision: number;
      revisionId: string;
      committedAt: string | null;
      contentHash: string;
      snapshotKind: SnapshotKind;
    }
  | {
      ok: false;
      kind: "conflict";
      head: { revision: number | null; revision_id: string | null } | null;
    }
  | { ok: false; kind: "auth"; message?: string }
  | { ok: false; kind: "quota"; message?: string }
  | { ok: false; kind: "cancelled"; message?: string }
  | { ok: false; kind: "network" | "server" | "local"; message: string; retryable: boolean };

export interface SnapshotUploadOptions {
  api?: StudioProjectsApi;
  signal?: AbortSignal;
  hash?: (blob: Blob) => Promise<string>;
  /** Attempts per network operation (default 3 total tries). */
  networkAttempts?: number;
  /** Delay before retry `attempt` (1-based); injectable for tests. */
  retryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultRetryDelay = (attempt: number) => Math.min(15_000, 1_000 * 2 ** (attempt - 1));
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function classifyApiError(error: unknown): { kind: SyncFailureKind; message: string; retryable: boolean } {
  if (isAbortError(error)) return { kind: "cancelled", message: "Cancelled", retryable: false };
  if (error instanceof StudioApiError) {
    if (error.status === 401) return { kind: "auth", message: error.message, retryable: false };
    if (error.status === 413 || error.code === "QUOTA_EXCEEDED") {
      return { kind: "quota", message: error.message, retryable: false };
    }
    if (error.status === 409) return { kind: "conflict", message: error.message, retryable: false };
    if (error.status >= 500) return { kind: "server", message: error.message, retryable: true };
    return { kind: "server", message: error.message, retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "network", message, retryable: true };
}

function conflictHead(error: StudioApiError): { revision: number | null; revision_id: string | null } | null {
  const head = error.extra.head;
  if (head && typeof head === "object") {
    const h = head as Record<string, unknown>;
    return {
      revision: typeof h.revision === "number" ? h.revision : null,
      revision_id: typeof h.revision_id === "string" ? h.revision_id : null,
    };
  }
  return null;
}

/**
 * Runs one revision through the full server protocol. Network-level failures
 * retry with backoff (PUT and COMMIT are idempotent server-side); definitive
 * failures abandon the pending revision best-effort (the server cron would
 * reclaim it anyway). A 409 anywhere is returned as a typed conflict for the
 * UI to resolve — this function NEVER overwrites a newer head silently.
 */
export async function uploadSnapshotRevision(
  input: SnapshotUploadInput,
  options: SnapshotUploadOptions = {}
): Promise<SnapshotUploadResult> {
  const api = options.api ?? studioProjectsApi;
  const hash = options.hash ?? sha256HexOf;
  const attempts = Math.max(1, options.networkAttempts ?? 3);
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelay;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  // Honest local validation mirroring the server's OPEN rules.
  const snapshotCount = input.files.filter((f) => f.kind === "snapshot3mf").length;
  if (input.snapshotKind === "full" && snapshotCount !== 1) {
    return { ok: false, kind: "local", message: "A full save needs exactly one 3MF snapshot file.", retryable: false };
  }
  if (input.snapshotKind === "source-only" && (snapshotCount !== 0 || !input.files.some((f) => f.kind === "source"))) {
    return { ok: false, kind: "local", message: "A source-only save carries source files and no snapshot.", retryable: false };
  }

  const withRetries = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const verdict = classifyApiError(error);
        if (!verdict.retryable || attempt >= attempts || signal?.aborted) throw error;
        await sleep(retryDelayMs(attempt));
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      }
    }
  };

  let declared: Array<{ decl: { kind: RemoteFileKind; sha256: string; size_bytes: number; content_type?: string | null }; blob: Blob }>;
  let contentHash: string;
  try {
    declared = await Promise.all(
      input.files.map(async (file) => ({
        decl: {
          kind: file.kind,
          sha256: await hash(file.blob),
          size_bytes: file.blob.size,
          content_type: file.contentType ?? (file.blob.type || null),
        },
        blob: file.blob,
      }))
    );
    if (input.contentHash) {
      contentHash = input.contentHash;
    } else {
      const primary = declared.filter((d) => d.decl.kind === (input.snapshotKind === "full" ? "snapshot3mf" : "source"));
      contentHash =
        primary.length === 1 ? primary[0].decl.sha256 : await combinedContentHash(primary.map((d) => d.decl.sha256));
    }
  } catch (error) {
    if (isAbortError(error)) return { ok: false, kind: "cancelled" };
    return { ok: false, kind: "local", message: error instanceof Error ? error.message : String(error), retryable: false };
  }

  // Name map into the manifest so a later open restores real file names.
  const manifest: ProjectManifest = {
    ...input.manifest,
    files: input.files.map((file, i) => ({
      kind: file.kind,
      name: file.name,
      sha256: declared[i].decl.sha256,
      size_bytes: declared[i].decl.size_bytes,
    })),
  };

  // OPEN ---------------------------------------------------------------------
  let opened: { revision_id: string; revision: number; files: RemoteFile[] };
  try {
    opened = await withRetries(() =>
      api.openRevision(
        input.projectId,
        {
          base_revision: input.baseRevision,
          content_hash: contentHash,
          snapshot_kind: input.snapshotKind,
          manifest: manifest as unknown as Record<string, unknown>,
          schema_version: input.schemaVersion,
          engine_version: input.engineVersion,
          files: declared.map((d) => d.decl),
        },
        signal
      )
    );
  } catch (error) {
    const verdict = classifyApiError(error);
    if (verdict.kind === "conflict" && error instanceof StudioApiError) {
      return { ok: false, kind: "conflict", head: conflictHead(error) };
    }
    if (verdict.kind === "cancelled") return { ok: false, kind: "cancelled" };
    if (verdict.kind === "auth" || verdict.kind === "quota") return { ok: false, kind: verdict.kind, message: verdict.message };
    return { ok: false, kind: verdict.kind === "network" ? "network" : "server", message: verdict.message, retryable: verdict.retryable };
  }

  const abandon = () => {
    void api.abandonRevision(input.projectId, opened.revision_id).catch(() => {});
  };

  // UPLOAD -------------------------------------------------------------------
  try {
    // Match server rows to local blobs by (kind, sha256) — order-independent.
    const pool = declared.map((d) => ({ ...d, used: false }));
    for (const remote of opened.files) {
      const match = pool.find((d) => !d.used && d.decl.kind === remote.kind && d.decl.sha256 === remote.sha256);
      if (!match) throw new StudioApiError(500, "FILE_MAP_MISMATCH", "The server file list does not match the declared files");
      match.used = true;
      await withRetries(() => api.uploadFile(remote.id, match.blob, signal));
    }
  } catch (error) {
    // A failed run is never resumed (the next save OPENs a fresh revision),
    // so the pending revision is released best-effort in every failure path;
    // the server refuses to abandon committed/head revisions, and the cron
    // reclaims anything this fire-and-forget call cannot reach.
    abandon();
    const verdict = classifyApiError(error);
    if (verdict.kind === "cancelled") return { ok: false, kind: "cancelled" };
    if (verdict.kind === "auth") return { ok: false, kind: "auth", message: verdict.message };
    return {
      ok: false,
      kind: verdict.kind === "network" ? "network" : "server",
      message: verdict.message,
      retryable: verdict.retryable,
    };
  }

  // COMMIT -------------------------------------------------------------------
  try {
    const committed = await withRetries(() => api.commitRevision(input.projectId, opened.revision_id, signal));
    return {
      ok: true,
      revision: committed.revision,
      revisionId: committed.revision_id,
      committedAt: committed.committed_at ?? null,
      contentHash,
      snapshotKind: input.snapshotKind,
    };
  } catch (error) {
    abandon(); // see above — safe even if the commit actually landed
    const verdict = classifyApiError(error);
    if (verdict.kind === "conflict" && error instanceof StudioApiError) {
      return { ok: false, kind: "conflict", head: conflictHead(error) };
    }
    if (verdict.kind === "cancelled") return { ok: false, kind: "cancelled" };
    if (verdict.kind === "auth") return { ok: false, kind: "auth", message: verdict.message };
    return {
      ok: false,
      kind: verdict.kind === "network" ? "network" : "server",
      message: verdict.message,
      retryable: verdict.retryable,
    };
  }
}

// ---------------------------------------------------------------------------
// Project open (download head revision for the editor)
// ---------------------------------------------------------------------------

export interface OpenedRemoteProject {
  project: RemoteProjectSummary;
  revision: RemoteRevision | null;
  manifest: ProjectManifest | null;
  /** Honest kind of what was restored — the UI must show source-only as degraded. */
  snapshotKind: SnapshotKind | null;
  files: File[];
}

/**
 * Downloads the head revision's restorable files (ownership enforced by the
 * worker per request). Full head → the single 3MF snapshot; source-only head
 * → the raw source files, honestly labeled so the caller can warn that
 * arrangement/painting are not part of a degraded save.
 */
export async function openRemoteProject(
  projectId: string,
  options: { api?: StudioProjectsApi; signal?: AbortSignal } = {}
): Promise<OpenedRemoteProject> {
  const api = options.api ?? studioProjectsApi;
  const project = await api.getProject(projectId, options.signal);
  if (!project.head_revision_id) {
    return { project, revision: null, manifest: null, snapshotKind: null, files: [] };
  }
  const { revision, files } = await api.getRevision(projectId, project.head_revision_id, options.signal);
  const manifest =
    revision.manifest && typeof revision.manifest === "object" ? (revision.manifest as ProjectManifest) : null;
  const nameFor = (file: RemoteFile, index: number): string => {
    const entry = manifest?.files?.find((f) => f.sha256 === file.sha256 && f.kind === file.kind);
    if (entry?.name) return entry.name;
    if (file.kind === "snapshot3mf") return `${project.name || "LEVO Project"}.3mf`;
    return `${file.kind}-${index + 1}.bin`;
  };
  const wanted =
    revision.snapshot_kind === "full"
      ? files.filter((f) => f.kind === "snapshot3mf")
      : files.filter((f) => f.kind === "source");
  const restored: File[] = [];
  for (const [index, remote] of wanted.entries()) {
    const blob = await api.downloadFile(projectId, remote.id, options.signal);
    restored.push(
      new File([blob], nameFor(remote, index), {
        type: remote.kind === "snapshot3mf" ? "model/3mf" : remote.content_type || "application/octet-stream",
      })
    );
  }
  return { project, revision, manifest, snapshotKind: revision.snapshot_kind, files: restored };
}

// ---------------------------------------------------------------------------
// Sync controller (state machine behind use-project-persistence)
// ---------------------------------------------------------------------------

/** The five distinct user-visible states (mandate §4). */
export type SyncStatus = "unsaved" | "saved-local" | "uploading" | "synced" | "failed";

export interface SyncConflict {
  head: { revision: number | null; revision_id: string | null } | null;
}

export interface SyncFailure {
  kind: Exclude<SyncFailureKind, "cancelled" | "conflict">;
  message: string;
  retryable: boolean;
}

export interface PersistenceState {
  status: SyncStatus;
  dirty: boolean;
  guest: boolean;
  remoteProjectId: string | null;
  lastLocalSaveAt: number | null;
  lastLocalKind: SnapshotKind | null;
  lastSyncedRevision: number | null;
  lastSyncedAt: number | null;
  lastSyncedKind: SnapshotKind | null;
  conflict: SyncConflict | null;
  failure: SyncFailure | null;
  retryCount: number;
  nextRetryAt: number | null;
}

export interface SnapshotCapture {
  file: Blob;
  name: string;
}

export interface DraftPersistPayload {
  files: File[];
  kind: SnapshotKind;
  contentHash: string | null;
  thumbnail: Blob | null;
}

export interface ProjectSyncCallbacks {
  /** Full engine 3MF export; resolve null when the engine save fails/times out. */
  captureSnapshot(): Promise<SnapshotCapture | null>;
  /** Raw imported source files — the honest degraded fallback. */
  getSourceFiles(): File[];
  /** Real canvas thumbnail; null when capture is not possible (never faked). */
  captureThumbnail?(): Promise<Blob | null>;
  buildManifest(kind: SnapshotKind): ProjectManifest;
  getMeta(): { schemaVersion: number; engineVersion?: string };
  /** Local IndexedDB draft write (namespaced by the hook). */
  persistDraft?(payload: DraftPersistPayload): Promise<void>;
  onState?(state: PersistenceState): void;
  /**
   * A CHEAP fingerprint of everything that would change the saved snapshot —
   * scene transforms, settings revision, plate count, project name. Return
   * null when it cannot be computed; the save then runs unconditionally.
   *
   * WHY IT EXISTS. A save is expensive: a full engine 3MF export (merge every
   * object's geometry, write the XML, deflate it), a canvas read-back for the
   * thumbnail, and a SHA-256 over the whole file — which needs the entire
   * multi-megabyte snapshot in one ArrayBuffer. The content hash that decides
   * whether to UPLOAD is computed from that file, so it can only skip the
   * network, never the work.
   *
   * Meanwhile `markDirty()` fires from an effect watching object and settings
   * identity, so plenty of runs have nothing new to save at all. On a phone
   * holding a 20 MB model, paying the full export every few seconds for an
   * unchanged scene is a stutter the user feels and a memory spike the slice
   * worker does not survive.
   *
   * So this runs FIRST and, when it matches the last completed full save,
   * nothing is captured, hashed, written or uploaded. It is only ever allowed
   * to skip work that would have produced identical bytes.
   */
  contentSignature?(): string | null;

  /**
   * "Not right now." True while the editor is doing something a DEBOUNCED save
   * must not land in the middle of.
   *
   * WHY IT EXISTS. The shell already refuses to call `markDirty()` during a
   * slice, and that is not enough: on a constrained device the debounce is
   * nine seconds, so a timer armed by the edit that preceded the slice fires
   * squarely inside it. What then runs is the most expensive thing this editor
   * does — a full engine 3MF export (merge every object's geometry, write the
   * XML, deflate it), a canvas read-back, and a SHA-256 needing the whole
   * multi-megabyte file in one ArrayBuffer — on the main thread, at the moment
   * the kernel owns the CPU and the phone's memory budget is already spent on
   * the WASM heap. That is both halves of the owner's report at once: the
   * editor goes sticky, and the slice worker is what gets killed.
   *
   * ONLY THE DEBOUNCED PATH ASKS. An explicit `saveNow()` — the Save button,
   * the flush on unmount — is intent or teardown and is never deferred: the
   * user asking to save during a slice is the user's call, and refusing a
   * teardown flush would lose work.
   *
   * A deferral re-arms the debounce rather than dropping the save, so nothing
   * is forgotten; the save happens one debounce after the editor is free.
   */
  busy?(): boolean;
}

export interface SyncTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const defaultTimers: SyncTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  now: () => Date.now(),
};

export interface ProjectSyncControllerOptions {
  /** null = guest: local drafts only, no network. */
  userId: string | null;
  callbacks: ProjectSyncCallbacks;
  remoteProjectId?: string | null;
  baseRevision?: number | null;
  debounceMs?: number;
  maxAutoRetries?: number;
  api?: StudioProjectsApi;
  hash?: (blob: Blob) => Promise<string>;
  timers?: SyncTimers;
  retryDelayMs?: (attempt: number) => number;
  uploader?: typeof uploadSnapshotRevision;
}

export type ConflictResolution = "overwrite" | "keep-remote" | "fork";

export class ProjectSyncController {
  private readonly opts: Required<Pick<ProjectSyncControllerOptions, "debounceMs" | "maxAutoRetries">> &
    ProjectSyncControllerOptions;
  private readonly timers: SyncTimers;
  private readonly api: StudioProjectsApi;
  private readonly uploader: typeof uploadSnapshotRevision;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(state: PersistenceState) => void>();
  private state: PersistenceState;
  private disposed = false;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private saving: Promise<void> | null = null;
  private saveQueued = false;
  private lastSyncedHash: string | null = null;
  /**
   * Signature of the last run that completed as a FULL snapshot with no
   * failure. Cleared on every degraded or failed run, so a save that fell back
   * to source-only (or failed to write, upload or resolve a conflict) is always
   * retried rather than skipped by a matching signature.
   */
  private lastSavedSignature: string | null = null;
  private baseRevision: number | null;

  constructor(options: ProjectSyncControllerOptions) {
    this.opts = { debounceMs: 2500, maxAutoRetries: 3, ...options };
    this.timers = options.timers ?? defaultTimers;
    this.api = options.api ?? studioProjectsApi;
    this.uploader = options.uploader ?? uploadSnapshotRevision;
    this.baseRevision = options.baseRevision ?? null;
    this.state = {
      status: "unsaved",
      dirty: false,
      guest: options.userId === null,
      remoteProjectId: options.remoteProjectId ?? null,
      lastLocalSaveAt: null,
      lastLocalKind: null,
      lastSyncedRevision: null,
      lastSyncedAt: null,
      lastSyncedKind: null,
      conflict: null,
      failure: null,
      retryCount: 0,
      nextRetryAt: null,
    };
  }

  getState(): PersistenceState {
    return this.state;
  }

  subscribe(listener: (state: PersistenceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<PersistenceState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.opts.callbacks.onState?.(this.state);
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch {
        /* listeners must not break the controller */
      }
    }
  }

  /** Signal an edit. Debounces a local save (+ upload when signed in and linked). */
  markDirty(): void {
    if (this.disposed) return;
    this.setState({ dirty: true, status: this.saving ? this.state.status : "unsaved" });
    if (this.debounceHandle !== null) this.timers.clear(this.debounceHandle);
    this.debounceHandle = this.timers.set(() => {
      this.debounceHandle = null;
      // Never start the expensive capture inside a slice — see the doc comment
      // on ProjectSyncCallbacks.busy. Re-arm rather than drop: the save then
      // happens one debounce after the editor is free.
      let busy = false;
      try {
        busy = this.opts.callbacks.busy?.() === true;
      } catch {
        busy = false;
      }
      if (busy) {
        this.markDirty();
        return;
      }
      void this.saveNow();
    }, this.opts.debounceMs);
  }

  /** Links this editor session to a server project (e.g. after create/open). */
  linkRemoteProject(projectId: string, baseRevision: number | null, synced?: { hash: string | null; kind: SnapshotKind | null; at?: number }): void {
    if (this.disposed) return;
    this.baseRevision = baseRevision;
    this.lastSyncedHash = synced?.hash ?? null;
    this.lastSavedSignature = null;
    this.setState({
      remoteProjectId: projectId,
      conflict: null,
      failure: null,
      retryCount: 0,
      nextRetryAt: null,
      lastSyncedRevision: baseRevision,
      lastSyncedKind: synced?.kind ?? null,
      lastSyncedAt: synced?.at ?? (baseRevision !== null ? this.timers.now() : null),
      status: baseRevision !== null && !this.state.dirty ? "synced" : this.state.status,
    });
  }

  unlinkRemoteProject(): void {
    if (this.disposed) return;
    this.baseRevision = null;
    this.lastSyncedHash = null;
    // A different project must never inherit this one's "already saved" mark.
    this.lastSavedSignature = null;
    this.setState({
      remoteProjectId: null,
      conflict: null,
      lastSyncedRevision: null,
      lastSyncedAt: null,
      lastSyncedKind: null,
    });
  }

  /** Immediate save; concurrent calls coalesce into one follow-up run. */
  async saveNow(): Promise<void> {
    if (this.disposed) return;
    if (this.debounceHandle !== null) {
      this.timers.clear(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.saving) {
      this.saveQueued = true;
      return this.saving;
    }
    this.saving = this.runSave().finally(() => {
      this.saving = null;
      if (this.saveQueued && !this.disposed) {
        this.saveQueued = false;
        void this.saveNow();
      }
    });
    return this.saving;
  }

  /**
   * Resolves when no save chain is running (queued follow-ups included).
   * Lets the shell flush before navigation/unload and tests await quiescence.
   */
  async whenIdle(): Promise<void> {
    while (this.saving) {
      await this.saving;
      // A queued follow-up re-arms `saving` from the finally handler.
      await Promise.resolve();
    }
  }

  /** Manual retry after a failure (also used by the auto-retry timer). */
  retryNow(): Promise<void> {
    if (this.retryHandle !== null) {
      this.timers.clear(this.retryHandle);
      this.retryHandle = null;
    }
    this.setState({ nextRetryAt: null });
    return this.saveNow();
  }

  /**
   * Resolves a 409 with a REAL user choice (mandate §4 — never silent):
   *  - "overwrite": rebase onto the server head and upload this device's
   *    content as a new revision on top of it (the old head stays in history).
   *  - "keep-remote": drop this device's upload claim; the caller then opens
   *    the server version (the local draft stays as crash recovery).
   *  - "fork": save this device's content as a NEW account project, leaving
   *    the other device's head untouched.
   */
  async resolveConflict(choice: ConflictResolution): Promise<void> {
    if (this.disposed || !this.state.conflict) return;
    const remoteProjectId = this.state.remoteProjectId;
    if (choice === "keep-remote") {
      this.baseRevision = this.state.conflict.head?.revision ?? null;
      this.lastSyncedHash = null;
      this.setState({ conflict: null, failure: null, status: "saved-local", retryCount: 0, nextRetryAt: null });
      return;
    }
    if (choice === "fork") {
      let project: RemoteProjectSummary;
      try {
        const baseName = String(this.opts.callbacks.buildManifest("full").project?.name || "LEVO Project");
        project = await this.api.createProject(`${baseName.slice(0, 110)} (2)`, this.abort.signal);
      } catch (error) {
        if (this.disposed || isAbortError(error)) return;
        const verdict = classifyApiError(error);
        this.setState({
          status: "failed",
          failure: {
            kind: verdict.kind === "conflict" || verdict.kind === "cancelled" ? "server" : verdict.kind,
            message: verdict.message,
            retryable: verdict.retryable,
          },
        });
        return;
      }
      if (this.disposed) return;
      this.baseRevision = project.head_revision ?? null;
      this.lastSyncedHash = null;
      this.setState({
        remoteProjectId: project.id,
        conflict: null,
        failure: null,
        retryCount: 0,
        nextRetryAt: null,
        dirty: true,
        lastSyncedRevision: null,
        lastSyncedAt: null,
        lastSyncedKind: null,
      });
      await this.saveNow();
      return;
    }
    // overwrite: refresh the true head first, then force an upload.
    let headRevision = this.state.conflict.head?.revision ?? null;
    if (remoteProjectId) {
      try {
        const fresh = await this.api.getProject(remoteProjectId, this.abort.signal);
        headRevision = fresh.head_revision ?? headRevision;
      } catch {
        /* keep the head the 409 reported */
      }
    }
    this.baseRevision = headRevision;
    this.lastSyncedHash = null; // force the upload even when content is unchanged
    this.setState({ conflict: null, failure: null, retryCount: 0, nextRetryAt: null, dirty: true });
    await this.saveNow();
  }

  /**
   * Cancels everything: timers, in-flight uploads, future callbacks. Called
   * on logout, account switch, and unmount — after this, nothing from this
   * controller can write to (or read from) any namespace.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceHandle !== null) this.timers.clear(this.debounceHandle);
    if (this.retryHandle !== null) this.timers.clear(this.retryHandle);
    this.debounceHandle = null;
    this.retryHandle = null;
    this.listeners.clear();
    this.abort.abort();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // -- internals ------------------------------------------------------------

  private async runSave(): Promise<void> {
    const { callbacks } = this.opts;

    // 0. Cheap change check BEFORE any expensive work. See the doc comment on
    //    ProjectSyncCallbacks.contentSignature: capture + thumbnail + SHA-256
    //    over a multi-megabyte 3MF is the most expensive thing this editor
    //    does off the slice path, and markDirty() fires far more often than
    //    the project actually changes.
    let signature: string | null = null;
    try {
      signature = this.opts.callbacks.contentSignature?.() ?? null;
    } catch {
      signature = null;
    }
    if (signature !== null && signature === this.lastSavedSignature) {
      // Identical content to the last completed FULL save: capturing it again
      // would produce the same bytes. The state must still settle honestly —
      // "synced" only where the previous run really reached a committed
      // revision, "saved-local" otherwise.
      const synced = this.state.remoteProjectId !== null && this.state.lastSyncedRevision !== null;
      this.setState({ dirty: false, status: synced ? "synced" : "saved-local", failure: null });
      return;
    }

    // 1. Capture: full engine snapshot, honestly degrading to source-only.
    let files: File[] = [];
    let kind: SnapshotKind = "source-only";
    let capture: SnapshotCapture | null = null;
    try {
      capture = await callbacks.captureSnapshot();
    } catch {
      capture = null;
    }
    if (this.disposed) return;
    if (capture) {
      kind = "full";
      files = [
        capture.file instanceof File
          ? capture.file
          : new File([capture.file], capture.name, { type: "model/3mf" }),
      ];
    } else {
      files = callbacks.getSourceFiles();
    }
    if (files.length === 0) {
      // Nothing to persist — an empty project is not an error.
      this.setState({ dirty: false, status: this.state.lastSyncedRevision !== null ? this.state.status : "unsaved" });
      return;
    }

    let thumbnail: Blob | null = null;
    if (callbacks.captureThumbnail) {
      try {
        thumbnail = await callbacks.captureThumbnail();
      } catch {
        thumbnail = null;
      }
    }
    if (this.disposed) return;

    /**
     * 2. Hash (incremental-upload key) + local draft persist.
     *
     * THE HASH IS AN UPLOAD KEY, SO IT IS ONLY WORTH PAYING FOR WHEN THERE IS
     * AN UPLOAD.
     *
     * `sha256HexOf` reads the whole snapshot into one contiguous ArrayBuffer
     * before it can digest it. For a real project that is the entire 3MF —
     * tens of megabytes — allocated in one piece on the main thread, on a
     * phone, where the JS heap and the slice worker share a single per-tab
     * budget. Every 9 seconds, for as long as the tab is open.
     *
     * It buys exactly one thing: the incremental-upload skip at step 3, which
     * compares it with `lastSyncedHash`. A guest has no upload. Neither does a
     * project that was never linked to a remote, nor one held by an unresolved
     * conflict — those are the same three conditions step 3 returns on, three
     * lines below, before the hash is looked at.
     *
     * It is also stored on the local draft, and nothing reads it back:
     * `project-store.ts` writes `contentHash` and never compares it, and the
     * one place that does compare a hash (`use-project-persistence.ts`) reads
     * the REMOTE revision's `content_hash` from the server, not the draft's.
     * `contentHash` is `string | null` everywhere downstream, so null is the
     * ordinary "not computed" case, not a new state.
     *
     * `uploadTarget` is resolved ONCE and is what both this decision and the
     * return at step 3 read, so the two can never disagree about whether this
     * run has an upload in it — which is the only way the skip could be lost.
     * It also removes a re-read across the awaits between them: the previous
     * code tested `this.state.remoteProjectId` at the guard and read it again
     * at the request, which is two chances to see two different values.
     */
    const uploadTarget =
      this.opts.userId !== null && !this.state.conflict ? this.state.remoteProjectId : null;
    const hash = this.opts.hash ?? sha256HexOf;
    let contentHash: string | null = null;
    if (uploadTarget) {
      try {
        contentHash =
          kind === "full" ? await hash(files[0]) : await combinedContentHash(await Promise.all(files.map(hash)));
      } catch {
        contentHash = null;
      }
      if (this.disposed) return;
    }

    let localSaved = false;
    try {
      await callbacks.persistDraft?.({ files, kind, contentHash, thumbnail });
      localSaved = true;
    } catch (error) {
      this.setState({
        status: "failed",
        failure: { kind: "local", message: error instanceof Error ? error.message : String(error), retryable: true },
      });
    }
    // Only a clean FULL save is allowed to suppress a later identical run. A
    // degraded source-only save (the engine did not answer) or a failed write
    // must be retried next time, not skipped because the scene looks the same.
    this.lastSavedSignature = localSaved && kind === "full" ? signature : null;
    if (this.disposed) return;
    if (localSaved) {
      this.setState({
        dirty: false,
        lastLocalSaveAt: this.timers.now(),
        lastLocalKind: kind,
        status: "saved-local",
        failure: null,
      });
    }

    // 3. Upload — signed-in and linked only; IndexedDB alone is NEVER "synced".
    // The same three conditions the hash above is skipped for, as one value:
    // a guest, an unlinked project, or an unresolved conflict blocking uploads.
    if (!uploadTarget) return;

    if (contentHash && contentHash === this.lastSyncedHash && kind === this.state.lastSyncedKind) {
      // Unchanged content — nothing to re-upload (incremental save).
      this.setState({ status: "synced" });
      return;
    }

    // From here on the run has network work left to do. Drop the skip mark for
    // the duration: if the upload fails, the auto-retry (and the next edit)
    // must run the whole save again, not find a matching signature and decide
    // there is nothing to do. It is restored below only on a committed upload.
    this.lastSavedSignature = null;
    this.setState({ status: "uploading" });
    const meta = callbacks.getMeta();
    const uploadFiles: SnapshotUploadFile[] = files.map((file) => ({
      kind: kind === "full" ? ("snapshot3mf" as const) : ("source" as const),
      name: file.name,
      blob: file,
      contentType: kind === "full" ? "model/3mf" : file.type || null,
    }));
    if (thumbnail) {
      uploadFiles.push({ kind: "thumbnail", name: "thumbnail.png", blob: thumbnail, contentType: thumbnail.type || "image/png" });
    }

    const result = await this.uploader(
      {
        projectId: uploadTarget,
        baseRevision: this.baseRevision,
        snapshotKind: kind,
        manifest: callbacks.buildManifest(kind),
        schemaVersion: meta.schemaVersion,
        engineVersion: meta.engineVersion,
        files: uploadFiles,
        contentHash: contentHash ?? undefined,
      },
      { api: this.api, signal: this.abort.signal, hash: this.opts.hash, retryDelayMs: this.opts.retryDelayMs }
    );
    if (this.disposed) return;

    if (result.ok) {
      this.baseRevision = result.revision;
      this.lastSyncedHash = result.contentHash;
      this.lastSavedSignature = kind === "full" ? signature : null;
      this.setState({
        status: this.state.dirty ? "unsaved" : "synced",
        lastSyncedRevision: result.revision,
        lastSyncedAt: this.timers.now(),
        lastSyncedKind: result.snapshotKind,
        failure: null,
        conflict: null,
        retryCount: 0,
        nextRetryAt: null,
      });
      return;
    }

    if (result.kind === "cancelled") return;

    if (result.kind === "conflict") {
      this.setState({
        status: "failed",
        conflict: { head: result.head },
        failure: null,
        nextRetryAt: null,
      });
      return;
    }

    if (result.kind === "auth" || result.kind === "quota") {
      this.setState({
        status: "failed",
        failure: { kind: result.kind, message: result.message ?? result.kind, retryable: false },
        nextRetryAt: null,
      });
      return;
    }

    const retryable = result.retryable;
    const retryCount = this.state.retryCount + 1;
    let nextRetryAt: number | null = null;
    if (retryable && retryCount <= this.opts.maxAutoRetries) {
      const delay = (this.opts.retryDelayMs ?? defaultRetryDelay)(retryCount);
      nextRetryAt = this.timers.now() + delay;
      if (this.retryHandle !== null) this.timers.clear(this.retryHandle);
      this.retryHandle = this.timers.set(() => {
        this.retryHandle = null;
        void this.retryNow();
      }, delay);
    }
    this.setState({
      status: "failed",
      failure: { kind: result.kind, message: result.message, retryable },
      retryCount,
      nextRetryAt,
    });
  }
}
