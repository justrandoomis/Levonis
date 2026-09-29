/**
 * CARDS IN THE STORE'S CONVERSATION (docs/COMMUNITY_COMMERCE_CHAT.md §2 D2, D7, D8).
 *
 * A card is a message (migration 0150): `card_type` + `card_ref` name an entity
 * of THIS thread — a product of its store, the store itself, a print request or
 * a quote between its customer and its store, a private product made for its
 * customer, an order between the two. Three rules hold for every type:
 *
 *   1. THE CLIENT SENDS AN ID AND NOTHING ELSE. No price, name, picture, total
 *      or fee is ever read from a request body. The resolver below reads the
 *      entity from the database and refuses one that is not this thread's
 *      (`CARD_NOT_IN_THREAD`) — a forged or foreign id is a refusal, never a
 *      card.
 *
 *   2. THE AGREEMENT IS NEVER REWRITTEN. `card_snapshot` is built by the server
 *      at send time and written once: what the card showed when it was sent.
 *
 *   3. THE CURRENT STATE IS READ, NOT STORED. Every read of a thread computes,
 *      for the reader, what each card is NOW — the price now, whether it can be
 *      bought, the quote's state, the order's stage — and the actions this
 *      reader may take on it. A price that moved is shown as moved; checkout
 *      and acceptance re-price on the server as they always did.
 *
 * System cards (D8) are the same rows with `is_system = 1`, written by the
 * server after a money move has committed, with an event key that makes a
 * second post of the same event a no-op. Posting one never fails the money.
 */
import type { Env } from './types';
import { safeParse } from './types';
import { HttpError, badRequest } from './http';
import { newId } from './crypto';
import { isSchemaMissing } from './membershipBenefits';
import { storeById } from './merchantAuth';
import { storeTakesOrders } from './storeOrderOps';
import { threadRole, type StoreThread } from './chatThread';

export const CARD_TYPES = ['product', 'custom_product', 'print_request', 'quote', 'order', 'custom_order', 'store'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** The message kind each card is answered as (`order` and `custom_order` are both order cards). */
export const CARD_KINDS: Record<CardType, string> = {
  product: 'product_card',
  custom_product: 'custom_product_card',
  print_request: 'print_request_card',
  quote: 'quote_card',
  order: 'order_card',
  custom_order: 'order_card',
  store: 'store_card',
};

/**
 * Cards a participant sends BY ID through `POST /api/chats/:id/messages`.
 * The rest are born with their entity — a quote with its offer, a print request
 * with its request, a private product with its product — in their own routes.
 */
export const SENDABLE_CARDS: readonly CardType[] = ['product', 'store'];

export function isCardType(v: unknown): v is CardType {
  return typeof v === 'string' && (CARD_TYPES as readonly string[]).includes(v);
}

/** What a card IS, as the server resolved it: ready to be written. */
export interface ResolvedCard {
  type: CardType;
  ref: string;
  snapshot: Record<string, unknown>;
  /** The plain fallback every older reader shows: the entity's own name. */
  body: string;
}

/** The one refusal for an id that is not this thread's — never says whose it is. */
export function notInThread(what = 'This item'): HttpError {
  return new HttpError(404, `${what} is not part of this conversation`, 'CARD_NOT_IN_THREAD');
}

/** A `/files/…` path from a stored picture reference, or null. */
function picture(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('/files/')) return value;
  if (/^[a-z]+\//.test(value)) return `/files/${value}`;
  return null;
}

function firstPicture(images: unknown): string | null {
  const list = safeParse<unknown[]>(images, []);
  for (const item of Array.isArray(list) ? list : []) {
    const p = picture(item);
    if (p) return p;
  }
  return null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

// ===========================================================================
//  PRODUCT
// ===========================================================================

/** Everything a product card shows, and what decides whether it can be bought. */
const PRODUCT_CARD_COLUMNS = `p.id, p.slug, p.name, p.name_ar, p.images, p.price_iqd, p.original_price_iqd,
       p.track_stock, p.stock, p.lifecycle, p.status, p.variant_mode, p.store_id, p.prep_days,
       (SELECT MIN(COALESCE(v.price_iqd, p.price_iqd)) FROM community_product_variants v
         WHERE v.product_id = p.id AND v.active = 1) AS v_min,
       (SELECT MAX(COALESCE(v.price_iqd, p.price_iqd)) FROM community_product_variants v
         WHERE v.product_id = p.id AND v.active = 1) AS v_max,
       s.slug AS s_slug, s.name AS s_name`;

interface PriceRange {
  price_iqd: number;
  /** The top of the range when the product's options are priced differently, else null. */
  price_max_iqd: number | null;
}

function productPrice(p: Record<string, unknown>): PriceRange {
  if (p.variant_mode === 'variants' && p.v_min !== null && p.v_min !== undefined) {
    const lo = Number(p.v_min);
    const hi = Number(p.v_max ?? lo);
    return { price_iqd: lo, price_max_iqd: hi > lo ? hi : null };
  }
  return { price_iqd: Number(p.price_iqd ?? 0), price_max_iqd: null };
}

function productSnapshotOf(p: Record<string, unknown>): Record<string, unknown> {
  const price = productPrice(p);
  const storeSlug = String(p.s_slug ?? '');
  return {
    v: 1,
    product_id: String(p.id),
    name: String(p.name ?? ''),
    name_ar: String(p.name_ar ?? ''),
    image: firstPicture(p.images),
    price_iqd: price.price_iqd,
    price_max_iqd: price.price_max_iqd,
    original_price_iqd: num(p.original_price_iqd),
    variants: p.variant_mode === 'variants',
    prep_days: Math.max(0, Math.trunc(Number(p.prep_days) || 0)),
    url: `/community/store/${encodeURIComponent(storeSlug)}/p/${encodeURIComponent(String(p.slug ?? ''))}`,
    store: { id: String(p.store_id ?? ''), slug: storeSlug, name: String(p.s_name ?? '') },
  };
}

async function resolveProduct(env: Env, thread: StoreThread, ref: string): Promise<ResolvedCard> {
  const p = await env.DB.prepare(
    `SELECT ${PRODUCT_CARD_COLUMNS} FROM community_products p JOIN merchant_stores s ON s.id = p.store_id WHERE p.id = ?`
  )
    .bind(ref)
    .first<Record<string, unknown>>();
  // Another store's product, a private product and a missing one are the same
  // answer: not part of this conversation.
  if (!p || p.store_id !== thread.store_id) throw notInThread('This product');
  if (p.lifecycle !== 'active' || p.status !== 'active') {
    throw new HttpError(409, 'Only a published product can be sent', 'PRODUCT_NOT_PUBLISHED');
  }
  const snapshot = productSnapshotOf(p);
  return { type: 'product', ref: String(p.id), snapshot, body: `🛍️ ${String(p.name ?? '').slice(0, 200)}` };
}

// ===========================================================================
//  STORE
// ===========================================================================

async function resolveStore(env: Env, thread: StoreThread, ref: string): Promise<ResolvedCard> {
  // The thread's own store and no other: a card is never a way to advertise a
  // competitor inside someone else's conversation.
  if (ref !== thread.store_id) throw notInThread('This store');
  const s = await env.DB.prepare('SELECT id, slug, name, logo_key, tagline FROM merchant_stores WHERE id = ?')
    .bind(ref)
    .first<Record<string, unknown>>();
  if (!s) throw notInThread('This store');
  const slug = String(s.slug ?? '');
  const snapshot = {
    v: 1,
    store_id: String(s.id),
    slug,
    name: String(s.name ?? ''),
    tagline: typeof s.tagline === 'string' ? s.tagline.slice(0, 160) : '',
    logo: picture(s.logo_key),
    url: `/community/store/${encodeURIComponent(slug)}`,
  };
  return { type: 'store', ref: String(s.id), snapshot, body: `🏪 ${String(s.name ?? '').slice(0, 200)}` };
}

// ===========================================================================
//  RESOLVING A SEND
// ===========================================================================

/**
 * The card a participant asked to send, resolved and authorised — or a refusal.
 * Only the SENDABLE types come through here; `type` has already been checked
 * against that list by the route.
 */
export async function resolveSendableCard(
  env: Env,
  thread: StoreThread,
  senderId: string,
  type: CardType,
  ref: string
): Promise<ResolvedCard> {
  if (!threadRole(thread, senderId)) throw new HttpError(403, 'Only the customer and the store send cards here', 'CARD_NOT_ALLOWED');
  switch (type) {
    case 'product':
      return resolveProduct(env, thread, ref);
    case 'store':
      return resolveStore(env, thread, ref);
    default:
      throw badRequest('That card cannot be sent this way', 'CARD_TYPE_UNSUPPORTED');
  }
}

// ===========================================================================
//  WRITING
// ===========================================================================

export interface CardMessage {
  id: string;
  chatId: string;
  senderId: string;
  card: ResolvedCard;
  createdAt: string;
  clientId?: string | null;
  /** A server-written event card: drawn centred, idempotent on `eventKey`. */
  system?: boolean;
  eventKey?: string | null;
}

/**
 * One card message as a statement, for a caller that writes it in its own
 * batch (a quote with its offer, a private product with its product). A system
 * card is `INSERT OR IGNORE`: its event key is unique per thread, so a second
 * post of the same event writes nothing.
 */
export function cardInsertStatement(db: D1Database, m: CardMessage): D1PreparedStatement {
  return db
    .prepare(
      `INSERT ${m.system ? 'OR IGNORE ' : ''}INTO chat_messages
         (id, chat_id, sender_id, kind, body, card_type, card_ref, card_snapshot, card_event_key, is_system, client_id, created_at)
       VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      m.id,
      m.chatId,
      m.senderId,
      m.card.body,
      m.card.type,
      m.card.ref,
      JSON.stringify(m.card.snapshot),
      m.eventKey ?? null,
      m.system ? 1 : 0,
      m.clientId ?? null,
      m.createdAt
    );
}

/** The thread's last activity, which the store's inbox pages by (0124). Best effort. */
export async function stampThreadActivity(db: D1Database, chatId: string, at: string): Promise<void> {
  await db
    .prepare('UPDATE chats SET last_message_at = ? WHERE id = ? AND (last_message_at IS NULL OR last_message_at < ?)')
    .bind(at, chatId, at)
    .run()
    .catch((e) => {
      if (!isSchemaMissing(e)) console.error('chat activity not stamped', chatId, e instanceof Error ? e.message : String(e));
    });
}

/**
 * A SYSTEM CARD, POSTED AFTER THE FACT (D8) — «تم إنشاء الطلب», «بدأ التنفيذ»…
 *
 * The caller has committed the money move and names the thread the deal came
 * from; this re-checks that the thread really is between the entity's store and
 * customer before writing (`expect`), writes the card once per event key, and
 * never throws: a conversation that could not be told must not undo a payment.
 * Returns whether a card was written.
 */
export async function postSystemCard(
  env: Env,
  p: {
    chatId: string | null | undefined;
    actorId: string;
    card: ResolvedCard;
    eventKey: string;
    expect: { storeId: string; customerId: string };
  }
): Promise<boolean> {
  if (!p.chatId) return false;
  try {
    const thread = await env.DB.prepare(
      `SELECT ch.store_id,
              CASE ch.context_type
                WHEN 'store' THEN ch.context_id
                WHEN 'store_order' THEN (SELECT o.user_id FROM orders o WHERE o.id = ch.context_id)
                WHEN 'request' THEN (SELECT r.customer_id FROM community_requests r WHERE r.id = ch.context_id)
              END AS customer_id
         FROM chats ch WHERE ch.id = ? AND ch.context_type IN ('store','store_order','request')`
    )
      .bind(p.chatId)
      .first<{ store_id: string; customer_id: string | null }>();
    if (!thread || thread.store_id !== p.expect.storeId || thread.customer_id !== p.expect.customerId) return false;
    const at = new Date().toISOString();
    const res = await cardInsertStatement(env.DB, {
      id: newId('msg'),
      chatId: p.chatId,
      senderId: p.actorId,
      card: p.card,
      createdAt: at,
      system: true,
      eventKey: p.eventKey,
    }).run();
    if (!Number(res.meta.changes ?? 0)) return false;
    await stampThreadActivity(env.DB, p.chatId, at);
    return true;
  } catch (e) {
    console.error('system card not posted', p.chatId, p.eventKey, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ===========================================================================
//  READING — THE CURRENT STATE, FOR THIS READER
// ===========================================================================

export type CardViewer = 'customer' | 'merchant' | 'staff';

export interface CardCurrent {
  /** What the entity is now — per type (see each loader). */
  status: string;
  /** What THIS reader may do from the card. */
  actions: string[];
  [k: string]: unknown;
}

interface CardRow {
  id: string;
  card_type: CardType;
  card_ref: string;
  snapshot: Record<string, unknown>;
}

/** One small memo per read: whether each store may take an order right now. */
async function storeOpenMemo(env: Env): Promise<(storeId: string) => Promise<boolean>> {
  const seen = new Map<string, Promise<boolean>>();
  return (storeId: string) => {
    let hit = seen.get(storeId);
    if (!hit) {
      hit = (async () => {
        const ctx = await storeById(env.DB, storeId);
        if (!ctx) return false;
        return (await storeTakesOrders(env.DB, ctx)).ok;
      })().catch(() => false);
      seen.set(storeId, hit);
    }
    return hit;
  };
}

async function productCurrents(
  env: Env,
  rows: CardRow[],
  thread: StoreThread | null,
  viewer: CardViewer,
  storeOpen: (id: string) => Promise<boolean>
): Promise<Map<string, CardCurrent>> {
  const out = new Map<string, CardCurrent>();
  const ids = [...new Set(rows.map((r) => r.card_ref))];
  const { results } = await env.DB.prepare(
    `SELECT ${PRODUCT_CARD_COLUMNS} FROM community_products p JOIN merchant_stores s ON s.id = p.store_id
      WHERE p.id IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(ids))
    .all<Record<string, unknown>>();
  const byId = new Map((results ?? []).map((p) => [String(p.id), p]));
  for (const r of rows) {
    const p = byId.get(r.card_ref);
    const sameStore = !!p && (!thread || p.store_id === thread.store_id);
    if (!p || !sameStore || p.lifecycle !== 'active' || p.status !== 'active') {
      out.set(r.id, { status: 'unavailable', actions: [] });
      continue;
    }
    const price = productPrice(p);
    const inStock = !Number(p.track_stock) || Number(p.stock) > 0;
    const open = await storeOpen(String(p.store_id));
    const status = !open ? 'store_closed' : !inStock ? 'out_of_stock' : 'available';
    const actions: string[] = ['view'];
    // Only the customer buys, and only what can be bought now. A product with
    // options is chosen on its own page; a simple one goes straight to the cart.
    if (viewer === 'customer' && status === 'available') actions.unshift(p.variant_mode === 'variants' ? 'choose_options' : 'add_to_cart');
    out.set(r.id, {
      status,
      actions,
      price_iqd: price.price_iqd,
      price_max_iqd: price.price_max_iqd,
      original_price_iqd: num(p.original_price_iqd),
      price_changed:
        price.price_iqd !== Number(r.snapshot.price_iqd ?? price.price_iqd) ||
        (price.price_max_iqd ?? null) !== (num(r.snapshot.price_max_iqd) ?? null),
    });
  }
  return out;
}

async function storeCurrents(
  env: Env,
  rows: CardRow[],
  storeOpen: (id: string) => Promise<boolean>
): Promise<Map<string, CardCurrent>> {
  const out = new Map<string, CardCurrent>();
  const ids = [...new Set(rows.map((r) => r.card_ref))];
  const { results } = await env.DB.prepare('SELECT id, name, status FROM merchant_stores WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<{ id: string; name: string; status: string }>();
  const byId = new Map((results ?? []).map((s) => [s.id, s]));
  for (const r of rows) {
    const s = byId.get(r.card_ref);
    if (!s) {
      out.set(r.id, { status: 'unavailable', actions: [] });
      continue;
    }
    // A suspended store is «غير متاح» to the customer — never why.
    const open = s.status === 'active' && (await storeOpen(s.id));
    out.set(r.id, { status: open ? 'open' : 'closed', actions: s.status === 'suspended' ? [] : ['view'], name: s.name });
  }
  return out;
}

/**
 * The current state of every card on a page, for this reader. One statement
 * per card type present, never one per card. A type whose loader fails (a
 * database a migration behind) answers `unknown` for its cards rather than
 * failing the thread: the conversation is still readable.
 */
export async function currentCardStates(
  env: Env,
  messages: Array<Record<string, unknown>>,
  thread: StoreThread | null,
  viewerId: string,
  staff = false
): Promise<Map<string, CardCurrent>> {
  const byType = new Map<CardType, CardRow[]>();
  for (const m of messages) {
    if (!isCardType(m.card_type) || typeof m.card_ref !== 'string') continue;
    const list = byType.get(m.card_type) ?? [];
    list.push({
      id: String(m.id),
      card_type: m.card_type,
      card_ref: m.card_ref,
      snapshot: safeParse<Record<string, unknown>>(m.card_snapshot, {}) ?? {},
    });
    byType.set(m.card_type, list);
  }
  const out = new Map<string, CardCurrent>();
  if (!byType.size) return out;
  const viewer: CardViewer = staff ? 'staff' : thread ? (threadRole(thread, viewerId) ?? 'staff') : 'staff';
  const storeOpen = await storeOpenMemo(env);
  const loaders: Array<Promise<void>> = [];
  for (const [type, rows] of byType) {
    const load = async (): Promise<Map<string, CardCurrent>> => {
      switch (type) {
        case 'product':
          return productCurrents(env, rows, thread, viewer, storeOpen);
        case 'store':
          return storeCurrents(env, rows, storeOpen);
        default:
          return new Map(rows.map((r) => [r.id, { status: 'unknown', actions: [] }]));
      }
    };
    loaders.push(
      load()
        .then((m) => {
          for (const [k, v] of m) out.set(k, v);
        })
        .catch((e) => {
          console.error('card state not read', type, e instanceof Error ? e.message : String(e));
          for (const r of rows) out.set(r.id, { status: 'unknown', actions: [] });
        })
    );
  }
  await Promise.all(loaders);
  return out;
}

/** A card as a thread screen reads it: what it was sent as, and what it is now. */
export function cardPublic(m: Record<string, unknown>, current: CardCurrent | undefined) {
  if (!isCardType(m.card_type)) return null;
  return {
    type: m.card_type,
    kind: CARD_KINDS[m.card_type],
    ref: m.card_ref,
    original: safeParse<Record<string, unknown>>(m.card_snapshot, {}) ?? {},
    current: current ?? { status: 'unknown', actions: [] },
  };
}

// ===========================================================================
//  PREVIEWS
// ===========================================================================

/** `client_id`: the sender's own id for one send — letters, digits, `-` and `_`. */
export function clientIdFrom(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(raw)) {
    throw badRequest('client_id must be 8–64 letters, digits, - or _', 'CLIENT_ID_INVALID');
  }
  return raw;
}
