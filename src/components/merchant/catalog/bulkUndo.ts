/**
 * «تراجع» AFTER A BULK ACTION — only where putting things back is EXACT.
 *
 * The inverse is computed from what the list showed before the action, for
 * the products the server reports as changed, and is offered only when one
 * or a few more bulk calls restore exactly what was there
 * (worker/routes/merchantCatalog.ts `POST /products/bulk`):
 *
 *   · feature / unfeature — one flag, nothing else moves. Only the products
 *     whose flag actually changed are flipped back: one that was already
 *     featured stays featured.
 *   · set_price — one column. The products are put back to their own earlier
 *     prices, one call per distinct price (at most UNDO_MAX_CALLS, the route
 *     is rate-limited), and never to 0 on a published product (the route
 *     refuses it, so the undo could not be whole).
 *
 * NOT offered, because the way back is not the same place:
 *   · hide / archive / draft — taking a product off the shelf revokes its
 *     live viewer links (`revokeProductViewerGrantsStatement`); publishing it
 *     again does not bring them back. publish — its reverse runs that revoke.
 *   · set_stock — it also clears the low-stock alert mark and may send the
 *     low-stock notice; neither is undone by setting the old number.
 *   · collection add / remove — adding ignores products already there and
 *     removing loses their place in the order.
 *   · delete — never; it keeps its confirmation dialog.
 */
import type { BulkAction, CatalogProduct } from './catalogApi';

export const UNDO_MAX_CALLS = 3;

export interface UndoStep {
  action: BulkAction;
  ids: string[];
  extra: Record<string, unknown>;
}

type Before = Pick<CatalogProduct, 'id' | 'featured' | 'price_iqd' | 'state'>;

/**
 * The calls that put back what `action` changed on `done` (the ids the server
 * reported ok), from `before` (the rows as the list showed them). Null: no
 * exact inverse, so no «تراجع».
 */
export function bulkInverse(
  action: BulkAction,
  extra: Record<string, unknown>,
  before: readonly Before[],
  done: readonly string[],
  canSell: boolean
): UndoStep[] | null {
  const was = new Map(before.map((p) => [p.id, p]));
  const rows = done.map((id) => was.get(id));
  if (!rows.length || rows.some((r) => !r)) return null;
  const known = rows as Before[];

  if (action === 'feature' || action === 'unfeature') {
    const on = action === 'feature';
    // Putting the flag back ON needs selling rights, as featuring does.
    if (!on && !canSell) return null;
    const changed = known.filter((p) => p.featured !== on).map((p) => p.id);
    return changed.length ? [{ action: on ? 'unfeature' : 'feature', ids: changed, extra: {} }] : null;
  }

  if (action === 'set_price') {
    const next = Number(extra.price_iqd);
    const groups = new Map<number, string[]>();
    for (const p of known) {
      const old = p.price_iqd;
      if (typeof old !== 'number' || !Number.isInteger(old) || old < 0) return null;
      if (old === 0 && p.state === 'published') return null;
      if (old === next) continue;
      groups.set(old, [...(groups.get(old) ?? []), p.id]);
    }
    if (!groups.size || groups.size > UNDO_MAX_CALLS) return null;
    return [...groups].map(([price, ids]) => ({ action: 'set_price', ids, extra: { price_iqd: price } }));
  }

  return null;
}
