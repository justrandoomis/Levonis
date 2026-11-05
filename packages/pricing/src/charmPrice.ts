/**
 * THE DOLLAR CHARM PRICE OF AN ESTIMATED SKU (owner decisions 2026-11-05, DECISIONS row 291;
 * docs/SMART_PRICING.md §4.11).
 *
 * The owner, on the smart pricing of estimated products: «dont make 25% on all product . it called the smart
 * pricing so priced from 0% to 25% or 30 or 35 or even 50 and 100», «we want cheap price so we need to become
 * cheapest iraqi supplier», and «make the price for product be like that 9.99$ , 19.99$ 24.99$ and ect …».
 *
 * THE GRID, in whole cents (`isCharmCents`): below $10 every $0.50 ending .49 / .99; $10–$100 every $1 ending
 * .99; $100–$1,000 every $5 ending 4.99 / 9.99; from $1,000 every $10 ending 9.99 — the grid the owner set his
 * own products on that day ($11.99, $18.99, $329.99, $749.99, $1,249.99). A price on it is one cent below a
 * multiple of its band's step; each band's lower bound is a multiple of every smaller step, so the last price of
 * one band ($9.99, $99.99, $999.99) is the one just below the next band's first ($10.99, $104.99, $1,009.99).
 *
 * FROM $5 UP (`CHARM_MIN_USD`). Under $5 the grid's $0.50 step is too coarse for the cheapest prices: 800 IQD at
 * 1,600, a tenth of a $5 price and most of a $0.99 one — at a 10% ceiling a cost of 784–1,334 IQD sold at $0.99 =
 * 1,750 (+31% to +123%) and one of 1,335–2,134 at $1.49 = 2,500. So a charm price is used only at $5 or more ($5.49
 * the lowest), and below that the SKU takes the plain house price under its ceiling (the lead's ruling for the
 * owner, 2026-11-05).
 *
 * THE CHOICE (`charmTarget`), for one SKU — R its exact replacement cost on its route (IQD, the engine's
 * `replacement_exact`), U the USD/IQD the engine prices at, T the type's minimum profit (USD), P the type's
 * profit ceiling (% of cost, 0–100), rp the one rounding rule (`roundPriceIqd`, DECISIONS row 245):
 *
 *     todayD = rp(R + T × U)          the ceiling: nothing ever goes up
 *     capD   = R × (1 + P / 100)      the owner's profit ceiling, not rounded
 *     margin = T_sku × U              the profit over R the price keeps — in DOLLARS, so FX-5 carries it as it is
 *
 *   THE FLOOR. A price is admitted only when its margin covers one rounding step: 250 IQD when the price is above
 *   1,000 IQD, one dinar at or under it (`marginNeededIqd`). Pricing V2's route floor (Q1, priceV2.ts) blocks a route
 *   whose price is not above its own cost rounded up (V2_ROUTE_BELOW_COST), and FX-5 keeps T_sku in dollars between
 *   the owner's applies: with a smaller margin, the next rise of R or U (a rate tick) rounds R up to the very price,
 *   FX-5 holds the product and it keeps selling at its old price — under its new cost. With one step, R + T_sku × U
 *   clears rp(R) whatever R and U do upward, so FX-5 always follows the cost. (A price above rp(R) alone would clear
 *   the route today and close it on the next tick.)
 *
 *   THE CHARM RULE, when the ceiling min(todayD, capD) reaches the dinar price of a charm price of at least $5 —
 *   rp($5.49 × U), 9,000 IQD at 1,600 and 9,500 at 1,690: c is the HIGHEST charm price of at least $5 whose dinar
 *   price is within min(todayD, capD) and whose margin covers the floor; when none is, the LOWEST charm price whose
 *   margin covers it (the ceiling then gives way to the grid, never to the floor).
 *
 *     T_sku = floor6(c − R ÷ U)       USD, six decimals
 *
 *   so the engine's dollar price, ceil6((R + T_sku × U) ÷ U) (`usd_ceil6`, what the storefront's $ shows), is c
 *   exactly — R + T_sku × U sits in (c × U − U ÷ 10⁶, c × U] — and its dinar price is rp(R + T_sku × U), which
 *   is rp(c × U) whenever U is whole dinars (1,600 and 1,690 among them): c × U is then a whole number of
 *   hundredths, and no rounding step lies within U ÷ 10⁶ below it.
 *
 *   THE PLAIN RULE, below that — whenever the ceiling is under $5 × U, and between $5 × U and the dinar price of
 *   $5.49, where the only charm prices under the ceiling are under $5: D is the HIGHEST price on the house rounding
 *   grid (rp's own: whole dinars at or under 1,000 IQD, multiples of 250 above it) within min(todayD, capD) whose
 *   margin covers the floor; when none is, the LOWEST house price whose margin covers it.
 *
 *     T_sku = floor6((D − R) ÷ U)     USD, six decimals
 *
 *   so the engine's dinar price is D exactly — R + T_sku × U sits in (D − U ÷ 10⁶, D], above the house price below D
 *   — and its dollar price is D's own dollar figure, not a charm price. From $5 × U to the dinar price of $5.49 that
 *   figure is $5 or more and off the grid ($5.00 to $5.79 at 1,600): where no house price within the ceiling keeps
 *   the margin, the lowest that does can reach $5.49's own dinar price or one step over it (9,000–9,250 IQD at 1,600,
 *   9,500–9,750 at 1,690) — still cheaper than the lowest charm price that keeps it ($5.99 = 9,750 at 1,600).
 *
 *   THE OWNER'S DIFFERENCES. A cost-first price is R + T × U plus the SKU's own option and colour differences Δ (USD,
 *   the product form's ±), never less than R + T × U (C-9), so only a positive sum Δ⁺ moves it: the engine's price is
 *   rp(R + (T_sku + Δ⁺) × U). The choice is the same with R + Δ⁺ × U in place of R for the price and the dollar price
 *   (T_sku = floor6(c − R ÷ U − Δ⁺), or floor6((D − R) ÷ U − Δ⁺)), the ceiling R × (1 + P / 100) + Δ⁺ × U (his
 *   difference stays on top of it), and the margin (T_sku + Δ⁺) × U. With no difference every figure above is as
 *   written.
 *
 *   One exception keeps a promise the grid cannot, and one rule says what today's own dinar price shows:
 *     - NOTHING GOES UP: when the only admitted price (charm or house) is dearer than today's price while today's
 *       price itself clears the route floor (rp(R)), the type's T stays — today's price exactly, no new rule;
 *     - TODAY'S DINAR PRICE SHOWS c (the lead's ruling for the owner, 2026-11-05, on his «make the price for product
 *       be like that 9.99$ , 19.99$ 24.99$»): a charm price whose dinar price IS today's sells at that very price at
 *       its own T_sku, so the storefront's $ is c. At T it would show today's own figure, ceil(100 × (R ÷ U + T + Δ⁺))
 *       cents, anywhere within one rounding step's worth of c, either side ($69.04 where $68.99 sells at the same
 *       110,500). T_sku is then within that much of T, above or below it, and keeps the margin like any charm price.
 *       T stays only where nothing a customer sees would change — today's own figure already is c, or the price is a
 *       house price (under $5 the dollar figure is its own either way): no new rule for no change — and where T_sku
 *       would pass the $100,000 a rule may carry, a T at that very bound.
 *   No dinar price moves for it at this R and U, and the price is above todayD only when today's own price would not
 *   clear the route floor (T × U under one rounding step): the floor forces it. Past them the two part by (T_sku − T) ×
 *   U: FX-5 keeps T_sku in dollars, so until the next compute and apply such a SKU can sell one rounding step from
 *   where T would, either side. This is one SKU; the planner takes c's profit here only on a product of at most 19 SKUs
 *   (`planEstimateProfits`, ./estimateInputs.ts; docs/SMART_PRICING.md §4.11).
 *
 * Every dinar figure the choice weighs is the engine's own price at that profit — rp(R + (T_sku + Δ⁺) × U) through
 * `roundPriceIqd` — so what it promises is what the engine publishes, for any U. Exact BigInt rationals, never a
 * float; pure, no I/O. The figures are the caller's (the owner's type, the engine's cost and rate): none lives here.
 */
import { procurementExact, type ProcurementExact } from '@levonis/contracts/procurementCost';
import { PRICE_ROUNDING_STEP_IQD, PRICE_ROUNDING_THRESHOLD_IQD, roundPriceIqd } from './priceRounding';

/* ------------------------------------------------------------- the grid -- */

/** One band of the grid: below `below_cents` (the last band has no bound), a price every `step_cents`. */
export interface CharmBand {
  readonly below_cents: number | null;
  readonly step_cents: number;
}

/** The grid's bands, cheapest first. */
export const CHARM_BANDS: readonly CharmBand[] = [
  { below_cents: 1_000, step_cents: 50 },
  { below_cents: 10_000, step_cents: 100 },
  { below_cents: 100_000, step_cents: 500 },
  { below_cents: null, step_cents: 1_000 },
];

/** The lowest charm price on the grid, $0.49. */
export const LOWEST_CHARM_CENTS = 49;

/** The step of the band a whole number of cents falls in. */
function stepAt(cents: number): number {
  for (const b of CHARM_BANDS) if (b.below_cents === null || cents < b.below_cents) return b.step_cents;
  return CHARM_BANDS[CHARM_BANDS.length - 1]!.step_cents;
}

/** Is this whole number of cents a price on the grid? */
export function isCharmCents(cents: number): boolean {
  return Number.isSafeInteger(cents) && cents >= LOWEST_CHARM_CENTS && (cents + 1) % stepAt(cents) === 0;
}

/** The highest charm price at or below `cents` (whole cents), or null below $0.49. */
export function charmAtMostCents(cents: number): number | null {
  if (!Number.isSafeInteger(cents) || cents < LOWEST_CHARM_CENTS) return null;
  const step = stepAt(cents);
  return Math.floor((cents + 1) / step) * step - 1;
}

/** The lowest charm price at or above `cents` (whole cents). */
export function charmAtLeastCents(cents: number): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError('A charm price is a whole number of cents');
  if (cents <= LOWEST_CHARM_CENTS) return LOWEST_CHARM_CENTS;
  const step = stepAt(cents);
  return Math.ceil((cents + 1) / step) * step - 1;
}

/** A whole number of cents as dollar text: 249 → '2.49', 124999 → '1249.99'. */
export function centsText(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('A dollar price is a whole, non-negative number of cents');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * THE LEAST DOLLAR PRICE A CHARM PRICE IS USED AT: $5 (the lead's ruling for the owner, 2026-11-05, DECISIONS row 291).
 * Under it the grid's $0.50 step is too coarse for the cheapest Iraqi prices the owner asked for — 800 IQD at 1,600,
 * a tenth of a $5 price and most of a $0.99 one: at a 10% ceiling a cost of 784–1,334 IQD sold at $0.99 = 1,750 (+31%
 * to +123%), one of 1,335–2,134 at $1.49 = 2,500. So a charm price is at least this — $5.49 the lowest used
 * (`LOWEST_USED_CHARM_CENTS`) — and a price under it is the plain house price under the ceiling, in 250 IQD steps
 * (whole dinars at or under 1,000), its dollar figure whatever it comes to.
 */
export const CHARM_MIN_USD = 5;

/** The lowest charm price the choice uses: the first on the grid at or above `CHARM_MIN_USD`, $5.49. */
export const LOWEST_USED_CHARM_CENTS = charmAtLeastCents(CHARM_MIN_USD * 100);

/* ------------------------------------------------------------ the floor -- */

/**
 * THE MARGIN A PRICE MUST KEEP OVER ITS COST (IQD at U): one rounding step (250) when the price is above 1,000 IQD,
 * one dinar at or under it — the most `roundPriceIqd` can add to a cost there, so a margin this size clears the cost
 * rounded up after any rise of the cost or of U (see the file header).
 */
export function marginNeededIqd(priceIqd: number): number {
  return priceIqd > PRICE_ROUNDING_THRESHOLD_IQD ? PRICE_ROUNDING_STEP_IQD : 1;
}

/* ----------------------------------------------------------- the choice -- */

export interface CharmTargetInput {
  /** R: the SKU's exact replacement cost on its route, IQD (decimal text, ≥ 0). */
  cost_iqd: string;
  /** U: the USD/IQD the engine prices at (decimal text, > 0). */
  usd_iqd: string;
  /** T: the type's minimum profit, USD (decimal text, > 0, at most six decimals). */
  min_profit_usd: string;
  /** P: the type's profit ceiling, % of cost (decimal text, 0 to 100, at most two decimals). */
  ceiling_pct: string;
  /**
   * Δ: the SKU's option and colour differences the engine adds to its price, Σ ± in USD (signed decimal text, at
   * most six decimals; absent or null: none). Only a positive sum moves a cost-first price (C-9).
   */
  difference_usd?: string | null;
}

/**
 * How the SKU's price was chosen: `charm` at the dollar charm price `charm_cents` (at least $5) — today's own dinar
 * price included, which then shows c rather than today's dollar figure; `today` the type's T, today's price exactly
 * (none at or under it that keeps the margin — nothing goes up —, or the chosen price is today's and already shows
 * what it would: a house price, or today's own dollar figure already c; or c's own profit there would pass the $100,000
 * a rule may carry); `plain` under the charm prices, at the house price `price_iqd` (the highest under the ceiling that
 * keeps the margin, else the lowest that keeps it).
 */
export type CharmBasis = 'charm' | 'today' | 'plain';

export interface CharmTarget {
  /** T_sku: the SKU's minimum profit to write, canonical USD (at most six decimals, above 0). */
  amount_usd: string;
  basis: CharmBasis;
  /** c in whole cents (`charm` only). */
  charm_cents: number | null;
  /** The engine's dinar price at T_sku: rp(R + (T_sku + Δ⁺) × U). */
  price_iqd: number;
  /** todayD = rp(R + (T + Δ⁺) × U). */
  today_iqd: number;
  /** The route floor: the smallest price above rp(R) (Q1). Every price chosen clears it, with the margin to spare. */
  floor_iqd: number;
}

const MICRO = 1_000_000n;
/** The largest minimum profit a rule may carry (the 0211 USD6 CHECK): $100,000. */
const MAX_PROFIT_MICRO = 100_000n * MICRO;
const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;
const SIGNED_DECIMAL = /^-?[0-9]+(?:\.[0-9]{1,6})?$/;
const THRESHOLD = BigInt(PRICE_ROUNDING_THRESHOLD_IQD);
const STEP = BigInt(PRICE_ROUNDING_STEP_IQD);

/** Decimal text as an exact rational, with at most `places` decimals when given; null otherwise. */
function decimalOf(raw: unknown, places?: number): ProcurementExact | null {
  if (typeof raw !== 'string') return null;
  const m = DECIMAL.exec(raw);
  if (!m || (places !== undefined && (m[2] ?? '').length > places)) return null;
  return procurementExact(raw);
}

/** Δ⁺: the positive part of a signed sum of differences (absent: none), or null when it does not read. */
function differenceOf(raw: unknown): ProcurementExact | null {
  if (raw === undefined || raw === null) return { num: 0n, den: 1n };
  if (typeof raw !== 'string' || !SIGNED_DECIMAL.test(raw)) return null;
  const d = procurementExact(raw, { signed: true });
  return d.num > 0n ? d : { num: 0n, den: 1n };
}

const floorDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? a / b : -((-a + b - 1n) / b)); // b > 0
const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b); // b > 0

/** The highest house price (rp's own grid: whole dinars to 1,000, then multiples of 250) at or under num ÷ den ≥ 0. */
function housePriceAtMost(num: bigint, den: bigint): number {
  const whole = floorDiv(num, den);
  return Number(whole > THRESHOLD ? (whole / STEP) * STEP : whole);
}

/** Whole micro-dollars as canonical USD text: 202812n → '0.202812', 6000000n → '6'. */
function microText(micro: bigint): string {
  const whole = micro / MICRO;
  const fraction = (micro % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * ONE SKU'S PROFIT UNDER THE CEILING: on the dollar charm grid from $5 up, the plain house price below (see the file
 * header). Null when a figure does not read — a cost, rate, profit, ceiling or difference that is absent where needed,
 * negative, a float, an exponent or out of its grammar — so the caller caps nothing from a guess.
 */
export function charmTarget(input: CharmTargetInput): CharmTarget | null {
  const r = decimalOf(input.cost_iqd);
  const u = decimalOf(input.usd_iqd);
  const t = decimalOf(input.min_profit_usd, 6);
  const p = decimalOf(input.ceiling_pct, 2);
  const d = differenceOf(input.difference_usd);
  if (!r || !u || !t || !p || !d || u.num <= 0n || t.num <= 0n) return null;
  if (p.num > 100n * p.den) return null; // P ≤ 100
  const tMicro = (t.num * MICRO) / t.den; // exact: at most six decimals
  if (tMicro > MAX_PROFIT_MICRO) return null;
  const { num: rn, den: rd } = r;
  const { num: un, den: ud } = u;
  const { num: dn, den: dd } = d; // Δ⁺ ≥ 0

  // B = R + Δ⁺ × U: what the engine adds the profit to.
  const bd = rd * dd * ud;
  const bn = rn * dd * ud + dn * un * rd;
  // The engine's price at a profit of `micro` USD millionths: rp(B + micro × U ÷ 10⁶).
  const den = bd * ud * MICRO;
  const priceAt = (micro: bigint): number => roundPriceIqd({ num: bn * ud * MICRO + micro * un * bd, den });
  // T_sku for a charm price c: floor6(c − B ÷ U), in millionths; below one, no profit — not a price for this SKU.
  const charmMicro = (cents: number): bigint => floorDiv((BigInt(cents) * bd * un - 100n * bn * ud) * 10_000n, bd * un);
  // T_sku for a house price D: floor6((D − B) ÷ U), in millionths; below one, the same.
  const houseMicro = (iqd: number): bigint => floorDiv((BigInt(iqd) * bd - bn) * ud * MICRO, bd * un);
  // The least profit whose margin over R, (micro ÷ 10⁶ + Δ⁺) × U, is at least `iqd` dinars — and at least one millionth.
  const leastWith = (iqd: number): bigint => {
    const x = ceilDiv(BigInt(iqd) * MICRO * dd * ud - dn * MICRO * un, dd * un);
    return x < 1n ? 1n : x;
  };
  const leastAtOrUnder = leastWith(marginNeededIqd(PRICE_ROUNDING_THRESHOLD_IQD));
  const leastAbove = leastWith(marginNeededIqd(PRICE_ROUNDING_THRESHOLD_IQD + 1));
  // Does this profit keep the margin its own price needs?
  const keeps = (micro: bigint): boolean => micro >= (priceAt(micro) > PRICE_ROUNDING_THRESHOLD_IQD ? leastAbove : leastAtOrUnder);

  const todayD = priceAt(tMicro);
  // Today's own dollar figure in whole cents, as the storefront shows it: the engine stores usd_ceil6 = ceil6((B + T ×
  // U) ÷ U) and the storefront rounds that up to the cent (`usdCeilCentsOf`) — two roundings up, which make one:
  // ceil(100 × (B ÷ U + T)).
  const todayCents = (): bigint => ceilDiv(100n * (bn * ud * MICRO + tMicro * bd * un), bd * un * MICRO);
  const costRounded = roundPriceIqd(r);
  const floorD = roundPriceIqd(BigInt(costRounded) + 1n);
  // capD = R × (100 + P) / 100 + Δ⁺ × U, exact: a price x is within it when x × capDen ≤ capNum.
  const capDen = rd * 100n * p.den * dd * ud;
  const capNum = rn * (100n * p.den + p.num) * dd * ud + dn * un * rd * 100n * p.den;
  const fits = (price: number): boolean => price <= todayD && BigInt(price) * capDen <= capNum;
  // The ceiling min(todayD, capD) as a rational, for the searches' first estimates.
  const ceilingIsToday = BigInt(todayD) * capDen <= capNum;
  const [ceilNum, ceilDen] = ceilingIsToday ? [BigInt(todayD), 1n] : [capNum, capDen];

  const result = (micro: bigint, basis: CharmBasis, cents: number | null): CharmTarget | null =>
    micro >= 1n && micro <= MAX_PROFIT_MICRO
      ? { amount_usd: microText(micro), basis, charm_cents: cents, price_iqd: priceAt(micro), today_iqd: todayD, floor_iqd: floorD }
      : null;
  const today = () => result(tMicro, 'today', null);
  // Nothing goes up while today's price clears the route floor (the floor forces a rise only past it).
  const rises = (micro: bigint): boolean => micro > tMicro && todayD > costRounded;
  const guard = { n: 0 };
  const step = () => {
    if (++guard.n > 100_000) throw new RangeError('charmTarget: the grid search did not settle');
  };
  type Choice = { micro: bigint; price: number };
  // The highest price within the ceiling that keeps the margin, else the lowest that keeps it; then the exception, and
  // what today's own dinar price shows.
  const settle = (chosen: Choice, withinCeiling: boolean, basis: 'charm' | 'plain', cents: number | null): CharmTarget | null => {
    // Nothing goes up: today's price clears the floor, so it stays rather than a dearer price.
    if (!withinCeiling && chosen.price > todayD && rises(chosen.micro)) return today();
    if (chosen.price === todayD) {
      // Today's very dinar price. T stays where it already shows what the choice would: a house price (its dollar
      // figure is its own either way), or today's own dollar figure already c — no new rule for no change.
      if (basis === 'plain' || cents === null || BigInt(cents) === todayCents()) return today();
      // Otherwise the same price at c's own profit, so the dollar figure shown becomes c. (Only a T at the $100,000
      // bound can leave T_sku past it: then T, as before.)
      return result(chosen.micro, basis, cents) ?? today();
    }
    return result(chosen.micro, basis, cents);
  };

  // UNDER $5: no charm price of at least CHARM_MIN_USD fits the ceiling (its lowest, $5.49, prices above it) — the
  // plain house price. Every lower house price keeps less margin, so the walk down stops at the first that keeps it,
  // or where the price is no longer above B; the walk up takes a step or two (each adds a dinar or 250 of margin).
  const lowestUsedIqd = roundPriceIqd({ num: BigInt(LOWEST_USED_CHARM_CENTS) * un, den: 100n * ud });
  if (!fits(lowestUsedIqd)) {
    const houseAt = (iqd: number): Choice | null => {
      const micro = houseMicro(iqd);
      return micro >= 1n ? { micro, price: priceAt(micro) } : null;
    };
    for (let iqd = housePriceAtMost(ceilNum, ceilDen); iqd >= 1; iqd = housePriceAtMost(BigInt(iqd - 1), 1n)) {
      step();
      const at = houseAt(iqd);
      if (!at) break; // every lower house price is at or under B too
      if (fits(at.price) && keeps(at.micro)) return settle(at, true, 'plain', null);
    }
    for (let iqd = roundPriceIqd(floorDiv(bn, bd) + 1n); ; iqd = roundPriceIqd(iqd + 1)) {
      step();
      const at = houseAt(iqd);
      if (at && keeps(at.micro)) return settle(at, false, 'plain', null);
    }
  }

  // FROM $5 UP: the engine's price at a charm price, or null where c is not above the SKU's own cost (and difference)
  // in dollars.
  const charmPrice = (cents: number): (Choice & { cents: number }) | null => {
    const micro = charmMicro(cents);
    return micro >= 1n ? { cents, micro, price: priceAt(micro) } : null;
  };

  // 1. The highest charm price of at least $5 within min(todayD, capD) that keeps the margin. Any c at or above `hi`
  //    cents prices above the ceiling (its price is above c × U less a millionth of U), so the walk starts there and
  //    steps down; under the margin the walk goes on down, until c is no longer above the cost or under $5.
  const hi = Number(floorDiv(100n * ceilNum * ud, ceilDen * un)) + 2;
  for (let c = charmAtMostCents(hi); c !== null && c >= LOWEST_USED_CHARM_CENTS; c = charmAtMostCents(c - 1)) {
    step();
    const at = charmPrice(c);
    if (!at) break; // every lower charm price is below the cost too
    if (fits(at.price) && keeps(at.micro)) return settle(at, true, 'charm', at.cents);
  }

  // 2. None: the lowest charm price of at least $5 that keeps the margin. At or below `lo` cents c is not above the
  //    cost, so the walk starts there and steps up (a step or two: every step adds at least $0.50 × U of margin).
  const lo = Number(floorDiv(100n * bn * ud, bd * un));
  for (let c = charmAtLeastCents(Math.max(LOWEST_USED_CHARM_CENTS, lo)); ; c = charmAtLeastCents(c + 1)) {
    step();
    const at = charmPrice(c);
    if (at && keeps(at.micro)) return settle(at, false, 'charm', at.cents);
  }
}

/* --------------------------------------------- a profit another SKU chose -- */

export interface ProfitPrice {
  /** The engine's dinar price at the profit: rp(R + (T_sku + Δ⁺) × U). */
  price_iqd: number;
  /** Its margin over R, (T_sku + Δ⁺) × U, covers that price's rounding step (`marginNeededIqd`). */
  keeps: boolean;
}

/**
 * ONE SKU AT A PROFIT IT DID NOT CHOOSE (the planner's shared rules past the wire's 60 rows, `planEstimateProfits`,
 * §4.11): the engine's dinar price at T_sku USD and whether its margin still covers the floor there — the arithmetic
 * of `charmTarget` (its owner's positive differences Δ⁺ on top) for a profit another SKU's price set. Null when a
 * figure does not read (`charmTarget`'s grammar; the profit above 0, at most six decimals).
 */
export function priceAtProfit(input: Pick<CharmTargetInput, 'cost_iqd' | 'usd_iqd' | 'difference_usd'>, profitUsd: string): ProfitPrice | null {
  const r = decimalOf(input.cost_iqd);
  const u = decimalOf(input.usd_iqd);
  const t = decimalOf(profitUsd, 6);
  const d = differenceOf(input.difference_usd);
  if (!r || !u || !t || !d || u.num <= 0n || t.num <= 0n) return null;
  // The margin over R, (T_sku + Δ⁺) × U = mNum ÷ mDen, and the price rp(R + margin).
  const mNum = (t.num * d.den + d.num * t.den) * u.num;
  const mDen = t.den * d.den * u.den;
  const price = roundPriceIqd({ num: r.num * mDen + mNum * r.den, den: r.den * mDen });
  return { price_iqd: price, keeps: mNum >= BigInt(marginNeededIqd(price)) * mDen };
}
