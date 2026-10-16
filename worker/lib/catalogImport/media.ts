/**
 * `/items/:sid/media`: THE IMPORT'S IMAGES, FETCHED BY THE WORKER (Bambu import
 * spec §A.3, §A.7, §C.4).
 *
 *   - At most 4 media a call, inside a 45 s wall budget: what does not fit is
 *     answered `pending` and the runner sends it again.
 *   - store.bblcdn.com over https ONLY, on every hop (`allowHost`, through
 *     worker/lib/fetchGuard.ts): any other host is `failed` /
 *     MEDIA_HOST_NOT_ALLOWED and nothing is requested from it.
 *   - The bytes go through the app's own pipeline (ingestProductMediaUrl:
 *     guarded fetch, sniff, convert to WebP, content-addressed R2 key, cleanup
 *     intent, file_objects); the `catalog_import_media` row keeps the key
 *     referenced across a long block (worker/lib/mediaRefs.ts).
 *   - A medium already `stored` whose R2 object HEADs is never fetched again; a
 *     vanished object is re-ingested. After the write (PUBLISHING,
 *     VERIFYING_LIVE) nothing is fetched: the call only tells a resumed runner
 *     the keys already stored (§A.7, the runner contract).
 *   - A transient failure (a timeout, a fetch that failed, the converter or
 *     storage unavailable) answers `pending` until its third attempt, then
 *     `failed`; a permanent one (a 4xx answer, bytes that are not an image) is
 *     `failed` at once. The answer names codes, never a URL or a message.
 *
 * THE DEV STAND-IN (`CATALOG_IMPORT_MEDIA_ORIGIN`, the local dry run only). The
 * URL that is validated and allow-listed stays the store.bblcdn.com address;
 * only the fetcher behind the guard is swapped for one that asks the loopback
 * origin for the same path — and only when BOTH the request this Worker
 * received is addressed to a loopback host AND the origin is a loopback http
 * origin. The live Worker is only ever reached under its own hostname, the var
 * is declared in no wrangler.jsonc block, so production cannot take this path.
 */
import type { Env } from '../types';
import { GuardedFetchError } from '../fetchGuard';
import { ingestProductMediaUrl, ProductMediaIngestError } from '../productMediaIngest';
import { headMediaObject } from '../mediaStorage';
import { NOW_SQL, OpsRefusal, type ImportRun } from './auth';
import type { ItemRow } from './items';

export const MEDIA_HOST = 'store.bblcdn.com';
export const MEDIA_PER_CALL = 4;
export const MEDIA_WALL_MS = 45_000;
/** A medium fetched no later than this before the wall budget ends; after it, `pending`. */
const MEDIA_MARGIN_MS = 5_000;
const MEDIA_TRIES = 3;

export const MEDIA_ROLES = new Set(['gallery', 'swatch', 'description', 'in_the_box']);
/** The states in which /media fetches; after the write it only reports (§A.7). */
export const INGEST_STATES = new Set(['INGESTING_MEDIA', 'WRITING']);
export const REPORT_STATES = new Set(['INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE']);

export interface MediaRequest {
  source_media_id: string;
  role: string;
  source_url: string;
}

export interface MediaAnswer {
  source_media_id: string;
  status: 'stored' | 'failed' | 'pending' | 'omitted_cap';
  r2_key: string;
  width: number | null;
  height: number | null;
  error_code: string;
}

type MediaEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES' | 'CATALOG_IMPORT_MEDIA_ORIGIN'>;

export function mediaRequestsOf(raw: unknown): MediaRequest[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MEDIA_PER_CALL) throw new OpsRefusal(400, 'MEDIA_BATCH_SIZE');
  const seen = new Set<string>();
  return raw.map((m) => {
    if (!m || typeof m !== 'object') throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    const r = m as Record<string, unknown>;
    const id = typeof r.source_media_id === 'string' ? r.source_media_id : '';
    const role = typeof r.role === 'string' ? r.role : '';
    const url = typeof r.source_url === 'string' ? r.source_url : '';
    if (!id || id.length > 200 || !MEDIA_ROLES.has(role) || !url || url.length > 1000 || seen.has(id)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
    seen.add(id);
    return { source_media_id: id, role, source_url: url };
  });
}

/** The allow-list: store.bblcdn.com over https, nothing else (a stand-in only ever swaps the fetcher). */
export function mediaUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === MEDIA_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The dev-only fetcher, or undefined. Both conditions are required: the request this Worker answers was
 * addressed to a loopback host (only `wrangler dev` is reached that way), and the configured origin is a
 * loopback http origin with no path.
 */
export function standInFetcher(env: Pick<Env, 'CATALOG_IMPORT_MEDIA_ORIGIN'>, requestUrl: string): typeof fetch | undefined {
  const raw = env.CATALOG_IMPORT_MEDIA_ORIGIN;
  if (!raw) return undefined;
  let self: URL;
  let origin: URL;
  try {
    self = new URL(requestUrl);
    origin = new URL(raw);
  } catch {
    return undefined;
  }
  if (!LOOPBACK.has(self.hostname)) return undefined;
  if (origin.protocol !== 'http:' || !LOOPBACK.has(origin.hostname) || (origin.pathname !== '/' && origin.pathname !== '') || origin.search || origin.username) return undefined;
  const base = origin.origin;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
}

interface StoredRow {
  source_media_id: string;
  status: string;
  r2_key: string;
  width: number | null;
  height: number | null;
  attempts: number;
}

const TRANSIENT_FETCH = new Set(['FETCH_TIMEOUT', 'FETCH_FAILED', 'FETCH_BUDGET_EXCEEDED']);
const TRANSIENT_INGEST = new Set(['IMAGE_CONVERT_UNAVAILABLE', 'IMAGE_STORAGE_FAILED', 'IMAGE_REFERENCE_MISSING']);

/** A failure as `{code, transient}`, from a fixed list. */
function failureOf(e: unknown): { code: string; transient: boolean } {
  if (e instanceof GuardedFetchError) {
    if (e.code === 'HOST_NOT_ALLOWED') return { code: 'MEDIA_HOST_NOT_ALLOWED', transient: false };
    if (e.code === 'SOURCE_TOO_LARGE') return { code: 'IMAGE_SOURCE_TOO_LARGE', transient: false };
    if (e.code === 'HTTP_ERROR') return { code: `MEDIA_HTTP_${e.status && e.status >= 500 ? '5XX' : '4XX'}`, transient: !!e.status && e.status >= 500 };
    if (e.code === 'FETCH_TIMEOUT') return { code: 'MEDIA_TIMEOUT', transient: true };
    return { code: TRANSIENT_FETCH.has(e.code) ? 'MEDIA_FETCH_FAILED' : 'MEDIA_REDIRECT_REFUSED', transient: TRANSIENT_FETCH.has(e.code) };
  }
  if (e instanceof ProductMediaIngestError) return { code: e.code, transient: TRANSIENT_INGEST.has(e.code) };
  return { code: 'MEDIA_FETCH_FAILED', transient: true };
}

/** POST /items/:sid/media (after holdLease). */
export async function ingestImportMedia(env: MediaEnv, requestUrl: string, run: ImportRun, item: ItemRow, requests: MediaRequest[]): Promise<MediaAnswer[]> {
  if (!REPORT_STATES.has(item.processing_state)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  if (!env.BUCKET && !env.R2_PUBLIC) throw new OpsRefusal(503, 'IMPORT_MEDIA_UNAVAILABLE');
  const fetchNow = INGEST_STATES.has(item.processing_state);
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT source_media_id, status, r2_key, width, height, attempts FROM catalog_import_media
        WHERE run_id = ? AND source_product_id = ? AND source_media_id IN (SELECT value FROM json_each(?))`
    )
    .bind(run.id, item.source_product_id, JSON.stringify(requests.map((r) => r.source_media_id)))
    .all<StoredRow>();
  const known = new Map((results ?? []).map((r) => [String(r.source_media_id), r]));
  const fetcher = standInFetcher(env, requestUrl);
  const started = Date.now();
  const out: MediaAnswer[] = [];

  const record = async (m: MediaRequest, a: MediaAnswer, extra: { bytes?: number | null; sha256?: string; tried: boolean }) => {
    await db
      .prepare(
        `INSERT INTO catalog_import_media (run_id, source_product_id, source_media_id, role, source_url, status, r2_key, width, height, bytes, sha256, error_code, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, source_product_id, source_media_id) DO UPDATE SET
           role = excluded.role, source_url = excluded.source_url, status = excluded.status, r2_key = excluded.r2_key,
           width = excluded.width, height = excluded.height, bytes = excluded.bytes, sha256 = excluded.sha256,
           error_code = excluded.error_code, attempts = catalog_import_media.attempts + ?, updated_at = ${NOW_SQL}`
      )
      .bind(
        run.id, item.source_product_id, m.source_media_id, m.role, m.source_url, a.status, a.r2_key, a.width, a.height,
        extra.bytes ?? null, extra.sha256 ?? '', a.error_code, extra.tried ? 1 : 0, extra.tried ? 1 : 0
      )
      .run();
  };

  for (const m of requests) {
    const prev = known.get(m.source_media_id);
    // Already stored and still in R2: never fetched again.
    if (prev && prev.status === 'stored' && prev.r2_key) {
      let present = false;
      try {
        const h = await headMediaObject(env, 'public', prev.r2_key);
        present = !!h && Number(h.size ?? 0) > 0;
      } catch {
        present = false;
      }
      if (present || !fetchNow) {
        out.push({ source_media_id: m.source_media_id, status: present ? 'stored' : 'failed', r2_key: present ? prev.r2_key : '', width: prev.width, height: prev.height, error_code: present ? '' : 'MEDIA_NOT_STORED' });
        continue;
      }
    }
    if (!fetchNow) {
      out.push({ source_media_id: m.source_media_id, status: 'failed', r2_key: '', width: null, height: null, error_code: 'MEDIA_NOT_STORED' });
      continue;
    }
    if (!mediaUrlAllowed(m.source_url)) {
      const a: MediaAnswer = { source_media_id: m.source_media_id, status: 'failed', r2_key: '', width: null, height: null, error_code: 'MEDIA_HOST_NOT_ALLOWED' };
      await record(m, a, { tried: false });
      out.push(a);
      continue;
    }
    const left = MEDIA_WALL_MS - (Date.now() - started);
    if (left < MEDIA_MARGIN_MS + 1_000) {
      out.push({ source_media_id: m.source_media_id, status: 'pending', r2_key: '', width: null, height: null, error_code: '' });
      continue;
    }
    try {
      const r = await ingestProductMediaUrl(env, m.source_url, {
        allowHost: (host) => host === MEDIA_HOST,
        fetcher,
        timeout_ms: Math.min(30_000, left - MEDIA_MARGIN_MS),
        max_redirects: 2,
      });
      const a: MediaAnswer = { source_media_id: m.source_media_id, status: 'stored', r2_key: r.key, width: r.width, height: r.height, error_code: '' };
      await record(m, a, { bytes: r.bytes, sha256: /([0-9a-f]{64})\.webp$/.exec(r.key)?.[1] ?? '', tried: true });
      out.push(a);
    } catch (e) {
      const f = failureOf(e);
      const tries = Number(prev?.attempts ?? 0) + 1;
      const status = f.transient && tries < MEDIA_TRIES ? 'pending' : 'failed';
      const a: MediaAnswer = { source_media_id: m.source_media_id, status, r2_key: '', width: null, height: null, error_code: f.code };
      await record(m, a, { tried: true });
      out.push(a);
    }
  }
  return out;
}
