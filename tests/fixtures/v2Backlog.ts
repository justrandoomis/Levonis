/**
 * A STALE V2 BACKLOG (the clean start, spec addendum A.6: the automatic run
 * selects V2 products only).
 *
 * One option-less product is written through the V2 writer (price-first, one
 * product-level dollar price) and cloned `count − 1` times — its state, price
 * point, SKU row and result — so the repricer reads a real backlog rather than
 * a faked one. The clone is a fixture write: the V2 guards are lifted for that
 * SQL only. Then U moves to `rate`, so every product is stale.
 */
import { all, withoutTriggers } from './app';
import { applyRate } from './fx';
import { pricingWorld } from './procurementPricing';
import { writeV2 } from './pricingV2';

export const BACKLOG_BASE = 'backlog_0000';

export async function v2BacklogWorld(count: number, o: { usd?: string; rate?: string } = {}) {
  const w = pricingWorld();
  w.raw.prepare(`INSERT INTO products (id, slug, name, name_ar, name_ku, price_iqd, status, stock, options, colors, selling_type, sale_types, preorder_transports, images, inventory_mode)
    VALUES (?, ?, 'Backlog', 'منتج', 'بەرهەم', 50000, 'active', 5, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', 'BASE')`).run(BACKLOG_BASE, BACKLOG_BASE);
  await writeV2(w.db, BACKLOG_BASE, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: o.usd ?? '40' }] });
  const tables = ['products', 'product_pricing_state', 'pricing_price_points', 'product_sku_prices', 'pricing_v2_sku_results'] as const;
  const guards = all<{ name: string }>(w.raw, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${tables.map(() => '?').join(',')})`, ...tables).map((t) => t.name);
  const columns = new Map(tables.map((t) => [t, all<{ name: string }>(w.raw, `PRAGMA table_info("${t}")`).map((c) => c.name)]));
  const sql: string[] = [];
  for (let i = 1; i < count; i++) {
    const pid = `backlog_${String(i).padStart(4, '0')}`;
    for (const table of tables) {
      const cols = columns.get(table)!;
      const key = table === 'products' ? 'id' : 'product_id';
      const values = cols.map((c) => (c === key || (table === 'products' && c === 'slug') ? `'${pid}'` : `"${c}"`));
      sql.push(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) SELECT ${values.join(',')} FROM ${table} WHERE ${key} = '${BACKLOG_BASE}';`);
    }
  }
  withoutTriggers(w.raw, guards, `BEGIN;\n${sql.join('\n')}\nCOMMIT;`);
  applyRate(w.raw, 'USD_IQD', o.rate ?? '1700');
  return w;
}
