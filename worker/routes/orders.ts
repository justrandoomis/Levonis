import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, str } from '../lib/http';
import { newId, newOrderId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import type { DeliveryMethod, CheckoutPaymentMethod } from '../lib/settings';
import { resolveCartLine, pricingContextFrom } from './cart';
import { getTierStatus, benefits } from '../lib/entitlements';
import {
  referralFreeDeliveryApplies,
  validateCoupon,
  grantPrinterGiftIfEligible,
} from '../lib/membershipOps';
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
  const coupon = safeParse<Record<string, unknown> | null>(o.coupon_snapshot, null);
  return {
    id: o.id,
    status: o.status,
    address: safeParse(o.address_snapshot, {}),
    delivery_method: safeParse(o.delivery_method_snapshot, {}),
    payment_method_id: o.payment_method_id,
    subtotal_iqd: o.subtotal_iqd,
    shipping_iqd: o.shipping_iqd,
    delivery_waived: !!o.delivery_waived,
    membership_tier_snapshot: o.membership_tier_snapshot ?? 'free',
    priority: Number(o.priority) || 0,
    coupon, // {coupon_id, code, discount_iqd} — never includes cost data
    coupon_discount_iqd: coupon ? Number(coupon.discount_iqd) || 0 : 0,
    points_discount_iqd: o.points_discount_iqd,
    wallet_applied_iqd: o.wallet_applied_iqd,
    total_iqd: o.total_iqd,
    due_on_delivery_iqd: o.due_on_delivery_iqd,
    delivered_at: o.delivered_at ?? null,
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
      // Resolver snapshots persisted at checkout time (cost fields stripped
      // before persistence — safe for the buyer to see).
      pricing: safeParse(it.pricing_snapshot, null),
      warranty: safeParse(it.warranty_snapshot, null),
      transport: safeParse(it.transport_snapshot, null),
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

  const settings = await getSettings(c.env.DB, [
    'checkoutDeliveryMethods',
    'checkoutPaymentMethods',
    'exchangeRate',
    'proPricingPolicy',
    'preorderTransportDefaults',
    'printerGiftConfig',
  ]);
  const delivery = (settings.checkoutDeliveryMethods as DeliveryMethod[]).find((m) => m.id === deliveryMethodId);
  if (!delivery) throw badRequest('Please choose a valid delivery method');
  const payment = (settings.checkoutPaymentMethods as CheckoutPaymentMethod[]).find((m) => m.id === paymentMethodId);
  if (!payment) throw badRequest('Please choose a valid payment method');
  const exchangeRate = Number(settings.exchangeRate) || 1400;
  const pricingCtx = pricingContextFrom(settings);

  // Effective tier from the memberships ledger — never the client, never the
  // legacy users.* cache.
  const tierStatus = await getTierStatus(c.env.DB, user.id);

  // Load and price the cart lines server-side.
  let sql = `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id, ci.shipping_method_id,
                    ci.transport_method, ci.warranty_plan_id, p.*
               FROM cart_items ci JOIN products p ON p.id = ci.product_id
              WHERE ci.user_id = ?`;
  const params: unknown[] = [user.id];
  if (itemIds.length > 0) {
    sql += ` AND ci.id IN (${itemIds.map(() => '?').join(',')})`;
    params.push(...itemIds);
  }
  const { results: lines } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  if (lines.length === 0) throw badRequest('Your cart is empty');

  let subtotal = 0;
  const productIds: string[] = [];
  const orderItems: Array<{
    id: string; product_id: string; name: string; image: string; variant: string;
    shipping_method_id: string; qty: number; unit: number; line: number; tracked: boolean;
    pricing_snapshot: string; warranty_snapshot: string | null; transport_snapshot: string | null;
  }> = [];
  for (const row of lines) {
    const displayName = String(row.name_ar || row.name);
    if (row.status !== 'active') throw badRequest(`"${displayName}" is no longer available — please remove it from your cart`);
    const { doc, resolved, variantLabel } = resolveCartLine(
      row,
      {
        optionId: String(row.option_id ?? ''),
        colorId: String(row.color_id ?? ''),
        transportMethod: String(row.transport_method ?? ''),
        warrantyPlanId: String(row.warranty_plan_id ?? ''),
      },
      tierStatus.tier,
      tierStatus.active,
      pricingCtx
    );
    if (resolved.errors.length > 0) {
      throw badRequest(`"${displayName}": ${resolved.errors.join(', ')}`, 'VALIDATION');
    }
    const qty = Number(row.qty);
    if (row.stock !== null && Number(row.stock) < qty) {
      throw badRequest(`Only ${row.stock} of "${displayName}" left in stock`);
    }
    const unit = resolved.unit_subtotal_iqd;
    const line = unit * qty;
    subtotal += line;
    productIds.push(String(row.id));
    // Persisted resolver snapshot: cost fields must NEVER be stored on the
    // order (it is served back to the buyer).
    const { cost_iqd, ...pricingSnapshot } = resolved;
    void cost_iqd;
    orderItems.push({
      id: newId('oi'),
      product_id: String(row.id),
      name: String(row.name),
      image: (doc.media.find((m) => m.primary) ?? doc.media[0])?.url ?? '',
      variant: variantLabel,
      shipping_method_id: String(row.shipping_method_id ?? ''),
      qty,
      unit,
      line,
      tracked: row.stock !== null,
      pricing_snapshot: JSON.stringify(pricingSnapshot),
      warranty_snapshot: resolved.warranty ? JSON.stringify(resolved.warranty) : null,
      transport_snapshot: resolved.transport ? JSON.stringify(resolved.transport) : null,
    });
  }

  // Last-mile delivery: chosen method price, waived to 0 for active PRO
  // (membership benefit) or a qualifying referral free-delivery order.
  const deliveryPrice = Number(delivery.price_iqd) || 0;
  let shipping = deliveryPrice;
  let deliveryWaived = 0;
  if (deliveryPrice > 0 && benefits.freeDelivery(tierStatus)) {
    shipping = 0;
    deliveryWaived = 1;
  } else if (deliveryPrice > 0 && (await referralFreeDeliveryApplies(c.env, user.id, productIds))) {
    shipping = 0;
    deliveryWaived = 1;
  }

  // Coupon — validated against the honest payable total (subtotal + the
  // delivery actually charged); applied FIRST: coupon, then points, then wallet.
  const couponCode = str(body.couponCode, 'couponCode', { max: 60, required: false });
  let couponDiscount = 0;
  let couponId: string | null = null;
  let couponSnapshot: string | null = null;
  if (couponCode) {
    const check = await validateCoupon(c.env, user.id, couponCode, subtotal + shipping);
    if (!check.ok || !check.coupon_id) {
      const reason = check.reason ?? 'COUPON_INVALID';
      throw badRequest(`Coupon could not be applied (${reason})`, reason);
    }
    couponId = check.coupon_id;
    couponDiscount = Math.max(0, Math.min(Math.floor(Number(check.discount_iqd) || 0), subtotal + shipping));
    couponSnapshot = JSON.stringify({
      coupon_id: check.coupon_id,
      code: check.code ?? couponCode.toUpperCase(),
      discount_iqd: couponDiscount,
    });
  }

  const beforeDiscounts = subtotal + shipping - couponDiscount;

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

  const priority = benefits.priorityService(tierStatus) ? 1 : 0;

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
         payment_method_id, subtotal_iqd, shipping_iqd, points_discount_iqd, wallet_applied_iqd,
         wallet_applied_usd_cents, exchange_rate, total_iqd, due_on_delivery_iqd, idempotency_key,
         membership_tier_snapshot, delivery_waived, priority, coupon_snapshot, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(address), deliveryMethodId, JSON.stringify(delivery),
      paymentMethodId, subtotal, shipping, pointsDiscount, walletApplied,
      finalWalletUsdCents, exchangeRate, afterPoints, dueOnDelivery, idempotencyKey,
      tierStatus.active ? tierStatus.tier : 'free', deliveryWaived, priority, couponSnapshot, now, now
    ),
  ];

  if (couponId) {
    // UNIQUE(order_id) makes the redemption idempotent with the order itself.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(newId('crd'), couponId, user.id, orderId, couponDiscount, now)
    );
  }

  for (const it of orderItems) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO order_items (id, order_id, product_id, name_snapshot, image_snapshot, option_snapshot,
           shipping_method_id, qty, unit_price_iqd, line_total_iqd, pricing_snapshot, warranty_snapshot, transport_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.id, orderId, it.product_id, it.name, it.image, it.variant, it.shipping_method_id, it.qty, it.unit, it.line,
        it.pricing_snapshot, it.warranty_snapshot, it.transport_snapshot
      )
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
    coupon_iqd: couponDiscount, tier: tierStatus.active ? tierStatus.tier : 'free', delivery_waived: deliveryWaived,
  });
  // PLUS gift on printer purchase — only when the owner enabled it and set the
  // milestone to the payment event (grant itself is idempotent per order).
  const printerGift = settings.printerGiftConfig as { enabled: boolean; plan_id: string; milestone: 'paid' | 'delivered' };
  if (printerGift?.enabled === true && printerGift.milestone === 'paid') {
    c.executionCtx.waitUntil(grantPrinterGiftIfEligible(c.env, orderId));
  }
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
