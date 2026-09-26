/**
 * «تعديل السعر النهائي» — AN ADMIN RE-PRICES AN ORDER, THE CUSTOMER DECIDES.
 *
 * The owner (2026-09-26): «اجعل بإمكان الأدمن التعديل على السعر النهائي لطلب
 * المستخدم، لكن عند التعديل يبقى الطلب معلقا إلى أن يوافق الزبون … فيرسل إشعار
 * للمستخدم بأنه يجب الموافقة على السعر حتى يتمكن من المتابعة للطلب مع زر
 * inline مثلا في التليجرام عند الضغط عليه يوافق».
 *
 * THE LIFECYCLE (migration 0140):
 *
 *   propose   a FINANCIAL admin names a new final total and a reason the
 *             customer reads. One batch writes the proposal row and sets
 *             `orders.price_hold_id`. No money moves.
 *   (held)    `trg_orders_price_hold_freeze` aborts every write that would move
 *             the order's status or stage; every admin door answers 409
 *             PRICE_APPROVAL_PENDING before it gets that far.
 *   approve   the customer (site button or Telegram inline button). ONE batch:
 *             the proposal flips, the order's total / door amount / wallet
 *             figures move, the prepaid excess (if any) is credited back to the
 *             wallet, the pending points accrual follows, the hold is
 *             released, the audit row is written. Every statement re-reads
 *             this batch's `decision_token`, so a second concurrent press
 *             aborts whole instead of applying twice.
 *   reject    the customer. The hold is released and nothing else changes; the
 *             admin decides what next (cancel through the normal path).
 *   withdraw  any admin. The hold is released and nothing else changes.
 *   void      the customer cancelled the order while it was held (they may:
 *             the ordinary «pending only» rule of POST /api/orders/:id/cancel
 *             still applies). The cancel batch voids the proposal.
 *
 * WHERE IT IS ALLOWED — «pre-shipping», defined here and nowhere else:
 *   legacy status pending / confirmed / processing, AND no courier shipment
 *   booked (`delivery_remote_id` empty — the courier's COD figure is copied
 *   when the shipment is created and would disagree with a new one), AND a
 *   platform order (a community store's order carries merchant money this
 *   does not re-price), AND not financed (BNPL, Gini — see
 *   packages/pricing/src/priceAdjustment.ts).
 *
 * THE MONEY RULE lives in `planPriceAdjustment` (pure, shared with the admin
 * panel's preview): higher → the door amount grows; lower → the door amount
 * shrinks first and anything below the prepaid wallet part comes back to the
 * wallet, in dinars exactly (0108's dinar legs, worker/lib/walletAdjust.ts).
 *
 * WHAT IS DELIBERATELY UNTOUCHED: the items and their prices, the coupon and
 * membership snapshots (they describe the checkout that happened), the COD
 * tax (frozen at checkout — the admin's figure IS the final total), and a
 * points accrual that already RELEASED. The pending accrual is capped so it
 * never rewards more than the new total, and its settlement flag follows the
 * door amount (see `pointsStatements`).
 */
import type { Env } from './types';
import { sha256Hex, randomToken } from './crypto';
import { isPriceHeld, PRICE_APPROVAL_PENDING_MESSAGE } from './priceHold';
export { isPriceHeld, isPriceHoldAbort, PRICE_APPROVAL_PENDING_MESSAGE } from './priceHold';
import { auditStatements } from './audit';
import { notifyStatement } from './notifications';
import { notifyCustomer, notificationLang, reachFor, NOTIFY_LANG_SELECT, type NotifyLangRow } from './customerNotify';
import { enqueue } from './outbox';
import type { EmailLang } from './emailTemplates';
import { availableUsdSql, walletLedgerDinarsReady } from './walletOps';
import { planDinarLegs, type DinarLeg } from './walletAdjust';
import { multipliedPointsSql } from './pointsMultiplier';
import { answerCallbackQuery, editMessageText, sendMessageToChat } from './telegram';
import { announceToAdmins, orderTopic } from './adminTopicRouting';
import { orderAdminLink } from './orderTelegramConfirm';
import { createInvoiceRevision } from './invoices';
import { sanitizeUserText } from './walletNotify';
import { planPriceAdjustment, type PriceAdjustPlan, type PriceAdjustRefusal } from '@levonis/pricing/priceAdjustment';

// ------------------------------------------------------------------ codes

/** Every refusal this feature makes. The client maps them (src/lib/refusalStrings.ts). */
export type PriceAdjustCode =
  | PriceAdjustRefusal
  | 'PRICE_APPROVAL_PENDING'
  | 'PRICE_ADJUST_STAGE'
  | 'PRICE_ADJUST_STORE_ORDER'
  | 'PRICE_ADJUST_COURIER_BOOKED'
  | 'PRICE_ADJUST_NOT_PENDING'
  | 'PRICE_ADJUST_STALE'
  | 'IDEMPOTENCY_KEY_REUSED';

export class PriceAdjustError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: PriceAdjustCode | 'NOT_FOUND',
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PriceAdjustError';
  }
}

/** Legacy statuses in which the price may still change. */
export const PRICE_ADJUSTABLE_STATUSES: readonly string[] = ['pending', 'confirmed', 'processing'];

/**
 * Why this order may not be re-priced now — or null when it may. Payment
 * refusals come from the plan itself; this is the order's situation.
 */
export function priceAdjustBlocker(order: Record<string, unknown>): PriceAdjustCode | null {
  if (String(order.seller_type ?? 'levonis') === 'merchant') return 'PRICE_ADJUST_STORE_ORDER';
  if (isPriceHeld(order)) return 'PRICE_APPROVAL_PENDING';
  if (!PRICE_ADJUSTABLE_STATUSES.includes(String(order.status ?? ''))) return 'PRICE_ADJUST_STAGE';
  if (['out_for_delivery', 'delivered', 'cancelled'].includes(String(order.stage ?? ''))) return 'PRICE_ADJUST_STAGE';
  if (String(order.delivery_remote_id ?? '') !== '') return 'PRICE_ADJUST_COURIER_BOOKED';
  return null;
}

export function planFor(order: Record<string, unknown>, newTotalIqd: number) {
  return planPriceAdjustment({
    totalIqd: Number(order.total_iqd) || 0,
    dueOnDeliveryIqd: Number(order.due_on_delivery_iqd) || 0,
    walletAppliedIqd: Number(order.wallet_applied_iqd) || 0,
    paymentMethodId: String(order.payment_method_id ?? ''),
    bnplDueIqd: Number(order.bnpl_due_iqd) || 0,
    giniPaidIqd: Number(order.gini_paid_iqd) || 0,
    newTotalIqd,
  });
}

// ------------------------------------------------------------------ reads

export interface PriceAdjustmentRow {
  id: string;
  order_id: string;
  user_id: string;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'void';
  old_total_iqd: number;
  new_total_iqd: number;
  delta_iqd: number;
  old_due_iqd: number;
  new_due_iqd: number;
  old_wallet_iqd: number;
  new_wallet_iqd: number;
  wallet_refund_iqd: number;
  reason: string;
  note: string;
  proposed_by: string;
  idempotency_key: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string;
  tg_chat_id: number | null;
  tg_message_id: number | null;
}

/** What a screen may see of a proposal. No idempotency key, no Telegram ids. */
export function publicAdjustment(a: PriceAdjustmentRow) {
  return {
    id: a.id,
    state: a.state,
    old_total_iqd: a.old_total_iqd,
    new_total_iqd: a.new_total_iqd,
    delta_iqd: a.delta_iqd,
    old_due_iqd: a.old_due_iqd,
    new_due_iqd: a.new_due_iqd,
    wallet_refund_iqd: a.wallet_refund_iqd,
    reason: a.reason,
    note: a.note,
    created_at: a.created_at,
    decided_at: a.decided_at,
    decided_via: a.decided_via || null,
  };
}

export async function loadAdjustment(db: D1Database, id: string): Promise<PriceAdjustmentRow | null> {
  return (await db.prepare('SELECT * FROM order_price_adjustments WHERE id = ?').bind(id).first<PriceAdjustmentRow>()) ?? null;
}

/** Newest first, bounded — an order has a handful at most. */
export async function listAdjustments(db: D1Database, orderId: string, limit = 20): Promise<PriceAdjustmentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM order_price_adjustments WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(orderId, limit)
    .all<PriceAdjustmentRow>();
  return results ?? [];
}

// ------------------------------------------------------------------ propose

export interface ProposeInput {
  orderId: string;
  adminId: string;
  newTotalIqd: number;
  reason: string;
  note: string;
  idempotencyKey: string;
}

export interface ProposeResult {
  adjustment: PriceAdjustmentRow;
  replayed: boolean;
}

const refuse = (code: PriceAdjustCode, msg: string, details?: Record<string, unknown>, status: 400 | 409 = 409) =>
  new PriceAdjustError(status, code, msg, details);

const MESSAGES: Record<PriceAdjustCode, string> = {
  PRICE_APPROVAL_PENDING: PRICE_APPROVAL_PENDING_MESSAGE,
  PRICE_ADJUST_STAGE: 'Only an order that has not shipped yet can be re-priced.',
  PRICE_ADJUST_STORE_ORDER: 'A community store order is priced by its merchant and cannot be re-priced here.',
  PRICE_ADJUST_COURIER_BOOKED: 'A courier shipment already carries this order’s cash amount — cancel the shipment first.',
  PRICE_ADJUST_FINANCED: 'Instalment orders (BNPL / Gini) cannot be re-priced.',
  PRICE_ADJUST_INVALID_TOTAL: 'The new total must be a whole number of dinars above zero.',
  PRICE_ADJUST_SAME_TOTAL: 'The new total is the same as the current one.',
  PRICE_ADJUST_UNSUPPORTED_PAYMENT: 'This order’s payment split cannot be re-priced automatically.',
  PRICE_ADJUST_NOT_PENDING: 'This price proposal was already decided or withdrawn.',
  PRICE_ADJUST_STALE: 'The order changed while you were editing — reload and retry.',
  IDEMPOTENCY_KEY_REUSED: 'This idempotency key was already used for a different proposal.',
};

const httpOf = (code: PriceAdjustCode, details?: Record<string, unknown>) =>
  refuse(code, MESSAGES[code], details, code === 'PRICE_ADJUST_INVALID_TOTAL' || code === 'PRICE_ADJUST_SAME_TOTAL' ? 400 : 409);

/** Deterministic per (order, admin, key): a retried request finds its own row. */
export async function proposalId(orderId: string, adminId: string, key: string): Promise<string> {
  return `padj_${(await sha256Hex(`${orderId}:${adminId}:${key}`)).slice(0, 24)}`;
}

export async function proposePriceAdjustment(env: Env, input: ProposeInput): Promise<ProposeResult> {
  const db = env.DB;
  const id = await proposalId(input.orderId, input.adminId, input.idempotencyKey);

  // A replay of a request that already landed answers with what it wrote.
  const prior = await loadAdjustment(db, id);
  if (prior) {
    if (prior.order_id !== input.orderId || prior.new_total_iqd !== input.newTotalIqd || prior.reason !== input.reason) {
      throw httpOf('IDEMPOTENCY_KEY_REUSED');
    }
    return { adjustment: prior, replayed: true };
  }

  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(input.orderId).first<Record<string, unknown>>();
  if (!order) throw new PriceAdjustError(404, 'NOT_FOUND', 'Order not found');
  const blocker = priceAdjustBlocker(order);
  if (blocker) throw httpOf(blocker, blocker === 'PRICE_APPROVAL_PENDING' ? { price_hold_id: order.price_hold_id } : undefined);
  const planned = planFor(order, input.newTotalIqd);
  if (!planned.ok) throw httpOf(planned.code);
  const plan = planned.plan;

  const now = new Date().toISOString();
  const userId = String(order.user_id);
  const audit = await auditStatements(db, input.adminId, 'order.price_adjust.propose', input.orderId, {
    adjustment_id: id,
    old_total_iqd: plan.oldTotalIqd,
    new_total_iqd: plan.newTotalIqd,
    delta_iqd: plan.deltaIqd,
    new_due_iqd: plan.newDueIqd,
    wallet_refund_iqd: plan.walletRefundIqd,
    reason: input.reason,
  });
  const inApp = notifyStatement(db, {
    userId,
    kind: 'order_update',
    title_ar: `مطلوب موافقتك على السعر الجديد لطلبك ${input.orderId}`,
    title_en: `Your approval is needed: new price for order ${input.orderId}`,
    body_ar: `${iqdText(plan.oldTotalIqd, 'ar')} ← ${iqdText(plan.newTotalIqd, 'ar')} — ${input.reason}`,
    body_en: `${iqdText(plan.oldTotalIqd, 'en')} → ${iqdText(plan.newTotalIqd, 'en')} — ${input.reason}`,
    link: orderPath(input.orderId),
    entity_type: 'order',
    entity_id: input.orderId,
    meta: { price_adjustment_id: id },
    eventKey: `order.price_adjust:${id}`,
  });

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO order_price_adjustments
             (id, order_id, user_id, state, old_total_iqd, new_total_iqd, delta_iqd, old_due_iqd, new_due_iqd,
              old_wallet_iqd, new_wallet_iqd, wallet_refund_iqd, reason, note, proposed_by, idempotency_key, created_at)
           VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
        )
        .bind(
          id, input.orderId, userId, plan.oldTotalIqd, plan.newTotalIqd, plan.deltaIqd, plan.oldDueIqd, plan.newDueIqd,
          plan.oldWalletIqd, plan.newWalletIqd, plan.walletRefundIqd, input.reason, input.note, input.adminId,
          input.idempotencyKey, now
        ),
      // THE HOLD, conditional on every figure the plan was computed from and on
      // the order still being where the blocker check saw it.
      db
        .prepare(
          `UPDATE orders SET price_hold_id = ?1, updated_at = ?2
            WHERE id = ?3 AND price_hold_id IS NULL AND status = ?4 AND stage = ?5
              AND total_iqd = ?6 AND due_on_delivery_iqd = ?7 AND wallet_applied_iqd = ?8
              AND COALESCE(delivery_remote_id, '') = ''`
        )
        .bind(
          id, now, input.orderId, String(order.status), String(order.stage ?? 'received'),
          plan.oldTotalIqd, plan.oldDueIqd, plan.oldWalletIqd
        ),
      // THE FENCE: a hold that did not land aborts the whole batch (state is NOT NULL).
      db
        .prepare(
          `UPDATE order_price_adjustments
              SET state = CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.id = ?2 AND o.price_hold_id = ?1)
                               THEN state ELSE NULL END
            WHERE id = ?1`
        )
        .bind(id, input.orderId),
      inApp.stmt,
      ...audit.statements,
    ]);
  } catch (e) {
    // The same key racing itself: the other request's row is the answer.
    const again = await loadAdjustment(db, id);
    if (again) return { adjustment: again, replayed: true };
    const now2 = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(input.orderId).first<Record<string, unknown>>();
    if (now2 && isPriceHeld(now2)) throw httpOf('PRICE_APPROVAL_PENDING', { price_hold_id: now2.price_hold_id });
    if (/constraint|NOT NULL/i.test(e instanceof Error ? e.message : String(e))) throw httpOf('PRICE_ADJUST_STALE');
    throw e;
  }
  const adjustment = (await loadAdjustment(db, id))!;
  return { adjustment, replayed: false };
}

// ------------------------------------------------------------------ close without money

export type CloseState = 'rejected' | 'withdrawn';

async function closeWithoutMoney(
  env: Env,
  a: PriceAdjustmentRow,
  state: CloseState,
  actorId: string,
  via: 'web' | 'telegram' | 'admin'
): Promise<boolean> {
  const db = env.DB;
  const token = randomToken(12);
  const now = new Date().toISOString();
  const audit = await auditStatements(db, actorId, `order.price_adjust.${state === 'rejected' ? 'reject' : 'withdraw'}`, a.order_id, {
    adjustment_id: a.id,
    old_total_iqd: a.old_total_iqd,
    new_total_iqd: a.new_total_iqd,
    via,
  });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE order_price_adjustments
              SET state = ?1, decided_at = ?2, decided_by = ?3, decided_via = ?4, decision_token = ?5
            WHERE id = ?6 AND state = 'pending'`
        )
        .bind(state, now, actorId, via, token, a.id),
      db.prepare('UPDATE orders SET price_hold_id = NULL, updated_at = ?1 WHERE id = ?2 AND price_hold_id = ?3').bind(now, a.order_id, a.id),
      db
        .prepare(
          `UPDATE order_price_adjustments
              SET state = CASE WHEN decision_token = ?2
                                AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = ?3 AND o.price_hold_id = ?1)
                               THEN state ELSE NULL END
            WHERE id = ?1`
        )
        .bind(a.id, token, a.order_id),
      ...audit.statements,
    ]);
    return true;
  } catch (e) {
    const again = await loadAdjustment(db, a.id);
    if (again && again.state !== 'pending') return false;
    throw e;
  }
}

export async function withdrawPriceAdjustment(
  env: Env,
  p: { orderId: string; adjustmentId: string; adminId: string }
): Promise<{ adjustment: PriceAdjustmentRow; replayed: boolean }> {
  const a = await loadAdjustment(env.DB, p.adjustmentId);
  if (!a || a.order_id !== p.orderId) throw new PriceAdjustError(404, 'NOT_FOUND', 'Price proposal not found');
  if (a.state === 'withdrawn') return { adjustment: a, replayed: true };
  if (a.state !== 'pending') throw httpOf('PRICE_ADJUST_NOT_PENDING', { state: a.state });
  const won = await closeWithoutMoney(env, a, 'withdrawn', p.adminId, 'admin');
  const after = (await loadAdjustment(env.DB, a.id))!;
  if (!won && after.state !== 'withdrawn') throw httpOf('PRICE_ADJUST_NOT_PENDING', { state: after.state });
  return { adjustment: after, replayed: !won };
}

// ------------------------------------------------------------------ approve

/** The debit this order's wallet payment was posted as (worker/routes/orders.ts checkout). */
const orderDebitId = (orderId: string) => `wtx_ord_${orderId}_usd`;
/** The ledger `ref` of a price-adjustment refund — NOT the order id, so the
 *  cancel refund's debit sum (orderCancelOps) never reads it as a debit. */
export const priceRefundRef = (orderId: string) => `order-price:${orderId}`;

interface RefundLegs {
  legs: DinarLeg[];
  /** Whether the legs record dinars (0108) — only when the debit did. */
  withDinars: boolean;
  rate: number;
  /** Net cents credited; the order's `wallet_applied_usd_cents` falls by this. */
  netCents: number;
}

/**
 * The wallet rows that return `refundIqd` of the prepaid part.
 *
 * All of it: the remaining cents in one credit (the cancel refund's shape), so
 * nothing is left on the order. Part of it: `planDinarLegs`, which moves the
 * dinar reading by EXACTLY `refundIqd` (a sub-cent refund is the net-zero-cent
 * pair). A debit that recorded no dinars is reversed by rows recording none,
 * which is the symmetry orderCancelOps keeps.
 */
async function refundLegsFor(
  env: Env,
  order: Record<string, unknown>,
  plan: PriceAdjustPlan
): Promise<RefundLegs | null> {
  if (plan.walletRefundIqd <= 0) return null;
  const orderId = String(order.id);
  const walletCents = Math.max(0, Math.trunc(Number(order.wallet_applied_usd_cents) || 0));
  const debit = await env.DB.prepare('SELECT amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?')
    .bind(orderDebitId(orderId))
    .first<{ amount_iqd: number | null; exchange_rate_snapshot: number | null }>()
    .catch(() => null);
  const debitRate = Math.trunc(Number(debit?.exchange_rate_snapshot) || 0);
  const rate = debitRate > 0 ? debitRate : Math.trunc(Number(order.exchange_rate) || 0);
  if (walletCents <= 0 || rate <= 0) return null;
  const withDinars = (Number(debit?.amount_iqd) || 0) > 0 && debitRate > 0 && (await walletLedgerDinarsReady(env.DB));

  if (plan.newWalletIqd === 0) {
    return { legs: [{ type: 'deposit', cents: walletCents, amountIqd: plan.walletRefundIqd }], withDinars, rate, netCents: walletCents };
  }
  if (!withDinars) {
    const cents = Math.min(walletCents, Math.max(1, Math.floor((plan.walletRefundIqd * 100) / rate)));
    return { legs: [{ type: 'deposit', cents, amountIqd: plan.walletRefundIqd }], withDinars, rate, netCents: cents };
  }
  let legs = planDinarLegs(plan.walletRefundIqd, rate);
  let net = legs.reduce((n, l) => n + (l.type === 'deposit' ? l.cents : -l.cents), 0);
  if (net > walletCents) {
    // The checkout capped its debit below the dinars' conversion (a wallet
    // holding remainders); never hand back more cents than were taken.
    legs = [{ type: 'deposit', cents: walletCents, amountIqd: plan.walletRefundIqd }];
    net = walletCents;
  }
  return { legs, withDinars, rate, netCents: net };
}

export type DecideOutcome =
  | { outcome: 'approved' | 'rejected'; adjustment: PriceAdjustmentRow; replayed: boolean }
  | { outcome: 'closed'; adjustment: PriceAdjustmentRow };

/**
 * The customer's decision. `actorUserId` must be the order's customer — the
 * web route and the Telegram callback both establish that before calling.
 */
export async function decidePriceAdjustment(
  env: Env,
  p: { adjustmentId: string; decision: 'approve' | 'reject'; actorUserId: string; via: 'web' | 'telegram' }
): Promise<DecideOutcome> {
  const db = env.DB;
  const a = await loadAdjustment(db, p.adjustmentId);
  if (!a) throw new PriceAdjustError(404, 'NOT_FOUND', 'Price proposal not found');
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(a.order_id).first<Record<string, unknown>>();
  if (!order || String(order.user_id) !== p.actorUserId || a.user_id !== p.actorUserId) {
    throw new PriceAdjustError(404, 'NOT_FOUND', 'Price proposal not found');
  }
  const wanted = p.decision === 'approve' ? 'approved' : 'rejected';
  if (a.state !== 'pending') {
    // Replay-safe: the same decision again is its own answer; anything else is closed.
    if (a.state === wanted) return { outcome: wanted, adjustment: a, replayed: true };
    return { outcome: 'closed', adjustment: a };
  }

  if (p.decision === 'reject') {
    const won = await closeWithoutMoney(env, a, 'rejected', p.actorUserId, p.via);
    const after = (await loadAdjustment(db, a.id))!;
    if (after.state === 'rejected') return { outcome: 'rejected', adjustment: after, replayed: !won };
    return { outcome: 'closed', adjustment: after };
  }

  // Re-plan from the proposal's own frozen figures: the approval moves the
  // order from exactly those figures or not at all.
  const plan: PriceAdjustPlan = {
    oldTotalIqd: a.old_total_iqd,
    newTotalIqd: a.new_total_iqd,
    deltaIqd: a.delta_iqd,
    oldDueIqd: a.old_due_iqd,
    newDueIqd: a.new_due_iqd,
    oldWalletIqd: a.old_wallet_iqd,
    newWalletIqd: a.new_wallet_iqd,
    walletRefundIqd: a.wallet_refund_iqd,
  };
  const oldCents = Math.max(0, Math.trunc(Number(order.wallet_applied_usd_cents) || 0));
  const refund = await refundLegsFor(env, order, plan);
  if (plan.walletRefundIqd > 0 && !refund) throw httpOf('PRICE_ADJUST_UNSUPPORTED_PAYMENT');
  const newCents = oldCents - (refund?.netCents ?? 0);

  const token = randomToken(12);
  const now = new Date().toISOString();
  const orderId = a.order_id;
  const userId = p.actorUserId;
  /** ?1..?5 of every dependent statement: this batch's decision and the figures it lands. */
  const fence: unknown[] = [a.id, token, orderId, plan.newTotalIqd, newCents];

  const statements: D1PreparedStatement[] = [
    // 1. THE CLAIM — only while still pending AND still the order's hold.
    db
      .prepare(
        `UPDATE order_price_adjustments
            SET state = 'approved', decided_at = ?1, decided_by = ?2, decided_via = ?3, decision_token = ?4
          WHERE id = ?5 AND state = 'pending' AND user_id = ?2
            AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ?6 AND o.price_hold_id = ?5)`
      )
      .bind(now, userId, p.via, token, a.id, orderId),
    // 2. THE ORDER — from exactly the proposal's figures, releasing the hold.
    db
      .prepare(
        `UPDATE orders
            SET total_iqd = ?1, due_on_delivery_iqd = ?2, wallet_applied_iqd = ?3, wallet_applied_usd_cents = ?4,
                price_adjustment_iqd = COALESCE(price_adjustment_iqd, 0) + ?5, price_hold_id = NULL, updated_at = ?6
          WHERE id = ?7 AND price_hold_id = ?8
            AND total_iqd = ?9 AND due_on_delivery_iqd = ?10 AND wallet_applied_iqd = ?11 AND wallet_applied_usd_cents = ?12
            AND EXISTS (SELECT 1 FROM order_price_adjustments pa WHERE pa.id = ?8 AND pa.decision_token = ?13 AND pa.state = 'approved')`
      )
      .bind(
        plan.newTotalIqd, plan.newDueIqd, plan.newWalletIqd, newCents, plan.deltaIqd, now,
        orderId, a.id, plan.oldTotalIqd, plan.oldDueIqd, plan.oldWalletIqd, oldCents, token
      ),
  ];

  // 3. THE WALLET CREDIT (a cut below the prepaid part), idempotent on its id.
  const legIds: string[] = [];
  if (refund) {
    refund.legs.forEach((leg, i) => {
      const txId = `wtx_padj_${a.id}_${i + 1}`;
      legIds.push(txId);
      const amountExpr =
        leg.type === 'withdrawal'
          ? `CASE WHEN ${APPLIED_SQL} AND ${availableUsdSql('?7')} >= ?9 THEN ?9 ELSE -1 END`
          : `CASE WHEN ${APPLIED_SQL} THEN ?9 ELSE -1 END`;
      const cols = refund.withDinars ? ', amount_iqd, exchange_rate_snapshot' : '';
      const vals = refund.withDinars ? ', ?13, ?14' : '';
      const binds = [...fence, txId, userId, leg.type, leg.cents, `Price adjustment refund for order ${orderId}`, priceRefundRef(orderId), now];
      if (refund.withDinars) binds.push(leg.amountIqd, refund.rate);
      statements.push(
        db
          .prepare(
            `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at${cols})
             SELECT ?6, ?7, ?8, 'USD', ${amountExpr}, 'approved', ?10, ?11, 'system', ?12${vals}
              WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?6)`
          )
          .bind(...binds)
      );
    });
  }

  // 4. THE POINTS the order is still earning.
  statements.push(...pointsStatements(db, plan, fence, now));

  // 5. THE FENCE: a claim that did not land, or an order that did not move,
  // aborts everything above (state is NOT NULL).
  statements.push(
    db
      .prepare(`UPDATE order_price_adjustments SET state = CASE WHEN ${APPLIED_SQL} THEN state ELSE NULL END WHERE id = ?1`)
      .bind(...fence)
  );

  // 6. THE AUDIT, in the same transaction as the money.
  const audit = await auditStatements(db, userId, 'order.price_adjust.approve', orderId, {
    adjustment_id: a.id,
    via: p.via,
    old_total_iqd: plan.oldTotalIqd,
    new_total_iqd: plan.newTotalIqd,
    delta_iqd: plan.deltaIqd,
    old_due_iqd: plan.oldDueIqd,
    new_due_iqd: plan.newDueIqd,
    wallet_refund_iqd: plan.walletRefundIqd,
    wallet_refund_cents: refund?.netCents ?? 0,
    wallet_tx_ids: legIds,
    proposed_by: a.proposed_by,
  });
  statements.push(...audit.statements);

  try {
    await db.batch(statements);
  } catch (e) {
    const again = await loadAdjustment(db, a.id);
    if (again && again.state === 'approved') return { outcome: 'approved', adjustment: again, replayed: true };
    if (again && again.state !== 'pending') return { outcome: 'closed', adjustment: again };
    if (/constraint|NOT NULL|CHECK/i.test(e instanceof Error ? e.message : String(e))) throw httpOf('PRICE_ADJUST_STALE');
    throw e;
  }
  const after = (await loadAdjustment(db, a.id))!;
  return { outcome: 'approved', adjustment: after, replayed: false };
}

/**
 * "This batch's decision landed and the order carries it" — re-read by every
 * dependent statement of the approval batch. ?1 proposal id, ?2 decision
 * token, ?3 order id, ?4 new total, ?5 the order's new wallet cents.
 */
const APPLIED_SQL = `(EXISTS (SELECT 1 FROM order_price_adjustments pa WHERE pa.id = ?1 AND pa.decision_token = ?2 AND pa.state = 'approved')
   AND EXISTS (SELECT 1 FROM orders po WHERE po.id = ?3 AND po.price_hold_id IS NULL AND po.total_iqd = ?4 AND po.wallet_applied_usd_cents = ?5))`;

/**
 * THE PENDING ACCRUAL FOLLOWS THE NEW TOTAL — within the existing rule.
 *
 * Points are computed from net eligible MERCHANDISE (pointsOps.ts), not from
 * the total, so a price adjustment does not re-derive them. Two things do
 * follow, because otherwise the accrual would contradict the order:
 *   - the basis is CAPPED at the new total: a cut below the merchandise figure
 *     must not keep rewarding money the customer no longer pays;
 *   - settlement follows the door amount: an order that owed nothing at the
 *     door and now does is no longer settled (its points wait for the
 *     collection, POST /api/orders/:id/settlement), and one that now owes
 *     nothing is settled today.
 * A RELEASED accrual is never touched — it is history, reversible only by the
 * reversal path.
 */
function pointsStatements(db: D1Database, plan: PriceAdjustPlan, fence: unknown[], now: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const base = '(CASE WHEN iqd_per_point > 0 THEN ?6 / iqd_per_point ELSE 0 END)';
  out.push(
    db
      .prepare(
        `UPDATE points_accruals
            SET eligible_iqd = ?6,
                base_points = ${base},
                points = ${multipliedPointsSql(base, 'COALESCE(multiplier_x100, 100)')}
          WHERE order_id = ?3 AND kind = 'purchase' AND state = 'pending' AND eligible_iqd > ?6 AND ${APPLIED_SQL}`
      )
      .bind(...fence, plan.newTotalIqd)
  );
  if (plan.oldDueIqd === 0 && plan.newDueIqd > 0) {
    out.push(
      db
        .prepare(
          `UPDATE points_accruals SET settled_at = NULL
            WHERE order_id = ?3 AND kind = 'purchase' AND state = 'pending' AND ${APPLIED_SQL}`
        )
        .bind(...fence)
    );
  } else if (plan.oldDueIqd > 0 && plan.newDueIqd === 0) {
    out.push(
      db
        .prepare(
          `UPDATE points_accruals SET settled_at = ?6
            WHERE order_id = ?3 AND kind = 'purchase' AND state = 'pending' AND settled_at IS NULL AND ${APPLIED_SQL}`
        )
        .bind(...fence, now)
    );
  }
  return out;
}

// ------------------------------------------------------------------ cancel while held

/**
 * The customer cancelled a held order (POST /api/orders/:id/cancel). Rides in
 * the cancel batch, fenced on the order really being cancelled.
 */
export function voidPendingPriceAdjustmentStatement(db: D1Database, orderId: string, actorId: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE order_price_adjustments
          SET state = 'void', decided_at = ?1, decided_by = ?2, decided_via = 'customer_cancel'
        WHERE order_id = ?3 AND state = 'pending'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ?3 AND o.status = 'cancelled' AND o.price_hold_id IS NULL)`
    )
    .bind(nowIso, actorId, orderId);
}

// ------------------------------------------------------------------ words

const orderPath = (orderId: string) => `/orders/${encodeURIComponent(orderId)}`;

function appOrigin(env: Env): string | null {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  return origin.startsWith('https://') ? origin : null;
}

export function iqdText(n: number, lang: EmailLang | 'ar' | 'en'): string {
  const v = Math.trunc(n).toLocaleString('en-US');
  return lang === 'en' ? `${v} IQD` : `${v} د.ع`;
}

/**
 * The customer's copy. Arabic and English only: Sorani is never
 * machine-written (docs/DECISIONS.md row 11) — a ckb reader gets the Arabic.
 * OWNER: Sorani to be written by hand.
 */
const CUSTOMER_COPY = {
  ar: {
    subject: (o: string) => `مطلوب موافقتك على السعر الجديد لطلبك ${o}`,
    body: (o: string, from: string, to: string, reason: string) =>
      `عدّلنا السعر النهائي لطلبك ${o} من ${from} إلى ${to}.\nالسبب: ${reason}\nلن نتابع تجهيز الطلب حتى توافق على السعر الجديد أو ترفضه.`,
    due: 'المستحق عند الاستلام بعد الموافقة',
    refund: 'يُعاد إلى محفظتك',
    note: 'تفاصيل',
    cta: 'راجع السعر ووافق',
    approve: '✅ موافق على السعر الجديد',
    reject: '✖️ رفض',
    open: '🔗 فتح الطلب',
  },
  en: {
    subject: (o: string) => `Your approval is needed: new price for order ${o}`,
    body: (o: string, from: string, to: string, reason: string) =>
      `We changed the final price of order ${o} from ${from} to ${to}.\nReason: ${reason}\nWe will not continue preparing it until you approve or reject the new price.`,
    due: 'Due on delivery after approval',
    refund: 'Back to your wallet',
    note: 'Details',
    cta: 'Review and approve',
    approve: '✅ Approve the new price',
    reject: '✖️ Reject',
    open: '🔗 Open the order',
  },
} as const;

const copyFor = (lang: EmailLang) => CUSTOMER_COPY[lang === 'en' ? 'en' : 'ar'];

/** Telegram refuses callback_data over 64 bytes; ours is ~34. */
export const PRICE_CALLBACK_PREFIX = 'pa:';
const ADJ_ID_RE = /^padj_[0-9a-f]{24}$/;

export function priceCallbackData(decision: 'approve' | 'reject', adjustmentId: string): string {
  return `${PRICE_CALLBACK_PREFIX}${decision === 'approve' ? 'y' : 'n'}:${adjustmentId}`;
}
export function isPriceCallbackData(data: unknown): data is string {
  return typeof data === 'string' && data.startsWith(PRICE_CALLBACK_PREFIX);
}
export function parsePriceCallbackData(data: unknown): { decision: 'approve' | 'reject'; adjustmentId: string } | null {
  if (!isPriceCallbackData(data)) return null;
  const m = /^pa:([yn]):(padj_[0-9a-f]{24})$/.exec(data);
  if (!m || !ADJ_ID_RE.test(m[2])) return null;
  return { decision: m[1] === 'y' ? 'approve' : 'reject', adjustmentId: m[2] };
}

export function priceKeyboard(env: Env, a: Pick<PriceAdjustmentRow, 'id' | 'order_id'>, lang: EmailLang): Record<string, unknown> {
  const t = copyFor(lang);
  const origin = appOrigin(env);
  return {
    inline_keyboard: [
      [{ text: t.approve, callback_data: priceCallbackData('approve', a.id) }],
      [{ text: t.reject, callback_data: priceCallbackData('reject', a.id) }],
      ...(origin ? [[{ text: t.open, url: `${origin}${orderPath(a.order_id)}` }]] : []),
    ],
  };
}

function promptText(a: PriceAdjustmentRow, lang: EmailLang): string {
  const t = copyFor(lang);
  const L = lang === 'en' ? 'en' : 'ar';
  const reason = sanitizeUserText(a.reason, { max: 500 });
  const lines = [t.body(a.order_id, iqdText(a.old_total_iqd, L), iqdText(a.new_total_iqd, L), reason)];
  if (a.note) lines.push(`${t.note}: ${sanitizeUserText(a.note, { max: 600 })}`);
  if (a.new_due_iqd > 0) lines.push(`${t.due}: ${iqdText(a.new_due_iqd, L)}`);
  if (a.wallet_refund_iqd > 0) lines.push(`${t.refund}: ${iqdText(a.wallet_refund_iqd, L)}`);
  return `LEVONIS\n${lines.join('\n')}`;
}

async function customerLang(env: Env, userId: string): Promise<EmailLang> {
  const row = await env.DB.prepare(`SELECT ${NOTIFY_LANG_SELECT} FROM users u WHERE u.id = ?`)
    .bind(userId)
    .first<NotifyLangRow>()
    .catch(() => null);
  return row ? notificationLang(row) : 'ar';
}

/**
 * «فيرسل إشعار للمستخدم بأنه يجب الموافقة على السعر» — email and WhatsApp
 * through the ordinary fan-out (a link to the order), and Telegram as its own
 * message carrying the two decision buttons. The in-app row was written in the
 * proposal batch. Never throws: the proposal is already true.
 */
export async function notifyCustomerOfProposal(env: Env, a: PriceAdjustmentRow): Promise<void> {
  try {
    const lang = await customerLang(env, a.user_id);
    const t = copyFor(lang);
    const L = lang === 'en' ? 'en' : 'ar';
    const origin = appOrigin(env);
    const reason = sanitizeUserText(a.reason, { max: 500 });
    await notifyCustomer(
      env,
      a.user_id,
      `order.price_adjust:${a.id}`,
      {
        subject: t.subject(a.order_id),
        body: t.body(a.order_id, iqdText(a.old_total_iqd, L), iqdText(a.new_total_iqd, L), reason),
        details: [
          ...(a.new_due_iqd > 0 ? [{ label: t.due, value: iqdText(a.new_due_iqd, L) }] : []),
          ...(a.wallet_refund_iqd > 0 ? [{ label: t.refund, value: iqdText(a.wallet_refund_iqd, L) }] : []),
        ],
        ...(origin ? { cta: { label: t.cta, url: `${origin}${orderPath(a.order_id)}` } } : {}),
      },
      { channels: ['email', 'whatsapp'] }
    );

    const reach = await reachFor(env, a.user_id);
    if (reach.telegram_chat_id === null) return;
    const text = promptText(a, lang);
    const markup = priceKeyboard(env, a, lang);
    const sent = await sendMessageToChat(env, reach.telegram_chat_id, text, { reply_markup: markup });
    if (sent.ok) {
      await env.DB.prepare('UPDATE order_price_adjustments SET tg_chat_id = ?1, tg_message_id = ?2 WHERE id = ?3')
        .bind(sent.chat_id, sent.message_id, a.id)
        .run();
      return;
    }
    // Not delivered now: the outbox retries it (the buttons stay replay-safe).
    if (sent.retryable) {
      await enqueue(env, `order.price_adjust:${a.id}:telegram`, {
        kind: 'telegram',
        chat_id: reach.telegram_chat_id,
        text,
        reply_markup: markup,
      });
    }
  } catch (e) {
    console.error('notifyCustomerOfProposal failed for', a.id, e instanceof Error ? e.message : String(e));
  }
}

/** The line a decided Telegram prompt ends with. */
function outcomeStamp(a: PriceAdjustmentRow, lang: EmailLang): string {
  const en = lang === 'en';
  const L = en ? 'en' : 'ar';
  switch (a.state) {
    case 'approved':
      return en ? `✅ Approved — the new total is ${iqdText(a.new_total_iqd, L)}.` : `✅ تمت الموافقة — الإجمالي الجديد ${iqdText(a.new_total_iqd, L)}.`;
    case 'rejected':
      return en ? `✖️ Rejected — the order stays at ${iqdText(a.old_total_iqd, L)}.` : `✖️ تم الرفض — بقي الطلب على ${iqdText(a.old_total_iqd, L)}.`;
    case 'withdrawn':
      return en ? 'The shop withdrew this price proposal.' : 'سحب المتجر اقتراح السعر هذا.';
    default:
      return en ? 'This proposal is closed.' : 'أُغلق هذا الاقتراح.';
  }
}

/** Rewrites the customer's Telegram prompt with the outcome and no buttons. Best effort. */
export async function stampCustomerPrompt(env: Env, a: PriceAdjustmentRow, messageText?: string): Promise<void> {
  try {
    if (!a.tg_chat_id || !a.tg_message_id) return;
    const lang = await customerLang(env, a.user_id);
    const body = messageText ?? promptText(a, lang);
    const origin = appOrigin(env);
    const markup = origin
      ? { inline_keyboard: [[{ text: copyFor(lang).open, url: `${origin}${orderPath(a.order_id)}` }]] }
      : { inline_keyboard: [] };
    await editMessageText(env, a.tg_chat_id, a.tg_message_id, `${body}\n\n${outcomeStamp(a, lang)}`.slice(0, 4000), markup);
  } catch (e) {
    console.error('stampCustomerPrompt failed for', a.id, e instanceof Error ? e.message : String(e));
  }
}

/**
 * The admin group hears the decision in the order's own topic, like every
 * other order event. Never throws (`announceToAdmins`).
 */
export async function notifyAdminsOfDecision(env: Env, a: PriceAdjustmentRow): Promise<void> {
  const order = await env.DB.prepare('SELECT shipping_type, due_on_delivery_iqd FROM orders WHERE id = ?')
    .bind(a.order_id)
    .first<{ shipping_type: string; due_on_delivery_iqd: number }>()
    .catch(() => null);
  const via = a.decided_via === 'telegram' ? 'تيليجرام' : a.decided_via === 'web' ? 'الموقع' : a.decided_via;
  const lines =
    a.state === 'approved'
      ? [
          `💰 وافق الزبون على السعر الجديد — ${a.order_id}`,
          `من ${iqdText(a.old_total_iqd, 'ar')} إلى ${iqdText(a.new_total_iqd, 'ar')}`,
          `المستحق عند التسليم: ${iqdText(Number(order?.due_on_delivery_iqd ?? a.new_due_iqd), 'ar')}`,
          ...(a.wallet_refund_iqd > 0 ? [`أُعيد إلى المحفظة: ${iqdText(a.wallet_refund_iqd, 'ar')}`] : []),
          `عبر: ${via}`,
        ]
      : [
          `❌ رفض الزبون السعر الجديد — ${a.order_id}`,
          `بقي الطلب على ${iqdText(a.old_total_iqd, 'ar')} (المقترح ${iqdText(a.new_total_iqd, 'ar')}).`,
          'يمكنك متابعة الطلب بالسعر القديم أو إلغاؤه من لوحة الإدارة.',
          `عبر: ${via}`,
        ];
  const url = orderAdminLink(env, a.order_id);
  await announceToAdmins(
    env,
    orderTopic(order?.shipping_type ?? 'direct'),
    lines.join('\n'),
    url ? { reply_markup: { inline_keyboard: [[{ text: '🔗 فتح في لوحة الإدارة', url }]] } } : {}
  );
}

/**
 * After an approval: the invoice gets a correction revision (issued invoices
 * are never mutated — worker/lib/invoices.ts), so the paper the customer holds
 * and the order agree. Best effort; the approval is already true.
 */
export async function reviseInvoiceAfterApproval(env: Env, a: PriceAdjustmentRow): Promise<void> {
  try {
    const inv = await env.DB.prepare(
      'SELECT id FROM invoices WHERE order_id = ? AND superseded_by IS NULL ORDER BY revision DESC LIMIT 1'
    )
      .bind(a.order_id)
      .first<{ id: string }>();
    if (!inv) return;
    await createInvoiceRevision(env, inv.id, { reason: `Price adjustment approved (${a.id})` }, a.proposed_by);
  } catch (e) {
    console.error('reviseInvoiceAfterApproval failed for', a.id, e instanceof Error ? e.message : String(e));
  }
}

/** Everything that follows a customer's decision. Never throws. */
export async function afterDecision(env: Env, a: PriceAdjustmentRow): Promise<void> {
  if (a.state === 'approved') await reviseInvoiceAfterApproval(env, a);
  await notifyAdminsOfDecision(env, a);
}

// ------------------------------------------------------------------ Telegram

export interface PriceCallback {
  id: string;
  from?: { id?: number };
  data?: string;
  message?: { message_id?: number; chat?: { id?: number; type?: string }; text?: string };
}

export type PriceCallbackOutcome = 'ignored' | 'not_owner' | 'not_found' | 'approved' | 'rejected' | 'already' | 'closed' | 'stale';

/**
 * One press of «موافق على السعر الجديد» / «رفض» in the customer's private chat.
 *
 * SECURITY: the callback data names the PROPOSAL, never the order, so a stale
 * message cannot approve a newer proposal. The presser must be the Telegram
 * account LINKED to the order's customer right now (a live `telegram_links`
 * row) — a forwarded message pressed by anyone else is refused and audited.
 * The decision itself is `decidePriceAdjustment`, replay-safe by state and by
 * its decision token; Telegram's own redelivery is already dropped by the
 * webhook's `telegram_updates` dedup.
 */
export async function handlePriceAdjustCallback(env: Env, cb: PriceCallback): Promise<PriceCallbackOutcome> {
  const parsed = parsePriceCallbackData(cb.data);
  const fromId = typeof cb.from?.id === 'number' && Number.isSafeInteger(cb.from.id) ? cb.from.id : null;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!parsed || fromId === null || typeof chatId !== 'number' || typeof messageId !== 'number') {
    if (cb.id) await answerCallbackQuery(env, cb.id, 'زر غير صالح.', true);
    return 'ignored';
  }
  const a = await loadAdjustment(env.DB, parsed.adjustmentId);
  const owner = a
    ? await env.DB.prepare(
        `SELECT l.user_id FROM telegram_links l JOIN orders o ON o.user_id = l.user_id
          WHERE o.id = ?1 AND l.user_id = ?2 AND l.telegram_user_id = ?3 AND l.revoked_at IS NULL`
      )
        .bind(a.order_id, a.user_id, fromId)
        .first<{ user_id: string }>()
    : null;
  if (!a || !owner) {
    await answerCallbackQuery(env, cb.id, 'هذا الزر لصاحب الطلب فقط. / This button is for the order’s owner only.', true);
    await auditStatements(env.DB, null, 'order.price_adjust.telegram_denied', a?.order_id ?? parsed.adjustmentId, {
      adjustment_id: parsed.adjustmentId,
      telegram_user_id: fromId,
      reason: a ? 'not_owner' : 'not_found',
    })
      .then((x) => env.DB.batch(x.statements))
      .catch(() => undefined);
    return a ? 'not_owner' : 'not_found';
  }
  const lang = await customerLang(env, a.user_id);
  const en = lang === 'en';
  const original = typeof cb.message?.text === 'string' && cb.message.text ? cb.message.text : undefined;

  let res: DecideOutcome;
  try {
    res = await decidePriceAdjustment(env, {
      adjustmentId: a.id,
      decision: parsed.decision,
      actorUserId: a.user_id,
      via: 'telegram',
    });
  } catch (e) {
    if (e instanceof PriceAdjustError && e.code === 'PRICE_ADJUST_STALE') {
      await answerCallbackQuery(env, cb.id, en ? 'The order changed — open it on the site.' : 'تغيّر الطلب — افتحه في الموقع.', true);
      return 'stale';
    }
    throw e;
  }
  const stamped = { ...res.adjustment, tg_chat_id: chatId, tg_message_id: messageId };
  if (res.outcome === 'closed') {
    await answerCallbackQuery(env, cb.id, outcomeStamp(res.adjustment, lang), true);
    await stampCustomerPrompt(env, stamped, original);
    return 'closed';
  }
  await answerCallbackQuery(env, cb.id, outcomeStamp(res.adjustment, lang), false);
  await stampCustomerPrompt(env, stamped, original);
  if (res.replayed) return 'already';
  await afterDecision(env, res.adjustment);
  return res.outcome;
}

