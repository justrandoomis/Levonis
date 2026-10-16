/**
 * DEMAND SUMMED PER STOCK COUNTER — the checkout's keying, written once.
 *
 * Two lines that draw on one counter (a product whose shelf is shared by every
 * colour, an option row two colours sit under) must be judged on their SUM:
 * each passing alone against the full `available` is how 50 + 5 + 1 pieces of
 * three colours on one shelf of 52 would reach a cart the checkout then
 * refuses. The checkout (worker/routes/orders.ts `refuseAggregateDemand`) and
 * the cart's batch door (worker/routes/cart.ts `POST /items/batch`,
 * docs/ux/COLOUR-QUANTITIES.md §4.3 step 4) both sum through here, so the two
 * cannot key a counter differently.
 */
import { isCapacityScope, type StockScope, type StockTarget } from './inventory';

export interface DemandLine {
  product_id: string;
  qty: number;
  stock_targets: readonly StockTarget[];
}

export interface CounterDemand<L extends DemandLine = DemandLine> {
  /** `${scope}:${scope_id || product_id}` — the checkout's own key. */
  key: string;
  scope: StockScope;
  /** Units every line drawing on this counter asks for, together. */
  needed: number;
  /** `stock - reserved` of the counter (never below 0); null = untracked. */
  available: number | null;
  /** A pre-order capacity row: aggregated like a shelf, but not a shelf. */
  preorder: boolean;
  /** The lines drawing on it, in the order they were given, with their indexes. */
  lines: L[];
  indexes: number[];
}

/**
 * Sums the demand of `lines` per stock counter.
 *
 * BASE stock lives on the product row itself, so its `scope_id` is '' and the
 * product id identifies the row — exactly as `planInventory` resolves it.
 * Keying on the scope alone would merge unrelated rows into one.
 */
export function demandByCounter<L extends DemandLine>(lines: readonly L[]): Map<string, CounterDemand<L>> {
  const demand = new Map<string, CounterDemand<L>>();
  lines.forEach((l, index) => {
    for (const t of l.stock_targets) {
      const key = `${t.scope}:${t.scope_id || l.product_id}`;
      const found = demand.get(key);
      if (found) {
        found.needed += l.qty;
        if (!found.lines.includes(l)) {
          found.lines.push(l);
          found.indexes.push(index);
        }
      } else {
        demand.set(key, {
          key,
          scope: t.scope,
          needed: l.qty,
          available: t.stock === null ? null : Math.max(0, t.stock - Math.max(0, t.reserved)),
          preorder: isCapacityScope(t.scope),
          lines: [l],
          indexes: [index],
        });
      }
    }
  });
  return demand;
}
