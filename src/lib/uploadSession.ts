/**
 * RESUMABLE UPLOADS, CLIENT SIDE (docs/COMMUNITY_ECOSYSTEM.md §9.4).
 *
 * `uploadFile` (src/lib/api.ts) posts a whole body and is right for a photo.
 * A print model or a clip is another matter on Iraqi mobile data: the body is
 * hundreds of megabytes, the connection drops, and a reload throws away
 * twenty minutes of upload. `uploadLarge` instead:
 *
 *   1. hashes the file (SHA-256) in a Web Worker, slice by slice, so the
 *      server can prove what arrived is what was chosen;
 *   2. opens a session — `POST /api/uploads/sessions` — and remembers it in
 *      sessionStorage under the file's fingerprint (name + size + mtime);
 *   3. sends fixed-size parts, two in flight, each retried three times with
 *      an exponential pause; a reload resumes from `GET /:id` and sends only
 *      the parts the server does not have;
 *   4. completes — the server verifies, sniffs and answers the stored file;
 *   5. a cancel (`AbortSignal`) deletes the session, unless the abort reason
 *      is UPLOAD_KEEP_SESSION (a tile unmounting on navigation), which keeps
 *      the resume record for the next visit.
 *
 * Every request here uses `fetch` directly rather than `api.post`, because a
 * part is a raw binary body and the shared client JSON-encodes everything but
 * FormData. Refusals still become `ApiError`, so `apiRefusal` translates them.
 */
import { ApiError } from './api';
import { sha256OfBlob } from '../components/upload/sha256core';
import type { HashWorkerMessage } from '../components/upload/sha256.worker';

export type SessionPurpose =
  | 'post' | 'community' | 'chat' | 'request' | 'product_file' | 'order_update'
  // An offer's files (0159, §9.5): private, under the merchant's prefix, keyed back to the offer composer.
  | 'offer';

/** Above this a file takes the session path; the whole-body route is for what fits in one request. */
export const SESSION_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** A model or an archive always takes the session path: it is sniffed, bounded and measured there. */
export const MODEL_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set(['stl', 'obj', '3mf', 'amf', 'glb', 'gltf', 'step', 'stp', 'zip']);

export function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : '';
}

/** Which door a file goes through: `'session'` (uploadLarge) or `'simple'` (the existing uploadFile). */
export function pickUpload(file: Pick<File, 'name' | 'size'>): 'session' | 'simple' {
  if (file.size > SESSION_THRESHOLD_BYTES) return 'session';
  if (MODEL_ARCHIVE_EXTENSIONS.has(fileExtension(file.name))) return 'session';
  return 'simple';
}

// ------------------------------------------------------------- resume records

/** Name, size and modification time: the same file picked again after a reload gets the same key. */
export function fileFingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.size}:${file.lastModified}:${file.name}`;
}

export const RESUME_PREFIX = 'levonis.upload.';

export function resumeKey(purpose: string, fingerprint: string, entityId = ''): string {
  return `${RESUME_PREFIX}${purpose}:${entityId}:${fingerprint}`;
}

export interface ResumeRecord {
  session_id: string;
  chunk_bytes: number;
  sha256: string;
  saved_at: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A record that parses AND has the right shape — anything else is nothing. Every storage call is guarded. */
export function readResume(storage: StorageLike | null | undefined, key: string): ResumeRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ResumeRecord> | null;
    if (
      !v || typeof v !== 'object' ||
      typeof v.session_id !== 'string' || !v.session_id ||
      typeof v.chunk_bytes !== 'number' || !(v.chunk_bytes > 0) ||
      typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)
    ) return null;
    return { session_id: v.session_id, chunk_bytes: v.chunk_bytes, sha256: v.sha256, saved_at: typeof v.saved_at === 'number' ? v.saved_at : 0 };
  } catch {
    return null;
  }
}

export function writeResume(storage: StorageLike | null | undefined, key: string, record: ResumeRecord): void {
  try {
    storage?.setItem(key, JSON.stringify(record));
  } catch {
    // a full or blocked storage only costs the resume, never the upload
  }
}

export function clearResume(storage: StorageLike | null | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // ignored: see writeResume
  }
}

// ------------------------------------------------------------- the arithmetic

export function partCount(totalBytes: number, chunkBytes: number): number {
  return Math.max(1, Math.ceil(totalBytes / chunkBytes));
}

/** The byte span of part `n` (1-based): [start, end). */
export function partRange(n: number, totalBytes: number, chunkBytes: number): { start: number; end: number } {
  const start = (n - 1) * chunkBytes;
  return { start, end: Math.min(start + chunkBytes, totalBytes) };
}

/** 600 ms, 1.2 s, 2.4 s … before the attempt after `attempt` failed. */
export function retryDelayMs(attempt: number, base = 600): number {
  return base * 2 ** Math.max(0, attempt - 1);
}

/** A network drop, a 5xx or a 429 is worth another try; a refusal is not. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'ABORTED') return false;
  return error.status === 0 || error.status >= 500 || error.status === 429;
}

// ------------------------------------------------------------- hashing

const abortedError = () => new ApiError(0, 'Request cancelled', 'ABORTED');

function hashInWorker(file: Blob, onProgress: ((loaded: number) => void) | undefined, signal: AbortSignal | undefined): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../components/upload/sha256.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(error);
      return;
    }
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(abortedError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as HashWorkerMessage;
      if (message.type === 'progress') onProgress?.(message.loaded);
      else if (message.type === 'done') {
        finish();
        resolve(message.hex);
      } else {
        finish();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'hash worker failed'));
    };
    worker.postMessage({ id: 1, file });
  });
}

/**
 * The file's SHA-256 as hex: in a Web Worker where there is one, inline where
 * there is not (the unit tests, an old webview). Progress is bytes hashed.
 */
export async function sha256OfFile(file: Blob, onProgress?: (loaded: number) => void, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortedError();
  if (typeof Worker === 'function') {
    try {
      return await hashInWorker(file, onProgress, signal);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ABORTED') throw error;
      // A worker that cannot start (a CSP, a webview) falls back to the main thread.
    }
  }
  try {
    return await sha256OfBlob(file, onProgress, () => !!signal?.aborted);
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    throw error;
  }
}

// ------------------------------------------------------------- the upload

/** Pass as the abort REASON to keep the session for a later resume (a tile unmounting on navigation). */
export const UPLOAD_KEEP_SESSION = 'keep-session';

export type UploadPhase = 'hashing' | 'creating' | 'uploading' | 'finishing';

export interface UploadProgress {
  phase: UploadPhase;
  /** Bytes hashed (hashing) or bytes the server holds (uploading). */
  loaded: number;
  total: number;
  /** The part that just landed, and how many there are. */
  part?: number;
  parts?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UploadLargeOptions {
  entityId?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Where the resume record lives; defaults to sessionStorage, `null` disables resume. */
  storage?: StorageLike | null;
  /** Injected by tests; defaults to the page's fetch. */
  fetchImpl?: FetchLike;
  /** Injected by tests; defaults to `sha256OfFile`. */
  hash?: (file: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal) => Promise<string>;
  /** Parts in flight at once (2). */
  concurrency?: number;
  /** Retries per part beyond the first attempt (3). */
  retries?: number;
}

export interface UploadLargeResult {
  /** Only for purposes whose consumers send it back: post, community, product_file, offer, order_update. */
  key?: string;
  url: string;
  visibility?: 'public' | 'private';
  mime: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  /** A model's measurements (worker/lib/modelGeometry.ts `ModelAnalysis`), when it was small enough to measure. */
  analysis?: unknown;
  warnings?: string[];
  /** A request's own file row (purpose `request`). */
  file?: Record<string, unknown>;
}

interface SessionState {
  state: 'open' | 'completed' | 'aborted' | 'expired';
  received: number[];
  chunk_bytes: number;
}

async function readJson<T>(res: Response): Promise<T> {
  let data: { success?: boolean; error?: string; code?: string; details?: Record<string, unknown> } & T;
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new ApiError(res.status, res.ok ? 'Invalid server response' : `Server error (${res.status})`);
  }
  if (!res.ok || data.success === false) {
    throw new ApiError(res.status, data.error || `Server error (${res.status})`, data.code, data.details, data as unknown as Record<string, unknown>);
  }
  return data;
}

async function send(fetchImpl: FetchLike, path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
  try {
    return await fetchImpl(path, { credentials: 'same-origin', ...init, signal });
  } catch {
    if (signal?.aborted) throw abortedError();
    throw new ApiError(0, 'Network error — check your connection and try again');
  }
}

async function requestJson<T>(fetchImpl: FetchLike, method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return readJson<T>(await send(fetchImpl, path, init, signal));
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

async function sendPart(fetchImpl: FetchLike, sessionId: string, n: number, body: Blob, signal: AbortSignal | undefined, retries: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await send(
        fetchImpl,
        `/api/uploads/sessions/${encodeURIComponent(sessionId)}/parts/${n}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body },
        signal
      );
      await readJson(res);
      return;
    } catch (error) {
      if (attempt > retries || !isRetryable(error)) throw error;
      await sleep(retryDelayMs(attempt), signal);
    }
  }
}

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
};

/**
 * Upload one large file through a resumable session. Resolves with what the
 * server stored; rejects with an `ApiError` (code `ABORTED` on cancel).
 */
export async function uploadLarge(file: File, purpose: SessionPurpose, opts: UploadLargeOptions = {}): Promise<UploadLargeResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const signal = opts.signal;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const retries = opts.retries ?? 3;
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const report = (p: UploadProgress) => opts.onProgress?.(p);
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortedError();
  };
  const storageKey = resumeKey(purpose, fileFingerprint(file), opts.entityId);

  throwIfAborted();
  report({ phase: 'hashing', loaded: 0, total: file.size });
  const sha256 = await (opts.hash ?? sha256OfFile)(file, (loaded) => report({ phase: 'hashing', loaded, total: file.size }), signal);
  throwIfAborted();

  // RESUME OR CREATE. A saved session is trusted only when it was opened for
  // these very bytes (same digest) and the server still calls it open.
  let sessionId: string | null = null;
  let chunk = 0;
  let received = new Set<number>();
  const saved = readResume(storage, storageKey);
  if (saved && saved.sha256 === sha256) {
    try {
      const state = await requestJson<SessionState>(fetchImpl, 'GET', `/api/uploads/sessions/${encodeURIComponent(saved.session_id)}`, undefined, signal);
      if (state.state === 'open') {
        sessionId = saved.session_id;
        chunk = state.chunk_bytes;
        received = new Set(state.received);
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ABORTED') throw error;
      // A session the server no longer has is simply opened afresh.
    }
    if (!sessionId) clearResume(storage, storageKey);
  }
  if (!sessionId) {
    report({ phase: 'creating', loaded: 0, total: file.size });
    const created = await requestJson<{ session_id: string; chunk_bytes: number }>(
      fetchImpl,
      'POST',
      '/api/uploads/sessions',
      { purpose, entity_id: opts.entityId, file_name: file.name, bytes: file.size, mime: file.type, sha256 },
      signal
    );
    sessionId = created.session_id;
    chunk = created.chunk_bytes;
    writeResume(storage, storageKey, { session_id: sessionId, chunk_bytes: chunk, sha256, saved_at: Date.now() });
  }
  const id = sessionId;

  const parts = partCount(file.size, chunk);
  let loaded = 0;
  for (const n of received) {
    if (n >= 1 && n <= parts) {
      const { start, end } = partRange(n, file.size, chunk);
      loaded += end - start;
    }
  }
  report({ phase: 'uploading', loaded, total: file.size, parts });
  const queue: number[] = [];
  for (let n = 1; n <= parts; n++) if (!received.has(n)) queue.push(n);

  try {
    let failure: unknown = null;
    const lane = async () => {
      for (;;) {
        if (failure) return;
        const n = queue.shift();
        if (n === undefined) return;
        throwIfAborted();
        const { start, end } = partRange(n, file.size, chunk);
        try {
          await sendPart(fetchImpl, id, n, file.slice(start, end), signal, retries);
        } catch (error) {
          failure ??= error;
          throw error;
        }
        // A sibling lane's part was refused while this one was in flight: the
        // upload is failing, and a «4 MB of 9 MB» after the refusal would
        // paint the tile as live again. Nothing is reported past a failure.
        if (failure) return;
        loaded += end - start;
        report({ phase: 'uploading', loaded, total: file.size, part: n, parts });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, lane));
    throwIfAborted();
    report({ phase: 'finishing', loaded: file.size, total: file.size, parts });
    const result = await requestJson<UploadLargeResult>(fetchImpl, 'POST', `/api/uploads/sessions/${encodeURIComponent(id)}/complete`, {}, signal);
    clearResume(storage, storageKey);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'ABORTED') {
      if (signal?.reason !== UPLOAD_KEEP_SESSION) {
        clearResume(storage, storageKey);
        // Fire and forget, on a fresh request: the caller's signal is spent.
        void fetchImpl(`/api/uploads/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
      }
    } else if (error instanceof ApiError && (error.code === 'UPLOAD_SESSION_NOT_FOUND' || error.code === 'CHECKSUM_MISMATCH' || error.status === 400)) {
      // Nothing to resume: the server closed or refused this session.
      clearResume(storage, storageKey);
    }
    throw error;
  }
}
