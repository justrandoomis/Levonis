import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, str } from '../lib/http';
import { newId, newOrderId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import type { DeliveryMethod, CheckoutPaymentMethod } from '../lib/settings';
import { unitPriceIqd, planIsActive } from './cart';
import { getBalances } from '../lib/wallet';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { notifyAdmins } from '../lib/telegram';

export const orderRoutes = new Hono<AppContext>();
orderRoutes.use('*', requireAuth);

/** IQD -> USD cents, rounded up so the wallet never undercharges. */
function iqdToUsdCents(iqd: number, rate: number): number {
  return Math.ceil((iqd * 100) / rate);
}

export function orderPublic(o: Record<string, unknown>, items: Record<string, unknown>[]) {
  return {
    id: o.id,
    status: o.status,
    address: safeParse(o.address_snapshot, {}),
    delivery_method: safeParse(o.delivery_method_snapshot, {}),
    payment_method_id: o.payment_method_id,
    subtotal_iqd: o.subtotal_iqd,
    shipping_iqd: o.shipping_iqd,
    points_discount_iqd: o.points_discount_iqd,
    wallet_applied_iqd: o.wallet_applied_iqd,
    total_iqd: o.total_iqd,
    due_on_delivery_iqd: o.due_on_delivery_iqd,
    created_at: o.created_at,
    updated_at: o.updated_at,
    items: items.map((it) => ({
      id: it.id,
      product_id: it.product_id,
      name: it.name_snapshot,
      image: it.image_snapshot,
      variant: it.option_snapshot,
      qty: it.qty,
      unit_price_iqd: it.unit_price_iqd,
      line_total_iqd: it.line_total_iqd,
    })),
  };
}

async function loadOrder(db: D1Database, orderId: string) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, unknown>>();
  if (!order) return null;
  const { results: items } = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).all();
  return { order, items };
}

orderRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  let sql = 'SELECT * FROM orders WHERE user_id = ?';
  const params: unknown[] = [user.id];
  if (status && status !== 'All' && status !== 'null') {
    sql += ' AND status = ?';
    params.push(status.toLowerCase());
  }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  const { results: orders } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  const out = [];
  for (const o of orders) {
    const { results: items } = await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?')
      .bind(o.id)
      .all();
    out.push(orderPublic(o, items));
  }
  return c.json({ success: true, orders: out });
});

orderRoutes.get('/counts', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM orders WHERE user_id = ? GROUP BY status'
  )
    .bind(user.id)
    .all<{ status: string; n: number }>();
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = r.n;
  return c.json({ success: true, counts });
});

orderRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const data = await loadOrder(c.env.DB, c.req.param('id'));
  if (!data || (data.order.user_id !== user.id && user.role !== 'admin')) throw notFound('Order not found');
  return c.json({ success: true, order: orderPublic(data.order, data.items) });
});

orderRoutes.post('/', async (c) => {
  await rateLimit(c, 'checkout', 15, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const addressId = str(body.addressId, 'addressId', { min: 1, max: 60 });
  const deliveryMethodId = str(body.deliveryMethodId, 'deliveryMethodId', { min: 1, max: 60 });
  const paymentMethodId = str(body.paymentMethodId, 'paymentMethodId', { min: 1, max: 60 });
  const useWallet = body.useWallet === true;
  const usePoints = body.usePoints === true;
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const itemIds: string[] = Array.isArray(body.itemIds) ? body.itemIds.map(String).slice(0, 100) : [];

  // Idempotent replay: return the already-created order.
  const existing = await c.env.DB.prepare('SELECT id FROM orders WHERE idempotency_key = ? AND user_id = ?')
    .bind(idempotencyKey, user.id)
    .first<{ id: string }>();
  if (existing) {
    const data = (await loadOrder(c.env.DB, existing.id))!;
    return c.json({ success: true, order: orderPublic(data.order, data.items), replay: true });
  }

  const address = await c.env.DB.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
    .bind(addressId, user.id)
    .first<Record<string, unknown>>();
  if (!address) throw badRequest('Please choose a valid delivery address');

  const settings = await getSettings(c.env.DB, ['checkoutDeliveryMethods', 'checkoutPaymentMethods', 'exchangeRate']);
  const delivery = (settings.checkoutDeliveryMethods as DeliveryMethod[]).find((m) => m.id === deliveryMethodId);
  if (!delivery) throw badRequest('Please choose a valid delivery method');
  const payment = (settings.checkoutPaymentMethods as CheckoutPaymentMethod[]).find((m) => m.id === paymentMethodId);
  if (!payment) throw badRequest('Please choose a valid payment method');
  const exchangeRate = Number(settings.exchangeRate) || 1400;

  // Load and price the cart lines server-side.
  let sql = `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id, ci.shipping_method_id, p.*
               FROM cart_items ci JOIN products p ON p.id = ci.product_id
              WHERE ci.user_id = ?`;
  const params: unknown[] = [user.id];
  if (itemIds.length > 0) {
    sql += ` AND ci.id IN (${itemIds.map(() => '?').join(',')})`;
    params.push(...itemIds);
  }
  const { results: lines } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  if (lines.length === 0) throw badRequest('Your cart is empty');

  const active = planIsActive(user.subscription_plan, user.subscription_expiry);
  let subtotal = 0;
  const orderItems: Array<{
    id: string; product_id: string; name: string; image: string; variant: string;
    shipping_method_id: string; qty: number; unit: number; line: number; tracked: boolean;
  }> = [];
  for (const row of lines) {
    if (row.status !== 'active') throw badRequest(`"${row.name}" is no longer available — please remove it from your cart`);
    const priced = unitPriceIqd(
      row as never,
      String(row.option_id ?? ''),
      String(row.color_id ?? ''),
      String(row.shipping_method_id ?? ''),
      user.subscription_plan,
      active
    );
    const qty = Number(row.qty);
    if (row.stock !== null && Number(row.stock) < qty) {
      throw badRequest(`Only ${row.stock} of "${row.name}" left in stock`);
    }
    const line = priced.price * qty;
    subtotal += line;
    orderItems.push({
      id: newId('oi'),
      product_id: String(row.id),
      name: String(row.name),
      image: safeParse<string[]>(row.images, [])[0] ?? '',
      variant: priced.label,
      shipping_method_id: String(row.shipping_method_id ?? ''),
      qty,
      unit: priced.price,
      line,
      tracked: row.stock !== null,
    });
  }

  const shipping = Number(delivery.price_iqd) || 0;
  const beforeDiscounts = subtotal + shipping;

  const balances = await getBalances(c.env.DB, user.id);
  const walletBalanceIqd = Math.floor((balances.usd_cents * exchangeRate) / 100);

  // Points: 1 point = 1 IQD, applied before the wallet.
  let pointsDiscount = 0;
  if (usePoints && balances.points > 0) {
    pointsDiscount = Math.min(balances.points, beforeDiscounts);
  }
  const afterPoints = beforeDiscounts - pointsDiscount;

  // Advance-payment requirements are paid from the wallet.
  let requiredAdvance = 0;
  if (paymentMethodId === 'half_advance') requiredAdvance = Math.ceil(afterPoints / 2);
  if (paymentMethodId === 'full_advance' || paymentMethodId === 'wallet') requiredAdvance = afterPoints;

  let walletApplied = 0;
  if (requiredAdvance > 0 || useWallet) {
    walletApplied = Math.min(walletBalanceIqd, afterPoints);
  }
  if (walletApplied < requiredAdvance) {
    throw badRequest('Insufficient wallet balance for the required advance payment', 'INSUFFICIENT_BALANCE');
  }
  const walletUsdCents = walletApplied > 0 ? iqdToUsdCents(walletApplied, exchangeRate) : 0;
  if (walletUsdCents > balances.usd_cents) {
    // Rounding pushed us past the balance; scale back to what the balance covers.
    walletApplied = Math.floor((balances.usd_cents * exchangeRate) / 100);
    if (walletApplied < requiredAdvance) throw badRequest('Insufficient wallet balance', 'INSUFFICIENT_BALANCE');
  }
  const finalWalletUsdCents = walletApplied > 0 ? Math.min(iqdToUsdCents(walletApplied, exchangeRate), balances.usd_cents) : 0;
  const dueOnDelivery = afterPoints - walletApplied;

  const orderId = newOrderId();
  const now = new Date().toISOString();

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, points_discount_iqd, wallet_applied_iqd,
         wallet_applied_usd_cents, exchange_rate, total_iqd, due_on_delivery_iqd, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(address), deliveryMethodId, JSON.stringify(delivery),
      paymentMethodId, subtotal, shipping, pointsDiscount, walletApplied,
      finalWalletUsdCents, exchangeRate, afterPoints, dueOnDelivery, idempotencyKey, now, now
    ),
  ];

  for (const it of orderItems) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, name_snapshot, image_snapshot, option_snapshot,
           shipping_method_id, qty, unit_price_iqd, line_total_iqd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(it.id, orderId, it.product_id, it.name, it.image, it.variant, it.shipping_method_id, it.qty, it.unit, it.line)
    );
    if (it.tracked) {
      // CHECK (stock >= 0) aborts the whole batch on oversell.
      stmts.push(
        c.env.DB.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(it.qty, it.product_id)
      );
    }
  }

  if (pointsDiscount > 0) {
    // Conditional amount: goes negative (violating CHECK amount > 0) when the
    // live balance no longer covers it, aborting the batch atomically.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'POINT',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='POINT' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(newId('wtx'), user.id, pointsDiscount, `Points used on order ${orderId}`, orderId, now)
    );
  }
  if (finalWalletUsdCents > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'USD',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id = ?2 AND currency='USD' AND status='approved') >= ?3
                THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      ).bind(newId('wtx'), user.id, finalWalletUsdCents, `Wallet payment on order ${orderId}`, orderId, now)
    );
  }

  // Remove the purchased lines from the cart.
  for (const row of lines) {
    stmts.push(c.env.DB.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').bind(row.cart_item_id, user.id));
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('idempotency_key')) {
      const data = await loadOrder(c.env.DB, orderId);
      const replay = await c.env.DB.prepare('SELECT id FROM orders WHERE idempotency_key = ? AND user_id = ?')
        .bind(idempotencyKey, user.id)
        .first<{ id: string }>();
      if (replay) {
        const d = (await loadOrder(c.env.DB, replay.id))!;
        return c.json({ success: true, order: orderPublic(d.order, d.items), replay: true });
      }
      void data;
    }
    if (msg.includes('CHECK')) {
      throw badRequest('Order could not be placed: a balance or stock level changed. Please review your cart and try again.', 'CONFLICT_RETRY');
    }
    console.error('Order batch failed', msg);
    throw badRequest('Order could not be placed. Please try again.');
  }

  await audit(c.env.DB, user.id, 'order.create', orderId, {
    total_iqd: afterPoints, wallet_applied_iqd: walletApplied, points: pointsDiscount, payment: paymentMethodId,
  });
  c.executionCtx.waitUntil(
    notifyAdmins(
      c.env,
      `🛒 New order ${orderId}\nCustomer: ${user.username || user.email}\nItems: ${orderItems.length}\nTotal: ${afterPoints.toLocaleString()} IQD (${paymentMethodId})\nDue on delivery: ${dueOnDelivery.toLocaleString()} IQD`
    )
  );
  const data = (await loadOrder(c.env.DB, orderId))!;
  return c.json({ success: true, order: orderPublic(data.order, data.items) });
});

orderRoutes.post('/:id/cancel', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const data = await loadOrder(c.env.DB, id);
  if (!data || data.order.user_id !== user.id) throw notFound('Order not found');
  if (data.order.status !== 'pending') {
    throw badRequest('Only pending orders can be cancelled — please contact support');
  }

  // Flip the status first with a conditional UPDATE so concurrent cancel
  // requests cannot both proceed to the refund step.
  const flip = await c.env.DB.prepare(
    `UPDATE orders SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'pending'`
  )
    .bind(id)
    .run();
  if (flip.meta.changes === 0) throw badRequest('This order was already cancelled or has progressed');

  const stmts = [];
  // Restore tracked stock.
  for (const it of data.items) {
    if (it.product_id) {
      stmts.push(
        c.env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').bind(it.qty, it.product_id)
      );
    }
  }
  // Refund wallet and points that were applied. Deterministic transaction ids
  // make the refund idempotent if this step ever has to be re-run.
  const walletCents = Number(data.order.wallet_applied_usd_cents) || 0;
  if (walletCents > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(`wtx_refund_${id}_usd`, user.id, walletCents, `Refund for cancelled order ${id}`, id)
    );
  }
  const points = Number(data.order.points_discount_iqd) || 0;
  if (points > 0) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(`wtx_refund_${id}_pts`, user.id, points, `Points refund for cancelled order ${id}`, id)
    );
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  await audit(c.env.DB, user.id, 'order.cancel', id, { refund_usd_cents: walletCents, refund_points: points });
  const after = (await loadOrder(c.env.DB, id))!;
  return c.json({ success: true, order: orderPublic(after.order, after.items) });
});
