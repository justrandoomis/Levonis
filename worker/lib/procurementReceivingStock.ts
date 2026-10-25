import { auditStatements } from './audit';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { conflict } from './http';
import { counterTarget } from './inventoryReceiving';
import type { Selection } from './inventorySelection';
import { fence } from './operations';

/** Receiving a physical purchase starts tracking its selected counter. This
 * plan belongs to the receipt transaction: a failed receipt must not leave an
 * empty counter behind. Existing quantities and unrelated selections stay put.
 * A missing counter with older stock/reservations needs a count, not a guessed
 * opening balance. NULL is never silently added to (SQLite keeps it NULL). */
export async function planProcurementReceivingStock(db: D1Database, selection: Selection, actorId: string) {
  if (selection.stock !== null) return [];
  const { product_id: productId, scope, scope_id: scopeId } = selection;
  const target = counterTarget(scope)!;
  const id = scope === 'base' ? productId : scopeId;
  const reserved = scope === 'base' ? 'stock_reserved' : 'reserved';
  const mode = { base: 'BASE', option: 'OPTION', color: 'COLOR', variant: 'VARIANT_COMBINATION' }[scope as 'base' | 'option' | 'color' | 'variant'];
  const condition = `EXISTS(SELECT 1 FROM products WHERE id=? AND inventory_mode=?)
    AND EXISTS(SELECT 1 FROM ${target.table} WHERE id=? AND stock IS NULL AND ${reserved}=0${scope === 'base' ? '' : ' AND product_id=? AND active=1'})
    AND NOT EXISTS(SELECT 1 FROM inventory_lots WHERE product_id=? AND scope=? AND scope_id=? AND qty_remaining>0)`;
  const args = [productId, mode, id, ...(scope === 'base' ? [] : [productId]), productId, scope, scopeId];
  if (!(await db.prepare(`SELECT (${condition}) AS ok`).bind(...args).first<{ok:number}>())?.ok)
    throw conflict(serverMessage('STOCK_RECOUNT_REQUIRED'), 'STOCK_RECOUNT_REQUIRED');
  return [
    ...fence(db, condition, args),
    db.prepare(`UPDATE ${target.table} SET stock=0 WHERE id=? AND stock IS NULL`).bind(id),
    ...(await auditStatements(db, actorId, 'purchase.stock_tracking_initialized', productId, { scope, scope_id: scopeId, before: null, after: 0 })).statements,
  ];
}
