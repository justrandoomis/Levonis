/**
 * Sagas (`01-TARGET.md` §2.3 item 4, §6.6, ADR-007): idempotent remote
 * commands first, the local batch second (carrying the outbox row), the
 * remote commit third; the orchestrator's `<svc>_sagas` row records step
 * state and a sweep completes or compensates anything older than 2 minutes.
 * FENCED ON BOTH SIDES: the local batch begins with
 * `UPDATE … SET state='local_committed' WHERE id=? AND state='started'` (0 rows
 * -> abort), and the sweep first flips `started -> compensating` and
 * compensates only when it changed a row. `stuck` is excluded from the
 * one-in-flight-per-user index so a stuck saga never blocks the customer.
 */
export const SAGA_STATES = ['started', 'local_committed', 'done', 'compensating', 'compensated', 'stuck'] as const;
export type SagaState = (typeof SAGA_STATES)[number];

/** Every legal transition; anything else is a bug the store refuses. */
export const SAGA_TRANSITIONS: Readonly<Record<SagaState, readonly SagaState[]>> = {
  started: ['local_committed', 'compensating'],
  local_committed: ['done', 'stuck'],
  compensating: ['compensated', 'stuck'],
  done: [],
  compensated: [],
  stuck: ['local_committed', 'compensating'], // admin unblock only
};

export const SAGA_IN_FLIGHT: readonly SagaState[] = ['started', 'local_committed', 'compensating'];
export const SAGA_STALE_AFTER_S = 120;
export const SAGA_STUCK_AFTER_FAILURES = 10;

export const sagasTable = (prefix: string) => `${prefix}_sagas`;

export function sagaSchemaSql(prefix: string): string {
  const t = sagasTable(prefix);
  return `CREATE TABLE IF NOT EXISTS ${t} (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  user_id     TEXT,
  aggregate_id TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('started','local_committed','done','compensating','compensated','stuck')),
  step        TEXT NOT NULL DEFAULT '',
  failures    INTEGER NOT NULL DEFAULT 0,
  input       TEXT NOT NULL,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_sagas_one_in_flight ON ${t}(kind, user_id) WHERE user_id IS NOT NULL AND state IN ('started','local_committed','compensating');
CREATE INDEX IF NOT EXISTS idx_${prefix}_sagas_sweep ON ${t}(state, updated_at);`;
}

export function canTransition(from: SagaState, to: SagaState): boolean {
  return SAGA_TRANSITIONS[from].includes(to);
}

export interface SagaRow {
  id: string;
  kind: string;
  user_id: string | null;
  aggregate_id: string;
  state: SagaState;
  step: string;
  failures: number;
  input: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export class SagaStore {
  private readonly table: string;
  constructor(private readonly db: D1Database, prefix: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.table = sagasTable(prefix);
  }

  /** Step 2 of every saga: the row is created `started`. The partial UNIQUE index refuses a second in-flight saga per user. */
  beginStatement(saga: { id: string; kind: string; userId: string | null; aggregateId: string; input: unknown }): D1PreparedStatement {
    const at = this.now();
    return this.db
      .prepare(`INSERT INTO ${this.table} (id, kind, user_id, aggregate_id, state, input, created_at, updated_at) VALUES (?, ?, ?, ?, 'started', ?, ?, ?)`)
      .bind(saga.id, saga.kind, saga.userId, saga.aggregateId, JSON.stringify(saga.input), at, at);
  }

  async begin(saga: { id: string; kind: string; userId: string | null; aggregateId: string; input: unknown }): Promise<void> {
    await this.beginStatement(saga).run();
  }

  /**
   * THE FENCE: a conditional flip. As the first statement of the local batch it
   * makes the whole batch abort when the sweep got there first (0 rows
   * changed -> the following CHECK-guarded statement aborts the batch).
   */
  fenceStatement(id: string, from: SagaState, to: SagaState, step = ''): D1PreparedStatement {
    if (!canTransition(from, to)) throw new Error(`saga: illegal transition ${from} -> ${to}`);
    return this.db
      .prepare(`UPDATE ${this.table} SET state = ?, step = ?, updated_at = ? WHERE id = ? AND state = ?`)
      .bind(to, step, this.now(), id, from);
  }

  /**
   * A statement that fails the whole batch unless the saga row is in
   * `expected` — B1's CHECK-abort trick in its cleanest form: `step` is NOT
   * NULL, so the CASE yields NULL (a constraint violation, the batch rolls
   * back) exactly when the fence above changed 0 rows. Leaves no trace when
   * the state is right.
   */
  fenceGuardStatement(id: string, expected: SagaState): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE ${this.table} SET step = CASE WHEN state = ? THEN step ELSE NULL END WHERE id = ?`)
      .bind(expected, id);
  }

  async transition(id: string, from: SagaState, to: SagaState, step = ''): Promise<boolean> {
    const r = await this.fenceStatement(id, from, to, step).run();
    return (r.meta.changes ?? 0) === 1;
  }

  async recordFailure(id: string, error: string): Promise<{ failures: number; stuck: boolean }> {
    await this.db
      .prepare(
        `UPDATE ${this.table} SET failures = failures + 1, last_error = ?, updated_at = ?,
            state = CASE WHEN failures + 1 >= ${SAGA_STUCK_AFTER_FAILURES} AND state IN ('local_committed','compensating') THEN 'stuck' ELSE state END
          WHERE id = ?`
      )
      .bind(error.slice(0, 500), this.now(), id)
      .run();
    const row = await this.get(id);
    return { failures: row?.failures ?? 0, stuck: row?.state === 'stuck' };
  }

  async get(id: string): Promise<SagaRow | null> {
    return this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).bind(id).first<SagaRow>();
  }

  /** In-flight sagas older than the stale window — what the sweep looks at. */
  async stale(kind: string, olderThanIso: string, limit = 100): Promise<SagaRow[]> {
    const r = await this.db
      .prepare(`SELECT * FROM ${this.table} WHERE kind = ? AND state IN ('started','local_committed','compensating') AND updated_at < ? ORDER BY updated_at LIMIT ?`)
      .bind(kind, olderThanIso, limit)
      .all<SagaRow>();
    return r.results ?? [];
  }
}

/**
 * The sweep decision for one stale saga (`01-TARGET.md` §6.6):
 * `started` -> flip to `compensating` (only when the flip changed a row, compensate);
 * `local_committed` -> retry the commit step; `compensating` -> retry compensation.
 */
export function sweepAction(state: SagaState): 'compensate' | 'retry_commit' | 'retry_compensation' | 'none' {
  switch (state) {
    case 'started':
      return 'compensate';
    case 'local_committed':
      return 'retry_commit';
    case 'compensating':
      return 'retry_compensation';
    default:
      return 'none';
  }
}
