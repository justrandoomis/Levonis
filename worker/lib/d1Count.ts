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

/** The binding a counting view views; any other database as it is. */
export function d1Base<T extends D1Database | null | undefined>(db: T): T {
  if (!db) return db;
  return (BASES.get(db as unknown as object) as T | undefined) ?? db;
}
