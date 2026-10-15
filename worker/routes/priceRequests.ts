/**
 * «طلب السعر» — THE CUSTOMER'S DOORS (DECISIONS rows 239 (4) and 240;
 * migration 0193; worker/lib/priceRequests.ts holds the rules).
 *
 *   POST   /api/price-requests          ask for a product's (or a selection's) price
 *   GET    /api/price-requests/mine     my requests (all, or one product's)
 *   PATCH  /api/price-requests/:id      notify me, or not
 *   DELETE /api/price-requests/:id      withdraw
 *
 * SIGNED IN ONLY: a signed-out caller gets 401 and the page sends no request
 * for one (it offers the sign-in sheet). Every answer is `private, no-store`
 * and carries the caller's own rows only — never a count, never anyone else's
 * id (default D11). A request touches no order, cart, wallet, reservation or
 * price: `product_price_requests`, its stats, `rate_limits` and the fence's
 * `ops_guards` scratch rows, nothing else.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, conflict, notFound, requireAuth, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { SESSION_CACHE_CONTROL } from '../lib/edgePolicy';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { PRICE_REQUEST_LIMITS } from '@levonis/contracts/priceRequests';
import { fence, isFenceMiss } from '../lib/operations';
import {
  isMissingPriceRequestTable,
  priceRequestsInstalled,
  rememberPriceRequestsPresent,
  statsRecompute,
  validatePriceRequestSelection,
} from '../lib/priceRequests';

export const priceRequestRoutes = new Hono<AppContext>();
// First, so the 401 of a signed-out caller and every refusal carry it too.
priceRequestRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', SESSION_CACHE_CONTROL);
});
priceRequestRoutes.use('*', requireAuth);

const refusal = (status: number, code: Parameters<typeof serverMessage>[0], details?: Record<string, unknown>) =>
  new HttpError(status, serverMessage(code), code, details);

const unavailable = () => refusal(503, 'PRICE_REQUESTS_UNAVAILABLE');

/** Without 0193 the doors answer 503 (deploy-ahead, CLAUDE.md rule 2). */
async function requireInstalled(c: Context<AppContext>): Promise<void> {
  if (!(await priceRequestsInstalled(c.env.DB))) throw unavailable();
}

/** A read or write that met a missing table mid-flight answers the same 503, never a 500. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (isMissingPriceRequestTable(e)) throw unavailable();
    throw e;
  }
}

const nowIso = () => new Date().toISOString();

/** The caller's own row as the page reads it: no click counter, no cycle, no one else. */
interface MineRow {
  id: string;
  product_id: string;
  product_slug: string | null;
  selection: string;
  state: string;
  notify: number;
  first_requested_at: string;
  requested_at: string;
  priced_at: string;
  notified_at: string;
  closed_at: string;
}
const mineDto = (r: MineRow) => ({
  id: r.id,
  product_id: r.product_id,
  product_slug: r.product_slug ?? '',
  selection: r.selection,
  state: r.state,
  notify: Number(r.notify) === 1,
  first_requested_at: r.first_requested_at,
  requested_at: r.requested_at,
  priced_at: r.priced_at || null,
  notified_at: r.notified_at || null,
  closed_at: r.closed_at || null,
});

// ------------------------------------------------------------------ ask

priceRequestRoutes.post('/', async (c) => {
  await rateLimit(c, 'price-request', 20, 600);
  const user = c.get('user')!;
  await requireInstalled(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(body.product_id, 'product_id', { min: 1, max: 60 });
  // The server never assumes consent (default D10): absent is "do not notify".
  const notifyMe = body.notify === true;
  const rawColor = typeof body.color_id === 'string' && body.color_id ? str(body.color_id, 'color_id', { max: 60 }) : null;
  const rawValues = Array.isArray(body.option_value_ids) ? body.option_value_ids.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 60) : [];
  if (Array.isArray(body.option_value_ids) && rawValues.length !== body.option_value_ids.length) throw refusal(400, 'PRICE_REQUEST_SELECTION_INVALID');

  const db = c.env.DB;
  // Steps 3–6, the one validation the import's `/complete` runs too (worker/lib/priceRequests.ts): VISIBLE only
  // (an invented id and a hidden product answer the same 404 — a request never confirms a draft exists), the
  // selection checked against the product's real options, colours and SKUs, and nothing to ask when priced.
  const verdict = await validatePriceRequestSelection(db, productId, { option_value_ids: rawValues, color_id: rawColor });
  if (!verdict.ok) {
    if (verdict.status === 404) throw notFound('Product not found');
    if (verdict.status === 409) throw refusal(409, verdict.code, { selection: verdict.key });
    throw refusal(400, verdict.code);
  }
  const key = verdict.key;

  return guarded(async () => {
    const before = await db
      .prepare('SELECT id, state FROM product_price_requests WHERE user_id = ? AND product_id = ? AND selection = ?')
      .bind(user.id, productId, key)
      .first<{ id: string; state: string }>();
    rememberPriceRequestsPresent(db);
    const repeat = before?.state === 'open';
    const now = nowIso();
    const id = before?.id ?? newId('prq');
    const openHere =
      "EXISTS (SELECT 1 FROM product_price_requests WHERE user_id = ? AND product_id = ? AND selection = ? AND state = 'open')";
    try {
      await db.batch([
        // At most 50 open requests a person, and 20 open selections a person on one product — unless this
        // very row is already open (a repeat tap is never refused for being one too many).
        ...fence(
          db,
          `(SELECT COUNT(*) FROM product_price_requests WHERE user_id = ? AND state = 'open') < ${PRICE_REQUEST_LIMITS.openPerUser} OR ${openHere}`,
          [user.id, user.id, productId, key]
        ),
        ...fence(
          db,
          `(SELECT COUNT(*) FROM product_price_requests WHERE user_id = ? AND product_id = ? AND state = 'open') < ${PRICE_REQUEST_LIMITS.openPerProduct} OR ${openHere}`,
          [user.id, productId, user.id, productId, key]
        ),
        // ONE ROW per (person, product, selection): a repeat tap is the same row, its click counter + 1;
        // a reopening (after a withdraw or a delivered notice) starts a new cycle and a new request time.
        db
          .prepare(
            `INSERT INTO product_price_requests (id, user_id, product_id, selection, notify, requested_at, last_clicked_at, first_requested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, product_id, selection) DO UPDATE SET
               click_count = click_count + 1,
               last_clicked_at = excluded.last_clicked_at,
               notify = excluded.notify,
               cycle = CASE WHEN state = 'open' THEN cycle ELSE cycle + 1 END,
               requested_at = CASE WHEN state = 'open' THEN requested_at ELSE excluded.requested_at END,
               state = 'open', close_reason = '', closed_at = '', priced_at = '', notified_at = ''`
          )
          .bind(id, user.id, productId, key, notifyMe ? 1 : 0, now, now, now),
        statsRecompute(db, productId, now),
      ]);
    } catch (e) {
      if (isFenceMiss(e)) throw refusal(409, 'PRICE_REQUEST_LIMIT', { max_open: PRICE_REQUEST_LIMITS.openPerUser, max_per_product: PRICE_REQUEST_LIMITS.openPerProduct });
      throw e;
    }
    const saved = await db
      .prepare('SELECT id, notify, requested_at FROM product_price_requests WHERE user_id = ? AND product_id = ? AND selection = ?')
      .bind(user.id, productId, key)
      .first<{ id: string; notify: number; requested_at: string }>();
    return c.json({
      success: true,
      request: {
        id: saved?.id ?? id,
        product_id: productId,
        selection: key,
        state: 'open',
        notify: Number(saved?.notify ?? (notifyMe ? 1 : 0)) === 1,
        requested_at: saved?.requested_at ?? now,
      },
      repeat,
    });
  });
});

// ------------------------------------------------------------------ mine

priceRequestRoutes.get('/mine', async (c) => {
  await rateLimit(c, 'price-request-read', 120, 60);
  const user = c.get('user')!;
  await requireInstalled(c);
  const productId = c.req.query('product_id') ? str(c.req.query('product_id'), 'product_id', { max: 60 }) : '';
  return guarded(async () => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT r.id, r.product_id, p.slug AS product_slug, r.selection, r.state, r.notify, r.first_requested_at,
                r.requested_at, r.priced_at, r.notified_at, r.closed_at
           FROM product_price_requests r LEFT JOIN products p ON p.id = r.product_id
          WHERE r.user_id = ?${productId ? ' AND r.product_id = ?' : ''}
          ORDER BY r.requested_at DESC, r.id DESC LIMIT 100`
      )
      .bind(...(productId ? [user.id, productId] : [user.id]))
      .all<MineRow>();
    return c.json({ success: true, requests: (results ?? []).map(mineDto) });
  });
});

// ------------------------------------------------------------------ notify me / withdraw

priceRequestRoutes.patch('/:id', async (c) => {
  await rateLimit(c, 'price-request-change', 30, 600);
  const user = c.get('user')!;
  await requireInstalled(c);
  const id = str(c.req.param('id'), 'id', { max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.notify !== 'boolean') throw new HttpError(400, 'notify must be true or false', 'VALIDATION');
  return guarded(async () => {
    const res = await c.env.DB
      .prepare("UPDATE product_price_requests SET notify = ? WHERE id = ? AND user_id = ? AND state = 'open'")
      .bind(body.notify ? 1 : 0, id, user.id)
      .run();
    // Someone else's id, a closed request and an unknown id answer alike.
    if (!(Number(res.meta?.changes ?? 0) > 0)) throw notFound('Price request not found');
    return c.json({ success: true, request: { id, notify: body.notify === true, state: 'open' } });
  });
});

priceRequestRoutes.delete('/:id', async (c) => {
  await rateLimit(c, 'price-request-change', 30, 600);
  const user = c.get('user')!;
  await requireInstalled(c);
  const id = str(c.req.param('id'), 'id', { max: 60 });
  return guarded(async () => {
    const db = c.env.DB;
    const row = await db
      .prepare("SELECT product_id FROM product_price_requests WHERE id = ? AND user_id = ? AND state = 'open'")
      .bind(id, user.id)
      .first<{ product_id: string }>();
    if (!row) throw notFound('Price request not found');
    const now = nowIso();
    const [withdraw] = await db.batch([
      db
        .prepare(
          "UPDATE product_price_requests SET state = 'closed', close_reason = 'withdrawn', closed_at = ? WHERE id = ? AND user_id = ? AND state = 'open'"
        )
        .bind(now, id, user.id),
      statsRecompute(db, row.product_id, now),
    ]);
    // A sweep that priced it a moment ago won: the same answer as an unknown id, and the page refreshes.
    if (!(Number(withdraw?.meta?.changes ?? 0) > 0)) throw notFound('Price request not found');
    return c.json({ success: true, request: { id, state: 'closed', close_reason: 'withdrawn' } });
  });
});

/** The refusal a page shows for a full list (exported for the tests' wording checks). */
export const PRICE_REQUEST_LIMIT_ERROR = () => conflict(serverMessage('PRICE_REQUEST_LIMIT'), 'PRICE_REQUEST_LIMIT');
