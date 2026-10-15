/**
 * THE POLITE FETCHERS (Bambu import spec §J.1, §J.2, §B.5).
 *
 * The STORE (us.store.bambulab.com) is read one request at a time, at least
 * 11 s apart (every store request counts, robots.txt and sitemaps included),
 * with the import's own User-Agent, `Accept-Encoding: br, gzip`, no cookies,
 * no proxy and no browser. Only product pages, the three sitemaps and
 * robots.txt are ever requested.
 *
 *   - a 403, a `cf-mitigated` header or a "Just a moment…" body → BLOCKED
 *     ACCESS_CHALLENGE at once. NEVER bypassed: no header spoofing, no
 *     headless browser on the store, no proxies, no retry around it;
 *   - 429 / 503 → `Retry-After`, else 60 s, 120 s, 240 s … 30 min, each wait
 *     within the deadline rules (§A.7);
 *   - 404 / 410, or a redirect to a non-product → SOURCE_WITHDRAWN;
 *   - a redirect to ANOTHER product → IDENTITY_AMBIGUOUS (a reviewed manifest
 *     change, never a silent follow).
 *
 * OTHER HOSTS (document checks, tracker HEADs, the wiki, the public site for
 * verification) go through `HostFetcher`, which knows each host's spacing and
 * refuses any host it does not list — the store among them.
 */
import { Deadline, retryAfterMs, Spacer, STORE_BACKOFF_BASE, backoff, type Clock, type WorstKey } from './deadline';

export const USER_AGENT = 'Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)';
export const STORE_ORIGIN = 'https://us.store.bambulab.com';
export const STORE_SPACING_MS = 11_000;
export const STORE_TIMEOUT_MS = 30_000;
const STORE_MAX_BYTES = 15 * 1024 * 1024;
/** In-call waits after 429 / 503 before the stage itself is retried (60 s … 960 s). */
const STORE_RATE_ATTEMPTS = 5;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Every failure the runner turns into an item state carries a code from §B.5. */
export class ImportStop extends Error {
  constructor(
    readonly code: string,
    readonly kind: 'blocked' | 'transient' | 'deadline',
    message: string,
    readonly detail: { status?: number; retryAfterMs?: number | null; needMs?: number } = {}
  ) {
    super(message);
    this.name = 'ImportStop';
  }
}

export const blockedStop = (code: string, message: string, status?: number) => new ImportStop(code, 'blocked', message, { status });
export const transientStop = (code: string, message: string, status?: number, retryAfter: number | null = null) =>
  new ImportStop(code, 'transient', message, { status, retryAfterMs: retryAfter });
export const deadlineStop = (needMs: number) => new ImportStop('DEADLINE_EXIT', 'deadline', 'a wait does not fit before the job deadline', { needMs });

const CHALLENGE_BODY = /just a moment|cf-browser-verification|challenge-platform|cf_chl_/i;

/** The bot-challenge signs of §J.1: a 403, a `cf-mitigated` header, a "Just a moment…" body. */
export function isChallenge(status: number, headers: Headers, body: string): boolean {
  if (status === 403) return true;
  if (headers.get('cf-mitigated')) return true;
  return CHALLENGE_BODY.test(body.slice(0, 20_000));
}

/** Reads at most `max` bytes of a body as text (a larger body is cut, never buffered whole). */
async function boundedText(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw transientStop('SOURCE_TOO_LARGE', 'the store page is larger than the import reads');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The first `max` bytes of a body; the rest is never downloaded (a document check reads 1 KB). */
async function firstBytes(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return new Uint8Array(all.subarray(0, max));
}

export interface StorePage {
  html: string;
  status: number;
  fetchedAt: string;
  /** True when one same-product redirect (case, trailing slash, encoding) was followed. */
  redirected: boolean;
}

export interface StoreFetcherOptions {
  fetch: FetchLike;
  clock: Clock;
  deadline: Deadline;
  origin?: string;
  spacingMs?: number;
  timeoutMs?: number;
  /** Called with the path of every store request just before it is sent (tests count and order them). */
  onRequest?: (path: string) => void;
}

/** The handle of a `/products/<handle>` path, decoded and lower-cased; '' when the path is not a product page. */
export function productHandleOf(path: string): string {
  const m = /^\/products\/([^/?#]+)\/?$/.exec(path);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).normalize('NFC').toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

export class StoreFetcher {
  readonly origin: string;
  private readonly spacer: Spacer;
  private readonly timeoutMs: number;
  /** Store requests sent by this job. */
  requests = 0;

  constructor(private readonly opts: StoreFetcherOptions) {
    this.origin = (opts.origin ?? STORE_ORIGIN).replace(/\/+$/, '');
    this.spacer = new Spacer(opts.clock, { store: opts.spacingMs ?? STORE_SPACING_MS });
    this.timeoutMs = opts.timeoutMs ?? STORE_TIMEOUT_MS;
  }

  /** When the last store request was sent (ms), or null. */
  lastRequestAt(): number | null {
    return this.spacer.lastAt('store');
  }

  /** Waits out the spacing (and any extra wait) inside the deadline rules, or stops the job. */
  private async waitFor(extraMs: number, stage: WorstKey): Promise<void> {
    const wait = Math.max(this.spacer.due('store'), extraMs);
    if (!this.opts.deadline.fitsStage(wait, stage)) throw deadlineStop(wait);
    if (wait > 0) await this.opts.clock.sleep(wait);
  }

  /** One store request: spacing first, our headers, no cookie, no redirect followed. */
  private async send(path: string): Promise<Response> {
    this.opts.onRequest?.(path);
    this.spacer.mark('store');
    this.requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.opts.fetch(`${this.origin}${path}`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: path.endsWith('.xml') || path.endsWith('.txt') ? 'text/xml,text/plain,*/*;q=0.5' : 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'br, gzip',
        },
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      throw transientStop('STORE_UNREACHABLE', `store request failed (${err instanceof Error ? err.name : 'error'})`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET one store path with the §J.1 rules. `same` decides whether a redirect
   * target is the same resource (followed once); `stage` is what the waits are
   * measured against.
   */
  private async get(path: string, stage: WorstKey, same: (target: string) => 'same' | 'other_product' | 'elsewhere'): Promise<{ body: string; status: number; redirected: boolean }> {
    let current = path;
    let redirected = false;
    for (let attempt = 0; ; attempt++) {
      await this.waitFor(0, stage);
      const res = await this.send(current);
      const status = res.status;
      if (status >= 300 && status < 400) {
        const location = res.headers.get('location') ?? '';
        await res.body?.cancel().catch(() => {});
        let target: URL | null = null;
        try {
          target = new URL(location, this.origin);
        } catch {
          target = null;
        }
        if (!target || target.origin !== this.origin) throw blockedStop('SOURCE_WITHDRAWN', 'the store redirects the page off the store', status);
        const verdict = same(target.pathname);
        if (verdict === 'other_product') throw blockedStop('IDENTITY_AMBIGUOUS', 'the store redirects the page to another product', status);
        if (verdict === 'elsewhere' || redirected) throw blockedStop('SOURCE_WITHDRAWN', 'the store redirects the page to a non-product', status);
        redirected = true;
        current = target.pathname + target.search;
        continue;
      }
      if (status === 403 || status === 401 || status === 451 || res.headers.get('cf-mitigated')) {
        await res.body?.cancel().catch(() => {});
        throw blockedStop('ACCESS_CHALLENGE', 'the store refused the request or answered a challenge', status);
      }
      if (status === 404 || status === 410) {
        await res.body?.cancel().catch(() => {});
        throw blockedStop('SOURCE_WITHDRAWN', 'the store page is gone', status);
      }
      if (status === 429 || status === 503) {
        const text = await boundedText(res, 200_000).catch(() => '');
        if (isChallenge(status, res.headers, text)) throw blockedStop('ACCESS_CHALLENGE', 'the store answered a challenge', status);
        const after = retryAfterMs(res.headers.get('retry-after'), this.opts.clock.now());
        const wait = after ?? backoff(attempt, STORE_BACKOFF_BASE);
        if (attempt + 1 >= STORE_RATE_ATTEMPTS) throw transientStop('STORE_RATE_LIMITED', 'the store keeps asking to wait', status, wait);
        if (!this.opts.deadline.fitsStage(wait, stage)) throw deadlineStop(wait);
        await this.opts.clock.sleep(wait);
        continue;
      }
      if (status < 200 || status >= 300) {
        await res.body?.cancel().catch(() => {});
        throw transientStop('STORE_UNAVAILABLE', 'the store answered an error', status);
      }
      const body = await boundedText(res, STORE_MAX_BYTES);
      if (isChallenge(status, res.headers, body)) throw blockedStop('ACCESS_CHALLENGE', 'the store answered a challenge', status);
      return { body, status, redirected };
    }
  }

  /** robots.txt (once per job): a 4xx means no rules; a challenge stops the job. */
  async robotsTxt(stage: WorstKey = 'EXTRACT'): Promise<string | null> {
    try {
      const { body } = await this.get('/robots.txt', stage, (p) => (p === '/robots.txt' ? 'same' : 'elsewhere'));
      return body;
    } catch (err) {
      if (err instanceof ImportStop && err.code === 'SOURCE_WITHDRAWN') return null;
      throw err;
    }
  }

  /** A product page by its raw handle (as the sitemap writes it). */
  async productPage(rawHandle: string, stage: WorstKey = 'EXTRACT'): Promise<StorePage> {
    const path = `/products/${rawHandle}`;
    const want = productHandleOf(path);
    const { body, status, redirected } = await this.get(path, stage, (target) => {
      const h = productHandleOf(target);
      if (!h) return 'elsewhere';
      return h === want ? 'same' : 'other_product';
    });
    return { html: body, status, fetchedAt: new Date(this.opts.clock.now()).toISOString(), redirected };
  }

  /** One of the three sitemaps (§I.3). */
  async sitemap(path: string, stage: WorstKey = 'EXTRACT'): Promise<string> {
    const { body } = await this.get(path, stage, (p) => (p === path ? 'same' : 'elsewhere'));
    return body;
  }
}

// ------------------------------------------------------------------ other hosts

/** §J.2 spacing per host (ms). The store is NOT here: it is only ever read by StoreFetcher. */
export const HOST_SPACING: Readonly<Record<string, number>> = {
  'store.bblcdn.com': 1000,
  'cdn.shopify.com': 1000,
  'e.bambulab.com': 1000,
  'wiki.bambulab.com': 5000,
};
/** ≤ 4 requests per second to the public site. */
export const SITE_SPACING_MS = 250;

export interface HostResponse {
  status: number;
  headers: Headers;
  /** The body (bounded) for GET; '' for HEAD. */
  body: string;
  bytes: Uint8Array | null;
}

export interface HostFetcherOptions {
  fetch: FetchLike;
  clock: Clock;
  deadline: Deadline;
  /** The public site origin (verification reads); its spacing is SITE_SPACING_MS. */
  siteOrigin: string;
  timeoutMs?: number;
  spacing?: Readonly<Record<string, number>>;
  onRequest?: (host: string, method: string) => void;
}

export class HostFetcher {
  private readonly spacer: Spacer;
  readonly siteHost: string;

  constructor(private readonly opts: HostFetcherOptions) {
    this.siteHost = new URL(opts.siteOrigin).host;
    this.spacer = new Spacer(opts.clock, { ...(opts.spacing ?? HOST_SPACING), [this.siteHost]: SITE_SPACING_MS });
  }

  allowed(host: string): boolean {
    return host === this.siteHost || Object.prototype.hasOwnProperty.call(this.opts.spacing ?? HOST_SPACING, host);
  }

  /**
   * One request to an allow-listed host, spaced for that host. `afterMs` is the
   * worst case of what must still fit after the spacing wait.
   */
  async request(
    url: string,
    init: { method?: 'GET' | 'HEAD' | 'POST'; headers?: Record<string, string>; body?: string; redirect?: 'manual' | 'follow'; maxBytes?: number; wantBytes?: boolean } = {},
    afterMs = 0
  ): Promise<HostResponse> {
    const target = new URL(url);
    if (!this.allowed(target.host)) throw new ImportStop('HOST_NOT_ALLOWED', 'blocked', 'a request to a host the import does not read');
    const wait = this.spacer.due(target.host);
    if (!this.opts.deadline.fits(wait, afterMs)) throw deadlineStop(wait);
    if (wait > 0) await this.opts.clock.sleep(wait);
    this.spacer.mark(target.host);
    const method = init.method ?? 'GET';
    this.opts.onRequest?.(target.host, method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      const res = await this.opts.fetch(target.toString(), {
        method,
        redirect: init.redirect ?? 'manual',
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
        body: init.body,
        credentials: 'omit',
        signal: controller.signal,
      });
      if (method === 'HEAD') {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, headers: res.headers, body: '', bytes: null };
      }
      const max = init.maxBytes ?? 4 * 1024 * 1024;
      if (init.wantBytes) return { status: res.status, headers: res.headers, body: '', bytes: await firstBytes(res, max) };
      const body = await boundedText(res, max).catch((e) => {
        if (e instanceof ImportStop) return '';
        throw e;
      });
      return { status: res.status, headers: res.headers, body, bytes: null };
    } catch (err) {
      if (err instanceof ImportStop) throw err;
      throw transientStop('HOST_UNREACHABLE', `request failed (${err instanceof Error ? err.name : 'error'})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
