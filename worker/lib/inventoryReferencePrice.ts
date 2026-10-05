import { auditStatements } from './audit';
import { badRequest, conflict, notFound } from './http';
import { requireSelection } from './inventorySelection';
import { fence, whole } from './operations';

/** Deliberate catalogue action, separate from recording a purchase. Only the
 * selected price and its mirrors change; order snapshots remain immutable. */
export async function updateSelectionPrice(db: D1Database, productId: string, input: Record<string, unknown>, actor: string) {
  const selection = await requireSelection(db, productId, String(input.scope), String(input.scope_id ?? ''));
  const expected = whole(input.expected_price_iqd, 'السعر المعروض'), price = whole(input.price_iqd, 'سعر البيع', 0, 1e9);
  if (selection.selling_price_iqd !== expected) throw conflict('تغير سعر المتجر؛ راجع السعر الحالي قبل تطبيقه');
  const p = await db.prepare('SELECT * FROM products WHERE id=?').bind(productId).first<Record<string, unknown>>();
  if (!p) throw notFound('المنتج غير موجود');
  if (price === expected) return { already: true, price_iqd: price, slug: String(p.slug) };
  const surcharge = Number(p.direct_surcharge_iqd ?? 0), storedPrice = price - surcharge;
  if (storedPrice < 0) throw badRequest('سعر البيع أقل من إضافة البيع المباشر المضبوطة للمنتج');
  const statements = [...fence(db, 'EXISTS(SELECT 1 FROM products WHERE id=? AND updated_at IS ? AND price_iqd=?)', [productId, p.updated_at ?? null, p.price_iqd])];
  const now = new Date().toISOString();
  if (selection.scope === 'base') statements.push(db.prepare('UPDATE products SET price_iqd=?,updated_at=? WHERE id=?').bind(storedPrice, now, productId));
  else {
    if(!['option','color','variant'].includes(selection.scope))throw badRequest('اختر مخزون البيع المباشر');
    const table = { option: 'product_option_values', color: 'product_colors', variant: 'product_variants' }[selection.scope as 'option'|'color'|'variant'];
    const row = await db.prepare(`SELECT regular_price_iqd FROM ${table} WHERE id=? AND product_id=?`).bind(selection.scope_id, productId).first<{ regular_price_iqd: number | null }>();
    if (!row) throw notFound('الخيار غير موجود');
    statements.push(...fence(db, `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND product_id=? AND regular_price_iqd IS ?)`, [selection.scope_id, productId, row.regular_price_iqd]), db.prepare(`UPDATE ${table} SET regular_price_iqd=? WHERE id=? AND product_id=?`).bind(storedPrice, selection.scope_id, productId));
    if (selection.scope === 'option') statements.push(db.prepare("UPDATE product_option_fulfillment SET regular_price_iqd=? WHERE product_id=? AND option_id=? AND fulfillment_type='direct_sale' AND enabled=1").bind(storedPrice, productId, selection.scope_id));
    if (selection.scope === 'option' || selection.scope === 'color') {
      const field = selection.scope === 'option' ? 'options' : 'colors';
      let rows: Record<string, unknown>[] = [];
      try { const value: unknown = JSON.parse(String(p[field] ?? '[]')); if (Array.isArray(value)) rows = value; } catch { /* relational rows remain authoritative */ }
      const updated = rows.map((r) => r.id === selection.scope_id ? { ...r, regular_price_iqd: storedPrice } : r);
      statements.push(db.prepare(`UPDATE products SET ${field}=?,updated_at=? WHERE id=?`).bind(JSON.stringify(updated), now, productId));
    } else statements.push(db.prepare('UPDATE products SET updated_at=? WHERE id=?').bind(now, productId));
  }
  statements.push(db.prepare("INSERT INTO price_history(product_id,variant_key,field,old_iqd,new_iqd,changed_by) VALUES (?,?,'regular',?,?,?)").bind(productId, selection.scope === 'base' ? '' : `${selection.scope}:${selection.scope_id}`, expected - surcharge, storedPrice, actor), ...(await auditStatements(db, actor, 'product.selection_price_from_purchase', productId, { scope: selection.scope, scope_id: selection.scope_id, before_iqd: expected, after_iqd: price })).statements);
  try { await db.batch(statements); } catch (e) { if (/CHECK constraint/.test(String(e))) throw conflict('تغير المنتج أثناء تحديث السعر'); throw e; }
  return { already: false, price_iqd: price, slug: String(p.slug) };
}
