/**
 * "HOW MANY HAVE SOLD" — ROUNDED DOWN, NEVER UP, AND NEVER EXACT.
 *
 * The owner asked for an approximate figure on the product page rather than a
 * live counter: «+50 مبيعات», not «237 مبيعات». Two rules follow from what
 * that badge MEANS, and both are load-bearing.
 *
 * ROUNDED DOWN. A "+" badge is read as "at least this many". Rounding 237 up
 * to 250+ tells a shopper that 250 people bought something 237 people bought,
 * which is a claim about the shop's own sales that is not true. Every product
 * therefore advertises a tier it has genuinely passed. The ladder is dense
 * enough that the loss is small — 237 lands on 200, not on 100.
 *
 * NEVER EXACT, AND BUCKETED ON THE SERVER. The tier is what leaves the Worker;
 * the raw count never reaches the browser. Sending the exact number and
 * rounding it in the client would publish the shop's real sales volume per
 * product to anyone who opened devtools, which is competitive information the
 * badge was specifically designed not to reveal.
 *
 * DELIVERED UNITS ONLY. A sale that is still in a courier's van may yet be
 * refused at the door, and a cancelled order is not a sale at all. Counting
 * anything earlier than `delivered` would inflate the badge with orders that
 * have not happened, which is the same overstatement the rounding rule exists
 * to prevent.
 *
 * BELOW THE FIRST TIER THERE IS NO BADGE. A product with four sales shows
 * nothing rather than "0+" — an empty shelf should look new, not unwanted.
 */

/**
 * The ladder, ascending. Dense at the bottom, where the difference between 5
 * and 25 is most of what a shopper can learn, and sparse at the top, where the
 * difference between 5,000 and 7,500 is not.
 */
export const SALES_TIERS: readonly number[] = [
  5, 10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750,
  1_000, 1_500, 2_000, 3_000, 5_000, 7_500, 10_000, 25_000, 50_000, 100_000,
] as const;

/**
 * The largest tier this many delivered units has actually passed, or null when
 * it has not reached the first one.
 */
export function salesBadgeTier(soldUnits: unknown): number | null {
  const n = typeof soldUnits === 'number' ? soldUnits : Number(soldUnits);
  if (!Number.isFinite(n)) return null;
  const units = Math.floor(n);
  if (units < SALES_TIERS[0]) return null;
  let tier: number | null = null;
  for (const t of SALES_TIERS) {
    if (units >= t) tier = t;
    else break;
  }
  return tier;
}

/**
 * Delivered units per product, batched. Returns only the products that have
 * any, so a caller can treat a missing key as "no badge".
 *
 * `delivered` is matched exactly rather than "not cancelled" — see the header
 * note on why an in-flight order is not yet a sale.
 */
export async function deliveredUnitsByProduct(
  db: D1Database,
  productIds: Iterable<string>
): Promise<Map<string, number>> {
  const wanted = [...new Set([...productIds].filter((id) => typeof id === 'string' && id !== ''))];
  const out = new Map<string, number>();
  const CHUNK = 90;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT oi.product_id AS product_id, COALESCE(SUM(oi.qty), 0) AS units
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_id IN (${chunk.map(() => '?').join(',')})
            AND o.status = 'delivered'
          GROUP BY oi.product_id`
      )
      .bind(...chunk)
      .all<{ product_id: string; units: number }>();
    for (const r of results ?? []) {
      const units = Number(r.units) || 0;
      if (units > 0) out.set(String(r.product_id), units);
    }
  }
  return out;
}

/** One product's badge tier, through the same query. */
export async function salesBadgeFor(db: D1Database, productId: string): Promise<number | null> {
  const units = (await deliveredUnitsByProduct(db, [productId])).get(productId) ?? 0;
  return salesBadgeTier(units);
}
