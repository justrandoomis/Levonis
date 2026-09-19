/**
 * THE TWO MESSAGES THE PLATFORM PROMISED AND NEVER SENT.
 *
 * `worker/lib/orderNotify.ts` is the only thing on this platform that has ever
 * called `notifyCustomer`. That is a fact worth stating plainly, because a
 * review of src/components/notify/ChannelNudge.tsx found the consequence: the
 * sheet that appears after a success and asks a customer to turn on WhatsApp or
 * Telegram offered them three reasons, and TWO OF THEM WERE NOT TRUE.
 *
 *   • «فعّل قناة لتصلك ردود الدعم على تذكرتك» — a staff reply on a support
 *     ticket reached the customer through NOTHING. Not WhatsApp, not Telegram,
 *     not email, and not even a `user_notifications` row: the only way to learn
 *     that support had answered was to open the site and look, which is the
 *     exact behaviour the sheet says the channel will save them from.
 *   • «فعّل قناة لتصلك عروض التجار على طلبك فور وصولها» — `'offer_received'` has
 *     been declared in `NotificationKind` since 0045 and was never once written.
 *     Merchants are told a request matched them (printRequests.ts); the customer
 *     whose request it is was told nothing when an offer arrived.
 *
 * ASKING SOMEBODY TO LINK TELEGRAM AND THEN SENDING THEM NOTHING IS WORSE THAN
 * NOT ASKING. They do it at the moment they care most — they have just paid, or
 * just opened a ticket — hear silence, and conclude the channel does not work.
 * The next message they DO get, about the order, is then the one they ignore.
 * So the fix is not to soften the sentence; it is to make it true.
 *
 * WHY A FILE OF ITS OWN. `orderNotify.ts` is about ORDERS — its copy table, its
 * status vocabulary and its event keys are all shaped by that. These two events
 * belong to support and to the community marketplace. Keeping them apart means
 * the order-status copy nobody is allowed to break is not edited every time a
 * new kind of message is added.
 *
 * EVERY FUNCTION HERE IS TOTAL. Neither may throw: both are called after a
 * business write has committed — a staff reply, a merchant's offer — and
 * neither a Telegram outage nor a D1 blip may turn that into an error for the
 * person who performed it. The pattern is `orderNotify.ts`'s, deliberately:
 * one try/catch around the whole body, a console.error, and a return.
 *
 * BOTH DOORS, NOT ONE. Each event writes the IN-APP row (`user_notifications`)
 * AND fans out to whatever outbound channel can reach the customer. The in-app
 * row is the floor — it is what makes the nudge's closing reassurance, «في كل
 * الأحوال ستجد التحديثات داخل التطبيق», true for somebody who declines — and
 * the fan-out is what makes accepting worth anything. Writing only one of the
 * two is what produced the false promise in the first place.
 */

import type { Env } from './types';
import { notifyCustomer, type CustomerMessage } from './customerNotify';
import { notify } from './notifications';
import type { EmailLang } from './emailTemplates';

/** Same mapping as orderNotify's: 'ku' is the stored value, 'ckb' the tag. */
function langOf(locale: string | null | undefined): EmailLang {
  if (locale === 'en') return 'en';
  if (locale === 'ku' || locale === 'ckb') return 'ckb';
  return 'ar';
}

async function localeOf(env: Env, userId: string): Promise<EmailLang> {
  const row = await env.DB.prepare('SELECT locale FROM users WHERE id = ?')
    .bind(userId)
    .first<{ locale: string | null }>();
  return langOf(row?.locale ?? null);
}

/**
 * THE COPY IS SHORT BECAUSE THE LOCK SCREEN IS SHORT.
 *
 * `plainNotification` gives every `details` entry a line of its own, so a
 * detail is not a form field — it is another line competing with the sentence
 * that says what happened. Each of these is one sentence carrying the one
 * identifier the customer needs, and nothing else. No thank-you, no promise of
 * a further message.
 *
 * AND THE BODY OF THE REPLY IS NEVER IN IT. A support answer can contain an
 * address, a serial number or a refund figure, and WhatsApp and Telegram are
 * carried by third parties. The message says an answer arrived and where to
 * read it; the answer stays on the site behind the customer's own login.
 */
const COPY = {
  ar: {
    supportSubject: (id: string) => `رد على تذكرتك ${id}`,
    supportBody: (id: string) => `وصلك رد من فريق الدعم على تذكرتك ${id}. افتح «تذاكري» لقراءته.`,
    supportTitle: 'رد من الدعم',
    offerSubject: (id: string) => `عرض جديد على طلبك ${id}`,
    offerBody: (id: string) => `وصلك عرض جديد على طلبك ${id}. افتح الطلب لمقارنة العروض.`,
    offerTitle: 'عرض جديد على طلبك',
    priceLabel: 'السعر',
  },
  en: {
    supportSubject: (id: string) => `Reply on your ticket ${id}`,
    supportBody: (id: string) => `Support answered your ticket ${id}. Open "My tickets" to read it.`,
    supportTitle: 'Support replied',
    offerSubject: (id: string) => `A new offer on your request ${id}`,
    offerBody: (id: string) => `A merchant sent an offer on your request ${id}. Open it to compare offers.`,
    offerTitle: 'A new offer on your request',
    priceLabel: 'Price',
  },
  ckb: {
    supportSubject: (id: string) => `وەڵامێک بۆ تیکێتەکەت ${id}`,
    supportBody: (id: string) => `تیمی پشتگیری وەڵامی تیکێتەکەتی ${id} دایەوە. «تیکێتەکانم» بکەرەوە بۆ خوێندنەوەی.`,
    supportTitle: 'پشتگیری وەڵامی دایەوە',
    offerSubject: (id: string) => `ئۆفەرێکی نوێ بۆ داواکاریەکەت ${id}`,
    offerBody: (id: string) => `بازرگانێک ئۆفەرێکی نوێی ناردووە بۆ داواکاریەکەت ${id}. بیکەرەوە بۆ بەراوردکردنی ئۆفەرەکان.`,
    offerTitle: 'ئۆفەرێکی نوێ بۆ داواکاریەکەت',
    priceLabel: 'نرخ',
  },
} as const;

/**
 * «رد الدعم» — staff answered a ticket, so the person who opened it hears about it.
 *
 * THE EVENT KEY CARRIES THE MESSAGE ID, not the ticket id. A ticket is a
 * conversation: support may answer three times over two days and each answer is
 * news. Keying on the ticket would deliver the first reply and silently swallow
 * every one after it — `notifyCustomer` appends the channel and the uniqueness
 * lives in `outbox`, so a repeated key is a no-op, not a second send.
 *
 * `/support` and not a per-ticket path: the Support page opens its «تذاكري» tab
 * from the page itself and there is no deep link to one ticket today. A link to
 * a screen that exists beats a link to a route that does not.
 */
export async function notifySupportReply(env: Env, ticketId: string, messageId: string): Promise<void> {
  try {
    const ticket = await env.DB.prepare('SELECT id, user_id FROM support_tickets WHERE id = ?')
      .bind(ticketId)
      .first<{ id: string; user_id: string }>();
    if (!ticket) return;
    const t = COPY[await localeOf(env, ticket.user_id)];
    // The in-app row FIRST and unconditionally: it is the floor the nudge's
    // «في كل الأحوال» sentence rests on, and `notify` never throws.
    await notify(env.DB, {
      userId: ticket.user_id,
      kind: 'support_reply',
      title_ar: COPY.ar.supportTitle,
      title_en: COPY.en.supportTitle,
      body_ar: COPY.ar.supportBody(ticket.id),
      body_en: COPY.en.supportBody(ticket.id),
      link: '/support',
      entity_type: 'ticket',
      entity_id: ticket.id,
      meta: { title_ckb: COPY.ckb.supportTitle, body_ckb: COPY.ckb.supportBody(ticket.id) },
      eventKey: `support.reply:${messageId}`,
    });
    const msg: CustomerMessage = {
      subject: t.supportSubject(ticket.id),
      body: t.supportBody(ticket.id),
    };
    await notifyCustomer(env, ticket.user_id, `support.reply:${messageId}`, msg);
  } catch (e) {
    console.error('notifySupportReply failed for', ticketId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * «عرض جديد على طلبك» — a merchant bid, so the customer who posted the request
 * hears about it while the offer is still worth comparing.
 *
 * THE PRICE IS THE ONE DETAIL. It is the number the customer opened the board
 * to see, it is already public to them on that screen, and it is what decides
 * whether they look now or tonight. The merchant's message, materials and
 * warranty text are not included: they are a sales pitch, they belong beside
 * the other offers where they can be compared, and they are up to 2000
 * characters of somebody else's prose on a lock screen.
 *
 * NOT THE MERCHANT'S NAME EITHER. Comparing offers by who sent them, before
 * seeing the prices side by side, is the behaviour §27 built the reputation
 * columns to replace.
 */
export async function notifyOfferReceived(env: Env, offerId: string): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT o.id, o.price_iqd, o.request_id, r.customer_id
         FROM community_offers o
         JOIN community_requests r ON r.id = o.request_id
        WHERE o.id = ?`
    )
      .bind(offerId)
      .first<{ id: string; price_iqd: number; request_id: string; customer_id: string }>();
    if (!row) return;
    const t = COPY[await localeOf(env, row.customer_id)];
    const price = `${Number(row.price_iqd || 0).toLocaleString()} IQD`;
    await notify(env.DB, {
      userId: row.customer_id,
      kind: 'offer_received',
      title_ar: COPY.ar.offerTitle,
      title_en: COPY.en.offerTitle,
      body_ar: COPY.ar.offerBody(row.request_id),
      body_en: COPY.en.offerBody(row.request_id),
      // The request, not the offer: the customer is being sent somewhere to
      // COMPARE, and one offer on its own is the screen that cannot do that.
      link: `/requests?request=${row.request_id}`,
      entity_type: 'offer',
      entity_id: row.id,
      meta: {
        price_iqd: row.price_iqd,
        title_ckb: COPY.ckb.offerTitle,
        body_ckb: COPY.ckb.offerBody(row.request_id),
      },
      // Per OFFER, so a second merchant bidding is a second message — which is
      // the point — while one merchant's offer can never be announced twice.
      eventKey: `offer_received:${row.id}`,
    });
    const msg: CustomerMessage = {
      subject: t.offerSubject(row.request_id),
      body: t.offerBody(row.request_id),
      details: [{ label: t.priceLabel, value: price }],
    };
    await notifyCustomer(env, row.customer_id, `offer_received:${row.id}`, msg);
  } catch (e) {
    console.error('notifyOfferReceived failed for', offerId, e instanceof Error ? e.message : String(e));
  }
}
