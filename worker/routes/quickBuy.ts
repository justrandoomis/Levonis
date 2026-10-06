/**
 * «الشراء السريع» — the HTTP surface (owner brief 2026-10-06 §3–§21,
 * docs/GIFTS_QUICK_BUY.md §3.2). Mounted at `/api/quick-buy` (customer) and
 * `/api/admin/quick-buy` (administrator, read-mostly).
 *
 * Nothing here decides money, stock, time or price: the routes parse, rate
 * limit and hand over to worker/lib/quickBuy, where every write is one fenced
 * batch priced by the cart's own checkout. Every write carries an
 * idempotency key (body `idempotencyKey`, or the `Idempotency-Key` header for
 * a DELETE that cannot carry a body).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, requireAdmin, requireAuth, str, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { langOf } from './orders';
import { activateQuickBuy, profileView, updateQuickBuyProfile } from '../lib/quickBuy/profile';
import {
  applyQuickBuyChange,
  cancelQuickBuySession,
  isExpired,
  liveItems,
  loadOpenSession,
  loadSession,
  parseAdd,
  sessionView,
  type QuickBuyChange,
} from '../lib/quickBuy/session';
import { finalizeQuickBuySession, releaseSession } from '../lib/quickBuy/finalize';
import { parseJson, QUICK_BUY_MAX_QTY, type QuickBuySessionRow } from '../lib/quickBuy/model';

export const quickBuyRoutes = new Hono<AppContext>();
quickBuyRoutes.use('*', requireAuth);

const keyOf = (c: Context<AppContext>, body: Record<string, unknown>) =>
  str(body.idempotencyKey ?? c.req.header('Idempotency-Key'), 'idempotencyKey', { min: 8, max: 80 });

const readBody = async (c: Context<AppContext>): Promise<Record<string, unknown>> => {
  const raw = await c.req.json().catch(() => ({}));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
};

const finalizeIfDue = (c: Context<AppContext>) => async (s: QuickBuySessionRow) => {
  await finalizeQuickBuySession(c.env, { c }, s.id);
};

/** The last session that ended, for «تم إرسال طلب الشراء السريع» (§13). */
async function recentView(db: D1Database, userId: string) {
  const s = await db
    .prepare(
      `SELECT * FROM quick_buy_sessions
        WHERE user_id = ? AND state IN ('submitted', 'failed') AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
        ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(userId)
    .first<QuickBuySessionRow>();
  if (!s) return null;
  const view = await sessionView(db, s);
  const order =
    s.state === 'submitted'
      ? await db.prepare('SELECT id, status, total_iqd FROM orders WHERE id = ?').bind(s.order_id).first<{ id: string; status: string; total_iqd: number }>()
      : null;
  return { ...view, order };
}

async function currentSession(c: Context<AppContext>) {
  const db = c.env.DB;
  const user = c.get('user')!;
  let s = await loadOpenSession(db, user.id);
  if (s && isExpired(s)) {
    await finalizeQuickBuySession(c.env, { c }, s.id);
    s = await loadOpenSession(db, user.id);
  }
  return {
    session: s ? await sessionView(db, s) : null,
    recent: s ? null : await recentView(db, user.id),
    server_now: new Date().toISOString(),
  };
}

quickBuyRoutes.get('/profile', async (c) => {
  return c.json({ success: true, profile: await profileView(c.env.DB, c.get('user')!.id) });
});

quickBuyRoutes.post('/activate', async (c) => {
  await rateLimit(c, 'quick_buy_profile', 20, 300);
  const body = await readBody(c);
  const profile = await activateQuickBuy(c.env, c.get('user')!.id, body, langOf(c));
  return c.json({ success: true, profile });
});

quickBuyRoutes.put('/profile', async (c) => {
  await rateLimit(c, 'quick_buy_profile', 20, 300);
  const body = await readBody(c);
  const profile = await updateQuickBuyProfile(c.env, c.get('user')!.id, body);
  return c.json({ success: true, profile });
});

quickBuyRoutes.get('/session', async (c) => {
  return c.json({ success: true, ...(await currentSession(c)) });
});

async function respondWithChange(c: Context<AppContext>, change: QuickBuyChange) {
  const result = await applyQuickBuyChange(c, c.get('user')!, change, finalizeIfDue(c));
  const view = result.session ? await sessionView(c.env.DB, result.session) : null;
  return c.json({
    success: true,
    session: view && view.state === 'open' ? view : null,
    ended: view && view.state !== 'open' ? view : null,
    added: result.added,
    replay: result.replay,
    server_now: new Date().toISOString(),
  });
}

quickBuyRoutes.post('/items', async (c) => {
  await rateLimit(c, 'quick_buy', 60, 300);
  const body = await readBody(c);
  return respondWithChange(c, {
    kind: 'add',
    key: keyOf(c, body),
    add: parseAdd(body),
    printerAck: body.printerStandardDeliveryAcceptance ?? null,
  });
});

quickBuyRoutes.patch('/items/:id', async (c) => {
  await rateLimit(c, 'quick_buy', 60, 300);
  const body = await readBody(c);
  const qty = int(body.qty, 'qty', { min: 0, max: QUICK_BUY_MAX_QTY });
  const itemId = str(c.req.param('id'), 'id', { min: 1, max: 80 });
  return respondWithChange(
    c,
    qty === 0 ? { kind: 'remove', key: keyOf(c, body), itemId } : { kind: 'update', key: keyOf(c, body), itemId, qty }
  );
});

quickBuyRoutes.delete('/items/:id', async (c) => {
  await rateLimit(c, 'quick_buy', 60, 300);
  const body = await readBody(c);
  return respondWithChange(c, { kind: 'remove', key: keyOf(c, body), itemId: str(c.req.param('id'), 'id', { min: 1, max: 80 }) });
});

quickBuyRoutes.post('/session/cancel', async (c) => {
  await rateLimit(c, 'quick_buy', 60, 300);
  const body = await readBody(c);
  const key = keyOf(c, body);
  const user = c.get('user')!;
  const db = c.env.DB;
  const prior = await db.prepare('SELECT 1 AS x FROM quick_buy_actions WHERE user_id = ? AND key = ?').bind(user.id, key).first();
  if (!prior) {
    const open = await loadOpenSession(db, user.id);
    if (open) await cancelQuickBuySession(c, user, key, 'customer');
  }
  return c.json({ success: true, session: null, server_now: new Date().toISOString() });
});

// ---------------------------------------------------------------- admin

/**
 * «طلبات Quick Buy قيد التجميع» (§14): a READ-ONLY window on open sessions —
 * nothing here confirms, prepares or ships one; a session becomes an order
 * the admin can act on only when its 30 minutes end. The two writes are for a
 * session the cron could not submit (`failed`): try again, or cancel it and
 * return the held money and units.
 */
export const quickBuyAdminRoutes = new Hono<AppContext>();
quickBuyAdminRoutes.use('*', requireAdmin);

quickBuyAdminRoutes.get('/sessions', async (c) => {
  const state = c.req.query('state') ?? 'open';
  if (!['open', 'submitted', 'cancelled', 'failed'].includes(state)) throw badRequest('Unknown state', 'VALIDATION');
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.state, s.started_at, s.expires_at, s.order_id, s.total_iqd, s.held_iqd, s.shipping_iqd,
            s.finalize_attempts, s.finalize_error, s.submitted_at, s.cancelled_at, s.cancel_reason, s.updated_at,
            u.name AS user_name, u.email AS user_email,
            (SELECT COUNT(*) FROM quick_buy_items i WHERE i.session_id = s.id AND i.qty > 0) AS lines,
            (SELECT COALESCE(SUM(i.qty), 0) FROM quick_buy_items i WHERE i.session_id = s.id AND i.qty > 0) AS units
       FROM quick_buy_sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.state = ?
      ORDER BY CASE WHEN s.state = 'open' THEN s.expires_at END ASC, s.updated_at DESC
      LIMIT ?`
  )
    .bind(state, limit)
    .all();
  return c.json({ success: true, sessions: results ?? [], server_now: new Date().toISOString() });
});

/**
 * §21 — THE MONEY, KEPT APART. A HOLD is not revenue: it is money reserved
 * for an order that does not exist yet. A CAPTURE is the order's own wallet
 * debit (revenue is still recognised at delivery, as for every order). A
 * RELEASE returned held money; a REFUND returned money of a cancelled Quick
 * Buy order through the ordinary cancel refund. Orders are counted by what
 * made them — the cart, Quick Buy or gifts only.
 */
quickBuyAdminRoutes.get('/summary', async (c) => {
  const days = Math.min(366, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
  const db = c.env.DB;
  const since = `-${days} days`;
  const [events, held, kinds, refunds] = await Promise.all([
    db
      .prepare(
        `SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount_iqd), 0) AS iqd FROM quick_buy_events
          WHERE kind IN ('hold', 'release', 'capture') AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
          GROUP BY kind`
      )
      .bind(since)
      .all<{ kind: string; n: number; iqd: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(held_iqd), 0) AS iqd FROM quick_buy_sessions WHERE state IN ('open', 'failed')`)
      .first<{ n: number; iqd: number }>(),
    db
      .prepare(
        `SELECT order_kind AS kind, COUNT(*) AS n, COALESCE(SUM(total_iqd), 0) AS iqd FROM orders
          WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND status <> 'cancelled'
          GROUP BY order_kind`
      )
      .bind(since)
      .all<{ kind: string; n: number; iqd: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(t.amount_iqd, 0)), 0) AS iqd
           FROM wallet_transactions t JOIN orders o ON o.id = t.ref
          WHERE o.order_kind = 'quick_buy' AND t.type = 'deposit' AND t.currency = 'USD'
            AND t.id LIKE 'wtx_refund_%' AND t.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
      )
      .bind(since)
      .first<{ n: number; iqd: number }>(),
  ]);
  const ev = (k: string) => (events.results ?? []).find((r) => r.kind === k) ?? { n: 0, iqd: 0 };
  return c.json({
    success: true,
    days,
    held_now: { sessions: Number(held?.n) || 0, iqd: Number(held?.iqd) || 0 },
    holds: ev('hold'),
    captured: ev('capture'),
    released: ev('release'),
    refunded: { n: Number(refunds?.n) || 0, iqd: Number(refunds?.iqd) || 0 },
    orders_by_kind: kinds.results ?? [],
  });
});

quickBuyAdminRoutes.get('/sessions/:id', async (c) => {
  const db = c.env.DB;
  const s = await loadSession(db, c.req.param('id'));
  if (!s) throw new HttpError(404, 'Not found', 'NOT_FOUND');
  const [view, events] = await Promise.all([
    sessionView(db, s),
    db.prepare('SELECT * FROM quick_buy_events WHERE session_id = ? ORDER BY created_at, id').bind(s.id).all(),
  ]);
  return c.json({
    success: true,
    session: { ...view, user_id: s.user_id, finalize_attempts: s.finalize_attempts, finalize_error: s.finalize_error, quote: parseJson(s.quote_json, {}) },
    events: events.results ?? [],
  });
});

quickBuyAdminRoutes.post('/sessions/:id/retry', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const res = await db
    .prepare(
      `UPDATE quick_buy_sessions SET state = 'open', finalize_attempts = 0, lease_until = NULL, finalize_error = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND state = 'failed'`
    )
    .bind(id)
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'Only a failed Quick Buy session can be retried', 'QUICK_BUY_STATE');
  const outcome = await finalizeQuickBuySession(c.env, { c }, id);
  return c.json({ success: true, outcome });
});

quickBuyAdminRoutes.post('/sessions/:id/cancel', async (c) => {
  const db = c.env.DB;
  const s = await loadSession(db, c.req.param('id'));
  if (!s || s.state !== 'failed') throw new HttpError(409, 'Only a failed Quick Buy session can be cancelled here', 'QUICK_BUY_STATE');
  const items = await liveItems(db, s.id);
  const ok = await releaseSession(db, s, items, { state: 'cancelled', reason: 'admin_cancel', actorId: c.get('user')!.id, fromStates: ['failed'] });
  if (!ok) throw new HttpError(409, 'The session changed — reload and try again', 'QUICK_BUY_BUSY');
  return c.json({ success: true });
});
