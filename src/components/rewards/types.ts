import type { GiftStatus, GiftView } from '../reviews/gifts/GiftCard';

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

/** One printer's gift, as far as this page needs to know it: where it stands, and whether a code opened it. */
export interface PrinterGift {
  id: string;
  status: GiftStatus;
  scope: 'level' | 'up_to';
}

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
  /** It also works on a piece that already has an offer: this coupon's own term. An older server sends none. */
  on_offer?: boolean;
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
  /** The printer that earned it; null for the points shop's and the team's; absent from an older server. */
  printer?: RewardCouponPrinter | null;
}

/** Which printer earned a coupon, and which of its weeks (0 is the first; the page counts from 1). */
export interface RewardCouponPrinter {
  name: Tri;
  image: string;
  unit_index: number;
  week: number;
  product_slug: string;
}

/** Why a printer earns nothing: the server's own list (worker/lib/rewards/earning.ts). */
export type PrinterStopped = 'warranty_closed' | 'warranty_over' | 'returned' | 'traded_in' | 'in_shop' | 'programme_off';

/** One of the customer's printers and what it earns: GET /api/rewards/program/printers. */
export interface RewardPrinter {
  order_item_id: string;
  unit_index: number;
  product_slug: string;
  name: Tri;
  image: string;
  delivered_at: string | null;
  warranty_start_at: string | null;
  earning: boolean;
  stopped: PrinterStopped | null;
  week: number;
  weeks_total: number;
  next_at: string | null;
  ends_at: string | null;
  this_week: Array<{ kind: RewardKind; state: RewardCoupon['state']; expires_at: string }>;
}

export interface RewardPrintersData {
  installed: boolean;
  server_time: string;
  printers: RewardPrinter[];
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
  /** code_ready: approved, and the code the team gives them is unwritten (row 301). */
  state: 'to_rate' | 'reward_pending' | 'code_ready' | 'reward_approved' | 'rated';
  stars: number | null;
  reward_level: number | null;
  /** The confirmed 1..100, once the customer has written the code: never before. */
  final_score?: number | null;
  /** The gift this printer's review became; absent from an older server. */
  gift?: PrinterGift | null;
  /** The team refused the reward, or sent the review back; absent from an older server. */
  reward_decision?: 'rejected' | 'revision' | null;
  /** The team's written reason for that decision, in its own words; empty for a system refusal. */
  reward_reason?: string;
  /** Row 303 R1: the printer went back, or its order was cancelled, so the review's code opens no gift. Absent from an older server. */
  code_void?: 'returned' | 'cancelled' | null;
  /** Row 303 R4: what the review itself earned when the team refused its gift; 0 otherwise. Absent from an older server. */
  review_points?: number;
}

/**
 * POST /api/rewards/program/gift-code and GET /gift-reveal/:giftId
 * (worker/lib/gifts/reviewCode.ts). Every figure of the analysis is here, and is
 * real; the page draws it and adds none. A closed level's gifts are never sent.
 */
export interface GiftReveal {
  score: number;
  levels: number[];
  track: Array<{ level: number; name: Tri; threshold: number; opened: boolean }>;
  breakdown: {
    text: { score: number; max: number; chars: number; words: number };
    images: { score: number; max: number; count: number };
    video: { score: number; max: number; present: boolean };
    story: { score: number; max: number; present: boolean };
    stars: { score: number; max: number; stars: number };
    /** The final score less the parts; 0 when they agree. */
    adjustment: number;
  };
  review: { product_id: string; slug: string; name: Tri; image: string; stars: number };
  gift: GiftView;
  replay?: boolean;
}

export interface GiftLevel {
  level: number;
  name: Tri;
  description: Tri;
  active: boolean;
  /** The score that opens this level; absent from an older server. */
  threshold?: number;
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

/** A product for points (DECISIONS row 299): one entry of `shop_items`, only what is on sale. */
export interface ShopProductItem {
  id: string;
  points: number;
  affordable: boolean;
  points_short: number;
  /** An un-ordered gift of this product is held: the swap would refuse it. */
  holding: boolean;
  /** Orderable right now. */
  available: boolean;
  product: {
    id: string;
    slug: string;
    name: Tri;
    image: string;
    option: Tri | null;
    color: Tri | null;
    color_hex?: string;
    qty?: number;
  };
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
  /** The products for points; absent from an older server. */
  shop_items?: ShopProductItem[];
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
