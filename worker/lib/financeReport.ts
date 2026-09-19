/**
 * THE NUMBERS BEHIND «الأرباح» — the aggregation engine for the owner's
 * financial dashboard. Pure: no Hono, no `Env`, no database handle. It builds
 * SQL TEXT and folds ROWS; the route module (worker/routes/adminFinanceReport
 * .ts) is the only thing here that touches D1, and the test suite runs these
 * same strings against a database built from the real migrations.
 *
 * Everything this file computes is behind the FINANCIAL scope at the route
 * boundary (worker/lib/adminScope.ts, mandate §11: «cost وجميع تفاصيل الربح
 * متاحة فقط للمالك/الدور المالي»). Nothing in this module may be re-exported
 * through a path an assistant admin can reach.
 *
 * ===========================================================================
 * 1. THE RECOGNITION RULE. ONE RULE, FOR THE WHOLE DASHBOARD.
 * ===========================================================================
 *
 * An order placed in January, delivered in February and refunded in March is
 * three different months depending on who is asking. If «مبيعات شباط» on one
 * card and «ربح شباط» on another answered that question differently, the two
 * cards could not be reconciled and the owner would be right not to trust
 * either. So the rule is written here once and every endpoint in this feature
 * obeys it:
 *
 *   REVENUE IS RECOGNISED ON THE BAGHDAD DAY THE ORDER WAS DELIVERED.
 *
 *   - The bucket is `orders.delivered_at`, converted to a Baghdad calendar day
 *     (§2). Not `created_at`, not `stage_changed_at`.
 *   - An order that is not `status = 'delivered'` contributes NOTHING. Not
 *     pending, not confirmed, not processing, not shipped. Those are a
 *     BACKLOG, not income, and this shop is cash-on-delivery: until the parcel
 *     is at the door and the money is collected, there is no sale. A dashboard
 *     that books a shipped order as profit books the profit of every order
 *     that is later refused at the door.
 *   - A CANCELLED order is never revenue and never cost. `status='cancelled'`
 *     is excluded by the same `status='delivered'` test.
 *   - A REFUND is a NEW, NEGATIVE EVENT in ITS OWN period — the Baghdad day of
 *     `return_cases.decided_at`, for a case that reached
 *     `state='resolved' AND resolution='refund'`. It does NOT reach back and
 *     rewrite the month the order was delivered in.
 *
 * WHY A REFUND DOES NOT REWRITE THE ORIGINAL MONTH. This is the property that
 * makes the dashboard usable at all: ONCE A PERIOD HAS PASSED, ITS NUMBERS DO
 * NOT MOVE. The owner can screenshot «ربح آب» and find the same figure in
 * December. If a March refund retro-reduced February, every closed month would
 * keep drifting behind the owner's back — which is exactly the defect that
 * `order_items` carrying no cost column already causes for profit, and which
 * this whole feature exists to end. The refund is still visible: it is
 * reported on its own row (`refunded_revenue_iqd`) inside the period it was
 * decided in, so «ليش ربح آذار أقل؟» has an answer on the same screen.
 *
 * WHAT A PARTIAL REFUND DOES. `return_cases.qty` is the returned quantity, so
 * a partial return reverses exactly its own fraction of the line: the line's
 * recognised revenue and the line's cost, both scaled by `qty / line qty`. The
 * rest of the line stays revenue. A refund therefore makes an order PARTLY
 * revenue, which is what it is.
 *
 * REFUNDED GOODS COME BACK, SO THEIR COST COMES BACK TOO. worker/routes/
 * returns.ts restores the stock through the inventory ledger when a case is
 * resolved as a refund, so the units are on the shelf again and their cost is
 * no longer a cost of goods SOLD. Reversing the revenue without reversing the
 * cost would print a loss on every return that never happened.
 *
 * THE REVERSAL USES THIS REPORT'S OWN REVENUE BASIS, NOT THE WALLET AMOUNT.
 * returns.ts credits the customer `caseGross` minus a PROPORTIONAL share of
 * the order-level coupon and points, and does not refund shipping. That is the
 * money that left. This report reverses the revenue it RECOGNISED (§3), which
 * differs by the points share — and points are already accounted once, at the
 * period level, as `points_redeemed_iqd`. Reversing on the recognition basis is
 * what keeps `revenue − refunds` reconcilable line by line; reversing on the
 * wallet basis would double-count the points reversal.
 *
 * DELIVERED WITH NO `delivered_at`. `orders.delivered_at` is only written from
 * migration 0002 onwards and both writers guard it with
 * `COALESCE(NULLIF(delivered_at,''), …)`, so a legacy row can be
 * `status='delivered'` with NULL or ''. Such an order belongs to no day and is
 * therefore in NO bucket. It is not silently dropped: `unrecognized_orders` in
 * the response metadata counts them, because "these N delivered orders are in
 * no month" is information the owner needs and a silently short total is not.
 *
 * ===========================================================================
 * 2. BAGHDAD, NEVER UTC.
 * ===========================================================================
 *
 * Iraq is UTC+3 all year. SQLite's `date('now')` is UTC, so the three hours
 * from 00:00 to 03:00 Baghdad fall on the previous UTC day — and at a month
 * end that is a whole night of orders filed under the wrong month. A financial
 * report that is wrong for one night in thirty is not a report.
 *
 * Two mechanisms, and they must agree:
 *
 *   FILTERING is done on ISO instants computed in TypeScript by
 *   `utcWindowFor()` from `BAGHDAD_OFFSET_MS` (worker/lib/baghdadTime.ts). The
 *   Baghdad day D runs from `D-1T21:00:00.000Z` to `DT21:00:00.000Z`. No SQL
 *   timezone is involved in deciding which rows are in range, and the stored
 *   timestamps are fixed-width ISO strings, so the comparison is the same
 *   lexicographic `>=`/`<` that baghdadTime.ts was built around.
 *
 *   BUCKETING is `date(<column>, '+3 hours')` in SQL, because the alternative
 *   is pulling every row into the Worker to bucket it there (§4 says why that
 *   is not allowed). The literal is `BAGHDAD_SQL_SHIFT`, derived from the same
 *   `BAGHDAD_OFFSET_MS` constant, so the two mechanisms cannot drift apart.
 *   `tests/financeReport.test.ts` asserts the SQL bucket equals
 *   `baghdadDayOf()` for instants either side of midnight Baghdad.
 *
 * `date()` returns NULL for a timestamp it cannot parse, and a NULL GROUP BY
 * key would quietly merge such rows into a bucket nobody looks at. Every
 * bucket expression is `COALESCE(date(…), '')`, and `''` is surfaced as
 * `unbucketed_*` in the metadata instead of being treated as a day.
 *
 * ===========================================================================
 * 3. WHAT "REVENUE" MEANS HERE, EXACTLY.
 * ===========================================================================
 *
 * `Σ order_items.line_total_iqd = orders.subtotal_iqd` (worker/routes/orders
 * .ts:938) and that subtotal is GROSS: the order-level coupon, the points and
 * the membership saving are deducted after it, in their own columns. But
 * migrations 0074 and 0077 also froze, PER LINE, what the membership and the
 * coupon actually took off THAT line — precisely so a refund would not have to
 * prorate. This report uses those frozen per-line figures:
 *
 *   line revenue = line_total_iqd − coupon_discount_iqd − membership_discount_iqd
 *
 * Exact integers, no allocation, no division — so the per-product breakdown and
 * the period total are the same arithmetic and agree to the dinar.
 *
 * WHAT IS DELIBERATELY *NOT* IN LINE REVENUE, and is reported separately at
 * the period level because it belongs to no product:
 *
 *   `points_discount_iqd` — order-level only, with no per-line freeze. It is a
 *     loyalty liability being settled, not a price cut on one product;
 *     splitting it across lines would need a division whose rounded parts
 *     would not re-add to the order's own column. It is subtracted in NET
 *     profit (§5), never inside gross.
 *   THE ORDER-LEVEL COUPON — `coupon_snapshot.discount_iqd`, falling back to
 *     `orders.coupon_discount_iqd` for a merchant-store order, which is the
 *     only writer of that column. Migration 0077 added
 *     `order_items.coupon_discount_iqd` precisely so a coupon COULD be
 *     attributed to the line it hit, and NOTHING IN THE CODEBASE WRITES IT
 *     YET — checkout's `INSERT INTO order_items` does not name the column. So
 *     the two can never double-count today, and the order-level figure is the
 *     whole truth. The day a writer lands, the per-line subtraction above
 *     starts carrying part of it and THIS expression must become the residual;
 *     `tests/financeReport.test.ts` seeds an order with both set and asserts
 *     which one wins, so the change cannot go unnoticed.
 *   `shipping_iqd` and `cod_tax_iqd` — money collected for delivery and for the
 *     courier's cash-handling fee. The matching outgoings are OPERATING
 *     EXPENSES the owner enters in the panel, so both sides meet in NET profit,
 *     never in a product's margin.
 *
 * THE MEMBERSHIP SAVING IS DIFFERENT, AND IS SUBTRACTED PER LINE. Checkout
 * writes `order_items.membership_discount_iqd` from `benefits.byLine`, and
 * `orders.membership_discount_iqd` is the SUM of exactly those per-line values
 * — so subtracting both would take the same saving off twice. Only the line
 * column is read here.
 *
 * ONLY LEVONIS'S OWN SALES. `orders.seller_type = 'levonis'` is part of the
 * recognition filter. A merchant-store order's goods are the MERCHANT's stock:
 * their cost is the merchant's business and this shop's income on it is the
 * commission already recorded on the order (`platform_fee_iqd`), not the
 * merchandise. Counting the full basket as revenue would inflate this shop's
 * sales by other people's takings — and with no cost to set against it, would
 * print it all as profit.
 *
 * ===========================================================================
 * 4. BUNDLES: THE MONEY IS ON THE PARENT, THE GOODS ARE ON THE COMPONENTS.
 * ===========================================================================
 *
 * A composition checkout writes one PARENT line carrying the whole bundle
 * price and one line per COMPONENT with `line_total_iqd = 0` naming the real
 * product (worker/routes/orders.ts §6.2). Summing `line_total_iqd` over every
 * line is therefore already correct for revenue — components contribute zero.
 *
 * COST is the opposite: the component rows name the products that were
 * actually taken off the shelf, and the parent names the bundle. Migration 0095
 * settles it in the data — a parent is `cost_basis = 'composed'` and its cost
 * is ZERO BY CONSTRUCTION, "even when the owner typed one on the bundle
 * product: the components are the goods, and recording both would double-count
 * them". Zero and not NULL, so the parent still counts as COSTED: its cost IS
 * measured, on other rows, and treating it as unknown would drop every bundle's
 * revenue out of the margin base.
 *
 * `units` counts only non-parent lines. A parent's `qty` is a number of
 * bundles and its components' `qty` are pieces; adding both counts the same
 * goods twice in a figure the owner reads as "how many things did we sell".
 *
 * A COMPONENT'S REFUND REVERSES `component_alloc_iqd`, not its own
 * `line_total_iqd` — which is 0, so reversing that would reverse nothing while
 * the goods went back on the shelf. `component_alloc_iqd` is the component's
 * share of the parent's line total by largest-remainder allocation, with
 * `Σ alloc = line_total_iqd` EXACTLY (worker/routes/orders.ts:1531), so a
 * reversal can never exceed the parent's recognised revenue. returns.ts uses
 * the same column for the same reason.
 *
 * ===========================================================================
 * 5. TWO PROFITS. THEY ARE NEVER MERGED.
 * ===========================================================================
 *
 * The owner's own model: «التكلفه على مستوى واحد في تفاصيل المنتج، لكن يستطيع
 * الادمن في لوحه الاداره اضافه تكاليف اخرى ... لا علاقه لها بالمنتج الاساسي».
 * Product cost is cost of goods sold. The other costs — rent, salaries,
 * advertising, a shipping contract, customs, fees — belong to no product.
 *
 *   GROSS PROFIT = revenue − cost of goods sold        per period AND per product
 *   NET PROFIT   = gross profit
 *                  + shipping collected + COD tax collected
 *                  − points redeemed − order-level coupons
 *                  − operating expenses                        per period ONLY
 *
 * There is no per-product net profit and there will not be one. An operating
 * expense row belongs to no product, so splitting December's rent across the
 * products that happened to sell in December is an invention, and an invented
 * number on a financial screen is worse than a missing one. The API simply does
 * not carry the field.
 *
 * ===========================================================================
 * 6. MEASURED COST, ESTIMATED COST, AND UNKNOWN COST.
 * ===========================================================================
 *
 * `order_items` carried NO cost column: the order snapshot strips `cost_iqd`
 * deliberately so the cost cannot reach the customer (worker/routes/orders.ts
 * :1183, :1248 and :2234 — three separate strips, all correct for their own
 * purpose). The consequence was that the cost AT THE MOMENT OF SALE was
 * recorded nowhere, so profit could only be computed against the product's cost
 * TODAY — and editing a supplier price rewrote last month's profit. Migration
 * 0095 (track A) adds `cost_iqd` AND `cost_basis`, and `cost_basis` is the
 * estimate flag this module must carry through every aggregation:
 *
 *   'snapshot'   MEASURED. `cost_iqd` is the cost resolved at the instant of
 *                sale. Profit computed from it is a FACT and repricing the
 *                supplier tomorrow cannot move it.
 *   'composed'   A bundle PARENT. Its COGS is ZERO BY CONSTRUCTION — the goods
 *                are its component rows, which carry their own snapshots (§4).
 *                Counted as measured, contributing no cost.
 *   'unpriced'   UNKNOWN, and RECORDED as unknown: the sale-time resolver
 *                walked every rung and found nothing. 0095 forbids estimating
 *                it, and this module obeys — the owner typed that cost AFTER
 *                the sale, so applying it backwards invents a margin that never
 *                existed.
 *   'unrecorded' Every row older than 0095. ESTIMATED against
 *                `products.product_cost_iqd` as it stands TODAY, and counted in
 *                `estimated_lines`, `estimated_units` and `estimated_cogs_iqd`,
 *                with `estimated: true` on the bucket. A dashboard that mixes
 *                measured and estimated profit without saying so is the one
 *                defect this flag exists to prevent. An 'unrecorded' row whose
 *                product has no cost either — or whose product was deleted — is
 *                UNKNOWN, not zero. Zero cost means 100% margin, which would be
 *                a lie told confidently.
 *
 * WHAT HAPPENS TO AN UNKNOWN-COST LINE. Its revenue is counted in
 * `revenue_iqd` — it really was sold — but it is EXCLUDED from the margin
 * base. Gross profit is `costed_revenue_iqd − cogs_iqd`: both sides of the
 * subtraction describe the same lines. The excluded part is reported in full
 * (`uncosted_revenue_iqd`, `uncosted_units`, `uncosted_lines`) so the owner can
 * see how much of the business the margin does not speak for, and go and enter
 * the missing costs. Treating unknown as zero inflates margin; dropping the
 * revenue silently under-reports sales; this does neither.
 *
 * THE ESTIMATE IS THE PRODUCT RUNG AND ONLY THE PRODUCT RUNG. The option and
 * colour rungs live in relational tables (0018, 0073) and resolving them needs
 * the price resolver, not a join, so a query-level guess at which rung applied
 * is a guess dressed as a measurement. That is `costProjectionSql`'s own
 * documented choice in worker/lib/financeLedger.ts, and this module embeds THAT
 * expression rather than writing a second one — two copies of the cost rule
 * would one day print two different profits for one month.
 *
 * ===========================================================================
 * 7. D1's LIMITS ARE THE DESIGN, NOT AN AFTERTHOUGHT.
 * ===========================================================================
 *
 * More than 100 bound parameters is REFUSED, which is why this codebase chunks
 * id lists at 90 (worker/lib/stockAlerts.ts and four other call sites). A
 * report over a year of orders can therefore never be "collect the ids, then
 * query with an IN list" — and it is not.
 *
 *   EVERY query here binds exactly TWO parameters (a window start and end),
 *   plus one LIMIT on the breakdowns. Three at most. The number of bound
 *   parameters does not grow with the size of the shop, the length of the
 *   range, or the number of products.
 *
 *   AGGREGATION HAPPENS IN SQLITE. `GROUP BY` the Baghdad DAY, and only the
 *   day: weeks, months and whole-range totals are folded from those day rows
 *   here in TypeScript, exactly (§8). So one query returns at most one row per
 *   day in the window — `MAX_RANGE_DAYS` caps a request at 366 days and the
 *   comparison window doubles that, so no query can return more than ~732 rows
 *   whatever the shop's size. A shop with 50,000 order lines returns the same
 *   ~732 rows as a shop with 50.
 *
 *   QUERY COUNT PER REQUEST. `/summary`: six — sales by day, refunds by day,
 *   order-level collections by day, operating expenses by day, operating
 *   expenses by category, and one COUNT of delivered orders that carry no
 *   `delivered_at`. `/products` and `/categories`: two each (sales and
 *   refunds).
 *
 *   PLUS ONE `PRAGMA table_info` PROBE, and only while the deployment is ahead
 *   of its database. A Worker is live before its migrations run — that is a
 *   normal minute of every deploy — so the route asks whether 0095's columns
 *   are actually there rather than assuming, exactly as worker/lib/
 *   productDeletion.ts does. Once they are present the answer can never change
 *   again (SQLite cannot drop a column and this repository's migrations are
 *   additive only), so it is cached for the life of the isolate and a warm
 *   request is back to six queries. The cache is deliberately one-way: a
 *   NEGATIVE answer is re-probed every time, so the report starts reporting
 *   real costs the moment 0095 lands instead of waiting for the isolate to
 *   recycle.
 *
 *   ONE JOIN PER LINE, AND NOT ONE MORE. On the current schema a bundle parent
 *   is named by `cost_basis = 'composed'`, so the only join a line query needs
 *   is `products` for the estimate fallback and the category ids. The
 *   pre-0095 fallback path adds a derived table of parent item ids — one pass
 *   over a sparse column, joined once per query and never correlated per row —
 *   and that path disappears the moment the migration lands.
 *
 * ===========================================================================
 * 8. INTEGER MONEY, AND ONE DIVISION AT THE VERY END.
 * ===========================================================================
 *
 * Dinars are integers everywhere in this codebase and they stay integers here.
 * Every sum, every reversal, every bucket fold is integer addition, so the
 * parts always re-add to the total exactly — a month is the exact sum of its
 * days and a range is the exact sum of its months, with nothing left over.
 *
 * A MARGIN IS A RATIO AND IS COMPUTED ONCE, at the last step, from the two
 * integers it describes. Percentages are NEVER accumulated: averaging the
 * daily margins of a day with one sale and a day with two hundred would give
 * the small day equal weight. `marginPercent()` is the only floating-point
 * arithmetic in this module, it never feeds another sum, and it returns NULL
 * rather than 0 when there is no base — because "no sales" and "0% margin" are
 * different sentences.
 *
 * The one place a division touches money is a PARTIAL refund's share of a line
 * (`net × returned_qty / line_qty`), done in SQLite integer arithmetic, which
 * truncates. A partial return of a line therefore reverses at most 1 IQD less
 * than the exact fraction, never more, so a refund can never reverse more
 * revenue than was recognised. A full-line return — every qty returned — is
 * exact with no division at all.
 */

import { BAGHDAD_OFFSET_MS, addDays, dayOfWeek, dayParts, isDay } from './baghdadTime';
// THE COST RULE IS TRACK A'S, NOT A SECOND COPY OF IT — see `costProjection`
// below. `financeLedger.ts` is a pure library of strings and validators, so
// importing it keeps this module free of Hono and of `Env`.
import { COST_BASIS, costConfidenceSql, costValueSql } from './financeLedger';

// ---------------------------------------------------------------- constants

/** The recognition rule's machine name. Echoed in every response so a screen,
 *  an export or a screenshot can say which rule produced the number. */
export const RECOGNITION_RULE = 'delivered_baghdad_day' as const;

/** The timezone every bucket boundary in this module is computed in. */
export const REPORT_TIMEZONE = 'Asia/Baghdad' as const;

/**
 * The SQL modifier that shifts a UTC timestamp to Baghdad civil time, derived
 * from the SAME constant `utcWindowFor()` filters with. Written as an
 * expression rather than the literal `'+3 hours'` so that the day a second
 * offset appears anywhere — a DST law, a second country — this cannot be the
 * copy that was forgotten.
 */
export const BAGHDAD_SQL_SHIFT = `+${BAGHDAD_OFFSET_MS / 3_600_000} hours`;

/**
 * The longest range one request may ask for, in days.
 *
 * Not a performance guess: it is the bound that makes §7's promise true. A
 * request is answered together with the preceding period of equal length, so
 * the widened window is twice this, and every query's result set is capped at
 * roughly that many rows no matter how large the shop is. A year plus the leap
 * day is what "compare this year against last year" needs.
 */
export const MAX_RANGE_DAYS = 366;

/** The rows a breakdown returns before it says it truncated. */
export const MAX_BREAKDOWN_ROWS = 200;

export type Granularity = 'day' | 'week' | 'month' | 'range';

export const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month', 'range'];

/**
 * The bucket key for a day that SQLite could not parse into one.
 *
 * `date()` answers NULL for a malformed timestamp and a NULL GROUP BY key is
 * invisible. Every bucket expression coalesces to this instead, and the
 * response reports how many rows and how many dinars landed here, so a corrupt
 * `delivered_at` shows up as a number on the screen rather than as a quietly
 * missing sale.
 */
export const UNBUCKETED = '';

// ------------------------------------------------------------------- ranges

/** An inclusive span of Baghdad calendar days. */
export interface DayRange {
  /** First day, inclusive, 'YYYY-MM-DD'. */
  from: string;
  /** Last day, inclusive, 'YYYY-MM-DD'. */
  to: string;
  /** How many days the span covers, inclusive of both ends. */
  days: number;
}

/** Whole days between two day strings, inclusive, or null if either is not a day. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayParts(from);
  const b = dayParts(to);
  if (!a || !b) return null;
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Validate a requested range, or explain why it cannot be served.
 *
 * Returns a discriminated result rather than throwing: this module is pure and
 * has no HttpError to throw, and the route turns `error` into a 400 with the
 * same message. `MAX_RANGE_DAYS` is enforced HERE, once, so no endpoint can
 * forget it and no endpoint can quietly raise it.
 */
export function resolveRange(from: unknown, to: unknown): { range: DayRange } | { error: string } {
  if (!isDay(from) || !dayParts(from as string)) return { error: 'from must be a YYYY-MM-DD Baghdad day' };
  if (!isDay(to) || !dayParts(to as string)) return { error: 'to must be a YYYY-MM-DD Baghdad day' };
  const days = daysBetween(from as string, to as string);
  if (days === null) return { error: 'from and to must both be real calendar days' };
  if (days <= 0) return { error: 'from must be on or before to' };
  if (days > MAX_RANGE_DAYS) return { error: `range is limited to ${MAX_RANGE_DAYS} days` };
  return { range: { from: from as string, to: to as string, days } };
}

/**
 * The period of EQUAL LENGTH immediately before this one.
 *
 * Equal length and not "the previous calendar month", because a comparison
 * only means something when the two sides are the same size: 28 days against
 * 31 makes February look like a bad month every year. The previous period ends
 * the day before this one starts, so the two never overlap and no order is
 * counted on both sides.
 */
export function previousRangeOf(range: DayRange): DayRange {
  const to = addDays(range.from, -1);
  const from = addDays(to, -(range.days - 1));
  return { from, to, days: range.days };
}

/**
 * The UTC instants bounding a span of BAGHDAD days: `[start, end)`.
 *
 * Baghdad day D begins at D−1 21:00 UTC. `end` is EXCLUSIVE and is the start
 * of the day after `to`, so an order delivered at 23:59:59.999 Baghdad on the
 * last day is inside and one delivered at 00:00:00.000 the next day is not.
 * Half-open on purpose: an inclusive upper bound would need a "last
 * representable instant" and would include or exclude a millisecond depending
 * on how many fractional digits the writer happened to use.
 */
export function utcWindowFor(range: DayRange): { startIso: string; endIso: string } {
  const a = dayParts(range.from);
  const b = dayParts(range.to);
  if (!a || !b) return { startIso: '', endIso: '' };
  const start = Date.UTC(a.y, a.m - 1, a.d) - BAGHDAD_OFFSET_MS;
  const end = Date.UTC(b.y, b.m - 1, b.d) + 86_400_000 - BAGHDAD_OFFSET_MS;
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

/**
 * The bucket a Baghdad day belongs to, at a given granularity.
 *
 * WEEKS START ON SATURDAY. The Iraqi working week runs Sunday to Thursday, so
 * Saturday is the first day of the week here and the weekend is not split
 * across two buckets. `dayOfWeek` is 0 = Sunday, 6 = Saturday, so the shift
 * back to Saturday is `(dow + 1) % 7`.
 *
 * A month bucket is the 'YYYY-MM' prefix, which is safe BECAUSE the day string
 * was already converted to Baghdad — slicing a UTC instant would be the
 * three-hour bug this whole module exists to avoid.
 */
export function bucketKeyOf(day: string, granularity: Granularity): string {
  if (day === UNBUCKETED || !isDay(day)) return UNBUCKETED;
  if (granularity === 'range') return 'range';
  if (granularity === 'month') return day.slice(0, 7);
  if (granularity === 'week') {
    const dow = dayOfWeek(day);
    return dow < 0 ? UNBUCKETED : addDays(day, -((dow + 1) % 7));
  }
  return day;
}

/** Every bucket key a range covers, in order, including the empty ones. An
 *  empty day is a real answer — a chart with a gap in it lies about the gap. */
export function bucketKeysFor(range: DayRange, granularity: Granularity): string[] {
  if (granularity === 'range') return ['range'];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < range.days; i += 1) {
    const day = addDays(range.from, i);
    const key = bucketKeyOf(day, granularity);
    if (key === UNBUCKETED || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

// -------------------------------------------------------------------- facts

/** One day's worth of delivered sales, straight out of the sales GROUP BY. */
export interface SaleFact {
  day: string;
  orders: number;
  lines: number;
  units: number;
  revenue_iqd: number;
  costed_revenue_iqd: number;
  uncosted_revenue_iqd: number;
  cogs_iqd: number;
  costed_units: number;
  uncosted_units: number;
  uncosted_lines: number;
  estimated_lines: number;
  estimated_units: number;
  estimated_cogs_iqd: number;
}

/** One day's worth of resolved refunds, in the period they were decided in. */
export interface RefundFact {
  day: string;
  cases: number;
  units: number;
  revenue_iqd: number;
  costed_revenue_iqd: number;
  cogs_iqd: number;
  /**
   * THE DISCLOSURE FIGURES A REFUND ALSO REVERSES.
   *
   * `costed_revenue + uncosted_revenue = revenue` is an invariant the screen
   * prints line by line, and it broke the moment a refund subtracted from one
   * side and not the other: an uncosted line sold for 200,000 and fully
   * refunded left the period reading `revenue 0` with `uncosted_revenue
   * 200,000`, and the honesty panel then told the owner that 200,000 د.ع of a
   * zero-revenue period had no known cost. The same for the estimate badge,
   * which stayed lit for a period whose only estimated sale had come back.
   *
   * The two LINE counts are reversed only on a FULL return (`ref_qty >=
   * line_qty`) because a partly returned line is still a sale line; the units
   * and the money are proportional and are reversed as such.
   */
  uncosted_revenue_iqd: number;
  uncosted_units: number;
  uncosted_lines: number;
  estimated_lines: number;
  estimated_units: number;
  estimated_cogs_iqd: number;
}

/** One day's order-level collections — the money that belongs to no product. */
export interface OrderFact {
  day: string;
  orders: number;
  shipping_iqd: number;
  cod_tax_iqd: number;
  points_iqd: number;
  coupon_iqd: number;
}

/** One day's operating expenses, from the admin's own ledger. */
export interface ExpenseFact {
  day: string;
  entries: number;
  amount_iqd: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const dayOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v : '';
  return isDay(s) ? s : UNBUCKETED;
};

export const saleFactOf = (r: Record<string, unknown>): SaleFact => ({
  day: dayOf(r.day),
  orders: num(r.orders),
  lines: num(r.lines),
  units: num(r.units),
  revenue_iqd: num(r.revenue_iqd),
  costed_revenue_iqd: num(r.costed_revenue_iqd),
  uncosted_revenue_iqd: num(r.uncosted_revenue_iqd),
  cogs_iqd: num(r.cogs_iqd),
  costed_units: num(r.costed_units),
  uncosted_units: num(r.uncosted_units),
  uncosted_lines: num(r.uncosted_lines),
  estimated_lines: num(r.estimated_lines),
  estimated_units: num(r.estimated_units),
  estimated_cogs_iqd: num(r.estimated_cogs_iqd),
});

export const refundFactOf = (r: Record<string, unknown>): RefundFact => ({
  day: dayOf(r.day),
  cases: num(r.cases),
  units: num(r.units),
  revenue_iqd: num(r.revenue_iqd),
  costed_revenue_iqd: num(r.costed_revenue_iqd),
  cogs_iqd: num(r.cogs_iqd),
  uncosted_revenue_iqd: num(r.uncosted_revenue_iqd),
  uncosted_units: num(r.uncosted_units),
  uncosted_lines: num(r.uncosted_lines),
  estimated_lines: num(r.estimated_lines),
  estimated_units: num(r.estimated_units),
  estimated_cogs_iqd: num(r.estimated_cogs_iqd),
});

export const orderFactOf = (r: Record<string, unknown>): OrderFact => ({
  day: dayOf(r.day),
  orders: num(r.orders),
  shipping_iqd: num(r.shipping_iqd),
  cod_tax_iqd: num(r.cod_tax_iqd),
  points_iqd: num(r.points_iqd),
  coupon_iqd: num(r.coupon_iqd),
});

export const expenseFactOf = (r: Record<string, unknown>): ExpenseFact => ({
  day: dayOf(r.day),
  entries: num(r.entries),
  amount_iqd: num(r.amount_iqd),
});

/**
 * One category's share of a period's operating expenses.
 *
 * Not folded into the day buckets, and deliberately: a category total per DAY would
 * be one row per category per day, which is the only place in this feature
 * where the result set would grow with the shop rather than with the calendar.
 * The owner's question is «وين راحت الفلوس هذا الشهر», which is one number per
 * category for the WHOLE range — so it is queried once, for the requested
 * period only, and never for the comparison window.
 */
export interface ExpenseCategoryTotal {
  id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  entries: number;
  amount_iqd: number;
}

export const expenseCategoryTotalOf = (r: Record<string, unknown>): ExpenseCategoryTotal => ({
  id: (r.category_id as string | null) ?? null,
  slug: String(r.slug ?? ''),
  name_ar: String(r.name_ar ?? ''),
  name_en: String(r.name_en ?? ''),
  name_ckb: String(r.name_ckb ?? ''),
  entries: num(r.entries),
  amount_iqd: num(r.amount_iqd),
});

// ------------------------------------------------------------------ the SQL

/**
 * What the deployment found when it looked at the database.
 *
 * A Worker can be live BEFORE its migrations have run — that is a normal
 * minute of every deploy, and worker/lib/cartLineProjection.ts already carries
 * the precedent for surviving it. Migration 0095 adds `order_items.cost_iqd`,
 * `order_items.cost_basis` AND the `operating_expenses` ledger in one file, so
 * one flag describes all of it: either the finance schema is there or none of
 * it is.
 *
 * `has0095` false means every cost is an ESTIMATE against today's catalogue,
 * which the response says out loud rather than pretending the profit is
 * measured, and net profit equals gross profit with
 * `operating_expenses_available: false` beside it — not a silent zero that
 * reads as «ما صرفنا شي».
 */
export interface SchemaFacts {
  /** Migration 0095 has been applied. */
  has0095: boolean;
}

/**
 * The joins every line-level query shares.
 *
 * ON THE CURRENT SCHEMA THERE IS ONE JOIN. `cost_basis = 'composed'` names a
 * bundle PARENT row outright, so nothing has to be discovered by looking for
 * rows that point at it.
 *
 * BEFORE 0095 there is no such column, and a bundle parent can only be found
 * by the rows that name it as their parent — hence the `par` derived table.
 * It is joined, not correlated: one pass over a sparse column instead of one
 * subquery per row. Without it a bundle whose PRODUCT happens to carry a cost
 * would have that cost counted once on the parent and again on every
 * component, charging the same goods twice.
 */
const lineJoins = (schema: SchemaFacts): string => `
       LEFT JOIN products p ON p.id = i.product_id
       LEFT JOIN (${KIDS_SQL(schema)}) kids ON kids.pid = i.id
       LEFT JOIN (${MYSTERY_SPOOL_SQL}) mys ON mys.oiid = i.id
       LEFT JOIN products mp ON mp.id = mys.offer_product_id`;

/**
 * WHICH MYSTERY OFFER A SPOOL ROW BELONGS TO — the one fact that stops a
 * mystery box reporting as free goods on the per-product screen.
 *
 * THE DEFECT, precisely. A mystery box is two kinds of `order_items` row: the
 * PARENT, which carries the money and whose `product_id` is the offer, and one
 * SPOOL row per drawn filament, whose `product_id` is bound NULL on purpose so
 * the pick cannot leak through the order (worker/routes/orders.ts §7.7). Since
 * migration 0096 the spool row also carries the COST of what was drawn. But
 * `salesByProductSql` groups on `l.product_id`, so those two halves of one sale
 * landed in two different groups: the offer's own product row showed its whole
 * revenue against a parent cost of zero — 100% gross margin, the exact figure
 * the owner would price a promotion against — while every mystery cost the shop
 * ever paid piled up in a single nameless NULL group beside it that reads as
 * pure loss. The period TOTAL was right all along; every breakdown built from
 * it was wrong in both directions at once.
 *
 * So a spool row is attributed to the offer it was sold under. That id is on
 * `mystery_allocations.offer_product_id`, frozen at the draw, and it is the
 * same id the parent row carries — which is what makes revenue and cost meet
 * in one group again.
 *
 * WHY A GROUPED DERIVED TABLE AND NOT A PLAIN JOIN. `mystery_allocations` is
 * keyed `(order_item_id, spool_index)`, so the TABLE permits several rows per
 * order item even though the checkout writes exactly one. A plain LEFT JOIN
 * would therefore be one duplicated line away from double-counting REVENUE on
 * every query in this module, which is the worst thing this file could do.
 * `GROUP BY order_item_id` makes one row per order item a property of the
 * QUERY rather than a property of today's checkout, so no future writer can
 * turn a dashboard into a revenue-doubling machine. `MIN(offer_product_id)` is
 * a deterministic pick, not a judgement: every spool of one line is drawn for
 * one offer.
 *
 * It costs one grouped scan of a table that holds one row per spool ever sold,
 * answered from `idx_mystery_alloc_item_offer` (0096) without touching the
 * rows. That is strictly cheaper than the `kids` scan beside it, which walks
 * the whole of `order_items`.
 *
 * NO COST AND NO PRODUCT IDENTITY CROSSES THIS JOIN — only the OFFER's id,
 * which the customer already knows they bought. The drawn `product_id`,
 * `color_id` and the snapshots stay where `mysteryReveal.ts` guards them, so
 * widening this join can never become a reveal leak.
 */
const MYSTERY_SPOOL_SQL = `
         SELECT a.order_item_id AS oiid, MIN(a.offer_product_id) AS offer_product_id
           FROM mystery_allocations a
          GROUP BY a.order_item_id`;

/**
 * WHAT A BUNDLE'S COMPONENTS KNOW ABOUT THEIR OWN COST, rolled up to the
 * parent that holds the money.
 *
 * This derived table replaces the `SELECT DISTINCT bundle_parent_item_id`
 * that used to live on the pre-0095 path only, and it is now on BOTH paths.
 * Two separate defects made that necessary and neither is hypothetical:
 *
 *   1. A PARENT IS NOT ALWAYS `cost_basis = 'composed'`. Every row written
 *      before migration 0095 carries the ALTER's DEFAULT `'unrecorded'`, and
 *      bundle parents are no exception. Naming parents by the column alone
 *      therefore stopped recognising every HISTORICAL bundle: its cost was
 *      estimated from the BUNDLE product's own `product_cost_iqd` — the very
 *      cost migration 0095 deliberately refuses to record — while each
 *      component was estimated from its own, charging the same physical goods
 *      twice, and its `qty` (a number of BUNDLES) was added to `units` beside
 *      its components' pieces. `kids.pid IS NOT NULL` names a parent by the
 *      only fact that is true in every schema: other rows point at it.
 *
 *   2. A PARENT'S COST IS ONLY AS KNOWN AS ITS COMPONENTS' COSTS. Booking a
 *      parent at zero cost is sound ONLY when the goods are costed on the
 *      component rows, and for a bundle whose component product has no
 *      `product_cost_iqd` they are not. The components' own `line_total_iqd`
 *      is 0 (the money is on the parent), so excluding THEM from the margin
 *      base costs nothing, and the parent's whole revenue was landing in
 *      `costed_revenue_iqd` against zero COGS: a 200,000 IQD box read as 100%
 *      gross margin with an "uncosted" notice announcing one line worth
 *      0 د.ع. That is the single most confident lie this screen could tell.
 *
 *      A MYSTERY BOX USED TO BE PERMANENTLY IN THAT CASE and is not any more.
 *      Its spool rows carried no cost and their `product_id` is NULL by design
 *      (docs §7.7), so the roll-up below read `unknown` and the box's revenue
 *      went to `uncosted_revenue_iqd` — honest, but an answer the owner could
 *      never act on. The owner has since ruled that the draw is a real stock
 *      movement — «المخزون يؤخذ من البيع المباشر أو الطلب المسبق
 *      ويصبح كمباع واللون والخيار يسحب، يعني له تكلفة» — so migration 0096
 *      freezes the drawn filament's cost onto the spool row's own
 *      `order_items.cost_iqd` at the instant of the draw. The roll-up needs no
 *      special case for it: a costed spool is `recorded` like any other
 *      component, and a pool nobody priced writes `unpriced`, which is still
 *      `unknown` here. Nothing about this rule changed — only what the spool
 *      rows know.
 *
 * So the roll-up is the WORST confidence among the components — 2 recorded,
 * 1 estimated, 0 unknown — and `costProjection` turns a 0 into a NULL unit
 * cost, which is what puts the parent's revenue in `uncosted_revenue_iqd`
 * where the screen already knows how to disclose it.
 *
 * It costs one join over a sparse column, once per query, with no bound
 * parameters and no correlation per row. That is the price of not reporting a
 * margin that never existed, and it is cheap.
 */
const KIDS_SQL = (schema: SchemaFacts): string => `
         SELECT k.bundle_parent_item_id AS pid,
                MIN(CASE (${schema.has0095
                  ? costConfidenceSql('k', 'kp')
                  : `CASE WHEN kp.product_cost_iqd IS NULL THEN 'unknown' ELSE 'estimated' END`})
                      WHEN 'recorded' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END) AS worst
           FROM order_items k
           LEFT JOIN products kp ON kp.id = k.product_id
          WHERE k.bundle_parent_item_id IS NOT NULL
          GROUP BY k.bundle_parent_item_id`;

/**
 * THE COST RULE, BORROWED RATHER THAN REWRITTEN.
 *
 * `costProjectionSql` lives in worker/lib/financeLedger.ts and its own comment
 * says it is "THE SQL TRACK B EMBEDS, so no screen invents its own rule for
 * this". Importing it is the point: a second copy of the four-way `cost_basis`
 * rule here is a second thing to update, and the day the two disagree is the
 * day the dashboard and the ledger screen report different profits for the
 * same month. That import is also why this module reaches into another lib at
 * all — the expressions are plain strings and the file stays pure.
 *
 * It yields two expressions:
 *   `unit_cost_iqd`   the cost of ONE unit, or NULL when it is UNKNOWN. A
 *                     bundle PARENT is 0 only when its components are all
 *                     costed — its goods are those rows, and a parent booked
 *                     at zero against goods nobody priced reports 100% margin
 *                     (see `KIDS_SQL`). When any component is unknown the
 *                     parent is NULL, which is «لا نعرف», not «بلا تكلفة».
 *   `cost_confidence` 'recorded' | 'estimated' | 'unknown' — a fact, a guess
 *                     against TODAY's catalogue, and "we cannot say", which
 *                     the screen must render as three different things. A
 *                     parent inherits the WORST of its components': a bundle
 *                     whose pieces were priced from today's catalogue is an
 *                     estimate too, and saying otherwise would launder a guess
 *                     into a measurement by wrapping it in a bundle.
 *
 * An `unpriced` line is NULL and is never estimated. Migration 0095 states why
 * and this module obeys it: the sale-time resolver found no cost, the owner
 * typed one AFTERWARDS, and applying it backwards invents a margin that never
 * existed. That is also why the estimate for an `unrecorded` line uses ONLY
 * `products.product_cost_iqd` and never the option or colour rungs — resolving
 * those needs the resolver, not a join, and a rung-level guess is a guess
 * dressed as a measurement.
 */
const costProjection = (schema: SchemaFacts): string => {
  const own = schema.has0095
    ? { value: costValueSql('i', 'p'), confidence: costConfidenceSql('i', 'p') }
    : {
        value: 'p.product_cost_iqd',
        confidence: `CASE WHEN p.product_cost_iqd IS NULL THEN 'unknown' ELSE 'estimated' END`,
      };
  return `
    CASE WHEN (${isParentSql(schema)})
         THEN CASE WHEN COALESCE(kids.worst, 0) = 0 THEN NULL ELSE 0 END
         ELSE ${own.value} END AS unit_cost_iqd,
    CASE WHEN (${isParentSql(schema)})
         THEN CASE WHEN COALESCE(kids.worst, 0) = 0 THEN 'unknown'
                   WHEN kids.worst = 1 THEN 'estimated'
                   ELSE 'recorded' END
         ELSE ${own.confidence} END AS cost_confidence`;
};

/**
 * Is this line a composition PARENT — money here, goods on other rows (§4)?
 *
 * NAMED BY ITS CHILDREN FIRST, by its own column second. `cost_basis =
 * 'composed'` is the fact checkout writes TODAY; `kids.pid IS NOT NULL` is the
 * fact that is true of every bundle ever sold, including the ones that predate
 * migration 0095 and therefore carry the ALTER's `'unrecorded'` default. Both
 * are tested because either alone lets a real bundle through as an ordinary
 * line — and an unrecognised parent has its own product cost charged on top of
 * its components' (§4 again, from the other direction).
 */
const isParentSql = (schema: SchemaFacts): string =>
  schema.has0095
    ? `i.cost_basis = '${COST_BASIS.composed}' OR kids.pid IS NOT NULL`
    : 'kids.pid IS NOT NULL';

/**
 * The money one line is worth to the shop.
 *
 * `line_total_iqd` is GROSS of the order-level coupon, points and membership
 * (worker/routes/orders.ts:938 — `Σ line_total_iqd = orders.subtotal_iqd`), but
 * migrations 0074 and 0077 froze PER LINE what the membership and the coupon
 * actually took off THAT line, precisely so a refund would not have to prorate.
 * Subtracting those two frozen integers is exact — no division, no allocation —
 * which is what lets the per-product column and the period total agree to the
 * dinar. `MAX(0, …)` because a discount larger than the line it sits on would
 * otherwise make revenue negative, and negative revenue on a sale is never the
 * truth about the sale; it is a bad row.
 */
const NET_LINE_IQD = `MAX(0, COALESCE(i.line_total_iqd, 0)
                - COALESCE(i.coupon_discount_iqd, 0)
                - COALESCE(i.membership_discount_iqd, 0))`;

/**
 * The same figure for a REFUND, which prefers `component_alloc_iqd` (§4). A
 * bundle component's own `line_total_iqd` is 0 — the money is on the parent —
 * so reversing that would reverse nothing while the goods went back on the
 * shelf. `Σ component_alloc_iqd = the parent's line_total_iqd` EXACTLY
 * (worker/routes/orders.ts:1531), so a reversal can never exceed what was
 * recognised. worker/routes/returns.ts uses the same column for the same reason.
 */
const NET_REFUND_IQD = `MAX(0, COALESCE(i.component_alloc_iqd, i.line_total_iqd, 0)
                  - COALESCE(i.coupon_discount_iqd, 0)
                  - COALESCE(i.membership_discount_iqd, 0))`;

/**
 * The per-line facts both the day report and the breakdowns are built on.
 *
 * `COALESCE(i.product_id, mys.offer_product_id)` IS THE MYSTERY RULE (see
 * `MYSTERY_SPOOL_SQL`): a spool row has no product of its own by design, so it
 * is filed under the OFFER it was drawn for — the same group its parent's
 * revenue is in. Ordinary rows are untouched, and a row that is neither
 * (a deleted product) still groups under NULL exactly as it always did.
 *
 * The category falls back the same way and for the same reason. Without it the
 * per-category screen would repeat the per-product lie one rung up: the
 * mystery box's revenue in its own category, its cost in a nameless one.
 */
const lineSelect = (schema: SchemaFacts): string => `
         o.id AS order_id,
         COALESCE(i.product_id, mys.offer_product_id) AS product_id,
         COALESCE(p.category_id, mp.category_id) AS category_id,
         COALESCE(p.sub_category_id, mp.sub_category_id) AS sub_category_id,
         i.qty AS qty,
         (${isParentSql(schema)}) AS is_parent,
         ${NET_LINE_IQD} AS net_iqd,
         ${costProjection(schema)}`;

/**
 * The aggregate columns, written once because the day report, the product
 * breakdown and the category breakdown must not be able to disagree about what
 * "revenue" or "estimated" mean. `l` is the line CTE.
 *
 * A `composed` parent reads as COSTED with a cost of zero: §4 explains why it
 * is neither uncosted (its cost is measured, on the component rows) nor a
 * contributor to COGS (that would charge the same goods twice). It is excluded
 * from `units` and from `costed_units` for the same reason — its `qty` is a
 * number of BUNDLES and its components' are pieces, and adding both counts the
 * same goods twice in a figure the owner reads as "how many things did we sell".
 */
const LINE_AGGREGATES = `
       COUNT(DISTINCT l.order_id) AS orders,
       COUNT(*) AS lines,
       SUM(CASE WHEN l.is_parent THEN 0 ELSE l.qty END) AS units,
       SUM(l.net_iqd) AS revenue_iqd,
       SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN 0 ELSE l.net_iqd END) AS costed_revenue_iqd,
       SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN l.net_iqd ELSE 0 END) AS uncosted_revenue_iqd,
       SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN 0 ELSE l.unit_cost_iqd * l.qty END) AS cogs_iqd,
       SUM(CASE WHEN l.unit_cost_iqd IS NULL OR l.is_parent THEN 0 ELSE l.qty END) AS costed_units,
       SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN l.qty ELSE 0 END) AS uncosted_units,
       SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN 1 ELSE 0 END) AS uncosted_lines,
       SUM(CASE WHEN l.cost_confidence = 'estimated' THEN 1 ELSE 0 END) AS estimated_lines,
       SUM(CASE WHEN l.cost_confidence = 'estimated' THEN l.qty ELSE 0 END) AS estimated_units,
       SUM(CASE WHEN l.cost_confidence = 'estimated'
                THEN l.unit_cost_iqd * l.qty ELSE 0 END) AS estimated_cogs_iqd`;

/**
 * THE RECOGNITION FILTER, written once (§1). Every sales query in this feature
 * uses this exact WHERE so no endpoint can quietly recognise a different set of
 * orders. Two bound parameters: the window start and the exclusive end.
 *
 * `delivered_at >= ?` also excludes the `''` a legacy row can carry, because
 * the empty string sorts before every ISO instant. Those rows are counted
 * separately by `UNRECOGNIZED_ORDERS_SQL`.
 */
export const DELIVERED_WHERE = `o.status = 'delivered' AND o.seller_type = 'levonis'
       AND o.delivered_at >= ? AND o.delivered_at < ?`;

/**
 * THE REFUND FILTER, and it joins back to the ORDER on purpose.
 *
 * A refund may only reverse revenue that was RECOGNISED. A case resolved
 * against an order that was cancelled before delivery, or against a merchant's
 * own order, would otherwise subtract money this report never added — turning a
 * return nobody was ever charged for into a loss. `o2` therefore repeats the
 * recognition test (§1) with no date bound: the SALE may be in any period, it
 * is the DECISION that belongs to this one. Binds: startIso, endIso.
 */
export const REFUND_WHERE = `rc.state = 'resolved' AND rc.resolution = 'refund'
       AND o2.status = 'delivered' AND o2.seller_type = 'levonis'
       AND o2.delivered_at IS NOT NULL AND o2.delivered_at <> ''
       AND rc.decided_at >= ? AND rc.decided_at < ?`;

/** The join every refund query needs to make `REFUND_WHERE` answerable. */
const REFUND_ORDER_JOIN = `
      JOIN orders o2 ON o2.id = rc.order_id`;

/** Sales, grouped by the Baghdad day of delivery. Binds: startIso, endIso. */
export const salesByDaySql = (schema: SchemaFacts): string => `
  WITH l AS (
    SELECT COALESCE(date(o.delivered_at, '${BAGHDAD_SQL_SHIFT}'), '') AS day,
    ${lineSelect(schema)}
      FROM orders o
      JOIN order_items i ON i.order_id = o.id${lineJoins(schema)}
     WHERE ${DELIVERED_WHERE}
  )
  SELECT l.day AS day,${LINE_AGGREGATES}
    FROM l GROUP BY l.day`;

/**
 * Refunds, grouped by the Baghdad day the case was RESOLVED (§1).
 *
 * `MIN(rc.qty, i.qty)` fences a case whose quantity somehow exceeds the line it
 * belongs to, so a reversal can never exceed what was recognised, and
 * `MAX(1, i.qty)` is the divide-by-zero guard: `order_items.qty` has a
 * `CHECK (qty > 0)`, but a division by a column is the one place where "the
 * constraint says it cannot happen" is not a reason to let the whole financial
 * screen fail. Binds: startIso, endIso.
 */
export const refundsByDaySql = (schema: SchemaFacts): string => `
  WITH r AS (
    SELECT COALESCE(date(rc.decided_at, '${BAGHDAD_SQL_SHIFT}'), '') AS day,
           MIN(rc.qty, i.qty) AS ref_qty,
           MAX(1, i.qty) AS line_qty,
           ${NET_REFUND_IQD} AS net_iqd,
           ${costProjection(schema)}
      FROM return_cases rc
      JOIN order_items i ON i.id = rc.order_item_id${REFUND_ORDER_JOIN}${lineJoins(schema)}
     WHERE ${REFUND_WHERE}
  )
  SELECT r.day AS day,${REFUND_AGGREGATES}
    FROM r GROUP BY r.day`;

/** The refund aggregates, on the same basis as the sale they reverse. */
const REFUND_AGGREGATES = `
         COUNT(*) AS cases,
         SUM(r.ref_qty) AS units,
         SUM(r.net_iqd * r.ref_qty / r.line_qty) AS revenue_iqd,
         SUM(CASE WHEN r.unit_cost_iqd IS NULL THEN 0
                  ELSE r.net_iqd * r.ref_qty / r.line_qty END) AS costed_revenue_iqd,
         SUM(CASE WHEN r.unit_cost_iqd IS NULL THEN 0
                  ELSE r.unit_cost_iqd * r.ref_qty END) AS cogs_iqd,
         SUM(CASE WHEN r.unit_cost_iqd IS NULL
                  THEN r.net_iqd * r.ref_qty / r.line_qty ELSE 0 END) AS uncosted_revenue_iqd,
         SUM(CASE WHEN r.unit_cost_iqd IS NULL THEN r.ref_qty ELSE 0 END) AS uncosted_units,
         SUM(CASE WHEN r.unit_cost_iqd IS NULL AND r.ref_qty >= r.line_qty THEN 1 ELSE 0 END) AS uncosted_lines,
         SUM(CASE WHEN r.cost_confidence = 'estimated' AND r.ref_qty >= r.line_qty THEN 1 ELSE 0 END) AS estimated_lines,
         SUM(CASE WHEN r.cost_confidence = 'estimated' THEN r.ref_qty ELSE 0 END) AS estimated_units,
         SUM(CASE WHEN r.cost_confidence = 'estimated'
                  THEN r.unit_cost_iqd * r.ref_qty ELSE 0 END) AS estimated_cogs_iqd`;

/**
 * Order-level collections, on the SAME recognition rule as the lines so the
 * two can be added without asking a second question. Binds: startIso, endIso.
 */
export const ORDERS_BY_DAY_SQL = `
  SELECT COALESCE(date(o.delivered_at, '${BAGHDAD_SQL_SHIFT}'), '') AS day,
         COUNT(*) AS orders,
         SUM(COALESCE(o.shipping_iqd, 0)) AS shipping_iqd,
         SUM(COALESCE(o.cod_tax_iqd, 0)) AS cod_tax_iqd,
         SUM(COALESCE(o.points_discount_iqd, 0)) AS points_iqd,
         SUM(COALESCE(json_extract(o.coupon_snapshot, '$.discount_iqd'), o.coupon_discount_iqd, 0)) AS coupon_iqd
    FROM orders o
   WHERE ${DELIVERED_WHERE}
   GROUP BY day`;

/**
 * Delivered orders that belong to no day at all (§1). Bound to nothing: it is
 * a property of the whole table, and a range-scoped count would be impossible
 * — the rows have no date to scope by.
 */
export const UNRECOGNIZED_ORDERS_SQL = `
  SELECT COUNT(*) AS orders
    FROM orders o
   WHERE o.status = 'delivered' AND o.seller_type = 'levonis'
     AND (o.delivered_at IS NULL OR o.delivered_at = '')`;

/**
 * Operating expenses by Baghdad day.
 *
 * `expense_day` is ALREADY a Baghdad day string, which is the whole reason
 * migration 0095 stores a day rather than a timestamp: an expense is something
 * a person says happened on a date, not an instant, and re-deriving a day from
 * an instant is one more chance to be three hours wrong. So this query needs no
 * timezone arithmetic and compares days lexicographically — inclusive at BOTH
 * ends, unlike the instant windows above, because a day string IS the bucket.
 *
 * `voided_at IS NULL` LEADS the predicate to match
 * `idx_operating_expenses_live_day(voided_at, expense_day)`, and it is not
 * optional: 0095 makes a deletion a VOID precisely so an already-reported net
 * profit can be reproduced, and a report that counted voided rows would undo
 * that. Binds: fromDay, toDay.
 */
export const EXPENSES_BY_DAY_SQL = `
  SELECT expense_day AS day, COUNT(*) AS entries, SUM(COALESCE(amount_iqd, 0)) AS amount_iqd
    FROM operating_expenses
   WHERE voided_at IS NULL AND expense_day >= ? AND expense_day <= ?
   GROUP BY expense_day`;

/**
 * The same expenses broken down by the owner's own categories.
 *
 * One number called «المصاريف» tells the owner that net profit fell and
 * nothing about why. The categories are rows the owner named themselves
 * (`expense_categories`, 0095), in three languages, so the client calls
 * `loc(ar, en, ckb)` and the server never decides that a Kurdish reader gets
 * Arabic. A LEFT JOIN, so an expense whose category was somehow removed still
 * appears with its money rather than vanishing from a total that must reconcile
 * with the day rows. Binds: fromDay, toDay.
 */
export const EXPENSES_BY_CATEGORY_SQL = `
  SELECT e.category_id AS category_id,
         c.slug AS slug, c.name_ar AS name_ar, c.name_en AS name_en, c.name_ckb AS name_ckb,
         COUNT(*) AS entries, SUM(COALESCE(e.amount_iqd, 0)) AS amount_iqd
    FROM operating_expenses e
    LEFT JOIN expense_categories c ON c.id = e.category_id
   WHERE e.voided_at IS NULL AND e.expense_day >= ? AND e.expense_day <= ?
   GROUP BY e.category_id
   ORDER BY amount_iqd DESC`;

/**
 * Sales grouped by PRODUCT, over the whole range at once — no day column, so
 * the result is one row per product that sold, not one per product per day.
 * Binds: startIso, endIso, limit.
 *
 * `GROUP BY l.product_id` keeps a NULL product_id as its own group, because a
 * deleted product leaves the column behind and that group is real revenue —
 * returned with a null id rather than dropped.
 *
 * A MYSTERY SPOOL IS NO LONGER IN THAT GROUP. It still stores NULL on the row
 * (worker/routes/orders.ts §7.7 — that NULL is what keeps the pick out of every
 * customer payload, and it is not negotiable), but `lineSelect` now resolves it
 * to the OFFER it was drawn for through `mystery_allocations`. So the box's
 * revenue (on its parent) and the filament's cost (on its spools, frozen by
 * migration 0096) are counted in ONE product group instead of two, and this
 * screen stops showing a mystery box at 100% margin beside a nameless bucket of
 * pure loss.
 */
export const salesByProductSql = (schema: SchemaFacts): string => `
  WITH l AS (
    SELECT ${lineSelect(schema)}
      FROM orders o
      JOIN order_items i ON i.order_id = o.id${lineJoins(schema)}
     WHERE ${DELIVERED_WHERE}
  )
  SELECT l.product_id AS product_id,
         MAX(pr.name) AS name_en,
         MAX(pr.name_ar) AS name_ar,
         MAX(pr.slug) AS slug,
         MAX(l.category_id) AS category_id,
         MAX(l.sub_category_id) AS sub_category_id,${LINE_AGGREGATES}
    FROM l LEFT JOIN products pr ON pr.id = l.product_id
   GROUP BY l.product_id
   ORDER BY revenue_iqd DESC
   LIMIT ?`;

/** Refunds grouped by product, same range, same basis. Binds: startIso, endIso. */
export const refundsByProductSql = (schema: SchemaFacts): string => `
  WITH r AS (
    -- THE SAME COALESCE AS \`lineSelect\`, AND FOR THE SAME REASON. A spool row
    -- binds \`product_id\` NULL so the pick cannot leak, so a refund touching one
    -- grouped under NULL while the SALE of that same row grouped under the
    -- offer. The join is already here — this query interpolates \`lineJoins\`
    -- and is already paying for the \`mys\`/\`mp\` scan — so the only thing the
    -- old projection bought was two queries encoding two different rules for
    -- one row. Practically inert today, because a return case is opened
    -- against the bundle PARENT; the next person to open one against a spool
    -- would have got a silent mismatch rather than an error.
    SELECT COALESCE(i.product_id, mys.offer_product_id) AS product_id,
           MIN(rc.qty, i.qty) AS ref_qty,
           MAX(1, i.qty) AS line_qty,
           ${NET_REFUND_IQD} AS net_iqd,
           ${costProjection(schema)}
      FROM return_cases rc
      JOIN order_items i ON i.id = rc.order_item_id${REFUND_ORDER_JOIN}${lineJoins(schema)}
     WHERE ${REFUND_WHERE}
  )
  SELECT r.product_id AS product_id,
         MAX(pr.name) AS name_en,
         MAX(pr.name_ar) AS name_ar,
         MAX(pr.slug) AS slug,${REFUND_AGGREGATES}
    FROM r LEFT JOIN products pr ON pr.id = r.product_id
   GROUP BY r.product_id`;

/**
 * Sales grouped by CATEGORY. `level` picks the rung: 'main' groups on
 * `products.category_id`, 'sub' on `products.sub_category_id`. Both are
 * `catalogs` rows, so the names come from one join either way, in all three
 * languages — the client calls `loc(ar, en, ckb)` and this must not decide for
 * it. Binds: startIso, endIso, limit.
 */
export const salesByCategorySql = (schema: SchemaFacts, level: 'main' | 'sub'): string => {
  const col = level === 'sub' ? 'sub_category_id' : 'category_id';
  return `
  WITH l AS (
    SELECT ${lineSelect(schema)}
      FROM orders o
      JOIN order_items i ON i.order_id = o.id${lineJoins(schema)}
     WHERE ${DELIVERED_WHERE}
  )
  SELECT l.${col} AS category_id,
         MAX(c.name_ar) AS name_ar,
         MAX(c.name_en) AS name_en,
         MAX(c.name_ckb) AS name_ckb,
         MAX(c.slug) AS slug,${LINE_AGGREGATES}
    FROM l LEFT JOIN catalogs c ON c.id = l.${col}
   GROUP BY l.${col}
   ORDER BY revenue_iqd DESC
   LIMIT ?`;
};

/** Refunds grouped by the same category rung. Binds: startIso, endIso. */
export const refundsByCategorySql = (schema: SchemaFacts, level: 'main' | 'sub'): string => {
  const col = level === 'sub' ? 'sub_category_id' : 'category_id';
  return `
  WITH r AS (
    SELECT p.${col} AS category_id,
           MIN(rc.qty, i.qty) AS ref_qty,
           MAX(1, i.qty) AS line_qty,
           ${NET_REFUND_IQD} AS net_iqd,
           ${costProjection(schema)}
      FROM return_cases rc
      JOIN order_items i ON i.id = rc.order_item_id${REFUND_ORDER_JOIN}${lineJoins(schema)}
     WHERE ${REFUND_WHERE}
  )
  SELECT r.category_id AS category_id,
         MAX(c.name_ar) AS name_ar,
         MAX(c.name_en) AS name_en,
         MAX(c.name_ckb) AS name_ckb,
         MAX(c.slug) AS slug,${REFUND_AGGREGATES}
    FROM r LEFT JOIN catalogs c ON c.id = r.category_id
   GROUP BY r.category_id`;
};

// ---------------------------------------------------------------- the totals

/** Everything one bucket is worth. Every field an integer number of dinars. */
export interface Totals {
  /** Sales revenue recognised in this bucket, before refunds. */
  gross_revenue_iqd: number;
  /** Revenue reversed by refunds DECIDED in this bucket (§1). */
  refunded_revenue_iqd: number;
  /** `gross_revenue − refunded_revenue`. The headline «المبيعات». */
  revenue_iqd: number;
  /** The part of `revenue_iqd` whose cost is known, measured or estimated. */
  costed_revenue_iqd: number;
  /** The part whose cost is UNKNOWN and which the margin does not speak for. */
  uncosted_revenue_iqd: number;
  /** Cost of goods sold, net of the cost of goods that came back. */
  cogs_iqd: number;
  /** Cost reversed by refunds — the goods went back on the shelf. */
  refunded_cogs_iqd: number;
  /** `costed_revenue − cogs`. Both sides describe the same lines (§6). */
  gross_profit_iqd: number;
  /** Gross profit over costed revenue, as a percentage, or null with no base. */
  gross_margin_percent: number | null;
  /** Delivery charged to the customer. Belongs to no product (§3). */
  shipping_collected_iqd: number;
  /** The cash-on-delivery fee collected. Belongs to no product (§3). */
  cod_tax_collected_iqd: number;
  /** Points spent by customers, 1 point = 1 IQD. A settled liability (§3). */
  points_redeemed_iqd: number;
  /** Order-level coupon discounts. Belongs to no product today (§3). */
  coupon_discount_iqd: number;
  /** The admin's own operating expenses for this bucket (§5). */
  operating_expenses_iqd: number;
  /** Gross + collections − points − opex. Period-level only (§5). */
  net_profit_iqd: number;
  /** Net profit over costed revenue plus collections, or null with no base. */
  net_margin_percent: number | null;
  /** Delivered orders recognised in this bucket. */
  orders: number;
  /** Order lines, bundle parents included. */
  lines: number;
  /** Physical units, bundle parents excluded (§4). */
  units: number;
  /** Units returned by refunds decided in this bucket. */
  refunded_units: number;
  /** Refund cases decided in this bucket. */
  refund_cases: number;
  /** Expense entries in this bucket. */
  expense_entries: number;
  /** True when ANY line here priced its cost from the catalogue, not a snapshot. */
  estimated: boolean;
  estimated_lines: number;
  estimated_units: number;
  estimated_cogs_iqd: number;
  /** Lines and units whose cost is unknown, excluded from the margin base. */
  uncosted_lines: number;
  uncosted_units: number;
}

const zeroTotals = (): Totals => ({
  gross_revenue_iqd: 0,
  refunded_revenue_iqd: 0,
  revenue_iqd: 0,
  costed_revenue_iqd: 0,
  uncosted_revenue_iqd: 0,
  cogs_iqd: 0,
  refunded_cogs_iqd: 0,
  gross_profit_iqd: 0,
  gross_margin_percent: null,
  shipping_collected_iqd: 0,
  cod_tax_collected_iqd: 0,
  points_redeemed_iqd: 0,
  coupon_discount_iqd: 0,
  operating_expenses_iqd: 0,
  net_profit_iqd: 0,
  net_margin_percent: null,
  orders: 0,
  lines: 0,
  units: 0,
  refunded_units: 0,
  refund_cases: 0,
  expense_entries: 0,
  estimated: false,
  estimated_lines: 0,
  estimated_units: 0,
  estimated_cogs_iqd: 0,
  uncosted_lines: 0,
  uncosted_units: 0,
});

/**
 * A ratio, computed ONCE from two integers, at the very last step (§8).
 *
 * NULL and not 0 when the base is zero or negative: a period with no costed
 * sales has no margin, and printing «٠٪» on it invites the owner to compare a
 * quiet month against a bad one as if they were the same thing. Two decimal
 * places, rounded once, and the result never feeds another sum.
 */
export function marginPercent(profit: number, base: number): number | null {
  if (!Number.isFinite(profit) || !Number.isFinite(base) || base <= 0) return null;
  return Math.round((profit * 10_000) / base) / 100;
}

/**
 * Close a bucket: derive everything that is a difference or a ratio.
 *
 * Called once per bucket after all the integer accumulation is done, which is
 * what guarantees a month equals the exact sum of its days. Deriving
 * `gross_profit` inside the fold instead would be the same arithmetic, but a
 * later edit could start rounding inside the loop, and then the parts would
 * stop adding to the whole.
 */
function seal(t: Totals): Totals {
  t.revenue_iqd = t.gross_revenue_iqd - t.refunded_revenue_iqd;
  t.gross_profit_iqd = t.costed_revenue_iqd - t.cogs_iqd;
  t.gross_margin_percent = marginPercent(t.gross_profit_iqd, t.costed_revenue_iqd);
  t.net_profit_iqd =
    t.gross_profit_iqd +
    t.shipping_collected_iqd +
    t.cod_tax_collected_iqd -
    t.points_redeemed_iqd -
    t.coupon_discount_iqd -
    t.operating_expenses_iqd;
  t.net_margin_percent = marginPercent(
    t.net_profit_iqd,
    t.costed_revenue_iqd + t.shipping_collected_iqd + t.cod_tax_collected_iqd
  );
  /**
   * THE COUNTS CANNOT GO BELOW ZERO, AND THE MONEY IS ALLOWED TO.
   *
   * A refund is recognised in the period it was DECIDED in (§1), so a return
   * resolved this month against a sale delivered last month subtracts a line
   * this bucket never counted. For the MONEY that is correct and deliberate —
   * `revenue_iqd` itself goes negative in a month that only took returns, and
   * `uncosted_revenue_iqd` must move with it or `costed + uncosted = revenue`
   * stops holding. For a COUNT it is meaningless: «−١ سطر» is not a fact about
   * anything, so the disclosure counts are floored at zero here, once, after
   * all the accumulation — never inside the fold, where flooring a day would
   * stop the days adding up to the month.
   */
  t.uncosted_units = Math.max(0, t.uncosted_units);
  t.uncosted_lines = Math.max(0, t.uncosted_lines);
  t.estimated_lines = Math.max(0, t.estimated_lines);
  t.estimated_units = Math.max(0, t.estimated_units);
  t.estimated_cogs_iqd = Math.max(0, t.estimated_cogs_iqd);
  t.estimated = t.estimated_lines > 0;
  return t;
}

function addSale(t: Totals, f: SaleFact): void {
  t.gross_revenue_iqd += f.revenue_iqd;
  t.costed_revenue_iqd += f.costed_revenue_iqd;
  t.uncosted_revenue_iqd += f.uncosted_revenue_iqd;
  t.cogs_iqd += f.cogs_iqd;
  t.orders += f.orders;
  t.lines += f.lines;
  t.units += f.units;
  t.estimated_lines += f.estimated_lines;
  t.estimated_units += f.estimated_units;
  t.estimated_cogs_iqd += f.estimated_cogs_iqd;
  t.uncosted_lines += f.uncosted_lines;
  t.uncosted_units += f.uncosted_units;
}

/**
 * A refund is SUBTRACTED from the same three accumulators the sale added to,
 * so `revenue`, `costed_revenue` and `cogs` stay one consistent basis, and is
 * ALSO recorded on its own fields so the owner can decompose the drop.
 * Recording it only as a subtraction would leave «ليش ربح آذار أقل؟»
 * unanswerable from the screen.
 */
function addRefund(t: Totals, f: RefundFact): void {
  t.refunded_revenue_iqd += f.revenue_iqd;
  t.refunded_cogs_iqd += f.cogs_iqd;
  t.costed_revenue_iqd -= f.costed_revenue_iqd;
  t.cogs_iqd -= f.cogs_iqd;
  t.refunded_units += f.units;
  t.refund_cases += f.cases;
  // THE DISCLOSURE SIDE IS REVERSED TOO, or the parts stop adding up to the
  // whole: `revenue_iqd` drops by the refund while `uncosted_revenue_iqd`
  // would keep the sale's figure, and the honesty panel would announce
  // uncosted revenue in a period whose sales all came back. See `RefundFact`.
  t.uncosted_revenue_iqd -= f.uncosted_revenue_iqd;
  t.uncosted_units -= f.uncosted_units;
  t.uncosted_lines -= f.uncosted_lines;
  t.estimated_lines -= f.estimated_lines;
  t.estimated_units -= f.estimated_units;
  t.estimated_cogs_iqd -= f.estimated_cogs_iqd;
}

// ------------------------------------------------------------- the reports

/** What a bucket looks like on the wire. */
export interface Bucket {
  /** 'YYYY-MM-DD' for a day or a week start, 'YYYY-MM' for a month, 'range'. */
  key: string;
  /** The first and last Baghdad day this bucket actually covers in the range. */
  from: string;
  to: string;
  totals: Totals;
  /**
   * How this bucket compares with the one before it IN THIS SAME LIST — the
   * month-over-month figure. Null on the first bucket, because there is nothing
   * before it and a change of «+100%» against nothing is a fabrication.
   */
  change: Change | null;
}

/** A difference between two buckets or two periods. */
export interface Change {
  revenue_iqd: number;
  revenue_percent: number | null;
  gross_profit_iqd: number;
  gross_profit_percent: number | null;
  net_profit_iqd: number;
  net_profit_percent: number | null;
  orders: number;
}

/**
 * The percentage change from `before` to `after`.
 *
 * NULL when `before` is zero or negative, and this is the important case: a
 * month that went from 0 to 900,000 did not grow by any percentage, it started.
 * Dividing by zero gives Infinity and dividing by a negative gives a growth
 * figure with the sign flipped — both would be printed as if they meant
 * something. The absolute difference is always there beside it and is always
 * true.
 */
function changePercent(after: number, before: number): number | null {
  if (!Number.isFinite(after) || !Number.isFinite(before) || before <= 0) return null;
  return Math.round(((after - before) * 10_000) / before) / 100;
}

function changeBetween(after: Totals, before: Totals): Change {
  return {
    revenue_iqd: after.revenue_iqd - before.revenue_iqd,
    revenue_percent: changePercent(after.revenue_iqd, before.revenue_iqd),
    gross_profit_iqd: after.gross_profit_iqd - before.gross_profit_iqd,
    gross_profit_percent: changePercent(after.gross_profit_iqd, before.gross_profit_iqd),
    net_profit_iqd: after.net_profit_iqd - before.net_profit_iqd,
    net_profit_percent: changePercent(after.net_profit_iqd, before.net_profit_iqd),
    orders: after.orders - before.orders,
  };
}

/** Everything the aggregation engine was handed, already decoded. */
export interface ReportInput {
  range: DayRange;
  previous: DayRange;
  granularity: Granularity;
  sales: SaleFact[];
  refunds: RefundFact[];
  orders: OrderFact[];
  expenses: ExpenseFact[];
  /** Per-category totals for the REQUESTED range only — never the comparison
   *  window, which nothing on the screen breaks down. */
  expenseCategories: ExpenseCategoryTotal[];
  schema: SchemaFacts;
  /** Delivered orders that carry no `delivered_at` and so sit in no bucket. */
  unrecognizedOrders: number;
}

/** What the fold could not place, reported rather than dropped (§2). */
export interface Unbucketed {
  sale_lines: number;
  sale_revenue_iqd: number;
  refund_cases: number;
  expense_entries: number;
  expense_amount_iqd: number;
}

export interface PeriodReport {
  range: DayRange;
  granularity: Granularity;
  buckets: Bucket[];
  totals: Totals;
  /** Where the period's operating expenses went, by the owner's own categories. */
  expense_categories: ExpenseCategoryTotal[];
  previous: { range: DayRange; totals: Totals };
  /** This whole period against the preceding period of equal length. */
  change: Change;
  meta: ReportMeta;
}

export interface ReportMeta {
  recognition: typeof RECOGNITION_RULE;
  timezone: typeof REPORT_TIMEZONE;
  week_starts_on: 'saturday';
  currency: 'IQD';
  /** Whose sales these are. Merchant-store orders are excluded (§3). */
  scope: 'levonis_own_sales';
  /** False when migration 0095 has not landed: every cost is an estimate. */
  cost_snapshot_available: boolean;
  /** False when there is no expense ledger: net profit equals gross profit. */
  operating_expenses_available: boolean;
  /** Delivered orders in no bucket at all, whatever the range (§1). */
  unrecognized_orders: number;
  /** Rows whose timestamp SQLite could not read into a day (§2). */
  unbucketed: Unbucketed;
}

const inRange = (day: string, range: DayRange): boolean => day >= range.from && day <= range.to;

/**
 * Fold a window of day-level facts into one period report and its comparison.
 *
 * The caller queries ONE widened window covering both the requested period and
 * the preceding one, and hands the whole thing here. That is what keeps the
 * request at five queries rather than ten, and it is safe because every fact
 * carries its own day and is routed by comparing that day against each range.
 */
export function buildPeriodReport(input: ReportInput): PeriodReport {
  const { range, previous, granularity } = input;

  const buckets = new Map<string, Totals>();
  for (const key of bucketKeysFor(range, granularity)) buckets.set(key, zeroTotals());

  const current = zeroTotals();
  const prior = zeroTotals();
  const unbucketed: Unbucketed = {
    sale_lines: 0,
    sale_revenue_iqd: 0,
    refund_cases: 0,
    expense_entries: 0,
    expense_amount_iqd: 0,
  };

  /**
   * Route one day's fact to the bucket, the period total and the comparison
   * total. A day outside BOTH ranges is dropped in silence and that is correct
   * — the widened query window is exactly the union of the two ranges, so such
   * a day can only be an unbucketable row, which is counted by the callers
   * below before they get here.
   */
  const place = (day: string, apply: (t: Totals) => void): void => {
    if (inRange(day, range)) {
      apply(current);
      const key = bucketKeyOf(day, granularity);
      const b = buckets.get(key);
      // A key the range said it covers is always present; this guards the one
      // case where it is not — a granularity whose bucket start falls before
      // `range.from` (a week beginning on the Saturday before the range did).
      if (b) apply(b);
      else {
        const created = zeroTotals();
        apply(created);
        buckets.set(key, created);
      }
      return;
    }
    if (inRange(day, previous)) apply(prior);
  };

  for (const f of input.sales) {
    if (f.day === UNBUCKETED) {
      unbucketed.sale_lines += f.lines;
      unbucketed.sale_revenue_iqd += f.revenue_iqd;
      continue;
    }
    place(f.day, (t) => addSale(t, f));
  }
  for (const f of input.refunds) {
    if (f.day === UNBUCKETED) {
      unbucketed.refund_cases += f.cases;
      continue;
    }
    place(f.day, (t) => addRefund(t, f));
  }
  for (const f of input.orders) {
    // An order whose `delivered_at` SQLite could not read into a day has
    // already had its LINES counted in `unbucketed.sale_lines`; its shipping,
    // COD fee, coupon and points belong to no period either. They are dropped
    // here rather than folded into an arbitrary bucket — the row to fix is the
    // order's timestamp, and `unbucketed` is what points at it.
    if (f.day === UNBUCKETED) continue;
    place(f.day, (t) => {
      t.shipping_collected_iqd += f.shipping_iqd;
      t.cod_tax_collected_iqd += f.cod_tax_iqd;
      t.points_redeemed_iqd += f.points_iqd;
      t.coupon_discount_iqd += f.coupon_iqd;
    });
  }
  for (const f of input.expenses) {
    if (f.day === UNBUCKETED) {
      unbucketed.expense_entries += f.entries;
      unbucketed.expense_amount_iqd += f.amount_iqd;
      continue;
    }
    place(f.day, (t) => {
      t.operating_expenses_iqd += f.amount_iqd;
      t.expense_entries += f.entries;
    });
  }

  const ordered = [...buckets.keys()].sort();
  const out: Bucket[] = [];
  let previousTotals: Totals | null = null;
  for (const key of ordered) {
    const totals = seal(buckets.get(key) as Totals);
    out.push({
      key,
      ...bucketSpan(key, granularity, range),
      totals,
      change: previousTotals ? changeBetween(totals, previousTotals) : null,
    });
    previousTotals = totals;
  }

  const totals = seal(current);
  const priorTotals = seal(prior);

  return {
    range,
    granularity,
    buckets: out,
    totals,
    expense_categories: input.expenseCategories,
    previous: { range: previous, totals: priorTotals },
    change: changeBetween(totals, priorTotals),
    meta: {
      recognition: RECOGNITION_RULE,
      timezone: REPORT_TIMEZONE,
      week_starts_on: 'saturday',
      currency: 'IQD',
      scope: 'levonis_own_sales',
      cost_snapshot_available: input.schema.has0095,
      operating_expenses_available: input.schema.has0095,
      unrecognized_orders: input.unrecognizedOrders,
      unbucketed,
    },
  };
}

/**
 * The first and last day a bucket covers WITHIN the requested range.
 *
 * Clamped to the range on purpose: a week bucket keyed on the Saturday before
 * the range began would otherwise claim days the report never looked at, and a
 * chart axis built from it would label a column with dates whose orders are not
 * in the column.
 */
function bucketSpan(key: string, granularity: Granularity, range: DayRange): { from: string; to: string } {
  if (granularity === 'range') return { from: range.from, to: range.to };
  if (granularity === 'day') return { from: key, to: key };
  if (granularity === 'week') {
    const end = addDays(key, 6);
    return { from: key < range.from ? range.from : key, to: end > range.to ? range.to : end };
  }
  const start = `${key}-01`;
  const p = dayParts(start);
  const end = p ? addDays(`${key}-01`, daysInMonth(p.y, p.m) - 1) : start;
  return { from: start < range.from ? range.from : start, to: end > range.to ? range.to : end };
}

/** Days in a Gregorian month. `Date.UTC(y, m, 0)` is the last day of month m. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------------------------------------------------------- the breakdowns

/** One product's or one category's line in a breakdown. */
export interface BreakdownRow {
  id: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  slug: string;
  /** Present on a product row so the UI can group without a second request. */
  category_id?: string | null;
  sub_category_id?: string | null;
  totals: Totals;
}

/**
 * Join a breakdown's sales and refunds into one row per subject.
 *
 * A refund can arrive for a product that sold NOTHING in this range — the
 * order was delivered in an earlier period and returned in this one. That row
 * is created rather than dropped: its revenue is negative, which is the truth
 * about that product this month, and dropping it would make the breakdown's
 * column fail to add up to the period total on the same screen.
 *
 * NO NET PROFIT HERE, EVER (§5). The row carries `net_profit_iqd` from
 * `seal()` because it shares the `Totals` shape, and the route deletes the
 * period-only fields before serializing — see `stripPeriodOnly`.
 */
export function combineBreakdown(
  sales: Array<{ id: string | null; names: Partial<BreakdownRow>; fact: SaleFact }>,
  refunds: Array<{ id: string | null; names?: Partial<BreakdownRow>; fact: RefundFact }>
): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();
  const keyOf = (id: string | null): string => (id === null ? '\u0000null' : id);

  const ensure = (id: string | null, names?: Partial<BreakdownRow>): BreakdownRow => {
    const k = keyOf(id);
    let row = rows.get(k);
    if (!row) {
      row = {
        id,
        name_ar: names?.name_ar ?? '',
        name_en: names?.name_en ?? '',
        name_ckb: names?.name_ckb ?? '',
        slug: names?.slug ?? '',
        totals: zeroTotals(),
      };
      if (names && 'category_id' in names) row.category_id = names.category_id ?? null;
      if (names && 'sub_category_id' in names) row.sub_category_id = names.sub_category_id ?? null;
      rows.set(k, row);
    } else if (names) {
      row.name_ar ||= names.name_ar ?? '';
      row.name_en ||= names.name_en ?? '';
      row.name_ckb ||= names.name_ckb ?? '';
      row.slug ||= names.slug ?? '';
    }
    return row;
  };

  for (const s of sales) addSale(ensure(s.id, s.names).totals, s.fact);
  for (const r of refunds) addRefund(ensure(r.id, r.names).totals, r.fact);

  const out = [...rows.values()];
  for (const row of out) seal(row.totals);
  // Descending revenue, then by id so the order is stable across requests —
  // an unstable order makes a paginated screen repeat and skip rows.
  out.sort((a, b) => b.totals.revenue_iqd - a.totals.revenue_iqd || keyOf(a.id).localeCompare(keyOf(b.id)));
  return out;
}

/**
 * The fields a per-subject row must NOT carry (§5).
 *
 * Shipping, the COD fee, points and operating expenses belong to no product,
 * so a product's net profit would be an invention. They are removed from the
 * SHAPE rather than zeroed: a zero is a claim that the number is zero, and a
 * UI that reads `net_profit_iqd` off a product row would print that claim.
 */
export const PERIOD_ONLY_FIELDS = [
  'shipping_collected_iqd',
  'cod_tax_collected_iqd',
  'points_redeemed_iqd',
  'coupon_discount_iqd',
  'operating_expenses_iqd',
  'net_profit_iqd',
  'net_margin_percent',
  'expense_entries',
] as const;

/** Drop the period-only fields from a breakdown row's totals. */
export function stripPeriodOnly(totals: Totals): Omit<Totals, (typeof PERIOD_ONLY_FIELDS)[number]> {
  const copy: Record<string, unknown> = { ...totals };
  for (const f of PERIOD_ONLY_FIELDS) delete copy[f];
  return copy as Omit<Totals, (typeof PERIOD_ONLY_FIELDS)[number]>;
}
