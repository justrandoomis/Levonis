import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAdmin, badRequest, notFound, forbidden, str, int, oneOf, jsonArray } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { getSettings, setSetting, SETTING_KEYS, type SettingKey } from '../lib/settings';
import { walletTxPublic, credit } from '../lib/wallet';
import { productPublic } from './products';
import { orderPublic } from './orders';
import { notifyAdmins, telegramConfigured, telegramGetMe } from '../lib/telegram';

export const adminRoutes = new Hono<AppContext>();
adminRoutes.use('*', requireAdmin);

// ---------------------------------------------------------------- overview

adminRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const [orders, users, wallet, pendingWallet, pendingCommunity, recentOrders] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status <> 'cancelled' THEN total_iqd ELSE 0 END) AS revenue_iqd
         FROM orders`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN subscription_plan = 'pro' THEN 1 ELSE 0 END) AS pro,
              SUM(CASE WHEN subscription_plan = 'plus' THEN 1 ELSE 0 END) AS plus,
              SUM(CASE WHEN is_investor = 1 THEN 1 ELSE 0 END) AS investors
         FROM users`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN currency='USD' AND type='deposit' AND status='approved' THEN amount ELSE 0 END),0) AS incoming_usd_cents,
         COALESCE(SUM(CASE WHEN currency='USD' AND type='withdrawal' AND status='approved' THEN amount ELSE 0 END),0) AS outgoing_usd_cents
       FROM wallet_transactions`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT wt.*, u.email, u.username FROM wallet_transactions wt
         LEFT JOIN users u ON u.id = wt.user_id
        WHERE wt.status = 'pending' ORDER BY wt.created_at DESC LIMIT 10`
    ).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS n FROM community_requests WHERE status = 'open'").first<{ n: number }>(),
    db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all<Record<string, unknown>>(),
  ]);

  return c.json({
    success: true,
    stats: {
      orders_total: orders?.total ?? 0,
      orders_pending: orders?.pending ?? 0,
      orders_delivered: orders?.delivered ?? 0,
      revenue_iqd: orders?.revenue_iqd ?? 0,
      users_total: users?.total ?? 0,
      pro_subscribers: users?.pro ?? 0,
      plus_subscribers: users?.plus ?? 0,
      investors: users?.investors ?? 0,
      incoming_usd_cents: wallet?.incoming_usd_cents ?? 0,
      outgoing_usd_cents: wallet?.outgoing_usd_cents ?? 0,
      pending_wallet_requests: pendingWallet.results.length,
      open_community_requests: pendingCommunity?.n ?? 0,
    },
    pending_wallet_requests: pendingWallet.results.map((t) => ({ ...walletTxPublic(t), email: t.email, username: t.username })),
    recent_orders: recentOrders.results.map((o) => ({
      id: o.id, status: o.status, total_iqd: o.total_iqd, created_at: o.created_at, user_id: o.user_id,
    })),
  });
});

// ---------------------------------------------------------------- telegram

/** Verifies the Telegram integration end-to-end and reports honestly. */
adminRoutes.post('/telegram/test', async (c) => {
  const me = await telegramGetMe(c.env);
  const configured = telegramConfigured(c.env);
  let sent = false;
  if (configured && me.ok) {
    sent = await notifyAdmins(c.env, '✅ Levonis: Telegram notifications are working (test message from the admin console).');
  }
  return c.json({
    success: true,
    tokenValid: me.ok,
    botUsername: me.username ?? null,
    chatConfigured: !!c.env.TELEGRAM_ADMIN_CHAT_ID,
    sent,
  });
});

// ---------------------------------------------------------------- users

adminRoutes.get('/users', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 50 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });
  let sql = `SELECT id, email, username, name, role, is_investor, subscription_plan, subscription_expiry, created_at
               FROM users`;
  const params: unknown[] = [];
  if (search) {
    sql += ' WHERE email LIKE ? OR username LIKE ? OR name LIKE ?';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return c.json({ success: true, users: results, total: total?.n ?? 0 });
});

adminRoutes.patch('/users/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first<{ id: string; role: string }>();
  if (!target) throw notFound('User not found');

  const updates: string[] = [];
  const params: unknown[] = [];
  if (body.role !== undefined) {
    const role = oneOf(body.role, 'role', ['customer', 'merchant', 'admin'] as const);
    if (id === admin.id && role !== 'admin') {
      throw forbidden('You cannot remove your own administrator role');
    }
    updates.push('role = ?');
    params.push(role);
  }
  if (body.subscription_plan !== undefined) {
    updates.push('subscription_plan = ?');
    params.push(oneOf(body.subscription_plan, 'subscription_plan', ['free', 'plus', 'pro'] as const));
  }
  if (body.is_investor !== undefined) {
    updates.push('is_investor = ?');
    params.push(body.is_investor ? 1 : 0);
  }
  if (updates.length === 0) throw badRequest('Nothing to update');
  params.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .bind(...params)
    .run();
  await audit(c.env.DB, admin.id, 'admin.user_update', id, body);
  return c.json({ success: true });
});

// ---------------------------------------------------------------- products

const SELLING_TYPES = ['direct_sale', 'pre_order', 'bundle'] as const;
const PRODUCT_STATUS = ['draft', 'active', 'hidden'] as const;

function validateProductBody(body: Record<string, unknown>) {
  const name = str(body.name, 'name', { min: 1, max: 200 });
  const slugRaw = str(body.slug, 'slug', { max: 200, required: false });
  const slug = (slugRaw || name).toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  if (!slug) throw badRequest('slug could not be derived — give the product a latin name or explicit slug');
  const priceFields = (v: unknown, nameOf: string) =>
    v === undefined || v === null || v === '' ? null : int(v, nameOf, { min: 0, max: 2_000_000_000 });
  return {
    name,
    slug,
    status: body.status === undefined ? 'active' : oneOf(body.status, 'status', PRODUCT_STATUS),
    name_ar: str(body.name_ar, 'name_ar', { max: 200, required: false }),
    name_ku: str(body.name_ku, 'name_ku', { max: 200, required: false }),
    description: str(body.description, 'description', { max: 20_000, required: false }),
    description_ar: str(body.description_ar, 'description_ar', { max: 20_000, required: false }),
    description_ku: str(body.description_ku, 'description_ku', { max: 20_000, required: false }),
    images: jsonArray(body.images, 'images', 24),
    options: jsonArray(body.options, 'options', 50),
    colors: jsonArray(body.colors, 'colors', 50),
    selling_type: body.selling_type === undefined ? 'direct_sale' : oneOf(body.selling_type, 'selling_type', SELLING_TYPES),
    shipping_methods: jsonArray(body.shipping_methods, 'shipping_methods', 20),
    price_iqd: int(body.price_iqd, 'price_iqd', { min: 0, max: 2_000_000_000 }),
    original_price_iqd: priceFields(body.original_price_iqd, 'original_price_iqd'),
    product_cost_iqd: priceFields(body.product_cost_iqd, 'product_cost_iqd'),
    membership_prices: JSON.stringify(
      typeof body.membership_prices === 'object' && body.membership_prices !== null ? body.membership_prices : {}
    ),
    payment_options: jsonArray(body.payment_options, 'payment_options', 20),
    subcategory_id: str(body.subcategory_id, 'subcategory_id', { max: 60, required: false }),
    categories: str(body.categories, 'categories', { max: 500, required: false }),
    display_order: int(body.display_order, 'display_order', { min: -100_000, max: 100_000, def: 0 }),
    is_featured: body.is_featured ? 1 : 0,
    specifications: jsonArray(body.specifications, 'specifications', 100),
    brand: str(body.brand, 'brand', { max: 100, required: false }),
    labels: jsonArray(body.labels, 'labels', 30),
    hashtags: jsonArray(body.hashtags, 'hashtags', 30),
    algorithm_tags: jsonArray(body.algorithm_tags, 'algorithm_tags', 30),
    features: jsonArray(body.features, 'features', 50),
    description_images: jsonArray(body.description_images, 'description_images', 30),
    description_videos: jsonArray(body.description_videos, 'description_videos', 10),
    stores: jsonArray(body.stores, 'stores', 20),
    warranty_plans: jsonArray(body.warranty_plans, 'warranty_plans', 10),
    how_to_use: str(body.how_to_use, 'how_to_use', { max: 20_000, required: false }),
    stock: body.stock === undefined || body.stock === null || body.stock === '' ? null : int(body.stock, 'stock', { min: 0, max: 1_000_000 }),
  };
}

adminRoutes.get('/products', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  return c.json({ success: true, products: results.map((p) => productPublic(p, { includeInternal: true })) });
});

adminRoutes.post('/products', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const p = validateProductBody(body);
  const id = typeof body.id === 'string' && body.id ? str(body.id, 'id', { max: 60 }) : newId('prd');

  const cols = Object.keys(p);
  const sql = `INSERT INTO products (id, ${cols.join(', ')})
               VALUES (?, ${cols.map(() => '?').join(', ')})
               ON CONFLICT(id) DO UPDATE SET ${cols.map((k) => `${k} = excluded.${k}`).join(', ')},
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  try {
    await c.env.DB.prepare(sql).bind(id, ...Object.values(p)).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('slug')) throw badRequest('A product with this slug already exists');
    throw e;
  }
  await audit(c.env.DB, adminUser.id, 'product.save', id, { name: p.name, price_iqd: p.price_iqd, status: p.status });
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, product: productPublic(row!, { includeInternal: true }) });
});

adminRoutes.delete('/products/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
  if (res.meta.changes === 0) throw notFound('Product not found');
  await audit(c.env.DB, adminUser.id, 'product.delete', id);
  return c.json({ success: true });
});

// ---------------------------------------------------------------- wallet review

adminRoutes.get('/wallet-requests', async (c) => {
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  let sql = `SELECT wt.*, u.email, u.username FROM wallet_transactions wt
               LEFT JOIN users u ON u.id = wt.user_id WHERE wt.currency = 'USD'`;
  const params: unknown[] = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    sql += ' AND wt.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY wt.created_at DESC LIMIT 300';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  return c.json({
    success: true,
    requests: results.map((t) => ({ ...walletTxPublic(t), email: t.email, username: t.username, userId: t.user_id })),
  });
});

adminRoutes.post('/wallet-requests/:id/decide', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.status, 'status', ['approved', 'rejected'] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  const tx = await c.env.DB.prepare("SELECT * FROM wallet_transactions WHERE id = ? AND status = 'pending'")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!tx) throw notFound('Pending request not found (it may already be decided)');

  if (decision === 'approved' && tx.type === 'withdrawal') {
    // Approving a withdrawal must not overdraw: conditional update guarded by
    // the live approved balance.
    const res = await c.env.DB.prepare(
      `UPDATE wallet_transactions
          SET status = 'approved', admin_note = ?1, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?2
        WHERE id = ?3 AND status = 'pending'
          AND (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                 FROM wallet_transactions
                WHERE user_id = ?4 AND currency = ?5 AND status='approved') >= amount`
    )
      .bind(adminNote, adminUser.id, id, tx.user_id, tx.currency)
      .run();
    if (res.meta.changes === 0) {
      throw badRequest("The user's balance no longer covers this withdrawal", 'INSUFFICIENT_BALANCE');
    }
  } else {
    const res = await c.env.DB.prepare(
      `UPDATE wallet_transactions
          SET status = ?, admin_note = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?
        WHERE id = ? AND status = 'pending'`
    )
      .bind(decision, adminNote, adminUser.id, id)
      .run();
    if (res.meta.changes === 0) throw badRequest('This request was already decided');
  }
  await audit(c.env.DB, adminUser.id, `wallet.${decision}`, id, {
    user_id: tx.user_id, type: tx.type, amount: tx.amount, currency: tx.currency,
  });
  return c.json({ success: true });
});

adminRoutes.post('/wallet/credit', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const userId = str(body.userId, 'userId', { min: 1, max: 60 });
  const currency = oneOf(body.currency, 'currency', ['USD', 'POINT'] as const);
  const amount = int(body.amount, 'amount', { min: 1, max: 100_000_000 });
  const note = str(body.note, 'note', { min: 3, max: 300 });
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');
  const id = await credit(c.env.DB, userId, currency, amount, note, `admin:${adminUser.id}`, 'admin');
  await audit(c.env.DB, adminUser.id, 'wallet.manual_credit', id, { userId, currency, amount, note });
  return c.json({ success: true, id });
});

// ---------------------------------------------------------------- orders

adminRoutes.get('/orders', async (c) => {
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  let sql = `SELECT o.*, u.email, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id`;
  const params: unknown[] = [];
  if (status) {
    sql += ' WHERE o.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY o.created_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  const out = [];
  for (const o of results) {
    const { results: items } = await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(o.id).all();
    out.push({ ...orderPublic(o, items), email: o.email, username: o.username, user_id: o.user_id });
  }
  return c.json({ success: true, orders: out });
});

const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

adminRoutes.patch('/orders/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const next = oneOf(body.status, 'status', ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  const from = String(order.status);
  if (!ORDER_TRANSITIONS[from]?.includes(next)) {
    throw badRequest(`Cannot move an order from "${from}" to "${next}"`);
  }

  const flip = await c.env.DB.prepare(
    `UPDATE orders SET status = ?, admin_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = ?`
  )
    .bind(next, adminNote, id, from)
    .run();
  if (flip.meta.changes === 0) throw badRequest('The order changed while you were editing — reload and retry');

  if (next === 'cancelled') {
    const stmts = [];
    const { results: items } = await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all<Record<string, unknown>>();
    for (const it of items) {
      if (it.product_id) {
        stmts.push(
          c.env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').bind(it.qty, it.product_id)
        );
      }
    }
    const walletCents = Number(order.wallet_applied_usd_cents) || 0;
    if (walletCents > 0) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(`wtx_refund_${id}_usd`, order.user_id, walletCents, `Refund for cancelled order ${id}`, id)
      );
    }
    const points = Number(order.points_discount_iqd) || 0;
    if (points > 0) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(`wtx_refund_${id}_pts`, order.user_id, points, `Points refund for cancelled order ${id}`, id)
      );
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  }
  await audit(c.env.DB, adminUser.id, 'order.status', id, { from, to: next });
  return c.json({ success: true });
});

// ---------------------------------------------------------------- settings

adminRoutes.get('/settings', async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({ success: true, settings });
});

adminRoutes.put('/settings/:key', async (c) => {
  const adminUser = c.get('user')!;
  const key = c.req.param('key') as SettingKey;
  if (!SETTING_KEYS.includes(key)) throw badRequest('Unknown setting');
  const body = await c.req.json().catch(() => ({}));
  let value = body.value as unknown;

  if (key === 'exchangeRate') {
    value = int(value, 'exchangeRate', { min: 1, max: 1_000_000 });
  } else if (key === 'currency') {
    value = oneOf(value, 'currency', ['IQD', 'USD'] as const);
  } else if (key === 'adVideoUrl') {
    const s = str(value, 'adVideoUrl', { max: 500, required: false });
    if (s && !/^https?:\/\//.test(s)) throw badRequest('adVideoUrl must be an http(s) URL');
    value = s;
  } else if (
    key === 'paymentMethods' || key === 'checkoutDeliveryMethods' ||
    key === 'checkoutPaymentMethods' || key === 'cartShippingMethods' ||
    key === 'homeSections' || key === 'homeAds'
  ) {
    if (!Array.isArray(value) || value.length > 50) throw badRequest(`${key} must be an array (max 50 items)`);
    for (const item of value) {
      if (typeof item !== 'object' || item === null || typeof (item as { id?: unknown }).id !== 'string') {
        throw badRequest(`Every ${key} entry needs a string id`);
      }
    }
  } else if (key === 'homeBanners' || key === 'homeSectionItems') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest(`${key} must be an object`);
    if (JSON.stringify(value).length > 100_000) throw badRequest(`${key} is too large`);
  }

  await setSetting(c.env.DB, key, value);
  await audit(c.env.DB, adminUser.id, 'settings.update', key);
  return c.json({ success: true });
});

// ---------------------------------------------------------------- community moderation

adminRoutes.get('/community/requests', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT cr.*, u.email, u.username FROM community_requests cr
       LEFT JOIN users u ON u.id = cr.customer_id ORDER BY cr.created_at DESC LIMIT 200`
  ).all();
  return c.json({ success: true, requests: results });
});

adminRoutes.post('/community/requests/:id/close', async (c) => {
  const adminUser = c.get('user')!;
  const res = await c.env.DB.prepare("UPDATE community_requests SET status = 'closed' WHERE id = ?")
    .bind(c.req.param('id'))
    .run();
  if (res.meta.changes === 0) throw notFound('Request not found');
  await audit(c.env.DB, adminUser.id, 'community.request_close', c.req.param('id'));
  return c.json({ success: true });
});

adminRoutes.patch('/community/merchants/:id', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const verified = body.verified ? 1 : 0;
  const res = await c.env.DB.prepare('UPDATE community_merchants SET verified = ? WHERE id = ?')
    .bind(verified, c.req.param('id'))
    .run();
  if (res.meta.changes === 0) throw notFound('Merchant not found');
  await audit(c.env.DB, adminUser.id, 'community.merchant_verify', c.req.param('id'), { verified });
  return c.json({ success: true });
});

adminRoutes.delete('/community/products/:id', async (c) => {
  const adminUser = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM community_products WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) throw notFound('Product not found');
  await audit(c.env.DB, adminUser.id, 'community.product_remove', c.req.param('id'));
  return c.json({ success: true });
});

// ---------------------------------------------------------------- warranty

adminRoutes.get('/warranty-claims', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT wc.*, u.email, u.username FROM warranty_claims wc
       LEFT JOIN users u ON u.id = wc.user_id ORDER BY wc.created_at DESC LIMIT 200`
  ).all();
  return c.json({ success: true, claims: results });
});

adminRoutes.patch('/warranty-claims/:id', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', ['submitted', 'in_review', 'approved', 'rejected'] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });
  const res = await c.env.DB.prepare('UPDATE warranty_claims SET status = ?, admin_note = ? WHERE id = ?')
    .bind(status, adminNote, c.req.param('id'))
    .run();
  if (res.meta.changes === 0) throw notFound('Claim not found');
  await audit(c.env.DB, adminUser.id, 'warranty.decide', c.req.param('id'), { status });
  return c.json({ success: true });
});

// ---------------------------------------------------------------- invest administration

adminRoutes.get('/invest/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, username, name, is_investor, created_at FROM users ORDER BY created_at DESC LIMIT 500`
  ).all();
  return c.json({ success: true, users: results });
});

adminRoutes.get('/invest/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  const [investments, messages] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 500').bind(userId).all(),
  ]);
  const items: Record<string, unknown[]> = {};
  for (const inv of investments.results) {
    const { results } = await c.env.DB.prepare('SELECT * FROM investment_items WHERE investment_id = ?').bind(inv.id).all();
    items[String(inv.id)] = results;
  }
  return c.json({ success: true, investments: investments.results, items, messages: messages.results });
});

adminRoutes.post('/invest/users/:userId/investments', async (c) => {
  const adminUser = c.get('user')!;
  const userId = c.req.param('userId');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_usd_cents, 'amount_usd_cents', { min: 1, max: 10_000_000_000 });
  const profit = int(body.expected_profit_usd_cents, 'expected_profit_usd_cents', { min: 0, max: 10_000_000_000, def: 0 });
  const days = int(body.duration_days, 'duration_days', { min: 1, max: 3650, def: 40 });
  const id = newId('inv');
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  await c.env.DB.prepare(
    `INSERT INTO investments (id, user_id, amount_usd_cents, expected_profit_usd_cents, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, amount, profit, start.toISOString(), end.toISOString())
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.create', id, { userId, amount, profit, days });
  return c.json({ success: true, id });
});

adminRoutes.patch('/invest/investments/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const inv = await c.env.DB.prepare('SELECT * FROM investments WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!inv) throw notFound('Investment not found');
  const body = await c.req.json().catch(() => ({}));
  const amount = body.amount_usd_cents !== undefined
    ? int(body.amount_usd_cents, 'amount_usd_cents', { min: 1, max: 10_000_000_000 })
    : Number(inv.amount_usd_cents);
  const profit = body.expected_profit_usd_cents !== undefined
    ? int(body.expected_profit_usd_cents, 'expected_profit_usd_cents', { min: 0, max: 10_000_000_000 })
    : Number(inv.expected_profit_usd_cents);
  const status = body.status !== undefined
    ? oneOf(body.status, 'status', ['active', 'completed', 'cancelled'] as const)
    : String(inv.status);
  let endDate = String(inv.end_date);
  if (body.duration_days !== undefined) {
    const days = int(body.duration_days, 'duration_days', { min: 1, max: 3650 });
    endDate = new Date(new Date(String(inv.start_date)).getTime() + days * 86_400_000).toISOString();
  }
  await c.env.DB.prepare(
    'UPDATE investments SET amount_usd_cents = ?, expected_profit_usd_cents = ?, status = ?, end_date = ? WHERE id = ?'
  )
    .bind(amount, profit, status, endDate, id)
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.update', id, { amount, profit, status });
  return c.json({ success: true });
});

adminRoutes.delete('/invest/investments/:id', async (c) => {
  const adminUser = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM investments WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) throw notFound('Investment not found');
  await audit(c.env.DB, adminUser.id, 'invest.delete', c.req.param('id'));
  return c.json({ success: true });
});

adminRoutes.post('/invest/investments/:id/items', async (c) => {
  const adminUser = c.get('user')!;
  const invId = c.req.param('id');
  const inv = await c.env.DB.prepare('SELECT id FROM investments WHERE id = ?').bind(invId).first();
  if (!inv) throw notFound('Investment not found');
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 1, max: 200 });
  const price = int(body.price_usd_cents, 'price_usd_cents', { min: 0, max: 10_000_000_000, def: 0 });
  const image = str(body.image, 'image', { max: 500, required: false });
  const id = newId('invi');
  await c.env.DB.prepare(
    'INSERT INTO investment_items (id, investment_id, name, price_usd_cents, image) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, invId, name, price, image)
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.item_add', id, { invId, name });
  return c.json({ success: true, id });
});

adminRoutes.delete('/invest/items/:id', async (c) => {
  const adminUser = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM investment_items WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) throw notFound('Item not found');
  await audit(c.env.DB, adminUser.id, 'invest.item_delete', c.req.param('id'));
  return c.json({ success: true });
});

adminRoutes.post('/invest/users/:userId/messages', async (c) => {
  const adminUser = c.get('user')!;
  const userId = c.req.param('userId');
  const body = await c.req.json().catch(() => ({}));
  const message = str(body.message, 'message', { min: 1, max: 2000 });
  const id = newId('imsg');
  await c.env.DB.prepare("INSERT INTO investor_messages (id, user_id, sender, message) VALUES (?, ?, 'admin', ?)")
    .bind(id, userId, message)
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.message', userId);
  return c.json({ success: true, id });
});
