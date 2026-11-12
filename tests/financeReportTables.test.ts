/**
 * «التقارير» — THE TABLES, PURE (redesign step 4, owner 2026-11-11; DECISIONS row 316).
 *
 * What the owner sees on Reports → Orders, Products, Sections and Days, held on an INVENTED 1–11 November 2026
 * (tests/fixtures/financeSampleMonth.ts: every id, time, amount and product made up — the repository is public, and the
 * live figures the screens were checked on stay outside it) and on the rules under them:
 *   · Orders: 13 orders, 5,814,070 of net sales, a calculated net of 796,059 (485,819 from 3 confirmed orders and
 *     310,240 from 6 estimated ones) — the overview's — labelled as the calculated orders', and 4 waiting (a purchase
 *     price 2, a wage 1, an investor share 1);
 *   · Products: six, the switches carrying 275 of promotion with a net of +14,902; Days: eleven rows adding up, an order
 *     delivered at 21:40 UTC on Friday the 6th counted on Saturday the 7th, its Baghdad day; and, on a few invented orders
 *     of October, an investor share that waits on a CONFIRMED goods cost naming no estimate, nor a known total holding none;
 *   · a sort on any column, both ways, with unknown values last and ties in place; totals that keep the known sum and
 *     count the unknown cells; the status, type and search filters; a product's, a section's or a day's row opening
 *     exactly its orders, named again from each summary (a refresh or another period never keeps the ids it was
 *     clicked on); weeks from Saturday and months; pieces kept, the returned apart; where an order stands from the server's own
 *     answer, or its id lists from a server that predates the field;
 *   · every word in Arabic, English and real Sorani (DECISIONS row 183), and no bare dash on any of the four tables.
 *
 * Run: node --import tsx --test tests/financeReportTables.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { november } from './fixtures/financeSampleMonth';
import {
  barOf, bucketOf, costOnEstimate, countWhereUnknown, exportQuery, filterGroups, filterOrders, groupDays, groupMoney, groupNet, groupOnEstimate, netOf, netTotal, NO_FILTER, orderLevelRow, orderMoney, piecesOf, restsOnEstimate, scopeIds, sortRows, standingOf, stateCounts, totalOf, weekStart,
} from '../src/components/financeWorkspace/reportTable';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import { overviewNet } from '../src/components/financeWorkspace/overviewFigures';
import { RS } from '../src/components/financeWorkspace/reportStrings';
import { FW, dayIn, dayText } from '../src/components/financeWorkspace/overviewStrings';
import { DaysReport, GroupsReport, OrdersReport, scopeOf, sectionName } from '../src/components/financeWorkspace/Reports';
import { LanguageProvider } from '../src/LanguageContext';
import { financeDay, type FinanceOrder, type FinanceProduct, type FinanceSummary } from '../src/components/financeWorkspace/types';

let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/, ARABIC_ONLY = /[ةىيك]/, ARABIC = /[؀-ۿ]/;
const money = orderMoney(undefined);
const s = november;
const ids = (rows: readonly FinanceOrder[]) => rows.map((o) => o.id).sort();

test('the invented 1–11 November, Reports → Orders: 13 orders, 5,814,070 of sales, the overview\'s calculated net 796,059 = 485,819 confirmed + 310,240 estimated, 4 waiting', () => {
  assert.equal(s.orders.length, 13);
  assert.equal(totalOf(s.orders, (o) => money(o, 'retained_revenue_iqd')).sum, 5814070);
  const net = netTotal(s.orders, money);
  assert.deepEqual([net.net, net.orders, net.waiting], [796059, 9, 4]);
  assert.equal(net.net, overviewNet(s).net, 'the overview\'s «صافي حصتك»');
  const part = (state: '' | 'confirmed' | 'estimated') => netTotal(filterOrders(s.orders, s, { ...NO_FILTER, state }), money);
  assert.deepEqual([part('confirmed').net, part('confirmed').orders, part('estimated').net, part('estimated').orders], [485819, 3, 310240, 6]);
  const counts = stateCounts(s.orders, s);
  assert.deepEqual({ ...counts, reasons: { ...counts.reasons } }, { all: 13, confirmed: 3, estimated: 6, waiting: 4, reasons: { no_price: 2, wage_waits_cost: 1, investor_waits: 1 } });
  // Each order stands as the server says, and as «known» and «waiting» list it.
  for (const o of s.orders) {
    const st = standingOf(o, s), id = o.order_id!;
    assert.equal(st.state === 'confirmed', !!s.known?.confirmed?.order_ids?.includes(id), id);
    assert.equal(st.reason ?? undefined, Object.entries(s.waiting!.reasons).find(([, list]) => list?.includes(id))?.[0], id);
  }
});

test('where an order stands is the server\'s answer; a server that predates the field is read from its id lists, never worked out again', () => {
  const older = { ...s, orders: s.orders.map(({ finance_state: _a, wait_reason: _b, ...o }) => o as FinanceOrder) } as FinanceSummary;
  for (const [a, b] of s.orders.map((o, i) => [standingOf(o, s), standingOf(older.orders[i], older)])) assert.deepEqual(b, a);
  // The server's word wins over anything the client could infer.
  const odd = { ...s.orders[0], finance_state: 'waiting', wait_reason: 'other' } as FinanceOrder;
  assert.deepEqual(standingOf(odd, s), { state: 'waiting', reason: 'other' });
});

test('a sort on any column, either way: unknown values last in both directions, equal values in the order they came', () => {
  const rows = [{ id: 'a', v: 3 }, { id: 'b', v: null }, { id: 'c', v: 1 }, { id: 'd', v: 3 }, { id: 'e', v: null }, { id: 'f', v: -2 }];
  assert.deepEqual(sortRows(rows, (r) => r.v, 'desc').map((r) => r.id), ['a', 'd', 'c', 'f', 'b', 'e']);
  assert.deepEqual(sortRows(rows, (r) => r.v, 'asc').map((r) => r.id), ['f', 'c', 'a', 'd', 'b', 'e']);
  assert.deepEqual(sortRows(['b', 'a', null, 'c'], (r) => r, 'asc'), ['a', 'b', 'c', null]);
  assert.deepEqual(sortRows(['b', 'a', null, 'c'], (r) => r, 'desc'), ['c', 'b', 'a', null]);
  // Every money column of the orders table, both ways: the known values ordered, every unknown one after them.
  for (const field of ['retained_revenue_iqd', 'cogs_iqd', 'wages_iqd', 'promotion_iqd', 'investor_iqd', 'net_after_report_adjustments_iqd', 'revenue_iqd']) for (const dir of ['asc', 'desc'] as const) {
    const values = sortRows(s.orders, (o) => money(o, field), dir).map((o) => money(o, field));
    const firstNull = values.indexOf(null), known = (firstNull < 0 ? values : values.slice(0, firstNull)) as number[];
    assert.ok(firstNull < 0 || values.slice(firstNull).every((v) => v === null), `${field} ${dir}: unknown last`);
    assert.deepEqual(known, [...known].sort((a, b) => (dir === 'asc' ? a - b : b - a)), `${field} ${dir}`);
  }
});

test('a totals cell keeps the known sum and counts what is unknown: «12,000+» and «ناقص 2», never a 0 that hides a gap', () => {
  assert.deepEqual(totalOf([{ v: 5 }, { v: null }, { v: 7 }, { v: undefined }], (r) => r.v), { sum: 12, unknown: 2, rows: 4 });
  assert.deepEqual(totalOf([], () => 1), { sum: 0, unknown: 0, rows: 0 });
  const cogs = totalOf(s.orders, (o) => money(o, 'cogs_iqd')), investor = totalOf(s.orders, (o) => money(o, 'investor_iqd'));
  assert.deepEqual([cogs.unknown, investor.unknown], [2, 1], 'two orders without a purchase price, one investor share waiting');
});

test('the filters: status (a state or one reason), the order\'s type, the search by number or customer, and a product\'s or a day\'s orders', () => {
  const by = (f: Partial<typeof NO_FILTER>) => ids(filterOrders(s.orders, s, { ...NO_FILTER, ...f }));
  assert.equal(by({ state: 'waiting' }).length, 4);
  assert.deepEqual(by({ state: 'reason:no_price' }), ['ORD-0A00000004', 'ORD-0A00000008']);
  assert.deepEqual(by({ state: 'reason:investor_waits' }), ['ORD-0A0000000C']);
  // Any case, any part of the number, never only the whole of it, its start or its end: the end of one number, and the middle
  // every invented number shares.
  assert.deepEqual(by({ q: 'a0000000c' }), ['ORD-0A0000000C'], 'any case, part of the number');
  assert.equal(by({ q: 'a000000' }).length, 13, 'any case, the middle of the number');
  assert.equal(by({ q: 'زبون' }).length, 13, 'the customer\'s name');
  assert.equal(by({ kind: 'gift' }).length, 0);
  assert.equal(by({ kind: 'normal' }).length, 13);
  // A product's row opens exactly the orders its lines came from; the filters still apply inside it.
  for (const p of s.products) assert.deepEqual(by({ scope: { label: p.name, ids: p.order_ids! } }), [...p.order_ids!].sort(), p.name);
  const magnets = s.products.find((p) => p.id === 'prd_magnets')!;
  assert.deepEqual(by({ scope: { label: 'magnets', ids: magnets.order_ids! }, state: 'reason:no_price' }), ['ORD-0A00000004', 'ORD-0A00000008']);
});

test('the invented 1–11 November, Reports → Products: six products, the switches carrying 275 of promotion and a net of +14,902; the pieces kept, the returned apart', () => {
  const products = filterGroups(s.products, 'product', '');
  assert.equal(products.length, 6);
  const sw = products.find((p) => p.name.startsWith('Sample switches'))!, gm = groupMoney(undefined, 'product');
  // A small part's share of the promotion by its sales value, and a net above its gross (6,720) once its delivery is added.
  assert.deepEqual([gm(sw, 'promotion_iqd'), groupNet(sw, gm), gm(sw, 'gross_profit_iqd')], [275, 14902, 6720]);
  assert.equal(totalOf(products, (p) => gm(p, 'promotion_iqd')).sum, 192400, 'the month\'s promotion, all of it');
  assert.equal(totalOf(products, (p) => gm(p, 'retained_revenue_iqd')).sum, 5814070, 'the products add up to the orders');
  assert.deepEqual(filterGroups(s.products, 'product', 'MAGNET').map((p) => p.id), ['prd_magnets']);
  assert.deepEqual(filterGroups(s.categories, 'main', 'Printers').map((p) => p.id), ['cat_printers'], 'a section by its English name too');
  assert.equal(piecesOf({ qty: 5, kept_qty: 3, returned_qty: 2 } as FinanceProduct), 3, 'the pieces kept');
  assert.equal(piecesOf({ qty: 5, returned_qty: 2 } as FinanceProduct), 3, 'from a server that predates kept_qty');
  assert.deepEqual([barOf(100, [100, 50, null]), barOf(50, [100, 50, null]), barOf(null, [100]), barOf(-5, [100]), barOf(1, [1000])], [100, 50, 0, 0, 2]);
});

test('weeks start on Saturday (the old report\'s rule), months by the calendar; a week or month with an unknown day stays unknown', () => {
  // 2026-11-07 is a Saturday.
  assert.deepEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-13', '2026-11-14'].map(weekStart), ['2026-10-31', '2026-11-07', '2026-11-07', '2026-11-07', '2026-11-14']);
  assert.equal(weekStart('2026-01-02'), '2025-12-27', 'across a year');
  assert.equal(bucketOf('2026-11-09', 'month'), '2026-11');
  const days = groupDays(s.chart_data!.daily, 'day', s.orders, s);
  assert.equal(days.length, 11);
  const weeks = groupDays(s.chart_data!.daily, 'week', s.orders, s), months = groupDays(s.chart_data!.daily, 'month', s.orders, s);
  assert.deepEqual(weeks.map((w) => [w.from, w.to]), [['2026-11-01', '2026-11-06'], ['2026-11-07', '2026-11-11']], 'inside the period');
  assert.deepEqual(months.map((m) => [m.from, m.to, m.orders]), [['2026-11-01', '2026-11-11', 13]]);
  // The rows add up to the totals, in every grouping; a week with a waiting order has no net.
  for (const rows of [days, weeks, months]) {
    assert.equal(totalOf(rows, (r) => r.revenue).sum, 5968070);
    assert.equal(rows.reduce((v, r) => v + r.orders, 0), 13);
    assert.equal(rows.reduce((v, r) => v + r.waiting, 0), 4);
    // A bucket's known cost is the sum of its days' when every one is known; else it is unknown, never a part passed off as the whole.
    for (const r of rows) {
      const inside = days.filter((d) => d.from >= r.from && d.to <= r.to);
      assert.equal(r.cost, inside.some((d) => d.cost === null) ? null : inside.reduce((v, d) => v + (d.cost as number), 0), `${r.key}: cost`);
    }
  }
  assert.ok(weeks.every((w) => w.net === null), 'each week holds a day with a waiting order');
  assert.deepEqual(days.filter((d) => d.net === null).map((d) => d.key), ['2026-11-02', '2026-11-05', '2026-11-09', '2026-11-10'], 'the four days with a waiting order, never 0');
  assert.ok(days.filter((d) => d.orders === 0).every((d) => d.net === 0 && d.cost === 0), 'a quiet day is a real 0');
  // The totals row's known net is its known days', and each known day's net is its orders' — no order lost or counted twice.
  for (const d of days.filter((x) => x.net !== null)) assert.equal(d.net, s.orders.filter((o) => financeDay(o.delivered_at) === d.key).reduce((v, o) => v + (netOf(o, money) as number), 0), d.key);
  const onKnownDays = s.orders.filter((o) => days.some((d) => d.net !== null && d.key === financeDay(o.delivered_at)));
  assert.equal(totalOf(days, (r) => r.net).sum, onKnownDays.reduce((v, o) => v + (netOf(o, money) as number), 0));
  assert.equal(totalOf(days, (r) => r.net).sum, 182389, 'the 4th\'s 169,984 and the 7th\'s 12,405: the two days with orders and none waiting');
  assert.equal(totalOf(days, (r) => r.net).unknown, 4, 'and «ينتظر 4» beside it');
  // THE BAGHDAD DAY: an order delivered at 21:40 UTC on Friday 6 November is 00:40 on Saturday 7 November in Baghdad — that day's
  // order and the second week's, never the 6th's (the 6th is a quiet day); its day opens on it, the 6th on none.
  const late = s.orders.find((o) => o.id === 'ORD-0A00000007')!;
  assert.deepEqual([late.delivered_at!.slice(0, 10), financeDay(late.delivered_at)], ['2026-11-06', '2026-11-07']);
  const on = (key: string) => days.find((d) => d.key === key)!;
  assert.deepEqual([on('2026-11-06').orders, on('2026-11-07').orders, on('2026-11-07').revenue, on('2026-11-07').net, on('2026-11-07').estimated], [0, 1, 29500, 12405, 1]);
  assert.deepEqual([scopeIds({ kind: 'days', from: '2026-11-06', to: '2026-11-06' }, s), scopeIds({ kind: 'days', from: '2026-11-07', to: '2026-11-07' }, s)], [[], ['ORD-0A00000007']]);
  assert.deepEqual(weeks.map((w) => w.orders), [6, 7], 'six orders in the first week, seven in the second with the late one');
});


test('every word of the reports and the drawer is in Arabic, English and real Sorani, with the same placeholders (DECISIONS row 183)', () => {
  const keys = Object.keys(RS) as Array<keyof typeof RS>;
  assert.ok(keys.length > 80);
  const holes = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const key of [...keys.map((k) => RS[k]), FW.sectionsPage, FW.daysPage].map((t, i) => [keys[i] ?? 'page', t] as const)) {
    const [name, [ar, en, ckb]] = key;
    assert.ok(ar && en && ckb, name);
    assert.match(ar, ARABIC, `${name}: the Arabic`);
    assert.doesNotMatch(en.replace(/«[^»]*»/g, ''), ARABIC, `${name}: the English`);
    assert.notEqual(ckb, ar, `${name}: the Sorani is the Arabic`);
    assert.notEqual(ckb, en, `${name}: the Sorani is the English`);
    assert.match(ckb, SORANI_ONLY, `${name}: «${ckb}» has no Sorani letter`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${name}: «${ckb}» has an Arabic-only letter`);
    assert.equal(holes(en), holes(ar), `${name}: English placeholders`);
    assert.equal(holes(ckb), holes(ar), `${name}: Sorani placeholders`);
  }
  assert.deepEqual(['ar', 'en', 'ckb'].map((l) => dayText(l as 'ar', '2026-11-09')), ['9 تشرين الثاني', 'Nov 9', '9 تشرینی دووەم']);
  const loc = (lang: 'ar' | 'en' | 'ckb') => (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k || a : a);
  assert.equal(sectionName(loc('ckb'), { id: 'unclassified', name: 'غير مصنف', level: 'sub' }), RS.noSub[2]);
  assert.equal(sectionName(loc('en'), { id: 'x', name: 'قطع', name_ar: 'قطع', name_en: '', name_ckb: '', level: 'main' }), 'قطع', 'no English name yet: the Arabic, not a blank');
  assert.equal(sectionName(loc('ckb'), s.categories[0]), 'چاپکەرەکان');
});

const render = (node: ReturnType<typeof createElement>, lang: 'ar' | 'en' | 'ckb') => {
  LANG = lang;
  try { return renderToStaticMarkup(createElement(LanguageProvider, null, node)); } finally { LANG = 'ar'; }
};
const noop = () => {};

test('the four tables as the owner sees them, in three languages: the strip and the totals, chips for what is missing, and no bare dash', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const orders = render(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), lang);
    assert.match(orders, /data-finance-report="orders"/);
    assert.equal((orders.match(/data-finance-order="/g) ?? []).length, 13, `${lang}: every order`);
    assert.match(orders, /5,814,070/, `${lang}: the sales`);
    assert.match(orders, /796,059/, `${lang}: the calculated net`);
    assert.ok(orders.includes(RS.netTotal[lang === 'ar' ? 0 : lang === 'en' ? 1 : 2].replace('{n}', '9')), `${lang}: the net total says it is the 9 calculated orders'`);
    assert.match(orders, /data-finance-chip="no_price"/, `${lang}: the missing price opens the costs`);
    assert.match(orders, /data-finance-cash="not_recorded"/, `${lang}: unrecorded cash opens the collections`);
    assert.match(orders, /aria-sort="descending"/, `${lang}: newest first`);
    const products = render(createElement(GroupsReport, { data: s, level: 'product', onOpenOrders: noop, onMissing: noop }), lang);
    assert.equal((products.match(/data-finance-group="/g) ?? []).length, 6);
    assert.match(products, /14,902/, `${lang}: the switches' net`);
    const sections = render(createElement(GroupsReport, { data: s, level: 'main', onLevel: noop, onOpenOrders: noop, onMissing: noop }), lang);
    assert.equal((sections.match(/data-finance-group="/g) ?? []).length, 3);
    if (lang === 'en') assert.match(sections, /Printing materials/, 'the English name of a section');
    const days = render(createElement(DaysReport, { data: s, onOpenOrders: noop }), lang);
    assert.equal((days.match(/data-finance-day="/g) ?? []).length, 11);
    assert.match(days, /5,968,070/, `${lang}: the revenue`);
    for (const html of [orders, products, sections, days]) assert.doesNotMatch(html, />—</, `${lang}: no bare dash`);
  }
});

test('a product\'s, a section\'s or a day\'s row opens the orders page on its own orders, read again from each summary — never the ids of the period it was clicked in', () => {
  const magnets = s.products.find((p) => p.id === 'prd_magnets')!, printers = s.categories.find((c) => c.id === 'cat_printers')!;
  assert.deepEqual(scopeIds({ kind: 'product', id: 'prd_magnets', name: magnets.name }, s), magnets.order_ids);
  assert.deepEqual(scopeIds({ kind: 'main', id: 'cat_printers', name: printers.name }, s), printers.order_ids);
  assert.deepEqual(scopeIds({ kind: 'sub', id: 'cat_printers', name: printers.name }, s), [], 'a main section is not a subsection of the same id');
  assert.deepEqual(scopeIds({ kind: 'days', from: '2026-11-09', to: '2026-11-09' }, s).sort(), ['ORD-0A00000004', 'ORD-0A00000005', 'ORD-0A00000006']);
  assert.equal(scopeIds({ kind: 'days', from: '2026-11-07', to: '2026-11-11' }, s).length, 7, 'a week from Saturday to the end of the period');
  // Another summary of the same row — a refresh, a wider or another period: the orders it has there, or none.
  const later = { ...s, products: s.products.map((p) => (p.id === 'prd_magnets' ? { ...p, order_ids: ['ORD-0A00000008'] } : p)) } as FinanceSummary;
  assert.deepEqual(scopeIds({ kind: 'product', id: 'prd_magnets', name: magnets.name }, later), ['ORD-0A00000008']);
  const without = { ...s, products: s.products.filter((p) => p.id !== 'prd_magnets') } as FinanceSummary;
  assert.deepEqual(scopeIds({ kind: 'product', id: 'prd_magnets', name: magnets.name }, without), []);
  // The chip names the row in the reader's language as it is now; the name it was opened with when the period no longer has it.
  const loc = (lang: 'ar' | 'en' | 'ckb') => (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k || a : a);
  assert.equal(scopeOf(loc('ckb'), 'ckb', { kind: 'main', id: 'cat_printers', name: 'الطابعات' }, s)?.label, 'بەش: چاپکەرەکان');
  assert.equal(scopeOf(loc('en'), 'en', { kind: 'product', id: 'prd_magnets', name: 'Magnet' }, without)?.label, 'Product: Magnet');
  assert.deepEqual(scopeOf(loc('ar'), 'ar', { kind: 'days', from: '2026-11-09', to: '2026-11-09' }, s)?.label, 'اليوم: 9 تشرين الثاني');
  assert.equal(scopeOf(loc('ar'), 'ar', null, s), null);
  // The page itself: exactly the row's orders, under its chip.
  const html = render(createElement(OrdersReport, { data: s, scope: { kind: 'product', id: 'prd_magnets', name: magnets.name }, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  assert.deepEqual([...html.matchAll(/data-finance-order="([^"]+)"/g)].map((m) => m[1]).sort(), [...magnets.order_ids!].sort());
  assert.match(html, /data-finance-scope[^>]*><bdi>Product: Sample magnets<\/bdi>/);
  // Both of the magnets' orders wait for a purchase price: their net is not known — «Waiting 2» in the strip and the totals row's net and
  // margin (a margin with no net is a chip too, the independent review of step 4), never 0.
  assert.equal((html.match(/data-finance-missing="true">Waiting\u00A02</g) ?? []).length, 3, 'the strip, the net total and the margin total');
  assert.doesNotMatch(html, /<b><span class="fw-num" dir="ltr">0<\/span><\/b>/);
  const all = render(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  assert.match(all, /<b><span class="fw-num" dir="ltr">796,059<\/span><\/b>/, 'with calculated orders among them, their net');
});

test('a long period draws its first 300 rows and «عرض الكل», while the totals row and the strip still count every row', () => {
  const many = Array.from({ length: 305 }, (_, i) => ({ ...s.orders[i % s.orders.length], id: `ORD-${String(i).padStart(4, '0')}`, order_id: `ORD-${String(i).padStart(4, '0')}` }));
  const big = { ...s, orders: many } as FinanceSummary;
  const html = render(createElement(OrdersReport, { data: big, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  assert.equal((html.match(/data-finance-order="/g) ?? []).length, 300, 'the first 300 rows');
  assert.match(html, />Show all \(305\)</);
  assert.match(html, /Orders <b>305<\/b>/, 'the strip counts every row');
  const sales = totalOf(many, (o) => money(o, 'retained_revenue_iqd')).sum;
  // 305 rows: the 13 orders 23 times over, then the first six again — 23 × 5,814,070 + 2,942,680.
  assert.equal(sales, 136666290);
  assert.ok(/<tfoot>[\s\S]*<\/tfoot>/.exec(html)![0].includes('>136,666,290</span>'), 'the totals row adds up all 305, not the 300 drawn');
  assert.doesNotMatch(render(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en'), /Show all/, '13 rows: no button');
});


// ------------------------------------------------------------------ the independent review of step 4
/** A table as a phone draws it: the stylesheet's 600 px query matches, so each table is its list (useNarrow). */
const phone = (node: ReturnType<typeof createElement>, lang: 'ar' | 'en' | 'ckb') => {
  const g = globalThis as { window?: unknown }, before = g.window;
  g.window = { location: { href: 'https://levonis-iq.com/admin', search: '' }, history: { state: null, replaceState: () => {} },
    matchMedia: (q: string) => ({ matches: q.includes('max-width: 600px'), media: q, addEventListener: () => {}, removeEventListener: () => {} }) };
  try { return render(node, lang); } finally { g.window = before; }
};
const rowOf = (html: string, attr: string, id: string) => new RegExp(`<(li|tr)[^>]* ${attr}="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html)?.[2] ?? '';
const footOf = (html: string) => /<tfoot>[\s\S]*<\/tfoot>/.exec(html)![0];

test('Orders: an unknown margin is a chip — «ينتظر» for a waiting order, «بلا مبيعات» for a gift — and an unknown goods cost a chip that opens what fixes it (review, screens)', () => {
  const html = render(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  const head = [...(/<thead>([\s\S]*?)<\/thead>/.exec(html)![1]).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/[▲▼]/g, ''));
  const margin = head.indexOf('Margin'), cogs = head.indexOf('Cost of goods');
  const cells = (id: string) => [...rowOf(html, 'data-finance-order', id).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]);
  for (const id of ['ORD-0A00000002', 'ORD-0A00000004', 'ORD-0A00000008', 'ORD-0A0000000C']) assert.match(cells(id)[margin], /data-finance-missing="true">Waiting</, `${id}: its margin waits, never an empty cell`);
  // Its net over its revenue: 122,267 of 755,500.
  assert.match(cells('ORD-0A00000001')[margin], /16\.2%/);
  assert.match(cells('ORD-0A00000004')[cogs], /<button type="button" class="fw-missing fw-chip-button"[^>]*data-finance-chip="no_price"[^>]*>No purchase price<\/button>/, 'the missing price opens «التكاليف الناقصة»');
  // A gift sold at 0 has a known net and no margin to give.
  const gift = { ...s, orders: [{ ...s.orders[0], id: 'ORD-GIFT', order_id: 'ORD-GIFT', order_kind: 'gift', retained_revenue_iqd: 0, net_goods_iqd: 0, revenue_iqd: 0, shipping_income_iqd: 0, cod_tax_iqd: 0,
    net_after_report_adjustments_iqd: -1000, owner_net_iqd: -1000 }] } as FinanceSummary;
  const g = render(createElement(OrdersReport, { data: gift, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  assert.match(rowOf(g, 'data-finance-order', 'ORD-GIFT'), />No sales</);
  assert.match(footOf(g), />No sales</, 'and its totals row');
});

test('on a phone, a product or section that is not confirmed keeps its status — an estimate always named — never twice, and its pieces read «القطع: 64» (review, screens)', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const i = lang === 'ar' ? 0 : lang === 'en' ? 1 : 2, t = (key: keyof typeof RS) => RS[key][i];
    const html = phone(createElement(GroupsReport, { data: s, level: 'product', onOpenOrders: noop, onMissing: noop }), lang);
    assert.match(html, /<ul class="fw-rows" data-finance-report="products"/, `${lang}: a list`);
    assert.ok(rowOf(html, 'data-finance-group', 'prd_switches').includes(t('stEstimated')), `${lang}: the switches rest on an estimate`);
    assert.ok(rowOf(html, 'data-finance-group', 'prd_printer_c').includes(t('stInvestor')), `${lang}: printer C's investor share waits`);
    assert.equal(rowOf(html, 'data-finance-group', 'prd_printer_c').split(t('stInvestor')).length - 1, 1, `${lang}: and says so once`);
    assert.ok(rowOf(html, 'data-finance-group', 'prd_printer_c').includes(`<span class="fw-status fw-status--warning">${FW.estimatedChip[i]}</span>`), `${lang}: its known goods cost, the sale-time estimate, named beside its status`);
    assert.ok(rowOf(html, 'data-finance-group', 'prd_filament').includes(t('stWage')), `${lang}: the filament's wage waits`);
    assert.equal(rowOf(html, 'data-finance-group', 'prd_magnets').split(t('stNoPrice')).length - 1, 1, `${lang}: the magnets say «no purchase price» once`);
    assert.ok(!rowOf(html, 'data-finance-group', 'prd_printer_a').includes(t('stConfirmed')), `${lang}: a confirmed row stays quiet`);
    const pieces = FW.pieces[i];
    assert.ok(html.includes(`${pieces}: 64`), `${lang}: the count after a colon`);
    assert.ok(!html.includes(`64 ${pieces}`), `${lang}: never «64 القطع»`);
    const sections = phone(createElement(GroupsReport, { data: s, level: 'main', onLevel: noop, onOpenOrders: noop, onMissing: noop }), lang);
    assert.ok(rowOf(sections, 'data-finance-group', 'cat_printers').includes(t('stInvestor')), `${lang}: a section's status too`);
    // «حسب نوع الطلب» is a list on a phone (its last column was cut at 390 px).
    assert.match(phone(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), lang), /<ul class="fw-rows" data-finance-kinds/);
  }
});

test('Days count, column by column, the orders that make a cell unknown — the totals the same orders, never days — and name the estimates a known figure stands on (review, money and screens)', () => {
  const weeks = groupDays(s.chart_data!.daily, 'week', s.orders, s), months = groupDays(s.chart_data!.daily, 'month', s.orders, s);
  // 1–6 November: an investor share waits (a known cost) and an order has no purchase price (a known investor share).
  assert.deepEqual(weeks.map((w) => [w.waiting, w.costWaits, w.investorWaits]), [[2, 1, 1], [2, 2, 0]]);
  // The orders whose known goods cost rests on a sale-time estimate: the six «تقديري» ones and the waiting investor order, whose share
  // waits for a confirmed cost while its own line is on the estimate (the second review's rule; the third: the fixture says so through the
  // order's review reason, as the server does — never because the share waits).
  assert.equal(s.known!.estimated!.orders_count, 6);
  assert.deepEqual(months.map((m) => [m.waiting, m.costWaits, m.investorWaits, m.estimated]), [[4, 3, 1, 7]]);
  for (const rows of [weeks, months]) {
    assert.equal(countWhereUnknown(rows, (r) => r.net, (r) => r.waiting), 4, 'the net total waits for 4 orders, whatever the grouping');
    assert.equal(countWhereUnknown(rows, (r) => r.cost, (r) => r.costWaits), 3);
    assert.equal(countWhereUnknown(rows, (r) => r.investor, (r) => r.investorWaits), 1);
  }
  const html = render(createElement(DaysReport, { data: s, onOpenOrders: noop }), 'en');
  const nov2 = [...rowOf(html, 'data-finance-day', '2026-11-02').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]);
  // 2 November: one order on an estimate, and one whose investor share waits for a confirmed cost, its own goods cost the sale-time
  // estimate — the day's known costs (1,312,000 + 55,926 of promotion, 49,050 + 2,234) name both.
  const day2 = groupDays(s.chart_data!.daily, 'day', s.orders, s).find((d) => d.key === '2026-11-02')!;
  assert.deepEqual([day2.estimated, day2.investorWaits, day2.waiting, day2.cost], [2, 1, 1, 1419210]);
  assert.match(nov2[3], /1,419,210<\/span> <span class="fw-status fw-status--warning">Estimated\u00A02</, '2 November: its known costs name the estimates they hold');
  assert.match(nov2[4], />Waiting\u00A01</, 'its investor share waits for one order');
  assert.match(nov2[nov2.length - 1], />Waiting\u00A01</, 'its net waits for it');
  assert.doesNotMatch(nov2[nov2.length - 1], /Estimated/, 'an unknown net names no estimate');
  const foot = footOf(html);
  assert.match(foot, /Waiting\u00A04/);
  assert.match(foot, /Waiting\u00A03/);
  // The known costs: the 2nd's two estimates, the 4th's one and the 7th's one; the known net: the 4th's and the 7th's (the 2nd's waits).
  assert.deepEqual(foot.match(/Estimated\u00A0\d+/g), ['Estimated\u00A04', 'Estimated\u00A02'], 'each known total names the estimates it holds, and only those');
  // The rule on its own, on invented orders: a known goods cost on an estimate, whatever the order waits for; a server without cost_confidence by its state.
  const base = { id: 'ORD-INVENTED', status: 'delivered', created_at: '2026-10-02T09:00:00Z', cogs_iqd: 35000, profit_basis_iqd: 40000 } as FinanceOrder;
  assert.equal(restsOnEstimate({ ...base, cost_confidence: 'snapshot', finance_state: 'waiting' }, { state: 'waiting', reason: 'investor_waits' }), true, 'its investor share waits, its cost is an estimate');
  assert.equal(restsOnEstimate({ ...base, cost_confidence: 'verified', finance_state: 'waiting' }, { state: 'waiting', reason: 'investor_waits' }), false, 'its investor share waits, its cost is confirmed');
  assert.equal(restsOnEstimate({ ...base, cogs_iqd: null, profit_basis_iqd: null, cost_confidence: 'unknown' }, { state: 'waiting', reason: 'no_price' }), false, 'no goods cost: nothing estimated in it');
  assert.equal(restsOnEstimate({ ...base, cost_confidence: 'verified' }, { state: 'confirmed', reason: null }), false);
  assert.equal(restsOnEstimate(base, { state: 'estimated', reason: null }), true, 'a server without cost_confidence: by its state');
  assert.equal(restsOnEstimate({ ...base, finance_state: 'waiting' }, { state: 'waiting', reason: 'investor_waits' }), false, 'an older server says nothing of a waiting order\'s cost');
  // A quiet day opens nothing: no button, no pointer.
  assert.equal((html.match(/class="fw-clickable"/g) ?? []).length, 6, 'the six days with orders');
  assert.equal((html.match(/<th scope="row" class="fw-start"><button/g) ?? []).length, 6);
  // The rule's other side, end to end (the invented month cannot show it: its waiting investor order rests on the estimate). On invented
  // orders (investorDays, below), 3 October holds an order on the estimate beside one whose investor share waits on a CONFIRMED goods
  // cost: the day's known costs (79,720) name one estimate, not two, and the month counts that one alone.
  const other = investorDays();
  assert.deepEqual(groupDays(other.chart_data!.daily, 'day', other.orders, other).map((d) => [d.key, d.orders, d.cost, d.net, d.estimated, d.investorWaits, d.waiting, d.costWaits]),
    [['2026-10-03', 2, 79720, null, 1, 1, 1, 0], ['2026-10-04', 0, 0, 0, 0, 0, 0, 0], ['2026-10-05', 1, 41750, 26750, 0, 0, 0, 0], ['2026-10-06', 0, 0, 0, 0, 0, 0, 0]]);
  assert.deepEqual(groupDays(other.chart_data!.daily, 'month', other.orders, other).map((m) => [m.orders, m.revenue, m.cost, m.investor, m.net, m.waiting, m.investorWaits, m.estimated]),
    [[3, 202000, 121470, null, null, 1, 1, 1]]);
  const otherHtml = render(createElement(DaysReport, { data: other, onOpenOrders: noop }), 'en'), oct3 = cellsOf(otherHtml, 'data-finance-day', '2026-10-03');
  assert.equal(oct3[3], '<span class="fw-num" dir="ltr">79,720</span> <span class="fw-status fw-status--warning">Estimated\u00A01</span>', '3 October: its known costs name the one estimate they hold');
  assert.match(oct3[4], />Waiting\u00A01</, 'its investor share waits for one order');
  assert.match(oct3[oct3.length - 1], />Waiting\u00A01</, 'its net waits for it');
  assert.doesNotMatch(oct3[oct3.length - 1], /Estimated/, 'an unknown net names no estimate');
  // The known costs total names that one; the known net (26,750 of the 5th and two quiet days) holds none and names none.
  const otherFoot = footCells(otherHtml);
  assert.equal(otherFoot[3], '<span class="fw-num" dir="ltr">121,470</span> <span class="fw-status fw-status--warning">Estimated\u00A01</span>');
  assert.match(otherFoot[otherFoot.length - 1], />26,750\+<\/span> <span class="fw-missing"[^>]*>Waiting\u00A01</);
  assert.deepEqual(footOf(otherHtml).match(/Estimated\u00A0\d+/g), ['Estimated\u00A01'], 'the known costs total names the one estimate it holds; the known net, none');
  // Without the order on the estimate no known figure holds one, and none names one: not the investor order's confirmed cost, not a total.
  const alone = investorDays(false), aloneHtml = render(createElement(DaysReport, { data: alone, onOpenOrders: noop }), 'en');
  assert.deepEqual(groupDays(alone.chart_data!.daily, 'month', alone.orders, alone).map((m) => [m.orders, m.cost, m.waiting, m.investorWaits, m.estimated]), [[2, 90470, 1, 1, 0]]);
  assert.equal(cellsOf(aloneHtml, 'data-finance-day', '2026-10-03')[3], '<span class="fw-num" dir="ltr">48,720</span>', 'a confirmed cost whose investor share waits names no estimate');
  assert.equal(footCells(aloneHtml)[3], '<span class="fw-num" dir="ltr">90,470</span>', 'a known costs total with no estimate in it names none');
  assert.doesNotMatch(footOf(aloneHtml), /Estimated/, 'nor does the known net, nor any other total');
});

test('the products and the sections end on «خصومات على مستوى الطلب» — after the others, never sorted — so their «صافيك» total meets the orders\' (review, money and screens)', () => {
  const level0 = { coupon_iqd: 3000, price_protection_iqd: 0, trade_in_credit_returned_iqd: 0, net_after_report_adjustments_iqd: -3000, order_ids: ['ORD-0A00000001'], orders_count: 1 };
  const withLevel = { ...s, order_level: level0 } as FinanceSummary;
  for (const level of ['product', 'main', 'sub'] as const) {
    const html = render(createElement(GroupsReport, { data: withLevel, level, onLevel: level === 'product' ? undefined : noop, onOpenOrders: noop, onMissing: noop }), 'en');
    const groups = [...html.matchAll(/<tr[^>]* data-finance-group="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(groups.at(-1), 'order_level', `${level}: the last row`);
    assert.match(rowOf(html, 'data-finance-group', 'order_level'), /Order-level deductions[\s\S]*-3,000/);
    const rows = [...(level === 'product' ? s.products : s.categories.filter((c) => c.level === level)), orderLevelRow(withLevel, level)!];
    const net = totalOf(rows, (p) => groupNet(p, groupMoney(undefined, level)));
    assert.ok(footOf(html).includes(`>${net.sum.toLocaleString('en-US')}+</span>`), `${level}: the known net total counts it`);
  }
  assert.deepEqual(scopeIds({ kind: 'product', id: 'order_level', name: '' }, withLevel), ['ORD-0A00000001'], 'it opens the orders it comes from');
  assert.equal(scopeOf((_a, e) => e, 'en', { kind: 'main', id: 'order_level', name: '' }, withLevel)?.label, 'Order-level deductions');
  // In dollars the row sells nothing either: its sales are 0, never «unknown».
  const cents = groupMoney({ available: true, order_level: { coupon_cents: 200, net_after_report_adjustments_cents: -200 } }, 'product'), row = orderLevelRow(withLevel, 'product')!;
  assert.deepEqual([cents(row, 'retained_revenue_iqd'), cents(row, 'net_after_report_adjustments_iqd')], [0, -200]);
});

test('sales that count a refund nobody recorded as 0 say so, on their row and in the totals (review, money lens)', () => {
  const refunded = { ...s, orders: s.orders.map((o) => (o.id === 'ORD-0A00000001' ? { ...o, unknown_refunds: 1 } : o)), products: s.products.map((p) => (p.id === 'prd_printer_a' ? { ...p, unknown_refunds: 1 } : p)) } as FinanceSummary;
  const orders = render(createElement(OrdersReport, { data: refunded, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  assert.match(rowOf(orders, 'data-finance-order', 'ORD-0A00000001'), /735,000<\/span> <span class="fw-status fw-status--warning">Refund amount unconfirmed</);
  assert.match(footOf(orders), /Unconfirmed refund\u00A01/);
  const products = render(createElement(GroupsReport, { data: refunded, level: 'product', onOpenOrders: noop, onMissing: noop }), 'en');
  assert.match(rowOf(products, 'data-finance-group', 'prd_printer_a'), /Refund amount unconfirmed/);
  assert.equal(groupDays(refunded.chart_data!.daily, 'day', refunded.orders, refunded).find((d) => d.key === '2026-11-10')!.refunds, 1, 'and its day');
});

test('each page exports itself as shown — its filters, its row or days, its grouping — for the period it was read for, and under the dollar toggle says the file is in dinars (review, money and safety)', () => {
  assert.equal(exportQuery({ view: 'orders', q: '  a0000000c ', state: 'reason:no_price', kind: 'gift', scope: { kind: 'product', id: 'prd_magnets', name: 'x' } }),
    '&view=orders&q=a0000000c&state=reason%3Ano_price&kind=gift&scope=product%3Aprd_magnets');
  assert.equal(exportQuery({ view: 'orders', scope: { kind: 'days', from: '2026-11-07', to: '2026-11-11' } }), '&view=orders&scope=days%3A2026-11-07%3A2026-11-11');
  assert.equal(exportQuery({ view: 'sections', level: 'sub', q: 'FDM' }), '&view=sections&level=sub&q=FDM');
  assert.equal(exportQuery({ view: 'days', by: 'day' }), '&view=days', 'the day view is the default file');
  assert.equal(exportQuery({ view: 'days', by: 'week' }), '&view=days&by=week');
  assert.equal(exportQuery({ view: 'orders', part: 'period' }), '&view=orders&part=period');
  const href = (html: string) => /href="([^"]+)"[^>]*data-finance-export/.exec(html)?.[1].replace(/&amp;/g, '&');
  const base = '/api/admin/finance-workspace/export.csv?from=2026-11-01&to=2026-11-11';
  const magnets = render(createElement(OrdersReport, { data: s, scope: { kind: 'product', id: 'prd_magnets', name: 'm' }, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  assert.equal(href(magnets), `${base}&view=orders&scope=product%3Aprd_magnets`, 'the magnets\' orders, not every order of the period');
  // The same table as a workbook and as a printed page (the owner's brief, 2026-11-12; DECISIONS row 329): the same filters, the reader's language.
  const fileHref = (html: string, attr: string) => new RegExp(`href="([^"]+)"[^>]*${attr}`).exec(html)?.[1].replace(/&amp;/g, '&');
  assert.equal(fileHref(magnets, 'data-finance-export-xlsx'), '/api/admin/finance-workspace/export.xlsx?from=2026-11-01&to=2026-11-11&view=orders&scope=product%3Aprd_magnets&lang=en');
  assert.equal(fileHref(magnets, 'data-finance-export-print'), '/api/admin/finance-workspace/print?from=2026-11-01&to=2026-11-11&view=orders&scope=product%3Aprd_magnets&lang=en');
  assert.match(magnets, /target="_blank" rel="noopener"[^>]*data-finance-export-print/, 'the printed page opens in its own tab');
  assert.doesNotMatch(render(createElement(GroupsReport, { data: s, level: 'product', onOpenOrders: noop, onMissing: noop }), 'en'), /data-finance-export-xlsx|data-finance-export-print/, 'the orders page only');
  assert.equal(href(render(createElement(GroupsReport, { data: s, level: 'product', onOpenOrders: noop, onMissing: noop }), 'en')), `${base}&view=products`);
  assert.equal(href(render(createElement(GroupsReport, { data: s, level: 'main', onLevel: noop, onOpenOrders: noop, onMissing: noop }), 'en')), `${base}&view=sections&level=main`);
  assert.equal(href(render(createElement(DaysReport, { data: s, onOpenOrders: noop }), 'en')), `${base}&view=days`);
  const dollars = render(createElement(DisplayCurrencyContext.Provider, { value: 'USD' }, createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop })), 'en');
  assert.match(dollars, /data-finance-export="true"><svg[\s\S]*?<span>Export CSV in IQD<\/span>/);
  // A type chosen on a wide screen keeps filtering on a phone, where its menu is hidden: a chip there names it and takes it off.
  assert.match(readFileSync(join(ROOT, 'src/components/financeWorkspace/Reports.tsx'), 'utf8'), /\{narrow && <ScopeChip label=\{kind \? rs\(loc, 'kindFilter', \{ name: kindName \}\) : null\} onClear=\{\(\) => setKind\(''\)\}/);
});

test('a day keeps its year when the period spans two (review nit): a year-long range never shows two rows «11 تشرين الثاني»', () => {
  assert.equal(dayIn('ar', '2026-11-09', { from: '2026-11-01', to: '2026-11-11' }), '9 تشرين الثاني');
  assert.equal(dayIn('ar', '2025-11-11', { from: '2025-11-11', to: '2026-11-11' }), '11 تشرين الثاني 2025');
  assert.equal(dayIn('en', '2026-11-11', { from: '2025-11-11', to: '2026-11-11' }), 'Nov 11, 2026');
  assert.equal(dayIn('ckb', '2026-01-02', { from: '2025-12-20', to: '2026-01-05' }), '2 کانوونی دووەم 2026');
});

// ------------------------------------------------------------------ the second review of step 4
test('the products\' note names every term of a product\'s «صافيك» in the statement\'s own words — the COD fee\'s share added, the extra costs taken off (second review, nit)', () => {
  // A product's net as the server builds it (orderProfit refreshProfit, then the promotion, the investors and the deductions): its gross profit
  // + delivery + the COD fee − wages − materials and extra costs − courier and payment fees − promotion − investor share − its coupons and credits.
  const terms: Array<[string, readonly [string, string, string]]> = [
    ['gross profit', ['ربح بضاعة', 'gross profit', 'قازانجی کاڵا']],
    ['delivery charged', FW.delivery],
    ['the COD fee', FW.cod],
    ['wages', ['أجوره', 'wages', 'کرێ']],
    ['materials', ['موادّه', 'materials', 'کەرەستە']],
    ['extra costs', ['تكاليفه الإضافية', 'extra costs', 'تێچووی زیادە']],
    ['courier and payment fees', FW.fees],
    ['promotion by sales value', ['الترويج حسب قيمة المبيعات', 'promotion by sales value', 'بانگەشە بەپێی بەهای فرۆشتن']],
    ['investors', ['حصة المستثمرين', 'investors’ share', 'بەشی وەبەرهێنەران']],
    ['coupons and credits', ['الكوبونات والأرصدة', 'coupons and credits', 'کۆپۆن و باڵانسەکان']],
    ['before general expenses', ['قبل المصاريف العامة', 'before general expenses', 'پێش خەرجییە گشتییەکان']],
  ];
  RS.productsNote.forEach((note, i) => {
    for (const [name, words] of terms) assert.ok(note.toLocaleLowerCase().includes(words[i].toLocaleLowerCase()), `${['ar', 'en', 'ckb'][i]}: ${name} («${words[i]}»)`);
  });
});

test('every column stays on screen: none steps aside at any width — a table wider than its card scrolls inside it — and a «ينتظر» chip wraps on whole words (second review, screens)', () => {
  // The promotion and a product's section were hidden under 1080 px of workspace: every laptop inside the admin shell (968 px at 1280
  // with the sidebar, 1,054 at 1366). Measured in headless Edge in the shell: every column on screen at 1280, 1366 and 1440 in ar, en and ckb.
  const heads = (html: string) => [...(/<thead>([\s\S]*?)<\/thead>/.exec(html)![1]).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/[▲▼]/g, ''));
  const orders = render(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en');
  const products = render(createElement(GroupsReport, { data: s, level: 'product', onOpenOrders: noop, onMissing: noop }), 'en');
  const sections = render(createElement(GroupsReport, { data: s, level: 'main', onLevel: noop, onOpenOrders: noop, onMissing: noop }), 'en');
  assert.deepEqual(heads(orders), ['Order', 'Delivered', 'Sales', 'Cost of goods', 'Wages', 'Promotion', 'Investor', 'Your net', 'Margin', 'Status', 'Cash']);
  assert.deepEqual(heads(products), ['Product', 'Section', 'Pieces', 'Sales', 'Cost of goods', 'Gross profit', 'Margin', 'Promotion', 'Your netbefore general expenses', 'Status']);
  assert.ok(heads(sections).includes('Promotion'));
  for (const html of [orders, products, sections]) assert.doesNotMatch(html, /fw-low/, 'no cell is marked to step aside');
  const css = readFileSync(join(ROOT, 'src/components/financeWorkspace/finance-workspace.css'), 'utf8');
  assert.doesNotMatch(css, /@container|fw-low/, 'no rule hides a report\'s column at any width');
  assert.match(css, /\.fw-report \.fw-missing\{white-space:normal;overflow-wrap:normal\}/, 'a «چاوەڕێ دەکات» chip wraps on its words, so Orders fits at 1280 in Sorani');
  assert.match(css, /\.fw-table-wrap\{overflow-x:auto\}/, 'a table too wide for its card scrolls inside it');
});

// ------------------------------------------------------------------ the third review of step 4
test('the fixture says of each order\'s goods cost what the server would: «verified» unless a review reason names a price not confirmed — never because an investor share waits — and the others are «التكاليف الناقصة»\'s (third review, money)', () => {
  // The server (adminFinanceWorkspace orderRow): no goods cost → 'unknown'; a line not confirmed → 'snapshot' (and such a line always
  // raises one of these reasons, orderProfitReview describeOrderProfit; a profit-based wage waiting on one, the last); else 'verified'.
  const UNCONFIRMED = ['fifo_missing', 'historical_cost_unverified', 'fifo_quantity_incomplete', 'fifo_cost_missing', 'verified_goods_cost_required'];
  const unconfirmed = (o: FinanceOrder) => (o.review_reasons ?? []).some((r) => UNCONFIRMED.includes(r.code));
  for (const o of s.orders) {
    assert.equal(o.cost_confidence, o.cogs_iqd == null ? 'unknown' : unconfirmed(o) ? 'snapshot' : 'verified', o.id);
    const st = standingOf(o, s);
    if (st.state !== 'waiting') assert.equal(st.state === 'estimated', o.cost_confidence !== 'verified', `${o.id}: a complete order stands «تقديري» exactly when its cost rests on an estimate`);
  }
  assert.equal(s.orders.filter((o) => o.cost_confidence !== 'verified').length, s.missing_costs!.orders, 'the orders a confirmed price still waits for are those «التكاليف الناقصة» counts');
  for (const p of s.products) {
    const verified = p.order_ids!.every((id) => s.orders.find((o) => o.id === id)!.cost_confidence === 'verified');
    if (verified) assert.equal(p.estimated_lines, 0, `${p.id}: a product sold only on confirmed costs has no estimated line`);
  }
  // The waiting investor order stands on the estimate by its own review reason — its funded line is costed on the sale-time estimate —
  // not because its share waits. Its known basis puts that estimate into Days' known costs beside the six «تقديري» orders, and no other
  // waiting order puts one there (the wage's basis waits, the two without a price have none).
  const investor = s.orders.find((o) => o.id === 'ORD-0A0000000C')!;
  assert.deepEqual([standingOf(investor, s).reason, investor.cost_confidence, (investor.review_reasons ?? []).map((r) => r.code)], ['investor_waits', 'snapshot', ['fifo_missing']]);
  assert.equal(s.orders.filter((o) => o.profit_basis_iqd != null && o.cost_confidence !== 'verified').length, 7);
  assert.equal(groupDays(s.chart_data!.daily, 'month', s.orders, s)[0].estimated, 7, 'the six «تقديري» orders and the waiting investor order');
  // The other side, on invented orders (investorDays): an investor share that waits leaves a confirmed cost confirmed, so on Days no
  // waiting order puts an estimate into a known cost and the «تقديري» orders are the only ones counted — here the one.
  const other = investorDays();
  assert.deepEqual(other.orders.map((o) => [o.id, o.cost_confidence, standingOf(o, other).state, standingOf(o, other).reason]),
    [['ORD-T-EST', 'snapshot', 'estimated', null], ['ORD-T-INV', 'verified', 'waiting', 'investor_waits'], ['ORD-T-CONF', 'verified', 'confirmed', null]]);
  assert.equal(groupDays(other.chart_data!.daily, 'month', other.orders, other)[0].estimated, 1, 'the «تقديري» order alone, not the waiting investor order on a confirmed cost');
});

/** An invented order (the third review's tables): a delivered order of 50,000 on a goods cost of 30,000, confirmed unless told otherwise. */
const invented = (id: string, over: Partial<FinanceOrder> = {}): FinanceOrder => ({ id, order_id: id, status: 'delivered', created_at: '2026-10-02T09:00:00Z', delivered_at: '2026-10-02T09:00:00Z', customer_name: 'Customer',
  order_kind: 'normal', retained_revenue_iqd: 50000, net_goods_iqd: 50000, shipping_income_iqd: 5000, cod_tax_iqd: 0, revenue_iqd: 55000, cogs_iqd: 30000, gross_profit_iqd: 20000, wages_iqd: 0,
  direct_cost_iqd: 0, materials_iqd: 0, promotion_iqd: 1000, investor_iqd: 0, profit_basis_iqd: 25000, owner_net_iqd: 24000, net_after_report_adjustments_iqd: 24000, pending_costs: 0, unknown_lines: 0,
  cost_confidence: 'verified', finance_state: 'confirmed', wait_reason: null, cash_state: 'recorded', ...over });
const waitingNet = { owner_net_iqd: null, net_after_report_adjustments_iqd: null };
/** A product or a section of the invented period: its one order's figures. */
const group = (id: string, level: 'product' | 'main', over: Partial<FinanceProduct> = {}): FinanceProduct => ({ id, name: `Row ${id}`, name_ar: `صف ${id}`, name_en: `Row ${id}`, name_ckb: `ڕیزی ${id}`, level, qty: 1, kept_qty: 1, returned_qty: 0,
  orders_count: 1, order_ids: [], retained_revenue_iqd: 50000, net_goods_iqd: 50000, cogs_iqd: 30000, gross_profit_iqd: 20000, promotion_iqd: 1000, investor_iqd: 0, owner_net_iqd: 24000,
  net_after_report_adjustments_iqd: 24000, pending_costs: 0, unknown_lines: 0, estimated_lines: 0, finance_state: 'confirmed', wait_reason: null, ...over });
const GROUPS: Array<[string, Partial<FinanceProduct>]> = [['confirmed', {}], ['estimated', { estimated_lines: 1, finance_state: 'estimated' }],
  ['wage', { estimated_lines: 2, finance_state: 'waiting', wait_reason: 'wage_waits_cost', pending_costs: 1, ...waitingNet }], ['investor', { finance_state: 'waiting', wait_reason: 'investor_waits', investor_iqd: null, ...waitingNet }],
  ['none', { cogs_iqd: null, gross_profit_iqd: null, unknown_lines: 1, finance_state: 'waiting', wait_reason: 'no_price', ...waitingNet }]];
const inventedPeriod = (): FinanceSummary => ({ range: { from: '2026-10-01', to: '2026-10-31' }, totals: {}, truncated: false, exceptions: [], promotions: [],
  orders: [invented('ORD-T-CONF'), invented('ORD-T-EST', { cost_confidence: 'snapshot', finance_state: 'estimated' }),
    // Its wage waits for the goods cost, which is known and rests on the sale-time estimate.
    invented('ORD-T-WAGE', { cost_confidence: 'snapshot', finance_state: 'waiting', wait_reason: 'wage_waits_cost', pending_costs: 1, profit_basis_iqd: null, ...waitingNet }),
    // Its investor share waits; its goods cost is confirmed.
    invented('ORD-T-INV', { finance_state: 'waiting', wait_reason: 'investor_waits', investor_iqd: null, ...waitingNet }),
    invented('ORD-T-NONE', { cogs_iqd: null, gross_profit_iqd: null, profit_basis_iqd: null, unknown_lines: 1, cost_confidence: 'unknown', finance_state: 'waiting', wait_reason: 'no_price', ...waitingNet })],
  products: GROUPS.map(([id, over]) => group(id, 'product', over)), categories: GROUPS.map(([id, over]) => group(id, 'main', over)) } as FinanceSummary);
/**
 * THE OTHER SIDE OF THE THIRD REVIEW'S RULE, ON DAYS: the invented month's waiting investor order rests on the sale-time estimate
 * (its review reason says so), so these invented orders hold the case of an investor share that waits on a CONFIRMED goods cost.
 * 3 October: ORD-T-EST on the estimate, and ORD-T-INV, its investor share waiting, 73,500 of sales on a confirmed cost of 47,250;
 * 5 October: ORD-T-CONF, 62,500 on 40,500 with 6,000 of delivery; the 4th and the 6th quiet. Each order's promotion is 2% of its
 * sales. Each day's amounts are the server's for its orders: its costs the goods cost and the promotion, known on the 3rd because
 * both orders' bases are; its investor share and net waiting for ORD-T-INV. `estimate: false` leaves the 3rd ORD-T-INV alone.
 */
const investorDays = (estimate = true): FinanceSummary => {
  const at = (d: string) => `${d}T09:00:00Z`;
  const day = (d: string, orders: number, revenue: number, cost: number, investor: number | null, net: number | null) =>
    ({ day: d, orders_count: orders, revenue_iqd: revenue, cost_iqd: cost, investor_iqd: investor, owner_net_iqd: net, net_after_report_adjustments_iqd: net, deductions_iqd: 0, unknown_lines: 0, pending_costs: 0 });
  return { ...inventedPeriod(), range: { from: '2026-10-03', to: '2026-10-06' },
    orders: [...(estimate ? [invented('ORD-T-EST', { cost_confidence: 'snapshot', finance_state: 'estimated', delivered_at: at('2026-10-03') })] : []),
      invented('ORD-T-INV', { retained_revenue_iqd: 73500, net_goods_iqd: 73500, revenue_iqd: 78500, cogs_iqd: 47250, gross_profit_iqd: 26250, promotion_iqd: 1470, profit_basis_iqd: 31250,
        finance_state: 'waiting', wait_reason: 'investor_waits', investor_iqd: null, ...waitingNet, delivered_at: at('2026-10-03') }),
      invented('ORD-T-CONF', { retained_revenue_iqd: 62500, net_goods_iqd: 62500, shipping_income_iqd: 6000, revenue_iqd: 68500, cogs_iqd: 40500, gross_profit_iqd: 22000, promotion_iqd: 1250,
        profit_basis_iqd: 28000, owner_net_iqd: 26750, net_after_report_adjustments_iqd: 26750, delivered_at: at('2026-10-05') })],
    chart_data: { daily: [estimate ? day('2026-10-03', 2, 133500, 79720, null, null) : day('2026-10-03', 1, 78500, 48720, null, null), day('2026-10-04', 0, 0, 0, 0, 0),
      day('2026-10-05', 1, 68500, 41750, 0, 26750), day('2026-10-06', 0, 0, 0, 0, 0)] } } as unknown as FinanceSummary;
};
const cellsOf = (html: string, attr: string, id: string) => [...rowOf(html, attr, id).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]);
const columnOf = (html: string, name: string) => [...(/<thead>([\s\S]*?)<\/thead>/.exec(html)![1]).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/[▲▼]/g, '')).indexOf(name);
const footCells = (html: string) => [...footOf(html).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

test('a waiting row whose known goods cost rests on a sale-time estimate says «تقديري» beside that cost — Orders, Products, Sections, and a product on a phone — and every goods-cost total counts the rows on one (third review, money)', () => {
  const p = inventedPeriod();
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const i = lang === 'ar' ? 0 : lang === 'en' ? 1 : 2, chip = `<span class="fw-status fw-status--warning">${FW.estimatedChip[i]}</span>`;
    const count = (n: number) => `<span class="fw-status fw-status--warning">${FW.estimatedN[i].replace('{n}', String(n))}</span>`;
    const orders = render(createElement(OrdersReport, { data: p, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), lang);
    const cogs = columnOf(orders, FW.cogs[i]);
    assert.ok(cogs > 0, `${lang}: the goods cost column`);
    // The waiting order's cost on the estimate is named; the «تقديري» order's chip says it already; a confirmed cost says nothing.
    assert.ok(cellsOf(orders, 'data-finance-order', 'ORD-T-WAGE')[cogs].includes(chip), `${lang}: a wage waits — its cost on the estimate says so`);
    for (const id of ['ORD-T-CONF', 'ORD-T-EST', 'ORD-T-INV', 'ORD-T-NONE']) assert.ok(!cellsOf(orders, 'data-finance-order', id)[cogs].includes(FW.estimatedChip[i]), `${lang}: ${id} has no «تقديري» in its goods cost`);
    assert.ok(footCells(orders)[cogs].includes(count(2)), `${lang}: the goods-cost total holds two estimates (the «تقديري» order's and the waiting one's)`);
    for (const level of ['product', 'main'] as const) {
      const html = render(createElement(GroupsReport, { data: p, level, onLevel: level === 'main' ? noop : undefined, onOpenOrders: noop, onMissing: noop }), lang);
      const c = columnOf(html, FW.cogs[i]);
      assert.ok(cellsOf(html, 'data-finance-group', 'wage')[c].includes(chip), `${lang} ${level}: a waiting row on estimated lines names them beside its goods cost`);
      for (const id of ['confirmed', 'estimated', 'investor', 'none']) assert.ok(!cellsOf(html, 'data-finance-group', id)[c].includes(FW.estimatedChip[i]), `${lang} ${level}: ${id}`);
      assert.ok(footCells(html)[c].includes(count(2)), `${lang} ${level}: the goods-cost total`);
    }
    // On a phone a product shows its gross, not its goods cost: the waiting row on an estimate says so beside its status.
    const list = phone(createElement(GroupsReport, { data: p, level: 'product', onOpenOrders: noop, onMissing: noop }), lang);
    assert.ok(rowOf(list, 'data-finance-group', 'wage').includes(chip), `${lang}: on a phone`);
    assert.ok(!rowOf(list, 'data-finance-group', 'investor').includes(FW.estimatedChip[i]), `${lang}: a confirmed cost on a phone says nothing`);
  }
  // The rules on their own.
  assert.deepEqual(p.orders.map((o) => costOnEstimate(o, standingOf(o, p))), [false, true, true, false, false]);
  assert.deepEqual(p.products.map(groupOnEstimate), [false, true, true, false, false]);
  const { cost_confidence: _c, ...older } = p.orders[1];
  assert.equal(costOnEstimate(older as FinanceOrder, { state: 'estimated', reason: null }), true, 'a server without cost_confidence: by its state');
  assert.equal(groupOnEstimate({ ...p.products[1], estimated_lines: undefined }), true, 'a server without estimated_lines: by its state');
});

test('on a phone the Days total names the estimates its known net holds, as the desktop totals row and each row do (third review, nit)', () => {
  const day = (d: string, net: number | null) => ({ day: d, revenue_iqd: 55000, cost_iqd: 31000, investor_iqd: net == null ? null : 0, owner_net_iqd: net, net_after_report_adjustments_iqd: net, deductions_iqd: 0, orders_count: 1, unknown_lines: 0, pending_costs: 0 });
  const at = (d: string) => `${d}T09:00:00Z`;
  const data = { ...inventedPeriod(), orders: [invented('ORD-T-EST', { cost_confidence: 'snapshot', finance_state: 'estimated', delivered_at: at('2026-10-02') }), invented('ORD-T-CONF', { delivered_at: at('2026-10-03') }),
    invented('ORD-T-INV', { finance_state: 'waiting', wait_reason: 'investor_waits', investor_iqd: null, ...waitingNet, delivered_at: at('2026-10-04') })],
  chart_data: { daily: [day('2026-10-02', 21100), day('2026-10-03', 22300), day('2026-10-04', null)] } } as unknown as FinanceSummary;
  // ORD-T-INV's investor share waits on a confirmed goods cost: the month counts the «تقديري» order alone.
  assert.deepEqual(groupDays(data.chart_data!.daily, 'month', data.orders, data).map((m) => [m.waiting, m.investorWaits, m.estimated]), [[1, 1, 1]]);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const i = lang === 'ar' ? 0 : lang === 'en' ? 1 : 2, count = FW.estimatedN[i].replace('{n}', '1'), chips = new RegExp(FW.estimatedN[i].replace('{n}', '\\d+'), 'g');
    const total = /<li class="fw-rows-total">([\s\S]*?)<\/li>/.exec(phone(createElement(DaysReport, { data, onOpenOrders: noop }), lang))![1];
    assert.ok(total.includes('43,400+') && total.includes(FW.waitingN[i].replace('{n}', '1')), `${lang}: the known net and the order it waits for`);
    assert.deepEqual(total.match(chips), [count], `${lang}: «${count}» — the estimate the known net holds`);
    // As the desktop totals row says: the known costs and the known net name one estimate each — never ORD-T-INV's confirmed cost,
    // which its own day (4 October) does not name either.
    const desktop = render(createElement(DaysReport, { data, onOpenOrders: noop }), lang);
    assert.deepEqual(footOf(desktop).match(chips), [count, count], `${lang}: as the desktop totals row says`);
    assert.equal(cellsOf(desktop, 'data-finance-day', '2026-10-04')[3], '<span class="fw-num" dir="ltr">31,000</span>', `${lang}: 4 October's known costs hold no estimate`);
  }
});

test('a count never stands alone on a line: a no-break space holds each count chip\'s number to its word, in every language (third review, nit)', () => {
  // At 1280 beside the sidebar a totals cell wrapped «ينتظر» / «1» (and «Waiting» / «1», «چاوەڕوان» / «1»): a report's chips wrap on
  // their words (a long Sorani chip has to), so the space before a count is one no line may break.
  for (const [name, t] of [['waitingN', FW.waitingN], ['estimatedN', FW.estimatedN], ['missingN', RS.missingN], ['refundN', RS.refundN]] as const) {
    t.forEach((text, i) => assert.match(text, /\S\u00A0\{n\}$/, `${name} (${['ar', 'en', 'ckb'][i]}): «${text}»`));
  }
  const html = render(createElement(OrdersReport, { data: s, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'ckb');
  assert.doesNotMatch(footOf(html), /(چاوەڕوان|ناتەواو|خەمڵێنراو) \d/, 'no breakable space before a count in the totals row');
});

// ------------------------------------------------------------------ the fourth review of step 4
/** The index of the column whose head starts with these words (a head may carry a line under it, as «صافيك» / «قبل المصاريف العامة»). */
const columnStarting = (html: string, words: string) => [...(/<thead>([\s\S]*?)<\/thead>/.exec(html)![1]).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/[▲▼]/g, '')).findIndex((head) => head.startsWith(words));

test('every known total of a goods cost, a gross or a net names the estimates it holds: the products\' and the sections\' gross and net, the list\'s total on a phone, the orders\' net (fourth review, nit)', () => {
  // On the invented period: the gross is known for the confirmed, the estimated, the wage's and the investor's rows — two of them on
  // estimated lines (the estimated one and the wage's); the net for the confirmed and the estimated rows — one on them.
  const p = inventedPeriod();
  for (const [i, lang] of (['ar', 'en', 'ckb'] as const).entries()) {
    const count = (n: number) => `<span class="fw-status fw-status--warning">${FW.estimatedN[i].replace('{n}', String(n))}</span>`;
    for (const level of ['product', 'main'] as const) {
      const html = render(createElement(GroupsReport, { data: p, level, onLevel: level === 'main' ? noop : undefined, onOpenOrders: noop, onMissing: noop }), lang);
      const foot = footCells(html), gross = columnStarting(html, FW.grossProfit[i]), net = columnStarting(html, RS.colNet[i]);
      assert.ok(gross > 0 && net > gross, `${lang} ${level}: the gross and net columns`);
      assert.ok(foot[gross].includes(count(2)), `${lang} ${level}: the gross total names the two rows on an estimate — «${foot[gross]}»`);
      assert.ok(foot[net].includes(count(1)) && !foot[net].includes(count(2)), `${lang} ${level}: the net total names the one whose net is known — «${foot[net]}»`);
    }
    // On a phone the gross is the list's one total, and it names them beside its amount (one group at the line's end).
    const list = phone(createElement(GroupsReport, { data: p, level: 'product', onOpenOrders: noop, onMissing: noop }), lang);
    const total = /<li class="fw-rows-total">([\s\S]*?)<\/li>/.exec(list)![1];
    assert.ok(total.startsWith(`<b>${RS.total[i]}</b><span>`) && total.endsWith(`${count(2)}</span>`), `${lang}: «${total}»`);
    // Reports → Orders: the calculated orders' net names the one of them on an estimate, as its strip does.
    const orders = render(createElement(OrdersReport, { data: p, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), lang);
    const ordersNet = footCells(orders)[columnStarting(orders, RS.colNet[i])];
    assert.ok(ordersNet.includes(count(1)), `${lang}: the orders' net total — «${ordersNet}»`);
  }
  // A total with no estimate in its known rows names none: the confirmed rows alone.
  const confirmed = { ...p, orders: p.orders.slice(0, 1), products: p.products.slice(0, 1), categories: p.categories.slice(0, 1) } as FinanceSummary;
  for (const html of [render(createElement(GroupsReport, { data: confirmed, level: 'product', onOpenOrders: noop, onMissing: noop }), 'en'),
    render(createElement(OrdersReport, { data: confirmed, scope: null, onClearScope: noop, openOrder: noop, onMissing: noop, onCollections: noop }), 'en')]) assert.doesNotMatch(footOf(html), /Estimated/);
});
