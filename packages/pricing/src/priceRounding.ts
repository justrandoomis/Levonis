/**
 * THE ONE PRICE ROUNDING RULE (owner decision 2026-10-17, DECISIONS row 245).
 *
 *   - a price ABOVE 1,000 IQD rounds UP to the next multiple of 250:
 *       13,120 → 13,250   1,120 → 1,250   24,000 → 24,000   1,000.01 → 1,250;
 *   - a price of 1,000 IQD OR LESS is not rounded to a step — only up to whole
 *     dinars: 999 → 999, 1,000 → 1,000, 120.4 → 121.
 *
 * It replaces the 1,000 step for every price a customer is shown: the published
 * Pricing V2 prices (direct and every pre-order route, priceV2.ts) and the
 * product discount's after-price, dollar (worker/lib/offerUsd.ts) and percent
 * (worker/lib/offers.ts). Every one of those paths calls THIS function; none
 * carries its own step. (The legacy E1 engine, `costToPrice.ts`, keeps its own
 * `ceilStep` and 1,000 step: no V2 price passes through it.)
 *
 * UP, never to nearest: a rounded price is never below the exact amount it
 * comes from, so a cost-first floor (R + T) is never undercut by the rounding.
 * Monotone and idempotent: a ≤ b ⇒ round(a) ≤ round(b), and round(round(x)) =
 * round(x). The amount is an exact rational, a bigint, decimal TEXT or a JS
 * safe integer — a fractional JS number is refused (it is already a binary
 * float), as everywhere in the engine. A negative amount is never a price.
 *
 * Pure, no I/O, nothing confidential: it may be imported anywhere.
 */
import {
  ceilProcurementExact,
  compareProcurementExact,
  divProcurementExact,
  procurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';

/** At or below this, a price is whole dinars, never stepped. */
export const PRICE_ROUNDING_THRESHOLD_IQD = 1_000;
/** Above the threshold, a price is a multiple of this. */
export const PRICE_ROUNDING_STEP_IQD = 250;

function exactOf(value: ProcurementExact | number | bigint | string): ProcurementExact {
  if (typeof value === 'object') {
    if (typeof value?.num !== 'bigint' || typeof value.den !== 'bigint' || value.den <= 0n) throw new RangeError('Not an exact amount');
    return value;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('A fractional amount must be decimal text, never a binary float');
  return procurementExact(value, { signed: true });
}

const THRESHOLD = procurementExact(PRICE_ROUNDING_THRESHOLD_IQD);

/** The price the rule gives for an exact amount (whole IQD). */
export function roundPriceIqd(value: ProcurementExact | number | bigint | string): number {
  const exact = exactOf(value);
  if (exact.num < 0n) throw new RangeError('A negative amount is never rounded to a price');
  const step = compareProcurementExact(exact, THRESHOLD) > 0 ? BigInt(PRICE_ROUNDING_STEP_IQD) : 1n;
  const out = ceilProcurementExact(divProcurementExact(exact, step)) * step;
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Price is not a safe integer');
  return Number(out);
}

/** Is this whole amount a price the rule can give (≥ 1; above 1,000 a multiple of 250)? */
export function isOnPriceRule(amount: number): boolean {
  if (!Number.isSafeInteger(amount) || amount < 1) return false;
  return amount <= PRICE_ROUNDING_THRESHOLD_IQD || amount % PRICE_ROUNDING_STEP_IQD === 0;
}
