/**
 * THE QUARTER-HOUR INVOCATION'S D1 STATEMENTS, COUNTED (FX programme plan
 * §7.4, critique H2).
 *
 * D1 allows 1,000 queries per Worker invocation. The `*\/15` tick runs four
 * jobs in ONE invocation — the staff reconciliation, the durable jobs, the
 * upload-session sweep and FX-5's engine repricing sweep — so they share those
 * 1,000. The first three keep their own bounds and run exactly as before; the
 * sweep runs AFTER them and spends only what they left (worker/index.ts), so
 * it can never be the statement that crosses the limit.
 *
 * To know what they left, the three jobs run on a COUNTING VIEW of the
 * binding: the same database, every statement it executes counted (a batch
 * counts each of its statements, as D1 does). The view is ONE object per
 * binding per isolate — the memos keyed by the binding (installed-table
 * probes, the pricing inputs) behave across ticks as they do today — and the
 * event bus treats it as the binding it views (`d1Base`), so an emitter that
 * asks `busFor(db)` answers exactly as before. A tick reads the counter's
 * DELTA; two overlapping ticks in one isolate would each see the other's
 * statements too, which only makes the sweep yield more.
 *
 * Nothing else changes: every call reaches the real binding with the real
 * statements (a batch is handed the binding's own statement objects).
 */

export interface CountingD1 {
  /** The counting view: hand it to the jobs as their `DB`. */
  readonly db: D1Database;
  /** Statements executed through the view so far (monotonic; read a delta per invocation). */
  readonly executed: number;
}

interface Counter {
  view: D1Database;
  n: number;
}

const VIEWS = new WeakMap<object, Counter>();
/** The counting view → the binding it views. */
const BASES = new WeakMap<object, D1Database>();
/** A statement of the view → the binding's own statement (what `batch` must be handed). */
const STATEMENTS = new WeakMap<object, D1PreparedStatement>();

const EXECUTES = new Set<PropertyKey>(['run', 'all', 'first', 'raw']);

function statementView(counter: Counter, inner: D1PreparedStatement): D1PreparedStatement {
  const view = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'bind') return (...values: unknown[]) => statementView(counter, target.bind(...values));
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (EXECUTES.has(prop)) {
        return (...args: unknown[]) => {
          counter.n += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  STATEMENTS.set(view, inner);
  return view;
}

const unwrap = (s: D1PreparedStatement): D1PreparedStatement => STATEMENTS.get(s as unknown as object) ?? s;

/** The binding's counting view (one per binding per isolate) and its counter. */
export function countingD1(db: D1Database): CountingD1 {
  const base = d1Base(db);
  let counter = VIEWS.get(base as unknown as object);
  if (!counter) {
    const c: Counter = { view: null as unknown as D1Database, n: 0 };
    c.view = new Proxy(base, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => statementView(c, target.prepare(sql));
        if (prop === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            c.n += statements.length;
            return target.batch(statements.map(unwrap));
          };
        }
        if (prop === 'exec') {
          return (sql: string) => {
            c.n += Math.max(1, sql.split(';').filter((part) => part.trim() !== '').length);
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    BASES.set(c.view as unknown as object, base);
    VIEWS.set(base as unknown as object, c);
    counter = c;
  }
  const c = counter;
  return {
    db: c.view,
    get executed() {
      return c.n;
    },
  };
}

/** A query refused by a scoped view's limit, before it reached the binding. */
export class D1BudgetExceeded extends Error {
  constructor(readonly limit: number) {
    super(`D1 budget of ${limit} queries for this request reached`);
    this.name = 'D1BudgetExceeded';
  }
}

export interface ScopedCountingD1 extends CountingD1 {
  /** Queries the limit refused (never sent). Above zero, anything read since may be incomplete. */
  readonly refused: number;
}

/**
 * ONE REQUEST'S QUERIES, AND ONLY ITS OWN (docs/DECISIONS.md row 212).
 *
 * `countingD1` is one view per binding per isolate, so its counter also sees
 * every concurrent request the isolate serves (and the quarter-hour tick):
 * right for the tick, which only yields more, wrong for a handler that sizes
 * its own batch from what IT has spent. This is a fresh view per call: the
 * same binding (`d1Base` answers it, so the event bus treats it as the
 * binding), its own counter. Memos keyed by the database object see a new
 * one, so the handler pays its probes as a cold isolate does — what the
 * budget tests measure.
 *
 * With `limit`, a query that would go past it is refused before it is sent
 * (`D1BudgetExceeded`) and counted in `refused`: a read-only handler stops
 * there and drops what it was reading (a refusal something swallowed still
 * shows in `refused`).
 */
export function scopedCountingD1(db: D1Database, opts: { limit?: number } = {}): ScopedCountingD1 {
  const base = d1Base(db);
  const c: Counter = { view: null as unknown as D1Database, n: 0 };
  let refused = 0;
  /** Counts `k` queries, or refuses them past the limit (a rejected promise, as D1 would answer). */
  const admit = (k: number): D1BudgetExceeded | null => {
    if (opts.limit !== undefined && c.n + k > opts.limit) {
      refused += k;
      return new D1BudgetExceeded(opts.limit);
    }
    c.n += k;
    return null;
  };
  const statementOf = (inner: D1PreparedStatement): D1PreparedStatement => {
    const view = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => statementOf(target.bind(...values));
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        if (EXECUTES.has(prop)) {
          return (...args: unknown[]) => {
            const refusal = admit(1);
            if (refusal) return Promise.reject(refusal);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    STATEMENTS.set(view, inner);
    return view;
  };
  c.view = new Proxy(base, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => statementOf(target.prepare(sql));
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          const refusal = admit(statements.length);
          if (refusal) return Promise.reject(refusal);
          return target.batch(statements.map(unwrap));
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          const refusal = admit(Math.max(1, sql.split(';').filter((part) => part.trim() !== '').length));
          if (refusal) return Promise.reject(refusal);
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  BASES.set(c.view as unknown as object, base);
  return {
    db: c.view,
    get executed() {
      return c.n;
    },
    get refused() {
      return refused;
    },
  };
}

/** The binding a counting view views; any other database as it is. */
export function d1Base<T extends D1Database | null | undefined>(db: T): T {
  if (!db) return db;
  return (BASES.get(db as unknown as object) as T | undefined) ?? db;
}
