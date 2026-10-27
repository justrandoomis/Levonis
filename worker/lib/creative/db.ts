/**
 * THE STUDIO'S DATABASE HELPERS — the deploy-ahead rule in one place
 * (CLAUDE.md rule 2; packages/creativeDoc/src/api.ts header).
 *
 * The Worker can run against a database that does not have migration 0215
 * yet (a manual redeploy of this commit over an older database, or Workers
 * Builds re-opened in an emergency). On such a database every studio read
 * answers exactly as it would on the migrated one with nothing in it — a list
 * is 200 `{ migrated: false, … }` with empty data, an item is 404 — and every
 * write is a 503 CREATIVE_SCHEMA_MISSING. Never a 500, and never a status
 * that differs between the two databases (tests/costDeployAhead.test.ts,
 * tests/fxDeployAhead.test.ts sweep every GET for that).
 */
import { HttpError } from '../http';

/** A D1/SQLite "no such table" (or column) error — the only error the deploy-ahead path absorbs. */
export function isMissingSchema(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(msg);
}

export function schemaMissing(): HttpError {
  return new HttpError(503, 'The Creative Studio tables are not installed on this database yet (migration 0215).', 'CREATIVE_SCHEMA_MISSING');
}

/** Run a read; on a database without the studio tables answer `fallback` instead. Every other error propagates. */
export async function readOr<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSchema(e)) return fallback;
    throw e;
  }
}

/** Run a write; on a database without the studio tables refuse with 503 CREATIVE_SCHEMA_MISSING. */
export async function writeOr503<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSchema(e)) throw schemaMissing();
    throw e;
  }
}

/** Is the studio installed? One cheap probe for the routes that must say `migrated` without reading data. */
export async function studioInstalled(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT 1 FROM creative_documents LIMIT 1').first();
    return true;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

/** A stored JSON object, or `{}` — a malformed cell is treated as empty, never a crash. */
export function jsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || !text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A stored JSON array, or `[]`. */
export function jsonArray(text: unknown): unknown[] {
  if (typeof text !== 'string' || !text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const stringList = (text: unknown): string[] => jsonArray(text).filter((x): x is string => typeof x === 'string');

/** An integer cell, or null. */
export function intOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** A user's display name for `*_by_name` fields (never an email): the users row's name or username. */
export async function namesOf(db: D1Database, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, 200);
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const { results } = await db
    .prepare('SELECT id, name, username FROM users WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(wanted))
    .all<{ id: string; name: string | null; username: string | null }>();
  for (const r of results ?? []) out.set(r.id, (r.name || r.username || '').slice(0, 80));
  return out;
}
