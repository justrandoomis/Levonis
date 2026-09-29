/**
 * THE DOORS A CONVERSATION'S CARDS USE — every one of them an existing route
 * (docs/COMMUNITY_COMMERCE_CHAT.md §5). Nothing here computes a price, a total
 * or a permission: the server decides, and the card shows what it answered.
 *
 *   print requests, quotes, private products   /api/chats/:id/…  (worker/routes/chatCommerce.ts)
 *   accept · decline · withdraw · re-confirm   /api/marketplace/offers/:id/…  (the existing escrow)
 *   the custom order's steps                   /api/marketplace/orders/:id/…
 *   «استلمت طلبي» for a store order            /api/orders/:id/confirm-receipt
 */
import { api } from './api';
import { newClientId } from './chatCards';

const enc = encodeURIComponent;

export interface QuoteInput {
  request_id?: string;
  /** Only when there is no request: the job the quote makes for the customer. */
  title?: string;
  description?: string;
  quantity?: number;
  material?: string;
  color?: string;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  message: string;
  included: string;
  warranty_terms: string;
  valid_days: number;
}

export interface PrintRequestInput {
  title: string;
  description: string;
  quantity: number;
  material: string;
  color: string;
  dimensions: string;
  budget_iqd: number | null;
  deadline: string;
  customer_notes: string;
}

export interface CustomProductInput {
  name: string;
  description: string;
  price_iqd: number;
  prep_days: number;
  valid_days: number;
  image?: string | null;
  quote_id?: string | null;
}

export interface ThreadOrders {
  role: 'customer' | 'merchant';
  store_orders: Array<{ id: string; status: string; stage: string | null; total_iqd: number; items: number; first_item: string; created_at: string }>;
  custom_orders: Array<{ id: string; state: string; price_iqd: number; request_id: string; title: string; created_at: string }>;
}

export const chatCommerceApi = {
  // ---- the customer's print request: draft → files → send
  draftPrintRequest: (chatId: string, b: PrintRequestInput) =>
    api.post<{ request: { id: string } }>(`/api/chats/${enc(chatId)}/print-requests`, b),
  uploadRequestFile: (requestId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<{ file: { id: string; file_name: string } }>(`/api/marketplace/requests/${enc(requestId)}/files`, form);
  },
  sendPrintRequest: (chatId: string, requestId: string) =>
    api.post(`/api/chats/${enc(chatId)}/print-requests/${enc(requestId)}/send`, { client_id: newClientId() }),
  cancelRequest: (requestId: string) => api.post(`/api/marketplace/requests/${enc(requestId)}/cancel`, {}),

  // ---- the store's quote
  quote: (chatId: string, b: QuoteInput) => api.post<{ offer: { id: string } }>(`/api/chats/${enc(chatId)}/quotes`, b),
  editQuote: (chatId: string, offerId: string, b: Partial<QuoteInput>) =>
    api.patch(`/api/chats/${enc(chatId)}/quotes/${enc(offerId)}`, b),
  withdraw: (offerId: string) => api.post(`/api/marketplace/offers/${enc(offerId)}/withdraw`, {}),
  reconfirm: (offerId: string) => api.post(`/api/marketplace/offers/${enc(offerId)}/reconfirm`, {}),

  // ---- the customer's answer — acceptance is the escrow's own door
  accept: (offerId: string, seen: { price_iqd: number; revision: number }) =>
    api.post<{ order: { id: string }; replayed?: boolean }>(`/api/marketplace/offers/${enc(offerId)}/accept`, {
      expected_price_iqd: seen.price_iqd,
      offer_revision: seen.revision,
    }),
  decline: (offerId: string) => api.post(`/api/marketplace/offers/${enc(offerId)}/decline`, {}),

  // ---- a private product
  customProduct: (chatId: string, b: CustomProductInput) =>
    api.post<{ product: { id: string } }>(`/api/chats/${enc(chatId)}/custom-products`, b),
  cancelCustomProduct: (chatId: string, productId: string) =>
    api.post(`/api/chats/${enc(chatId)}/custom-products/${enc(productId)}/cancel`, {}),

  // ---- the orders, both flows
  orders: (chatId: string) => api.get<ThreadOrders>(`/api/chats/${enc(chatId)}/orders`, { mascot: 'silent' }),
  startWork: (orderId: string) => api.post(`/api/marketplace/orders/${enc(orderId)}/start`, {}),
  markDelivered: (orderId: string) => api.post(`/api/marketplace/orders/${enc(orderId)}/delivered`, {}),
  confirmCustomOrder: (orderId: string) => api.post(`/api/marketplace/orders/${enc(orderId)}/confirm`, {}),
  confirmReceipt: (orderId: string) => api.post(`/api/orders/${enc(orderId)}/confirm-receipt`, {}),
};

/** How a quote is handed over — the closed list the server accepts (worker/lib/requestRevisions.ts). */
export const DELIVERY_METHODS = ['merchant_delivery', 'courier', 'pickup'] as const;
