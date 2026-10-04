export type FinanceSection = 'overview' | 'orders' | 'products' | 'monthly' | 'staff' | 'investors' | 'settlements' | 'accounting';

export interface ProfitTotals {
  net_goods_iqd?: number | null;
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
  pending_costs?: number;
  unknown_lines?: number;
  orders_count?: number;
  units?: number;
}

export interface FinanceOrder extends ProfitTotals {
  id: string;
  order_id?: string;
  status: string;
  created_at: string;
  delivered_at?: string;
  customer_name?: string;
  version?: number;
  cost_confidence?: string;
}

export interface FinanceProduct extends ProfitTotals {
  id: string;
  name: string;
  qty: number;
  product_image?: string;
  image_url?: string;
}

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

export interface FinanceSummary {
  totals: ProfitTotals;
  orders: FinanceOrder[];
  products: FinanceProduct[];
  categories: FinanceProduct[];
  exceptions: Array<{ id?: string; order_id?: string; message?: string; type?: string }>;
  promotions: Promotion[];
  truncated: boolean;
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
  retained_revenue_iqd?: number;
  fifo_cogs_iqd?: number | null;
  restored_cogs_iqd?: number | null;
  cost_confidence: string;
  profit_basis_iqd?: number | null;
}

export interface ProfitCost {
  id: string;
  rule_name: string;
  staff_id: string | null;
  staff_name?: string;
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
  order_id: string;
  version: number;
  order: FinanceOrder & { total_iqd?: number; shipping_iqd?: number; cod_tax_iqd?: number; shipping_benefit_iqd?: number };
  lines: ProfitLine[];
  totals: ProfitTotals;
  costs: ProfitCost[];
  warnings: string[];
  history: FinancialHistory[];
}

export const WORKSPACE_API = '/api/admin/finance-workspace';
export const currentMonth = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
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
    delivered: ['مستلم', 'Delivered'], cancelled: ['ملغى', 'Cancelled'], pending: ['جديد', 'New'],
    confirmed: ['مؤكد', 'Confirmed'], preparing: ['قيد التجهيز', 'Preparing'], out_for_delivery: ['في الطريق', 'On the way'],
    completed: ['مكتمل', 'Completed'], paid: ['مدفوع', 'Paid'],
  };
  return names[status] ? loc(...names[status]) : status;
}
