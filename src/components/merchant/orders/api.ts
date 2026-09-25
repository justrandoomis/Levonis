/**
 * The order detail screen's reads (W3-B): the order itself
 * (GET /api/merchant/orders/:id, worker/routes/merchant.ts) and its story
 * (GET /api/merchant/orders/:id/timeline, worker/routes/merchantOrders.ts).
 */
import { api } from '../../../lib/api';

export type TimelineActor = 'store' | 'customer' | 'levonis' | 'courier' | 'system';

export type TimelineEvent =
  | { kind: 'placed'; at: string; actor: 'customer'; total_iqd: number }
  | { kind: 'status'; at: string; status: string; stage: string; actor: TimelineActor }
  | { kind: 'cancelled'; at: string; actor: TimelineActor }
  | { kind: 'refunded'; at: string; actor: 'system' }
  | { kind: 'receipt_confirmed'; at: string; actor: 'customer' }
  | { kind: 'credit_recorded' | 'credit_reversed'; at: string; lines: Array<{ kind: string; amount_iqd: number }>; bucket: string }
  | { kind: 'credit_released'; at: string; amount_iqd: number; actor: TimelineActor }
  | { kind: 'ledger_adjustment'; at: string; amount_iqd: number; bucket: string }
  | { kind: 'dispute_opened' | 'dispute_closed'; at: string; source: 'complaint' | 'ticket' }
  | { kind: 'chat_started'; at: string }
  | { kind: 'release_due'; at: string; expected: true; frozen: boolean };

export interface OrderTimeline {
  order_id: string;
  status: string;
  credit_state: string | null;
  disputed: boolean;
  commission_percent: number;
  events: TimelineEvent[];
  money?: {
    gross_iqd: number;
    commission_iqd: number;
    delivery_fee_iqd: number;
    reversed_iqd: number;
    adjustments_iqd: number;
    net_iqd: number;
    pending_iqd: number;
    available_iqd: number;
  };
  delivery: {
    recorded: boolean;
    fulfilment: string | null;
    governorate: string | null;
    rule: string | null;
    fee_iqd: number;
    base_fee_iqd?: number;
    free_over_iqd?: number;
    prep_days: number | null;
    shipping_type: string;
  };
  items: Array<{
    id: string;
    product_id: string | null;
    variant_id: string | null;
    name: string;
    image: string | null;
    option: string;
    sku: string;
    qty: number;
    unit_price_iqd: number;
    line_total_iqd: number;
  }>;
  chat?: { id: string; link: string };
}

export interface OrderRecord {
  id: string;
  status: string;
  created_at: string;
  delivered_at: string | null;
  receipt_confirmed_at: string | null;
  credit_state: string | null;
  release_after: string | null;
  subtotal_iqd: number;
  shipping_iqd: number;
  total_iqd: number;
  platform_fee_iqd: number;
  merchant_receivable_iqd: number;
  coupon_code: string;
  coupon_discount_iqd: number;
  payment_method_id: string;
  due_on_delivery_iqd: number;
  customer_name: string;
  customer_phone: string;
  address: Record<string, unknown>;
}

export const orderDetailApi = {
  order: (id: string) => api.get<{ order: OrderRecord }>(`/api/merchant/orders/${encodeURIComponent(id)}`),
  timeline: (id: string) => api.get<{ success: true } & OrderTimeline>(`/api/merchant/orders/${encodeURIComponent(id)}/timeline`),
  setStatus: (id: string, status: string) =>
    api.post<{ status: string }>(`/api/merchant/orders/${encodeURIComponent(id)}/status`, { status }),
  openChat: (orderId: string) => api.post<{ chatId: string }>('/api/chats/open', { orderId }),
};
