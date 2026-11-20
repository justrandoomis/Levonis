/**
 * PHASE 8 — «حصة الطابعة وحدها» (owner rulings R1 and R3, 2026-11-21; DECISIONS row 364).
 *
 * R1 «shop only, the investor and staff on just printer the base [price after all promotion]; any services earn on new
 *     column as profit from services is for shop».
 * R3  a warranty / Levo Care claim cost is the shop's general expense of its cost day: no investor result, no staff
 *     profit-% wage and no fingerprint moves.
 *
 * THE WORKED EXAMPLES. An anchored printer of catalogue price P = 960,000 whose Smart package (the anchor) is 48,000,
 * goods cost C = 700,000:
 *
 *     bought as                unit price   services fee   printer's own part   «ربح الخدمات»
 *     Just Printer               912,000            0            912,000                 0
 *     Smart                      960,000       48,000            912,000            48,000
 *     Complete                 1,093,000      181,000            912,000           181,000
 *     Smart by a PRO member      936,000       24,000            912,000            24,000
 *
 * In all four the investor (35%) earns 35% × (912,000 − 700,000) = 74,200 and a 10% profit / 10% revenue wage is
 * 21,200 / 91,200. Everything that lowers the LINE (a line coupon, points, a refund) is carried by the printer and its
 * services in proportion to their share of the line's price (splitServicedLine's rule since phase 3).
 *
 * Nothing counted before the rule's first delivery day is restated, and a line without services is byte-identical.
 *
 * Run: node --import tsx --test tests/printerPartShares.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, failingD1, stubApp, post, get, json, count, row } from './fixtures/app';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { investorOrderSplit, syncInvestorOrder } from '../worker/lib/investorFinance';
import { getOrderProfitBase } from '../worker/lib/orderProfit';
import { participantNetProfit } from '../worker/lib/participantProfit';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { reconcileEffectiveWages } from '../worker/lib/financeWageCalculation';
import { baghdadDay, journalPlan } from '../worker/lib/operations';
import { PRINTER_PART_FROM_DAY, CLAIM_COSTS_OUT_OF_SHARES_FROM_DAY, printerPartOf, printerPartRuleApplies, servicesOutOfShares } from '../worker/lib/printerPart';
import { printerBreakdown } from '../worker/lib/printerFinance';
import type { Env } from '../worker/lib/types';

const P = 960_000, ANCHOR = 48_000, C = 700_000, OWN = P - ANCHOR;
/** The four ways the same printer is bought: [name, unit price, the frozen services fee, the service lines]. */
const snap = (fee: number, lines: Record<string, number>, extra: Record<string, unknown> = {}) => JSON.stringify({
  lines: Object.entries(lines).map(([service, fee_iqd]) => ({ service, choice: 'x', fee_iqd })),
  fee_iqd: fee, anchor_fee_iqd: ANCHOR, net_fee_iqd: fee - ANCHOR, warranty_months: lines.warranty ? 12 : 0, care_months: lines.care ? 12 : 0, ...extra,
});
const PACKAGES = [
  { name: 'Just Printer', unit: 912_000, fee: 0, snapshot: snap(0, {}) },
  { name: 'Smart', unit: 960_000, fee: 48_000, snapshot: snap(48_000, { warranty: 29_000, care: 19_000 }) },
  { name: 'Complete', unit: 1_093_000, fee: 181_000, snapshot: snap(181_000, { warranty: 80_000, care: 19_000, packaging: 12_000, inspection: 20_000, academy: 50_000 }) },
  { name: 'Smart by a PRO member', unit: 936_000, fee: 24_000, snapshot: snap(24_000, { warranty: 14_500, care: 9_500 }, { pro_discount: { pct: 50, services_iqd: 24_000, personal_before_iqd: null, personal_iqd: 0 } }) },
] as const;
const AFTER = '2026-11-25T09:00:00.000Z', BEFORE = '2026-11-20T09:00:00.000Z';

test('the constants: the rule governs orders PLACED from its first day; claim costs leave the shares from the same day', () => {
  assert.equal(PRINTER_PART_FROM_DAY, '2026-11-22');
  assert.equal(CLAIM_COSTS_OUT_OF_SHARES_FROM_DAY, PRINTER_PART_FROM_DAY);
  assert.equal(printerPartRuleApplies({ created_at: '2026-11-21T20:59:59Z' }), false, '23:59 Baghdad on the 21st: before');
  assert.equal(printerPartRuleApplies({ created_at: '2026-11-21T21:00:00Z' }), true, '00:00 Baghdad on the 22nd: the first day');
  assert.equal(printerPartRuleApplies({ created_at: '2026-11-21 21:00:00' }), true, 'a SQLite timestamp is UTC');
  // Placed before the day, delivered after it (a wage may already be accrued at `prepared`, a payout may hold it): the old basis, for life.
  assert.equal(printerPartRuleApplies({ created_at: '2026-11-20T09:00:00Z', delivered_at: '2026-11-30T09:00:00Z' }), false);
  assert.equal(printerPartRuleApplies({ created_at: '2026-11-20T09:00:00Z', delivered_at: null }), false);
  assert.equal(printerPartRuleApplies({ created_at: '2026-11-23T09:00:00Z', delivered_at: null }), true, 'a new order, not delivered yet');
  assert.equal(printerPartRuleApplies({ delivered_at: '2026-11-20T09:00:00Z' }), false, 'no creation instant: read by its delivery');
});

test('the four packages: the printer part is 912,000 in each; the services are 0 / 48,000 / 181,000 / 24,000', () => {
  for (const k of PACKAGES) {
    const p = printerPartOf({ qty: 1, line_total_iqd: k.unit, net_goods_iqd: k.unit, retained_revenue_iqd: k.unit, services_snapshot: k.snapshot });
    assert.deepEqual([p.serviced, p.printer_part_retained_iqd, p.services_retained_iqd], [true, OWN, k.fee], k.name);
    assert.equal(servicesOutOfShares({ delivered_at: AFTER }, { qty: 1, line_total_iqd: k.unit, net_goods_iqd: k.unit, retained_revenue_iqd: k.unit, services_snapshot: k.snapshot }), k.fee, k.name);
    assert.equal(servicesOutOfShares({ delivered_at: BEFORE }, { qty: 1, line_total_iqd: k.unit, net_goods_iqd: k.unit, retained_revenue_iqd: k.unit, services_snapshot: k.snapshot }), 0, `${k.name}: delivered before the rule — the whole line stays the base`);
  }
});

test('a coupon, points, a live offer and a partial return: each lowers the printer and its services in proportion', () => {
  const smart = PACKAGES[1], complete = PACKAGES[2];
  // A 10% line coupon on a Smart line: 864,000 kept of 960,000 → the services keep 90% of 48,000, the printer 90% of 912,000.
  const coupon = printerPartOf({ qty: 1, line_total_iqd: 960_000, net_goods_iqd: 864_000, retained_revenue_iqd: 864_000, services_snapshot: smart.snapshot });
  assert.deepEqual([coupon.services_retained_iqd, coupon.printer_part_retained_iqd], [43_200, 820_800]);
  // 50,000 of points on a Complete line (the engine takes points off the line's net): floor(1,043,000 × 181,000 / 1,093,000).
  const points = printerPartOf({ qty: 1, line_total_iqd: 1_093_000, net_goods_iqd: 1_043_000, retained_revenue_iqd: 1_043_000, services_snapshot: complete.snapshot });
  assert.equal(points.services_retained_iqd, Math.floor((1_043_000 * 181_000) / 1_093_000));
  assert.equal(points.services_retained_iqd, 172_720);
  assert.equal(points.printer_part_retained_iqd + points.services_retained_iqd, 1_043_000);
  // A live offer takes 60,000 off the printer itself: the catalogue price is 900,000, Smart still charges 48,000 inside it.
  const offer = printerPartOf({ qty: 1, line_total_iqd: 900_000, net_goods_iqd: 900_000, retained_revenue_iqd: 900_000, services_snapshot: smart.snapshot });
  assert.deepEqual([offer.services_retained_iqd, offer.printer_part_retained_iqd], [48_000, 852_000]);
  // Two Smart printers, one returned and refunded 960,000: one printer's part and one printer's services are kept.
  const returned = printerPartOf({ qty: 2, line_total_iqd: 1_920_000, net_goods_iqd: 1_920_000, retained_revenue_iqd: 960_000, services_snapshot: smart.snapshot });
  assert.deepEqual([returned.services_gross_iqd, returned.services_net_iqd, returned.services_retained_iqd, returned.printer_part_retained_iqd], [96_000, 96_000, 48_000, 912_000]);
  // Both returned: nothing kept, nothing for anyone. A refund above the line never makes the services negative.
  const all = printerPartOf({ qty: 2, line_total_iqd: 1_920_000, net_goods_iqd: 1_920_000, retained_revenue_iqd: 0, services_snapshot: smart.snapshot });
  assert.deepEqual([all.services_retained_iqd, all.printer_part_retained_iqd], [0, 0]);
  const over = printerPartOf({ qty: 1, line_total_iqd: 960_000, net_goods_iqd: 960_000, retained_revenue_iqd: -10_000, services_snapshot: smart.snapshot });
  assert.deepEqual([over.services_retained_iqd, over.printer_part_retained_iqd], [0, -10_000]);
  // No services on the line: the printer part IS the line; garbage is no services.
  for (const s of [null, undefined, '', '{not json']) {
    const plain = printerPartOf({ qty: 1, line_total_iqd: 500, net_goods_iqd: 500, retained_revenue_iqd: 450, services_snapshot: s });
    assert.deepEqual(plain, { serviced: false, services_gross_iqd: 0, services_net_iqd: 0, services_retained_iqd: 0, printer_part_retained_iqd: 450 });
  }
});

// ───────────────────────────────────────────────────────────── the investor

const ADMIN = { id: 'admin', email: 'boss@x.co', role: 'admin' as const };
function investorSetup(cost: number = C) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role,admin_scope,name) VALUES ('admin','boss@x.co','admin','full','Owner'),('investor','investor@x.co','admin','assistant','Investor'),('buyer','buyer@x.co','customer',NULL,'Buyer');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,name_ar,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('xpa2','XPA2','طابعة','xpa2','XPA2',${P},${cost},12,'BASE');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by) VALUES ('inc','xpa2','base','',12,12,${cost},0,0,'supplier','received','admin');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id) VALUES ('lot','xpa2','base','',12,12,${cost},${12 * cost},'received','2026-01-01','inc','supplier');`);
  const db = asD1(raw);
  const app = stubApp(db, ADMIN, (a) => { a.route('/i', adminInvestmentFinanceRoutes); a.route('/w', adminFinanceWorkspaceRoutes); });
  return { raw, db, app };
}
type S = ReturnType<typeof investorSetup>;
async function fundedContract(s: S) {
  const body = { operation_id: crypto.randomUUID(), incoming_id: 'inc', user_id: 'investor', name: 'تمويل طابعات', principal_iqd: 12 * C, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: 10000 };
  const res = await post(s.app, '/i/contracts', body);
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const fund = await post(s.app, `/i/contracts/${body.operation_id}/funding`, { operation_id: crypto.randomUUID(), amount_iqd: 12 * C, payment_day: baghdadDay(), reference: 'cash' });
  assert.equal(fund.status, 200, JSON.stringify(await json(fund.clone())));
  return body.operation_id;
}
async function sale(s: S, id: string, o: { unit: number; snapshot: string | null; qty?: number; deliveredAt?: string; createdAt?: string; coupon?: number; orderCoupon?: number; points?: number; cost?: number; lossBps?: number; shipping?: number }) {
  const qty = o.qty ?? 1, total = qty * o.unit, at = o.deliveredAt ?? AFTER, due = total - (o.coupon ?? 0) - (o.orderCoupon ?? 0) - (o.points ?? 0) + (o.shipping ?? 0);
  s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,points_discount_iqd,coupon_discount_iqd,created_at,delivered_at)
    VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,?,?,?,?,?)`).run(id, total, due, due, o.shipping ?? 0, o.points ?? 0, (o.coupon ?? 0) + (o.orderCoupon ?? 0), o.createdAt ?? at, at);
  s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,coupon_discount_iqd,cost_iqd,cost_basis,services_snapshot) VALUES (?,?,'xpa2','طابعة',?,?,?,?,?,'snapshot',?)`)
    .run(`${id}-item`, id, qty, o.unit, total, o.coupon ?? 0, C, o.snapshot);
  s.raw.prepare("INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,'lot','base','',?,?,?,?)").run(`${id}-a`, id, `${id}-item`, qty, C, qty * C, `${id}:lot`);
  s.raw.prepare("UPDATE inventory_lots SET qty_remaining=qty_remaining-? WHERE id='lot'").run(qty);
  s.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'admin',?)").run(`${id}-collection`, id, due, baghdadDay(), new Date().toISOString());
  await s.db.batch([
    ...journalPlan(s.db, { key: `sale:${id}`, day: baghdadDay(), title: 'Sale', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '1100', debit: due }, { account: '4000', credit: due }]).statements,
    ...journalPlan(s.db, { key: `cogs:${id}`, day: baghdadDay(), title: 'COGS', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '5000', debit: qty * C }, { account: '1200', credit: qty * C }]).statements,
  ]);
}
const share = (v: number) => Math.floor((v * 3500) / 10000);

test('investor: Just Printer, Smart, Complete and PRO Smart all pay 35% of (912,000 − cost); the services stay with the shop', async () => {
  const s = investorSetup();
  await fundedContract(s);
  for (const [i, k] of PACKAGES.entries()) {
    const id = `o${i}`;
    await sale(s, id, { unit: k.unit, snapshot: k.snapshot });
    await syncInvestorOrder(s.db, id, { actor: 'admin' });
    const split = await investorOrderSplit(s.db, id);
    assert.equal(split.allocations.length, 1, k.name);
    const a = split.allocations[0], snapshot = JSON.parse(a.snapshot);
    assert.equal(a.profit_iqd, share(OWN - C), k.name);
    assert.equal(a.profit_iqd, 74_200, k.name);
    assert.equal(a.capital_iqd, C, `${k.name}: the capital returns whole`);
    assert.deepEqual([snapshot.revenue, snapshot.cost, snapshot.expenses, snapshot.profit], [OWN, C, 0, OWN - C], `${k.name}: the unit's sale is the printer part`);
    assert.equal(snapshot.printer_part, k.fee > 0 ? true : undefined, `${k.name}: flagged only when services were left to the shop`);
    // The shop keeps the rest of the order's profit: its 65% of the printer part and every dinar of the services.
    assert.equal(split.owner_profit_iqd, k.unit - C - 74_200, k.name);
    assert.equal(split.owner_profit_iqd, (OWN - C - 74_200) + k.fee, k.name);
    const stored = row(s.raw, 'SELECT profit_iqd,capital_iqd FROM investor_allocation_results WHERE allocation_id=?', `${id}-a`)!;
    assert.deepEqual([stored.profit_iqd, stored.capital_iqd], [74_200, C], `${k.name}: what the ledger stored`);
    // The profit engine's own figures are untouched: the line's profit still holds the services (they are the shop's profit).
    const base = await getOrderProfitBase(s.db, id);
    assert.equal(base.totals.profit_basis_iqd, k.unit - C, k.name);
    assert.equal((base.totals as Record<string, unknown>).services_profit_iqd, k.fee, `${k.name}: «ربح الخدمات»`);
    assert.equal((await participantNetProfit(s.db, base)).get(`${id}-item`), OWN - C, `${k.name}: the participants' net`);
  }
  assert.equal(count(s.raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
});

test('investor: a line coupon and points lower the printer part pro rata; a partial return keeps one printer', async () => {
  const s = investorSetup();
  await fundedContract(s);
  // Smart with a 96,000 line coupon (10%): the printer part is 820,800.
  await sale(s, 'coupon', { unit: 960_000, snapshot: PACKAGES[1].snapshot, coupon: 96_000 });
  await syncInvestorOrder(s.db, 'coupon');
  let a = (await investorOrderSplit(s.db, 'coupon')).allocations[0];
  assert.equal(JSON.parse(a.snapshot).revenue, 820_800);
  assert.equal(a.profit_iqd, share(820_800 - C));
  // Complete with 50,000 of points: 1,043,000 kept, the services' part 172,720, the printer's 870,280.
  await sale(s, 'points', { unit: 1_093_000, snapshot: PACKAGES[2].snapshot, points: 50_000 });
  await syncInvestorOrder(s.db, 'points');
  a = (await investorOrderSplit(s.db, 'points')).allocations[0];
  assert.equal(JSON.parse(a.snapshot).revenue, 870_280);
  assert.equal(a.profit_iqd, share(870_280 - C));
  // Two Smart printers; one comes back (refund 960,000, restocked): one printer's part, one unit's cost, one unit of capital.
  await sale(s, 'pair', { unit: 960_000, snapshot: PACKAGES[1].snapshot, qty: 2 });
  await syncInvestorOrder(s.db, 'pair');
  a = (await investorOrderSplit(s.db, 'pair')).allocations[0];
  assert.deepEqual([JSON.parse(a.snapshot).revenue, a.profit_iqd, a.capital_iqd], [2 * OWN, share(2 * (OWN - C)), 2 * C]);
  s.raw.exec(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution) VALUES ('ret','pair','pair-item','buyer',1,'defective','resolved','refund');
    INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,cogs_iqd,channel,refunded_day) VALUES ('ret','pair',960000,1,'restock',${C},'wallet','2026-11-26');`);
  const base = await getOrderProfitBase(s.db, 'pair');
  assert.deepEqual([base.lines[0].retained_revenue_iqd, base.lines[0].cogs_iqd, (base.lines[0] as Record<string, unknown>).services_profit_iqd], [960_000, C, 48_000]);
  assert.equal((await participantNetProfit(s.db, base)).get('pair-item'), OWN - C);
  const b = printerBreakdown([base]);
  assert.deepEqual([b.printer_net_iqd, b.services_net_iqd, b.printer_cogs_iqd, b.printer_margin_iqd, b.sold.units], [OWN, 48_000, C, OWN - C, 1], 'the report card reads retained figures: the returned printer shows no services');
});

test('nothing is restated: a serviced order delivered before the first day keeps the whole line as its base, however often it is recomputed', async () => {
  const s = investorSetup();
  await fundedContract(s);
  await sale(s, 'old', { unit: 1_093_000, snapshot: PACKAGES[2].snapshot, deliveredAt: BEFORE });
  await syncInvestorOrder(s.db, 'old');
  const first = row(s.raw, "SELECT profit_iqd,snapshot FROM investor_allocation_results WHERE allocation_id='old-a'")!;
  assert.equal(first.profit_iqd, share(1_093_000 - C), 'as it was counted before this phase: 35% of the whole line');
  assert.equal(JSON.parse(String(first.snapshot)).printer_part, undefined);
  assert.equal(JSON.parse(String(first.snapshot)).revenue, 1_093_000);
  const events = count(s.raw, 'SELECT COUNT(*) n FROM investor_finance_events');
  await syncInvestorOrder(s.db, 'old');
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM investor_finance_events'), events, 'a recheck writes nothing');
  assert.deepEqual(row(s.raw, "SELECT profit_iqd,snapshot FROM investor_allocation_results WHERE allocation_id='old-a'"), first);
});

test('a line without services is byte-identical: the same keys in the same order, the same figures, on either side of the first day', async () => {
  const s = investorSetup();
  await fundedContract(s);
  for (const [id, at] of [['plain-after', AFTER], ['plain-before', BEFORE]] as const) {
    await sale(s, id, { unit: P, snapshot: null, deliveredAt: at });
    await syncInvestorOrder(s.db, id);
    const split = await investorOrderSplit(s.db, id), a = split.allocations[0], base = await getOrderProfitBase(s.db, id);
    assert.equal(a.snapshot, JSON.stringify({ version: 0, profit_basis: 'net_excluding_store_promotion_v2', source_fingerprint: split.source_fingerprint, contract_version: JSON.parse(a.snapshot).contract_version,
      qty: 1, principal_iqd: C, revenue: P, cost: C, expenses: 0, profit: P - C, collected: true, delivered: true, capital_loss_iqd: 0 }), id);
    assert.equal(a.profit_iqd, share(P - C), id);
    assert.equal('services_profit_iqd' in base.lines[0], false, `${id}: an unserviced line carries no services key`);
    assert.equal((base.totals as Record<string, unknown>).services_profit_iqd, 0);
  }
});

// ───────────────────────────────────────────────────────────── ruling R3: claim costs

test('R3: a claim cost of the month changes no investor result, no participants’ net and no fingerprint — yet the shop’s period carries it once', async () => {
  const s = investorSetup();
  await fundedContract(s);
  await sale(s, 'nov', { unit: 960_000, snapshot: PACKAGES[1].snapshot });
  await syncInvestorOrder(s.db, 'nov');
  const before = await investorOrderSplit(s.db, 'nov'), stored = row(s.raw, "SELECT * FROM investor_allocation_results WHERE allocation_id='nov-a'");
  const events = count(s.raw, 'SELECT COUNT(*) n FROM investor_finance_events');
  s.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES
    ('claim-w','exp_warranty_claims',60000,'2026-11-26','مطالبة ضمان','x'),('claim-c','exp_care_claims',40000,'2026-11-27','مطالبة ليفو كير','x')`);
  const after = await investorOrderSplit(s.db, 'nov');
  assert.equal(after.source_fingerprint, before.source_fingerprint, 'the fingerprint does not see a claim cost');
  assert.deepEqual(after.allocations, before.allocations);
  assert.equal((await participantNetProfit(s.db, await getOrderProfitBase(s.db, 'nov'))).get('nov-item'), OWN - C);
  assert.equal((await participantNetProfit(s.db, await getOrderProfitBase(s.db, 'nov'), true)).get('nov-item'), OWN - C, 'the staff profit-% base too');
  await syncInvestorOrder(s.db, 'nov');
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM investor_finance_events'), events, 'nothing is posted');
  assert.deepEqual(row(s.raw, "SELECT * FROM investor_allocation_results WHERE allocation_id='nov-a'"), stored);
  // The shop's period still carries the 100,000 once, as general expenses.
  const summary = await json(await get(s.app, '/w/summary?from=2026-11-22&to=2026-11-30'));
  assert.equal(summary.totals.general_expenses_iqd, 100_000);
  assert.equal(summary.totals.owner_period_net_iqd, summary.totals.owner_net_iqd - 100_000);
  assert.equal(summary.totals.investor_iqd, 74_200);
  // The control: an ordinary general expense of the month IS shared, as before.
  s.raw.exec("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES ('rent',(SELECT id FROM expense_categories WHERE id NOT IN ('exp_warranty_claims','exp_care_claims') LIMIT 1),10000,'2026-11-26','إيجار','x')");
  const shared = await investorOrderSplit(s.db, 'nov');
  assert.notEqual(shared.source_fingerprint, before.source_fingerprint);
  assert.equal(shared.allocations[0].profit_iqd, share(OWN - C - 10_000));
});

test('R3 restates nothing: a claim cost dated before the first day stays where it was counted', async () => {
  const s = investorSetup();
  await fundedContract(s);
  await sale(s, 'early', { unit: P, snapshot: null, deliveredAt: BEFORE });
  const clean = await investorOrderSplit(s.db, 'early');
  s.raw.exec("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES ('claim-old','exp_warranty_claims',20000,'2026-11-19','مطالبة ضمان','x')");
  const counted = await investorOrderSplit(s.db, 'early');
  assert.notEqual(counted.source_fingerprint, clean.source_fingerprint, 'as before this phase: it is in the month’s fingerprint');
  assert.equal(counted.allocations[0].profit_iqd, share(P - C - 20_000), 'and in the month’s spread');
});

// ───────────────────────────────────────────────────────────── staff commission

async function wageSetup(basis: 'revenue_percent' | 'profit_percent', amount: number) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Employee','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO catalogs(id,name_ar,slug) VALUES ('printers','الطابعات','wage-printers');
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode,category_id) VALUES ('xpa2','XPA2','wage-xpa2',${P},0,'BASE','printers');`);
  const { db } = failingD1(raw);
  const app = (id: string) => stubApp(db, { id, email: `${id}@x.co`, role: 'admin', admin_scope: id === 'boss' ? 'full' : 'assistant' }, (a) => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
    a.route('/earnings', financeEarningsRoutes);
  });
  const boss = app('boss'), self = app('employee'), env = { DB: db } as Env;
  const staff = await json(await post(boss, '/people/staff', { user_id: 'employee', start_work_date: '2026-08-31' }));
  const ruleResponse = await post(boss, '/operations/rules', { staff_id: staff.id, basis, amount, scope: { catalog_ids: ['printers'], product_ids: [], excluded_product_ids: [] } });
  assert.equal(ruleResponse.status, 200, JSON.stringify(await json(ruleResponse.clone())));
  async function order(id: string, unit: number, snapshot: string | null, at = AFTER, created?: string) {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(id, unit, unit, unit, created ?? at, at);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,services_snapshot) VALUES (?,?,'xpa2','Printer',1,?,?,?,'snapshot',?)`).run(`${id}:l`, id, unit, unit, C, snapshot);
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES (?,'xpa2','base',1,0,?,'opening','2026-09-01T00:00:00Z')`).run(`${id}:l`, C);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,'base',1,?,?,?)`).run(`${id}:l`, id, `${id}:l`, `${id}:l`, C, C, `${id}:l`);
    await runOrderFinancialEffects(env, id, 'delivered');
  }
  async function drain() {
    for (let i = 0; i < 10; i++) {
      const response = await post(boss, `/people/staff/${staff.id}/reconcile`, {}), result = await json(response);
      assert.equal(response.status, 200, JSON.stringify(result));
      if (result.reconciliation.state === 'complete') return;
    }
    assert.fail('Reconciliation did not complete');
  }
  const wage = (id: string) => row(raw, `SELECT c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id=c.id),0) AS amount,c.base_iqd,c.snapshot FROM finance_order_costs c WHERE c.order_id=? AND c.state<>'reversed'`, id)!;
  return { raw, order, drain, wage, self, env };
}

for (const [basis, base, wage] of [['revenue_percent', OWN, 91_200], ['profit_percent', OWN - C, 21_200]] as const) {
  test(`staff ${basis} (10%): the same wage ${wage.toLocaleString('en-US')} for all four packages — the base is the printer part`, async () => {
    const x = await wageSetup(basis, 1000);
    for (const [i, k] of PACKAGES.entries()) await x.order(`o${i}`, k.unit, k.snapshot);
    await x.order('plain', P, null);
    await x.order('old', 1_093_000, PACKAGES[2].snapshot, BEFORE);
    // Placed before the first day, delivered after it: the old basis for life (no accrued wage or held payout can move).
    await x.order('straddle', 1_093_000, PACKAGES[2].snapshot, AFTER, BEFORE);
    await x.drain();
    for (const [i, k] of PACKAGES.entries()) {
      const w = x.wage(`o${i}`);
      assert.deepEqual([w.amount, w.base_iqd], [wage, base], k.name);
    }
    // A printer sold without services: its whole line, as ever. An order delivered before the first day: the whole line too.
    const plain = x.wage('plain'), old = x.wage('old'), straddle = x.wage('straddle');
    assert.equal(straddle.amount, old.amount);
    assert.equal(String(straddle.snapshot).includes('printer_part'), false);
    assert.equal(plain.amount, basis === 'revenue_percent' ? 96_000 : 26_000);
    assert.equal(old.amount, basis === 'revenue_percent' ? 109_300 : 39_300);
    assert.equal(String(plain.snapshot).includes('printer_part'), false);
    assert.equal(String(old.snapshot).includes('printer_part'), false);
    // Recomputing changes nothing.
    const total = count(x.raw, 'SELECT COALESCE(SUM(delta_iqd),0) n FROM finance_cost_adjustments');
    await x.drain();
    assert.equal(count(x.raw, 'SELECT COALESCE(SUM(delta_iqd),0) n FROM finance_cost_adjustments'), total);
    assert.equal((await json(await get(x.self, '/earnings'))).summary.earned_iqd, 4 * wage + Number(plain.amount) + Number(old.amount) + Number(straddle.amount));
  });
}

test('R3: a claim cost of the month does not move a staff profit-% wage', async () => {
  const x = await wageSetup('profit_percent', 1000);
  await x.order('o', 960_000, PACKAGES[1].snapshot);
  await x.drain();
  assert.equal(x.wage('o').amount, 21_200);
  x.raw.exec("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES ('claim','exp_care_claims',50000,'2026-11-26','مطالبة ليفو كير','x')");
  await x.drain();
  assert.equal(x.wage('o').amount, 21_200);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments'), 0);
});

// ───────────────────────────────────────────────────────────── the report card

test('the card: courier, delivery and membership count only orders that hold a serviced printer; the margin is sales − cost, unknown while a cost is', () => {
  const smart = PACKAGES[1].snapshot;
  const bases = [
    { totals: { courier_fee_iqd: 8_000, shipping_income_iqd: 10_000, cod_tax_iqd: 0 }, lines: [
      { qty: 1, returned_qty: 0, line_total_iqd: 960_000, net_goods_iqd: 960_000, retained_revenue_iqd: 960_000, cogs_iqd: C, services_snapshot: smart },
      { qty: 1, line_total_iqd: 30_000, net_goods_iqd: 30_000, retained_revenue_iqd: 30_000, line_kind: 'membership', services_snapshot: null }] },
    // No printer here: its courier fee and its membership are not the printers'.
    { totals: { courier_fee_iqd: 5_000, shipping_income_iqd: 6_000, cod_tax_iqd: 0 }, lines: [
      { qty: 2, line_total_iqd: 40_000, net_goods_iqd: 40_000, retained_revenue_iqd: 40_000, cogs_iqd: 20_000, services_snapshot: null },
      { qty: 1, line_total_iqd: 30_000, net_goods_iqd: 30_000, retained_revenue_iqd: 30_000, line_kind: 'membership', services_snapshot: null }] },
  ];
  const b = printerBreakdown(bases as never);
  assert.deepEqual([b.printer_orders, b.courier_fee_iqd, b.delivery_income_iqd, b.membership_iqd], [1, 8_000, 10_000, 30_000]);
  assert.deepEqual([b.printer_net_iqd, b.printer_cogs_iqd, b.printer_margin_iqd, b.services_net_iqd], [OWN, C, OWN - C, 48_000]);
  assert.deepEqual(b.sold, { units: 1, warranty_0: 0, warranty_12: 1, warranty_24: 0, care: 1 });
  // Just Printer on an anchored line: 48,000 came off the price — information; a PRO line names its services discount.
  const info = printerBreakdown([{ totals: {}, lines: [
    { qty: 1, line_total_iqd: 912_000, net_goods_iqd: 912_000, retained_revenue_iqd: 912_000, cogs_iqd: null, services_snapshot: PACKAGES[0].snapshot },
    { qty: 1, line_total_iqd: 936_000, net_goods_iqd: 936_000, retained_revenue_iqd: 936_000, cogs_iqd: C, services_snapshot: PACKAGES[3].snapshot }] }] as never);
  assert.deepEqual([info.anchor_reduction_iqd, info.pro_services_discount_iqd, info.printer_cogs_iqd, info.printer_margin_iqd], [48_000 + 24_000, 24_000, null, null]);
});

test('the screens: /summary carries «ربح الخدمات» on the totals, the order and the product; the order sheet says which rule governs it', async () => {
  const s = investorSetup();
  await fundedContract(s);
  await sale(s, 'c', { unit: 1_093_000, snapshot: PACKAGES[2].snapshot });
  await sale(s, 'old', { unit: 960_000, snapshot: PACKAGES[1].snapshot, deliveredAt: BEFORE });
  await syncInvestorOrder(s.db, 'c'); await syncInvestorOrder(s.db, 'old');
  const sum = await json(await get(s.app, '/w/summary?from=2026-11-01&to=2026-11-30'));
  assert.equal(sum.totals.services_profit_iqd, 181_000 + 48_000);
  assert.equal(sum.orders.find((o: { id: string }) => o.id === 'c').services_profit_iqd, 181_000);
  assert.equal(sum.products[0].services_profit_iqd, 229_000);
  assert.equal(sum.printer_part_from_day, PRINTER_PART_FROM_DAY);
  assert.deepEqual([sum.printer_breakdown.printer_net_iqd, sum.printer_breakdown.printer_margin_iqd], [2 * OWN, 2 * (OWN - C)]);
  // The investor column: 35% of the printer part for the order under the rule, of the whole line for the one before it.
  assert.equal(sum.orders.find((o: { id: string }) => o.id === 'c').investor_iqd, 74_200);
  assert.equal(sum.orders.find((o: { id: string }) => o.id === 'old').investor_iqd, share(960_000 - C));
  const sheet = await json(await get(s.app, '/w/orders/c')), before = await json(await get(s.app, '/w/orders/old'));
  assert.deepEqual([sheet.printer_part_rule, before.printer_part_rule, sheet.lines[0].services_profit_iqd, sheet.totals.investor_iqd], [true, false, 181_000, 74_200]);
  const csv = await (await get(s.app, '/w/export.csv?from=2026-11-01&to=2026-11-30&view=orders')).text();
  assert.ok(csv.split('\r\n')[0].includes('"retained_revenue_iqd","services_profit_iqd","cogs_iqd"'));
});

// ───────────────────────────────────────────────────────────── the review of 2026-11-20

async function lossContract(s: S, lossBps: number, cost: number) {
  const body = { operation_id: crypto.randomUUID(), incoming_id: 'inc', user_id: 'investor', name: 'تمويل طابعات', principal_iqd: 12 * cost, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: lossBps };
  assert.equal((await post(s.app, '/i/contracts', body)).status, 200);
  assert.equal((await post(s.app, `/i/contracts/${body.operation_id}/funding`, { operation_id: crypto.randomUUID(), amount_iqd: 12 * cost, payment_day: baghdadDay(), reference: 'cash' })).status, 200);
}
async function costlySale(s: S, id: string, cost: number, o: { unit: number; snapshot: string | null; shipping?: number }) {
  const total = o.unit + (o.shipping ?? 0);
  s.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1500,?,?,?,?,?)`).run(id, o.unit, total, total, o.shipping ?? 0, AFTER, AFTER);
  s.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis,services_snapshot) VALUES (?,?,'xpa2','طابعة',1,?,?,?,'snapshot',?)`).run(`${id}-item`, id, o.unit, o.unit, cost, o.snapshot);
  s.raw.prepare("INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,'lot','base','',1,?,?,?)").run(`${id}-a`, id, `${id}-item`, cost, cost, `${id}:lot`);
  s.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES (?,?,'customer',?,?,'admin',?)").run(`${id}-collection`, id, total, baghdadDay(), new Date().toISOString());
  await s.db.batch([
    ...journalPlan(s.db, { key: `sale:${id}`, day: baghdadDay(), title: 'Sale', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '1100', debit: total }, { account: '4000', credit: total }]).statements,
    ...journalPlan(s.db, { key: `cogs:${id}`, day: baghdadDay(), title: 'COGS', source: 'order', sourceId: id, actor: 'admin' }, [{ account: '5000', debit: cost }, { account: '1200', credit: cost }]).statements,
  ]);
  await syncInvestorOrder(s.db, id, { actor: 'admin' });
  return (await investorOrderSplit(s.db, id)).allocations[0];
}
const lossEvents = (s: S) => count(s.raw, "SELECT COUNT(*) n FROM investor_finance_events WHERE kind IN ('loss','loss_correction')");

for (const lossBps of [0, 10000]) {
  test(`the investor's own money (loss share ${lossBps / 100}%): a Smart printer of cost 930,000 sold at 960,000 returns the whole 930,000 and records no loss; its profit share is 0`, async () => {
    const s = investorSetup(930_000); await lossContract(s, lossBps, 930_000);
    const a = await costlySale(s, 'thin', 930_000, { unit: 960_000, snapshot: PACKAGES[1].snapshot });
    assert.deepEqual([a.capital_iqd, a.profit_iqd, a.loss_iqd, a.raw_loss_iqd], [930_000, 0, 0, 0]);
    assert.deepEqual([JSON.parse(a.snapshot).revenue, JSON.parse(a.snapshot).profit], [912_000, -18_000], 'the printer part is below the cost: nothing to share');
    assert.equal(lossEvents(s), 0, 'a sale above cost is no loss');
    assert.deepEqual(row(s.raw, "SELECT profit_iqd,capital_iqd,loss_iqd FROM investor_allocation_results WHERE allocation_id='thin-a'"), { profit_iqd: 0, capital_iqd: 930_000, loss_iqd: 0 });
  });
}

test('the investor’s own money: with 25,000 of delivery income the same unit returns 930,000 and shares 35% of 7,000', async () => {
  const s = investorSetup(930_000); await lossContract(s, 10000, 930_000);
  const a = await costlySale(s, 'delivery', 930_000, { unit: 960_000, snapshot: PACKAGES[1].snapshot, shipping: 25_000 });
  assert.deepEqual([a.capital_iqd, a.profit_iqd, a.loss_iqd], [930_000, 2_450, 0]);
  assert.equal(lossEvents(s), 0);
});

test('the investor’s own money: a real loss is what it always was — the WHOLE line below the cost (sold at 960,000, cost 980,000)', async () => {
  const s = investorSetup(980_000); await lossContract(s, 10000, 980_000);
  const a = await costlySale(s, 'loss', 980_000, { unit: 960_000, snapshot: PACKAGES[1].snapshot });
  // Exactly the figures of the same sale without services on the line: 960,000 of capital back, a 20,000 loss.
  const t = investorSetup(980_000); await lossContract(t, 10000, 980_000);
  const plain = await costlySale(t, 'loss', 980_000, { unit: 960_000, snapshot: null });
  assert.deepEqual([a.capital_iqd, a.profit_iqd, a.raw_loss_iqd], [960_000, 0, 20_000]);
  assert.deepEqual([a.capital_iqd, a.profit_iqd, a.raw_loss_iqd, a.loss_iqd], [plain.capital_iqd, plain.profit_iqd, plain.raw_loss_iqd, plain.loss_iqd]);
});

test('a 10% code costs the printer part the same stored on the line or on the order', async () => {
  const s = investorSetup();
  await fundedContract(s);
  await sale(s, 'on-line', { unit: 960_000, snapshot: PACKAGES[1].snapshot, coupon: 96_000 });
  await sale(s, 'on-order', { unit: 960_000, snapshot: PACKAGES[1].snapshot, orderCoupon: 96_000 });
  const net = async (id: string) => (await participantNetProfit(s.db, await getOrderProfitBase(s.db, id))).get(`${id}-item`);
  assert.equal(await net('on-line'), 820_800 - C);
  assert.equal(await net('on-order'), 820_800 - C);
  await syncInvestorOrder(s.db, 'on-line'); await syncInvestorOrder(s.db, 'on-order');
  const [a, b] = [(await investorOrderSplit(s.db, 'on-line')).allocations[0], (await investorOrderSplit(s.db, 'on-order')).allocations[0]];
  assert.deepEqual([a.profit_iqd, a.capital_iqd], [share(820_800 - C), C]);
  assert.deepEqual([b.profit_iqd, b.capital_iqd], [a.profit_iqd, a.capital_iqd]);
});

test('placed before the first day, delivered after it: the investor keeps the whole line as the base', async () => {
  const s = investorSetup();
  await fundedContract(s);
  await sale(s, 'straddle', { unit: 1_093_000, snapshot: PACKAGES[2].snapshot, createdAt: BEFORE, deliveredAt: AFTER });
  await syncInvestorOrder(s.db, 'straddle');
  const a = (await investorOrderSplit(s.db, 'straddle')).allocations[0];
  assert.equal(a.profit_iqd, share(1_093_000 - C));
  assert.equal(JSON.parse(a.snapshot).printer_part, undefined);
});

test('the statement’s asterisk: a wage whose base is recomputed later still carries printer_part in its snapshot', async () => {
  const x = await wageSetup('revenue_percent', 1000);
  await x.order('o', 960_000, PACKAGES[1].snapshot);
  await x.drain();
  assert.equal(JSON.parse(String(x.wage('o').snapshot)).printer_part, true);
  // Lose the mark (a row written by an older path), change the base, recompute: the mark is written back with the base.
  x.raw.exec("UPDATE finance_order_costs SET snapshot=json_remove(snapshot,'$.printer_part') WHERE order_id='o'; UPDATE order_items SET line_total_iqd=950000, unit_price_iqd=950000 WHERE order_id='o'; UPDATE orders SET subtotal_iqd=950000,total_iqd=950000,due_on_delivery_iqd=950000 WHERE id='o'");
  await reconcileEffectiveWages(x.env.DB, 'o');
  const w = x.wage('o');
  assert.equal(w.amount, Math.floor(((950_000 - 48_000) * 1000) / 10000));
  assert.equal(JSON.parse(String(w.snapshot)).printer_part, true);
});
