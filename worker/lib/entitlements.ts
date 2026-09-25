/**
 * Membership tiers and benefit checks — SERVER-SIDE ONLY source of truth.
 * Never trust a browser-supplied tier, localStorage flag, or request field.
 *
 * States (mandate §8.1):
 *   pending_payment          — created, wallet charge not completed
 *   prepaid_pending_launch   — paid before the owner's launch event; reserves
 *                              the full duration, clock not started. LEGACY
 *                              since the site went live: nothing writes one
 *                              while the launch is activated, and one left
 *                              over is converted on its account's next read
 *   active                   — running; expires_at set
 *   expired / cancelled      — terminal
 *
 * Launch: admin_settings key `launchConfig` = {launch_at: ISO|null,
 * activated: bool, activated_at}. THE SITE IS LIVE: a missing row means
 * "activated" (DEFAULT_LAUNCH below), migration 0109 writes the row as
 * activated on every database that had not been, and a reservation still
 * waiting from before is converted the first time its account is read
 * (`getTierStatus` → worker/lib/launchActivation.ts). The admin button
 * (POST /api/memberships/admin/activate-launch) remains for any leftovers.
 */

import type { Env, SessionUser } from './types';
import { safeParse } from './types';
import { TIER_RANK, type Tier } from './pricing';
import { normalizePhone } from './phone';

export interface LaunchConfig {
  launch_at: string | null;
  activated: boolean;
  activated_at: string | null;
}

/**
 * «الموقع يعمل» — THE DEFAULT IS LIVE. This used to say `activated: false`, so
 * a database nobody had pressed the launch button on sold every card as a
 * reservation that granted nothing (`getTierStatus` counts only `active`
 * rows) and told the customer «تُفعّل عند إطلاق الموقع» on a site that was
 * already running. An owner who genuinely wants a pre-launch gate again writes
 * `activated: false` into the setting on purpose; forgetting to write it can
 * no longer switch the memberships off.
 */
export const DEFAULT_LAUNCH: LaunchConfig = { launch_at: null, activated: true, activated_at: null };

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

/**
 * The canonical membership contract.  A benefit is introduced once, at the
 * lowest tier that owns it; higher tiers inherit it through TIER_RANK.
 *
 * Database values keep the historical `prime` id for compatibility, while
 * every customer-facing surface calls that tier PREMIUM.  Nothing may infer
 * access from the label sent by a browser: routes resolve TierStatus from the
 * memberships ledger and ask this table.
 */
export const ENTITLEMENT_MINIMUM_TIER = {
  merchantProfile: 'plus',
  merchantStore: 'plus',
  merchantProducts: 'plus',
  merchantOrders: 'plus',
  communityOffers: 'plus',
  merchantAnalytics: 'plus',
  merchantSubdomain: 'plus',
  exclusiveCoupons: 'plus',
  exclusiveSections: 'plus',
  memberOffers: 'plus',

  premiumPricing: 'prime',
  premiumDelivery: 'prime',
  premiumRewards: 'prime',

  /**
   * The cash-on-delivery tax exemption, as an entitlement an admin can
   * restrict on one account the way every other benefit can be.
   *
   * Minimum tier PREMIUM, not PRO, and the distinction is the point: the
   * entitlement says which tiers MAY be exempt, and the configured rule in
   * `membership_benefit_rules` says whether they actually are. PREMIUM ships
   * with a rule that says no. Putting the answer in the rule rather than in
   * this table is what lets the owner change it without a deploy.
   */
  codTaxExemption: 'prime',

  proPricing: 'pro',
  freeDelivery: 'pro',
  noPreorderCommission: 'pro',
  proMerchantBadge: 'pro',
  priorityService: 'pro',
  priorityDelivery12h: 'pro',
  bnpl: 'pro',
  proExclusive: 'pro',
} as const satisfies Record<string, Exclude<Tier, 'free'>>;

export type MembershipEntitlement = keyof typeof ENTITLEMENT_MINIMUM_TIER;

/** The inheritance relation exposed to offer/configuration tooling. */
export const TIER_INHERITANCE: Record<Tier, Tier[]> = {
  free: ['free'],
  plus: ['free', 'plus'],
  prime: ['free', 'plus', 'prime'],
  pro: ['free', 'plus', 'prime', 'pro'],
};

export function tierInherits(tier: Tier, required: Tier): boolean {
  return TIER_INHERITANCE[tier].includes(required);
}

/** True only for a live server-resolved membership with this entitlement. */
export function hasEntitlement(status: TierStatus, entitlement: MembershipEntitlement): boolean {
  if (!status.active) return false;
  const minimum = ENTITLEMENT_MINIMUM_TIER[entitlement];
  if ((TIER_RANK[status.tier] ?? 0) < TIER_RANK[minimum]) return false;
  const gated = status.gated_benefits ?? [];
  // `verifiedMerchant` was the old restriction flag.  Honour it as an alias
  // during the rename so an existing safety restriction cannot be bypassed.
  if (entitlement === 'proMerchantBadge' && gated.includes('verifiedMerchant')) return false;
  if (entitlement === 'premiumDelivery' && gated.includes('primeDeliveryEligible')) return false;
  return !gated.includes(entitlement);
}

/** Safe public snapshot: facts derived on the server, never accepted back. */
export function entitlementSnapshot(status: TierStatus): Record<MembershipEntitlement, boolean> {
  return Object.fromEntries(
    (Object.keys(ENTITLEMENT_MINIMUM_TIER) as MembershipEntitlement[]).map((name) => [name, hasEntitlement(status, name)])
  ) as Record<MembershipEntitlement, boolean>;
}

/**
 * Resolve one entitlement for a page of users without moving membership
 * lifecycle/ranking logic into a route. This is the bulk counterpart of
 * `getTierStatus`; community/store lists use it for the PRO status badge.
 */
export async function usersWithEntitlement(
  db: D1Database,
  userIds: unknown[],
  entitlement: MembershipEntitlement
): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const entitled = new Set<string>();
  if (ids.length === 0) return entitled;

  // ONE bound parameter for the whole list (json_each), not one per id: the
  // live D1 refuses a statement over 100 bound parameters, and a followed-shops
  // list or a community page can name more users than that (review F1).
  const idsJson = JSON.stringify(ids);
  const inIds = `(SELECT value FROM json_each(?))`;
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `UPDATE memberships SET state = 'expired'
        WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at < ?
          AND user_id IN ${inIds}`
    )
    .bind(nowIso, idsJson)
    .run();

  const [{ results: memberships }, { results: restrictions }] = await Promise.all([
    db
      .prepare(
        `SELECT user_id, tier, expires_at FROM memberships
          WHERE state = 'active' AND (expires_at IS NULL OR expires_at >= ?)
            AND user_id IN ${inIds}`
      )
      .bind(nowIso, idsJson)
      .all<{ user_id: string; tier: Exclude<Tier, 'free'>; expires_at: string | null }>(),
    db
      .prepare(`SELECT user_id, benefit_flags FROM restriction_cases WHERE state = 'active' AND user_id IN ${inIds}`)
      .bind(idsJson)
      .all<{ user_id: string; benefit_flags: string }>(),
  ]);

  const flagsByUser = new Map<string, Set<string>>();
  for (const row of restrictions) {
    const flags = flagsByUser.get(row.user_id) ?? new Set<string>();
    for (const flag of safeParse<unknown[]>(row.benefit_flags, [])) if (typeof flag === 'string') flags.add(flag);
    flagsByUser.set(row.user_id, flags);
  }
  const statusByUser = new Map<string, TierStatus>();
  for (const row of memberships) {
    const previous = statusByUser.get(row.user_id);
    if (previous && TIER_RANK[previous.tier] >= TIER_RANK[row.tier]) continue;
    statusByUser.set(row.user_id, {
      tier: row.tier,
      active: true,
      expires_at: row.expires_at,
      pending_launch: null,
      gated_benefits: [...(flagsByUser.get(row.user_id) ?? [])],
    });
  }
  for (const [userId, status] of statusByUser) if (hasEntitlement(status, entitlement)) entitled.add(userId);
  return entitled;
}

/** Reward multiplier in hundredths: PLUS 1×, PREMIUM 1.5×, PRO 2×. */
export function dailyRewardMultiplierX100(status: TierStatus): number {
  if (!status.active || !hasEntitlement(status, 'premiumRewards')) return 100;
  return hasEntitlement(status, 'priorityService') ? 200 : 150;
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

  let rows = results;
  if (rows.some((m) => m.state === 'prepaid_pending_launch')) {
    rows = await convertReservationOnRead(db, userId, rows, nowIso);
  }
  const active = rows.find((m) => m.state === 'active');
  const pending = rows.find((m) => m.state === 'prepaid_pending_launch');

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

/**
 * A RESERVATION MET AFTER THE LAUNCH STARTS HERE, ON ITS OWN.
 *
 * The owner's option 1b: rather than asking anyone to press a button, the one
 * place every tier question passes through turns a waiting reservation into a
 * running membership the first time the account is read once the launch is
 * live — the customer who paid opens the site and has what they paid for. The
 * dedupe is the admin sweep's own (`convertLaunchReservations`), so the two
 * paths can never disagree about which row wins.
 *
 * Only when a reservation exists, which is a SELECT this function already
 * made; an account without one pays nothing extra. A failure here never fails
 * the read it rides on — the tier is then answered from the rows as they
 * stand, which is exactly the answer before this existed.
 */
async function convertReservationOnRead(
  db: D1Database,
  userId: string,
  rows: MembershipRow[],
  nowIso: string
): Promise<MembershipRow[]> {
  try {
    const launch = await getLaunchConfig(db);
    if (!launch.activated) return rows;
    // Lazily, because launchActivation needs addMonths from membershipOps,
    // and membershipOps imports this module.
    const { convertLaunchReservations } = await import('./launchActivation');
    const res = await convertLaunchReservations(db, { actorId: null, nowIso, userId, auditDeferred: false });
    if (res.converted === 0) return rows;
    const { results } = await db
      .prepare(
        `SELECT * FROM memberships
          WHERE user_id = ? AND state IN ('active','prepaid_pending_launch')
          ORDER BY CASE tier WHEN 'pro' THEN 0 WHEN 'prime' THEN 1 ELSE 2 END, expires_at DESC`
      )
      .bind(userId)
      .all<MembershipRow>();
    return results;
  } catch (e) {
    console.error('reservation conversion on read failed', userId, e instanceof Error ? e.message : String(e));
    return rows;
  }
}

/** Convenience for routes that already loaded the session user. */
export async function effectiveTier(env: Env, user: SessionUser): Promise<{ tier: Tier; active: boolean }> {
  const s = await getTierStatus(env.DB, user.id);
  return { tier: s.tier, active: s.active };
}

// ------------------------------------------------- the PRO purchase context

const collapse = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function phoneKey(raw: unknown): string {
  const s = String(raw ?? '');
  return normalizePhone(s) ?? s.replace(/\D+/g, '');
}

/**
 * Is this address the customer's current APPROVED default PRO address
 * (approved_addresses, 0003)? Read-only: approval/change flows live in the
 * PRO administration module. Matching normalizes harmless whitespace/case and
 * phone formats — it never mutates anything. No approved row (non-PRO users,
 * or PRO before approval) → false.
 */
export async function isApprovedDefaultAddress(
  db: D1Database,
  userId: string,
  address: Record<string, unknown>
): Promise<boolean> {
  const approved = await db
    .prepare(
      `SELECT name, phone_e164, address, landmark FROM approved_addresses
        WHERE user_id = ? AND state = 'approved'
        ORDER BY version DESC LIMIT 1`
    )
    .bind(userId)
    .first<{ name: string; phone_e164: string; address: string; landmark: string }>();
  if (!approved) return false;
  return (
    collapse(address.name) === collapse(approved.name) &&
    collapse(address.address) === collapse(approved.address) &&
    phoneKey(address.phone) === phoneKey(approved.phone_e164)
  );
}

/** The customer's default address (the first one when none is marked). */
export async function defaultAddressOf(db: D1Database, userId: string): Promise<Record<string, unknown> | null> {
  return db
    .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at ASC LIMIT 1')
    .bind(userId)
    .first<Record<string, unknown>>();
}

/**
 * THE ONE PRO PURCHASE CONTEXT — computed the same way on every surface that
 * prices a line: the product page, the product quote, the cart and the
 * checkout. CONFIRMED §6.3: PRO purchase benefits (PRO product prices, the
 * pre-order commission waiver, the direct-sale premium waiver, the shipping
 * waiver, priority) exist only at the single approved default PRO address;
 * anywhere else the whole pricing context is ordinary. Active restriction
 * cases (§10) pause the pricing benefits without touching the membership —
 * the resolver applies PRO prices and both availability waivers through one
 * flag, so gating either 'proPricing' or 'noPreorderCommission' pauses that
 * whole context.
 *
 * `address` is the address the money is being quoted FOR: the checkout passes
 * the one the customer selected; the product page and the cart, which have no
 * selection yet, pass nothing and are judged at the customer's DEFAULT
 * address — the address a checkout would open on. So a PRO whose default
 * address is not (yet) approved sees the surcharge on the product page, in
 * the cart and at the checkout alike, instead of a price the door will not
 * honour. Recomputed per request, never stored.
 */
export interface PricingTierContext {
  tierStatus: TierStatus;
  /** The judged address matches the approved default PRO address. */
  atApprovedDefault: boolean;
  /** PRO purchase benefits apply to THIS quote. */
  proContext: boolean;
  /** What the resolver is told as `tierActive`: PRO only inside proContext. */
  pricingTierActive: boolean;
}

export async function pricingTierContext(
  db: D1Database,
  userId: string,
  address?: Record<string, unknown> | null
): Promise<PricingTierContext> {
  const tierStatus = await getTierStatus(db, userId);
  let atApprovedDefault = false;
  if (tierStatus.tier === 'pro' && tierStatus.active) {
    const judged = address === undefined ? await defaultAddressOf(db, userId) : address;
    atApprovedDefault = judged ? await isApprovedDefaultAddress(db, userId, judged) : false;
  }
  const proContext =
    atApprovedDefault &&
    benefits.proPricing(tierStatus) &&
    benefits.noPreorderCommission(tierStatus);
  return {
    tierStatus,
    atApprovedDefault,
    proContext,
    pricingTierActive:
      tierStatus.tier === 'pro'
        ? proContext
        : tierStatus.tier === 'prime'
          ? benefits.premiumPricing(tierStatus)
          : tierStatus.active,
  };
}

// Backward-compatible named helpers. All of them delegate to the matrix above;
// routes do not own tier comparisons.
export const benefits = {
  merchantProfile: (t: TierStatus) => hasEntitlement(t, 'merchantProfile'),
  merchantStore: (t: TierStatus) => hasEntitlement(t, 'merchantStore'),
  merchantProducts: (t: TierStatus) => hasEntitlement(t, 'merchantProducts'),
  merchantOrders: (t: TierStatus) => hasEntitlement(t, 'merchantOrders'),
  communityOffers: (t: TierStatus) => hasEntitlement(t, 'communityOffers'),
  merchantAnalytics: (t: TierStatus) => hasEntitlement(t, 'merchantAnalytics'),
  merchantSubdomain: (t: TierStatus) => hasEntitlement(t, 'merchantSubdomain'),
  exclusiveCoupons: (t: TierStatus) => hasEntitlement(t, 'exclusiveCoupons'),
  exclusiveSections: (t: TierStatus) => hasEntitlement(t, 'exclusiveSections'),
  memberOffers: (t: TierStatus) => hasEntitlement(t, 'memberOffers'),
  premiumPricing: (t: TierStatus) => hasEntitlement(t, 'premiumPricing'),
  premiumDelivery: (t: TierStatus) => hasEntitlement(t, 'premiumDelivery'),
  premiumRewards: (t: TierStatus) => hasEntitlement(t, 'premiumRewards'),
  proPricing: (t: TierStatus) => hasEntitlement(t, 'proPricing'),
  freeDelivery: (t: TierStatus) => hasEntitlement(t, 'freeDelivery'),
  noPreorderCommission: (t: TierStatus) => hasEntitlement(t, 'noPreorderCommission'),
  /** Compatibility name; this is a PRO status badge, never KYC verification. */
  verifiedMerchant: (t: TierStatus) => hasEntitlement(t, 'proMerchantBadge'),
  proMerchantBadge: (t: TierStatus) => hasEntitlement(t, 'proMerchantBadge'),
  priorityService: (t: TierStatus) => hasEntitlement(t, 'priorityService'),
  priorityDelivery12h: (t: TierStatus) => hasEntitlement(t, 'priorityDelivery12h'),
  bnpl: (t: TierStatus) => hasEntitlement(t, 'bnpl'),
  proExclusive: (t: TierStatus) => hasEntitlement(t, 'proExclusive'),
  primeDeliveryEligible: (t: TierStatus) => hasEntitlement(t, 'premiumDelivery'),
};

/** PRO shipping rules supersede the inherited PREMIUM rule for a PRO order. */
export function shippingEntitlementContext(t: TierStatus): {
  proShippingEntitled: boolean;
  premiumShippingEntitled: boolean;
} {
  const pro = benefits.freeDelivery(t);
  return {
    proShippingEntitled: pro,
    premiumShippingEntitled: !pro && benefits.primeDeliveryEligible(t),
  };
}

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
