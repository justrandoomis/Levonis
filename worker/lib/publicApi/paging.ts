/**
 * PAGINATION FOR THE PUBLIC API — one shape for every list.
 *
 * `limit` is clamped, never refused: an agent that asks for 1000 gets the
 * maximum and a `next_cursor`, which is more useful than an error. The cursor
 * is opaque (base64url of a small JSON object) so what it holds can change
 * without breaking a client that only ever echoes it back; a cursor that does
 * not decode is a 400, because silently restarting from the first page would
 * make an agent loop forever.
 */
import { HttpError } from '../http';
import type { Pagination } from './types';

export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 50;
/** The deepest offset a cursor may carry — the storefront listing's own ceiling. */
export const MAX_OFFSET = 10_000;

export function parseLimit(raw: string | undefined | null, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const toB64Url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

export function encodeCursor(offset: number): string {
  return toB64Url(JSON.stringify({ o: offset }));
}

export function decodeCursor(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  try {
    const parsed = JSON.parse(fromB64Url(raw)) as { o?: unknown };
    const o = Number(parsed?.o);
    if (Number.isInteger(o) && o >= 0 && o <= MAX_OFFSET) return o;
  } catch {
    /* refused below */
  }
  throw new HttpError(400, 'The cursor is not one this API issued. Start again without it.', 'INVALID_CURSOR', {
    param: 'cursor',
  });
}

/** One page of an already-ordered list. */
export function pageOf<T>(all: readonly T[], limit: number, offset: number): { items: T[]; pagination: Pagination } {
  const items = all.slice(offset, offset + limit);
  const next = offset + limit < all.length && offset + limit <= MAX_OFFSET ? encodeCursor(offset + limit) : null;
  return { items, pagination: { limit, next_cursor: next, total: all.length } };
}

/** Pagination for a source that pages itself: another page exists when this one came back full. */
export function pageFromSource(limit: number, offset: number, returned: number, total: number | null): Pagination {
  const more = total !== null ? offset + returned < total : returned >= limit;
  const next = more && offset + limit <= MAX_OFFSET ? encodeCursor(offset + limit) : null;
  return { limit, next_cursor: next, total };
}
