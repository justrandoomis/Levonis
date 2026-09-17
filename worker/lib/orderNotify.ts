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
 * The copy is deliberately SHORT. These arrive on WhatsApp and Telegram as
 * well as email, and on a phone the lock-screen preview is often the whole
 * interaction — the order number and what happened have to fit in it.
 *
 * NEVER THROWS, always `waitUntil`-able: an order must not fail to be placed,
 * and a status must not fail to change, because a notification could not be
 * queued.
 */

import type { Env } from './types';
import { notifyCustomer, type CustomerMessage } from './customerNotify';
import type { EmailLang } from './emailTemplates';

/** The transitions worth telling a customer about. `processing` is not one. */
export const NOTIFIED_ORDER_STATUSES = ['confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type NotifiedOrderStatus = (typeof NOTIFIED_ORDER_STATUSES)[number];

export function isNotifiedOrderStatus(v: string): v is NotifiedOrderStatus {
  return (NOTIFIED_ORDER_STATUSES as readonly string[]).includes(v);
}

interface OrderCopy {
  placedSubject: (order: string) => string;
  placedBody: string;
  orderLabel: string;
  totalLabel: string;
  dueLabel: string;
  statusSubject: (order: string) => string;
  status: Record<NotifiedOrderStatus, string>;
}

const COPY: Record<EmailLang, OrderCopy> = {
  ar: {
    placedSubject: (order) => `تم استلام طلبك ${order}`,
    placedBody: 'وصلنا طلبك وهو قيد المراجعة الآن. سنخبرك عند تأكيده وعند شحنه.',
    orderLabel: 'رقم الطلب',
    totalLabel: 'الإجمالي',
    dueLabel: 'المستحق عند الاستلام',
    statusSubject: (order) => `تحديث على طلبك ${order}`,
    status: {
      confirmed: 'تم تأكيد طلبك ويجري تجهيزه الآن.',
      shipped: 'تم شحن طلبك وهو في الطريق إليك.',
      delivered: 'تم تسليم طلبك. شكراً لثقتك بليفونيس.',
      cancelled: 'تم إلغاء طلبك. إن لم تطلب ذلك، تواصل معنا فوراً.',
    },
  },
  en: {
    placedSubject: (order) => `We received your order ${order}`,
    placedBody: 'Your order has reached us and is being reviewed. We will tell you when it is confirmed and when it ships.',
    orderLabel: 'Order',
    totalLabel: 'Total',
    dueLabel: 'Due on delivery',
    statusSubject: (order) => `Update on your order ${order}`,
    status: {
      confirmed: 'Your order is confirmed and is being prepared.',
      shipped: 'Your order has shipped and is on its way to you.',
      delivered: 'Your order has been delivered. Thank you for choosing LEVONIS.',
      cancelled: 'Your order has been cancelled. If you did not ask for this, contact us right away.',
    },
  },
  ckb: {
    placedSubject: (order) => `داواکارییەکەت ${order} وەرگیرا`,
    placedBody: 'داواکارییەکەت پێمان گەیشت و ئێستا پێداچوونەوەی بۆ دەکرێت. ئاگادارت دەکەینەوە کاتێک پشتڕاست دەکرێتەوە و کاتێک دەنێردرێت.',
    orderLabel: 'ژمارەی داواکاری',
    totalLabel: 'کۆی گشتی',
    dueLabel: 'پارەی کاتی وەرگرتن',
    statusSubject: (order) => `نوێکارییەک لەسەر داواکارییەکەت ${order}`,
    status: {
      confirmed: 'داواکارییەکەت پشتڕاستکرایەوە و ئامادە دەکرێت.',
      shipped: 'داواکارییەکەت نێردرا و لە ڕێگایە بۆت.',
      delivered: 'داواکارییەکەت گەیەندرا. سوپاس بۆ متمانەت بە لیڤۆنیس.',
      cancelled: 'داواکارییەکەت هەڵوەشێندرایەوە. ئەگەر تۆ داوات نەکردووە، یەکسەر پەیوەندیمان پێوە بکە.',
    },
  },
};

/** Integers, grouped, LTR-safe at the template level. */
function iqd(n: number): string {
  return `${Math.trunc(n).toLocaleString('en-US')} IQD`;
}

interface OrderRow {
  id: string;
  user_id: string;
  locale: string | null;
  total_iqd: number;
  due_on_delivery_iqd: number;
}

async function loadOrderRow(env: Env, orderId: string): Promise<OrderRow | null> {
  return env.DB.prepare(
    `SELECT o.id, o.user_id, o.total_iqd, o.due_on_delivery_iqd, u.locale
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id = ?`
  )
    .bind(orderId)
    .first<OrderRow>()
    .catch(() => null);
}

function langOf(locale: string | null): EmailLang {
  if (locale === 'en') return 'en';
  if (locale === 'ku' || locale === 'ckb') return 'ckb';
  return 'ar';
}

/**
 * "We have your order." Queued once per order — the event key is the order
 * id, so a replayed checkout (the idempotency-key path) re-notifies nobody.
 */
export async function notifyOrderPlaced(env: Env, orderId: string): Promise<void> {
  try {
    const row = await loadOrderRow(env, orderId);
    if (!row) return;
    const t = COPY[langOf(row.locale)];
    const msg: CustomerMessage = {
      subject: t.placedSubject(row.id),
      body: t.placedBody,
      details: [
        { label: t.orderLabel, value: row.id },
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
 * "Your order moved." The event key carries the STATUS, so an order that
 * legitimately reaches `shipped` twice (reversed and re-shipped) notifies
 * once — which is the honest reading: the customer already knows it shipped.
 */
export async function notifyOrderStatus(env: Env, orderId: string, status: string): Promise<void> {
  try {
    if (!isNotifiedOrderStatus(status)) return;
    const row = await loadOrderRow(env, orderId);
    if (!row) return;
    const t = COPY[langOf(row.locale)];
    const msg: CustomerMessage = {
      subject: t.statusSubject(row.id),
      body: t.status[status],
      details: [{ label: t.orderLabel, value: row.id }],
    };
    await notifyCustomer(env, row.user_id, `order.status.${status}:${row.id}`, msg);
  } catch (e) {
    console.error('notifyOrderStatus failed for', orderId, status, e instanceof Error ? e.message : String(e));
  }
}
