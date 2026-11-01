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
 *
 * «تأكيد السعر النهائي» — ESTIMATED PRICES (migration 0218; docs/SMART_PRICING.md
 * §6.5; worker/lib/orderEstimates.ts), on the same admin router:
 *   GET  /:id/price-estimate            each estimated line: name, qty, the price
 *                                       it was sold at, the SKU × channel's price
 *                                       today and its state — customer prices
 *                                       only, so any admin may read it
 *   POST /:id/price-estimate/confirm    settle every open / rejected line at its
 *                                       final price (FINANCIAL scope: a different
 *                                       total becomes a 0140 proposal)
 * Every proposal answer carries `reason_code`, and an estimate proposal its
 * per-line old → new `lines` (customer prices), for the customer's card and
 * the admin's panel alike.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, notFound, requireAdmin, requireAuth, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { canMoveMoney } from '../lib/adminScope';
import { requireFinancialScope } from '../lib/walletAdjust';
import { processOutbox } from '../lib/outbox';
import {
  PriceAdjustError,
  adjustmentEstimateLines,
  afterDecision,
  decidePriceAdjustment,
  isEstimateProposal,
  listAdjustments,
  loadAdjustment,
  notifyCustomerOfProposal,
  planFor,
  priceAdjustBlocker,
  proposePriceAdjustment,
  publicAdjustment,
  stampCustomerPrompt,
  withdrawPriceAdjustment,
  type PriceAdjustmentRow,
} from '../lib/orderPriceAdjust';
import {
  confirmEstimateFinalPrices,
  currentUnitPrices,
  estimateLineView,
  isUnsettledEstimateState,
  orderEstimateRows,
  type EstimateFinalLine,
} from '../lib/orderEstimates';
import { hasOpenEstimates } from '../lib/priceEstimateGate';
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
adminOrderPriceRoutes.use('/:id/price-estimate', requireAdmin);
adminOrderPriceRoutes.use('/:id/price-estimate/*', requireAdmin);

/** The estimate proposals' lines, read only when the list holds one (one indexed read). */
async function linesFor(c: Context<AppContext>, orderId: string, list: ReadonlyArray<PriceAdjustmentRow | null>) {
  return list.some((a) => a && isEstimateProposal(a)) ? adjustmentEstimateLines(c.env.DB, orderId) : undefined;
}

/**
 * Does this order still hold estimated lines open (migration 0218)? For a
 * screen's verdict only — the proposal itself asks again and fails closed —
 * so an unreadable answer is logged and read as "no".
 */
async function estimateOpen(c: Context<AppContext>, orderId: string): Promise<boolean> {
  try {
    return await hasOpenEstimates(c.env.DB, orderId);
  } catch (e) {
    console.error('estimate state unreadable', orderId, e instanceof Error ? e.message : String(e));
    return false;
  }
}

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
  // Estimated lines still open (0218): the panel shows «تأكيد السعر النهائي» instead of a free proposal.
  const estimate = await estimateOpen(c, id);
  const estimateBlocker = estimate ? ('PRICE_ESTIMATE_OPEN' as const) : null;
  const financial = canMoveMoney(c.env, c.get('user'));
  const lines = await linesFor(c, id, history);
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
    blocker: blocker ?? paymentBlocker ?? estimateBlocker,
    /** Proposing needs the financial scope; withdrawing does not. */
    can_propose: financial && !blocker && !paymentBlocker && !estimateBlocker,
    financial_scope: financial,
    /** Estimated lines wait for their final price: the estimate panel (`/price-estimate`) settles them. */
    estimate_open: estimate,
    pending: pending ? publicAdjustment(pending, lines) : null,
    history: history.map((a) => publicAdjustment(a, lines)),
  });
});

/**
 * The order's estimated lines for the confirm panel (§6.5, §7): the price each
 * was sold at, the SKU × channel's published price today and the state. Every
 * figure is a customer price — never a cost — so any admin may read it; only
 * a financial admin may act (`can_confirm`).
 */
adminOrderPriceRoutes.get('/:id/price-estimate', async (c) => {
  const id = orderIdOf(c);
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  const rows = await orderEstimateRows(c.env.DB, id);
  const current = await currentUnitPrices(c.env.DB, rows);
  const held = typeof order.price_hold_id === 'string' && order.price_hold_id !== '';
  const pending = held ? await loadAdjustment(c.env.DB, String(order.price_hold_id)) : null;
  const lines = pending ? await linesFor(c, id, [pending]) : undefined;
  const waiting = rows.filter((r) => r.state === 'open' || r.state === 'rejected');
  const financial = canMoveMoney(c.env, c.get('user'));
  return c.json({
    success: true,
    order: {
      id,
      status: String(order.status ?? ''),
      stage: String(order.stage ?? 'received'),
      total_iqd: Number(order.total_iqd) || 0,
      due_on_delivery_iqd: Number(order.due_on_delivery_iqd) || 0,
      wallet_applied_iqd: Number(order.wallet_applied_iqd) || 0,
      payment_method_id: String(order.payment_method_id ?? ''),
      price_hold_id: held ? String(order.price_hold_id) : null,
    },
    lines: rows.map((r) => estimateLineView(r, current.get(r.order_item_id) ?? null)),
    /** Lines that still hold the order at «تم الاستلام» (open, proposed or rejected). */
    unsettled: rows.filter((r) => isUnsettledEstimateState(r.state)).length,
    /** The estimate proposal waiting on the customer, if any. */
    pending: pending && pending.state === 'pending' ? publicAdjustment(pending, lines) : null,
    financial_scope: financial,
    /** Settling needs the financial scope, an open or rejected line, and no proposal waiting. */
    can_confirm: financial && waiting.length > 0 && !held,
  });
});

/** The confirm body's lines: each an order item id and a whole-dinar final unit price. */
function finalLinesOf(raw: unknown): EstimateFinalLine[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 250) {
    throw new HttpError(400, 'Name every estimated line with its final unit price.', 'VALIDATION');
  }
  return raw.map((l) => {
    const r = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const itemId = str(r.order_item_id, 'order_item_id', { min: 1, max: 80 });
    const fin = r.final_unit_iqd;
    // Integer dinars, never a float and never a string that parses to one.
    if (typeof fin !== 'number' || !Number.isSafeInteger(fin) || fin <= 0 || fin > PRICE_ADJUST_MAX_IQD) {
      throw new HttpError(400, 'A final unit price must be a whole number of dinars above zero.', 'PRICE_ADJUST_INVALID_TOTAL', { order_item_id: itemId });
    }
    return { order_item_id: itemId, final_unit_iqd: fin };
  });
}

adminOrderPriceRoutes.post('/:id/price-estimate/confirm', requireFinancialScope, async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'admin-price-adjust', 60, 3600);
  const id = orderIdOf(c);
  const body = await c.req.json().catch(() => ({}));
  const idempotencyKey = str(body.idempotency_key ?? body.idempotencyKey, 'idempotency_key', { min: 8, max: 80 });
  const lines = finalLinesOf(body.lines);
  const rawTotal = body.new_total_iqd;
  if (rawTotal !== undefined && rawTotal !== null && (typeof rawTotal !== 'number' || !Number.isSafeInteger(rawTotal) || rawTotal <= 0 || rawTotal > PRICE_ADJUST_MAX_IQD)) {
    throw new HttpError(400, 'The new total must be a whole number of dinars above zero.', 'PRICE_ADJUST_INVALID_TOTAL');
  }
  const note = str(body.note, 'note', { max: 300, required: false });
  let res;
  try {
    res = await confirmEstimateFinalPrices(c.env, {
      orderId: id,
      adminId: admin.id,
      idempotencyKey,
      lines,
      newTotalIqd: typeof rawTotal === 'number' ? rawTotal : null,
      note,
    });
  } catch (e) {
    toHttp(e);
  }
  const view = res.lines.map((r) => estimateLineView(r));
  if (res.outcome === 'proposed') {
    const a = res.adjustment;
    if (!res.replayed) {
      // The same follow-up as an ordinary proposal: email, WhatsApp and Telegram with the two buttons.
      afterResponse(
        c,
        notifyCustomerOfProposal(c.env, a).then(() => processOutbox(c.env, 5, { eventKeyPrefix: `order.price_adjust:${a.id}:` }))
      );
    }
    const adjLines = await adjustmentEstimateLines(c.env.DB, id);
    return c.json({ success: true, outcome: 'proposed', replayed: res.replayed, adjustment: publicAdjustment(a, adjLines), lines: view }, res.replayed ? 200 : 201);
  }
  return c.json({ success: true, outcome: 'confirmed', replayed: res.replayed, lines: view });
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
  // An estimate proposal carries its reason code and per-line old → new rows (customer prices only).
  const lines = a && a.state === 'pending' ? await linesFor(c, String(order.id), [a]) : undefined;
  return c.json({ success: true, pending: a && a.state === 'pending' ? publicAdjustment(a, lines) : null });
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
    const lines = await linesFor(c, String(order.id), [res.adjustment]);
    return c.json({ success: true, outcome: res.outcome, replayed: res.replayed, adjustment: publicAdjustment(res.adjustment, lines) });
  });
}
