/**
 * SQL FRAGMENTS THE CATALOGUE'S READERS SHARE — the variant label a cart line
 * and an order line print, the "on the storefront" predicate, and the
 * collection filters (manual membership or a computed rule).
 *
 * Every fragment is a fixed string over fixed column names; the only inputs
 * are table ALIASES chosen by the caller in code and bound parameters.
 */

/**
 * «أحمر / كبير» — a variant's values in GROUP order, Arabic name first (the
 * rule every order snapshot has used: the merchant's own words), from the
 * variant row aliased `v`.
 */
export function variantLabelSql(v: string): string {
  const one = (col: string) =>
    `(SELECT COALESCE(NULLIF(x.name_ar, ''), x.name) FROM community_product_option_values x WHERE x.id = ${v}.${col})`;
  return `(COALESCE(${one('value1_id')}, '') || COALESCE(' / ' || ${one('value2_id')}, '') || COALESCE(' / ' || ${one('value3_id')}, ''))`;
}

/** On the storefront: published, not hidden by Levonis (the mirrors 0126 keeps). */
export const LIVE_PRODUCT = (p: string) => `${p}.lifecycle = 'active' AND ${p}.status = 'active'`;

export type CollectionKind = 'manual' | 'featured' | 'new_arrivals' | 'best_sellers';

export const COLLECTION_KINDS: readonly CollectionKind[] = ['manual', 'featured', 'new_arrivals', 'best_sellers'];

/** How far back «وصل حديثًا» reaches. */
export const NEW_ARRIVALS_DAYS = 30;

/**
 * The membership condition of one collection for product alias `p`, with the
 * collection's id at bound parameter `idParam` (`?n`) and "now minus the
 * new-arrivals window" at `sinceParam`.
 */
export function collectionMemberSql(kind: CollectionKind, p: string, idParam: string, sinceParam: string): string {
  switch (kind) {
    case 'manual':
      return `EXISTS (SELECT 1 FROM merchant_collection_products m WHERE m.collection_id = ${idParam} AND m.product_id = ${p}.id)`;
    case 'featured':
      return `${p}.featured = 1`;
    case 'new_arrivals':
      return `${p}.created_at >= ${sinceParam}`;
    case 'best_sellers':
      return `${p}.sold_count > 0`;
  }
}

/**
 * The order of one collection, and the value its keyset cursor carries:
 *   manual        the merchant's position, then newest
 *   best_sellers  units sold, most first
 *   featured / new_arrivals   newest first
 */
export function collectionOrder(kind: CollectionKind, p: string, idParam: string): { sortExpr: string; dir: 'ASC' | 'DESC' } {
  switch (kind) {
    case 'manual':
      return {
        sortExpr: `(SELECT m.position FROM merchant_collection_products m WHERE m.collection_id = ${idParam} AND m.product_id = ${p}.id)`,
        dir: 'ASC',
      };
    case 'best_sellers':
      return { sortExpr: `${p}.sold_count`, dir: 'DESC' };
    default:
      return { sortExpr: `${p}.created_at`, dir: 'DESC' };
  }
}

export const sinceNewArrivals = (now = Date.now()) => new Date(now - NEW_ARRIVALS_DAYS * 86_400_000).toISOString();
