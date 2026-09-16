/**
 * WHAT @alilevobot SAYS BACK.
 *
 * The whole setup the owner asked for is five lines typed into Telegram:
 *
 *     (in the Wallet topic)    /topic_here wallet
 *     (in the Orders topic)    /topic_here orders
 *     …
 *                              /topics
 *
 * No JSON, no Chat ID, no `message_thread_id`. Every number comes out of the
 * update Telegram already sent (§4, §8).
 *
 * THE REFUSALS ARE AS DELIBERATE AS THE COMMANDS.
 *  • An unauthorized user gets ONE sentence and learns nothing about the
 *    platform — not which commands exist, not whether a group is configured,
 *    not who the admins are (§20).
 *  • `/topic_here` refuses a private chat, refuses a non-forum chat, and
 *    refuses ANY group other than the one already bound. The first authorized
 *    `/topic_here` is what establishes the group; after that a second group
 *    cannot quietly take over the notifications (§5).
 */

import type { Env } from './types';
import { sendMessageToChat, type TgSendResult } from './telegram';
import {
  TOPIC_KEYS,
  auditAdminBot,
  bindAdminGroup,
  bindTopic,
  isTopicKey,
  readAdminGroup,
  readTopics,
  threadExtra,
  topicLabel,
  type TopicKey,
} from './telegramAdmin';
import { resolveAdminActor } from './walletNotify';

// ------------------------------------------------------------------- types

/** A forum-aware message. `message_thread_id` and `is_forum` are the two
 *  fields the customer bot's types never needed and this bot cannot work
 *  without. */
export interface AdminChat {
  id?: number;
  type?: string;
  title?: string;
  is_forum?: boolean;
}
export interface AdminMessage {
  message_id?: number;
  /** The forum topic this message is in. ABSENT for the General topic — that
   *  absence is data, not a gap, and is stored as NULL. */
  message_thread_id?: number;
  chat?: AdminChat;
  from?: { id?: number; username?: string; first_name?: string };
  text?: string;
}

export interface CommandContext {
  env: Env;
  msg: AdminMessage;
  /** Already checked against TELEGRAM_ADMIN_USER_IDS by the caller. */
  telegramUserId: number;
}

export type CommandOutcome =
  | 'ignored'
  | 'unauthorized'
  | 'replied'
  | 'bound_group'
  | 'bound_topic'
  | 'refused_private'
  | 'refused_not_forum'
  | 'refused_other_group'
  | 'refused_unknown_topic';

const GROUP_TYPES = new Set(['group', 'supergroup']);

// ------------------------------------------------------------------- copy

const TXT_UNAUTHORIZED = 'غير مصرح باستخدام بوت الإدارة.';

const TXT_START = [
  'مرحباً بك في بوت إدارة Levonis.',
  '',
  '• متابعة الطلبات',
  '• تعبئة المحفظة',
  '• التقييمات',
  '• البلاغات',
  '• توثيق التجار',
  '• الدعم',
  '',
  'استخدم /topics لعرض حالة ربط المواضيع.',
].join('\n');

const TXT_HELP = [
  'أوامر بوت الإدارة:',
  '',
  '/start — البداية',
  '/help — هذه القائمة',
  '/status — حالة البوت والمجموعة',
  '/topics — حالة ربط المواضيع',
  '/topic_here <اسم> — يربط الموضوع الحالي',
  '',
  `الأسماء المتاحة: ${TOPIC_KEYS.join('، ')}`,
  '',
  'اكتب /topic_here داخل الموضوع المطلوب — لا حاجة لأي رقم.',
].join('\n');

// --------------------------------------------------------------- dispatch

/** `/topic_here wallet` → ['topic_here', 'wallet']. `/topics@alilevobot` → ['topics'].
 *  The `@botname` suffix Telegram appends in groups is stripped here, once. */
export function parseCommand(text: unknown): { name: string; args: string[] } | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const name = parts[0].split('@')[0].toLowerCase();
  if (!/^[a-z_]{1,32}$/.test(name)) return null;
  return { name, args: parts.slice(1) };
}

export async function handleAdminCommand(ctx: CommandContext): Promise<CommandOutcome> {
  const cmd = parseCommand(ctx.msg.text);
  if (!cmd) return 'ignored';
  switch (cmd.name) {
    case 'start':
      await reply(ctx, TXT_START);
      return 'replied';
    case 'help':
      await reply(ctx, TXT_HELP);
      return 'replied';
    case 'status':
      await reply(ctx, await statusText(ctx));
      return 'replied';
    case 'topics':
      await reply(ctx, await topicsText(ctx));
      return 'replied';
    case 'topic_here':
      return bindHere(ctx, cmd.args[0]);
    default:
      // An unknown command from an authorized admin gets the menu, not silence.
      await reply(ctx, TXT_HELP);
      return 'replied';
  }
}

/** The one thing an unauthorized sender ever sees. */
export async function refuseUnauthorized(env: Env, msg: AdminMessage): Promise<void> {
  const chatId = msg.chat?.id;
  if (typeof chatId !== 'number') return;
  // A GROUP is a shared space: answering there would tell everyone in it that
  // this bot exists and is listening. Only a private chat gets the sentence.
  if (msg.chat?.type !== 'private') return;
  await sendMessageToChat(env, chatId, TXT_UNAUTHORIZED, {}, 'admin');
}

// ------------------------------------------------------------- /topic_here

async function bindHere(ctx: CommandContext, rawKey: string | undefined): Promise<CommandOutcome> {
  const { env, msg } = ctx;
  const chat = msg.chat ?? {};
  const chatId = chat.id;
  if (typeof chatId !== 'number') return 'ignored';

  // A private chat is not the admin group and must never become it (§19).
  if (chat.type === 'private') {
    await reply(ctx, 'اربط المواضيع من داخل مجموعة الإدارة (Forum) وليس من المحادثة الخاصة.');
    return 'refused_private';
  }
  if (!GROUP_TYPES.has(String(chat.type ?? ''))) {
    await reply(ctx, 'هذا الأمر يعمل داخل مجموعة إدارة من نوع Forum فقط.');
    return 'refused_not_forum';
  }

  const key = (rawKey ?? '').trim().toLowerCase();
  if (!isTopicKey(key)) {
    await reply(
      ctx,
      [
        'اكتب اسم الموضوع بعد الأمر، مثال:',
        '/topic_here wallet',
        '',
        `الأسماء المتاحة: ${TOPIC_KEYS.join('، ')}`,
      ].join('\n')
    );
    return 'refused_unknown_topic';
  }

  // The first authorized /topic_here ESTABLISHES the group; every later one
  // must come from that same group (§5).
  const actor = await resolveAdminActor(env, ctx.telegramUserId);
  const siteUserId = actor?.userId ?? `tg:${ctx.telegramUserId}`;
  const bound = await bindAdminGroup(env.DB, {
    chatId: String(chatId),
    title: String(chat.title ?? '').slice(0, 200),
    userId: siteUserId,
    telegramUserId: ctx.telegramUserId,
  });
  if (!bound.ok) {
    await reply(
      ctx,
      [
        '⚠️ مجموعة إدارة أخرى مربوطة بالفعل.',
        'لا يمكن ربط المواضيع من هذه المجموعة.',
        'إن أردت نقل الإدارة إلى هنا، أعد التعيين من لوحة الإدارة أولًا.',
      ].join('\n')
    );
    await auditAdminBot(env.DB, actor?.userId ?? null, 'telegram_admin.group.refused', String(chatId), ctx.telegramUserId, {
      bound_group: bound.existing.groupChatId,
      attempted_topic: key,
    });
    return 'refused_other_group';
  }

  // Telegram sends NO message_thread_id in a forum's General topic. That
  // absence IS the answer — stored as NULL, never invented (§21).
  const threadId = typeof msg.message_thread_id === 'number' ? msg.message_thread_id : null;
  await bindTopic(env.DB, {
    topicKey: key as TopicKey,
    messageThreadId: threadId,
    userId: siteUserId,
    telegramUserId: ctx.telegramUserId,
  });
  await auditAdminBot(env.DB, actor?.userId ?? null, 'telegram_admin.topic.bound', key, ctx.telegramUserId, {
    group_chat_id: String(chatId),
    message_thread_id: threadId,
    group_created: bound.created,
  });

  const where = threadId === null ? 'الموضوع العام (General)' : `هذا الموضوع`;
  await reply(
    ctx,
    [
      `✅ تم ربط «${topicLabel(key)}» بـ${where}.`,
      bound.created ? 'وتم اعتماد هذه المجموعة كمجموعة إدارة Levonis.' : '',
      '',
      'استخدم /topics لعرض بقية المواضيع.',
    ]
      .filter(Boolean)
      .join('\n')
  );
  return bound.created ? 'bound_group' : 'bound_topic';
}

// ----------------------------------------------------------------- /topics

async function topicsText(ctx: CommandContext): Promise<string> {
  const group = await readAdminGroup(ctx.env.DB);
  const topics = await readTopics(ctx.env.DB);
  const byKey = new Map(topics.map((t) => [t.topicKey, t]));
  const lines = ['إعداد مواضيع الإدارة:', ''];
  for (const key of TOPIC_KEYS) {
    const t = byKey.get(key);
    if (!t || !t.enabled) {
      lines.push(`❌ ${topicLabel(key)} — غير مربوط`);
      continue;
    }
    lines.push(`✅ ${topicLabel(key)}${t.messageThreadId === null ? ' (الموضوع العام)' : ''}`);
  }
  lines.push('');
  // "Is this the configured group?" — §7 asks for it explicitly, and it is the
  // question that turns a confusing silence into an obvious cause.
  const here = ctx.msg.chat?.id;
  if (!group) {
    lines.push('لا توجد مجموعة إدارة مربوطة بعد — اكتب /topic_here داخل أحد المواضيع للبدء.');
  } else if (typeof here === 'number' && String(here) === group.groupChatId) {
    lines.push('📍 هذه هي مجموعة الإدارة المعتمدة.');
  } else if (ctx.msg.chat?.type === 'private') {
    lines.push(`📍 مجموعة الإدارة المعتمدة: ${group.groupTitle || group.groupChatId}`);
  } else {
    lines.push('⚠️ هذه ليست مجموعة الإدارة المعتمدة — الإشعارات تذهب إلى مجموعة أخرى.');
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------- /status

async function statusText(ctx: CommandContext): Promise<string> {
  const group = await readAdminGroup(ctx.env.DB);
  const topics = (await readTopics(ctx.env.DB)).filter((t) => t.enabled);
  const legacy = (ctx.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  return [
    'حالة بوت الإدارة:',
    '',
    `• المجموعة: ${group ? group.groupTitle || group.groupChatId : 'غير مربوطة'}`,
    `• المواضيع المربوطة: ${topics.length} من ${TOPIC_KEYS.length}`,
    `• الوجهة الاحتياطية القديمة: ${legacy ? 'مفعّلة' : 'غير مضبوطة'}`,
    '',
    group
      ? 'الإشعارات تذهب إلى مواضيع هذه المجموعة.'
      : 'حتى ربط المجموعة، تذهب الإشعارات إلى الوجهة القديمة إن كانت مضبوطة.',
  ].join('\n');
}

// ------------------------------------------------------------------ reply

/** Replies IN THE SAME topic the command came from, so a bot answer never
 *  jumps out of the thread the admin was working in. */
async function reply(ctx: CommandContext, text: string): Promise<TgSendResult> {
  const chatId = ctx.msg.chat?.id;
  if (typeof chatId !== 'number') return { ok: false, error: 'no chat', retryable: false };
  const thread = typeof ctx.msg.message_thread_id === 'number' ? ctx.msg.message_thread_id : null;
  return sendMessageToChat(ctx.env, chatId, text, threadExtra(thread), 'admin');
}
