import { HttpError } from './http';
import { newId } from './crypto';

type StockRow = { id: string; stock: number | null; reserved?: number | null };
export type StockWriteScope = {
  scope: 'option' | 'color' | 'variant';
  table: 'product_option_values' | 'product_colors' | 'product_variants';
  existing: readonly StockRow[];
  incoming: Array<{ id: string; stock: number | null }>;
};

export const stockWriteChanged = () => new HttpError(
  409,
  'تغيّر المخزون أثناء التحرير. أعد تحميل المنتج وراجع الكمية قبل حفظها. / Stock changed; reload the product before editing its quantity.',
  'STOCK_CHANGED'
);

/** The original quantity is evidence of intent, never a new stock source. */
export function preserveUneditedStock(baseline: unknown, scopes: StockWriteScope[]): void {
  // Legacy/import callers carry explicit quantities and their own revision
  // checks. New editors always send the baseline, including on "keep mine".
  if (baseline === undefined) return;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw stockWriteChanged();
  const original = baseline as Record<string, unknown>;
  for (const group of scopes) {
    const values = original[group.scope];
    if (!Array.isArray(values)) throw stockWriteChanged();
    const before = new Map<string, number | null>();
    for (const value of values) {
      if (!value || typeof value !== 'object') throw stockWriteChanged();
      const { id, stock } = value as Record<string, unknown>;
      if (typeof id !== 'string' || !id || before.has(id) ||
          !(stock === null || (typeof stock === 'number' && Number.isSafeInteger(stock) && stock >= 0))) {
        throw stockWriteChanged();
      }
      before.set(id, stock as number | null);
    }
    const current = new Map(group.existing.map((row) => [row.id, row]));
    for (const row of group.incoming) {
      const live = current.get(row.id);
      if (!live) {
        if (before.has(row.id)) throw stockWriteChanged(); // deleted since opening
        continue;
      }
      if (!before.has(row.id)) throw stockWriteChanged();
      const loaded = before.get(row.id);
      if (row.stock === loaded) row.stock = live.stock;
      else if (live.stock !== loaded) throw stockWriteChanged();
    }
  }
}

/** A checkout between planning and committing must roll the entire save back. */
export function stockWriteFence(
  db: D1Database,
  productId: string,
  scopes: StockWriteScope[],
  guardInstalled: boolean
): D1PreparedStatement[] {
  // Older schema fixtures/import installations predate the transaction guard.
  // The caller probes it alongside its existing reads, without swallowing errors.
  if (!guardInstalled || !scopes.some((s) => s.existing.length)) return [];
  const checks: string[] = [];
  const binds: unknown[] = [];
  for (const { table, existing } of scopes) {
    if (!existing.length) continue;
    checks.push(`NOT EXISTS (
      SELECT 1 FROM json_each(?) expected
      LEFT JOIN ${table} live ON live.id = json_extract(expected.value, '$.id') AND live.product_id = ?
      WHERE live.id IS NULL OR live.stock IS NOT json_extract(expected.value, '$.stock')
         OR COALESCE(live.reserved, 0) <> json_extract(expected.value, '$.reserved'))`);
    binds.push(JSON.stringify(existing.map((r) => ({ id: r.id, stock: r.stock, reserved: r.reserved ?? 0 }))), productId);
  }
  const id = newId('product_stock');
  return [
    // NULL selects a distinct NOT NULL failure, separate from pricing's CHECK
    // fence, so the product form can explain the conflict accurately.
    db.prepare(`INSERT INTO ops_guards(id,ok) SELECT ?, CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE NULL END`)
      .bind(id, ...binds),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(id),
  ];
}

export const isStockWriteConflict = (error: unknown): boolean =>
  /NOT NULL constraint failed:\s*ops_guards\.ok/i.test(error instanceof Error ? error.message : String(error));
