import type { ProductDoc } from '../productModel';
import { snapshotFrom, type ProductRelationsView } from '../productOverlay';
import { resolveStock } from '../inventory';

/** Physical stock, not availability after reservations. An empty direct-only
 * choice cannot be bought and must not prevent pricing the other choices.
 * NULL remains unknown/untracked; a missing variant is never treated as zero. */
export function emptyDirectStock(doc: ProductDoc, view: ProductRelationsView | undefined, selection: { option_value_ids: readonly string[]; color_id: string | null }, channels: readonly string[]): boolean {
  if (!view || channels.length !== 1 || channels[0] !== 'direct_sale') return false;
  const stock = resolveStock(snapshotFrom(view, { stock: doc.stock, reserved: 0, low_stock_threshold: null }), { ...selection, option_value_ids: [...selection.option_value_ids] });
  return !stock.error && stock.tracked && stock.targets.some((t) => t.stock === 0);
}
