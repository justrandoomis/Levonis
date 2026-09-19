/**
 * THE ADMIN BOT — @alilevobot (migration 0080).
 *
 * A SECOND Telegram bot, kept completely apart from the customer bot: its own
 * token, its own webhook secret, its own webhook path, its own update-dedup
 * table, and its own allow-list. It talks to ONE forum group and to admins in
 * a private chat. It never DMs a customer, and it never touches the linking or
 * OTP conversations — those belong to the customer bot and are keyed by a chat
 * id that only that bot can address.
 *
 * -------------------------------------------------------------------------
 * NOBODY HAS TO GO AND FIND A CHAT ID
 * -------------------------------------------------------------------------
 * The owner's constraint, verbatim: «The new admin system must NOT require me
 * to manually discover or enter the group Chat ID or Topic IDs.»
 *
 * Telegram already tells us. Every message carries `chat.id`, a message inside
 * a forum topic carries `message_thread_id`, and the sender carries `from.id`.
 * So the whole setup is: open a topic, type `/topic_here wallet`. The bot reads
 * those three fields out of that one update and stores them. `/topics` then
 * shows what is bound and what is not.
 *
 * -------------------------------------------------------------------------
 * TWO DOORS, AND THEY ARE NOT THE SAME DOOR
 * -------------------------------------------------------------------------
 *  1. THE BOT DOOR — `TELEGRAM_ADMIN_USER_IDS`, numeric Telegram ids only.
 *     This decides who may command the bot at all. A @username is NOT an
 *     identity: it is re-assignable and trivially spoofed in a display name,
 *     so it grants nothing anywhere in this file.
 *  2. THE MONEY DOOR — unchanged, and NOT this file's. A wallet decision still
 *     goes through `resolveAdminActor`, which reads `admin_tg_identities`
 *     JOIN `users.role = 'admin'` at click time. Being on the bot allow-list,
 *     being in the group, or being a Telegram group admin authorises no
 *     financial transition. Passing door 1 only gets you the buttons.
 *
 * -------------------------------------------------------------------------
 * THE TWO BOTS MUST NEVER CROSS — WHAT ACTUALLY ENFORCES IT
 * -------------------------------------------------------------------------
 * @alilevobot is the ADMIN bot; @Levonisiq_bot is the MEMBER bot that verifies
 * identity and carries notifications to customers and merchants. Being honest
 * about the seam, because "by convention" is not a guarantee:
 *
 *  • WHICH TOKEN IS SENT WITH is a plain argument — `sendMessageToChat(…, bot)`
 *    in worker/lib/telegram.ts defaults to 'customer' and the caller opts in to
 *    'admin'. Nothing in the type system stops a future customer-facing notifier
 *    from passing 'admin'. THAT IS A REAL RISK and it is named here rather than
 *    left implied; the defence is that the default is the safe one, so the
 *    mistake has to be typed on purpose.
 *  • WHERE THE ADMIN BOT MAY SEND, on the other hand, IS structural. Every
 *    admin destination in this file comes out of `resolveAdminDestination`, and
 *    it returns `bot: 'admin'` only with the bound GROUP's chat id — which
 *    `isGroupChatId` now proves is a group id (negative) at the write AND at
 *    the read. A customer's chat id is their own positive user id, so it cannot
 *    come out of this function at all. The one place the admin bot answers a
 *    private chat is a reply to an ADMIN who typed a command at it
 *    (telegramAdminCommands.ts), which is the point of the bot, not a leak.
 *  • The admin bot never touches linking or OTP: those conversations are keyed
 *    by a chat id only the customer bot shares, and nothing here reads them.
 *
 * -------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * -------------------------------------------------------------------------
 * It moves no money, decides no request and writes no ledger row. The wallet
 * approve/reject buttons are the EXISTING machinery in worker/lib/walletNotify.ts
 * — tokens, single-use claim, `decideDeposit`, authoritative re-read, audit,
 * customer notification. This file only decides WHERE a message goes and WHICH
 * bot carries it.
 */

import type { Env } from './types';
import { audit } from './audit';
import { botConfigured, scrubTokens, sendMessageToChat, type BotId, type TgSendResult } from './telegram';

// ---------------------------------------------------------------- vocabulary

/**
 * The topics the platform routes to. `general` is the fallback and is
 * deliberately first — a destination that exists is the point of it.
 *
 * Extending this list is a one-line change here plus a label below: the table
 * carries no CHECK constraint precisely so the next topic is not a migration.
 * RE-VERIFIED before the three keys below were added: migration 0080 declares
 * `telegram_admin_topics (topic_key TEXT PRIMARY KEY CHECK (topic_key <> ''), …)`
 * and `tg_admin_notifications.topic_key TEXT NOT NULL DEFAULT ''` — neither
 * constrains the VALUE, so a new key is storable today and this change ships
 * with no migration at all. If a CHECK is ever added there, this comment is the
 * warning that adding a topic stops being free.
 *
 * WHY THE LIST GREW FROM SEVEN, AND TO EXACTLY THESE. The group the owner
 * actually runs has NINE topics:
 *
 *   🔥 Warranty support · 📝 Orders pre-order · 📝 Orders direct · # General ·
 *   💲 Wallet · 📢 Review · ❗ Report · ⚡ Merchants verification · ‼️ Support
 *
 * Two of them had no key at all. Warranty tickets — «تذاكر الضمان», the owner's
 * own words — were landing in whatever general destination the ladder found,
 * mixed in with everything else, which is precisely the pile the owner opened a
 * dedicated topic to stop reading. And one `orders` key cannot address two
 * topics: a PRE-ORDER (paid now, produced later, a queue watched for capacity
 * and for promised dates) and a DIRECT order (printed and shipped today) are
 * two different workflows the owner checks at different hours. One key would
 * have forced both into one topic and made the owner's own split pointless.
 *
 * `orders` IS STILL A KEY — the tenth, against nine topics — and that is not an
 * oversight. See TOPIC_FALLBACK: it is already bound in the owner's group and
 * it is still the literal argument at live call sites (worker/routes/orders.ts,
 * worker/routes/returns.ts). Deleting it would have turned a working binding
 * into a type error and, worse, a silently re-routed notification.
 */
export const TOPIC_KEYS = [
  'general',
  'review',
  'report',
  'merchant_verification',
  'wallet',
  'orders',
  'orders_preorder',
  'orders_direct',
  'support',
  'warranty',
] as const;
export type TopicKey = (typeof TOPIC_KEYS)[number];

const TOPIC_LABELS: Record<TopicKey, string> = {
  general: 'عام',
  review: 'التقييمات',
  report: 'البلاغات',
  merchant_verification: 'توثيق التجار',
  wallet: 'المحفظة',
  orders: 'الطلبات',
  orders_preorder: 'الطلبات المسبقة',
  orders_direct: 'الطلبات المباشرة',
  support: 'الدعم',
  warranty: 'تذاكر الضمان',
};

/**
 * THE NINE the owner is asked to bind, in the order `/topics` lists them —
 * one line per topic that exists in their group, and no line for anything else.
 *
 * `orders` is deliberately NOT here. It still resolves, it still accepts
 * `/topic_here orders`, and an existing binding of it still carries traffic;
 * it is simply not advertised as a tenth topic to go and create, because the
 * group has nine and a checklist that does not match what is on screen is a
 * checklist the owner stops trusting.
 */
export const BINDABLE_TOPIC_KEYS: readonly TopicKey[] = TOPIC_KEYS.filter((k) => k !== 'orders');

/**
 * WHERE A NOTIFICATION GOES WHEN ITS OWN TOPIC IS NOT BOUND YET.
 *
 * The ladder that already existed is untouched and is still the floor: the
 * topic → GENERAL → the legacy chat → a reported miss. Nothing is dropped and
 * nothing throws; an unbound NEW key behaves exactly like an unbound OLD one.
 *
 * What is added is ONE optional step in front of General, for the keys that
 * have a sibling which is plainly a better home than a mixed feed:
 *
 *  • orders_preorder / orders_direct → `orders`. THIS IS THE BACKWARD
 *    COMPATIBILITY, and it is the reason the split costs the owner nothing.
 *    A row that already says `orders` keeps carrying BOTH kinds of order the
 *    moment this deploys, before anyone types anything in Telegram. Binding
 *    «Orders pre-order» later takes the pre-orders out of it; binding neither
 *    changes nothing. A binding the owner already made never stops working.
 *  • orders → orders_direct → orders_preorder. The mirror image, for after the
 *    owner has bound the two new topics and the old `orders` row is gone: the
 *    call sites that still pass the literal 'orders' (orders.ts, returns.ts)
 *    then land in an ORDERS topic instead of falling all the way to General.
 *  • warranty → support. «Warranty support» is support; until its own topic is
 *    bound, the Support topic is where the owner is already looking for it.
 *
 * THE LOOKUP IS FLAT AND NOT RECURSIVE — each chain is tried in order and then
 * General, and a chain is never followed out of another chain. That is what
 * makes `orders_preorder → orders` and `orders → orders_preorder` safe to state
 * at the same time: two keys can name each other without any possibility of a
 * cycle, and no notification can loop while a customer waits for it.
 */
const TOPIC_FALLBACK: Partial<Record<TopicKey, readonly TopicKey[]>> = {
  orders_preorder: ['orders', 'orders_direct'],
  orders_direct: ['orders', 'orders_preorder'],
  orders: ['orders_direct', 'orders_preorder'],
  warranty: ['support'],
};

/** The siblings tried before GENERAL for an unbound key. Empty for most keys. */
export function topicFallbackChain(key: TopicKey): readonly TopicKey[] {
  return TOPIC_FALLBACK[key] ?? [];
}

export function topicLabel(key: string): string {
  return TOPIC_LABELS[key as TopicKey] ?? key;
}

export function isTopicKey(v: unknown): v is TopicKey {
  return typeof v === 'string' && (TOPIC_KEYS as readonly string[]).includes(v);
}

/**
 * A TELEGRAM GROUP ID IS NEGATIVE. A private chat's id is the user's own
 * positive numeric id, and that difference is the only cheap STRUCTURAL line
 * between the two bots — see the note at the head of this file.
 *
 * What it prevents: the admin bot is the one that carries wallet notifications,
 * and a wallet notification carries the customer's payment-proof photo. If the
 * group row ever held a POSITIVE id — a private chat with the bot, written by a
 * future caller that does not repeat `/topic_here`'s forum checks — every one
 * of those photos would be delivered into one person's DM by the bot that is
 * documented as never DMing anyone but through this router. The id's sign is
 * checked at the write AND at the read, because a row that predates the check
 * is exactly the row that would slip through.
 */
export function isGroupChatId(chatId: string): boolean {
  return /^-\d{1,19}$/.test(String(chatId).trim());
}

// --------------------------------------------------------------- authority

/**
 * The numeric Telegram ids allowed to command the bot.
 *
 * Parsed on every call rather than cached: the value is a Worker secret that
 * can be rotated by a redeploy, and a stale allow-list is the one cache that
 * must never outlive its source. Anything that is not a positive integer is
 * DROPPED, silently — a malformed entry must not widen the list, and it must
 * not empty it either.
 */
export function adminTelegramIds(env: Env): Set<number> {
  const out = new Set<number>();
  for (const part of (env.TELEGRAM_ADMIN_USER_IDS || '').split(/[,\s]+/)) {
    const raw = part.trim();
    if (!/^\d{1,19}$/.test(raw)) continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return out;
}

/**
 * Door 1. NUMERIC ids only — a username never reaches this function, and there
 * is no overload that accepts one.
 *
 * An EMPTY allow-list authorises NOBODY. That is the safe direction and the
 * honest one: an unset secret means the bot has not been given its admins yet,
 * not that everyone is an admin.
 */
export function isBotAdmin(env: Env, telegramUserId: unknown): boolean {
  if (typeof telegramUserId !== 'number' || !Number.isSafeInteger(telegramUserId)) return false;
  return adminTelegramIds(env).has(telegramUserId);
}

/** Is the admin bot usable at all? Callers answer 503 rather than throwing. */
export function adminBotConfigured(env: Env): boolean {
  return botConfigured(env, 'admin');
}

// ------------------------------------------------------------- the group

export interface AdminGroup {
  groupChatId: string;
  groupTitle: string;
  configuredBy: string;
  configuredByTg: number;
  updatedAt: string;
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export async function readAdminGroup(db: D1Database): Promise<AdminGroup | null> {
  const row = await db
    .prepare(
      `SELECT group_chat_id, group_title, configured_by, configured_by_tg, updated_at
         FROM telegram_admin_config WHERE id = 'singleton'`
    )
    .first<{
      group_chat_id: string;
      group_title: string;
      configured_by: string;
      configured_by_tg: number;
      updated_at: string;
    }>();
  if (!row) return null;
  return {
    groupChatId: row.group_chat_id,
    groupTitle: row.group_title,
    configuredBy: row.configured_by,
    configuredByTg: row.configured_by_tg,
    updatedAt: row.updated_at,
  };
}

/**
 * Binds the group, ONCE. Re-binding the SAME chat is a no-op refresh (the
 * title may have changed); binding a DIFFERENT chat is refused, because the
 * first `/topic_here` is what establishes the group and a second group would
 * silently take over every notification the first one was carrying.
 *
 * Moving to a genuinely new group is a deliberate admin act, not something a
 * message in the wrong chat can do by accident — `POST /api/telegram/admin/group/reset`
 * exists for it, behind a site admin session.
 *
 * REFUSES A NON-GROUP CHAT ID OUTRIGHT (`isGroupChatId`). `/topic_here` already
 * refuses a private chat and a non-forum chat before it ever gets here, so today
 * this is unreachable from Telegram — which is exactly why it is worth writing
 * down: it is the guard that survives the NEXT caller of this function, one that
 * will not repeat those checks. A private chat id stored here would make the
 * admin bot deliver payment-proof photos into one person's DM, and the failure
 * would look like normal operation. The refusal carries a REASON so the caller
 * can say which of the two things went wrong instead of blaming the other.
 */
export async function bindAdminGroup(
  db: D1Database,
  p: { chatId: string; title: string; userId: string; telegramUserId: number }
): Promise<
  | { ok: true; created: boolean }
  | { ok: false; reason: 'other_group'; existing: AdminGroup }
  | { ok: false; reason: 'not_a_group'; existing: null }
> {
  if (!isGroupChatId(p.chatId)) return { ok: false, reason: 'not_a_group', existing: null };
  const existing = await readAdminGroup(db);
  if (existing && existing.groupChatId !== p.chatId) return { ok: false, reason: 'other_group', existing };
  if (existing) {
    await db
      .prepare(
        `UPDATE telegram_admin_config SET group_title = ?2, updated_at = ${NOW_SQL} WHERE id = 'singleton'`
      )
      .bind('singleton', p.title)
      .run();
    return { ok: true, created: false };
  }
  await db
    .prepare(
      `INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
       VALUES ('singleton', ?1, ?2, ?3, ?4)`
    )
    .bind(p.chatId, p.title, p.userId, p.telegramUserId)
    .run();
  return { ok: true, created: true };
}

// ------------------------------------------------------------- the topics

export interface TopicBinding {
  topicKey: string;
  messageThreadId: number | null;
  enabled: boolean;
  updatedAt: string;
}

export async function readTopics(db: D1Database): Promise<TopicBinding[]> {
  const { results } = await db
    .prepare(
      `SELECT topic_key, message_thread_id, enabled, updated_at
         FROM telegram_admin_topics ORDER BY topic_key`
    )
    .all<{ topic_key: string; message_thread_id: number | null; enabled: number; updated_at: string }>();
  return (results ?? []).map((r) => ({
    topicKey: r.topic_key,
    messageThreadId: r.message_thread_id === null ? null : Number(r.message_thread_id),
    enabled: !!r.enabled,
    updatedAt: r.updated_at,
  }));
}

/**
 * Binds (or re-points) one topic. `topic_key` is the primary key, so running
 * `/topic_here wallet` in a different topic MOVES the wallet notifications
 * there — one command, nothing to clean up.
 *
 * `messageThreadId` is NULL for a forum's General topic, where Telegram sends
 * no thread id at all. We store that NULL rather than inventing a number: a
 * fabricated thread id addresses a topic that does not exist and every send
 * into it fails.
 *
 * The write is CONDITIONAL on `groupChatId` still being the bound group. The
 * group check and this insert are two statements, and `group/reset` can land
 * between them: without the guard the config row would be gone while the topic
 * row survived, and the NEXT group to be adopted would inherit a thread id
 * belonging to the group that was just abandoned — every wallet notification
 * addressed to a topic that does not exist there. Returns false when the guard
 * rejected the write, so the caller can say so instead of claiming success.
 */
export async function bindTopic(
  db: D1Database,
  p: {
    topicKey: TopicKey;
    messageThreadId: number | null;
    userId: string;
    telegramUserId: number;
    groupChatId: string;
  }
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO telegram_admin_topics
         (topic_key, message_thread_id, enabled, configured_by, configured_by_tg)
       SELECT ?1, ?2, 1, ?3, ?4
        WHERE EXISTS (
          SELECT 1 FROM telegram_admin_config
           WHERE id = 'singleton' AND group_chat_id = ?5
        )
       ON CONFLICT (topic_key) DO UPDATE SET
         message_thread_id = excluded.message_thread_id,
         enabled = 1,
         configured_by = excluded.configured_by,
         configured_by_tg = excluded.configured_by_tg,
         updated_at = ${NOW_SQL}`
    )
    .bind(p.topicKey, p.messageThreadId, p.userId, p.telegramUserId, p.groupChatId)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

// ------------------------------------------------------------ destinations

/**
 * Where one admin notification goes.
 *
 * `via` records HOW the destination was reached, because the three answers
 * are operationally different and a report that conflated them would hide a
 * missing binding behind a working fallback:
 *
 *   'topic'    the topic asked for is bound — the normal case.
 *   'fallback' that topic is NOT bound, but a SIBLING topic is and carried it
 *              (TOPIC_FALLBACK) — `topicKey` names the sibling that actually
 *              took it. Kept distinct from 'general' on purpose: a pre-order
 *              sitting in the `orders` topic is a WORKING deployment with one
 *              binding left to make, while the same pre-order in General is the
 *              mixed pile the owner is trying to get out of. Conflating them
 *              would make the `/topics` checklist look finished when it is not.
 *   'general'  neither the topic nor any sibling is bound, so GENERAL carried
 *              it (§9).
 *   'legacy'   no admin group is bound at all, so the pre-0080
 *              `TELEGRAM_ADMIN_CHAT_ID` chat carried it on the CUSTOMER bot.
 *              This is what keeps the platform working during the migration.
 */
export interface AdminDestination {
  bot: BotId;
  chatId: string;
  messageThreadId: number | null;
  topicKey: string;
  via: 'topic' | 'fallback' | 'general' | 'legacy';
}

/**
 * Why there is nowhere to send — never a silent drop (§9).
 *
 * Each value names a DIFFERENT repair, so they must not be interchangeable:
 *   'admin_bot_not_configured'  the admin bot has no token — upload the secret.
 *   'no_group_bound'            the bot works; nobody has run `/topic_here` yet.
 *   'not_configured'            the legacy chat is set but the CUSTOMER bot,
 *                               which carries it, has no token.
 * There is deliberately no `no_topic_and_no_general`: a bound group with no
 * topics still delivers, into its General topic, so that is never a miss.
 */
export type DestinationMiss =
  | 'admin_bot_not_configured'
  | 'no_group_bound'
  | 'not_configured';

export type DestinationResult =
  | { ok: true; destination: AdminDestination }
  | { ok: false; miss: DestinationMiss };

/**
 * Resolves the destination for a topic, with the ladder §9 specifies:
 * the topic → GENERAL → the legacy chat. A miss is RETURNED, never swallowed:
 * the caller logs it as a structured routing error and preserves the event.
 */
export async function resolveAdminDestination(env: Env, topicKey: TopicKey): Promise<DestinationResult> {
  const legacyChat = (env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  const adminBot = adminBotConfigured(env);
  // The miss is reported as the thing an operator would have to FIX. A missing
  // admin-bot token and an unbound group are one line apart in the code and a
  // different afternoon's work in the operator's hands, so they never share a
  // name: reporting the first as `no_group_bound` sends someone into Telegram
  // to run `/topic_here` in a group the bot cannot even read.
  const legacy = (): DestinationResult => {
    if (legacyChat && botConfigured(env, 'customer')) {
      return {
        ok: true,
        destination: { bot: 'customer', chatId: legacyChat, messageThreadId: null, topicKey: '', via: 'legacy' },
      };
    }
    if (legacyChat) return { ok: false, miss: 'not_configured' };
    return { ok: false, miss: adminBot ? 'no_group_bound' : 'admin_bot_not_configured' };
  };

  if (!adminBot) return legacy();
  const group = await readAdminGroup(env.DB);
  if (!group) return legacy();
  /**
   * THE BOT BOUNDARY, CHECKED AT THE READ AND NOT ONLY AT THE WRITE.
   *
   * Every destination this function hands back with `bot: 'admin'` is addressed
   * with `group.groupChatId`, so this one line is the whole platform's guarantee
   * that the admin bot's traffic — including the wallet messages that carry a
   * customer's payment-proof photo — goes to a GROUP and never into somebody's
   * private chat. `bindAdminGroup` already refuses to store a positive id, but a
   * row written before that check existed, or by a future writer that forgets
   * it, would otherwise be trusted here forever. A bad row now degrades to the
   * legacy chat (or to a reported miss) instead of DMing a person.
   */
  if (!isGroupChatId(group.groupChatId)) {
    console.error(
      JSON.stringify({
        event: 'telegram_admin_group_not_a_group',
        topic: topicKey,
        detail: 'the bound admin chat id is not a group id; refusing to send admin traffic to it',
      })
    );
    return legacy();
  }

  const topics = await readTopics(env.DB);
  const byKey = new Map(topics.filter((t) => t.enabled).map((t) => [t.topicKey, t]));
  const wanted = byKey.get(topicKey);
  if (wanted) {
    return {
      ok: true,
      destination: {
        bot: 'admin',
        chatId: group.groupChatId,
        messageThreadId: wanted.messageThreadId,
        topicKey,
        via: 'topic',
      },
    };
  }
  /**
   * THE SIBLING RUNG (TOPIC_FALLBACK). Tried before General, never instead of
   * it: if no sibling is bound either, the code below is reached unchanged and
   * an unbound key behaves exactly as it did before this rung existed.
   *
   * `topicKey` records the sibling that ACTUALLY took the message, not the one
   * that was asked for, because `tg_admin_notifications.topic_key` is the
   * routing audit — a row that claimed `orders_preorder` while the message sat
   * in the `orders` thread would make the one question that audit exists to
   * answer, "where did this go?", unanswerable.
   */
  for (const sibling of topicFallbackChain(topicKey)) {
    const alt = byKey.get(sibling);
    if (!alt) continue;
    return {
      ok: true,
      destination: {
        bot: 'admin',
        chatId: group.groupChatId,
        messageThreadId: alt.messageThreadId,
        topicKey: sibling,
        via: 'fallback',
      },
    };
  }
  const general = byKey.get('general');
  if (general) {
    return {
      ok: true,
      destination: {
        bot: 'admin',
        chatId: group.groupChatId,
        messageThreadId: general.messageThreadId,
        topicKey: 'general',
        via: 'general',
      },
    };
  }
  // The group is bound but NOTHING is: a bare group send would land in the
  // forum's General topic anyway, which is the honest place for it, so it is
  // offered as `general` with no thread rather than refused.
  return {
    ok: true,
    destination: { bot: 'admin', chatId: group.groupChatId, messageThreadId: null, topicKey: 'general', via: 'general' },
  };
}

/** The `message_thread_id` send field, omitted when there is no thread. */
export function threadExtra(messageThreadId: number | null): Record<string, unknown> {
  return messageThreadId === null ? {} : { message_thread_id: messageThreadId };
}

// ----------------------------------------------------------- the router

export type NotifyOutcome =
  | { ok: true; destination: AdminDestination; messageId: number }
  | { ok: false; reason: DestinationMiss | 'send_failed'; error?: string };

/**
 * ONE admin notification, routed by topic (§9).
 *
 * A routing miss is LOGGED as a structured error and returned — «Do not
 * silently discard it.» Callers that own a durable record of the event (the
 * wallet queue, for one) keep it and retry; callers that do not at least leave
 * a line that names the topic and the reason.
 */
export async function notifyAdminTopic(
  env: Env,
  topicKey: TopicKey,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<NotifyOutcome> {
  const resolved = await resolveAdminDestination(env, topicKey);
  if (!resolved.ok) {
    console.error(
      JSON.stringify({
        event: 'telegram_admin_routing_error',
        topic: topicKey,
        reason: resolved.miss,
        detail: 'no destination for this admin notification; the event was NOT delivered',
      })
    );
    return { ok: false, reason: resolved.miss };
  }
  const d = resolved.destination;
  const res: TgSendResult = await sendMessageToChat(
    env,
    d.chatId,
    text,
    { ...threadExtra(d.messageThreadId), ...extra },
    d.bot
  );
  if (!res.ok) {
    console.error(
      JSON.stringify({
        event: 'telegram_admin_send_failed',
        topic: topicKey,
        via: d.via,
        bot: d.bot,
        error: scrubTokens(env, res.error),
      })
    );
    return { ok: false, reason: 'send_failed', error: res.error };
  }
  return { ok: true, destination: d, messageId: res.message_id };
}

// -------------------------------------------------------------- audit glue

/**
 * One audit row for a Telegram-admin action, with the Telegram identity beside
 * the site identity.
 *
 * `actorId` is ALWAYS the site user id — `audit_log.actor_id` has no foreign
 * key, so a raw Telegram number written there would corrupt the trail with an
 * id that resolves to nobody. The Telegram id travels in `detail` where it
 * belongs, next to `source: 'telegram_admin'` (§17).
 */
export async function auditAdminBot(
  db: D1Database,
  actorId: string | null,
  action: string,
  target: string,
  telegramUserId: number | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await audit(db, actorId, action, target, {
    ...detail,
    source: 'telegram_admin',
    telegram_user_id: telegramUserId,
  });
}
