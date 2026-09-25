/**
 * OFFERS v2 — the shapes worker/routes/marketplace.ts returns (`offerShape`,
 * `/my-offers`, `/orders/:id`) and the words for their closed vocabularies.
 */
import { api } from '../../../lib/api';
import type { OfferDeliveryMethod } from '../requests/api';

export type Loc = (ar: string, en: string, ckb?: string) => string;

export interface OfferHistoryEntry {
  revision: number;
  request_revision: number;
  price_iqd: number;
  completion_days: number | null;
  delivery_method: string;
  reason: string;
  created_at: string;
}

export interface OfferV2 {
  id: string;
  request_id: string;
  merchant_id: string;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  message: string;
  materials: string;
  material_ids: string[];
  included: string;
  warranty_terms: string;
  state: 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'superseded' | string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  request_revision: number;
  stale: boolean;
  expired: boolean;
  history?: OfferHistoryEntry[];
  /** The order this offer became (the winning offer only). */
  order_id?: string | null;
  merchant: {
    id: string;
    name: string;
    verified: boolean;
    pro_badge?: boolean;
    badge: string;
    rating: number | null;
    rating_count: number;
    completed_orders: number;
    store_slug: string | null;
  } | null;
}

export interface OfferTermsInput {
  price_iqd: number;
  completion_days: number;
  delivery_method: OfferDeliveryMethod;
  material_ids: string[];
  included: string;
  warranty_terms: string;
  valid_days: number;
  message: string;
}

export interface MyOfferRow extends OfferV2 {
  request: { id: string; title: string; state: string; revision: number; expires_at: string | null };
  order_id: string | null;
}

export interface OrderContact {
  name?: string;
  phone?: string;
  governorate?: string;
  area?: string;
  address?: string;
  landmark?: string;
  address_notes?: string;
  store_name?: string;
  store_slug?: string;
  delivery_method?: string;
}

export const offersApi = {
  list: (requestId: string) =>
    api.get<{ offers: OfferV2[]; is_customer: boolean }>(`/api/marketplace/requests/${encodeURIComponent(requestId)}/offers`),
  create: (requestId: string, t: OfferTermsInput) =>
    api.post<{ offer: OfferV2 }>(`/api/marketplace/requests/${encodeURIComponent(requestId)}/offers`, t),
  edit: (offerId: string, t: Partial<OfferTermsInput>) => api.patch<{ offer: OfferV2 }>(`/api/marketplace/offers/${encodeURIComponent(offerId)}`, t),
  withdraw: (offerId: string) => api.post(`/api/marketplace/offers/${encodeURIComponent(offerId)}/withdraw`),
  reconfirm: (offerId: string) => api.post<{ offer: OfferV2 }>(`/api/marketplace/offers/${encodeURIComponent(offerId)}/reconfirm`),
  decline: (offerId: string) => api.post(`/api/marketplace/offers/${encodeURIComponent(offerId)}/decline`),
  accept: (offerId: string, b: { expected_price_iqd: number; offer_revision: number; address_id?: string }) =>
    api.post<{ order: { id: string } }>(`/api/marketplace/offers/${encodeURIComponent(offerId)}/accept`, b),
  mine: (cursor = '', state = '') =>
    api.get<{ offers: MyOfferRow[]; next_cursor: string | null }>(
      `/api/marketplace/my-offers?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${state ? `&state=${state}` : ''}`
    ),
  order: (orderId: string) =>
    api.get<{ role: 'customer' | 'merchant'; contact: OrderContact | null; thread: { request_id: string; merchant_id: string }; order: { id: string; state: string } }>(
      `/api/marketplace/orders/${encodeURIComponent(orderId)}`
    ),
  openThread: (requestId: string, merchantId?: string) =>
    api.post<{ chatId: string }>('/api/chats/open', merchantId ? { requestId, merchantId } : { requestId }),
};

export function deliveryLabel(method: string, loc: Loc): string {
  switch (method) {
    case 'pickup':
      return loc('يستلمه الزبون من الورشة', 'Customer collects');
    case 'merchant_delivery':
      return loc('يوصله التاجر', 'Merchant delivers');
    case 'courier':
      return loc('شركة توصيل', 'Courier');
    case '':
      return loc('غير محدد', 'Not stated');
    default:
      // A free-text method from before offers v2, shown as the merchant wrote it.
      return method;
  }
}

export function offerStateLabel(o: Pick<OfferV2, 'state' | 'stale' | 'expired'>, loc: Loc): { text: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' } {
  if (o.state === 'accepted') return { text: loc('مقبول', 'Accepted'), tone: 'success' };
  if (o.state === 'superseded' || (o.state === 'pending' && o.stale)) return { text: loc('بانتظار تأكيد التاجر', 'Awaiting re-confirmation'), tone: 'warning' };
  if (o.state === 'expired' || o.expired) return { text: loc('منتهي الصلاحية', 'Expired'), tone: 'neutral' };
  if (o.state === 'rejected') return { text: loc('لم يُختر', 'Not chosen'), tone: 'neutral' };
  if (o.state === 'withdrawn') return { text: loc('مسحوب', 'Withdrawn'), tone: 'neutral' };
  return { text: loc('قائم', 'Open'), tone: 'info' };
}

/** «صالح حتى ٣ أكتوبر» in the reader's calendar, or null. */
export function validUntil(iso: string | null, lang: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Latin digits in every language, as every other figure in the app.
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'short' });
}
