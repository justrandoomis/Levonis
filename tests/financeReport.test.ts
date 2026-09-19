/**
 * THE ONE TEST SUITE WHERE AN OFF-BY-ONE IS MONEY.
 *
 * Built on a database created from the REAL migrations (`freshDb()`), seeded
 * with orders that straddle a month boundary IN BAGHDAD TIME, a refund, a
 * cancellation, a product with NULL cost and a line with no cost snapshot. The
 * arithmetic is asserted exactly — every expected figure below is written out
 * as an integer and derived by hand in the comment beside it, because a test
 * that recomputes the number the same way the code does proves only that the
 * code is consistent with itself.
 *
 * WHY THE SEED IS RAW SQL AND NOT THE CHECKOUT ROUTE. A report must be able to
 * describe rows the checkout could not produce today — an order delivered
 * before migration 0095 existed and therefore carrying no cost snapshot, a
 * legacy `delivered_at = ''` — and those are precisely the rows whose handling
 * is worth testing. Going through checkout would make them unreachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, get, json, APEX } from './fixtures/app';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import {
  bucketKeyOf,
  daysBetween,
  marginPercent,
  previousRangeOf,
  resolveRange,
  utcWindowFor,
} from '../worker/lib/financeReport';
import { baghdadDayOf } from '../worker/lib/baghdadTime';

/**
 * Migration 0095 (track A) is what this track consumes: `order_items.cost_iqd`
 * and `order_items.cost_basis`, the `operating_expenses` ledger and
 * `expense_categories`. It is in `migrations/`, so `freshDb()` applies it and
 * this suite runs against the real schema with nothing hand-written.
 *
 * `cost_basis` is the contract that matters here, and every one of its four
 * values appears in the seed below:
 *
 *   'snapshot'   the cost frozen at the instant of sale — a FACT.
 *   'unpriced'   the resolver found no cost. UNKNOWN, and 0095 forbids
 *                estimating it from the catalogue afterwards.
 *   'composed'   a bundle parent: real money, zero COGS, goods on other rows.
 *   'unrecorded' every pre-0095 row: estimated against today's catalogue and
 *                labelled as an estimate.
 */

// ---------------------------------------------------------------- the seed

/**
 * THE MONTH BOUNDARY, AND THE THREE HOURS THAT DECIDE IT.
 *
 * Baghdad is UTC+3, so the Iraqi day begins at 21:00 UTC the day before. These
 * two instants are one millisecond apart on either side of midnight Baghdad on
 * the 1st of March, and they belong to DIFFERENT MONTHS. `.slice(0, 10)` on
 * either of them says '2026-02-28', which is the bug this whole module exists
 * to prevent: a month-end report that files a whole night of sales under the
 * wrong month.
 */
const LAST_MS_OF_FEBRUARY = '2026-02-28T20:59:59.999Z'; // 23:59:59.999 Baghdad, 28 Feb
const FIRST_MS_OF_MARCH = '2026-02-28T21:00:00.000Z'; // 00:00:00.000 Baghdad, 1 Mar

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Owner','boss@x.co','h','admin'),
      ('helper','Assistant','helper@x.co','h','admin'),
      ('buyer','Sara','sara@x.co','h','customer');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'helper';

    INSERT INTO catalogs (id,slug,name_ar,name_en,name_ckb) VALUES
      ('cat_main','levo-test-main','طابعات','Printers','چاپکەرەکان'),
      ('cat_sub','levo-test-sub','FDM','FDM','FDM');

    -- P1 and P2 carry a catalogue cost; P3 carries NONE. P_BUNDLE is the
    -- composition parent's product and deliberately HAS a cost — 0095 says a
    -- 'composed' row's COGS is zero even then, because the goods are its
    -- components, and this fixture is what proves the cost is not counted twice.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,product_cost_iqd,category_id,sub_category_id) VALUES
      ('p_printer','printer-x','Printer X','طابعة إكس',500000,300000,'cat_main','cat_sub'),
      ('p_filament','filament-y','Filament Y','فيلامنت واي',10000,4000,'cat_main','cat_sub'),
      ('p_nocost','riddle-z','Riddle Z','لغز زد',25000,NULL,NULL,NULL),
      ('p_bundle','kit-b','Kit B','حزمة بي',200000,999999,'cat_main','cat_sub');

    INSERT INTO expense_categories (id,slug,name_ar,name_en,name_ckb,sort) VALUES
      ('exc_rent','rent','إيجار','Rent','کرێ',10),
      ('exc_ads','ads','إعلانات','Advertising','ڕیکلام',20);
  `);

  const order = (
    id: string,
    status: string,
    deliveredAt: string | null,
    subtotal: number,
    shipping: number,
    codTax: number,
    points: number,
    opts: { seller?: string; coupon?: number } = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
            payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,cod_tax_iqd,exchange_rate,
            total_iqd,due_on_delivery_iqd,delivered_at,seller_type,coupon_snapshot,created_at)
         VALUES (?,'buyer',?,'{}','standard','{}','cash',?,?,?,?,1400,?,?,?,?,?,'2026-01-05T09:00:00.000Z')`
      )
      .run(
        id,
        status,
        subtotal,
        shipping,
        points,
        codTax,
        subtotal + shipping + codTax - points,
        0,
        deliveredAt,
        opts.seller ?? 'levonis',
        opts.coupon ? JSON.stringify({ code: 'X', discount_iqd: opts.coupon }) : null
      );

  const item = (
    id: string,
    orderId: string,
    productId: string | null,
    qty: number,
    unit: number,
    line: number,
    cost: number | null,
    basis: string,
    extra: { membership?: number; coupon?: number; parent?: string; alloc?: number } = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
            cost_iqd,cost_basis,membership_discount_iqd,coupon_discount_iqd,bundle_parent_item_id,component_alloc_iqd)
         VALUES (?,?,?,'x',?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id, orderId, productId, qty, unit, line, cost, basis,
        extra.membership ?? 0, extra.coupon ?? 0, extra.parent ?? null, extra.alloc ?? null
      );

  // O1 — delivered in the LAST millisecond of February, Baghdad time.
  order('o1', 'delivered', LAST_MS_OF_FEBRUARY, 500_000, 10_000, 12_000, 5_000);
  item('i1', 'o1', 'p_printer', 1, 500_000, 500_000, 290_000, 'snapshot'); // a FACT

  // O2 — delivered in the FIRST millisecond of March, Baghdad time. One
  // millisecond after O1 and a different MONTH. 'unrecorded' is every pre-0095
  // row, so its cost is ESTIMATED from today's catalogue: 3 × 4,000.
  order('o2', 'delivered', FIRST_MS_OF_MARCH, 30_000, 5_000, 0, 0);
  item('i2', 'o2', 'p_filament', 3, 10_000, 30_000, null, 'unrecorded');

  // O3 — mid-March, two lines: an 'unpriced' one (UNKNOWN, and 0095 forbids
  // estimating it) and a measured one carrying a membership saving. The order
  // also carries a coupon, which belongs to no line today.
  order('o3', 'delivered', '2026-03-05T10:00:00.000Z', 650_000, 8_000, 6_000, 20_000, { coupon: 15_000 });
  item('i3', 'o3', 'p_nocost', 2, 25_000, 50_000, null, 'unpriced');
  item('i4', 'o3', 'p_printer', 1, 600_000, 600_000, 310_000, 'snapshot', { membership: 60_000 });

  // O4 — CANCELLED. Never revenue, never cost, whatever it carries.
  order('o4', 'cancelled', null, 999_000, 9_000, 9_000, 0);
  item('i5', 'o4', 'p_printer', 1, 999_000, 999_000, 400_000, 'snapshot');

  // O5 — SHIPPED, not delivered. A backlog, not income (§1).
  order('o5', 'shipped', null, 777_000, 7_000, 0, 0);
  item('i6', 'o5', 'p_printer', 1, 777_000, 777_000, 400_000, 'snapshot');

  // O6 — delivered, but a legacy row with no delivery instant. It belongs to
  // no day and must be COUNTED rather than silently dropped.
  order('o6', 'delivered', '', 111_000, 0, 0, 0);
  item('i7', 'o6', 'p_printer', 1, 111_000, 111_000, 100_000, 'snapshot');

  // O7 — a MERCHANT-STORE order, delivered in March. Its goods are the
  // merchant's stock; counting the basket as this shop's revenue would inflate
  // sales by somebody else's takings and, with no cost against it, print the
  // lot as profit.
  order('o7', 'delivered', '2026-03-06T10:00:00.000Z', 444_000, 4_000, 0, 0, { seller: 'merchant' });
  item('i8', 'o7', 'p_printer', 1, 444_000, 444_000, 200_000, 'snapshot');

  // O8 — a BUNDLE, delivered in APRIL so it has a month to itself. The parent
  // holds the whole price and `cost_basis = 'composed'`; the components hold
  // the goods and their own snapshots. `Σ component_alloc_iqd` is exactly the
  // parent's `line_total_iqd`, which is what lets the per-product column still
  // add up to the period.
  order('o8', 'delivered', '2026-04-05T10:00:00.000Z', 200_000, 0, 0, 0);
  item('i9', 'o8', 'p_bundle', 1, 200_000, 200_000, null, 'composed');
  item('i10', 'o8', 'p_printer', 1, 0, 0, 120_000, 'snapshot', { parent: 'i9', alloc: 150_000 });
  item('i11', 'o8', 'p_filament', 2, 0, 0, 3_000, 'snapshot', { parent: 'i9', alloc: 50_000 });

  // O9 — MAY, and it exists for ONE assertion: an order carrying a coupon at
  // BOTH levels. Nothing in the codebase writes `order_items.coupon_discount_iqd`
  // today (migration 0077 added the column; checkout's INSERT does not name
  // it), so this row is synthetic on purpose — it pins down what the report
  // does the day a writer lands.
  order('o9', 'delivered', '2026-05-05T10:00:00.000Z', 100_000, 0, 0, 0, { coupon: 20_000 });
  item('i12', 'o9', 'p_filament', 1, 100_000, 100_000, 30_000, 'snapshot', { coupon: 8_000 });

  // A REFUND of O1's whole line, decided in MARCH. It reverses February's sale
  // inside MARCH — February's closed figures do not move (§1).
  raw
    .prepare(
      `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
       VALUES ('rc1','o1','i1','buyer',1,'defective','resolved','refund','2026-03-10T09:00:00.000Z')`
    )
    .run();
  // A refund against the CANCELLED order. It must reverse nothing: this report
  // never recognised that sale, so subtracting it would invent a loss.
  raw
    .prepare(
      `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at)
       VALUES ('rc2','o4','i5','buyer',1,'defective','resolved','refund','2026-03-11T09:00:00.000Z')`
    )
    .run();
  // An OPEN case: requested, never resolved. Not a refund yet, so not an event.
  raw
    .prepare(
      `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,decided_at)
       VALUES ('rc3','o3','i4','buyer',1,'defective','requested','2026-03-12T09:00:00.000Z')`
    )
    .run();

  raw.exec(`
    INSERT INTO operating_expenses (id,category_id,amount_iqd,expense_day,title) VALUES
      ('e_feb','exc_rent',200000,'2026-02-10','إيجار شباط'),
      ('e_mar1','exc_ads',100000,'2026-03-03','إعلان'),
      ('e_mar2','exc_rent',250000,'2026-03-20','إيجار آذار'),
      ('e_void','exc_ads',900000,'2026-03-21','خطأ');
    UPDATE operating_expenses SET voided_at = '2026-03-22T00:00:00.000Z' WHERE id = 'e_void';
  `);
  return raw;
}

const appFor = (raw: DatabaseSync, user: { id: string; email: string; admin_scope?: string | null }) => {
  resetFinanceSchemaMemo();
  return stubApp(asD1(raw), { ...user, role: 'admin' }, (a) =>
    a.route('/api/admin/finance/report', adminFinanceReportRoutes)
  );
};

const OWNER = { id: 'boss', email: 'boss@x.co' };
const ASSISTANT = { id: 'helper', email: 'helper@x.co', admin_scope: 'assistant' };

// =========================================================== the pure rules

test('a Baghdad day boundary is three hours before the UTC one', () => {
  assert.equal(baghdadDayOf(LAST_MS_OF_FEBRUARY), '2026-02-28');
  assert.equal(baghdadDayOf(FIRST_MS_OF_MARCH), '2026-03-01');
  // The bug this prevents, stated as an assertion: slicing the ISO string puts
  // both instants in February, so a month report would be a night short.
  assert.equal(FIRST_MS_OF_MARCH.slice(0, 10), '2026-02-28');
});

test('the UTC window for a Baghdad range is half-open and offset by three hours', () => {
  const w = utcWindowFor({ from: '2026-03-01', to: '2026-03-31', days: 31 });
  assert.equal(w.startIso, '2026-02-28T21:00:00.000Z');
  assert.equal(w.endIso, '2026-03-31T21:00:00.000Z');
  // The last instant of February is OUTSIDE a March window, and the first
  // instant of March is inside it. One millisecond decides both.
  assert.ok(LAST_MS_OF_FEBRUARY < w.startIso);
  assert.ok(FIRST_MS_OF_MARCH >= w.startIso && FIRST_MS_OF_MARCH < w.endIso);
});

test('the previous period has equal length and does not overlap', () => {
  const range = { from: '2026-03-01', to: '2026-03-31', days: 31 };
  const prev = previousRangeOf(range);
  assert.deepEqual(prev, { from: '2026-01-29', to: '2026-02-28', days: 31 });
  assert.ok(prev.to < range.from);
  assert.equal(daysBetween(prev.from, prev.to), range.days);
});

test('a range is validated, and the length cap is enforced in one place', () => {
  assert.ok('error' in resolveRange('2026-13-01', '2026-03-01'));
  assert.ok('error' in resolveRange('2026-03-05', '2026-03-01'));
  assert.ok('error' in resolveRange('2025-01-01', '2026-12-31'));
  assert.deepEqual(resolveRange('2026-03-01', '2026-03-31'), {
    range: { from: '2026-03-01', to: '2026-03-31', days: 31 },
  });
});

test('weeks start on Saturday, so the Iraqi weekend is not split', () => {
  // 2026-03-07 is a Saturday; 2026-03-08 a Sunday; 2026-03-13 a Friday.
  assert.equal(bucketKeyOf('2026-03-07', 'week'), '2026-03-07');
  assert.equal(bucketKeyOf('2026-03-08', 'week'), '2026-03-07');
  assert.equal(bucketKeyOf('2026-03-13', 'week'), '2026-03-07');
  assert.equal(bucketKeyOf('2026-03-14', 'week'), '2026-03-14');
  assert.equal(bucketKeyOf('2026-03-14', 'month'), '2026-03');
});

test('a margin is null, not zero, when there is no base', () => {
  assert.equal(marginPercent(0, 0), null);
  assert.equal(marginPercent(1000, -5), null);
  // Rounded once, at the end, to two places: 38,000 / 70,000 = 54.2857…%
  assert.equal(marginPercent(38_000, 70_000), 54.29);
});

// =============================================== the numbers, end to end

test('February is exactly one order, and the refund decided in March does not move it', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-02-01&to=2026-02-28&granularity=range'));
  assert.equal(r.success, true);
  const t = r.totals;

  // O1 alone. O2 is one millisecond later and is MARCH; O4 is cancelled; O5 is
  // shipped; O6 has no delivery instant at all.
  assert.equal(t.gross_revenue_iqd, 500_000);
  assert.equal(t.refunded_revenue_iqd, 0); // decided in March, recognised in March
  assert.equal(t.revenue_iqd, 500_000);
  assert.equal(t.costed_revenue_iqd, 500_000);
  assert.equal(t.uncosted_revenue_iqd, 0);
  assert.equal(t.cogs_iqd, 290_000);
  assert.equal(t.gross_profit_iqd, 210_000); // 500,000 − 290,000
  assert.equal(t.gross_margin_percent, 42); // 210,000 / 500,000
  assert.equal(t.orders, 1);
  assert.equal(t.units, 1);
  assert.equal(t.estimated, false); // i1 is a 'snapshot' — a fact

  // Order-level collections and the opex the admin entered for February.
  assert.equal(t.shipping_collected_iqd, 10_000);
  assert.equal(t.cod_tax_collected_iqd, 12_000);
  assert.equal(t.points_redeemed_iqd, 5_000);
  assert.equal(t.coupon_discount_iqd, 0);
  assert.equal(t.operating_expenses_iqd, 200_000);
  // 210,000 + 10,000 + 12,000 − 5,000 − 0 − 200,000
  assert.equal(t.net_profit_iqd, 27_000);
  // 27,000 / (500,000 + 10,000 + 12,000) = 5.1724…%
  assert.equal(t.net_margin_percent, 5.17);

  // The legacy delivered order with no instant is counted, not dropped.
  assert.equal(r.meta.unrecognized_orders, 1);
  assert.equal(r.meta.recognition, 'delivered_baghdad_day');
  assert.equal(r.meta.timezone, 'Asia/Baghdad');
  assert.equal(r.meta.scope, 'levonis_own_sales');
  assert.equal(r.meta.cost_snapshot_available, true);
  assert.equal(r.meta.operating_expenses_available, true);
});

test('March carries the midnight order, the estimate, the unknown cost and the refund', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=range'));
  const t = r.totals;

  // Sales: O2 30,000 + O3 (50,000 unpriced + 600,000 − 60,000 membership =
  // 540,000) = 620,000 gross. O7 is a merchant order and is not this shop's.
  assert.equal(t.gross_revenue_iqd, 620_000);
  assert.equal(t.refunded_revenue_iqd, 500_000); // O1's whole line, reversed here
  assert.equal(t.revenue_iqd, 120_000);
  assert.equal(t.refunded_cogs_iqd, 290_000); // the goods went back on the shelf
  assert.equal(t.refunded_units, 1);
  // ONE case, not three: the refund against the CANCELLED order reverses
  // nothing (that sale was never recognised) and the open case is not a refund.
  assert.equal(t.refund_cases, 1);

  // The 'unpriced' line's 50,000 is revenue but is NOT in the margin base, and
  // 0095 forbids estimating it from the catalogue after the fact.
  assert.equal(t.uncosted_revenue_iqd, 50_000);
  assert.equal(t.uncosted_units, 2);
  assert.equal(t.uncosted_lines, 1);
  // 30,000 + 540,000 − 500,000 refunded
  assert.equal(t.costed_revenue_iqd, 70_000);
  // 12,000 estimated + 310,000 measured − 290,000 refunded
  assert.equal(t.cogs_iqd, 32_000);
  assert.equal(t.gross_profit_iqd, 38_000);
  assert.equal(t.gross_margin_percent, 54.29);

  // The estimate flag survived aggregation, with its counts.
  assert.equal(t.estimated, true);
  assert.equal(t.estimated_lines, 1); // only i2 is 'unrecorded' with a catalogue cost
  assert.equal(t.estimated_units, 3);
  assert.equal(t.estimated_cogs_iqd, 12_000); // 3 × 4,000, today's catalogue cost

  assert.equal(t.orders, 2);
  assert.equal(t.units, 6); // 3 filament + 2 riddle + 1 printer
  assert.equal(t.shipping_collected_iqd, 13_000);
  assert.equal(t.cod_tax_collected_iqd, 6_000);
  assert.equal(t.points_redeemed_iqd, 20_000);
  assert.equal(t.coupon_discount_iqd, 15_000); // O3's order-level coupon
  // The voided expense row is excluded: 100,000 + 250,000, not 1,250,000.
  assert.equal(t.operating_expenses_iqd, 350_000);
  assert.equal(t.expense_entries, 2);
  // 38,000 + 13,000 + 6,000 − 20,000 − 15,000 − 350,000
  assert.equal(t.net_profit_iqd, -328_000);

  // Where the money went, by the owner's own categories, in three languages.
  const cats = new Map<string, { amount_iqd: number; name_ar: string; name_ckb: string }>(
    (r.expense_categories as Array<{ id: string; amount_iqd: number; name_ar: string; name_ckb: string }>).map((x) => [
      x.id,
      x,
    ])
  );
  assert.equal(cats.get('exc_rent')?.amount_iqd, 250_000);
  assert.equal(cats.get('exc_ads')?.amount_iqd, 100_000); // the voided 900,000 is not here
  assert.equal(cats.get('exc_rent')?.name_ar, 'إيجار');
  assert.equal(cats.get('exc_rent')?.name_ckb, 'کرێ');
});

test("a merchant store's basket is never counted as this shop's revenue", async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-06&to=2026-03-06&granularity=range'));
  // O7 was delivered on this day and is worth 444,000 — to the merchant.
  assert.equal(r.totals.gross_revenue_iqd, 0);
  assert.equal(r.totals.orders, 0);
  assert.equal(r.totals.shipping_collected_iqd, 0);
});

test('a bundle books its money on the parent and its cost on the components, once', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-04-01&to=2026-04-30&granularity=range'));
  const t = r.totals;

  assert.equal(t.revenue_iqd, 200_000); // the parent's line total; components are 0
  // 120,000 + 2 × 3,000 — and NOT p_bundle's own 999,999 product cost, which is
  // exactly what 'composed' exists to keep out of the total.
  assert.equal(t.cogs_iqd, 126_000);
  assert.equal(t.gross_profit_iqd, 74_000);
  assert.equal(t.gross_margin_percent, 37);
  assert.equal(t.uncosted_revenue_iqd, 0); // the parent is COSTED, at zero
  assert.equal(t.units, 3); // 1 printer + 2 filament; the parent's 1 bundle is not a unit
  assert.equal(t.lines, 3);

  const products = await json(await get(a, '/api/admin/finance/report/products?from=2026-04-01&to=2026-04-30'));
  const by = new Map<string, Record<string, number>>(
    (products.products as Array<{ id: string; totals: Record<string, number> }>).map((x) => [x.id, x.totals])
  );
  // THE KNOWN LIMIT OF PER-PRODUCT ATTRIBUTION FOR BUNDLES, asserted so it is a
  // documented shape rather than a surprise: the revenue is on the bundle's own
  // product row and the cost is on the components' rows. The period totals are
  // exact either way, and per-product REVENUE still adds up.
  assert.equal(by.get('p_bundle')?.revenue_iqd, 200_000);
  assert.equal(by.get('p_bundle')?.cogs_iqd, 0);
  assert.equal(by.get('p_printer')?.cogs_iqd, 120_000);
  assert.equal(by.get('p_filament')?.cogs_iqd, 6_000);
  const revenue = [...by.values()].reduce((n, x) => n + x.revenue_iqd, 0);
  const gross = [...by.values()].reduce((n, x) => n + x.gross_profit_iqd, 0);
  assert.equal(revenue, 200_000);
  assert.equal(gross, 74_000);
});

test('a coupon is subtracted where it is frozen — and today that is the order', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-05-01&to=2026-05-31&granularity=range'));

  // CHARACTERIZATION, NOT A BLESSING. O9 carries a coupon at BOTH levels, which
  // no real order can today: checkout never writes
  // `order_items.coupon_discount_iqd`, so the per-line subtraction below is
  // always 0 and the order-level figure is the whole truth. The day a writer
  // for 0077's column lands, THIS TEST FAILS — and that is the point, because
  // at that moment `ORDERS_BY_DAY_SQL` must start reporting the RESIDUAL
  // instead, or the same coupon is taken off twice.
  assert.equal(r.totals.revenue_iqd, 92_000); // 100,000 − 8,000 frozen on the line
  assert.equal(r.totals.coupon_discount_iqd, 20_000); // the order-level figure
  assert.equal(r.totals.gross_profit_iqd, 62_000); // 92,000 − 30,000
  assert.equal(r.totals.net_profit_iqd, 42_000); // 62,000 − 20,000
});

test('a day report puts the midnight order on the first of March, and the days sum exactly', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=day'));

  const byKey = new Map<string, Record<string, number>>(
    (r.buckets as Array<{ key: string; totals: Record<string, number> }>).map((b) => [b.key, b.totals])
  );
  assert.equal(byKey.get('2026-03-01')?.revenue_iqd, 30_000); // the midnight order
  assert.equal(byKey.get('2026-03-05')?.gross_revenue_iqd, 590_000); // 50,000 + 540,000
  assert.equal(byKey.get('2026-03-06')?.revenue_iqd, 0); // the merchant order's day
  assert.equal(byKey.get('2026-03-10')?.refunded_revenue_iqd, 500_000);
  assert.equal(byKey.get('2026-03-10')?.revenue_iqd, -500_000); // a refund-only day is negative
  assert.equal(byKey.get('2026-03-02')?.revenue_iqd, 0); // an empty day is still a day

  // THE PROPERTY THAT MAKES THE SCREEN TRUSTWORTHY: the parts re-add to the
  // whole, to the dinar, with nothing lost to rounding (§8).
  const sum = (field: string) =>
    (r.buckets as Array<{ totals: Record<string, number> }>).reduce((n, b) => n + b.totals[field], 0);
  for (const field of [
    'revenue_iqd',
    'cogs_iqd',
    'gross_profit_iqd',
    'coupon_discount_iqd',
    'operating_expenses_iqd',
    'net_profit_iqd',
  ]) {
    assert.equal(sum(field), r.totals[field], `${field} must be the exact sum of its days`);
  }

  // 31 days asked for, 31 buckets returned — a chart with a real gap in it.
  assert.equal(r.buckets.length, 31);
});

test('a week bucket is a Saturday and its days still sum exactly', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=week'));
  const keys = (r.buckets as Array<{ key: string }>).map((b) => b.key);
  // 1 March 2026 is a Sunday, so its week began on Saturday 28 February — and
  // the bucket's span is CLAMPED to the range rather than claiming a day the
  // report never looked at.
  assert.equal(keys[0], '2026-02-28');
  assert.equal(r.buckets[0].from, '2026-03-01');
  const sum = (r.buckets as Array<{ totals: Record<string, number> }>).reduce(
    (n, b) => n + b.totals.revenue_iqd,
    0
  );
  assert.equal(sum, r.totals.revenue_iqd);
});

test('month buckets and the equal-length comparison', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=month'));

  assert.equal(r.buckets.length, 1);
  assert.equal(r.buckets[0].key, '2026-03');
  assert.equal(r.buckets[0].from, '2026-03-01');
  assert.equal(r.buckets[0].to, '2026-03-31');
  assert.equal(r.buckets[0].change, null); // nothing before it in this list

  // The previous 31 days end on 28 February, so O1 is the whole of it.
  assert.deepEqual(r.previous.range, { from: '2026-01-29', to: '2026-02-28', days: 31 });
  assert.equal(r.previous.totals.revenue_iqd, 500_000);
  assert.equal(r.previous.totals.gross_profit_iqd, 210_000);

  assert.equal(r.change.revenue_iqd, 120_000 - 500_000);
  assert.equal(r.change.gross_profit_iqd, 38_000 - 210_000);
  // (38,000 − 210,000) / 210,000 = −81.9047…%
  assert.equal(r.change.gross_profit_percent, -81.9);
  assert.equal(r.change.orders, 1);
});

test('month-over-month change is the difference from the bucket before it', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-02-01&to=2026-03-31&granularity=month'));

  assert.deepEqual(r.buckets.map((b: { key: string }) => b.key), ['2026-02', '2026-03']);
  assert.equal(r.buckets[0].change, null);
  assert.equal(r.buckets[1].change.revenue_iqd, 120_000 - 500_000);
  assert.equal(r.buckets[1].change.revenue_percent, -76); // −380,000 / 500,000
});

test('the product breakdown adds up to the period, and carries no net profit', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/products?from=2026-03-01&to=2026-03-31'));

  const by = new Map<string, Record<string, number>>(
    (r.products as Array<{ id: string; totals: Record<string, number> }>).map((p) => [p.id, p.totals])
  );
  // The printer sold 540,000 in March and had 500,000 reversed by February's
  // refund landing here — a product can be barely positive on a month it sold
  // well in, and the row says so instead of hiding the return.
  assert.equal(by.get('p_printer')?.revenue_iqd, 40_000);
  assert.equal(by.get('p_printer')?.cogs_iqd, 20_000); // 310,000 − 290,000
  assert.equal(by.get('p_printer')?.gross_profit_iqd, 20_000);
  assert.equal(by.get('p_filament')?.revenue_iqd, 30_000);
  assert.equal(by.get('p_filament')?.gross_profit_iqd, 18_000);
  assert.equal(by.get('p_filament')?.estimated, true);
  // The 'unpriced' product: real revenue, no margin, and it says why.
  assert.equal(by.get('p_nocost')?.revenue_iqd, 50_000);
  assert.equal(by.get('p_nocost')?.costed_revenue_iqd, 0);
  assert.equal(by.get('p_nocost')?.uncosted_revenue_iqd, 50_000);
  assert.equal(by.get('p_nocost')?.gross_margin_percent, null);

  const total = [...by.values()].reduce((n, t) => n + t.revenue_iqd, 0);
  assert.equal(total, 120_000, 'the product column must add up to the period revenue');

  // §5: an operating expense belongs to no product, so there is no per-product
  // net profit — and the field is ABSENT, not zero, so nothing can read a zero
  // as a claim.
  for (const p of r.products as Array<{ totals: Record<string, unknown> }>) {
    assert.ok(!('net_profit_iqd' in p.totals));
    assert.ok(!('operating_expenses_iqd' in p.totals));
    assert.ok(!('shipping_collected_iqd' in p.totals));
    assert.ok(!('coupon_discount_iqd' in p.totals));
  }
});

test('the category breakdown keeps unfiled revenue instead of dropping it', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/categories?from=2026-03-01&to=2026-03-31&level=main'));

  const by = new Map<string | null, Record<string, number>>(
    (r.categories as Array<{ id: string | null; totals: Record<string, number> }>).map((x) => [x.id, x.totals])
  );
  assert.equal(by.get('cat_main')?.revenue_iqd, 70_000); // printer 40,000 + filament 30,000
  assert.equal(by.get('cat_main')?.gross_profit_iqd, 38_000);
  // The product in no catalogue is its own row, not a missing one.
  assert.equal(by.get(null)?.revenue_iqd, 50_000);
  const total = [...by.values()].reduce((n, t) => n + t.revenue_iqd, 0);
  assert.equal(total, 120_000, 'the category column must add up to the period revenue');

  const names = (r.categories as Array<{ id: string | null; name_ar: string; name_ckb: string }>).find(
    (x) => x.id === 'cat_main'
  );
  // All three languages travel, so the client calls loc(ar, en, ckb) and the
  // server never decides that a Kurdish reader gets Arabic.
  assert.equal(names?.name_ar, 'طابعات');
  assert.equal(names?.name_ckb, 'چاپکەرەکان');
});

// ================================================================ the gate

test('an assistant admin is refused every financial endpoint, before any query', async () => {
  const raw = seed();
  const a = appFor(raw, ASSISTANT);
  for (const path of [
    '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31',
    '/api/admin/finance/report/products?from=2026-03-01&to=2026-03-31',
    '/api/admin/finance/report/categories?from=2026-03-01&to=2026-03-31',
  ]) {
    const res = await get(a, path);
    assert.equal(res.status, 403, path);
    const body = await json(res);
    assert.equal(body.code, 'FINANCIAL_SCOPE_REQUIRED');
    // Nothing financial leaked into the refusal itself.
    const text = JSON.stringify(body);
    assert.ok(!text.includes('cogs'));
    assert.ok(!text.includes('revenue'));
    assert.ok(!text.includes('profit_iqd'));
  }
});

test('the owner is financial even when the row says assistant', async () => {
  const raw = seed();
  // INITIAL_ADMIN_EMAIL is boss@x.co in the stub environment: a compromised
  // assistant must not be able to take the owner's own numbers away.
  const a = appFor(raw, { ...OWNER, admin_scope: 'assistant' });
  const res = await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=range');
  assert.equal(res.status, 200);
  assert.equal((await json(res)).totals.gross_profit_iqd, 38_000);
});

test('a merchant subdomain does not know these endpoints exist', async () => {
  const raw = seed();
  resetFinanceSchemaMemo();
  const a = stubApp(
    asD1(raw),
    { ...OWNER, role: 'admin' },
    (x) => x.route('/api/admin/finance/report', adminFinanceReportRoutes),
    { host: `somestore.${APEX}` }
  );
  assert.equal((await get(a, '/api/admin/finance/report/summary')).status, 404);
});

// ===================================================== a database behind

test('a deployment ahead of migration 0095 answers honestly instead of failing', async () => {
  // The same shape of data on a database one migration behind: no cost
  // snapshot, no cost basis, no expense ledger. This is a real minute of every
  // deploy, and a 500 here reads as «شاشة الأرباح خربانة».
  const raw = dbThrough('0094');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Owner','boss@x.co','h','admin');
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','sara@x.co','h','customer');
    INSERT INTO products (id,slug,name,price_iqd,product_cost_iqd) VALUES ('p1','a','A',100000,60000);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
        payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('o1','buyer','delivered','{}','standard','{}','cash',100000,0,1400,100000,0,'2026-03-05T10:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('i1','o1','p1','x',1,100000,100000);
  `);
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=range'));

  assert.equal(r.meta.cost_snapshot_available, false);
  assert.equal(r.meta.operating_expenses_available, false);
  // The cost still resolves — from TODAY's catalogue — and is flagged as the
  // estimate it is, rather than being reported as a measured profit.
  assert.equal(r.totals.cogs_iqd, 60_000);
  assert.equal(r.totals.gross_profit_iqd, 40_000);
  assert.equal(r.totals.estimated, true);
  assert.equal(r.totals.estimated_lines, 1);
  // No ledger means no expenses — and `operating_expenses_available: false` is
  // what stops that zero being read as «ما صرفنا شي».
  assert.equal(r.totals.operating_expenses_iqd, 0);
  assert.equal(r.totals.net_profit_iqd, 40_000);
  assert.deepEqual(r.expense_categories, []);
});

// ========================================================= the input guard

test('a range longer than the cap is refused rather than scanned', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  const res = await get(a, '/api/admin/finance/report/summary?from=2024-01-01&to=2026-03-31');
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'BAD_RANGE');
});

test('mounted under track A\'s ledger prefix, both routers still answer', async () => {
  // THE MOUNT THIS FEATURE DEPENDS ON, READ OUT OF THE DEPLOYED ENTRY FILE.
  //
  // This assertion used to assemble its own Hono app with both `route()` calls
  // written inside the test, and it passed for as long as worker/index.ts had
  // no such line at all: every request to /api/admin/finance/report/* answered
  // 404 in production while this suite was green. A test that builds the thing
  // it is supposed to be checking cannot fail the way the system fails.
  //
  // So the FIRST check reads wrangler.jsonc's `main` and asserts the two lines
  // are there and in the right order — longer prefix registered SECOND, since
  // Hono matches in registration order — and only then does the second half
  // prove that order actually serves both routers.
  const entry = readFileSync(resolve(import.meta.dirname, '..', 'worker', 'index.ts'), 'utf8');
  const ledgerAt = entry.indexOf("app.route('/api/admin/finance', adminFinanceRoutes)");
  const reportAt = entry.indexOf("app.route('/api/admin/finance/report', adminFinanceReportRoutes)");
  assert.ok(entry.includes("from './routes/adminFinanceReport'"), 'worker/index.ts must import the report router');
  assert.ok(ledgerAt > 0, 'worker/index.ts must mount the expense ledger');
  assert.ok(reportAt > 0, 'worker/index.ts must mount the profit report — without it the whole dashboard is 404');
  assert.ok(reportAt > ledgerAt, 'the /report mount must come AFTER the ledger mount');

  const raw = seed();
  resetFinanceSchemaMemo();
  const a = stubApp(asD1(raw), { ...OWNER, role: 'admin' }, (x) => {
    x.route('/api/admin/finance', adminFinanceRoutes);
    x.route('/api/admin/finance/report', adminFinanceReportRoutes);
  });

  const report = await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=range');
  assert.equal(report.status, 200);
  assert.equal((await json(report)).totals.gross_profit_iqd, 38_000);

  // And track A's own ledger is untouched by the neighbour.
  const ledger = await get(a, '/api/admin/finance/expenses?from=2026-03-01&to=2026-03-31');
  assert.equal(ledger.status, 200);
});

test('a product returned but not sold in the period is a named row, not a blank one', async () => {
  const raw = seed();
  const a = appFor(raw, OWNER);
  // One day: 10 March, which holds the refund of February's printer and no
  // sale at all. The row must carry the product's name — the refund query
  // joins `products` for exactly this — and it must reverse February's profit
  // rather than inventing a new one.
  const r = await json(await get(a, '/api/admin/finance/report/products?from=2026-03-10&to=2026-03-10'));
  assert.equal(r.products.length, 1);
  const row = r.products[0];
  assert.equal(row.id, 'p_printer');
  assert.equal(row.name_ar, 'طابعة إكس');
  assert.equal(row.totals.revenue_iqd, -500_000);
  assert.equal(row.totals.cogs_iqd, -290_000);
  assert.equal(row.totals.gross_profit_iqd, -210_000); // February's profit, undone
});

// ============================== a composition is only as costed as its goods

/**
 * Seed helper for the two defects a bundle PARENT can hide. Both write rows
 * the checkout really produces:
 *
 *   A MYSTERY BOX — the parent holds the whole price; the spool rows hold the
 *   goods, carry `product_id = NULL` (docs §7.7 keeps the draw secret) and
 *   take migration 0095's `'unrecorded'` default because the draw's candidate
 *   record has no cost to snapshot. There is nothing to measure and nothing to
 *   estimate, so the honest answer is UNKNOWN.
 *
 *   A LEGACY BUNDLE — sold before 0095 existed, so all three rows carry the
 *   ALTER's `'unrecorded'` default, parent included. It is a parent because
 *   other rows point at it, and for no other reason.
 */
function bundleCase(raw: DatabaseSync, kind: 'mystery' | 'legacy'): void {
  const ins = (sql: string, ...args: unknown[]) => raw.prepare(sql).run(...(args as never[]));
  ins(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
        payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,cod_tax_iqd,exchange_rate,
        total_iqd,due_on_delivery_iqd,delivered_at,seller_type,created_at)
     VALUES (?,'buyer','delivered','{}','standard','{}','cash',200000,0,0,0,1400,200000,0,
             '2026-06-05T10:00:00.000Z','levonis','2026-06-01T09:00:00.000Z')`,
    kind === 'mystery' ? 'o_myst' : 'o_leg'
  );
  const item = (
    id: string,
    orderId: string,
    productId: string | null,
    qty: number,
    line: number,
    cost: number | null,
    basis: string,
    parent: string | null,
    alloc: number | null
  ) =>
    ins(
      `INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
          cost_iqd,cost_basis,membership_discount_iqd,coupon_discount_iqd,bundle_parent_item_id,component_alloc_iqd)
       VALUES (?,?,?,'x',?,?,?,?,?,0,0,?,?)`,
      id, orderId, productId, qty, line, line, cost, basis, parent, alloc
    );

  if (kind === 'mystery') {
    // The parent IS 'composed' — checkout writes that today. Its components
    // are spools with no product and no cost: unknowable, not free.
    item('m_parent', 'o_myst', 'p_bundle', 1, 200_000, null, 'composed', null, null);
    item('m_spool1', 'o_myst', null, 1, 0, null, 'unrecorded', 'm_parent', 120_000);
    item('m_spool2', 'o_myst', null, 1, 0, null, 'unrecorded', 'm_parent', 80_000);
  } else {
    // Every row 'unrecorded', as the ALTER left them. p_bundle's own
    // product_cost_iqd is 999,999 — the number that must NEVER be charged.
    item('l_parent', 'o_leg', 'p_bundle', 1, 200_000, null, 'unrecorded', null, null);
    item('l_kid1', 'o_leg', 'p_printer', 1, 0, null, 'unrecorded', 'l_parent', 150_000);
    item('l_kid2', 'o_leg', 'p_filament', 2, 0, null, 'unrecorded', 'l_parent', 50_000);
  }
}

test('a mystery box reports UNKNOWN cost, never 100% margin', async () => {
  const raw = seed();
  bundleCase(raw, 'mystery');
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-06-01&to=2026-06-30&granularity=range'));
  const t = r.totals;

  assert.equal(t.gross_revenue_iqd, 200_000); // the money is real and is reported
  // AND NONE OF IT IS IN THE MARGIN BASE. The parent used to be booked as
  // costed-at-zero, which turned a mystery box into 200,000 of pure profit —
  // the exact figure migration 0095's owner note says must never appear.
  assert.equal(t.costed_revenue_iqd, 0);
  assert.equal(t.uncosted_revenue_iqd, 200_000);
  assert.equal(t.cogs_iqd, 0);
  assert.equal(t.gross_profit_iqd, 0);
  assert.equal(t.gross_margin_percent, null); // «لا نعرف», not «٠٪», not «١٠٠٪»
  // And the disclosure carries the MONEY, so «سطر واحد بقيمة ٠ د.ع» — which
  // reads as nothing to worry about — cannot be what the owner is shown.
  assert.equal(t.uncosted_revenue_iqd > 0, true);
  assert.equal(t.estimated_lines, 0);
  // The parent's qty is a number of BOXES and its spools' are pieces; only the
  // pieces are units.
  assert.equal(t.units, 2);
});

test('a fully refunded mystery box takes its revenue AND its disclosure back to zero', async () => {
  const raw = seed();
  bundleCase(raw, 'mystery');
  // One case per component, which is what worker/routes/returns.ts opens: the
  // parent is priced but holds nothing physical, so no case is ever raised
  // against it. The reversal has to find its way back to the parent's money
  // through `component_alloc_iqd`.
  raw.exec(`
    INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES
      ('rc_m1','o_myst','m_spool1','buyer',1,'defective','resolved','refund','2026-06-20T09:00:00.000Z'),
      ('rc_m2','o_myst','m_spool2','buyer',1,'defective','resolved','refund','2026-06-20T09:00:00.000Z');
  `);
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-06-01&to=2026-06-30&granularity=range'));
  const t = r.totals;

  assert.equal(t.revenue_iqd, 0); // sold and given back, inside one period
  assert.equal(t.costed_revenue_iqd, 0);
  // The defect this pins: the sale recognised the money on the PARENT and the
  // refund reverses on the COMPONENTS, so a parent booked as costed left
  // 200,000 of costed revenue and 200,000 of gross profit standing in a month
  // with no sales at all.
  assert.equal(t.gross_profit_iqd, 0);
  // THE INVARIANT, stated as an assertion: the two parts add to the whole.
  assert.equal(t.costed_revenue_iqd + t.uncosted_revenue_iqd, t.revenue_iqd);
  assert.equal(t.uncosted_revenue_iqd, 0);
  // The PARENT row is still a line and its cost is still unknown, so the line
  // COUNT does not reach zero: returns.ts raises a case per component and
  // never one against the parent, so there is nothing to reverse it with. That
  // is why the honesty panel's uncosted notice keys on the MONEY (see
  // src/components/adminFinance/honesty.ts): a count with «٠ د.ع» beside it is
  // the sentence that reads as "nothing to worry about" while the screen
  // prints a margin built on goods nobody priced.
  assert.equal(t.uncosted_lines, 1);
  assert.equal(t.uncosted_revenue_iqd, 0);
});

test('a bundle sold before 0095 is still a bundle: its goods are charged once, and only once', async () => {
  const raw = seed();
  bundleCase(raw, 'legacy');
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-06-01&to=2026-06-30&granularity=range'));
  const t = r.totals;

  assert.equal(t.gross_revenue_iqd, 200_000);
  // THE COST IS THE COMPONENTS' AND NOTHING ELSE: 1 × 300,000 (p_printer) +
  // 2 × 4,000 (p_filament) = 308,000, estimated from today's catalogue because
  // these rows predate the snapshot column.
  //
  // What it must NOT be is 1,307,999 — 308,000 plus p_bundle's own 999,999,
  // which is what a parent that is not recognised as a parent adds on top. A
  // month that reads −1,107,999 instead of −108,000 is a month that tells the
  // owner to stop selling their best kit.
  assert.equal(t.cogs_iqd, 308_000);
  assert.equal(t.gross_profit_iqd, -108_000);
  assert.equal(t.estimated, true);
  assert.equal(t.estimated_cogs_iqd, 308_000);
  // The parent's qty is bundles, the components' are pieces: 1 + 2, not 1+1+2.
  assert.equal(t.units, 3);
});

test('a refund of an uncosted line takes the uncosted disclosure with it', async () => {
  const raw = seed();
  // O3's `i3` is the 'unpriced' line — the sale-time resolver LOOKED and found
  // no cost. Sold for 50,000 in March and returned in March.
  raw.exec(`
    INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES
      ('rc_u','o3','i3','buyer',2,'defective','resolved','refund','2026-03-15T09:00:00.000Z');
  `);
  const a = appFor(raw, OWNER);
  const r = await json(await get(a, '/api/admin/finance/report/summary?from=2026-03-01&to=2026-03-31&granularity=range'));
  const t = r.totals;

  // The invariant the decomposition card prints line by line. Before the
  // refund reversed the disclosure side, a period could report `revenue` of
  // one figure with `costed + uncosted` of another, and the honesty panel
  // announced uncosted revenue that had already been given back.
  assert.equal(t.costed_revenue_iqd + t.uncosted_revenue_iqd, t.revenue_iqd);
  assert.equal(t.uncosted_revenue_iqd, 0); // sold for 50,000, all of it returned
  assert.equal(t.uncosted_lines, 0);
});
