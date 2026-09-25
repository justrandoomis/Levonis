/**
 * The customers screen's reads (W3-B, worker/routes/merchantCustomers.ts).
 * A customer is addressed by an ORDER id of this store (`key`), never a user id.
 */
import { api } from '../../../lib/api';

export interface CustomerRow {
  key: string;
  name: string;
  order_count: number;
  spent_iqd: number;
  last_order_at: string;
  first_order_at: string;
  governorate?: string;
  link: string;
}

export interface CustomerDetail {
  customer: {
    key: string;
    name: string;
    order_count: number;
    spent_iqd: number;
    cancelled_count: number;
    average_order_iqd?: number;
    first_order_at: string | null;
    last_order_at: string | null;
    returning: boolean;
    governorate?: string;
    phone?: string;
  };
  orders: Array<{
    id: string;
    status: string;
    total_iqd: number;
    merchant_receivable_iqd: number;
    created_at: string;
    item_count: number;
    credit_state: string | null;
    link: string;
  }>;
  next_cursor: string | null;
}

export const customersApi = {
  list: (p: { q?: string; cursor?: string | null }) => {
    const qs = new URLSearchParams();
    if (p.q) qs.set('q', p.q);
    if (p.cursor) qs.set('cursor', p.cursor);
    const s = qs.toString();
    return api.get<{ customers: CustomerRow[]; next_cursor: string | null }>(`/api/merchant/customers${s ? `?${s}` : ''}`);
  },
  one: (key: string, cursor?: string | null) =>
    api.get<{ success: true } & CustomerDetail>(
      `/api/merchant/customers/${encodeURIComponent(key)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    ),
};

/** A search the server will take: empty (everything) or 2–60 characters. */
export function searchTerm(raw: string): string | null {
  const q = raw.trim();
  if (!q) return '';
  const n = [...q].length;
  return n >= 2 && n <= 60 ? q : null;
}
