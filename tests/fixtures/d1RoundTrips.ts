/**
 * HOW MANY TIMES A HANDLER WAITS FOR THE DATABASE — AND NOTHING IT SENDS
 * WOULD FAIL ONLY IN PRODUCTION.
 *
 * On the live Worker every `first()`, `all()`, `run()` and every `batch()` is
 * one round trip from the Worker to the D1 primary; a handler that awaits them
 * one after another pays each one in full (from Iraq, tens to hundreds of
 * milliseconds apiece). This adapter, over `LimitD1` (production's 100 bound
 * parameters and 5 compound terms) plus the two limits it does not model —
 * 100,000 bytes of SQL and 32 arguments to one SQL function call (local
 * SQLite allows 1,000; D1 refuses, in production only) — counts:
 *
 *   - `trips`: every call that crosses to the database (a batch is one);
 *   - `waves`: the calls that START while no other call is in flight — the
 *     sequential depth a handler actually waits through (reads sent together
 *     with `Promise.all` are one wave);
 *   - `log`: each call's kind and the start of its SQL, to name the offenders.
 *
 * Tests only.
 */
import type { DatabaseSync } from 'node:sqlite';
import { LimitD1 } from './d1Limits';

export interface TripCounter {
  trips: number;
  waves: number;
  statements: number;
  log: string[];
  reset(): void;
  /** Any other I/O the handler waits on (an R2 read, an Images decode), counted in the same waves. */
  io<T>(label: string, call: () => Promise<T>): Promise<T>;
  /** Of `trips`, those that were not D1. */
  other: number;
}

/** Parenthesised lists that are not function calls, when written against their `(`. */
const NOT_CALLS = new Set(['IN', 'VALUES', 'EXISTS', 'AS', 'USING', 'ON', 'AND', 'OR', 'NOT', 'WHEN', 'THEN', 'ELSE', 'SELECT', 'FROM', 'WHERE', 'IS', 'BY', 'KEY', 'CHECK', 'CONFLICT']);

/** The most arguments any one SQL function call in `sql` takes (strings, quoted names and comments blanked). */
export function maxFunctionArgs(sql: string): number {
  let s = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      s += c === "'" ? "''" : 'q';
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
    } else {
      s += c;
      i++;
    }
  }
  const stack: Array<{ call: boolean; commas: number; empty: boolean }> = [];
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') {
      const name = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(s.slice(Math.max(0, i - 80), i))?.[1];
      const before = name ? s.slice(0, i - name.length).trimEnd() : '';
      stack.push({ call: !!name && !NOT_CALLS.has(name.toUpperCase()) && !/\b(INTO|TABLE)$/i.test(before), commas: 0, empty: true });
    } else if (c === ')') {
      const f = stack.pop();
      if (f?.call) max = Math.max(max, f.empty ? 0 : f.commas + 1);
    } else if (stack.length) {
      const f = stack[stack.length - 1];
      if (c === ',') f.commas++;
      else if (!/\s/.test(c)) f.empty = false;
    }
  }
  return max;
}

/** Production's two per-statement limits LimitD1 leaves out: refused here as D1 would refuse them. */
function productionOnly(sql: string): void {
  const bytes = Buffer.byteLength(sql, 'utf8');
  if (bytes > 100_000) throw new Error(`D1_LIMIT statement too long (${bytes} bytes) :: ${sql.slice(0, 140)}`);
  const args = maxFunctionArgs(sql);
  if (args > 32) throw new Error(`D1_LIMIT too many arguments on a function (${args}) :: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
}

export function countingD1(raw: DatabaseSync): { db: D1Database; counter: TripCounter } {
  const inner = new LimitD1(raw);
  let inflight = 0;
  const counter: TripCounter = {
    trips: 0,
    waves: 0,
    statements: 0,
    other: 0,
    log: [],
    reset() {
      this.trips = 0;
      this.waves = 0;
      this.statements = 0;
      this.other = 0;
      this.log = [];
    },
    io: <T>(label: string, call: () => Promise<T>) => {
      counter.other += 1;
      return track(label, 0, call);
    },
  };
  const track = async <T>(label: string, n: number, call: () => Promise<T>): Promise<T> => {
    counter.trips += 1;
    counter.statements += n;
    if (inflight === 0) counter.waves += 1;
    counter.log.push(`${counter.waves}\t${label}`);
    inflight += 1;
    try {
      return await call();
    } finally {
      // Settle on a later tick, as a real round trip does: a call started in the same tick shares the wave.
      await Promise.resolve();
      inflight -= 1;
    }
  };
  const short = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 90);
  type Inner = ReturnType<LimitD1['prepare']>;
  const wrap = (stmt: Inner, sql: string): unknown => ({
    bind: (...values: unknown[]) => wrap(stmt.bind(...values) as Inner, sql),
    first: () => track(`first ${short(sql)}`, 1, () => stmt.first()),
    all: () => track(`all ${short(sql)}`, 1, () => stmt.all()),
    run: () => track(`run ${short(sql)}`, 1, () => stmt.run()),
    raw: () => track(`raw ${short(sql)}`, 1, async () => ((await stmt.all()).results ?? []).map((r) => Object.values(r as object))),
    get __inner() {
      return stmt;
    },
  });
  const db = {
    prepare: (sql: string) => {
      productionOnly(sql);
      return wrap(inner.prepare(sql), sql);
    },
    batch: (statements: Array<{ __inner: Inner }>) =>
      track(`batch ×${statements.length}`, statements.length, () => inner.batch(statements.map((s) => s.__inner) as never)),
    exec: (sql: string) => track(`exec ${short(sql)}`, 1, async () => raw.exec(sql)),
  };
  return { db: db as unknown as D1Database, counter };
}
