/**
 * Services S-P2 (DECISIONS row 238 decision 5; spec §6.11, §13.5) — a trade-in credit is a payment,
 * not a discount, in the owner's profit report:
 *
 *   - an S-P2 credit whose old device is stock at cost = the credit is shown (`trade_in_credit_iqd`)
 *     and NOT subtracted from net profit — its margin appears when the device is resold;
 *   - a credit with no device in stock (before S-P2) is still subtracted, on its own line;
 *   - a credit given back by a return reverses the returned sale's credit part in the refunds;
 *   - the three parts add up to the old order-level residual, to the dinar;
 *   - the workspace overlay deducts no stocked credit either; the owner's P&L sees the resale.
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/sv2_p2_finance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp } from './fixtures/app';
import { adminFinanceReportRoutes, resetFinanceSchemaMemo } from '../worker/routes/adminFinanceReport';
import { reportAdjustments } from '../worker/lib/financeReportOverlay';
import { OWNER, adminApp, approvedAndOrdered, delivered, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const baghdadDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
async function summary(raw: DatabaseSync) {
  resetFinanceSchemaMemo();
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/finance/report', adminFinanceReportRoutes));
  const res = await get(app, `/api/admin/finance/report/summary?from=${baghdadDay(-3)}&to=${baghdadDay(0)}&granularity=range`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.totals as Record<string, number>;
}

/** The P1S bought with the credit, delivered: the old A1 is stock at cost = the credit. */
async function completed(raw: DatabaseSync) {
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  await delivered(raw, orderId);
  const credit = row<{ credit_iqd: number }>(raw, 'SELECT credit_iqd FROM trade_in_requests WHERE id = ?', id)!.credit_iqd;
  return { id, orderId, credit };
}

test('an S-P2 credit with its device in stock is shown and not subtracted; the order’s parts add up to the old residual', async () => {
  const raw = seed();
  const t = await completed(raw);
  const totals = await summary(raw);
  assert.equal(totals.trade_in_credit_iqd, t.credit);
  assert.equal(totals.legacy_trade_in_credit_iqd, 0);
  assert.equal(totals.coupon_discount_iqd, 0);
  // Net profit does not lose the credit: the device on the shelf is worth it.
  assert.equal(
    totals.net_profit_iqd,
    totals.gross_profit_iqd + totals.shipping_collected_iqd + totals.cod_tax_collected_iqd - totals.points_redeemed_iqd - totals.coupon_discount_iqd - totals.legacy_trade_in_credit_iqd - totals.operating_expenses_iqd
  );
  // The workspace overlay (report-only deductions) deducts no stocked credit either.
  const overlay = (await reportAdjustments(asD1(raw), [t.orderId])).get(t.orderId)!;
  assert.deepEqual([overlay.coupon_iqd, overlay.trade_in_credit_iqd], [0, t.credit]);
});

test('a legacy credit with no device in stock stays subtracted, on its own line; an ordinary coupon is unchanged', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const now = new Date().toISOString();
  raw.exec(`
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope, trade_in_id)
      VALUES ('cpn_leg', 'TILEG0001', 'fixed_iqd', 200000, 0, 1, 1, 0, '${now}', 'cust', 'product', '${id}'),
             ('cpn_plain', 'PLAIN10', 'fixed_iqd', 10000, 0, 100, 1, 1, '${now}', NULL, 'order', NULL);
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at,coupon_snapshot,seller_type)
      VALUES ('ORD-LEG','cust','delivered','delivered','{}','standard','{}','cash',1500000,0,1400,1300000,0,'${now}','${now}','${now}',
              '{"coupon_id":"cpn_leg","discount_iqd":200000}','levonis'),
             ('ORD-PLAIN','cust','delivered','delivered','{}','standard','{}','cash',100000,0,1400,90000,0,'${now}','${now}','${now}',
              '{"coupon_id":"cpn_plain","discount_iqd":10000}','levonis');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids)
      VALUES ('oi_leg','ORD-LEG','p_p1s','Bambu Lab P1S','','',1,1500000,1500000,'','[]'),
             ('oi_plain','ORD-PLAIN','p_p1s','Bambu Lab P1S','','',1,100000,100000,'','[]');
  `);
  const totals = await summary(raw);
  assert.deepEqual([totals.legacy_trade_in_credit_iqd, totals.coupon_discount_iqd, totals.trade_in_credit_iqd], [200_000, 10_000, 0]);
  const overlay = await reportAdjustments(asD1(raw), ['ORD-LEG', 'ORD-PLAIN']);
  assert.deepEqual([overlay.get('ORD-LEG')!.coupon_iqd, overlay.get('ORD-LEG')!.trade_in_credit_iqd, overlay.get('ORD-PLAIN')!.coupon_iqd], [200_000, 0, 10_000]);
});

test('a credit given back by a return reverses the returned sale’s credit part in the refunds, once', async () => {
  const raw = seed();
  const t = await completed(raw);
  const line = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_p1s'", t.orderId)!;
  raw.prepare(
    `INSERT INTO return_cases (id, order_id, order_item_id, user_id, qty, reason, state, within_window, delivered_at_snapshot)
     VALUES ('ret_fin', ?, ?, 'cust', 1, 'defective', 'inspected', 1, ?)`
  ).run(t.orderId, line.id, new Date().toISOString());
  const before = await summary(raw);
  const res = await post(adminApp(raw, OWNER), '/api/returns/admin/ret_fin/transition', { to: 'resolved', resolution: 'refund' });
  assert.equal(res.status, 200, await res.clone().text());
  const after = await summary(raw);
  assert.equal(after.trade_in_reissued_iqd, t.credit);
  assert.ok(after.refunded_revenue_iqd - before.refunded_revenue_iqd >= t.credit, `${before.refunded_revenue_iqd} → ${after.refunded_revenue_iqd}`);
  // The parts still add up: costed + uncosted + estimated = revenue.
  assert.equal(after.costed_revenue_iqd + after.uncosted_revenue_iqd + after.estimated_revenue_iqd, after.revenue_iqd);
});

test('the owner’s P&L sees the resale of a traded-in device at a cost = the credit', async () => {
  const raw = seed();
  const t = await completed(raw);
  // The hidden draft is priced by the owner and sold; its allocation eats the trade-in lot.
  const now = new Date().toISOString();
  raw.exec(`
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at,seller_type)
      VALUES ('ORD-RESALE','staff','delivered','delivered','{}','standard','{}','cash',450000,0,1400,450000,0,'${now}','${now}','${now}','levonis');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids)
      VALUES ('oi_resale','ORD-RESALE','prd_ti_${t.id}','Used A1','','',1,450000,450000,'','[]');
    INSERT INTO order_item_inventory_allocations (id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES ('al_resale','ORD-RESALE','oi_resale','ilot_ti_${t.id}','base',1,${t.credit},${t.credit},'resale:${t.id}');
  `);
  const pnl = (await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/pnl'))).pnl;
  assert.deepEqual(pnl.resold, { count: 1, revenue_iqd: 450_000, cogs_iqd: t.credit, margin_iqd: 450_000 - t.credit });
});
