/**
 * «الشراء السريع» — the HTTP surface (owner brief 2026-10-06 §3–§21,
 * docs/GIFTS_QUICK_BUY.md §3.2). Mounted at `/api/quick-buy`, for the customer
 * only. There is NO administrator surface (owner, 2026-10-08, DECISIONS row
 * 188): the system runs a session from its first purchase to its order, and
 * one it cannot submit is cancelled and refunded by itself
 * (worker/lib/quickBuy/finalize.ts). The admin meets a Quick Buy only once it
 * is an ordinary order, on the ordinary orders board.
 *
 * Nothing here decides money, stock, time or price: the routes parse, rate
 * limit and hand over to worker/lib/quickBuy, where every write is one fenced
 * batch priced by the cart's own checkout. Every write carries an
 * idempotency key (body `idempotencyKey`, or the `Idempotency-Key` header for
 * a DELETE that cannot carry a body).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, str, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { langOf } from './orders';
import { activateQuickBuy, profileView, updateQuickBuyProfile } from '../lib/quickBuy/profile';
import {
  applyQuickBuyChange,
  cancelQuickBuySession,
  isExpired,
  loadOpenSession,
  parseAdd,
  sessionView,
  type QuickBuyChange,
} from '../lib/quickBuy/session';
import { finalizeQuickBuySession, QUICK_BUY_NOT_SUBMITTED } from '../lib/quickBuy/finalize';
import { QUICK_BUY_MAX_QTY, type QuickBuySessionRow } from '../lib/quickBuy/model';

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

/**
 * The last session that ended, for «تم إرسال طلب الشراء السريع» (§13) — or,
 * when the system could not submit it, for the one line that says it was
 * cancelled and the money is back (`cancelled` / `not_submitted`). A `failed`
 * row left from before DECISIONS row 188 still reads here until the next
 * minute's sweep cancels and refunds it.
 */
async function recentView(db: D1Database, userId: string, lang: string) {
  const s = await db
    .prepare(
      `SELECT * FROM quick_buy_sessions
        WHERE user_id = ?
          AND (state IN ('submitted', 'failed') OR (state = 'cancelled' AND cancel_reason = ?))
          AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
        ORDER BY updated_at DESC LIMIT 1`
    )
    .bind(userId, QUICK_BUY_NOT_SUBMITTED)
    .first<QuickBuySessionRow>();
  if (!s) return null;
  const view = await sessionView(db, s, Date.now(), lang);
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
    session: s ? await sessionView(db, s, Date.now(), langOf(c)) : null,
    recent: s ? null : await recentView(db, user.id, langOf(c)),
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
  const view = result.session ? await sessionView(c.env.DB, result.session, Date.now(), langOf(c)) : null;
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
