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

  // ---------------------------------------------------------------------
  // LEVO PLUS merchant stores (§83). PRO INHERITS every PLUS merchant
  // benefit — a PRO member is a more privileged merchant, not a lesser one.
  // PRIME does NOT: it is a delivery/priority tier for buyers, and granting
  // it selling rights would let someone open a shop on a plan that was never
  // sold as one. That exclusion is deliberate and is asserted in
  // tests/entitlements.test.ts so it cannot be "tidied up" later.
  //
  // Each is a separate name rather than one merchant flag, because
  // gated_benefits works per name: an admin must be able to suspend exactly
  // one capability — say, publishing products — over a complaint, without
  // cancelling a paid membership or locking the merchant out of their own
  // order history (§84).
  // ---------------------------------------------------------------------

  /** May own and operate a storefront. The gate for everything commercial. */
  merchantStore: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'merchantStore'),
  /** May publish products to that storefront. */
  merchantProducts: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'merchantProducts'),
  /** May receive and fulfil store orders. */
  merchantOrders: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'merchantOrders'),
  /** May submit offers on customer requests in the community marketplace. */
  communityOffers: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'communityOffers'),
  /** May see their own store analytics. */
  merchantAnalytics: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'merchantAnalytics'),
  /** Gets a dedicated storefront subdomain. */
  merchantSubdomain: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'merchantSubdomain'),
  /** PLUS+PRO: eligibility for PLUS-only coupons where the owner configures them. */
  exclusiveCoupons: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'pro') && notGated(t, 'exclusiveCoupons'),
  /** PLUS+PRIME+PRO: exclusive sections (bundles, random filament, special
   *  offers). PRIME was added by the owner's bundles mandate: «هذه الميزه
   *  تظهر لمشتركين فقط البلس والبريميوم والبرو» — every paid tier sees the
   *  bundles section; PRIME still gets no merchant/selling rights. */
  exclusiveSections: (t: TierStatus) =>
    t.active && (t.tier === 'plus' || t.tier === 'prime' || t.tier === 'pro') && notGated(t, 'exclusiveSections'),
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

/**
 * «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية» — the whole rule, in one
 * testable place.
 *
 * It lives here rather than inline in the checkout because it is a membership
 * rule, and every other one is here; the checkout supplies the facts and takes
 * the answer. The gift is worth 0 IQD on every total — the customer pays the
 * same price and a spool ships in the box — so nothing about it belongs in the
 * price resolver, the shipping quote or the wallet ledger.
 *
 * All four conditions are necessary:
 *   proContext        active PRO at the single approved default address, the
 *                     same gate every other PRO purchase benefit passes. An
 *                     order priced as ordinary does not earn a PRO gift.
 *   isPreorder        the order is on a pre-order journey; a direct sale earns
 *                     nothing, because the promise is about waiting.
 *   dueOnDeliveryIqd  exactly 0 — «مدفوع مقدمًا» means nothing is left to
 *                     collect at the door.
 *   a configured gift the owner has both enabled AND named a product for.
 *     An enabled switch with no product grants nothing; the admin endpoint
 *     refuses to store that combination, and this refuses to honour it if it
 *     somehow exists.
 */
export interface PreorderGiftConfig {
  enabled?: boolean;
  product_id?: string;
  label_ar?: string;
  qty?: number;
}

export interface PreorderGiftSnapshot {
  kind: 'preorder_filament';
  reason: 'pro_prepaid_preorder';
  product_id: string;
  label_ar: string;
  qty: number;
  /** Always 0: it is stock the store gives, not a discount on the total. */
  value_iqd: 0;
  granted_at: string;
}

export function preorderGiftFor(input: {
  config: PreorderGiftConfig | null | undefined;
  proContext: boolean;
  isPreorder: boolean;
  dueOnDeliveryIqd: number;
  now: string;
}): PreorderGiftSnapshot | null {
  const cfg = input.config;
  if (!cfg?.enabled || !cfg.product_id) return null;
  if (!input.proContext || !input.isPreorder) return null;
  if (input.dueOnDeliveryIqd !== 0) return null;
  const qty = Number.isInteger(cfg.qty) && (cfg.qty as number) > 0 ? (cfg.qty as number) : 1;
  return {
    kind: 'preorder_filament',
    reason: 'pro_prepaid_preorder',
    product_id: cfg.product_id,
    label_ar: cfg.label_ar ?? '',
    qty,
    value_iqd: 0,
    granted_at: input.now,
  };
}
