/**
 * THE CREDIT IS NEVER LOST (DECISIONS rows 237 and 238; Services S-P2 spec §6.9, plan §1.2).
 *
 * A completed trade-in's credit paid for a new device. Two ways it comes back — always as the SAME
 * coupon row (same code; one coupon per request for life), on any device sold directly, never as
 * cash (decision 2 / C14a); for 30 days the first time, for the time it had left after that
 * (`reissueEndsAt`):
 *
 *   - the order is CANCELLED before delivery, by any door: migration 0192's
 *     `trg_orders_tradein_reissue_on_cancel` writes the re-issue, moves the coupon's end and logs
 *     the event, while 0191 releases the use; the services sweep sends the notice;
 *   - the new device is RETURNED: the refund batch (worker/routes/returns.ts) releases the use,
 *     writes the re-issue (`reason = 'returned'`), moves the coupon's end and tells the customer —
 *     and the refund itself is cash NET of the credit, attributed to the new device's line only
 *     (other lines are no longer charged a share of it). The credit belongs to the FIRST unit
 *     returned of that line (§16 D-13).
 */
import { safeParse } from './types';
import { newId } from './crypto';
import { notifyStatement } from './notifications';
import { requestPath } from './tradeIn';

/** A re-issued credit lives this long — the 0192 trigger's literal (`+30 days`, §16 D-12). */
export const REISSUE_VALID_DAYS = 30;

export interface OrderTradeInCredit {
  requestId: string;
  couponId: string;
  /** What the credit took off this order (`coupon_snapshot.discount_iqd`). */
  amount: number;
  /** The order line it paid for (`coupon_snapshot.trade_in_line_id`, else the coupon's target line); null when none matches. */
  lineId: string | null;
}

/**
 * The trade-in credit an order spent, and the line it paid for — from the order's own frozen
 * snapshot (`trade_in_line_id`, written by the checkout since S-P2); an older order falls back to
 * the coupon's target (product, model, colour). Null when the order spent no trade-in credit.
 */
export async function tradeInCreditOf(
  db: D1Database,
  order: { coupon_snapshot?: unknown },
  items: ReadonlyArray<{ id: string; product_id?: unknown; option_value_ids?: unknown; color_id?: unknown; gift_entitlement_id?: unknown }>
): Promise<OrderTradeInCredit | null> {
  const snap = safeParse<{ coupon_id?: unknown; discount_iqd?: unknown; trade_in_line_id?: unknown } | null>(String(order.coupon_snapshot ?? ''), null);
  const couponId = typeof snap?.coupon_id === 'string' ? snap.coupon_id : null;
  if (!couponId) return null;
  const c = await db
    .prepare('SELECT trade_in_id, product_id, option_value_id, color_id FROM coupons WHERE id = ?')
    .bind(couponId)
    .first<{ trade_in_id: string | null; product_id: string | null; option_value_id: string | null; color_id: string | null }>();
  if (!c?.trade_in_id) return null;
  const amount = Math.max(0, Math.trunc(Number(snap?.discount_iqd) || 0));
  const named = typeof snap?.trade_in_line_id === 'string' && items.some((i) => i.id === snap.trade_in_line_id) ? (snap.trade_in_line_id as string) : null;
  const matched =
    named ??
    items.find(
      (i) =>
        !i.gift_entitlement_id &&
        i.product_id === c.product_id &&
        (!c.option_value_id || safeParse<unknown[]>(String(i.option_value_ids ?? '[]'), []).includes(c.option_value_id)) &&
        (!c.color_id || i.color_id === c.color_id)
    )?.id ??
    null;
  return { requestId: c.trade_in_id, couponId, amount, lineId: matched };
}

/**
 * WHEN A CREDIT GIVEN BACK ENDS (review F-2; the 0192 cancel trigger states the same rule in SQL):
 * the FIRST time a request's credit comes back it lives 30 days; when it comes back again (the
 * re-issued credit was spent on this order, which is now returned or cancelled) it keeps the time it
 * had left — the latest earlier re-issue's end plus the time this order held it — never more than 30
 * days from now. Giving a credit back can never renew it.
 */
export async function reissueEndsAt(db: D1Database, requestId: string, orderId: string, nowIso: string): Promise<string> {
  const now = Date.parse(nowIso);
  const fresh = new Date(now + REISSUE_VALID_DAYS * 86_400_000).toISOString();
  const row = await db
    .prepare(
      `SELECT (SELECT MAX(x.ends_at) FROM trade_in_credit_reissues x WHERE x.request_id = ?1 AND x.order_id <> ?2) AS prev_end,
              (SELECT o.created_at FROM orders o WHERE o.id = ?2) AS order_at`
    )
    .bind(requestId, orderId)
    .first<{ prev_end: string | null; order_at: string | null }>();
  const prev = row?.prev_end ? Date.parse(row.prev_end) : NaN;
  if (!Number.isFinite(prev)) return fresh;
  const since = row?.order_at ? Date.parse(row.order_at) : NaN;
  const held = Number.isFinite(since) ? Math.max(0, now - since) : 0;
  const carried = new Date(prev + held).toISOString();
  return carried < fresh ? carried : fresh;
}

/**
 * The statements that give a returned device's credit back, for the refund batch (after the
 * wallet credit, before the evidence). Each is conditional on the request being COMPLETED, and the
 * re-issue on none existing for this (request, order) — a second press of the refund, or a second
 * case on the same line, re-issues nothing. `ctx.endsAt` comes from `reissueEndsAt`.
 *
 * An order that was cancelled (its credit given back then), reopened, delivered and now returned
 * already has its (request, order) row: the coupon's end still moves to `endsAt`, the return is
 * logged, and the FENCE (last) refuses the whole refund when no re-issue row stands for this
 * (request, order) — a refund netted of the credit never commits without the credit coming back.
 */
export function returnReissueStatements(
  db: D1Database,
  credit: OrderTradeInCredit,
  ctx: { orderId: string; returnCaseId: string; userId: string; now: string; endsAt: string }
): D1PreparedStatement[] {
  const completed = `EXISTS (SELECT 1 FROM trade_in_requests t WHERE t.id = ?1 AND t.status = 'completed')`;
  return [
    db
      .prepare(`UPDATE coupon_redemptions SET state = 'released', released_at = ?4 WHERE order_id = ?3 AND coupon_id = ?2 AND state = 'active' AND ${completed}`)
      .bind(credit.requestId, credit.couponId, ctx.orderId, ctx.now),
    db
      .prepare(
        `INSERT INTO trade_in_credit_reissues (id, request_id, coupon_id, order_id, reason, return_case_id, amount_iqd, ends_at, created_at)
         SELECT ?5, ?1, ?2, ?3, 'returned', ?4, ?6, ?7, ?8
          WHERE ${completed} AND NOT EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = ?1 AND x.order_id = ?3)`
      )
      .bind(credit.requestId, credit.couponId, ctx.orderId, ctx.returnCaseId, newId('tcr'), credit.amount, ctx.endsAt, ctx.now),
    db
      .prepare(
        `UPDATE coupons SET ends_at = ?4
          WHERE id = ?2 AND trade_in_id = ?1 AND ${completed}
            AND EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = ?1 AND x.order_id = ?3)`
      )
      .bind(credit.requestId, credit.couponId, ctx.orderId, ctx.endsAt),
    db
      .prepare(
        `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
         SELECT ?2, ?1, NULL, 'system', 'credit_reissued', 'completed', 'completed',
                json_object('order_id', ?4, 'coupon_id', ?5, 'ends_at', ?6, 'reason', 'returned'), ?3
          WHERE ${completed}
            AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = ?1 AND e.action = 'credit_reissued'
                              AND json_valid(e.detail_json) AND json_extract(e.detail_json, '$.order_id') = ?4
                              AND json_extract(e.detail_json, '$.reason') = 'returned')`
      )
      .bind(credit.requestId, newId('tie'), ctx.now, ctx.orderId, credit.couponId, ctx.endsAt),
    reissueNotice(db, { requestId: credit.requestId, userId: ctx.userId, orderId: ctx.orderId, endsAt: ctx.endsAt }),
    // THE FENCE (review F-5/F-10): no re-issue for this (request, order) → the case's quantity turns
    // negative, its CHECK aborts the batch: no cash refund netted of a credit that did not come back.
    db
      .prepare(`UPDATE return_cases SET qty = -1 WHERE id = ?3 AND NOT EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = ?1 AND x.order_id = ?2)`)
      .bind(credit.requestId, ctx.orderId, ctx.returnCaseId),
  ];
}

/** «2026-11-14» — the day a credit given back ends, as every language states it. */
const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * «عاد رصيد الاستبدال — صالح حتى <اليوم> لأي جهاز متوفر للبيع المباشر» (ar/en/ckb), once per
 * (request, order). The day is the credit's own end (30 days the first time, what was left after).
 */
export function reissueNotice(db: D1Database, x: { requestId: string; userId: string; orderId: string; endsAt: string }): D1PreparedStatement {
  const d = dayOf(x.endsAt);
  return notifyStatement(db, {
    userId: x.userId,
    kind: 'trade_in',
    title_ar: `عاد رصيد الاستبدال — صالح حتى ${d} لأي جهاز متوفر للبيع المباشر`,
    title_en: `Your trade-in credit is back — valid until ${d} on any device in stock for direct sale`,
    body_ar: 'يُصرف على أي جهاز متوفر للبيع المباشر، ولا يُصرف نقداً.',
    body_en: 'Usable on any device in stock for direct sale, never as cash.',
    meta: {
      title_ckb: `باڵانسی گۆڕینەوەکەت گەڕایەوە — تا ${d} بۆ هەر ئامێرێکی بەردەست بۆ فرۆشتنی ڕاستەوخۆ بەکاردێت`,
      body_ckb: 'بۆ هەر ئامێرێکی بەردەست بۆ فرۆشتنی ڕاستەوخۆ بەکاردێت، نەک وەک پارەی نەقد.',
    },
    link: requestPath(x.requestId),
    entity_type: 'trade_in',
    entity_id: x.requestId,
    eventKey: `trade_in:${x.requestId}:reissued:${x.orderId}`,
  }).stmt;
}
