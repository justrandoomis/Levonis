/**
 * «المخزون ينفد» — telling the merchant when a product (or one variant of it)
 * crosses the low-stock line they set.
 *
 * The line is the merchant's: `low_stock_threshold` on the product, and on a
 * variant when it has its own (a variant without one uses the product's).
 * None set = no alert. The notice itself — its words, its deep link, the
 * merchant's preference for it and the outside channels — belongs to the
 * merchant notification centre (worker/lib/merchantNotify.ts, stream W2-E):
 * `notifyLowStock` sends only on the write that CROSSED the line (stock was
 * above it, is now at or below it), once per cause (an order id, an edit), so
 * a sale, a retry and the next sale do not repeat it.
 *
 * Never throws and never holds the response: callers hand it to `waitUntil`.
 */
import type { Env } from '../types';
import { notifyLowStock } from '../merchantNotify';

export interface StockMove {
  productId: string;
  productName: string;
  variantLabel?: string;
  before: number;
  after: number;
  /** The effective line: the variant's own, else the product's; null = none. */
  threshold: number | null;
}

export async function alertLowStock(env: Env | D1Database, merchantId: string, moves: StockMove[], cause: string): Promise<number> {
  let sent = 0;
  for (const m of moves) {
    if (m.threshold === null || m.threshold === undefined) continue;
    try {
      const r = await notifyLowStock(env, {
        merchantId,
        productId: m.productId,
        productName: m.productName,
        before: m.before,
        after: m.after,
        threshold: m.threshold,
        cause: m.variantLabel ? `${cause}:${m.variantLabel}` : cause,
        variantLabel: m.variantLabel,
      });
      if (r.written) sent += 1;
    } catch (e) {
      console.error('catalog: low-stock notice not sent', m.productId, e instanceof Error ? e.message : String(e));
    }
  }
  return sent;
}
