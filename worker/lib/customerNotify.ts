/**
 * TELLING A CUSTOMER SOMETHING HAPPENED — on whichever channel actually
 * reaches them.
 *
 * Before this module the shop had a strange asymmetry: the ADMIN group heard
 * about every order, return and claim through `notifyAdminTopic`, while the
 * customer heard about exactly two things — an invoice email, and a wallet
 * deposit decision. The person who paid was the last to know.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is a fan-out over the DURABLE OUTBOX:
 * `notifyCustomer` decides which channels can reach a user and enqueues one
 * row per channel. It does not send anything itself, it never blocks the
 * business write that called it, and it never throws — an order must not fail
 * because a notification could not be queued.
 *
 * WHY THE EVENT KEY CARRIES THE CHANNEL. `outbox.event_key` is UNIQUE, which
 * is what makes a replayed business event a no-op. One key per (event,
 * channel) means the same order can legitimately produce an email row AND a
 * WhatsApp row, while a second call for the same order produces neither.
 * That is also why the caller passes a stable `eventKey` — a random one would
 * turn every retry of the calling route into a duplicate message.
 *
 * THE ACCOUNT RULES, and the reason for each:
 *
 *   email    — only a VERIFIED, real address. An unverified address may
 *              belong to somebody else entirely (it is whatever was typed at
 *              sign-up), and `@telegram.local` is not a mailbox at all.
 *
 *   whatsapp — `users.phone_e164`, which migration 0013 guarantees is only
 *              ever written after Telegram contact verification: "a phone
 *              typed into a form is never stored here". So there is no
 *              unverified-phone case to worry about — if the column has a
 *              value, its owner proved it.
 *
 *   telegram — a live (non-revoked) link in `telegram_links`.
 *
 * A customer with all three gets all three, deliberately. This is transaction
 * mail — an order they placed, money that moved — not marketing, and the
 * whole complaint that produced this module was not hearing about it.
 *
 * AND THE HALF THAT WAS MISSING. Those three rules answer whether the ACCOUNT
 * has a destination. They said nothing about whether this DEPLOYMENT can
 * carry the channel, because `emailConfigured`, `wasenderConfigured` and the
 * bot token were read only at SEND time, inside `deliver()`, a cron tick
 * later. So on a deployment with no `EMAIL_API_KEY` this module enqueued an
 * email row, `deliver()` returned EMAIL_NOT_CONFIGURED, processOutbox called
 * that terminal, and the row was dead on its first attempt — while whatever
 * dialog called us had already told the customer "we will email you".
 *
 * `channelsLive(env)` (lib/channelReadiness.ts) is now consulted BEFORE the
 * enqueue, and a channel this deployment cannot carry is recorded as a
 * `skipped` outbox row carrying the reason instead of a pending row that
 * cannot be sent. The returned flags say `false` for it, so a caller that
 * writes a confirmation sentence from this result stops writing a false one.
 *
 * The email allowlist is checked here too, and it is PER RECIPIENT rather than
 * per deployment: with `EMAIL_ALLOWLIST_REQUIRED=on` and an empty
 * `EMAIL_ALLOWED_RECIPIENTS` nobody at all is mailable, and the outbox quietly
 * marked those rows `skipped` at send time — fifteen minutes after the promise.
 */

import type { Env } from './types';
import { channelsLive, type ChannelBlocker, type LiveChannels } from './channelReadiness';
import { emailAllowsRecipient } from './emailSend';
import { enqueue, enqueueStatement, type OutboxMessage } from './outbox';
import { emailLang, escapeHtml, type EmailLang } from './emailTemplates';
import { isPlaceholderEmail } from './profileCompletion';
import { isE164 } from './wasender';

export type CustomerChannel = 'email' | 'whatsapp' | 'telegram';

export interface CustomerReach {
  user_id: string;
  lang: EmailLang;
  /** A verified, real mailbox — or null. */
  email: string | null;
  /** E.164, proven owned (see the module note) — or null. */
  phone: string | null;
  /**
   * THE CUSTOMER'S OWN ANSWER about WhatsApp, kept separate from `phone`.
   *
   * «لا يوجد زر لدى المستخدم يمكنه بالتفعيل الواتساب» — there is one now, and
   * `users.notify_whatsapp` is what it writes (migration 0101, default 1, so
   * nobody's messages changed the day it landed). It is NOT folded into
   * `phone` because that field is the account's verified identity and is read
   * for sign-in codes too: somebody who turned off order updates has not asked
   * to be locked out of their own account.
   */
  wants_whatsapp: boolean;
  /** A live private chat with the customer bot — or null. */
  telegram_chat_id: number | null;
}

/** locale column → the three languages the templates speak. */
function langOfLocale(locale: unknown): EmailLang {
  return emailLang(locale === 'ku' ? 'ckb' : locale);
}

/**
 * Which channels can reach this customer, in one query.
 *
 * Returns a reach with every field null rather than throwing when the user is
 * gone: a notification for a deleted account is nothing to send, not an error
 * to propagate into whatever business write is on the stack.
 */
export async function reachFor(env: Env, userId: string): Promise<CustomerReach> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.locale, u.email, u.email_verified_at, u.phone_e164, u.notify_whatsapp,
            (SELECT l.chat_id FROM telegram_links l
              WHERE l.user_id = u.id AND l.revoked_at IS NULL
              ORDER BY l.verified_at DESC LIMIT 1) AS chat_id
       FROM users u WHERE u.id = ?`
  )
    .bind(userId)
    .first<ReachRow>()
    .catch(() => null);

  return row ? reachFromRow(row) : emptyReach(userId);
}

interface ReachRow {
  id: string;
  locale: string | null;
  email: string | null;
  email_verified_at: string | null;
  phone_e164: string | null;
  notify_whatsapp: number | null;
  chat_id: number | null;
}

/** Nothing reaches this person — a deleted account, or a lookup that failed. */
function emptyReach(userId: string): CustomerReach {
  return { user_id: userId, lang: 'ar', email: null, phone: null, wants_whatsapp: false, telegram_chat_id: null };
}

/** One row → one reach. Shared by the single and the bulk lookup so the two
 *  can never drift into disagreeing about what "reachable" means. */
function reachFromRow(row: ReachRow): CustomerReach {
  const mail = row.email && row.email_verified_at && !isPlaceholderEmail(row.email) ? row.email : null;
  return {
    user_id: row.id,
    lang: langOfLocale(row.locale),
    email: mail,
    phone: isE164(row.phone_e164) ? row.phone_e164 : null,
    // A row from a database that has not run migration 0101 yet reads null,
    // and null is the OLD behaviour — everyone opted in. Only an explicit 0
    // turns the channel off, so a deploy that lands before its migration
    // cannot silence a live channel.
    wants_whatsapp: row.notify_whatsapp !== 0,
    telegram_chat_id: typeof row.chat_id === 'number' ? row.chat_id : null,
  };
}

/**
 * D1 refuses more than 100 bound parameters in one statement, and the chunk is
 * 90 rather than 100 so a caller can add a bound value of its own without
 * discovering the ceiling in production (the same 90 `productPersistence.ts`
 * uses).
 */
const REACH_IN_CHUNK = 90;

/**
 * The same answer for many users, in ONE query per chunk.
 *
 * WHY THIS EXISTS. `reachFor` is one D1 statement per user. A sweep over 200
 * subscribers to a restocked product would run 200 reads inside a single
 * invocation, against a per-invocation statement budget that has nothing to do
 * with how many people happen to want that product — the feature would work in
 * testing with three subscribers and fall over on the first popular item.
 *
 * The LEFT JOIN replaces `reachFor`'s correlated subselect because
 * `telegram_links.user_id` is the PRIMARY KEY (migration 0003), so at most one
 * row can join and the result cannot fan out. The `revoked_at IS NULL` test
 * lives in the JOIN condition, not in WHERE — in WHERE it would drop the user
 * entirely instead of dropping only their Telegram channel.
 *
 * Every requested id comes back, including ids with no row: a notification for
 * a deleted account is nothing to send, not an error for the caller to handle.
 */
export async function reachForMany(env: Env, userIds: string[]): Promise<Map<string, CustomerReach>> {
  const out = new Map<string, CustomerReach>();
  const unique = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += REACH_IN_CHUNK) {
    const part = unique.slice(i, i + REACH_IN_CHUNK);
    const placeholders = part.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `SELECT u.id, u.locale, u.email, u.email_verified_at, u.phone_e164, u.notify_whatsapp, l.chat_id
         FROM users u
         LEFT JOIN telegram_links l ON l.user_id = u.id AND l.revoked_at IS NULL
        WHERE u.id IN (${placeholders})`
    )
      .bind(...part)
      .all<ReachRow>()
      .catch((e) => {
        console.error('reachForMany: lookup failed:', e instanceof Error ? e.message : String(e));
        return { results: [] as ReachRow[] };
      });
    for (const row of res.results ?? []) out.set(row.id, reachFromRow(row));
  }

  for (const id of unique) if (!out.has(id)) out.set(id, emptyReach(id));
  return out;
}

export interface CustomerMessage {
  /** Email subject. */
  subject: string;
  /**
   * THE WHOLE MESSAGE IN ONE SHORT BLOCK, plain text. Used verbatim by
   * WhatsApp and Telegram and as the email's text alternative, and wrapped in
   * the LEVONIS card for the HTML part.
   *
   * It is one field rather than three because a notification that says
   * different things on different channels is a notification the shop cannot
   * answer a question about. Keep it short: a WhatsApp message is read on a
   * lock screen.
   */
  body: string;
  /** Optional lines of label/value detail — order number, amount, status. */
  details?: Array<{ label: string; value: string }>;
  /**
   * ONE thing to tap, rendered three ways because the three channels can
   * carry three different amounts of it — and NOT rendered at all when the
   * deployment cannot build an absolute address (see `ctaOf`).
   *
   *   telegram — a real `inline_keyboard`, the same mechanism the admin group
   *              has had since §12.2.
   *   whatsapp — the bare URL on its own last line. `sendWhatsAppText` posts
   *              `{to, text}` to a REAL linked account (lib/wasender.ts), not
   *              the Business API: there is no button field to send, and a
   *              provider-specific one would simply be refused. A URL alone on
   *              a line is tappable in every WhatsApp client, which is the
   *              most the channel can honestly do.
   *   email    — one escaped <a> in the card, and the same bare URL in the
   *              text alternative, because a text part with no address is a
   *              message whose whole point is missing for anyone reading it.
   *
   * It is ONE field rather than one per channel for the same reason `body` is:
   * a notification that offers different destinations on different channels is
   * one the shop cannot answer a question about.
   */
  cta?: { label: string; url: string };
}

/**
 * THE ONE GATE EVERY RENDERER GOES THROUGH.
 *
 * A CTA is only ever built from `env.APP_ORIGIN` (configuration) — never from
 * a request, whose Host header is merchant-controlled — and this is the last
 * check that the thing about to be put in front of a customer is really an
 * absolute https address. A relative path in a WhatsApp message is text, not a
 * link; `http://` in a message the shop sent is a downgrade the shop chose;
 * and a `javascript:` label would be neither. Any of those omits the CTA
 * entirely, which is the same rule `adminDeepLink` applies for the same
 * reason: an unlinked message is honest, a half-built one is not.
 */
function ctaOf(msg: CustomerMessage): { label: string; url: string } | null {
  const url = (msg.cta?.url ?? '').trim();
  const label = (msg.cta?.label ?? '').trim();
  if (!url.startsWith('https://') || !label) return null;
  return { label, url };
}

/** The LEVONIS card, for the email part only. Same shell idea as the auth
 *  templates, inlined because this module owns transactional notices rather
 *  than the auth template set. */
function notifyHtml(lang: EmailLang, msg: CustomerMessage): string {
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  const details = (msg.details ?? [])
    .map(
      (d) =>
        `<p style="margin:0 0 6px;font-size:13px;color:#555555;">` +
        `${escapeHtml(d.label)}: <span dir="ltr" style="unicode-bidi:isolate;">${escapeHtml(d.value)}</span></p>`
    )
    .join('');
  // One escaped <a>, and escaped for BOTH positions it sits in: the href and
  // the visible label. `escapeHtml` is the same helper the auth templates use.
  const cta = ctaOf(msg);
  const action = cta
    ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(cta.url)}" ` +
      `style="display:inline-block;background-color:#111111;color:#d4af37;text-decoration:none;` +
      `font-size:14px;font-weight:bold;padding:11px 20px;border-radius:10px;">${escapeHtml(cta.label)}</a></p>`
    : '';
  return (
    `<div dir="${dir}" style="margin:0;padding:24px 12px;background-color:#f4f4f2;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="max-width:520px;margin:0 auto;">` +
    `<div style="background-color:#111111;border-radius:14px 14px 0 0;padding:18px 24px;">` +
    `<span style="font-size:20px;font-weight:bold;letter-spacing:2px;color:#d4af37;">LEVONIS</span></div>` +
    `<div style="background-color:#ffffff;border-radius:0 0 14px 14px;padding:26px 24px;color:#111111;">` +
    `<p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;">${escapeHtml(msg.body).replace(/\n/g, '<br>')}</p>` +
    details +
    action +
    `</div></div></div>`
  );
}

/**
 * The plain-text form both chat channels send and the email carries too.
 *
 * EVERY DETAIL IS ANOTHER LINE ON A LOCK SCREEN — which is what makes the
 * `details` list expensive and why the order messages now carry almost none.
 *
 * The CTA is the LAST line and is the bare URL, with no label in front of it:
 * a URL alone on its own line is what WhatsApp, Telegram and every mail client
 * turn into something tappable, while «الرابط: https://…» is a line that may
 * or may not linkify depending on the client. The label already rode along in
 * `body` as the reason to tap.
 */
export function plainNotification(msg: CustomerMessage): string {
  const lines = [msg.body];
  for (const d of msg.details ?? []) lines.push(`${d.label}: ${d.value}`);
  const cta = ctaOf(msg);
  if (cta) lines.push(cta.url);
  return `LEVONIS\n${lines.join('\n')}`;
}

/**
 * WHICH CHANNELS CAN ACTUALLY CARRY THIS MESSAGE, and what to say about the
 * ones that cannot. One decision function, two execution shapes — the
 * immediate `notifyCustomer` and the batched `planNotifyCustomer` — so the two
 * can never disagree about who gets told what.
 *
 * The blocker vocabulary is `ChannelBlocker` from lib/channelReadiness.ts on
 * purpose: the sheet that offered the channel and the queue that refused it
 * must name the same fact with the same word, or an operator reading a skipped
 * row has to translate.
 */
/**
 * WHAT `last_error` SAYS ON A ROW THAT WAS NEVER SENT — and why it is the same
 * sentence `deliver()` would have written.
 *
 * There are two ways a channel ends up carrying nothing on a deployment that
 * cannot use it. `deliver()` discovers it at send time and writes a bare code:
 * EMAIL_NOT_CONFIGURED, WHATSAPP_NOT_CONFIGURED, TELEGRAM_NOT_CONFIGURED. This
 * module now discovers the same fact BEFORE the enqueue, which is the whole
 * improvement — no pending row that looks queued for fifteen minutes and then
 * dies, no five attempts spent proving something we already knew.
 *
 * But an operator asking «ليش ما وصلت الرسالة؟» asks the outbox one question,
 * and the answer must not depend on which of the two paths happened to notice.
 * So the pre-check writes the code the send path would have written, and one
 * `WHERE last_error = 'WHATSAPP_NOT_CONFIGURED'` finds both. A prose sentence
 * here, or a second vocabulary, would mean every such query had to know about
 * both — which is how a column stops being searchable.
 *
 * The state still differs, deliberately: 'dead' means we tried, 'skipped'
 * means we knew better than to. Both are terminal, neither is retried.
 */
function skipReason(channel: CustomerChannel, blocker: ChannelBlocker): string {
  if (blocker === 'RECIPIENT_BLOCKED') {
    // Word-for-word what outbox.ts writes when it discovers the same staging
    // guard at send time.
    return 'recipient not in EMAIL_ALLOWED_RECIPIENTS (staging guard)';
  }
  if (blocker === 'DEPLOYMENT_OUTAGE') return 'WHATSAPP_SESSION_NOT_CONNECTED';
  return channel === 'email'
    ? 'EMAIL_NOT_CONFIGURED'
    : channel === 'whatsapp'
      ? 'WHATSAPP_NOT_CONFIGURED'
      : 'TELEGRAM_NOT_CONFIGURED';
}

interface ChannelItem {
  channel: CustomerChannel;
  message: OutboxMessage;
}

interface ChannelPlan {
  send: ChannelItem[];
  /** Live account destination, dark deployment — the promise we must NOT make.
   *  Each one keeps the payload it WOULD have carried, so the row recording the
   *  refusal has something to send if the deployment is fixed and an operator
   *  retries it, rather than an empty row that only says a mistake happened. */
  blocked: Array<ChannelItem & { blocker: ChannelBlocker }>;
}

function planChannels(
  env: Env,
  reach: CustomerReach,
  live: LiveChannels,
  msg: CustomerMessage,
  wanted: readonly CustomerChannel[]
): ChannelPlan {
  const text = plainNotification(msg);
  const cta = ctaOf(msg);
  // Telegram carries the CTA as a real button, so its TEXT must not also end
  // with the bare URL: the same address twice in one short message reads as
  // padding, and on a lock screen the preview is the message.
  const telegramText = cta ? plainNotification({ ...msg, cta: undefined }) : text;
  const plan: ChannelPlan = { send: [], blocked: [] };

  // A channel the ACCOUNT cannot receive is absent, not blocked: a customer
  // with no Telegram link is not a failure to record, and writing a skipped
  // row for every channel every user lacks would treble the outbox for nothing.
  // `blocked` is reserved for the case that produced this code — an account
  // that CAN be reached and a deployment that cannot do it.
  if (wanted.includes('email') && reach.email) {
    const item: ChannelItem = {
      channel: 'email',
      message: {
        kind: 'email',
        to: reach.email,
        subject: msg.subject,
        html: notifyHtml(reach.lang, msg),
        text,
      },
    };
    if (!live.email) plan.blocked.push({ ...item, blocker: 'DEPLOYMENT_NOT_CONFIGURED' });
    else if (!emailAllowsRecipient(env, reach.email)) {
      // The staging guard, applied HERE rather than only at send time. The
      // outbox re-checks it anyway; the point is to stop the promise, not the
      // send — the send was already being stopped, silently, a cron later.
      plan.blocked.push({ ...item, blocker: 'RECIPIENT_BLOCKED' });
    } else plan.send.push(item);
  }

  // ABSENT, NOT BLOCKED, when the customer has turned it off. `blocked` is
  // reserved for "this account CAN be reached and the deployment cannot do
  // it" — see the note above — and a customer's own choice is not a
  // deployment fault to write an outbox row about on every single send.
  if (wanted.includes('whatsapp') && reach.phone && reach.wants_whatsapp) {
    const item: ChannelItem = { channel: 'whatsapp', message: { kind: 'whatsapp', to: reach.phone, text } };
    if (!live.whatsapp) {
      // Two different facts with two different remedies: no key at all is an
      // operator setting a secret; an outage is an operator scanning a QR code.
      plan.blocked.push({
        ...item,
        blocker: live.whatsapp_outage ? 'DEPLOYMENT_OUTAGE' : 'DEPLOYMENT_NOT_CONFIGURED',
      });
    } else plan.send.push(item);
  }

  if (wanted.includes('telegram') && reach.telegram_chat_id !== null) {
    const item: ChannelItem = {
      channel: 'telegram',
      message: {
        kind: 'telegram',
        chat_id: reach.telegram_chat_id,
        text: telegramText,
        // ONE button, one row. A customer message has exactly one thing worth
        // doing; a keyboard with choices on it is an admin decision surface
        // (walletNotify's `decisionKeyboard`), and this is not one.
        ...(cta ? { reply_markup: { inline_keyboard: [[{ text: cta.label, url: cta.url }]] } } : {}),
      },
    };
    if (!live.telegram) plan.blocked.push({ ...item, blocker: 'DEPLOYMENT_NOT_CONFIGURED' });
    else plan.send.push(item);
  }

  return plan;
}

/**
 * Queue one notification on every channel that can reach the customer.
 *
 * `eventKey` must be stable and unique per business event — e.g.
 * `order.placed:ORD-123`. The channel suffix is appended here, so callers
 * never have to remember to do it, and a caller that changes which channels
 * exist does not accidentally re-notify the ones that already went out.
 *
 * Returns which channels were newly queued FOR DELIVERY. `false` now means one
 * of three things — the channel cannot reach this customer, it was already
 * queued for this exact event, or this deployment cannot carry it — and all
 * three are "nothing will be sent here", which is the only thing a caller may
 * safely tell a customer. It deliberately does NOT mean "a row exists": a
 * blocked channel still writes a `skipped` row, and counting that as success
 * is the exact lie this function was rewritten to stop telling.
 */
export async function notifyCustomer(
  env: Env,
  userId: string,
  eventKey: string,
  msg: CustomerMessage,
  opts: { channels?: readonly CustomerChannel[] } = {}
): Promise<Record<CustomerChannel, boolean>> {
  const out: Record<CustomerChannel, boolean> = { email: false, whatsapp: false, telegram: false };
  const wanted = opts.channels ?? (['email', 'whatsapp', 'telegram'] as const);

  let reach: CustomerReach;
  let live: LiveChannels;
  try {
    [reach, live] = await Promise.all([reachFor(env, userId), channelsLive(env)]);
  } catch (e) {
    console.error('notifyCustomer: reach lookup failed:', e instanceof Error ? e.message : String(e));
    return out;
  }

  const plan = planChannels(env, reach, live, msg, wanted);

  // Each enqueue is independently guarded: one channel's failure must not
  // cost the customer the other two.
  for (const item of plan.send) {
    try {
      out[item.channel] = (await enqueue(env, `${eventKey}:${item.channel}`, item.message)) !== null;
    } catch (e) {
      console.error(
        `notifyCustomer: ${item.channel} enqueue failed:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // Recorded, never sent, and never counted as queued. The row exists so that
  // "why did this customer not get the email" has an answer in the same table
  // as every other answer, instead of only in a log line that has rotated away.
  for (const item of plan.blocked) {
    try {
      await enqueue(env, `${eventKey}:${item.channel}`, item.message, {
        state: 'skipped',
        note: skipReason(item.channel, item.blocker),
      });
    } catch (e) {
      console.error(
        `notifyCustomer: ${item.channel} skip record failed:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return out;
}

export interface CustomerNotifyPlan {
  /** The reach this plan was built from — the caller usually already has it. */
  reach: CustomerReach;
  /** Channels with a statement in `statements` that will really be attempted. */
  queued: CustomerChannel[];
  /** Channels with a live destination that this deployment cannot carry. */
  blocked: Array<{ channel: CustomerChannel; blocker: ChannelBlocker }>;
  /** Ready for `db.batch`, alongside the caller's own rows. */
  statements: D1PreparedStatement[];
}

/**
 * The same decision, returned as STATEMENTS instead of executed.
 *
 * WHY A CALLER WOULD WANT THIS. A sweep that fires a restock alert has three
 * writes that must agree with each other: the outbox rows, the in-app
 * notification row, and the state flip that stops the next tick doing all of
 * it again. Run separately, a worker that dies between them either notifies
 * twice or marks an alert notified that nobody was told about. In one
 * `db.batch` they commit together or not at all.
 *
 * WHAT THAT ATOMICITY WOULD HAVE COST, and why `enqueueStatement` exists. The
 * replay-safety of `enqueue()` is a try/catch around `.run()` that looks for
 * 'UNIQUE' in the error message. Inside a batch there is no such catch: one
 * collision on `event_key` aborts the entire batch, rolling back the
 * notification AND the state flip, and the next sweep rebuilds the identical
 * batch and fails identically, for ever. So the statements returned here are
 * `INSERT ... ON CONFLICT(event_key) DO NOTHING` — the replay is a zero-row
 * no-op the rest of the batch survives.
 *
 * `reach` and `live` are accepted so a caller notifying two hundred people
 * pays for ONE `reachForMany` and ONE deployment check rather than four
 * hundred reads it already has the answers to.
 */
export async function planNotifyCustomer(
  env: Env,
  userId: string,
  eventKey: string,
  msg: CustomerMessage,
  opts: {
    channels?: readonly CustomerChannel[];
    reach?: CustomerReach;
    live?: LiveChannels;
  } = {}
): Promise<CustomerNotifyPlan> {
  const wanted = opts.channels ?? (['email', 'whatsapp', 'telegram'] as const);
  const reach = opts.reach ?? (await reachFor(env, userId));
  const live = opts.live ?? (await channelsLive(env));
  const plan = planChannels(env, reach, live, msg, wanted);

  return {
    reach,
    queued: plan.send.map((s) => s.channel),
    blocked: plan.blocked.map((b) => ({ channel: b.channel, blocker: b.blocker })),
    statements: plan.send.map(
      (s) => enqueueStatement(env.DB, `${eventKey}:${s.channel}`, s.message).stmt
    ),
  };
}
