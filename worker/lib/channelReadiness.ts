/**
 * CAN WE ACTUALLY REACH THIS PERSON? — one server-side answer, and the only
 * one any surface is allowed to render.
 *
 * WHAT WAS WRONG. `customerNotify.reachFor()` answered the ACCOUNT half of
 * that question — a verified address, an E.164 phone, a live `telegram_links`
 * row — and consulted the environment for NOTHING. `emailConfigured`,
 * `wasenderConfigured` and `TELEGRAM_BOT_TOKEN` were read only at SEND time,
 * inside `deliver()`, fifteen minutes later in a cron. So on a deployment with
 * no `EMAIL_API_KEY` the shop cheerfully enqueued an email row, `deliver()`
 * classified `EMAIL_NOT_CONFIGURED` as terminal, and the row was dead on its
 * first attempt and never retried. A dialog that said "we will email you" on
 * that deployment was lying, and the only record of the lie was a dead outbox
 * row nobody reads.
 *
 * READINESS IS THE **AND** OF BOTH HALVES. A channel is ready when the
 * DEPLOYMENT can carry it (`channelsLive`) and the ACCOUNT has somewhere for
 * it to land. Neither half alone is an answer, and an answer that is not both
 * is a promise the shop cannot keep.
 *
 * THE THIRD EMAIL CONDITION, which no global flag can carry.
 * `emailAllowsRecipient(env, to)` is PER RECIPIENT: with
 * `EMAIL_ALLOWLIST_REQUIRED=on` and an empty `EMAIL_ALLOWED_RECIPIENTS`,
 * NOBODY is mailable, and the outbox re-checks it at send time and silently
 * marks the row `skipped`. So email readiness takes the address as an input,
 * not a deployment boolean — readiness that ignores this lies on staging in
 * exactly the deployment that exists to catch lies.
 *
 * `can_activate` IS THE ACTIVATION ROUTE'S OWN PREDICATE, not optimism.
 * `POST /api/telegram/link/start` refuses unless `getBotUsername(env)` returns
 * a name, and that is a live `getMe` with a memory cache and an
 * `admin_settings` fallback that is EMPTY on a fresh deployment. Token set +
 * bot not answering = a sheet that renders "activate Telegram", a tap that
 * 503s, and a shopper who is stuck. So `can_activate` for Telegram is
 * "getBotUsername resolved" and for email it is `emailConfigured(env)` — the
 * same test the route runs. A channel that is neither ready nor activatable is
 * rendered as UNAVAILABLE, never as a button.
 *
 * WHATSAPP HAS NO ACTIVATION PATH OF ITS OWN. `users.phone_e164` is only ever
 * written after Telegram contact verification (migration 0013: "a phone typed
 * into a form is never stored here"). So a WhatsApp row blocked by
 * ACCOUNT_NO_DESTINATION is not a dead end — its action is `link_telegram`,
 * and it says so in the ACTION rather than in a sentence the client would have
 * to parse.
 *
 * 'inapp' IS A REAL CHANNEL AND IT IS THE FLOOR. `user_notifications` needs no
 * secret, no verification and no provider, the inbox already renders it with
 * an unread badge, and a signed-in user is by definition reachable there. It
 * is what makes the activation sheet an OFFER rather than a WALL, and it is
 * where a message goes when an outbound channel goes dark between arming and
 * firing. `any_outbound_ready` is therefore about telegram/whatsapp/email
 * ONLY — the floor must never be mistaken for an outbound success.
 *
 * PRIVACY. `publicUser` masks the phone on purpose: "a full number sitting in
 * a JSON response is a number that ends up in a log, a screenshot or a support
 * ticket". `destination_masked` inherits that rule on EVERY channel — masked
 * or null, never the real address, number or chat id.
 *
 * WHY THIS MODULE HOLDS THE WHATSAPP SESSION CACHE. WasenderAPI drives a real
 * WhatsApp account: the API key stays valid while the shop's phone is logged
 * out, and only `wasenderStatus()` can tell the difference. That is a live GET
 * with a 10s budget and it MUST NEVER sit on a shopper's request, so what a
 * send already learned is cached in `admin_settings` and read from there.
 *
 * IMPORT DIRECTION (deliberate, and load-bearing). This module imports the
 * transports and NOTHING of `outbox.ts` or `customerNotify.ts`, so `outbox.ts`
 * can feed an outage in from its failure path without closing an import cycle.
 * It also means the per-user query below is its own: `reachFor` answers WHO a
 * message goes to, this answers WHY it cannot go — an unverified address, a
 * placeholder address and no address at all are one `null` there and three
 * different sentences here.
 */

import type { Env } from './types';
import { emailConfigured, emailAllowsRecipient } from './emailSend';
import { isPlaceholderEmail } from './profileCompletion';
import { maskPhone } from './phone';
import { getBotUsername, telegramCanDeliver } from './telegram';
import { isE164, wasenderConfigured } from './wasender';

export type ChannelId = 'inapp' | 'telegram' | 'whatsapp' | 'email';

export type ChannelBlocker =
  /** The deployment has no secret for this channel. Nothing the user does helps. */
  | 'DEPLOYMENT_NOT_CONFIGURED'
  /** Configured but not delivering right now — the shop's WhatsApp phone is logged out. */
  | 'DEPLOYMENT_OUTAGE'
  /** This exact recipient is refused: the bot was blocked, or the staging allowlist excludes them. */
  | 'RECIPIENT_BLOCKED'
  /** The account has nothing for this channel to land on. */
  | 'ACCOUNT_NO_DESTINATION'
  /** There is an address, but nobody has proved it belongs to this person. */
  | 'ACCOUNT_NOT_VERIFIED'
  /** `tg-<id>@telegram.local` — a Telegram-signup placeholder, not a mailbox. */
  | 'ACCOUNT_PLACEHOLDER_EMAIL';

export interface ChannelState {
  channel: ChannelId;
  ready: boolean;
  blocker: ChannelBlocker | null;
  /** MASKED or null. Never the address, the number or the chat id (see PRIVACY above). */
  destination_masked: string | null;
  /** Would the activation route actually succeed if tapped right now? */
  can_activate: boolean;
  action: { kind: 'link_telegram' | 'verify_email'; href: string } | null;
}

export interface ChannelReadiness {
  channels: ChannelState[];
  /** telegram/whatsapp/email only — 'inapp' is the floor, not an outbound win. */
  any_outbound_ready: boolean;
  /** What a confirmation sentence names. NEVER null: the floor is 'inapp'. */
  recommended: ChannelId;
  /** What the user CHOSE, '' when they never chose. Not what is ready. */
  primary_channel: ChannelId | '';
  /** Where a message actually goes: every ready channel, or ready ∩ chosen. */
  delivery: ChannelId[];
}

/** Where the client sends somebody to fix each blocker. Paths, never absolute
 *  URLs — a stored origin is a stored mistake the day the domain changes.
 *  `#settings-linking` is the real anchor on the Settings page; the email
 *  verification card has none, so email points at the page rather than at an
 *  invented anchor that would scroll nowhere. */
const HREF_LINK_TELEGRAM = '/settings#settings-linking';
const HREF_VERIFY_EMAIL = '/settings';

// --------------------------------------------- the WhatsApp session cache

/** Raw `admin_settings` row, like `telegramBotUsername` — deliberately not a
 *  typed SETTING_DEFAULTS entry: this is a cached OBSERVATION, not an operator
 *  setting, and nothing should offer it in a settings form. */
const SESSION_SETTING_KEY = 'whatsappSessionState';

/**
 * How long a recorded outage stays EVIDENCE. The sweep cron fires every 15
 * minutes, so one missed tick is normal and two is a slow night; at three the
 * record is no longer telling us anything about now. Sized against that
 * fifteen-minute period rather than the 10-second provider budget, which is a
 * different number about a different thing.
 */
const SESSION_OUTAGE_TTL_MS = 45 * 60 * 1000;

/** Per-isolate read cache, so a page that asks readiness twice costs one read. */
const SESSION_READ_TTL_MS = 60 * 1000;

/**
 * One write per state per five minutes in this isolate. `processOutbox` runs
 * up to 25 rows a tick and every failing WhatsApp row would otherwise upsert
 * the same key — 25 writes that all say the same thing.
 *
 * A debounce rather than a once-ever flag ON PURPOSE: the record has to stay
 * FRESH while the outage lasts. An isolate that wrote once and never again
 * would let its own record go stale under the TTL above and quietly
 * re-advertise WhatsApp as live while the phone is still logged out.
 */
const SESSION_WRITE_DEBOUNCE_MS = 5 * 60 * 1000;

export interface SessionStateRecord {
  /** Last thing an actual send (or probe) proved about the shop's WhatsApp session. */
  connected: boolean;
  /** `SESSION_NOT_CONNECTED`, `UNAUTHORIZED`, … — '' when connected. */
  reason: string;
  /** ISO 8601, when it was observed. */
  at: string;
}

let sessionRead: { value: SessionStateRecord | null; at: number } | null = null;
let sessionWrite: { key: string; at: number } | null = null;

function parseSessionRecord(raw: string): SessionStateRecord | null {
  try {
    const p = JSON.parse(raw) as Partial<SessionStateRecord> | null;
    if (!p || typeof p !== 'object' || typeof p.at !== 'string') return null;
    return { connected: p.connected === true, reason: String(p.reason ?? ''), at: p.at };
  } catch {
    return null;
  }
}

/**
 * The last thing anything learned about the shop's WhatsApp session, from the
 * cache — NEVER a live probe. `wasenderStatus()` is a GET with a 10-second
 * budget against a third party; putting it on a shopper's request would put a
 * third party's outage on the critical path of a page that has nothing to do
 * with WhatsApp.
 *
 * Returns null when nothing has ever been recorded, which is "unknown", not
 * "broken": a deployment that has simply not sent a WhatsApp message yet must
 * not be shown as down.
 */
export async function cachedSessionState(env: Env): Promise<SessionStateRecord | null> {
  if (sessionRead && Date.now() - sessionRead.at < SESSION_READ_TTL_MS) return sessionRead.value;
  try {
    const row = await env.DB.prepare('SELECT value FROM admin_settings WHERE key = ?')
      .bind(SESSION_SETTING_KEY)
      .first<{ value: string }>();
    const value = row ? parseSessionRecord(row.value) : null;
    sessionRead = { value, at: Date.now() };
    return value;
  } catch {
    // A readiness answer must not fail because a settings read did. Unknown.
    sessionRead = { value: null, at: Date.now() };
    return null;
  }
}

async function writeSessionState(env: Env, rec: SessionStateRecord, dedupeKey: string): Promise<void> {
  if (sessionWrite && sessionWrite.key === dedupeKey && Date.now() - sessionWrite.at < SESSION_WRITE_DEBOUNCE_MS) {
    return;
  }
  sessionWrite = { key: dedupeKey, at: Date.now() };
  sessionRead = { value: rec, at: Date.now() };
  try {
    // The exact pattern getBotUsername already uses for its own cached
    // observation — one row, last writer wins, no migration needed.
    await env.DB.prepare(
      'INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
      .bind(SESSION_SETTING_KEY, JSON.stringify(rec))
      .run();
  } catch (e) {
    // Never throws upward: this is bookkeeping beside a delivery attempt that
    // has already happened, and losing the note must not undo the outcome.
    console.error('whatsapp session state write failed', e instanceof Error ? e.message : e);
  }
}

/**
 * Record that WhatsApp is configured but NOT delivering — called from the
 * outbox's WhatsApp failure path, which is the only place in the system that
 * gets told so by the provider for free.
 */
export async function recordSessionOutage(env: Env, reason: string): Promise<void> {
  const clean = String(reason || 'UNKNOWN').slice(0, 120);
  await writeSessionState(env, { connected: false, reason: clean, at: new Date().toISOString() }, `outage:${clean}`);
}

/**
 * Clear the outage. Called on the first SUCCESSFUL WhatsApp send rather than
 * on the next probe: a message the shop's phone actually sent is stronger
 * evidence than a status endpoint, it is free, and waiting up to fifteen
 * minutes for a cron to notice would keep WhatsApp hidden from every shopper
 * in the meantime.
 */
export async function clearSessionOutage(env: Env): Promise<void> {
  if (sessionRead && sessionRead.value?.connected === true && Date.now() - sessionRead.at < SESSION_READ_TTL_MS) {
    return; // already known good in this isolate — nothing to say
  }
  await writeSessionState(env, { connected: true, reason: '', at: new Date().toISOString() }, 'ok');
}

// -------------------------------------------------------- deployment half

export interface LiveChannels {
  /** Always true. An in-app row needs no secret, no provider and no verification. */
  inapp: true;
  telegram: boolean;
  whatsapp: boolean;
  email: boolean;
  /** Why WhatsApp is dark while configured — '' when it is not dark. */
  whatsapp_outage: string;
}

/**
 * CAN THIS DEPLOYMENT CARRY EACH CHANNEL AT ALL — the half `reachFor` never
 * asked. Every caller that is about to promise a customer something must ask
 * this BEFORE the promise, not fifteen minutes later inside `deliver()`.
 *
 * Email is the deployment flag only; the per-recipient allowlist cannot be
 * answered without an address and is applied where one exists.
 */
export async function channelsLive(env: Env): Promise<LiveChannels> {
  const waConfigured = wasenderConfigured(env);
  let outage = '';
  if (waConfigured) {
    const rec = await cachedSessionState(env);
    // A stale record is not evidence — see SESSION_OUTAGE_TTL_MS.
    if (rec && !rec.connected && Date.now() - Date.parse(rec.at) < SESSION_OUTAGE_TTL_MS) {
      outage = rec.reason || 'SESSION_NOT_CONNECTED';
    }
  }
  return {
    inapp: true,
    telegram: telegramCanDeliver(env),
    whatsapp: waConfigured && !outage,
    email: emailConfigured(env),
    whatsapp_outage: outage,
  };
}

// ------------------------------------------------------------- the answer

interface ReadinessRow {
  id: string;
  email: string | null;
  email_verified_at: string | null;
  phone_e164: string | null;
  chat_id: number | null;
  link_phone: string | null;
  link_revoked_at: string | null;
}

interface PrefRow {
  channel: string;
  enabled: number;
  is_primary: number;
}

const CHANNEL_IDS: readonly ChannelId[] = ['inapp', 'telegram', 'whatsapp', 'email'];

function isChannelId(v: unknown): v is ChannelId {
  return typeof v === 'string' && (CHANNEL_IDS as readonly string[]).includes(v);
}

/** `a***@example.com` — enough to recognise the mailbox, not enough to BE one.
 *  Written here rather than imported because the existing copy lives inside
 *  `routes/auth.ts` as a private helper of that route file. */
function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}${address.slice(at)}`;
}

/**
 * The whole answer for one user.
 *
 * Two reads, never more: the account row with its Telegram link, and the
 * user's channel choices. `getBotUsername()` (a live getMe behind two caches)
 * is consulted ONLY when something would actually be rendered as activatable —
 * a fully-reachable user costs no subrequest.
 */
export async function channelReadiness(env: Env, userId: string): Promise<ChannelReadiness> {
  const live = await channelsLive(env);

  const row = await env.DB.prepare(
    // telegram_links.user_id is the PRIMARY KEY, so this LEFT JOIN cannot fan
    // out. The revoked row is joined too, deliberately: "never linked" and
    // "linked, then the bot was blocked" are different sentences, and the
    // second one is the whole point of writing revoked_at at all.
    `SELECT u.id, u.email, u.email_verified_at, u.phone_e164,
            l.chat_id, l.phone_e164 AS link_phone, l.revoked_at AS link_revoked_at
       FROM users u
       LEFT JOIN telegram_links l ON l.user_id = u.id
      WHERE u.id = ?`
  )
    .bind(userId)
    .first<ReadinessRow>()
    .catch(() => null);

  const prefs = await env.DB.prepare(
    'SELECT channel, enabled, is_primary FROM user_notification_channels WHERE user_id = ?'
  )
    .bind(userId)
    .all<PrefRow>()
    // The table arrives with migration 0092. Missing it means "this user has
    // chosen nothing", which is exactly the pre-migration truth — a readiness
    // answer must not 500 because a migration has not run yet.
    .catch(() => ({ results: [] as PrefRow[] }));

  const prefRows = (prefs.results ?? []).filter((p) => isChannelId(p.channel));
  const chosen = new Set<ChannelId>(
    prefRows.filter((p) => p.enabled === 1).map((p) => p.channel as ChannelId)
  );
  const disabled = new Set<ChannelId>(
    prefRows.filter((p) => p.enabled !== 1).map((p) => p.channel as ChannelId)
  );
  const primaryRow = prefRows.find((p) => p.is_primary === 1 && p.enabled === 1);
  const primary_channel: ChannelId | '' = primaryRow ? (primaryRow.channel as ChannelId) : '';

  // getBotUsername is the activation predicate for BOTH Telegram and WhatsApp
  // (the only road to a phone number runs through Telegram contact
  // verification), so it is resolved at most once, and only when a blocked
  // channel might otherwise be drawn as a button.
  let botName: string | null | undefined;
  const botResolved = async (): Promise<boolean> => {
    if (botName === undefined) botName = live.telegram ? await getBotUsername(env).catch(() => null) : null;
    return !!botName;
  };

  const channels: ChannelState[] = [];

  // ---- inapp: the floor. A signed-in account IS the destination, so the only
  // way this is not ready is that the account itself is gone.
  const inappReady = !!row;
  channels.push({
    channel: 'inapp',
    ready: inappReady,
    blocker: inappReady ? null : 'ACCOUNT_NO_DESTINATION',
    destination_masked: null,
    can_activate: false, // nothing to activate: it is on for every account
    action: null,
  });

  // ---- telegram
  {
    const linked = !!row?.chat_id && !row.link_revoked_at;
    const revoked = !!row?.chat_id && !!row.link_revoked_at;
    const masked = row?.link_phone && linked ? maskPhone(row.link_phone) : null;
    let blocker: ChannelBlocker | null = null;
    let can_activate = false;
    let action: ChannelState['action'] = null;
    if (!live.telegram) {
      blocker = 'DEPLOYMENT_NOT_CONFIGURED';
    } else if (!linked) {
      // A revoked link is a recipient who blocked the bot — a different fact
      // from never having linked, and it must not be silently re-promised.
      blocker = revoked ? 'RECIPIENT_BLOCKED' : 'ACCOUNT_NO_DESTINATION';
      can_activate = await botResolved();
      if (can_activate) action = { kind: 'link_telegram', href: HREF_LINK_TELEGRAM };
    }
    channels.push({
      channel: 'telegram',
      ready: live.telegram && linked,
      blocker,
      destination_masked: masked,
      can_activate,
      action,
    });
  }

  // ---- whatsapp
  {
    const phone = row && isE164(row.phone_e164) ? row.phone_e164 : null;
    let blocker: ChannelBlocker | null = null;
    let can_activate = false;
    let action: ChannelState['action'] = null;
    if (!wasenderConfigured(env)) {
      blocker = 'DEPLOYMENT_NOT_CONFIGURED';
    } else if (live.whatsapp_outage) {
      // Configured, key valid, phone logged out. An operator fixes this; the
      // shopper cannot, so no button.
      blocker = 'DEPLOYMENT_OUTAGE';
    } else if (!phone) {
      blocker = 'ACCOUNT_NO_DESTINATION';
      // WhatsApp has NO activation path of its own: phone_e164 is only ever
      // written after Telegram contact verification. The tap therefore leads
      // to Telegram linking, and saying so in the action is the difference
      // between an offer and a dead end.
      can_activate = await botResolved();
      if (can_activate) action = { kind: 'link_telegram', href: HREF_LINK_TELEGRAM };
    }
    channels.push({
      channel: 'whatsapp',
      ready: live.whatsapp && !!phone,
      blocker,
      destination_masked: phone ? maskPhone(phone) : null,
      can_activate,
      action,
    });
  }

  // ---- email
  {
    const raw = (row?.email || '').trim();
    const placeholder = isPlaceholderEmail(raw);
    const real = raw.length > 0 && !placeholder;
    const verified = real && !!row?.email_verified_at;
    // The per-recipient staging guard. Without this the readiness answer is
    // wrong on exactly the deployment that exists to stop a wrong answer.
    const allowed = real ? emailAllowsRecipient(env, raw) : true;

    let blocker: ChannelBlocker | null = null;
    if (!live.email) blocker = 'DEPLOYMENT_NOT_CONFIGURED';
    else if (!raw) blocker = 'ACCOUNT_NO_DESTINATION';
    else if (placeholder) blocker = 'ACCOUNT_PLACEHOLDER_EMAIL';
    else if (!allowed) blocker = 'RECIPIENT_BLOCKED';
    else if (!verified) blocker = 'ACCOUNT_NOT_VERIFIED';

    // The verification mail goes through the same provider and the same
    // allowlist as any other mail, so an address the guard refuses cannot be
    // verified either — offering the button would 503 the same way Telegram's
    // does without a bot username.
    const can_activate = live.email && (real ? allowed : true);
    const action: ChannelState['action'] =
      can_activate && !verified ? { kind: 'verify_email', href: HREF_VERIFY_EMAIL } : null;

    channels.push({
      channel: 'email',
      ready: live.email && verified && allowed,
      blocker,
      destination_masked: real ? maskEmail(raw) : null,
      can_activate,
      action,
    });
  }

  const readyIds = channels.filter((c) => c.ready).map((c) => c.channel);
  const any_outbound_ready = readyIds.some((c) => c !== 'inapp');

  /**
   * DELIVERY IS WHAT A MESSAGE ACTUALLY REACHES, and the default is not a
   * narrowing. A customer with three live channels gets all three — that is
   * `notifyCustomer`'s deliberate behaviour ("this is transaction mail, not
   * marketing, and the whole complaint that produced that module was not
   * hearing about it") and it must not quietly change for accounts that never
   * opened a preferences screen. Once somebody HAS chosen, the choice wins,
   * intersected with what is ready — a chosen channel that is dark delivers
   * nothing, and pretending otherwise is the original lie in a new place.
   */
  const delivery = chosen.size > 0 ? readyIds.filter((c) => chosen.has(c)) : readyIds.slice();
  // The floor holds unless it was switched off explicitly: whatever else
  // happens, the message is in their inbox to find.
  if (inappReady && !delivery.includes('inapp') && !disabled.has('inapp')) delivery.unshift('inapp');

  /**
   * RECOMMENDED is what a confirmation sentence names, so it is never null.
   * Their own choice first when it can actually deliver; then the fastest
   * ready outbound (Telegram and WhatsApp are push notifications on a lock
   * screen, email is a mailbox they may open tomorrow); then the floor.
   */
  const order: ChannelId[] = ['telegram', 'whatsapp', 'email'];
  const recommended: ChannelId =
    primary_channel && readyIds.includes(primary_channel)
      ? primary_channel
      : (order.find((c) => readyIds.includes(c) && (chosen.size === 0 || chosen.has(c))) ??
        order.find((c) => readyIds.includes(c)) ??
        'inapp');

  return { channels, any_outbound_ready, recommended, primary_channel, delivery };
}

/**
 * Make `channel` the user's primary, as statements for one `db.batch`.
 *
 * WRITTEN ONLY ON EXPLICIT ACTIVATION, NEVER AS A SIDE EFFECT OF A
 * VERIFICATION STAMP. `email_verified_at` is stamped in six places including
 * the first Google sign-in; hooking a primary-channel write to it would make
 * every Google user email-primary before they had ever opened a product page,
 * and they would never know why their alerts stopped arriving on Telegram.
 * Verification changes what is READY. It must not change what was CHOSEN.
 *
 * Primary implies enabled — a channel cannot be the one we prefer and also
 * switched off — and the demotion runs first so the pair is never both-primary
 * mid-batch.
 */
export function setPrimaryChannelStatements(
  db: D1Database,
  userId: string,
  channel: ChannelId
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE user_notification_channels
            SET is_primary = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE user_id = ? AND channel <> ? AND is_primary = 1`
      )
      .bind(userId, channel),
    db
      .prepare(
        `INSERT INTO user_notification_channels (user_id, channel, enabled, is_primary, updated_at)
         VALUES (?, ?, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(user_id, channel) DO UPDATE SET
           enabled = 1,
           is_primary = 1,
           updated_at = excluded.updated_at`
      )
      .bind(userId, channel),
  ];
}
