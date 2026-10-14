/**
 * A D1 THAT LETS ANOTHER REQUEST FINISH AT THE EXACT MOMENT ONE IS ABOUT TO
 * WRITE — the concurrent request a route's read-then-write is exposed to.
 *
 * Lifted from tests/sv2_p0_tradein_credit_integrity.test.ts (S-P0, F1–F3) so
 * the S-P1 tests (row 237) race the same way. `when` picks the batch (by its
 * statements' SQL), `hook` is the other request; it runs once, before that
 * batch, and the batch then runs against whatever the hook left behind.
 *
 * `whenRun` does the same for a single statement's `.run()` — a route that
 * writes with one INSERT rather than a batch (the protection claim door).
 */
import { LimitD1 } from './d1Limits';

const sqlOf = (s: unknown) => String((s as { sql?: string }).sql ?? '');

export class RaceD1 extends LimitD1 {
  hook: (() => Promise<void>) | null = null;
  when: (sqls: string[]) => boolean = () => false;
  /** Before the first `.run()` whose SQL matches, let `runHook` finish. */
  runHook: (() => Promise<void>) | null = null;
  whenRun: (sql: string) => boolean = () => false;

  override prepare(sql: string) {
    const stmt = super.prepare(sql);
    return this.watch(stmt, sql);
  }

  private watch<S extends { bind: (...v: unknown[]) => S; run: () => unknown }>(stmt: S, sql: string): S {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const race = this;
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') return (...v: unknown[]) => race.watch(target.bind(...v), sql);
        if (prop === 'run') {
          return async () => {
            if (race.runHook && race.whenRun(sql)) {
              const h = race.runHook;
              race.runHook = null;
              await h();
            }
            return target.run();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  override async batch(statements: never[]) {
    const sqls = statements.map(sqlOf);
    if (this.hook && this.when(sqls)) {
      const h = this.hook;
      this.hook = null;
      await h();
    }
    return super.batch(statements);
  }
}

/** The order batch: it redeems a coupon. */
export const redeems = (sqls: string[]) => sqls.some((s) => s.includes('INSERT INTO coupon_redemptions'));
