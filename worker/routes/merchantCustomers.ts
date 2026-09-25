/**
 * THE PEOPLE WHO BOUGHT FROM THIS STORE (W3-B).
 *
 *   GET /api/merchant/customers?q=&cursor=&limit=   the list, newest buyer first
 *   GET /api/merchant/customers/:key                one customer, and their
 *     ?cursor=                                      orders HERE, paged
 *
 * NOT A DIRECTORY (§60). A row exists only because this store has a counted
 * (not cancelled) order from that person — cancelled orders do not make a
 * customer (audit 01 B12) — and every figure is of that relationship only:
 * orders here, spent here, the last order here, the governorate it went to.
 * Nothing of another store and nothing of the account (no balance, no other
 * purchases, no user id).
 *
 * THE KEY IS AN ORDER, NOT A USER. A customer is addressed by the id of their
 * first counted order with this store — an id the merchant already holds —
 * and resolved `WHERE id = ? AND merchant_id = <session>`. No user id leaves
 * the server (the command palette's rule, W3-A), a key from another store is
 * the same 404 as a made-up one, and a key stays valid if that order is later
 * cancelled (any order of this store by that person resolves them).
 *
 * THE PHONE, ONLY AS THE STORE ALREADY SEES IT: the detail shows the number on
 * the customer's latest order here, by the rule GET /api/merchant/orders/:id
 * uses (the delivery address's phone, else the account's). The list never
 * carries it; the search matches it without returning it.
 *
 * PAGED BY (last_order_at, key) — a keyset over the aggregate, so a page never
 * repeats or skips a customer whose last order shares a timestamp with another.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, requireAuth } from '../lib/http';
import { requireStoreOwner } from '../lib/merchantAuth';
import { rateLimit } from '../lib/ratelimit';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { phoneDigits, SEARCH_MAX, SEARCH_MIN } from './merchantWorkspace';
import { orderCreditStateSql } from '../lib/merchantLedger';
import { merchantHref } from '@levonis/contracts/merchantRoutes';

export const merchantCustomerRoutes = new Hono<AppContext>();
merchantCustomerRoutes.use('*', requireAuth);

const COUNTED = `o.status <> 'cancelled'`;
const KEY_RE = /^(?!\.+$)[A-Za-z0-9_.-]{1,80}$/;
export const CUSTOMERS_PAGE = 30;
export const CUSTOMER_ORDERS_PAGE = 20;

/** `<at>|<id>` → its parts; anything malformed is a 400, never a silent first page. */
export function parseKeyset(raw: string | undefined): { at: string; id: string } | null {
  if (raw === undefined || raw === '') return { at: '', id: '' };
  const v = String(raw).slice(0, 200);
  const bar = v.lastIndexOf('|');
  if (bar <= 0) return null;
  const at = v.slice(0, bar);
  const id = v.slice(bar + 1);
  if (!/^\d{4}-\d{2}-\d{2}[0-9T:.+\- Z]{0,30}$/.test(at) || !KEY_RE.test(id)) return null;
  return { at, id };
}

/** The governorate an order went to: the applied rule's, else the address's. */
const GOVERNORATE_OF = (o: string) =>
  `COALESCE(NULLIF(${o}.delivery_governorate, ''), CASE WHEN json_valid(${o}.address_snapshot) THEN json_extract(${o}.address_snapshot, '$.governorate') END, '')`;

merchantCustomerRoutes.get('/', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const merchantId = ctx.merchant.id;
  const limitRaw = Number(c.req.query('limit') ?? CUSTOMERS_PAGE);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.trunc(limitRaw))) : CUSTOMERS_PAGE;
  const cursor = parseKeyset(c.req.query('cursor'));
  if (!cursor) throw new HttpError(400, 'Bad cursor', 'BAD_CURSOR');
  const q = String(c.req.query('q') ?? '').trim();
  if (q) {
    await rateLimit(c, 'merchant-customer-search', 60, 60);
    if ([...q].length < SEARCH_MIN) throw new HttpError(400, `Type at least ${SEARCH_MIN} characters`, 'SEARCH_QUERY_TOO_SHORT');
    if ([...q].length > SEARCH_MAX) throw new HttpError(400, `At most ${SEARCH_MAX} characters`, 'SEARCH_QUERY_TOO_LONG');
  }
  const pattern = q ? likePattern(q) : '';
  const digits = q ? phoneDigits(q) : '';
  const phone = digits.length >= 4 ? likePattern(digits) : '';

  // One row per buyer: their counted orders here. The search matches the
  // name, or a phone on ANY of this store's orders by them — the phone is
  // matched, never returned. The key is their first counted order here.
  const { results } = await db
    .prepare(
      `SELECT x.* FROM (
         SELECT t.user_id, t.name, t.order_count, t.spent, t.last_order_at, t.first_order_at,
                (SELECT o2.id FROM orders o2
                  WHERE o2.merchant_id = ?1 AND o2.user_id = t.user_id AND o2.status <> 'cancelled'
                  ORDER BY o2.created_at, o2.id LIMIT 1) AS customer_key,
                (SELECT ${GOVERNORATE_OF('o3')} FROM orders o3
                  WHERE o3.merchant_id = ?1 AND o3.user_id = t.user_id AND o3.status <> 'cancelled'
                  ORDER BY o3.created_at DESC, o3.id DESC LIMIT 1) AS governorate
           FROM (SELECT o.user_id, MAX(u.name) AS name, COUNT(*) AS order_count,
                        COALESCE(SUM(o.total_iqd), 0) AS spent, MAX(o.created_at) AS last_order_at,
                        MIN(o.created_at) AS first_order_at
                   FROM orders o JOIN users u ON u.id = o.user_id
                  WHERE o.merchant_id = ?1 AND ${COUNTED}
                    AND (?2 = '' OR ${sqlLikeClause(['u.name'], '?2')}
                         OR (?3 <> '' AND EXISTS (
                           SELECT 1 FROM orders op
                            WHERE op.merchant_id = ?1 AND op.user_id = o.user_id
                              AND ${sqlLikeClause(["replace(replace(replace(CASE WHEN json_valid(op.address_snapshot) THEN COALESCE(json_extract(op.address_snapshot, '$.phone'), '') ELSE '' END, ' ', ''), '-', ''), '+', '')"], '?3')})))
                  GROUP BY o.user_id) t
       ) x
        WHERE (?4 = '' OR x.last_order_at < ?4 OR (x.last_order_at = ?4 AND x.customer_key < ?5))
        ORDER BY x.last_order_at DESC, x.customer_key DESC
        LIMIT ?6`
    )
    .bind(merchantId, pattern, phone, cursor.at, cursor.id, limit + 1)
    .all<{ user_id: string; name: string | null; order_count: number; spent: number; last_order_at: string; first_order_at: string; customer_key: string; governorate: string | null }>();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    ...(q ? { q } : {}),
    customers: page.map((r) => ({
      key: r.customer_key,
      name: r.name ?? '',
      order_count: Number(r.order_count) || 0,
      spent_iqd: Number(r.spent) || 0,
      last_order_at: r.last_order_at,
      first_order_at: r.first_order_at,
      // Absent when the orders carry none (older addresses), never a guess.
      ...(r.governorate ? { governorate: r.governorate } : {}),
      link: merchantHref.customer(r.customer_key),
    })),
    next_cursor: rows.length > limit && last ? `${last.last_order_at}|${last.customer_key}` : null,
  });
});

merchantCustomerRoutes.get('/:key', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const merchantId = ctx.merchant.id;
  const key = String(c.req.param('key') ?? '');
  if (!KEY_RE.test(key)) throw new HttpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  const cursor = parseKeyset(c.req.query('cursor'));
  if (!cursor) throw new HttpError(400, 'Bad cursor', 'BAD_CURSOR');

  // The key resolves ONLY through an order of THIS store.
  const who = await db
    .prepare('SELECT user_id FROM orders WHERE id = ? AND merchant_id = ?')
    .bind(key, merchantId)
    .first<{ user_id: string }>();
  if (!who) throw new HttpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  const userId = who.user_id;

  const [summary, latest, orders] = await Promise.all([
    db
      .prepare(
        `SELECT MAX(u.name) AS name,
                COALESCE(SUM(CASE WHEN ${COUNTED} THEN 1 ELSE 0 END), 0) AS order_count,
                COALESCE(SUM(CASE WHEN ${COUNTED} THEN o.total_iqd ELSE 0 END), 0) AS spent,
                COALESCE(SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
                MIN(CASE WHEN ${COUNTED} THEN o.created_at END) AS first_order_at,
                MAX(CASE WHEN ${COUNTED} THEN o.created_at END) AS last_order_at,
                (SELECT o2.id FROM orders o2 WHERE o2.merchant_id = ?1 AND o2.user_id = ?2 AND o2.status <> 'cancelled'
                  ORDER BY o2.created_at, o2.id LIMIT 1) AS customer_key
           FROM orders o JOIN users u ON u.id = o.user_id
          WHERE o.merchant_id = ?1 AND o.user_id = ?2`
      )
      .bind(merchantId, userId)
      .first<{ name: string | null; order_count: number; spent: number; cancelled: number; first_order_at: string | null; last_order_at: string | null; customer_key: string | null }>(),
    db
      .prepare(
        `SELECT o.address_snapshot, u.phone_e164 AS account_phone, ${GOVERNORATE_OF('o')} AS governorate
           FROM orders o JOIN users u ON u.id = o.user_id
          WHERE o.merchant_id = ? AND o.user_id = ?
          ORDER BY o.created_at DESC, o.id DESC LIMIT 1`
      )
      .bind(merchantId, userId)
      .first<{ address_snapshot: string | null; account_phone: string | null; governorate: string | null }>(),
    db
      .prepare(
        `SELECT o.id, o.status, o.total_iqd, o.merchant_receivable_iqd, o.created_at,
                (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
                ${orderCreditStateSql('o.id')} AS credit_state
           FROM orders o
          WHERE o.merchant_id = ?1 AND o.user_id = ?2
            AND (?3 = '' OR o.created_at < ?3 OR (o.created_at = ?3 AND o.id < ?4))
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ?5`
      )
      .bind(merchantId, userId, cursor.at, cursor.id, CUSTOMER_ORDERS_PAGE + 1)
      .all<{ id: string; status: string; total_iqd: number; merchant_receivable_iqd: number; created_at: string; item_count: number; credit_state: string | null }>(),
  ]);

  const rows = orders.results ?? [];
  const page = rows.slice(0, CUSTOMER_ORDERS_PAGE);
  const last = page[page.length - 1];
  const addr = safeParse<Record<string, unknown>>(latest?.address_snapshot ?? null, {});
  const phone = (typeof addr.phone === 'string' && addr.phone) || latest?.account_phone || '';
  const counted = Number(summary?.order_count) || 0;
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    customer: {
      // The canonical key: their first counted order here — or, for someone
      // whose every order here was cancelled, the key they were opened by.
      key: summary?.customer_key ?? key,
      name: summary?.name ?? '',
      order_count: counted,
      spent_iqd: Number(summary?.spent) || 0,
      cancelled_count: Number(summary?.cancelled) || 0,
      // An average over no counted order is not 0; it is absent.
      ...(counted ? { average_order_iqd: Math.round((Number(summary?.spent) || 0) / counted) } : {}),
      first_order_at: summary?.first_order_at ?? null,
      last_order_at: summary?.last_order_at ?? null,
      returning: counted >= 2,
      ...(latest?.governorate ? { governorate: latest.governorate } : {}),
      ...(phone ? { phone } : {}),
    },
    orders: page.map((o) => ({
      id: o.id,
      status: o.status,
      total_iqd: Number(o.total_iqd) || 0,
      merchant_receivable_iqd: Number(o.merchant_receivable_iqd) || 0,
      created_at: o.created_at,
      item_count: Number(o.item_count) || 0,
      credit_state: o.credit_state ?? null,
      link: merchantHref.order(o.id),
    })),
    next_cursor: rows.length > CUSTOMER_ORDERS_PAGE && last ? `${last.created_at}|${last.id}` : null,
  });
});
