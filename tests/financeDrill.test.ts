/**
 * «فتح رقم» — THE FIGURE DRAWER ADDS UP (redesign step 4, owner 2026-11-11; DECISIONS row 316).
 *
 * A figure of the overview, a line of the statement or a cash figure opens on the orders that make it. Here, for a period
 * with a confirmed order, an estimated one and every reason an order can wait for (a purchase price, the cost a wage
 * needs, an investor share's projection, a refund amount, a posting error), with rent this month and last month's
 * promotion that had no sales: for every line of the statement and both of its columns, the drawer's rows — each order's
 * own term, plus the overhead rows no order carries — add up to the statement's cell exactly, in dinars and in the
 * server's cents; where the cell is unknown, so is a row of it. The waiting column lists exactly the orders «waiting»
 * names, each with its reason. The cash figures add up to the cash card. Every formula is written in Arabic, English
 * and real Sorani. Then the drawer as the owner sees it, on an invented 1–11 November (tests/fixtures/financeSampleMonth.ts:
 * every id, time and amount made up — the repository is public).
 *
 * Run: node --import tsx --test tests/financeDrill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { everyState, order, period, usd, world } from './fixtures/financeWorld';
import { baghdadDay } from '../worker/lib/operations';
import { november } from './fixtures/financeSampleMonth';
import { cashCard, drill, drillParts, FORMULA, headline, rowsSum, STATEMENT_FIGURES, type FigureKey } from '../src/components/financeWorkspace/drill';
import { statementRows } from '../src/components/financeWorkspace/statement';
import { overviewNet } from '../src/components/financeWorkspace/overviewFigures';
import { RS } from '../src/components/financeWorkspace/reportStrings';
import { FW } from '../src/components/financeWorkspace/overviewStrings';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import { LanguageProvider } from '../src/LanguageContext';
import type { DisplayUsdSummary, FinanceSummary } from '../src/components/financeWorkspace/types';

let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/, ARABIC_ONLY = /[ةىيك]/;

/** Every statement line, both columns: the rows add up to the cell; an unknown cell has an unknown row. */
function addsUp(s: FinanceSummary, usd: DisplayUsdSummary | undefined, currency: 'IQD' | 'USD') {
  const st = statementRows(s, usd);
  assert.equal(st.currency, currency);
  let known = 0;
  for (const key of STATEMENT_FIGURES) for (const part of [0, 1] as const) {
    const d = drill(s, key, part, usd), cell = st.rows.find((r) => r.key === key)!.cells[part];
    assert.equal(d.currency, currency, key);
    assert.equal(d.total, cell, `${key} [${part}]: the drawer's total is the statement's cell`);
    assert.equal(rowsSum(d.rows), cell, `${key} [${part}] in ${currency}: the rows add up to ${cell}`);
    if (cell !== null) known += 1;
  }
  return known;
}

test('for every line of the statement and both columns, the drawer\'s orders and overhead rows add up to the cell — in dinars and in cents', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}&display=USD`) as FinanceSummary;
  // The world has what the test needs: both columns, both overheads in each, every reason.
  assert.deepEqual([s.known?.orders_count, s.waiting?.orders_count], [2, 5]);
  assert.ok((s.known?.general_share_iqd ?? 0) > 0 && (s.known?.unallocated_share_iqd ?? 0) > 0 && (s.waiting?.general_share_iqd ?? 0) > 0 && (s.waiting?.unallocated_share_iqd ?? 0) > 0);
  assert.deepEqual(Object.keys(s.waiting!.reasons).sort(), ['investor_waits', 'no_price', 'other', 'refund_unknown', 'wage_waits_cost']);
  const knownCells = addsUp(s, undefined, 'IQD');
  assert.ok(knownCells >= 17, `most cells are known (${knownCells}), so the sums prove something`);
  addsUp(s, s.display_usd, 'USD');
  // The overheads are rows of their own: the net's, the promotion's, the general expenses' — in both columns.
  for (const part of [0, 1] as const) {
    const kinds = (key: FigureKey) => drill(s, key, part).rows.filter((r) => r.kind !== 'order').map((r) => [r.kind, r.value]);
    const share = part === 0 ? s.known! : s.waiting!;
    assert.deepEqual(kinds('general'), [['general', share.general_share_iqd]]);
    assert.deepEqual(kinds('promotion'), [['unallocated', share.unallocated_share_iqd]]);
    assert.deepEqual(kinds('net'), [['overhead', -(share.general_share_iqd ?? 0) - (share.unallocated_share_iqd ?? 0)]]);
    assert.equal(drill(s, 'general', part).rows.filter((r) => r.kind === 'order').length, 0, 'no order carries general expenses');
  }
  // The calculated column's net is the overview's «صافي حصتك».
  assert.equal(drill(s, 'net', 0).total, overviewNet(s).net);
});

test('the waiting column lists exactly the orders «waiting» names, each with its reason; the calculated one the confirmed and estimated orders', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`) as FinanceSummary;
  const reasons = Object.fromEntries(Object.entries(s.waiting!.reasons).flatMap(([reason, ids]) => (ids ?? []).map((id) => [id, reason])));
  const waiting = drill(s, 'net', 1).rows.flatMap((r) => (r.kind === 'order' ? [[r.order.id, r.standing.reason]] : []));
  assert.deepEqual(Object.fromEntries(waiting), reasons);
  const calculated = drill(s, 'sales', 0).rows.flatMap((r) => (r.kind === 'order' ? [[r.order.id, r.standing.state]] : []));
  assert.deepEqual(Object.fromEntries(calculated), { fifo: 'confirmed', est: 'estimated' });
  assert.deepEqual(drillParts(s, 'net'), [0, 1], 'both columns while the period is split');
  assert.deepEqual(drillParts(s, 'cashDue'), ['all']);
  // Largest first, an unknown value last.
  const values = drill(s, 'investor', 1).rows.map((r) => r.value);
  assert.deepEqual(values.slice(values.findIndex((v) => v === null)).every((v) => v === null), true, 'the unknown ones last');
});

test('the cash figures open on the orders whose cash is due, and add up to the cash card, in dinars and cents', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}&display=USD`) as FinanceSummary;
  for (const usd of [undefined, s.display_usd]) {
    const card = cashCard(s, usd);
    assert.equal(drill(s, 'cashDue', 'all', usd).total, card.due);
    assert.equal(drill(s, 'cashOpen', 'all', usd).total, card.open);
    assert.equal(rowsSum(drill(s, 'cashOpen', 'all', usd).rows), card.open);
    assert.equal(headline(s, 'cashDue', usd).value, card.due);
  }
  assert.equal(drill(s, 'cashOpen', 'all').rows.length, 7, 'every order still owes its cash');
});

test('every formula is written in Arabic, English and real Sorani', () => {
  const keys: FigureKey[] = [...STATEMENT_FIGURES, 'cashDue', 'cashOpen'];
  for (const key of keys) {
    const [ar, en, ckb] = RS[FORMULA[key]];
    assert.ok(ar && en && ckb, key);
    assert.notEqual(ckb, ar, key); assert.notEqual(ckb, en, key);
    assert.match(ckb, SORANI_ONLY, key); assert.doesNotMatch(ckb, ARABIC_ONLY, key);
  }
});

test('the invented 1–11 November: the net drawer is the overview\'s 796,059 (485,819 confirmed + 310,240 estimated) and every line of the statement adds up', async () => {
  const s = november;
  assert.equal(addsUp(s, undefined, 'IQD') > 0, true);
  const net = drill(s, 'net', 0);
  assert.equal(net.total, 796059);
  assert.equal(net.total, overviewNet(s).net);
  const part = (state: string) => net.rows.reduce((v, r) => v + (r.kind === 'order' && r.standing.state === state ? r.value ?? 0 : 0), 0);
  assert.deepEqual([part('confirmed'), part('estimated')], [485819, 310240]);
  assert.deepEqual(headline(s, 'net'), { value: 796059, orders: 9, all: 13, estimated: 6 }, 'as the card: the calculated orders\' net, on 9 of 13, six of them on estimates');
  assert.deepEqual(headline(s, 'sales'), { value: 5814070, orders: 13, all: 13, estimated: 0 });
  assert.equal(drill(s, 'net', 1).rows.length, 4);
  assert.equal(drill(s, 'promotion', 0).total! + drill(s, 'promotion', 1).total!, 192400, 'the month\'s promotion, all of it');
  // The drawer as the owner sees it: the total and its basis, the formula, the two tabs, each order with its chip; no bare dash.
  const { FigureBody } = await import('../src/components/financeWorkspace/FigureDrawer');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    LANG = lang;
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: 'IQD' },
      createElement(FigureBody, { data: s, figure: 'net', from: '2026-11-01', to: '2026-11-11', onClose: () => {}, openOrder: () => {}, onNavigate: () => {} }))));
    assert.match(html, /data-finance-drawer="net"/, lang);
    assert.match(html, /796,059/, lang);
    assert.match(html, /data-finance-drawer-tab="0"[^>]*>[^<]*\(9\)/, `${lang}: the calculated tab, 9 orders`);
    assert.match(html, /data-finance-drawer-tab="1"[^>]*>[^<]*\(4\)/, `${lang}: the waiting tab, 4 orders`);
    assert.match(html, /view=orders&amp;part=calculated/, `${lang}: its CSV is the column's`);
    assert.doesNotMatch(html, />—</, `${lang}: no bare dash`);
  }
  LANG = 'ar';
});

// ------------------------------------------------------------------ the independent review of step 4
const body = async (s: FinanceSummary, figure: FigureKey, opts: { lang?: 'ar' | 'en' | 'ckb'; currency?: 'IQD' | 'USD' } = {}) => {
  const { FigureBody } = await import('../src/components/financeWorkspace/FigureDrawer');
  LANG = opts.lang ?? 'ar';
  try {
    return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: opts.currency ?? 'IQD' },
      createElement(FigureBody, { data: s, figure, from: s.range?.from ?? '2026-11-01', to: s.range?.to ?? '2026-11-11', onClose: () => {}, openOrder: () => {}, onNavigate: () => {} }))));
  } finally { LANG = 'ar'; }
};

test('a period with rent and no delivered order opens on the period and its overheads — never an empty «تنتظر (0)» under a figure no row makes (review, money lens)', async () => {
  const w = world();
  usd(w.raw);
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${baghdadDay()}','Rent','admin');`);
  const s = await w.read(`/f/summary?${period()}&display=USD`) as FinanceSummary;
  assert.deepEqual([s.orders.length, s.known, s.waiting], [0, null, null]);
  for (const usdBlock of [undefined, s.display_usd]) {
    const st = statementRows(s, usdBlock);
    for (const key of STATEMENT_FIGURES) {
      assert.deepEqual(drillParts(s, key), [2], key);
      const d = drill(s, key, 2, usdBlock), cell = st.rows.find((r) => r.key === key)!.cells[2];
      assert.equal(d.total, cell, `${key}: the period's cell`);
      assert.equal(rowsSum(d.rows), cell, `${key} in ${st.currency}: its rows add up to it`);
    }
  }
  assert.deepEqual(drill(s, 'net', 2).rows.map((r) => [r.kind, r.value]), [['overhead', -10001]]);
  assert.deepEqual(drill(s, 'general', 2).rows.map((r) => [r.kind, r.value]), [['general', 10001]]);
  assert.equal(headline(s, 'net').value, -10001);
  const html = await body(s, 'net', { lang: 'en' });
  assert.match(html, /data-finance-drawer-tab="2"[^>]*>Period \(0\)</, 'the period, not «Waiting (0)»');
  assert.doesNotMatch(html, /Waiting \(0\)|No orders in this column/);
  assert.match(html, /data-finance-drill-row="overhead"/);
  assert.match(html, /view=orders&amp;part=period/, 'its file is the period\'s overheads');
});

test('a long period: the drawer draws its first 300 orders and «عرض الكل», its total and overhead rows still over every order (review, screens)', async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ ...november.orders[i % november.orders.length], id: `ORD-${String(i).padStart(4, '0')}`, order_id: `ORD-${String(i).padStart(4, '0')}` }));
  const big = { ...november, orders: many } as FinanceSummary;
  const html = await body(big, 'cashOpen', { lang: 'en' });
  assert.equal((html.match(/data-finance-drill-row="ORD-/g) ?? []).length, 300);
  assert.match(html, /data-finance-drill-more[^>]*>Show all \(\d+\)</);
  const open = drill(big, 'cashOpen', 'all');
  assert.ok(open.rows.length > 300);
  // 450 rows cycle the 13 orders: the prepaid one (no cash due) comes 34 times, so 416 rows owe cash, 160,160,950 of it.
  assert.deepEqual([open.rows.length, open.total], [416, 160160950]);
  assert.match(html, /data-finance-drill-more[^>]*>Show all \(416\)</);
  assert.ok(html.includes('>160,160,950</span></b></span></li>'), 'the total of every order, not of the 300 drawn');
  // The overheads stay in sight under a cut list: the calculated orders' net with a share of general expenses, past the 300 drawn.
  const withRent = { ...big, known: { ...big.known!, general_share_iqd: 5000 } } as FinanceSummary;
  const net = await body(withRent, 'net');
  assert.ok(drill(withRent, 'net', 0).rows.filter((r) => r.kind === 'order').length > 300);
  assert.match(net, /data-finance-drill-more[\s\S]*data-finance-drill-row="overhead"[\s\S]*data-finance-drill-total/, 'the overhead row after «عرض الكل», before the total');
  assert.doesNotMatch(await body(november, 'net'), /data-finance-drill-more/, '13 orders: no button');
});

test('the drawer says its formula once, its currency, and what a cash figure stands on (review, screens and safety)', async () => {
  const s = november;
  const net = await body(s, 'net');
  assert.match(net, /data-finance-formula="true">صافي حصتك = /, 'a formula that names its figure has no «=» before it');
  assert.doesNotMatch(net, /<b aria-hidden="true">=<\/b> صافي حصتك/);
  assert.match(await body(s, 'delivery'), /data-finance-formula="true"><b aria-hidden="true">=<\/b> ما دفعه الزبائن للتوصيل/, 'a definition keeps it');
  assert.match(net, /data-finance-drawer-currency="true">المبالغ بالدينار</);
  // Under «دولار» with no rate the amounts stay dinars, and the drawer says both.
  const noRate = await body({ ...s, display_usd: { available: false } } as FinanceSummary, 'net', { currency: 'USD', lang: 'en' });
  assert.match(noRate, /data-finance-drawer-currency="true">Amounts in IQD</);
  assert.match(noRate, /data-finance-usd-note="none"/);
  // The cash figure stands on the 12 orders with cash due, as listed — not «every order of the period: 13» above 12 rows.
  const cash = await body(s, 'cashOpen');
  assert.match(cash, /طلبات لم يُسجَّل نقدها كله: 12/);
  assert.doesNotMatch(cash, /كل طلبات الفترة: 13/);
  assert.equal((cash.match(/data-finance-drill-row="ORD-/g) ?? []).length, 12);
  assert.match(cash, /view=orders&amp;cash=open/, 'its file is those orders');
  assert.match(await body(s, 'cashDue'), /view=orders&amp;cash=due/);
});

// ------------------------------------------------------------------ the fourth review of step 4
/**
 * An invented period, read from the server (the fourth review): «conf» confirmed on a FIFO lot; «est» on its sale-time estimate (the
 * «تقديري» state); «wage» waiting for a profit-based wage while its goods cost is the sale-time estimate; «inv» waiting for an investor
 * share's projection on a confirmed cost. Every goods cost is known, so each column of the statement has one. `waitingOnly`: the two
 * waiting orders alone, so the drawer opens on «تنتظر». The shop's dollar rate is set, so the drawer is drawn in cents too.
 */
function estimatesWorld(waitingOnly = false) {
  const w = world();
  usd(w.raw);
  w.raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('funded','Funded','fig-funded',25000,0,999),('wage','Wage','fig-wage',25000,0,999);`);
  if (!waitingOnly) {
    order(w.raw, { id: 'conf' });
    order(w.raw, { id: 'est', qty: 1, unit: 20000, cost: null, estimate: 15000, product: 'esun' });
  }
  order(w.raw, { id: 'wage', qty: 1, unit: 20000, cost: null, estimate: 15000, product: 'wage' });
  order(w.raw, { id: 'inv', product: 'funded' });
  w.raw.exec(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot) VALUES
      ('c1','wage',NULL,'r1',1,'Packing wage','g1','staff_sajjad','rent','delivered',1,NULL,'${baghdadDay()}','pending_cost','{}');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('batch','funded','base','',4,4,10000);
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json,state) VALUES ('contract','batch','buyer','Funding',40000,10000,1000,1000,'admin','now','{}','active');
    UPDATE inventory_lots SET incoming_id='batch' WHERE id='inv:lot';`);
  return w;
}
const drillRow = (html: string, id: string) => new RegExp(`<li data-finance-drill-row="${id}">([\\s\\S]*?)</li>`).exec(html)?.[1] ?? '';
const drillTotal = (html: string) => /data-finance-drill-total="true">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
const drillHead = (html: string) => /<div class="fw-drawer-total">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';

test('a known goods cost on a sale-time estimate is named in the drawer and in the statement: a waiting row\'s «تقديري», «تقديري n» beside the total and the headline, and in the heads of «تنتظر» and «الفترة» (fourth review, money)', async () => {
  const w = estimatesWorld();
  const s = await w.read(`/f/summary?${period()}&display=USD`) as FinanceSummary;
  // The server: two calculated orders, one of them on the estimate; two waiting, each with its goods cost known — the wage's on the estimate.
  assert.deepEqual(Object.fromEntries(s.orders.map((o) => [o.id, [o.finance_state, o.wait_reason, o.cost_confidence, o.cogs_iqd !== null]])),
    { conf: ['confirmed', null, 'verified', true], est: ['estimated', null, 'snapshot', true], wage: ['waiting', 'wage_waits_cost', 'snapshot', true], inv: ['waiting', 'investor_waits', 'verified', true] });
  assert.ok(statementRows(s).rows.find((r) => r.key === 'cogs')!.cells.every((v) => v !== null), 'every column of the statement knows its goods cost');
  const chip = (i: number) => `<span class="fw-status fw-status--warning">${FW.estimatedChip[i]}</span>`;
  const count = (i: number, n: number) => `<span class="fw-status fw-status--warning">${FW.estimatedN[i].replace('{n}', String(n))}</span>`;
  const LANGS = ['ar', 'en', 'ckb'] as const;

  // The statement: each column's head names the orders its known figures rest on an estimate for — «تنتظر» the wage, «الفترة» both.
  const { Statement } = await import('../src/components/financeWorkspace/Overview');
  const heads = (data: FinanceSummary, lang: 'ar' | 'en' | 'ckb', currency: 'IQD' | 'USD') => {
    LANG = lang;
    try {
      const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: currency },
        createElement(Statement, { data, usd: currency === 'USD' ? data.display_usd : undefined }))));
      return [...html.matchAll(/<th scope="col" data-col="(\d)">([^<]*)</g)].map((m) => m[2]);
    } finally { LANG = 'ar'; }
  };
  assert.deepEqual(heads(s, 'ar', 'IQD'), ['محسوبة (2 · تقديرية: 1)', 'تنتظر (2 · تقديرية: 1)', 'الفترة (4 · تقديرية: 2)']);
  assert.deepEqual(heads(s, 'en', 'USD'), ['Calculated (2 · estimated: 1)', 'Waiting (2 · estimated: 1)', 'Period (4 · estimated: 2)'], 'in dollars the same orders');
  assert.deepEqual(heads(s, 'ckb', 'IQD'), ['ژمێردراو (2 · خەمڵێنراو: 1)', 'چاوەڕوان (2 · خەمڵێنراو: 1)', 'کۆی ماوە (4 · خەمڵێنراو: 2)']);

  // The drawer of «تكلفة البضاعة» opens on «محسوبة»: the «تقديري» order says it in its own chip; the total counts it; the headline —
  // the period's goods cost, every column known — counts both.
  for (const [i, lang] of LANGS.entries()) {
    const html = await body(s, 'cogs', { lang });
    assert.match(html, /data-finance-drawer-part="0"/);
    assert.ok(drillTotal(html).includes(count(i, 1)), `${lang}: the calculated goods cost holds one estimate`);
    assert.ok(drillHead(html).includes(count(i, 2)), `${lang}: the headline, the period's goods cost, holds two`);
    assert.ok(!drillRow(html, 'est').includes(chip(i)) && drillRow(html, 'est').includes(RS.stEstimated[i]), `${lang}: the «تقديري» order says it in its status, once`);
    assert.ok(!drillRow(html, 'conf').includes(FW.estimatedChip[i]), `${lang}: a confirmed cost says nothing`);
  }
  // Its net too: the calculated orders' net rests on the one estimate (the headline is that net while orders wait).
  const net = await body(s, 'net', { lang: 'en' });
  assert.ok(drillTotal(net).includes(count(1, 1)) && drillHead(net).includes(count(1, 1)), 'the net\'s total and headline');
  // A figure no estimate reaches names none.
  for (const figure of ['sales', 'delivery', 'promotion', 'investor', 'cashOpen'] as const) assert.doesNotMatch(await body(s, figure, { lang: 'en' }), /Estimated\u00A0\d|>Estimated</, figure);

  // The two waiting orders alone: the drawer opens on «تنتظر». The wage's goods cost — and the gross on it — is the estimate and says so
  // beside its value (its chip names the wage it waits for); the investor's confirmed cost says nothing; the total and the headline count one.
  const only = await estimatesWorld(true).read(`/f/summary?${period()}&display=USD`) as FinanceSummary;
  assert.deepEqual([only.known, only.waiting?.orders_count], [null, 2]);
  for (const [i, lang] of LANGS.entries()) for (const [figure, currency] of [['cogs', 'IQD'], ['gross', 'IQD'], ['cogs', 'USD'], ['gross', 'USD']] as const) {
    const html = await body(only, figure, { lang, currency }), at = `${lang} ${figure} ${currency}`;
    assert.match(html, /data-finance-drawer-part="1"/, at);
    assert.ok(drillRow(html, 'wage').includes(RS.stWage[i]) && drillRow(html, 'wage').includes(chip(i)), `${at}: the wage's known value is the estimate, named`);
    assert.ok(!drillRow(html, 'inv').includes(FW.estimatedChip[i]), `${at}: a confirmed cost says nothing`);
    assert.ok(drillTotal(html).includes(count(i, 1)) && drillHead(html).includes(count(i, 1)), `${at}: the total and the headline count it`);
  }
  assert.deepEqual(heads(only, 'ar', 'IQD'), ['الفترة (2 · تقديرية: 1)'], 'the period alone, all of it waiting: its known goods cost holds the wage\'s estimate');

  // A waiting order with no purchase price leaves the waiting column's goods cost — and the period's — unknown: no known figure of theirs
  // holds an estimate, so their heads name none (the «محسوبة» head still names its own).
  order(w.raw, { id: 'mag', qty: 60, unit: 500, cost: null, product: 'magnet', shipping: 0 });
  const gap = await w.read(`/f/summary?${period()}`) as FinanceSummary;
  assert.deepEqual(heads(gap, 'ar', 'IQD'), ['محسوبة (2 · تقديرية: 1)', 'تنتظر (3)', 'الفترة (5)']);

  // The rules on their own (drill.ts).
  const { columnEstimates, rowOnEstimate } = await import('../src/components/financeWorkspace/drill');
  assert.deepEqual([columnEstimates(s), columnEstimates(s, s.display_usd), columnEstimates(only), columnEstimates(gap)], [[1, 1, 2], [1, 1, 2], [0, 1, 1], [1, 0, 0]]);
  const estimated = (key: FigureKey, part: 0 | 1) => drill(s, key, part).rows.filter((r) => rowOnEstimate(key, r)).map((r) => (r.kind === 'order' ? r.order.id : r.kind));
  assert.deepEqual([estimated('cogs', 0), estimated('cogs', 1), estimated('gross', 1), estimated('net', 0), estimated('net', 1), estimated('sales', 1), estimated('investor', 0)],
    [['est'], ['wage'], ['wage'], ['est'], [], [], []]);
  assert.deepEqual([drill(s, 'cogs', 1).estimated, drill(s, 'cogs', 1, s.display_usd).estimated, headline(s, 'cogs').estimated, headline(s, 'net').estimated, headline(s, 'sales').estimated], [1, 1, 2, 1, 0]);
});
