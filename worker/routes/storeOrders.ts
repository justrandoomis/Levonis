/**
 * Checkout and orders for merchant STORE PRODUCTS — /api/store-orders/*.
 *
 * The second of the two merchant commerce paths (§74). The other is the
 * request → offer → escrow path in marketplace.ts. Both belong to the
 * merchant; they are different origins and are recorded as such
 * (`orders.origin`), so a merchant can see them in one list and still tell
 * them apart.
 *
 * WHY NOT THE PLATFORM CHECKOUT. `worker/routes/orders.ts` resolves
 * membership pricing tiers, transport methods, warranty plans, points
 * accrual, support-gift eligibility and Levonis inventory. None of that
 * applies to a merchant's own goods: a merchant sets one price, ships it
 * their own way, and Levonis takes a commission. Threading a second product
 * source through that resolver would make the platform path harder to read in
 * order to serve a path that needs almost none of it. The two share what
 * genuinely is shared — the `orders` table, the wallet, idempotency, the
 * address book — and diverge where they genuinely differ.
 *
 * MONEY. A store sale is not escrowed the way custom work is: the goods
 * exist, and the customer is buying rather than commissioning. The merchant's
 * share is written to the payout ledger as `pending` when the order is placed
 * and becomes `available` when it completes (§77) — so a merchant can see
 * what is coming without being able to spend it before the customer has the
 * goods.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, conflict, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { feeFor } from '../lib/merchantOps';
import { exchangeRate, iqdToUsdCents } from '../lib/escrowOps';
import { createPurchaseHold, commitHold } from '../lib/walletOps';

export const storeOrderRoutes = new Hono<AppContext>();
storeOrderRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

interface PricedLine {
  cart_item_id: string;
  product_id: string;
  name: string;
  image: string;
  qty: number;
  unit_price_iqd: number;
  line_total_iqd: number;
  option_id: string;
  color_id: string;
}

interface PricedCart {
  merchant_id: string;
  store_id: string;
  store_name: string;
  store_slug: string;
  lines: PricedLine[];
  subtotal_iqd: number;
  delivery_iqd: number;
  coupon_code: string;
  coupon_id: string | null;
  discount_iqd: number;
  total_iqd: number;
}

/**
 * A merchant coupon, validated against THIS store's own codes.
 *
 * Only consulted when the customer actually typed a code: an empty code is a
 * normal cart, never an error. A code that does not apply is a 400 with the
 * reason — a discount silently not applied is worse than a refusal.
 */
async function resolveCoupon(
  db: D1Database,
  storeId: string,
  rawCode: string,
  subtotal: number
): Promise<{ id: string; code: string; discount: number } | null> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  const cp = await db.prepare(
    'SELECT * FROM merchant_coupons WHERE store_id = ? AND code = ?'
  ).bind(storeId, code).first<Record<string, unknown>>();

  const fail = (why: string) => badRequest('This code cannot be used', 'COUPON_INVALID', { reason: why });
  if (!cp || !cp.active) throw fail('unknown_or_inactive');
  const now = Date.now();
  if (cp.starts_at && now < new Date(String(cp.starts_at)).getTime()) throw fail('not_started');
  if (cp.ends_at && now > new Date(String(cp.ends_at)).getTime()) throw fail('expired');
  if (cp.max_uses !== null && Number(cp.used_count) >= Number(cp.max_uses)) throw fail('exhausted');
  if (subtotal < Number(cp.min_total_iqd)) throw fail('below_minimum');

  const discount = cp.kind === 'percent'
    ? Math.floor((subtotal * Number(cp.value)) / 100)
    : Math.min(Number(cp.value), subtotal);
  if (discount <= 0) return null;
  return { id: String(cp.id), code, discount };
}

/**
 * Prices the merchant cart from the DATABASE, refusing anything that cannot
 * actually be sold right now.
 *
 * Every number here is read server-side (§17). A client that posts prices,
 * totals or a delivery fee is ignored entirely — those fields are not read.
 */
async function priceMerchantCart(c: Context<AppContext>, couponCode = ''): Promise<PricedCart> {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id,
            p.id, p.name, p.images, p.price_iqd, p.stock, p.track_stock, p.lifecycle, p.status,
            s.id AS store_id, s.slug AS store_slug, s.name AS store_name,
            s.status AS store_status, s.delivery_settings,
            m.id AS merchant_id, m.status AS merchant_status
       FROM cart_items ci
       JOIN community_products p ON p.id = ci.community_product_id
       JOIN merchant_stores s ON s.id = ci.store_id
       JOIN community_merchants m ON m.id = ci.merchant_id
      WHERE ci.user_id = ? AND ci.seller_type = 'merchant'
      ORDER BY ci.created_at`
  ).bind(user.id).all<Record<string, unknown>>();

  if (!results.length) throw badRequest('Your cart is empty', 'CART_EMPTY');

  const first = results[0];
  if (first.store_status !== 'active' || first.merchant_status === 'suspended') {
    throw conflict('This store is not taking orders right now');
  }

  const lines: PricedLine[] = [];
  let subtotal = 0;
  for (const r of results) {
    // Availability is re-checked at checkout, not trusted from when the item
    // was added. A product hidden or sold out in between must stop the order
    // rather than create one the merchant cannot fulfil.
    if (r.lifecycle !== 'active' || r.status !== 'active') {
      throw conflict(`"${r.name}" is no longer available`);
    }
    const qty = Number(r.qty) || 1;
    if (r.track_stock && Number(r.stock) < qty) {
      throw conflict(`"${r.name}" does not have ${qty} in stock`);
    }
    const unit = Number(r.price_iqd) || 0;
    const line = unit * qty;
    subtotal += line;
    lines.push({
      cart_item_id: String(r.cart_item_id),
      product_id: String(r.id),
      name: String(r.name),
      image: (safeParse<string[]>(r.images, [])[0] ?? ''),
      qty,
      unit_price_iqd: unit,
      line_total_iqd: line,
      option_id: String(r.option_id ?? ''),
      color_id: String(r.color_id ?? ''),
    });
  }

  // The merchant's own delivery fee, from their store settings. Absent means
  // free — never an invented number.
  const settings = safeParse<Record<string, unknown>>(first.delivery_settings, {});
  const rawFee = Number(settings.fee_iqd);
  const freeOver = Number(settings.free_over_iqd);
  let delivery = Number.isFinite(rawFee) && rawFee > 0 ? Math.floor(rawFee) : 0;
  if (Number.isFinite(freeOver) && freeOver > 0 && subtotal >= freeOver) delivery = 0;

  const coupon = await resolveCoupon(c.env.DB, String(first.store_id), couponCode, subtotal);
  const discount = coupon?.discount ?? 0;

  return {
    merchant_id: String(first.merchant_id),
    store_id: String(first.store_id),
    store_name: String(first.store_name),
    store_slug: String(first.store_slug),
    lines,
    subtotal_iqd: subtotal,
    delivery_iqd: delivery,
    coupon_code: coupon?.code ?? '',
    coupon_id: coupon?.id ?? null,
    discount_iqd: discount,
    total_iqd: subtotal - discount + delivery,
  };
}

/** What the order will cost, before committing to it. */
storeOrderRoutes.post('/quote', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cart = await priceMerchantCart(c, typeof body.couponCode === 'string' ? body.couponCode : '');
  // The commission base is what the customer actually pays for the goods.
  const split = await feeFor(c.env.DB, 'store', cart.subtotal_iqd - cart.discount_iqd);
  return c.json({
    success: true,
    quote: {
      ...cart,
      // Shown to the customer as a total; the commission split is the
      // merchant's and the platform's business, and is returned so the
      // merchant's own screens can render it without a second call.
      commission_percent_x100: split.commission_percent_x100,
      platform_fee_iqd: split.platform_fee_iqd,
      merchant_receivable_iqd: split.merchant_receivable_iqd,
    },
  });
});

/**
 * Place the order.
 *
 * Idempotent on a client-supplied key, like the platform checkout: a double
 * tap or a network retry must not produce two orders, two stock decrements
 * and two payouts.
 */
storeOrderRoutes.post('/', async (c) => {
  await rateLimit(c, 'store-checkout', 15, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  const replay = await c.env.DB.prepare(
    'SELECT id FROM orders WHERE idempotency_key = ? AND user_id = ?'
  ).bind(idempotencyKey, user.id).first<{ id: string }>();
  if (replay) {
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(replay.id).first();
    return c.json({ success: true, order, replay: true });
  }

  const addressId = str(body.addressId, 'addressId', { min: 1, max: 60 });
  const address = await c.env.DB.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
    .bind(addressId, user.id)
    .first<Record<string, unknown>>();
  if (!address) throw notFound('Address not found');

  const payWithWallet = body.payWithWallet === true;
  const cart = await priceMerchantCart(c, typeof body.couponCode === 'string' ? body.couponCode : '');
  const split = await feeFor(c.env.DB, 'store', cart.subtotal_iqd - cart.discount_iqd);
  const rate = await exchangeRate(c.env.DB);

  // Wallet payment is reserved and committed in the same request. A hold
  // rather than a bare debit, so an insufficient balance writes nothing at
  // all instead of a half-paid order.
  let walletCents = 0;
  let holdId: string | null = null;
  if (payWithWallet) {
    walletCents = iqdToUsdCents(cart.total_iqd, rate);
    const hold = await createPurchaseHold(c.env.DB, {
      userId: user.id,
      amountCents: walletCents,
      eventKey: `store-order:${idempotencyKey}`,
      refType: 'store_order',
      refId: idempotencyKey,
      note: `Order from ${cart.store_name}`,
    });
    if (!hold.ok) {
      if (hold.reason === 'INSUFFICIENT_AVAILABLE') {
        throw badRequest('Your wallet balance does not cover this order', 'INSUFFICIENT_FUNDS', {
          required_iqd: cart.total_iqd,
        });
      }
      throw badRequest('Could not reserve the payment', 'WALLET_ERROR', { reason: hold.reason });
    }
    holdId = hold.holdId;
  }

  const orderId = `ORD-${newId().slice(0, 10).toUpperCase()}`;
  const ts = nowIso();

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO orders
         (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
          payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd,
          due_on_delivery_iqd, wallet_applied_iqd, wallet_applied_usd_cents,
          idempotency_key, created_at, updated_at,
          seller_type, merchant_id, store_id, origin,
          commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd,
          stage, stage_changed_at, coupon_code, coupon_discount_iqd)
       VALUES (?,?, 'pending', ?, 'merchant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'merchant', ?, ?, 'store_product', ?, ?, ?, 'received', ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(address), JSON.stringify({ by: 'merchant', store: cart.store_name }),
      payWithWallet ? 'wallet' : 'cod',
      cart.subtotal_iqd, cart.delivery_iqd, rate, cart.total_iqd,
      payWithWallet ? 0 : cart.total_iqd,
      payWithWallet ? cart.total_iqd : 0, walletCents,
      idempotencyKey, ts, ts,
      cart.merchant_id, cart.store_id,
      split.commission_percent_x100, split.platform_fee_iqd, split.merchant_receivable_iqd,
      ts, cart.coupon_code, cart.discount_iqd
    ),
  ];
  // The redemption is counted with the order, conditionally: a coupon at its
  // cap cannot be spent one more time by a concurrent checkout.
  if (cart.coupon_id) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE merchant_coupons SET used_count = used_count + 1
          WHERE id = ? AND active = 1 AND (max_uses IS NULL OR used_count < max_uses)`
      ).bind(cart.coupon_id)
    );
  }

  for (const l of cart.lines) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO order_items
           (id, order_id, product_id, community_product_id, seller_type, name_snapshot, image_snapshot,
            option_snapshot, qty, unit_price_iqd, line_total_iqd)
         VALUES (?,?,NULL,?, 'merchant', ?,?,?,?,?,?)`
      ).bind(
        newId('oi'), orderId, l.product_id, l.name, l.image,
        [l.option_id, l.color_id].filter(Boolean).join(' / '),
        l.qty, l.unit_price_iqd, l.line_total_iqd
      )
    );
    // Stock moves with the order, conditionally: the WHERE clause means a
    // concurrent order that already took the last unit makes this a no-op
    // rather than driving stock negative.
    stmts.push(
      c.env.DB.prepare(
        `UPDATE community_products
            SET stock = stock - ?, sold_count = sold_count + ?
          WHERE id = ? AND (track_stock = 0 OR stock >= ?)`
      ).bind(l.qty, l.qty, l.product_id, l.qty)
    );
  }

  // The merchant's share, PENDING until the order completes (§77). Visible to
  // them as "coming", not spendable.
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO merchant_payout_ledger
         (id, merchant_id, kind, amount_iqd, state, order_id, note, idempotency_key)
       VALUES (?,?,'sale_credit',?,'pending',?,'store sale',?)`
    ).bind(newId('pay'), cart.merchant_id, split.merchant_receivable_iqd, orderId, `sale:${idempotencyKey}`)
  );
  stmts.push(c.env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?').bind(user.id));

  await c.env.DB.batch(stmts);

  if (holdId) await commitHold(c.env.DB, { holdId, note: `Order ${orderId}` });

  await audit(c.env.DB, user.id, 'community.store_order_created', orderId, {
    store: cart.store_id,
    total: cart.total_iqd,
    fee: split.platform_fee_iqd,
  });

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  return c.json({ success: true, order }, 201);
});
