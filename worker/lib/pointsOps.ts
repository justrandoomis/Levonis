/**
 * Purchase points — integrated mandate §4.2 / §4.3 / §4.4 (SUPERSEDES the
 * earlier "1 point per 1,000 IQD, awarded at delivery" rule).
 *
 * THE RULE (§4.2)
 *  - 1 point per full `iqd_per_point` (100 by default) of NET ELIGIBLE
 *    MERCHANDISE: the applied product price × qty of official-store lines,
 *    after product/membership discounts, minus order-level coupon discounts,
 *    minus the points already spent on the same order.
 *  - Lines are summed FIRST and floored ONCE on the order total — never
 *    floored per line, which would silently lose points.
 *  - Delivery, preorder transport commissions and warranty fees are NOT
 *    merchandise: they never earn points and are never covered by them.
 *  - Redemption is a different rate: 1 point = exactly 1 IQD (§4.4). 739
 *    points discount 739 IQD — never rounded to 500 or 1,000.
 *
 * THE LIFECYCLE (§4.3)
 *  - A PENDING accrual is created inside the checkout batch, at the
 *    server-side purchase-confirmation event. `purchase_at` is precisely the
 *    instant that transaction committed the order (stock reserved, wallet and
 *    points debited, invoice issued) — never the browser clock, never cart
 *    creation, never a failed attempt (a failed attempt writes no row at all).
 *  - `available_at = purchase_at + 7×24h`, fixed at creation and never moved.
 *  - Release requires BOTH: available_at passed AND the payment settled.
 *    Wallet-prepaid orders settle at purchase; a COD order settles when a
 *    collection is RECORDED (§11.5 — delivery alone is not collection). A COD
 *    order collected on day 9 releases on day 9: settlement never starts a
 *    new seven-day clock.
 *  - Release happens in the durable job (worker/lib/jobs.ts) and on the
 *    settlement event itself — both idempotent, neither tied to a page open.
 *  - Cancellations/returns write negative reversal entries RECOMPUTED from
 *    the remaining eligible amount; history is never erased.
 *
 * RULE VERSIONING (§4.2 / acceptance test PTS-07)
 *  Settings key `pointsRuleConfig` = {iqd_per_point, legacy_iqd_per_point,
 *  effective_at, version, legacy_version}. The rate is resolved ONCE at
 *  purchase time and frozen on the accrual row, so changing the setting later
 *  can never re-price history. Orders that predate migration 0014 have no
 *  accrual row and keep the LEGACY path below (points_awards, 1,000 IQD per
 *  point, awarded at delivery) with their rows intact. Balances are never
 *  multiplied, re-granted or re-computed.
 *
 * The points VALUE lives in wallet_transactions (currency='POINT') — the same
 * ledger the rest of the app reads. points_accruals is the lifecycle and the
 * idempotency guard; PENDING points are NOT in the ledger and are therefore
 * not spendable, by construction.
 */

import type { Env } from './types';
import { safeParse } from './types';
import { newId } from './crypto';
import { getTierStatus } from './entitlements';
import {
  applyMultiplierX100,
  multipliedPointsSql,
  multiplierSql,
  rewardMultiplierX100,
  tierNameSql,
} from './pointsMultiplier';

// ---------------------------------------------------------------- pure math

export interface PointsItemFacts {
  qty: number;
  unit_price_iqd: number; // applied + effective commission + warranty fee (0002)
  pricing_snapshot: string | null; // JSON ResolvedPrice sans cost (has applied_iqd)
  warranty_snapshot: string | null; // JSON {fee_iqd,...}
  transport_snapshot: string | null; // JSON {commission_iqd, waived}
}

/**
 * Merchandise value of ONE unit of an order item: the applied product price
 * only — transport commission and warranty fee stripped. Prefers the
 * persisted resolver snapshot; falls back to subtracting the persisted fee
 * snapshots from unit_price_iqd for pre-snapshot rows.
 */
export function unitMerchandiseIqd(item: PointsItemFacts): number {
  const ps = safeParse<{ applied_iqd?: number } | null>(item.pricing_snapshot, null);
  if (ps && Number.isInteger(ps.applied_iqd) && (ps.applied_iqd as number) >= 0) {
    return ps.applied_iqd as number;
  }
  const warranty = safeParse<{ fee_iqd?: number } | null>(item.warranty_snapshot, null);
  const transport = safeParse<{ commission_iqd?: number; waived?: boolean } | null>(item.transport_snapshot, null);
  const wFee = warranty ? Number(warranty.fee_iqd) || 0 : 0;
  const comm = transport && transport.waived !== true ? Number(transport.commission_iqd) || 0 : 0;
  return Math.max(0, (Number(item.unit_price_iqd) || 0) - wFee - comm);
}

/**
 * Eligible MERCHANDISE of a whole order: Σ (applied unit price × qty).
 * Summed first — the floor is applied once, at the end, on the order total.
 */
export function eligibleMerchandiseIqd(items: PointsItemFacts[]): number {
  let merchandise = 0;
  for (const it of items) {
    merchandise += unitMerchandiseIqd(it) * Math.max(0, Math.trunc(Number(it.qty) || 0));
  }
  return merchandise;
}

/**
 * Net eligible base: merchandise minus the order-level coupon discount and
 * minus the points already spent on this order (§4.2 — "so points are not
 * re-earned on value the customer never paid"). Order-level discounts are
 * deducted IN FULL from the merchandise pool: the documented, deliberately
 * conservative distribution rule, since a coupon may partly cover shipping
 * and shipping must never earn points. Never negative.
 */
export function netEligibleIqd(merchandiseIqd: number, couponDiscountIqd: number, pointsSpentIqd: number): number {
  const base = Math.max(0, Math.trunc(Number(merchandiseIqd) || 0));
  const discounts =
    Math.max(0, Math.trunc(Number(couponDiscountIqd) || 0)) + Math.max(0, Math.trunc(Number(pointsSpentIqd) || 0));
  return Math.max(0, base - discounts);
}

/** Merchandise → net eligible base, in one call (order-total basis). */
export function computeQualifyingSpendIqd(
  items: PointsItemFacts[],
  couponDiscountIqd: number,
  pointsDiscountIqd: number
): number {
  return netEligibleIqd(eligibleMerchandiseIqd(items), couponDiscountIqd, pointsDiscountIqd);
}

/**
 * floor(net eligible / iqd_per_point) — ONE floor, on the order total.
 * 99 → 0, 100 → 1, 199 → 1, 75,000 → 750 at the 100 IQD rate.
 */
export function pointsForEligibleIqd(eligibleIqd: number, iqdPerPoint: number): number {
  const rate = Math.trunc(Number(iqdPerPoint) || 0);
  if (rate <= 0) return 0;
  const base = Number(eligibleIqd);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.floor(Math.trunc(base) / rate);
}

/**
 * Redemption cap (§4.4): apply ALL available points, capped at the eligible
 * official-store merchandise value AFTER product/membership/coupon discounts.
 * Never delivery, never community-store lines, never subscriptions. The
 * result is EXACT — 739 available against a 75,000 basis redeems 739.
 * Pending points are not passed in here: only released, spendable balance is.
 */
export function capRedeemablePoints(availablePoints: number, eligibleMerchandiseIqd: number): number {
  const available = Math.max(0, Math.trunc(Number(availablePoints) || 0));
  const cap = Math.max(0, Math.trunc(Number(eligibleMerchandiseIqd) || 0));
  return Math.min(available, cap);
}

/**
 * Refund distribution rule (§4.2: "distribute discounts AND refunds across the
 * lines with a correct, documented rule").
 *
 * A caller knows the GROSS merchandise value of the returned lines, but the
 * accrual was computed on the NET basis (gross minus coupon and points). The
 * returned portion is therefore scaled by the order's own discount ratio, so
 * a customer only loses the points they actually earned on the money they
 * actually paid for that line. The ratio is clamped to 1 and floored, so the
 * removed basis can never exceed the returned value.
 *
 * `grossMerchandiseIqd <= 0` (legacy orders with no stored merchandise basis)
 * falls back to the gross portion — conservative: it may remove marginally
 * more basis, never less, so points are never over-credited.
 */
export function allocateReversalPortion(
  portionGrossIqd: number,
  originalEligibleIqd: number,
  grossMerchandiseIqd: number
): number {
  const gross = Math.max(0, Math.trunc(Number(portionGrossIqd) || 0));
  const eligible = Math.max(0, Math.trunc(Number(originalEligibleIqd) || 0));
  const den = Math.trunc(Number(grossMerchandiseIqd) || 0);
  if (gross === 0) return 0;
  if (den <= 0 || eligible >= den) return gross;
  return Math.min(gross, Math.floor((gross * eligible) / den));
}

/**
 * Reversal math (§4.3: "a partial return recomputes the entitlement from the
 * REMAINING eligible amount with reversing entries, without erasing history").
 *
 * The points to remove are the difference between what the order currently
 * carries and what floor(remaining / rate) says it should carry — NOT a floor
 * of the returned portion on its own, which would drift away from the
 * order-total basis on repeated partial returns. `portionIqd` undefined means
 * a full reversal (nothing eligible remains).
 */
export function recomputeReversal(
  currentPoints: number,
  currentEligibleIqd: number,
  portionIqd: number | undefined,
  iqdPerPoint: number,
  /**
   * The subscription multiplier the accrual was FROZEN at (100 = none).
   * Without it a partial return would recompute the target from the base rate
   * alone and claw back the multiplied half of what the customer keeps: a PRO
   * who earned 1,500 on 75,000 IQD and returns half would be left with 375
   * instead of 750. The order's own frozen multiplier is passed in, never a
   * freshly-resolved one, so a membership that lapsed after the purchase
   * cannot change what a return costs.
   */
  multiplierX100 = 100
): { removePoints: number; removeEligible: number; remainingEligible: number; targetPoints: number } {
  const points = Math.max(0, Math.trunc(Number(currentPoints) || 0));
  const eligible = Math.max(0, Math.trunc(Number(currentEligibleIqd) || 0));
  const portion = portionIqd === undefined ? eligible : Math.max(0, Math.trunc(Number(portionIqd) || 0));
  const removeEligible = Math.min(portion, eligible);
  const remainingEligible = eligible - removeEligible;
  const targetPoints = applyMultiplierX100(
    pointsForEligibleIqd(remainingEligible, iqdPerPoint),
    multiplierX100
  );
  return {
    removePoints: Math.max(0, points - targetPoints),
    removeEligible,
    remainingEligible,
    targetPoints,
  };
}

// ------------------------------------------------------------ rule version

export interface PointsRuleConfig {
  iqd_per_point: number;
  legacy_iqd_per_point: number;
  effective_at: string | null;
  version: string;
  legacy_version: string;
}

export interface PointsRule {
  iqd_per_point: number;
  version: string;
  /** True when this order falls under the pre-effective_at (legacy) rate. */
  legacy: boolean;
}

export const POINTS_RULE_DEFAULTS: PointsRuleConfig = {
  iqd_per_point: 100,
  legacy_iqd_per_point: 1000,
  effective_at: null,
  version: 'v2',
  legacy_version: 'v1',
};

/** Seven days, in milliseconds — the §4.3 waiting period. */
export const ACCRUAL_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

const posInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;

/** Coerces the stored (possibly partial or malformed) setting into a full config. */
export function parsePointsRuleConfig(raw: unknown): PointsRuleConfig {
  const o = (typeof raw === 'string' ? safeParse<Record<string, unknown>>(raw, {}) : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const src = o && typeof o === 'object' ? o : {};
  const eff = typeof src.effective_at === 'string' && !Number.isNaN(Date.parse(src.effective_at))
    ? new Date(src.effective_at).toISOString()
    : null;
  return {
    iqd_per_point: posInt(src.iqd_per_point, POINTS_RULE_DEFAULTS.iqd_per_point),
    legacy_iqd_per_point: posInt(src.legacy_iqd_per_point, POINTS_RULE_DEFAULTS.legacy_iqd_per_point),
    effective_at: eff,
    version: typeof src.version === 'string' && src.version ? src.version : POINTS_RULE_DEFAULTS.version,
    legacy_version:
      typeof src.legacy_version === 'string' && src.legacy_version
        ? src.legacy_version
        : POINTS_RULE_DEFAULTS.legacy_version,
  };
}

/**
 * The rule an order earns under, resolved ONCE from its purchase instant.
 * A purchase strictly before `effective_at` keeps the legacy rate; from
 * `effective_at` onwards the new rate applies. `effective_at = null` means
 * the new rate is already in force (migration 0014 seeds a real timestamp,
 * so every pre-0014 order is unambiguously legacy).
 */
export function resolvePointsRule(config: PointsRuleConfig, purchaseAtIso: string): PointsRule {
  const eff = config.effective_at ? Date.parse(config.effective_at) : NaN;
  const at = Date.parse(purchaseAtIso);
  const isLegacy = Number.isFinite(eff) && Number.isFinite(at) && at < eff;
  return isLegacy
    ? { iqd_per_point: config.legacy_iqd_per_point, version: config.legacy_version, legacy: true }
    : { iqd_per_point: config.iqd_per_point, version: config.version, legacy: false };
}

/** available_at for a purchase instant: exactly seven 24-hour days later. */
export function availableAtFrom(purchaseAtIso: string): string {
  const t = Date.parse(purchaseAtIso);
  const base = Number.isFinite(t) ? t : Date.now();
  return new Date(base + ACCRUAL_HOLD_MS).toISOString();
}

/**
 * Reads `pointsRuleConfig` from admin_settings. Kept as a direct read rather
 * than through lib/settings.ts: that module's typed defaults map is owned by
 * another slice, and the points rule must not depend on it landing first.
 */
export async function getPointsRuleConfig(env: Env): Promise<PointsRuleConfig> {
  const row = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'pointsRuleConfig'")
    .first<{ value: string }>();
  return parsePointsRuleConfig(row?.value);
}

// -------------------------------------------------------- accrual creation

export interface AccrualPlan {
  id: string;
  source_ref: string;
  order_id: string;
  user_id: string;
  /**
   * Points the accrual will carry AFTER the subscription multiplier.
   *
   * Exact when the caller supplied `multiplierX100` (or used the async
   * `buildPurchaseAccrual`, which resolves it). When it did not, the
   * multiplier is resolved by the INSERT itself inside the checkout
   * transaction and this field reports the un-multiplied base — see
   * `multiplier_resolved_in_statement`, which says which of the two happened.
   */
  points: number;
  /** Points before the multiplier. Always exact. */
  base_points: number;
  /** 100 / 150 / 200, or null when the INSERT resolves it in-statement. */
  multiplier_x100: number | null;
  /** The tier the multiplier came from, or null when resolved in-statement. */
  tier_at_award: string | null;
  /** True when the row's multiplier is decided by SQL at commit time. */
  multiplier_resolved_in_statement: boolean;
  eligible_iqd: number;
  rule: PointsRule;
  purchase_at: string;
  available_at: string;
  /** Stamped immediately when the order is fully paid at purchase. */
  settled_at: string | null;
}

export interface PurchaseAccrualInput {
  orderId: string;
  userId: string;
  /** The instant the checkout transaction confirmed the purchase (ISO UTC). */
  purchaseAt: string;
  /** Net eligible merchandise after coupon and points spent. */
  netEligibleIqd: number;
  rule: PointsRule;
  /** True when nothing is due on delivery (wallet/points covered the total). */
  settledAtPurchase: boolean;
  /**
   * The subscription reward multiplier, ALREADY RESOLVED by the caller
   * (100 / 150 / 200). Omit it and the INSERT resolves it itself from
   * `memberships` and `restriction_cases` at the instant the checkout
   * transaction commits — which is the safer default, because there is then
   * no window between reading the membership and writing the award.
   */
  multiplierX100?: number;
  /** The tier that multiplier came from; only read when multiplierX100 is given. */
  tier?: string;
}

/**
 * Builds the statements that create the PENDING accrual. Returned rather than
 * executed so the caller embeds them in the SAME D1 batch as the order — the
 * accrual can never exist without its order, nor an order without its
 * accrual. UNIQUE(order_id) WHERE kind='purchase' makes a replay abort the
 * batch instead of accruing twice.
 */
export function buildPurchaseAccrualStatements(
  env: Env,
  input: PurchaseAccrualInput
): { statements: D1PreparedStatement[]; accrual: AccrualPlan } {
  const base = pointsForEligibleIqd(input.netEligibleIqd, input.rule.iqd_per_point);
  const eligible = Math.max(0, Math.trunc(Number(input.netEligibleIqd) || 0));
  const supplied = input.multiplierX100 !== undefined;
  const multiplier = supplied ? Math.max(100, Math.trunc(Number(input.multiplierX100) || 100)) : null;
  const accrual: AccrualPlan = {
    id: newId('pac'),
    source_ref: `order:${input.orderId}:accrual`,
    order_id: input.orderId,
    user_id: input.userId,
    points: multiplier === null ? base : applyMultiplierX100(base, multiplier),
    base_points: base,
    multiplier_x100: multiplier,
    tier_at_award: multiplier === null ? null : String(input.tier ?? ''),
    multiplier_resolved_in_statement: multiplier === null,
    eligible_iqd: eligible,
    rule: input.rule,
    purchase_at: input.purchaseAt,
    available_at: availableAtFrom(input.purchaseAt),
    settled_at: input.settledAtPurchase ? input.purchaseAt : null,
  };

  // THE MULTIPLIER IS FROZEN HERE, IN THIS STATEMENT, IN THE CHECKOUT
  // TRANSACTION. Whether it arrives as a bound constant (?12/?13) or is read
  // out of `memberships` by the SELECT itself, `points`, `base_points`,
  // `multiplier_x100` and `tier_at_award` are all written together, once, and
  // never recomputed. Release reads `points` off the row seven days later, so
  // a subscription that lapses in between cannot rewrite what was earned —
  // and a subscription bought in between cannot inflate it either.
  const multExpr = multiplier === null ? multiplierSql('?4', '?9') : '?12';
  const tierExpr = multiplier === null ? tierNameSql('?4', '?9') : '?13';
  const statements = [
    env.DB.prepare(
      `INSERT INTO points_accruals
         (id, source_ref, order_id, user_id, kind, points, base_points, multiplier_x100, tier_at_award,
          eligible_iqd, iqd_per_point, rule_version,
          state, purchase_at, available_at, settled_at, reason)
       SELECT ?1, ?2, ?3, ?4, 'purchase',
              ${multipliedPointsSql('?5', 'm.mult')}, ?5, m.mult, m.tier,
              ?6, ?7, ?8, 'pending', ?9, ?10, ?11, 'purchase'
         FROM (SELECT ${multExpr} AS mult, ${tierExpr} AS tier) m`
    ).bind(
      accrual.id,
      accrual.source_ref,
      accrual.order_id,
      accrual.user_id,
      accrual.base_points,
      accrual.eligible_iqd,
      accrual.rule.iqd_per_point,
      accrual.rule.version,
      accrual.purchase_at,
      accrual.available_at,
      accrual.settled_at,
      ...(multiplier === null ? [] : [multiplier, accrual.tier_at_award]),
    ),
  ];
  return { statements, accrual };
}

/**
 * The same plan with the multiplier resolved BEFORE the batch, so every number
 * in `AccrualPlan` is exact and a caller can show the customer what they are
 * about to earn. Prefer it wherever an await is available; the statements it
 * returns still carry the multiplier as a bound constant, so the row is
 * written atomically with the order exactly as before.
 */
export async function buildPurchaseAccrual(
  env: Env,
  input: PurchaseAccrualInput
): Promise<{ statements: D1PreparedStatement[]; accrual: AccrualPlan }> {
  if (input.multiplierX100 !== undefined) return buildPurchaseAccrualStatements(env, input);
  const status = await getTierStatus(env.DB, input.userId);
  return buildPurchaseAccrualStatements(env, {
    ...input,
    multiplierX100: rewardMultiplierX100(status),
    tier: status.tier,
  });
}

/**
 * Statement that cancels a still-PENDING accrual (order cancelled before it
 * ever released). Conditional on state='pending', so an already-released
 * accrual is left to the reversal path instead of being silently erased.
 */
export function cancelPendingAccrualStatement(
  env: Env,
  orderId: string,
  reason: string,
  atIso: string
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE points_accruals
        SET state = 'cancelled', cancelled_at = ?, reason = ?
      WHERE order_id = ? AND state = 'pending'`
  ).bind(atIso, String(reason || 'cancelled').slice(0, 120), orderId);
}

// ------------------------------------------------------------- settlement

export type SettlementKind = 'prepaid_at_purchase' | 'cod_collection' | 'adjustment';

export interface SettlementInput {
  kind: SettlementKind;
  amountIqd: number;
  /** Unique business event key for this order — replays record once. */
  eventKey: string;
  reference?: string;
  note?: string;
  recordedBy?: 'system' | 'admin';
  actorId?: string | null;
  settledAt?: string;
}

export interface SettlementResult {
  recorded: boolean;
  duplicate: boolean;
  collected_iqd: number;
  total_iqd: number;
  fully_settled: boolean;
  reason?: string;
}

/**
 * Statement that records one collection event. Returned so a caller can put
 * it in the same batch as the rest of a checkout.
 */
export function buildSettlementStatements(
  env: Env,
  orderId: string,
  input: SettlementInput
): D1PreparedStatement[] {
  const at = input.settledAt ?? new Date().toISOString();
  const amount = Math.max(0, Math.trunc(Number(input.amountIqd) || 0));
  return [
    env.DB.prepare(
      `INSERT INTO order_payment_settlements
         (id, order_id, event_key, kind, amount_iqd, reference, note, recorded_by, actor_id, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      newId('set'),
      orderId,
      String(input.eventKey).slice(0, 120),
      input.kind,
      amount,
      String(input.reference ?? '').slice(0, 200),
      String(input.note ?? '').slice(0, 300),
      input.recordedBy ?? 'system',
      input.actorId ?? null,
      at
    ),
    // Stamp settlement on the accrual ONLY when the recorded collections now
    // cover the order total. Both the comparison and the write happen in one
    // statement, so there is no check-then-write race, and a partially paid
    // order stays pending (§4.3: never issue points on money not collected).
    env.DB.prepare(
      `UPDATE points_accruals
          SET settled_at = ?2
        WHERE order_id = ?1 AND kind = 'purchase' AND state = 'pending' AND settled_at IS NULL
          AND (SELECT COALESCE(SUM(s.amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = ?1)
              >= (SELECT o.total_iqd FROM orders o WHERE o.id = ?1)`
    ).bind(orderId, at),
  ];
}

/**
 * Records a payment collection for an order (§11.5). Idempotent per
 * (order_id, event_key): a replayed courier callback, a retried job or a
 * double-clicked admin button records exactly one row. Recording a
 * collection is the ONLY thing that can settle a COD order — delivery does
 * not, and this function is never called by the delivered transition.
 */
export async function recordOrderSettlement(
  env: Env,
  orderId: string,
  input: SettlementInput
): Promise<SettlementResult> {
  const order = await env.DB.prepare('SELECT id, status, total_iqd FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; status: string; total_iqd: number }>();
  if (!order) return { recorded: false, duplicate: false, collected_iqd: 0, total_iqd: 0, fully_settled: false, reason: 'order_not_found' };
  if (order.status === 'cancelled') {
    return { recorded: false, duplicate: false, collected_iqd: 0, total_iqd: Number(order.total_iqd) || 0, fully_settled: false, reason: 'order_cancelled' };
  }

  let duplicate = false;
  try {
    await env.DB.batch(buildSettlementStatements(env, orderId, input));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) duplicate = true;
    else throw e;
  }

  const sums = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_iqd), 0) AS collected FROM order_payment_settlements WHERE order_id = ?'
  )
    .bind(orderId)
    .first<{ collected: number }>();
  const collected = Number(sums?.collected) || 0;
  const total = Number(order.total_iqd) || 0;
  return {
    recorded: !duplicate,
    duplicate,
    collected_iqd: collected,
    total_iqd: total,
    fully_settled: collected >= total,
  };
}

// ----------------------------------------------------------------- release

export interface AwardResult {
  awarded: boolean;
  points: number;
  reason?: string;
}

/**
 * Releases one order's accrual when BOTH conditions hold. Safe to call from
 * anywhere, any number of times, concurrently:
 *  1. the purchase row flips pending→released only if it is still pending,
 *     settled and due (single winner);
 *  2. pending reversal rows flip only if the purchase row carries THIS run's
 *     released_at token — a losing run touches nothing;
 *  3. the POINT deposit is written only when that same token matches and the
 *     amount it computes in-statement is positive, with a deterministic id
 *     whose PRIMARY KEY makes a second credit impossible.
 * All of it is one D1 batch, so a losing race writes nothing at all.
 */
export async function releaseAccrualForOrder(env: Env, orderId: string, nowIso?: string): Promise<AwardResult> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, state, settled_at, available_at FROM points_accruals
      WHERE order_id = ? AND kind = 'purchase'`
  )
    .bind(orderId)
    .first<{ id: string; user_id: string; state: string; settled_at: string | null; available_at: string }>();
  if (!row) return { awarded: false, points: 0, reason: 'no_accrual' };
  if (row.state === 'released') return { awarded: false, points: 0, reason: 'already_released' };
  if (row.state === 'cancelled') return { awarded: false, points: 0, reason: 'cancelled' };
  if (!row.settled_at) return { awarded: false, points: 0, reason: 'awaiting_settlement' };

  const now = nowIso ?? new Date().toISOString();
  if (Date.parse(row.available_at) > Date.parse(now)) {
    return { awarded: false, points: 0, reason: 'awaiting_availability' };
  }

  const wtxId = `wtx_acc_${row.id}`;
  const note = `Purchase points released for order ${orderId}`;
  let res: D1Result[];
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE points_accruals SET state = 'released', released_at = ?1
          WHERE order_id = ?2 AND kind = 'purchase' AND state = 'pending'
            AND settled_at IS NOT NULL AND available_at <= ?3`
      ).bind(now, orderId, now),
      env.DB.prepare(
        `UPDATE points_accruals SET state = 'released', released_at = ?1
          WHERE order_id = ?2 AND kind = 'reversal' AND state = 'pending'
            AND EXISTS (SELECT 1 FROM points_accruals p
                         WHERE p.order_id = ?2 AND p.kind = 'purchase'
                           AND p.state = 'released' AND p.released_at = ?1)`
      ).bind(now, orderId),
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'deposit', 'POINT',
                (SELECT COALESCE(SUM(p.points), 0) FROM points_accruals p
                  WHERE p.order_id = ?3 AND p.state = 'released' AND p.released_at = ?4),
                'approved', ?5, ?3, 'system', ?4
          WHERE (SELECT COALESCE(SUM(p.points), 0) FROM points_accruals p
                  WHERE p.order_id = ?3 AND p.state = 'released' AND p.released_at = ?4) > 0`
      ).bind(wtxId, row.user_id, orderId, now, note),
      env.DB.prepare(
        `UPDATE points_accruals SET wallet_tx_id = ?1
          WHERE order_id = ?2 AND kind = 'purchase' AND released_at = ?3
            AND EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.id = ?1)`
      ).bind(wtxId, orderId, now),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return { awarded: false, points: 0, reason: 'already_released' };
    }
    throw e;
  }

  if ((res[0]?.meta.changes ?? 0) === 0) return { awarded: false, points: 0, reason: 'already_released' };
  const credited = Number(res[2]?.meta.changes ?? 0) > 0
    ? (await env.DB.prepare('SELECT amount FROM wallet_transactions WHERE id = ?').bind(wtxId).first<{ amount: number }>())
        ?.amount ?? 0
    : 0;
  return { awarded: true, points: Number(credited) || 0 };
}

export interface ReleaseSweepReport {
  scanned: number;
  released: number;
  points: number;
  skipped: number;
}

/**
 * Durable sweep (§4.3: "a scheduled or otherwise reliable process releases
 * entitlements once — not tied to the user opening the page"). Picks accruals
 * that are pending, settled and past available_at, and releases each through
 * the idempotent path above.
 */
export async function releaseDueAccruals(env: Env, limit = 200): Promise<ReleaseSweepReport> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT order_id FROM points_accruals
      WHERE kind = 'purchase' AND state = 'pending' AND settled_at IS NOT NULL AND available_at <= ?
      ORDER BY available_at ASC LIMIT ?`
  )
    .bind(now, Math.max(1, Math.min(1000, Math.trunc(limit))))
    .all<{ order_id: string }>();

  const report: ReleaseSweepReport = { scanned: results.length, released: 0, points: 0, skipped: 0 };
  for (const r of results) {
    const out = await releaseAccrualForOrder(env, r.order_id, now);
    if (out.awarded) {
      report.released += 1;
      report.points += out.points;
    } else {
      report.skipped += 1;
    }
  }
  return report;
}

// ------------------------------------------------------- legacy (pre-0014)

interface OrderPointsRow {
  id: string;
  user_id: string;
  status: string;
  points_discount_iqd: number;
  coupon_snapshot: string | null;
}

async function loadLegacyOrderFacts(
  env: Env,
  orderId: string
): Promise<{ order: OrderPointsRow; items: PointsItemFacts[]; couponIqd: number } | null> {
  const order = await env.DB.prepare(
    'SELECT id, user_id, status, points_discount_iqd, coupon_snapshot FROM orders WHERE id = ?'
  )
    .bind(orderId)
    .first<OrderPointsRow>();
  if (!order) return null;
  const { results: items } = await env.DB.prepare(
    'SELECT qty, unit_price_iqd, pricing_snapshot, warranty_snapshot, transport_snapshot FROM order_items WHERE order_id = ?'
  )
    .bind(orderId)
    .all<PointsItemFacts>();
  const coupon = safeParse<{ discount_iqd?: number } | null>(order.coupon_snapshot, null);
  return { order, items, couponIqd: coupon ? Number(coupon.discount_iqd) || 0 : 0 };
}

/**
 * Pre-0014 orders only: the ORIGINAL delivered-event award at the legacy rate
 * (1,000 IQD per point), guarded by points_awards PRIMARY KEY. Their rows and
 * their rate stay exactly as earned — mandate §4.2 forbids re-pricing them.
 */
async function legacyAwardOnDelivery(env: Env, orderId: string): Promise<AwardResult> {
  const facts = await loadLegacyOrderFacts(env, orderId);
  if (!facts) return { awarded: false, points: 0, reason: 'order_not_found' };
  const { order, items, couponIqd } = facts;
  if (order.status !== 'delivered') return { awarded: false, points: 0, reason: 'not_delivered' };

  const config = await getPointsRuleConfig(env);
  const qualifying = computeQualifyingSpendIqd(items, couponIqd, Number(order.points_discount_iqd) || 0);
  const points = pointsForEligibleIqd(qualifying, config.legacy_iqd_per_point);

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points) VALUES (?, ?, ?)').bind(
      `order:${orderId}:award`,
      order.user_id,
      points
    ),
  ];
  if (points > 0) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
      ).bind(`wtx_pts_${orderId}`, order.user_id, points, `Purchase points for delivered order ${orderId}`, orderId, now)
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return { awarded: false, points: 0, reason: 'already_awarded' };
    }
    throw e;
  }
  return { awarded: true, points };
}

/**
 * Delivered-transition hook. NAME AND SIGNATURE ARE FROZEN (worker/routes/
 * admin.ts calls it) but the SEMANTICS are the mandate's, not the old
 * award-on-delivery rule:
 *
 *  - Orders with a 0014 accrual: delivery neither awards nor settles. It only
 *    ATTEMPTS a release, which succeeds solely if the seven days have passed
 *    AND a collection was recorded. A delivered COD order whose cash was not
 *    recorded returns {awarded:false, reason:'awaiting_settlement'} — the
 *    honest state. Record the collection with recordOrderSettlement().
 *  - Orders that predate 0014: the legacy delivered award, unchanged.
 */
export async function awardOrderPoints(env: Env, orderId: string): Promise<AwardResult> {
  const accrual = await env.DB.prepare(
    "SELECT id FROM points_accruals WHERE order_id = ? AND kind = 'purchase'"
  )
    .bind(orderId)
    .first<{ id: string }>();
  if (accrual) return releaseAccrualForOrder(env, orderId);
  return legacyAwardOnDelivery(env, orderId);
}

// ---------------------------------------------------------------- reversal

export interface ReversalResult {
  reversed: boolean;
  points: number;
  reason?: string;
}

/**
 * Reverses purchase points on a cancellation/return.
 *
 * New lifecycle: the remaining eligible amount is recomputed and the target
 * points re-derived from it with the order's OWN frozen rate — a partial
 * return removes exactly floor(remaining/rate) fewer points, never a
 * per-portion floor that would over- or under-charge the customer. If the
 * accrual is still pending the reversal only reduces the pending amount (no
 * ledger movement ever happened); if it already released, a balance-guarded
 * claw-back is written and reports honestly when the customer already spent
 * the points instead of faking one.
 *
 * Legacy orders keep the original points_awards reversal path.
 */
export async function reversePointsForOrder(
  env: Env,
  orderId: string,
  reason: string,
  opts: { portionIqd?: number; sourceRef?: string } = {}
): Promise<ReversalResult> {
  const purchase = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.state, a.iqd_per_point, a.rule_version, a.eligible_iqd,
            a.multiplier_x100, o.merchandise_iqd AS gross_merchandise
       FROM points_accruals a JOIN orders o ON o.id = a.order_id
      WHERE a.order_id = ? AND a.kind = 'purchase'`
  )
    .bind(orderId)
    .first<{
      id: string; user_id: string; state: string; iqd_per_point: number; rule_version: string;
      eligible_iqd: number; multiplier_x100: number | null; gross_merchandise: number | null;
    }>();
  if (!purchase) return legacyReverse(env, orderId, reason, opts);
  if (purchase.state === 'cancelled') return { reversed: false, points: 0, reason: 'accrual_cancelled' };

  // Current net position across the purchase row and every reversal so far.
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(points), 0) AS points, COALESCE(SUM(eligible_iqd), 0) AS eligible
       FROM points_accruals WHERE order_id = ? AND state <> 'cancelled'`
  )
    .bind(orderId)
    .first<{ points: number; eligible: number }>();
  const currentPoints = Number(totals?.points) || 0;
  const currentEligible = Number(totals?.eligible) || 0;

  // Callers (worker/routes/returns.ts) hand over the GROSS merchandise value
  // of the returned lines; scale it onto the net basis the accrual used.
  const portionNet =
    opts.portionIqd === undefined
      ? undefined
      : allocateReversalPortion(
          opts.portionIqd,
          Number(purchase.eligible_iqd) || 0,
          Number(purchase.gross_merchandise) || 0
        );
  // The order's OWN frozen multiplier, never a freshly-resolved one: a
  // membership that lapsed (or was bought) after the purchase must not change
  // what a return costs the customer.
  const frozenMultiplier = Math.max(100, Number(purchase.multiplier_x100) || 100);
  const { removePoints, removeEligible } = recomputeReversal(
    currentPoints,
    currentEligible,
    portionNet,
    Number(purchase.iqd_per_point) || 0,
    frozenMultiplier
  );

  if (removePoints <= 0 && removeEligible <= 0) {
    return { reversed: false, points: 0, reason: 'nothing_to_reverse' };
  }

  const suffix = opts.sourceRef ? `:${String(opts.sourceRef).slice(0, 60)}` : '';
  const sourceRef = `order:${orderId}:reverse${suffix}`;
  const now = new Date().toISOString();
  const note = `Points reversal for order ${orderId}: ${reason}`.slice(0, 300);
  const alreadyReleased = purchase.state === 'released';
  const rowId = newId('pac');

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO points_accruals
         (id, source_ref, order_id, user_id, kind, points, eligible_iqd, iqd_per_point, rule_version,
          multiplier_x100, tier_at_award, state, purchase_at, available_at, released_at, reason)
       SELECT ?1, ?2, ?3, p.user_id, 'reversal', ?4, ?5, p.iqd_per_point, p.rule_version,
              p.multiplier_x100, p.tier_at_award, ?6, p.purchase_at, p.available_at, ?7, ?8
         FROM points_accruals p WHERE p.order_id = ?3 AND p.kind = 'purchase'`
    ).bind(
      rowId,
      sourceRef,
      orderId,
      -removePoints,
      -removeEligible,
      alreadyReleased ? 'released' : 'pending',
      alreadyReleased ? now : null,
      String(reason || 'reversal').slice(0, 120)
    ),
  ];
  if (alreadyReleased && removePoints > 0) {
    // Conditional amount: turns negative (violating CHECK amount > 0) when the
    // live POINT balance no longer covers the claw-back, aborting the whole
    // batch atomically — the reversal row is never written without its ledger
    // entry. Same pattern as checkout point spending.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'POINT',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='POINT' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(`wtx_pacrev_${rowId}`, purchase.user_id, removePoints, note, orderId, now)
    );
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return { reversed: false, points: 0, reason: 'already_reversed' };
    }
    if (msg.includes('CHECK')) {
      return { reversed: false, points: removePoints, reason: 'insufficient_points_balance' };
    }
    throw e;
  }
  return { reversed: true, points: removePoints };
}

/** Pre-0014 orders: the original points_awards reversal, unchanged. */
async function legacyReverse(
  env: Env,
  orderId: string,
  reason: string,
  opts: { portionIqd?: number; sourceRef?: string }
): Promise<ReversalResult> {
  const award = await env.DB.prepare('SELECT user_id, points FROM points_awards WHERE source_ref = ?')
    .bind(`order:${orderId}:award`)
    .first<{ user_id: string; points: number }>();
  if (!award || (Number(award.points) || 0) <= 0) {
    return { reversed: false, points: 0, reason: 'nothing_awarded' };
  }

  const prior = await env.DB.prepare(
    'SELECT COALESCE(SUM(points), 0) AS total FROM points_awards WHERE source_ref LIKE ? AND points < 0'
  )
    .bind(`order:${orderId}:reverse%`)
    .first<{ total: number }>();
  const remaining = (Number(award.points) || 0) + (Number(prior?.total) || 0); // reversals are negative
  if (remaining <= 0) return { reversed: false, points: 0, reason: 'already_reversed' };

  const config = await getPointsRuleConfig(env);
  let toReverse = remaining;
  if (opts.portionIqd !== undefined) {
    const portionPoints = pointsForEligibleIqd(Math.max(0, Math.trunc(opts.portionIqd)), config.legacy_iqd_per_point);
    toReverse = Math.min(remaining, portionPoints);
  }
  if (toReverse <= 0) return { reversed: false, points: 0, reason: 'no_points_in_portion' };

  const suffix = opts.sourceRef ? `:${String(opts.sourceRef).slice(0, 60)}` : '';
  const key = `order:${orderId}:reverse${suffix}`;
  const wtxId = opts.sourceRef ? `wtx_ptsrev_${String(opts.sourceRef).slice(0, 40)}` : `wtx_ptsrev_${orderId}`;
  const now = new Date().toISOString();
  const note = `Points reversal for order ${orderId}: ${reason}`.slice(0, 300);

  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points) VALUES (?, ?, ?)').bind(
        key,
        award.user_id,
        -toReverse
      ),
      env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'POINT',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='POINT' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(wtxId, award.user_id, toReverse, note, orderId, now),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return { reversed: false, points: 0, reason: 'already_reversed' };
    }
    if (msg.includes('CHECK')) {
      return { reversed: false, points: toReverse, reason: 'insufficient_points_balance' };
    }
    throw e;
  }
  return { reversed: true, points: toReverse };
}

// --------------------------------------------------------- read models (§5)

export interface OrderPointsSnapshot {
  order_id: string;
  /** Points still waiting (pending accrual net of pending reversals). */
  pending: number;
  /** Points already released to the spendable balance from this order. */
  released: number;
  state: 'pending' | 'released' | 'cancelled' | 'none';
  /** Fixed at purchase: purchase_at + 7 days. Null for legacy orders. */
  available_at: string | null;
  purchase_at: string | null;
  settled_at: string | null;
  eligible_iqd: number;
  iqd_per_point: number | null;
  rule_version: string | null;
  /** Recorded collections (wallet at purchase + COD collections). */
  collected_iqd: number;
  /** Points REDEEMED on this order (the §4.4 reservation), and its state. */
  redeemed: number;
  redemption_state: 'committed' | 'refunded' | 'none';
}

/**
 * Per-order points + settlement facts for the §5 unified financial snapshot.
 * One query per aspect for the whole page of orders — never a per-row loop.
 */
export async function getOrderPointsSnapshots(
  env: Env,
  orderIds: string[]
): Promise<Map<string, OrderPointsSnapshot>> {
  const out = new Map<string, OrderPointsSnapshot>();
  const ids = orderIds.filter((id) => typeof id === 'string' && id).slice(0, 200);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');

  const { results: accruals } = await env.DB.prepare(
    `SELECT order_id, kind, points, eligible_iqd, state, purchase_at, available_at, settled_at,
            iqd_per_point, rule_version
       FROM points_accruals WHERE order_id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{
      order_id: string; kind: string; points: number; eligible_iqd: number; state: string;
      purchase_at: string; available_at: string; settled_at: string | null;
      iqd_per_point: number; rule_version: string;
    }>();

  for (const r of accruals) {
    const snap = out.get(r.order_id) ?? {
      order_id: r.order_id, pending: 0, released: 0, state: 'none' as const, available_at: null,
      purchase_at: null, settled_at: null, eligible_iqd: 0, iqd_per_point: null, rule_version: null,
      collected_iqd: 0, redeemed: 0, redemption_state: 'none' as const,
    };
    if (r.state === 'pending') snap.pending += Number(r.points) || 0;
    if (r.state === 'released') snap.released += Number(r.points) || 0;
    if (r.state !== 'cancelled') snap.eligible_iqd += Number(r.eligible_iqd) || 0;
    if (r.kind === 'purchase') {
      snap.state = (r.state as OrderPointsSnapshot['state']) ?? 'none';
      snap.available_at = r.available_at;
      snap.purchase_at = r.purchase_at;
      snap.settled_at = r.settled_at;
      snap.iqd_per_point = Number(r.iqd_per_point) || null;
      snap.rule_version = r.rule_version;
    }
    out.set(r.order_id, snap);
  }

  const { results: settlements } = await env.DB.prepare(
    `SELECT order_id, COALESCE(SUM(amount_iqd), 0) AS collected
       FROM order_payment_settlements WHERE order_id IN (${placeholders}) GROUP BY order_id`
  )
    .bind(...ids)
    .all<{ order_id: string; collected: number }>();
  for (const s of settlements) {
    const snap = out.get(s.order_id);
    if (snap) snap.collected_iqd = Number(s.collected) || 0;
    else {
      out.set(s.order_id, {
        order_id: s.order_id, pending: 0, released: 0, state: 'none', available_at: null,
        purchase_at: null, settled_at: null, eligible_iqd: 0, iqd_per_point: null, rule_version: null,
        collected_iqd: Number(s.collected) || 0, redeemed: 0, redemption_state: 'none',
      });
    }
  }

  const { results: reservations } = await env.DB.prepare(
    `SELECT order_id, points, state FROM points_reservations WHERE order_id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ order_id: string; points: number; state: string }>();
  for (const r of reservations) {
    const snap = out.get(r.order_id) ?? {
      order_id: r.order_id, pending: 0, released: 0, state: 'none' as const, available_at: null,
      purchase_at: null, settled_at: null, eligible_iqd: 0, iqd_per_point: null, rule_version: null,
      collected_iqd: 0, redeemed: 0, redemption_state: 'none' as const,
    };
    snap.redeemed = Number(r.points) || 0;
    snap.redemption_state = r.state === 'refunded' ? 'refunded' : 'committed';
    out.set(r.order_id, snap);
  }
  return out;
}
