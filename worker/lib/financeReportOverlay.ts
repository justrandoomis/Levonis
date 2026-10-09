/**
 * THE REPORT-ONLY DEDUCTIONS OF «الأرباح والتكاليف» (P-A fixes F4 and F5;
 * owner brief 2026-10-09, "Accounting Currency": revenue is what the customer
 * actually paid, after discounts and refunds).
 *
 * Two amounts the workspace never subtracted from an order's revenue:
 *   F4  the ORDER-LEVEL coupon — the part of the coupon recorded on the order
 *       that no order line carries (`order_items.coupon_discount_iqd` has no
 *       writer yet, so today it is the whole coupon; a line share, once one
 *       exists, is already inside `calculateGoods` and is not counted twice);
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
  /** Order-level coupon not carried by any line, ≥ 0. */
  coupon_iqd: number;
  /** Credited price-protection amount per order line id. */
  price_protection_by_line: Map<string, number>;
  /** Their sum. */
  price_protection_iqd: number;
}

export async function reportAdjustments(db: D1Database, orderIds: readonly string[]): Promise<Map<string, ReportAdjustments>> {
  const out = new Map<string, ReportAdjustments>();
  const ids = [...new Set(orderIds)];
  for (const id of ids) out.set(id, { coupon_iqd: 0, price_protection_by_line: new Map(), price_protection_iqd: 0 });
  if (!ids.length) return out;
  const bound = JSON.stringify(ids);
  const [coupons, claims] = await Promise.all([
    db
      .prepare(
        `SELECT o.id order_id,
                MAX(0, COALESCE(json_extract(o.coupon_snapshot, '$.discount_iqd'), o.coupon_discount_iqd, 0)
                       - COALESCE((SELECT SUM(i.coupon_discount_iqd) FROM order_items i WHERE i.order_id = o.id), 0)) coupon_iqd
           FROM orders o WHERE o.id IN (SELECT value FROM json_each(?))`
      )
      .bind(bound)
      .all<Row>(),
    db
      .prepare(
        `SELECT order_id, order_item_id, COALESCE(SUM(credited_iqd), 0) credited_iqd
           FROM price_protection_claims
          WHERE state = 'credited' AND order_id IN (SELECT value FROM json_each(?))
          GROUP BY order_id, order_item_id`
      )
      .bind(bound)
      .all<Row>(),
  ]);
  for (const r of coupons.results ?? []) {
    const entry = out.get(String(r.order_id));
    if (entry) entry.coupon_iqd = Math.max(0, n(r.coupon_iqd));
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
