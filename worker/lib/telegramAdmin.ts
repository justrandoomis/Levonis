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
 */
export const TOPIC_KEYS = [
  'general',
  'review',
  'report',
  'merchant_verification',
  'wallet',
  'orders',
  'support',
] as const;
export type TopicKey = (typeof TOPIC_KEYS)[number];

const TOPIC_LABELS: Record<TopicKey, string> = {
  general: 'عام',
  review: 'التقييمات',
  report: 'البلاغات',
  merchant_verification: 'توثيق التجار',
  wallet: 'المحفظة',
  orders: 'الطلبات',
  support: 'الدعم',
};

export function topicLabel(key: string): string {
  return TOPIC_LABELS[key as TopicKey] ?? key;
}

export function isTopicKey(v: unknown): v is TopicKey {
  return typeof v === 'string' && (TOPIC_KEYS as readonly string[]).includes(v);
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
 */
export async function bindAdminGroup(
  db: D1Database,
  p: { chatId: string; title: string; userId: string; telegramUserId: number }
): Promise<{ ok: true; created: boolean } | { ok: false; existing: AdminGroup }> {
  const existing = await readAdminGroup(db);
  if (existing && existing.groupChatId !== p.chatId) return { ok: false, existing };
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
 *   'topic'   the topic asked for is bound — the normal case.
 *   'general' that topic is NOT bound, so GENERAL carried it (§9).
 *   'legacy'  no admin group is bound at all, so the pre-0080
 *             `TELEGRAM_ADMIN_CHAT_ID` chat carried it on the CUSTOMER bot.
 *             This is what keeps the platform working during the migration.
 */
export interface AdminDestination {
  bot: BotId;
  chatId: string;
  messageThreadId: number | null;
  topicKey: string;
  via: 'topic' | 'general' | 'legacy';
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
