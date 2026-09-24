/**
 * The share panel's decisions, as pure functions — no DOM, no React, so each
 * is pinned by tests/shareStore.test.ts under `node --test`.
 */
import { qrEncode, qrToSvgPath, type QrMatrix } from '../../profile/qr';

/** The quiet zone the QR spec asks for, in modules, on every side. */
export const QR_QUIET_ZONE = 4;

export interface StoreQr {
  matrix: QrMatrix;
  /** One SVG path, one unit per module, offset by the quiet zone. */
  path: string;
  /** Side of the square viewBox: modules + both quiet zones. */
  viewBox: number;
}

/**
 * The store link as a QR symbol, or null when it cannot be one.
 *
 * REUSES THE REPOSITORY'S OWN ENCODER (worker/lib/qr.ts, via the profile
 * modal's re-export) — the one tests/qr.test.ts verifies — rather than a
 * second implementation or a package. A payload it refuses (empty, or past
 * its capacity) is an honest null the panel says out loud, never a
 * truncated code that scans to a different address.
 */
export function storeQr(url: string): StoreQr | null {
  if (!url) return null;
  try {
    const matrix = qrEncode(url);
    return { matrix, path: qrToSvgPath(matrix, QR_QUIET_ZONE), viewBox: matrix.size + QR_QUIET_ZONE * 2 };
  } catch {
    return null;
  }
}

/**
 * The pixel geometry of the downloadable PNG: whole pixels per module (a
 * fractional module blurs its edges, and a printed code has to scan from a
 * receipt), as close to `target` as that allows, never below 8 px a module.
 */
export function qrPngGeometry(matrix: QrMatrix, target = 1024): { scale: number; side: number } {
  const modules = matrix.size + QR_QUIET_ZONE * 2;
  const scale = Math.max(8, Math.floor(target / modules));
  return { scale, side: modules * scale };
}

/** `ali3d.levonis-iq.com-qr.png` — a name a person recognises in Downloads, nothing path-like. */
export function qrFileName(host: string, url: string): string {
  let base = host;
  if (!base) {
    try {
      base = new URL(url).host;
    } catch {
      base = '';
    }
  }
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `${safe || 'store'}-qr.png`;
}

/** What the link field shows: the host a person recognises, else the whole address. */
export function displayAddress(kit: { host: string; url: string }): string {
  return kit.host || kit.url;
}

/**
 * Whether the system share sheet is offered at all. The button is NOT shown
 * where it cannot work (desktop Firefox, most desktop Chrome) — no fake UI —
 * and `canShare`, where it exists, has the last word on this payload.
 */
export function canShareNatively(nav: Pick<Navigator, 'share' | 'canShare'> | undefined, url: string): boolean {
  if (!nav || typeof nav.share !== 'function') return false;
  if (typeof nav.canShare !== 'function') return true;
  try {
    return nav.canShare({ url });
  } catch {
    return false;
  }
}

/** A user closing the share sheet is not an error to report. */
export function isShareAbort(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

/** How long to wait before asking again while the icon is being cut, and how often at most. */
export const ICON_POLL_MS = 2500;
export const ICON_POLL_LIMIT = 6;

export function shouldPollIcon(state: string, polls: number): boolean {
  return state === 'pending' && polls < ICON_POLL_LIMIT;
}
