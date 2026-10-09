/**
 * OWNER DECISION 6: PRICE PROTECTION ON THE BASE PRICE IN USD (ODP §5.1 items
 * 9-10; USD design §6.6; policy `price_protection` v5 §10.4, §11.8).
 *
 * An FX-only drop is never price protection. For a line bought at an engine
 * price, every engine price observed in the window is restated at the rate the
 * line was bought at — ρ = ceil(P × U0 ÷ U) — so a price that fell only because
 * the dollar moved restates to the price paid; the dinars owed per unit are
 * min(P0 − min ρ, the actual dinar drop), and below one 1,000 step the claim is
 * FX_ONLY_DROP. A line bought at a manual price compares manual prices as
 * before and restates only the engine-written ones, at the USD/IQD in force
 * when the order was created (from `fx_rate_log`); with no such rate only the
 * owner's own engine saves count. Today's price is a candidate on the same
 * terms. A manual observation is dinars, never restated (manual prices do not
 * move with FX).
 *
 * THE RULE FOLLOWS THE ORDER'S DATE (§13.1: amendments are not retroactive).
 * An order created before v5 keeps the dinar rule, with the engine's `sku:`
 * history rows of the line's channel added as dinar observations, so a real
 * engine drop is never missed.
 *
 * Prices and rates only: the caller (the claim route) owns the order line and
 * stores the result. Nothing here writes, and nothing here names an
 * accounting table. On a database without migration 0181 there are no engine
 * observations and every claim keeps today's dinar rule.
 */
import { ceilProcurementExact, mulProcurementExact, procurementExact, quotientProcurementExact } from '@levonis/contracts/procurementCost';
import { skuComboKey, skuPriceHistoryKey, type SkuChannel } from '@levonis/pricing/skuChannel';
import { isMissingTable } from '../fx/pairs';
import { baseUsdOf } from './orderBasis';

/** `price_protection` v5's effective date: orders created on or after it take the USD-base rule. */
export const USD_BASE_RULE_FROM = '2026-10-09';

/** One 1,000 IQD rounding step: a restated drop below it is the rounding of an FX move, never a real one. */
export const FX_ONLY_STEP_IQD = 1000;

export interface EngineObservation {
  price_iqd: number;
  /** The U the price was computed at (NULL on a row written before 0181's columns). */
  usd_iqd_rate: string | null;
  source: 'manual' | 'engine_owner' | 'engine_fx';
}

export interface EngineToday {
  price_iqd: number;
  usd_iqd_rate: string;
}

const isMissingColumn = (e: unknown) => /no such column/i.test(e instanceof Error ? e.message : String(e));

/** The USD/IQD in force at a moment, from the append-only FX log; null when none was. */
export async function usdIqdInForceAt(db: D1Database, iso: string): Promise<string | null> {
  try {
    const r = await db
      .prepare(
        `SELECT effective_after FROM fx_rate_log
          WHERE pair = 'USD_IQD' AND effective_after IS NOT NULL AND created_at <= ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .bind(iso)
      .first<{ effective_after: string }>();
    return r?.effective_after ?? null;
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

/**
 * The engine's observations of one model × channel in the window (its `sku:`
 * history rows, with the U each was computed at) and, when the product is
 * engine-priced now, today's engine price and U.
 */
export async function engineObservations(
  db: D1Database,
  productId: string,
  optionId: string,
  channel: SkuChannel,
  window: { from: string; to: string }
): Promise<{ history: EngineObservation[]; today: EngineToday | null }> {
  const combo = skuComboKey({ option_value_ids: optionId ? [optionId] : [], color_id: null });
  try {
    const [hist, today] = await db.batch([
      db
        .prepare(
          `SELECT new_iqd, usd_iqd_rate, price_source FROM price_history
            WHERE product_id = ? AND variant_key = ? AND field = 'regular' AND new_iqd IS NOT NULL
              AND changed_at >= ? AND changed_at <= ?`
        )
        .bind(productId, skuPriceHistoryKey(combo, channel), window.from, window.to),
      db
        .prepare(
          `SELECT c.computed_price_iqd, c.usd_iqd_rate FROM pricing_sku_costs c
             JOIN product_pricing_state s ON s.product_id = c.product_id AND s.mode = 'engine'
            WHERE c.product_id = ? AND c.combo_key = ? AND c.channel = ?`
        )
        .bind(productId, combo, channel),
    ]);
    const rows = ((hist as D1Result<{ new_iqd: number; usd_iqd_rate: string | null; price_source: string }>).results ?? []) as Array<{ new_iqd: number; usd_iqd_rate: string | null; price_source: string }>;
    const t = (((today as D1Result<{ computed_price_iqd: number; usd_iqd_rate: string }>).results ?? []) as Array<{ computed_price_iqd: number; usd_iqd_rate: string }>)[0] ?? null;
    return {
      history: rows
        .filter((r) => Number.isSafeInteger(Number(r.new_iqd)) && Number(r.new_iqd) >= 0)
        .map((r) => ({
          price_iqd: Number(r.new_iqd),
          usd_iqd_rate: r.usd_iqd_rate ?? null,
          source: r.price_source === 'engine_owner' || r.price_source === 'engine_fx' ? r.price_source : 'manual',
        })),
      today: t ? { price_iqd: Number(t.computed_price_iqd), usd_iqd_rate: String(t.usd_iqd_rate) } : null,
    };
  } catch (e) {
    if (isMissingTable(e) || isMissingColumn(e)) return { history: [], today: null };
    throw e;
  }
}

/** ρ = ceil(P × U0 ÷ U): an engine price restated at the purchase-time rate, rounded up to the dinar. */
export function restate(priceIqd: number, rateAtPrice: string, rateAtPurchase: string): number {
  return Number(ceilProcurementExact(quotientProcurementExact(mulProcurementExact(procurementExact(priceIqd), procurementExact(rateAtPurchase)), procurementExact(rateAtPrice))));
}

export interface ClaimBasisInput {
  /** The order was created on or after v5's effective date. */
  v5: boolean;
  /** The line's frozen engine snapshot (price_basis = 'engine'), or null for a manual line. */
  engine: { regular_iqd: number; usd_iqd_at_purchase: string; base_usd_at_purchase: string | null } | null;
  /** A manual line on a v5 order: the USD/IQD in force when the order was created (null when none was). */
  orderUsdIqd: string | null;
  /** P0: what the buyer paid per unit (tier-aware). */
  paidUnit: number;
  /** Today's tier-aware price from the cart's resolver (dinars). */
  todayApplied: number;
  /** The lowest manual (dinar) price recorded in the window under the product's own keys, tier-aware; null when none. */
  manualMin: number | null;
  /** The engine's `sku:` observations of the line's channel in the window. */
  engineHistory: readonly EngineObservation[];
  /** Today's engine price of the line's model × channel, when the product is engine-priced now. */
  engineToday: EngineToday | null;
}

export type ClaimBasisResult =
  | { ok: true; basis: 'iqd' | 'usd_base'; observed_unit: number; eligible_unit: number | null; base_usd_observed: string | null }
  | { ok: false; code: 'NO_ELIGIBLE_DROP' | 'FX_ONLY_DROP'; observed_unit: number };

const minOf = (xs: readonly number[]) => Math.min(...xs);

/** The claim's figures under the order's rule (see the file header). Pure. */
export function claimBasis(a: ClaimBasisInput): ClaimBasisResult {
  // The dinar observations: today's applied price, the manual rows, and every engine row as it was charged.
  const dinar = [a.todayApplied, ...(a.manualMin === null ? [] : [a.manualMin]), ...a.engineHistory.map((h) => h.price_iqd)];
  const observedDinar = minOf(dinar);
  const actualDrop = Math.max(0, a.paidUnit - observedDinar);

  if (!a.v5) {
    // The pre-v5 dinar rule, the engine's sku: rows included as dinar observations.
    if (actualDrop <= 0) return { ok: false, code: 'NO_ELIGIBLE_DROP', observed_unit: observedDinar };
    return { ok: true, basis: 'iqd', observed_unit: observedDinar, eligible_unit: null, base_usd_observed: null };
  }

  const u0 = a.engine ? a.engine.usd_iqd_at_purchase : a.orderUsdIqd;
  // The candidates on the order's terms: engine prices restated at U0 (an engine row with no rate, or no U0,
  // counts only when the owner wrote it, as charged); manual prices as dinars; today's on the same terms.
  const restated: number[] = [];
  for (const h of a.engineHistory) {
    if (u0 && h.usd_iqd_rate) restated.push(restate(h.price_iqd, h.usd_iqd_rate, u0));
    else if (h.source === 'engine_owner' || h.source === 'manual') restated.push(h.price_iqd);
  }
  if (a.engineToday) {
    if (u0) restated.push(restate(a.engineToday.price_iqd, a.engineToday.usd_iqd_rate, u0));
  } else {
    restated.push(a.todayApplied);
  }
  if (a.manualMin !== null) restated.push(a.manualMin);

  if (a.engine) {
    // An engine line compares its base (regular) price in USD; the dinars owed never exceed the actual drop.
    const minRestated = restated.length ? minOf(restated) : a.engine.regular_iqd;
    const usdDrop = Math.max(0, a.engine.regular_iqd - minRestated);
    const eligible = Math.min(usdDrop, actualDrop);
    if (actualDrop <= 0) return { ok: false, code: 'NO_ELIGIBLE_DROP', observed_unit: observedDinar };
    if (eligible < FX_ONLY_STEP_IQD) return { ok: false, code: 'FX_ONLY_DROP', observed_unit: observedDinar };
    return { ok: true, basis: 'usd_base', observed_unit: observedDinar, eligible_unit: eligible, base_usd_observed: baseUsdOf(minRestated, u0!) };
  }

  // A manual line on a v5 order: the dinar rule with the engine's prices restated at the order's rate.
  const minCandidate = restated.length ? minOf(restated) : observedDinar;
  const eligible = Math.min(Math.max(0, a.paidUnit - minCandidate), actualDrop);
  if (actualDrop <= 0) return { ok: false, code: 'NO_ELIGIBLE_DROP', observed_unit: observedDinar };
  if (eligible <= 0 || (eligible < FX_ONLY_STEP_IQD && eligible < actualDrop)) return { ok: false, code: 'FX_ONLY_DROP', observed_unit: observedDinar };
  return { ok: true, basis: 'iqd', observed_unit: observedDinar, eligible_unit: eligible, base_usd_observed: null };
}

/** True when the order's creation falls on or after v5's effective date. */
export const takesUsdBaseRule = (orderCreatedAt: string | null | undefined): boolean =>
  typeof orderCreatedAt === 'string' && orderCreatedAt.slice(0, 10) >= USD_BASE_RULE_FROM;
