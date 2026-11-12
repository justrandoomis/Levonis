/** Every page of «المال والأرباح»; each belongs to one of the five sections (redesign step 2: overview, reports, costs, people, accounting; step 4 adds sections and days). */
export type FinanceSection = 'overview' | 'orders' | 'products' | 'sections' | 'days' | 'missing' | 'monthly' | 'expenses' | 'staff' | 'investors' | 'settlements' | 'accounting';
/** Where an order, a product or a section stands (the server's orderState / groupState, DECISIONS row 316). */
export type FinanceState = 'confirmed' | 'estimated' | 'waiting';
/** An order's cash: nothing due on delivery, all of it recorded as received, part of it, or none yet. */
export type CashState = 'prepaid' | 'recorded' | 'part' | 'not_recorded';

export interface ProfitTotals {
  net_goods_iqd?: number | null;
  retained_revenue_iqd?: number | null;
  cogs_iqd?: number | null;
  gross_profit_iqd?: number | null;
  shipping_income_iqd?: number | null;
  shipping_iqd?: number | null;
  cod_tax_iqd?: number | null;
  courier_fee_iqd?: number | null;
  payment_fee_iqd?: number | null;
  direct_cost_iqd?: number | null;
  wages_iqd?: number | null;
  materials_iqd?: number | null;
  manual_direct_iqd?: number | null;
  contribution_profit_iqd?: number | null;
  /** What the goods, delivery and fees left before promotion and investors: null while a goods cost or a cost that waits on it is unknown. */
  profit_basis_iqd?: number | null;
  promotion_iqd?: number | null;
  unallocated_promotion_iqd?: number | null;
  investor_iqd?: number | null;
  investor_loss_iqd?: number | null;
  owner_net_iqd?: number | null;
  owner_period_net_iqd?: number | null;
  general_expenses_iqd?: number | null;
  allocated_overhead_iqd?: number | null;
  refunded_iqd?: number | null;
  refund_iqd?: number | null;
  collected_iqd?: number | null;
  collection_difference_iqd?: number | null;
  /** P-A F4: the order-level coupon, deducted in this report only (never in investor shares, wages or journals). */
  coupon_iqd?: number | null;
  /** P-A F5: price-protection credits paid back, deducted in this report only. */
  price_protection_iqd?: number | null;
  /** A returned in-stock trade-in credit, deducted with the two above (S-P2, DECISIONS row 313 for the period). */
  trade_in_credit_returned_iqd?: number | null;
  /** `owner_net − coupon − price protection − returned trade-in credit` — «الصافي بعد خصومات التقرير». */
  net_after_report_adjustments_iqd?: number | null;
  /** The period figure, the overview's «صافي حصتك»: the orders after their deductions, minus the period overheads (summary totals only). */
  owner_period_net_after_report_adjustments_iqd?: number | null;
  /** Costs entered in the period for orders still on their way: not in this net, counted on delivery (summary totals only). */
  general_waiting_iqd?: number;
  pending_costs?: number;
  unknown_lines?: number;
  orders_count?: number;
  units?: number;
}

export interface FinanceOrder extends ProfitTotals {
  has_financial_activity?: boolean;
  projected_finance?: ProjectedOrderFinance;
  review_reasons?: ProfitReviewIssue[];
  id: string;
  order_id?: string;
  status: string;
  created_at: string;
  delivered_at?: string;
  customer_name?: string;
  version?: number;
  cost_confidence?: string;
  /** What made the order (0174): the cart, a Quick Buy session, or gifts only. */
  order_kind?: 'normal' | 'quick_buy' | 'gift';
  /** Net sales, delivery and the COD fee: the margin's base (redesign step 4; absent from a server that predates it). */
  revenue_iqd?: number;
  /** Where the order stands and, waiting, for what; its cash (redesign step 4; absent from a server that predates them). */
  finance_state?: FinanceState;
  wait_reason?: FinanceWaitReason | null;
  cash_state?: CashState;
  /** Its lines with a refunded return whose amount nobody recorded: its sales count that refund as 0 (the review of step 4). */
  unknown_refunds?: number;
}

/** §21: the period's delivered orders by what made them; the rows add up to the totals. */
export interface FinanceKindTotals extends ProfitTotals {
  kind: 'normal' | 'quick_buy' | 'gift';
  orders_count: number;
}

export interface FinanceProduct extends ProfitTotals {
  id: string;
  name: string;
  qty: number;
  /** Its lines whose goods cost is the sale-time estimate, not a confirmed price (absent from a server that predates it). */
  estimated_lines?: number;
  level?: 'product' | 'main' | 'sub';
  product_image?: string;
  image_url?: string;
  /** Redesign step 4 (absent from a server that predates it): the pieces the customers kept and those they returned. */
  kept_qty?: number;
  returned_qty?: number;
  /** The orders its lines come from, so a row can open them. */
  order_ids?: string[];
  orders_count?: number;
  finance_state?: FinanceState;
  wait_reason?: FinanceWaitReason | null;
  /** A product's main section (its id; the names come from that section's own row). */
  main_id?: string;
  main_name?: string;
  /** A section's name in each language, from the live section; `name` is the sale's Arabic snapshot. */
  name_ar?: string;
  name_en?: string;
  name_ckb?: string;
  /** Its lines with an unrecorded refund amount (the review of step 4). */
  unknown_refunds?: number;
}
/**
 * What no product and no section carries (the review of step 4): the rest of a coupon larger than the goods, a price
 * protection or a returned trade-in credit no line carries — on the orders, so the products' and sections' tables give it
 * a row of its own and add up to the orders. Null: nothing is left at the order level.
 */
export interface FinanceOrderLevel { coupon_iqd: number; price_protection_iqd: number; trade_in_credit_returned_iqd: number; net_after_report_adjustments_iqd: number | null; order_ids: string[]; orders_count: number }

export interface Promotion {
  id: string;
  month: string;
  title: string;
  currency: string;
  amount: number;
  exchange_rate: number;
  amount_iqd: number;
  enabled: number | boolean;
  version: number;
}

/** Integer US cents keyed `<field>_cents` (design P-A §8); null = incomplete («—»). */
export type UsdCents = Record<string, number | null>;
export interface UsdOrderCents { usd_basis: 'at_time' | 'today'; fx_rate_snapshot: string; cents: UsdCents }
/** `display_usd` of `GET /summary?display=USD` — display only; every IQD field beside it is unchanged. */
export interface DisplayUsdSummary {
  available: boolean;
  today_rate?: string | null;
  at_time_count?: number;
  today_count?: number;
  /** FX-6: lines whose goods cost is at their batches' purchase-time rates. */
  batch_cost_lines?: number;
  approximate?: boolean;
  orders?: Record<string, UsdOrderCents>;
  kinds?: Record<string, UsdCents>;
  products?: Record<string, UsdCents>;
  categories?: { main: Record<string, UsdCents>; sub: Record<string, UsdCents> };
  chart?: { revenue_cents: number; cost_cents: number | null; owner_net_cents: number | null; investor_cents: number | null;
    daily: Record<string, UsdDay>;
    expense_composition: Array<{ key: string; amount_cents: number | null }> };
  totals?: UsdCents;
  /** `known` in cents (null: no complete order); absent from a server that predates it. */
  known?: { revenue_cents: number; cost_cents: number | null; owner_net_cents: number | null; net_after_report_adjustments_cents?: number | null;
    /** Its confirmed and estimated parts, sharing its overhead by revenue as in dinars (absent from a server that predates them). */
    confirmed?: UsdKnownPart; estimated?: UsdKnownPart;
    /** The complete orders' sums in cents and their share of the overheads (the statement's «محسوبة» column in dollars). */
    totals?: UsdCents; general_share_cents?: number; unallocated_share_cents?: number } | null;
  /** `waiting` in cents: the incomplete orders' sums and the rest of the overheads (null: every order is complete; absent from an older server). */
  waiting?: { orders_count: number; totals: UsdCents; general_share_cents: number; unallocated_share_cents: number } | null;
  /** The order-level row of the products and the sections in cents (the review of step 4). */
  order_level?: UsdCents | null;
}
export interface UsdKnownPart { orders_count: number; owner_net_cents: number | null; net_after_report_adjustments_cents: number | null }
/** One day in cents; the deductions and the net after them since redesign step 4 (absent from a server that predates them). */
export interface UsdDay { revenue_cents: number; cost_cents: number | null; owner_net_cents: number | null; investor_cents: number | null;
  deductions_cents?: number; net_after_report_adjustments_cents?: number | null }
/** `display_usd` of `GET /orders?display=USD`. */
export interface DisplayUsdOrders { available: boolean; today_rate?: string | null; at_time_count?: number; today_count?: number; batch_cost_lines?: number; orders?: Record<string, UsdOrderCents> }
/** `display_usd` of `GET /orders/:id?display=USD`. */
export interface DisplayUsdOrder { available: boolean; today_rate?: string | null; usd_basis?: 'at_time' | 'today'; fx_rate_snapshot?: string; cents?: UsdCents; lines?: Record<string, UsdCents>; batch_cost_lines?: number }

/** The period over the orders whose every amount is known (owner 2026-11-10), with their share of the period's general expenses by revenue. */
/** The complete orders that rest only on confirmed costs, or on at least one sale-time estimate (DECISIONS row 313). */
export type FinanceKnownPart = { orders_count: number; revenue_iqd: number; owner_net_iqd: number | null; net_after_report_adjustments_iqd?: number | null; order_ids?: string[] };
export type FinanceKnown = { orders_count: number; incomplete_orders: number; revenue_iqd: number | null; cost_iqd: number | null; owner_net_iqd: number | null; overhead_share_iqd?: number;
  /** After the order coupons and credits, as the headline (absent from a server that predates it). */
  net_after_report_adjustments_iqd?: number | null; confirmed?: FinanceKnownPart; estimated?: FinanceKnownPart;
  /** The complete orders' sums, and their revenue share of the period's overheads (the statement's «محسوبة» column). */
  totals?: ProfitTotals; general_share_iqd?: number; unallocated_share_iqd?: number };
/**
 * The one thing an incomplete order waits for, first match in the order the owner fixes them. `return_cost` (the review of
 * step 4): its own price is confirmed, but a piece returned to stock has no known cost — fixed in the order, not on «التكاليف الناقصة».
 */
export type FinanceWaitReason = 'no_price' | 'return_cost' | 'wage_waits_cost' | 'investor_waits' | 'refund_unknown' | 'other';
/** The orders that are not complete: their sums (unknown parts null), what each waits for, and the rest of the overheads. */
export type FinanceWaiting = { orders_count: number; totals: ProfitTotals; reasons: Partial<Record<FinanceWaitReason, string[]>>; general_share_iqd?: number; unallocated_share_iqd?: number };
/** What keeps the period from being complete: lines without a confirmed purchase price. */
export type FinanceMissingCosts = { lines: number; orders: number; unknown_lines: number; estimated_lines: number; unknown_products: { product_id: string | null; name: string; qty: number; lines: number }[] };
export interface FinanceSummary {
  /** Absent from a server that predates them; null when no order of the period is complete. */
  known?: FinanceKnown | null;
  /** Absent from a server that predates it; null when every order of the period is complete. */
  waiting?: FinanceWaiting | null;
  missing_costs?: FinanceMissingCosts;
  /** Present only with `?display=USD`. */
  display_usd?: DisplayUsdSummary;
  range?: FinanceRange;
  totals: ProfitTotals;
  orders: FinanceOrder[];
  /** Absent from a server that predates the order-kind split. */
  kinds?: FinanceKindTotals[];
  products: FinanceProduct[];
  categories: FinanceProduct[];
  /** Absent from a server that predates it; null when nothing is left at the order level. */
  order_level?: FinanceOrderLevel | null;
  exceptions: Array<{ id?: string; order_id?: string; message?: string; type?: string }>;
  promotions: Promotion[];
  truncated: boolean;
  chart_data?: FinanceCharts;
}

export interface FinanceRange { from: string; to: string }
export interface FinanceChartAmounts {
  revenue_iqd: number;
  cost_iqd: number | null;
  owner_net_iqd: number | null;
  investor_iqd: number | null;
  orders_count: number;
  unknown_lines: number;
  pending_costs: number;
  /** The day's coupons, credited price protection and returned trade-in credits, and its net after them (redesign step 4; absent from a server that predates them). */
  deductions_iqd?: number;
  net_after_report_adjustments_iqd?: number | null;
}
export interface FinanceCharts extends FinanceChartAmounts {
  /**
   * Each day of the period. Since the second review of step 4 a day also counts its orders whose known goods cost rests on a sale-time
   * estimate and those whose sales count an unrecorded refund as 0 (for its file; Reports → Days counts the same from the orders).
   */
  daily: Array<FinanceChartAmounts & { day: string; estimated_orders?: number; unknown_refund_orders?: number }>;
  expense_composition: Array<{ key: 'goods' | 'wages' | 'materials' | 'other' | 'delivery' | 'promotion' | 'general'; amount_iqd: number | null }>;
  basis: 'delivered_baghdad_day';
}

export interface ProfitReviewIssue {
  code: string;
  field: string;
  source_id: string | null;
  line_ids: string[];
}
export interface ProjectedOrderFinance {
  cogs_iqd: number | null;
  gross_profit_iqd: number | null;
  owner_net_iqd: number | null;
  is_estimate: true;
}
export interface ProjectedLineCost {
  unit_cost_iqd: number | null;
  total_cost_iqd: number | null;
  source: 'confirmed_lot' | 'current_catalogue' | 'estimate';
  source_id: string | null;
  as_of: string | null;
}
export interface ProfitCostReview {
  source: 'fifo' | 'manual_verified' | 'recorded_snapshot' | 'snapshot' | 'unknown';
  source_field: string;
  snapshot_unit_iqd: number | null;
  allocated_qty: number;
  required_qty: number;
  sources: Array<{ allocation_id: string; lot_id: string; incoming_id: string | null; purchase_id: string | null; qty: number; cogs_iqd: number | null; unit_cost_iqd: number | null; returned_qty?: number; returned_cogs_iqd?: number | null; late_cost_iqd?: number; retained_cogs_iqd?: number | null }>;
  issues: ProfitReviewIssue[];
  suggestion: null | { source: 'order_snapshot' | 'current_catalogue' | 'confirmed_lot' | 'estimate'; unit_cost_iqd: number; total_cost_iqd: number; as_of: string | null; requires_confirmation: true };
  can_verify: boolean;
}

export interface ProfitLine extends ProfitTotals {
  id: string;
  product_id: string | null;
  name_snapshot: string;
  sku_snapshot: string;
  option_snapshot?: string;
  color_id?: string;
  variant_id?: string;
  color_snapshot?: string;
  image_snapshot?: string;
  product_image?: string;
  image_url?: string;
  qty: number;
  returned_qty: number;
  original_net_goods_iqd?: number;
  price_adjustment_iqd?: number;
  fifo_cogs_iqd?: number | null;
  restored_cogs_iqd?: number | null;
  cost_confidence: string;
  profit_basis_iqd?: number | null;
  cost_review?: ProfitCostReview;
  cost_projection?: ProjectedLineCost;
}

export interface ProfitCost {
  id: string;
  rule_name: string;
  staff_id: string | null;
  staff_name?: string;
  staff_user_id?: string | null;
  basis?: string | null;
  rate?: number | null;
  qty?: number;
  base_iqd?: number | null;
  line_ids?: string[];
  review_reasons?: ProfitReviewIssue[];
  scope_confidence?: 'line' | 'recorded' | 'all_products' | 'historical_unknown';
  amount_iqd: number | null;
  effective_amount_iqd?: number | null;
  state: string;
  order_item_id: string | null;
  center_id: string | null;
}

export interface FinancialHistory {
  id?: string;
  old_value_iqd: number | null;
  new_value_iqd: number | null;
  field: string;
  line_id?: string;
  actor_id?: string;
  actor_name?: string;
  created_at: string;
  version: number;
}

export interface OrderProfit {
  has_financial_activity?: boolean;
  projected_finance?: ProjectedOrderFinance;
  can_reconcile?: boolean;
  order_id: string;
  version: number;
  order: FinanceOrder & { total_iqd?: number; shipping_iqd?: number; cod_tax_iqd?: number; shipping_benefit_iqd?: number };
  lines: ProfitLine[];
  totals: ProfitTotals;
  costs: ProfitCost[];
  warnings: string[];
  history: FinancialHistory[];
  /** Present only with `?display=USD`. */
  display_usd?: DisplayUsdOrder;
}

export const WORKSPACE_API = '/api/admin/finance-workspace';
export const currentMonth = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
export const financeToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
export function validFinanceRange(range: FinanceRange): boolean {
  const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString().slice(0, 10) === v;
  if (!valid(range.from) || !valid(range.to)) return false;
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86400000;
  return days >= 0 && days <= 365;
}
export function financePreset(preset: 'month' | '7days' | '30days' | 'previous' | 'year', today = financeToday()): FinanceRange {
  const shift = (days: number) => new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);
  if (preset === '7days') return { from: shift(6), to: today };
  if (preset === '30days') return { from: shift(29), to: today };
  if (preset === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (preset === 'previous') return monthRange(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0)).toISOString().slice(0, 7));
  return { from: `${today.slice(0, 7)}-01`, to: today };
}
export function financeRangeFromSearch(search: string): { range: FinanceRange; invalid: boolean } {
  const query = new URLSearchParams(search), from = query.get('from'), to = query.get('to');
  if (from === null && to === null) return { range: financePreset('month'), invalid: false };
  const range = { from: from ?? '', to: to ?? '' };
  return validFinanceRange(range) ? { range, invalid: false } : { range: financePreset('month'), invalid: true };
}
export function financeDay(value?: string) {
  if (!value) return '';
  const normalized = value.replace(' ', 'T');
  const timestamp = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp + 3 * 3600000).toISOString().slice(0, 10) : value.slice(0, 10);
}
export function monthRange(month: string) {
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
export function statusName(status: string, loc: (ar: string, en: string) => string) {
  const names: Record<string, [string, string]> = {
    delivered: ['مستلم', 'Delivered'], cancelled: ['ملغى', 'Cancelled'], returned: ['مرتجع', 'Returned'], refunded: ['مسترد', 'Refunded'], pending: ['جديد', 'New'],
    confirmed: ['مؤكد', 'Confirmed'], preparing: ['قيد التجهيز', 'Preparing'], out_for_delivery: ['في الطريق', 'On the way'],
    processing: ['قيد التجهيز', 'Preparing'], shipped: ['في الطريق', 'On the way'],
    completed: ['مكتمل', 'Completed'], paid: ['مدفوع', 'Paid'],
  };
  return names[status] ? loc(...names[status]) : status;
}
