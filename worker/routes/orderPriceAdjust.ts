/**
 * «تعديل السعر النهائي» — the HTTP doors of worker/lib/orderPriceAdjust.ts.
 *
 * ADMIN (mounted at /api/admin/orders, gateway row `/api/admin/orders`):
 *   GET  /:id/price-adjustment                  the proposal state for the modal
 *   POST /:id/price-adjustment                  propose (FINANCIAL scope — it
 *                                               changes what the customer pays
 *                                               and may refund their wallet)
 *   POST /:id/price-adjustment/:pid/withdraw    withdraw (any admin: it moves no
 *                                               money, it only releases the hold
 *                                               back to the price already agreed)
 *
 * CUSTOMER (mounted at /api/orders, their own order only — 404 otherwise):
 *   GET  /:id/price-adjustment                  the open proposal, if any
 *   POST /:id/price-adjustment/:pid/approve
 *   POST /:id/price-adjustment/:pid/reject
 *
 * The proposal id is in the path of every decision, so a screen that shows one
 * proposal can never approve a different one (a withdraw-and-repropose between
 * the render and the tap answers PRICE_ADJUST_NOT_PENDING instead).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, notFound, requireAdmin, requireAuth, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { canViewFinancials } from '../lib/adminScope';
import { requireFinancialScope } from '../lib/walletAdjust';
import { processOutbox } from '../lib/outbox';
import {
  PriceAdjustError,
  afterDecision,
  decidePriceAdjustment,
  listAdjustments,
  loadAdjustment,
  notifyCustomerOfProposal,
  planFor,
  priceAdjustBlocker,
  proposePriceAdjustment,
  publicAdjustment,
  stampCustomerPrompt,
  withdrawPriceAdjustment,
} from '../lib/orderPriceAdjust';
import { PRICE_ADJUST_MAX_IQD } from '@levonis/pricing/priceAdjustment';

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const ADJ_ID_RE = /^padj_[0-9a-f]{24}$/;

function toHttp(e: unknown): never {
  if (e instanceof PriceAdjustError) throw new HttpError(e.status, e.message, e.code, e.details);
  throw e;
}

/** Runs after the response; never lets a notification fail the request. */
function afterResponse(c: Context<AppContext>, work: Promise<unknown>): void {
  const safe = work.catch((e) => console.error('price adjustment follow-up failed', e instanceof Error ? e.message : String(e)));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No ExecutionContext (a test harness): the promise is already running.
  }
}

function orderIdOf(c: Context<AppContext>): string {
  const id = c.req.param('id') ?? '';
  if (!ORDER_ID_RE.test(id)) throw notFound('Order not found');
  return id;
}
function adjustmentIdOf(c: Context<AppContext>): string {
  const id = c.req.param('pid') ?? '';
  if (!ADJ_ID_RE.test(id)) throw notFound('Price proposal not found');
  return id;
}

// =========================================================================
//  ADMIN
// =========================================================================

export const adminOrderPriceRoutes = new Hono<AppContext>();
adminOrderPriceRoutes.use('/:id/price-adjustment', requireAdmin);
adminOrderPriceRoutes.use('/:id/price-adjustment/*', requireAdmin);

adminOrderPriceRoutes.get('/:id/price-adjustment', async (c) => {
  const id = orderIdOf(c);
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  const history = await listAdjustments(c.env.DB, id);
  const pending = history.find((a) => a.state === 'pending') ?? null;
  const blocker = priceAdjustBlocker(order);
  // A payment the plan refuses (BNPL / Gini) is known before anyone types a
  // figure: ask the planner with a total that cannot collide with the current one.
  const probe = planFor(order, Math.min(PRICE_ADJUST_MAX_IQD, (Number(order.total_iqd) || 0) + 1));
  const paymentBlocker = probe.ok ? null : probe.code === 'PRICE_ADJUST_FINANCED' || probe.code === 'PRICE_ADJUST_UNSUPPORTED_PAYMENT' ? probe.code : null;
  const financial = canViewFinancials(c.env, c.get('user'));
  return c.json({
    success: true,
    order: {
      id,
      total_iqd: Number(order.total_iqd) || 0,
      due_on_delivery_iqd: Number(order.due_on_delivery_iqd) || 0,
      wallet_applied_iqd: Number(order.wallet_applied_iqd) || 0,
      payment_method_id: String(order.payment_method_id ?? ''),
      price_adjustment_iqd: Math.trunc(Number(order.price_adjustment_iqd) || 0),
    },
    /** Why a new proposal cannot be made now (null when it can). */
    blocker: blocker ?? paymentBlocker,
    /** Proposing needs the financial scope; withdrawing does not. */
    can_propose: financial && !blocker && !paymentBlocker,
    financial_scope: financial,
    pending: pending ? publicAdjustment(pending) : null,
    history: history.map(publicAdjustment),
  });
});

adminOrderPriceRoutes.post('/:id/price-adjustment', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-price-adjust', 60, 3600);
  const id = orderIdOf(c);
  const body = await c.req.json().catch(() => ({}));
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const reason = str(body.reason, 'reason', { min: 3, max: 500 });
  const note = str(body.note, 'note', { max: 1000, required: false });
  const raw = body.new_total_iqd;
  // Integer dinars, never a float and never a string that parses to one.
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0 || raw > PRICE_ADJUST_MAX_IQD) {
    throw new HttpError(400, 'The new total must be a whole number of dinars above zero.', 'PRICE_ADJUST_INVALID_TOTAL');
  }
  let res;
  try {
    res = await proposePriceAdjustment(c.env, {
      orderId: id,
      adminId: admin.id,
      newTotalIqd: raw,
      reason,
      note,
      idempotencyKey,
    });
  } catch (e) {
    toHttp(e);
  }
  if (!res.replayed) {
    const a = res.adjustment;
    afterResponse(
      c,
      notifyCustomerOfProposal(c.env, a).then(() =>
        processOutbox(c.env, 5, { eventKeyPrefix: `order.price_adjust:${a.id}:` })
      )
    );
  }
  return c.json({ success: true, replayed: res.replayed, adjustment: publicAdjustment(res.adjustment) }, res.replayed ? 200 : 201);
});

adminOrderPriceRoutes.post('/:id/price-adjustment/:pid/withdraw', async (c) => {
  const admin = c.get('user')!;
  const id = orderIdOf(c);
  const pid = adjustmentIdOf(c);
  let res;
  try {
    res = await withdrawPriceAdjustment(c.env, { orderId: id, adjustmentId: pid, adminId: admin.id });
  } catch (e) {
    toHttp(e);
  }
  if (!res.replayed) afterResponse(c, stampCustomerPrompt(c.env, res.adjustment));
  return c.json({ success: true, replayed: res.replayed, adjustment: publicAdjustment(res.adjustment) });
});

// =========================================================================
//  CUSTOMER
// =========================================================================

export const orderPriceRoutes = new Hono<AppContext>();
orderPriceRoutes.use('/:id/price-adjustment', requireAuth);
orderPriceRoutes.use('/:id/price-adjustment/*', requireAuth);

async function ownOrder(c: Context<AppContext>): Promise<Record<string, unknown>> {
  const user = c.get('user')!;
  const id = orderIdOf(c);
  const order = await c.env.DB.prepare('SELECT id, user_id, price_hold_id FROM orders WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  // Someone else's order is "not found", never "forbidden".
  if (!order || String(order.user_id) !== user.id) throw notFound('Order not found');
  return order;
}

orderPriceRoutes.get('/:id/price-adjustment', async (c) => {
  const order = await ownOrder(c);
  const hold = typeof order.price_hold_id === 'string' ? order.price_hold_id : '';
  const a = hold ? await loadAdjustment(c.env.DB, hold) : null;
  return c.json({ success: true, pending: a && a.state === 'pending' ? publicAdjustment(a) : null });
});

for (const decision of ['approve', 'reject'] as const) {
  orderPriceRoutes.post(`/:id/price-adjustment/:pid/${decision}`, async (c) => {
    const user = c.get('user')!;
    await rateLimit(c, 'order-price-decision', 30, 3600);
    const order = await ownOrder(c);
    const pid = adjustmentIdOf(c);
    const a = await loadAdjustment(c.env.DB, pid);
    if (!a || a.order_id !== String(order.id)) throw notFound('Price proposal not found');
    let res;
    try {
      res = await decidePriceAdjustment(c.env, { adjustmentId: pid, decision, actorUserId: user.id, via: 'web' });
    } catch (e) {
      toHttp(e);
    }
    if (res.outcome === 'closed') {
      throw new HttpError(409, 'This price proposal was already decided or withdrawn.', 'PRICE_ADJUST_NOT_PENDING', {
        state: res.adjustment.state,
      });
    }
    if (!res.replayed) {
      const decided = res.adjustment;
      afterResponse(c, Promise.all([stampCustomerPrompt(c.env, decided), afterDecision(c.env, decided)]));
    }
    return c.json({ success: true, outcome: res.outcome, replayed: res.replayed, adjustment: publicAdjustment(res.adjustment) });
  });
}
