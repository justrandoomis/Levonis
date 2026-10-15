/**
 * THE REPORT-ONLY DEDUCTIONS OF «الأرباح والتكاليف» (P-A fixes F4 and F5;
 * owner brief 2026-10-09, "Accounting Currency": revenue is what the customer
 * actually paid, after discounts and refunds).
 *
 * Two amounts the workspace never subtracted from an order's revenue:
 *   F4  the ORDER-LEVEL coupon — the part of the coupon recorded on the order
 *       that no order line carries. Since Services V2 S-P0a checkout writes a
 *       code's goods part onto `order_items.coupon_discount_iqd`, which is
 *       already inside `calculateGoods` and is not counted twice; what is left
 *       here is a delivery discount, a trade-in credit, or the whole coupon of
 *       an order written before the cut-over;
 *   F5  price-protection credits paid back to the customer on a line
 *       (`price_protection_claims`, state 'credited').
 *
 * They are shown as DEDUCTIONS IN THE REPORT ONLY (owner question Q3, default
 * "report only"). `calculateGoods`, `getOrderProfitBase(s)` and every writer
 * that reads them — investor accrual, staff wages, participants, percentage
 * costs, workspace postings, reconciliation — are untouched, so no recorded
 * investor share, wage or journal entry moves. That is a test
 * (tests/financeOverlayNoSettlement.test.ts), and so is the rule that only
 * worker/routes/adminFinanceWorkspace.ts imports this module.
 *
 * Read only. Two `json_each`-bound reads (the pattern of
 * `getOrderProfitBases`), whatever the number of orders.
 */
type Row = Record<string, unknown>;
const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
};

export interface ReportAdjustments {
  /** Order-level coupon not carried by any line, ≥ 0 — a trade-in credit whose device is stock excluded (S-P2). */
  coupon_iqd: number;
  /**
   * S-P2 (DECISIONS row 238, decision 5): the order's trade-in credit whose old device is in stock
   * at cost = the credit — a payment in kind, shown and NOT deducted; its margin appears when the
   * device is resold. 0 on a database without 0192.
   */
  trade_in_credit_iqd: number;
  /**
   * S-P2 (review F-12): the part of that in-stock credit a RETURN gave back (`trade_in_credit_reissues`,
   * reason 'returned'), per returned line — the cash refund is net of it, so the line's retained
   * revenue still carries it; deducted here so this report and the period report agree, and the
   * next sale the same credit pays for is not revenue twice. A legacy credit is already deducted
   * as a coupon above.
   */
  trade_in_credit_returned_by_line: Map<string, number>;
  trade_in_credit_returned_iqd: number;
  /** Credited price-protection amount per order line id. */
  price_protection_by_line: Map<string, number>;
  /** Their sum. */
  price_protection_iqd: number;
}

export async function reportAdjustments(db: D1Database, orderIds: readonly string[]): Promise<Map<string, ReportAdjustments>> {
  const out = new Map<string, ReportAdjustments>();
  const ids = [...new Set(orderIds)];
  for (const id of ids) out.set(id, { coupon_iqd: 0, trade_in_credit_iqd: 0, trade_in_credit_returned_by_line: new Map(), trade_in_credit_returned_iqd: 0, price_protection_by_line: new Map(), price_protection_iqd: 0 });
  if (!ids.length) return out;
  const bound = JSON.stringify(ids);
  const residual = `MAX(0, COALESCE(json_extract(o.coupon_snapshot, '$.discount_iqd'), o.coupon_discount_iqd, 0)
                       - COALESCE((SELECT SUM(i.coupon_discount_iqd) FROM order_items i WHERE i.order_id = o.id), 0))`;
  const couponRows = () =>
    db
      .prepare(
        `SELECT o.id order_id, ${residual} coupon_iqd,
                EXISTS (SELECT 1 FROM coupons tc JOIN trade_in_stock ts ON ts.request_id = tc.trade_in_id
                         WHERE tc.id = json_extract(o.coupon_snapshot, '$.coupon_id')) stocked
           FROM orders o WHERE o.id IN (SELECT value FROM json_each(?))`
      )
      .bind(bound)
      .all<Row>()
      .catch((e: unknown) => {
        // A database without 0192: no trade-in stock, every credit is deducted as before.
        if (!/no such table\b/i.test(e instanceof Error ? e.message : String(e))) throw e;
        return db
          .prepare(`SELECT o.id order_id, ${residual} coupon_iqd, 0 stocked FROM orders o WHERE o.id IN (SELECT value FROM json_each(?))`)
          .bind(bound)
          .all<Row>();
      });
  const returnedRows = () =>
    db
      .prepare(
        `SELECT rc.order_id, rc.order_item_id, COALESCE(SUM(x.amount_iqd), 0) amount_iqd
           FROM trade_in_credit_reissues x JOIN return_cases rc ON rc.id = x.return_case_id
          WHERE x.reason = 'returned' AND rc.order_id IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM trade_in_stock ts WHERE ts.request_id = x.request_id)
          GROUP BY rc.order_id, rc.order_item_id`
      )
      .bind(bound)
      .all<Row>()
      .catch((e: unknown) => {
        // A database without 0192: nothing was given back.
        if (!/no such table\b/i.test(e instanceof Error ? e.message : String(e))) throw e;
        return { results: [] as Row[] };
      });
  const [coupons, claims, returned] = await Promise.all([
    couponRows(),
    db
      .prepare(
        `SELECT order_id, order_item_id, COALESCE(SUM(credited_iqd), 0) credited_iqd
           FROM price_protection_claims
          WHERE state = 'credited' AND order_id IN (SELECT value FROM json_each(?))
          GROUP BY order_id, order_item_id`
      )
      .bind(bound)
      .all<Row>(),
    returnedRows(),
  ]);
  for (const r of returned.results ?? []) {
    const entry = out.get(String(r.order_id));
    if (!entry) continue;
    const amount = Math.max(0, n(r.amount_iqd));
    const line = String(r.order_item_id);
    entry.trade_in_credit_returned_by_line.set(line, (entry.trade_in_credit_returned_by_line.get(line) ?? 0) + amount);
    entry.trade_in_credit_returned_iqd += amount;
  }
  for (const r of coupons.results ?? []) {
    const entry = out.get(String(r.order_id));
    if (!entry) continue;
    const amount = Math.max(0, n(r.coupon_iqd));
    if (n(r.stocked) === 1) entry.trade_in_credit_iqd = amount;
    else entry.coupon_iqd = amount;
  }
  for (const r of claims.results ?? []) {
    const entry = out.get(String(r.order_id));
    if (!entry) continue;
    const amount = Math.max(0, n(r.credited_iqd));
    const line = String(r.order_item_id);
    entry.price_protection_by_line.set(line, (entry.price_protection_by_line.get(line) ?? 0) + amount);
    entry.price_protection_iqd += amount;
  }
  return out;
}
