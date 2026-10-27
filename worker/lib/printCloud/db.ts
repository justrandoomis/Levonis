/**
 * The D1 discipline every Print Cloud write follows.
 *
 * D1 has no interactive transaction: a request READS, PLANS, then sends ONE
 * `db.batch`, which D1 runs as a single transaction. Everything the plan
 * assumed is re-checked INSIDE that batch, so a concurrent writer can only
 * make it fail, never make it wrong:
 *
 *   - balances carry named CHECKs (no column ever goes negative);
 *   - state transitions are conditional UPDATEs stamped with a fresh
 *     `op_token`, followed by a FENCE asserting the row carries that token —
 *     a transition that matched no row aborts the batch instead of letting
 *     the statements after it run against a state the plan never saw;
 *   - every business event has a unique `entry_key`, so a second copy of the
 *     same event collides.
 *
 * A failed batch is classified (`classifyDbError`) into the refusal it means;
 * `STATE_CHANGED` is retried by `idempotent` with a fresh plan.
 */
import { sha256Hex } from '../crypto';
import { HttpError } from '../http';
import { classifyDbError, isOperationReplay, pcError } from './errors';
import { canonicalJson, iso, pcId } from './util';

export type Stmt = D1PreparedStatement;

export type FenceCode =
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_CREDIT'
  | 'INSUFFICIENT_INVENTORY'
  | 'PRINTER_UNAVAILABLE'
  | 'LIMIT_REACHED'
  | 'STATE_CHANGED';

/**
 * A batch guard: aborts the whole batch with 'PC_FENCE:<code>' unless
 * `condition` (a SQL boolean expression with positional `?` placeholders,
 * bound from `params`) holds at this point of the transaction.
 */
export function fence(db: D1Database, code: FenceCode, condition: string, params: unknown[] = []): Stmt {
  return db
    .prepare(`INSERT INTO pc_fence (code, ok) SELECT ?, CASE WHEN (${condition}) THEN 1 ELSE 0 END`)
    .bind(code, ...params);
}

/** Send one batch; a refusal the database expressed becomes the HttpError it means. */
export async function runBatch(db: D1Database, statements: Stmt[]): Promise<D1Result[]> {
  if (!statements.length) return [];
  try {
    return await db.batch(statements);
  } catch (e) {
    const mapped = classifyDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export async function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  try {
    return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
  } catch (e) {
    if (readsEmpty(db, e)) return null;
    throw e;
  }
}

export async function many<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  try {
    const res = await db.prepare(sql).bind(...params).all<T>();
    return (res.results ?? []) as T[];
  } catch (e) {
    if (readsEmpty(db, e)) return [];
    throw e;
  }
}

// ------------------------------------------------------------------ installed?

const installed = new WeakMap<D1Database, true>();

/**
 * A DATABASE WITHOUT 0215 (CLAUDE.md rule 2: a Worker can run ahead of its
 * migration — a manual redeploy of an older commit, an emergency rollback).
 * Reads there see an EMPTY service: `one` finds nothing and `many` lists
 * nothing, so a GET answers exactly as it does on a migrated database that
 * holds no Print Cloud data (lists are empty, a named record is 404, a guard
 * refuses as it always does) — the pattern every later-migration read follows
 * (tests/costDeployAhead.test.ts). Writes never reach a statement there:
 * `pcGate` refuses them 503 PRINT_CLOUD_NOT_INSTALLED.
 */
const absent = new WeakSet<D1Database>();

const MISSING_PC_SCHEMA = /no such (table|column): (\w+\.)?pc_/i;

function readsEmpty(db: D1Database, e: unknown): boolean {
  return absent.has(db) && MISSING_PC_SCHEMA.test(e instanceof Error ? e.message : String(e));
}

/** A Print Cloud table that does not exist, on a database `printCloudInstalled` found without 0215. */
export function isAbsentSchemaError(db: D1Database, e: unknown): boolean {
  return readsEmpty(db, e);
}

/**
 * Does this database carry migration 0215? Only a positive answer is
 * memoised: a database that gains the migration is noticed on the next
 * request.
 */
export async function printCloudInstalled(db: D1Database): Promise<boolean> {
  if (installed.has(db)) return true;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('pc_settings', 'pc_credit_ledger', 'pc_print_jobs')")
    .first<{ n: number }>()
    .catch(() => null);
  const ok = !!row && Number(row.n) === 3;
  if (ok) {
    installed.set(db, true);
    absent.delete(db);
  } else {
    absent.add(db);
  }
  return ok;
}

// ------------------------------------------------------------------ idempotency

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

export function validIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_RE.test(key);
}

export interface OperationSpec {
  actorId: string;
  scope: string;
  key: string;
  /** What the request asked for; its canonical hash pins the key to it. */
  request: unknown;
  now: Date;
}

export interface Planned<R> {
  statements: Stmt[];
  result: R;
}

export interface Outcome<R> {
  result: R;
  replayed: boolean;
}

export interface IdempotentOptions {
  /**
   * For a batch carrying a guard `classifyDbError` cannot read on its own —
   * the platform wallet's `CHECK (amount > 0)` (walletOps `usdSpendStatement`)
   * is an unnamed CHECK outside Print Cloud's schema, which the default
   * mapping would call VALIDATION. Called with every failed batch that is not
   * a replay of the same key, and `lastAttempt` when no re-plan is left: it
   * throws the refusal the failure means, answers 'retry' to plan again, or
   * undefined to fall through to `classifyDbError` (an outage is rethrown).
   */
  refusal?: (e: unknown, lastAttempt: boolean) => Promise<'retry' | undefined>;
}

/**
 * Run an idempotent operation exactly once.
 *
 *   1. A stored operation under (actor, scope, key) answers at once: its own
 *      result for the same request, IDEMPOTENCY_KEY_REUSED for another.
 *   2. Otherwise `plan()` reads and returns the batch and its result; the
 *      operation row (carrying that result) is the batch's FIRST statement,
 *      so it lands exactly when the business effects land.
 *   3. A collision on the operation row means a concurrent copy won: its
 *      stored result is the answer. STATE_CHANGED re-plans (twice at most),
 *      as does a failure `opts.refusal` answers 'retry' for.
 */
export async function idempotent<R>(db: D1Database, spec: OperationSpec, plan: () => Promise<Planned<R>>, opts: IdempotentOptions = {}): Promise<Outcome<R>> {
  if (!validIdempotencyKey(spec.key)) throw pcError('IDEMPOTENCY_KEY_REQUIRED');
  const requestHash = await sha256Hex(canonicalJson(spec.request));
  const stored = async (): Promise<Outcome<R> | null> => {
    const row = await one<{ request_hash: string; result_json: string }>(
      db,
      'SELECT request_hash, result_json FROM pc_operations WHERE actor_id = ? AND scope = ? AND idempotency_key = ?',
      spec.actorId,
      spec.scope,
      spec.key
    );
    if (!row) return null;
    if (row.request_hash !== requestHash) throw pcError('IDEMPOTENCY_KEY_REUSED');
    return { result: JSON.parse(row.result_json) as R, replayed: true };
  };
  const earlier = await stored();
  if (earlier) return earlier;

  for (let attempt = 0; ; attempt++) {
    const planned = await plan();
    const opRow = db
      .prepare(
        `INSERT INTO pc_operations (id, actor_id, scope, idempotency_key, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(pcId('pcop'), spec.actorId, spec.scope, spec.key, requestHash, JSON.stringify(planned.result), iso(spec.now));
    try {
      await db.batch([opRow, ...planned.statements]);
      return { result: planned.result, replayed: false };
    } catch (e) {
      if (isOperationReplay(e)) {
        const won = await stored();
        if (won) return won;
        throw pcError('STATE_CHANGED');
      }
      if (opts.refusal && (await opts.refusal(e, attempt >= 2)) === 'retry') {
        if (attempt < 2) continue;
        throw pcError('STATE_CHANGED');
      }
      const mapped = classifyDbError(e);
      if (mapped && mapped.code === 'STATE_CHANGED' && attempt < 2) continue;
      if (mapped) throw mapped;
      throw e;
    }
  }
}

/**
 * The same discipline for a write with no client key (an operator's
 * transition, the scheduler): plan, run, re-plan once on STATE_CHANGED.
 */
export async function planned<R>(db: D1Database, plan: () => Promise<Planned<R>>, attempts = 3): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    const p = await plan();
    try {
      await runBatch(db, p.statements);
      return p.result;
    } catch (e) {
      if (e instanceof HttpError && e.code === 'STATE_CHANGED' && attempt < attempts - 1) continue;
      throw e;
    }
  }
}
