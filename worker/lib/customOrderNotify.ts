/**
 * THE CUSTOM ORDER'S LIFECYCLE, TOLD TO THE OTHER SIDE (review F4).
 *
 * A custom (print-request) order used to move silently: the merchant started
 * work, marked it delivered, or raised a dispute, and the customer heard
 * nothing; the customer cancelled and the merchant heard nothing; an admin
 * decided a disputed escrow and neither side was told, nor was the merchant
 * told that money had reached their balance. Each sender below is called by
 * the route that performed the event, after its write committed, and:
 *
 *   - is KEYED on the order and the event (`custom_order:<id>:<event>`), so a
 *     retried request, a replayed decision or a second tap announces nothing
 *     twice — the in-app row is unique per (user, event key), the outbound
 *     rows per event key;
 *   - RESPECTS PREFERENCES: the merchant's through `notifyMerchant` (their
 *     switch per kind decides the outside channels), the customer's through
 *     `notifyCustomer` (only the channels they linked and left on);
 *   - DEEP-LINKS: the merchant to the order's workspace address
 *     (`merchantHref.customOrder`), the customer to their request, where the
 *     order card and its «أكّد الاستلام» live;
 *   - is TOTAL: never throws into the route that called it.
 *
 * Sorani: ar/en only; the bell shows a Sorani reader the Arabic (DECISIONS
 * row 11). OWNER: Sorani to be written by hand.
 */
import type { Env } from './types';
import { notify } from './notifications';
import { notifyCustomer, type CustomerMessage } from './customerNotify';
import { notifyMerchant, notifyPayoutAvailable, type MerchantNotifyResult } from './merchantNotify';
import { merchantHref } from '@levonis/contracts/merchantRoutes';

/** An id or a figure inside Arabic copy, isolated so the RTL paragraph never reorders it. */
const iso = (s: string | number) => `⁨${s}⁩`;
const money = (iqd: number) => Math.max(0, Math.trunc(Number(iqd) || 0)).toLocaleString('en-US');

interface OrderFacts {
  id: string;
  request_id: string;
  customer_id: string;
  merchant_id: string;
  auto_complete_at: string | null;
}

async function orderFacts(env: Env, orderId: string): Promise<OrderFacts | null> {
  return env.DB.prepare(
    'SELECT id, request_id, customer_id, merchant_id, auto_complete_at FROM community_orders WHERE id = ?'
  )
    .bind(orderId)
    .first<OrderFacts>();
}

/** Where the customer reads their custom order: the request page, with its order card. */
export function customOrderCustomerLink(requestId: string): string {
  return `/requests?request=${encodeURIComponent(requestId)}`;
}

/** «١٢ أكتوبر» / «12 Oct» — the date only, in UTC (the clock the sweep runs on). */
function day(isoTs: string, lang: 'ar' | 'en'): string {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

async function customerLang(env: Env, userId: string): Promise<'ar' | 'en'> {
  const row = await env.DB.prepare('SELECT locale FROM users WHERE id = ?').bind(userId).first<{ locale: string | null }>();
  return row?.locale === 'en' ? 'en' : 'ar';
}

/** The in-app row and the outside channels, for the customer of one order. */
async function tellCustomer(
  env: Env,
  o: OrderFacts,
  event: string,
  copy: { title_ar: string; title_en: string; body_ar: string; body_en: string },
  meta: Record<string, unknown> = {}
): Promise<boolean> {
  const eventKey = `custom_order:${o.id}:${event}`;
  const link = customOrderCustomerLink(o.request_id);
  const id = await notify(env.DB, {
    userId: o.customer_id,
    kind: 'order_update',
    title_ar: copy.title_ar,
    title_en: copy.title_en,
    body_ar: copy.body_ar,
    body_en: copy.body_en,
    link,
    entity_type: 'custom_order',
    entity_id: o.id,
    meta: { ...meta, event, request_id: o.request_id },
    eventKey,
  });
  // A replay wrote nothing in-app, and queues nothing outside either.
  if (!id) return false;
  const lang = await customerLang(env, o.customer_id);
  const msg: CustomerMessage = {
    subject: lang === 'en' ? copy.title_en : copy.title_ar,
    body: lang === 'en' ? copy.body_en : copy.body_ar,
  };
  await notifyCustomer(env, o.customer_id, eventKey, msg);
  return true;
}

/** «بدأت الورشة العمل على طلبك» — the merchant's «ابدأ العمل». */
export async function notifyCustomOrderStarted(env: Env, orderId: string): Promise<boolean> {
  try {
    const o = await orderFacts(env, orderId);
    if (!o) return false;
    return await tellCustomer(env, o, 'started', {
      title_ar: 'بدأت الورشة العمل على طلبك',
      title_en: 'The workshop started work on your order',
      body_ar: `بدأ تنفيذ الطلب ${iso(o.id)}. مبلغك محجوز لدى Levonis حتى تؤكّد الاستلام.`,
      body_en: `Work on order ${o.id} has started. Levonis holds your money until you confirm receipt.`,
    });
  } catch (e) {
    console.error('custom order started notice failed', orderId, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * «سلّمت الورشة طلبك — أكّد الاستلام». With the auto-complete date when the
 * owner has one set: the customer must know the money moves on its own then.
 */
export async function notifyCustomOrderDelivered(env: Env, orderId: string): Promise<boolean> {
  try {
    const o = await orderFacts(env, orderId);
    if (!o) return false;
    const auto = o.auto_complete_at;
    return await tellCustomer(
      env,
      o,
      'delivered',
      {
        title_ar: 'سلّمت الورشة طلبك — أكّد الاستلام',
        title_en: 'The workshop delivered your order — confirm receipt',
        body_ar: auto
          ? `إذا وصلك الطلب ${iso(o.id)} كما اتفقتما فاضغط «أكّد الاستلام». إن لم تؤكّد ولم تفتح نزاعًا يكتمل الطلب تلقائيًا في ${iso(day(auto, 'ar'))}.`
          : `إذا وصلك الطلب ${iso(o.id)} كما اتفقتما فاضغط «أكّد الاستلام»، أو افتح نزاعًا إن كانت هناك مشكلة.`,
        body_en: auto
          ? `If order ${o.id} arrived as agreed, tap "Confirm receipt". Unless you confirm or open a dispute, it completes automatically on ${day(auto, 'en')}.`
          : `If order ${o.id} arrived as agreed, tap "Confirm receipt" — or open a dispute if something is wrong.`,
      },
      { auto_complete_at: auto }
    );
  } catch (e) {
    console.error('custom order delivered notice failed', orderId, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** «ألغى الزبون الطلب المخصص — لا تبدأ العمل» — the customer's cancel before work started. */
export async function notifyCustomOrderCancelledByCustomer(env: Env, orderId: string): Promise<MerchantNotifyResult> {
  try {
    const o = await orderFacts(env, orderId);
    if (!o) return { written: false, outbound: [] };
    return await notifyMerchant(env, { merchantId: o.merchant_id }, {
      kind: 'order_needs_action',
      title_ar: `ألغى الزبون الطلب المخصص ${iso(o.id)} — لا تبدأ العمل`,
      title_en: `The customer cancelled custom order ${o.id} — do not start work`,
      body_ar: 'أُعيد المبلغ المحجوز إلى محفظة الزبون، ولم يعد ملف التصميم متاحًا لك.',
      body_en: 'The held money went back to the customer’s wallet, and the design file is no longer available to you.',
      link: merchantHref.customOrder(o.id),
      entity_type: 'custom_order',
      entity_id: o.id,
      eventKey: `custom_order:${o.id}:cancelled_by_customer`,
    });
  } catch (e) {
    console.error('custom order cancel notice failed', orderId, e instanceof Error ? e.message : String(e));
    return { written: false, outbound: [] };
  }
}

/**
 * «فتحت الورشة نزاعًا على طلبك» — the merchant raised it; the customer is the
 * other party. The merchant's words are not in it: the admin desk reads them.
 */
export async function notifyCustomOrderDisputedByMerchant(env: Env, orderId: string, complaintId: string): Promise<boolean> {
  try {
    const o = await orderFacts(env, orderId);
    if (!o) return false;
    return await tellCustomer(
      env,
      o,
      `dispute:${complaintId}`,
      {
        title_ar: `فتحت الورشة نزاعًا على الطلب ${iso(o.id)}`,
        title_en: `The workshop opened a dispute on order ${o.id}`,
        body_ar: 'مبلغك يبقى محجوزًا لدى Levonis حتى تقرّر الإدارة. سيتواصل معك الفريق إن احتاج إلى ردك.',
        body_en: 'Your money stays held by Levonis until the admin team decides. The team will contact you if they need your side.',
      },
      { complaint_id: complaintId }
    );
  } catch (e) {
    console.error('custom order merchant-dispute notice failed', orderId, e instanceof Error ? e.message : String(e));
    return false;
  }
}

export type EscrowDecision = 'release' | 'refund' | 'partial_refund';

/** What the merchant's ledger received from this escrow — the ledger's own figure, never the caller's. */
async function escrowCreditedIqd(env: Env, escrowId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_iqd), 0) AS n FROM merchant_ledger_entries
      WHERE escrow_id = ? AND kind IN ('escrow_release','commission')`
  )
    .bind(escrowId)
    .first<{ n: number }>();
  return Math.max(0, Number(row?.n) || 0);
}

/**
 * AN ADMIN DECIDED THE DISPUTE — BOTH SIDES ARE TOLD, and when money reached
 * the merchant's ledger, «صار مبلغ متاحًا» follows from the ledger's figure.
 * Keyed on the order and the decision, so a replayed decision tells nobody
 * twice. The refunded amount is the customer's to know; the admin's reason
 * stays on the complaint.
 */
export async function notifyEscrowResolved(
  env: Env,
  p: { orderId: string; escrowId: string; decision: EscrowDecision; refundedIqd: number }
): Promise<void> {
  try {
    const o = await orderFacts(env, p.orderId);
    if (!o) return;
    const credited = p.decision === 'refund' ? 0 : await escrowCreditedIqd(env, p.escrowId);
    const refund = money(p.refundedIqd);
    const customerCopy =
      p.decision === 'release'
        ? {
            title_ar: `قرّرت Levonis النزاع على الطلب ${iso(o.id)}`,
            title_en: `Levonis decided the dispute on order ${o.id}`,
            body_ar: 'قرّرت الإدارة تحويل المبلغ إلى الورشة، واكتمل الطلب.',
            body_en: 'The admin team released the money to the workshop, and the order is complete.',
          }
        : p.decision === 'refund'
          ? {
              title_ar: `أُعيد إليك مبلغ الطلب ${iso(o.id)}`,
              title_en: `Order ${o.id} was refunded to you`,
              body_ar: `قرّرت الإدارة إعادة المبلغ كاملًا (${iso(refund)} د.ع) إلى محفظتك.`,
              body_en: `The admin team refunded the full amount (${refund} IQD) to your wallet.`,
            }
          : {
              title_ar: `أُعيد إليك جزء من مبلغ الطلب ${iso(o.id)}`,
              title_en: `Part of order ${o.id} was refunded to you`,
              body_ar: `قرّرت الإدارة إعادة ${iso(refund)} د.ع إلى محفظتك، وتحويل الباقي إلى الورشة.`,
              body_en: `The admin team refunded ${refund} IQD to your wallet and released the rest to the workshop.`,
            };
    await tellCustomer(env, o, `resolved:${p.decision}`, customerCopy, { decision: p.decision, refunded_iqd: p.refundedIqd });

    const merchantBody =
      p.decision === 'release'
        ? { ar: 'قرّرت الإدارة تحويل المبلغ إليك، واكتمل الطلب.', en: 'The admin team released the money to you, and the order is complete.' }
        : p.decision === 'refund'
          ? { ar: 'قرّرت الإدارة إعادة المبلغ كاملًا إلى الزبون.', en: 'The admin team refunded the full amount to the customer.' }
          : {
              ar: `قرّرت الإدارة إعادة ${iso(refund)} د.ع إلى الزبون وتحويل الباقي إليك.`,
              en: `The admin team refunded ${refund} IQD to the customer and released the rest to you.`,
            };
    await notifyMerchant(env, { merchantId: o.merchant_id }, {
      kind: 'dispute_resolved',
      title_ar: `قرّرت Levonis النزاع على الطلب ${iso(o.id)}`,
      title_en: `Levonis decided the dispute on order ${o.id}`,
      body_ar: merchantBody.ar,
      body_en: merchantBody.en,
      link: merchantHref.customOrder(o.id),
      entity_type: 'custom_order',
      entity_id: o.id,
      meta: { decision: p.decision, refunded_iqd: p.refundedIqd },
      eventKey: `custom_order:${o.id}:resolved:${p.decision}`,
    });
    if (credited > 0) {
      await notifyPayoutAvailable(env, {
        merchantId: o.merchant_id,
        amountIqd: credited,
        // The confirm route's key: one custom order's money is announced once,
        // whichever door settled it.
        sourceKey: `community_order:${o.id}`,
        communityOrderId: o.id,
      });
    }
  } catch (e) {
    console.error('escrow resolution notices failed', p.orderId, e instanceof Error ? e.message : String(e));
  }
}
