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
  tier: 'plus' | 'pro' | 'prime';
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
  pending_launch: { tier: 'plus' | 'pro' | 'prime'; duration_months: number } | null;
  /** Benefit names gated by ACTIVE restriction cases (admin decisions,
   *  final phase §10). Gates benefit computation only — never data access,
   *  support, warranty, repayment or login. */
  gated_benefits: string[];
}

export async function getLaunchConfig(db: D1Database): Promise<LaunchConfig> {
  const row = await db.prepare("SELECT value FROM admin_settings WHERE key = 'launchConfig'").first<{ value: string }>();
  if (!row) return DEFAULT_LAUNCH;
  return safeParse(row.value, DEFAULT_LAUNCH);
}

/**
 * Resolves the user's effective tier from the memberships ledger.
 * Precedence is PRO > PRIME > PLUS when several are active (product-form
 * mandate §5: "PRO الفعّال أولًا، ثم PRIME الفعّال، ثم المستخدم الاعتيادي").
 * Also lazily marks
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
        ORDER BY CASE tier WHEN 'pro' THEN 0 WHEN 'prime' THEN 1 ELSE 2 END, expires_at DESC`
    )
    .bind(userId)
    .all<MembershipRow>();

  const active = results.find((m) => m.state === 'active');
  const pending = results.find((m) => m.state === 'prepaid_pending_launch');

  // Active restriction cases gate specific benefits (admin decision with
  // reason + audit, worker/routes/support.ts). Merged here — the single
  // choke point — so checkout, pricing, community and support all honor
  // the same decision without separate wiring.
  const gated = new Set<string>();
  const { results: cases } = await db
    .prepare("SELECT benefit_flags FROM restriction_cases WHERE user_id = ? AND state = 'active'")
    .bind(userId)
    .all<{ benefit_flags: string }>();
  for (const r of cases) {
    for (const f of safeParse<unknown[]>(r.benefit_flags, [])) {
      if (typeof f === 'string') gated.add(f);
    }
  }

  const status: TierStatus = {
    tier: active ? active.tier : 'free',
    active: !!active,
    expires_at: active?.expires_at ?? null,
    pending_launch: pending ? { tier: pending.tier, duration_months: pending.duration_months } : null,
    gated_benefits: [...gated],
  };

  // Cache the resolved tier on the user row. `membership_tier` (migration
  // 0018) is the column every reader uses; it is unconstrained, so it can
  // carry 'prime'.
  //
  // `subscription_plan` is the pre-0018 column and its CHECK only admits
  // free/plus/pro. Rebuilding `users` to widen that CHECK would mean dropping
  // and re-creating a table that 60 foreign keys point at, which is not a
  // proportionate risk for a column nothing reads any more — so it keeps
  // being maintained for its legal domain and a PRIME member reads 'free'
  // there. Do not reintroduce a reader; the column is dropped in a later
  // migration.
  const legacyPlan = status.tier === 'prime' ? 'free' : status.tier;
  const expiryMs = status.expires_at ? new Date(status.expires_at).getTime() : 0;
  await db
    .prepare(
      `UPDATE users SET membership_tier = ?, subscription_plan = ?, subscription_expiry = ?
        WHERE id = ? AND (membership_tier <> ? OR subscription_plan <> ? OR subscription_expiry <> ?)`
    )
    .bind(status.tier, legacyPlan, expiryMs, userId, status.tier, legacyPlan, expiryMs)
    .run();

  return status;
}

/** Convenience for routes that already loaded the session user. */
export async function effectiveTier(env: Env, user: SessionUser): Promise<{ tier: Tier; active: boolean }> {
  const s = await getTierStatus(env.DB, user.id);
  return { tier: s.tier, active: s.active };
}

// Benefit checks — single definitions so PLUS/PRO gates never drift apart.
// Every check honors gated_benefits: an active restriction case pauses the
// specific benefit without touching the paid membership record itself.
const notGated = (t: TierStatus, name: string) => !(t.gated_benefits ?? []).includes(name);
export const benefits = {
  /** PLUS+PRO: professional merchant profile in the community. */
  merchantProfile: (t: TierStatus) => t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'merchantProfile'),
  /** PLUS+PRO: exclusive sections (bundles, random filament, special offers). */
  exclusiveSections: (t: TierStatus) => t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'exclusiveSections'),
  /** PRO: explicit/policy product discounts (resolver applies pricing). */
  proPricing: (t: TierStatus) => t.active && t.tier === 'pro' && notGated(t, 'proPricing'),
  /** PRO: free last-mile delivery on all orders. */
  freeDelivery: (t: TierStatus) => t.active && t.tier === 'pro' && notGated(t, 'freeDelivery'),
  /** PRO: preorder transport commission waived. */
  noPreorderCommission: (t: TierStatus) => t.active && t.tier === 'pro' && notGated(t, 'noPreorderCommission'),
  /** PRO: verified/distinguished merchant + advertising eligibility. */
  verifiedMerchant: (t: TierStatus) => t.active && t.tier === 'pro' && notGated(t, 'verifiedMerchant'),
  /** PRO: priority service/preparation flag on orders and support. */
  priorityService: (t: TierStatus) => t.active && t.tier === 'pro' && notGated(t, 'priorityService'),
  /** PRO: PRO-only products/offers/coupons eligibility. */
  proExclusive: (t: TierStatus) => t.active && t.tier === 'pro' && notGated(t, 'proExclusive'),
  /** PRIME: CONDITIONAL free last-mile delivery. Unlike PRO's unconditional
   *  waiver this only says the member is eligible to be TESTED against the
   *  150,000 IQD threshold — worker/lib/shipping.ts applies the comparison,
   *  and 150,000 itself does not qualify (mandate §5). PRIME grants no other
   *  PRO benefit: no preorder-commission waiver, no priority service, no
   *  PRO-exclusive catalog. */
  primeDeliveryEligible: (t: TierStatus) =>
    t.active && t.tier === 'prime' && notGated(t, 'primeDeliveryEligible'),
};
