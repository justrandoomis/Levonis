/**
 * THE APPROVED USD/IQD RATE, AND NOTHING ELSE (Services S-P2 spec §4.3 rule 4;
 * USD design §2.4, §2.6; DECISIONS row 238).
 *
 * The trade-in offer prices a part that has no price of its own today from the
 * owner's private USD reference, ceil-1,000 at the rate every engine write
 * prices at: U, the USD/IQD effective rate as the engine's versioned reader
 * (`loadPricingRates`) answers it. A customer path must not hold the engine's
 * write-side rate struct (versions, shipping, held candidates) nor any price
 * computer, so it reads this ONE figure here — the shape of the purchase
 * routes' approved-rate helper (procurementRate.ts): it computes no price.
 *
 * Null when no USD/IQD rate is approved, and on a database without 0179.
 */
import { loadPricingRates } from './rates';

export async function approvedUsdIqdRate(db: D1Database): Promise<string | null> {
  return (await loadPricingRates(db))?.usd_iqd ?? null;
}
