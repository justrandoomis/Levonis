/**
 * «طلب السعر» — SIGNED-IN PRICE REQUESTS (DECISIONS rows 239 (4) and 240;
 * migration 0193).
 *
 * A customer who sees a product with no price yet («السعر غير متوفر حالياً»)
 * may ask for it — for the product, or for the exact option/colour/variant
 * they chose. One row per (person, product, selection): a repeat tap raises
 * that row's `click_count` and never the count of people. The per-product
 * aggregates (`product_price_request_stats`) are RECOMPUTED FROM SOURCE inside
 * the same batch as every write, never incremented, so they are exact under
 * concurrency (D1 serialises batches).
 *
 * NO MONEY. A request touches `product_price_requests` and its stats only
 * (plus `rate_limits` and the fence's `ops_guards` scratch rows): never an
 * order, a cart, a wallet, an inventory reservation or any price.
 *
 * THE SWEEP IS THE ONE AUTHORITY for "this is now priced": a selection becomes
 * sellable through many doors (the first V2 write, a later V2 write adding SKU
 * rows, FX-5, the completeness hold lifting, the owner's switch turning off),
 * and a hook on one door would miss the others. It runs in the quarter-hour
 * tick after the completeness sweep, within its own budget, and moves a
 * request to `notified` (the in-app row and the outbox rows in the SAME batch)
 * or `closed(priced)` when the customer did not ask to be told.
 *
 * THE ADMIN HEARS IN A DIGEST, never once per request: at most one Telegram
 * message an hour, in the existing «البلاغات» topic (default D8), naming the
 * products whose distinct requesters crossed a threshold (1, 3, 10, 25, 50,
 * 100, then every 100). Claim, then send: two concurrent digests send once.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): without 0193 every customer door answers
 * 503 PRICE_REQUESTS_UNAVAILABLE, the sweep and the digest return at once, and
 * the admin reads fall back (no column, today's order).
 */
import { parseSkuComboKey } from '@levonis/pricing/skuChannel';
import { PRICE_REQUEST_ADMIN_TEXT, type PriceRequestText } from '@levonis/contracts/priceRequests';
import type { ProductDoc } from './productModel';
import { unitNamesOf } from './pricingEngine/legacy';

// ------------------------------------------------------------- installed?

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** "no such table: product_price_request…" — the deploy-ahead answer. */
export function isMissingPriceRequestTable(err: unknown): boolean {
  return /no such table:?\s*product_price_request/i.test(String((err as { message?: unknown })?.message ?? err));
}

/** Migration 0193's tables are on this database. One probe per binding while unknown, none once present. */
export async function priceRequestsInstalled(db: D1Database): Promise<boolean> {
  if (PRESENT.has(db)) return true;
  if ((ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return false;
  try {
    await db.prepare('SELECT 1 AS x FROM product_price_request_stats LIMIT 1').first<{ x: number }>();
    PRESENT.set(db, true);
    return true;
  } catch (e) {
    if (isMissingPriceRequestTable(e)) ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
    return false;
  }
}

/** Whether this database is known to carry 0193 without asking (a read that just succeeded proves it). */
export function rememberPriceRequestsPresent(db: object): void {
  PRESENT.set(db, true);
}

// ------------------------------------------------------------- the stats

/**
 * The per-product aggregates, RECOMPUTED FROM SOURCE over the open rows — one
 * statement, appended to every batch that writes requests.
 */
const STATS_SQL = `INSERT INTO product_price_request_stats (product_id, requesters, selections, clicks, last_request_at, updated_at)
SELECT ?1, COUNT(DISTINCT user_id), COUNT(DISTINCT selection), COALESCE(SUM(click_count), 0), COALESCE(MAX(requested_at), ''), ?2
  FROM product_price_requests WHERE product_id = ?1 AND state = 'open'
ON CONFLICT(product_id) DO UPDATE SET requesters = excluded.requesters, selections = excluded.selections,
  clicks = excluded.clicks, last_request_at = excluded.last_request_at, updated_at = excluded.updated_at`;

export const statsRecompute = (db: D1Database, productId: string, now: string): D1PreparedStatement =>
  db.prepare(STATS_SQL).bind(productId, now);

// ------------------------------------------------------------- the selection's words

/** The selection's name in three languages (« · » between parts); the whole product when the key is ''. */
export function selectionLabel(doc: ProductDoc, key: string): PriceRequestText {
  const sel = parseSkuComboKey(key);
  if (!sel || (!sel.option_value_ids.length && !sel.color_id)) return { ...PRICE_REQUEST_ADMIN_TEXT.whole_product };
  const color = sel.color_id ? (doc.colors.find((c) => c.id === sel.color_id) ?? null) : null;
  const names = unitNamesOf(doc, sel.option_value_ids, color);
  const fallback = PRICE_REQUEST_ADMIN_TEXT.whole_product;
  return { ar: names.name_ar || fallback.ar, en: names.name_en || fallback.en, ckb: names.name_ckb || fallback.ckb };
}

/** The product's own name in three languages (the English one is required and the fallback). */
export function productNames(doc: ProductDoc): PriceRequestText {
  const en = doc.name_en || doc.name_ar || '';
  return { ar: doc.name_ar || en, en, ckb: doc.name_ckb || doc.name_ar || en };
}
