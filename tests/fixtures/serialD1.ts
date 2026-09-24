/**
 * THE D1 ADAPTER, SERIALISED — for tests that race two requests.
 *
 * `SqliteD1.batch` opens a transaction and awaits each statement, so two
 * batches started by `Promise.all` can interleave inside ONE transaction on
 * the shared node:sqlite connection — something real D1 never does: a
 * database is a single writer, and each statement or batch runs to completion
 * before the next begins. This adapter queues every call (run, first, all and
 * batch) behind the previous one, which is exactly that model. The requests
 * themselves still interleave between calls, so the check-then-write races a
 * route is exposed to (two confirmations reading the same state, two
 * acceptances reserving at once) happen here just as they would live.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SqliteD1, type SqliteStatement } from './d1';

type Wrapped = {
  bind: (...v: unknown[]) => Wrapped;
  run: () => ReturnType<SqliteStatement['run']>;
  first: <T>() => Promise<T | null>;
  all: () => ReturnType<SqliteStatement['all']>;
  inner: SqliteStatement;
};

export function serialD1(raw: DatabaseSync): D1Database {
  const inner = new SqliteD1(raw);
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const wrap = (st: SqliteStatement): Wrapped => ({
    bind: (...v: unknown[]) => wrap(st.bind(...v)),
    run: () => queue(() => st.run()),
    first: <T>() => queue(() => st.first<T>()),
    all: () => queue(() => st.all()) as ReturnType<SqliteStatement['all']>,
    inner: st,
  });
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: (stmts: Wrapped[]) => queue(() => inner.batch(stmts.map((s) => s.inner))),
  } as unknown as D1Database;
}
