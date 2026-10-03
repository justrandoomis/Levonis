import { allocateExact } from './operations';
import { badRequest } from './http';
export async function operationsReport(db: D1Database, from: string, to: string) {
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0 || days > 365) throw badRequest('اختر فترة لا تتجاوز سنة');
  const [orders, expenses, suppliers, wallets, centers, refunds] = await Promise.all([
    db
      .prepare(
        `WITH item_cost AS (
      SELECT i.*,EXISTS(SELECT 1 FROM order_items child WHERE child.bundle_parent_item_id=i.id) AS parent,
       CASE WHEN EXISTS(SELECT 1 FROM order_item_inventory_allocations a WHERE a.order_item_id=i.id AND a.released_at IS NULL) THEN 0 ELSE 1 END AS estimated,
       CASE WHEN EXISTS(SELECT 1 FROM order_item_inventory_allocations a WHERE a.order_item_id=i.id AND a.released_at IS NULL) THEN
        CASE WHEN EXISTS(SELECT 1 FROM order_item_inventory_allocations a WHERE a.order_item_id=i.id AND a.released_at IS NULL AND a.cogs_iqd IS NULL) OR (SELECT SUM(qty) FROM order_item_inventory_allocations a WHERE a.order_item_id=i.id AND a.released_at IS NULL)<i.qty THEN NULL ELSE (SELECT SUM(cogs_iqd) FROM order_item_inventory_allocations a WHERE a.order_item_id=i.id AND a.released_at IS NULL) END
       ELSE i.cost_iqd*i.qty END AS cogs
      FROM order_items i),costs AS (SELECT order_id,SUM(CASE WHEN state IN ('due','approved') THEN amount_iqd ELSE 0 END) AS direct,SUM(CASE WHEN state='pending_cost' THEN 1 ELSE 0 END) AS pending FROM finance_order_costs GROUP BY order_id),
      collections AS (SELECT order_id,SUM(amount_iqd) AS collected,SUM(fee_iqd) AS fee FROM finance_collections GROUP BY order_id)
      SELECT o.id,o.delivered_at,o.delivery_provider,o.shipping_iqd,o.shipping_benefit_iqd,o.membership_discount_iqd,o.points_discount_iqd,o.coupon_discount_iqd,o.due_on_delivery_iqd,o.gini_paid_iqd,
       SUM(CASE WHEN i.bundle_parent_item_id IS NULL THEN MAX(0,i.line_total_iqd-i.coupon_discount_iqd-i.membership_discount_iqd) ELSE 0 END)-o.points_discount_iqd AS net_goods_iqd,
       SUM(CASE WHEN i.parent=0 THEN i.qty ELSE 0 END) AS units,SUM(CASE WHEN i.parent=0 AND i.cogs IS NULL THEN 1 ELSE 0 END) AS unknown_lines,
       SUM(CASE WHEN i.parent=0 AND i.cogs IS NOT NULL AND i.estimated=1 THEN 1 ELSE 0 END) AS estimated_lines,
       SUM(CASE WHEN i.parent=0 THEN COALESCE(i.cogs,0) ELSE 0 END) AS cogs_iqd,COALESCE(c.direct,0) AS direct_cost_iqd,COALESCE(c.pending,0) AS pending_costs,
       COALESCE(col.collected,0) AS collected_iqd,COALESCE(col.fee,0) AS courier_fee_iqd,
       (SELECT COALESCE(SUM(e.amount_iqd),0) FROM finance_expense_links l JOIN operating_expenses e ON e.id=l.expense_id WHERE l.order_id=o.id AND e.voided_at IS NULL) AS manual_direct_iqd
      FROM orders o JOIN item_cost i ON i.order_id=o.id LEFT JOIN costs c ON c.order_id=o.id LEFT JOIN collections col ON col.order_id=o.id
      WHERE o.seller_type='levonis' AND o.status='delivered' AND date(o.delivered_at,'+3 hours') BETWEEN ? AND ? GROUP BY o.id ORDER BY o.delivered_at,o.id LIMIT 5001`,
      )
      .bind(from, to)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT e.id,e.amount_iqd,l.allocation_basis,l.center_id,l.target_type,l.target_id FROM operating_expenses e LEFT JOIN finance_expense_links l ON l.expense_id=e.id
       WHERE e.voided_at IS NULL AND e.expense_day BETWEEN ? AND ? AND l.order_id IS NULL AND NOT EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.expense_id=e.id)
       AND NOT EXISTS(SELECT 1 FROM finance_collections c WHERE c.expense_id=e.id)`,
      )
      .bind(from, to)
      .all<{
        id: string;
        amount_iqd: number;
        allocation_basis: string | null;
        center_id: string | null;
        target_type: string | null;
        target_id: string | null;
      }>(),
    db
      .prepare(
        `SELECT s.id,s.name,SUM(i.qty_ordered*i.purchase_unit_iqd+l.charges_iqd) AS ordered_total_iqd,SUM(i.qty_received) AS received_units,
      (SELECT COALESCE(SUM(pay.amount_iqd),0) FROM supplier_payments pay JOIN purchase_orders po ON po.id=pay.purchase_id WHERE po.supplier_id=s.id) AS paid_iqd,
      (SELECT COALESCE(SUM(al.credit_iqd-al.debit_iqd),0) FROM accounting_lines al JOIN accounting_entries ae ON ae.id=al.entry_id JOIN purchase_orders po ON po.id=ae.source_id WHERE ae.source_type='purchase' AND ae.state='posted' AND al.account_code='2000' AND po.supplier_id=s.id) AS payable_iqd,
      (SELECT COALESCE(SUM(al.debit_iqd-al.credit_iqd),0) FROM accounting_lines al JOIN accounting_entries ae ON ae.id=al.entry_id JOIN purchase_orders po ON po.id=ae.source_id WHERE ae.source_type='purchase' AND ae.state='posted' AND al.account_code='1300' AND po.supplier_id=s.id) AS prepaid_iqd
      FROM inventory_suppliers s LEFT JOIN purchase_orders p ON p.supplier_id=s.id LEFT JOIN purchase_lines l ON l.purchase_id=p.id LEFT JOIN incoming_inventory i ON i.id=l.incoming_id GROUP BY s.id ORDER BY ordered_total_iqd DESC LIMIT 100`,
      )
      .all(),
    db
      .prepare(
        `SELECT currency,SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END) AS liability_native_units FROM wallet_transactions WHERE status='approved' GROUP BY currency`,
      )
      .all(),
    db
      .prepare(
        `SELECT cc.id,cc.name,
      (SELECT COALESCE(SUM(c.amount_iqd),0) FROM finance_order_costs c WHERE c.center_id=cc.id AND c.state<>'pending_cost' AND c.cost_day BETWEEN ?1 AND ?2)
      -(SELECT COALESCE(SUM(r.amount_iqd),0) FROM finance_cost_reversals r JOIN finance_order_costs c ON c.id=r.cost_id WHERE c.center_id=cc.id AND r.reversal_day BETWEEN ?1 AND ?2) AS rule_cost_iqd,
      (SELECT COALESCE(SUM(e.amount_iqd),0) FROM operating_expenses e JOIN finance_expense_links l ON l.expense_id=e.id WHERE l.center_id=cc.id AND e.voided_at IS NULL AND e.expense_day BETWEEN ?1 AND ?2) AS manual_cost_iqd,
      (SELECT COUNT(*) FROM finance_order_costs c WHERE c.center_id=cc.id AND c.state='pending_cost' AND c.cost_day BETWEEN ?1 AND ?2) AS pending_costs
      FROM finance_cost_centers cc ORDER BY cc.name`,
      )
      .bind(from, to)
      .all(),
    db
      .prepare(
        `SELECT f.*,i.name_snapshot FROM finance_refund_facts f JOIN return_cases r ON r.id=f.case_id JOIN order_items i ON i.id=r.order_item_id WHERE f.refunded_day BETWEEN ? AND ? ORDER BY f.refunded_day,f.case_id LIMIT 1000`,
      )
      .bind(from, to)
      .all(),
  ]);
  const list = orders.results ?? [],
    truncated = list.length > 5000;
  const overhead = list.map(() => 0);
  const eligibility = new Map<string, { products: Set<string>; catalogs: Set<string> }>();
  if (!truncated && list.length) {
    const ids = JSON.stringify(list.map((o) => o.id));
    const [placements, catalogs] = await Promise.all([
      db
        .prepare(
          `SELECT i.order_id,i.product_id,pc.catalog_id FROM order_items i LEFT JOIN product_catalogs pc ON pc.product_id=i.product_id WHERE i.order_id IN (SELECT value FROM json_each(?1))
        UNION SELECT i.order_id,i.product_id,p.category_id FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id IN (SELECT value FROM json_each(?1))
        UNION SELECT i.order_id,i.product_id,p.sub_category_id FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(ids)
        .all<{ order_id: string; product_id: string; catalog_id: string | null }>(),
      db.prepare('SELECT id,parent_id FROM catalogs').all<{ id: string; parent_id: string | null }>(),
    ]);
    const parents = new Map((catalogs.results ?? []).map((c) => [c.id, c.parent_id]));
    for (const p of placements.results ?? []) {
      const entry = eligibility.get(p.order_id) ?? {
        products: new Set<string>(),
        catalogs: new Set<string>(),
      };
      if (p.product_id) entry.products.add(p.product_id);
      let id = p.catalog_id;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        entry.catalogs.add(id);
        id = parents.get(id) ?? null;
      }
      eligibility.set(p.order_id, entry);
    }
  }

  if (!truncated)
    for (const e of expenses.results ?? []) {
      if (!e.allocation_basis || e.allocation_basis === 'none' || list.length === 0) continue;
      const weights = list.map((o) => {
        const eligible = eligibility.get(String(o.id));
        if (e.target_type === 'product' && !eligible?.products.has(e.target_id ?? '')) return 0;
        if (e.target_type === 'catalog' && !eligible?.catalogs.has(e.target_id ?? '')) return 0;
        return e.allocation_basis === 'revenue'
          ? Math.max(0, Number(o.net_goods_iqd))
          : e.allocation_basis === 'units'
            ? Number(o.units)
            : 1;
      });
      if (!weights.some((w) => w > 0)) continue;
      const shares = allocateExact(e.amount_iqd, weights);
      shares.forEach((v, i) => (overhead[i] += v));
    }
  const rows = list.slice(0, 5000).map((o, i) => {
    const gross = Number(o.unknown_lines) > 0 ? null : Number(o.net_goods_iqd) - Number(o.cogs_iqd),
      contribution =
        gross === null || Number(o.pending_costs) > 0
          ? null
          : gross +
            Number(o.shipping_iqd) -
            Number(o.direct_cost_iqd) -
            Number(o.manual_direct_iqd) -
            Number(o.courier_fee_iqd);
    return {
      ...o,
      gross_profit_iqd: gross,
      contribution_profit_iqd: contribution,
      allocated_overhead_iqd: truncated ? null : overhead[i],
      managerial_net_iqd: contribution === null || truncated ? null : contribution - overhead[i],
      collection_difference_iqd:
        Number(o.due_on_delivery_iqd) + Number(o.gini_paid_iqd) - Number(o.collected_iqd),
    };
  });
  return {
    orders: rows,
    truncated,
    range: { from, to },
    suppliers: suppliers.results ?? [],
    wallets: wallets.results ?? [],
    centers: centers.results ?? [],
    refunds: refunds.results ?? [],
    general_expenses_iqd: (expenses.results ?? []).reduce((s, e) => s + e.amount_iqd, 0),
    allocated_overhead_iqd: truncated ? null : overhead.reduce((a, b) => a + b, 0),
    note: 'ربح الطلبات المستلمة خلال الفترة، وتعرض المرتجعات في تاريخها منفصلة. الربح الإداري بعد توزيع المصروفات للمعاينة. التوزيع لا ينشئ مصروفًا ثانيًا. أرصدة المحافظ بعملتها الأصلية.',
  };
}
