/**
 * TELLING A MERCHANT WHAT HAPPENED TO THEIR BUSINESS — and taking them to it.
 *
 * Before wave 2 a merchant heard about exactly two things: a print request
 * that matched their printers, and (after wave 1) a new or cancelled store
 * order that linked to the dashboard's front page. A review, a dispute, money
 * becoming available, a coupon about to end, a sanction on their own store —
 * none of it reached them (audit 04 §4.5). This module is every merchant
 * notification, in one place, with three rules:
 *
 *  1. EMITTED FROM THE REAL EVENT. Each sender below is called by the code
 *     that performed the thing it announces — the store checkout, the chat
 *     send, the matcher, the offer acceptance, the review insert, the dispute
 *     route, the receipt confirmation, the admin's sanction — or by a sweep
 *     that reads the rows the event left (a coupon's end date, an order still
 *     unconfirmed a day later). Nothing is announced that did not happen.
 *
 *  2. A DEEP LINK TO THE REAL OBJECT. The link is built by `merchantHref`
 *     (packages/contracts/src/merchantRoutes.ts) — the order, the thread, the
 *     request, the product, the coupon — never the dashboard's front door.
 *
 *  3. PREFERENCES ARE READ. The in-app row is ALWAYS written: it is the record
 *     of what happened and the workspace's notification centre lists it. The
 *     merchant's switch for the kind (`merchant_notification_preferences`)
 *     decides whether the same news also goes out on their outside channels
 *     (Telegram / WhatsApp / email, through the durable outbox), and a channel
 *     the account switched off (`user_notification_channels`) is never used.
 *     `complaints`, `subscription_expiry` and `system_alerts` are forced on.
 *
 * WHAT MAKES A NOTIFICATION THE STORE'S is its KIND (`MERCHANT_KINDS`), not a
 * column: one store has one owner, so the owner's rows of these kinds are the
 * store's notifications, and a Worker deployed ahead of a migration still
 * writes every row. Replay is the database's problem, as everywhere: the
 * in-app row is unique per (user, event key), the outbound rows per event key.
 *
 * EVERY SENDER IS TOTAL. It is called after the business write committed, and
 * neither a provider outage nor a D1 blip may turn a placed order, a sent
 * message or an admin decision into an error.
 *
 * Sorani: the rows carry ar/en; the notification centre shows a Sorani reader
 * the Arabic (DECISIONS row 11 — no machine-written Kurdish).
 */

import type { Env } from './types';
import { notifyStatement, type NotificationInput, type NotificationKind } from './notifications';
import { planNotifyCustomer, reachFor, type CustomerChannel, type CustomerMessage } from './customerNotify';
import { merchantHref } from '@levonis/contracts/merchantRoutes';
import { orderCredit, payoutFacts } from './merchantLedger';

// ---------------------------------------------------------------- the kinds

/**
 * Every kind the merchant notification centre lists. `print_request_match`
 * is the matcher's pre-wave-2 name for `matching_request` (rows written before
 * the rename keep it); `offer_stale` is «تغيّر الطلب تحت عرضك».
 */
export const MERCHANT_KINDS = [
  'new_order',
  'order_needs_action',
  'new_message',
  'matching_request',
  'print_request_match',
  'offer_accepted',
  'offer_stale',
  'offer_rejected',
  'low_stock',
  'new_review',
  'dispute_opened',
  'payout_available',
  'payout_paid',
  'coupon_ending',
  'store_status_changed',
] as const satisfies readonly NotificationKind[];
export type MerchantKind = (typeof MERCHANT_KINDS)[number];

export function isMerchantKind(kind: string): kind is MerchantKind {
  return (MERCHANT_KINDS as readonly string[]).includes(kind);
}

/** `kind IN (…)` for SQL — literals from the constant above, never input. */
export const MERCHANT_KINDS_SQL = MERCHANT_KINDS.map((k) => `'${k}'`).join(',');

// ---------------------------------------------------------- the preferences

/** The switches, in the order the settings screen draws them. */
export const NOTIFICATION_PREF_KEYS = [
  'new_orders',
  'request_opportunities',
  'new_messages',
  'new_reviews',
  'low_stock',
  'payouts',
  'complaints',
  'system_alerts',
  'marketing',
  'new_followers',
  'subscription_expiry',
] as const;
export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

/**
 * Three cannot be switched off (§61): a dispute against the merchant, their
 * subscription lapsing, a sanction on their store — those decide money and
 * standing. Stored if sent, forced back on when read.
 */
export const FORCED_PREFS = ['complaints', 'subscription_expiry', 'system_alerts'] as const;

/** Which switch governs each kind's OUTSIDE channels. */
export const KIND_PREF: Readonly<Record<MerchantKind, NotificationPrefKey>> = {
  new_order: 'new_orders',
  order_needs_action: 'new_orders',
  // A funded custom order is a new order for the workshop.
  offer_accepted: 'new_orders',
  new_message: 'new_messages',
  matching_request: 'request_opportunities',
  print_request_match: 'request_opportunities',
  offer_stale: 'request_opportunities',
  // «لم يُختر عرضك» (W5-A): the answer to an opportunity the merchant took up.
  offer_rejected: 'request_opportunities',
  low_stock: 'low_stock',
  new_review: 'new_reviews',
  dispute_opened: 'complaints',
  payout_available: 'payouts',
  payout_paid: 'payouts',
  // The merchant's own marketing tools: a coupon about to end.
  coupon_ending: 'marketing',
  store_status_changed: 'system_alerts',
};

/**
 * The switches a sender actually reads — the settings screen draws every
 * other one as «قريبًا» instead of as a control that does nothing (audit 04
 * #19). Derived from `KIND_PREF`, so a new kind wires its switch by existing.
 */
export const WIRED_PREFS: readonly NotificationPrefKey[] = NOTIFICATION_PREF_KEYS.filter((k) =>
  Object.values(KIND_PREF).includes(k)
);

/**
 * A stored preference row, as switches. No row = the platform default (on);
 * a column a database has not been migrated to yet = on, never "off".
 */
export function preferenceShape(row: Record<string, unknown> | null | undefined): Record<NotificationPrefKey, boolean> {
  const out = {} as Record<NotificationPrefKey, boolean>;
  for (const k of NOTIFICATION_PREF_KEYS) {
    const v = row ? row[k] : undefined;
    out[k] = v === undefined || v === null ? true : !!Number(v);
  }
  for (const k of FORCED_PREFS) out[k] = true;
  return out;
}

// ------------------------------------------------------------ one notice

export interface MerchantNotice {
  kind: MerchantKind;
  title_ar: string;
  title_en: string;
  body_ar?: string;
  body_en?: string;
  /** A workspace path from `merchantHref` (or, for a legacy kind, the board). */
  link: string;
  entity_type: NonNullable<NotificationInput['entity_type']>;
  entity_id: string;
  /** Unique per (merchant, event): the replay guard. */
  eventKey: string;
  meta?: Record<string, unknown>;
  /**
   * What the OUTSIDE channels say, when it must be less than the in-app body
   * (third parties carry them — no customer's words, no reasons). Defaults to
   * the title.
   */
  outbound_ar?: string;
  outbound_en?: string;
}

/** Whom to tell: the merchant, by any of the ids an event has in hand. */
export type MerchantTarget = { merchantId: string } | { storeId: string } | { ownerUserId: string };

interface Owner {
  merchant_id: string;
  user_id: string;
  store_id: string | null;
}

async function ownerOf(db: D1Database, target: MerchantTarget): Promise<Owner | null> {
  const where =
    'merchantId' in target ? 'm.id = ?' : 'storeId' in target ? 's.id = ?' : 'm.user_id = ?';
  const id = 'merchantId' in target ? target.merchantId : 'storeId' in target ? target.storeId : target.ownerUserId;
  if (!id) return null;
  return db
    .prepare(
      `SELECT m.id AS merchant_id, m.user_id, s.id AS store_id
         FROM community_merchants m
         LEFT JOIN merchant_stores s ON s.merchant_id = m.id
        WHERE ${where}
        LIMIT 1`
    )
    .bind(id)
    .first<Owner>();
}

/** The in-app row, ready for a caller's own batch. */
export function merchantNotificationStatement(db: D1Database, userId: string, n: MerchantNotice): D1PreparedStatement {
  return notifyStatement(db, {
    userId,
    kind: n.kind,
    title_ar: n.title_ar,
    title_en: n.title_en,
    body_ar: n.body_ar ?? '',
    body_en: n.body_en ?? '',
    link: n.link,
    entity_type: n.entity_type,
    entity_id: n.entity_id,
    meta: n.meta,
    eventKey: n.eventKey,
  }).stmt;
}

/** The outside channels this account switched off («أوقف تيليغرام»). */
async function refusedChannels(db: D1Database, userId: string): Promise<Set<string>> {
  try {
    const { results } = await db
      .prepare('SELECT channel FROM user_notification_channels WHERE user_id = ? AND enabled = 0')
      .bind(userId)
      .all<{ channel: string }>();
    return new Set((results ?? []).map((r) => r.channel));
  } catch {
    return new Set();
  }
}

/** Is the kind's switch on for this merchant? Forced switches always are. */
export async function merchantWantsOutbound(db: D1Database, merchantId: string, kind: MerchantKind): Promise<boolean> {
  const key = KIND_PREF[kind];
  if ((FORCED_PREFS as readonly string[]).includes(key)) return true;
  const row = await db
    .prepare('SELECT * FROM merchant_notification_preferences WHERE merchant_id = ?')
    .bind(merchantId)
    .first<Record<string, unknown>>()
    .catch(() => null);
  return preferenceShape(row)[key];
}

/** An absolute https address for a workspace path, or null (see customerNotify `ctaOf`). */
function absolute(env: Env, path: string): string | null {
  const origin = String(env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (!origin.startsWith('https://') || !path.startsWith('/')) return null;
  return `${origin}${path}`;
}

/**
 * THE OUTSIDE CHANNELS, if the merchant's switch allows. Queued through the
 * same durable outbox as every customer message (`planNotifyCustomer`), keyed
 * `merchant:<event key>` so a replay queues nothing twice.
 */
export async function fanOutMerchantNotice(
  env: Env,
  owner: { merchant_id: string; user_id: string },
  n: MerchantNotice
): Promise<CustomerChannel[]> {
  try {
    if (!(await merchantWantsOutbound(env.DB, owner.merchant_id, n.kind))) return [];
    const refused = await refusedChannels(env.DB, owner.user_id);
    const channels = (['telegram', 'whatsapp', 'email'] as const).filter((ch) => !refused.has(ch));
    if (!channels.length) return [];
    const reach = await reachFor(env, owner.user_id);
    // Sorani readers get the Arabic: no Kurdish is generated here.
    const en = reach.lang === 'en';
    const url = absolute(env, n.link);
    const msg: CustomerMessage = {
      subject: en ? n.title_en : n.title_ar,
      body: en ? n.outbound_en ?? n.title_en : n.outbound_ar ?? n.title_ar,
      ...(url ? { cta: { label: en ? 'Open in your store dashboard' : 'افتح في لوحة متجرك', url } } : {}),
    };
    const plan = await planNotifyCustomer(env, owner.user_id, `merchant:${n.eventKey}`, msg, { channels, reach });
    if (plan.statements.length) await env.DB.batch(plan.statements);
    return plan.queued;
  } catch (e) {
    console.error(`merchant outbound not queued (${n.kind})`, e instanceof Error ? e.message : String(e));
    return [];
  }
}

export interface MerchantNotifyResult {
  /** A new in-app row was written (false: a replay, or nobody to tell). */
  written: boolean;
  outbound: CustomerChannel[];
}

/**
 * THE ONE DOOR: the in-app row always, the outside channels per preference.
 * Accepts the Env (both halves) or only a database (in-app only — for the
 * few callers that have no Env in hand).
 */
export async function notifyMerchant(
  envOrDb: Env | D1Database,
  target: MerchantTarget,
  n: MerchantNotice
): Promise<MerchantNotifyResult> {
  const env = 'DB' in (envOrDb as object) ? (envOrDb as Env) : null;
  const db = env ? env.DB : (envOrDb as D1Database);
  try {
    const owner = await ownerOf(db, target);
    if (!owner) return { written: false, outbound: [] };
    const res = await merchantNotificationStatement(db, owner.user_id, n).run();
    const written = (res.meta?.changes ?? 0) > 0;
    const outbound = env ? await fanOutMerchantNotice(env, owner, n) : [];
    return { written, outbound };
  } catch (e) {
    console.error(`merchant notification not written (${n.kind})`, e instanceof Error ? e.message : String(e));
    return { written: false, outbound: [] };
  }
}

// ------------------------------------------------------------ the copy

/**
 * An id, a code or a figure inside an Arabic sentence, isolated (FSI…PDI) so
 * «ORD-7F3A21» is never reordered or split around its hyphen by the RTL
 * paragraph — the same device the copy uses for «Levonis».
 */
const iso = (s: string | number) => `\u2068${s}\u2069`;

const money = (iqd: number) => Math.max(0, Math.trunc(Number(iqd) || 0)).toLocaleString('en-US');
/** One lock-screen line of somebody's product name. */
const clip = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || '—';
};

// -------------------------------------------------------------- senders

/** «طلب جديد» and «أُلغي الطلب — لا تشحنه» (the store checkout, the cancel doors). */
export function storeOrderNotice(
  event: 'new' | 'cancelled_by_customer' | 'cancelled_by_admin',
  orderId: string,
  totalIqd?: number
): MerchantNotice {
  if (event === 'new') {
    const total = money(totalIqd ?? 0);
    return {
      kind: 'new_order',
      title_ar: `طلب جديد في متجرك — ${iso(orderId)}`,
      title_en: `New order in your store — ${orderId}`,
      body_ar: `الإجمالي ${iso(total)} د.ع، مدفوع مسبقًا من محفظة الزبون. أكّده وجهّزه.`,
      body_en: `Total ${total} IQD, prepaid from the customer's wallet. Confirm and prepare it.`,
      link: merchantHref.order(orderId),
      entity_type: 'order',
      entity_id: orderId,
      // Wave 1's key, kept: an order announced before this change is not announced again.
      eventKey: `store_order.new:${orderId}`,
      meta: { total_iqd: Math.trunc(Number(totalIqd) || 0) },
    };
  }
  return {
    kind: 'order_needs_action',
    title_ar: `أُلغي الطلب ${iso(orderId)} — لا تشحنه`,
    title_en: `Order ${orderId} was cancelled — do not ship it`,
    body_ar:
      event === 'cancelled_by_customer'
        ? 'ألغى الزبون الطلب، وأُعيد المبلغ إلى محفظته.'
        : 'ألغت Levonis الطلب، وأُعيد المبلغ إلى محفظة الزبون.',
    body_en:
      event === 'cancelled_by_customer'
        ? 'The customer cancelled it and was refunded to their wallet.'
        : 'Levonis cancelled it and refunded the customer to their wallet.',
    link: merchantHref.order(orderId),
    entity_type: 'order',
    entity_id: orderId,
    eventKey: `store_order.cancelled:${orderId}`,
  };
}

/** «ما زال بانتظار تأكيدك» — a store order unconfirmed a day after it was placed (the sweep). */
export function pendingOrderNotice(orderId: string): MerchantNotice {
  return {
    kind: 'order_needs_action',
    title_ar: `الطلب ${iso(orderId)} ما زال بانتظار تأكيدك`,
    title_en: `Order ${orderId} is still waiting for you to confirm it`,
    body_ar: 'مرّ يوم على الطلب دون تأكيد. أكّده أو تواصل مع الزبون.',
    body_en: 'A day has passed without a confirmation. Confirm it or message the customer.',
    link: merchantHref.order(orderId),
    entity_type: 'order',
    entity_id: orderId,
    eventKey: `order_needs_action.pending:${orderId}`,
  };
}

/**
 * «رسالة جديدة من زبون» — a customer's line on one of the store's threads.
 * The customer's words are NOT in it on any channel: the thread is behind
 * the merchant's login, and that is where it is read.
 */
export function newMessageNotice(chatId: string, messageId: string, context: { type: string; id: string }): MerchantNotice {
  const about =
    context.type === 'store_order'
      ? { ar: `بخصوص الطلب ${iso(context.id)}`, en: `About order ${context.id}` }
      : context.type === 'request'
        ? { ar: `بخصوص الطلب المخصص ${iso(context.id)}`, en: `About request ${context.id}` }
        : { ar: 'رسالة مباشرة إلى متجرك', en: 'A direct message to your store' };
  return {
    kind: 'new_message',
    title_ar: 'رسالة جديدة من زبون',
    title_en: 'New message from a customer',
    body_ar: about.ar,
    body_en: about.en,
    link: merchantHref.thread(chatId),
    entity_type: 'chat',
    entity_id: chatId,
    // Per message (the caller already sends one per TURN, not per line).
    eventKey: `chat_msg:${messageId}`,
    meta: { context_type: context.type, context_id: context.id },
  };
}

/** «طلب يناسب ورشتك» — the matcher's notice (worker/routes/printRequests.ts). */
export function matchingRequestNotice(
  requestId: string,
  text: { title: { ar: string; en: string; ckb?: string }; body: { ar: string; en: string; ckb?: string } },
  meta: Record<string, unknown> = {}
): MerchantNotice {
  return {
    kind: 'matching_request',
    title_ar: text.title.ar,
    title_en: text.title.en,
    body_ar: text.body.ar,
    body_en: text.body.en,
    link: merchantHref.request(requestId),
    entity_type: 'request',
    entity_id: requestId,
    meta: { ...meta, title_ckb: text.title.ckb, body_ckb: text.body.ckb },
    // The pre-rename key, kept: a merchant told under the old kind is not told again.
    eventKey: `print_request_match:${requestId}`,
    outbound_ar: 'طلب طباعة جديد يناسب طابعاتك. افتحه لتقدّم عرضك.',
    outbound_en: 'A new print request fits your printers. Open it to make your offer.',
  };
}

/** «قبل العميل عرضك» — the acceptance batch (worker/routes/marketplace.ts). */
export function offerAcceptedNotice(p: { requestId: string; offerId: string; orderId: string; priceIqd: number }): MerchantNotice {
  const price = money(p.priceIqd);
  return {
    kind: 'offer_accepted',
    title_ar: 'قبل العميل عرضك',
    title_en: 'Your offer was accepted',
    body_ar: `قبل العميل عرضك على الطلب ${iso(p.requestId)} بمبلغ ${iso(price)} د.ع. المبلغ محجوز لدى Levonis ويُحرَّر لك بعد تأكيد الاستلام.`,
    body_en: `The customer accepted your offer on request ${p.requestId} for ${price} IQD. Levonis holds the money and releases it to you when delivery is confirmed.`,
    link: merchantHref.customOrder(p.orderId),
    entity_type: 'order',
    entity_id: p.orderId,
    meta: { request_id: p.requestId, offer_id: p.offerId, price_iqd: p.priceIqd },
    eventKey: `offer_accepted:${p.offerId}`,
  };
}

/**
 * «المخزون ينفد» — a product's stock crossed its threshold. The threshold is
 * the product's own (stream W2-F adds it); `lowStockCrossed` is the one test
 * of "crossed", and the caller passes the stock before and after its write.
 */
export function lowStockCrossed(before: number, after: number, threshold: number): boolean {
  if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(threshold) || threshold < 0) return false;
  return before > threshold && after <= threshold;
}

export function lowStockNotice(p: {
  productId: string;
  productName: string;
  stock: number;
  threshold: number;
  /** What made it cross — an order id, a stock edit id. One notice per crossing. */
  cause: string;
  variantLabel?: string;
}): MerchantNotice {
  const name = clip(p.variantLabel ? `${p.productName} — ${p.variantLabel}` : p.productName);
  const left = Math.max(0, Math.trunc(Number(p.stock) || 0));
  return {
    kind: 'low_stock',
    title_ar: left === 0 ? `نفد المخزون: ${iso(name)}` : `المخزون ينفد: ${iso(name)}`,
    title_en: left === 0 ? `Out of stock: ${name}` : `Running low: ${name}`,
    body_ar: `بقي ${iso(left)} (حد التنبيه ${iso(p.threshold)}). أعد التعبئة أو عدّل الكمية.`,
    body_en: `${left} left (alert at ${p.threshold}). Restock or update the quantity.`,
    link: merchantHref.product(p.productId),
    entity_type: 'product',
    entity_id: p.productId,
    meta: { stock: left, threshold: p.threshold },
    eventKey: `low_stock:${p.productId}:${p.cause}`,
  };
}

/**
 * THE HOOK FOR THE CATALOGUE (stream W2-F): call after a stock write with the
 * figures before and after it. Sends nothing unless the stock crossed the
 * threshold on THIS write.
 */
export async function notifyLowStock(
  env: Env | D1Database,
  p: {
    merchantId: string;
    productId: string;
    productName: string;
    before: number;
    after: number;
    threshold: number;
    cause: string;
    variantLabel?: string;
  }
): Promise<MerchantNotifyResult> {
  if (!lowStockCrossed(p.before, p.after, p.threshold)) return { written: false, outbound: [] };
  return notifyMerchant(env, { merchantId: p.merchantId }, lowStockNotice({ ...p, stock: p.after }));
}

/** «تقييم جديد» — worker/routes/merchantReviews.ts, after the review is stored. */
export async function notifyNewReview(env: Env, reviewId: string): Promise<MerchantNotifyResult> {
  try {
    const r = await env.DB.prepare('SELECT id, merchant_id, rating, order_id, community_order_id FROM merchant_reviews WHERE id = ?')
      .bind(reviewId)
      .first<{ id: string; merchant_id: string; rating: number; order_id: string | null; community_order_id: string | null }>();
    if (!r) return { written: false, outbound: [] };
    const stars = Math.max(1, Math.min(5, Math.trunc(Number(r.rating) || 0)));
    return notifyMerchant(env, { merchantId: r.merchant_id }, {
      kind: 'new_review',
      title_ar: `تقييم جديد لمتجرك: ${iso(stars)} من 5`,
      title_en: `New review of your store: ${stars} of 5`,
      body_ar: 'اقرأه وردّ عليه من «التقييمات».',
      body_en: 'Read it and reply under Reviews.',
      link: merchantHref.reviews(),
      entity_type: 'review',
      entity_id: r.id,
      meta: { rating: stars, order_id: r.order_id, community_order_id: r.community_order_id },
      eventKey: `new_review:${r.id}`,
    });
  } catch (e) {
    console.error('new review notice failed', reviewId, e instanceof Error ? e.message : String(e));
    return { written: false, outbound: [] };
  }
}

/**
 * «نزاع على طلبك» — a customer disputed a custom order (the escrow is frozen).
 * The description is NOT included: it is one party's accusation, and the
 * admin desk is where it is read. Forced on (§61).
 */
export async function notifyDisputeOpened(
  env: Env,
  p: { communityOrderId: string; complaintId: string; merchantId: string }
): Promise<MerchantNotifyResult> {
  return notifyMerchant(env, { merchantId: p.merchantId }, {
    kind: 'dispute_opened',
    title_ar: `فتح الزبون نزاعًا على الطلب ${iso(p.communityOrderId)}`,
    title_en: `The customer opened a dispute on order ${p.communityOrderId}`,
    body_ar: 'المبلغ مجمّد لدى Levonis حتى تقرّر الإدارة. ستتواصل معك الإدارة إن احتاجت إلى ردك.',
    body_en: 'The money is held by Levonis until the admin team decides. They will contact you if they need your side.',
    link: merchantHref.customOrder(p.communityOrderId),
    entity_type: 'custom_order',
    entity_id: p.communityOrderId,
    meta: { complaint_id: p.complaintId },
    eventKey: `dispute_opened:${p.complaintId}`,
  });
}

/**
 * «شكوى على طلب من متجرك» — a customer opened a support ticket on a STORE
 * order. An open ticket freezes the order's money (`openDisputeSql`), so the
 * merchant is told why it waits. The ticket's words stay between the customer
 * and Levonis support.
 */
export async function notifyStoreOrderComplaint(env: Env, p: { orderId: string; ticketId: string }): Promise<MerchantNotifyResult> {
  try {
    const o = await env.DB.prepare(
      "SELECT id, merchant_id FROM orders WHERE id = ? AND seller_type = 'merchant' AND merchant_id IS NOT NULL"
    )
      .bind(p.orderId)
      .first<{ id: string; merchant_id: string }>();
    if (!o) return { written: false, outbound: [] };
    return notifyMerchant(env, { merchantId: o.merchant_id }, {
      kind: 'dispute_opened',
      title_ar: `فتح الزبون شكوى على الطلب ${iso(o.id)}`,
      title_en: `The customer opened a complaint on order ${o.id}`,
      body_ar: 'يبقى مبلغ هذا الطلب معلّقًا حتى يغلق فريق Levonis الشكوى.',
      body_en: 'This order\'s money stays on hold until the Levonis team closes the complaint.',
      link: merchantHref.order(o.id),
      entity_type: 'order',
      entity_id: o.id,
      meta: { ticket_id: p.ticketId },
      eventKey: `dispute_opened:ticket:${p.ticketId}`,
    });
  } catch (e) {
    console.error('store order complaint notice failed', p.orderId, e instanceof Error ? e.message : String(e));
    return { written: false, outbound: [] };
  }
}

/**
 * «صار مبلغ متاحًا» — THE HOOK FOR THE LEDGER (stream W2-B): call after a
 * credit moved pending → available. `sourceKey` names the credit
 * (`store_order:<id>`, `community_order:<id>`, a ledger entry id) and is the
 * replay key, so the confirm route, the three-day sweep and the ledger itself
 * can all call it for one credit and the merchant hears once.
 */
export async function notifyPayoutAvailable(
  env: Env | D1Database,
  p: { merchantId: string; amountIqd: number; sourceKey: string; orderId?: string; communityOrderId?: string }
): Promise<MerchantNotifyResult> {
  const amount = money(p.amountIqd);
  const about = p.orderId
    ? { ar: `من الطلب ${iso(p.orderId)}`, en: `from order ${p.orderId}` }
    : p.communityOrderId
      ? { ar: `من الطلب المخصص ${iso(p.communityOrderId)}`, en: `from custom order ${p.communityOrderId}` }
      : { ar: '', en: '' };
  return notifyMerchant(env, { merchantId: p.merchantId }, {
    kind: 'payout_available',
    title_ar: `صار ${iso(amount)} د.ع متاحًا في رصيدك`,
    title_en: `${amount} IQD is now available in your balance`,
    body_ar: `${about.ar ? `${about.ar}. ` : ''}يمكنك طلب تحويله من «الأرباح».`.trim(),
    body_en: `${about.en ? `${about.en[0].toUpperCase()}${about.en.slice(1)}. ` : ''}You can request a payout under Earnings.`.trim(),
    link: merchantHref.money(),
    entity_type: p.orderId ? 'order' : p.communityOrderId ? 'custom_order' : 'payout',
    entity_id: p.orderId ?? p.communityOrderId ?? p.sourceKey,
    meta: { amount_iqd: Math.trunc(Number(p.amountIqd) || 0) },
    eventKey: `payout_available:${p.sourceKey}`,
  });
}

/**
 * «حُوِّل إليك مبلغ» — THE HOOK FOR THE PAYOUT DECISION (stream W2-B): call
 * when a payout reaches `paid`. The transfer reference is in-app only.
 */
export async function notifyPayoutPaid(
  env: Env | D1Database,
  p: { merchantId: string; payoutId: string; amountIqd: number; reference?: string }
): Promise<MerchantNotifyResult> {
  const amount = money(p.amountIqd);
  const ref = String(p.reference ?? '').trim().slice(0, 80);
  return notifyMerchant(env, { merchantId: p.merchantId }, {
    kind: 'payout_paid',
    title_ar: `حوّلت Levonis إليك ${iso(amount)} د.ع`,
    title_en: `Levonis paid out ${amount} IQD to you`,
    body_ar: ref ? `رقم الحوالة: ${iso(ref)}` : 'تجد التفاصيل في «الأرباح».',
    body_en: ref ? `Transfer reference: ${ref}` : 'The details are under Earnings.',
    link: merchantHref.money(),
    entity_type: 'payout',
    entity_id: p.payoutId,
    meta: { amount_iqd: Math.trunc(Number(p.amountIqd) || 0) },
    eventKey: `payout_paid:${p.payoutId}`,
  });
}

/**
 * FROM THE LEDGER'S OWN FACTS (stream W2-B, worker/lib/merchantLedger.ts):
 * a store order whose credit a release just moved to «available» — the amount
 * is what the ledger holds available for that order, never a figure the
 * caller computed. Called by the customer's «استلمت طلبي» route and by the
 * merchant sweep for the three-day release; one key per order, so the two
 * can never announce one credit twice.
 */
export async function notifyOrderCreditAvailable(env: Env, orderId: string): Promise<MerchantNotifyResult> {
  try {
    const credit = await orderCredit(env.DB, orderId);
    if (!credit.merchant_id || credit.available_iqd <= 0) return { written: false, outbound: [] };
    return notifyPayoutAvailable(env, {
      merchantId: credit.merchant_id,
      amountIqd: credit.available_iqd,
      sourceKey: `store_order:${orderId}`,
      orderId,
    });
  } catch (e) {
    console.error('credit-available notice failed', orderId, e instanceof Error ? e.message : String(e));
    return { written: false, outbound: [] };
  }
}

/** A payout the ledger records as PAID (`payoutFacts`), told to its merchant once. */
export async function notifyPayoutPaidById(env: Env, payoutId: string): Promise<MerchantNotifyResult> {
  try {
    const p = await payoutFacts(env.DB, payoutId);
    if (!p || p.state !== 'paid') return { written: false, outbound: [] };
    return notifyPayoutPaid(env, { merchantId: p.merchant_id, payoutId: p.id, amountIqd: Number(p.amount_iqd) || 0, reference: p.reference });
  } catch (e) {
    console.error('payout-paid notice failed', payoutId, e instanceof Error ? e.message : String(e));
    return { written: false, outbound: [] };
  }
}

/** «كوبونك ينتهي قريبًا» — the daily sweep, once per coupon per end date. */
export function couponEndingNotice(c: { id: string; code: string; ends_at: string; used_count: number }): MerchantNotice {
  const day = String(c.ends_at).slice(0, 10);
  return {
    kind: 'coupon_ending',
    title_ar: `الكوبون ${iso(c.code)} ينتهي في ${iso(day)}`,
    title_en: `Coupon ${c.code} ends on ${day}`,
    body_ar: `استُخدم ${iso(Math.trunc(Number(c.used_count) || 0))} مرة. مدّده أو اتركه ينتهي.`,
    body_en: `Used ${Math.trunc(Number(c.used_count) || 0)} times. Extend it or let it end.`,
    link: merchantHref.coupon(c.id),
    entity_type: 'coupon',
    entity_id: c.id,
    meta: { code: c.code, ends_at: c.ends_at },
    eventKey: `coupon_ending:${c.id}:${c.ends_at}`,
  };
}

const STATUS_WORD: Record<string, { ar: string; en: string }> = {
  active: { ar: 'فعّال من جديد', en: 'active again' },
  suspended: { ar: 'موقوف من Levonis', en: 'suspended by Levonis' },
  restricted: { ar: 'مقيّد من Levonis', en: 'restricted by Levonis' },
};

/**
 * «تغيّر وضع متجرك» — an admin sanction on the store or on its merchant
 * (worker/routes/adminCommunity.ts). The admin's reason is shown in-app (the
 * merchant is owed it, as the dashboard already shows `status_reason`) and
 * kept off the outside channels. Forced on (§61).
 */
export async function notifyStoreStatusChanged(
  env: Env,
  p: { scope: 'store' | 'merchant'; id: string; status: string; reason?: string; at: string }
): Promise<MerchantNotifyResult> {
  const word = STATUS_WORD[p.status] ?? { ar: p.status, en: p.status };
  const reason = String(p.reason ?? '').trim().slice(0, 500);
  const target: MerchantTarget = p.scope === 'store' ? { storeId: p.id } : { merchantId: p.id };
  const subject = p.scope === 'store' ? { ar: 'متجرك', en: 'Your store' } : { ar: 'حسابك التجاري', en: 'Your merchant account' };
  return notifyMerchant(env, target, {
    kind: 'store_status_changed',
    title_ar: `${subject.ar} الآن ${word.ar}`,
    title_en: `${subject.en} is now ${word.en}`,
    body_ar: reason ? `السبب: ${reason}` : p.status === 'active' ? 'يمكنك البيع كالمعتاد.' : 'تواصل مع الدعم لمعرفة المطلوب.',
    body_en: reason ? `Reason: ${reason}` : p.status === 'active' ? 'You can sell as usual.' : 'Contact support to learn what is needed.',
    link: merchantHref.storeSettings(),
    entity_type: 'store',
    entity_id: p.id,
    meta: { scope: p.scope, status: p.status },
    eventKey: `store_status:${p.scope}:${p.id}:${p.status}:${p.at}`,
    outbound_ar: `${subject.ar} الآن ${word.ar}. افتح لوحة متجرك للتفاصيل.`,
    outbound_en: `${subject.en} is now ${word.en}. Open your store dashboard for the details.`,
  });
}

// ------------------------------------------------------ the feed (the API)

export interface MerchantFeedRow {
  id: string;
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  link: string;
  entity_type: string;
  entity_id: string;
  meta: string;
  read_at: string | null;
  created_at: string;
}

/**
 * One page of the owner's merchant notifications, newest first. The cursor is
 * `<created_at>|<id>` of the last row, so rows sharing a timestamp are never
 * skipped at a page boundary.
 */
export async function listMerchantNotifications(
  db: D1Database,
  userId: string,
  opts: { limit: number; cursor?: string; unreadOnly?: boolean; kind?: MerchantKind | null }
): Promise<{ rows: MerchantFeedRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit) || 25, 1), 50);
  const raw = String(opts.cursor ?? '').slice(0, 120);
  const bar = raw.lastIndexOf('|');
  const at = bar === -1 ? raw : raw.slice(0, bar);
  const cid = bar === -1 ? '' : raw.slice(bar + 1);
  const clauses = [`user_id = ?1`, `kind IN (${MERCHANT_KINDS_SQL})`];
  if (opts.unreadOnly) clauses.push('read_at IS NULL');
  if (opts.kind) clauses.push('kind = ?4');
  if (at) clauses.push('(created_at < ?2 OR (created_at = ?2 AND id < ?3))');
  const { results } = await db
    .prepare(
      `SELECT id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, meta, read_at, created_at
         FROM user_notifications
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?5`
    )
    .bind(userId, at, cid, opts.kind ?? '', limit + 1)
    .all<MerchantFeedRow>();
  const rows = (results ?? []).slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    rows,
    next_cursor: (results ?? []).length > limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

/** The unread merchant notifications, per kind and in total. */
export async function merchantUnreadCounts(db: D1Database, userId: string): Promise<{ total: number; by_kind: Record<string, number> }> {
  const { results } = await db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM user_notifications
        WHERE user_id = ? AND read_at IS NULL AND kind IN (${MERCHANT_KINDS_SQL})
        GROUP BY kind`
    )
    .bind(userId)
    .all<{ kind: string; n: number }>();
  const by_kind: Record<string, number> = {};
  let total = 0;
  for (const r of results ?? []) {
    by_kind[r.kind] = Number(r.n) || 0;
    total += Number(r.n) || 0;
  }
  return { total, by_kind };
}

/**
 * Marks one of the owner's MERCHANT notifications read, or all of them. A
 * personal notification (an order they bought, a support reply) is never
 * touched from the workspace, and another account's id changes nothing.
 */
export async function markMerchantRead(db: D1Database, userId: string, id?: string): Promise<number> {
  const res = id
    ? await db
        .prepare(
          `UPDATE user_notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE user_id = ? AND id = ? AND read_at IS NULL AND kind IN (${MERCHANT_KINDS_SQL})`
        )
        .bind(userId, id)
        .run()
    : await db
        .prepare(
          `UPDATE user_notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE user_id = ? AND read_at IS NULL AND kind IN (${MERCHANT_KINDS_SQL})`
        )
        .bind(userId)
        .run();
  return res.meta?.changes ?? 0;
}
