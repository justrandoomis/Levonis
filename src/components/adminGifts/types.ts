/**
 * The admin gifts screens' view of the server (worker/lib/gifts/admin.ts,
 * worker/lib/gifts/levels.ts, worker/routes/gifts.ts). Mirrors only — nothing
 * here decides a status, a price or a permission.
 */

export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export type GiftStatus = 'GRANTED' | 'READY_TO_REDEEM' | 'REDEEMED' | 'ADDED_TO_ORDER' | 'ORDERED' | 'FULFILLED' | 'CANCELLED' | 'LEGACY';
export type GrantReason = 'review' | 'reward' | 'compensation' | 'admin_gift';
export const GRANT_REASONS: readonly GrantReason[] = ['review', 'reward', 'compensation', 'admin_gift'];
export const GIFT_STATUSES: readonly GiftStatus[] = ['GRANTED', 'READY_TO_REDEEM', 'REDEEMED', 'ADDED_TO_ORDER', 'ORDERED', 'FULFILLED', 'CANCELLED', 'LEGACY'];

/** One product a gift grants, as the store describes it today (GiftItemView). */
export interface ItemView {
  item_id: string | null;
  product_id: string;
  slug: string;
  name: Tri;
  image: string;
  variant: Tri;
  color: (Tri & { hex: string }) | null;
  qty: number;
  sale_type: 'direct_sale' | 'pre_order';
  transport_method: string;
  value_iqd: number;
  lead_time_text: string;
  available: boolean | null;
  reason: string | null;
}

/** A product-backed level item (AdminItemView). */
export interface LevelItem extends ItemView {
  id: string;
  level: number;
  active: boolean;
  sort: number;
  option_value_ids: string[];
  color_id: string;
  updated_at: string | null;
}

export interface LegacyItem {
  id: string;
  level: number;
  kind: string;
  label: Tri;
  brand: string;
  material: string;
  color: string;
  option_value: string;
  stock: number;
  active: boolean;
}

export interface Level {
  n: number;
  name: Tri;
  description: Tri;
  active: boolean;
  updated_at: string | null;
  items: LevelItem[];
  legacy_items: LegacyItem[];
}

export interface AdminGift {
  id: string;
  status: GiftStatus;
  state: string;
  mode: 'legacy' | 'level' | 'product';
  reason: GrantReason | 'legacy';
  level: { n: number; name: Tri; description: Tri; active: boolean } | null;
  user: { id: string; name: string; email: string; username: string; phone: string };
  note: string;
  granted_by: { id: string; name: string; email: string } | null;
  granted_at: string;
  chosen: ItemView | null;
  item_id: string | null;
  cart_item_id: string | null;
  order: { id: string; status: string; stage: string | null } | null;
  order_seq: number;
  chosen_at: string | null;
  redeemed_at: string | null;
  ordered_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string;
  version: number;
  reward_id: string | null;
  legacy: { state: string; max_level: number; chosen_level: number | null; contents: unknown[]; selected_at: string | null } | null;
  actions: { cancel: boolean; edit_reason: boolean; convert: boolean; fulfill: boolean };
}

export interface AuditEntry {
  id: number;
  action: string;
  actor: { id: string; name: string; email: string } | null;
  detail: Record<string, unknown>;
  at: string;
}

export interface UserHit {
  id: string;
  name: string;
  email: string;
  username: string;
  phone: string;
  role: string;
}

/** GET /api/gifts/admin/products/:id/options — what an item can pin. */
export interface OptionsProjection {
  product: { id: string; name_en: string; name_ar: string; status: string; composition: string };
  giftable: boolean;
  sale_types: Array<'direct_sale' | 'pre_order'>;
  groups: Array<{
    id: string;
    name_en: string;
    values: Array<{ id: string; name_en: string; name_ar: string; name_ckb: string; stock: number | null; sale_types: string[]; routes: string[] }>;
  }>;
  colors: Array<{ id: string; name_en: string; name_ar: string; name_ckb: string; hex: string; stock: number | null; links: Array<{ group_id: string; option_value_id: string }> }>;
  transports: string[];
}

/** What an item sheet sends (POST /levels/:n/items, PUT /items/:id, and `product` of a grant). */
export interface ItemInput {
  productId: string;
  optionValueIds: string[];
  colorId: string;
  qty: number;
  saleType: 'direct_sale' | 'pre_order';
  transportMethod: '' | 'air' | 'sea' | 'land';
  active?: boolean;
}
