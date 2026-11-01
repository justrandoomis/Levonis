/**
 * ONE INVOCATION'S D1 STATEMENTS, COUNTED THROUGH THE BINDING IT IS GIVEN.
 *
 * D1 allows 1,000 queries per Worker invocation, a batch counting each of its
 * statements (`D1_INVOCATION_STATEMENT_LIMIT`, worker/lib/quarterHourBudget.ts).
 * A handler that sizes its own work against that limit runs on this counting
 * view: every `first`, `all`, `run` and `raw` of a statement prepared through
 * it counts one, a `batch` counts its length, an `exec` one. The statements it
 * hands out are its own wrappers; `batch` unwraps them before the binding sees
 * them.
 *
 * Unlike worker/lib/d1Count.ts's views (which always view the BASE binding),
 * this one wraps exactly the binding it is given, so counters NEST: a test, or
 * a caller, that counts a whole request still sees every statement a handler
 * sends through its own counted view. It is registered as a view of the
 * binding (d1Count.ts `registerD1View`), so the event bus treats it as the
 * binding it wraps (DECISIONS row 212).
 *
 * Its users: the catalogue import's `/write` budget (worker/lib/catalogImport/
 * budget.ts re-exports it; Bambu import spec §A.5) and the owner's estimator
 * (worker/lib/pricingEngine/estimate/, docs/SMART_PRICING.md §4.8: at most 900
 * statements an invocation). A neutral module, so the estimator never imports
 * the import's code (tests/noImportSync.test.ts).
 */
import { registerD1View } from './d1Count';

/** How many statements an invocation has sent so far. */
export interface InvocationCounter {
  readonly count: number;
  /** Charges statements sent outside the counted binding (none in this codebase; kept for callers). */
  charge(n: number): void;
}

export interface CountedD1 {
  db: D1Database;
  counter: InvocationCounter;
}

type AnyStatement = D1PreparedStatement & Record<string, unknown>;

/**
 * Wraps a D1 binding so every statement it sends is counted. The wrapper is a
 * Proxy: every other member of the binding passes through untouched.
 */
export function countingD1(inner: D1Database): CountedD1 {
  let n = 0;
  const counter: InvocationCounter = {
    get count() {
      return n;
    },
    charge(k: number) {
      n += Math.max(0, Math.trunc(k));
    },
  };
  const innerOf = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt as AnyStatement, {
      get(target, key, receiver) {
        if (key === 'bind') {
          return (...values: unknown[]) => wrap((target.bind as (...v: unknown[]) => D1PreparedStatement)(...values));
        }
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          const fn = Reflect.get(target, key, receiver);
          // A test double may expose `raw` as a property (tests/fixtures/d1Limits.ts); only a call is a statement.
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) => {
            n += 1;
            return (fn as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const v = Reflect.get(target, key, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    innerOf.set(proxy, stmt);
    return proxy as D1PreparedStatement;
  };
  const db = new Proxy(inner as D1Database & Record<string, unknown>, {
    get(target, key, receiver) {
      if (key === 'prepare') {
        return (sql: string) => wrap(target.prepare(sql));
      }
      if (key === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          n += statements.length;
          return target.batch(statements.map((s) => innerOf.get(s as object) ?? s));
        };
      }
      if (key === 'exec') {
        return (sql: string) => {
          n += 1;
          return target.exec(sql);
        };
      }
      const v = Reflect.get(target, key, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  // The bus must still see the binding behind the view (d1Count.ts `d1Base`, DECISIONS row 212): with
  // EVENT_BUS_ENABLED the save's ProductAdded outbox row and the audits' dual write are planned as on the raw binding.
  registerD1View(db as D1Database, inner);
  return { db: db as D1Database, counter };
}
