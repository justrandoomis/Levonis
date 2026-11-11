/**
 * THE ORDER SHEET OF AN ORDER CANCELLED AFTER DELIVERY SAYS ITS SALE WAS REVERSED LIKE A RETURN (owner 2026-11-11, ruling 6.7.2;
 * DECISIONS row 318, its second part).
 *
 * The journal reverses such a sale (tests/cancelledAfterDeliveryLedger.test.ts), and every period, file and drawer drops the order.
 * Until now its sheet (GET /finance-workspace/orders/:id) still read as a delivered sale: its net goods kept, its goods cost
 * spent, its delivery earned and an owner net of the whole margin. Now it reads as the journal has it — each line's net goods
 * refunded, its goods cost back in stock, its delivery and cash-on-delivery fee taken back, no investor share and no promotion —
 * so what it leaves the owner is minus the costs that stay on it, and the cash collected on it is to give back. `sale_reversal`
 * says what the journal did: the reversal's entries and day, or `pending` until the minute scan posts it, or neither when nothing
 * of it was ever booked; the sheet says so in Arabic, English and Sorani. Orders are placed, delivered and cancelled through the
 * real doors; invented data only.
 *
 * Run: node --import tsx --test tests/cancelledAfterDeliverySheet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, asD1, get, json, post, row, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { appsFor, giftWorld, paidLine, patch, placeOrder } from './fixtures/giftWorld';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { refreshProfit, reverseLikeAReturn, type OrderProfitBase, type ProfitLine } from '../worker/lib/orderProfit';
import { iqdToCents } from '../worker/lib/financeUsdDisplay';
import { baghdadDay } from '../worker/lib/operations';
import { SALE_REVERSAL_NOTES, saleReversalNote, saleReversalText } from '../src/components/financeWorkspace/orderFinancePresentation';
import type { OrderProfit, SaleReversal } from '../src/components/financeWorkspace/types';
import type { Env } from '../worker/lib/types';

type Row = Record<string, unknown>;

// ------------------------------------------------------------------ the pure helper

/** A line as getOrderProfitBases builds it, with its investor share, promotion and report deductions added. */
function line(over: Partial<ProfitLine> & Row = {}): ProfitLine {
  return { id: 'line-a', order_item_id: 'line-a', product_id: 'p_plain', name_snapshot: 'Nozzle cleaner', sku_snapshot: '', qty: 2, returned_qty: 0,
    original_net_goods_iqd: 15000, net_goods_iqd: 15000, price_adjustment_iqd: 0, refund_iqd: 0, retained_revenue_iqd: 0, fifo_cogs_iqd: 6000,
    restored_cogs_iqd: 0, cogs_iqd: 6000, cost_confidence: 'fifo', shipping_income_iqd: 3000, cod_tax_iqd: 1000, courier_fee_iqd: 500,
    payment_fee_iqd: 200, direct_cost_iqd: 1400, wages_iqd: 1000, materials_iqd: 400, manual_direct_iqd: 300, pending_costs: 0,
    gross_profit_iqd: null, contribution_profit_iqd: null, profit_basis_iqd: null, main_catalog_id: '', sub_catalog_id: '', main_name: '', sub_name: '',
    allocations: [], investor_iqd: 2000, promotion_iqd: 700, coupon_iqd: 900, price_protection_iqd: 250, trade_in_credit_returned_iqd: 100, ...over } as ProfitLine;
}
/** An order of those lines, its figures worked out as the sheet's read does before the reversal. */
function base(lines: ProfitLine[], totals: Row = {}): OrderProfitBase {
  const b = refreshProfit({ order_id: 'order-t', version: 2, order: { status: 'cancelled', delivered_at: '2026-11-02T09:00:00.000Z' }, lines, costs: [], warnings: [],
    totals: { collected_iqd: 20000, collection_difference_iqd: 0, ...totals } as unknown as OrderProfitBase['totals'] });
  for (const l of b.lines) { l.owner_net_iqd = l.profit_basis_iqd === null ? null : l.profit_basis_iqd - 2700; l.net_after_report_adjustments_iqd = l.owner_net_iqd === null ? null : Number(l.owner_net_iqd) - 1250; }
  Object.assign(b.totals, { investor_iqd: 2000 * lines.length, promotion_iqd: 700 * lines.length, owner_net_iqd: 1, coupon_iqd: 900, price_protection_iqd: 250 * lines.length, trade_in_credit_returned_iqd: 100, net_after_report_adjustments_iqd: 1 });
  return b;
}

test('reverseLikeAReturn: each line refunds its net goods, its cost back in stock and its delivery taken back; the owner keeps minus what stays', () => {
  const b = base([line(), line({ id: 'line-b', order_item_id: 'line-b', qty: 1, net_goods_iqd: 8000, original_net_goods_iqd: 8000, refund_iqd: 2000, restored_cogs_iqd: 1500, cogs_iqd: 1500,
    shipping_income_iqd: 2000, cod_tax_iqd: 0, courier_fee_iqd: 0, payment_fee_iqd: 0, direct_cost_iqd: 0, wages_iqd: 0, materials_iqd: 0, manual_direct_iqd: 0, unknown_refund: 1 })]);
  const same = reverseLikeAReturn(b);
  assert.equal(same, b, 'in place');
  const [a, c] = b.lines;
  // The kept goods are refunded, nothing retained, the cost restored (an earlier return's included), the delivery and the fee taken back.
  assert.deepEqual([a.refund_iqd, a.retained_revenue_iqd, a.cogs_iqd, a.restored_cogs_iqd, a.shipping_income_iqd, a.cod_tax_iqd, a.gross_profit_iqd], [15000, 0, 0, 6000, 0, 0, 0]);
  assert.deepEqual([c.refund_iqd, c.retained_revenue_iqd, c.cogs_iqd, c.restored_cogs_iqd, c.gross_profit_iqd], [8000, 0, 0, 3000, 0], 'an earlier partial refund: the whole sale is refunded now, an unknown amount no more');
  // What stays on the order: wages and materials (direct), extra costs, the courier and payment fees.
  assert.deepEqual([a.contribution_profit_iqd, a.profit_basis_iqd, a.owner_net_iqd], [-2400, -2400, -2400]);
  assert.deepEqual([a.investor_iqd, a.promotion_iqd, a.coupon_iqd, a.trade_in_credit_returned_iqd, a.price_protection_iqd], [0, 0, 0, 0, 250]);
  assert.equal(a.net_after_report_adjustments_iqd, -2650, 'a price protection already credited stays deducted');
  assert.deepEqual([c.owner_net_iqd, c.net_after_report_adjustments_iqd], [0, -250]);
  // Untouched: what was sold, its quantities, its costs.
  assert.deepEqual([a.net_goods_iqd, a.qty, a.wages_iqd, a.materials_iqd, a.courier_fee_iqd, a.fifo_cogs_iqd], [15000, 2, 1000, 400, 500, 6000]);
  const t = b.totals;
  assert.deepEqual([t.net_goods_iqd, t.refund_iqd, t.refunded_iqd, t.retained_revenue_iqd, t.cogs_iqd, t.gross_profit_iqd, t.shipping_income_iqd, t.cod_tax_iqd], [23000, 23000, 23000, 0, 0, 0, 0, 0]);
  assert.deepEqual([t.profit_basis_iqd, t.investor_iqd, t.promotion_iqd, t.owner_net_iqd, t.coupon_iqd, t.trade_in_credit_returned_iqd, t.net_after_report_adjustments_iqd], [-2400, 0, 0, -2400, 0, 0, -2900]);
  assert.equal(t.collection_difference_iqd, -20000, 'the cash collected is to give back');
  assert.equal(t.unknown_lines, 0);
});

test('reverseLikeAReturn: an unknown goods cost is restored whatever it was; a cost that waits keeps the net unknown', () => {
  const b = reverseLikeAReturn(base([line({ cogs_iqd: null, fifo_cogs_iqd: null, cost_confidence: 'unknown' })]));
  assert.deepEqual([b.lines[0].cogs_iqd, b.lines[0].restored_cogs_iqd, b.lines[0].gross_profit_iqd, b.totals.cogs_iqd, b.totals.unknown_lines], [0, null, 0, 0, 0]);
  assert.equal(b.totals.owner_net_iqd, -2400);
  const waiting = reverseLikeAReturn(base([line({ pending_costs: 1 })]));
  assert.deepEqual([waiting.lines[0].owner_net_iqd, waiting.lines[0].net_after_report_adjustments_iqd, waiting.totals.owner_net_iqd, waiting.totals.net_after_report_adjustments_iqd], [null, null, null, null]);
  assert.deepEqual([waiting.totals.refund_iqd, waiting.totals.cogs_iqd, waiting.totals.investor_iqd], [15000, 0, 0]);
});

// ------------------------------------------------------------------ the sheet, through the real doors

/** The gift world with a priced stock batch (3 × 6,000) for the nozzle cleaner (15,000 + 5,000 delivery), as the ledger test's. */
function world() {
  const raw = giftWorld();
  raw.exec(`UPDATE users SET admin_scope='full' WHERE id='boss';
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('lot_plain','p_plain','base','',3,3,6000,18000,'received','2026-01-01');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
    VALUES ('p_loose','loose-part','Loose part','قطعة سائبة','پارچەی سەربەست',12000,'active',NULL,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');`);
  const db = asD1(raw), a = appsFor(db), env = { DB: db } as Env;
  const boss = { id: 'boss', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };
  const fin = stubApp(db, boss, (x) => { x.route('/f', adminFinanceWorkspaceRoutes); x.route('/ops', adminFinanceOperationsRoutes); });
  const ok = async (res: Response, what: string) => { const body = await json(res.clone()); assert.equal(res.status, 200, `${what}: ${JSON.stringify(body)}`); return body; };
  const move = async (id: string, status: string) => ok(await patch(a.admin, `/api/admin/orders/${id}`, { status }), status);
  async function delivered(cart: string, over: Record<string, unknown> = {}, product = 'p_plain') {
    paidLine(raw, cart, product, { qty: 1 });
    const id = (await placeOrder(a.buyer, over)).id as string;
    await move(id, 'confirmed');
    await move(id, 'delivered');
    return id;
  }
  const cancel = async (id: string) => { await move(id, 'shipped'); await move(id, 'cancelled'); };
  const sheet = async (id: string, display = '') => (await ok(await get(fin, `/f/orders/${id}${display}`), `sheet ${id}`)) as OrderProfit & Row;
  async function drainAll() { for (let i = 0; i < 6; i++) if (!(await drainOrderFinanceRecovery(env)).scanned) break; }
  const reversals = (id: string) => all<{ id: string; event_key: string; entry_day: string; reversal_of: string }>(raw,
    "SELECT id,event_key,entry_day,reversal_of FROM accounting_entries WHERE source_id=? AND event_key LIKE 'order-cancel:%' ORDER BY event_key", id).map((e) => ({ ...e }));
  return { raw, db, env, fin, ok, move, delivered, cancel, sheet, drainAll, reversals };
}

/** What a reversed sheet reads, in dinars: the goods refunded, no cost, no delivery, nothing shared, minus what stays. */
function assertReversedFigures(s: OrderProfit & Row, stays: number, collected: number) {
  const t = s.totals as Row;
  assert.deepEqual([t.net_goods_iqd, t.refund_iqd, t.retained_revenue_iqd, t.cogs_iqd, t.gross_profit_iqd, t.shipping_income_iqd, t.cod_tax_iqd],
    [15000, 15000, 0, 0, 0, 0, 0], JSON.stringify(t));
  assert.deepEqual([t.investor_iqd, t.promotion_iqd, t.owner_net_iqd, t.net_after_report_adjustments_iqd], [0, 0, 0 - stays, 0 - stays]);
  assert.equal(t.collection_difference_iqd, 0 - collected);
  const l = s.lines[0] as ProfitLine & Row;
  assert.deepEqual([l.refund_iqd, l.retained_revenue_iqd, l.cogs_iqd, l.restored_cogs_iqd, l.shipping_income_iqd, l.investor_iqd, l.owner_net_iqd], [15000, 0, 0, 6000, 0, 0, 0 - stays]);
}

test('a cash order cancelled after delivery: pending until the minute scan, then reversed on its day; the figures as a full return', async () => {
  const w = world();
  const id = await w.delivered('cart_sheet_cash');
  const deliveredSheet = await w.sheet(id);
  assert.equal(deliveredSheet.sale_reversal, undefined, 'a delivered order has none');
  assert.deepEqual([deliveredSheet.totals.refund_iqd, deliveredSheet.totals.cogs_iqd, deliveredSheet.totals.owner_net_iqd], [0, 6000, 14000]);
  await w.move(id, 'shipped');
  const walkedBack = await w.sheet(id);
  assert.equal(walkedBack.sale_reversal, undefined, 'walked back only: still a sale until it is cancelled or delivered again');
  assert.deepEqual([walkedBack.totals.refund_iqd, walkedBack.totals.cogs_iqd, walkedBack.totals.owner_net_iqd], [0, 6000, 14000]);
  await w.move(id, 'cancelled');
  // Before the scan: the journal still holds the sale and its cost.
  const before = await w.sheet(id);
  assert.deepEqual(before.sale_reversal, { pending: true, day: null, entries: [] });
  assertReversedFigures(before, 0, 0);
  await w.drainAll();
  const journal = () => all(w.raw, 'SELECT id,event_key FROM accounting_entries ORDER BY id').map((e) => ({ ...e }));
  const books = journal();
  const after = await w.sheet(id);
  const posted = w.reversals(id);
  assert.equal(posted.length, 2, 'the sale and its cost');
  assert.deepEqual(after.sale_reversal, { pending: false, day: baghdadDay(), entries: posted });
  assertReversedFigures(after, 0, 0);
  assert.deepEqual(journal(), books, 'a read writes nothing');
});

test('the costs that stay on the order make its owner net, and the cash collected is to give back; in dollars the same', async () => {
  const w = world();
  // A material cost of 1,000 an order (a rule with no employee) and a courier who kept 3,000 of the 20,000 he collected: both stay.
  await w.ok(await post(w.fin, '/ops/rules', { basis: 'order', amount: 1000, milestone: 'delivered' }), 'rule');
  const id = await w.delivered('cart_sheet_costs');
  assert.equal(row<{ n: number }>(w.raw, 'SELECT SUM(amount_iqd) n FROM finance_order_costs WHERE order_id=? AND staff_id IS NULL', id)?.n, 1000);
  w.raw.exec("INSERT INTO expense_categories(id,slug,name_ar,name_en) VALUES ('courier_fees_t','courier-fees-t','أجور شركة التوصيل','Courier fees')");
  await w.ok(await post(w.fin, '/ops/collections', { operation_id: 'sheet-cash-0001', order_id: id, amount_iqd: 20000, fee_iqd: 3000, category_id: 'courier_fees_t', collection_day: baghdadDay(), payer: 'courier' }), 'collection');
  await w.cancel(id);
  await w.drainAll();
  const s = await w.sheet(id);
  assert.equal(s.sale_reversal?.day, baghdadDay());
  assertReversedFigures(s, 4000, 20000);
  assert.deepEqual([s.totals.materials_iqd, s.totals.courier_fee_iqd, s.totals.collected_iqd], [1000, 3000, 20000]);
  // The dollar block beside it: every dinar field byte-identical, and its cents worked out from the reversed figures.
  const usd = await w.sheet(id, '?display=USD');
  const { display_usd: dollars, ...dinars } = usd;
  assert.deepEqual(dinars, s);
  assert.equal(dollars?.available, true);
  const rate = String(dollars?.fx_rate_snapshot), c = (iqd: number) => iqdToCents(iqd, rate)!;
  const cents = dollars!.cents!;
  assert.deepEqual([cents.refund_cents, cents.retained_revenue_cents, cents.cogs_cents, cents.gross_profit_cents, cents.shipping_income_cents, cents.cod_tax_cents],
    [cents.net_goods_cents, 0, 0, 0, 0, 0]);
  assert.deepEqual([cents.investor_cents, cents.promotion_cents], [0, 0]);
  assert.deepEqual([cents.owner_net_cents, cents.net_after_report_adjustments_cents, cents.collection_difference_cents], [-(c(1000) + c(3000)), -(c(1000) + c(3000)), -c(20000)]);
  const lineCents = dollars!.lines![s.lines[0].id];
  assert.deepEqual([lineCents.refund_cents, lineCents.cogs_cents, lineCents.owner_net_cents], [lineCents.net_goods_cents, 0, -(c(1000) + c(3000))]);
});

test('a wallet order: the same figures; its entries are the reversals of the sale and its cost, not the wallet\'s refund', async () => {
  const w = world();
  const id = await w.delivered('cart_sheet_wallet', { useWallet: true });
  await w.cancel(id);
  assert.equal(all(w.raw, 'SELECT id FROM accounting_entries WHERE event_key=?', `cancel-wallet:${id}`).length, 1, 'the cancel gave the wallet money back (source order_cancel too)');
  assert.deepEqual((await w.sheet(id)).sale_reversal, { pending: true, day: null, entries: [] });
  await w.drainAll();
  const s = await w.sheet(id);
  const natives = all<{ id: string }>(w.raw, 'SELECT id FROM accounting_entries WHERE event_key IN (?,?) ORDER BY id', `sale:${id}`, `cogs:${id}`).map((e) => e.id);
  assert.deepEqual(s.sale_reversal?.entries.map((e) => e.reversal_of).sort(), natives);
  assert.ok(s.sale_reversal?.entries.every((e) => e.event_key === `order-cancel:${e.reversal_of}` && e.entry_day === baghdadDay()));
  assertReversedFigures(s, 0, 0);
});

test('R-b: delivered again, the sheet is a sale again; cancelled again, it waits for the scan, then names the second reversal', async () => {
  const w = world();
  // An untracked part, its cost never recorded: the order the live store can re-open (row 310).
  const id = await w.delivered('cart_sheet_again', {}, 'p_loose');
  await w.cancel(id);
  await w.drainAll();
  const first = w.reversals(id);
  assert.equal(first.length, 1);
  assert.deepEqual((await w.sheet(id)).sale_reversal, { pending: false, day: baghdadDay(), entries: first });
  for (const status of ['pending', 'confirmed', 'delivered']) await w.move(id, status);
  const again = await w.sheet(id);
  assert.equal(again.sale_reversal, undefined);
  assert.deepEqual([again.totals.refund_iqd, again.totals.retained_revenue_iqd, again.totals.shipping_income_iqd], [0, 12000, 5000], 'a delivered sale');
  await w.cancel(id);
  assert.deepEqual((await w.sheet(id)).sale_reversal, { pending: true, day: null, entries: [] }, 'the re-posting is in the books until the scan');
  await w.drainAll();
  const redeliver = all<{ id: string }>(w.raw, "SELECT id FROM accounting_entries WHERE source_id=? AND event_key LIKE 'order-redeliver:%'", id).map((e) => e.id);
  const s = await w.sheet(id);
  assert.equal(s.sale_reversal?.entries.length, 1);
  assert.deepEqual([s.sale_reversal?.entries[0].reversal_of, s.sale_reversal?.day, s.sale_reversal?.pending], [redeliver[0], baghdadDay(), false]);
  assert.deepEqual([s.totals.net_goods_iqd, s.totals.refund_iqd, s.totals.cogs_iqd, s.totals.owner_net_iqd], [12000, 12000, 0, 0], 'its cost unknown, the reversed sheet still nets 0');
});

test('an order cancelled after delivery that never booked a sale: neither pending nor reversed', async () => {
  const w = world();
  w.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('free-order-t1','buyer','cancelled','{}','standard','{}','cash',0,1500,0,0,'2026-10-01T10:00:00.000Z','2026-10-02T10:00:00.000Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line-free-t1','free-order-t1','p_other','Other',1,0,0,0,'snapshot');`);
  const s = await w.sheet('free-order-t1');
  assert.deepEqual(s.sale_reversal, { pending: false, day: null, entries: [] });
  assert.deepEqual([s.totals.net_goods_iqd, s.totals.refund_iqd, s.totals.cogs_iqd, s.totals.owner_net_iqd], [0, 0, 0, 0]);
});

// ------------------------------------------------------------------ the note, in three languages

const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/, ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the note in Arabic, English and real Sorani (DECISIONS row 183), and the sheet says it where the cancelled status stands', () => {
  for (const [key, { ar, en, ckb }] of Object.entries(SALE_REVERSAL_NOTES)) {
    for (const [lang, s] of Object.entries({ ar, en, ckb })) assert.ok(s.trim().length > 0 && s === s.trim(), `${key}.${lang}`);
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, SORANI_ONLY, `${key}: no Sorani letter`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani`);
    assert.match(ar, /[؀-ۿ]/, `${key}: the Arabic is not Arabic`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: Arabic script in the English`);
    assert.deepEqual(placeholders(ckb), placeholders(ar), `${key}: ckb placeholders`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${key}: en placeholders`);
  }
  assert.ok(SALE_REVERSAL_NOTES.reversed.ar.startsWith('أُلغي بعد التسليم: عُكس بيعه وتكلفة بضاعته في الدفتر يوم {day}، كالمرتجع، ولا يُحسب في أي فترة'), 'the owner\'s words');
  assert.deepEqual(placeholders(SALE_REVERSAL_NOTES.reversed.ar), ['day']);
  // Which note, from what the server says.
  const reversal = (over: Partial<SaleReversal>): SaleReversal => ({ pending: false, day: null, entries: [], ...over });
  assert.equal(saleReversalNote(reversal({ pending: true })), 'pending');
  assert.equal(saleReversalNote(reversal({ day: '2026-11-11' })), 'reversed');
  assert.equal(saleReversalNote(reversal({ pending: true, day: '2026-11-11' })), 'pending', 'a chain still in the books comes first');
  assert.equal(saleReversalNote(reversal({})), 'neverBooked');
  // Its day as the workspace writes a day, Latin digits, in each language.
  const loc = (lang: 'ar' | 'en' | 'ckb') => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
  const day = reversal({ day: '2026-11-11' });
  assert.equal(saleReversalText(loc('ar'), 'ar', day), 'أُلغي بعد التسليم: عُكس بيعه وتكلفة بضاعته في الدفتر يوم 11 تشرين الثاني 2026، كالمرتجع، ولا يُحسب في أي فترة.');
  assert.equal(saleReversalText(loc('en'), 'en', day), 'Cancelled after delivery: its sale and goods cost were reversed in the journal on Nov 11, 2026, like a return, and it counts in no period.');
  assert.match(saleReversalText(loc('ckb'), 'ckb', day), /^دوای گەیاندن هەڵوەشێنرایەوە: .* لە ڕۆژی 11 تشرینی دووەم 2026 /);
  assert.doesNotMatch(saleReversalText(loc('ckb'), 'ckb', reversal({ pending: true })), /\{day\}|[ةىيك]/);
  // The sheet: the note where it names the cancelled status, from the server's answer; the pinned lines stay.
  const sheet = readFileSync(join(ROOT, 'src/components/financeWorkspace/OrderProfitSheet.tsx'), 'utf8');
  assert.match(sheet, /<Status>\{statusName\(data\.order\.status, loc\)\}<\/Status> \{data\.sale_reversal \? saleReversalText\(loc, lang, data\.sale_reversal\) : view\?\.expectsDelivery \?/);
  assert.match(sheet, /\(line\.refund_iqd \?\? 0\) > 0 && <><Row label=\{loc\('المبلغ المرتجع', 'Refunded amount'\)\}/, 'the refund rows show the take-back');
});
