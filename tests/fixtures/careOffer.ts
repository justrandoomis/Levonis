/**
 * A LIVE LEVO CARE PART OFFER, WRITTEN AS THE DESK'S BATCH WRITES IT (migration 0243; DECISIONS row 358):
 * the personal carrier coupon and its `care_part_grants` row. For suites that own a cart fixture (kits,
 * add-ons, bundles, gifts, trade-in, pre-orders) and need to prove what the automatic discount does there,
 * without building a device and a claim first. The device named is unknown to the database, so the offer is
 * held only to its own ceiling.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface SeededCareOffer { grantId: string; couponId: string }

export function seedCareOffer(
  raw: DatabaseSync,
  o: { user: string; product: string; pct?: number; max?: number | null; key?: string }
): SeededCareOffer {
  const key = o.key ?? `${o.user}_${o.product}`;
  const grantId = `cpg_${key}`;
  const couponId = `cpc_${key}`;
  const now = new Date().toISOString();
  const ends = new Date(Date.now() + 14 * 86_400_000).toISOString();
  raw
    .prepare(
      `INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, starts_at, ends_at, max_global, max_per_user, active, created_at,
          assigned_user_id, scope, product_id, applies_to, cap_scope, max_discount_iqd, max_quantity, stacks)
       VALUES (?, ?, NULL, 'percent', ?, 0, NULL, ?, 1, 1, 1, ?, ?, 'product', ?, 'merchandise', 'per_order', ?, 1, 1)`
    )
    .run(couponId, `CARE-${key.toUpperCase()}`, o.pct ?? 50, ends, now, o.user, o.product, o.max ?? null);
  raw
    .prepare(
      `INSERT INTO care_part_grants (id, claim_id, user_id, entitlement_unit_id, product_id, coupon_id, discount_pct, max_discount_iqd,
          misuse, note, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, 'staff', ?)`
    )
    .run(grantId, `wc_${key}`, o.user, `unit_${key}`, o.product, couponId, o.pct ?? 50, o.max ?? null, ends, now);
  return { grantId, couponId };
}

/** How many times the offer's coupon is spent on a live order (0 = still the customer's). */
export const careOfferUses = (raw: DatabaseSync, couponId: string): number =>
  Number(
    (raw.prepare(
      `SELECT (SELECT COUNT(*) FROM coupon_redemption_extras WHERE coupon_id = ?1 AND state = 'active')
            + (SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = ?1 AND state = 'active') AS n`
    ).get(couponId) as { n: number }).n
  );
