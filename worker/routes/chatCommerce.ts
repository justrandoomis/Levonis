/**
 * CUSTOM WORK IN THE STORE'S CONVERSATION — /api/chats/:id/…
 * (docs/COMMUNITY_COMMERCE_CHAT.md §2 D3–D5, D9; §5).
 *
 *   POST  /:id/print-requests              the customer drafts a print request to THIS store
 *   POST  /:id/print-requests/:rid/send    …and sends it (files attached in between through
 *                                          the request's own file route) — its card lands
 *   POST  /:id/quotes                      the store quotes: a request of the thread, or —
 *                                          with no request — the customer's request it makes
 *   PATCH /:id/quotes/:offerId             the store edits its quote: a new revision, a new card
 *   GET   /:id/orders                      this store × this customer's orders, both flows
 *
 * NOTHING HERE IS A SECOND MARKETPLACE. A print request is a `community_requests`
 * row addressed to one store (0151), a quote is a `community_offers` row with
 * revisions, and ACCEPTANCE IS THE EXISTING DOOR — `POST /api/marketplace/
 * offers/:id/accept`, which holds the money and freezes the quote in one fenced
 * batch. Withdrawing, declining, cancelling and every order step after it are
 * the existing doors too. What this file adds is the way into that flow from a
 * conversation, and the cards that show it there.
 *
 * WHO. Only the thread's customer sends print requests; only its store quotes
 * (the selling gate every offer passes, and the plan's community-offers
 * benefit); nobody else in or outside the thread does either. Ids come from
 * the thread and the session, never the body: a quote's customer is the
 * thread's customer, its store is the thread's store.
 *
 * THE GATE (D9). Starting custom work is Levo Community's and follows its
 * maintenance switch, like the board's create doors; acceptance and every
 * order step stay open, as they are today.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, conflict, forbidden, str, int, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { getSetting } from '../lib/settings';
import { requireCommunityOpen } from '../lib/communityGate';
import { requireOfferPrivileges, storeById } from '../lib/merchantAuth';
import { benefits, getTierStatus } from '../lib/entitlements';
import { isConstraintAbort } from '../lib/walletOps';
import { DRAFT_TTL_DAYS, composeSnapshot, recordOfferRevisionStatement, recordRevisionStatement } from '../lib/requestRevisions';
import { merchantTakesNewWork, offerCountStatement } from '../lib/communityRequests';
import { assertDirectStanding, directRequest } from '../lib/directRequests';
import { storeThreadOf, threadRole, type StoreThread } from '../lib/chatThread';
import { cardInsertStatement, notInThread, printRequestCard, quoteCardFrom, stampThreadActivity } from '../lib/chatCards';
import { assertMayWriteInThread, notifyStoreThread, publicPage } from './chats';
import { offerShape, publicRequest, readOfferTerms } from './marketplace';

export const chatCommerceRoutes = new Hono<AppContext>();
chatCommerceRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

/**
 * THE STORE'S CONVERSATION WITH ITS CUSTOMER, AND THIS CALLER ON THE RIGHT SIDE
 * OF IT. Custom work starts in the store thread (D1) — never in a personal DM,
 * and not in an order's or a board request's thread, which are about something
 * already under way.
 */
async function storeThreadFor(c: Context<AppContext>, chatId: string, side: 'customer' | 'merchant'): Promise<StoreThread> {
  const user = c.get('user')!;
  await assertMayWriteInThread(c.env.DB, chatId, user.id);
  const thread = await storeThreadOf(c.env.DB, chatId);
  if (!thread || thread.context_type !== 'store') {
    throw badRequest('This is done in your conversation with the store', 'CARD_NOT_ALLOWED_HERE');
  }
  if (threadRole(thread, user.id) !== side) {
    throw new HttpError(
      403,
      side === 'merchant' ? 'Only the store sends quotes here' : 'Only the customer sends print requests here',
      'CARD_NOT_ALLOWED'
    );
  }
  return thread;
}

/** How long a request addressed to a store stays open — the board's own setting. */
async function requestExpiry(db: D1Database): Promise<string> {
  const days = Number(await getSetting(db, 'communityRequestExpiryDays')) || 30;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** The job fields a print request (or a store's quote without one) carries — the board's own limits. */
function readJob(body: Record<string, unknown>, opts: { descriptionRequired: boolean }) {
  return {
    title: str(body.title, 'title', { min: 4, max: 140 }),
    description: str(body.description, 'description', { min: opts.descriptionRequired ? 10 : 0, max: 6000, required: opts.descriptionRequired }),
    category: str(body.category, 'category', { min: 0, max: 60, required: false }),
    quantity: int(body.quantity, 'quantity', { min: 1, max: 100_000, def: 1 }),
    material: str(body.material, 'material', { min: 0, max: 60, required: false }),
    color: str(body.color, 'color', { min: 0, max: 60, required: false }),
    dimensions: str(body.dimensions, 'dimensions', { min: 0, max: 120, required: false }),
    budget_iqd:
      body.budget_iqd === undefined || body.budget_iqd === null || body.budget_iqd === ''
        ? null
        : int(body.budget_iqd, 'budget_iqd', { min: 0, max: 1_000_000_000 }),
    deadline: str(body.deadline, 'deadline', { min: 0, max: 40, required: false }) || null,
    governorate: str(body.governorate, 'governorate', { min: 0, max: 60, required: false }),
    delivery_pref: str(body.delivery_pref, 'delivery_pref', { min: 0, max: 40, required: false }),
    customer_notes: str(body.customer_notes, 'customer_notes', { min: 0, max: 1000, required: false }),
  };
}

/** The card message a thread already carries for an entity, in the read path's shape — the answer to a replay. */
async function existingCard(c: Context<AppContext>, chatId: string, type: string, ref: string) {
  const row = await c.env.DB.prepare(
    'SELECT * FROM chat_messages WHERE chat_id = ? AND card_type = ? AND card_ref = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(chatId, type, ref)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const [message] = await publicPage(c.env, chatId, [row], c.get('user')!.id, false);
  return message;
}

/** After a card landed: the thread moved, and the other side hears it once per turn. Never throws. */
async function afterCard(c: Context<AppContext>, thread: StoreThread, chatId: string, messageId: string, at: string): Promise<void> {
  await stampThreadActivity(c.env.DB, chatId, at);
  await notifyStoreThread(c.env, thread, chatId, c.get('user')!.id, messageId).catch(() => {});
}

// ================================================================ print requests

/**
 * «طلب طباعة» — the customer drafts a request TO THIS STORE. A draft, like the
 * print wizard's: invisible to everyone but its customer until it is sent, so
 * its files can be attached first through `POST /api/marketplace/requests/:id/
 * files` (which sniffs the bytes and keeps them private). The store must take
 * custom requests and new work — the customer is told now, not after writing
 * the whole job.
 */
chatCommerceRoutes.post('/:id/print-requests', requireCommunityOpen, async (c) => {
  await rateLimit(c, 'chat-print-request', 10, 3600);
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const thread = await storeThreadFor(c, chatId, 'customer');
  const ctx = await storeById(c.env.DB, thread.store_id);
  if (!ctx || Number(ctx.store.accepts_custom_requests) !== 1) {
    throw conflict('This store is not taking custom requests right now', 'STORE_NO_CUSTOM_REQUESTS');
  }
  const takes = await merchantTakesNewWork(c.env.DB, {
    merchantStatus: ctx.merchant.status,
    storeStatus: ctx.store.status,
    ownerUserId: ctx.store.user_id,
  });
  if (!takes) throw conflict('This store is not taking new work right now', 'MERCHANT_UNAVAILABLE');

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const job = readJob(body, { descriptionRequired: true });
  const id = newId('req');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO community_requests
       (id, customer_id, title, description, status, state, category, quantity, material, color,
        dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility,
        created_at, expires_at, updated_at, customer_notes, target_merchant_id, origin_chat_id, created_by)
     VALUES (?,?,?,?,'closed','draft',?,?,?,?,?,?,?,?,?,'','direct',?,?,?,?,?,?,'customer')`
  )
    .bind(
      id, user.id, job.title, job.description, job.category, job.quantity, job.material, job.color,
      job.dimensions, job.budget_iqd, job.deadline, job.governorate, job.delivery_pref,
      ts, new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString(), ts, job.customer_notes,
      thread.merchant_id, chatId
    )
    .run();
  await audit(c.env.DB, user.id, 'community.direct_request_drafted', id, { store: thread.store_id, chat: chatId });
  const row = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, request: publicRequest(row!) }, 201);
});

/**
 * «إرسال» — the draft becomes an open request addressed to the store, and its
 * card lands in the conversation IN THE SAME BATCH (the card is written only if
 * the request really moved). Sending twice answers the card already there.
 */
chatCommerceRoutes.post('/:id/print-requests/:rid/send', requireCommunityOpen, async (c) => {
  await rateLimit(c, 'chat-print-request', 10, 3600);
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const requestId = str(c.req.param('rid'), 'rid', { min: 1, max: 60 });
  const thread = await storeThreadFor(c, chatId, 'customer');
  const r = await directRequest(c.env.DB, requestId);
  if (!r || r.customer_id !== user.id || r.origin_chat_id !== chatId || r.target_merchant_id !== thread.merchant_id) {
    throw notInThread('This request');
  }
  if (r.state !== 'draft') {
    const sent = await existingCard(c, chatId, 'print_request', requestId);
    if (sent) return c.json({ success: true, message: sent, replayed: true });
    throw conflict('This request was already sent', 'REQUEST_NOT_DRAFT');
  }
  const ctx = await storeById(c.env.DB, thread.store_id);
  const takes = !!ctx && (await merchantTakesNewWork(c.env.DB, {
    merchantStatus: ctx.merchant.status,
    storeStatus: ctx.store.status,
    ownerUserId: ctx.store.user_id,
  }));
  if (!takes) throw conflict('This store is not taking new work right now', 'MERCHANT_UNAVAILABLE');

  const card = await printRequestCard(c.env.DB, requestId);
  const ts = nowIso();
  const expires = await requestExpiry(c.env.DB);
  const messageId = newId('msg');
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_requests SET state = 'open', status = 'open', expires_at = ?, updated_at = ?
        WHERE id = ? AND customer_id = ? AND state = 'draft' AND visibility = 'direct'`
    ).bind(expires, ts, requestId, user.id),
    cardInsertStatement(
      c.env.DB,
      { id: messageId, chatId, senderId: user.id, card, createdAt: ts },
      { sql: `EXISTS (SELECT 1 FROM community_requests WHERE id = ? AND state = 'open' AND updated_at = ?)`, binds: [requestId, ts] }
    ),
  ]);
  if (!Number(res[0]?.meta.changes ?? 0)) throw conflict('This request changed while you were sending it — reload it', 'REQUEST_CHANGED');
  // The job as sent is revision 1 of its record — what an accepted quote freezes.
  const snap = await composeSnapshot(c.env.DB, requestId).catch(() => null);
  if (snap) await recordRevisionStatement(c.env.DB, requestId, snap, 'publish', user.id, ts).run().catch(() => {});
  await audit(c.env.DB, user.id, 'community.direct_request_sent', requestId, { store: thread.store_id, chat: chatId });
  await afterCard(c, thread, chatId, messageId, ts);
  const message = await existingCard(c, chatId, 'print_request', requestId);
  const row = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
  return c.json({ success: true, request: publicRequest(row!), message }, 201);
});

// ================================================================ quotes

/** The request a quote prices — its job fields, for the card. */
async function jobOf(db: D1Database, requestId: string) {
  return db
    .prepare('SELECT id, title, quantity, material, color, revision, customer_id FROM community_requests WHERE id = ?')
    .bind(requestId)
    .first<{ id: string; title: string; quantity: number; material: string; color: string; revision: number; customer_id: string }>();
}

/** The store behind this quote, taking new commitments — the gate every offer passes. */
async function quotingStore(c: Context<AppContext>, thread: StoreThread) {
  const ctx = await requireOfferPrivileges(c);
  // Belt and braces: the thread's store IS the caller's (threadRole said so).
  if (ctx.merchant.id !== thread.merchant_id) throw forbidden('This conversation belongs to another store');
  const tier = await getTierStatus(c.env.DB, c.get('user')!.id);
  if (!benefits.communityOffers(tier)) throw forbidden('Your plan does not include community offers');
  return ctx;
}

/**
 * «عرض سعر» — the store quotes, in its conversation with the customer.
 *
 * With `request_id`: a request of THIS thread's customer addressed to this
 * store (the customer's «طلب طباعة»). Without one (D5): the quote makes the
 * customer's request from what the store wrote — owned by the customer, seen by
 * nobody else, costing nothing — and the customer's acceptance is the consent.
 *
 * The offer, its first revision, the request's move and the card are ONE batch,
 * the offer fenced on the request still being this store's, open and unexpired
 * (0151's trigger refuses any other store's offer even if a route forgot).
 */
chatCommerceRoutes.post('/:id/quotes', requireCommunityOpen, async (c) => {
  await rateLimit(c, 'chat-quote', 40, 3600);
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const thread = await storeThreadFor(c, chatId, 'merchant');
  const ctx = await quotingStore(c, thread);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ts = nowIso();
  const terms = await readOfferTerms(c.env.DB, body, ts, { partial: false });
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];

  let requestId = str(body.request_id, 'request_id', { max: 60, required: false });
  let job: { title: string; quantity: number; material: string; color: string; revision: number };
  if (requestId) {
    const r = await assertDirectStanding(c.env, requestId, ctx.merchant.id);
    if (r.customer_id !== thread.customer_id) throw notInThread('This request');
    const row = await jobOf(db, requestId);
    if (!row) throw notInThread('This request');
    job = { title: row.title, quantity: Number(row.quantity) || 1, material: row.material ?? '', color: row.color ?? '', revision: Number(row.revision ?? 1) };
  } else {
    const j = readJob(body, { descriptionRequired: false });
    requestId = newId('req');
    job = { title: j.title, quantity: j.quantity, material: j.material, color: j.color, revision: 1 };
    stmts.push(
      db.prepare(
        `INSERT INTO community_requests
           (id, customer_id, title, description, status, state, category, quantity, material, color,
            dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility,
            created_at, expires_at, updated_at, customer_notes, target_merchant_id, origin_chat_id, created_by)
         VALUES (?,?,?,?,'open','open',?,?,?,?,?,NULL,?,'','','','direct',?,?,?,'',?,?,'merchant')`
      ).bind(
        requestId, thread.customer_id, j.title, j.description || terms.message || j.title, j.category, j.quantity,
        j.material, j.color, j.dimensions, j.deadline, ts, await requestExpiry(db), ts, ctx.merchant.id, chatId
      )
    );
  }

  const offerId = newId('off');
  const offerAt = stmts.length; // the offer INSERT's position in the batch
  stmts.push(
    db.prepare(
      `INSERT INTO community_offers
         (id, request_id, merchant_id, store_id, price_iqd, completion_days, delivery_method,
          message, materials, included, warranty_terms, state, expires_at, revision, request_revision,
          created_at, updated_at, material_ids)
       SELECT ?1, r.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, 1, r.revision, ?12, ?12, ?15
         FROM community_requests r
        WHERE r.id = ?13 AND r.visibility = 'direct' AND r.target_merchant_id = ?2
          AND r.state IN ('open','receiving_offers') AND r.customer_id <> ?14
          AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?12)`
    ).bind(
      offerId, ctx.merchant.id, ctx.store.id, terms.price_iqd!,
      terms.completion_days ?? 0, terms.delivery_method ?? '', terms.message ?? '', terms.materials ?? '',
      terms.included ?? '', terms.warranty_terms ?? '',
      terms.expires_at ?? null, ts, requestId, user.id, JSON.stringify(terms.material_ids ?? [])
    ),
    db.prepare(
      `UPDATE community_requests
          SET state = CASE WHEN state = 'open' THEN 'receiving_offers' ELSE state END, updated_at = ?
        WHERE id = ? AND state IN ('open','receiving_offers') AND EXISTS (SELECT 1 FROM community_offers WHERE id = ?)`
    ).bind(ts, requestId, offerId),
    recordOfferRevisionStatement(db, offerId, 'create'),
    offerCountStatement(db, requestId)
  );
  const card = quoteCardFrom({
    offer_id: offerId, request_id: requestId, revision: 1, request_revision: job.revision,
    title: job.title, quantity: job.quantity, material: job.material, color: job.color,
    price_iqd: terms.price_iqd!, completion_days: terms.completion_days ?? 0, delivery_method: terms.delivery_method ?? '',
    message: terms.message ?? '', materials: terms.materials ?? '', included: terms.included ?? '',
    warranty_terms: terms.warranty_terms ?? '', expires_at: terms.expires_at ?? null,
  });
  const messageId = newId('msg');
  stmts.push(
    cardInsertStatement(
      db,
      { id: messageId, chatId, senderId: user.id, card, createdAt: ts },
      { sql: 'EXISTS (SELECT 1 FROM community_offers WHERE id = ?)', binds: [offerId] }
    )
  );

  let inserted = 0;
  try {
    const res = await db.batch(stmts);
    inserted = Number(res[offerAt]?.meta.changes ?? 0);
  } catch (e) {
    // The one-live-offer index: this store already has a quote on this request.
    if (isConstraintAbort(e) && /UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
      throw conflict('You already have a quote on this request — edit it instead', 'OFFER_EXISTS');
    }
    throw e;
  }
  if (!inserted) throw conflict('This request changed while you were quoting — reload it', 'REQUEST_CHANGED');

  await audit(db, user.id, 'community.offer_created', offerId, { request: requestId, price: terms.price_iqd, direct: true, chat: chatId });
  await afterCard(c, thread, chatId, messageId, ts);
  const row = await db.prepare('SELECT * FROM community_offers WHERE id = ?').bind(offerId).first<Record<string, unknown>>();
  const message = await existingCard(c, chatId, 'quote', offerId);
  return c.json({ success: true, offer: offerShape(row!), request_id: requestId, message }, 201);
});

/**
 * THE STORE EDITS ITS QUOTE — a NEW REVISION (audit 03 §10 B, 0130), never an
 * overwrite of what the customer saw: the offer moves to revision + 1 and a
 * new card carries it, fenced on the revision the store was editing; the older
 * card says «تم تحديث العرض» and loses its buttons, and an acceptance of the
 * older revision is refused `OFFER_CHANGED` by the existing door. An accepted
 * quote is the contract and cannot be edited at all.
 */
chatCommerceRoutes.patch('/:id/quotes/:offerId', requireCommunityOpen, async (c) => {
  await rateLimit(c, 'chat-quote', 40, 3600);
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  const offerId = str(c.req.param('offerId'), 'offerId', { min: 1, max: 60 });
  const thread = await storeThreadFor(c, chatId, 'merchant');
  const ctx = await quotingStore(c, thread);
  const db = c.env.DB;
  const before = await db
    .prepare(
      `SELECT o.*, r.title AS r_title, r.quantity AS r_quantity, r.material AS r_material, r.color AS r_color,
              r.revision AS r_revision, r.customer_id, r.visibility
         FROM community_offers o JOIN community_requests r ON r.id = o.request_id
        WHERE o.id = ? AND o.merchant_id = ?`
    )
    .bind(offerId, ctx.merchant.id)
    .first<Record<string, unknown>>();
  if (!before || before.visibility !== 'direct' || before.customer_id !== thread.customer_id) throw notInThread('This quote');
  if (before.state !== 'pending' && before.state !== 'superseded') {
    throw conflict('That quote can no longer be changed', 'OFFER_NOT_AVAILABLE');
  }
  await assertDirectStanding(c.env, String(before.request_id), ctx.merchant.id);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ts = nowIso();
  const t = await readOfferTerms(db, body, ts, { partial: true });
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (t.price_iqd !== undefined) put('price_iqd', t.price_iqd);
  if (t.completion_days !== undefined) put('completion_days', t.completion_days);
  if (t.delivery_method !== undefined) put('delivery_method', t.delivery_method);
  if (t.message !== undefined) put('message', t.message);
  if (t.materials !== undefined) put('materials', t.materials);
  if (t.included !== undefined) put('included', t.included);
  if (t.warranty_terms !== undefined) put('warranty_terms', t.warranty_terms);
  if (t.material_ids !== undefined) put('material_ids', JSON.stringify(t.material_ids));
  if (t.expires_at !== undefined) put('expires_at', t.expires_at);
  if (!sets.length) throw badRequest('Nothing to update');

  const fromRevision = Number(before.revision ?? 1);
  const next = fromRevision + 1;
  const merged = {
    price_iqd: t.price_iqd ?? Number(before.price_iqd),
    completion_days: t.completion_days ?? Number(before.completion_days ?? 0),
    delivery_method: t.delivery_method ?? String(before.delivery_method ?? ''),
    message: t.message ?? String(before.message ?? ''),
    materials: t.materials ?? String(before.materials ?? ''),
    included: t.included ?? String(before.included ?? ''),
    warranty_terms: t.warranty_terms ?? String(before.warranty_terms ?? ''),
    expires_at: t.expires_at !== undefined ? t.expires_at : ((before.expires_at as string | null) ?? null),
  };
  const card = quoteCardFrom({
    offer_id: offerId, request_id: String(before.request_id), revision: next, request_revision: Number(before.r_revision ?? 1),
    title: String(before.r_title ?? ''), quantity: Number(before.r_quantity ?? 1), material: String(before.r_material ?? ''),
    color: String(before.r_color ?? ''), ...merged,
  });
  const messageId = newId('msg');
  let changes = 0;
  const res = await db.batch([
    db.prepare(
      `UPDATE community_offers
          SET ${sets.join(', ')}, state = 'pending', revision = revision + 1,
              request_revision = (SELECT r.revision FROM community_requests r WHERE r.id = community_offers.request_id),
              updated_at = ?
        WHERE id = ? AND merchant_id = ? AND state IN ('pending','superseded') AND revision = ?
          AND EXISTS (SELECT 1 FROM community_requests r
                       WHERE r.id = community_offers.request_id AND r.visibility = 'direct'
                         AND r.state IN ('open','receiving_offers')
                         AND (r.expires_at IS NULL OR r.expires_at = '' OR r.expires_at > ?))`
    ).bind(...vals, ts, offerId, ctx.merchant.id, fromRevision, ts),
    recordOfferRevisionStatement(db, offerId, 'edit'),
    offerCountStatement(db, String(before.request_id)),
    cardInsertStatement(
      db,
      { id: messageId, chatId, senderId: user.id, card, createdAt: ts },
      { sql: 'EXISTS (SELECT 1 FROM community_offers WHERE id = ? AND revision = ?)', binds: [offerId, next] }
    ),
  ]);
  changes = Number(res[0]?.meta.changes ?? 0);
  if (!changes) throw conflict('That quote changed or can no longer be changed — reload it', 'OFFER_NOT_AVAILABLE');

  await audit(db, user.id, 'community.offer_edited', offerId, {
    before: { price_iqd: before.price_iqd, revision: fromRevision },
    after: { price_iqd: merged.price_iqd, revision: next },
    direct: true,
  });
  await afterCard(c, thread, chatId, messageId, ts);
  const row = await db.prepare('SELECT * FROM community_offers WHERE id = ?').bind(offerId).first<Record<string, unknown>>();
  const message = await existingCard(c, chatId, 'quote', offerId);
  return c.json({ success: true, offer: offerShape(row!), message });
});

// ================================================================ orders

/**
 * «الطلبات» — what this customer bought from this store, both flows, for the
 * conversation's orders panel. Only the two parties; the store sees its own
 * customer's orders with it and no one else's.
 */
chatCommerceRoutes.get('/:id/orders', async (c) => {
  const user = c.get('user')!;
  const chatId = str(c.req.param('id'), 'chatId', { min: 1, max: 60 });
  await assertMayWriteInThread(c.env.DB, chatId, user.id);
  const thread = await storeThreadOf(c.env.DB, chatId);
  const side = thread ? threadRole(thread, user.id) : null;
  if (!thread || !side) throw badRequest('Orders are shown in a conversation with a store', 'CARD_NOT_ALLOWED_HERE');
  const [store, custom] = await Promise.all([
    c.env.DB.prepare(
      `SELECT o.id, o.status, o.stage, o.total_iqd, o.created_at,
              (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS items,
              (SELECT i.name_snapshot FROM order_items i WHERE i.order_id = o.id ORDER BY i.rowid LIMIT 1) AS first_item
         FROM orders o
        WHERE o.user_id = ? AND o.store_id = ? AND o.seller_type = 'merchant'
        ORDER BY o.created_at DESC LIMIT 20`
    )
      .bind(thread.customer_id, thread.store_id)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT o.id, o.state, o.price_iqd, o.request_id, o.created_at, r.title
         FROM community_orders o JOIN community_requests r ON r.id = o.request_id
        WHERE o.customer_id = ? AND o.store_id = ?
        ORDER BY o.created_at DESC LIMIT 20`
    )
      .bind(thread.customer_id, thread.store_id)
      .all<Record<string, unknown>>(),
  ]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    role: side,
    store_orders: (store.results ?? []).map((o) => ({
      id: o.id,
      status: o.status,
      stage: o.stage ?? null,
      total_iqd: Number(o.total_iqd ?? 0),
      items: Number(o.items ?? 0),
      first_item: o.first_item ?? '',
      created_at: o.created_at,
    })),
    custom_orders: (custom.results ?? []).map((o) => ({
      id: o.id,
      state: o.state,
      price_iqd: Number(o.price_iqd ?? 0),
      request_id: o.request_id,
      title: o.title ?? '',
      created_at: o.created_at,
    })),
  });
});
