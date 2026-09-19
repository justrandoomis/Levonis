/**
 * THE TWO PROFITS, AND THE DATA EACH ONE IS MADE OF.
 *
 * The owner's own words draw the line this file enforces:
 *
 *   «التكلفه على مستوى واحد في تفاصيل المنتج، لكن يستطيع الادمن في لوحه
 *    الاداره اضافه تكاليف اخرى يمكن، لا علاقه لها بالمنتج الاساسي او ما يظهر
 *    للمستخدم، انها خاصه في لوحه الادمن»
 *
 * So there are exactly two kinds of cost, and merging them is the defect:
 *
 *   GROSS PROFIT = revenue − cost of goods sold.  COGS is the PRODUCT cost,
 *                  one level, `cost_iqd` on the product/option/colour rungs.
 *                  It attributes to a product and to a category.
 *   NET PROFIT   = gross profit − operating expenses.  An operating expense —
 *                  rent, a salary, an advertising invoice, customs — belongs to
 *                  NO product, so it can only ever be subtracted PER PERIOD.
 *                  A per-product net profit would be an invention.
 *
 * A single number called «الربح» that the owner cannot decompose into those
 * two is worse than two honest ones, so nothing in this file computes one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERYTHING HERE IS FINANCIAL, WHICH MEANS EVERYTHING HERE IS GATED.
 *
 * worker/lib/adminScope.ts §11: «cost وجميع تفاصيل الربح متاحة فقط
 * للمالك/الدور المالي. مساعد الأدمن العادي لا يراها في API ولا في HTML ولا في
 * export». A cost, a margin, an expense and a net profit are all "تفاصيل
 * الربح". Every route that reads or writes any of it calls
 * `canViewFinancials` first — on the SERVER, before serialization, so reading
 * the raw API response, the HTML or a downloaded file reveals nothing.
 *
 * This module holds no route and no authorization of its own: it is the shapes
 * and the rules. The gate lives at the door (worker/routes/adminFinance.ts and
 * the reporting routes), because a helper that "usually" gets called is not a
 * gate.
 */

import { addDays, dayParts, isDay } from './baghdadTime';
import { badRequest } from './http';

// ═══════════════════════════════════════════════════════════════════════════
//  PART 1 — THE COST BASIS OF A SOLD LINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHAT `order_items.cost_basis` MEANS. Four values, and the fourth is the one
 * that keeps the dashboard honest.
 *
 * Until migration 0095 the cost at the moment of sale was recorded NOWHERE:
 * worker/routes/orders.ts stripped `cost_iqd` out of the persisted pricing
 * snapshot (correctly — that snapshot is served straight back to the buyer)
 * and `order_items` had no cost column to put it in. Profit could therefore
 * only be computed against the product's CURRENT cost, so editing one supplier
 * price today rewrote last month's reported profit. This column exists so that
 * a reader can always tell a recorded fact from a reconstruction.
 */
export const COST_BASIS = {
  /** `cost_iqd` is the unit cost the resolver produced at the instant of sale.
   *  Authoritative and immutable: nothing that happens to the catalogue later
   *  can change the profit computed from it. */
  snapshot: 'snapshot',
  /** The sale-time resolver walked every rung and found NO cost, so `cost_iqd`
   *  is NULL — and that NULL is a recorded fact rather than a gap. Gross profit
   *  on this line is UNKNOWN. It must NOT be estimated from the product's cost
   *  today: that number was typed after the sale, and applying it backwards
   *  invents a margin that never existed. */
  unpriced: 'unpriced',
  /** A composition PARENT (a bundle). The money is on this row; the GOODS are
   *  on its component rows, which are separate `order_items` rows in the same
   *  order and carry their own snapshots. Its COGS is zero by construction —
   *  counting a cost here as well would count the same goods twice. */
  composed: 'composed',
  /** Nothing was captured. Every order placed before 0095 is this, and so is a
   *  mystery-box spool (whose `product_id` is NULL by design, so it cannot even
   *  be estimated). A figure derived from this row is an ESTIMATE at best and
   *  must be labelled «تقدير» on screen, never added silently into a total the
   *  owner will read as a fact. */
  unrecorded: 'unrecorded',
} as const;

export type CostBasis = (typeof COST_BASIS)[keyof typeof COST_BASIS];

/** Every legal value, for a validator or a SQL `IN` list. Mirrors the CHECK
 *  constraint in migration 0095 — the two must keep agreeing. */
export const COST_BASES: readonly CostBasis[] = Object.values(COST_BASIS);

/** What a stored `cost_basis` means, with an unreadable value resolved to the
 *  LEAST confident answer. The same reasoning as
 *  `adminScope.normalizeAdminScope`: the one thing certain about a value we
 *  cannot read is that we must not present it as a fact. */
export function normalizeCostBasis(v: unknown): CostBasis {
  return (COST_BASES as readonly string[]).includes(String(v ?? ''))
    ? (String(v) as CostBasis)
    : COST_BASIS.unrecorded;
}

/** What the checkout writes onto one `order_items` row. */
export interface CostSnapshot {
  cost_iqd: number | null;
  cost_basis: CostBasis;
}

/**
 * THE ONE PLACE THAT TURNS A RESOLVED COST INTO A STORED BASIS.
 *
 * `resolved` is `ResolvedPrice.cost_iqd` — the value the three strip sites in
 * worker/routes/orders.ts discard, handed straight here. It is NEVER re-derived
 * from the product: the resolver already walked the option/colour/fulfilment/
 * transport rungs for this exact selection, and a second walk can disagree with
 * the first, leaving two honest numbers describing one sale.
 *
 * A NULL from the resolver is `unpriced`, not `unrecorded`, and the difference
 * is the whole point: "we looked and there was no cost" is a fact about the
 * sale, while "we never looked" is a gap in our records. Only the second may
 * ever be estimated against today's catalogue.
 *
 * A negative or non-integer cost is refused into `unpriced` rather than stored.
 * Money is whole dinars everywhere in this codebase, and a fractional COGS is
 * the first rounding disagreement between a dashboard and the order it came
 * from — a number that cannot be reconciled is worse than no number.
 */
export function costSnapshot(resolved: number | null | undefined): CostSnapshot {
  if (resolved === null || resolved === undefined) return { cost_iqd: null, cost_basis: COST_BASIS.unpriced };
  if (!Number.isInteger(resolved) || resolved < 0) return { cost_iqd: null, cost_basis: COST_BASIS.unpriced };
  return { cost_iqd: resolved, cost_basis: COST_BASIS.snapshot };
}

/** A composition PARENT's basis. Its own `cost_iqd` is deliberately discarded
 *  even when the owner typed one on the bundle product: the components are the
 *  goods, and recording both would double-count them. */
export const COMPOSED_SNAPSHOT: CostSnapshot = { cost_iqd: null, cost_basis: COST_BASIS.composed };

/** How confident a reported cost is. The dashboard MUST render these three
 *  differently — a fact, an estimate, and "we cannot say". */
export type CostConfidence = 'recorded' | 'estimated' | 'unknown';

/**
 * THE SQL TRACK B EMBEDS, so no screen invents its own rule for this.
 *
 * Returns three expressions over an `order_items` alias joined to a `products`
 * alias. It deliberately does not aggregate: a caller sums `qty *
 * unit_cost_iqd` itself, because whether to sum at all depends on whether the
 * period is being shown as fact or as estimate, and hiding that decision inside
 * a SUM is how an estimate becomes a fact.
 *
 * THE ESTIMATE IS `products.product_cost_iqd` AND ONLY THAT — never the option
 * or colour rung. Those live in relational tables (0018/0073) and resolving
 * them needs the resolver, not a join; using the product rung is the most
 * defensible guess available in one query AND it is why the answer is labelled
 * an estimate rather than a cost. A product deleted since the sale leaves the
 * LEFT JOIN null, which is `unknown`, which is the truth.
 *
 * @param oi alias of `order_items`
 * @param p  alias of `products`, LEFT JOINed on `oi.product_id`
 */
export function costProjectionSql(oi = 'oi', p = 'p'): string {
  return `
    ${costValueSql(oi, p)} AS unit_cost_iqd,
    ${costConfidenceSql(oi, p)} AS cost_confidence`;
}

/**
 * THE VALUE HALF OF THE RULE, WITHOUT ITS ALIAS.
 *
 * Split out of `costProjectionSql` because a caller sometimes needs the
 * expression INSIDE another expression — a composition parent's costedness is
 * a property of its COMPONENTS, so the report has to evaluate this rule over a
 * different row than the one it is selecting (worker/lib/financeReport.ts,
 * `kids`). Before the split that caller had to write the four-way rule out a
 * second time, which is the one thing `costProjectionSql`'s own comment exists
 * to prevent: two copies drift, and the day they disagree the dashboard and
 * the ledger report different profits for the same month.
 *
 * NULL means UNKNOWN, and a `composed` parent's 0 here means only "this row's
 * own cost is not the goods" — whether its goods are costed at all is a
 * question about other rows, which is exactly why this returns an expression a
 * caller can nest rather than a verdict.
 */
export function costValueSql(oi = 'oi', p = 'p'): string {
  return `CASE
      WHEN ${oi}.cost_basis = '${COST_BASIS.snapshot}'   THEN ${oi}.cost_iqd
      WHEN ${oi}.cost_basis = '${COST_BASIS.composed}'   THEN 0
      WHEN ${oi}.cost_basis = '${COST_BASIS.unpriced}'   THEN NULL
      ELSE ${p}.product_cost_iqd
    END`;
}

/** The confidence half of the same rule, without its alias. See `costValueSql`. */
export function costConfidenceSql(oi = 'oi', p = 'p'): string {
  return `CASE
      WHEN ${oi}.cost_basis IN ('${COST_BASIS.snapshot}','${COST_BASIS.composed}') THEN 'recorded'
      WHEN ${oi}.cost_basis = '${COST_BASIS.unpriced}' THEN 'unknown'
      WHEN ${p}.product_cost_iqd IS NULL THEN 'unknown'
      ELSE 'estimated'
    END`;
}

/** The same rule in TypeScript, for a caller that already has both rows. Kept
 *  beside the SQL on purpose: two copies that drift produce a screen and an
 *  export that disagree about last month's profit. */
export function costConfidenceOf(basis: unknown, productCostToday: number | null | undefined): CostConfidence {
  const b = normalizeCostBasis(basis);
  if (b === COST_BASIS.snapshot || b === COST_BASIS.composed) return 'recorded';
  if (b === COST_BASIS.unpriced) return 'unknown';
  return productCostToday === null || productCostToday === undefined ? 'unknown' : 'estimated';
}

// ═══════════════════════════════════════════════════════════════════════════
//  PART 2 — THE OPERATING-EXPENSE LEDGER
// ═══════════════════════════════════════════════════════════════════════════

/** One row of `operating_expenses`, as the admin panel sees it. */
export interface ExpenseRow {
  id: string;
  category_id: string;
  amount_iqd: number;
  /** The Baghdad civil day the expense BELONGS to — not the day it was typed. */
  expense_day: string;
  title: string;
  note: string;
  series_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string;
}

/** One row of `expense_categories`. Three languages, because 'ckb' is a real
 *  language on this platform and not a fallback to English. */
export interface ExpenseCategoryRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sort: number;
  active: number;
}

/**
 * THE CATEGORIES A NEW SHOP STARTS WITH — created ONCE, on demand, as ordinary
 * editable rows, and never from the migration.
 *
 * A seeded INSERT inside a .sql file is a write, and re-applying it would
 * resurrect a category the owner had deliberately removed.
 * `scripts/check-migrations-additive.mjs` classifies writes as non-additive for
 * exactly that reason. These are therefore a DEFAULT, not a schema: the owner
 * renames them, reorders them, deactivates them and adds their own, with no
 * migration and no deploy — the same rule §4/§9 sets for the catalogue tree.
 */
export const DEFAULT_EXPENSE_CATEGORIES: ReadonlyArray<{
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}> = [
  { slug: 'rent', name_ar: 'إيجار', name_en: 'Rent', name_ckb: 'کرێ' },
  { slug: 'salaries', name_ar: 'رواتب', name_en: 'Salaries', name_ckb: 'مووچە' },
  { slug: 'advertising', name_ar: 'إعلانات وتسويق', name_en: 'Advertising', name_ckb: 'ڕیکلام' },
  { slug: 'shipping', name_ar: 'شحن ونقل', name_en: 'Shipping', name_ckb: 'گواستنەوە' },
  { slug: 'customs', name_ar: 'كمارك ورسوم', name_en: 'Customs & duties', name_ckb: 'گومرگ' },
  { slug: 'fees', name_ar: 'رسوم بنكية وعمولات', name_en: 'Bank fees', name_ckb: 'کرێی بانک' },
  { slug: 'utilities', name_ar: 'كهرباء وإنترنت', name_en: 'Utilities', name_ckb: 'کارەبا و ئینتەرنێت' },
  { slug: 'maintenance', name_ar: 'صيانة', name_en: 'Maintenance', name_ckb: 'چاککردنەوە' },
  { slug: 'other', name_ar: 'أخرى', name_en: 'Other', name_ckb: 'ئەوانی تر' },
];

/**
 * A URL-safe slug from a name the owner typed, in any of the three languages.
 *
 * Arabic and Kurdish names survive `\p{Letter}` — they are letters — so
 * «إيجار» slugs to «إيجار» rather than to nothing. THE LENGTH IS IN BYTES, not
 * characters, and it is capped at 40: an Arabic letter is TWO bytes in UTF-8,
 * and a LIKE/GLOB pattern in D1 caps at 50 BYTES. A 60-character Arabic slug is
 * 120 bytes, and a search for it would be refused by the database rather than
 * return nothing — a failure that looks like a bug in the screen and is not.
 */
export function expenseSlug(name: string, fallback: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const encoder = new TextEncoder();
  let out = '';
  for (const ch of cleaned) {
    if (encoder.encode(out + ch).length > 40) break;
    out += ch;
  }
  return out.replace(/-+$/g, '') || fallback;
}

/** The largest repeat the panel will write in one go. Twelve months is the
 *  case the owner described (rent, salaries); twenty-four is the generous
 *  ceiling. It is bounded because every repeated month is a REAL ROW written in
 *  one batch, and an unbounded repeat is an unbounded batch. */
export const MAX_EXPENSE_REPEAT = 24;

/**
 * THE DAYS A REPEAT WRITES, as real rows — one per month, starting at `day`.
 *
 * RECURRENCE IS MATERIALISED, NEVER EVALUATED AT READ TIME, and this function
 * is the whole of it. The argument, in full:
 *
 *   A recurrence RULE read at report time makes a reported profit depend on
 *   code rather than on rows the owner can see. The month the rent goes from
 *   500,000 to 600,000, one edited rule rewrites every month the report has
 *   ever shown — the same silent rewriting of history that the cost snapshot in
 *   PART 1 exists to abolish. And a generator on a cron writes expenses nobody
 *   typed into months nobody was looking at.
 *
 *   So a repeat produces twelve ordinary rows, right then, each visible, each
 *   editable, each voidable on its own. `series_id` groups them for the panel
 *   and is never read by a report.
 *
 * THE MONTH-END RULE. 31 January + 1 month is 28 February, not 3 March. Adding
 * 30 days drifts (twelve additions land eleven days early by December) and
 * `Date.UTC(y, m + 1, 31)` overflows February into March, which would put a
 * January rent invoice in the wrong month — and a month is exactly the period
 * this ledger reports on. The day of month is therefore CLAMPED to the length
 * of the target month.
 */
export function expenseSeriesDays(day: string, months: number): string[] {
  const p = dayParts(day);
  if (!p) return [];
  const n = Math.max(1, Math.min(MAX_EXPENSE_REPEAT, Math.trunc(months) || 1));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const targetMonth = p.m - 1 + i;
    const y = p.y + Math.floor(targetMonth / 12);
    const m = ((targetMonth % 12) + 12) % 12; // 0-based, for Date.UTC
    // The last day of the target month: day 0 of the NEXT month, which Date.UTC
    // normalises for leap years without a table of month lengths.
    const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = Math.min(p.d, lastOfMonth);
    // Formatted from the parts, NOT from `toISOString().slice(0, 10)`.
    // worker/lib/baghdadTime.ts is emphatic about why: slicing an instant is a
    // whole day wrong for every instant between 21:00 and 24:00 UTC, and the
    // habit is the defect even where this particular value happens to be a UTC
    // midnight. Padding three numbers cannot be wrong at any hour.
    out.push(`${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

/**
 * The day an expense belongs to, validated.
 *
 * SHAPE IS NOT VALIDITY — '2026-02-31' matches the GLOB in migration 0095 and
 * is not a day — so this goes through `dayParts`, which round-trips the value
 * and rejects anything that does not format back to itself.
 *
 * THE FUTURE IS ALLOWED, WITHIN A YEAR. Rent paid in advance and a repeat of
 * twelve months are both legitimate future rows, so refusing the future would
 * refuse the owner's own use case. An unbounded future is not: a typo of
 * '2226-01-01' would sit forever in a period nobody ever opens, silently
 * missing from every net-profit figure the owner reads. `todayBaghdad` is the
 * SERVER's day — never a client's, for the same reason a client may not choose
 * the day it is paid for.
 */
export function validateExpenseDay(value: unknown, todayBaghdad: string): string {
  const day = String(value ?? '').trim();
  if (!isDay(day) || !dayParts(day)) {
    throw badRequest('expense_day must be a real calendar day in YYYY-MM-DD form', 'EXPENSE_DAY_INVALID');
  }
  if (isDay(todayBaghdad)) {
    const ceiling = addDays(todayBaghdad, 366);
    if (ceiling && day > ceiling) {
      throw badRequest('expense_day is more than a year in the future — check the year you typed', 'EXPENSE_DAY_TOO_FAR');
    }
  }
  return day;
}

/**
 * An amount in WHOLE DINARS.
 *
 * Integer, because every money column in this codebase is an integer of dinars
 * and a second representation is the first place two totals can disagree.
 * Strictly positive, because a "negative expense" is a refund or a correction —
 * a different fact with a different story — and allowing one here would let a
 * mistyped minus sign cancel a real cost with nothing on screen to show it.
 * The ceiling is a typo guard: 999,999,999,999 IQD is not an operating expense,
 * it is a missing decimal point, and a single such row would make every net
 * profit the owner reads for that period meaningless.
 */
export function validateExpenseAmount(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw badRequest('amount_iqd must be a whole number of dinars above zero', 'EXPENSE_AMOUNT_INVALID');
  }
  if (n > 999_999_999_999) {
    throw badRequest('amount_iqd is implausibly large — check the number you typed', 'EXPENSE_AMOUNT_INVALID');
  }
  return n;
}
