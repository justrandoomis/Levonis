/**
 * THE CLOUD CLIENT — every agent door of docs/PRINT_CLOUD.md §9, as served by
 * worker/routes/printCloudAgent.ts under /api/print-cloud/v1/agent.
 *
 *   GET  /printers                 the printers bound to this token
 *   POST /printers/:id/telemetry   one reading, ordered by (boot, seq)
 *   POST /jobs/:id/events          started | paused | resumed | completed | failed
 *   GET  /jobs/:id                 what a job on one of our printers prints
 *   GET  /commands?since=          operator commands for our printers
 *   POST /slicing/claim            the oldest slicing request, under a 10-minute lease
 *   POST /slicing/:id/result       measured slicer figures
 *   POST /slicing/:id/failure      the slicer could not measure it
 *   GET  /files/:id                a model of a job we slice or print
 *
 * RETRIES. A network error, a timeout, a 5xx and a 429 are retried with
 * exponential backoff and jitter (a 429's Retry-After is honoured). A 4xx is
 * an answer, not an outage, and is not retried — with one documented
 * exception: 409 STATE_CHANGED («the record changed while the request was
 * running; try again», worker/lib/printCloud/errors.ts) on the doors whose
 * re-send is harmless (telemetry, job events). On the slicing doors a
 * STATE_CHANGED means the request is no longer ours to answer, so it is
 * returned to the caller instead.
 *
 * RE-SENDS ARE IDEMPOTENT BY CONSTRUCTION, so a retry after a lost answer
 * never doubles anything: a reading keeps its (boot, seq) — the same pair is
 * «superseded», never stored twice; a job event keeps the `event_id` the
 * runner persisted before the first send — the cloud answers
 * `already_applied`. The body of a telemetry POST is rebuilt per attempt so
 * its `sent_at` is the moment of THAT attempt (the age `sent_at -
 * reported_at` stays true on one clock).
 *
 * The bearer token goes only to the configured origin: a file path the cloud
 * hands back is followed only inside the agent API.
 */
import { silentLogger } from './log.mjs';

export const AGENT_BASE = '/api/print-cloud/v1/agent';
const FILE_PATH = new RegExp(`^${AGENT_BASE.replace(/[/.]/g, '\\$&')}/files/[A-Za-z0-9_-]{1,120}$`);
const DEFAULT_MAX_DOWNLOAD = 512 * 1024 * 1024;

export class CloudError extends Error {
  /**
   * @param {{ status: number, code?: string | null, message?: string, details?: unknown, retryable: boolean, cause?: unknown }} p
   */
  constructor(p) {
    super(p.message ?? (p.status ? `HTTP ${p.status}${p.code ? ` ${p.code}` : ''}` : 'network error'));
    this.name = 'CloudError';
    /** HTTP status; 0 for a network error or a timeout. */
    this.status = p.status;
    /** The cloud's stable refusal code (VALIDATION, NOT_FOUND, STATE_CHANGED, …), when it gave one. */
    this.code = p.code ?? null;
    this.details = p.details ?? null;
    /** True when the request could succeed later unchanged (an outage), false when it was answered. */
    this.retryable = p.retryable;
    if (p.cause !== undefined) this.cause = p.cause;
  }
}

/**
 * Did the cloud refuse the TOKEN itself (revoked, wrong)? The agent API says
 * so with AGENT_UNAUTHORIZED. A 401 with another code came from a router that
 * is not the agent API — a door this cloud does not have, falling through —
 * and says nothing about the token.
 */
export const tokenRejected = (e) => e instanceof CloudError && e.status === 401 && (e.code === 'AGENT_UNAUTHORIZED' || e.code === null);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), or null. */
function retryAfterMs(value, now) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export class CloudClient {
  /**
   * @param {{
   *   baseUrl: string, token: string, fetch?: typeof fetch, timeoutMs?: number, downloadTimeoutMs?: number,
   *   attempts?: number, backoffMs?: number, maxBackoffMs?: number, maxDownloadBytes?: number,
   *   sleep?: (ms: number) => Promise<unknown>, random?: () => number, clock?: () => number, log?: ReturnType<typeof import('./log.mjs').createLogger>
   * }} opts
   */
  constructor(opts) {
    const url = new URL(opts.baseUrl);
    this.origin = url.origin;
    this.token = opts.token;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 300_000;
    this.attempts = opts.attempts ?? 5;
    this.backoffMs = opts.backoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.maxDownloadBytes = opts.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.clock = opts.clock ?? (() => Date.now());
    this.log = opts.log ?? silentLogger;
    this.log.addSecret(this.token);
  }

  backoff(attempt, hintMs) {
    if (hintMs !== null && hintMs !== undefined) return Math.min(hintMs, 5 * 60_000);
    const base = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - 1));
    return Math.round(base * (0.5 + this.random() / 2));
  }

  /**
   * One door, with the retry policy above.
   *
   * @param {string} method
   * @param {string} path  a path under the agent API (`/printers`) or an absolute agent path
   * @param {{ body?: unknown | (() => unknown), query?: Record<string, string | null | undefined>, retryStateChanged?: boolean, download?: boolean, attempts?: number }} [opts]
   * @returns {Promise<{ status: number, data: any, headers: Headers, bytes?: Buffer }>}
   */
  async request(method, path, opts = {}) {
    const full = path.startsWith(AGENT_BASE) ? path : `${AGENT_BASE}${path}`;
    const url = new URL(full, this.origin);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== null && v !== undefined) url.searchParams.set(k, v);
    const attempts = opts.attempts ?? this.attempts;
    const timeoutMs = opts.download ? this.downloadTimeoutMs : this.timeoutMs;
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = this.clock();
      let res;
      let hint = null;
      try {
        res = await this.once(method, url, opts, timeoutMs);
      } catch (e) {
        last = e instanceof CloudError ? e : new CloudError({ status: 0, message: `network: ${/** @type {Error} */ (e)?.message ?? String(e)}`, retryable: true, cause: e });
        if (!last.retryable) throw last;
      }
      if (res) {
        if (res.status >= 200 && res.status < 300) {
          if (opts.download) {
            const bytes = await this.readBytes(res);
            this.log.debug('cloud.request', { method, path: url.pathname, status: res.status, ms: this.clock() - started, bytes: bytes.length });
            return { status: res.status, data: null, headers: res.headers, bytes };
          }
          const parsed = await readBody(res);
          this.log.debug('cloud.request', { method, path: url.pathname, status: res.status, ms: this.clock() - started });
          return { status: res.status, data: parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed, headers: res.headers };
        }
        const parsed = await readBody(res).catch(() => null);
        const code = parsed && typeof parsed.code === 'string' ? parsed.code : null;
        const retryable = res.status >= 500 || res.status === 429 || (res.status === 409 && code === 'STATE_CHANGED' && opts.retryStateChanged !== false);
        last = new CloudError({ status: res.status, code, message: typeof parsed?.error === 'string' ? parsed.error : undefined, details: parsed?.details ?? null, retryable });
        if (!retryable) throw last;
        hint = retryAfterMs(res.headers.get('retry-after'), this.clock());
      }
      if (attempt < attempts) {
        const wait = this.backoff(attempt, hint);
        this.log.warn('cloud.retry', { method, path: url.pathname, attempt, of: attempts, wait_ms: wait, status: last?.status ?? 0, code: last?.code ?? null, error: last?.message });
        await this.sleep(wait);
      }
    }
    throw last ?? new CloudError({ status: 0, message: 'no attempt made', retryable: true });
  }

  /** One HTTP exchange bounded by a timeout, whether or not the fetch honours its abort signal. */
  async once(method, url, opts, timeoutMs) {
    const controller = new AbortController();
    const body = typeof opts.body === 'function' ? opts.body() : opts.body;
    const headers = { Authorization: `Bearer ${this.token}`, Accept: opts.download ? 'application/octet-stream' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CloudError({ status: 0, message: `timeout after ${timeoutMs} ms`, retryable: true }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async readBytes(res) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxDownloadBytes) {
      throw new CloudError({ status: res.status, message: `file larger than ${this.maxDownloadBytes} bytes`, retryable: false });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > this.maxDownloadBytes) throw new CloudError({ status: res.status, message: `file larger than ${this.maxDownloadBytes} bytes`, retryable: false });
    return buf;
  }

  // ------------------------------------------------------------------ the doors

  /** The printers bound to this agent: id, name, model_code, status, connection_ref, current_job_id… */
  async printers() {
    return /** @type {Array<Record<string, any>>} */ ((await this.request('GET', '/printers')).data ?? []);
  }

  /**
   * One reading. `body` is a function so each attempt stamps its own `sent_at`.
   * @returns {Promise<{ stored: boolean, superseded?: boolean, mismatch: boolean }>}
   */
  async telemetry(printerId, body) {
    return (await this.request('POST', `/printers/${encodeURIComponent(printerId)}/telemetry`, { body })).data;
  }

  /**
   * A job event. Returns the HTTP status with the data: 202 means a completion
   * held for an operator's verification (`agent_reports_need_verification`).
   */
  async jobEvent(jobId, body) {
    const r = await this.request('POST', `/jobs/${encodeURIComponent(jobId)}/events`, { body });
    return { status: r.status, data: r.data };
  }

  /**
   * What a job on one of our printers prints, or null when the cloud does not
   * state it: 404 (not on our printer), or a cloud that predates this door —
   * its request falls through to another router, which answers 404 or a 401
   * that is not the agent API's own (tokenRejected).
   */
  async job(jobId) {
    try {
      return (await this.request('GET', `/jobs/${encodeURIComponent(jobId)}`)).data;
    } catch (e) {
      if (e instanceof CloudError && (e.status === 404 || (e.status === 401 && !tokenRejected(e)))) return null;
      throw e;
    }
  }

  /**
   * Operator commands created after `since` (a cloud timestamp), oldest first,
   * at most 100. `serverNow` is the cloud's clock from the Date header, when
   * it sent one — the only fair clock to age a cloud timestamp with.
   */
  async commands(since) {
    const r = await this.request('GET', '/commands', { query: { since: since ?? undefined } });
    const date = Date.parse(r.headers.get('date') ?? '');
    return { commands: /** @type {Array<Record<string, any>>} */ (r.data ?? []), serverNow: Number.isNaN(date) ? null : date };
  }

  /** The oldest waiting slicing request, claimed under a lease — or null when there is none. */
  async claimSlicing() {
    return (await this.request('POST', '/slicing/claim')).data ?? null;
  }

  async slicingResult(requestId, estimate) {
    return (await this.request('POST', `/slicing/${encodeURIComponent(requestId)}/result`, { body: estimate, retryStateChanged: false })).data;
  }

  async slicingFailure(requestId, errorCode) {
    return (await this.request('POST', `/slicing/${encodeURIComponent(requestId)}/failure`, { body: { error_code: errorCode }, retryStateChanged: false })).data;
  }

  /**
   * Download a model by its file id or by the path a claim named. Only paths
   * inside the agent API are followed, so the token never leaves the origin.
   * @returns {Promise<{ bytes: Buffer, filename: string | null }>}
   */
  async downloadFile(fileIdOrPath) {
    const path = fileIdOrPath.startsWith('/') ? fileIdOrPath : `${AGENT_BASE}/files/${encodeURIComponent(fileIdOrPath)}`;
    if (!FILE_PATH.test(path)) throw new CloudError({ status: 0, message: `refusing to follow a file path outside the agent API: ${path.slice(0, 120)}`, retryable: false });
    const r = await this.request('GET', path, { download: true });
    const disposition = r.headers.get('content-disposition') ?? '';
    const m = /filename="([^"]{1,255})"/.exec(disposition);
    return { bytes: /** @type {Buffer} */ (r.bytes), filename: m ? m[1] : null };
  }
}
