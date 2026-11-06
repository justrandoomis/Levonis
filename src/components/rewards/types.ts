/**
 * GET /api/rewards/program — the rewards hub, exactly as
 * worker/routes/rewardsProgram.ts answers it (migration 0220). The page draws
 * these and decides nothing: every figure, window and state is the server's.
 *
 * The rewards-area additions (spec §9.4: gates, coupon targets, holdings, the
 * hub's counts, the competitions list and detail) are all OPTIONAL fields, so
 * an older server's answer still type-checks and still renders.
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
  /** A percentage coupon's percentage; 0 for a coupon worth a fixed amount. */
  percent: number;
  /** A fixed coupon's dinars off the delivery; null for a percentage, and for free delivery issued before 0225 (the whole fee). */
  amount_iqd?: number | null;
  /** The goods, after every discount, an order needs. 0 or absent: none. */
  min_total_iqd?: number;
  max_discount_iqd: number | null;
  /** How many pieces it discounts; null or absent: every piece it names. */
  max_quantity?: number | null;
  /** It also works on a piece already on sale; absent from an older server. */
  stacks?: boolean;
  scope: string;
  category_id: string | null;
  product_ids: string[];
  issued_at: string;
  expires_at: string;
  order_id: string | null;
  points_spent: number;
  used_on_order_id: string | null;
  revoke_reason: string;
  /** What a live filament coupon covers; null for free delivery and every past coupon; absent from an older server. */
  targets?: CouponTargets | null;
}

/**
 * The products a filament coupon was issued for (its OWN frozen `product_ids`
 * that are still on sale), or the catalogue section of a category-scoped one.
 */
export interface CouponTargets {
  /** At most 20, in the coupon's own order. */
  products: Array<{ id: string; slug: string; name: Tri; image: string }>;
  /** Every live product of the coupon, beyond the 20 named. */
  products_total: number;
  section: { id: string; slug: string; path: string; name: Tri } | null;
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
  /** An unused, live coupon of this kind bought with points is already held (one of each at a time). */
  holding?: boolean;
  /** How many more points this coupon needs; 0 when affordable. */
  points_short?: number;
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
  /** When the results were announced (finished only); null otherwise. */
  results_at?: string | null;
  /** Whether this customer can enter now, and if not, why — the server's decision. */
  gate?: CompetitionGate;
}

/** Why this customer cannot enter now, in the server's order of checks (worker `gateOf`). */
export type GateBlock = 'entered' | 'upcoming' | 'closed' | 'not_eligible' | 'full' | 'insufficient_points';

export interface CompetitionGate {
  can_enter: boolean;
  blocked_by: GateBlock | null;
  /** The points still missing when `blocked_by` is 'insufficient_points', else 0. */
  points_short: number;
  /** Places left under `max_entries`; null when the competition is uncapped. */
  spots_left: number | null;
}

export interface RewardsHubData {
  installed: boolean;
  server_time: string;
  point_balance: number;
  pending_points: { points: number; next_available_at: string | null };
  program: {
    enabled: boolean;
    valid_days: number;
    /** A new pair every week of the printer's warranty (0225); absent from an older server. */
    weekly?: { enabled: boolean; months: number };
    free_shipping: { enabled: boolean; amount_iqd?: number; min_order_iqd?: number };
    filament: {
      enabled: boolean;
      percent: number;
      max_discount_iqd: number | null;
      max_pieces?: number;
      products: Array<{ id: string; slug: string; name: Tri }>;
      section: { id: string; slug: string; path: string; name: Tri } | null;
    };
  };
  coupons: RewardCoupon[];
  /** Every coupon of this customer by state, beyond the 40 listed. */
  coupon_counts?: { active: number; past: number };
  printers: PrinterToRate[];
  rating: {
    gift_levels: GiftLevel[];
    review_points: number | null;
    /** The least a valid review below the gift levels earns (before the member multiplier); null when unconfigured. */
    no_level_points?: number | null;
  };
  shop: ShopItem[];
  competitions: Competition[];
  /** Published competitions by window, at the server's now; `open_to_enter` is open, not entered, eligible and below the cap. */
  competition_counts?: { open: number; upcoming: number; closed: number; open_to_enter: number };
}

/** GET /api/rewards/program/competitions?view=current|results[&mine=1][&cursor=…] */
export interface CompetitionsPage {
  success: true;
  installed: boolean;
  server_time: string;
  point_balance: number;
  view: 'current' | 'results';
  /** Echoed: true only for view=results&mine=1. */
  mine?: boolean;
  counts: { current: number; results: number };
  competitions: Competition[];
  next_cursor: string | null;
}

/** GET /api/rewards/program/competitions/:id */
export interface CompetitionDetailResponse {
  success: true;
  server_time: string;
  point_balance: number;
  competition: Competition;
}
