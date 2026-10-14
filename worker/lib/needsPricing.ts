/**
 * THE PRODUCTS STILL «يحتاج تسعيرًا» (the clean start, DECISIONS row 222 Q6): a product with no V2 method or
 * no complete V2 write keeps its old dinar prices only as an archive. A read of which products those are —
 * it computes no price and imports no part of the pricing engine, so a customer path (trade-in) may ask it.
 */
export async function needsPricingIds(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const all = new Set(ids.filter(Boolean));
  if (!all.size) return all;
  try {
    const { results } = await db
      .prepare(
        `SELECT s.product_id AS id FROM product_pricing_state s
          WHERE s.product_id IN (SELECT value FROM json_each(?)) AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
            AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = s.product_id)`
      )
      .bind(JSON.stringify([...all]))
      .all<{ id: string }>();
    for (const r of results ?? []) all.delete(String(r.id));
  } catch {
    // A database before 0189: nothing is published, every product needs pricing.
  }
  return all;
}

