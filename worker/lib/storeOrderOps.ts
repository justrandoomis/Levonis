/**
 * A COMMUNITY-STORE ORDER, FROM THE MOMENT IT EXISTS — one module for every
 * rule that decides whether a store may sell, and for every move of the money
 * a store order carries after checkout.
 *
 * WHY ONE MODULE (docs/merchant-platform/audit/02-commerce-money.md §4).
 * A store order lives in the platform's own `orders` table, and FOUR doors act
 * on it — the merchant's status route, the customer's cancel, the admin's
 * status dropdown and the admin's stage panel. Each one had its own idea of
 * what "cancelled" means:
 *
 *   · the MERCHANT's cancel reversed their own credit and never refunded the
 *     buyer, whose wallet had been debited at checkout (B2);
 *   · the CUSTOMER's and the ADMIN's cancel refunded the buyer and left the
 *     merchant's credit `pending` for ever, the community stock decremented and
 *     the coupon use spent (B7);
 *   · the admin could re-open a cancelled, REFUNDED store order, and a merchant
 *     "delivered" tap then paid the merchant for goods the customer had been
 *     given their money back for.
 *
 * So cancellation is now ONE operation, `cancelStoreOrder`, and every door
 * calls it. Money never leaves a store order by any other path.
 *
 * THE OWNER'S COMPLETION RULE (docs/MERCHANT_PLATFORM.md §2, 2026-09-24):
 * «عند تأكيد الزبون الاستلام، أو تلقائيًا بعد 3 أيام من التسليم إذا لم تُفتح
 * شكوى». A merchant's «تم التسليم» alone never releases money — it used to,
 * instantly (B10). The sale credit stays `pending` until
 * `confirmStoreOrderReceipt` (the customer) or `releaseDueStoreCredits` (the
 * cron, three days after `delivered_at`, skipping any order with an open
 * complaint or support ticket) moves it to `available`.
 *
 * EVERY GUARD IS INSIDE THE STATEMENT THAT WRITES (the file-wide rule of
 * worker/lib/walletOps.ts): a lost race aborts the batch or matches zero rows
 * and is REPORTED as such — never answered with a success that did nothing.
 */

import type { Env } from './types';
import { safeParse } from './types';
import { newId } from './crypto';
import { audit, auditStatements } from './audit';
import { cancelledOrderRefundStatements } from './orderCancelOps';
import { sellingVerdict, type StoreContext } from './merchantAuth';
import { notifyMerchant, storeOrderNotice } from './merchantNotify';
import {
  orderCredit,
  orderCreditStateSql,
  releaseOrderCreditStatements,
  reverseOrderCreditStatement,
} from './merchantLedger';

// ------------------------------------------------------------------ policy

/**
 * Days after `delivered_at` before a store sale's credit releases on its own —
 * the owner's number («تلقائيًا بعد 3 أيام من التسليم»), not a tunable guess.
 */
export const STORE_RELEASE_DAYS = 3;

/**
 * How long a store-checkout wallet hold may stay `active` with no order behind
 * it before the sweep hands the money back (B13). A checkout request lives for
 * seconds; the hold deliberately survives a FAILED batch so a same-key retry
 * reuses it (tests/walletHoldSettlement.test.ts), and half an hour is far past
 * any honest retry.
 */
export const STORE_HOLD_TTL_MINUTES = 30;

/** The cancellation anchor's id: one per order, which is what makes a cancel happen once. */
export const cancelAnchorId = (orderId: string) => `osh_cancel_${orderId}`;

/**
 * A complaint or support ticket that is still open on this order FREEZES its
 * money: the auto-release waits for a human (owner decision, §2). `o` is the
 * alias of the `orders` row in the enclosing query.
 */
export const openDisputeSql = (o: string) => `(
  EXISTS (SELECT 1 FROM community_complaints cc
           WHERE cc.order_id = ${o}.id AND cc.status NOT IN ('resolved','rejected','closed'))
  OR EXISTS (SELECT 1 FROM support_tickets st
              WHERE st.order_id = ${o}.id AND st.state <> 'resolved'))`;

/**
 * THE CUSTOMER WAS ALREADY REFUNDED FOR THIS ORDER — its wallet refund row
 * exists. `orderId` is the SQL expression (a placeholder or a column) for the
 * order's id. The refund's id is deterministic, `wtx_refund_<order>_usd`
 * (worker/lib/orderCancelOps.ts), which is what makes this one primary-key
 * lookup.
 *
 * WHY IT GUARDS EVERY RELEASE (review F4). The code before wave 1 refunded a
 * cancelled store order and then let an admin RE-OPEN it, leaving live rows in
 * which the customer holds the refund and the merchant's credit is still
 * `pending`. Releasing such a credit — three days after a delivery, or on the
 * customer's «استلمت طلبي» — pays the merchant for goods whose price the
 * customer already has back. No credit on a refunded order is released; those
 * orders are listed for a financial admin (`storeOrderMoneyDrift`) instead.
 */
export const refundedStoreOrderSql = (orderId: string) =>
  `EXISTS (SELECT 1 FROM wallet_transactions rt WHERE rt.id = 'wtx_refund_' || ${orderId} || '_usd')`;

// ------------------------------------------------------ may this store sell

/** Why a store is not taking orders. Logged and audited — never shown to a customer. */
export type StoreClosedReason =
  | 'store_paused'
  | 'store_suspended'
  | 'merchant_suspended'
  | 'merchant_restricted'
  | 'not_selling_products'
  | 'subscription_inactive'
  | 'benefit_restricted';

export type StoreSellingVerdict = { ok: true } | { ok: false; reason: StoreClosedReason };

/**
 * MAY THIS STORE TAKE A NEW ORDER RIGHT NOW? — asked at add-to-cart, at the
 * quote and at place-order, about the store's OWNER (B11, audit 01 B3).
 *
 * The merchant's own `requireSellingPrivileges` refused a lapsed PLUS the right
 * to publish a product or make a coupon, while their storefront kept taking
 * paid orders: the buy path checked only `store.status` and a merchant
 * suspension. This is the merchant dashboard's own rule (`sellingVerdict`,
 * worker/lib/merchantAuth.ts — the store is open, nobody suspended it, the
 * owner holds `merchantStore`: PLUS, PREMIUM or PRO) plus the two things only
 * a BUYER needs to be refused for:
 *
 *   · a RESTRICTED merchant takes no new orders (the brief's rule; the
 *     dashboard answer is left to the sanctions work);
 *   · a store that switched off `sells_direct_products` sells none.
 *
 * AN ALLOW-LIST, not a deny-list: `community_merchants.status` is free text
 * with no CHECK, so anything other than exactly `active` is closed. A sanction
 * nobody has taught this function yet stops sales rather than slipping past.
 */
export async function storeTakesOrders(db: D1Database, ctx: StoreContext): Promise<StoreSellingVerdict> {
  if (ctx.merchant.status !== 'active') {
    return { ok: false, reason: ctx.merchant.status === 'suspended' ? 'merchant_suspended' : 'merchant_restricted' };
  }
  if (ctx.store.status !== 'active') {
    return { ok: false, reason: ctx.store.status === 'paused' ? 'store_paused' : 'store_suspended' };
  }
  if (Number(ctx.store.sells_direct_products) !== 1) return { ok: false, reason: 'not_selling_products' };
  const verdict = await sellingVerdict(db, ctx, ctx.store.user_id);
  if (verdict.canSell) return { ok: true };
  return { ok: false, reason: (verdict.reason || 'subscription_inactive') as StoreClosedReason };
}

/**
 * A MERCHANT BUYING FROM THEIR OWN STORE (B17, the buying half).
 *
 * A self-purchase is how a store farms `sold_count`, `completed_orders`, its
 * badge and its matcher score for the price of the commission. Both owner
 * columns are compared — `merchant_stores.user_id` is denormalised from
 * `community_merchants.user_id`, and a disagreement between them must still
 * refuse rather than let one of them through.
 */
export function isOwnStore(ctx: StoreContext, userId: string): boolean {
  return ctx.store.user_id === userId || ctx.merchant.user_id === userId;
}

// ------------------------------------------------------ options & colours

/**
 * THE MERCHANT'S OWN WORD FOR ONE CHOSEN OPTION OR COLOUR (B16).
 *
 * `''` when nothing was chosen; `null` when `id` names nothing on the product
 * — which is a refusal, never a snapshot: the add door used to store whatever
 * 60 characters a client posted and the order printed it as the chosen variant
 * («GOLD PLATED (paid +20000)» at the base price). The label is the entry's
 * display name, or the entry's own id when the merchant gave it none: either
 * way a word the MERCHANT wrote, never one the customer did.
 */
export function merchantEntryLabel(listJson: unknown, id: string): string | null {
  if (!id) return '';
  const list = safeParse<unknown[]>(listJson, []);
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry === id) return entry;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const entryId = String(e.id ?? e.value ?? '');
    if (!entryId || entryId !== id) continue;
    for (const key of ['name_ar', 'name', 'label', 'title', 'value']) {
      const v = e[key];
      if (typeof v === 'string' && v.trim() && v !== id) return v.trim();
    }
    return entryId;
  }
  return null;
}

/**
 * Both choices at once: the snapshot text, or which of the two named nothing.
 * The one function the add door and the checkout both ask, so the two cannot
 * disagree about what a valid choice is.
 */
export function merchantVariantLabel(
  optionsJson: unknown,
  colorsJson: unknown,
  optionId: string,
  colorId: string
): { ok: true; label: string } | { ok: false; which: 'option' | 'color' } {
  const option = merchantEntryLabel(optionsJson, optionId);
  if (option === null) return { ok: false, which: 'option' };
  const color = merchantEntryLabel(colorsJson, colorId);
  if (color === null) return { ok: false, which: 'color' };
  return { ok: true, label: [option, color].filter(Boolean).join(' / ') };
}

// ------------------------------------------------- what the customer sees

/**
 * A store order as its CUSTOMER may see it (B18).
 *
 * `/api/store-orders` answered with `SELECT * FROM orders` — on placement and
 * on every replay — so the buyer's browser received the commission split
 * (`commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`),
 * the idempotency keys and `admin_note`. Named fields only: a column added to
 * `orders` tomorrow is private until somebody decides otherwise here.
 */
export function storeOrderPublic(o: Record<string, unknown>) {
  const delivery = safeParse<Record<string, unknown>>(o.delivery_method_snapshot, {});
  return {
    id: String(o.id),
    status: String(o.status ?? ''),
    stage: String(o.stage || 'received'),
    origin: String(o.origin ?? 'store_product'),
    seller_type: String(o.seller_type ?? 'merchant'),
    merchant_id: o.merchant_id ?? null,
    store_id: o.store_id ?? null,
    store_name: typeof delivery.store === 'string' ? delivery.store : null,
    payment_method_id: String(o.payment_method_id ?? ''),
    delivery_method_id: String(o.delivery_method_id ?? ''),
    subtotal_iqd: Number(o.subtotal_iqd) || 0,
    coupon_code: String(o.coupon_code ?? ''),
    coupon_discount_iqd: Number(o.coupon_discount_iqd) || 0,
    shipping_iqd: Number(o.shipping_iqd) || 0,
    total_iqd: Number(o.total_iqd) || 0,
    wallet_applied_iqd: Number(o.wallet_applied_iqd) || 0,
    wallet_applied_usd_cents: Number(o.wallet_applied_usd_cents) || 0,
    due_on_delivery_iqd: Number(o.due_on_delivery_iqd) || 0,
    address: safeParse<Record<string, unknown>>(o.address_snapshot, {}),
    created_at: o.created_at ?? null,
    updated_at: o.updated_at ?? null,
    delivered_at: o.delivered_at ?? null,
    receipt_confirmed_at: o.receipt_confirmed_at ?? null,
  };
}

// ------------------------------------------------ telling the merchant

/**
 * THE MERCHANT HEARS ABOUT THEIR OWN ORDERS (B23) — through the one merchant
 * notification door (worker/lib/merchantNotify.ts, stream W2-E).
 *
 * The in-app notice is always written and opens THE ORDER
 * (`/merchant/orders/<id>`); the merchant's `new_orders` switch decides whether
 * it also goes to their Telegram / WhatsApp / email. A cancellation is
 * `order_needs_action` — the instruction not to ship what was paid for.
 * Pass the Env for the outside channels; a bare database writes in-app only.
 *
 * Never throws, and replay-proof by event key (wave 1's keys, kept).
 */
export async function notifyMerchantOfStoreOrder(
  envOrDb: Env | D1Database,
  p: {
    merchantId: string;
    orderId: string;
    event: 'new' | 'cancelled_by_customer' | 'cancelled_by_admin';
    totalIqd?: number;
  }
): Promise<void> {
  await notifyMerchant(envOrDb, { merchantId: p.merchantId }, storeOrderNotice(p.event, p.orderId, p.totalIqd));
}

// ------------------------------------------------------------- cancelling

export type StoreOrderActor = 'merchant' | 'customer' | 'admin';

/**
 * WOULD CANCELLING THIS STORE ORDER MOVE MONEY? — a refund to the customer's
 * wallet (cash or points the order took), or a claw-back of a merchant credit
 * that was already released. The admin doors ask it to decide whether the
 * cancel needs the financial scope (review S6); a status move that moves no
 * money does not.
 */
export async function storeCancelMovesMoney(db: D1Database, o: Record<string, unknown>): Promise<boolean> {
  if ((Number(o.wallet_applied_usd_cents) || 0) > 0 || (Number(o.points_discount_iqd) || 0) > 0) return true;
  // A credit already released (the merchant ledger holds it in «available»).
  return (await orderCredit(db, String(o.id ?? ''))).available_iqd > 0;
}

export interface CancelStoreOrderInput {
  /**
   * The order row EXACTLY as the caller read it (`SELECT * FROM orders`) and
   * judged cancellable. The flip is fenced on its `status`, so a row that moved
   * in between loses cleanly instead of being cancelled from a state the
   * caller never approved.
   */
  order: Record<string, unknown>;
  actor: StoreOrderActor;
  /** Who pressed it — recorded on the history row and the audit row. */
  actorUserId: string;
  reason?: string;
  nowIso?: string;
}

export type CancelStoreOrderResult =
  | {
      ok: true;
      orderId: string;
      refundedUsdCents: number;
      restockedUnits: number;
      couponReleased: boolean;
      /** What happened to the merchant's sale credit. */
      credit: 'reversed' | 'clawed_back' | 'none';
    }
  | { ok: false; reason: 'ALREADY_CANCELLED' | 'RACED' };

/**
 * CANCEL A STORE ORDER — everything a cancellation owes, in ONE batch.
 *
 *   1. the conditional status flip (and `stage`, so the customer's tracker
 *      says «ملغي» instead of «تم استلام الطلب»);
 *   2. the history row, which is also THE ONCE-ONLY GATE: its id is fixed per
 *      order, so a second cancellation — a double tap, the merchant and the
 *      customer at the same moment — dies on the PRIMARY KEY and rolls its
 *      whole batch back instead of restocking or reversing a second time;
 *   3. the wallet refund of exactly what the debit took, cents and dinars
 *      (`cancelledOrderRefundStatements`, the customer door's own statements);
 *   4. the community stock and `sold_count` put back, per product;
 *   5. the coupon use given back;
 *   6. the merchant's credit, undone in the append-only merchant ledger
 *      (worker/lib/merchantLedger.ts): refund lines in «pending», or — when it
 *      had already become available (an admin cancelling after a release) —
 *      in «available», a claw-back; keyed `reversal:<order>:<part>` so it can
 *      exist once;
 *   7. a fence that aborts everything unless THIS batch's gate row exists;
 *   8. the audit row.
 *
 * The refund's own fence (step 3) aborts the batch whenever the order is not
 * cancelled at that point, so a flip that lost its race writes nothing at all.
 */
export async function cancelStoreOrder(env: Env, p: CancelStoreOrderInput): Promise<CancelStoreOrderResult> {
  const db = env.DB;
  const o = p.order;
  const id = String(o.id ?? '');
  // A programming error, not a refusal: a platform order must never be
  // cancelled with store semantics (its stock is Levonis's inventory ledger,
  // its money is not a merchant's credit). Loud, so it cannot ship quietly.
  if (!id || String(o.seller_type ?? '') !== 'merchant') {
    throw new Error(`cancelStoreOrder: ${id || '(no id)'} is not a community-store order`);
  }
  const from = String(o.status ?? '');
  if (from === 'cancelled') return { ok: false, reason: 'ALREADY_CANCELLED' };

  const now = p.nowIso ?? new Date().toISOString();
  const anchor = cancelAnchorId(id);
  const merchantId = String(o.merchant_id ?? '');

  const [{ results: lines }, credit] = await Promise.all([
    db
      .prepare(
        `SELECT community_product_id AS product_id, SUM(qty) AS qty
           FROM order_items
          WHERE order_id = ? AND community_product_id IS NOT NULL
          GROUP BY community_product_id`
      )
      .bind(id)
      .all<{ product_id: string; qty: number }>(),
    orderCredit(db, id),
  ]);

  const note = `Cancelled by the ${p.actor}${p.reason ? `: ${p.reason.slice(0, 300)}` : ''}`;
  /** Every dependent statement repeats the gate, bound at parameter `?n`. */
  const gate = (n: number) => `EXISTS (SELECT 1 FROM order_status_history WHERE id = ?${n})`;

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE orders
            SET status = 'cancelled', stage = 'cancelled', stage_changed_at = ?1, stage_source = 'manual',
                next_stage = '', next_stage_at = NULL, updated_at = ?1
          WHERE id = ?2 AND status = ?3 AND seller_type = 'merchant'`
      )
      .bind(now, id, from),
    // THE GATE. A plain INSERT on purpose — never OR IGNORE: the PRIMARY KEY
    // conflict on a second cancellation is what aborts that batch.
    db
      .prepare(
        `INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
         SELECT ?1, ?2, 'cancelled', 'cancelled', 'manual', ?3, ?4, ?5
          WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND status = 'cancelled')`
      )
      .bind(anchor, id, now, p.actorUserId, note),
    ...(await cancelledOrderRefundStatements(env, o, p.actor === 'admin' ? 'admin' : 'system', now)),
  ];

  let restockedUnits = 0;
  for (const line of lines ?? []) {
    const qty = Math.max(0, Math.trunc(Number(line.qty) || 0));
    if (!qty) continue;
    restockedUnits += qty;
    // Symmetric with the checkout's decrement, which takes `stock` down for
    // every line (tracked or not) and `sold_count` up: the cancel puts both
    // back, and `sold_count` never below zero.
    stmts.push(
      db
        .prepare(
          `UPDATE community_products
              SET stock = stock + ?1,
                  sold_count = CASE WHEN sold_count >= ?1 THEN sold_count - ?1 ELSE 0 END,
                  updated_at = ?2
            WHERE id = ?3 AND ${gate(4)}`
        )
        .bind(qty, now, line.product_id, anchor)
    );
  }

  const couponCode = String(o.coupon_code ?? '');
  const storeId = String(o.store_id ?? '');
  const couponReleased = !!(couponCode && storeId);
  if (couponReleased) {
    stmts.push(
      db
        .prepare(
          `UPDATE merchant_coupons SET used_count = used_count - 1, updated_at = ?1
            WHERE store_id = ?2 AND code = ?3 AND used_count > 0 AND ${gate(4)}`
        )
        .bind(now, storeId, couponCode, anchor)
    );
  }

  // The merchant's credit, undone in the merchant ledger: refund lines in
  // «pending» when it was never released, in «available» when it was (a
  // claw-back) — one statement that computes what is left, so a credit a
  // financial admin already took back (`reconcileReverseCredit`) is not taken
  // twice, and fenced on THIS batch's gate row.
  stmts.push(
    reverseOrderCreditStatement(db, {
      orderId: id,
      merchantId,
      actorId: p.actorUserId,
      note: `store order ${id} cancelled by the ${p.actor}`,
      ts: now,
      guard: { sql: gate(7), binds: [anchor] },
    }).statement,
    db
      .prepare(
        `UPDATE orders
            SET status = CASE WHEN status = 'cancelled' AND ${gate(1)} THEN status ELSE NULL END
          WHERE id = ?2`
      )
      .bind(anchor, id)
  );
  const refundedUsdCents = Number(o.wallet_applied_usd_cents) || 0;
  const creditOutcome: 'reversed' | 'clawed_back' | 'none' =
    credit.state === 'pending' ? 'reversed' : credit.state === 'available' ? 'clawed_back' : 'none';
  const { statements: auditStmts } = await auditStatements(db, p.actorUserId, 'store_order.cancelled', id, {
    actor: p.actor,
    from,
    refund_usd_cents: refundedUsdCents,
    restocked_units: restockedUnits,
    coupon: couponCode || null,
    credit: creditOutcome,
    reason: p.reason ?? null,
  });
  stmts.push(...auditStmts);

  try {
    await db.batch(stmts);
  } catch (e) {
    // Every fence above aborts the WHOLE batch, so nothing was written. Say
    // which kind of "no" it was by re-reading; anything that is not a lost
    // race is a real failure and propagates for the caller to retry.
    const again = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first<{ status: string }>();
    if (again?.status === 'cancelled') return { ok: false, reason: 'ALREADY_CANCELLED' };
    if (again && again.status !== from) return { ok: false, reason: 'RACED' };
    throw e;
  }
  return {
    ok: true,
    orderId: id,
    refundedUsdCents,
    restockedUnits,
    couponReleased,
    credit: creditOutcome,
  };
}

// ------------------------------------------------- the customer confirms

export type ConfirmReceiptResult =
  | { ok: true; replayed: boolean; released: boolean }
  | { ok: false; reason: 'NOT_A_STORE_ORDER' | 'NOT_DELIVERED' };

/**
 * «استلمت طلبي» — the customer confirms a DELIVERED store order, and the
 * merchant's credit becomes available (owner decision, §2).
 *
 * The caller has already proved ownership (the route's own `user_id` check);
 * the statement repeats it anyway, so a caller that forgot cannot confirm
 * somebody else's order. Idempotent: the stamp is written once (`IS NULL`),
 * and the credit moves only in the batch that wrote it.
 */
export async function confirmStoreOrderReceipt(
  env: Env,
  p: { order: Record<string, unknown>; customerId: string; nowIso?: string }
): Promise<ConfirmReceiptResult> {
  const db = env.DB;
  const o = p.order;
  const id = String(o.id ?? '');
  if (String(o.seller_type ?? '') !== 'merchant') return { ok: false, reason: 'NOT_A_STORE_ORDER' };
  if (o.receipt_confirmed_at) return { ok: true, replayed: true, released: false };
  if (String(o.status ?? '') !== 'delivered') return { ok: false, reason: 'NOT_DELIVERED' };

  const now = p.nowIso ?? new Date().toISOString();
  const res = await db.batch([
    db
      .prepare(
        `UPDATE orders SET receipt_confirmed_at = ?1, updated_at = ?1
          WHERE id = ?2 AND user_id = ?3 AND seller_type = 'merchant'
            AND status = 'delivered' AND receipt_confirmed_at IS NULL`
      )
      .bind(now, id, p.customerId),
    // Never on an order whose customer was already refunded (review F4): the
    // receipt is still recorded, and the credit waits for a financial admin.
    // The release moves what the order holds in «pending», only in the batch
    // that wrote this receipt.
    ...releaseOrderCreditStatements(db, {
      orderId: id,
      merchantId: String(o.merchant_id ?? ''),
      actorId: p.customerId,
      note: 'the customer confirmed receipt',
      ts: now,
      condition: {
        sql: `EXISTS (SELECT 1 FROM orders ro WHERE ro.id = ?3 AND ro.status = 'delivered' AND ro.receipt_confirmed_at = ?7)
              AND NOT ${refundedStoreOrderSql('?3')}`,
        binds: [now],
      },
    }),
  ]);
  const stamped = (res[0]?.meta?.changes ?? 0) > 0;
  if (!stamped) {
    const again = await db
      .prepare('SELECT status, receipt_confirmed_at FROM orders WHERE id = ? AND user_id = ?')
      .bind(id, p.customerId)
      .first<{ status: string; receipt_confirmed_at: string | null }>();
    if (again?.receipt_confirmed_at) return { ok: true, replayed: true, released: false };
    return { ok: false, reason: 'NOT_DELIVERED' };
  }
  const released = (res[1]?.meta?.changes ?? 0) > 0;
  await audit(db, p.customerId, 'store_order.receipt_confirmed', id, { released });
  return { ok: true, replayed: false, released };
}

// ------------------------------------------------------------- the sweeps

export interface StoreOrderSweepReport {
  /** Sale credits moved pending → available three days after delivery. */
  released: number;
  /** Due credits left pending because a complaint or ticket is open. */
  frozen: number;
  /**
   * Due credits left pending because the customer was already refunded for
   * the order (review F4) — legacy rows a financial admin reconciles.
   */
  refund_blocked: number;
  /** Orphaned store-checkout wallet holds handed back (B13). */
  holds_released: number;
  errors: number;
}

/**
 * THREE DAYS AFTER DELIVERY, WITH NO OPEN COMPLAINT, THE MONEY IS THE MERCHANT'S.
 *
 * Idempotent by construction: each release is a conditional flip of one
 * `pending` row, re-checking inside the statement that the order is still
 * delivered, still past its three days, still free of an open dispute and
 * not refunded — so an admin moving the order back, or a complaint filed a
 * second before the sweep, both win. Audited per release (actor NULL: nobody
 * pressed anything).
 *
 * ONLY ROWS IT CAN RELEASE ARE READ (review F3). A frozen row used to be
 * selected, skipped in code and counted — and `ORDER BY delivered_at LIMIT
 * 100` served the SAME hundred frozen rows (a ticket asking for an invoice is
 * enough) to every run, so no later due credit was ever released. The frozen
 * and the refunded are filtered in the SELECT and counted by queries of their
 * own.
 */
export async function releaseDueStoreCredits(
  env: Env,
  nowIso: string,
  limit = 100
): Promise<Pick<StoreOrderSweepReport, 'released' | 'frozen' | 'refund_blocked' | 'errors'>> {
  const out = { released: 0, frozen: 0, refund_blocked: 0, errors: 0 };
  const cutoff = new Date(Date.parse(nowIso) - STORE_RELEASE_DAYS * 86_400_000).toISOString();
  // Delivered store orders past their three days whose credit is still in
  // «pending» in the merchant ledger.
  const due = `FROM orders o
      WHERE o.seller_type = 'merchant' AND o.status = 'delivered'
        AND o.delivered_at IS NOT NULL AND o.delivered_at <> '' AND o.delivered_at <= ?1
        AND (SELECT COALESCE(SUM(l.amount_iqd), 0) FROM merchant_ledger_entries l
              WHERE l.order_id = o.id AND l.bucket = 'pending') > 0`;
  const { results } = await env.DB.prepare(
    `SELECT o.id AS order_id, o.merchant_id
       ${due}
        AND NOT ${openDisputeSql('o')}
        AND NOT ${refundedStoreOrderSql('o.id')}
      ORDER BY o.delivered_at
      LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ order_id: string; merchant_id: string }>();
  const held = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ${openDisputeSql('o')} THEN 1 ELSE 0 END), 0) AS frozen,
            COALESCE(SUM(CASE WHEN ${refundedStoreOrderSql('o.id')} THEN 1 ELSE 0 END), 0) AS refunded
       ${due}`
  )
    .bind(cutoff)
    .first<{ frozen: number; refunded: number }>();
  out.frozen = Number(held?.frozen ?? 0);
  out.refund_blocked = Number(held?.refunded ?? 0);

  for (const r of results ?? []) {
    try {
      // Every condition asked again INSIDE the statement that moves the money:
      // still delivered, still past the three days, no complaint or ticket
      // opened a second ago, not refunded.
      const stmts = releaseOrderCreditStatements(env.DB, {
        orderId: r.order_id,
        merchantId: String(r.merchant_id ?? ''),
        actorId: null,
        note: `released ${STORE_RELEASE_DAYS} days after delivery`,
        ts: nowIso,
        condition: {
          sql: `EXISTS (SELECT 1 FROM orders o
                         WHERE o.id = ?3 AND o.status = 'delivered'
                           AND o.delivered_at IS NOT NULL AND o.delivered_at <> '' AND o.delivered_at <= ?7
                           AND NOT ${openDisputeSql('o')})
                AND NOT ${refundedStoreOrderSql('?3')}`,
          binds: [cutoff],
        },
      });
      const res = await env.DB.batch(stmts);
      if ((res[0]?.meta?.changes ?? 0) > 0) {
        out.released += 1;
        const moved = await env.DB.prepare(
          "SELECT amount_iqd FROM merchant_ledger_entries WHERE event_key = 'release:' || ? || ':available'"
        )
          .bind(r.order_id)
          .first<{ amount_iqd: number }>();
        await audit(env.DB, null, 'store_order.credit_released', r.order_id, {
          amount_iqd: Number(moved?.amount_iqd) || 0,
          merchant_id: r.merchant_id,
          basis: `${STORE_RELEASE_DAYS} days after delivery, no open complaint`,
        });
      }
    } catch (e) {
      out.errors += 1;
      console.error('store credit release failed for', r.order_id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

/**
 * HAND BACK A STORE-CHECKOUT HOLD THAT NO ORDER EVER CLAIMED (B13).
 *
 * The hold is taken before the order batch and deliberately survives a failed
 * one, so the same key can retry into it. A reload mints a new key, and a
 * changed total can no longer reuse the old hold — so the old one stayed
 * `active`, reserving the customer's money, for ever.
 *
 * FENCED AGAINST THE ORDER BATCH, in the statement that releases: the release
 * requires the hold to be `active` and unlinked AND no order to exist for its
 * (user, checkout key). The order batch commits the hold only while it is
 * `active`, and D1 serialises the two, so exactly one of them wins — a hold is
 * either settled into an order or handed back, never both and never neither.
 */
export async function releaseOrphanStoreHolds(
  env: Env,
  nowIso: string,
  limit = 100
): Promise<Pick<StoreOrderSweepReport, 'holds_released' | 'errors'>> {
  const out = { holds_released: 0, errors: 0 };
  const cutoff = new Date(Date.parse(nowIso) - STORE_HOLD_TTL_MINUTES * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, amount_cents FROM wallet_holds
      WHERE ref_type = 'store_order' AND kind = 'purchase' AND state = 'active' AND tx_id IS NULL
        AND created_at <= ?1
      ORDER BY created_at
      LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ id: string; user_id: string; amount_cents: number }>();

  for (const h of results ?? []) {
    try {
      const res = await env.DB.prepare(
        `UPDATE wallet_holds
            SET state = 'released', released_at = ?2, updated_at = ?2,
                release_reason = 'Store checkout abandoned: no order was placed with this hold'
          WHERE id = ?1 AND state = 'active' AND kind = 'purchase' AND ref_type = 'store_order'
            AND tx_id IS NULL AND created_at <= ?3
            AND NOT EXISTS (
              SELECT 1 FROM orders o
               WHERE o.user_id = wallet_holds.user_id
                 AND (o.client_idempotency_key = substr(wallet_holds.ref_id, length(wallet_holds.user_id) + 2)
                      OR o.idempotency_key = substr(wallet_holds.ref_id, length(wallet_holds.user_id) + 2)))`
      )
        .bind(h.id, nowIso, cutoff)
        .run();
      if ((res.meta.changes ?? 0) > 0) {
        out.holds_released += 1;
        await audit(env.DB, null, 'wallet.store_hold_released', h.id, {
          user_id: h.user_id,
          amount_cents: Number(h.amount_cents) || 0,
          ttl_minutes: STORE_HOLD_TTL_MINUTES,
        });
      }
    } catch (e) {
      out.errors += 1;
      console.error('store hold release failed for', h.id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

/** Both store-order sweeps, for the one line the cron registers (worker/lib/jobs.ts). */
export async function runStoreOrderSweeps(env: Env, nowIso: string): Promise<StoreOrderSweepReport> {
  const credits = await releaseDueStoreCredits(env, nowIso);
  const holds = await releaseOrphanStoreHolds(env, nowIso);
  return {
    released: credits.released,
    frozen: credits.frozen,
    refund_blocked: credits.refund_blocked,
    holds_released: holds.holds_released,
    errors: credits.errors + holds.errors,
  };
}

// ---------------------------------------------------------- reconciliation

/**
 * STORE-ORDER MONEY THE CODE BEFORE WAVE 1 LEFT WRONG, AND NO ROUTE CAN REACH
 * (review F4) — found by a read-only query, shown to a financial admin, and put
 * right one order at a time by a decision on the record. Never by a migration:
 * each row is somebody's money, and which way it goes is a human's call made
 * with the order in front of them.
 *
 *   A · REFUNDED, THEN RE-OPENED. The customer's or the admin's cancel
 *       refunded the buyer and left the merchant's credit `pending`; an admin
 *       then re-opened the order. The customer holds the refund and the
 *       merchant still stands to be paid (the release paths now refuse it —
 *       `refundedStoreOrderSql`). Remedy: `reconcileReverseCredit`.
 *   B · CANCELLED, PAID, NEVER REFUNDED. The merchant's old cancel reversed
 *       their own credit and never refunded the buyer, whose wallet had been
 *       debited at checkout — and every door now refuses a cancelled order.
 *       Remedy: `reconcileRefundUnrefunded`, the cancel operation's own refund.
 *
 * A row leaves the list the moment it is reconciled, so the list is also the
 * proof that nothing is left.
 */
export interface DriftRefundedReopened {
  order_id: string;
  status: string;
  created_at: string;
  customer_id: string;
  customer_name: string | null;
  merchant_id: string;
  merchant_name: string | null;
  total_iqd: number;
  refund_usd_cents: number;
  refund_iqd: number | null;
  refunded_at: string;
  credit_state: 'pending' | 'available';
  credit_iqd: number;
}

export interface DriftCancelledUnrefunded {
  order_id: string;
  created_at: string;
  updated_at: string;
  customer_id: string;
  customer_name: string | null;
  merchant_id: string;
  merchant_name: string | null;
  total_iqd: number;
  paid_usd_cents: number;
  paid_iqd: number | null;
  credit_state: string | null;
}

export async function storeOrderMoneyDrift(
  db: D1Database,
  limit = 200
): Promise<{ refunded_reopened: DriftRefundedReopened[]; cancelled_unrefunded: DriftCancelledUnrefunded[] }> {
  const [{ results: reopened }, { results: unrefunded }] = await Promise.all([
    db
      .prepare(
        `SELECT o.id AS order_id, o.status, o.created_at, o.user_id AS customer_id, u.name AS customer_name,
                o.merchant_id, m.name AS merchant_name, o.total_iqd,
                rt.amount AS refund_usd_cents, rt.amount_iqd AS refund_iqd, rt.created_at AS refunded_at,
                c.credit_state, CASE WHEN c.pend > 0 THEN c.pend ELSE c.avail END AS credit_iqd
           FROM orders o
           JOIN wallet_transactions rt ON rt.id = 'wtx_refund_' || o.id || '_usd'
           JOIN (SELECT l.order_id,
                        COALESCE(SUM(CASE WHEN l.bucket = 'pending' THEN l.amount_iqd ELSE 0 END), 0) AS pend,
                        COALESCE(SUM(CASE WHEN l.bucket = 'available' THEN l.amount_iqd ELSE 0 END), 0) AS avail,
                        CASE WHEN SUM(CASE WHEN l.bucket = 'pending' THEN l.amount_iqd ELSE 0 END) > 0 THEN 'pending'
                             ELSE 'available' END AS credit_state
                   FROM merchant_ledger_entries l WHERE l.order_id IS NOT NULL GROUP BY l.order_id) c ON c.order_id = o.id
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN community_merchants m ON m.id = o.merchant_id
          WHERE o.seller_type = 'merchant' AND o.status <> 'cancelled'
            AND (c.pend > 0 OR c.avail > 0)
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ?1`
      )
      .bind(limit)
      .all<DriftRefundedReopened>(),
    db
      .prepare(
        `SELECT o.id AS order_id, o.created_at, o.updated_at, o.user_id AS customer_id, u.name AS customer_name,
                o.merchant_id, m.name AS merchant_name, o.total_iqd,
                (SELECT d.amount FROM wallet_transactions d
                  WHERE d.user_id = o.user_id AND d.ref = o.id AND d.type = 'withdrawal'
                    AND d.currency = 'USD' AND d.status = 'approved' LIMIT 1) AS paid_usd_cents,
                (SELECT d.amount_iqd FROM wallet_transactions d
                  WHERE d.user_id = o.user_id AND d.ref = o.id AND d.type = 'withdrawal'
                    AND d.currency = 'USD' AND d.status = 'approved' LIMIT 1) AS paid_iqd,
                ${orderCreditStateSql('o.id')} AS credit_state
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN community_merchants m ON m.id = o.merchant_id
          WHERE o.seller_type = 'merchant' AND o.status = 'cancelled' AND o.wallet_applied_usd_cents > 0
            AND NOT ${refundedStoreOrderSql('o.id')}
            AND EXISTS (SELECT 1 FROM wallet_transactions d
                         WHERE d.user_id = o.user_id AND d.ref = o.id AND d.type = 'withdrawal'
                           AND d.currency = 'USD' AND d.status = 'approved')
          ORDER BY o.updated_at DESC, o.id DESC
          LIMIT ?1`
      )
      .bind(limit)
      .all<DriftCancelledUnrefunded>(),
  ]);
  return { refunded_reopened: reopened ?? [], cancelled_unrefunded: unrefunded ?? [] };
}

export type ReconcileResult =
  | { ok: true; replayed: boolean; orderId: string }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_APPLICABLE'; detail: string };

/**
 * The merchant's credit on an order, taken back — refund lines that zero what
 * the order still holds, in «pending» or (already released) in «available»
 * (worker/lib/merchantLedger.ts `reverseOrderCreditStatement`), keyed
 * `reversal:<order>:<part>` exactly as `cancelStoreOrder` keys them, so the two
 * can never both take it back. Conditional and idempotent.
 */
function creditTakeBackStatement(
  db: D1Database,
  p: {
    orderId: string;
    merchantId: string;
    idPrefix: string;
    note: string;
    adminId: string;
    /** A further condition, given the SQL for the order id (?3); its binds start at ?7. */
    extraGuard?: { sql: string; binds: unknown[] };
  }
): D1PreparedStatement {
  return reverseOrderCreditStatement(db, {
    orderId: p.orderId,
    merchantId: p.merchantId,
    actorId: p.adminId,
    note: p.note,
    ts: new Date().toISOString(),
    idPrefix: p.idPrefix,
    guard: p.extraGuard,
  }).statement;
}

/**
 * B · REFUND A CANCELLED, PAID STORE ORDER THAT WAS NEVER REFUNDED — with the
 * cancel operation's own refund statements (`cancelledOrderRefundStatements`,
 * which `cancelStoreOrder` runs): exactly what the checkout debit took, cents
 * and the dinars beside them, under the deterministic `wtx_refund_<order>_usd`
 * id, fenced on the order being cancelled. The merchant's credit is taken
 * back if it is somehow still payable. Two fences bracket the refund: the
 * batch aborts if the refund row ALREADY exists when it starts (a second
 * submit — D1 runs batches one at a time, so it sees the first one's row), and
 * again unless the row exists once the refund ran. So a double submit refunds
 * once and writes one audit row, whatever the clock says — which is why
 * neither fence compares timestamps.
 *
 * Stock and the coupon use are NOT touched: months later the merchant may
 * have corrected their stock by hand, and a blind restock would overstate it.
 */
export async function reconcileRefundUnrefunded(
  env: Env,
  p: { orderId: string; adminId: string; reason: string; nowIso?: string }
): Promise<ReconcileResult> {
  const db = env.DB;
  const o = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(p.orderId).first<Record<string, unknown>>();
  if (!o) return { ok: false, reason: 'NOT_FOUND', detail: 'order' };
  const id = String(o.id);
  if (String(o.seller_type ?? '') !== 'merchant') return { ok: false, reason: 'NOT_APPLICABLE', detail: 'not_a_store_order' };
  const refundId = `wtx_refund_${id}_usd`;
  const already = await db.prepare('SELECT 1 AS x FROM wallet_transactions WHERE id = ?').bind(refundId).first();
  if (already) return { ok: true, replayed: true, orderId: id };
  if (String(o.status ?? '') !== 'cancelled') return { ok: false, reason: 'NOT_APPLICABLE', detail: 'not_cancelled' };
  const cents = Number(o.wallet_applied_usd_cents) || 0;
  const debit = await db
    .prepare(
      `SELECT id, amount FROM wallet_transactions
        WHERE user_id = ? AND ref = ? AND type = 'withdrawal' AND currency = 'USD' AND status = 'approved' LIMIT 1`
    )
    .bind(String(o.user_id), id)
    .first<{ id: string; amount: number }>();
  if (!(cents > 0) || !debit) return { ok: false, reason: 'NOT_APPLICABLE', detail: 'not_paid_from_wallet' };

  const now = p.nowIso ?? new Date().toISOString();
  const credit = await orderCredit(db, id);
  const { statements: auditStmts } = await auditStatements(db, p.adminId, 'admin.store_order_reconciled', id, {
    kind: 'refund_unrefunded_cancellation',
    reason: p.reason,
    refund_usd_cents: cents,
    debit_id: debit.id,
    debit_usd_cents: Number(debit.amount) || 0,
    credit_before: credit.state,
  });
  // `orders.status` is NOT NULL: writing NULL into it is the abort, the same
  // idiom as the refund's own fence.
  const refundFence = (mustExist: boolean) =>
    db
      .prepare(
        `UPDATE orders
            SET status = CASE WHEN ${mustExist ? '' : 'NOT '}EXISTS (SELECT 1 FROM wallet_transactions WHERE id = ?1)
                              THEN status ELSE NULL END
          WHERE id = ?2`
      )
      .bind(refundId, id);
  const stmts: D1PreparedStatement[] = [
    // Nobody refunded it yet — a second submit stops here.
    refundFence(false),
    ...(await cancelledOrderRefundStatements(env, o, 'admin', now)),
    // …and THIS batch did, or nothing in it stands.
    refundFence(true),
    creditTakeBackStatement(db, {
      orderId: id,
      merchantId: String(o.merchant_id ?? ''),
      idPrefix: newId('mle'),
      note: `store order ${id} cancelled and refunded by reconciliation`,
      adminId: p.adminId,
    }),
    ...auditStmts,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    const landed = await db.prepare('SELECT 1 AS x FROM wallet_transactions WHERE id = ?').bind(refundId).first();
    if (landed) return { ok: true, replayed: true, orderId: id };
    throw e;
  }
  return { ok: true, replayed: false, orderId: id };
}

/**
 * A · TAKE BACK THE CREDIT OF A STORE ORDER WHOSE CUSTOMER WAS ALREADY
 * REFUNDED and which an admin then re-opened. Conditional, inside the
 * statements, on the refund still existing and the order not cancelled (a
 * cancellation takes the credit back by itself). The order is left as it is —
 * whether the goods still go out, and on what terms, is between the admin,
 * the customer and the merchant; the money can no longer pay twice.
 */
export async function reconcileReverseCredit(
  env: Env,
  p: { orderId: string; adminId: string; reason: string }
): Promise<ReconcileResult> {
  const db = env.DB;
  const o = await db
    .prepare('SELECT id, status, seller_type, merchant_id FROM orders WHERE id = ?')
    .bind(p.orderId)
    .first<{ id: string; status: string; seller_type: string; merchant_id: string | null }>();
  if (!o) return { ok: false, reason: 'NOT_FOUND', detail: 'order' };
  if (o.seller_type !== 'merchant') return { ok: false, reason: 'NOT_APPLICABLE', detail: 'not_a_store_order' };
  const refund = await db
    .prepare('SELECT amount, amount_iqd FROM wallet_transactions WHERE id = ?')
    .bind(`wtx_refund_${o.id}_usd`)
    .first<{ amount: number; amount_iqd: number | null }>();
  if (!refund) return { ok: false, reason: 'NOT_APPLICABLE', detail: 'not_refunded' };
  const credit = await orderCredit(db, o.id);
  if (credit.state === null) return { ok: false, reason: 'NOT_APPLICABLE', detail: 'no_credit' };
  if (credit.state === 'reversed' || credit.state === 'settled') return { ok: true, replayed: true, orderId: o.id };
  if (o.status === 'cancelled') return { ok: false, reason: 'NOT_APPLICABLE', detail: 'cancelled' };

  const prefix = newId('mle');
  const { statements: auditStmts } = await auditStatements(db, p.adminId, 'admin.store_order_reconciled', o.id, {
    kind: 'reverse_credit_of_refunded_order',
    reason: p.reason,
    credit_before: credit.state,
    credit_iqd: credit.state === 'pending' ? credit.pending_iqd : credit.available_iqd,
    refund_usd_cents: Number(refund.amount) || 0,
    refund_iqd: refund.amount_iqd ?? null,
  });
  const stmts: D1PreparedStatement[] = [
    creditTakeBackStatement(db, {
      orderId: o.id,
      merchantId: String(o.merchant_id ?? ''),
      idPrefix: prefix,
      note: 'customer refunded before the order was re-opened — reversed by reconciliation',
      adminId: p.adminId,
      extraGuard: {
        sql: `${refundedStoreOrderSql('?3')}
              AND EXISTS (SELECT 1 FROM orders ro WHERE ro.id = ?3 AND ro.status <> 'cancelled')`,
        binds: [],
      },
    }),
    // THIS batch took the credit back, or nothing in it — the audit row
    // included — stands.
    db
      .prepare(
        `UPDATE orders
            SET status = CASE WHEN EXISTS (SELECT 1 FROM merchant_ledger_entries
                                            WHERE id IN (?1 || '_refund', ?1 || '_commission_refund', ?1 || '_delivery_refund'))
                              THEN status ELSE NULL END
          WHERE id = ?2`
      )
      .bind(prefix, o.id),
    ...auditStmts,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    const again = await orderCredit(db, o.id);
    if (again.state === 'reversed') return { ok: true, replayed: true, orderId: o.id };
    const now = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(o.id).first<{ status: string }>();
    if (now?.status === 'cancelled') return { ok: false, reason: 'NOT_APPLICABLE', detail: 'cancelled' };
    throw e;
  }
  return { ok: true, replayed: false, orderId: o.id };
}
