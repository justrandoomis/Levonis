/** Real migrated database: a large stale catalogue must make bounded progress. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { pricingWorld } from './fixtures/procurementPricing';
import { applyRate } from './fixtures/fx';
import { all, row } from './fixtures/app';
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

const BASE = 'backlog_0000';

async function backlogWorld() {
  const w = pricingWorld();
  w.raw.prepare(`INSERT INTO products (id, slug, name, name_ar, name_ku, price_iqd, status, stock, options, colors, selling_type, sale_types, preorder_transports, images, inventory_mode)
    VALUES (?, ?, 'Backlog', 'منتج', 'بەرهەم', 50000, 'active', 5, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', 'BASE')`).run(BASE, BASE);
  const draft = {
    inputs_seq: 0,
    inputs: [{ scope: 'base', supplier_cost_amount: '20', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '10' }, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 0 }],
  };
  const preview = await w.putInputs(BASE, draft);
  assert.equal(preview.body.code, 'PRICING_PREVIEW_REQUIRED');
  const saved = await w.putInputs(BASE, { ...draft, preview_hash: preview.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(saved.body.mode, 'engine');

  // Clone one valid synthetic adopted product, including its exact cost/rule
  // snapshots, to make a real backlog rather than fake the repricer's reads.
  const tables = ['products', 'pricing_inputs', 'pricing_rules', 'pricing_sku_costs', 'product_pricing_state'] as const;
  const sources = tables.map((table) => ({ table, rows: all<Record<string, SQLInputValue>>(w.raw, `SELECT * FROM ${table} WHERE ${table === 'products' ? 'id' : 'product_id'} = ?`, BASE) }));
  w.raw.exec('BEGIN');
  for (let i = 1; i < 951; i++) {
    const pid = `backlog_${String(i).padStart(4, '0')}`;
    w.raw.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').run(`pricing-mode:${pid}`);
    for (const { table, rows } of sources) for (const source of rows) {
      const next: Record<string, SQLInputValue> = { ...source, ...(table === 'products' ? { id: pid, slug: pid } : { product_id: pid }) };
      if (table === 'pricing_rules') next.id = `${String(source.id)}_${i}`;
      if (table === 'pricing_sku_costs') {
        next.target_rule_id = `${String(source.target_rule_id)}_${i}`;
        if (source.extra_rule_id !== null) next.extra_rule_id = `${String(source.extra_rule_id)}_${i}`;
      }
      const keys = Object.keys(next);
      w.raw.prepare(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(next));
    }
    w.raw.prepare('DELETE FROM ops_guards WHERE id = ?').run(`pricing-mode:${pid}`);
  }
  w.raw.exec('COMMIT');
  applyRate(w.raw, 'USD_IQD', '1700');
  return w;
}

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
        const cost = row<{ usd_iqd_rate: string; computed_price_iqd: number; replacement_cost_iqd: number; target_profit_iqd: number }>(w.raw, 'SELECT * FROM pricing_sku_costs WHERE product_id = ?', pid)!;
        const product = row<{ price_iqd: number }>(w.raw, 'SELECT price_iqd FROM products WHERE id = ?', pid)!;
        assert.equal(cost.usd_iqd_rate, '1700');
        assert.equal(product.price_iqd, cost.computed_price_iqd, 'price and its cost snapshot committed together');
        assert.ok(product.price_iqd - cost.replacement_cost_iqd >= cost.target_profit_iqd);
      }
    }
    const last = row<{ summary_json: string }>(w.raw, "SELECT summary_json FROM pricing_audit WHERE entity = 'run' AND entity_key = 'auto_reprice' ORDER BY created_at DESC, rowid DESC LIMIT 1")!;
    const summary = JSON.parse(last.summary_json) as { next_product_id: string };
    cursors.push(summary.next_product_id);
  }
  assert.deepEqual(cursors, ['backlog_0049', 'backlog_0099', 'backlog_0149']);
  assert.deepEqual(all(w.raw, "SELECT id, price_iqd FROM products WHERE id NOT LIKE 'backlog_%' ORDER BY id"), manualBefore);
});
