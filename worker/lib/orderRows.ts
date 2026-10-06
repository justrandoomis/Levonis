/**
 * THE TWO ROWS EVERY PLATFORM ORDER IS MADE OF — written in one place.
 *
 * The cart checkout (`POST /api/orders`, worker/routes/orders.ts) and the
 * Quick Buy finalisation (worker/lib/quickBuy/finalize.ts) both create
 * ordinary platform orders that every downstream reader — the admin board,
 * stages, finance, invoices, returns, warranty — must treat identically. A
 * second hand-written INSERT would drift the first time either side gained a
 * column, so both build their statements here. The SQL of an ordinary order is
 * byte-for-byte the statement checkout has always run; optional columns are
 * appended only when a caller supplies them (docs/GIFTS_QUICK_BUY.md D10, D15).
 */
import { COST_BASIS, type CostBasis } from './financeLedger';
import type { PhysicalDimensions } from './physicalDimensions';

type Extra = Record<string, string | number | null>;

const extraColumns = (extra: Extra | undefined) => {
  const keys = Object.keys(extra ?? {}).filter((k) => /^[a-z_]+$/.test(k));
  return {
    names: keys.map((k) => `, ${k}`).join(''),
    marks: keys.map(() => ', ?').join(''),
    values: keys.map((k) => (extra as Extra)[k]),
  };
};

export interface OrderRow {
  id: string;
  user_id: string;
  address_snapshot: string;
  delivery_method_id: string;
  delivery_method_snapshot: string;
  payment_method_id: string;
  subtotal_iqd: number;
  shipping_iqd: number;
  cod_tax_iqd: number;
  points_discount_iqd: number;
  wallet_applied_iqd: number;
  wallet_applied_usd_cents: number;
  exchange_rate: number;
  total_iqd: number;
  due_on_delivery_iqd: number;
  client_idempotency_key: string;
  membership_tier_snapshot: string;
  delivery_waived: number;
  priority: number;
  coupon_snapshot: string | null;
  merchandise_iqd: number;
  support_snapshot: string | null;
  shipping_type: string;
  membership_gift: string;
  referral_delivery_waived: number;
  fulfillment_service: string;
  priority_due_at: string | null;
  bnpl_due_iqd: number;
  bnpl_due_at: string | null;
  benefit_version_id: number | null;
  membership_discount_iqd: number;
  shipping_before_benefit_iqd: number;
  shipping_benefit_iqd: number;
  cod_tax_before_exemption_iqd: number;
  cod_tax_exemption_iqd: number;
  benefit_snapshot: string;
  delivery_day_schedulable: number;
  delivery_day_window_end: string | null;
  delivery_due_day: string | null;
  delivery_day_source: string | null;
  gini_order_no: string;
  gini_paid_iqd: number;
  gini_state: string;
  gini_hold_until: string | null;
  created_at: string;
  updated_at: string;
}

/** `status` is always 'pending': every order starts at `received` (orderStages.ts). */
export function orderInsertStatement(db: D1Database, o: OrderRow, extra?: Extra): D1PreparedStatement {
  const x = extraColumns(extra);
  return db.prepare(
    `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, cod_tax_iqd, points_discount_iqd, wallet_applied_iqd,
         wallet_applied_usd_cents, exchange_rate, total_iqd, due_on_delivery_iqd, client_idempotency_key,
         membership_tier_snapshot, delivery_waived, priority, coupon_snapshot, merchandise_iqd,
         support_snapshot, shipping_type, membership_gift, referral_delivery_waived,
         fulfillment_service, priority_due_at, bnpl_due_iqd, bnpl_due_at,
         benefit_version_id, membership_discount_iqd, shipping_before_benefit_iqd, shipping_benefit_iqd,
         cod_tax_before_exemption_iqd, cod_tax_exemption_iqd, benefit_snapshot,
         delivery_day_schedulable, delivery_day_window_end, delivery_due_day, delivery_day_source,
         gini_order_no, gini_paid_iqd, gini_state, gini_hold_until,
         created_at, updated_at${x.names})
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${x.marks})`
  ).bind(
    o.id, o.user_id, o.address_snapshot, o.delivery_method_id, o.delivery_method_snapshot,
    o.payment_method_id, o.subtotal_iqd, o.shipping_iqd, o.cod_tax_iqd, o.points_discount_iqd, o.wallet_applied_iqd,
    o.wallet_applied_usd_cents, o.exchange_rate, o.total_iqd, o.due_on_delivery_iqd, o.client_idempotency_key,
    o.membership_tier_snapshot, o.delivery_waived, o.priority, o.coupon_snapshot, o.merchandise_iqd,
    o.support_snapshot, o.shipping_type, o.membership_gift, o.referral_delivery_waived,
    o.fulfillment_service, o.priority_due_at, o.bnpl_due_iqd, o.bnpl_due_at,
    o.benefit_version_id, o.membership_discount_iqd, o.shipping_before_benefit_iqd, o.shipping_benefit_iqd,
    o.cod_tax_before_exemption_iqd, o.cod_tax_exemption_iqd, o.benefit_snapshot,
    o.delivery_day_schedulable, o.delivery_day_window_end, o.delivery_due_day, o.delivery_day_source,
    o.gini_order_no, o.gini_paid_iqd, o.gini_state, o.gini_hold_until,
    o.created_at, o.updated_at,
    ...x.values
  );
}

export interface OrderItemRow {
  id: string;
  /** NULL for a MYSTERY SPOOL, on purpose (§7.7): the `ORDER_ITEMS_SELECT`
   *  join to `products` then yields no slug, `/units` finds nothing, the
   *  invoice and courier payload say the offer's name — no filtering code. The
   *  inventory move still names the real product. */
  product_id: string | null;
  name: string;
  image: string;
  variant: string;
  option_id: string;
  option_value_ids: string[];
  color_id: string;
  shipping_method_id: string;
  qty: number;
  unit: number;
  line: number;
  /** NULL for a mystery spool (§6.2, §8.2 row 19); its share is `component_value_iqd`. */
  pricing_snapshot: string | null;
  warranty_snapshot: string | null;
  transport_snapshot: string | null;
  bundle_parent_item_id?: string | null;
  bundle_component_id?: string | null;
  component_value_iqd?: number | null;
  component_alloc_iqd?: number | null;
  /** §19 — what the membership took off this line, and under which rule,
   *  frozen per item so a return or a question about one product answers from
   *  the row itself. */
  membership_discount_iqd: number;
  membership_rule_id: string | null;
  /**
   * THE COST OF GOODS SOLD, AS IT WAS AT THIS INSTANT (migration 0095), taken
   * from the same resolver output that priced the line — never re-read. A line
   * that set neither field (the mystery spool) falls through to 'unrecorded',
   * so the dashboard says "unknown" rather than "pure profit". `orderPublic`
   * builds customer items from an explicit field list, so this never reaches a
   * customer payload.
   */
  cost_iqd?: number | null;
  cost_basis?: CostBasis;
  physical_dimensions: PhysicalDimensions;
}

/** The ONLY writer of `order_items.warranty_snapshot` (tests/extendedWarranty.test.ts). */
export function orderItemInsertStatement(db: D1Database, orderId: string, it: OrderItemRow, extra?: Extra): D1PreparedStatement {
  const x = extraColumns(extra);
  return db.prepare(
    `INSERT INTO order_items (id, order_id, product_id, name_snapshot, image_snapshot, option_snapshot,
           option_id, option_value_ids, color_id, shipping_method_id, qty, unit_price_iqd, line_total_iqd,
           pricing_snapshot, warranty_snapshot, transport_snapshot,
           bundle_parent_item_id, bundle_component_id, component_value_iqd, component_alloc_iqd,
           membership_discount_iqd, membership_rule_id, cost_iqd, cost_basis,
           net_weight_g, width_mm, depth_mm, height_mm,
           package_weight_g, package_width_mm, package_depth_mm, package_height_mm${x.names})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?${x.marks})`
  ).bind(
    it.id, orderId, it.product_id,
    it.name, it.image, it.variant,
    it.option_id, JSON.stringify(it.option_value_ids), it.color_id, it.shipping_method_id,
    it.qty, it.unit, it.line,
    it.pricing_snapshot, it.warranty_snapshot, it.transport_snapshot,
    it.bundle_parent_item_id ?? null, it.bundle_component_id ?? null,
    it.component_value_iqd ?? null, it.component_alloc_iqd ?? null,
    it.membership_discount_iqd, it.membership_rule_id,
    it.cost_iqd ?? null,
    it.cost_basis ?? COST_BASIS.unrecorded,
    it.physical_dimensions.net_weight_g,
    it.physical_dimensions.width_mm,
    it.physical_dimensions.depth_mm,
    it.physical_dimensions.height_mm,
    it.physical_dimensions.package_weight_g,
    it.physical_dimensions.package_width_mm,
    it.physical_dimensions.package_depth_mm,
    it.physical_dimensions.package_height_mm,
    ...x.values
  );
}
