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
import { notify } from './notifications';

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
 * THE MERCHANT HEARS ABOUT THEIR OWN ORDERS (B23).
 *
 * A paid order reached the admin group's Telegram topic and nobody at the
 * store: `merchant_notification_preferences.new_orders` was stored and never
 * read. It is read here — a merchant who switched new-order notices off gets
 * none — and an absent row means the platform default, which is on.
 *
 * A CANCELLATION IS ALWAYS SENT, whatever that switch says. It is not news
 * about a new order; it is the instruction not to ship one that was already
 * paid for.
 *
 * Never throws (`notify`), and replay-proof by event key.
 */
export async function notifyMerchantOfStoreOrder(
  db: D1Database,
  p: {
    merchantId: string;
    orderId: string;
    event: 'new' | 'cancelled_by_customer' | 'cancelled_by_admin';
    totalIqd?: number;
  }
): Promise<void> {
  try {
    const owner = await db
      .prepare(
        `SELECT m.user_id, COALESCE(p.new_orders, 1) AS new_orders
           FROM community_merchants m
           LEFT JOIN merchant_notification_preferences p ON p.merchant_id = m.id
          WHERE m.id = ?`
      )
      .bind(p.merchantId)
      .first<{ user_id: string; new_orders: number }>();
    if (!owner) return;
    if (p.event === 'new' && Number(owner.new_orders) === 0) return;
    const total = Math.max(0, Math.trunc(Number(p.totalIqd) || 0)).toLocaleString('en-US');
    const copy =
      p.event === 'new'
        ? {
            title_ar: `طلب جديد في متجرك — ${p.orderId}`,
            title_en: `New order in your store — ${p.orderId}`,
            body_ar: `الإجمالي ${total} د.ع، مدفوع مسبقًا من محفظة الزبون. أكّده من «الطلبات» في لوحة متجرك.`,
            body_en: `Total ${total} IQD, prepaid from the customer's wallet. Confirm it under Orders in your store dashboard.`,
          }
        : {
            title_ar: `أُلغي الطلب ${p.orderId} — لا تشحنه`,
            title_en: `Order ${p.orderId} was cancelled — do not ship it`,
            body_ar:
              p.event === 'cancelled_by_customer'
                ? 'ألغى الزبون الطلب، وأُعيد المبلغ إلى محفظته.'
                : 'ألغت Levonis الطلب، وأُعيد المبلغ إلى محفظة الزبون.',
            body_en:
              p.event === 'cancelled_by_customer'
                ? 'The customer cancelled it and was refunded to their wallet.'
                : 'Levonis cancelled it and refunded the customer to their wallet.',
          };
    await notify(db, {
      userId: owner.user_id,
      kind: 'order_update',
      ...copy,
      link: '/merchant',
      entity_type: 'order',
      entity_id: p.orderId,
      eventKey: `store_order.${p.event === 'new' ? 'new' : 'cancelled'}:${p.orderId}`,
    });
  } catch (e) {
    console.error('merchant order notice not written', p.orderId, e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------- cancelling

export type StoreOrderActor = 'merchant' | 'customer' | 'admin';

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
 *   6. the merchant's credit: `pending → reversed` in place, or — when it had
 *      already become available (an admin cancelling after a release) — a
 *      negative `reversal` row that takes it back out of «متاح», keyed
 *      `reversal:<order>` so it can exist once;
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
    db
      .prepare(
        `SELECT state FROM merchant_payout_ledger
          WHERE order_id = ? AND merchant_id = ? AND kind = 'sale_credit' LIMIT 1`
      )
      .bind(id, merchantId)
      .first<{ state: string }>(),
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

  stmts.push(
    // Already released → taken back out of «متاح» by a row of its own. Before
    // the flip below, and mutually exclusive with it by `state`.
    db
      .prepare(
        `INSERT INTO merchant_payout_ledger (id, merchant_id, kind, amount_iqd, state, order_id, note, idempotency_key)
         SELECT ?1, l.merchant_id, 'reversal', -l.amount_iqd, 'available', l.order_id, ?2, 'reversal:' || l.order_id
           FROM merchant_payout_ledger l
          WHERE l.order_id = ?3 AND l.merchant_id = ?4 AND l.kind = 'sale_credit'
            AND l.state = 'available' AND l.amount_iqd > 0
            AND ${gate(5)}`
      )
      .bind(newId('pay'), `store order ${id} cancelled after release`, id, merchantId, anchor),
    db
      .prepare(
        `UPDATE merchant_payout_ledger SET state = 'reversed'
          WHERE order_id = ?1 AND merchant_id = ?2 AND kind = 'sale_credit' AND state = 'pending'
            AND ${gate(3)}`
      )
      .bind(id, merchantId, anchor),
    // THIS batch's gate row must exist, or nothing above may stand.
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
    credit?.state === 'pending' ? 'reversed' : credit?.state === 'available' ? 'clawed_back' : 'none';
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
    db
      .prepare(
        `UPDATE merchant_payout_ledger SET state = 'available'
          WHERE order_id = ?1 AND kind = 'sale_credit' AND state = 'pending'
            AND EXISTS (SELECT 1 FROM orders o
                         WHERE o.id = ?1 AND o.status = 'delivered' AND o.receipt_confirmed_at = ?2)`
      )
      .bind(id, now),
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
  /** Orphaned store-checkout wallet holds handed back (B13). */
  holds_released: number;
  errors: number;
}

/**
 * THREE DAYS AFTER DELIVERY, WITH NO OPEN COMPLAINT, THE MONEY IS THE MERCHANT'S.
 *
 * Idempotent by construction: each release is a conditional flip of one
 * `pending` row, re-checking inside the statement that the order is still
 * delivered, still past its three days and still free of an open dispute — so
 * an admin moving the order back, or a complaint filed a second before the
 * sweep, both win. Audited per release (actor NULL: nobody pressed anything).
 */
export async function releaseDueStoreCredits(
  env: Env,
  nowIso: string,
  limit = 100
): Promise<Pick<StoreOrderSweepReport, 'released' | 'frozen' | 'errors'>> {
  const out = { released: 0, frozen: 0, errors: 0 };
  const cutoff = new Date(Date.parse(nowIso) - STORE_RELEASE_DAYS * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT l.id AS ledger_id, l.amount_iqd, o.id AS order_id, o.merchant_id,
            CASE WHEN ${openDisputeSql('o')} THEN 1 ELSE 0 END AS disputed
       FROM merchant_payout_ledger l
       JOIN orders o ON o.id = l.order_id
      WHERE l.kind = 'sale_credit' AND l.state = 'pending'
        AND o.seller_type = 'merchant' AND o.status = 'delivered'
        AND o.delivered_at IS NOT NULL AND o.delivered_at <> '' AND o.delivered_at <= ?1
      ORDER BY o.delivered_at
      LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ ledger_id: string; amount_iqd: number; order_id: string; merchant_id: string; disputed: number }>();

  for (const r of results ?? []) {
    if (Number(r.disputed) === 1) {
      out.frozen += 1;
      continue;
    }
    try {
      const res = await env.DB.prepare(
        `UPDATE merchant_payout_ledger SET state = 'available'
          WHERE id = ?1 AND kind = 'sale_credit' AND state = 'pending'
            AND EXISTS (SELECT 1 FROM orders o
                         WHERE o.id = ?2 AND o.status = 'delivered'
                           AND o.delivered_at IS NOT NULL AND o.delivered_at <> '' AND o.delivered_at <= ?3
                           AND NOT ${openDisputeSql('o')})`
      )
        .bind(r.ledger_id, r.order_id, cutoff)
        .run();
      if ((res.meta.changes ?? 0) > 0) {
        out.released += 1;
        await audit(env.DB, null, 'store_order.credit_released', r.order_id, {
          ledger_id: r.ledger_id,
          amount_iqd: Number(r.amount_iqd) || 0,
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
    holds_released: holds.holds_released,
    errors: credits.errors + holds.errors,
  };
}
