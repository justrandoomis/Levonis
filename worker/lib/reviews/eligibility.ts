/**
 * STAGE 2 — PRINTER-GIFT ELIGIBILITY (docs/REVIEWS_GIFTS.md §Eligibility).
 * Owner: lane S1. Lane S2 calls `recheckPrinterGift` at issue and at redeem,
 * and `giftDiagnostics` for the admin queue; lane S1 calls the admission in
 * POST/PUT /api/reviews and from the device-registration hook.
 *
 * Deterministic, server-side, no sentiment. A review ENTERS the gift queue
 * (a `review_rewards` row, kind 'printer_gift', state 'submitted',
 * quality_score NULL) when, all at once:
 *   buyer        the reviewer bought it: orders.user_id = reviews.user_id
 *   delivered    orders.status = 'delivered' AND delivered_at set (not moved back)
 *   printer      printerGiftFamily(product) ∈ fdm | resin | laser (the product's
 *                OWN section; never the placement-based printerIdentity rule)
 *   unit         a live order_item_units row of that product (replaced_by NULL)
 *   unit_owned   order_item_units.owner_user_id = reviewer
 *   registered   device_registrations(unit) held by the reviewer, not revoked
 *   five_stars   reviews.stars = 5
 *   text_ok      checkReviewText(body).ok (bound as ?textOk)
 *   user_authored reviews.source = 'user' AND status = 'published'
 *   unit_not_rewarded no printer_gift reward on the unit's replacement chain
 * and the unit is none of: from a GIFT line (order_items.gift_entitlement_id),
 * refunded (return_cases resolution 'refund' naming the unit or its line),
 * traded in (a 'device' trade_in_claims row on it), a merchant order.
 * Publication never depends on any of this.
 */
import { catalogIndexFor, productTypeOf, type CatalogIndex } from '../catalogPresentation';
import { isUsedBranch } from '../templateFamilies';
import { newId } from '../crypto';
import { checkReviewText } from './text';

export type PrinterGiftFamily = 'fdm' | 'resin' | 'laser';

/** The seeded section ids the program admits (0018, 0102). Settled by the owner. */
export const PRINTER_GIFT_SECTIONS = {
  fdm: 'cat_printers_fdm',
  resin: 'cat_printers_resin',
  laser: 'cat_laser_machines',
  /** Roots: admitted only when the product's own type says printer / laser machine. */
  printersRoot: 'cat_printers',
  laserRoot: 'cat_laser',
} as const;

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/**
 * The product's family from its OWN classification (sub_category_id, else
 * category_id) — never from placements, so a laser accessory under the
 * flagged `cat_laser` root is not a printer here. Used printers are out.
 */
export function printerGiftFamily(
  row: { category_id?: unknown; sub_category_id?: unknown; template_family?: unknown },
  idx: CatalogIndex
): PrinterGiftFamily | null {
  const leaf = text(row.sub_category_id) || text(row.category_id);
  if (!leaf) return null;
  const branch = idx.branch(leaf);
  if (!branch.length) return null;
  if (isUsedBranch(branch.map((n) => ({ id: n.id, slug: n.slug })))) return null;
  const ids = new Set(branch.map((n) => n.id));
  const type = productTypeOf(row, idx);
  if (ids.has(PRINTER_GIFT_SECTIONS.resin)) return type === 'printer' ? 'resin' : null;
  if (ids.has(PRINTER_GIFT_SECTIONS.fdm)) return type === 'printer' ? 'fdm' : null;
  if (ids.has(PRINTER_GIFT_SECTIONS.laser)) return type === 'laser' ? 'laser' : null;
  if (leaf === PRINTER_GIFT_SECTIONS.printersRoot) return type === 'printer' ? 'fdm' : null;
  if (leaf === PRINTER_GIFT_SECTIONS.laserRoot) return type === 'laser' ? 'laser' : null;
  return null;
}

export async function printerGiftFamilyOf(db: D1Database, productId: string): Promise<PrinterGiftFamily | null> {
  const row = await db
    .prepare('SELECT category_id, sub_category_id, template_family FROM products WHERE id = ?')
    .bind(productId)
    .first<{ category_id: string | null; sub_category_id: string | null; template_family: string | null }>();
  if (!row) return null;
  return printerGiftFamily(row, await catalogIndexFor(db));
}

/** The exclusions every statement below repeats, on the unit alias `u`. */
const UNIT_EXCLUSIONS = `
  AND NOT EXISTS (SELECT 1 FROM order_items gi WHERE gi.id = u.order_item_id AND gi.gift_entitlement_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM return_cases rc
                   WHERE rc.resolution = 'refund'
                     AND (rc.unit_id = u.id OR (rc.unit_id IS NULL AND rc.order_item_id = u.order_item_id)))
  AND NOT EXISTS (SELECT 1 FROM trade_in_claims tc
                   WHERE tc.order_item_id = u.order_item_id AND tc.unit_index = u.unit_index AND tc.part = 'device')`;

/**
 * The ONE unit that makes review ?1 eligible, or no row. ?2 = text verdict
 * (1/0), ?3 = family verdict (1/0) — both computed in TS by the same
 * functions the rest of the system uses. The review's own order and line are
 * preferred; another delivered unit of the same model owned by the reviewer
 * is accepted and recorded as the reward's unit.
 */
export const ELIGIBLE_UNIT_SQL = `
SELECT u.id AS unit_id, u.order_id, u.order_item_id, u.product_id, r.id AS review_id, r.user_id
  FROM reviews r
  JOIN order_item_units u      ON u.product_id = r.product_id AND u.owner_user_id = r.user_id
                              AND u.delivered_at IS NOT NULL AND u.replaced_by_unit_id IS NULL
  JOIN order_items oi          ON oi.id = u.order_item_id AND oi.product_id = r.product_id
  JOIN orders o                ON o.id = u.order_id AND o.user_id = r.user_id
                              AND o.status = 'delivered' AND o.delivered_at IS NOT NULL
                              AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
  JOIN device_registrations dr ON dr.unit_id = u.id AND dr.user_id = r.user_id AND dr.revoked_at IS NULL
 WHERE r.id = ?1 AND r.source = 'user' AND r.status = 'published' AND r.stars = 5
   AND ?2 = 1 AND ?3 = 1
   ${UNIT_EXCLUSIONS}
   AND NOT EXISTS (
         WITH RECURSIVE chain(id, d) AS (
           SELECT u.id, 0
           UNION
           SELECT x.id, c.d + 1
             FROM chain c
             JOIN order_item_units cu ON cu.id = c.id
             JOIN order_item_units x  ON x.id IN (cu.replacement_of_unit_id, cu.replaced_by_unit_id)
            WHERE c.d < 8)
         SELECT 1 FROM review_rewards rr JOIN chain ON rr.unit_id = chain.id
          WHERE rr.kind = 'printer_gift')
 ORDER BY (u.order_id = r.order_id) DESC, (u.order_item_id = r.order_item_id) DESC,
          u.delivered_at ASC, u.unit_index ASC, u.id ASC
 LIMIT 1`;

/**
 * ADMISSION, INSIDE THE REVIEW'S OWN BATCH (append after the review INSERT /
 * system-marker UPDATE / PUT UPDATE). Idempotent: `review_id` UNIQUE and
 * `idx_review_rewards_printer_unit` make a retry, a double POST or a second
 * review reaching the same unit insert nothing. `quality_score` stays NULL —
 * the admin chooses the level. `quality_snapshot` may carry the advisory
 * quality JSON (never a level).
 */
export function admitPrinterGiftStatement(
  db: D1Database,
  args: {
    rewardId: string;
    reviewId: string;
    textOk: boolean;
    familyOk: boolean;
    nowIso: string;
    qualitySnapshot?: string;
    /** Which door admitted it: the review's own write, or the device registration hook. */
    via?: 'review' | 'registration';
  }
): D1PreparedStatement {
  // The eligibility SNAPSHOT (`review_rewards.eligibility`, v2): the unit the
  // statement chose and the ten checks as they stood at admission — all true
  // by construction, since the row exists only when every one held. The admin
  // panel renders it beside the live `giftDiagnostics`.
  return db
    .prepare(
      `INSERT INTO review_rewards (id, review_id, user_id, kind, eligibility, quality_snapshot, state, created_at,
                                   unit_id, order_id, order_item_id, product_id)
       SELECT ?4, e.review_id, e.user_id, 'printer_gift',
              json_object('v', 2, 'unit_id', e.unit_id, 'order_id', e.order_id, 'order_item_id', e.order_item_id,
                          'admitted_at', ?5, 'via', ?7, 'checks', json(?8)),
              ?6, 'submitted', ?5, e.unit_id, e.order_id, e.order_item_id, e.product_id
         FROM (${ELIGIBLE_UNIT_SQL}) e
        WHERE 1
       ON CONFLICT DO NOTHING`
    )
    .bind(
      args.reviewId,
      args.textOk ? 1 : 0,
      args.familyOk ? 1 : 0,
      args.rewardId,
      args.nowIso,
      args.qualitySnapshot ?? '{}',
      args.via ?? 'review',
      ALL_CHECKS_PASSED
    );
}

/**
 * RE-ADMISSION when the reviewer links the printer AFTER writing the review
 * (settled: admitted when the registration happens). Called by the device
 * registration routes after a successful bind. Contained: never throws, never
 * blocks the warranty flow; idempotent.
 */
export async function admitPrinterGiftForUnit(
  env: { DB: D1Database },
  args: { userId: string; unitId: string }
): Promise<{ admitted: boolean }> {
  try {
    const db = env.DB;
    // The caller's OWN review of this unit's model. The statement below
    // re-proves every condition (the unit, its owner, the registration, the
    // order, the stars, publication, the exclusions); this only avoids running
    // it when there is plainly nothing to admit.
    const review = await db
      .prepare(
        `SELECT r.id, r.body, r.product_id, r.stars, r.source, r.status
           FROM order_item_units u
           JOIN reviews r ON r.product_id = u.product_id AND r.user_id = ?2
          WHERE u.id = ?1
          LIMIT 1`
      )
      .bind(args.unitId, args.userId)
      .first<{ id: string; body: string; product_id: string; stars: number; source: string | null; status: string }>();
    if (!review || (review.source ?? 'user') !== 'user' || review.status !== 'published' || Number(review.stars) !== 5) {
      return { admitted: false };
    }
    const family = await printerGiftFamilyOf(db, review.product_id);
    const textOk = checkReviewText(String(review.body ?? '')).ok;
    if (!family || !textOk) return { admitted: false };
    const res = await admitPrinterGiftStatement(db, {
      rewardId: newId('rr'),
      reviewId: review.id,
      textOk,
      familyOk: true,
      nowIso: new Date().toISOString(),
      via: 'registration',
    }).run();
    return { admitted: Number(res.meta?.changes ?? 0) > 0 };
  } catch (error) {
    // Contained by contract: a warranty registration has already succeeded and
    // must never fail, or be slowed into a retry, because of the gift program.
    console.error('admitPrinterGiftForUnit failed', error instanceof Error ? error.message : error);
    return { admitted: false };
  }
}

/**
 * THE RE-CHECK at admin issue and at customer redeem (brief §5). Follows a
 * warranty replacement FORWARD to the live unit; fails after an unlink, a
 * transfer, a star downgrade, an unpublished review, an order moved back,
 * a refund or a trade-in. `live_unit_id` null = not eligible any more.
 */
export const RECHECK_SQL = `
WITH RECURSIVE fwd(id, d) AS (
  SELECT rr.unit_id, 0 FROM review_rewards rr WHERE rr.id = ?1
  UNION
  SELECT uu.replaced_by_unit_id, f.d + 1
    FROM fwd f JOIN order_item_units uu ON uu.id = f.id
   WHERE uu.replaced_by_unit_id IS NOT NULL AND f.d < 8
)
SELECT u.id AS live_unit_id
  FROM review_rewards rr
  JOIN reviews r                ON r.id = rr.review_id
  JOIN fwd
  JOIN order_item_units u       ON u.id = fwd.id AND u.replaced_by_unit_id IS NULL
  JOIN orders o                 ON o.id = u.order_id
  JOIN device_registrations dr  ON dr.unit_id = u.id
 WHERE rr.id = ?1 AND rr.kind = 'printer_gift'
   AND r.source = 'user' AND r.status = 'published' AND r.stars = 5
   AND u.owner_user_id = r.user_id AND u.product_id = r.product_id AND u.delivered_at IS NOT NULL
   AND o.user_id = r.user_id AND o.status = 'delivered'
   AND dr.user_id = r.user_id AND dr.revoked_at IS NULL
   ${UNIT_EXCLUSIONS}
 LIMIT 1`;

export async function recheckPrinterGift(db: D1Database, rewardId: string): Promise<{ ok: boolean; liveUnitId: string | null }> {
  const row = await db.prepare(RECHECK_SQL).bind(rewardId).first<{ live_unit_id: string }>();
  return { ok: !!row, liveUnitId: row?.live_unit_id ?? null };
}

/** The ten conditions, one boolean each, for the admin panel and the sheet (never guessed client-side). */
export type GiftCheck =
  | 'buyer'
  | 'delivered'
  | 'printer'
  | 'unit'
  | 'unit_owned'
  | 'registered_to_reviewer'
  | 'five_stars'
  | 'text_ok'
  | 'user_authored'
  | 'unit_not_rewarded';

export const GIFT_CHECKS: readonly GiftCheck[] = [
  'buyer',
  'delivered',
  'printer',
  'unit',
  'unit_owned',
  'registered_to_reviewer',
  'five_stars',
  'text_ok',
  'user_authored',
  'unit_not_rewarded',
];

/** The admission snapshot's checks: every one true, by construction (see admitPrinterGiftStatement). */
const ALL_CHECKS_PASSED = JSON.stringify(Object.fromEntries(GIFT_CHECKS.map((k) => [k, true])));

export interface GiftDiagnostics {
  family: PrinterGiftFamily | null;
  checks: Record<GiftCheck, boolean>;
  /** Extra exclusions, true when they apply. */
  excluded: { gift_line: boolean; refunded: boolean; traded_in: boolean };
  unit: {
    id: string;
    order_id: string;
    order_item_id: string;
    unit_index: number;
    serial: string | null;
    registration: 'reviewer' | 'other' | 'released' | 'none';
    registered_at: string | null;
    /** S1 additions (optional, for the gift-queue row of brief §3). */
    product_id?: string | null;
    delivered_at?: string | null;
    warranty_end_at?: string | null;
    replaced_by_unit_id?: string | null;
    /** Set when the reward's own unit was replaced and the checks ran on this live replacement. */
    replacement_of_unit_id?: string | null;
    /** The unit's live warranty receipt number, if one was issued. */
    receipt_no?: string | null;
  } | null;
  /** Another printer_gift reward on this unit's replacement chain (id + state). */
  prior_reward: { reward_id: string; state: string } | null;
  /** S1 addition: this review's own printer-gift reward, if any (`unit_id` null on a legacy row). */
  reward?: { id: string; state: string; unit_id: string | null } | null;
  /** S1 addition: the failing checks, in GIFT_CHECKS order (what the sheet explains to the customer). */
  missing?: GiftCheck[];
}

interface DiagReviewRow {
  id: string;
  user_id: string;
  product_id: string;
  order_id: string | null;
  order_item_id: string | null;
  stars: number;
  body: string | null;
  source: string | null;
  status: string;
  category_id: string | null;
  sub_category_id: string | null;
  template_family: string | null;
  reward_id: string | null;
  reward_unit_id: string | null;
  reward_state: string | null;
  bought: number;
  live_unit_id: string | null;
  candidate_unit_id: string | null;
}

interface DiagUnitRow {
  id: string;
  order_id: string;
  order_item_id: string;
  product_id: string | null;
  unit_index: number;
  owner_user_id: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  replaced_by_unit_id: string | null;
  order_user_id: string;
  order_status: string;
  order_delivered_at: string | null;
  seller_type: string;
  serial_raw: string | null;
  receipt_no: string | null;
  reg_user_id: string | null;
  registered_at: string | null;
  revoked_at: string | null;
  gift_line: number;
  refunded: number;
  traded_in: number;
  prior_reward_id: string | null;
  prior_reward_state: string | null;
}

/**
 * The review, its product's section, its own printer-gift reward, and the ONE
 * unit the checks run on: the reward's unit followed FORWARD through warranty
 * replacements to the live one (as RECHECK_SQL does), or — with no reward —
 * the reviewer's best unit of the model, ranked as ELIGIBLE_UNIT_SQL ranks
 * (a unit linked to the reviewer first, then the review's own order and line).
 */
const DIAG_REVIEW_SQL = `
WITH RECURSIVE fwd(id, d) AS (
  SELECT rr.unit_id, 0 FROM review_rewards rr
   WHERE rr.review_id = ?1 AND rr.kind = 'printer_gift' AND rr.unit_id IS NOT NULL
  UNION
  SELECT uu.replaced_by_unit_id, f.d + 1
    FROM fwd f JOIN order_item_units uu ON uu.id = f.id
   WHERE uu.replaced_by_unit_id IS NOT NULL AND f.d < 8
)
SELECT r.id, r.user_id, r.product_id, r.order_id, r.order_item_id, r.stars, r.body, r.source, r.status,
       p.category_id, p.sub_category_id, p.template_family,
       rr.id AS reward_id, rr.unit_id AS reward_unit_id, rr.state AS reward_state,
       EXISTS (SELECT 1 FROM orders bo JOIN order_items bi ON bi.order_id = bo.id
                WHERE bo.user_id = r.user_id AND bi.product_id = r.product_id
                  AND COALESCE(bo.seller_type, 'levonis') <> 'merchant') AS bought,
       (SELECT u.id FROM fwd JOIN order_item_units u ON u.id = fwd.id
         WHERE u.replaced_by_unit_id IS NULL ORDER BY fwd.d DESC LIMIT 1) AS live_unit_id,
       (SELECT u.id FROM order_item_units u JOIN orders o ON o.id = u.order_id
         WHERE u.product_id = r.product_id AND o.user_id = r.user_id AND u.replaced_by_unit_id IS NULL
         ORDER BY EXISTS (SELECT 1 FROM device_registrations dr
                           WHERE dr.unit_id = u.id AND dr.user_id = r.user_id AND dr.revoked_at IS NULL) DESC,
                  (u.delivered_at IS NOT NULL) DESC,
                  (u.order_id = r.order_id) DESC, (u.order_item_id = r.order_item_id) DESC,
                  u.delivered_at ASC, u.unit_index ASC, u.id ASC
         LIMIT 1) AS candidate_unit_id
  FROM reviews r
  LEFT JOIN products p ON p.id = r.product_id
  LEFT JOIN review_rewards rr ON rr.review_id = r.id AND rr.kind = 'printer_gift'
 WHERE r.id = ?1`;

/** One unit's facts, its exclusions, and another review's printer-gift reward anywhere on its replacement chain. */
const DIAG_UNIT_SQL = `
WITH RECURSIVE chain(id, d) AS (
  SELECT ?1, 0
  UNION
  SELECT x.id, c.d + 1
    FROM chain c
    JOIN order_item_units cu ON cu.id = c.id
    JOIN order_item_units x  ON x.id IN (cu.replacement_of_unit_id, cu.replaced_by_unit_id)
   WHERE c.d < 8
)
SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.unit_index, u.owner_user_id, u.delivered_at,
       u.warranty_end_at, u.replaced_by_unit_id,
       o.user_id AS order_user_id, o.status AS order_status, o.delivered_at AS order_delivered_at,
       COALESCE(o.seller_type, 'levonis') AS seller_type,
       (SELECT s.serial_raw FROM device_serials s WHERE s.unit_id = u.id
         ORDER BY (s.replaced_by_serial IS NULL) DESC, s.assigned_at DESC LIMIT 1) AS serial_raw,
       (SELECT wr.receipt_no FROM warranty_receipts wr WHERE wr.unit_id = u.id AND wr.status = 'active'
         ORDER BY wr.created_at DESC LIMIT 1) AS receipt_no,
       dr.user_id AS reg_user_id, dr.registered_at, dr.revoked_at,
       EXISTS (SELECT 1 FROM order_items gi WHERE gi.id = u.order_item_id AND gi.gift_entitlement_id IS NOT NULL) AS gift_line,
       EXISTS (SELECT 1 FROM return_cases rc
                WHERE rc.resolution = 'refund'
                  AND (rc.unit_id = u.id OR (rc.unit_id IS NULL AND rc.order_item_id = u.order_item_id))) AS refunded,
       EXISTS (SELECT 1 FROM trade_in_claims tc
                WHERE tc.order_item_id = u.order_item_id AND tc.unit_index = u.unit_index AND tc.part = 'device') AS traded_in,
       (SELECT rr.id FROM review_rewards rr JOIN chain ON rr.unit_id = chain.id
         WHERE rr.kind = 'printer_gift' AND rr.review_id <> ?2 ORDER BY rr.created_at, rr.id LIMIT 1) AS prior_reward_id,
       (SELECT rr.state FROM review_rewards rr JOIN chain ON rr.unit_id = chain.id
         WHERE rr.kind = 'printer_gift' AND rr.review_id <> ?2 ORDER BY rr.created_at, rr.id LIMIT 1) AS prior_reward_state
  FROM order_item_units u
  JOIN orders o ON o.id = u.order_id
  LEFT JOIN device_registrations dr ON dr.unit_id = u.id
 WHERE u.id = ?1`;

function registrationOf(u: DiagUnitRow, reviewerId: string): 'reviewer' | 'other' | 'released' | 'none' {
  if (!u.reg_user_id) return 'none';
  if (u.revoked_at) return 'released';
  return u.reg_user_id === reviewerId ? 'reviewer' : 'other';
}

/**
 * READ-ONLY diagnostics of one review (admin queue, all-reviews list, the
 * POST/PUT `gift.missing` hint): the ten conditions as they stand NOW, one
 * boolean each, never guessed client-side. Two queries plus the cached
 * taxonomy index. Null for an unknown review.
 *
 * `unit` false also covers a unit the program excludes (a gift line, a
 * refund, a trade-in): `excluded` says which. A merchant order is never a
 * purchase of a Levonis product here (`buyer` false).
 */
export async function giftDiagnostics(db: D1Database, reviewId: string): Promise<GiftDiagnostics | null> {
  const r = await db.prepare(DIAG_REVIEW_SQL).bind(reviewId).first<DiagReviewRow>();
  if (!r) return null;
  const family = printerGiftFamily(r, await catalogIndexFor(db));
  const unitId = r.live_unit_id ?? r.candidate_unit_id;
  const u = unitId ? await db.prepare(DIAG_UNIT_SQL).bind(unitId, r.id).first<DiagUnitRow>() : null;

  const source = r.source ?? 'user';
  const excluded = {
    gift_line: !!u && Number(u.gift_line) === 1,
    refunded: !!u && Number(u.refunded) === 1,
    traded_in: !!u && Number(u.traded_in) === 1,
  };
  const liveUnit =
    !!u && u.product_id === r.product_id && !!u.delivered_at && !u.replaced_by_unit_id &&
    !excluded.gift_line && !excluded.refunded && !excluded.traded_in;
  const checks: Record<GiftCheck, boolean> = {
    buyer: Number(r.bought) === 1 && (!u || (u.order_user_id === r.user_id && u.seller_type !== 'merchant')),
    delivered: !!u && u.order_status === 'delivered' && !!u.order_delivered_at,
    printer: family !== null,
    unit: liveUnit,
    unit_owned: !!u && u.owner_user_id === r.user_id,
    registered_to_reviewer: !!u && u.reg_user_id === r.user_id && !u.revoked_at,
    five_stars: Number(r.stars) === 5,
    text_ok: source === 'user' && checkReviewText(String(r.body ?? '')).ok,
    user_authored: source === 'user' && r.status === 'published',
    unit_not_rewarded: !!u && !u.prior_reward_id,
  };
  return {
    family,
    checks,
    excluded,
    unit: u
      ? {
          id: u.id,
          order_id: u.order_id,
          order_item_id: u.order_item_id,
          unit_index: Number(u.unit_index),
          serial: u.serial_raw ?? null,
          registration: registrationOf(u, r.user_id),
          registered_at: u.reg_user_id ? u.registered_at ?? null : null,
          product_id: u.product_id ?? null,
          delivered_at: u.delivered_at ?? null,
          warranty_end_at: u.warranty_end_at ?? null,
          replaced_by_unit_id: u.replaced_by_unit_id ?? null,
          replacement_of_unit_id: r.reward_unit_id && r.reward_unit_id !== u.id ? r.reward_unit_id : null,
          receipt_no: u.receipt_no ?? null,
        }
      : null,
    prior_reward: u?.prior_reward_id ? { reward_id: u.prior_reward_id, state: String(u.prior_reward_state ?? '') } : null,
    reward: r.reward_id ? { id: r.reward_id, state: String(r.reward_state ?? ''), unit_id: r.reward_unit_id ?? null } : null,
    missing: GIFT_CHECKS.filter((k) => !checks[k]),
  };
}

/**
 * THE CUSTOMER'S GIFT HINT for one product (GET /eligibility/:productId and
 * each line of GET /order/:orderId): is the product in the printer program,
 * and is a unit of it linked to the caller in the warranty centre? Never a
 * serial, never another account's identity — only whether the caller's own
 * unit is held elsewhere, which the warranty centre already tells them.
 */
export interface GiftPreview {
  program: boolean;
  family: PrinterGiftFamily | null;
  /** A delivered, live unit the caller bought is linked to the caller. */
  linked: boolean;
  /** None is linked to the caller, but one is linked to another account. */
  linked_elsewhere: boolean;
  /** Every unit linked to the caller already carries a printer-gift reward. */
  unit_rewarded: boolean;
}

export async function giftPreview(
  db: D1Database,
  args: { userId: string; productId: string; family?: PrinterGiftFamily | null }
): Promise<GiftPreview> {
  const family = args.family !== undefined ? args.family : await printerGiftFamilyOf(db, args.productId);
  if (!family) return { program: false, family: null, linked: false, linked_elsewhere: false, unit_rewarded: false };
  const { results } = await db
    .prepare(
      `SELECT u.id, dr.user_id AS reg_user_id, dr.revoked_at,
              EXISTS (
                WITH RECURSIVE chain(id, d) AS (
                  SELECT u.id, 0
                  UNION
                  SELECT x.id, c.d + 1
                    FROM chain c
                    JOIN order_item_units cu ON cu.id = c.id
                    JOIN order_item_units x  ON x.id IN (cu.replacement_of_unit_id, cu.replaced_by_unit_id)
                   WHERE c.d < 8)
                SELECT 1 FROM review_rewards rr JOIN chain ON rr.unit_id = chain.id
                 WHERE rr.kind = 'printer_gift') AS rewarded
         FROM order_item_units u
         JOIN orders o ON o.id = u.order_id AND o.user_id = ?1
         LEFT JOIN device_registrations dr ON dr.unit_id = u.id
        WHERE u.owner_user_id = ?1 AND u.product_id = ?2
          AND u.delivered_at IS NOT NULL AND u.replaced_by_unit_id IS NULL
        LIMIT 50`
    )
    .bind(args.userId, args.productId)
    .all<{ id: string; reg_user_id: string | null; revoked_at: string | null; rewarded: number }>();
  const units = results ?? [];
  const mine = units.filter((u) => u.reg_user_id === args.userId && !u.revoked_at);
  const elsewhere = units.some((u) => !!u.reg_user_id && u.reg_user_id !== args.userId && !u.revoked_at);
  return {
    program: true,
    family,
    linked: mine.length > 0,
    linked_elsewhere: mine.length === 0 && elsewhere,
    unit_rewarded: mine.length > 0 && mine.every((u) => Number(u.rewarded) === 1),
  };
}

/** What POST/PUT tell the customer about the gift program for the review they just wrote. */
export interface GiftOutcome {
  program: boolean;
  /** A printer-gift reward exists for this review and is not rejected. */
  queued: boolean;
  /** The conditions that keep it out of the queue (empty when queued or outside the program). */
  missing: GiftCheck[];
}

export async function giftOutcome(db: D1Database, reviewId: string, family: PrinterGiftFamily | null): Promise<GiftOutcome> {
  if (!family) return { program: false, queued: false, missing: [] };
  const reward = await db
    .prepare("SELECT state FROM review_rewards WHERE review_id = ? AND kind = 'printer_gift'")
    .bind(reviewId)
    .first<{ state: string }>();
  if (reward && reward.state !== 'rejected') return { program: true, queued: true, missing: [] };
  const diag = await giftDiagnostics(db, reviewId);
  return { program: true, queued: false, missing: diag?.missing ?? [] };
}

// ------------------------------------------------- the edit of a queued review

/**
 * PUT, IN THE EDIT'S OWN BATCH, after the review UPDATE (docs/REVIEWS_GIFTS.md
 * §6.1). Three statements over the review's pending printer-gift reward; each
 * carries its own fence, so they are safe in any order and against a
 * concurrent admin decision (a decided reward matches none of them):
 *
 *  1. a LEGACY reward (no unit, written under the old quality-tier rule) is
 *     re-admitted under the new rule when the edited review now passes the
 *     eligibility statement — its unit, order, line and product are recorded;
 *  2. a reward that fails RECHECK_SQL after the edit is closed by the system:
 *     state 'rejected', reason «no longer eligible after edit» (the review
 *     stays published; the fallback points then apply);
 *  3. a reward that still passes returns to 'submitted' (a «request changes»
 *     answered) with the fresh advisory quality.
 */
export function rewardAfterEditStatements(
  db: D1Database,
  args: { rewardId: string; reviewId: string; textOk: boolean; familyOk: boolean; nowIso: string; qualitySnapshot: string }
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE review_rewards
            SET unit_id = e.unit_id, order_id = e.order_id, order_item_id = e.order_item_id, product_id = e.product_id,
                eligibility = json_object('v', 2, 'unit_id', e.unit_id, 'order_id', e.order_id,
                                          'order_item_id', e.order_item_id, 'admitted_at', ?5, 'via', 'edit',
                                          'checks', json(?6))
           FROM (${ELIGIBLE_UNIT_SQL}) e
          WHERE review_rewards.id = ?4 AND review_rewards.review_id = ?1 AND review_rewards.kind = 'printer_gift'
            AND review_rewards.unit_id IS NULL AND review_rewards.state IN ('submitted', 'revision_needed')`
      )
      .bind(args.reviewId, args.textOk ? 1 : 0, args.familyOk ? 1 : 0, args.rewardId, args.nowIso, ALL_CHECKS_PASSED),
    db
      .prepare(
        `UPDATE review_rewards
            SET state = 'rejected', reason = ?2, decided_by = 'system', decided_at = ?3
          WHERE id = ?1 AND kind = 'printer_gift' AND state IN ('submitted', 'revision_needed')
            -- the edit itself landed (it republishes); a moderation reject
            -- that won the race is not "no longer eligible after edit"
            AND EXISTS (SELECT 1 FROM reviews pr WHERE pr.id = review_rewards.review_id
                         AND pr.status = 'published' AND pr.source = 'user')
            AND NOT EXISTS (${RECHECK_SQL})`
      )
      .bind(args.rewardId, REJECTED_AFTER_EDIT, args.nowIso),
    db
      .prepare(
        `UPDATE review_rewards
            SET state = 'submitted', reason = '', decided_by = NULL, decided_at = NULL, quality_snapshot = ?2
          WHERE id = ?1 AND kind = 'printer_gift' AND state IN ('submitted', 'revision_needed')
            AND EXISTS (${RECHECK_SQL})`
      )
      .bind(args.rewardId, args.qualitySnapshot),
  ];
}

/** The system's reason when an edit takes a queued review out of the program. */
export const REJECTED_AFTER_EDIT = 'no longer eligible after edit';
