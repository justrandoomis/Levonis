/**
 * `fetchWithBudget` (`01-TARGET.md` §11.5): every external fetch goes through
 * a timeout, retries only when the caller says the request is idempotent, an
 * SSRF guard re-run on every redirect hop (absorbing `worker/lib/fetchGuard.ts`
 * — the three functions below are byte-identical copies, pinned by
 * `tests/edgeParity.test.ts`), and an optional circuit breaker per provider.
 * A lint bans bare `fetch(` outside this module.
 */
import { KitError, TransientError, dependencyUnavailable } from './errors';
import { systemClock, type Clock } from './correlation';
import { withTimeout, type CircuitBreaker, type Timers } from './rpc';

const badRequest = (msg: string) => new KitError(400, msg, 'BAD_REQUEST');

const BLOCKED_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

/**
 * `http://localhost./x` has hostname `localhost.` — the fully-qualified form,
 * which resolves to exactly the same place and matched none of the four
 * alternatives above. Every host is normalized before it is judged.
 */
const normalizeHost = (h: string): string => h.toLowerCase().replace(/\.$/, '');

function ipIsPrivate(host: string): boolean {
  // IPv4 literal check.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT is not globally reachable and is frequently used by
    // internal service networks. It must not become an SSRF route merely
    // because it is outside the three RFC1918 blocks.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  // IPv6 literal (bracketed or not).
  const h = normalizeHost(host.replace(/^\[|\]$/g, ''));
  if (h.includes(':')) {
    // An IPv4-MAPPED address wraps a v4 address inside a v6 literal, in either
    // spelling: `::ffff:127.0.0.1` or `::ffff:7f00:1`. Neither starts with fc,
    // fd or fe80 and neither equals ::1, so both walked straight past the
    // checks below and reached 127.0.0.1. The embedded address is unwrapped
    // and re-tested as what it is.
    const mapped = /^::ffff:(.+)$/.exec(h);
    if (mapped) {
      const inner = mapped[1];
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(inner)) return ipIsPrivate(inner);
      // Hex form: two groups of 16 bits are the four v4 octets.
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
      if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return ipIsPrivate(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
      }
      return true; // an ::ffff: form we cannot read is refused, not trusted
    }
    // The deprecated IPv4-COMPATIBLE form has no ffff marker at all:
    // `::127.0.0.1` and `::7f00:1` are still loopback, and neither starts with
    // fc, fd or fe80 nor equals ::1.
    const compat = /^::((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/.exec(h);
    if (compat) {
      const inner = compat[1];
      if (inner.includes('.')) return ipIsPrivate(inner);
      const [hiRaw, loRaw] = inner.split(':');
      const hi = parseInt(hiRaw, 16);
      const lo = parseInt(loRaw, 16);
      return ipIsPrivate(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    const firstRaw = h.split(':', 1)[0];
    const first = firstRaw ? Number.parseInt(firstRaw, 16) : 0;
    const uniqueLocal = (first & 0xfe00) === 0xfc00; // fc00::/7
    const linkLocal = (first & 0xffc0) === 0xfe80;   // fe80::/10
    const siteLocal = (first & 0xffc0) === 0xfec0;   // deprecated, still internal
    const multicast = (first & 0xff00) === 0xff00;   // ff00::/8
    return h === '::1' || h === '::' || uniqueLocal || linkLocal || siteLocal || multicast;
  }
  return false;
}

/**
 * Validates an outbound URL: http(s) only, no credentials, and no LITERAL
 * loopback, private, link-local or multicast address (in any spelling the URL
 * parser normalises — decimal, octal, IPv4-mapped IPv6). Must be re-run on
 * EVERY redirect hop — a first-hop check alone is not a guard.
 *
 * WHAT IT DOES NOT DO: resolve hostnames. A Worker has no DNS API, so a name
 * that resolves to a private address cannot be caught here; it is caught by
 * the platform instead — Workers egress does not route RFC 1918, loopback or
 * link-local ranges, and exposes no metadata endpoint. If this code ever runs
 * somewhere that does route them, resolve-and-check must be added before the
 * connect, and the connection pinned to the checked address.
 */
export function validateOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Only http(s) URLs are allowed');
  if (url.username || url.password) throw badRequest('URLs with credentials are not allowed');
  const host = normalizeHost(url.hostname);
  if (BLOCKED_HOST_RE.test(host) || ipIsPrivate(host)) {
    throw badRequest('This address is not allowed');
  }
  return url;
}

export type RetryOn = number | 'timeout' | 'network';

export interface FetchBudget {
  timeoutMs: number;
  /** retries only when the request is idempotent by contract (GET, or a provider call with its own Idempotency-Key) */
  retries?: number;
  retryOn?: readonly RetryOn[];
  /** re-run validateOutboundUrl on the first hop and on every redirect (default true) */
  ssrfGuard?: boolean;
  maxRedirects?: number;
  breaker?: CircuitBreaker;
  /** injected for tests */
  fetchImpl?: typeof fetch;
  timers?: Timers;
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
  /** a label for errors/logs: 'resend', 'telegram', 'alwaseet', 'turnstile', … */
  provider?: string;
}

export const DEFAULT_RETRY_ON: readonly RetryOn[] = [502, 503, 504, 'timeout', 'network'];

/** The per-provider budgets the design names (`01-TARGET.md` §11.5). */
export const PROVIDER_BUDGETS: Readonly<Record<string, { timeoutMs: number; retries: number }>> = {
  resend: { timeoutMs: 8_000, retries: 2 },
  telegram: { timeoutMs: 5_000, retries: 2 },
  alwaseet: { timeoutMs: 15_000, retries: 0 },
  google_jwks: { timeoutMs: 3_000, retries: 1 },
  turnstile: { timeoutMs: 3_000, retries: 1 },
  ads: { timeoutMs: 5_000, retries: 2 },
};

export class FetchTimeoutError extends TransientError {
  constructor(public readonly url: string, public readonly afterMs: number) {
    super(`fetch ${url} timed out after ${afterMs} ms`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * fetch with a timeout, bounded retries, an SSRF guard on every hop and an
 * optional breaker. Redirects are followed manually so the guard sees each hop.
 */
export async function fetchWithBudget(url: string, init: RequestInit, budget: FetchBudget): Promise<Response> {
  const doFetch = budget.fetchImpl ?? fetch;
  const guard = budget.ssrfGuard ?? true;
  const retryOn = budget.retryOn ?? DEFAULT_RETRY_ON;
  const retries = budget.retries ?? 0;
  const maxRedirects = budget.maxRedirects ?? 3;
  const clock = budget.clock ?? systemClock;
  const sleep = budget.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const provider = budget.provider ?? new URL(url).hostname;

  for (let attempt = 0; ; attempt++) {
    if (budget.breaker && !budget.breaker.tryAcquire()) throw dependencyUnavailable(provider);
    const started = clock.now();
    try {
      let current = url;
      let res: Response | undefined;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (guard) validateOutboundUrl(current);
        const remaining = budget.timeoutMs - (clock.now() - started);
        if (remaining <= 0) throw new FetchTimeoutError(url, budget.timeoutMs);
        const attemptRes = await withTimeout(
          Promise.resolve(doFetch(current, { ...init, redirect: 'manual' })).catch((e) => {
            throw new TransientError(`fetch ${provider} failed: ${(e as Error).message}`, e);
          }),
          remaining,
          () => new FetchTimeoutError(url, budget.timeoutMs),
          budget.timers
        );
        const location = attemptRes.headers.get('location');
        if (attemptRes.status >= 300 && attemptRes.status < 400 && location) {
          current = new URL(location, current).toString();
          continue;
        }
        res = attemptRes;
        break;
      }
      if (!res) throw new KitError(502, `Too many redirects from ${provider}`, 'BAD_UPSTREAM');
      const retryable = retryOn.includes(res.status);
      if (retryable && attempt < retries) {
        budget.breaker?.onFailure();
        await sleep(jitter(attempt));
        continue;
      }
      if (res.status >= 500) budget.breaker?.onFailure();
      else budget.breaker?.onSuccess();
      return res;
    } catch (e) {
      budget.breaker?.onFailure();
      const kind: RetryOn | null = e instanceof FetchTimeoutError ? 'timeout' : e instanceof TransientError ? 'network' : null;
      if (kind && retryOn.includes(kind) && attempt < retries) {
        await sleep(jitter(attempt));
        continue;
      }
      throw e;
    }
  }
}

function jitter(attempt: number): number {
  const base = Math.min(2_000, 200 * 2 ** attempt);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}
