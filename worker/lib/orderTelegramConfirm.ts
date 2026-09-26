/**
 * «تم تأكيد الطلب» — CONFIRMING AN ORDER FROM THE MESSAGE THAT ANNOUNCED IT.
 *
 * The owner, about the «📝 Orders» topics: «تفاصيل الطلب … + زر inline «تم
 * تأكيد الطلب»». The message already names everything needed to decide; the
 * decision then cost a trip to the admin panel to find the same order again and
 * press the same stage. This is that press, on the message.
 *
 * WHAT THE BUTTON IS, AND WHAT IT IS NOT.
 *
 *  • IT IS THE STAGE DOOR, NOT A SECOND ONE. The press calls `moveOrderStage`
 *    with `to: 'confirmed'`, `source: 'manual'` — the function the panel's
 *    stage panel calls — so the customer's notification, the stock deduction,
 *    the history row and the race fence are the ones that already exist. A
 *    Telegram confirmation that did any of those differently would be the
 *    "which door did the admin use" defect this codebase has already fixed
 *    once (worker/lib/orderStageOps.ts).
 *  • IT REFUSES WHAT THE PANEL REFUSES. A Gini order whose receipt barcode was
 *    never scanned cannot be confirmed from the panel (GINI_RECEIPT_REQUIRED);
 *    it cannot be confirmed from here either.
 *  • IT IS IDEMPOTENT BY THE ORDER'S OWN STATE, not by a token. Confirmation
 *    moves no money that a replay could double, so the wallet's single-use
 *    token machinery would add nothing but a table. A second press finds the
 *    order already confirmed and says so; two admins pressing at once meet the
 *    stage flip's conditional UPDATE and exactly one wins.
 *
 * WHO MAY PRESS IT. Two doors, as everywhere on the admin bot
 * (worker/lib/telegramAdmin.ts): the bot allow-list (`TELEGRAM_ADMIN_USER_IDS`,
 * checked by the webhook before this is reached and again here), AND a live
 * `admin_tg_identities` row whose site account is still an admin. Unlike the
 * wallet's `resolveAdminActor`, an ASSISTANT admin passes: confirming an order
 * is operations, which the assistant scope exists to allow (worker/lib/
 * adminScope.ts), and the panel lets them do exactly this. AND WHERE: only in
 * the bound admin group (or, before one is bound, the legacy admin chat) — a
 * forwarded copy of the message in any other chat carries a dead button.
 */

import type { Env } from './types';
import { answerCallbackQuery, editMessageReplyMarkup, editMessageText, type BotId } from './telegram';
import { auditAdminBot, isBotAdmin, isGroupChatId, readAdminGroup } from './telegramAdmin';
import { moveOrderStage } from './orderStageOps';
import { flushOrderStatusNotice } from './orderNotify';
import { GINI_RECEIPT_REQUIRED_MESSAGE, giniBlocksConfirmation } from './gini';
import { actorLabel, sanitizeUserText, type AdminActor } from './walletNotify';
import { baghdadDayOf } from './baghdadTime';

/** The callback namespace. Wallet tokens never start with it (walletNotify.ts). */
export const ORDER_CONFIRM_PREFIX = 'oc:';

/** The same id shape `orderAdminLink` accepts; nothing else is ever minted. */
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,60}$/;

/** Telegram refuses `callback_data` over 64 BYTES. */
const CALLBACK_DATA_MAX_BYTES = 64;

export function orderConfirmCallbackData(orderId: string): string | null {
  if (!ORDER_ID_RE.test(orderId)) return null;
  const data = `${ORDER_CONFIRM_PREFIX}${orderId}`;
  return new TextEncoder().encode(data).length <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

export function isOrderConfirmData(data: unknown): data is string {
  return typeof data === 'string' && data.startsWith(ORDER_CONFIRM_PREFIX);
}

function parseOrderConfirmData(data: unknown): string | null {
  if (!isOrderConfirmData(data)) return null;
  const id = data.slice(ORDER_CONFIRM_PREFIX.length);
  return ORDER_ID_RE.test(id) ? id : null;
}

/**
 * «🔗 فتح في لوحة الإدارة» — the order itself, opened in the board's modal
 * (src/components/adminOrders/OrdersBoard.tsx reads `order`, src/pages/Admin.tsx
 * reads `tab`). From `env.APP_ORIGIN` only and only over https, the same rule
 * `adminDeepLink` keeps for the wallet: an unlinked button is honest, a link
 * built from a request's Host header is not.
 */
export function orderAdminLink(env: Env, orderId: string): string | null {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!origin.startsWith('https://') || !ORDER_ID_RE.test(orderId)) return null;
  return `${origin}/admin?tab=orders&order=${encodeURIComponent(orderId)}`;
}

function linkRow(env: Env, orderId: string): Array<Array<Record<string, unknown>>> {
  const url = orderAdminLink(env, orderId);
  return url ? [[{ text: '🔗 فتح في لوحة الإدارة', url }]] : [];
}

/**
 * The keyboard the order message is sent with: the button the owner asked for,
 * and the panel link under it. Null only for an id that cannot be carried in
 * `callback_data` — the message then goes out with the link alone rather than
 * with a button Telegram would refuse (and take the whole message with it).
 */
export function orderConfirmKeyboard(env: Env, orderId: string): Record<string, unknown> | null {
  const data = orderConfirmCallbackData(orderId);
  const rows = linkRow(env, orderId);
  if (!data) return rows.length ? { inline_keyboard: rows } : null;
  return { inline_keyboard: [[{ text: '✅ تم تأكيد الطلب', callback_data: data }], ...rows] };
}

/** After the decision: the link stays, the button that decided is gone. */
function closedMarkup(env: Env, orderId: string): Record<string, unknown> {
  return { inline_keyboard: linkRow(env, orderId) };
}

/** What a callback needs to carry. `message.text` is the body to re-stamp. */
export interface OrderConfirmCallback {
  id: string;
  from?: { id?: number };
  data?: string;
  message?: { message_id?: number; chat?: { id?: number }; text?: string };
}

export type OrderConfirmOutcome =
  | 'ignored'
  | 'wrong_chat'
  | 'not_authorized'
  | 'not_found'
  | 'cancelled'
  | 'already_confirmed'
  | 'gini_blocked'
  | 'confirmed'
  | 'raced'
  | 'refused';

/**
 * Is `chatId` the chat this bot posts order messages into? The admin bot's is
 * the bound GROUP (and only a real group id — the same read-side guard
 * `resolveAdminDestination` keeps); the customer bot's is the legacy
 * `TELEGRAM_ADMIN_CHAT_ID`, which is where the ladder sends orders before any
 * group is bound.
 */
async function isOrderChat(env: Env, chatId: number, bot: BotId): Promise<boolean> {
  if (bot === 'admin') {
    const group = await readAdminGroup(env.DB).catch(() => null);
    return !!group && isGroupChatId(group.groupChatId) && group.groupChatId === String(chatId);
  }
  const legacy = (env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  return legacy !== '' && legacy === String(chatId);
}

/**
 * The site admin behind a Telegram id — `admin_tg_identities`, live, joined to
 * a user who is STILL an admin, read at press time and never cached. See the
 * header for why the wallet's financial-scope clause is deliberately absent.
 */
async function resolveOrderActor(env: Env, telegramUserId: unknown): Promise<AdminActor | null> {
  if (typeof telegramUserId !== 'number' || !Number.isSafeInteger(telegramUserId)) return null;
  const row = await env.DB.prepare(
    `SELECT i.user_id, u.name, u.username FROM admin_tg_identities i
       JOIN users u ON u.id = i.user_id
      WHERE i.telegram_user_id = ? AND i.revoked_at IS NULL AND u.role = 'admin'`
  )
    .bind(telegramUserId)
    .first<{ user_id: string; name: string; username: string | null }>();
  if (!row) return null;
  return { userId: row.user_id, name: row.name, username: row.username, telegramUserId };
}

/** «2026-09-23 14:05» on Baghdad's clock, which is the clock the group lives on. */
export function baghdadClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const hhmm = new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
  return `${baghdadDayOf(iso)} ${hhmm}`;
}

/** Telegram's own ceiling on a text message; the stamp must survive it. */
const TEXT_MAX = 4000;

/** The original message with ONE stamp line appended — the stamp is what must
 *  survive the length limit, so the body is trimmed first, never the stamp. */
export function stampedText(original: string, stamp: string): string {
  const tail = `\n\n${stamp}`;
  const room = TEXT_MAX - tail.length;
  const body = original.length <= room ? original : `${original.slice(0, Math.max(0, room - 1))}…`;
  return `${body}${tail}`;
}

/**
 * Rewrites the pressed message: the stamp appended, the confirm button gone,
 * the panel link kept. Best-effort — the order state is already true whatever
 * Telegram answers — and a message whose text did not come back on the
 * callback keeps its text and only loses the button.
 */
async function closeMessage(
  env: Env,
  cb: OrderConfirmCallback,
  orderId: string,
  stamp: string,
  bot: BotId
): Promise<void> {
  const chatId = cb.message!.chat!.id!;
  const messageId = cb.message!.message_id!;
  const original = typeof cb.message?.text === 'string' ? cb.message.text : '';
  const markup = closedMarkup(env, orderId);
  if (original) {
    const res = await editMessageText(env, chatId, messageId, stampedText(original, stamp), markup, bot);
    if (res.ok) return;
  }
  await editMessageReplyMarkup(env, chatId, messageId, markup, bot);
}

const CONFIRMED_OR_LATER = new Set(['confirmed', 'processing', 'shipped', 'delivered']);

/**
 * One press of «تم تأكيد الطلب». Every refusal is ANSWERED (a button that
 * spins and says nothing reads as a broken bot) and every answer describes
 * only what has already been committed.
 */
export async function handleOrderConfirmCallback(
  env: Env,
  cb: OrderConfirmCallback,
  bot: BotId
): Promise<OrderConfirmOutcome> {
  const orderId = parseOrderConfirmData(cb.data);
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const fromId = typeof cb.from?.id === 'number' ? cb.from.id : null;
  if (!orderId || typeof chatId !== 'number' || typeof messageId !== 'number') {
    if (cb.id) await answerCallbackQuery(env, cb.id, 'زر غير صالح.', true, bot);
    return 'ignored';
  }

  // WHERE. A forwarded copy of the message is not the admin group.
  if (!(await isOrderChat(env, chatId, bot))) {
    await answerCallbackQuery(env, cb.id, 'هذا الزر يعمل في مجموعة الإدارة فقط.', true, bot);
    await auditAdminBot(env.DB, null, 'telegram.order_confirm.denied', orderId, fromId, {
      reason: 'wrong_chat',
      chat_id: chatId,
    });
    return 'wrong_chat';
  }

  // WHO — door 1 (the bot allow-list) on the admin bot, door 2 (a live site
  // admin behind this Telegram id) on both.
  const actor = bot === 'admin' && !isBotAdmin(env, fromId) ? null : await resolveOrderActor(env, fromId);
  if (!actor) {
    await answerCallbackQuery(env, cb.id, 'لا تملك صلاحية تأكيد الطلبات. اطلب من الإدارة ربط حسابك.', true, bot);
    await auditAdminBot(env.DB, null, 'telegram.order_confirm.denied', orderId, fromId, {
      reason: 'no_admin_identity',
    });
    return 'not_authorized';
  }

  const order = await env.DB.prepare(
    'SELECT id, status, payment_method_id, gini_state FROM orders WHERE id = ?'
  )
    .bind(orderId)
    .first<Record<string, unknown>>();
  if (!order) {
    await answerCallbackQuery(env, cb.id, 'الطلب غير موجود — ربما حُذف.', true, bot);
    await closeMessage(env, cb, orderId, '⚠️ الطلب غير موجود.', bot);
    return 'not_found';
  }
  const status = String(order.status ?? '');
  if (status === 'cancelled') {
    await answerCallbackQuery(env, cb.id, 'الطلب ملغى — لا يمكن تأكيده من هنا.', true, bot);
    await closeMessage(env, cb, orderId, '⛔️ الطلب ملغى.', bot);
    return 'cancelled';
  }
  if (CONFIRMED_OR_LATER.has(status)) {
    // THE SECOND PRESS. Nothing to do, and the button that invited it goes.
    await answerCallbackQuery(env, cb.id, 'الطلب مؤكد مسبقاً.', false, bot);
    await closeMessage(env, cb, orderId, '✅ الطلب مؤكد مسبقاً.', bot);
    return 'already_confirmed';
  }
  if (giniBlocksConfirmation(order)) {
    // The panel's own refusal, in its own Arabic half. The button STAYS: once
    // the barcode is scanned the same press is exactly right.
    await answerCallbackQuery(env, cb.id, GINI_RECEIPT_REQUIRED_MESSAGE.split(' / ')[0], true, bot);
    return 'gini_blocked';
  }

  const res = await moveOrderStage(env, {
    orderId,
    to: 'confirmed',
    source: 'manual',
    changedBy: actor.userId,
    note: 'Telegram',
  });

  if (!res.moved) {
    if (res.reason === 'RACED') {
      // Somebody else moved it between the read and the flip. If what they did
      // was confirm it, this press is simply the second one.
      const again = await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>();
      if (again && CONFIRMED_OR_LATER.has(again.status)) {
        await answerCallbackQuery(env, cb.id, 'الطلب مؤكد مسبقاً.', false, bot);
        await closeMessage(env, cb, orderId, '✅ الطلب مؤكد مسبقاً.', bot);
        return 'already_confirmed';
      }
      await answerCallbackQuery(env, cb.id, 'تغيّر الطلب أثناء التأكيد — أعد المحاولة.', true, bot);
      return 'raced';
    }
    if (res.reason === 'NOT_FOUND') {
      await answerCallbackQuery(env, cb.id, 'الطلب غير موجود — ربما حُذف.', true, bot);
      return 'not_found';
    }
    if (res.reason === 'PRICE_APPROVAL_PENDING') {
      // The button stays: once the customer decides, the same press is right.
      await answerCallbackQuery(env, cb.id, 'الطلب بانتظار موافقة الزبون على السعر الجديد — لا يمكن تأكيده الآن.', true, bot);
      return 'refused';
    }
    await answerCallbackQuery(env, cb.id, 'لا يمكن تأكيد الطلب من مرحلته الحالية — أكمل من لوحة الإدارة.', true, bot);
    await auditAdminBot(env.DB, actor.userId, 'telegram.order_confirm.refused', orderId, fromId, {
      reason: res.reason ?? 'unknown',
      from: res.from,
    });
    return 'refused';
  }

  // The same audit line the panel's stage door writes, with the Telegram
  // identity beside the site one (`auditAdminBot`).
  await auditAdminBot(env.DB, actor.userId, 'order.stage', orderId, fromId, {
    from: res.from,
    to: 'confirmed',
    stage_source: 'manual',
    legacy: `${res.legacy_from} -> ${res.legacy_to}`,
    next_stage: res.next_stage,
    next_stage_at: res.next_stage_at,
  });

  // Fast answer first (§12.2), then the rewrite. A stock note is a real
  // partial outcome the confirming admin must see, so it turns the toast into
  // an alert rather than being dropped.
  const warn = res.notes.length > 0;
  await answerCallbackQuery(
    env,
    cb.id,
    warn ? `تم تأكيد الطلب ✅ — تنبيه: ${res.notes.join(' ')}` : 'تم تأكيد الطلب ✅',
    warn,
    bot
  );
  const when = baghdadClock(new Date().toISOString());
  const who = sanitizeUserText(actorLabel(actor), { max: 60 });
  await closeMessage(env, cb, orderId, `✅ تم التأكيد — ${who}${when ? ` — ${when}` : ''}`, bot);

  // The customer's «تم تأكيد طلبك» was queued by the stage move; send it now
  // rather than at the next outbox cron. Never throws.
  await flushOrderStatusNotice(env, orderId, 'confirmed');
  return 'confirmed';
}
