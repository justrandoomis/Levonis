/**
 * THE LEVO CARE PART OFFER — printer services phase 5 (owner request 2026-11-18; DECISIONS row 358;
 * migration 0243).
 *
 * The customer applies for Levo Care on /warranty. Staff answer in the claim thread with a discount on ONE
 * store part (an ordinary product). He adds it to the cart and orders it like any part, and the discount
 * applies by itself — on one unit of that product, once, for that account only.
 *
 * HOW IT IS CARRIED. Each offer (`care_part_grants`) owns ONE personal coupon: percent, scope product,
 * one unit, one use, stacks, ends with the offer. So the discount is an ordinary coupon discount at every
 * door that already knows one — `order_items.coupon_discount_iqd`, `coupon_snapshot.discount_iqd`, profit,
 * refunds, the release on cancel — and nothing here is a second discount system. The coupon's code is
 * random and never shown; typed in the code box it answers as an unknown code (`isCareCouponId`).
 *
 * WHERE THE USE IS WRITTEN. Always in `coupon_redemption_extras` (0225), beside the order's own code —
 * never as the order's coupon (0243 refuses it), so `coupon_redemptions` keeps meaning «the code the
 * customer typed» for every reader. «Used» is never stored on the offer: it is that live row. A cancel
 * before delivery releases it (0225's trigger) and the offer is live again until it ends.
 *
 * Every reader tolerates a database without 0243: no offers, no discount, [] on every list.
 */
import { SPENT_AMOUNT_SQL, SPENT_ON_SQL, SPENT_SQL } from './rewards/pool';
import { isSchemaMissing } from './membershipBenefits';
import { safeParse } from './types';

export const PART_VALID_DAYS = 14;
export const PART_MAX_LIVE = 5;
/** The id prefix of a part offer's coupon (`cpc_…`): how a reader without 0243 still knows one. */
export const CARE_COUPON_PREFIX = 'cpc';
export const isCareCouponId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(`${CARE_COUPON_PREFIX}_`);
/** SQL: `alias.id` is NOT a part offer's coupon (the admin coupon list, the product-delete guard). */
export const notCareCouponSql = (alias = ''): string => `${alias ? `${alias}.` : ''}id NOT LIKE '${CARE_COUPON_PREFIX}~_%' ESCAPE '~'`;

const installedDbs = new WeakMap<object, true>();
/** Is migration 0243 on this database? Only «present» is remembered. */
export async function carePartGrantsInstalled(db: D1Database): Promise<boolean> {
  if (installedDbs.has(db as object)) return true;
  try {
    await db.prepare('SELECT (SELECT COUNT(*) FROM care_part_grants WHERE 0) AS a, (SELECT part_grant_id FROM claim_messages WHERE 0) AS b').first();
    installedDbs.set(db as object, true);
    return true;
  } catch {
    return false;
  }
}

export type GrantState = 'live' | 'used' | 'revoked' | 'expired';

export interface CarePartGrantRow {
  id: string;
  claim_id: string;
  user_id: string;
  entitlement_unit_id: string;
  product_id: string;
  coupon_id: string;
  discount_pct: number;
  max_discount_iqd: number | null;
  misuse: number;
  note: string;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  /** The live order that spent the offer's coupon, and what it took off; null / 0 when none. */
  used_order_id: string | null;
  discount_given_iqd: number | null;
}

const GRANT_SELECT = `SELECT g.*, ${SPENT_ON_SQL('g.coupon_id')} AS used_order_id, ${SPENT_AMOUNT_SQL('g.coupon_id')} AS discount_given_iqd
  FROM care_part_grants g`;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** used (its coupon is spent on a live order) › revoked › expired › live. */
export function grantState(g: Pick<CarePartGrantRow, 'used_order_id' | 'revoked_at' | 'expires_at'>, nowMs = Date.now()): GrantState {
  if (g.used_order_id) return 'used';
  if (g.revoked_at) return 'revoked';
  const end = Date.parse(g.expires_at);
  if (!Number.isFinite(end) || end <= nowMs) return 'expired';
  return 'live';
}

/** A claim's offers, newest first. [] without 0243. */
export async function grantsOfClaim(db: D1Database, claimId: string): Promise<CarePartGrantRow[]> {
  try {
    return (await db.prepare(`${GRANT_SELECT} WHERE g.claim_id = ? ORDER BY g.created_at DESC, g.id DESC`).bind(claimId).all<CarePartGrantRow>()).results ?? [];
  } catch (e) {
    if (isSchemaMissing(e)) return [];
    throw e;
  }
}

export async function grantById(db: D1Database, claimId: string, grantId: string): Promise<CarePartGrantRow | null> {
  return db.prepare(`${GRANT_SELECT} WHERE g.id = ? AND g.claim_id = ?`).bind(grantId, claimId).first<CarePartGrantRow>();
}

/** How many live offers each claim carries (the customer's claims list). Empty without 0243. */
export async function liveOfferCounts(db: D1Database, claimIds: string[], nowIso = new Date().toISOString()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!claimIds.length) return out;
  try {
    const { results } = await db
      .prepare(
        `SELECT g.claim_id AS id, COUNT(*) AS n FROM care_part_grants g
          WHERE g.claim_id IN (SELECT value FROM json_each(?1)) AND g.revoked_at IS NULL AND g.expires_at > ?2
            AND NOT ${SPENT_SQL('g.coupon_id')}
          GROUP BY g.claim_id`
      )
      .bind(JSON.stringify([...new Set(claimIds)]), nowIso)
      .all<{ id: string; n: number }>();
    for (const r of results ?? []) out.set(r.id, num(r.n));
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return out;
}

// ------------------------------------------------------------------ the automatic discount

/** A live offer of one customer, as the cart, the quote and the checkout apply it. */
export interface LiveCareOffer {
  grant_id: string;
  claim_id: string;
  product_id: string;
  coupon_id: string;
  discount_pct: number;
  max_discount_iqd: number | null;
  expires_at: string;
  /** The device's ROOT unit the offer (and the Care caps) belong to. */
  entitlement_unit_id?: string;
  /**
   * THE DEVICE'S CAPS TODAY (`spendableCareOffers`, worker/lib/carePartOfferCaps.ts): what is left of its Care
   * money ceiling (null = the terms set none, or unknown), how many claims are left, and whether this offer's
   * claim is already counted among the used ones. Absent = not capped here (a pure caller, a test).
   */
  root_left_iqd?: number | null;
  root_claims_left?: number | null;
  claim_counted?: boolean;
}

/**
 * Every part offer THIS customer can spend right now: his own (the offer's user AND the coupon's
 * assigned_user_id), not revoked, not ended, its coupon active and not spent on a live order. The soonest
 * to end first, then the offer's id, so every door applies them in one order. [] without 0243.
 */
export async function liveCareOffers(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<LiveCareOffer[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT g.id AS grant_id, g.claim_id, g.product_id, g.coupon_id, c.value AS discount_pct, c.max_discount_iqd, g.expires_at,
                g.entitlement_unit_id
           FROM care_part_grants g
           JOIN coupons c ON c.id = g.coupon_id
          WHERE g.user_id = ?1 AND g.revoked_at IS NULL AND g.expires_at > ?2
            AND c.active = 1 AND c.assigned_user_id = ?1 AND c.kind = 'percent' AND c.scope = 'product' AND c.product_id = g.product_id
            AND (c.ends_at IS NULL OR c.ends_at > ?2)
            AND NOT ${SPENT_SQL('g.coupon_id')}
          ORDER BY g.expires_at ASC, g.id ASC
          LIMIT 50`
      )
      .bind(userId, nowIso)
      .all<LiveCareOffer>();
    return (results ?? []).map((r) => ({
      ...r,
      discount_pct: Math.max(0, Math.min(90, Math.trunc(num(r.discount_pct)))),
      max_discount_iqd: r.max_discount_iqd === null || r.max_discount_iqd === undefined ? null : Math.max(0, Math.trunc(num(r.max_discount_iqd))),
    }));
  } catch (e) {
    if (isSchemaMissing(e)) return [];
    throw e;
  }
}

/**
 * What the device's OTHER live offers already hold of its money ceiling: Σ max_discount_iqd of the offers on
 * this root unit (every claim) that are not revoked, not ended and not spent. The issue door reserves against
 * it, so the live offers of one device can never promise more than the ceiling has left (review 2026-11-18).
 */
export async function liveReservedOnRoot(db: D1Database, rootUnitId: string, nowIso = new Date().toISOString()): Promise<number> {
  const row = await db.prepare(`SELECT ${LIVE_RESERVED_SQL} AS s`).bind(rootUnitId, nowIso).first<{ s: number }>();
  return Math.max(0, Math.trunc(num(row?.s)));
}
/** The same sum as one scalar expression: binds (root unit id, now). The issuing batch fences on it. */
export const LIVE_RESERVED_SQL = `(SELECT COALESCE(SUM(COALESCE(lg.max_discount_iqd, 0)), 0) FROM care_part_grants lg
    WHERE lg.entitlement_unit_id = ? AND lg.revoked_at IS NULL AND lg.expires_at > ? AND NOT ${SPENT_SQL('lg.coupon_id')})`;

/** One line an offer may land on — the caller has already left out what an offer never touches. */
export interface CareOfferLine {
  line_id: string;
  /** The cart line's id: the same order at every door. */
  tie_key: string;
  product_id: string;
  qty: number;
  /** The goods price of one unit as the customer pays it (after the membership saving at the line). */
  unit_goods_iqd: number;
  /** What another coupon already took off this whole line. */
  taken_iqd: number;
}

export interface AppliedCareOffer {
  grant_id: string;
  claim_id: string;
  coupon_id: string;
  product_id: string;
  line_id: string;
  cart_item_id: string;
  discount_pct: number;
  discount_iqd: number;
  expires_at: string;
}

/**
 * THE ONE ARITHMETIC OF A PART OFFER, for the cart, the quote and the order: each offer takes its percent off
 * ONE unit of its product — the first eligible line in cart order that still has a unit no other offer took.
 *
 *   • THE PERCENT IS OF WHAT THAT UNIT COSTS AFTER THE ORDER'S OWN CODE (a typed code or the reward pool): the
 *     code's share on one unit is ceil(taken ÷ qty), so a 60% code and a 50% offer on a 40,000 part take
 *     24,000 + 8,000 — never the whole price (review 2026-11-18). The cart knows no code, so its figure is an
 *     upper bound and the quote is the authority.
 *   • then the offer's own ceiling (what it reserved of the device's money ceiling when issued);
 *   • then THE DEVICE'S CEILING TODAY, across every offer of that device in this order (`root_left_iqd`), so no
 *     combination of offers can take more than the Care terms allow; and the device's claim limit: an offer
 *     of a claim not yet counted is applied only while a claim is left (`root_claims_left`).
 * An offer with no line, or worth nothing here, is simply not applied (and stays live).
 */
export function allocateCareOffers(offers: readonly LiveCareOffer[], lines: readonly CareOfferLine[]): AppliedCareOffer[] {
  const sorted = [...lines].sort((a, b) => (a.tie_key < b.tie_key ? -1 : a.tie_key > b.tie_key ? 1 : a.line_id < b.line_id ? -1 : a.line_id > b.line_id ? 1 : 0));
  const unitsTaken = new Map<string, number>();
  const moneyTaken = new Map<string, number>();
  const rootTaken = new Map<string, number>();
  const rootNewClaims = new Map<string, Set<string>>();
  const out: AppliedCareOffer[] = [];
  for (const o of offers) {
    const root = o.entitlement_unit_id ?? '';
    const rootLeft = o.root_left_iqd === null || o.root_left_iqd === undefined ? null : Math.max(0, Math.trunc(num(o.root_left_iqd)) - (rootTaken.get(root) ?? 0));
    if (rootLeft !== null && rootLeft <= 0) continue;
    const claimsLeft = o.root_claims_left === null || o.root_claims_left === undefined ? null : Math.trunc(num(o.root_claims_left));
    const newClaims = rootNewClaims.get(root) ?? new Set<string>();
    if (claimsLeft !== null && o.claim_counted !== true && !newClaims.has(o.claim_id) && newClaims.size >= claimsLeft) continue;
    for (const l of sorted) {
      if (l.product_id !== o.product_id) continue;
      const qty = Math.max(0, Math.trunc(num(l.qty)));
      const unit = Math.max(0, Math.trunc(num(l.unit_goods_iqd)));
      if ((unitsTaken.get(l.line_id) ?? 0) >= qty || unit <= 0) continue;
      const taken = Math.max(0, Math.trunc(num(l.taken_iqd)));
      const room = unit * qty - taken - (moneyTaken.get(l.line_id) ?? 0);
      // What this one unit costs after the order's own code took its share of it.
      const unitAfterCode = Math.max(0, unit - (qty > 0 ? Math.ceil(taken / qty) : 0));
      let amount = Math.floor((unitAfterCode * o.discount_pct) / 100);
      if (o.max_discount_iqd !== null) amount = Math.min(amount, o.max_discount_iqd);
      if (rootLeft !== null) amount = Math.min(amount, rootLeft);
      amount = Math.max(0, Math.min(amount, unitAfterCode, room));
      if (amount <= 0) continue;
      rootTaken.set(root, (rootTaken.get(root) ?? 0) + amount);
      if (o.claim_counted !== true) rootNewClaims.set(root, newClaims.add(o.claim_id));
      unitsTaken.set(l.line_id, (unitsTaken.get(l.line_id) ?? 0) + 1);
      moneyTaken.set(l.line_id, (moneyTaken.get(l.line_id) ?? 0) + amount);
      out.push({
        grant_id: o.grant_id, claim_id: o.claim_id, coupon_id: o.coupon_id, product_id: o.product_id,
        line_id: l.line_id, cart_item_id: l.tie_key, discount_pct: o.discount_pct, discount_iqd: amount, expires_at: o.expires_at,
      });
      break;
    }
  }
  return out;
}

/** The Care offers an order's coupon snapshot froze: [{ grant_id, product_id, order_item_id, discount_iqd }]. */
export function careOffersOfSnapshot(couponSnapshot: unknown): Array<{ grant_id: string; product_id: string; order_item_id: string; discount_iqd: number }> {
  const snap = typeof couponSnapshot === 'string' ? safeParse<{ care_offers?: unknown } | null>(couponSnapshot, null) : (couponSnapshot as { care_offers?: unknown } | null);
  const list = snap && Array.isArray(snap.care_offers) ? (snap.care_offers as Array<Record<string, unknown>>) : [];
  return list
    .filter((o) => o && typeof o.grant_id === 'string')
    .map((o) => ({
      grant_id: String(o.grant_id),
      product_id: String(o.product_id ?? ''),
      order_item_id: String(o.order_item_id ?? ''),
      discount_iqd: Math.max(0, Math.trunc(num(o.discount_iqd))),
    }));
}
