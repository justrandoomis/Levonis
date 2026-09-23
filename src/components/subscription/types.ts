/**
 * The membership API as this page reads it. Kept local to the page on
 * purpose — src/lib/api.ts belongs to another change; these mirror
 * worker/routes/memberships.ts field for field.
 */
import type { AnyTier, PaidTier } from './tierMeta';

export interface ApiPlan {
  id: string;
  tier: PaidTier;
  duration_months: number;
  /** null = unpriced — an honest "not purchasable yet", never a zero. */
  price_iqd: number | null;
  purchasable: boolean;
  /** Math.round(price / months), computed by the server; null while unpriced. */
  per_month_iqd: number | null;
  sort: number;
}

export interface LaunchInfo {
  launch_at: string | null;
  activated: boolean;
}

/** Conditional perks, as the server reports them switched on right now. */
export interface PlanFeatures {
  /** Always false since the printer gift became a manual grant; kept for the wire shape. */
  printer_gift: boolean;
  preorder_gift: boolean;
}

/** Free-delivery thresholds from the same shipping policy the quote engine applies. */
export interface DeliveryThresholds {
  pro_threshold_iqd: number;
  prime_threshold_iqd: number;
}

export interface PlansResponse {
  plans: ApiPlan[];
  launch: LaunchInfo;
  features?: PlanFeatures;
  delivery?: DeliveryThresholds;
  /**
   * The canonical capability matrix (ENTITLEMENT_MINIMUM_TIER), resolved per
   * tier on the server. The comparison reads its ticks from here, so an
   * inherited benefit is a tick in every higher column by construction.
   */
  entitlement_contract?: {
    minimum_tier: Record<string, PaidTier>;
    tiers: Record<PaidTier, Record<string, boolean>>;
  };
  /** Daily check-in points multiplier per tier, in hundredths (150 = ×1.5). */
  points_multiplier_x100?: Record<PaidTier, number>;
}

export interface ApiMembership {
  id: string;
  plan_id: string;
  tier: PaidTier;
  state: 'pending_payment' | 'prepaid_pending_launch' | 'active' | 'expired' | 'cancelled' | string;
  duration_months: number;
  price_paid_iqd: number;
  purchased_at: string;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
}

export interface TierStatus {
  tier: AnyTier;
  active: boolean;
  expires_at: string | null;
  pending_launch: { tier: PaidTier; duration_months: number } | null;
  /** Benefits paused by an active restriction case — shown to the member. */
  gated_benefits?: string[];
}

export interface MineResponse {
  status: TierStatus;
  /** The authenticated user's server-derived capability snapshot. */
  entitlements?: Record<string, boolean>;
  memberships: ApiMembership[];
  referral?: { code: string; rewards: unknown[] };
  launch: LaunchInfo;
}

/** GET /api/memberships/quote — what buying the plan would do for THIS account. */
export type PurchaseQuote =
  | {
      ok: true;
      plan: ApiPlan;
      price_iqd: number;
      credit_iqd: number;
      charge_iqd: number;
      exchange_rate: number;
      charge_usd_cents: number;
      balance_usd_cents: number;
      shortfall_usd_cents: number;
      /**
       * THE WALLET IN DINARS — what /wallet prints, and what the purchase's
       * affordability is decided in (quotePayload, migration 0108). Absent
       * only from a server older than that.
       */
      balance_iqd?: number;
      shortfall_iqd?: number;
      activate_now: boolean;
      launch_at: string | null;
      expires_at: string | null;
      /** The lower tier this purchase ends (active, or a prepaid reservation) and credits. */
      upgrade_from_tier: PaidTier | null;
    }
  | { ok: false; code: string; message: string; plan: ApiPlan };

/** What the page sends back with the confirmation: the very figures it displayed. */
export interface ConfirmedFigures {
  charge_iqd: number;
  charge_usd_cents: number;
}

export interface SubscribeResponse {
  replay: boolean;
  membership: ApiMembership;
  charged_iqd: number;
  charged_usd_cents: number;
  credit_iqd: number;
  upgraded_from?: PaidTier | null;
}

export type PurchaseResult =
  | { kind: 'ok'; res: SubscribeResponse }
  | { kind: 'err'; code?: string; message: string };
