/** Product removal records these exact catalogue facts in its own transaction.
 * The ordinary audit cleanup does not prune audit_log. No price, rule or wage
 * is stored here: later wage revisions still select their own effective terms. */
export const DELETED_PRODUCT_FINANCE_SCOPE_ACTION = 'product.unlink_finance_scope';

interface DeletedProductFinanceScope {
  productId: string;
  catalogDepths: Map<string, number>;
}

/** Read only explicit unlink evidence for lines whose live link is gone. Never
 * infer a product from its name or consult a new product that reused its id. */
export async function readDeletedProductFinanceScopes(db: D1Database, lineIds: string[]) {
  const scopes = new Map<string, DeletedProductFinanceScope>();
  if (!lineIds.length) return scopes;
  const rows = (await db.prepare(`SELECT a.target,a.detail FROM audit_log a
    JOIN order_items i ON i.id=a.target AND i.product_id IS NULL
    WHERE a.action=? AND a.actor_id IS NULL AND a.target IN (SELECT value FROM json_each(?))
    ORDER BY a.id DESC`).bind(DELETED_PRODUCT_FINANCE_SCOPE_ACTION, JSON.stringify(lineIds))
    .all<{ target: string; detail: string }>()).results ?? [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.target)) continue;
    seen.add(row.target);
    try {
      const value: unknown = JSON.parse(row.detail);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const fact = value as Record<string, unknown>;
      if (fact.version !== 1 || typeof fact.product_id !== 'string' || !fact.product_id
        || !fact.catalog_depths || typeof fact.catalog_depths !== 'object' || Array.isArray(fact.catalog_depths)) continue;
      const entries = Object.entries(fact.catalog_depths);
      if (entries.some(([id, depth]) => !id || !Number.isSafeInteger(depth) || Number(depth) < 1)) continue;
      scopes.set(row.target, { productId: fact.product_id, catalogDepths: new Map(entries as Array<[string, number]>) });
    } catch { /* Missing or malformed history is never promoted to known scope. */ }
  }
  return scopes;
}
