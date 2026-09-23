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
    complaintSubject: (id: string) => `رد على شكواك ${id}`,
    complaintShort: (id: string) => `وصلك رد من إدارة ليفونيس على شكواك ${id}. افتح الإشعارات في التطبيق لقراءته.`,
    complaintTitle: 'رد على شكواك',
  },
  en: {
    supportSubject: (id: string) => `Reply on your ticket ${id}`,
    supportBody: (id: string) => `Support answered your ticket ${id}. Open "My tickets" to read it.`,
    supportTitle: 'Support replied',
    offerSubject: (id: string) => `A new offer on your request ${id}`,
    offerBody: (id: string) => `A merchant sent an offer on your request ${id}. Open it to compare offers.`,
    offerTitle: 'A new offer on your request',
    priceLabel: 'Price',
    complaintSubject: (id: string) => `Reply on your complaint ${id}`,
    complaintShort: (id: string) => `Levonis answered your complaint ${id}. Open your notifications in the app to read it.`,
    complaintTitle: 'A reply on your complaint',
  },
  ckb: {
    supportSubject: (id: string) => `وەڵامێک بۆ تیکێتەکەت ${id}`,
    supportBody: (id: string) => `تیمی پشتگیری وەڵامی تیکێتەکەتی ${id} دایەوە. «تیکێتەکانم» بکەرەوە بۆ خوێندنەوەی.`,
    supportTitle: 'پشتگیری وەڵامی دایەوە',
    offerSubject: (id: string) => `ئۆفەرێکی نوێ بۆ داواکاریەکەت ${id}`,
    offerBody: (id: string) => `بازرگانێک ئۆفەرێکی نوێی ناردووە بۆ داواکاریەکەت ${id}. بیکەرەوە بۆ بەراوردکردنی ئۆفەرەکان.`,
    offerTitle: 'ئۆفەرێکی نوێ بۆ داواکاریەکەت',
    priceLabel: 'نرخ',
    // OWNER: the Sorani for the three complaint lines is yours to write by
    // hand. They carry the ARABIC text on purpose — no Kurdish is generated
    // here, and Arabic is the closer of the two for a Sorani reader (the same
    // choice src/components/notifications/NotificationBell.tsx already makes
    // when it falls back).
    complaintSubject: (id: string) => `رد على شكواك ${id}`, // OWNER: Sorani by hand.
    complaintShort: (id: string) => `وصلك رد من إدارة ليفونيس على شكواك ${id}. افتح الإشعارات في التطبيق لقراءته.`, // OWNER: Sorani by hand.
    complaintTitle: 'رد على شكواك', // OWNER: Sorani by hand.
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

/**
 * «الشكاوى» — AN ADMIN ANSWERED, SO THE PERSON WHO COMPLAINED IS TOLD.
 *
 * WHY THIS HAD TO EXIST BEFORE THE REPLY ROUTE COULD BE CALLED FINISHED.
 * `community_complaint_messages` has existed since migration 0031 and nothing
 * in the repository ever inserted into it; a reply route closed that half. But
 * there is still NO CUSTOMER-FACING SCREEN anywhere in `src/` that reads that
 * table — the only customer touch on a complaint is `POST
 * /api/marketplace/orders/:id/dispute`, which files one and never reads it
 * back. So a reply written into the thread would have been a sentence typed
 * into a room with no door: an admin believing they had answered, and a
 * customer still waiting.
 *
 * THE IN-APP ROW CARRIES THE TEXT, AND THE OUTBOUND CHANNELS DO NOT. That
 * split is deliberate and it follows the rule stated on the COPY table above:
 * WhatsApp and Telegram are carried by third parties and a complaint answer
 * can name an amount, an address or another person, so the outbound line says
 * only that an answer arrived. `user_notifications` is behind the customer's
 * own login, exactly as a page on the site would be, so that is where the
 * answer itself lives — and it is the only place it currently CAN live.
 *
 * AN INTERNAL NOTE IS NEVER SENT. The caller only reaches this function for a
 * public reply; the column exists so a dispute desk can write to itself, and
 * mailing that to the person it is about is the worst outcome this feature
 * has. The guard is at the call site AND the contract is stated here, because
 * one of the two being forgotten is how it would happen.
 *
 * TOTAL, like everything else in this file: it is called after the message
 * row has committed, and neither a Telegram outage nor a D1 blip may turn an
 * admin's sent reply into an error on their screen.
 */
export async function notifyComplaintReply(
  env: Env,
  complaintId: string,
  messageId: string,
  replyText: string
): Promise<void> {
  try {
    const complaint = await env.DB.prepare('SELECT id, reporter_id FROM community_complaints WHERE id = ?')
      .bind(complaintId)
      .first<{ id: string; reporter_id: string }>();
    if (!complaint) return;
    const t = COPY[await localeOf(env, complaint.reporter_id)];

    /**
     * THE EVENT KEY CARRIES THE MESSAGE ID, not the complaint id — the same
     * reasoning as `notifySupportReply`. A dispute is a conversation and the
     * third answer is as much news as the first; keying on the complaint would
     * deliver one reply and silently swallow every one after it.
     */
    await notify(env.DB, {
      userId: complaint.reporter_id,
      kind: 'complaint_reply',
      title_ar: COPY.ar.complaintTitle,
      title_en: COPY.en.complaintTitle,
      // The answer itself. There is nowhere else the reporter can read it.
      body_ar: replyText,
      body_en: replyText,
      // No link: a link to a screen that does not exist is the failure this
      // function was written to avoid, one level down.
      link: '',
      entity_type: 'complaint',
      entity_id: complaint.id,
      eventKey: `complaint.reply:${messageId}`,
    });

    const msg: CustomerMessage = {
      subject: t.complaintSubject(complaint.id),
      body: t.complaintShort(complaint.id),
    };
    await notifyCustomer(env, complaint.reporter_id, `complaint.reply:${messageId}`, msg);
  } catch (e) {
    console.error('notifyComplaintReply failed for', complaintId, e instanceof Error ? e.message : String(e));
  }
}
