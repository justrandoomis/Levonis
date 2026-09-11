/**
 * "Is this product a printer?" — answered ONE way, from the owner's own flag.
 *
 * The identity is `catalogs.is_printer_catalog` reached through
 * `product_catalogs`: the owner marks a catalog as a printer catalog and every
 * product filed under it is a printer. That is the flag the PLUS gift, the
 * referral free-delivery rule and the review rules already read, so the
 * storefront note ("50,000 IQD is paid on delivery when home delivery is
 * requested for a printer") agrees with every other place the word is used.
 *
 * DELIBERATELY NOT `products.ops_policy.size_class`. That field drives the
 * printer delivery FEE engine (worker/lib/shipping.ts), whose amounts are
 * still unconfigured: an admin who set `size_class` just to get the note would
 * switch the fee engine on and block every checkout with SHIPPING_NEEDS_CONFIG.
 * The note must never have that side effect, so it keys off the catalog flag.
 *
 * Batched: one query per call for the whole cart / quote / order, never one
 * per line. Nothing here touches money.
 */

const CHUNK = 90;

/** The ids among `productIds` that belong to a printer catalog. */
export async function printerProductIds(db: D1Database, productIds: Iterable<string>): Promise<Set<string>> {
  const wanted = [...new Set([...productIds].filter((id) => typeof id === 'string' && id !== ''))];
  const out = new Set<string>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT DISTINCT pc.product_id
           FROM product_catalogs pc
           JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
          WHERE pc.product_id IN (${chunk.map(() => '?').join(',')})`
      )
      .bind(...chunk)
      .all<{ product_id: string }>();
    for (const r of results ?? []) out.add(String(r.product_id));
  }
  return out;
}

/** One product's answer, through the same query. */
export async function isPrinterProduct(db: D1Database, productId: string): Promise<boolean> {
  return (await printerProductIds(db, [productId])).has(productId);
}
