/**
 * WHAT THIS BROWSER HAS LOOKED AT — and nothing more than that.
 *
 * The owner asked for a «Selection» tile that «يعرف المستخدم ماذا يريد» —
 * that knows what the shopper is after. This shop records no browsing
 * telemetry at all: there is no views table, no search log, no recommendation
 * service. Two honest ways forward existed, and only one of them is a small
 * change.
 *
 * The one not taken: start recording every product view on the server. That is
 * a new table, a write on the busiest read path in the shop, a retention
 * policy, and a privacy question the owner has not been asked — a large thing
 * to build for one tile.
 *
 * The one taken: the BROWSER remembers, and only the browser. A short list of
 * recently opened products lives in `localStorage`, never leaves the device,
 * is never sent to the server, and is used on the client to re-rank products
 * the page has ALREADY fetched. A first-time visitor loses nothing — the tile
 * falls back to the shop's own rotation — and nobody is tracked.
 *
 * WHAT IS STORED IS DELIBERATELY THIN: an id, its section and its brand. Not
 * the name, not the price, not a timestamp beyond the ordering. Enough to say
 * "this person has been looking at resin printers", which is the whole job,
 * and not enough to reconstruct a shopping history from a shared device.
 */

const KEY = 'levonis.recentlyViewed.v1';
/** Enough to spot a pattern, short enough to stay a hint rather than a record. */
const MAX = 12;

export interface ViewedProduct {
  id: string;
  /** The product's main section, when it has one. */
  category_id?: string | null;
  brand_id?: string | null;
}

/**
 * Every read and write is wrapped: `localStorage` throws in a private window
 * on some browsers, and in an iframe with third-party storage blocked. A tile
 * that cannot read a preference must still draw.
 */
export function readRecentlyViewed(): ViewedProduct[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is ViewedProduct => !!v && typeof v === 'object' && typeof (v as ViewedProduct).id === 'string')
      .slice(0, MAX);
  } catch {
    return [];
  }
}

/** Records a view, newest first, with no duplicates. Never throws. */
export function rememberViewed(product: ViewedProduct): void {
  if (!product?.id) return;
  try {
    const next = [
      { id: product.id, category_id: product.category_id ?? null, brand_id: product.brand_id ?? null },
      ...readRecentlyViewed().filter((v) => v.id !== product.id),
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a browser that will not remember is not an error */
  }
}

/**
 * Score a candidate against what this browser has been looking at.
 *
 * Section matters more than brand: someone reading about resin printers wants
 * resin printers more than they want another product from the same
 * manufacturer. Recency is a mild tie-breaker — the most recent view counts
 * for a little more than the twelfth — and a product the visitor has ALREADY
 * opened scores below everything else, because showing it back to them is the
 * one thing a "selection" must not do.
 */
export function affinityScore(
  candidate: { id: string; category_id?: string | null; brand_id?: string | null },
  history: readonly ViewedProduct[]
): number {
  let score = 0;
  for (let i = 0; i < history.length; i++) {
    const seen = history[i];
    if (seen.id === candidate.id) return -1; // already looked at: not a discovery
    const recency = 1 - i / (history.length + 1);
    if (seen.category_id && candidate.category_id && seen.category_id === candidate.category_id) score += 3 * recency;
    if (seen.brand_id && candidate.brand_id && seen.brand_id === candidate.brand_id) score += 1 * recency;
  }
  return score;
}

/**
 * Re-rank a pool by affinity, keeping the pool's own order as the tie-break.
 *
 * STABLE, and that is the point: with no history every score is 0 and the
 * caller's order survives unchanged, so a first-time visitor sees exactly the
 * shop's own rotation rather than a scramble.
 */
export function rankByAffinity<T extends { id: string; category_id?: string | null; brand_id?: string | null }>(
  pool: readonly T[],
  history: readonly ViewedProduct[]
): T[] {
  if (history.length === 0) return [...pool];
  return pool
    .map((item, index) => ({ item, index, score: affinityScore(item, history) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
