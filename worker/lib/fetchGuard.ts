/**
 * SSRF guard for every outbound fetch the admin surface makes: ingesting an
 * image file, and — since 2026-09-04, at the owner's request — reading a
 * product page on one of the named vendor hosts for the image ADDRESSES it
 * advertises.
 *
 * This module contains no HTML parsing. It owns the network boundary instead:
 * URL validation, manual redirects, a single request deadline and a bounded
 * response reader. Keeping those together makes it impossible for a new
 * caller to validate the first URL and accidentally trust a redirect.
 */

import { badRequest } from './http';

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

export type GuardedFetchErrorCode =
  | 'FETCH_TIMEOUT'
  | 'FETCH_FAILED'
  | 'HTTP_ERROR'
  | 'BAD_REDIRECT'
  | 'TOO_MANY_REDIRECTS'
  | 'SOURCE_TOO_LARGE'
  | 'FETCH_BUDGET_EXCEEDED';

/** A stable code lets API routes translate failures without string parsing. */
export class GuardedFetchError extends Error {
  readonly code: GuardedFetchErrorCode;
  readonly status?: number;

  constructor(code: GuardedFetchErrorCode, message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GuardedFetchError';
    this.code = code;
    this.status = status;
  }
}

/** Shared mutable request budget used by vendor-page expansion. */
export interface GuardedFetchBudget {
  fetches: number;
  bytes: number;
}

export interface ReadLimitOptions {
  /** The most bytes returned. The reader throws before allocating beyond it. */
  maxBytes: number;
  tooLargeMessage?: string;
}

/**
 * Read a response without ever buffering more than the declared limit.
 * Content-Length is only an early refusal; streamed bytes remain authoritative.
 */
export async function readResponseBytes(response: Response, options: ReadLimitOptions): Promise<Uint8Array> {
  const maxBytes = Math.floor(options.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid response byte limit');
  const tooLarge = () =>
    new GuardedFetchError(
      'SOURCE_TOO_LARGE',
      options.tooLargeMessage ?? `Response exceeds the ${maxBytes} byte limit`
    );

  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    if (error instanceof GuardedFetchError) throw error;
    throw new GuardedFetchError('FETCH_FAILED', 'The response body could not be read', undefined, error);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface GuardedFetchOptions {
  maxBytes: number;
  /** Redirect responses followed after the initial request. */
  maxRedirects?: number;
  /** One deadline for redirects AND body download, not one timer per hop. */
  timeoutMs?: number;
  headers?: HeadersInit;
  budget?: GuardedFetchBudget;
  fetcher?: typeof fetch;
}

export interface GuardedFetchResult {
  bytes: Uint8Array;
  /** The validated final address after redirects. */
  url: string;
  response: Response;
  redirects: number;
}

/**
 * Fetch bytes from a public HTTP(S) address under one bounded policy.
 * `validateOutboundUrl` is called immediately before every network hop.
 */
export async function guardedFetchBytes(rawUrl: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error('Invalid redirect limit');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid fetch timeout');
  if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) throw new Error('Invalid source byte limit');

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new GuardedFetchError('FETCH_TIMEOUT', `Timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  const withinDeadline = async <T>(work: Promise<T>): Promise<T> => Promise.race([work, timeout]);
  const fetcher = options.fetcher ?? fetch;
  let target = validateOutboundUrl(rawUrl);
  let redirects = 0;

  try {
    while (true) {
      // Validate again at the point of use. This is intentionally redundant
      // for the first hop and makes future loop edits fail closed.
      target = validateOutboundUrl(target.toString());
      if (options.budget) {
        if (options.budget.fetches <= 0) {
          throw new GuardedFetchError('FETCH_BUDGET_EXCEEDED', 'Outbound fetch budget exhausted');
        }
        options.budget.fetches -= 1;
      }

      let response: Response;
      try {
        response = await withinDeadline(
          Promise.resolve(
            fetcher(target.toString(), {
              redirect: 'manual',
              signal: controller.signal,
              headers: options.headers,
            })
          )
        );
      } catch (error) {
        if (error instanceof GuardedFetchError) throw error;
        if (controller.signal.aborted) {
          throw new GuardedFetchError('FETCH_TIMEOUT', `Timed out after ${timeoutMs} ms`, undefined, error);
        }
        throw new GuardedFetchError('FETCH_FAILED', 'Fetch failed', undefined, error);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new GuardedFetchError('BAD_REDIRECT', `HTTP ${response.status} redirect has no Location header`);
        if (redirects >= maxRedirects) {
          throw new GuardedFetchError('TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects`);
        }
        let next: string;
        try {
          next = new URL(location, target).toString();
        } catch (error) {
          throw new GuardedFetchError('BAD_REDIRECT', 'Redirect Location is invalid', response.status, error);
        }
        // This check happens before the redirected address can be fetched.
        target = validateOutboundUrl(next);
        redirects += 1;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GuardedFetchError('HTTP_ERROR', `HTTP ${response.status}`, response.status);
      }

      const budgetBytes = options.budget?.bytes ?? options.maxBytes;
      if (budgetBytes <= 0) {
        await response.body?.cancel().catch(() => undefined);
        throw new GuardedFetchError('FETCH_BUDGET_EXCEEDED', 'Outbound byte budget exhausted');
      }
      const cap = Math.min(options.maxBytes, budgetBytes);
      // Reserve before the first body read. Template media is staged in
      // parallel; subtracting only after every response had fully buffered let
      // forty 8 MiB readers all observe the same 64 MiB budget. JavaScript
      // executes this subtraction synchronously, so concurrent readers can
      // reserve at most the remaining aggregate allowance. On success the
      // unused portion is returned. On failure it stays consumed because the
      // reader may already have received bytes we can no longer count.
      if (options.budget) options.budget.bytes -= cap;
      let bytes: Uint8Array;
      try {
        bytes = await withinDeadline(readResponseBytes(response, { maxBytes: cap }));
      } catch (error) {
        if (
          error instanceof GuardedFetchError &&
          error.code === 'SOURCE_TOO_LARGE' &&
          budgetBytes < options.maxBytes
        ) {
          throw new GuardedFetchError('FETCH_BUDGET_EXCEEDED', 'Outbound byte budget exhausted', undefined, error);
        }
        throw error;
      }
      if (options.budget) options.budget.bytes += cap - bytes.byteLength;
      return { bytes, url: target.toString(), response, redirects };
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
