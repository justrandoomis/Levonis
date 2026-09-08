/**
 * Every statement Audit runs, in one file, so the boundaries lint has one place
 * to read and a reviewer has one place to check that the log is append-only:
 * there is no DELETE and no UPDATE here except the sealing pass (which fills
 * chain columns once, guarded by `chain_index IS NULL`) and the detail
 * back-fill (which fills a body once, guarded by `detail IS NULL`). An audit
 * row is never rewritten and never removed.
 */
import type { AuditRow } from '@levonis/contracts/rpc/audit';
import { CHAIN_MAIN, type ChainHead, type SealedLink, type SealedRow, type UnsealedRow } from './chain';

/** A new entry, before it is chained. */
export interface AuditEntry {
  id: string;
  event_id: string;
  event_type: string;
  actor_id: string | null;
  action: string;
  target: string;
  detail_hash: string;
  detail_ref: string | null;
  detail: string | null;
  source_service: string;
  correlation_id: string;
  occurred_at: string;
  recorded_at: string;
}

const INSERT_ENTRY = `INSERT INTO audit_events
  (id, event_id, event_type, actor_id, action, target, detail_hash, detail_ref, detail, source_service, correlation_id, occurred_at, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * The append. `ON CONFLICT DO NOTHING` on `event_id` makes a redelivery a
 * no-op rather than an aborted batch: the consumer's `processed_events` row is
 * the primary idempotency, this is the belt that also covers `record()` calls
 * arriving twice with the same key.
 */
export function insertEntryStatement(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare(`${INSERT_ENTRY} ON CONFLICT(event_id) DO NOTHING`)
    .bind(
      e.id,
      e.event_id,
      e.event_type,
      e.actor_id,
      e.action,
      e.target,
      e.detail_hash,
      e.detail_ref,
      e.detail,
      e.source_service,
      e.correlation_id,
      e.occurred_at,
      e.recorded_at
    );
}

/** Fills a body for an entry that was recorded by hash only. Never overwrites one. */
export function fillDetailStatement(db: D1Database, eventId: string, detail: string): D1PreparedStatement {
  return db.prepare('UPDATE audit_events SET detail = ? WHERE event_id = ? AND detail IS NULL').bind(detail, eventId);
}

export async function headOf(db: D1Database): Promise<ChainHead | null> {
  const row = await db
    .prepare('SELECT chain_index, head_hash, alg, anchored_index, anchored_hash FROM audit_chain_heads WHERE chain = ?')
    .bind(CHAIN_MAIN)
    .first<{ chain_index: number; head_hash: string; alg: string; anchored_index: number | null; anchored_hash: string | null }>();
  if (!row) return null;
  return {
    chain_index: Number(row.chain_index),
    head_hash: String(row.head_hash),
    alg: String(row.alg),
    anchored_index: row.anchored_index === null || row.anchored_index === undefined ? null : Number(row.anchored_index),
    anchored_hash: row.anchored_hash ?? null,
  };
}

/** The next run of rows to link, oldest first. */
export async function unsealedRows(db: D1Database, limit: number): Promise<UnsealedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT seq, id, event_id, event_type, actor_id, action, target, detail_hash, source_service, correlation_id, occurred_at, recorded_at
         FROM audit_events WHERE chain_index IS NULL ORDER BY seq LIMIT ?`
    )
    .bind(limit)
    .all<UnsealedRow>();
  return (results ?? []).map((r) => ({ ...r, seq: Number(r.seq), actor_id: r.actor_id ?? null }));
}

export async function unsealedCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE chain_index IS NULL').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * How long the oldest unchained entry has been waiting, in seconds — the lag
 * `health()` reports. Audit publishes no events, so this is the only lag it
 * has, and it is the one an operator cares about: entries arrive continuously
 * and the chain is what makes them evidence.
 */
export async function sealLagSeconds(db: D1Database, nowMs = Date.now()): Promise<number | null> {
  const row = await db.prepare('SELECT MIN(recorded_at) AS oldest FROM audit_events WHERE chain_index IS NULL').first<{ oldest: string | null }>();
  if (!row?.oldest) return 0;
  const t = Date.parse(row.oldest);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** One row's chain columns. Conditional on the row still being unsealed. */
export function sealLinkStatement(db: D1Database, link: SealedLink, alg: string): D1PreparedStatement {
  return db
    .prepare('UPDATE audit_events SET chain_index = ?, prev_hash = ?, hash = ?, alg = ? WHERE seq = ? AND chain_index IS NULL')
    .bind(link.chain_index, link.prev_hash, link.hash, alg, link.seq);
}

/**
 * The fence. When a head row exists, the new value is written only if the old
 * one is still what the sealer read; otherwise the CASE yields NULL against a
 * NOT NULL column and the WHOLE batch — every `sealLinkStatement` in it —
 * rolls back, so the loser of a race leaves no trace and retries next minute.
 * When no head row exists, the INSERT's primary key does the same job.
 */
export function advanceHeadStatement(
  db: D1Database,
  head: ChainHead | null,
  next: { chain_index: number; head_hash: string; alg: string; sealed_at: string }
): D1PreparedStatement {
  if (!head) {
    return db
      .prepare('INSERT INTO audit_chain_heads (chain, chain_index, head_hash, alg, sealed_at) VALUES (?, ?, ?, ?, ?)')
      .bind(CHAIN_MAIN, next.chain_index, next.head_hash, next.alg, next.sealed_at);
  }
  return db
    .prepare(
      `UPDATE audit_chain_heads
          SET chain_index = CASE WHEN chain_index = ? THEN ? ELSE NULL END,
              head_hash   = CASE WHEN chain_index = ? THEN ? ELSE head_hash END,
              alg         = ?,
              sealed_at   = ?
        WHERE chain = ?`
    )
    .bind(head.chain_index, next.chain_index, head.chain_index, next.head_hash, next.alg, next.sealed_at, CHAIN_MAIN);
}

/** One page of the sealed chain, in seal order. */
export async function sealedPage(db: D1Database, afterIndex: number, limit: number): Promise<SealedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT chain_index, prev_hash, hash, alg, id, event_id, event_type, actor_id, action, target, detail_hash, source_service, correlation_id, occurred_at, recorded_at
         FROM audit_events WHERE chain_index > ? ORDER BY chain_index LIMIT ?`
    )
    .bind(afterIndex, limit)
    .all<SealedRow>();
  return (results ?? []).map((r) => ({ ...r, chain_index: Number(r.chain_index), actor_id: r.actor_id ?? null }));
}

export interface QueryFilter {
  actor_id?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  limit: number;
  /** the `seq` of the last row of the previous page (descending order) */
  cursor: number | null;
}

export const QUERY_LIMIT_MAX = 200;
export const QUERY_LIMIT_DEFAULT = 50;

/**
 * The admin read. Newest first, keyset-paged on `seq` so a concurrent append
 * can neither skip nor duplicate a row. Filters are equality on the indexed
 * columns and a half-open time range; no `LIKE`, no free-text search — a log
 * you can grep from the outside is a log you can probe from the outside.
 */
export async function queryEntries(db: D1Database, f: QueryFilter): Promise<{ rows: AuditRow[]; next: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.actor_id) {
    where.push('actor_id = ?');
    params.push(f.actor_id);
  }
  if (f.action) {
    where.push('action = ?');
    params.push(f.action);
  }
  if (f.target) {
    where.push('target = ?');
    params.push(f.target);
  }
  if (f.from) {
    where.push('recorded_at >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('recorded_at < ?');
    params.push(f.to);
  }
  if (f.cursor !== null) {
    where.push('seq < ?');
    params.push(f.cursor);
  }
  const limit = Math.min(Math.max(1, Math.trunc(f.limit)), QUERY_LIMIT_MAX);
  const sql =
    `SELECT seq, id, event_id, prev_hash, hash, actor_id, action, target, detail, source_service, recorded_at
       FROM audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY seq DESC LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...params, limit + 1)
    .all<{
      seq: number;
      id: string;
      event_id: string;
      prev_hash: string | null;
      hash: string | null;
      actor_id: string | null;
      action: string;
      target: string;
      detail: string | null;
      source_service: string;
      recorded_at: string;
    }>();
  const page = (results ?? []).slice(0, limit);
  const rows: AuditRow[] = page.map((r) => ({
    id: String(r.id),
    seq: Number(r.seq),
    prev_hash: r.prev_hash ?? '',
    hash: r.hash ?? '',
    event_id: String(r.event_id),
    actor_id: r.actor_id ?? null,
    action: String(r.action),
    target: String(r.target ?? ''),
    detail: parseDetail(r.detail),
    source_service: String(r.source_service),
    created_at: String(r.recorded_at),
  }));
  const next = (results ?? []).length > limit ? String(page[page.length - 1].seq) : null;
  return { rows, next };
}

/** A stored body is JSON when the producer sent one; a malformed one is reported as absent, never thrown at an admin. */
function parseDetail(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
