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
    complaintShort: (id: string) => `وصلك رد من إدارة \u2068Levonis\u2069 على شكواك ${id}. افتح «تذاكري» في صفحة الدعم لقراءته.`,
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
    complaintShort: (id: string) => `Levonis answered your complaint ${id}. Open "My tickets" on the Support page to read it.`,
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
    complaintShort: (id: string) => `وصلك رد من إدارة \u2068Levonis\u2069 على شكواك ${id}. افتح «تذاكري» في صفحة الدعم لقراءته.`, // OWNER: Sorani by hand.
    complaintTitle: 'رد على شكواك', // OWNER: Sorani by hand.
  },
} as const;

/**
 * WHERE A SUPPORT CONVERSATION LIVES, AS A LINK A NOTIFICATION CAN CARRY.
 *
 * Both open the «تذاكري» tab of /support with the thread already open; the
 * page reads exactly these parameter names. One spelling each, here, so the
 * bell and the page cannot drift into two ideas of the same address.
 */
export function supportTicketLink(ticketId: string): string {
  return `/support?tab=tickets&ticket=${encodeURIComponent(ticketId)}`;
}
export function complaintThreadLink(complaintId: string): string {
  return `/support?tab=tickets&complaint=${encodeURIComponent(complaintId)}`;
}

/**
 * «رد الدعم» — staff answered a ticket, so the person who opened it hears about it.
 *
 * THE EVENT KEY CARRIES THE MESSAGE ID, not the ticket id. A ticket is a
 * conversation: support may answer three times over two days and each answer is
 * news. Keying on the ticket would deliver the first reply and silently swallow
 * every one after it — `notifyCustomer` appends the channel and the uniqueness
 * lives in `outbox`, so a repeated key is a no-op, not a second send.
 *
 * THE LINK OPENS THE TICKET, not the page. It was `/support`, and the Support
 * page opens on the ASSISTANT — so a customer told «افتح «تذاكري»» landed in
 * the bot, had to find the tab, and then find the ticket in a list. The page
 * now reads `tab` and `ticket` from the query (src/pages/Support.tsx) and opens
 * the thread itself; `supportTicketLink` is the one spelling of that address.
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
      link: supportTicketLink(ticket.id),
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
 * in the repository ever inserted into it; a reply route closed that half. The
 * other half is the reporter's own thread — GET/POST
 * /api/marketplace/complaints/:id, drawn on the Support page — which this
 * notification now links to, so an answer is a door and not a dead end.
 *
 * THE IN-APP ROW CARRIES THE TEXT, AND THE OUTBOUND CHANNELS DO NOT. That
 * split is deliberate and it follows the rule stated on the COPY table above:
 * WhatsApp and Telegram are carried by third parties and a complaint answer
 * can name an amount, an address or another person, so the outbound line says
 * only that an answer arrived. `user_notifications` is behind the customer's
 * own login, exactly as a page on the site would be, so the bell may preview
 * the answer; the thread it opens is where it is read in full.
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
      // The answer itself, as a preview the bell can show whole. An
      // attachment-only reply has no text, so it says an answer arrived.
      body_ar: replyText || COPY.ar.complaintShort(complaint.id),
      body_en: replyText || COPY.en.complaintShort(complaint.id),
      /**
       * THE THREAD, NOW THAT THERE IS ONE. This was '' because no customer
       * screen read a complaint, and the bell clamps a body to two lines — so
       * a multi-sentence answer could be read by nobody. The reporter's thread
       * lives on the Support page («تذاكري»), where they can read every
       * answer in full and reply with text, a photo or a clip.
       */
      link: complaintThreadLink(complaint.id),
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

// ===================================================================
// WARRANTY CLAIMS — «ولا يرسل الإشعار إلى المستخدم بأن هناك رسالة جديدة تخص الضمان»
// ===================================================================

/**
 * WHERE A WARRANTY CLAIM'S CONVERSATION LIVES, AS A LINK A NOTIFICATION CAN
 * CARRY. The Warranty page reads `claim` from the query and opens that thread
 * itself (src/pages/Warranty.tsx), so the bell lands the customer IN the
 * conversation and not on a page with a list they must search. One spelling,
 * here, for the same reason `supportTicketLink` has one.
 */
export function warrantyClaimLink(claimId: string): string {
  return `/warranty?claim=${encodeURIComponent(claimId)}`;
}

/**
 * The stage names are the ones the claim card already draws
 * (src/components/warranty/strings.ts `stageLabels`), so the message and the
 * screen it opens say the same word for the same step.
 */
const CLAIM_STAGE_LABEL: Record<'ar' | 'en', Record<string, string>> = {
  ar: {
    received: 'مُستلَمة',
    diagnosing: 'قيد الفحص',
    approved: 'مقبولة',
    rejected: 'مرفوضة',
    repairing: 'قيد الإصلاح',
    replaced: 'استبدال',
    resolved: 'منتهية',
  },
  en: {
    received: 'Received',
    diagnosing: 'Diagnosing',
    approved: 'Approved',
    rejected: 'Rejected',
    repairing: 'Repairing',
    replaced: 'Replacement',
    resolved: 'Resolved',
  },
};

/**
 * THE PRODUCT, NOT THE CLAIM ID, NAMES THE CLAIM. A support ticket's id is
 * printed on the customer's own ticket list; a claim's `wc_…` id is printed
 * nowhere the customer looks — the card under «مطالباتي» is headed by the
 * subject and the printer. The printer's name is the identifier they will
 * recognise on a lock screen, and unlike the subject it is not their own
 * prose travelling through a third party.
 *
 * Sorani carries the ARABIC text on purpose, exactly as the complaint lines
 * above do: no Kurdish sentence is generated here. OWNER: Sorani by hand.
 */
const CLAIM_COPY = {
  ar: {
    replyTitle: 'رد من فريق الضمان',
    replyBody: (p: string) => `وصلك رد من فريق الضمان على مطالبتك الخاصة بـ«${p}». افتح «مطالباتي» في مركز الضمان لقراءته والرد عليه.`,
    replySubject: (p: string) => `رد على مطالبة الضمان — ${p}`,
    stageTitle: 'تحديث على مطالبة الضمان',
    stageBody: (p: string, label: string) => `مطالبتك الخاصة بـ«${p}» صارت: ${label}.`,
    stageOpen: 'افتح «مطالباتي» في مركز الضمان للتفاصيل.',
    stageSubject: (p: string) => `تحديث على مطالبة الضمان — ${p}`,
    reasonLabel: 'السبب',
  },
  en: {
    replyTitle: 'The warranty team replied',
    replyBody: (p: string) => `The warranty team replied on your claim for “${p}”. Open "My claims" in the Warranty centre to read it and answer.`,
    replySubject: (p: string) => `Reply on your warranty claim — ${p}`,
    stageTitle: 'Your warranty claim was updated',
    stageBody: (p: string, label: string) => `Your claim for “${p}” is now: ${label}.`,
    stageOpen: 'Open "My claims" in the Warranty centre for the details.',
    stageSubject: (p: string) => `Warranty claim update — ${p}`,
    reasonLabel: 'Reason',
  },
} as const;

/** 'ckb' reads the Arabic copy — see CLAIM_COPY. */
const claimCopyFor = (lang: EmailLang) => (lang === 'en' ? CLAIM_COPY.en : CLAIM_COPY.ar);
const claimStageLabelFor = (lang: EmailLang, stage: string) =>
  (lang === 'en' ? CLAIM_STAGE_LABEL.en : CLAIM_STAGE_LABEL.ar)[stage] ?? stage;

interface ClaimHead {
  id: string;
  user_id: string;
  product_name: string | null;
}

async function claimHead(env: Env, claimId: string): Promise<ClaimHead | null> {
  return env.DB.prepare('SELECT id, user_id, product_name FROM warranty_claims WHERE id = ?')
    .bind(claimId)
    .first<ClaimHead>();
}

/** One lock-screen line: the printer's name, clipped. */
function claimProduct(head: ClaimHead): string {
  const name = String(head.product_name ?? '').trim();
  return name.length > 60 ? `${name.slice(0, 59)}…` : name || '—';
}

/**
 * «رد من فريق الضمان» — staff wrote in a warranty claim's thread, so the
 * customer who filed it hears about it.
 *
 * THE MIRROR OF THE LINE THAT ALREADY EXISTED. POST
 * /api/devices/claims/:id/messages has announced every CUSTOMER message to the
 * owner's «🔥 Warranty support» topic since the claim thread was built; the
 * staff message went into `claim_messages` and reached the customer by no path
 * at all — not the bell, not WhatsApp, not Telegram, not email. They learned
 * that the warranty team had asked for a photo of the nozzle by coming back
 * and looking.
 *
 * THE EVENT KEY CARRIES THE MESSAGE ID, not the claim id — a claim is a
 * conversation, and the second question from the team is as much news as the
 * first. Keying on the claim would deliver one reply and swallow every one
 * after it.
 *
 * THE TEXT OF THE REPLY IS NEVER IN IT, on either door: the in-app row says an
 * answer arrived and opens the thread, and the outbound channels (carried by
 * third parties) say the same. What the team wrote can name a serial, an
 * address or a repair cost, and it stays behind the customer's own login.
 *
 * TOTAL. Called after the message row has committed; neither a D1 blip nor a
 * provider outage may turn a staff member's sent reply into an error.
 */
export async function notifyClaimReply(env: Env, claimId: string, messageId: string): Promise<void> {
  try {
    const head = await claimHead(env, claimId);
    if (!head) return;
    const product = claimProduct(head);
    const eventKey = `claim.reply:${messageId}`;
    // The in-app row first and unconditionally — the floor for a customer with
    // no linked channel. Sorani falls back to the Arabic in the bell.
    await notify(env.DB, {
      userId: head.user_id,
      kind: 'warranty_reply',
      title_ar: CLAIM_COPY.ar.replyTitle,
      title_en: CLAIM_COPY.en.replyTitle,
      body_ar: CLAIM_COPY.ar.replyBody(product),
      body_en: CLAIM_COPY.en.replyBody(product),
      link: warrantyClaimLink(head.id),
      entity_type: 'claim',
      entity_id: head.id,
      eventKey,
    });
    const t = claimCopyFor(await localeOf(env, head.user_id));
    const msg: CustomerMessage = { subject: t.replySubject(product), body: t.replyBody(product) };
    await notifyCustomer(env, head.user_id, eventKey, msg);
  } catch (e) {
    console.error('notifyClaimReply failed for', claimId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * «تحديث على مطالبة الضمان» — the claim moved a stage, so its customer is told
 * where it now stands.
 *
 * THE DECISION REASON IS IN THE IN-APP ROW AND NOT IN THE OUTBOUND LINE. The
 * admin queue labels that field «سيُبلَّغ للزبون», so the customer is owed it —
 * behind their own login, where the claim card shows it too. WhatsApp and
 * Telegram get the stage and where to read the rest, by the same rule as
 * every other message in this file.
 *
 * THE EVENT KEY CARRIES THE MOMENT OF THE MOVE (`at`), not just the stage. A
 * claim can legitimately reach the same stage twice — rejected, reopened for
 * another look, rejected again — and the second decision is news. The caller
 * reaches this only after its conditional UPDATE won, so a retried request
 * that lost the race never gets here and cannot announce twice.
 */
export async function notifyClaimStage(
  env: Env,
  claimId: string,
  stage: string,
  opts: { at: string; reason?: string }
): Promise<void> {
  try {
    const head = await claimHead(env, claimId);
    if (!head) return;
    const product = claimProduct(head);
    const reason = String(opts.reason ?? '').trim();
    const eventKey = `claim.stage:${head.id}:${stage}:${opts.at}`;
    const inApp = (lang: 'ar' | 'en') => {
      const c = CLAIM_COPY[lang];
      const line = c.stageBody(product, CLAIM_STAGE_LABEL[lang][stage] ?? stage);
      return reason ? `${line} ${c.reasonLabel}: ${reason}` : line;
    };
    await notify(env.DB, {
      userId: head.user_id,
      kind: 'warranty_stage',
      title_ar: CLAIM_COPY.ar.stageTitle,
      title_en: CLAIM_COPY.en.stageTitle,
      body_ar: inApp('ar'),
      body_en: inApp('en'),
      link: warrantyClaimLink(head.id),
      entity_type: 'claim',
      entity_id: head.id,
      meta: { stage },
      eventKey,
    });
    const lang = await localeOf(env, head.user_id);
    const t = claimCopyFor(lang);
    const msg: CustomerMessage = {
      subject: t.stageSubject(product),
      body: `${t.stageBody(product, claimStageLabelFor(lang, stage))} ${t.stageOpen}`,
    };
    await notifyCustomer(env, head.user_id, eventKey, msg);
  } catch (e) {
    console.error('notifyClaimStage failed for', claimId, e instanceof Error ? e.message : String(e));
  }
}
