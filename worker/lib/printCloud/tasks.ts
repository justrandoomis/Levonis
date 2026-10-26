/**
 * Durable background work: the row a request writes so the work happens
 * later, outside the request (worker/lib/printCloud/background.ts runs it).
 * `dedupe_key` is UNIQUE, so enqueueing the same work twice is a no-op.
 */
import type { Stmt } from './db';
import { iso, pcId } from './util';

export type TaskKind =
  | 'analyze_model_file'
  | 'import_model_url'
  | 'expire_orders'
  | 'expire_credit_lots'
  | 'low_inventory_scan'
  | 'schedule_queue'
  | 'reconcile'
  | 'slicing_lease_sweep';

export const TASK_KINDS: readonly TaskKind[] = [
  'analyze_model_file',
  'import_model_url',
  'expire_orders',
  'expire_credit_lots',
  'low_inventory_scan',
  'schedule_queue',
  'reconcile',
  'slicing_lease_sweep',
];

export function enqueueTask(
  db: D1Database,
  p: { kind: TaskKind; payload?: Record<string, unknown>; dedupeKey: string; now: Date; runAfter?: Date; maxAttempts?: number }
): Stmt {
  return db
    .prepare(
      `INSERT OR IGNORE INTO pc_background_jobs (id, kind, payload_json, dedupe_key, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`
    )
    .bind(pcId('pcbj'), p.kind, JSON.stringify(p.payload ?? {}), p.dedupeKey, p.maxAttempts ?? 5, iso(p.runAfter ?? p.now), iso(p.now), iso(p.now));
}
