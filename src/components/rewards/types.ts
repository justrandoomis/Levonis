/**
 * GET /api/rewards/program — the rewards hub, exactly as
 * worker/routes/rewardsProgram.ts answers it (migration 0220). The page draws
 * these and decides nothing: every figure, window and state is the server's.
 */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export type RewardKind = 'free_shipping' | 'filament_discount';

export interface RewardCoupon {
  id: string;
  kind: RewardKind;
  source: 'printer' | 'points_shop' | 'admin';
  state: 'active' | 'used' | 'expired' | 'revoked';
  code: string;
  percent: number;
  max_discount_iqd: number | null;
  scope: string;
  category_id: string | null;
  product_ids: string[];
  issued_at: string;
  expires_at: string;
  order_id: string | null;
  points_spent: number;
  used_on_order_id: string | null;
  revoke_reason: string;
}

export interface PrinterToRate {
  order_id: string;
  product_id: string;
  slug: string;
  name: Tri;
  image: string;
  delivered_at: string | null;
  state: 'to_rate' | 'reward_pending' | 'reward_approved' | 'rated';
  stars: number | null;
  reward_level: number | null;
}

export interface GiftLevel {
  level: number;
  name: Tri;
  description: Tri;
  active: boolean;
}

export interface ShopItem {
  kind: RewardKind;
  points: number;
  affordable: boolean;
}

export interface CompetitionEntry {
  id: string;
  state: 'entered' | 'disqualified' | 'winner' | 'refunded';
  place: number | null;
  prize_points: number;
  entry_points: number;
  answer: string;
  media_url: string | null;
  created_at: string;
}

export interface Competition {
  id: string;
  title: Tri;
  description: Tri;
  prize: Tri;
  entry_mode: 'free' | 'points';
  entry_points: number;
  submission: 'none' | 'text' | 'photo' | 'photo_text';
  eligibility: 'everyone' | 'printer_owners';
  prize_points: number[];
  max_entries: number | null;
  starts_at: string;
  ends_at: string;
  phase: 'draft' | 'upcoming' | 'open' | 'closed' | 'finished' | 'cancelled';
  entries_count: number;
  eligible: boolean;
  my_entry: CompetitionEntry | null;
  winners: Array<{ place: number; name: string; prize_points: number; answer: string; media_url: string | null }>;
}

export interface RewardsHubData {
  installed: boolean;
  server_time: string;
  point_balance: number;
  pending_points: { points: number; next_available_at: string | null };
  program: {
    enabled: boolean;
    valid_days: number;
    free_shipping: { enabled: boolean };
    filament: {
      enabled: boolean;
      percent: number;
      max_discount_iqd: number | null;
      products: Array<{ id: string; slug: string; name: Tri }>;
      section: { id: string; slug: string; path: string; name: Tri } | null;
    };
  };
  coupons: RewardCoupon[];
  printers: PrinterToRate[];
  rating: { gift_levels: GiftLevel[]; review_points: number | null };
  shop: ShopItem[];
  competitions: Competition[];
}
