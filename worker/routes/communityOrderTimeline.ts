/**
 * THE ORDER'S TIMELINE — what happened to a custom order between «قُبل
 * العرض» and «اكتمل», told to its two parties (docs/COMMUNITY_ECOSYSTEM.md
 * §9.5, migration 0160):
 *
 *   POST /api/marketplace/orders/:id/updates
 *        the workshop writes progress | photo | ready | note; the customer
 *        writes modification_request (only before delivery). «ready» stamps
 *        `community_orders.ready_at` and nothing else: NO state moves, NO
 *        money moves — the state machine and the escrow rules in
 *        worker/routes/marketplace.ts are untouched.
 *   GET  /api/marketplace/orders/:id/timeline
 *        the merged record: created/funded (the escrow's own events), started,
 *        every update, delivered, confirmed or auto-completed, dispute and
 *        its decision, completed / refunded / cancelled — each with its actor
 *        AS A ROLE, never an id, and a photo as a URL on this Worker, never a
 *        key.
 *   GET  /api/marketplace/orders/:id/updates/:uid/file
 *        the photo's bytes, for a party of the order, inline (sandboxed).
 *
 * WHO: a party of the order — the customer or the workshop's owner — decided
 * from the order row (`orderForParty`); anyone else gets the 404 every order
 * door gives, so an id from another deal reveals nothing. Every update tells
 * the other side once (`notifyGrouped`, one row per order that comes back
 * unread on each update) and is recorded in the conversation the deal came
 * from when the order has one (`postSystemCard`, D8).
 *
 * Refusals: ORDER_UPDATE_KIND_NOT_ALLOWED, ORDER_UPDATE_TOO_LATE,
 * ORDER_UPDATE_TOO_LONG, ORDER_UPDATE_FILE_NOT_OWNED (src/lib/refusalStrings.ts).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { HttpError, badRequest, conflict, isPlatformAdmin, notFound, requireAuth, str, oneOf, jsonObject } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { ownedFileObject } from '../lib/fileOwnership';
import { ORDER_UPDATE_LIVE_STATES, orderUpdateKeyPrefix } from '../lib/uploadEntity';
import { getMediaObject } from '../lib/mediaStorage';
import { safeFileName } from '../lib/attachments';
import { escrowForOrder } from '../lib/escrowOps';
import { notifyGrouped, stampGroupedCkb } from '../lib/notifications';
import { customOrderCustomerLink } from '../lib/customOrderNotify';
import { customOrderCard, postSystemCard } from '../lib/chatCards';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { merchantHref } from '@levonis/contracts/merchantRoutes';

export const communityOrderTimelineRoutes = new Hono<AppContext>();

const nowIso = () => new Date().toISOString();

// ----------------------------------------------------------------- shapes

export const ORDER_UPDATE_KINDS = ['started', 'progress', 'photo', 'ready', 'note', 'modification_request', 'delivered'] as const;
export type OrderUpdateKind = (typeof ORDER_UPDATE_KINDS)[number];
/** What the workshop may write; the customer writes `modification_request` alone. */
const MERCHANT_KINDS: readonly OrderUpdateKind[] = ['progress', 'photo', 'ready', 'note'];
/** Written by the order's own routes, never by a client. */
type ServerKind = Extract<OrderUpdateKind, 'started' | 'delivered'>;
type ClientKind = Exclude<OrderUpdateKind, ServerKind>;
const isServerKind = (k: OrderUpdateKind): k is ServerKind => k === 'started' || k === 'delivered';
/** The most an update's text carries. */
export const ORDER_UPDATE_MAX = 1000;
/** The states in which the workshop still writes on the timeline (shared with the photo's upload door). */
const LIVE_STATES = ORDER_UPDATE_LIVE_STATES;
/** Before delivery: the customer may still ask for a change. */
const BEFORE_DELIVERY: ReadonlySet<string> = new Set(['funded', 'in_progress']);
/**
 * The newest this many updates are read into the timeline (review
 * 2026-09-30): a party may post 120 an hour, and the page re-reads every
 * 30 s while open, so the read is bounded; `older_updates` says more exist.
 */
export const TIMELINE_UPDATES_MAX = 200;

const REPORT_REASONS = ['spam', 'abuse', 'nudity', 'fraud', 'copyright', 'offtopic', 'other'] as const;

type Role = 'customer' | 'merchant';
type Actor = Role | 'admin' | 'system';

interface OrderRow {
  id: string;
  request_id: string;
  customer_id: string;
  merchant_id: string;
  merchant_user_id: string;
  store_id: string | null;
  state: string;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  chat_id: string | null;
  request_title: string;
  created_at: string;
  started_at?: string | null;
  ready_at?: string | null;
  delivered_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  auto_complete_at: string | null;
  [k: string]: unknown;
}

interface UpdateRow {
  id: string;
  community_order_id: string;
  actor_id: string;
  kind: OrderUpdateKind;
  body: string;
  file_key: string | null;
  created_at: string;
}

const idParam = (c: Context<AppContext>, name = 'id') => str(c.req.param(name), name, { min: 1, max: 60 });

/**
 * Both sides of a community order see the same row, from their own angle —
 * the marketplace's own rule (`loadOrderForParty`): neither party, no order.
 */
async function orderForParty(c: Context<AppContext>, orderId: string): Promise<{ row: OrderRow; role: Role }> {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT o.*, m.user_id AS merchant_user_id, r.title AS request_title
       FROM community_orders o
       JOIN community_merchants m ON m.id = o.merchant_id
       JOIN community_requests r ON r.id = o.request_id
      WHERE o.id = ?`
  )
    .bind(orderId)
    .first<OrderRow>();
  if (!row) throw notFound('Order not found');
  if (row.customer_id === user.id) return { row, role: 'customer' };
  if (row.merchant_user_id === user.id) return { row, role: 'merchant' };
  throw notFound('Order not found');
}

const actorOf = (row: OrderRow, actorId: string | null | undefined): Actor =>
  actorId === row.merchant_user_id ? 'merchant' : actorId === row.customer_id ? 'customer' : actorId ? 'admin' : 'system';

/** An update as a party reads it: the actor as a role, the photo as a URL on this Worker. */
function updatePublic(u: UpdateRow, order: OrderRow) {
  return {
    id: u.id,
    kind: u.kind,
    body: String(u.body ?? ''),
    at: u.created_at,
    actor: actorOf(order, u.actor_id),
    file: u.file_key ? { url: `/api/marketplace/orders/${order.id}/updates/${u.id}/file`, inline: true } : null,
  };
}

/**
 * THE ROW THE ORDER'S OWN ROUTES WRITE — «بدأ التنفيذ» from POST /orders/:id/
 * start (worker/routes/marketplace.ts). Guarded so a replayed start writes
 * one row, whatever the caller did. For a caller's batch or `.run()`.
 */
export function recordOrderEventStatement(
  db: D1Database,
  orderId: string,
  actorId: string,
  kind: Extract<OrderUpdateKind, 'started' | 'delivered'>,
  ts: string = nowIso()
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO community_order_updates (id, community_order_id, actor_id, kind, body, file_key, created_at)
       SELECT ?1, ?2, ?3, ?4, '', NULL, ?5
        WHERE NOT EXISTS (SELECT 1 FROM community_order_updates WHERE community_order_id = ?2 AND kind = ?4)`
    )
    .bind(newId('cou'), orderId, actorId, kind, ts);
}

/** The same, on its own after the move committed; never throws into the route. */
export async function recordOrderEvent(db: D1Database, orderId: string, actorId: string, kind: 'started' | 'delivered', ts?: string): Promise<void> {
  try {
    await recordOrderEventStatement(db, orderId, actorId, kind, ts).run();
  } catch (e) {
    console.error(`order event not recorded (${kind})`, orderId, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------- telling people

const quoteAr = (s: string) => `«${s}»`;
const quoteEn = (s: string) => `“${s}”`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The actor as the bell names them: the row's name (a session may carry none), then the handle. */
async function displayNameOf(db: D1Database, user: SessionUser): Promise<string> {
  const r = await db.prepare('SELECT name, username FROM users WHERE id = ?').bind(user.id).first<{ name: string | null; username: string | null }>();
  return r?.name || user.name || r?.username || user.username || '';
}
const updatesAr = (n: number) => (n === 2 ? 'تحديثان' : n >= 3 && n <= 10 ? `${n} تحديثات` : `${n} تحديثًا`);
const changesAr = (n: number) => (n === 2 ? 'طلبا تعديل' : n >= 3 && n <= 10 ? `${n} طلبات تعديل` : `${n} طلب تعديل`);

const KIND_WORDS: Record<ClientKind, { ar: string; en: string; ckb: string }> = {
  progress: { ar: 'حدّثت الورشة طلبك', en: 'The workshop posted an update on your order', ckb: 'وۆرکشۆپەکە نوێکردنەوەیەکی لەسەر داواکارییەکەت دانا' },
  photo: { ar: 'أرسلت الورشة صورة من العمل على طلبك', en: 'The workshop sent a photo of the work on your order', ckb: 'وۆرکشۆپەکە وێنەیەکی کارەکەی داواکارییەکەتی نارد' },
  ready: { ar: 'طلبك جاهز لدى الورشة', en: 'Your order is ready at the workshop', ckb: 'داواکارییەکەت لە وۆرکشۆپەکە ئامادەیە' },
  note: { ar: 'ملاحظة من الورشة على طلبك', en: 'A note from the workshop on your order', ckb: 'تێبینییەک لە وۆرکشۆپەکەوە لەسەر داواکارییەکەت' },
  modification_request: { ar: 'طلب الزبون تعديلًا على الطلب', en: 'The customer asked for a change on the order', ckb: 'کڕیارەکە داوای گۆڕانکاری لە داواکارییەکە کرد' },
};

/**
 * THE OTHER SIDE HEARS EVERY UPDATE (§9.5): one row per order per recipient
 * (`order_update:<orderId>`) that comes back unread with the latest words on
 * every update — the two parties of an order are exactly who may ring each
 * other's bell about it (`repeatActor: 'bump'`). The customer is sent to the
 * request page, the workshop to the order's workspace address. Sorani is
 * stamped after the upsert. Never throws.
 */
async function tellOtherParty(env: Env, order: OrderRow, role: Role, actor: SessionUser, kind: ClientKind, body: string): Promise<void> {
  try {
    const name = await displayNameOf(env.DB, actor);
    const title = String(order.request_title ?? '');
    const words = KIND_WORDS[kind];
    const excerpt = body ? clip(body, 120) : '';
    const toCustomer = role === 'merchant';
    const written = await notifyGrouped(env.DB, {
      userId: toCustomer ? order.customer_id : order.merchant_user_id,
      kind: 'order_update',
      groupKey: `order_update:${order.id}`,
      actor: { id: actor.id, name },
      repeatActor: 'bump',
      title: (n) => ({
        ar: n === 1 ? `${words.ar} ${quoteAr(title)}` : toCustomer ? `${updatesAr(n)} على طلبك ${quoteAr(title)}` : `${changesAr(n)} من الزبون على ${quoteAr(title)}`,
        en:
          n === 1
            ? `${words.en} ${quoteEn(title)}`
            : toCustomer
              ? `${n} updates on your order ${quoteEn(title)}`
              : `${n} change requests from the customer on ${quoteEn(title)}`,
      }),
      body: { ar: excerpt, en: excerpt },
      link: toCustomer ? `${customOrderCustomerLink(order.request_id)}#timeline` : merchantHref.customOrder(order.id),
      entity_type: 'custom_order',
      entity_id: order.id,
    });
    if (written) {
      await stampGroupedCkb(env.DB, written.id, {
        title_ckb:
          written.count === 1
            ? `${words.ckb} ${quoteAr(title)}`
            : toCustomer
              ? `${written.count} نوێکردنەوە لەسەر داواکارییەکەت ${quoteAr(title)}`
              : `${written.count} داوای گۆڕانکاری لە کڕیارەکەوە لەسەر ${quoteAr(title)}`,
        body_ckb: excerpt,
      });
    }
  } catch (e) {
    console.error('order update notice failed', order.id, kind, e instanceof Error ? e.message : String(e));
  }
}

/**
 * THE CONVERSATION THE DEAL CAME FROM HEARS IT TOO (D8) — one system card per
 * update, only into the thread the order names, only when that thread really
 * is between this store and this customer (`postSystemCard` re-checks), and
 * never able to undo the update. The card's snapshot carries the update's
 * kind and words, so the thread reads them even after the timeline changes.
 */
async function announceOrderUpdate(env: Env, order: OrderRow, actorId: string, u: UpdateRow): Promise<void> {
  if (!order.chat_id) return;
  const base = customOrderCard(order as unknown as Record<string, unknown>, String(order.request_title ?? ''), u.kind);
  await postSystemCard(env, {
    chatId: order.chat_id,
    actorId,
    card: { ...base, snapshot: { ...base.snapshot, update: { id: u.id, kind: u.kind, body: clip(String(u.body ?? ''), 200), has_photo: !!u.file_key } } },
    eventKey: `custom_order:${order.id}:update:${u.id}`,
    expect: { storeId: String(order.store_id ?? ''), customerId: order.customer_id },
  });
}

// ---------------------------------------------------------------- writing

communityOrderTimelineRoutes.post('/orders/:id/updates', requireAuth, async (c) => {
  await rateLimit(c, 'order-update', 120, 3600);
  const user = c.get('user')!;
  const orderId = idParam(c);
  const raw = await jsonObject(c);
  const asked = oneOf(raw.kind, 'kind', ORDER_UPDATE_KINDS);
  // «بدأ» and «سُلِّم» are the order's own moves, written by their routes.
  if (isServerKind(asked)) {
    throw new HttpError(403, 'That event is recorded by the order itself', 'ORDER_UPDATE_KIND_NOT_ALLOWED', { kind: asked, reason: 'SERVER_ONLY' });
  }
  const kind: ClientKind = asked;
  const text = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (text.length > ORDER_UPDATE_MAX) {
    throw badRequest(`An update holds at most ${ORDER_UPDATE_MAX} characters`, 'ORDER_UPDATE_TOO_LONG', { max: ORDER_UPDATE_MAX });
  }
  if ((kind === 'progress' || kind === 'note' || kind === 'modification_request') && !text) throw badRequest('body is required');

  const { row, role } = await orderForParty(c, orderId);
  const state = String(row.state);

  // ---- may THIS side write THIS kind, now -----------------------------------
  const allowed = role === 'merchant' ? MERCHANT_KINDS.includes(kind) : kind === 'modification_request';
  if (!allowed) throw new HttpError(403, 'This side of the order does not write that kind of update', 'ORDER_UPDATE_KIND_NOT_ALLOWED', { kind, role });
  if (kind === 'modification_request') {
    // A change can be asked for while the work is still in the workshop's
    // hands; once it says «سُلِّم» the customer confirms or disputes.
    if (!BEFORE_DELIVERY.has(state)) throw conflict('The order has been delivered — confirm it or open a dispute', 'ORDER_UPDATE_TOO_LATE');
  } else if (!LIVE_STATES.has(state)) {
    throw new HttpError(409, `An order that is ${state} takes no more updates`, 'ORDER_UPDATE_TOO_LATE', { state });
  }
  // «جاهز» is a moment INSIDE the work: it needs work that has started.
  if (kind === 'ready' && state !== 'in_progress') {
    throw new HttpError(403, 'Start the work before marking it ready', 'ORDER_UPDATE_KIND_NOT_ALLOWED', { kind, reason: 'NOT_STARTED' });
  }

  // ---- the photo: the caller's own private upload, filed under THIS order --
  let fileKey: string | null = null;
  if (kind === 'photo') {
    const owned = await ownedFileObject(c.env.DB, raw.file_key, user.id, ['order_update']);
    if (!owned || !owned.key.startsWith(orderUpdateKeyPrefix(orderId)) || owned.kind !== 'image') {
      throw badRequest('That picture is not one of your uploads for this order', 'ORDER_UPDATE_FILE_NOT_OWNED');
    }
    fileKey = owned.key;
  }

  // «جاهز» twice is one event: the first stamp stands, the row is answered again.
  if (kind === 'ready' && row.ready_at) {
    const first = await c.env.DB.prepare(
      `SELECT * FROM community_order_updates WHERE community_order_id = ? AND kind = 'ready' ORDER BY created_at ASC, id ASC LIMIT 1`
    )
      .bind(orderId)
      .first<UpdateRow>();
    if (first) return c.json({ success: true, replayed: true, update: updatePublic(first, row) });
  }

  const id = newId('cou');
  const ts = nowIso();
  /**
   * THE RULE HOLDS IN THE WRITE, NOT ONLY IN THE READ ABOVE (review
   * 2026-09-30). The row is inserted only while the order is STILL in a
   * state that takes this kind — a «سلّمت العمل» or a dispute landing between
   * the read and this batch leaves nothing behind (a change request on a
   * delivered order, a «ready» on a disputed one). «جاهز» is also fenced on
   * being the first, so two at once write one row, and its `ready_at` stamp
   * rides the same condition in the same batch.
   */
  const allowedStates = kind === 'modification_request' ? [...BEFORE_DELIVERY] : kind === 'ready' ? ['in_progress'] : [...LIVE_STATES];
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO community_order_updates (id, community_order_id, actor_id, kind, body, file_key, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
        WHERE EXISTS (SELECT 1 FROM community_orders WHERE id = ?2 AND state IN (SELECT value FROM json_each(?8)))
          AND (?4 <> 'ready' OR NOT EXISTS (SELECT 1 FROM community_order_updates WHERE community_order_id = ?2 AND kind = 'ready'))`
    ).bind(id, orderId, user.id, kind, text, fileKey, ts, JSON.stringify(allowedStates)),
  ];
  if (kind === 'ready') {
    // The stamp and NOTHING else: no state, no money (§9.5) — and only with its row.
    stmts.push(
      c.env.DB.prepare(
        `UPDATE community_orders SET ready_at = COALESCE(ready_at, ?1), updated_at = ?1
          WHERE id = ?2 AND state = 'in_progress' AND EXISTS (SELECT 1 FROM community_order_updates WHERE id = ?3)`
      ).bind(ts, orderId, id)
    );
  }
  const [inserted] = await c.env.DB.batch(stmts);
  if (!Number(inserted?.meta?.changes ?? 0)) {
    // A «ready» that lost to another «ready» is that one, answered again.
    if (kind === 'ready') {
      const first = await c.env.DB.prepare(
        `SELECT * FROM community_order_updates WHERE community_order_id = ? AND kind = 'ready' ORDER BY created_at ASC, id ASC LIMIT 1`
      )
        .bind(orderId)
        .first<UpdateRow>();
      if (first) return c.json({ success: true, replayed: true, update: updatePublic(first, row) });
    }
    const now = await c.env.DB.prepare('SELECT state FROM community_orders WHERE id = ?').bind(orderId).first<{ state: string }>();
    const moved = String(now?.state ?? state);
    throw new HttpError(409, `An order that is ${moved} takes no more updates of this kind`, 'ORDER_UPDATE_TOO_LATE', { state: moved });
  }
  await audit(c.env.DB, user.id, 'community.order_update', orderId, { kind, update_id: id, by: role });

  const made: UpdateRow = { id, community_order_id: orderId, actor_id: user.id, kind, body: text, file_key: fileKey, created_at: ts };
  await tellOtherParty(c.env, row, role, user, kind, text);
  await announceOrderUpdate(c.env, row, user.id, made);
  return c.json({ success: true, update: updatePublic(made, row) }, 201);
});

// ---------------------------------------------------------------- reading

interface TimelineEvent {
  kind: string;
  at: string;
  actor: Actor;
  id?: string;
  body?: string;
  file?: { url: string; inline: boolean } | null;
  amount_iqd?: number;
}

/**
 * THE MERGED TIMELINE: the escrow's own events (created, held, release,
 * refund, dispute_open, dispute_resolve, cancel — worker/lib/escrowOps.ts),
 * the order's instants (started, delivered, confirmed, completed, cancelled)
 * and every update row, in time order. A fact the escrow records is not
 * repeated from the order's columns, and an instant a row records («started»
 * since 0160) is not repeated from its column.
 */
async function mergedTimeline(env: Env, row: OrderRow): Promise<{ events: TimelineEvent[]; olderUpdates: boolean }> {
  // ONE WAVE after the order (review 2026-09-30): the escrow, its events (joined
  // through the order, not keyed on the escrow's id read first) and the newest
  // TIMELINE_UPDATES_MAX updates (+1 to know whether older ones exist). Two
  // rows of one millisecond keep the order they were written in (rowid), never
  // their random ids — the discussion's rule too.
  const [escrow, { results: newest }, { results: escrowRows }] = await Promise.all([
    escrowForOrder(env.DB, row.id),
    env.DB.prepare('SELECT * FROM community_order_updates WHERE community_order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .bind(row.id, TIMELINE_UPDATES_MAX + 1)
      .all<UpdateRow>(),
    env.DB.prepare(
      `SELECT e.kind, e.amount_iqd, e.actor_role, e.created_at
         FROM community_escrow_events e JOIN community_escrows x ON x.id = e.escrow_id
        WHERE x.community_order_id = ?
        ORDER BY e.created_at ASC, e.rowid ASC`
    )
      .bind(row.id)
      .all<{ kind: string; amount_iqd: number; actor_role: string; created_at: string }>(),
  ]);
  const olderUpdates = (newest ?? []).length > TIMELINE_UPDATES_MAX;
  const updates = (newest ?? []).slice(0, TIMELINE_UPDATES_MAX).reverse();
  const escrowEvents = escrowRows ?? [];

  const events: TimelineEvent[] = [{ kind: 'created', at: row.created_at, actor: 'customer' }];
  const roleOf = (r: string): Actor => (r === 'customer' || r === 'merchant' || r === 'admin' ? r : 'system');
  const seen = new Set<string>();
  for (const e of escrowEvents) {
    const map: Record<string, string> = {
      held: 'funded',
      release: 'released',
      refund: 'refunded',
      dispute_open: 'dispute',
      dispute_resolve: 'dispute_resolved',
      cancel: 'cancelled',
    };
    const kind = map[e.kind];
    if (!kind) continue;
    seen.add(kind);
    events.push({ kind, at: e.created_at, actor: roleOf(e.actor_role), ...(e.kind === 'release' || e.kind === 'refund' ? { amount_iqd: Number(e.amount_iqd ?? 0) } : {}) });
  }
  if (!seen.has('funded') && escrow?.held_at) events.push({ kind: 'funded', at: escrow.held_at, actor: 'customer' });

  const rowKinds = new Set(updates.map((u) => u.kind));
  for (const u of updates) events.push({ ...updatePublic(u, row), kind: u.kind });
  if (!rowKinds.has('started') && row.started_at) events.push({ kind: 'started', at: row.started_at, actor: 'merchant' });
  if (!rowKinds.has('delivered') && row.delivered_at) events.push({ kind: 'delivered', at: row.delivered_at, actor: 'merchant' });
  if (row.confirmed_at) {
    // The customer's confirmation IS the release (worker/routes/marketplace.ts
    // /confirm: the escrow moves first, the order is stamped after): one act,
    // told in its own order — confirmed, then the money.
    const release = events.find((e) => e.kind === 'released' && e.actor === 'customer');
    const at = release && release.at < row.confirmed_at ? release.at : row.confirmed_at;
    events.push({ kind: 'confirmed', at, actor: 'customer' });
  }
  if (row.completed_at) events.push({ kind: 'completed', at: row.completed_at, actor: row.confirmed_at ? 'customer' : 'system' });
  if (row.cancelled_at) {
    // Who cancelled is what the refund event recorded (the same batch); an
    // order cancelled with no escrow to refund was closed by the platform.
    const money = events.find((e) => e.kind === 'refunded' || e.kind === 'cancelled');
    if (!seen.has('cancelled')) events.push({ kind: 'cancelled', at: row.cancelled_at, actor: money?.actor ?? 'system' });
  }
  if (row.state === 'disputed' && !seen.has('dispute')) events.push({ kind: 'dispute', at: String(row.updated_at ?? row.created_at), actor: 'system' });

  // Time order; two instants of one act (the same millisecond, or a batch's
  // stamp beside the escrow's) fall into the order the act has.
  return { events: events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rankOf(a.kind) - rankOf(b.kind))), olderUpdates };
}

/**
 * The order events of one act take when they share an instant: the act, then
 * the money. A cancel is stamped by the route's clock and its refund by the
 * escrow's, so the two can land on one millisecond — «cancelled» ranks before
 * «refunded» (review 2026-09-30; it used to rank after, and the timeline read
 * «refunded, cancelled» whenever the clocks tied).
 */
const EVENT_RANK: Record<string, number> = {
  created: 0, funded: 1, started: 2,
  progress: 3, photo: 3, ready: 3, note: 3, modification_request: 3,
  delivered: 4, confirmed: 5, dispute: 5, cancelled: 5.5, released: 6, refunded: 6, dispute_resolved: 6, completed: 8,
};
const rankOf = (kind: string) => EVENT_RANK[kind] ?? 3;

communityOrderTimelineRoutes.get('/orders/:id/timeline', requireAuth, async (c) => {
  const orderId = idParam(c);
  const { row, role } = await orderForParty(c, orderId);
  const { events: timeline, olderUpdates } = await mergedTimeline(c.env, row);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    role,
    order: {
      id: row.id,
      request_id: row.request_id,
      request_title: row.request_title,
      state: row.state,
      price_iqd: Number(row.price_iqd ?? 0),
      completion_days: Number(row.completion_days ?? 0),
      delivery_method: String(row.delivery_method ?? ''),
      created_at: row.created_at,
      started_at: row.started_at ?? null,
      ready_at: row.ready_at ?? null,
      delivered_at: row.delivered_at ?? null,
      confirmed_at: row.confirmed_at ?? null,
      completed_at: row.completed_at ?? null,
      cancelled_at: row.cancelled_at ?? null,
      auto_complete_at: row.auto_complete_at ?? null,
      chat_id: row.chat_id ?? null,
    },
    timeline,
    /** More updates exist than the newest `TIMELINE_UPDATES_MAX` the timeline carries. */
    older_updates: olderUpdates,
    /** What this side may write next — a hint; the POST decides again. */
    can: {
      update: role === 'merchant' && LIVE_STATES.has(String(row.state)),
      ready: role === 'merchant' && row.state === 'in_progress' && !row.ready_at,
      modification_request: role === 'customer' && BEFORE_DELIVERY.has(String(row.state)),
    },
  });
});

/**
 * WHO MAY OPEN AN UPDATE'S PHOTO: a party of the order — or the desk, for an
 * update somebody REPORTED (review 2026-09-30). A report of a private photo
 * the reviewer cannot open is a report nobody can decide; the staff read is
 * a platform admin on the admin host (`isPlatformAdmin`), only for a reported
 * update, and audited like a staff read of a chat. Anyone else: the 404
 * every order door gives.
 */
async function fileReaderOrder(c: Context<AppContext>, orderId: string, uid: string): Promise<OrderRow> {
  if (isPlatformAdmin(c)) {
    const row = await c.env.DB.prepare(
      `SELECT o.*, m.user_id AS merchant_user_id, r.title AS request_title
         FROM community_orders o
         JOIN community_merchants m ON m.id = o.merchant_id
         JOIN community_requests r ON r.id = o.request_id
        WHERE o.id = ?1
          AND (o.customer_id = ?3 OR m.user_id = ?3
               OR EXISTS (SELECT 1 FROM community_report_targets t WHERE t.kind = 'order_update' AND t.target_id = ?2))`
    )
      .bind(orderId, uid, c.get('user')!.id)
      .first<OrderRow>();
    if (!row) throw notFound('File not found');
    if (row.customer_id !== c.get('user')!.id && row.merchant_user_id !== c.get('user')!.id) {
      await audit(c.env.DB, c.get('user')!.id, 'admin.order_update_file_read', orderId, { update_id: uid, reported: true });
    }
    return row;
  }
  return (await orderForParty(c, orderId)).row;
}

/**
 * THE PHOTO'S BYTES, for a party of the order — never a key, never public.
 * Inline for a picture (it is one: the upload door admits images alone under
 * this purpose), sandboxed with `nosniff` and a CSP so a file that somehow
 * passed classification cannot run as script, and never cached.
 */
communityOrderTimelineRoutes.get('/orders/:id/updates/:uid/file', requireAuth, async (c) => {
  const orderId = idParam(c);
  const uid = idParam(c, 'uid');
  const row = await fileReaderOrder(c, orderId, uid);
  const u = await c.env.DB.prepare(
    `SELECT u.file_key, u.created_at, f.mime_type, f.original_name
       FROM community_order_updates u
       LEFT JOIN file_objects f ON f.object_key = u.file_key
      WHERE u.id = ? AND u.community_order_id = ? AND u.file_key IS NOT NULL`
  )
    .bind(uid, row.id)
    .first<{ file_key: string; created_at: string; mime_type: string | null; original_name: string | null }>();
  if (!u) throw notFound('File not found');
  const obj = await getMediaObject(c.env, 'private', u.file_key);
  if (!obj) throw notFound('File not found');
  const mime = u.mime_type && u.mime_type.startsWith('image/') ? u.mime_type : 'application/octet-stream';
  const ext = u.file_key.includes('.') ? u.file_key.slice(u.file_key.lastIndexOf('.') + 1) : 'bin';
  const name = safeFileName(u.original_name || `update-${uid}.${ext}`, ext);
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Disposition': `${mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  if (obj.httpEtag) headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
});

// --------------------------------------------------------------- reporting

/**
 * «إبلاغ» ON AN UPDATE, by the other party. Filed under target_type 'request'
 * (the 0154 CHECK is kept) and resolved to the update row by
 * `community_report_targets` (kind order_update) in the same batch. The
 * report's `target_id` is the UPDATE's id (review 2026-09-30): filed under
 * the request id, the (reporter, type, target) uniqueness let one reporter
 * report ONE update per order, and a second — the abusive photo after a
 * reported note — answered as a replay of the first and reached nobody.
 */
communityOrderTimelineRoutes.post('/orders/:id/updates/:uid/report', requireAuth, async (c) => {
  await rateLimit(c, 'report', 20, 3600);
  const user = c.get('user')!;
  const orderId = idParam(c);
  const uid = idParam(c, 'uid');
  const raw = await jsonObject(c);
  const reason = oneOf(raw.reason, 'reason', REPORT_REASONS);
  const details = str(raw.details, 'details', { min: 0, max: 1000, required: false });
  const { row } = await orderForParty(c, orderId);
  const target = await c.env.DB.prepare(
    `SELECT id FROM community_order_updates WHERE id = ? AND community_order_id = ? AND actor_id <> ? AND kind NOT IN ('started','delivered')`
  )
    .bind(uid, orderId, user.id)
    .first<{ id: string }>();
  if (!target) throw new HttpError(404, 'We could not find what you are reporting', 'REPORT_TARGET_NOT_FOUND');

  const reportId = newId('rpt');
  const [ins] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO community_reports (id, reporter_id, target_type, target_id, reason, details) VALUES (?, ?, 'request', ?, ?, ?)
       ON CONFLICT(reporter_id, target_type, target_id) DO NOTHING`
    ).bind(reportId, user.id, uid, reason, details),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO community_report_targets (report_id, kind, target_id)
       SELECT ?1, 'order_update', ?2 WHERE EXISTS (SELECT 1 FROM community_reports WHERE id = ?1)`
    ).bind(reportId, uid),
  ]);
  if (!Number(ins.meta.changes ?? 0)) {
    const existing = await c.env.DB.prepare(`SELECT id FROM community_reports WHERE reporter_id = ? AND target_type = 'request' AND target_id = ?`)
      .bind(user.id, uid)
      .first<{ id: string }>();
    return c.json({ success: true, report_id: existing?.id ?? null, replayed: true });
  }
  await audit(c.env.DB, user.id, 'community.report', reportId, { target_type: 'request', target_id: uid, real: 'order_update', update_id: uid, order_id: orderId, request_id: row.request_id, reason });
  announceAfterResponse(
    c,
    'report',
    `🚩 بلاغ جديد في المجتمع` + `\nType: order_update` + `\nTarget: ${uid}` + `\nOrder: ${orderId}` + `\nReason: ${reason}` + `\nReport: ${reportId}`
  );
  return c.json({ success: true, report_id: reportId }, 201);
});
