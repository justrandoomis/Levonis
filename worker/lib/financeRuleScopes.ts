import { badRequest } from './http';

export interface FinanceRuleScope {
  catalog_ids: string[];
  product_ids: string[];
  excluded_product_ids: string[];
}
export interface ScopedCostRule {
  target_type: 'all' | 'catalog' | 'product';
  target_id: string;
  scope_json?: string;
}
const ids = (v: unknown): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 100 || v.some((id) => typeof id !== 'string' || !id || id.length > 100))
    throw badRequest('اختر الأقسام والمنتجات من القائمة');
  return [...new Set(v)].sort();
};
export function normalizeRuleScope(value: unknown): FinanceRuleScope {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw badRequest('نطاق القاعدة غير صحيح');
  const v = value as Record<string, unknown>;
  return { catalog_ids: ids(v.catalog_ids), product_ids: ids(v.product_ids), excluded_product_ids: ids(v.excluded_product_ids) };
}
export function readRuleScope(rule: ScopedCostRule): FinanceRuleScope | null {
  if (!rule.scope_json || rule.scope_json === '{}') return null;
  try { return normalizeRuleScope(JSON.parse(rule.scope_json)); } catch { return null; }
}
/** Exclusions always win; selecting both a parent and child never duplicates pay. */
export function ruleScopeRank(rule: ScopedCostRule, productId: string, ancestors: Map<string, number>): number {
  const scope = readRuleScope(rule);
  if (!scope && rule.scope_json && rule.scope_json !== '{}') return -1;
  if (scope) {
    if (scope.excluded_product_ids.includes(productId)) return -1;
    if (scope.product_ids.includes(productId)) return 10000;
    const ranks = scope.catalog_ids.map((id) => ancestors.get(id) ?? -1);
    if (scope.catalog_ids.length || scope.product_ids.length) return Math.max(-1, ...ranks);
    return 0;
  }
  return rule.target_type === 'product' ? (rule.target_id === productId ? 10000 : -1)
    : rule.target_type === 'catalog' ? (ancestors.get(rule.target_id) ?? -1) : 0;
}
export async function validateRuleScope(db: D1Database, value: unknown) {
  const scope = normalizeRuleScope(value);
  const products = [...new Set([...scope.product_ids, ...scope.excluded_product_ids])];
  for (const [table, selected] of [['catalogs', scope.catalog_ids], ['products', products]] as const) {
    if (!selected.length) continue;
    const result = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(selected)).first<{ n: number }>();
    if (result?.n !== selected.length) throw badRequest('أحد المنتجات أو الأقسام المحددة لم يعد موجودًا');
  }
  return scope;
}
