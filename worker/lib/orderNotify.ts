/**
 * WHAT THE CUSTOMER HEARS ABOUT THEIR OWN ORDER.
 *
 * Until now: nothing, on any channel, except an invoice email. The admin
 * group got a message the moment an order landed (`notifyAdminTopic`), and
 * every status change after that was visible only to somebody who thought to
 * open the site and look. The person who paid was told last, or not at all.
 *
 * Two events are worth a customer's attention, and they are the two here:
 *
 *   PLACED    — the receipt moment. It answers "did that go through?", which
 *               is the question people ask a shop by phone.
 *   STATUS    — confirmed / shipped / delivered / cancelled. Not every
 *               internal transition: `processing` is a warehouse fact, and a
 *               notification that says nothing the customer can act on is a
 *               notification that trains them to ignore the next one.
 *
 * EVERY STATUS WRITES AN IN-APP ROW whatever the channels say — it is the one
 * notice a customer with no verified channel at all still receives.
 *
 * DELIVERED IS A STATUS WITH A THIRD HALF, which is why it has a function of
 * its own (`notifyOrderDelivered`) that `notifyOrderStatus` hands off to: it
 * carries the one button in this file — «قيّم منتجاتك», pointing at the orders
 * that still want a rating. Both spellings share one event key, so the
 * customer is asked once however many doors the order reaches `delivered`
 * through.
 *
 * The copy is deliberately SHORT. These arrive on WhatsApp and Telegram as
 * well as email, and on a phone the lock-screen preview is often the whole
 * interaction — the order number and what happened have to fit in it.
 *
 * NEVER THROWS, always `waitUntil`-able: an order must not fail to be placed,
 * and a status must not fail to change, because a notification could not be
 * queued.
 */

import type { Env } from './types';
import {
  notifyCustomer,
  notificationLang,
  NOTIFY_LANG_SELECT,
  type CustomerMessage,
  type NotifyLangRow,
} from './customerNotify';
import { notify } from './notifications';
import { processOutbox } from './outbox';
import type { EmailLang } from './emailTemplates';

/** The transitions worth telling a customer about. `processing` is not one. */
export const NOTIFIED_ORDER_STATUSES = ['confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type NotifiedOrderStatus = (typeof NOTIFIED_ORDER_STATUSES)[number];

export function isNotifiedOrderStatus(v: string): v is NotifiedOrderStatus {
  return (NOTIFIED_ORDER_STATUSES as readonly string[]).includes(v);
}

/**
 * THE LENGTH RULE, and why every line below is one sentence.
 *
 * `plainNotification` prefixes LEVONIS and gives EVERY detail a line of its
 * own, so a `details` entry is not a field on a form — it is another line on a
 * lock screen, competing with the sentence that says what happened. The old
 * delivered message spent 36 characters on «تم تسليم طلبك. شكراً لثقتك
 * بليفونيس.», of which 22 were a thank-you nobody asked for, and then added a
 * «رقم الطلب:» line restating a fact that fits inside the sentence.
 *
 * So each line here is: THE FACT, the order number INLINE, and — only where
 * there is something to do — one short reason to act. No thank-you, and no
 * promise of a future message: the next notification announces itself.
 *
 * CANCELLED IS UNTOUCHED, DELIBERATELY. It already states the fact and gives
 * an action to the one reader who needs it, and it is the only line that keeps
 * its order-number DETAIL row — the number stayed out of its sentence, and a
 * cancellation the customer cannot match to an order is the one failure this
 * whole message set exists to prevent.
 */
interface OrderCopy {
  placedSubject: (order: string) => string;
  placedBody: (order: string) => string;
  orderLabel: string;
  totalLabel: string;
  dueLabel: string;
  statusSubject: (order: string) => string;
  status: Record<NotifiedOrderStatus, (order: string) => string>;
  /**
   * The words on the delivered message's button. «نقاط» AND NOT «هدية»:
   * review points are automatic, the gift is a separate decision by the store,
   * and src/pages/Orders.tsx already tells the customer so («اعتماد المكافأة
   * قرار منفصل»). Promising a gift here would make the app contradict itself
   * in writing, to a customer holding both messages.
   */
  reviewCta: string;
}

const COPY: Record<EmailLang, OrderCopy> = {
  ar: {
    placedSubject: (order) => `تم استلام طلبك ${order}`,
    placedBody: (order) => `استلمنا طلبك ${order} وهو قيد المراجعة.`,
    orderLabel: 'رقم الطلب',
    totalLabel: 'الإجمالي',
    dueLabel: 'المستحق عند الاستلام',
    statusSubject: (order) => `تحديث على طلبك ${order}`,
    status: {
      confirmed: (order) => `تم تأكيد طلبك ${order} ويجري تجهيزه.`,
      shipped: (order) => `تم شحن طلبك ${order} وهو في الطريق إليك.`,
      delivered: (order) => `تم تسليم طلبك ${order}. قيّم منتجاته لتحصل على نقاط.`,
      cancelled: () => 'تم إلغاء طلبك. إن لم تطلب ذلك، تواصل معنا فوراً.',
    },
    reviewCta: 'قيّم منتجاتك',
  },
  en: {
    placedSubject: (order) => `We received your order ${order}`,
    placedBody: (order) => `Order ${order} reached us and is being reviewed.`,
    orderLabel: 'Order',
    totalLabel: 'Total',
    dueLabel: 'Due on delivery',
    statusSubject: (order) => `Update on your order ${order}`,
    status: {
      confirmed: (order) => `Order ${order} is confirmed and is being prepared.`,
      shipped: (order) => `Order ${order} has shipped and is on its way to you.`,
      delivered: (order) => `Order ${order} has been delivered. Rate its products to earn points.`,
      cancelled: () => 'Your order has been cancelled. If you did not ask for this, contact us right away.',
    },
    reviewCta: 'Rate your products',
  },
  ckb: {
    placedSubject: (order) => `داواکارییەکەت ${order} وەرگیرا`,
    placedBody: (order) => `داواکاری ${order} پێمان گەیشت و پێداچوونەوەی بۆ دەکرێت.`,
    orderLabel: 'ژمارەی داواکاری',
    totalLabel: 'کۆی گشتی',
    dueLabel: 'پارەی کاتی وەرگرتن',
    statusSubject: (order) => `نوێکارییەک لەسەر داواکارییەکەت ${order}`,
    status: {
      confirmed: (order) => `داواکاری ${order} پشتڕاستکرایەوە و ئامادە دەکرێت.`,
      shipped: (order) => `داواکاری ${order} نێردرا و لە ڕێگایە بۆت.`,
      delivered: (order) => `داواکاری ${order} گەیەندرا. کاڵاکانی هەڵبسەنگێنە بۆ وەرگرتنی خاڵ.`,
      cancelled: () => 'داواکارییەکەت هەڵوەشێندرایەوە. ئەگەر تۆ داوات نەکردووە، یەکسەر پەیوەندیمان پێوە بکە.',
    },
    reviewCta: 'کاڵاکان هەڵبسەنگێنە',
  },
};

/**
 * WHERE THE DELIVERED BUTTON GOES — and why it carries `needs_review=1`.
 *
 * `/orders?status=review` is the DELIVERED list, all of it. A customer who
 * taps a button that says «قيّم منتجاتك» and lands on ten cards with the
 * review verb on one of them has been sent to a list, not to a task; the flag
 * narrows it to the orders that still want a rating (src/pages/Orders.tsx).
 *
 * Built from `env.APP_ORIGIN` ONLY, and null unless that is https. There is no
 * request on this stack — a courier sync runs in a cron — and the Host header
 * is merchant-controlled anyway, so an origin derived from a request is how a
 * platform message ends up pointing at somebody's subdomain. Null omits the
 * CTA everywhere, which is the same rule `adminDeepLink` applies: an unlinked
 * message is honest, a half-built one is worse than none.
 */
const REVIEW_PATH = '/orders?status=review&needs_review=1';

function reviewLandingUrl(env: Env): string | null {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!origin.startsWith('https://')) return null;
  return `${origin}${REVIEW_PATH}`;
}

/** Integers, grouped, LTR-safe at the template level. */
function iqd(n: number): string {
  return `${Math.trunc(n).toLocaleString('en-US')} IQD`;
}

interface OrderRow extends NotifyLangRow {
  id: string;
  user_id: string;
  locale: string | null;
  email: string | null;
  google_sub: string | null;
  locale_stated: number | null;
  total_iqd: number;
  due_on_delivery_iqd: number;
  /** 'merchant' for a community store's order (review F7). */
  seller_type?: string | null;
}

/**
 * A STORE ORDER'S DELIVERED LINE (review F7). A community store's order earns
 * no Levonis review points, and its money waits for the customer's «استلمت
 * طلبي» (or three days) — so the line asks for THAT, promises nothing, and
 * opens the order itself. Sorani: the Arabic, until the owner writes it by
 * hand (DECISIONS row 11). OWNER: Sorani to be written by hand.
 */
const STORE_DELIVERED = {
  ar: { line: (order: string) => `وصل طلبك ${order}. استلمت طلبك؟ أكّد الاستلام.`, cta: 'أكّد الاستلام' },
  en: { line: (order: string) => `Order ${order} was delivered. Got your order? Confirm receipt.`, cta: 'Confirm receipt' },
} as const;

function storeOrderPath(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}`;
}

/**
 * ONE ORDER, ONE LANGUAGE DECISION — and it is not made here.
 *
 * This file used to map `u.locale` itself (`'en'→en`, `'ku'|'ckb'→ckb`, else
 * 'ar'), which is the same mapping the fan-out in `customerNotify.ts` makes a
 * moment later when it picks the email template. Two mappings of one column is
 * one mapping too many: the day either learns something the other has not,
 * the customer gets a message whose sentence and whose envelope disagree
 * about what language they are in.
 *
 * So the columns the decision needs travel in this row — `NOTIFY_LANG_SELECT`
 * names them — and `notificationLang` is the only place that reads them. See
 * the contract on that function for WHY a stored 'en' is not always an answer.
 */
async function loadOrderRow(env: Env, orderId: string): Promise<OrderRow | null> {
  return env.DB.prepare(
    `SELECT o.id, o.user_id, o.total_iqd, o.due_on_delivery_iqd, o.seller_type, ${NOTIFY_LANG_SELECT}
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id = ?`
  )
    .bind(orderId)
    .first<OrderRow>()
    .catch(() => null);
}

/**
 * "We have your order." Queued once per order — the event key is the order
 * id, so a replayed checkout (the idempotency-key path) re-notifies nobody.
 */
export async function notifyOrderPlaced(env: Env, orderId: string): Promise<void> {
  try {
    const row = await loadOrderRow(env, orderId);
    if (!row) return;
    const t = COPY[notificationLang(row)];
    const msg: CustomerMessage = {
      subject: t.placedSubject(row.id),
      body: t.placedBody(row.id),
      details: [
        // No «رقم الطلب» line: the number is in the sentence above, and on a
        // lock screen the money is the only thing worth a second line.
        { label: t.totalLabel, value: iqd(row.total_iqd) },
        // Only when there IS something to pay on the door — a zero line reads
        // as a charge nobody expected.
        ...(row.due_on_delivery_iqd > 0
          ? [{ label: t.dueLabel, value: iqd(row.due_on_delivery_iqd) }]
          : []),
      ],
    };
    await notifyCustomer(env, row.user_id, `order.placed:${row.id}`, msg);
  } catch (e) {
    console.error('notifyOrderPlaced failed for', orderId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * HOW A CALLER WITH A REQUEST GETS THE MESSAGE OUT NOW, NOT AT THE NEXT CRON.
 *
 * `notifyCustomer` only ENQUEUES. The rows then waited for the fifteen-minute
 * cron, and that cron drains the outbox oldest-first — so an owner who changed a status
 * and watched their phone for the Telegram message saw nothing for up to a
 * quarter of an hour and concluded, reasonably, that it was broken. A caller
 * that has an ExecutionContext passes its `waitUntil` here, and the rows this
 * ONE event produced are sent straight after the response — by prefix, so an
 * older backlog at the head of the queue cannot hold them up.
 *
 * Optional, and absent on every path with no request behind it (the courier
 * sync, the sweeps): those keep the cron, which is what they always had.
 */
export interface NotifyDelivery {
  defer?: (work: Promise<unknown>) => void;
}

/** The outbox rows of ONE order-status event, sent now. Never throws. */
export async function flushOrderStatusNotice(env: Env, orderId: string, status: string): Promise<void> {
  try {
    await processOutbox(env, 5, { eventKeyPrefix: `order.status.${status}:${orderId}:` });
  } catch (e) {
    console.error('flushOrderStatusNotice failed for', orderId, status, e instanceof Error ? e.message : String(e));
  }
}

/**
 * "Your order moved." The event key carries the STATUS, so an order that
 * legitimately reaches `shipped` twice (reversed and re-shipped) notifies
 * once — which is the honest reading: the customer already knows it shipped.
 */
export async function notifyOrderStatus(
  env: Env,
  orderId: string,
  status: string,
  delivery: NotifyDelivery = {}
): Promise<void> {
  try {
    if (!isNotifiedOrderStatus(status)) return;
    // ONE WRITER OF THE DELIVERED MESSAGE. Delivery is the only status that
    // also owes the customer a button, and both doors that reach it share this
    // event key — so if this function built its own version, which of the two
    // arrived first would decide whether the customer got the button, for ever
    // (the loser's enqueue is a no-op).
    if (status === 'delivered') {
      await notifyOrderDelivered(env, orderId);
    } else {
      const row = await loadOrderRow(env, orderId);
      if (!row) return;
      const t = COPY[notificationLang(row)];
      const eventKey = `order.status.${status}:${row.id}`;

      /*
       * THE FLOOR, FOR EVERY STATUS — not only for `delivered`.
       *
       * «الإشعارات لا تصل للمستخدم عند تحديث حالة طلبه». The outbox rows below
       * exist only for a customer with a verified email, a verified WhatsApp
       * or a linked Telegram; a customer with none of the three was told
       * nothing at all about confirmed, shipped or cancelled, and their bell
       * stayed empty. The in-app row needs no channel. Same shape and same
       * reasons as the delivered row below: a PATH for the link, ar/en titles
       * (the bell falls back to Arabic for Sorani), and the status in the
       * event key so a reversed-and-repeated status is one row, not two.
       *
       * The cancelled sentence carries no number, so the in-app title adds it:
       * a bell entry reading «تم إلغاء طلبك» beside three orders says nothing.
       */
      await notify(env.DB, {
        userId: row.user_id,
        kind: 'order_update',
        title_ar:
          status === 'cancelled'
            ? `${COPY.ar.status.cancelled(row.id)} (${COPY.ar.orderLabel} ${row.id})`
            : COPY.ar.status[status](row.id),
        title_en:
          status === 'cancelled'
            ? `${COPY.en.status.cancelled(row.id)} (${COPY.en.orderLabel} ${row.id})`
            : COPY.en.status[status](row.id),
        link: `/orders/${encodeURIComponent(row.id)}`,
        entity_type: 'order',
        entity_id: row.id,
        eventKey,
      });

      const msg: CustomerMessage = {
        subject: t.statusSubject(row.id),
        body: t.status[status](row.id),
        // Only the cancelled line keeps the number on a line of its own, because
        // only the cancelled SENTENCE was left unchanged — see the copy note.
        // The subject is no substitute: WhatsApp and Telegram never see it.
        ...(status === 'cancelled' ? { details: [{ label: t.orderLabel, value: row.id }] } : {}),
      };
      await notifyCustomer(env, row.user_id, eventKey, msg);
    }
    if (delivery.defer) delivery.defer(flushOrderStatusNotice(env, orderId, status));
  } catch (e) {
    console.error('notifyOrderStatus failed for', orderId, status, e instanceof Error ? e.message : String(e));
  }
}

/**
 * «تم توصيل طلبك» — THE ONE MESSAGE THAT ASKS FOR SOMETHING BACK.
 *
 * WHY IT IS ITS OWN FUNCTION. Every other status is one sentence on whatever
 * channels exist. Delivery owes the customer three things that the generic
 * path cannot express:
 *
 *   1. AN IN-APP ROW, WRITTEN UNCONDITIONALLY. It needs no verified address,
 *      no linked phone and no bot, and it is the only artefact of this message
 *      the customer can still find tomorrow — a WhatsApp line scrolls away and
 *      a customer with no channel at all would otherwise be told nothing by a
 *      shop that owes them points for a review. Written FIRST for that reason.
 *   2. A BUTTON, on the one channel that can carry one, degrading to a bare
 *      tappable URL on WhatsApp and in the mail — see `CustomerMessage.cta`.
 *   3. A DESTINATION THAT IS A TASK, not a list — `needs_review=1`.
 *
 * THE EVENT KEY IS THE STATUS, NEVER `delivered_at`. Both keys here —
 * `user_notifications` (unique per user) and the outbox's (unique globally) —
 * are `order.status.delivered:<id>`, so an order reversed to shipped and
 * delivered again notifies exactly ONCE. That is the honest reading: the
 * customer already knows it arrived, and the second message would be the shop
 * asking twice for the same review. Keying on the timestamp would have made
 * every correction a fresh message — and `delivered_at` is the wrong column
 * for a second reason, since both delivered doors now COALESCE it (92c4adf)
 * precisely so a re-flip cannot restart a customer's warranty and return
 * clocks. It does not move, so it cannot mark a second event either.
 *
 * Never throws: an order must not fail to be delivered because a notification
 * could not be queued.
 */
export async function notifyOrderDelivered(env: Env, orderId: string): Promise<void> {
  try {
    const row = await loadOrderRow(env, orderId);
    if (!row) return;
    const t = COPY[notificationLang(row)];
    const eventKey = `order.status.delivered:${row.id}`;
    if (row.seller_type === 'merchant') {
      const lang = notificationLang(row);
      const copy = lang === 'en' ? STORE_DELIVERED.en : STORE_DELIVERED.ar;
      const path = storeOrderPath(row.id);
      const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
      await notify(env.DB, {
        userId: row.user_id,
        kind: 'order_update',
        title_ar: STORE_DELIVERED.ar.line(row.id),
        title_en: STORE_DELIVERED.en.line(row.id),
        link: path,
        entity_type: 'order',
        entity_id: row.id,
        eventKey,
      });
      await notifyCustomer(env, row.user_id, eventKey, {
        subject: t.statusSubject(row.id),
        body: copy.line(row.id),
        ...(origin.startsWith('https://') ? { cta: { label: copy.cta, url: `${origin}${path}` } } : {}),
      });
      return;
    }
    const url = reviewLandingUrl(env);

    // THE FLOOR. `link` is a PATH, never an absolute URL — the column's own
    // rule (lib/notifications.ts): a stored origin is a stored mistake waiting
    // for the day the domain changes. The outbound CTA is absolute because a
    // chat message has no site to be relative to; this one is inside the site.
    //
    // The title is the whole line and the body is empty: it is already one
    // short sentence, and splitting it would only repeat half of it. Stored in
    // ar/en because the column has no Sorani pair — the bell falls back to the
    // Arabic, deliberately, never to the English.
    await notify(env.DB, {
      userId: row.user_id,
      kind: 'order_update',
      title_ar: COPY.ar.status.delivered(row.id),
      title_en: COPY.en.status.delivered(row.id),
      link: REVIEW_PATH,
      entity_type: 'order',
      entity_id: row.id,
      eventKey,
    });

    const msg: CustomerMessage = {
      subject: t.statusSubject(row.id),
      body: t.status.delivered(row.id),
      // No details line at all: the number is in the sentence, and the link is
      // the last line the message needs.
      ...(url ? { cta: { label: t.reviewCta, url } } : {}),
    };
    await notifyCustomer(env, row.user_id, eventKey, msg);
  } catch (e) {
    console.error('notifyOrderDelivered failed for', orderId, e instanceof Error ? e.message : String(e));
  }
}
