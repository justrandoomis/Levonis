/**
 * Membership tiers and benefit checks — SERVER-SIDE ONLY source of truth.
 * Never trust a browser-supplied tier, localStorage flag, or request field.
 *
 * States (mandate §8.1):
 *   pending_payment          — created, wallet charge not completed
 *   prepaid_pending_launch   — paid before the owner-configured launch event;
 *                              reserves the full duration, clock not started
 *   active                   — running; expires_at set
 *   expired / cancelled      — terminal
 *
 * Launch: admin_settings key `launchConfig` = {launch_at: ISO|null,
 * activated: bool, activated_at}. Activation is an explicit, audited,
 * idempotent admin action (POST /api/admin/memberships/activate-launch) —
 * never an automatic clock during staging tests.
 */

import type { Env, SessionUser } from './types';
import { safeParse } from './types';
import type { Tier } from './pricing';

export interface LaunchConfig {
  launch_at: string | null;
  activated: boolean;
  activated_at: string | null;
}

export const DEFAULT_LAUNCH: LaunchConfig = { launch_at: null, activated: false, activated_at: null };

export interface MembershipRow {
  id: string;
  user_id: string;
  plan_id: string;
  tier: 'plus' | 'pro';
  state: string;
  duration_months: number;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
}

export interface TierStatus {
  tier: Tier;
  active: boolean;
  expires_at: string | null;
  pending_launch: { tier: 'plus' | 'pro'; duration_months: number } | null;
}

export async function getLaunchConfig(db: D1Database): Promise<LaunchConfig> {
  const row = await db.prepare("SELECT value FROM admin_settings WHERE key = 'launchConfig'").first<{ value: string }>();
  if (!row) return DEFAULT_LAUNCH;
  return safeParse(row.value, DEFAULT_LAUNCH);
}

/**
 * Resolves the user's effective tier from the memberships ledger.
 * PRO takes precedence over PLUS when both are active. Also lazily marks
 * overdue rows expired (idempotent, safe under concurrency: conditional
 * UPDATE on state+expiry).
 */
export async function getTierStatus(db: D1Database, userId: string): Promise<TierStatus> {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      "UPDATE memberships SET state = 'expired' WHERE user_id = ? AND state = 'active' AND expires_at IS NOT NULL AND expires_at < ?"
    )
    .bind(userId, nowIso)
    .run();

  const { results } = await db
    .prepare(
      `SELECT * FROM memberships
        WHERE user_id = ? AND state IN ('active','prepaid_pending_launch')
        ORDER BY CASE tier WHEN 'pro' THEN 0 ELSE 1 END, expires_at DESC`
    )
    .bind(userId)
    .all<MembershipRow>();

  const active = results.find((m) => m.state === 'active');
  const pending = results.find((m) => m.state === 'prepaid_pending_launch');

  const status: TierStatus = {
    tier: active ? active.tier : 'free',
    active: !!active,
    expires_at: active?.expires_at ?? null,
    pending_launch: pending ? { tier: pending.tier, duration_months: pending.duration_months } : null,
  };

  // Keep the legacy users.* cache in sync (many read paths still use it).
  await db
    .prepare(
      `UPDATE users SET subscription_plan = ?, subscription_expiry = ?
        WHERE id = ? AND (subscription_plan <> ? OR subscription_expiry <> ?)`
    )
    .bind(
      status.tier,
      status.expires_at ? new Date(status.expires_at).getTime() : 0,
      userId,
      status.tier,
      status.expires_at ? new Date(status.expires_at).getTime() : 0
    )
    .run();

  return status;
}

/** Convenience for routes that already loaded the session user. */
export async function effectiveTier(env: Env, user: SessionUser): Promise<{ tier: Tier; active: boolean }> {
  const s = await getTierStatus(env.DB, user.id);
  return { tier: s.tier, active: s.active };
}

// Benefit checks — single definitions so PLUS/PRO gates never drift apart.
export const benefits = {
  /** PLUS+PRO: professional merchant profile in the community. */
  merchantProfile: (t: TierStatus) => t.active && (t.tier === 'plus' || t.tier === 'pro'),
  /** PLUS+PRO: exclusive sections (bundles, random filament, special offers). */
  exclusiveSections: (t: TierStatus) => t.active && (t.tier === 'plus' || t.tier === 'pro'),
  /** PRO: explicit/policy product discounts (resolver applies pricing). */
  proPricing: (t: TierStatus) => t.active && t.tier === 'pro',
  /** PRO: free last-mile delivery on all orders. */
  freeDelivery: (t: TierStatus) => t.active && t.tier === 'pro',
  /** PRO: preorder transport commission waived. */
  noPreorderCommission: (t: TierStatus) => t.active && t.tier === 'pro',
  /** PRO: verified/distinguished merchant + advertising eligibility. */
  verifiedMerchant: (t: TierStatus) => t.active && t.tier === 'pro',
  /** PRO: priority service/preparation flag on orders and support. */
  priorityService: (t: TierStatus) => t.active && t.tier === 'pro',
  /** PRO: PRO-only products/offers/coupons eligibility. */
  proExclusive: (t: TierStatus) => t.active && t.tier === 'pro',
};
