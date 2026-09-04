/**
 * SSRF guard for every outbound fetch the admin surface makes: ingesting an
 * image file, and — since 2026-09-04, at the owner's request — reading a
 * product page on one of the named vendor hosts for the image ADDRESSES it
 * advertises.
 *
 * This module still contains no HTML parsing and no page fetch of its own: it
 * validates addresses and nothing else, and it must be re-run on EVERY
 * redirect hop. Which hosts may be read as pages, and what is read out of
 * them, live in worker/lib/pageImages.ts.
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
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::';
  }
  return false;
}

/** Validates an outbound URL: http(s) only, no credentials, no loopback,
 *  private, link-local or multicast address. Must be re-run on EVERY redirect
 *  hop — a first-hop check alone is not a guard. */
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
