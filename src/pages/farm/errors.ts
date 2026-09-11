/**
 * Server refusals → words. `HttpError` codes are SCREAMING_SNAKE; the strings
 * table carries a sentence for each one the contract names, and a few the
 * routes are likely to add. Anything else falls back to the server's own
 * message, then to the generic line — never to silence.
 */
import { ApiError } from '../../lib/api';
import type { FarmStrings } from './strings';

export function farmErrorText(err: unknown, s: FarmStrings): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return s.errors.RATE_LIMITED;
    // 409 FEATURE_LOCKED carries { min_level }: say the level when it is there.
    if (err.code === 'FEATURE_LOCKED') {
      const level = err.details?.min_level;
      if (typeof level === 'number') return s.lockedLevel(level);
    }
    if (err.code && s.errors[err.code]) return s.errors[err.code];
    if (err.status === 404) return s.errors.NOT_FOUND;
    if (err.status === 0) return err.message;
    if (err.message) return err.message;
  }
  return s.errGeneric;
}

/** Codes after which the screen must re-read the state instead of retrying. */
export function isStateConflict(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 409 || err.status === 400 || err.status === 404);
}

/**
 * 409 STATE_CHANGED: the row moved under the intent (another tab, the
 * resolver). The one refusal worth retrying — after a fresh GET /state, once.
 */
export function isStateChanged(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'STATE_CHANGED';
}
