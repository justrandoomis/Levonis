/**
 * Real migrated database: a large stale catalogue must make bounded progress.
 * Since the clean start (spec addendum A.6) the run selects V2 products only:
 * one is written through the V2 writer (price-first, $40) and cloned 950 times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, row } from './fixtures/app';
import { BACKLOG_BASE, v2BacklogWorld } from './fixtures/v2Backlog';
import { SqliteD1, SqliteStatement } from './fixtures/d1';
import { sweepStaleEnginePrices } from '../worker/lib/fx/reprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

class CountStatement {
  constructor(readonly inner: SqliteStatement, private readonly counter: { n: number }) {}
  bind(...values: unknown[]) { return new CountStatement(this.inner.bind(...values), this.counter); }
  run() { this.counter.n++; return this.inner.run(); }
  first<T>() { this.counter.n++; return this.inner.first<T>(); }
  all<T>() { this.counter.n++; return this.inner.all<T>(); }
}
class CountD1 {
  readonly counter = { n: 0 };
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync, private readonly refuseWrites = false) { this.inner = new SqliteD1(raw); }
  prepare(sql: string) { return new CountStatement(this.inner.prepare(sql), this.counter); }
  async batch(statements: CountStatement[]) {
    this.counter.n += statements.length;
    if (this.refuseWrites && statements.some((s) => !s.inner.yieldsRows)) throw new Error('CHECK constraint failed: ok = 1');
    return this.inner.batch(statements.map((s) => s.inner));
  }
}

const BASE = BACKLOG_BASE;
const backlogWorld = () => v2BacklogWorld(951);

test('951 stale products: a bounded sweep advances its cursor even after conflicts, later ticks write whole products and stay within 200 statements', async () => {
  const w = await backlogWorld();
  const manualBefore = all(w.raw, "SELECT id, price_iqd FROM products WHERE id NOT LIKE 'backlog_%' ORDER BY id");
  const oldPrice = row<{ price_iqd: number }>(w.raw, 'SELECT price_iqd FROM products WHERE id = ?', BASE)!.price_iqd;
  const cursors: string[] = [];
  for (let tick = 0; tick < 3; tick++) {
    const db = new CountD1(w.raw, tick === 0);
    const budget = statementBudget(200);
    const r = await sweepStaleEnginePrices({ DB: db } as unknown as Env, { trigger: 'sweep', budget });
    assert.equal(r.skipped, null, JSON.stringify(r));
    assert.ok(db.counter.n <= budget.used && budget.used <= 200, `${db.counter.n} executed, ${budget.used} charged`);
    assert.ok(r.deferred.length > 850);
    if (tick === 0) {
      assert.ok(r.conflicts.length > 0);
      assert.equal(r.repriced.length, 0);
      assert.equal(row<{ price_iqd: number }>(w.raw, 'SELECT price_iqd FROM products WHERE id = ?', BASE)!.price_iqd, oldPrice);
    } else {
      assert.ok(r.repriced.length > 0, 'each later tick makes forward progress');
      assert.ok(r.repriced.every((pid) => pid > cursors[tick - 1]!), 'the cursor does not revisit the conflicting first window');
      for (const pid of r.repriced) {
        const result = row<{ usd_iqd_rate: string; final_price_iqd: number }>(w.raw, 'SELECT usd_iqd_rate, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = ?', pid)!;
        const product = row<{ price_iqd: number }>(w.raw, 'SELECT price_iqd FROM products WHERE id = ?', pid)!;
        assert.equal(result.usd_iqd_rate, '1700');
        assert.equal(result.final_price_iqd, 68_000, '$40 at 1,700');
        assert.equal(product.price_iqd, result.final_price_iqd, 'the price and its V2 result committed together');
      }
    }
    const last = row<{ summary_json: string }>(w.raw, "SELECT summary_json FROM pricing_audit WHERE entity = 'run' AND entity_key = 'auto_reprice' ORDER BY created_at DESC, rowid DESC LIMIT 1")!;
    const summary = JSON.parse(last.summary_json) as { next_product_id: string };
    cursors.push(summary.next_product_id);
  }
  assert.deepEqual(cursors, ['backlog_0049', 'backlog_0099', 'backlog_0149']);
  assert.deepEqual(all(w.raw, "SELECT id, price_iqd FROM products WHERE id NOT LIKE 'backlog_%' ORDER BY id"), manualBefore);
});
