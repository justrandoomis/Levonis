/**
 * The merchant finance API (worker/routes/merchantFinance.ts), typed.
 * Every figure is what the server summed over the append-only ledger — this
 * module never adds, subtracts or rounds a dinar.
 */
import { api } from '../../../lib/api';

export type LedgerBucket = 'pending' | 'available' | 'reserved' | 'paid';
export type LedgerKind =
  | 'sale_gross'
  | 'commission'
  | 'delivery_fee'
  | 'refund'
  | 'commission_refund'
  | 'delivery_refund'
  | 'escrow_release'
  | 'adjustment'
  | 'release'
  | 'payout'
  | 'payout_reversal';
export type PayoutState = 'requested' | 'approved' | 'paid' | 'failed' | 'cancelled';

export interface FinanceSummary {
  gross: number;
  store_gross: number;
  custom_gross: number;
  commission: number;
  delivery_fees: number;
  refunds: number;
  adjustments: number;
  receivable: number;
  pending: number;
  pending_frozen: number;
  available: number;
  reserved: number;
  paid_out: number;
  escrow_held: number;
  open_payouts: number;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  bucket: LedgerBucket;
  amount_iqd: number;
  note: string;
  created_at: string;
  link: { type: 'order' | 'custom_order' | 'payout' | 'none'; id: string | null };
  legacy: boolean;
}

export interface Payout {
  id: string;
  amount_iqd: number;
  state: PayoutState;
  source: 'merchant' | 'admin' | 'legacy';
  method: { channel: string; label: string; account: string; holder: string };
  note: string;
  reference: string;
  decision_reason: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
}

export interface PayoutMethodOption {
  id: string;
  name: string;
  requires_account: boolean;
}

export interface PayoutsAnswer {
  buckets: { pending: number; available: number; reserved: number; paid: number };
  methods: PayoutMethodOption[];
  payouts: Payout[];
  next_cursor: string | null;
}

export interface PayoutRequestBody {
  amount_iqd: number;
  channel: string;
  account: string;
  holder: string;
  note: string;
  idempotencyKey: string;
}

export const financeApi = {
  summary: () => api.get<{ summary: FinanceSummary }>('/api/merchant/finance/summary'),
  ledger: (q: { cursor?: string | null; kind?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.cursor) p.set('cursor', q.cursor);
    if (q.kind) p.set('kind', q.kind);
    p.set('limit', String(q.limit ?? 30));
    return api.get<{ entries: LedgerEntry[]; next_cursor: string | null }>(`/api/merchant/finance/ledger?${p}`);
  },
  payouts: (cursor?: string | null) =>
    api.get<PayoutsAnswer>(`/api/merchant/payouts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  requestPayout: (body: PayoutRequestBody) =>
    api.post<{ replayed: boolean; payout: Payout }>('/api/merchant/payouts', body),
  cancelPayout: (id: string) => api.post<{ replayed: boolean; payout: Payout }>(`/api/merchant/payouts/${encodeURIComponent(id)}/cancel`),
  order: (id: string) =>
    api.get<{ order: Record<string, unknown> }>(`/api/merchant/orders/${encodeURIComponent(id)}`),
};
