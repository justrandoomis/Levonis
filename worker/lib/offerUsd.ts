/**
 * A DOLLAR SALE PRICE THAT FOLLOWS THE EXCHANGE RATE (docs/ux/PRODUCT-DISCOUNT.md
 * §3, §4.4, §4.7; migration 0197).
 *
 * The owner types the price AFTER the discount in dollars ($500). The price
 * BEFORE it is the product's published V2 price, never typed. Both are read at
 * the SAME rate: the `usd_iqd_rate` of the SKU's own `pricing_v2_sku_results`
 * row — the rate its published price was computed at, written in the same batch
 * as that price (`v2WriteStatements`, `autoReprice`). So when the rate moves and
 * a product is repriced, its before and after prices move together; a product
 * not yet repriced in a wave keeps its old rate for both. The central rate is
 * never read here.
 *
 * NO FLOAT EVER. Cents are a whole number, the rate is decimal text, and the
 * product is exact BigInt rational arithmetic, rounded UP by the very rule
 * Pricing V2 publishes its prices with (`roundPriceIqd`, DECISIONS row 245:
 * above 1,000 IQD to the next 250, else whole dinars).
 *
 * THIS FILE ALSO OWNS 0197's PRESENCE PROBE, its reads and its writes, so every
 * reader asks once whether the table is there (CLAUDE.md rule 2: a newer Worker
 * can run on a database without 0197; then no window prices in dollars, and a
 * dollar save is refused with OFFER_USD_NOT_INSTALLED).
 *
 * PRIVATE: no price, rate or cent value is ever logged from here.
 */
import { mulProcurementExact, procurementExact, type ProcurementExact } from '@levonis/contracts/procurementCost';
import { roundPriceIqd } from '@levonis/pricing/priceRounding';
import { parseV2Usd } from '@levonis/pricing/priceV2';

/* ------------------------------------------------------------ the maths -- */

export type FixedUsdAnswer =
  /**
   * The line's offer regular price, and its dollar twin (DECISIONS row 247) when one exists: the typed
   * cents on a direct line, `route − (direct − typed)` in cents on a prepaid route. Absent otherwise.
   */
  | { kind: 'price'; regular_iqd: number; regular_usd_cents?: number }
  /** No sale on this line: the line sells at its regular price, with no strike and no error. */
  | { kind: 'none' }
  /** The route would reach 0 or less: the line does not sell (DERIVED_PRICE_BELOW_FLOOR). */
  | { kind: 'below_floor' };

const NONE: FixedUsdAnswer = { kind: 'none' };

/** A stored rate (decimal text, > 0) as an exact rational, or null. Never a float. */
function rateOf(rate: string | null): ProcurementExact | null {
  if (typeof rate !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(rate.trim())) return null;
  try {
    const exact = procurementExact(rate.trim());
    return exact.num > 0n ? exact : null;
  } catch {
    return null;
  }
}

/** The after price on direct sale: round(cents ÷ 100 × U), exact (`roundPriceIqd`). Null for an unusable input. */
export function usdToIqdCeil(cents: number, rate: string | null): number | null {
  const u = rateOf(rate);
  if (!u || !Number.isSafeInteger(cents) || cents < 1) return null;
  return roundPriceIqd(mulProcurementExact({ num: BigInt(cents), den: 100n }, u));
}

/**
 * ONE LINE'S DOLLAR SALE PRICE (§4.4).
 *
 *  1. No cents, no rate or no direct price: `none` (a model with no row, a SKU
 *     that does not sell direct, a V1 or missing rate, a database without 0197).
 *  2. afterDirect = round(cents/100 × U), exact, by the one rounding rule.
 *  3. afterDirect ≥ the direct price: `none` (D4 — a sale that lowers nothing is
 *     never shown).
 *  4. The saving (positive, whole dinars) comes off the line's own channel:
 *     a direct line (or a COD pre-order priced as direct) pays afterDirect; a
 *     prepaid route pays its published P minus the same saving (PRICING-V2 §5.5).
 *  5. A route at 0 or below: `below_floor`.
 */
export function fixedUsdLine(i: {
  cents: number | null;
  rate: string | null;
  directIqd: number | null;
  channelIqd: number;
  /**
   * THE DOLLAR TWIN (DECISIONS row 247). `direct`: the line is read on the SKU's direct row (a direct
   * sale, or a COD pre-order priced as direct) — its dollar after-price is exactly the typed cents.
   * Otherwise the line is a prepaid route: the same saving comes off the route's own dollars,
   * `channelUsdCents − (directUsdCents − cents)`, when both are known and the result is above zero.
   */
  direct?: boolean;
  directUsdCents?: number | null;
  channelUsdCents?: number | null;
}): FixedUsdAnswer {
  if (i.cents === null || i.rate === null || i.directIqd === null) return NONE;
  if (!Number.isSafeInteger(i.directIqd) || i.directIqd <= 0 || !Number.isSafeInteger(i.channelIqd)) return NONE;
  const afterDirect = usdToIqdCeil(i.cents, i.rate);
  if (afterDirect === null || afterDirect >= i.directIqd) return NONE;
  const saving = i.directIqd - afterDirect;
  const regular = i.channelIqd - saving;
  if (regular < 1) return { kind: 'below_floor' };
  const usd = fixedUsdTwin(i);
  return usd !== null ? { kind: 'price', regular_iqd: regular, regular_usd_cents: usd } : { kind: 'price', regular_iqd: regular };
}

/** The dollar after-price of a `fixed_usd` line (see `fixedUsdLine`), or null when it has no dollar base. */
function fixedUsdTwin(i: { cents: number | null; direct?: boolean; directUsdCents?: number | null; channelUsdCents?: number | null }): number | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
  if (!ok(i.cents)) return null;
  if (i.direct === true) return i.cents;
  if (!ok(i.directUsdCents) || !ok(i.channelUsdCents)) return null;
  const route = i.channelUsdCents - (i.directUsdCents - i.cents);
  return route >= 1 ? route : null;
}

/** D9: the «−N٪» of a saving, rounded to the nearest whole percent; null below 1 or without a before price. */
export function offerSavingPercent(before: number | null | undefined, applied: number): number | null {
  if (typeof before !== 'number' || !(before > 0) || !(applied < before)) return null;
  const p = Math.round(((before - applied) * 100) / before);
  return p >= 1 ? p : null;
}

/* ------------------------------------------------------ dollars as text -- */

/**
 * A typed dollar price → whole cents, by the V2 grammar (`parseV2Usd`): > 0, at
 * most two decimals, ≤ 100,000. Null when the text is not one; a JSON number
 * with a fraction THROWS (RangeError) — it is already a binary float.
 */
export function centsOfUsdText(text: unknown): number | null {
  const exact = parseV2Usd(text);
  if (!exact) return null;
  const cents = (exact.num * 100n) / exact.den;
  if ((exact.num * 100n) % exact.den !== 0n) return null;
  const n = Number(cents);
  return Number.isSafeInteger(n) && n >= 1 && n <= 10_000_000 ? n : null;
}

/** Whole cents → "500.00". */
export function usdTextOfCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

/* ------------------------------------------------------- 0197 presence -- */

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** "no such table: offer_usd_prices" — the deploy-ahead answer. */
export function isMissingOfferUsd(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /no such table:?\s*offer_usd_prices\b/i.test(msg);
}

/** What this binding is known to hold, without asking (true, false for a minute after "absent", or null). */
export function offerUsdKnown(db: object): boolean | null {
  if (PRESENT.has(db)) return true;
  if ((ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return false;
  return null;
}

/**
 * Migration 0197 is on this database. One statement per binding while unknown,
 * none once present; "absent" is re-asked after a minute. Only a missing table
 * is "absent" — any other failure is thrown.
 */
export async function offerUsdInstalled(db: D1Database): Promise<boolean> {
  const known = offerUsdKnown(db);
  if (known !== null) return known;
  try {
    await db.prepare('SELECT 1 AS x FROM offer_usd_prices LIMIT 1').first<{ x: number }>();
    PRESENT.set(db, true);
    return true;
  } catch (e) {
    if (isMissingOfferUsd(e)) {
      ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
      return false;
    }
    throw e;
  }
}

/* ------------------------------------------------------ reads and writes -- */

export interface OfferUsdPrice {
  model_id: string;
  cents: number;
}

const CHUNK = 50;

/**
 * The dollar prices of many subjects (product ids), in one read per 50. A
 * database without 0197 answers an empty map, so those windows price nothing.
 */
export async function loadOfferUsdPrices(db: D1Database, productIds: readonly string[]): Promise<Map<string, OfferUsdPrice[]>> {
  const out = new Map<string, OfferUsdPrice[]>();
  const ids = [...new Set(productIds)];
  if (!ids.length || !(await offerUsdInstalled(db))) return out;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    let rows: Array<{ subject_id: string; model_id: string; price_usd_cents: number }>;
    try {
      rows =
        (
          await db
            .prepare(
              `SELECT subject_id, model_id, price_usd_cents FROM offer_usd_prices
                WHERE subject_type = 'product' AND subject_id IN (SELECT value FROM json_each(?))
                ORDER BY subject_id, model_id`
            )
            .bind(JSON.stringify(part))
            .all<{ subject_id: string; model_id: string; price_usd_cents: number }>()
        ).results ?? [];
    } catch (e) {
      if (isMissingOfferUsd(e)) return out;
      throw e;
    }
    for (const r of rows) {
      const cents = Number(r.price_usd_cents);
      if (!Number.isSafeInteger(cents) || cents < 1) continue;
      const list = out.get(String(r.subject_id)) ?? [];
      list.push({ model_id: String(r.model_id ?? ''), cents });
      out.set(String(r.subject_id), list);
    }
  }
  return out;
}

/**
 * The subject's whole set, REWRITTEN: a DELETE of its rows, then the INSERTs.
 * `set = []` (any mode other than `fixed_usd`) leaves it empty. The caller lays
 * these in its own batch, only when 0197 is installed.
 */
export function offerUsdStatements(db: D1Database, productId: string, set: readonly OfferUsdPrice[]): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM offer_usd_prices WHERE subject_type = 'product' AND subject_id = ?").bind(productId),
    ...set.map((p) =>
      db
        .prepare("INSERT INTO offer_usd_prices (subject_type, subject_id, model_id, price_usd_cents) VALUES ('product', ?, ?, ?)")
        .bind(productId, p.model_id, p.cents)
    ),
  ];
}

/** The SKU row's price for a model: its own row first, else the whole product's '' row, else null. */
export function usdCentsFor(prices: readonly OfferUsdPrice[], modelId: string | null): number | null {
  const own = modelId ? prices.find((p) => p.model_id === modelId) : undefined;
  if (own) return own.cents;
  return prices.find((p) => p.model_id === '')?.cents ?? null;
}
