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
 * THE CHANNEL RULES, and the reason for each:
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
 */

import type { Env } from './types';
import { enqueue } from './outbox';
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
    `SELECT u.id, u.locale, u.email, u.email_verified_at, u.phone_e164,
            (SELECT l.chat_id FROM telegram_links l
              WHERE l.user_id = u.id AND l.revoked_at IS NULL
              ORDER BY l.verified_at DESC LIMIT 1) AS chat_id
       FROM users u WHERE u.id = ?`
  )
    .bind(userId)
    .first<{
      id: string;
      locale: string | null;
      email: string | null;
      email_verified_at: string | null;
      phone_e164: string | null;
      chat_id: number | null;
    }>()
    .catch(() => null);

  if (!row) return { user_id: userId, lang: 'ar', email: null, phone: null, telegram_chat_id: null };

  const mail =
    row.email && row.email_verified_at && !isPlaceholderEmail(row.email) ? row.email : null;

  return {
    user_id: row.id,
    lang: langOfLocale(row.locale),
    email: mail,
    phone: isE164(row.phone_e164) ? row.phone_e164 : null,
    telegram_chat_id: typeof row.chat_id === 'number' ? row.chat_id : null,
  };
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
  return (
    `<div dir="${dir}" style="margin:0;padding:24px 12px;background-color:#f4f4f2;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="max-width:520px;margin:0 auto;">` +
    `<div style="background-color:#111111;border-radius:14px 14px 0 0;padding:18px 24px;">` +
    `<span style="font-size:20px;font-weight:bold;letter-spacing:2px;color:#d4af37;">LEVONIS</span></div>` +
    `<div style="background-color:#ffffff;border-radius:0 0 14px 14px;padding:26px 24px;color:#111111;">` +
    `<p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;">${escapeHtml(msg.body).replace(/\n/g, '<br>')}</p>` +
    details +
    `</div></div></div>`
  );
}

/** The plain-text form both chat channels send and the email carries too. */
export function plainNotification(msg: CustomerMessage): string {
  const lines = [msg.body];
  for (const d of msg.details ?? []) lines.push(`${d.label}: ${d.value}`);
  return `LEVONIS\n${lines.join('\n')}`;
}

/**
 * Queue one notification on every channel that can reach the customer.
 *
 * `eventKey` must be stable and unique per business event — e.g.
 * `order.placed:ORD-123`. The channel suffix is appended here, so callers
 * never have to remember to do it, and a caller that changes which channels
 * exist does not accidentally re-notify the ones that already went out.
 *
 * Returns which channels were newly queued. `false` for a channel means
 * either that it cannot reach this customer or that it was already queued for
 * this exact event — both of which are "nothing to do", and neither of which
 * is a failure.
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
  try {
    reach = await reachFor(env, userId);
  } catch (e) {
    console.error('notifyCustomer: reach lookup failed:', e instanceof Error ? e.message : String(e));
    return out;
  }

  const text = plainNotification(msg);

  // Each enqueue is independently guarded: one channel's failure must not
  // cost the customer the other two.
  if (wanted.includes('email') && reach.email) {
    try {
      out.email =
        (await enqueue(env, `${eventKey}:email`, {
          kind: 'email',
          to: reach.email,
          subject: msg.subject,
          html: notifyHtml(reach.lang, msg),
          text,
        })) !== null;
    } catch (e) {
      console.error('notifyCustomer: email enqueue failed:', e instanceof Error ? e.message : String(e));
    }
  }

  if (wanted.includes('whatsapp') && reach.phone) {
    try {
      out.whatsapp =
        (await enqueue(env, `${eventKey}:whatsapp`, { kind: 'whatsapp', to: reach.phone, text })) !== null;
    } catch (e) {
      console.error('notifyCustomer: whatsapp enqueue failed:', e instanceof Error ? e.message : String(e));
    }
  }

  if (wanted.includes('telegram') && reach.telegram_chat_id !== null) {
    try {
      out.telegram =
        (await enqueue(env, `${eventKey}:telegram`, {
          kind: 'telegram',
          chat_id: reach.telegram_chat_id,
          text,
        })) !== null;
    } catch (e) {
      console.error('notifyCustomer: telegram enqueue failed:', e instanceof Error ? e.message : String(e));
    }
  }

  return out;
}
