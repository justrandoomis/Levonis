/**
 * WHAT @alilevobot SAYS BACK.
 *
 * The whole setup the owner asked for is NINE lines typed into Telegram — one
 * inside each topic their group actually has, and nothing else:
 *
 *     (in the Wallet topic)          /topic_here wallet
 *     (in «Orders direct»)           /topic_here orders_direct
 *     (in «Orders pre-order»)        /topic_here orders_preorder
 *     (in «Warranty support»)        /topic_here warranty
 *     … and the same for review, report, merchant_verification, support, general
 *                              /topics
 *
 * It said "five" while the list under it asked for nine, which is the kind of
 * small untruth that makes an owner stop half way and assume they are done.
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
  BINDABLE_TOPIC_KEYS,
  auditAdminBot,
  bindAdminGroup,
  bindTopic,
  isTopicKey,
  readAdminGroup,
  readTopics,
  threadExtra,
  topicFallbackChain,
  topicLabel,
  type TopicBinding,
  type TopicKey,
} from './telegramAdmin';
import { actorLabel, resolveAdminActor } from './walletNotify';

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

/**
 * A Telegram forum is ALWAYS a supergroup carrying `is_forum: true`. A basic
 * `group` can never hold a topic at all, so it is not in this set: adopting one
 * as the admin group would bind every topic to the same thread-less chat while
 * the reply claimed a topic had been bound.
 */
const FORUM_TYPE = 'supergroup';

// ------------------------------------------------------------------- copy

const TXT_UNAUTHORIZED = 'غير مصرح باستخدام بوت الإدارة.';

const TXT_START = [
  'مرحباً بك في بوت إدارة Levonis.',
  '',
  '• الطلبات المسبقة والمباشرة',
  '• تعبئة المحفظة',
  '• التقييمات',
  '• البلاغات',
  '• توثيق التجار',
  '• الدعم',
  '• تذاكر الضمان',
  '',
  'استخدم /topics لعرض حالة ربط المواضيع.',
].join('\n');

/**
 * THE NAMES, ONE PER LINE, EACH BESIDE ITS ARABIC MEANING.
 *
 * They used to be one comma-joined line of English keys. With seven that was
 * merely terse; with nine — and with `orders_preorder` and `orders_direct` a
 * single underscore apart — it is a line nobody can copy from correctly on a
 * phone. The key is what the command takes and the label is what the owner
 * recognises, so both are shown and the whole command is spelled out ready to
 * copy. `orders` is absent for the reason BINDABLE_TOPIC_KEYS gives: it still
 * works, it is just not a topic anyone should go and create.
 */
const TXT_TOPIC_MENU = BINDABLE_TOPIC_KEYS.map((k) => `/topic_here ${k} — ${topicLabel(k)}`).join('\n');

const TXT_HELP = [
  'أوامر بوت الإدارة:',
  '',
  '/start — البداية',
  '/help — هذه القائمة',
  '/whoami — رقمك ومستوى صلاحيتك',
  '/status — حالة البوت والمجموعة',
  '/topics — حالة ربط المواضيع',
  '/topic_here <اسم> — يربط الموضوع الحالي',
  '',
  'الأسماء المتاحة:',
  TXT_TOPIC_MENU,
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
    case 'whoami':
      await reply(ctx, await whoamiText(ctx));
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

// ----------------------------------------------------------------- /whoami

/**
 * «اجعل 6404042791 الادمن حتى يتمكن من اضافه وربط topic» — AND THE REASON IT
 * IS NOT, IN ONE MESSAGE.
 *
 * `/topic_here` needs BOTH doors, and until now failing either one produced a
 * message that did not say WHICH:
 *
 *   DOOR 1 — the bot allow-list, `TELEGRAM_ADMIN_USER_IDS`, a Worker secret.
 *            Failing it means the webhook refuses before any command runs, and
 *            §20 says an unauthorized sender learns nothing about the platform
 *            — so in a GROUP the bot says nothing at all. Correct, and
 *            indistinguishable from a bot that is down.
 *   DOOR 2 — a row in `admin_tg_identities` joined to a site account whose
 *            role is 'admin'. This is the door that authorises money, and it
 *            is NOT granted by being on the allow-list.
 *
 * So somebody told "you are an admin now" tries `/topic_here`, gets silence or
 * a sentence about a door they thought they were through, and has no way to
 * find out which half is missing — or even what their own numeric id is, which
 * is the one fact needed to fix door 1.
 *
 * This answers all of it: the id to paste into the secret, and a tick or a
 * cross per door with the exact remedy under whichever one failed.
 *
 * IT REVEALS NOTHING. The reader's own Telegram id is already theirs — every
 * Telegram client will show it — and the two lines say only whether THEY pass.
 * No other admin, no group, no topic and no customer is named. Door 1 still
 * gates reaching this command at all, so it is not a probe for outsiders.
 */
async function whoamiText(ctx: CommandContext): Promise<string> {
  const { env, telegramUserId } = ctx;
  // Door 1 is already proven — the webhook refuses before dispatch — but it is
  // printed anyway, because a checklist that only ever shows the failing half
  // leaves the reader unsure the other half was even looked at.
  const actor = await resolveAdminActor(env, telegramUserId);
  const lines = [
    '🆔 رقمك في تيليغرام:',
    // Alone on its line, with nothing around it: this gets copied on a phone
    // and pasted into a secret, and a stray character there is a silent
    // failure that looks exactly like this one.
    String(telegramUserId),
    '',
    '✅ الباب الأول — قائمة أوامر البوت: مسموح.',
  ];
  if (actor) {
    lines.push(
      `✅ الباب الثاني — هوية إدارية على الموقع: ${actorLabel(actor)}.`,
      '',
      'تقدر تربط المواضيع: اكتب /topic_here داخل الموضوع المطلوب.'
    );
  } else {
    lines.push(
      '❌ الباب الثاني — هوية إدارية على الموقع: غير مربوطة.',
      '',
      'ربط المواضيع وأزرار اعتماد المحفظة يتطلبان هذا الباب.',
      'الحل: لوحة الإدارة ← المستخدمون ← تيليغرام ← هويات المسؤولين،',
      'واربط الرقم أعلاه بحساب دوره «admin».'
    );
  }
  return lines.join('\n');
}

// ------------------------------------------------------------- /topic_here

async function bindHere(ctx: CommandContext, rawKey: string | undefined): Promise<CommandOutcome> {
  const { env, msg } = ctx;
  const chat = msg.chat ?? {};
  const chatId = chat.id;
  if (typeof chatId !== 'number') return 'ignored';

  // A typo is answered first: it is not a permission problem, and refusing it
  // here keeps the later refusals from doubling as an oracle.
  const key = (rawKey ?? '').trim().toLowerCase();
  if (!isTopicKey(key)) {
    await reply(
      ctx,
      [
        'اكتب اسم الموضوع بعد الأمر، مثال:',
        '/topic_here wallet',
        '',
        'الأسماء المتاحة:',
        TXT_TOPIC_MENU,
      ].join('\n')
    );
    return 'refused_unknown_topic';
  }

  // A private chat is not the admin group and must never become it (§19).
  if (chat.type === 'private') {
    await reply(ctx, 'اربط المواضيع من داخل مجموعة الإدارة (Forum) وليس من المحادثة الخاصة.');
    return 'refused_private';
  }
  // A FORUM, PROVEN — not merely "some group". Telegram sets `is_forum` on
  // every message from a forum supergroup, so its absence is a real negative
  // and not a missing field. Without this the outcome name `refused_not_forum`
  // was a claim the code never checked: a plain group was silently adopted as
  // THE admin group and every `/topic_here` in it bound a thread-less
  // destination.
  if (String(chat.type ?? '') !== FORUM_TYPE || chat.is_forum !== true) {
    await reply(
      ctx,
      [
        'هذا الأمر يعمل داخل مجموعة إدارة من نوع Forum فقط.',
        'فعّل «Topics» في إعدادات المجموعة ثم أعد المحاولة من داخل الموضوع المطلوب.',
      ].join('\n')
    );
    return 'refused_not_forum';
  }

  /**
   * DOOR 2, AND IT BELONGS HERE.
   *
   * Being on `TELEGRAM_ADMIN_USER_IDS` opens the bot. It does NOT get to decide
   * WHERE the platform delivers its admin notifications — and that includes the
   * wallet messages, which carry the customer's payment-proof photo. Re-pointing
   * that is at least as sensitive as pressing the approve button, so it is
   * behind the same site-role check the button uses: a live `admin_tg_identities`
   * row joined to `users.role = 'admin'`, read now.
   *
   * There is no `tg:<id>` fallback any more. A binding whose author cannot be
   * named in the audit trail is a binding nobody can answer for.
   */
  const actor = await resolveAdminActor(env, ctx.telegramUserId);
  if (!actor) {
    await reply(
      ctx,
      [
        '⚠️ حسابك غير مربوط بصلاحية إدارة على الموقع.',
        'ربط المواضيع يحدّد أين تصل رسائل المحفظة وإثباتات الدفع، فيتطلب نفس صلاحية أزرار الاعتماد.',
        'اطلب من الإدارة ربط حسابك من: لوحة الإدارة ← تيليغرام ← هويات المسؤولين.',
      ].join('\n')
    );
    await auditAdminBot(env.DB, null, 'telegram_admin.topic.denied', String(chatId), ctx.telegramUserId, {
      reason: 'no_site_admin_identity',
      attempted_topic: (rawKey ?? '').slice(0, 40),
    });
    return 'unauthorized';
  }

  // The first authorized /topic_here ESTABLISHES the group; every later one
  // must come from that same group (§5).
  const siteUserId = actor.userId;
  const bound = await bindAdminGroup(env.DB, {
    chatId: String(chatId),
    title: String(chat.title ?? '').slice(0, 200),
    userId: siteUserId,
    telegramUserId: ctx.telegramUserId,
  });
  if (!bound.ok) {
    /**
     * TWO REFUSALS, TWO SENTENCES. `not_a_group` means the chat id is not a
     * group id at all — unreachable from here today (the forum checks above run
     * first) and kept only so a future path cannot bind a private chat as the
     * admin group. Telling the owner "another group is already bound" in that
     * case would send them to reset a group that is not the problem.
     */
    if (bound.reason === 'not_a_group') {
      await reply(ctx, '⚠️ لا يمكن اعتماد هذه المحادثة كمجموعة إدارة. افتح مجموعة ذات مواضيع (Forum) وأعد المحاولة.');
      await auditAdminBot(env.DB, actor.userId, 'telegram_admin.group.refused', String(chatId), ctx.telegramUserId, {
        reason: 'not_a_group',
        attempted_topic: key,
      });
      return 'refused_not_forum';
    }
    await reply(
      ctx,
      [
        '⚠️ مجموعة إدارة أخرى مربوطة بالفعل.',
        'لا يمكن ربط المواضيع من هذه المجموعة.',
        'إن أردت نقل الإدارة إلى هنا، أعد التعيين من لوحة الإدارة أولًا.',
      ].join('\n')
    );
    await auditAdminBot(env.DB, actor.userId, 'telegram_admin.group.refused', String(chatId), ctx.telegramUserId, {
      bound_group: bound.existing.groupChatId,
      attempted_topic: key,
    });
    return 'refused_other_group';
  }

  // Telegram sends NO message_thread_id in a forum's General topic. That
  // absence IS the answer — stored as NULL, never invented (§21).
  const threadId = typeof msg.message_thread_id === 'number' ? msg.message_thread_id : null;
  // Conditional on THIS group still being the bound one. `group/reset` can land
  // between the check above and this write; without the guard the topic row
  // would outlive the config row and the next group to be adopted would inherit
  // a thread id from the group that was abandoned.
  const wrote = await bindTopic(env.DB, {
    topicKey: key as TopicKey,
    messageThreadId: threadId,
    userId: siteUserId,
    telegramUserId: ctx.telegramUserId,
    groupChatId: String(chatId),
  });
  if (!wrote) {
    await reply(ctx, '⚠️ تغيّر ربط المجموعة أثناء التنفيذ. أعد إرسال الأمر من داخل الموضوع.');
    await auditAdminBot(env.DB, actor.userId, 'telegram_admin.topic.raced', key, ctx.telegramUserId, {
      group_chat_id: String(chatId),
    });
    return 'refused_other_group';
  }
  await auditAdminBot(env.DB, actor.userId, 'telegram_admin.topic.bound', key, ctx.telegramUserId, {
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

/**
 * WHERE AN UNBOUND KEY'S MESSAGES ARE LANDING RIGHT NOW.
 *
 * `/topics` used to print «❌ غير مربوط» and stop there, which reads as "these
 * notifications are lost". They are not — the router has always carried them on
 * (a sibling topic, then General, then the legacy chat). Saying only "not bound"
 * about a live destination is the kind of half-truth that makes an owner go
 * looking for messages that were delivered all along, or worse, stop trusting
 * the screen. So every unbound line also names where its traffic goes today.
 *
 * THE WORDING IS CONDITIONAL AND NOT PRESENT-TENSE, on purpose. «تصل حالياً إلى»
 * asserts that messages for this key ARE being delivered somewhere right now,
 * which is only true while something actually produces them; «عند وصول رسالة»
 * is true either way. Every one of the nine does have a producer today — report
 * gets the community dispute and the price report, merchant_verification gets
 * the new store, the new merchant profile and the identity case — but a screen
 * whose truth depends on a call site somewhere else staying alive is a screen
 * that will lie the first time one is removed.
 *
 * It reproduces the ladder in `resolveAdminDestination` deliberately and reads
 * the SAME rows, so the two cannot disagree about a binding. It stops at the
 * group, because `/topics` is only ever answered when the bot is running and
 * the last lines below already say whether a group is bound at all.
 */
function landingNow(key: TopicKey, byKey: Map<string, TopicBinding>): string {
  for (const sibling of topicFallbackChain(key)) {
    if (byKey.get(sibling)?.enabled) return topicLabel(sibling);
  }
  if (byKey.get('general')?.enabled) return topicLabel('general');
  return 'الموضوع العام (General)';
}

async function topicsText(ctx: CommandContext): Promise<string> {
  const group = await readAdminGroup(ctx.env.DB);
  const topics = await readTopics(ctx.env.DB);
  const byKey = new Map(topics.map((t) => [t.topicKey, t]));
  const lines = [`إعداد مواضيع الإدارة (${BINDABLE_TOPIC_KEYS.length}):`, ''];
  let missing = 0;
  for (const key of BINDABLE_TOPIC_KEYS) {
    const t = byKey.get(key);
    if (!t || !t.enabled) {
      missing += 1;
      /**
       * ONE LINE PER TOPIC, and it still ends in the exact command.
       *
       * This pushed THREE lines for every unbound topic. On a fresh deployment
       * that is twenty-seven lines plus a header, a footer and the group note
       * — a wall of text on the phone the owner is holding inside the topic
       * they are trying to bind, which is the screen this reply exists to make
       * easy. The three facts are all still here: what the topic is, where its
       * messages land until it is bound, and the command. The command stays
       * LAST so a tap-and-hold still selects it cleanly, and the owner never
       * has to go back to /help to find out what to type next.
       */
      lines.push(
        `❌ ${topicLabel(key)} — عند وصول رسالة ستنزل في «${landingNow(key, byKey)}» · /topic_here ${key}`
      );
      continue;
    }
    lines.push(`✅ ${topicLabel(key)}${t.messageThreadId === null ? ' (الموضوع العام)' : ''}`);
  }
  lines.push('');
  lines.push(
    missing === 0
      ? '🎉 كل المواضيع مربوطة.'
      : `بقي ${missing} من ${BINDABLE_TOPIC_KEYS.length} مواضيع بدون ربط — اكتب الأمر داخل كل موضوع.`
  );
  /**
   * THE LEGACY `orders` ROW, SHOWN ONLY IF IT EXISTS.
   *
   * It is not one of the nine, so it gets no checklist line — but it is a real
   * binding that is really carrying pre-orders and direct orders until those two
   * are bound, and an owner who sees «الطلبات المسبقة — غير مربوط» with no
   * further explanation would reasonably conclude the orders had stopped
   * arriving. One line, only when the row is actually there.
   */
  const legacyOrders = byKey.get('orders');
  if (legacyOrders?.enabled) {
    lines.push('');
    lines.push('ℹ️ يوجد ربط قديم باسم orders ما زال يستقبل الطلبات حتى تربط «الطلبات المسبقة» و«الطلبات المباشرة».');
    lines.push('بعد ربطهما لن يصله شيء ويمكنك تركه أو حذفه بأمان — لا تحذفه قبل ذلك.');
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
  // COUNTED AGAINST THE NINE, not against every key that exists. The denominator
  // is the number of topics in the owner's group; counting the legacy `orders`
  // row in the numerator would let /status read «8 من 9» while a topic the owner
  // can see on screen is still unbound.
  const boundKeys = new Set(topics.map((t) => t.topicKey));
  const done = BINDABLE_TOPIC_KEYS.filter((k) => boundKeys.has(k)).length;
  const legacy = (ctx.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  return [
    'حالة بوت الإدارة:',
    '',
    `• المجموعة: ${group ? group.groupTitle || group.groupChatId : 'غير مربوطة'}`,
    `• المواضيع المربوطة: ${done} من ${BINDABLE_TOPIC_KEYS.length}`,
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
