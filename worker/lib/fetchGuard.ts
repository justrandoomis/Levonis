/**
 * SSRF guard for the only two outbound fetches the admin surface still makes:
 * ingesting a DIRECT image file URL for a product or an import (mandate §2 —
 * "رابط الصورة يجب أن يشير مباشرة إلى ملف وسائط صالح، ولا يجوز استعماله لكشط
 * صفحة منتج أو استخراج نصوص منها").
 *
 * Product-page extraction was REMOVED in the product-form mandate (§2). This
 * module deliberately contains no HTML parsing, no metadata reading and no
 * page fetch — only the address validation those image fetches need.
 */

import { badRequest } from './http';

const BLOCKED_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

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
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.includes(':')) {
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
  if (BLOCKED_HOST_RE.test(url.hostname) || ipIsPrivate(url.hostname)) {
    throw badRequest('This address is not allowed');
  }
  return url;
}
