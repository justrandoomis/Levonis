/**
 * A MEMBERSHIP BOUGHT WITH A PRINTER ORDER (0235; owner rulings 2026-11-17,
 * DECISIONS row 339 phase 2).
 *
 * The checkout sold it as an ORDER LINE (order_items.line_kind 'membership')
 * at the live plan price, less an upgrade credit frozen then, paid like the
 * rest of the order — cash on delivery included — and recorded what it froze
 * in `order_membership_purchases` as 'pending'. NOTHING IS GRANTED THEN: no
 * benefit, not even on the order that buys it.
 *
 * IT STARTS WHEN THE ORDER IS DELIVERED AND FULLY PAID — the support gift's
 * and the points accrual's test: status `delivered`, and the collections
 * recorded in `order_payment_settlements` cover what Levonis collects
 * (`levonisCollectibleSql`). Three doors ask, each idempotent:
 *   · the delivered transition (runOrderDeliveredEffects) — a prepaid order;
 *   · a collection that settles the order (POST /api/orders/:id/settlement);
 *   · the quarter-hour jobs sweep — anything the two above missed.
 *
 * ONE ACTIVATION, WHOEVER ASKS. The batch's first statement flips the purchase
 * pending → active with a fresh token, guarded by the order's delivered-and-
 * paid state; every membership write after it is guarded by that token and
 * fenced (changedExactlyOne), so of two callers racing exactly one writes and
 * the other changes nothing. The memberships row id is derived
 * (`mem_ord_<order item>`), so no replay can make a second one.
 *
 *   new      → a memberships row, active from now for the plan's months;
 *   upgrade  → the lower row it was quoted against is ended and the new row
 *              starts now (its credit was frozen at checkout).
 * (No renewal through an order — owner ruling 2026-11-17 ~10:20.)
 *
 * When the account's memberships changed in a way the purchase cannot follow
 * (a different live row appeared — an admin grant, say), nothing is written
 * and the purchase is 'blocked' for a person (needs_review), never guessed.
 *
 * ACTIVE IS FINAL (trg_order_membership_active_final): no door refunds it —
 * returns refuse the line, the order is no longer cancellable, the admin
 * cancel gives no wallet refund. Cancelled BEFORE activation, the order's own
 * cancel trigger ends it and the order's refund carries its money back.
 * The ONE exception is the owner's correction (`ownerCorrectionStatements`):
 * it ends the membership and the purchase inside the batch that cancels and
 * refunds the order, with an audit row; staff and customers cannot.
 *
 * A GINI ORDER (owner ruling ~10:20): Gini finances the goods only; the
 * membership charge is collected by the courier in cash with the delivery fee
 * (orders.gini_paid_iqd excludes it), so «fully paid» is that collection.
 */
import type { Env } from './types';
import { newId } from './crypto';
import { addMonths } from './membershipOps';
import { getTierStatus } from './entitlements';
import { changedExactlyOne, isLostRace } from './gifts/fence';
import { levonisCollectibleSql } from './gini';

export interface OrderMembershipPurchaseRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_item_id: string;
  printer_item_id: string | null;
  user_id: string;
  plan_id: string;
  tier: 'plus' | 'prime' | 'pro';
  duration_months: number;
  kind: 'new' | 'upgrade';
  price_iqd: number;
  credit_iqd: number;
  charge_iqd: number;
  base_membership_id: string | null;
  base_expires_at: string | null;
  state: 'pending' | 'active' | 'cancelled' | 'blocked';
  needs_review: number;
  review_reason: string;
  membership_id: string | null;
  starts_at: string | null;
  expires_at: string | null;
  activated_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  created_at: string;
  updated_at: string;
}

const missingTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

/** The purchases of one order (any state); empty on a database without 0235. */
export async function orderMembershipPurchases(db: D1Database, orderId: string): Promise<OrderMembershipPurchaseRow[]> {
  try {
    const { results } = await db.prepare('SELECT * FROM order_membership_purchases WHERE order_id = ? ORDER BY created_at').bind(orderId).all<OrderMembershipPurchaseRow>();
    return results ?? [];
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

/** True while this order holds an ACTIVE membership: no door cancels it (ORDER_MEMBERSHIP_ACTIVE). */
export async function orderMembershipActive(db: D1Database, orderId: string): Promise<boolean> {
  return (await orderMembershipPurchases(db, orderId)).some((p) => p.state === 'active');
}

/** Did a D1 write abort on trg_orders_membership_active_no_cancel (0235)? */
export function isOrderMembershipActiveAbort(e: unknown): boolean {
  return /ORDER_MEMBERSHIP_ACTIVE(?!_FINAL)/.test(e instanceof Error ? e.message : String(e));
}

export const ORDER_MEMBERSHIP_ACTIVE_MESSAGE =
  'العضوية المشتراة مع هذا الطلب بدأت ولا تُسترد، فلا يُلغى الطلب — أرجع الطابعة من قسم المرتجعات / The membership bought with this order has started and is not refunded, so the order is not cancelled — return the printer through the returns desk / ئەندامێتییەکەی لەگەڵ ئەم داواکارییە کڕدرا دەستی پێکردووە و ناگەڕێندرێتەوە، بۆیە داواکارییەکە هەڵناوەشێتەوە — چاپکەرەکە لە بەشی گەڕاندنەوە بگەڕێنەوە';

/** trg_orders_membership_corrected_no_reopen: the owner corrected this order; it stays cancelled. */
export function isOrderMembershipCorrectedAbort(e: unknown): boolean {
  return /ORDER_MEMBERSHIP_CORRECTED/.test(e instanceof Error ? e.message : String(e));
}

export const ORDER_MEMBERSHIP_CORRECTED_MESSAGE =
  'صحّح المالك هذا الطلب وأنهى عضويته وأعاد مبلغه، فلا يُعاد فتحه — أنشئ طلباً جديداً / The owner corrected this order, ended its membership and refunded it, so it cannot be re-opened — create a new order / خاوەن ئەم داواکارییەی ڕاستکردەوە، ئەندامێتییەکەی کۆتایی پێهێنا و پارەکەی گەڕاندەوە، بۆیە دووبارە ناکرێتەوە — داواکارییەکی نوێ دروست بکە';

/** What the order detail shows of a purchase: no token, no internal ids beyond the membership's. */
export function orderMembershipPublic(p: OrderMembershipPurchaseRow) {
  return {
    order_item_id: p.order_item_id,
    printer_item_id: p.printer_item_id,
    plan_id: p.plan_id,
    tier: p.tier,
    duration_months: p.duration_months,
    kind: p.kind,
    price_iqd: p.price_iqd,
    credit_iqd: p.credit_iqd,
    charge_iqd: p.charge_iqd,
    state: p.state,
    needs_review: p.needs_review === 1,
    review_reason: p.review_reason || null,
    starts_at: p.starts_at,
    expires_at: p.expires_at,
    activated_at: p.activated_at,
    cancelled_at: p.cancelled_at,
    refundable: false,
  };
}

/** The order is delivered and what Levonis collects is covered — the activation's precondition, as SQL on `?1`. */
const DELIVERED_AND_PAID = `EXISTS (SELECT 1 FROM orders o WHERE o.id = ?1 AND o.status = 'delivered'
    AND (SELECT COALESCE(SUM(s.amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = ?1) >= ${levonisCollectibleSql('o')})`;

export interface OrderMembershipActivation {
  order_id: string;
  activated: string[];
  blocked: string[];
  /** Why nothing was tried: the order is not delivered or not paid yet, or holds no waiting purchase. */
  waiting: 'not_delivered' | 'not_paid' | 'none' | null;
}

interface LiveRow { id: string; tier: string; state: string; expires_at: string | null; starts_at: string | null; credit_basis_iqd: number | null; price_paid_iqd: number }

/**
 * Activates every waiting membership of the order when it is delivered and
 * fully paid. TOTAL for its callers (they catch), idempotent, race-safe.
 * `retryBlocked` (an admin, after resolving the conflict) tries a blocked one
 * again.
 */
export async function activateOrderMembership(
  env: Env,
  orderId: string,
  opts: { trigger: string; actorId?: string | null; retryBlocked?: boolean; nowIso?: string } = { trigger: 'manual' }
): Promise<OrderMembershipActivation> {
  const db = env.DB;
  const out: OrderMembershipActivation = { order_id: orderId, activated: [], blocked: [], waiting: null };
  const all = await orderMembershipPurchases(db, orderId);
  const open = all.filter((p) => p.state === 'pending' || (opts.retryBlocked && p.state === 'blocked'));
  if (!open.length) return { ...out, waiting: 'none' };

  const order = await db
    .prepare(`SELECT o.status, (SELECT COALESCE(SUM(s.amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = o.id) AS collected,
                     ${levonisCollectibleSql('o')} AS collectible
                FROM orders o WHERE o.id = ?`)
    .bind(orderId)
    .first<{ status: string; collected: number; collectible: number }>();
  if (!order || order.status !== 'delivered') return { ...out, waiting: 'not_delivered' };
  if (Number(order.collected) < Number(order.collectible)) return { ...out, waiting: 'not_paid' };

  for (const p of open) {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    await getTierStatus(db, p.user_id); // lazily expire overdue rows first
    const { results: liveRows } = await db
      .prepare("SELECT id, tier, state, expires_at, starts_at, credit_basis_iqd, price_paid_iqd FROM memberships WHERE user_id = ? AND state IN ('active','prepaid_pending_launch')")
      .bind(p.user_id)
      .all<LiveRow>();
    const live = liveRows ?? [];
    const baseLive = p.base_membership_id ? live.find((m) => m.id === p.base_membership_id && m.state === 'active') ?? null : null;

    type Plan =
      | { kind: 'insert'; endBase: LiveRow | null }
      | { kind: 'block'; reason: string };
    let plan: Plan;
    // THE BASE WAS ENDED UNDER THE WAITING UPGRADE (review S4): its unused value is this purchase's frozen
    // credit, so an upgrade whose base an admin cancelled (or refunded to the wallet) meanwhile is not
    // activated at the credited price — a person decides (cancel the order, or charge the difference).
    const baseEnded = p.kind === 'upgrade' && p.base_membership_id && !baseLive
      ? await db.prepare("SELECT id FROM memberships WHERE id = ? AND state = 'cancelled'").bind(p.base_membership_id).first<{ id: string }>()
      : null;
    if (p.kind === 'upgrade' && baseEnded) {
      const refunded = await db.prepare('SELECT 1 AS x FROM wallet_transactions WHERE id = ?').bind(`wtx_refund_${p.base_membership_id}`).first();
      plan = { kind: 'block', reason: refunded ? 'base_membership_refunded' : 'base_membership_ended' };
    } else if (p.kind === 'upgrade') {
      if (baseLive && live.length === 1) plan = { kind: 'insert', endBase: baseLive };
      else if (!live.length) plan = { kind: 'insert', endBase: null };
      else plan = { kind: 'block', reason: 'live_membership_changed' };
    } else {
      plan = live.length ? { kind: 'block', reason: 'live_membership_at_activation' } : { kind: 'insert', endBase: null };
    }

    if (p.state === 'blocked') {
      // A RETRY OF A BLOCKED ONE (the sweep, an admin) writes nothing while the
      // conflict stands — no state flip, no second audit row per sweep.
      if (plan.kind === 'block') { out.blocked.push(p.id); continue; }
      // Back to pending for this attempt; refused (unique pending) if another purchase of this customer waits.
      try {
        const moved = await db.prepare("UPDATE order_membership_purchases SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'blocked'").bind(nowIso, p.id).run();
        if (!moved.meta.changes) { out.blocked.push(p.id); continue; }
      } catch { out.blocked.push(p.id); continue; }
    } else if (plan.kind === 'block') {
      await block(db, p, plan.reason, nowIso);
      out.blocked.push(p.id);
      continue;
    }

    const token = newId('omt');
    const membershipId = `mem_ord_${p.order_item_id}`.slice(0, 64);
    const startsAt = nowIso;
    const expiresAt = addMonths(nowIso, p.duration_months);
    const tokenHolds = `EXISTS (SELECT 1 FROM order_membership_purchases WHERE id = '${p.id.replace(/'/g, "''")}' AND activation_token = '${token}' AND state = 'active')`;

    const stmts: D1PreparedStatement[] = [
      db.prepare(
        `UPDATE order_membership_purchases
            SET state = 'active', activation_token = ?2, membership_id = ?3, starts_at = ?4, expires_at = ?5,
                activated_at = ?6, updated_at = ?6, needs_review = 0, review_reason = ''
          WHERE id = ?7 AND state = 'pending' AND ${DELIVERED_AND_PAID}`
      ).bind(orderId, token, membershipId, startsAt, expiresAt, nowIso, p.id),
      ...changedExactlyOne(db),
    ];
    if (plan.endBase) {
      stmts.push(
        db.prepare(`UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = 'active' AND ${tokenHolds}`).bind(plan.endBase.id),
        ...changedExactlyOne(db)
      );
    }
    // The one-live-membership guard of every writer (insertLiveMembership): a live
    // row at this instant makes the state 'conflict', which the CHECK refuses.
    stmts.push(
      db.prepare(
        `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months,
           price_paid_iqd, credit_basis_iqd, credit_applied_iqd, purchased_at, starts_at, expires_at,
           source, source_ref, wallet_tx_id)
         SELECT ?1, ?2, ?3, ?4,
           CASE WHEN EXISTS (SELECT 1 FROM memberships l WHERE l.user_id = ?2 AND l.state IN ('active','prepaid_pending_launch'))
                THEN 'conflict' ELSE 'active' END,
           ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'purchase', ?12, NULL
          WHERE ${tokenHolds}`
      ).bind(membershipId, p.user_id, p.plan_id, p.tier, p.duration_months, p.charge_iqd, p.price_iqd, p.credit_iqd,
        p.created_at, nowIso, expiresAt, `order:${orderId}`),
      ...changedExactlyOne(db)
    );
    stmts.push(
      db.prepare(
        `INSERT INTO audit_log (actor_id, action, target, detail) SELECT ?, 'membership.order_activated', ?, ? WHERE ${tokenHolds}`
      ).bind(opts.actorId ?? null, membershipId, JSON.stringify({
        order_id: orderId, purchase_id: p.id, kind: p.kind, plan_kind: plan.kind, tier: p.tier, months: p.duration_months,
        charge_iqd: p.charge_iqd, credit_iqd: p.credit_iqd, ended: plan.endBase?.id ?? null,
        expires_at: expiresAt, trigger: opts.trigger,
      }))
    );

    try {
      await db.batch(stmts);
      out.activated.push(p.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const now = await db.prepare('SELECT state FROM order_membership_purchases WHERE id = ?').bind(p.id).first<{ state: string }>();
      if (now?.state === 'active') { out.activated.push(p.id); continue; } // another caller won: one activation
      if (isLostRace(e) && now?.state === 'pending') {
        // The order stopped being delivered-and-paid, or the account changed under the batch:
        // re-asked on the next door, never guessed now. A live row that appeared is a person's call.
        const again = await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND state IN ('active','prepaid_pending_launch')").bind(p.user_id).first<{ n: number }>();
        const expected = plan.endBase ? 1 : 0;
        if (Number(again?.n ?? 0) !== expected) { await block(db, p, 'live_membership_changed', nowIso); out.blocked.push(p.id); }
        continue;
      }
      if (/CHECK/.test(msg) || /UNIQUE/.test(msg)) { await block(db, p, 'live_membership_conflict', nowIso); out.blocked.push(p.id); continue; }
      throw e;
    }
    // The cached tier on the user row, so the very next request sees the membership.
    await getTierStatus(db, p.user_id);
  }
  return out;
}

async function block(db: D1Database, p: OrderMembershipPurchaseRow, reason: string, nowIso: string): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE order_membership_purchases SET state = 'blocked', needs_review = 1, review_reason = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'`
    ).bind(reason, nowIso, p.id),
    db.prepare(
      `INSERT INTO audit_log (actor_id, action, target, detail)
       SELECT NULL, 'membership.order_blocked', ?, ? WHERE changes() = 1`
    ).bind(p.order_id, JSON.stringify({ purchase_id: p.id, reason })),
  ]);
}

/**
 * The jobs sweep: every waiting purchase whose order is delivered AND fully
 * paid, re-asked through the same idempotent activation. A COD collected by a
 * job, a delivery through a door that predates this — nothing waits for a page.
 *
 * ONLY ORDERS READY NOW ARE READ (review S7): the delivered-and-paid test is in
 * the SQL, so a hundred delivered-but-unpaid cash orders cannot fill the page
 * and starve a paid one behind them.
 *
 * BLOCKED ONES ARE RETRIED (review S6) when no other purchase of the customer
 * waits: the conflict a person resolved (the other membership cancelled or
 * expired) clears on the next sweep. A conflict that still stands writes
 * nothing (activateOrderMembership). Pending ones are read first.
 */
export async function sweepOrderMemberships(env: Env, limit = 100): Promise<{ scanned: number; activated: number; blocked: number }> {
  const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
  let rows: Array<{ order_id: string; retry: number }> = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT p.order_id, MAX(p.state = 'blocked') AS retry, MIN(p.state = 'blocked') AS only_blocked, MIN(p.updated_at) AS since
         FROM order_membership_purchases p JOIN orders o ON o.id = p.order_id
        WHERE (p.state = 'pending'
               OR (p.state = 'blocked' AND NOT EXISTS (SELECT 1 FROM order_membership_purchases q
                                                        WHERE q.user_id = p.user_id AND q.state = 'pending' AND q.id <> p.id)))
          AND o.status = 'delivered'
          AND (SELECT COALESCE(SUM(s.amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = o.id) >= ${levonisCollectibleSql('o')}
        GROUP BY p.order_id
        ORDER BY only_blocked, since LIMIT ?`
    ).bind(cap).all<{ order_id: string; retry: number }>()).results ?? [];
  } catch (e) {
    if (missingTable(e)) return { scanned: 0, activated: 0, blocked: 0 };
    throw e;
  }
  const report = { scanned: 0, activated: 0, blocked: 0 };
  for (const r of rows) {
    report.scanned++;
    try {
      const res = await activateOrderMembership(env, r.order_id, { trigger: 'sweep', retryBlocked: Number(r.retry) === 1 });
      report.activated += res.activated.length;
      report.blocked += res.blocked.length;
    } catch (e) {
      console.error('order membership activation failed', r.order_id, e instanceof Error ? e.message : String(e));
    }
  }
  return report;
}

/** The refusal of a correction asked for by anyone but the owner, or of an order with no started membership. */
export const OWNER_CORRECTION_NOTHING =
  'لا عضوية بدأت مع هذا الطلب — يُلغى من باب الإلغاء العادي / No membership started with this order — cancel it through the ordinary door';

/**
 * THE OWNER'S CORRECTION (owner ruling 2026-11-17 ~10:20): an order whose
 * membership already started may still be cancelled — by the OWNER only, with
 * a reason. These statements ride FIRST in the batch that cancels and refunds
 * the order (worker/lib/orderStageOps.ts `membershipCorrection`): each started
 * membership row is ended, its purchase becomes 'cancelled' with
 * cancel_reason 'owner_correction' (the only exit trg_order_membership_active_final
 * allows), and an audit row names the owner and the reason. Fenced on the
 * order's stage and status as read, so a lost race writes none of it; the
 * order's own refund (the ordinary cancel's) carries the membership's money
 * back with the rest. A lower membership an upgrade ended is NOT revived.
 */
export function ownerCorrectionStatements(
  db: D1Database,
  order: { id: string; stage: string; status: string },
  purchases: OrderMembershipPurchaseRow[],
  actorId: string,
  reason: string,
  nowIso: string
): D1PreparedStatement[] {
  const fence = `EXISTS (SELECT 1 FROM orders WHERE id = ? AND stage = ? AND status = ?)`;
  const fenceBinds = [order.id, order.stage, order.status];
  const out: D1PreparedStatement[] = [];
  for (const p of purchases.filter((x) => x.state === 'active')) {
    if (p.membership_id) {
      out.push(db.prepare(`UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = 'active' AND ${fence}`).bind(p.membership_id, ...fenceBinds));
    }
    out.push(db.prepare(
      `UPDATE order_membership_purchases SET state = 'cancelled', cancel_reason = 'owner_correction', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND state = 'active' AND ${fence}`
    ).bind(nowIso, nowIso, p.id, ...fenceBinds));
    out.push(db.prepare(
      `INSERT INTO audit_log (actor_id, action, target, detail) SELECT ?, 'membership.order_owner_correction', ?, ? WHERE ${fence}`
    ).bind(actorId, order.id, JSON.stringify({ purchase_id: p.id, membership_id: p.membership_id, tier: p.tier, charge_iqd: p.charge_iqd, reason }), ...fenceBinds));
  }
  return out;
}
