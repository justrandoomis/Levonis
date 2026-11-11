/**
 * «المال والأرباح» → التكاليف — THE SERVER'S HALF (redesign step 5, owner 2026-11-11; DECISIONS row 317).
 *
 * GET /expenses names where every expense of the period counts, from the one fragment /summary reads too
 * (worker/lib/financeExpenseKinds.ts): here a plain general expense, the month's promotion, an order's wage, a courier's
 * fee, costs linked to a delivered order, to one on its way and to one that ended without a delivery, a row tagged only to
 * a cost centre and a voided row. On the same ranges its general total is /summary's «المصاريف العامة» and its waiting
 * total /summary's costs waiting for their orders, for every world; its categories add up to its general total; the door
 * is the owner's and a period is at most a year. The file view adds up the same way.
 *
 * GET /promotions says who carries the month's promotion: each product's share of it, read off the very line shares the
 * orders carry, adding up to the month exactly and in proportion to net sales; a bundle's parent is never counted beside
 * its parts and a drawn spool sits under its offer; a month without sales has no product and keeps the whole amount
 * unallocated; the history lists each edit newest first, with who made it; the month is a month.
 *
 * Every figure here is invented (DECISIONS row 316: no live order, day or amount in the repository).
 * Run: node --import tsx --test tests/financeCostsServer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, patch, post, send, stubApp } from './fixtures/app';
import { everyState, month, order, period, previousMonth, world } from './fixtures/financeWorld';
import { expenseWorld } from './fixtures/financeCosts';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { EXPENSE_KINDS, GENERAL_KINDS } from '../worker/lib/financeExpenseKinds';
import { baghdadDay } from '../worker/lib/operations';

type W = ReturnType<typeof world>;
type Entry = { id: string; kind: string; counts_as_general: boolean; amount_iqd: number; category_id: string; category: { name_ar: string; name_en: string; name_ckb: string };
  order_id: string | null; promotion_month: string | null; center_id: string | null; center_name: string | null; voided: boolean };
type Totals = { general_iqd: number; waiting_iqd: number; all_iqd: number; entries: number; by_kind: Record<string, { amount_iqd: number; entries: number }>;
  by_category: Array<{ category_id: string; name_ar: string; name_en: string; name_ckb: string; amount_iqd: number; entries: number }> };

const read = async (w: W, path: string) => (await w.read(path)) as { rows: Entry[]; totals: Totals; truncated: boolean; range: { from: string; to: string } };
/** On one range: the page's totals are /summary's, and its categories add up to its general total. */
async function agrees(w: W, range: string) {
  const e = await read(w, `/f/expenses?${range}`), s = await w.read(`/f/summary?${range}`);
  assert.equal(e.totals.general_iqd, s.totals.general_expenses_iqd, `${range}: the page's general total is the statement's`);
  assert.equal(e.totals.waiting_iqd, s.totals.general_waiting_iqd, `${range}: the costs waiting for their orders are the statement's`);
  assert.equal(e.totals.by_category.reduce((v, c) => v + c.amount_iqd, 0), e.totals.general_iqd, `${range}: the categories add up to the general total`);
  assert.equal(Object.values(e.totals.by_kind).reduce((v, k) => v + k.amount_iqd, 0), e.totals.all_iqd);
  assert.equal(GENERAL_KINDS.reduce((v, k) => v + e.totals.by_kind[k].amount_iqd, 0), e.totals.general_iqd);
  // The rows (when the period has fewer than the page's limit) are the sums, kind by kind.
  if (!e.truncated) for (const kind of EXPENSE_KINDS) assert.equal(e.rows.filter((r) => r.kind === kind && !r.voided).reduce((v, r) => v + r.amount_iqd, 0), e.totals.by_kind[kind].amount_iqd, `${range}: ${kind}`);
  return e;
}

test('GET /expenses names where every expense counts, and its general total is the statement\'s «المصاريف العامة»', async () => {
  const w = expenseWorld();
  const e = await agrees(w, period());
  const kind = Object.fromEntries(e.rows.map((r) => [r.id, r.kind]));
  assert.deepEqual(kind, { rent: 'general', power: 'general', centre: 'general', 'promo-exp': 'promotion', 'wage-exp': 'order_cost', 'fee-exp': 'collection_fee',
    'to-shipped': 'order_delivered', 'to-onway': 'order_waiting', 'to-gone': 'order_ended' }, 'every kind once; the voided row is not there');
  // The rent, the power bill, the generator tagged to a cost centre and the cost of the cancelled order: 157,000.
  assert.equal(e.totals.general_iqd, 157000);
  assert.equal(e.totals.waiting_iqd, 9000, 'the order still on its way');
  assert.equal(e.totals.all_iqd, 157000 + 240000 + 7500 + 3000 + 2000 + 9000, 'every live entry — the ledger\'s total — is more than the general figure, and the page says why');
  assert.deepEqual(e.totals.by_category.map((c) => [c.category_id, c.amount_iqd, c.entries]), [['rent', 120000, 2], ['power', 37000, 2]]);
  assert.deepEqual(e.totals.by_category.find((c) => c.category_id === 'power'), { category_id: 'power', name_ar: 'كهرباء', name_en: 'Power', name_ckb: 'کارەبا', amount_iqd: 37000, entries: 2 }, 'names in three languages');
  const row = (id: string) => e.rows.find((r) => r.id === id)!;
  assert.deepEqual([row('centre').center_id, row('centre').center_name, row('centre').counts_as_general], ['shop', 'Shop floor', true], 'the cost-centre tag is shown; the rule is unchanged');
  assert.deepEqual([row('to-gone').order_id, row('to-gone').counts_as_general], ['gone', true]);
  assert.deepEqual([row('wage-exp').order_id, row('fee-exp').order_id, row('to-onway').order_id], ['shipped', 'shipped', 'onway'], 'each names the order it counts with');
  assert.equal(row('promo-exp').promotion_month, month());
  for (const r of e.rows) assert.equal(r.counts_as_general, GENERAL_KINDS.includes(r.kind as never), r.id);
  // A voided row only when asked for, flagged, and in no sum.
  const all = await read(w, `/f/expenses?${period()}&include_voided=1`);
  assert.deepEqual(all.rows.filter((r) => r.voided).map((r) => r.id), ['void']);
  assert.deepEqual(all.totals, e.totals, 'showing the voided row changes no figure');
});

test('the general total is /summary\'s for every world and range: a day, the month, the month before, a world with none, the reports\' every-state world', async () => {
  const w = expenseWorld(), day = baghdadDay(), prev = previousMonth();
  for (const range of [period(), `from=${day}&to=${day}`, `from=${prev}-01&to=${prev}-28`, `from=${month()}-01&to=${month()}-01`]) await agrees(w, range);
  const empty = world();
  const none = await agrees(empty, period());
  assert.deepEqual([none.rows.length, none.totals.general_iqd, none.totals.by_category.length], [0, 0, 0]);
  const every = everyState();
  const e = await agrees(every, every.range);
  assert.equal(e.totals.general_iqd, 10001, 'the every-state world\'s rent');
  assert.equal(e.totals.by_kind.promotion.amount_iqd, 30000, 'last month\'s promotion is no general expense');
});

test('GET /expenses is the owner\'s, for at most a year, and its file adds up to the same general total', async () => {
  const w = expenseWorld();
  const assistant = stubApp(w.db, { id: 'assistant', email: 'helper@x.co', role: 'admin', admin_scope: 'assistant' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  assert.equal((await get(assistant, `/f/expenses?${period()}`)).status, 403);
  assert.equal((await get(assistant, `/f/export.csv?${period()}&view=expenses`)).status, 403);
  assert.equal((await get(w.app, '/f/expenses?from=2025-01-01&to=2026-06-01')).status, 400, 'over 365 days');
  assert.equal((await get(w.app, '/f/expenses?from=2026-11-10&to=2026-11-01')).status, 400, 'reversed');
  // The file: every live entry, numbers as numbers, the general rows summing to the statement's line.
  const text = await w.text(`/f/export.csv?${period()}&view=expenses`);
  assert.ok(text.startsWith('\uFEFF'), 'the BOM a spreadsheet reads Arabic by');
  // A quoted cell may hold a comma («Generator, shop floor»): read the cells as a spreadsheet does.
  const split = (line: string) => {
    const out: string[] = [];
    let cell = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) { if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
      else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cell); cell = ''; }
      else cell += c;
    }
    return [...out, cell];
  };
  const [head, ...lines] = text.replace(/^\uFEFF/, '').split('\r\n');
  const cols = split(head);
  assert.deepEqual(cols, ['expense_day', 'kind', 'counts_as_general', 'category_name_ar', 'category_name_en', 'category_name_ckb', 'title', 'amount_iqd', 'center_name', 'order_id', 'promotion_month', 'expense_id']);
  const cells = lines.map(split);
  assert.ok(cells.every((c) => c.length === cols.length), 'every row has every column');
  assert.ok(cells.some((c) => c[cols.indexOf('title')] === 'Generator, shop floor'), 'a comma stays inside its cell');
  assert.equal(cells.length, 9, 'nine live entries; the voided one is not in the file');
  const at = (name: string) => cols.indexOf(name);
  assert.equal(cells.filter((c) => c[at('counts_as_general')] === '1').reduce((v, c) => v + Number(c[at('amount_iqd')]), 0), 157000);
  assert.equal((await get(w.app, `/f/export.csv?${period()}&view=expenses&q=rent`)).status, 400, 'the file reads no filter');
});

/** A month's promotion over invented sales: a printer, a bag of switches, and the shares. */
async function promotionWorld() {
  const w = world();
  order(w.raw, { id: 'printer', qty: 1, unit: 1000000, cost: 800000, shipping: 0 });
  order(w.raw, { id: 'switches', qty: 100, unit: 100, cost: 50, product: 'switch', shipping: 0 });
  const made = await post(w.app, '/f/promotions', { month: month(), currency: 'IQD', amount: 10100 });
  assert.equal(made.status, 200, JSON.stringify(await json(made.clone())));
  return { ...w, id: (await json(made)).id as string };
}
type Promotions = { total_iqd: number; unallocated_iqd: number; sales_iqd: number; lines_count: number; products: Array<{ product_id: string | null; name: string; qty: number; sales_iqd: number; promotion_iqd: number }>;
  history: Array<{ version: number; actor_id: string; actor_name: string | null; at: string; before: null | { amount: number; currency: string; amount_iqd: number; enabled: boolean }; after: null | { amount: number; currency: string; amount_iqd: number; enabled: boolean; exchange_rate: number } }> };

test('GET /promotions says who carries the month: each product\'s share by net sales, adding up to the month exactly', async () => {
  const w = await promotionWorld();
  const p = await w.read(`/f/promotions?month=${month()}`) as Promotions;
  assert.equal(p.total_iqd, 10100);
  assert.deepEqual(p.products, [
    { product_id: 'product', name: 'product', qty: 1, sales_iqd: 1000000, promotion_iqd: 10000 },
    { product_id: 'switch', name: 'switch', qty: 100, sales_iqd: 10000, promotion_iqd: 100 },
  ], 'by sales value: the printer\'s 1,000,000 of 1,010,000 carries 10,000; a hundred switches carry 100, not 100 of 101 pieces');
  assert.deepEqual([p.sales_iqd, p.lines_count, p.unallocated_iqd], [1010000, 2, 0]);
  // The products are the orders' own shares, grouped: /summary's products carry the same.
  const s = await w.read(`/f/summary?${period()}`);
  for (const row of p.products) assert.equal(s.products.find((x: { id: string }) => x.id === row.product_id).promotion_iqd, row.promotion_iqd, row.name);
  // A split that does not divide: three equal sales and 100 dinars — still exact, and the shares differ by one at most.
  w.raw.exec("UPDATE finance_monthly_promotions SET amount_iqd=100");
  order(w.raw, { id: 'esun', qty: 1, unit: 1000000, cost: 1, product: 'esun', shipping: 0 });
  order(w.raw, { id: 'magnet', qty: 1, unit: 1010000, cost: 1, product: 'magnet', shipping: 0 });
  const odd = await w.read(`/f/promotions?month=${month()}`) as Promotions;
  assert.equal(odd.products.reduce((v, r) => v + r.promotion_iqd, 0), odd.total_iqd, 'the rows total the month\'s amount exactly');
  for (const r of odd.products) assert.ok(Math.abs(r.promotion_iqd - odd.total_iqd * r.sales_iqd / odd.sales_iqd) < 1, `${r.name}: in proportion to its sales`);
});

test('a bundle\'s parent is never counted beside its parts, and a drawn spool sits under its offer', async () => {
  const w = world();
  const at = new Date().toISOString();
  w.raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('kit','Kit','fig-kit',30000,0,NULL),('box','Box','fig-box',20000,0,NULL);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,cod_tax_iqd,points_discount_iqd,order_kind,created_at,delivered_at)
      VALUES ('bundle','buyer','delivered','{}','standard','{}','cash',50000,1400,50000,50000,0,0,0,'normal','${at}','${at}');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,bundle_parent_item_id,component_alloc_iqd) VALUES
      ('kit:line','bundle','kit','Kit','SKU',1,30000,30000,NULL,'unpriced',NULL,NULL),
      ('kit:a','bundle','product','Printer part','SKU',1,0,0,NULL,'unpriced','kit:line',20000),
      ('kit:b','bundle','esun','Filament part','SKU',1,0,0,NULL,'unpriced','kit:line',10000),
      ('box:line','bundle','box','Mystery box','SKU',1,20000,20000,NULL,'unpriced',NULL,NULL),
      ('box:spool','bundle',NULL,'Mystery box','SKU',1,0,0,NULL,'unpriced','box:line',20000);`);
  assert.equal((await post(w.app, '/f/promotions', { month: month(), currency: 'IQD', amount: 5000 })).status, 200);
  const p = await w.read(`/f/promotions?month=${month()}`) as Promotions;
  assert.deepEqual(p.products.map((r) => [r.product_id, r.name, r.sales_iqd, r.promotion_iqd]).sort(), [['box', 'Mystery box', 20000, 2000], ['esun', 'Filament part', 10000, 1000], ['product', 'Printer part', 20000, 2000]],
    'the kit\'s parts, never the kit beside them; the spool under the box it came from');
  assert.equal(p.sales_iqd, 50000, 'the order\'s 50,000 once, not 100,000');
  assert.equal(p.products.reduce((v, r) => v + r.promotion_iqd, 0), 5000);
});

test('a month without sales has no product to carry its promotion: the whole amount waits, counted on its 1st', async () => {
  const w = world();
  const prev = previousMonth();
  assert.equal((await post(w.app, '/f/promotions', { month: prev, currency: 'IQD', amount: 30000 })).status, 200);
  const p = await w.read(`/f/promotions?month=${prev}`) as Promotions;
  assert.deepEqual([p.products, p.total_iqd, p.unallocated_iqd, p.sales_iqd, p.lines_count], [[], 30000, 30000, 0, 0]);
  const s = await w.read(`/f/summary?from=${prev}-01&to=${prev}-01`);
  assert.equal(s.totals.unallocated_promotion_iqd, 30000, 'the period holding its 1st carries it (owner default 5.7.4, unchanged)');
});

test('the history lists every edit of the month newest first, with who made it and the amount before and after; the month is a month', async () => {
  const w = await promotionWorld();
  assert.equal((await patch(w.app, `/f/promotions/${w.id}`, { amount: 12000 })).status, 200);
  assert.equal((await send(w.app, 'DELETE', `/f/promotions/${w.id}`)).status, 200);
  const p = await w.read(`/f/promotions?month=${month()}`) as Promotions;
  assert.deepEqual(p.history.map((h) => [h.version, h.actor_id, h.actor_name, h.before?.amount_iqd ?? null, h.after?.amount_iqd ?? null, h.after?.enabled ?? null]), [
    [3, 'admin', 'Owner', 12000, 12000, false],
    [2, 'admin', 'Owner', 10100, 12000, true],
    [1, 'admin', 'Owner', null, 10100, true],
  ]);
  assert.ok(p.history.every((h) => /^\d{4}-\d{2}-\d{2}T/.test(h.at)), 'each with its time');
  assert.deepEqual(p.history[2].after, { currency: 'IQD', amount: 10100, exchange_rate: 1, amount_iqd: 10100, enabled: true });
  // Another month's history is not this one's.
  assert.deepEqual((await w.read(`/f/promotions?month=${previousMonth()}`) as Promotions).history, []);
  for (const bad of ['2026-13', '2026-1', 'abc', '2026-11-01']) assert.equal((await get(w.app, `/f/promotions?month=${bad}`)).status, 400, bad);
});
