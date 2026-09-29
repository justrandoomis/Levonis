/**
 * CARDS IN A CONVERSATION — the shapes the thread screen reads
 * (worker/lib/chatCards.ts is the other half; docs/COMMUNITY_COMMERCE_CHAT.md).
 *
 * A card arrives as `{ type, kind, ref, original, current }`: `original` is
 * what it was sent as — frozen by the server, never rewritten — and `current`
 * is what it is now, for this reader, with the actions this reader may take.
 * The screen never computes a price or a permission of its own: it shows the
 * two and offers exactly the actions the server listed.
 */

export type ChatCardType = 'product' | 'custom_product' | 'print_request' | 'quote' | 'order' | 'custom_order' | 'store';

export interface ChatCardCurrent {
  status: string;
  actions: string[];
  [k: string]: unknown;
}

export interface ChatCard {
  type: ChatCardType;
  kind: string;
  ref: string;
  original: Record<string, unknown>;
  current: ChatCardCurrent;
}

/** A product card's frozen snapshot (worker/lib/chatCards.ts `productSnapshotOf`). */
export interface ProductSnapshot {
  product_id: string;
  name: string;
  name_ar: string;
  image: string | null;
  price_iqd: number;
  price_max_iqd: number | null;
  original_price_iqd: number | null;
  variants: boolean;
  prep_days: number;
  url: string;
  store: { id: string; slug: string; name: string };
}

export interface StoreSnapshot {
  store_id: string;
  slug: string;
  name: string;
  tagline: string;
  logo: string | null;
  url: string;
}

/** `GET /api/chats/:id` — who the conversation is with, and what this reader may send. */
export interface ChatThreadInfo {
  id: string;
  context: { type: 'store' | 'store_order' | 'request' | 'order' | 'direct'; id: string };
  order_id: string | null;
  role: 'customer' | 'merchant' | 'member' | 'staff';
  read_only: boolean;
  store: { id: string; name: string; slug: string; logoUrl: string | null; url: string; open: boolean } | null;
  other: { name: string; username: string } | null;
  can: Record<string, boolean>;
}

/** One row of the product picker (`GET /api/chats/:id/products`). */
export interface PickerProduct {
  id: string;
  name: string;
  name_ar: string;
  image: string | null;
  price_iqd: number;
  price_max_iqd: number | null;
  original_price_iqd: number | null;
  in_stock: boolean;
  variants: boolean;
}

/**
 * THE SENDER'S NAME FOR ONE SEND (0150 `client_id`). A retry of the same send
 * carries the same name, so a lost response never puts the message in twice.
 */
export function newClientId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** A product's name for the reader: Arabic readers read the Arabic name when there is one. */
export function productName(p: { name: string; name_ar?: string | null }, lang: string): string {
  const ar = (p.name_ar ?? '').trim();
  if (lang !== 'en' && ar) return ar;
  return p.name || ar;
}
