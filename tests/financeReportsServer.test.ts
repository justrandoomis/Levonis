/**
 * «التقارير» — THE SERVER'S HALF OF REPORTS → ORDERS, PRODUCTS, SECTIONS AND DAYS (redesign step 4, owner 2026-11-11;
 * DECISIONS row 316).
 *
 * /summary already carried every per-order sum; step 4 adds what the tables show beside them, each from one function
 * the export reads too, so a row, the statement and a downloaded file cannot disagree:
 *   · each order's state (`finance_state`, `wait_reason`) — the same answer «known» and «waiting» give — its cash
 *     (`cash_state`) and its revenue, the margin's base;
 *   · on products and sections the pieces kept and returned (owner default: the tables count what was kept), the
 *     orders they come from, their own state, a product's main section; every line in every grouping, a line with no
 *     subsection too, so each table adds up to the period;
 *   · the sections' names in Arabic, English and Sorani from `catalogs`, the frozen snapshot when the section is gone;
 *   · each day's deductions and net after them («صافيك» on Reports → Days is the statement's), in dinars and cents;
 *   · `export.csv?view=orders|products|sections|days` (`&level`, `&part`), built from the same read as /summary, whose
 *     amounts are numbers and add up to the screen's, an unknown amount an empty cell; `view=lines` unchanged.
 *
 * Run: node --import tsx --test tests/financeReportsServer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './fixtures/app';
import { everyState, order, period, usd, world } from './fixtures/financeWorld';
import { baghdadDay } from '../worker/lib/operations';
import { cashState, waitReason } from '../worker/routes/adminFinanceWorkspace';
import type { OrderProfitBase } from '../worker/lib/orderProfit';
import { costOnEstimate, countWhereKnown, filterGroups, filterOrders, groupDays, NO_FILTER, standingOf, totalOf } from '../src/components/financeWorkspace/reportTable';
import { financeDay, type FinanceSummary } from '../src/components/financeWorkspace/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import { DaysReport } from '../src/components/financeWorkspace/Reports';

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
/**
 * A CSV of the export as a spreadsheet reads it: its BOM, then records of cells — a quoted cell may hold a comma, a doubled
 * quote or a line break; quoted text keeps its quotes in `raw` («"» marks text, a bare cell is a number or empty).
 */
function parseCsv(body: string): { bom: boolean; head: string[]; rows: Array<Record<string, { raw: string; text: string }>> } {
  const bom = body.startsWith('\uFEFF'), src = body.replace(/^\uFEFF/, ''), records: string[][] = [];
  let record: string[] = [], at = 0;
  while (at <= src.length) {
    if (src[at] === '"') {
      let end = at + 1;
      while (end < src.length && !(src[end] === '"' && src[end + 1] !== '"')) end += src[end] === '"' ? 2 : 1;
      record.push(src.slice(at, end + 1)); at = end + 1;
    } else {
      let end = at; while (end < src.length && src[end] !== ',' && src[end] !== '\r') end += 1;
      record.push(src.slice(at, end)); at = end;
    }
    if (src[at] === ',') { at += 1; continue; }
    records.push(record); record = [];
    if (src.startsWith('\r\n', at)) { at += 2; continue; }
    break;
  }
  const head = records[0].map((c) => c.replace(/^"|"$/g, ''));
  const rows = records.slice(1).map((cells) => Object.fromEntries(cells.map((raw, i) => [head[i], { raw, text: raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw }])));
  return { bom, head, rows };
}
/** What a table's cell shows for a field (the screens' rule): a row whose costs still wait has no known wages or materials. */
const shown = (r: Row, f: string) => ((f === 'wages_iqd' || f === 'materials_iqd') && n(r.pending_costs) > 0 ? null : r[f]);
/** The sum of a numeric column: unquoted cells only (an empty one is an unknown amount, as a spreadsheet's SUM skips it). */
const sumOf = (rows: ReturnType<typeof parseCsv>['rows'], field: string) => rows.reduce((v, r) => v + (r[field].raw === '' || r[field].raw.startsWith('"') ? 0 : Number(r[field].raw)), 0);

const EXPECTED: Record<string, [string, string | null]> = { fifo: ['confirmed', null], est: ['estimated', null], mag: ['waiting', 'no_price'], wage: ['waiting', 'wage_waits_cost'],
  inv: ['waiting', 'investor_waits'], err: ['waiting', 'other'], ret: ['waiting', 'refund_unknown'] };

test('every order says where it stands — the answer «known» and «waiting» give, in /summary and the paged list alike — with its revenue', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`);
  const state = Object.fromEntries((s.orders as Row[]).map((o) => [o.id, [o.finance_state, o.wait_reason]]));
  assert.deepEqual(state, EXPECTED, 'confirmed, estimated, and each reason an order can wait for');
  for (const o of s.orders as Row[]) {
    const id = String(o.id), waits = Object.entries(s.waiting.reasons as Record<string, string[]>).find(([, ids]) => ids.includes(id))?.[0] ?? null;
    assert.equal(o.wait_reason, waits, `${id}: the reason «waiting» lists it under`);
    assert.equal(o.finance_state === 'confirmed', (s.known.confirmed.order_ids as string[]).includes(id), `${id}: confirmed as «known.confirmed»`);
    assert.equal(o.finance_state === 'estimated', (s.known.estimated.order_ids as string[]).includes(id), `${id}: estimated as «known.estimated»`);
    assert.equal(o.revenue_iqd, n(o.retained_revenue_iqd) + n(o.shipping_income_iqd) + n(o.cod_tax_iqd), `${id}: revenue is net sales, delivery and the COD fee`);
  }
  const list = await w.read(`/f/orders?${w.range}`);
  assert.deepEqual(Object.fromEntries((list.orders as Row[]).map((o) => [o.id, [o.finance_state, o.wait_reason]])), EXPECTED, 'the paged list reads the same posting errors');
});

test('an order\'s cash: nothing due on delivery, none recorded yet, part of it, all of it', async () => {
  assert.deepEqual([cashState({ collected_iqd: 0, collection_difference_iqd: 0 }), cashState({ collected_iqd: 0, collection_difference_iqd: 55000 }),
    cashState({ collected_iqd: 20000, collection_difference_iqd: 35000 }), cashState({ collected_iqd: 55000, collection_difference_iqd: 0 }),
    cashState({ collected_iqd: 60000, collection_difference_iqd: -5000 })], ['prepaid', 'not_recorded', 'part', 'recorded', 'recorded']);
  const w = world();
  for (const id of ['pre', 'none', 'part', 'all']) order(w.raw, { id });
  w.raw.exec(`UPDATE orders SET due_on_delivery_iqd=0 WHERE id='pre';
    INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('c-part','part','courier',20000,'${baghdadDay()}','admin','now'),('c-all','all','courier',55000,'${baghdadDay()}','admin','now');`);
  const s = await w.read(`/f/summary?${period()}`);
  assert.deepEqual(Object.fromEntries((s.orders as Row[]).map((o) => [o.id, o.cash_state])), { pre: 'prepaid', none: 'not_recorded', part: 'part', all: 'recorded' });
});

test('products and sections: the pieces kept and returned, their orders, their own state, a product\'s section; every line in every grouping', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}&display=USD`);
  const products: Record<string, Row> = Object.fromEntries((s.products as Row[]).map((p) => [p.id, p]));
  assert.deepEqual([products.returned.qty, products.returned.kept_qty, products.returned.returned_qty], [2, 1, 1], 'the customer kept one of two');
  assert.deepEqual(products.magnet.order_ids, ['mag']);
  assert.deepEqual([products.product.main_id, products.product.main_name, products.esun.main_id, products.wage.main_id], ['printers', 'الطابعات', 'parts', 'unclassified']);
  assert.deepEqual([products.esun.estimated_lines, products.product.estimated_lines], [1, 0]);
  const states = Object.fromEntries(Object.entries(products).map(([id, p]) => [id, [p.finance_state, p.wait_reason]]));
  assert.deepEqual(states, { product: ['confirmed', null], esun: ['estimated', null], magnet: ['waiting', 'no_price'], wage: ['waiting', 'wage_waits_cost'],
    funded: ['waiting', 'investor_waits'], held: ['waiting', 'other'], returned: ['waiting', 'refund_unknown'] }, 'a product stands as its lines do, by the orders\' rule');
  // Every line in every grouping: the products, the main sections and the subsections each add up to the period.
  const t = s.totals;
  for (const level of ['product', 'main', 'sub']) {
    const rows = level === 'product' ? s.products as Row[] : (s.categories as Row[]).filter((c) => c.level === level);
    for (const f of ['retained_revenue_iqd', 'shipping_income_iqd', 'promotion_iqd', 'coupon_iqd']) assert.equal(rows.reduce((v, r) => v + n(r[f]), 0), t[f], `${level}: ${f}`);
    assert.equal(rows.reduce((v, r) => v + n(r.qty), 0), t.units, `${level}: every piece sold`);
    assert.equal(new Set(rows.flatMap((r) => r.order_ids as string[])).size, 7, `${level}: every order`);
  }
  // The sections' names in three languages, from the live section; the frozen Arabic when it is gone; «غير مصنف» is the screen's.
  const main = Object.fromEntries((s.categories as Row[]).filter((c) => c.level === 'main').map((c) => [c.id, [c.name_ar, c.name_en, c.name_ckb]]));
  assert.deepEqual(main.printers, ['الطابعات', 'Printers', 'چاپکەرەکان']);
  assert.deepEqual(main.parts, ['قطع', '', ''], 'no English or Sorani name yet: the screen falls back to the Arabic');
  assert.deepEqual(main.gone, ['قسم محذوف', '', ''], 'a section gone since the sale: its frozen snapshot');
  assert.ok(main.unclassified, 'a line with no section');
  const sub = (s.categories as Row[]).filter((c) => c.level === 'sub').map((c) => c.id).sort();
  assert.deepEqual(sub, ['gone-sub', 'unclassified'], 'a line with no subsection is counted, under «بلا قسم فرعي»');
  // In dollars, the same keys.
  assert.deepEqual(Object.keys(s.display_usd.categories.sub).sort(), sub);
});

test('each day carries its deductions and its net after them, in dinars and cents: revenue − costs − investor share − deductions = «صافيك», and the days add up to the period', async () => {
  const w = world();
  usd(w.raw);
  const day = baghdadDay(), first = `${day.slice(0, 7)}-01`;
  order(w.raw, { id: 'a', coupon: 3000 });
  order(w.raw, { id: 'b', delivered: `${first}T09:00:00Z` });
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${day}','Rent','admin');
    INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state) VALUES ('pp1','buyer','a','a:item',25000,23000,1,2000,'credited');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const daily = s.chart_data.daily as Row[], cents = s.display_usd.chart.daily as Record<string, Row>;
  for (const d of daily) {
    assert.equal(n(d.revenue_iqd) - n(d.cost_iqd) - n(d.investor_iqd) - n(d.deductions_iqd), d.net_after_report_adjustments_iqd, `${d.day} in dinars`);
    const c = cents[String(d.day)];
    assert.equal(n(c.revenue_cents) - n(c.cost_cents) - n(c.investor_cents) - n(c.deductions_cents), c.net_after_report_adjustments_cents, `${d.day} in cents`);
  }
  assert.equal(daily.reduce((v, d) => v + n(d.deductions_iqd), 0), 5000, 'the coupon and the credited price protection');
  assert.equal(daily.reduce((v, d) => v + n(d.net_after_report_adjustments_iqd), 0), s.totals.owner_period_net_after_report_adjustments_iqd, 'the days add up to «صافي حصتك»');
  assert.equal(Object.values(cents).reduce((v, c) => v + n(c.net_after_report_adjustments_cents), 0), s.display_usd.totals.owner_period_net_after_report_adjustments_cents, 'in cents too');
});

test('the export follows the page: orders, products, sections and days, each from the read /summary answers, amounts as numbers that add up to the screen', async () => {
  const w = everyState();
  w.raw.exec(`UPDATE users SET name='=HYPERLINK("https://x")' WHERE id='buyer';`);
  const s = await w.read(`/f/summary?${w.range}`);
  // Orders: one row per order, where it stands and its cash; a name that could start a formula is guarded.
  const orders = parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders`));
  assert.ok(orders.bom, 'the BOM, as the line file');
  assert.equal(orders.head[0], 'order_id');
  assert.deepEqual(orders.rows.map((r) => r.order_id.text).sort(), Object.keys(EXPECTED).sort());
  for (const r of orders.rows) {
    const o = (s.orders as Row[]).find((x) => x.id === r.order_id.text)!;
    assert.deepEqual([r.finance_state.text, r.wait_reason.text || null, r.cash_state.text, r.row_kind.text], [o.finance_state, o.wait_reason, o.cash_state, 'order']);
    assert.equal(r.customer_name.text, "'=HYPERLINK(\"https://x\")", 'the formula guard');
    assert.doesNotMatch(r.retained_revenue_iqd.raw, /"/, 'an amount is a number, not text');
  }
  for (const f of ['retained_revenue_iqd', 'shipping_income_iqd', 'promotion_iqd', 'coupon_iqd', 'collection_difference_iqd', 'revenue_iqd'])
    assert.equal(sumOf(orders.rows, f), f === 'revenue_iqd' ? (s.orders as Row[]).reduce((v, o) => v + n(o.revenue_iqd), 0) : s.totals[f], f);
  // An unknown amount is an empty cell, never 0: the known sum is what the table's totals row shows beside «ناقص».
  assert.equal(orders.rows.find((r) => r.order_id.text === 'mag')!.cogs_iqd.raw, '""');
  assert.equal(sumOf(orders.rows, 'cogs_iqd'), (s.orders as Row[]).reduce((v, o) => v + n(o.cogs_iqd), 0));
  // A column of the statement: its orders and its share of the overheads, adding up to the statement's cell.
  const calc = parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders&part=calculated`)), wait = parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders&part=waiting`));
  assert.deepEqual(calc.rows.filter((r) => r.row_kind.text === 'order').map((r) => r.order_id.text).sort(), ['est', 'fifo']);
  assert.deepEqual(wait.rows.filter((r) => r.row_kind.text === 'order').map((r) => r.order_id.text).sort(), ['err', 'inv', 'mag', 'ret', 'wage']);
  const k = s.known, wt = s.waiting;
  assert.equal(sumOf(calc.rows, 'net_after_report_adjustments_iqd'), k.net_after_report_adjustments_iqd, 'the calculated column\'s net, after its overheads');
  assert.equal(sumOf(calc.rows, 'general_expenses_iqd'), k.general_share_iqd);
  assert.equal(sumOf(calc.rows, 'promotion_iqd'), n(k.totals.promotion_iqd) + n(k.unallocated_share_iqd));
  assert.equal(sumOf(wait.rows, 'general_expenses_iqd'), wt.general_share_iqd);
  assert.equal(sumOf(wait.rows, 'promotion_iqd'), n(wt.totals.promotion_iqd) + n(wt.unallocated_share_iqd));
  assert.ok(k.general_share_iqd > 0 && k.unallocated_share_iqd > 0 && wt.general_share_iqd > 0, 'both overheads, in both columns');
  assert.equal(wait.rows.find((r) => r.row_kind.text === 'overhead')!.net_after_report_adjustments_iqd.raw, '""', 'the waiting column\'s net is unknown, never a number');
  // Products and sections: one row per row of the table, the pieces kept and returned apart, every column adding up.
  const products = parseCsv(await w.text(`/f/export.csv?${w.range}&view=products`));
  assert.equal(products.rows.length, (s.products as Row[]).length);
  const returned = products.rows.find((r) => r.product_id.text === 'returned')!;
  assert.deepEqual([returned.kept_qty.raw, returned.returned_qty.raw], ['1', '1']);
  for (const [level, file] of [['main', 'main'], ['sub', 'sub']] as const) {
    const rows = parseCsv(await w.text(`/f/export.csv?${w.range}&view=sections&level=${file}`)).rows;
    assert.equal(rows.length, (s.categories as Row[]).filter((c) => c.level === level).length, level);
    assert.equal(sumOf(rows, 'retained_revenue_iqd'), s.totals.retained_revenue_iqd, `${level}: the sections add up to the period`);
    const none = rows.find((r) => r.section_id.text === 'unclassified')!;
    assert.deepEqual([none.name_ar.text, none.name_en.text, none.name_ckb.text], level === 'main' ? ['غير مصنف', 'Unclassified', 'پۆلێننەکراو'] : ['بلا قسم فرعي', 'No subsection', 'بێ بەشی لاوەکی']);
  }
  const printers = parseCsv(await w.text(`/f/export.csv?${w.range}&view=sections`)).rows.find((r) => r.section_id.text === 'printers')!;
  assert.deepEqual([printers.name_ar.text, printers.name_en.text, printers.name_ckb.text], ['الطابعات', 'Printers', 'چاپکەرەکان'], 'level=main is the default');
  // Days: one row per day of the period, adding up to the chart.
  const days = parseCsv(await w.text(`/f/export.csv?${w.range}&view=days`)).rows;
  assert.equal(days.length, (s.chart_data.daily as Row[]).length);
  for (const f of ['revenue_iqd', 'deductions_iqd', 'orders_count']) assert.equal(sumOf(days, f), (s.chart_data.daily as Row[]).reduce((v, d) => v + n(d[f]), 0), f);
  assert.equal(sumOf(days, 'revenue_iqd'), s.chart_data.revenue_iqd);
  // Refused: an unknown view, level or part. The line file stays the default, its header unchanged.
  for (const q of ['view=nonsense', 'view=sections&level=deep', 'view=orders&part=half']) assert.equal((await get(w.app, `/f/export.csv?${w.range}&${q}`)).status, 400, q);
  const lines = await w.text(`/f/export.csv?${w.range}`);
  assert.equal(lines, await w.text(`/f/export.csv?${w.range}&view=lines`));
  assert.equal(lines.split('\r\n')[0], '\uFEFF"order_id","id","product_id","name_snapshot","sku_snapshot","qty","returned_qty","main_name","sub_name","net_goods_iqd","refund_iqd","cogs_iqd","cost_confidence","gross_profit_iqd","wages_iqd","materials_iqd","manual_direct_iqd","shipping_income_iqd","cod_tax_iqd","courier_fee_iqd","payment_fee_iqd","promotion_iqd","investor_iqd","owner_net_iqd","pending_costs","coupon_iqd","price_protection_iqd","trade_in_credit_returned_iqd","net_after_report_adjustments_iqd","row_kind"');
  const named = await get(w.app, `/f/export.csv?${w.range}&view=sections&level=sub`);
  assert.match(named.headers.get('Content-Disposition') ?? '', /filename="finance-sections-sub-[\d-]+-[\d-]+\.csv"/);
});

test('every view opens in a spreadsheet as its table: the BOM, CRLF lines, one header, a row per row — and every amount column adds up to the totals row, an unknown cell empty as the chip counts it', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`);
  const level = (l: string) => (s.categories as Row[]).filter((c) => c.level === l);
  const views: Array<[string, Row[]]> = [['orders', s.orders], ['products', s.products], ['sections&level=main', level('main')], ['sections&level=sub', level('sub')], ['days', s.chart_data.daily]];
  for (const [view, rows] of views) {
    const body = await w.text(`/f/export.csv?${w.range}&view=${view}`), csv = parseCsv(body);
    assert.ok(csv.bom, `${view}: the BOM, so a spreadsheet reads the Arabic as UTF-8`);
    assert.equal(body.split('\n').length, body.split('\r\n').length, `${view}: every line ends in CRLF`);
    assert.ok(csv.head.length > 8 && csv.rows.every((r) => Object.keys(r).length === csv.head.length), `${view}: as many cells on each line as in the header`);
    assert.equal(csv.rows.length, rows.length, `${view}: one line per row of the table`);
    const money = csv.head.filter((h) => h.endsWith('_iqd') && !(view === 'orders' && h === 'general_expenses_iqd'));
    assert.ok(money.length >= 6, view);
    for (const f of money) {
      // As the table shows the cell (the independent review of step 4: an order whose wage still waits exported its approved
      // part as its wages, so the file's sum disagreed with the «ينتظر» on screen).
      const known = rows.filter((r) => shown(r, f) !== null);
      assert.equal(sumOf(csv.rows, f), known.reduce((v, r) => v + n(r[f]), 0), `${view}: ${f} adds up to the totals row`);
      assert.equal(csv.rows.filter((r) => r[f].raw === '""').length, rows.length - known.length, `${view}: ${f}: an empty cell for each unknown one, never 0`);
      assert.ok(csv.rows.every((r) => r[f].raw === '""' || /^-?\d+(?:\.\d+)?$/.test(r[f].raw)), `${view}: ${f} is a number a spreadsheet adds`);
    }
  }
  // The world has unknown amounts in the files, so the empty cells above were counted, not assumed.
  assert.ok((s.products as Row[]).some((p) => p.cogs_iqd === null) && (s.chart_data.daily as Row[]).some((d) => d.cost_iqd === null));
  assert.ok((s.orders as Row[]).some((o) => n(o.pending_costs) > 0 && o.wages_iqd !== null), 'and a wage that waits beside a known one');
});

// ------------------------------------------------------------------ the independent review of step 4
test('a coupon larger than the goods: the products and the sections end on an order-level row, so their «صافيك» and coupons add up to the orders — on screen, in each file and in cents (review, money lens)', async () => {
  const w = world();
  usd(w.raw);
  // 2 × 25,000 of goods and 5,000 of delivery, a coupon of 53,000: 50,000 of it on the goods, 3,000 on the delivery.
  order(w.raw, { id: 'big', coupon: 53000 });
  order(w.raw, { id: 'plain' });
  const s = await w.read(`/f/summary?${period()}&display=USD`);
  const sum = (rows: Row[], f: string) => rows.reduce((v, r) => v + n(r[f]), 0);
  const orders = s.orders as Row[], level = s.order_level as Row;
  assert.equal(sum(orders, 'net_after_report_adjustments_iqd'), 17000, 'the orders: −18,000 and 35,000');
  assert.deepEqual([level.coupon_iqd, level.net_after_report_adjustments_iqd, level.order_ids], [3000, -3000, ['big']], 'what no line carries');
  for (const [name, rows] of [['products', s.products], ['main', (s.categories as Row[]).filter((c) => c.level === 'main')], ['sub', (s.categories as Row[]).filter((c) => c.level === 'sub')]] as Array<[string, Row[]]>) {
    assert.equal(sum(rows, 'net_after_report_adjustments_iqd'), 20000, `${name}: the lines alone are 3,000 more`);
    assert.equal(sum(rows, 'net_after_report_adjustments_iqd') + n(level.net_after_report_adjustments_iqd), sum(orders, 'net_after_report_adjustments_iqd'), `${name} + the order-level row = the orders`);
    assert.equal(sum(rows, 'coupon_iqd') + n(level.coupon_iqd), s.totals.coupon_iqd, `${name}: every coupon`);
  }
  // In cents: the products' and sections' cents plus the order-level row's are the orders' cents.
  const u = s.display_usd, orderCents = (f: string) => Object.values(u.orders as Record<string, { cents: Row }>).reduce((v, o) => v + n(o.cents[f]), 0);
  for (const groups of [u.products, u.categories.main, u.categories.sub] as Array<Record<string, Row>>) for (const f of ['net_after_report_adjustments_cents', 'coupon_cents', 'retained_revenue_cents', 'owner_net_cents'])
    assert.equal(Object.values(groups).reduce((v, g) => v + n(g[f]), 0) + n((u.order_level as Row | null)?.[f]), orderCents(f), f);
  // The files: the products and both levels of sections end on that row, and add up to the orders.
  for (const view of ['products', 'sections&level=main', 'sections&level=sub']) {
    const csv = parseCsv(await w.text(`/f/export.csv?${period()}&view=${view}`)), last = csv.rows[csv.rows.length - 1];
    assert.equal(last.row_kind.text, 'order_level', view);
    assert.equal(sumOf(csv.rows, 'net_after_report_adjustments_iqd'), 17000, `${view}: its net is the orders'`);
    assert.equal(sumOf(csv.rows, 'coupon_iqd'), 53000, `${view}: every coupon`);
    assert.equal(sumOf(csv.rows, 'retained_revenue_iqd'), s.totals.retained_revenue_iqd, `${view}: the order-level row sells nothing`);
  }
  const sections = parseCsv(await w.text(`/f/export.csv?${period()}&view=sections`)).rows.at(-1)!;
  assert.deepEqual([sections.section_id.text, sections.name_ar.text, sections.name_en.text, sections.name_ckb.text], ['order_level', 'خصومات على مستوى الطلب', 'Order-level deductions', 'داشکاندنەکانی ئاستی داواکاری']);
  // A search shows the rows it found, as the screen does: no order-level row.
  assert.ok(parseCsv(await w.text(`/f/export.csv?${period()}&view=products&q=print`)).rows.every((r) => r.row_kind.text === 'product'));
});

test('in dollars a product\'s cents add up to its order\'s: two lines of 25,001 IQD at 1,500 are 3,333¢, as the order, not 3,334¢ (review nit)', async () => {
  const w = world();
  usd(w.raw);
  order(w.raw, { id: 'two', qty: 1, unit: 25001, shipping: 0 });
  w.raw.exec(`UPDATE orders SET subtotal_iqd=50002,total_iqd=50002,due_on_delivery_iqd=50002 WHERE id='two';
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('two:item2','two','esun','esun','SKU',1,25001,25001,10000,'snapshot');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`), u = s.display_usd;
  const own = (u.orders as Record<string, { cents: Row }>).two.cents;
  assert.equal(own.retained_revenue_cents, 3333);
  for (const groups of [u.products, u.categories.main, u.categories.sub] as Array<Record<string, Row>>)
    for (const f of ['retained_revenue_cents', 'gross_profit_cents', 'net_after_report_adjustments_cents']) assert.equal(Object.values(groups).reduce((v, g) => v + n(g[f]), 0), n(own[f]), f);
});

test('a wage still waiting for its cost: the order\'s and its product\'s wages and materials are empty cells in every file, as «ينتظر» on screen — never the approved part read as the whole (review, money lens)', async () => {
  const w = world();
  const day = baghdadDay();
  order(w.raw, { id: 'ok' });
  order(w.raw, { id: 'w2', product: 'esun', cost: 10000 });
  w.raw.exec(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot) VALUES
      ('a1','ok',NULL,'r1',1,'Packing wage','g1','staff_sajjad','rent','delivered',1,2000,'${day}','approved','{}'),
      ('a2','w2',NULL,'r1',1,'Packing wage','g2','staff_sajjad','rent','delivered',1,7500,'${day}','approved','{}'),
      ('a3','w2',NULL,'r2',1,'Profit share','g3','staff_sajjad','rent','delivered',1,NULL,'${day}','pending_cost','{}');`);
  const s = await w.read(`/f/summary?${period()}`);
  const w2 = (s.orders as Row[]).find((o) => o.id === 'w2')!;
  assert.deepEqual([w2.wages_iqd, w2.pending_costs, w2.wait_reason], [7500, 1, 'wage_waits_cost'], 'the server keeps the approved part; the screens show «ينتظر»');
  const orders = parseCsv(await w.text(`/f/export.csv?${period()}&view=orders`)).rows;
  assert.deepEqual(orders.map((r) => [r.order_id.text, r.wages_iqd.raw, r.materials_iqd.raw]).sort(), [['ok', '2000', '0'], ['w2', '""', '""']]);
  assert.equal(sumOf(orders, 'wages_iqd'), 2000, 'the file adds up to the table\'s «2,000+ ينتظر 1»');
  const products = parseCsv(await w.text(`/f/export.csv?${period()}&view=products`)).rows;
  assert.equal(products.find((r) => r.product_id.text === 'esun')!.wages_iqd.raw, '""');
  assert.equal(products.find((r) => r.product_id.text === 'esun')!.pending_costs.raw, '1', 'and says why');
  const waiting = parseCsv(await w.text(`/f/export.csv?${period()}&view=orders&part=waiting`)).rows;
  assert.equal(waiting.find((r) => r.order_id.text === 'w2')!.wages_iqd.raw, '""', 'the drawer\'s file too');
});

test('the export is the page as shown: the orders\' search, status, type, row or days and cash; the products\' and sections\' search; the days by week or month — by the screen\'s own rules, adding up to it (review, money lens)', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`) as FinanceSummary & Row;
  const ids = (body: string) => parseCsv(body).rows.map((r) => r.order_id.text).filter(Boolean).sort();
  const screen = (f: Partial<typeof NO_FILTER>) => filterOrders(s.orders, s, { ...NO_FILTER, ...f }).map((o) => o.id).sort();
  const cases: Array<[string, Partial<typeof NO_FILTER>]> = [['state=waiting', { state: 'waiting' }], ['state=reason%3Ano_price', { state: 'reason:no_price' }], ['state=estimated', { state: 'estimated' }],
    ['q=FIF', { q: 'FIF' }], ['q=buyer', { q: 'buyer' }], ['kind=gift', { kind: 'gift' }], ['kind=normal&state=confirmed', { kind: 'normal', state: 'confirmed' }]];
  for (const [query, f] of cases) assert.deepEqual(ids(await w.text(`/f/export.csv?${w.range}&view=orders&${query}`)), screen(f), query);
  // The row or the days a page was opened on: the same orders the chip names (reportTable scopeIds).
  const printers = s.categories.find((c) => c.id === 'printers' && c.level === 'main')!;
  assert.deepEqual(ids(await w.text(`/f/export.csv?${w.range}&view=orders&scope=main%3Aprinters`)), [...printers.order_ids!].sort());
  assert.deepEqual(ids(await w.text(`/f/export.csv?${w.range}&view=orders&scope=product%3Amagnet`)), ['mag']);
  const day = baghdadDay();
  assert.deepEqual(ids(await w.text(`/f/export.csv?${w.range}&view=orders&scope=days%3A${day}%3A${day}`)), s.orders.map((o) => o.id).sort(), 'every order was delivered today');
  // A filtered file is that page's rows, with no column's share of the overheads.
  const filtered = await get(w.app, `/f/export.csv?${w.range}&view=orders&state=waiting`);
  assert.match(filtered.headers.get('Content-Disposition') ?? '', /filename="finance-orders-filtered-/);
  assert.ok(parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders&state=waiting`)).rows.every((r) => r.row_kind.text === 'order'));
  // A cash figure's file is the orders the drawer lists.
  assert.equal(parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders&cash=open`)).rows.length, s.orders.filter((o) => n(o.collection_difference_iqd) !== 0).length);
  // Products and sections: their search, in any language the server has.
  const named = (body: string, key: string) => parseCsv(body).rows.map((r) => r[key].text).sort();
  assert.deepEqual(named(await w.text(`/f/export.csv?${w.range}&view=products&q=MAG`), 'product_id'), filterGroups(s.products, 'product', 'MAG').map((p) => p.id).sort());
  assert.deepEqual(named(await w.text(`/f/export.csv?${w.range}&view=sections&level=main&q=Printers`), 'section_id'), ['printers']);
  // The days by week and by month: the screen's rows (groupDays), adding up to the same totals.
  for (const by of ['week', 'month'] as const) {
    const body = await w.text(`/f/export.csv?${w.range}&view=days&by=${by}`), csv = parseCsv(body), rows = groupDays(s.chart_data!.daily, by, s.orders, s);
    assert.deepEqual(csv.head.slice(0, 2), ['from', 'to'], by);
    assert.deepEqual(csv.rows.map((r) => [r.from.text, r.to.text]), rows.map((r) => [r.from, r.to]), `${by}: the screen's rows`);
    assert.equal(sumOf(csv.rows, 'revenue_iqd'), totalOf(rows, (r) => r.revenue).sum, `${by}: revenue`);
    assert.equal(sumOf(csv.rows, 'cost_iqd'), totalOf(rows, (r) => r.cost).sum, `${by}: the known costs`);
    assert.deepEqual(csv.rows.map((r) => r.cost_iqd.raw === '""'), rows.map((r) => r.cost === null), `${by}: a bucket with an unknown day is unknown`);
  }
  // Refused: a filter the view does not read, an unknown value, a part outside the orders (it went into the file's name and was ignored).
  for (const q of ['view=products&state=waiting', 'view=days&q=x', 'view=orders&by=week', 'view=orders&state=nonsense', 'view=orders&kind=box', 'view=orders&scope=nowhere', 'view=orders&cash=all',
    'view=days&by=year', 'view=products&part=waiting', 'view=days&part=calculated', 'view=sections&part=waiting', 'view=lines&q=x'])
    assert.equal((await get(w.app, `/f/export.csv?${w.range}&${q}`)).status, 400, q);
});

test('a period with rent and no delivered order: the drawer\'s file of the period is its overheads, adding up to the statement (review, money lens)', async () => {
  const w = world();
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${baghdadDay()}','Rent','admin');`);
  const s = await w.read(`/f/summary?${period()}`);
  assert.equal(s.orders.length, 0);
  const rows = parseCsv(await w.text(`/f/export.csv?${period()}&view=orders&part=period`)).rows;
  assert.deepEqual(rows.map((r) => [r.row_kind.text, r.general_expenses_iqd.raw, r.net_after_report_adjustments_iqd.raw]), [['overhead', '10001', '-10001']]);
  assert.equal(sumOf(rows, 'net_after_report_adjustments_iqd'), s.totals.owner_period_net_after_report_adjustments_iqd);
});

test('a returned piece whose cost is unknown waits for that cost in the order, not for a purchase price «التكاليف الناقصة» never lists; a refund nobody recorded is counted on the order and its product (review, money lens)', async () => {
  // The rule on its own: a line whose own cost is confirmed has no missing price.
  const base = (lines: Array<Row>) => ({ order_id: 'o', version: 1, order: {}, lines, totals: { pending_costs: 0, investor_iqd: 0, gross_profit_iqd: null }, costs: [], warnings: [] }) as unknown as OrderProfitBase;
  assert.equal(waitReason(base([{ cogs_iqd: null, cost_confidence: 'fifo' }])), 'return_cost');
  assert.equal(waitReason(base([{ cogs_iqd: null, cost_confidence: 'fifo' }, { cogs_iqd: null, cost_confidence: 'unknown' }])), 'no_price', 'a missing price first');
  // In a period: one of two pieces refunded and put back in stock, with no release of its batch and no refund amount recorded.
  const w = world();
  order(w.raw, { id: 'rr' });
  w.raw.exec(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('rc','rr','rr:item','buyer',1,'defective','resolved','refund','${baghdadDay()}T08:00:00Z');`);
  const s = await w.read(`/f/summary?${period()}`);
  const o = (s.orders as Row[])[0], p = (s.products as Row[])[0];
  assert.deepEqual([o.cogs_iqd, o.finance_state, o.wait_reason, o.unknown_refunds], [null, 'waiting', 'return_cost', 1]);
  assert.deepEqual([p.wait_reason, p.unknown_refunds], ['return_cost', 1]);
  assert.equal(s.missing_costs.lines, 0, '«التكاليف الناقصة» has nothing for it: its chip opens the order instead');
  assert.deepEqual(s.waiting.reasons, { return_cost: ['rr'] });
  const csv = parseCsv(await w.text(`/f/export.csv?${period()}&view=orders`)).rows[0];
  assert.deepEqual([csv.wait_reason.text, csv.unknown_refunds.raw], ['return_cost', '1'], 'the file says it too');
});

test('a name that could start a formula is guarded however it starts — a line feed, a space, a full-width sign — and one with a comma, a quote and a line break stays one cell (review nit)', async () => {
  const w = world();
  order(w.raw, { id: 'n1' });
  for (const name of ['\n=1+1', ' =1+1', '＝1+1', '＋1', '-1', '@SUM(A1)', '\t=1']) {
    w.raw.prepare("UPDATE users SET name=? WHERE id='buyer'").run(name);
    const row = parseCsv(await w.text(`/f/export.csv?${period()}&view=orders`)).rows[0];
    assert.equal(row.customer_name.text, `'${name}`, JSON.stringify(name));
  }
  w.raw.prepare("UPDATE users SET name=? WHERE id='buyer'").run('Ali, "the" buyer\r\nsecond line');
  const csv = parseCsv(await w.text(`/f/export.csv?${period()}&view=orders`));
  assert.equal(csv.rows.length, 1, 'one record, its line break inside the quotes');
  assert.equal(csv.rows[0].customer_name.text, 'Ali, "the" buyer\r\nsecond line');
  assert.equal(csv.rows[0].retained_revenue_iqd.raw, '50000', 'the cells after it in their columns');
});

// ------------------------------------------------------------------ the second review of step 4
test('a product\'s and a section\'s unknown lines are their own lines with no goods cost — in /summary and in each file, every grouping adding up to the orders\' — never the 0 a line\'s missing count summed to (second review)', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`);
  const products: Record<string, Row> = Object.fromEntries((s.products as Row[]).map((p) => [p.id, p]));
  assert.deepEqual([products.magnet.cogs_iqd, products.magnet.unknown_lines, products.esun.unknown_lines], [null, 1, 0], 'the magnets\' line has no purchase price; the eSUN\'s rests on its estimate');
  assert.ok(n(s.totals.unknown_lines) > 0);
  for (const level of ['product', 'main', 'sub']) {
    const rows = level === 'product' ? s.products as Row[] : (s.categories as Row[]).filter((c) => c.level === level);
    assert.equal(rows.reduce((v, r) => v + n(r.unknown_lines), 0), s.totals.unknown_lines, `${level}: every unknown line of the period, once`);
    for (const r of rows) assert.equal(n(r.unknown_lines) > 0, r.cogs_iqd === null, `${level} ${r.id}: an unknown goods cost counts its lines, a known one none`);
  }
  // The files: whoever filters a file on unknown_lines > 0 finds the rows with an empty goods cost.
  const magnet = parseCsv(await w.text(`/f/export.csv?${w.range}&view=products`)).rows.find((r) => r.product_id.text === 'magnet')!;
  assert.deepEqual([magnet.cogs_iqd.raw, magnet.unknown_lines.raw, magnet.wait_reason.text], ['""', '1', 'no_price']);
  for (const [level, id] of [['main', 'parts'], ['sub', 'unclassified']] as const) {
    const row = parseCsv(await w.text(`/f/export.csv?${w.range}&view=sections&level=${level}`)).rows.find((r) => r.section_id.text === id)!;
    assert.deepEqual([row.cogs_iqd.raw, row.unknown_lines.raw], ['""', '1'], `${level}: ${id}`);
  }
});

test('a waiting order whose known goods cost rests on a sale-time estimate: its day\'s known cost says «تقديري» — on the Days page, in its totals and in its file — never a confirmed-looking figure (second review, money lens)', async () => {
  const w = world();
  // One order: a FIFO line funded by an investor whose projection is missing (its share waits), and a line costed on its 15,000 sale-time estimate.
  w.raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('funded','Funded','fig-funded',25000,0,999);`);
  order(w.raw, { id: 'inv', product: 'funded' });
  w.raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('batch','funded','base','',4,4,10000);
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json,state) VALUES ('contract','batch','buyer','Funding',40000,10000,1000,1000,'admin','now','{}','active');
    UPDATE inventory_lots SET incoming_id='batch' WHERE id='inv:lot';
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,estimated_cost_iqd) VALUES ('inv:est','inv','esun','esun','SKU',1,20000,20000,NULL,'unpriced',15000);
    UPDATE orders SET subtotal_iqd=70000,total_iqd=75000,due_on_delivery_iqd=75000 WHERE id='inv';`);
  const s = await w.read(`/f/summary?${period()}`) as FinanceSummary & Row;
  const o = s.orders[0];
  assert.deepEqual([o.finance_state, o.wait_reason, o.cost_confidence, o.cogs_iqd, o.profit_basis_iqd], ['waiting', 'investor_waits', 'snapshot', 35000, 40000], 'the server: waiting for the investor, its cost known and estimated');
  assert.equal(s.missing_costs!.estimated_lines, 1);
  const day = financeDay(o.delivered_at!), row = groupDays(s.chart_data!.daily, 'day', s.orders, s).find((d) => d.key === day)!;
  assert.deepEqual([row.cost, row.net, row.waiting, row.investorWaits, row.estimated], [35000, null, 1, 1, 1], 'a known cost on an estimate, named; the net waits');
  // Drawn as the owner reads it: the day's cost and the totals' known costs both name the estimate; the unknown net names none.
  const g = globalThis as { localStorage?: unknown }, before = g.localStorage;
  g.localStorage = { getItem: (k: string) => (k === 'levo_lang' ? 'en' : null), setItem: () => {}, removeItem: () => {} };
  try {
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DaysReport, { data: s, onOpenOrders: () => {} })));
    const cells = [...(new RegExp(`<tr[^>]* data-finance-day="${day}"[^>]*>([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? '').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]);
    assert.match(cells[3], /35,000<\/span> <span class="fw-status fw-status--warning">Estimated\u00A01</, 'the day\'s cost');
    assert.match(cells[cells.length - 1], />Waiting\u00A01</);
    assert.doesNotMatch(cells[cells.length - 1], /Estimated/);
    assert.match(/<tfoot>[\s\S]*<\/tfoot>/.exec(html)![0], /35,000<\/span> <span class="fw-status fw-status--warning">Estimated\u00A01</, 'the costs total');
  } finally { g.localStorage = before; }
  // The file says it too.
  const file = parseCsv(await w.text(`/f/export.csv?${period()}&view=days`)).rows.find((r) => r.day.text === day)!;
  assert.deepEqual([file.cost_iqd.raw, file.estimated_orders.raw, file.net_after_report_adjustments_iqd.raw], ['35000', '1', '""']);
});

test('the days file names what the Days page names beside its sums — the orders on a sale-time estimate beside a known cost, those whose refund nobody recorded — by day, week and month (second and third reviews, nits)', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`) as FinanceSummary & Row;
  // Every order was delivered today: «est» rests on its estimate, «ret» counts a refund nobody recorded as 0 — and «mag», with no
  // purchase price, leaves today's cost unknown.
  const today = s.chart_data!.daily.find((d) => d.day === baghdadDay())!;
  assert.deepEqual([today.estimated_orders, today.unknown_refund_orders, today.cost_iqd], [1, 1, null]);
  for (const by of ['day', 'week', 'month'] as const) {
    const csv = parseCsv(await w.text(`/f/export.csv?${w.range}&view=days${by === 'day' ? '' : `&by=${by}`}`)), rows = groupDays(s.chart_data!.daily, by, s.orders, s);
    // The third review of step 4: the page names a row's estimates beside its known cost (and net) only, so the file writes none beside an
    // empty cost — a spreadsheet's SUM of the column is then the costs total's «تقديري n», never a count the page shows nowhere.
    assert.deepEqual(csv.rows.map((r) => [r.estimated_orders.raw, Number(r.unknown_refund_orders.raw)]), rows.map((r) => [r.cost == null ? '""' : String(r.estimated), r.refunds]), `${by}: the page's own counts, row by row`);
    assert.equal(sumOf(csv.rows, 'estimated_orders'), countWhereKnown(rows, (r) => r.cost, (r) => r.estimated), `${by}: the costs total's «تقديري n»`);
    assert.ok(csv.rows.some((r) => r.cost_iqd.raw === '""' && r.estimated_orders.raw === '""'), `${by}: today's estimate is beside an unknown cost, so not written`);
    assert.equal(sumOf(csv.rows, 'unknown_refund_orders'), 1, `${by}: the «مرتجع غير مثبت 1» beside the revenue total`);
  }
});

// ------------------------------------------------------------------ the fourth review of step 4
test('the orders file says which known goods costs rest on a sale-time estimate — beside a known cost only — so its column adds up to the goods-cost total\'s «تقديري n» on Reports → Orders (fourth review, nit)', async () => {
  const w = everyState();
  // «inv» waits for its investor share; a second line of it is costed on its 15,000 sale-time estimate, so its known goods cost rests on
  // one, as a waiting wage's can. «est» stands «تقديري»; «mag» has no purchase price; the others' costs are confirmed.
  w.raw.exec(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,estimated_cost_iqd) VALUES ('inv:est','inv','esun','esun','SKU',1,20000,20000,NULL,'unpriced',15000);
    UPDATE orders SET subtotal_iqd=70000,total_iqd=75000,due_on_delivery_iqd=75000 WHERE id='inv';`);
  const s = await w.read(`/f/summary?${w.range}`) as FinanceSummary & Row;
  const inv = s.orders.find((o) => o.id === 'inv')!;
  assert.deepEqual([inv.finance_state, inv.wait_reason, inv.cost_confidence, inv.cogs_iqd !== null], ['waiting', 'investor_waits', 'snapshot', true], 'the server: waiting for its investor, its cost known and estimated');
  // The page's goods-cost total says «تقديري 2»: the «تقديري» order and the waiting one (Reports.tsx, reportTable costOnEstimate).
  const page = countWhereKnown(s.orders, (o) => o.cogs_iqd ?? null, (o) => (costOnEstimate(o, standingOf(o, s)) ? 1 : 0));
  assert.equal(page, 2);
  const csv = parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders`));
  assert.ok(csv.head.includes('estimated_cost'), `the column: ${csv.head.join(',')}`);
  const expected: Record<string, string> = { fifo: '0', est: '1', mag: '""', wage: '0', inv: '1', err: '0', ret: '0' };
  assert.deepEqual(Object.fromEntries(csv.rows.map((r) => [r.order_id.text, r.estimated_cost.raw])), expected, 'beside a known goods cost 1 on an estimate and 0 confirmed; beside the unknown one, nothing');
  assert.equal(sumOf(csv.rows, 'estimated_cost'), page, 'the column adds up to the page\'s «تقديري n»');
  assert.equal(csv.rows.filter((r) => r.finance_state.text === 'estimated').length, 1, 'the state alone counts one: the waiting order on an estimate is the column\'s to say');
  // Every file of the orders carries it: a column of the statement (with its overheads' row), a filtered page, a cash figure's orders.
  for (const q of ['part=waiting', 'part=calculated', 'state=waiting', 'cash=open']) {
    const rows = parseCsv(await w.text(`/f/export.csv?${w.range}&view=orders&${q}`)).rows;
    assert.ok(rows.some((r) => r.row_kind.text === 'order'), q);
    for (const r of rows) assert.equal(r.estimated_cost.raw, r.row_kind.text === 'overhead' ? '0' : expected[r.order_id.text], `${q}: ${r.order_id.text || r.row_kind.text}`);
  }
});
