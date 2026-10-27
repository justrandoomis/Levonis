/**
 * AI JOBS — one row per provider call: idempotency, state, cancellation and
 * "applied once" (spec §29; docs/CREATIVE_STUDIO.md §4 "Jobs").
 *
 *   queued → running → succeeded | failed | cancelled
 *
 * IDEMPOTENCY. The client sends an `idempotency_key` with every AI request.
 * The same key with the same request (its canonical hash, actor and task
 * included) answers the STORED result and calls nobody; the same key with a
 * different request is 409 IDEMPOTENCY_KEY_REUSED. A retry after a dropped
 * connection therefore never pays twice.
 *
 * CANCELLATION AND APPLY. Cancelling a job cannot stop a request already at
 * the provider, but its late result is never applied: a cancelled job answers
 * JOB_CANCELLED to `markApplied`, and the editor applies a patch only through
 * that door. A job is applied at most once (JOB_ALREADY_APPLIED).
 */
import type { AiTask, JobDto, JobStatus } from '../../../packages/creativeDoc/src/api';
import { canonicalJson } from '../../../packages/creativeDoc/src/snapshot';
import { newId, sha256Hex } from '../crypto';
import { HttpError } from '../http';
import { nowIso } from './db';

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;

export interface JobRow {
  id: string;
  task: AiTask;
  status: JobStatus;
  actor_id: string | null;
  idempotency_key: string | null;
  request_hash: string;
  document_id: string | null;
  base_version: number | null;
  target_ids_json: string;
  result_json: string | null;
  error_code: string | null;
  reserved_day: string | null;
  reserved_tokens: number;
  reserved_usd_micro: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  applied_at: string | null;
  applied_version: number | null;
}

export function jobDto(r: JobRow): JobDto {
  return {
    id: r.id,
    task: r.task,
    status: r.status,
    document_id: r.document_id,
    base_version: r.base_version,
    error_code: r.error_code,
    created_at: r.created_at,
    finished_at: r.finished_at,
    applied_at: r.applied_at,
  };
}

/** The request's identity: actor, task and the canonical request (the idempotency key itself excluded). */
export async function requestHash(actorId: string, task: AiTask, request: Record<string, unknown>): Promise<string> {
  const { idempotency_key: _k, ...rest } = request;
  return sha256Hex(canonicalJson({ actor: actorId, task, request: rest }));
}

export async function jobByKey(db: D1Database, key: string): Promise<JobRow | null> {
  return (await db.prepare('SELECT * FROM creative_jobs WHERE idempotency_key = ?').bind(key).first<JobRow>()) ?? null;
}

export async function jobById(db: D1Database, id: string): Promise<JobRow | null> {
  return (await db.prepare('SELECT * FROM creative_jobs WHERE id = ?').bind(id).first<JobRow>()) ?? null;
}

export type JobStart =
  | { kind: 'new'; job: JobRow }
  /** The same key and the same request: the stored outcome, no second call. */
  | { kind: 'replay'; job: JobRow };

/**
 * Open the job for a request, or find the one this key already opened. A
 * concurrent duplicate loses the UNIQUE race and reads the winner.
 */
export async function openJob(
  db: D1Database,
  input: { task: AiTask; actorId: string; key: string; hash: string; documentId: string | null; baseVersion: number | null; targetIds: string[] }
): Promise<JobStart> {
  const existing = await jobByKey(db, input.key);
  if (existing) {
    if (existing.request_hash !== input.hash) {
      throw new HttpError(409, 'This idempotency key was already used for a different request.', 'IDEMPOTENCY_KEY_REUSED');
    }
    return { kind: 'replay', job: existing };
  }
  const id = newId('cjob');
  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO creative_jobs (id, task, status, actor_id, idempotency_key, request_hash, document_id, base_version, target_ids_json, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.task, input.actorId, input.key, input.hash, input.documentId, input.baseVersion, JSON.stringify(input.targetIds.slice(0, 80)), now)
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
      const winner = await jobByKey(db, input.key);
      if (winner) {
        if (winner.request_hash !== input.hash) throw new HttpError(409, 'This idempotency key was already used for a different request.', 'IDEMPOTENCY_KEY_REUSED');
        return { kind: 'replay', job: winner };
      }
    }
    throw e;
  }
  return { kind: 'new', job: (await jobById(db, id))! };
}

/** queued → running, with the reservation it now holds. False when the job was cancelled first. */
export async function markRunning(db: D1Database, id: string, r: { day: string; tokens: number; usdMicro: number }): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE creative_jobs SET status = 'running', started_at = ?, reserved_day = ?, reserved_tokens = ?, reserved_usd_micro = ?
        WHERE id = ? AND status = 'queued'`
    )
    .bind(nowIso(), r.day, r.tokens, r.usdMicro, id)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/** Finish a job — unless it was cancelled meanwhile, which wins (its result is never stored as usable). */
export function finishStatement(db: D1Database, id: string, outcome: { status: 'succeeded' | 'failed'; result?: unknown; code?: string | null }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE creative_jobs SET status = ?, result_json = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status IN ('queued', 'running')`
    )
    .bind(outcome.status, outcome.result === undefined ? null : JSON.stringify(outcome.result), outcome.code ?? null, nowIso(), id);
}

/** Fail a queued job that never reached the provider (budget refused, validation before the call). */
export async function failQueued(db: D1Database, id: string, code: string): Promise<void> {
  await db.prepare(`UPDATE creative_jobs SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND status = 'queued'`).bind(code, nowIso(), id).run();
}

/** Cancel: queued or running → cancelled. A finished job cannot be cancelled; an applied one certainly not. */
export async function cancelJob(db: D1Database, id: string): Promise<JobRow> {
  const job = await jobById(db, id);
  if (!job) throw new HttpError(404, 'Job not found', 'NOT_FOUND');
  if (job.status === 'cancelled') return job;
  if (job.applied_at) throw new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
  // A succeeded job may still be cancelled until it is applied: «إلغاء» then means "do not apply this".
  await db
    .prepare(`UPDATE creative_jobs SET status = 'cancelled', cancelled_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND applied_at IS NULL AND status <> 'cancelled'`)
    .bind(nowIso(), nowIso(), id)
    .run();
  return (await jobById(db, id))!;
}

/**
 * Record that the editor applied this job's result to `documentId` at
 * `version`. Refused when cancelled, failed, not yet succeeded, applied
 * before, or for another document.
 */
export async function markApplied(db: D1Database, id: string, documentId: string, version: number): Promise<JobRow> {
  const job = await jobById(db, id);
  if (!job) throw new HttpError(404, 'Job not found', 'NOT_FOUND');
  if (job.status === 'cancelled') throw new HttpError(409, 'This job was cancelled; its result is never applied.', 'JOB_CANCELLED');
  if (job.applied_at) throw new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
  if (job.status !== 'succeeded') throw new HttpError(409, 'This job has no result to apply.', 'INVALID_INPUT');
  if (job.document_id && job.document_id !== documentId) throw new HttpError(409, 'This result belongs to another design.', 'INVALID_INPUT');
  const res = await db
    .prepare(`UPDATE creative_jobs SET applied_at = ?, applied_version = ? WHERE id = ? AND status = 'succeeded' AND applied_at IS NULL`)
    .bind(nowIso(), version, id)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) {
    const now = await jobById(db, id);
    throw now?.status === 'cancelled'
      ? new HttpError(409, 'This job was cancelled; its result is never applied.', 'JOB_CANCELLED')
      : new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
  }
  return (await jobById(db, id))!;
}

/** Jobs left running by a Worker that died: failed after `olderThanMs`; their reservations are returned to the caller to release. */
export async function staleRunning(db: D1Database, olderThanMs: number, nowMs = Date.now()): Promise<JobRow[]> {
  const cutoff = nowIso(nowMs - olderThanMs);
  const { results } = await db.prepare(`SELECT * FROM creative_jobs WHERE status = 'running' AND started_at < ? LIMIT 20`).bind(cutoff).all<JobRow>();
  return results ?? [];
}
