/**
 * Review of de54666a (autoReprice backlog window).
 *
 * The commit says: "a circular window of 50 products is evaluated instead. Its
 * last ID is retained in the run audit, so a large backlog or an unreadable
 * product cannot starve later IDs." The cursor is read from the newest
 * `run_finished` record only, and every run that is NOT windowed (an owner's
 * rate act or the six-hour FX run with the 600 budget, or any tick with enough
 * budget) writes a record WITHOUT `next_product_id`. The next windowed tick
 * therefore starts again at the lowest product ID and re-evaluates the window
 * it already processed, while the products after the cursor wait. Deficit
 * ties are broken by ascending product ID in the global run too, so with a
 * backlog larger than one rotation between such runs the highest IDs are
 * never reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SQLInputValue } from 'node:sqlite';
import { pricingWorld } from './fixtures/procurementPricing';
import { applyRate } from './fixtures/fx';
import { all, row } from './fixtures/app';
import { SqliteD1 } from './fixtures/d1';
import { sweepStaleEnginePrices } from '../worker/lib/fx/reprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

const BASE = 'backlog_0000';
const COUNT = 120;

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
  const tables = ['products', 'pricing_inputs', 'pricing_rules', 'pricing_sku_costs', 'product_pricing_state'] as const;
  const sources = tables.map((table) => ({ table, rows: all<Record<string, SQLInputValue>>(w.raw, `SELECT * FROM ${table} WHERE ${table === 'products' ? 'id' : 'product_id'} = ?`, BASE) }));
  w.raw.exec('BEGIN');
  for (let i = 1; i < COUNT; i++) {
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

const lastSummary = (w: Awaited<ReturnType<typeof backlogWorld>>) =>
  JSON.parse(row<{ summary_json: string }>(w.raw, "SELECT summary_json FROM pricing_audit WHERE entity = 'run' AND entity_key = 'auto_reprice' AND action = 'run_finished' ORDER BY created_at DESC, rowid DESC LIMIT 1")!.summary_json) as { next_product_id?: string };

test('an unwindowed run between two windowed ticks must not send the window back to the first IDs', async () => {
  const w = await backlogWorld();
  const env = () => ({ DB: new SqliteD1(w.raw) }) as unknown as Env;

  // 1. A constrained tick: 120 stale products do not fit, so the 50-product window runs and records its cursor.
  const first = await sweepStaleEnginePrices(env(), { trigger: 'sweep', budget: statementBudget(80) });
  assert.equal(first.skipped, null, JSON.stringify(first));
  const cursor = lastSummary(w).next_product_id;
  assert.equal(cursor, 'backlog_0049', 'precondition: the first window recorded its cursor');
  assert.ok(first.repriced.length > 0 && first.repriced.length < 50, `precondition: part of the window written (${first.repriced.length})`);

  // 2. A run with a larger budget (owner act / six-hour run): the backlog fits, no window, no cursor in its record.
  const middle = await sweepStaleEnginePrices(env(), { trigger: 'sweep', budget: statementBudget(140) });
  assert.equal(middle.skipped, null, JSON.stringify(middle));
  assert.ok(middle.repriced.length > 0, 'precondition: the global run wrote something');

  // 3. The next constrained tick should continue after backlog_0049.
  const next = await sweepStaleEnginePrices(env(), { trigger: 'sweep', budget: statementBudget(80) });
  assert.equal(next.skipped, null, JSON.stringify(next));
  assert.ok(next.repriced.length > 0);
  assert.ok(next.repriced.every((pid) => pid > cursor!), `window restarted at the first IDs: ${next.repriced.join(',')} (cursor was ${cursor})`);
});
