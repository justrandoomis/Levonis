/**
 * «لوحة الأرباح» — the owner's financial reporting endpoints.
 *
 *   GET /api/admin/finance/report/summary     period buckets + comparison
 *   GET /api/admin/finance/report/products    gross profit per product
 *   GET /api/admin/finance/report/categories  gross profit per category rung
 *
 * The arithmetic, the recognition rule and every word of why they are what
 * they are live in worker/lib/financeReport.ts. This file does three things
 * and nothing else: it GUARDS, it QUERIES, and it SERIALIZES.
 *
 * ---------------------------------------------------------------------------
 * 1. THE GUARD IS THE POINT OF THIS FILE.
 *
 * Mandate §11, quoted in full in worker/lib/adminScope.ts: «cost وجميع تفاصيل
 * الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن العادي لا يراها في API ولا
 * في HTML ولا في export». EVERY byte these three endpoints produce is cost and
 * margin detail — there is no "safe subset" of a profit report to hand an
 * assistant, and nothing here is stripped field by field the way a product
 * document is. So the whole router is refused, at the door, before a single
 * query runs.
 *
 * TWO MIDDLEWARES, NOT ONE, AND BOTH ON `'*'`. `requireAdmin` carries the
 * apex-only host rule with it (worker/lib/http.ts), so a merchant subdomain
 * cannot reach this at all; `requireFinancial` is the §11 test. Registering
 * them on the router rather than per-handler is deliberate: a route added
 * later cannot forget a middleware it never had to write, and "the endpoint
 * somebody adds next month" is how this kind of hole is actually opened.
 * `tests/financeReport.test.ts` asserts the refusal for an assistant.
 *
 * THE OWNER CAN NEVER BE LOCKED OUT. `canViewFinancials` answers true for
 * INITIAL_ADMIN_EMAIL whatever `admin_scope` says, which is what stops a
 * compromised assistant from taking the owner's own numbers away from them.
 *
 * ---------------------------------------------------------------------------
 * 2. WHY THE QUERIES LIVE HERE AND THE ARITHMETIC DOES NOT.
 *
 * financeReport.ts is pure — no Hono, no `Env`, no D1 handle — so the SQL it
 * builds can be run against a database made from the real migrations in a test
 * without standing up a request. This module is the only place a statement is
 * prepared, and every one of them binds at most three parameters (§7 there):
 * D1 refuses more than 100, which is why this codebase chunks id lists at 90
 * (worker/lib/stockAlerts.ts and four other call sites). A report over a year
 * of orders is aggregated by SQLite with GROUP BY and never by collecting ids
 * into an IN list — that shape would work on the owner's laptop and fail on the
 * shop's real data, which is the worst possible time to find out.
 *
 * ---------------------------------------------------------------------------
 * 3. ONE WIDENED WINDOW, NOT TWO ROUND TRIPS.
 *
 * Every summary is answered together with the preceding period of equal length,
 * because a number with nothing to compare it against does not mean anything.
 * Both periods are fetched in ONE window — `previous.from` to `range.to` — and
 * the pure fold routes each day to the side it belongs to. Two separate sets of
 * queries would double the request cost to learn nothing new.
 *
 * ---------------------------------------------------------------------------
 * 4. A DEPLOY THAT IS AHEAD OF ITS DATABASE STILL ANSWERS.
 *
 * `order_items.cost_iqd` (migration 0095) and the `operating_expenses` ledger
 * may not exist yet for a few minutes after a deploy, or for longer on a
 * staging copy. Asking `PRAGMA table_info` — the same thing
 * worker/lib/productDeletion.ts does, for the same reason — costs two reads and
 * lets the report answer honestly instead of returning a 500 that reads as "the
 * profit screen is broken". What it must never do is answer QUIETLY: with no
 * snapshot column every cost is an estimate and `cost_snapshot_available` says
 * so, and with no ledger `operating_expenses_available` is false rather than
 * the expenses being a silent zero that reads as «ما صرفنا شي».
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, int, oneOf, requireAdmin } from '../lib/http';
import { canViewFinancials } from '../lib/adminScope';
import { baghdadDay } from '../lib/baghdadTime';
import {
  GRANULARITIES,
  MAX_BREAKDOWN_ROWS,
  ORDERS_BY_DAY_SQL,
  UNRECOGNIZED_ORDERS_SQL,
  buildPeriodReport,
  combineBreakdown,
  EXPENSES_BY_CATEGORY_SQL,
  EXPENSES_BY_DAY_SQL,
  expenseCategoryTotalOf,
  expenseFactOf,
  orderFactOf,
  previousRangeOf,
  refundFactOf,
  refundsByCategorySql,
  refundsByDaySql,
  refundsByProductSql,
  resolveRange,
  saleFactOf,
  salesByCategorySql,
  salesByDaySql,
  salesByProductSql,
  stripPeriodOnly,
  utcWindowFor,
  type BreakdownRow,
  type DayRange,
  type Granularity,
  type SchemaFacts,
} from '../lib/financeReport';

export const adminFinanceReportRoutes = new Hono<AppContext>();

/** Platform administration, and the apex-only host rule rides with it. */
adminFinanceReportRoutes.use('*', requireAdmin);

/**
 * §11 at the door. The message is bilingual because the person reading it is an
 * assistant admin on an Arabic panel who needs to know this is a permission,
 * not a bug — and the code is the same `FINANCIAL_SCOPE_REQUIRED` the farm
 * admin already uses (worker/routes/farmAdmin.ts), so one client-side handler
 * covers every financial refusal on the platform.
 */
adminFinanceReportRoutes.use('*', async (c, next) => {
  if (!canViewFinancials(c.env, c.get('user'))) {
    throw new HttpError(
      403,
      'تقارير الأرباح للمالك أو الدور المالي فقط / Profit reports need the owner or a financial admin',
      'FINANCIAL_SCOPE_REQUIRED'
    );
  }
  await next();
});

// ------------------------------------------------------------ schema probe

/**
 * The answer, once it can no longer change.
 *
 * ONE-WAY ON PURPOSE. Caching a POSITIVE answer is safe forever: the columns
 * migration 0095 adds cannot be dropped — SQLite cannot drop a column at all
 * and this repository's migrations are additive only
 * (scripts/check-migrations-additive.mjs enforces it). Caching a NEGATIVE
 * answer would be a bug: the isolate that first ran the report a minute before
 * 0095 landed would go on reporting every cost as an estimate for as long as
 * Cloudflare kept it warm. So absence is re-probed every request, and one read
 * is a cheap price for a screen that starts telling the truth the moment the
 * migration does.
 */
let schemaMemo: SchemaFacts | null = null;

async function columnsOf(db: D1Database, table: string): Promise<Set<string>> {
  // The canonical PRAGMA form with a literal, validated name: D1 deployments
  // have differed on whether the table-valued form accepts a bound parameter
  // (see worker/lib/productDeletion.ts). A missing table answers zero rows
  // rather than throwing, which is exactly the signal wanted here.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set();
  try {
    const rows = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    return new Set((rows.results ?? []).map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

/**
 * `order_items.cost_basis` is the single witness for the whole of migration
 * 0095: one file adds the cost columns, the expense ledger and the category
 * table together, so either all of it is there or none of it is. Asking about
 * one column rather than three tables keeps this to a single read.
 */
export async function probeSchema(db: D1Database): Promise<SchemaFacts> {
  if (schemaMemo) return schemaMemo;
  const items = await columnsOf(db, 'order_items');
  const facts: SchemaFacts = { has0095: items.has('cost_basis') && items.has('cost_iqd') };
  if (facts.has0095) schemaMemo = facts;
  return facts;
}

/** Test-only: forget the probe so one process can exercise both schemas. */
export function resetFinanceSchemaMemo(): void {
  schemaMemo = null;
}

// ---------------------------------------------------------------- the input

/**
 * The requested range, defaulted to the last 30 Baghdad days.
 *
 * `baghdadDay(Date.now())` and never `new Date().toISOString().slice(0,10)`:
 * between 21:00 and 24:00 UTC those are different days, so for the first three
 * hours of every Iraqi day the default range would end YESTERDAY and today's
 * sales would be missing from the screen the owner opens at one in the morning.
 *
 * The bounds come from the client, so they are validated rather than trusted —
 * `resolveRange` rejects a non-day, a reversed pair and anything longer than
 * `MAX_RANGE_DAYS`, which is what keeps §7's promise about result-set size
 * true no matter what is typed into the URL.
 */
function rangeFrom(c: Context<AppContext>): DayRange {
  const today = baghdadDay(Date.now());
  const to = c.req.query('to') ?? today;
  const from = c.req.query('from') ?? baghdadDay(Date.now(), -29);
  const resolved = resolveRange(from, to);
  if ('error' in resolved) throw badRequest(resolved.error, 'BAD_RANGE');
  return resolved.range;
}

type Row = Record<string, unknown>;

const rowsOf = async (db: D1Database, sql: string, binds: unknown[]): Promise<Row[]> => {
  const r = await db.prepare(sql).bind(...binds).all<Row>();
  return r.results ?? [];
};

/**
 * The expense ledger's rows, or none when the ledger is not installed.
 *
 * Wrapped rather than trusted to the probe alone: the probe and the query are
 * two separate reads, and a migration landing between them would otherwise
 * turn the owner's profit screen into a 500 for one unlucky request. `no such
 * table` degrades to "no expenses yet"; anything else is a real failure and is
 * re-thrown, because a lock or a syntax error silently reported as zero
 * expenses is a NET PROFIT that is too high with nothing on the screen to say
 * so.
 */
async function expenseRows(db: D1Database, schema: SchemaFacts, sql: string, binds: unknown[]): Promise<Row[]> {
  if (!schema.has0095) return [];
  try {
    return await rowsOf(db, sql, binds);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table\b/i.test(msg)) throw e;
    console.error(`finance report: expense ledger not installed (${msg})`);
    return [];
  }
}

// ---------------------------------------------------------------- /summary

/**
 * The period report: one row per day, week or month, the whole-range totals,
 * and the same totals for the preceding period of equal length.
 *
 * `granularity=range` collapses the whole span into a single bucket, which is
 * what a «هذا الشهر مقابل الشهر الماضي» card wants — two numbers and the
 * difference between them, with no series to draw.
 */
adminFinanceReportRoutes.get('/summary', async (c) => {
  const range = rangeFrom(c);
  const granularity = oneOf(c.req.query('granularity') ?? 'day', 'granularity', GRANULARITIES) as Granularity;
  const previous = previousRangeOf(range);

  const schema = await probeSchema(c.env.DB);

  // ONE window covering both periods (§3). `previous.from` is the earlier
  // bound by construction — the previous period ends the day before this one
  // starts — so this is the union of the two ranges and nothing else.
  const window = utcWindowFor({ from: previous.from, to: range.to, days: range.days * 2 });
  const binds = [window.startIso, window.endIso];

  const [sales, refunds, orders, expenses, expenseCategories, unrecognized] = await Promise.all([
    rowsOf(c.env.DB, salesByDaySql(schema), binds),
    rowsOf(c.env.DB, refundsByDaySql(schema), binds),
    rowsOf(c.env.DB, ORDERS_BY_DAY_SQL, binds),
    // Days are fetched across the WIDENED window so the comparison period has
    // its expenses too; the category breakdown is only ever asked of the
    // requested range, because nothing on the screen breaks down last month's
    // spending by category as well as this month's.
    expenseRows(c.env.DB, schema, EXPENSES_BY_DAY_SQL, [previous.from, range.to]),
    expenseRows(c.env.DB, schema, EXPENSES_BY_CATEGORY_SQL, [range.from, range.to]),
    c.env.DB.prepare(UNRECOGNIZED_ORDERS_SQL).first<{ orders: number }>(),
  ]);

  const report = buildPeriodReport({
    range,
    previous,
    granularity,
    sales: sales.map(saleFactOf),
    refunds: refunds.map(refundFactOf),
    orders: orders.map(orderFactOf),
    expenses: expenses.map(expenseFactOf),
    expenseCategories: expenseCategories.map(expenseCategoryTotalOf),
    schema,
    unrecognizedOrders: Number(unrecognized?.orders ?? 0) || 0,
  });

  return c.json({ success: true, ...report });
});

// --------------------------------------------------------------- /products

/**
 * Gross profit per product over the range. NO net profit, and there never will
 * be one: an operating expense belongs to no product, so splitting the rent
 * across the products that happened to sell that month is an invention, and an
 * invented number on a financial screen is worse than a missing one. The
 * period-only fields are removed from the SHAPE by `stripPeriodOnly`, not
 * zeroed, so a client cannot read a zero as a claim.
 */
adminFinanceReportRoutes.get('/products', async (c) => {
  const range = rangeFrom(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: MAX_BREAKDOWN_ROWS, def: 50 });
  const schema = await probeSchema(c.env.DB);
  const window = utcWindowFor(range);

  const [sales, refunds] = await Promise.all([
    // `limit + 1` so "there is more" is a fact from the database rather than a
    // guess from a full page — a page that happens to be exactly `limit` long
    // would otherwise always claim to be truncated.
    rowsOf(c.env.DB, salesByProductSql(schema), [window.startIso, window.endIso, limit + 1]),
    rowsOf(c.env.DB, refundsByProductSql(schema), [window.startIso, window.endIso]),
  ]);

  const truncated = sales.length > limit;
  const rows = combineBreakdown(
    sales.slice(0, limit).map((r) => ({
      id: (r.product_id as string | null) ?? null,
      names: {
        // `products.name` is the English column and `name_ar` the Arabic one;
        // there is no Kurdish name on the product table, so `name_ckb` is
        // empty and the client's `loc()` falls through to Arabic — which is
        // the right answer for a Kurdish reader and the reason nothing here
        // branches on direction.
        name_en: String(r.name_en ?? ''),
        name_ar: String(r.name_ar ?? ''),
        name_ckb: '',
        slug: String(r.slug ?? ''),
        category_id: (r.category_id as string | null) ?? null,
        sub_category_id: (r.sub_category_id as string | null) ?? null,
      },
      fact: saleFactOf(r),
    })),
    // A product RETURNED this period but not SOLD in it still gets a row, and
    // the names travel on the refund query too so that row is not blank.
    refunds.map((r) => ({
      id: (r.product_id as string | null) ?? null,
      names: {
        name_en: String(r.name_en ?? ''),
        name_ar: String(r.name_ar ?? ''),
        name_ckb: '',
        slug: String(r.slug ?? ''),
      },
      fact: refundFactOf(r),
    }))
  );

  return c.json({
    success: true,
    range,
    truncated,
    limit,
    products: rows.map(serializeBreakdown),
    meta: metaFor(schema),
  });
});

// ------------------------------------------------------------- /categories

/**
 * The same figures rolled up to a catalogue rung. `level=main` groups on
 * `products.category_id`, `level=sub` on `products.sub_category_id` — both
 * `catalogs` rows, so the names come back in all three languages and the client
 * calls `loc(ar, en, ckb)`. A product placed in no catalogue groups under a
 * null id rather than disappearing: unfiled revenue is still revenue, and a
 * category table whose column does not add up to the period total is a table
 * the owner cannot check.
 */
adminFinanceReportRoutes.get('/categories', async (c) => {
  const range = rangeFrom(c);
  const level = oneOf(c.req.query('level') ?? 'main', 'level', ['main', 'sub'] as const);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: MAX_BREAKDOWN_ROWS, def: 50 });
  const schema = await probeSchema(c.env.DB);
  const window = utcWindowFor(range);

  const [sales, refunds] = await Promise.all([
    rowsOf(c.env.DB, salesByCategorySql(schema, level), [window.startIso, window.endIso, limit + 1]),
    rowsOf(c.env.DB, refundsByCategorySql(schema, level), [window.startIso, window.endIso]),
  ]);

  const truncated = sales.length > limit;
  const rows = combineBreakdown(
    sales.slice(0, limit).map((r) => ({
      id: (r.category_id as string | null) ?? null,
      names: {
        name_ar: String(r.name_ar ?? ''),
        name_en: String(r.name_en ?? ''),
        name_ckb: String(r.name_ckb ?? ''),
        slug: String(r.slug ?? ''),
      },
      fact: saleFactOf(r),
    })),
    refunds.map((r) => ({
      id: (r.category_id as string | null) ?? null,
      names: {
        name_ar: String(r.name_ar ?? ''),
        name_en: String(r.name_en ?? ''),
        name_ckb: String(r.name_ckb ?? ''),
        slug: String(r.slug ?? ''),
      },
      fact: refundFactOf(r),
    }))
  );

  return c.json({
    success: true,
    range,
    level,
    truncated,
    limit,
    categories: rows.map(serializeBreakdown),
    meta: metaFor(schema),
  });
});

// ------------------------------------------------------------- serializing

const serializeBreakdown = (row: BreakdownRow) => ({
  id: row.id,
  name_ar: row.name_ar,
  name_en: row.name_en,
  name_ckb: row.name_ckb,
  slug: row.slug,
  ...(row.category_id === undefined ? {} : { category_id: row.category_id }),
  ...(row.sub_category_id === undefined ? {} : { sub_category_id: row.sub_category_id }),
  totals: stripPeriodOnly(row.totals),
});

/**
 * The metadata a breakdown carries. It is a SHORTER list than the summary's —
 * `unrecognized_orders` and the unbucketed counts are properties of a period
 * fold, and a breakdown does not fold by period. Repeating them here with
 * plausible zeroes would be a claim this endpoint has not checked.
 */
const metaFor = (schema: SchemaFacts) => ({
  recognition: 'delivered_baghdad_day' as const,
  timezone: 'Asia/Baghdad' as const,
  currency: 'IQD' as const,
  scope: 'levonis_own_sales' as const,
  cost_snapshot_available: schema.has0095,
  /** Stated even though a breakdown has no net profit, so a client cannot
   *  infer that the absent net figure means the expenses were zero. */
  net_profit_is_period_only: true,
});
