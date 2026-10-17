/**
 * «طلب السعر» — WHEN A REQUEST IS ANSWERED, AND WHO STILL WAITS ON THE OWNER
 * (DECISIONS row 240; migration 0193; the owner's report of 2026-10-17).
 *
 * WHAT WENT WRONG. «فلمنت eSUN PLA+ — 1 كغم» was priced through Pricing V2 and
 * sold at 26,000 د.ع, and its row in the admin list still said «طلبات السعر: 2».
 * Nothing on the pricing side ever moved a request: the only door from `open`
 * to `priced`/`notified`/`closed` was the quarter-hour sweep — the second-last
 * step of a tick that spends only what everything before it left — and the
 * nudge written to follow a V2 write
 * (`sweepPriceRequestsFor`) was never called. The chip and the stats it reads
 * count `open` rows, so a priced product kept its requests until a sweep that
 * might not come.
 *
 * WHAT HAPPENS NOW, in three places:
 *
 *   1. AT THE WRITE. Every owner or editor V2 price write — the form's save
 *      and «اعتمد ونشر», the prices-only apply, the purchase review — goes
 *      through `v2WriteStatements`; its batch now carries
 *      `priceRequestTransitions`: an `open` request whose selection the batch
 *      just priced, on a product a customer can BUY once the batch lands, moves
 *      to `priced` (waiting to be told); a `priced` one that is no longer so
 *      goes back to `open`; the stats are recounted. Atomic with the prices.
 *      (An automatic repricing — FX-5, the owner's rate preview — budgets
 *      every statement of its tick and lays none: place 3 covers it.)
 *   2. THE CHIP. «طلبات السعر: N» counts, from source, only the people whose
 *      request STILL NEEDS THE OWNER — open and not answered
 *      (`requestersWaitingSql`) — so a priced, sellable product shows none
 *      whatever the sweep has or has not reached.
 *   3. THE ROWS LEFT BEHIND, AND EVERY OTHER DOOR. The sweep starts every pass
 *      with `repairAnsweredRequests`: one guarded, idempotent statement over
 *      every product (a hold lifted, a rate that unblocked a colour, a product
 *      priced before this release) and the recount of the stats it moved; its
 *      passes then tell the people who asked, as before.
 *
 * NEVER A PRICE THE CUSTOMER WOULD NOT SEE: `priced` is only ever set for a
 * product that is SELLABLE (the listing's own predicate, worker/lib/listing.ts)
 * with a LIVE V2 price for that very selection (the overlay's rule,
 * worker/lib/productOverlay.ts `SKU_ROW_LIVE_V2`), and the sweep checks both
 * again before it tells anyone.
 *
 * DEPLOY-AHEAD: without 0193 nothing here is sent (the caller asks
 * `priceRequestsInstalled` first); without 0189 nothing is sellable and every
 * request still waits.
 */
import { PRODUCT_SKU_ROW_KEY } from '@levonis/pricing/skuChannel';
import { completenessInstalled, sellableSql } from './listing';
import { pricingV2Installed } from './engineInstalled';

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
 * statement, appended to every batch that writes requests. The digest's
 * high-water mark follows the count DOWN (never up: only the digest's claim
 * raises it), so demand that returns after the open rows were told or
 * withdrawn is announced again from its new start.
 */
const STATS_SQL = `INSERT INTO product_price_request_stats (product_id, requesters, selections, clicks, last_request_at, updated_at)
SELECT ?1, COUNT(DISTINCT user_id), COUNT(DISTINCT selection), COALESCE(SUM(click_count), 0), COALESCE(MAX(requested_at), ''), ?2
  FROM product_price_requests WHERE product_id = ?1 AND state = 'open'
ON CONFLICT(product_id) DO UPDATE SET requesters = excluded.requesters, selections = excluded.selections,
  clicks = excluded.clicks, last_request_at = excluded.last_request_at, updated_at = excluded.updated_at,
  digest_requesters = MIN(product_price_request_stats.digest_requesters, excluded.requesters)`;

export const statsRecompute = (db: D1Database, productId: string, now: string): D1PreparedStatement =>
  db.prepare(STATS_SQL).bind(productId, now);

// ------------------------------------------------------------- answered

/** Which of the listing's clauses this database can run (0184's hold, 0189's V2 tables). */
export interface RequestGate {
  held: boolean;
  v2: boolean;
}

/** The gate of this binding (both probes are kept per binding: no read once known). */
export async function requestGateOf(db: D1Database): Promise<RequestGate> {
  const [held, v2] = await Promise.all([completenessInstalled(db), pricingV2Installed(db)]);
  return { held, v2 };
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQL: the request row `r` (an alias, or the table's own name) is ANSWERED — its
 * selection has a LIVE V2 price (the V2 writer's result for that exact SKU and
 * a `product_sku_prices` row saying the same price: `SKU_ROW_LIVE_V2`, the key
 * canonical — `o:*` is the product itself, `''`) and its product is SELLABLE.
 * Without 0189 nothing is answered.
 */
export function requestAnsweredSql(r: string, gate: RequestGate): string {
  if (!ALIAS.test(r)) throw new Error(`requestAnsweredSql: bad alias ${r}`);
  if (!gate.v2) return '0';
  return `(EXISTS (SELECT 1 FROM products pqa WHERE pqa.id = ${r}.product_id AND ${sellableSql('pqa', gate.held)})
    AND EXISTS (SELECT 1 FROM pricing_v2_sku_results rqa
      JOIN product_sku_prices sqa ON sqa.product_id = rqa.product_id AND sqa.channel = rqa.channel
        AND sqa.regular_price_iqd = rqa.final_price_iqd AND sqa.regular_price_iqd > 0
        AND (CASE sqa.combo_key WHEN '${PRODUCT_SKU_ROW_KEY}' THEN '' ELSE sqa.combo_key END) = rqa.combo_key
      WHERE rqa.product_id = ${r}.product_id AND rqa.combo_key = ${r}.selection))`;
}

/**
 * «طلبات السعر: N» — the distinct people whose request STILL NEEDS THE OWNER:
 * open, and not answered. A correlated count for the `products` row `p` (the
 * admin list's column, sort and filter). Read from source, so a request the
 * sweep has not reached yet never shows on a product the owner already priced.
 */
export function requestersWaitingSql(p: string, gate: RequestGate): string {
  if (!ALIAS.test(p)) throw new Error(`requestersWaitingSql: bad alias ${p}`);
  return `(SELECT COUNT(DISTINCT rqw.user_id) FROM product_price_requests rqw
    WHERE rqw.product_id = ${p}.id AND rqw.state = 'open' AND NOT ${requestAnsweredSql('rqw', gate)})`;
}

/**
 * THE V2 WRITE'S TAIL (place 1 above): the product's open requests the batch
 * answered move to `priced` (the sweep tells or closes them), `priced` ones it
 * un-answered (a colour's price gone, the product no longer sellable) wait
 * again, and the stats are recounted. Three statements, guarded, idempotent.
 */
export function priceRequestTransitions(db: D1Database, productId: string, now: string, gate: RequestGate): D1PreparedStatement[] {
  const answered = requestAnsweredSql('product_price_requests', gate);
  return [
    db
      .prepare(`UPDATE product_price_requests SET state = 'priced', priced_at = ? WHERE product_id = ? AND state = 'open' AND ${answered}`)
      .bind(now, productId),
    db
      .prepare(`UPDATE product_price_requests SET state = 'open', priced_at = '' WHERE product_id = ? AND state = 'priced' AND NOT ${answered}`)
      .bind(productId),
    statsRecompute(db, productId, now),
  ];
}

/** The open-row aggregates of the stats row being updated, from source (STATS_SQL's, correlated). */
const openOf = (expr: string) =>
  `(SELECT ${expr} FROM product_price_requests rqs WHERE rqs.product_id = product_price_request_stats.product_id AND rqs.state = 'open')`;

/**
 * THE ROWS LEFT BEHIND (place 3 above): every open request already answered,
 * over every product, moves to `priced`, and the stats of the products it
 * moved are recounted from source. Two statements for one batch, guarded and
 * idempotent: a second run changes nothing. The sweep's per-product pass then
 * tells the people who asked, or closes a request nobody asked to be told of.
 */
export function repairAnsweredRequests(db: D1Database, now: string, gate: RequestGate): D1PreparedStatement[] {
  return [
    db
      .prepare(`UPDATE product_price_requests SET state = 'priced', priced_at = ? WHERE state = 'open' AND ${requestAnsweredSql('product_price_requests', gate)}`)
      .bind(now),
    db
      .prepare(
        `UPDATE product_price_request_stats
            SET requesters = ${openOf('COUNT(DISTINCT rqs.user_id)')}, selections = ${openOf('COUNT(DISTINCT rqs.selection)')},
                clicks = ${openOf('COALESCE(SUM(rqs.click_count), 0)')}, last_request_at = ${openOf("COALESCE(MAX(rqs.requested_at), '')")},
                digest_requesters = MIN(digest_requesters, ${openOf('COUNT(DISTINCT rqs.user_id)')}), updated_at = ?1
          WHERE product_id IN (SELECT product_id FROM product_price_requests WHERE state = 'priced' AND priced_at = ?1)`
      )
      .bind(now),
  ];
}
