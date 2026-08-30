import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAdmin, badRequest, notFound, forbidden, str, int, oneOf, jsonArray, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { canViewFinancials, normalizeAdminScope } from '../lib/adminScope';
import { normalizeHomeBanners, normalizeSectionItems } from '../lib/homeContent';
import { deductOrderStock, returnOrderStock } from '../lib/orderInventory';
import { getSetting, getSettings, setSetting, SETTING_KEYS, type SettingKey } from '../lib/settings';
import { onOrderDelivered, grantPrinterGiftIfEligible } from '../lib/membershipOps';
import { createUnitsOnDelivery, type CreateUnitsResult } from '../lib/deviceOps';
import { awardOrderPoints } from '../lib/pointsOps';
import { walletTxPublic, credit } from '../lib/wallet';
import { productPublic } from './products';
import { orderPublic } from './orders';
import { getOrderPointsSnapshots } from '../lib/pointsOps';
import { notifyAdmins, telegramConfigured, telegramGetMe } from '../lib/telegram';
import {
  STAGE_SOURCE,
  canMoveStage,
  resolveDurations,
  stageForLegacyStatus,
  stageLabel,
  stagesFor,
  type OrderStage,
} from '../lib/orderStages';
import { moveOrderStage, stagePath, stageRowFrom, sweepDueStages } from '../lib/orderStageOps';
import { ALWASEET, alwaseetDriver, resolveWire } from '../lib/delivery/alwaseet';
import { listStatusMap, setStatusMapping, upsertRemoteStatuses } from '../lib/delivery/statusMap';
import { syncOrderDelivery, sweepDeliveryStatuses } from '../lib/delivery/sync';
import type { DeliveryDriver } from '../lib/delivery/types';
import { typeForTransport } from '../lib/shippingType';
import type { ShippingType } from '../lib/shippingType';

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
              SUM(CASE WHEN membership_tier = 'pro' THEN 1 ELSE 0 END) AS pro,
              SUM(CASE WHEN membership_tier = 'prime' THEN 1 ELSE 0 END) AS prime,
              SUM(CASE WHEN membership_tier = 'plus' THEN 1 ELSE 0 END) AS plus,
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

  // §11: revenue and wallet flow are financial data. An assistant admin sees
  // the operational counts and nothing about money.
  const money = canViewFinancials(c.env, c.get('user'));
  return c.json({
    success: true,
    can_view_financials: money,
    stats: {
      orders_total: orders?.total ?? 0,
      orders_pending: orders?.pending ?? 0,
      orders_delivered: orders?.delivered ?? 0,
      ...(money ? { revenue_iqd: orders?.revenue_iqd ?? 0 } : {}),
      users_total: users?.total ?? 0,
      pro_subscribers: users?.pro ?? 0,
      plus_subscribers: users?.plus ?? 0,
      investors: users?.investors ?? 0,
      ...(money
        ? {
            incoming_usd_cents: wallet?.incoming_usd_cents ?? 0,
            outgoing_usd_cents: wallet?.outgoing_usd_cents ?? 0,
          }
        : {}),
      pending_wallet_requests: pendingWallet.results.length,
      open_community_requests: pendingCommunity?.n ?? 0,
    },
    pending_wallet_requests: money
      ? pendingWallet.results.map((t) => ({ ...walletTxPublic(t), email: t.email, username: t.username }))
      : [],
    recent_orders: recentOrders.results.map((o) => ({
      id: o.id,
      status: o.status,
      ...(money ? { total_iqd: o.total_iqd } : {}),
      created_at: o.created_at,
      user_id: o.user_id,
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
  let sql = `SELECT id, email, username, name, role, is_investor, membership_tier,
                    admin_scope, subscription_plan, subscription_expiry, created_at
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
  const target = await c.env.DB
    .prepare('SELECT id, role, email FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; role: string; email: string }>();
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
  // Admins set the tier through membership_tier; subscription_plan is kept in
  // sync for its legal domain only (a PRIME member is 'free' there — see
  // migration 0018). getTierStatus overwrites both from the memberships
  // ledger on the member's next request, so this is an override, not a
  // substitute for issuing a membership.
  if (body.membership_tier !== undefined || body.subscription_plan !== undefined) {
    const tier = oneOf(
      body.membership_tier ?? body.subscription_plan,
      'membership_tier',
      ['free', 'plus', 'pro', 'prime'] as const
    );
    updates.push('membership_tier = ?');
    params.push(tier);
    updates.push('subscription_plan = ?');
    params.push(tier === 'prime' ? 'free' : tier);
  }
  // §11: only a financial admin may hand out (or take away) financial access,
  // and the site owner can never be demoted — otherwise a compromised
  // assistant could lock the owner out of their own numbers.
  if (body.admin_scope !== undefined) {
    if (!canViewFinancials(c.env, admin)) {
      throw forbidden('Only a financial administrator can change financial access');
    }
    const scope = normalizeAdminScope(body.admin_scope);
    const ownerEmail = (c.env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
    if (scope === 'assistant' && ownerEmail && target.email.trim().toLowerCase() === ownerEmail) {
      throw forbidden('The owner account cannot be restricted');
    }
    updates.push('admin_scope = ?');
    params.push(scope);
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
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const offset = int(c.req.query('offset'), 'offset', { min: 0, max: 100_000, def: 0 });

  // TWO QUERIES, NOT 201. This used to fetch 200 orders and then run a
  // separate `SELECT * FROM order_items WHERE order_id = ?` for EACH one —
  // 201 round trips to D1 for one screen, which is why the orders tab took
  // seconds to appear. The items now come back in a single IN query over the
  // page's ids, and the page is 30 rows rather than 200.
  let where = '';
  const params: unknown[] = [];
  if (status) {
    where = ' WHERE o.status = ?';
    params.push(status);
  }

  const [{ results }, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT o.*, u.email, u.username FROM orders o
         LEFT JOIN users u ON u.id = o.user_id${where}
        ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o${where}`)
      .bind(...params)
      .first<{ n: number }>(),
  ]);

  const ids = results.map((o) => String(o.id));
  const byOrder = new Map<string, Record<string, unknown>[]>(ids.map((id) => [id, []]));
  if (ids.length > 0) {
    const { results: items } = await c.env.DB.prepare(
      `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`
    )
      .bind(...ids)
      .all<Record<string, unknown>>();
    for (const it of items) byOrder.get(String(it.order_id))?.push(it);
  }

  const out = results.map((o) => ({
    ...orderPublic(o, byOrder.get(String(o.id)) ?? []),
    email: o.email,
    username: o.username,
    user_id: o.user_id,
    priority: Number(o.priority) || 0,
    delivery_waived: Number(o.delivery_waived) || 0,
    membership_tier_snapshot: o.membership_tier_snapshot ?? 'free',
    delivered_at: o.delivered_at ?? null,
  }));
  return c.json({ success: true, orders: out, total: countRow?.n ?? out.length, limit, offset });
});

/**
 * Everything needed to PREPARE one order, in a single call.
 *
 * The list endpoint above returns 200 orders with their items and was never
 * meant to carry the fulfilment detail: the address parts a courier asks for,
 * who the customer is, and the money breakdown behind the total. This is the
 * order screen's own payload.
 *
 * §11 still applies — nothing here is cost or margin. The admin sees what the
 * CUSTOMER was charged and how it was paid, which is what packing a box and
 * writing a receipt needs.
 */
adminRoutes.get('/orders/:id', async (c) => {
  const id = c.req.param('id');
  const o = await c.env.DB.prepare(
    `SELECT o.*, u.email, u.username, u.name AS user_name, u.phone_e164, u.membership_tier,
            u.created_at AS user_since
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!o) throw notFound('Order not found');

  // ENRICHMENTS DEGRADE, THEY DO NOT FAIL THE SCREEN. The units, the invoice
  // and the order's chat thread all live in tables added by later migrations
  // (0003, 0026). Code always reaches a deployment a moment before its
  // migration does, and on 2026-08-30 that window turned the whole fulfilment
  // modal into "خطأ في الخادم" because one lookup for `chats.order_id` threw.
  // The order, its address and its money are the screen; everything else is
  // extra, and extra that is missing is worth an empty list, not a 500.
  const soft = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      console.error(`order detail enrichment unavailable (${label}): ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  const [{ results: items }, snaps, units, invoice, chat, stageHistory] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid').bind(id).all<Record<string, unknown>>(),
    soft('points', () => getOrderPointsSnapshots(c.env, [id]), new Map()),
    // Serialized units matter on the fulfilment screen: a printer that needs a
    // serial written on the warranty slip is a different packing job from a
    // spool of filament.
    soft(
      'units',
      async () =>
        (
          await c.env.DB.prepare(
            `SELECT iu.*, ds.serial_raw
               FROM order_item_units iu
               LEFT JOIN device_serials ds ON ds.unit_id = iu.id
              WHERE iu.order_id = ? ORDER BY iu.order_item_id, iu.unit_index`
          ).bind(id).all<Record<string, unknown>>()
        ).results,
      [] as Record<string, unknown>[]
    ),
    soft(
      'invoice',
      () =>
        c.env.DB.prepare(
          'SELECT id, invoice_no, revision, payment_status FROM invoices WHERE order_id = ? ORDER BY revision DESC LIMIT 1'
        ).bind(id).first<Record<string, unknown>>(),
      null as Record<string, unknown> | null
    ),
    soft(
      'chat',
      () => c.env.DB.prepare('SELECT id FROM chats WHERE order_id = ?').bind(id).first<{ id: string }>(),
      null as { id: string } | null
    ),
    soft(
      'stage_history',
      async () =>
        (
          await c.env.DB.prepare(
            'SELECT stage, status, source, changed_at, changed_by, note FROM order_status_history WHERE order_id = ? ORDER BY changed_at'
          ).bind(id).all<{ stage: string; changed_at: string }>()
        ).results ?? [],
      [] as { stage: string; changed_at: string }[]
    ),
  ]);

  // The address as STORED ON THE ORDER, not the customer's current address —
  // an order is packed for where it was sent, and a later edit must not
  // silently repoint a parcel that is already being prepared.
  const address = safeParse<Record<string, unknown>>(o.address_snapshot, {});

  return c.json({
    success: true,
    order: {
      ...orderPublic(o, items, snaps.get(id)),
      admin_note: o.admin_note ?? '',
      customer: {
        id: o.user_id,
        name: o.user_name ?? null,
        username: o.username ?? null,
        email: o.email ?? null,
        // The account's own verified phone, which may differ from the one on
        // the address — both are shown, neither is guessed from the other.
        account_phone: o.phone_e164 ?? null,
        membership_tier: o.membership_tier ?? 'free',
        member_since: o.user_since ?? null,
      },
      address,
      units: units.map((u) => ({
        id: u.id,
        order_item_id: u.order_item_id,
        unit_index: u.unit_index,
        serial: u.serial_raw ?? null,
        warranty_base_months: u.warranty_base_months ?? null,
        warranty_ext_months: u.warranty_ext_months ?? 0,
        warranty_start_at: u.warranty_start_at ?? null,
        warranty_end_at: u.warranty_end_at ?? null,
      })),
      invoice: invoice ?? null,
      chat_id: chat?.id ?? null,
      // The tracking path, so the fulfilment modal shows where the parcel is
      // and offers only the moves that are actually legal from here. The
      // panel holds no copy of the path — one authority, on the server.
      tracking: (() => {
        const shippingType = asShippingType(o.shipping_type);
        const stage = String(o.stage || 'received') as OrderStage;
        const path = stagesFor(shippingType);
        return {
          shipping_type: shippingType,
          stage,
          stage_source: o.stage_source ?? 'automatic',
          stage_changed_at: o.stage_changed_at || o.updated_at || o.created_at,
          next_stage: o.next_stage || null,
          next_stage_at: o.next_stage_at ?? null,
          delivery: {
            provider: o.delivery_provider || '',
            remote_id: o.delivery_remote_id || '',
            tracking_no: o.delivery_tracking_no || '',
            status_text: o.delivery_status_text || '',
            synced_at: o.delivery_synced_at ?? null,
            error: o.delivery_error || '',
          },
          steps: stagePath(shippingType, stage, stageHistory).map((v) => ({
            ...v,
            label_ar: stageLabel(v.stage, shippingType, 'ar'),
            label_en: stageLabel(v.stage, shippingType, 'en'),
          })),
          available: [...path, 'cancelled' as OrderStage]
            .filter((to) => canMoveStage(stage, to, shippingType))
            .map((to) => ({
              stage: to,
              source: STAGE_SOURCE[to],
              label_ar: stageLabel(to, shippingType, 'ar'),
              label_en: stageLabel(to, shippingType, 'en'),
            })),
          history: stageHistory,
        };
      })(),
    },
  });
});

/**
 * Where an order may go from where it is.
 *
 * THIS USED TO BE A ONE-WAY RATCHET: pending offered two options, shipped
 * offered one, and delivered and cancelled offered none. A human running a
 * real shop mis-taps — an order marked shipped that has not shipped, or
 * cancelled by mistake — and had no way back at all. Two choices on a screen
 * whose whole job is moving orders is not a state machine, it is a trap.
 *
 * So corrections are allowed among the pre-delivery states in BOTH directions,
 * and forward steps may skip (an order confirmed and shipped the same hour
 * does not need a click on `processing` to be honest). What is NOT allowed:
 *
 *   * delivered -> anything but `shipped`. Delivery grants points, starts
 *     warranty clocks and creates device units. Backing out to `shipped` is
 *     offered as the one correction path for a mis-tap, and the route says
 *     plainly what that does NOT undo.
 *   * a no-op transition to the state the order is already in.
 *
 * Every side effect behind these is idempotent through the inventory and
 * points ledgers, so a correction that goes forward again moves nothing twice.
 */
/**
 * Everything that has to happen the first time an order reaches `delivered`.
 *
 * Extracted because there are now TWO ways an order gets there — an admin
 * moving the legacy status, and an admin (or the courier's API) moving the
 * tracking stage — and the day those two granted different things would be
 * the day a customer's warranty depended on which button was pressed.
 *
 * Every step is individually idempotent (UNIQUE(order_item_id, unit_index),
 * UNIQUE(order_id) on points and on the gift), so reaching delivered twice
 * grants nothing twice.
 */
/** Narrows a stored shipping_type, falling back the way the cart does. */
function asShippingType(v: unknown): ShippingType {
  return v === 'preorder_air' || v === 'preorder_sea' || v === 'preorder_land' || v === 'direct'
    ? v
    : typeForTransport(v);
}

async function deliveredEffects(
  c: Context<AppContext>,
  id: string
): Promise<{ deviceUnits: CreateUnitsResult | null; deviceUnitsWarning: string | null }> {
  let deviceUnits: CreateUnitsResult | null = null;
  let deviceUnitsWarning: string | null = null;

  // Mandate §4: create one device record per PHYSICAL unit of every
  // serialized product, clocked to the delivered_at just stamped. Awaited
  // (warranty clocks are account state, not a fire-and-forget message) and
  // idempotent via UNIQUE(order_item_id, unit_index) — a replayed
  // transition can never duplicate units or restart coverage.
  const deliveredRow = await c.env.DB.prepare('SELECT delivered_at FROM orders WHERE id = ?')
    .bind(id)
    .first<{ delivered_at: string | null }>();
  try {
    deviceUnits = await createUnitsOnDelivery(c.env, id, deliveredRow?.delivered_at ?? new Date().toISOString());
  } catch (e) {
    console.error('device unit creation failed for order', id, e);
    // Honest partial outcome: the order IS delivered, units are missing.
    deviceUnitsWarning =
      'Device units were not created — retry from Admin → Serials & Devices (backfill), otherwise warranty clocks for this order are missing.';
  }

  // Purchase points (decision row 20 defaults): floor(qualifying merchandise
  // / 1000) at the delivered event. Awaited — points are account state —
  // and idempotent via points_awards UNIQUE(order_id), so a replayed
  // delivered transition can never double-award.
  try {
    await awardOrderPoints(c.env, id);
  } catch (e) {
    console.error('points award failed for order', id, e);
  }

  // Referral 9.1 milestone: records delivered_at-based eligibility (idempotent).
  c.executionCtx.waitUntil(onOrderDelivered(c.env, id));
  // PLUS gift on printer purchase, when the owner set the milestone to
  // delivery (grant itself is idempotent per order).
  const printerGift = await getSetting(c.env.DB, 'printerGiftConfig');
  if (printerGift?.enabled === true && printerGift.milestone === 'delivered') {
    c.executionCtx.waitUntil(grantPrinterGiftIfEligible(c.env, id));
  }
  return { deviceUnits, deviceUnitsWarning };
}

const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
  shipped: ['pending', 'confirmed', 'processing', 'delivered', 'cancelled'],
  // Reversible only one step, and only to correct a mis-tap.
  delivered: ['shipped'],
  // A cancelled order can be re-opened; re-confirming re-deducts the stock.
  cancelled: ['pending', 'confirmed', 'processing'],
};

/** The states in which the stock has been taken out of inventory. */
const STOCK_DEDUCTED_STATES = new Set(['confirmed', 'processing', 'shipped', 'delivered']);

/**
 * The tracking stages an order can be in, and the moves available from where
 * it stands. Feeds the admin panel so the panel does not have to hold its own
 * copy of the path — the one place the rules live is the server.
 */
adminRoutes.get('/orders/:id/stages', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('Order not found');
  const order = stageRowFrom(row);
  const { results: history } = await c.env.DB.prepare(
    'SELECT stage, status, source, changed_at, changed_by, note FROM order_status_history WHERE order_id = ? ORDER BY changed_at'
  )
    .bind(id)
    .all<{ stage: string; changed_at: string }>();

  const path = stagesFor(order.shipping_type);
  return c.json({
    success: true,
    shipping_type: order.shipping_type,
    stage: order.stage,
    stage_source: order.stage_source,
    stage_changed_at: order.stage_changed_at,
    next_stage: order.next_stage || null,
    next_stage_at: order.next_stage_at,
    path: stagePath(order.shipping_type, order.stage, history ?? []).map((v) => ({
      ...v,
      label_ar: stageLabel(v.stage, order.shipping_type, 'ar'),
      label_en: stageLabel(v.stage, order.shipping_type, 'en'),
    })),
    // What the admin may actually pick. Computed here so a panel can render
    // the real options instead of the whole path greyed out — the six-option
    // bug the owner already reported once was a panel guessing this.
    available: [...path, 'cancelled' as OrderStage]
      .filter((to) => canMoveStage(order.stage, to, order.shipping_type))
      .map((to) => ({
        stage: to,
        source: STAGE_SOURCE[to],
        label_ar: stageLabel(to, order.shipping_type, 'ar'),
        label_en: stageLabel(to, order.shipping_type, 'en'),
      })),
    history: history ?? [],
  });
});

/**
 * An admin moving an order along its path. The stage is the authority for
 * what the customer is told; the legacy status is kept in step underneath by
 * moveOrderStage, so the stock lifecycle and every existing filter still work.
 */
/**
 * Runs the stage sweep now, instead of waiting for the next cron tick.
 *
 * The cron fires every fifteen minutes, which is right for a shop and wrong
 * for an owner who has just shortened a wait in the settings and wants to see
 * it take effect. It is the same function the cron calls — not a second
 * implementation — so what this promotes is exactly what the cron would have.
 */
// ------------------------------------------------------------ local delivery

/**
 * Builds the courier driver, or throws the honest 503 that says why not.
 *
 * A missing credential is not a server error and must not read like one. The
 * message names the SETTING, never a value — the owner's rule is that no
 * token or login ever leaves the Worker, and that includes leaving it inside
 * an error message.
 */
async function deliveryDriverOrFail(c: Context<AppContext>): Promise<DeliveryDriver> {
  const wire = await getSetting(c.env.DB, 'deliveryConfig');
  const driver = alwaseetDriver(c.env, wire);
  if ('configured' in driver) {
    throw new HttpError(
      503,
      `${driver.reason} Missing: ${driver.missing.join(', ')}.`,
      'DELIVERY_NOT_CONFIGURED',
      { missing: driver.missing }
    );
  }
  return driver;
}

/** What is and is not set up, for the admin screen. Names only, no values. */
adminRoutes.get('/delivery/config', async (c) => {
  const wire = (await getSetting(c.env.DB, 'deliveryConfig')) as Record<string, unknown>;
  const driver = alwaseetDriver(c.env, wire);
  const mappings = await listStatusMap(c.env.DB, ALWASEET).catch(() => []);
  return c.json({
    success: true,
    provider: ALWASEET,
    credentials_configured: !('configured' in driver),
    missing_credentials: 'configured' in driver ? driver.missing : [],
    // The wire config is not secret — it is endpoint paths and field names —
    // so it is safe to show and to edit from the panel.
    wire: wire ?? {},
    statuses_known: mappings.length,
    statuses_mapped: mappings.filter((m) => m.internal_stage !== '').length,
  });
});

/**
 * Refreshes the courier's OFFICIAL status list — "اجلب قائمة الحالات الرسمية
 * من GET /v1/merchant/statuses ولا تعتمد على نصوص hardcoded".
 *
 * Never touches mappings the owner already made: a refresh that silently
 * unmapped a status would break every order using it.
 */
adminRoutes.post('/delivery/statuses/refresh', async (c) => {
  const adminUser = c.get('user')!;
  const driver = await deliveryDriverOrFail(c);
  const res = await driver.listStatuses();
  if (!res.ok) throw badRequest(res.error, 'DELIVERY_API_ERROR', { retryable: res.retryable });
  const now = new Date().toISOString();
  const out = await upsertRemoteStatuses(c.env.DB, driver.provider, res.value, now);
  await audit(c.env.DB, adminUser.id, 'delivery.statuses_refresh', driver.provider, out);
  return c.json({ success: true, ...out, statuses: await listStatusMap(c.env.DB, driver.provider) });
});

adminRoutes.get('/delivery/statuses', async (c) => {
  return c.json({ success: true, statuses: await listStatusMap(c.env.DB, ALWASEET) });
});

/** The owner's alwaseet_status_id -> internal stage mapping, one row at a time. */
adminRoutes.put('/delivery/statuses/:remoteId', async (c) => {
  const adminUser = c.get('user')!;
  const remoteId = c.req.param('remoteId');
  const body = await c.req.json().catch(() => ({}));
  const stage = str(body.stage, 'stage', { max: 40, required: false });
  // '' clears a mapping, which is how an owner says "I do not know what this
  // means yet" — and an unmapped status leaves orders alone.
  if (stage && !(stage in STAGE_SOURCE)) throw badRequest(`Unknown stage "${stage}"`);
  await setStatusMapping(c.env.DB, ALWASEET, remoteId, stage, new Date().toISOString());
  await audit(c.env.DB, adminUser.id, 'delivery.status_map', remoteId, { stage });
  return c.json({ success: true, statuses: await listStatusMap(c.env.DB, ALWASEET) });
});

/**
 * Creates the courier shipment for one order — the admin's action at
 * "جارٍ تجهيز التوصيل المحلي".
 *
 * Refuses to create a SECOND shipment for an order that already has one:
 * a double-tap would put two drivers on the same parcel and leave us syncing
 * the wrong id.
 */
adminRoutes.post('/orders/:id/delivery', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const driver = await deliveryDriverOrFail(c);

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  if (order.delivery_remote_id) {
    throw badRequest('This order already has a delivery shipment.', 'SHIPMENT_EXISTS', {
      remote_id: order.delivery_remote_id,
      tracking_no: order.delivery_tracking_no ?? '',
    });
  }
  const address = safeParse<Record<string, unknown>>(order.address_snapshot, {});
  const { results: items } = await c.env.DB.prepare(
    'SELECT name_snapshot, qty FROM order_items WHERE order_id = ?'
  ).bind(id).all<{ name_snapshot: string; qty: number }>();

  const res = await driver.createShipment({
    orderId: String(order.id),
    customerName: String(address.name ?? ''),
    phone: String(address.phone ?? ''),
    governorate: String(address.governorate ?? ''),
    area: String(address.area ?? ''),
    address: String(address.address ?? ''),
    landmark: String(address.landmark ?? ''),
    notes: String(address.notes ?? ''),
    // Cash on delivery collects the total; anything already paid collects
    // nothing. Getting this wrong takes money off a customer twice, so it is
    // read from the order rather than assumed.
    amountIqd: String(order.payment_method_id) === 'cash' ? Number(order.total_iqd) || 0 : 0,
    itemCount: (items ?? []).reduce((n, i) => n + Number(i.qty || 0), 0),
    itemsSummary: (items ?? []).map((i) => `${i.name_snapshot} x${i.qty}`).join(', ').slice(0, 500),
  });

  if (!res.ok) {
    // The order is NOT moved and NOT marked as shipped. The error is stored
    // so the admin sees it on the order rather than only in a toast.
    await c.env.DB.prepare('UPDATE orders SET delivery_error = ? WHERE id = ?')
      .bind(res.error.slice(0, 500), id).run();
    throw badRequest(res.error, 'DELIVERY_API_ERROR', { retryable: res.retryable });
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE orders SET delivery_provider = ?, delivery_remote_id = ?, delivery_tracking_no = ?,
            delivery_status_id = ?, delivery_status_text = ?, delivery_synced_at = ?, delivery_error = ''
      WHERE id = ?`
  )
    .bind(driver.provider, res.value.remoteId, res.value.trackingNo, res.value.statusId, res.value.statusText, now, id)
    .run();
  await audit(c.env.DB, adminUser.id, 'delivery.shipment_create', id, {
    provider: driver.provider, remote_id: res.value.remoteId, tracking_no: res.value.trackingNo,
  });

  // The stage is NOT advanced here. "لا تستخدم Timer للانتقال إلى في الطريق
  // إليك" — creating a shipment is not the courier picking it up, and only
  // the courier's own status may say that.
  return c.json({
    success: true,
    provider: driver.provider,
    remote_id: res.value.remoteId,
    tracking_no: res.value.trackingNo,
  });
});

/** The owner's "مزامنة حالة الوسيط" button, for one order. */
adminRoutes.post('/orders/:id/delivery/sync', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const driver = await deliveryDriverOrFail(c);
  const res = await syncOrderDelivery(c.env, driver, id);
  await audit(c.env.DB, adminUser.id, 'delivery.sync', id, { outcome: res.outcome });
  // An error is reported as an error, but with 200: the sync ran, it just
  // could not reach the courier, and the admin needs to see WHICH it was.
  return c.json({ success: true, ...res });
});

/** The same sync the cron runs, on demand. */
adminRoutes.post('/delivery/sync', async (c) => {
  const adminUser = c.get('user')!;
  const driver = await deliveryDriverOrFail(c);
  const report = await sweepDeliveryStatuses(c.env, driver, 100);
  await audit(c.env.DB, adminUser.id, 'delivery.sync_all', driver.provider, {
    scanned: report.scanned, moved: report.moved, errors: report.errors,
  });
  return c.json({ success: true, ...report });
});

adminRoutes.post('/orders/sweep-stages', async (c) => {
  const adminUser = c.get('user')!;
  const report = await sweepDueStages(c.env, 200);
  await audit(c.env.DB, adminUser.id, 'order.stage_sweep', '', {
    scanned: report.scanned, promoted: report.promoted, skipped: report.skipped,
  });
  return c.json({ success: true, ...report });
});

adminRoutes.patch('/orders/:id/stage', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const to = str(body.stage, 'stage', { max: 40 }) as OrderStage;
  if (!(to in STAGE_SOURCE)) throw badRequest(`Unknown stage "${to}"`);
  const note = str(body.note, 'note', { max: 500, required: false });

  const res = await moveOrderStage(c.env, {
    orderId: id,
    to,
    source: 'manual',
    changedBy: adminUser.id,
    note,
  });
  if (!res.moved) {
    if (res.reason === 'NOT_FOUND') throw notFound('Order not found');
    if (res.reason === 'RACED') throw badRequest('The order changed while you were editing — reload and retry');
    throw badRequest(`Cannot move this order from "${res.from}" to "${to}"`, 'ILLEGAL_STAGE_MOVE', {
      from: res.from,
      to,
    });
  }

  // Reaching `delivered` grants device warranties and purchase points. That
  // lives in the legacy PATCH handler below and is NOT duplicated here: an
  // admin marking an order delivered by stage is routed through the same
  // grant path so the two can never award different things.
  const notes = [...res.notes];
  if (to === 'delivered') {
    const effects = await deliveredEffects(c, id);
    if (effects.deviceUnitsWarning) notes.push(effects.deviceUnitsWarning);
  }

  await audit(c.env.DB, adminUser.id, 'order.stage', id, {
    from: res.from, to, source: 'manual',
    legacy: `${res.legacy_from} -> ${res.legacy_to}`,
    next_stage: res.next_stage, next_stage_at: res.next_stage_at,
  });
  return c.json({
    success: true,
    stage: to,
    legacy_status: res.legacy_to,
    next_stage: res.next_stage,
    next_stage_at: res.next_stage_at,
    ...(notes.length ? { notes } : {}),
  });
});

adminRoutes.patch('/orders/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const next = oneOf(body.status, 'status', [
    'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled',
  ] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  const from = String(order.status);
  if (!ORDER_TRANSITIONS[from]?.includes(next)) {
    throw badRequest(`Cannot move an order from "${from}" to "${next}"`);
  }

  // delivered_at is stamped in the SAME conditional update as the status flip
  // so a concurrent transition can never produce a delivered order without it.
  const flip = await c.env.DB.prepare(
    next === 'delivered'
      ? `UPDATE orders SET status = ?, admin_note = ?, delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = ?`
      : `UPDATE orders SET status = ?, admin_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = ?`
  )
    .bind(next, adminNote, id, from)
    .run();
  if (flip.meta.changes === 0) throw badRequest('The order changed while you were editing — reload and retry');

  // §7 stock lifecycle. Confirmation turns the hold taken at checkout into a
  // real decrement; cancellation gives the units back — a release when the
  // order was never confirmed, a restore when it was. Both are idempotent
  // through the inventory ledger, so a double-clicked transition (or a replay
  // after the status flip already landed) moves nothing twice.
  //
  // The trigger is CROSSING THE BOUNDARY, not landing on one particular
  // status. Now that an order may go pending -> shipped directly, or come back
  // from cancelled to processing, keying the deduction off `next ===
  // 'confirmed'` would have silently skipped it. Both operations are
  // idempotent through the inventory ledger, so a correction that re-crosses
  // the boundary moves nothing twice.
  let stockNote: string | null = null;
  const wasDeducted = STOCK_DEDUCTED_STATES.has(from);
  const nowDeducted = STOCK_DEDUCTED_STATES.has(next);
  if (!wasDeducted && nowDeducted) {
    const res = await deductOrderStock(c.env.DB, id, adminUser.id);
    if (res.rejected > 0) {
      // The status already flipped. Saying so is the honest outcome: the order
      // IS confirmed, and the stock needs a human.
      stockNote = `Stock could not be deducted for ${res.rejected} line(s) — check the product's stock before shipping.`;
    }
  } else if (next === 'cancelled') {
    const res = await returnOrderStock(c.env.DB, id, adminUser.id);
    if (res.kind !== 'none') stockNote = `Stock ${res.kind}d for ${res.applied} row(s).`;
  }

  // Reversing a delivery does not un-grant what delivery granted. Say so
  // rather than letting the admin assume it did.
  let reversalNote: string | null = null;
  if (from === 'delivered' && next !== 'delivered') {
    reversalNote =
      'Moved back from delivered. Points already awarded, device records and warranty start dates are NOT reversed — they stay as they were granted.';
  }

  let deviceUnits: CreateUnitsResult | null = null;
  let deviceUnitsWarning: string | null = null;
  if (next === 'delivered') {
    const effects = await deliveredEffects(c, id);
    deviceUnits = effects.deviceUnits;
    deviceUnitsWarning = effects.deviceUnitsWarning;
  }

  if (next === 'cancelled') {
    // Stock was already handled above through the inventory ledger, which
    // knows whether the units were ever deducted. The raw "stock + qty" that
    // used to live here could not, and handed back units on an order that was
    // cancelled before confirmation — units it had never taken.
    const stmts = [];
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

    // A cancelled order can no longer qualify referral rewards keyed on it —
    // cancel any still-undecided ones (never touches available/reserved/
    // fulfilled rewards, which an admin decided explicitly).
    const rewards = await c.env.DB.prepare(
      `UPDATE referral_rewards
          SET state = 'cancelled',
              decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              decided_by = ?,
              admin_note = CASE WHEN admin_note = '' THEN ? ELSE admin_note END
        WHERE source_ref = ? AND state IN ('pending','qualified')`
    )
      .bind(adminUser.id, `Source order ${id} was cancelled`, id)
      .run();
    if (rewards.meta.changes > 0) {
      await audit(c.env.DB, adminUser.id, 'referral.reward_cancel', id, {
        reason: 'order_cancelled', count: rewards.meta.changes,
      });
    }
  }
  // Keep the tracking stage in step with the legacy status. The old dropdown
  // is still in the panel and still the fastest way to correct an order; if
  // it left the stage behind, the customer's tracker and the admin's list
  // would start telling two different stories about the same parcel.
  //
  // The stage chosen is the EARLIEST one carrying the new status — moving an
  // order to "shipped" must not tell the customer it already reached Iraq —
  // and the schedule is re-armed from now, which is what cancels whatever
  // automatic transition was pending.
  try {
    const shippingType = asShippingType(order.shipping_type);
    const targetStage = stageForLegacyStatus(next, shippingType);
    const currentStage = String(order.stage || 'received') as OrderStage;
    if (targetStage !== currentStage) {
      await moveOrderStage(c.env, {
        orderId: id,
        to: targetStage,
        source: 'manual',
        changedBy: adminUser.id,
        note: adminNote || `Status changed to ${next}`,
        // The legality of this move was already decided by ORDER_TRANSITIONS
        // above, on the legacy statuses. Re-judging it on the stage path
        // would reject corrections the admin is entitled to make.
        force: true,
      });
    }
  } catch (e) {
    console.error('stage sync failed for order', id, e);
  }

  await audit(c.env.DB, adminUser.id, 'order.status', id, {
    from,
    to: next,
    stock: stockNote,
    reversal: reversalNote,
  });
  return c.json({
    success: true,
    ...(stockNote ? { stock_note: stockNote } : {}),
    ...(reversalNote ? { reversal_note: reversalNote } : {}),
    ...(deviceUnits ? { device_units: deviceUnits } : {}),
    ...(deviceUnitsWarning ? { device_units_warning: deviceUnitsWarning } : {}),
  });
});

// ---------------------------------------------------------------- coupons

/**
 * Promo codes. The validation engine has existed since migration 0002 —
 * tiers, date windows, global and per-user limits, fixed and percentage
 * discounts, all enforced server-side at checkout — but there was no way to
 * CREATE one, so the storefront's promo box had nothing to accept and was
 * disabled with "قريباً" on it. This is the missing half.
 *
 * Redemptions are counted, not stored twice: the count comes from the
 * coupon_redemptions rows the checkout writes, so a coupon's usage can never
 * disagree with the orders that used it.
 */
adminRoutes.get('/coupons', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redeemed
       FROM coupons c ORDER BY c.created_at DESC LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({ success: true, coupons: results ?? [] });
});

/** Shared validation for create and update, so the two cannot drift apart. */
function couponFieldsFrom(body: Record<string, unknown>) {
  const kind = oneOf(body.kind, 'kind', ['fixed_iqd', 'percent'] as const);
  const value = int(body.value, 'value', { min: 1, max: kind === 'percent' ? 100 : 100_000_000 });
  const tierRaw = str(body.tier_required, 'tier_required', { max: 10, required: false });
  if (tierRaw && !['plus', 'pro', 'prime'].includes(tierRaw)) {
    throw badRequest('tier_required must be plus, pro or prime');
  }
  const startsAt = str(body.starts_at, 'starts_at', { max: 40, required: false });
  const endsAt = str(body.ends_at, 'ends_at', { max: 40, required: false });
  // A window that closes before it opens would silently never apply. Better
  // refused at the form than debugged from a customer's complaint.
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw badRequest('The end date must be after the start date');
  }
  const maxGlobalRaw = body.max_global;
  const maxGlobal =
    maxGlobalRaw === null || maxGlobalRaw === undefined || maxGlobalRaw === ''
      ? null
      : int(maxGlobalRaw, 'max_global', { min: 1, max: 1_000_000 });
  return {
    kind,
    value,
    tier_required: tierRaw || null,
    min_total_iqd: int(body.min_total_iqd ?? 0, 'min_total_iqd', { min: 0, max: 1_000_000_000 }),
    starts_at: startsAt || null,
    ends_at: endsAt || null,
    max_global: maxGlobal,
    max_per_user: int(body.max_per_user ?? 1, 'max_per_user', { min: 1, max: 1000 }),
    active: body.active === false ? 0 : 1,
  };
}

adminRoutes.post('/coupons', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  // Stored uppercased, as the column has always assumed, and with spaces
  // stripped: a customer typing "save 10" must reach the same row.
  const code = str(body.code, 'code', { min: 3, max: 60 }).trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]+$/.test(code)) throw badRequest('A code may use letters, digits, - and _ only');
  const f = couponFieldsFrom(body);
  const id = newId('cpn');
  try {
    await c.env.DB.prepare(
      `INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, starts_at, ends_at,
         max_global, max_per_user, active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
      .bind(id, code, f.tier_required, f.kind, f.value, f.min_total_iqd, f.starts_at, f.ends_at,
            f.max_global, f.max_per_user, f.active)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) throw badRequest('That code already exists', 'CODE_TAKEN');
    throw e;
  }
  await audit(c.env.DB, adminUser.id, 'coupon.create', id, { code, kind: f.kind, value: f.value });
  return c.json({ success: true, id, code });
});

adminRoutes.patch('/coupons/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const existing = await c.env.DB.prepare('SELECT id FROM coupons WHERE id = ?').bind(id).first<{ id: string }>();
  if (!existing) throw notFound('Coupon not found');

  // The CODE is not editable. Customers have it written down and orders
  // already reference it in their snapshots; renaming it would break the
  // first and orphan the second. Deactivate and create a new one instead.
  const f = couponFieldsFrom(body);
  await c.env.DB.prepare(
    `UPDATE coupons SET tier_required = ?, kind = ?, value = ?, min_total_iqd = ?,
            starts_at = ?, ends_at = ?, max_global = ?, max_per_user = ?, active = ?
      WHERE id = ?`
  )
    .bind(f.tier_required, f.kind, f.value, f.min_total_iqd, f.starts_at, f.ends_at,
          f.max_global, f.max_per_user, f.active, id)
    .run();
  await audit(c.env.DB, adminUser.id, 'coupon.update', id, f);
  return c.json({ success: true });
});

/**
 * Deactivates a coupon. There is no delete: coupon_redemptions references the
 * row, and an order that says "SAVE10 was applied" must still be able to say
 * what SAVE10 was.
 */
adminRoutes.delete('/coupons/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('UPDATE coupons SET active = 0 WHERE id = ?').bind(id).run();
  if (res.meta.changes === 0) throw notFound('Coupon not found');
  await audit(c.env.DB, adminUser.id, 'coupon.deactivate', id);
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
    // Normalize on the WAY IN, not only on the way out. This is the content
    // the storefront puts in an <img src> and an <a href>, so a link that is
    // not a path or an http(s) URL is dropped here rather than stored and
    // filtered on every read. It also accepts the pre-hero `{id,image,link}`
    // shape unchanged, so existing banners survive the upgrade.
    value = key === 'homeBanners' ? normalizeHomeBanners(value) : normalizeSectionItems(value);
  } else if (key === 'deliveryConfig') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('deliveryConfig must be an object');
    }
    if (JSON.stringify(value).length > 20_000) throw badRequest('deliveryConfig is too large');
    // Normalized by the same function the driver reads with, so what survives
    // here is exactly what will go on the wire. A credential accidentally
    // pasted into this object is DROPPED rather than stored: the shape only
    // admits endpoint paths and field-name maps, and secrets belong in Worker
    // secrets where no admin screen can read them back.
    value = resolveWire(value);
  } else if (key === 'orderStageDurations') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('orderStageDurations must be an object of minute values');
    }
    // Validated by the same function the engine reads with, so a value that
    // survives here is exactly the value the clock will use. An unknown key
    // or an out-of-range number is dropped rather than stored to confuse a
    // later reader.
    value = resolveDurations(value);
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
