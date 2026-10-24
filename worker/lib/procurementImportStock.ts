/** Saving a price from an inventory purchase explicitly chooses tracked
 * inventory for an undecided import. Prepare that choice in the SAME batch
 * as the price: previews never write stock, and a refused price rolls it back.
 * A purchase is not a receipt. Only unknown counters become zero; existing
 * quantities, reservations, lots and incoming purchases are never rewritten. */
import { serverMessage } from '@levonis/contracts/costRefusals';
import { auditStatements } from './audit';
import { badRequest } from './http';
import { importStockNotConfigured, TRACKED_STOCK_SQL, trackedStockBinds } from './importStock';
import { requireSelection } from './inventorySelection';
import { fence } from './operations';

const invalidStock = () => badRequest(
  serverMessage('PRICING_INPUT_INVALID').replaceAll('{field}', 'procurement_stock'),
  'PRICING_INPUT_INVALID', { field: 'procurement_stock' },
);

export async function planProcurementImportStock(
  db: D1Database,
  productId: string,
  selection: { scope: unknown; scope_id: unknown },
  actorId: string,
  now: string,
): Promise<D1PreparedStatement[]> {
  const { scope, scope_id: scopeId } = selection;
  if (typeof scope !== 'string' || !['base', 'option', 'color', 'variant'].includes(scope)
    || typeof scopeId !== 'string' || (scope === 'base' ? scopeId !== '' : !scopeId)) throw invalidStock();
  if (!(await importStockNotConfigured(db, productId))) return [];
  await requireSelection(db, productId, scope, scopeId);
  const modes: Record<string, string> = { base: 'BASE', option: 'OPTION', color: 'COLOR', variant: 'VARIANT_COMBINATION' };
  const mode = modes[scope]!;
  const guards = fence(db, `EXISTS (SELECT 1 FROM products WHERE id = ? AND inventory_mode = ?)
    AND EXISTS (SELECT 1 FROM product_source_refs WHERE product_id = ? AND match_kind = 'created' AND stock_decision = 'not_configured')`, [productId, mode, productId]);
  let initialize: D1PreparedStatement;
  if (scope === 'base') {
    initialize = db.prepare('UPDATE products SET stock = 0 WHERE id = ? AND stock IS NULL').bind(productId);
  } else if (scope === 'option') {
    // OPTION can have several groups. Track the purchase's entire group, not
    // every group: an unrelated zero-valued group would block every selection.
    const group = await db.prepare(`SELECT v.group_id FROM product_option_values v JOIN product_option_groups g ON g.id = v.group_id
      WHERE v.id = ? AND v.product_id = ? AND v.active = 1 AND g.product_id = ? AND g.active = 1`)
      .bind(scopeId, productId, productId).first<{ group_id: string }>();
    if (!group) throw invalidStock();
    guards.push(...fence(db, `EXISTS (SELECT 1 FROM product_option_values v JOIN product_option_groups g ON g.id = v.group_id
      WHERE v.id = ? AND v.product_id = ? AND v.group_id = ? AND v.active = 1 AND g.product_id = ? AND g.active = 1)`, [scopeId, productId, group.group_id, productId]));
    initialize = db.prepare('UPDATE product_option_values SET stock = 0 WHERE product_id = ? AND group_id = ? AND active = 1 AND stock IS NULL')
      .bind(productId, group.group_id);
  } else {
    const table = scope === 'color' ? 'product_colors' : 'product_variants';
    guards.push(...fence(db, `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND product_id = ? AND active = 1)`, [scopeId, productId]));
    initialize = db.prepare(`UPDATE ${table} SET stock = 0 WHERE product_id = ? AND active = 1 AND stock IS NULL`).bind(productId);
  }
  const audit = await auditStatements(db, actorId, 'product.import_stock_decision', productId, {
    product_id: productId, before: 'not_configured', after: 'tracked', source: 'procurement', scope, scope_id: scopeId,
  });
  return [
    ...guards,
    initialize,
    ...fence(db, TRACKED_STOCK_SQL, trackedStockBinds(productId)),
    db.prepare(`UPDATE product_source_refs SET stock_decision = 'tracked', stock_decided_by = ?, stock_decided_at = ?, updated_at = ?
      WHERE product_id = ? AND match_kind = 'created' AND stock_decision = 'not_configured'`).bind(actorId, now, now, productId),
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').bind(now, productId),
    ...audit.statements,
  ];
}
