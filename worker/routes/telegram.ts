import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import {
  requireAuth,
  requireAdmin,
  badRequest,
  forbidden,
  conflict,
  unavailable,
  str,
  oneOf,
} from '../lib/http';
import { sha256Hex, randomToken, timingSafeEqual } from '../lib/crypto';
import { normalizePhone, phonesMatch, maskPhone } from '../lib/phone';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import {
  getBotUsername,
  sendToChat,
  verifyOtp,
  OTP_PURPOSES,
  type OtpPurpose,
} from '../lib/telegram';

/**
 * Telegram phone-ownership linking, OTP verification and the secured
 * webhook (final-phase §2).
 *
 * Design notes:
 * - The deep-link start payload is an opaque 32-byte random nonce
 *   (base64url, 43 chars — inside Telegram's documented 64-char limit).
 *   Only its SHA-256 digest is stored (link_challenges.id); the raw nonce
 *   exists in the customer's URL alone. A leaked nonce can NEVER sign
 *   anyone in or change an account: finalization requires the ORIGINATING
 *   authenticated browser session (user + session_ref match) via
 *   /link/confirm, and Telegram-side verification additionally requires
 *   the sender to share their OWN contact whose number equals the number
 *   typed on the site (full E.164 equality).
 * - Webhook authenticity: X-Telegram-Bot-Api-Secret-Token must equal
 *   TELEGRAM_WEBHOOK_SECRET (timing-safe compare). Updates are
 *   deduplicated through the telegram_updates UNIQUE insert — a redelivery
 *   is acknowledged 200 and ignored, keeping side effects idempotent.
 * - No getUpdates polling anywhere; the webhook is the only intake.
 * - OTP send/verify helpers live in worker/lib/telegram.ts (sendOtp /
 *   verifyOtp) so auth/recovery flows can call them without importing this
 *   route module. The authenticated /otp/verify endpoint below only
 *   consumes a challenge; the calling flow performs its own state
 *   transition on success.
 */

export const telegramRoutes = new Hono<AppContext>();

const LINK_TTL_MINUTES = 15;
const nowIso = () => new Date().toISOString();

// ------------------------------------------------------- trilingual texts
// The bot cannot know the site language of the person in the chat, so bot
// messages carry Arabic + English + Sorani together.

const TXT_CONTACT_PROMPT =
  'LEVONIS\n' +
  'للتحقق من ملكية رقم هاتفك، اضغط زر «مشاركة رقم هاتفي» بالأسفل. نستخدم الرقم فقط لمطابقته مع الرقم الذي أدخلته في الموقع.\n\n' +
  "To verify that you own your phone number, tap the 'Share my phone number' button below. We only use it to match the number you entered on the website.\n\n" +
  'بۆ پشتڕاستکردنەوەی خاوەندارێتی ژمارەی تەلەفۆنەکەت، دوگمەی «هاوبەشکردنی ژمارەی تەلەفۆنم» لە خوارەوە دابگرە. تەنها بۆ بەراوردکردن لەگەڵ ئەو ژمارەیە بەکاردەهێنرێت کە لە ماڵپەڕەکە نووسیوتە.';

const TXT_UNKNOWN_START =
  'LEVONIS\n' +
  'هذا الرابط غير صالح أو انتهت صلاحيته. ابدأ عملية الربط من جديد من موقع LEVONIS.\n' +
  'This link is invalid or has expired. Please start the linking process again from the LEVONIS website.\n' +
  'ئەم بەستەرە نادروستە یان بەسەرچووە. تکایە دووبارە لە ماڵپەڕی LEVONISەوە دەستپێبکەرەوە.';

const TXT_NO_ACTIVE_REQUEST =
  'LEVONIS\n' +
  'لا يوجد طلب ربط نشط لهذه المحادثة. ابدأ من موقع LEVONIS.\n' +
  'There is no active linking request for this chat. Please start from the LEVONIS website.\n' +
  'هیچ داواکارییەکی چالاکی بەستنەوە نییە بۆ ئەم گفتوگۆیە. تکایە لە ماڵپەڕی LEVONISەوە دەستپێبکە.';

const TXT_FORWARDED_REJECTED =
  'LEVONIS\n' +
  'لا نقبل جهات اتصال معاد توجيهها. اضغط زر «مشاركة رقم هاتفي» لمشاركة رقمك أنت.\n' +
  "Forwarded contacts are not accepted. Tap the 'Share my phone number' button to share your own number.\n" +
  'کۆنتاکتی ڕەوانەکراو قبوڵ ناکرێت. دوگمەی «هاوبەشکردنی ژمارەی تەلەفۆنم» دابگرە بۆ ناردنی ژمارەی خۆت.';

const TXT_NOT_OWN_CONTACT =
  'LEVONIS\n' +
  'جهة الاتصال المُرسلة لا تعود لحسابك في تيليغرام. اضغط زر «مشاركة رقم هاتفي» لمشاركة رقمك أنت.\n' +
  "The shared contact does not belong to your Telegram account. Tap the 'Share my phone number' button to share your own number.\n" +
  'ئەو کۆنتاکتە هی هەژماری تەلەگرامی تۆ نییە. دوگمەی «هاوبەشکردنی ژمارەی تەلەفۆنم» دابگرە.';

const TXT_PHONE_MISMATCH =
  'LEVONIS\n' +
  'الرقم الذي شاركتَه لا يطابق الرقم المُدخل في الموقع. ارجع إلى الموقع وتأكد من الرقم ثم ابدأ من جديد.\n' +
  'The number you shared does not match the number entered on the website. Return to the site, check the number, and start again.\n' +
  'ئەو ژمارەیەی هاوبەشت کرد لەگەڵ ژمارەی ماڵپەڕەکە یەک ناگرێتەوە. بگەڕێوە بۆ ماڵپەڕەکە و ژمارەکە بپشکنە و دووبارە دەستپێبکەرەوە.';

const TXT_PHONE_VERIFIED =
  'LEVONIS ✅\n' +
  'تم التحقق من رقم هاتفك بنجاح. ارجع إلى موقع LEVONIS لإكمال الربط من نفس المتصفح الذي بدأت منه.\n' +
  'Your phone number is verified. Return to the LEVONIS website to finish linking from the same browser you started in.\n' +
  'ژمارەی تەلەفۆنەکەت پشتڕاستکرایەوە. بگەڕێوە بۆ ماڵپەڕی LEVONIS بۆ تەواوکردنی بەستنەوەکە لە هەمان وێبگەڕەوە.';

const TXT_LINKED_DONE =
  'LEVONIS ✅\n' +
  'تم ربط حسابك في تيليغرام بحساب LEVONIS بنجاح.\n' +
  'Your Telegram account is now linked to your LEVONIS account.\n' +
  'هەژماری تەلەگرامەکەت بە هەژماری LEVONISەوە بەسترایەوە.';

const CONTACT_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📱 مشاركة رقم هاتفي / Share my phone number', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};
const REMOVE_KEYBOARD = { reply_markup: { remove_keyboard: true } };

// ------------------------------------------------------------ link start

telegramRoutes.post('/link/start', requireAuth, async (c) => {
  await rateLimit(c, 'tg-link-start', 6, 600);
  const user = c.get('user')!;
  const sessionId = c.get('sessionId')!;
  const body = await c.req.json().catch(() => ({}));

  const raw = str(body.phone, 'phone', { min: 7, max: 20 });
  const phone = normalizePhone(raw);
  if (!phone) {
    throw badRequest(
      'رقم الهاتف غير صالح — أدخل رقم موبايل عراقي مثل 07XXXXXXXXX / Invalid phone number — enter an Iraqi mobile number like 07XXXXXXXXX',
      'INVALID_PHONE'
    );
  }

  if (!c.env.TELEGRAM_BOT_TOKEN) {
    throw unavailable('Telegram linking is not configured yet (TELEGRAM_BOT_TOKEN is unset)');
  }
  const botUsername = await getBotUsername(c.env);
  if (!botUsername) {
    throw unavailable('Telegram is unreachable right now — please try again later', 'TELEGRAM_UNAVAILABLE');
  }

  // Opaque high-entropy nonce; 32 bytes → 43 base64url chars (Telegram's
  // documented start payload limit is 64). Only the digest is stored.
  const nonce = randomToken(32);
  const challengeId = await sha256Hex(nonce);
  const expiresAt = new Date(Date.now() + LINK_TTL_MINUTES * 60_000).toISOString();

  await c.env.DB.batch([
    // One active challenge per user+purpose: retire earlier attempts so a
    // stale deep link cannot race a newer one.
    c.env.DB.prepare(
      `UPDATE link_challenges SET state = 'expired', consumed_at = ?
        WHERE user_id = ? AND purpose = 'link' AND consumed_at IS NULL`
    ).bind(nowIso(), user.id),
    c.env.DB.prepare(
      `INSERT INTO link_challenges (id, purpose, user_id, session_ref, phone_entered, state, expires_at)
       VALUES (?, 'link', ?, ?, ?, 'pending', ?)`
    ).bind(challengeId, user.id, sessionId, phone, expiresAt),
  ]);

  return c.json({
    success: true,
    deep_link: `https://t.me/${botUsername}?start=${nonce}`,
    bot_username: botUsername,
    expires_at: expiresAt,
    phone_masked: maskPhone(phone),
  });
});

// ----------------------------------------------------------- link status

telegramRoutes.get('/link/status', requireAuth, async (c) => {
  await rateLimit(c, 'tg-link-status', 60, 60);
  const user = c.get('user')!;
  const sessionId = c.get('sessionId')!;

  const link = await c.env.DB.prepare(
    'SELECT phone_e164, verified_at FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL'
  )
    .bind(user.id)
    .first<{ phone_e164: string; verified_at: string }>();

  // Only the ORIGINATING session sees its own challenge (session_ref match).
  const ch = await c.env.DB.prepare(
    `SELECT state, expires_at, consumed_at, phone_entered FROM link_challenges
      WHERE user_id = ? AND purpose = 'link' AND session_ref = ?
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(user.id, sessionId)
    .first<{ state: string; expires_at: string; consumed_at: string | null; phone_entered: string }>();

  let challenge: { state: string; expires_at: string; phone_masked: string } | null = null;
  if (ch) {
    let state = ch.state;
    if (state !== 'linked' && new Date(ch.expires_at).getTime() <= Date.now()) state = 'expired';
    else if (ch.consumed_at && state !== 'linked') state = 'expired';
    challenge = { state, expires_at: ch.expires_at, phone_masked: maskPhone(ch.phone_entered) };
  }

  return c.json({
    success: true,
    linked: !!link,
    phone_masked: link ? maskPhone(link.phone_e164) : null,
    verified_at: link?.verified_at ?? null,
    challenge,
  });
});

// ---------------------------------------------------------- link confirm

telegramRoutes.post('/link/confirm', requireAuth, async (c) => {
  await rateLimit(c, 'tg-link-confirm', 10, 600);
  const user = c.get('user')!;
  const sessionId = c.get('sessionId')!;

  const ch = await c.env.DB.prepare(
    `SELECT id, state, expires_at, phone_entered, telegram_user_id, chat_id FROM link_challenges
      WHERE user_id = ? AND purpose = 'link' AND session_ref = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(user.id, sessionId)
    .first<{
      id: string;
      state: string;
      expires_at: string;
      phone_entered: string;
      telegram_user_id: number | null;
      chat_id: number | null;
    }>();

  if (!ch) throw badRequest('No linking request found for this session — start again', 'NO_CHALLENGE');
  if (new Date(ch.expires_at).getTime() <= Date.now()) {
    throw badRequest('The linking request has expired — start again', 'CHALLENGE_EXPIRED');
  }
  if (ch.state !== 'phone_verified' || ch.telegram_user_id === null || ch.chat_id === null) {
    throw badRequest('Phone ownership is not verified yet — finish the steps in Telegram first', 'NOT_VERIFIED');
  }

  const now = nowIso();
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      // The link is written only if the challenge is still verified,
      // unconsumed and unexpired at commit time (the batch is one
      // transaction — no check-then-write race).
      c.env.DB.prepare(
        `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
         SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM link_challenges
             WHERE id = ?6 AND consumed_at IS NULL AND state = 'phone_verified' AND expires_at > ?5
          )
         ON CONFLICT(user_id) DO UPDATE SET
           telegram_user_id = excluded.telegram_user_id,
           chat_id = excluded.chat_id,
           phone_e164 = excluded.phone_e164,
           verified_at = excluded.verified_at,
           revoked_at = NULL`
      ).bind(user.id, ch.telegram_user_id, ch.chat_id, ch.phone_entered, now, ch.id),
      // Single-use consumption (conditional — concurrent confirms cannot
      // both transition).
      c.env.DB.prepare(
        `UPDATE link_challenges SET consumed_at = ?, state = 'linked'
          WHERE id = ? AND consumed_at IS NULL AND state = 'phone_verified'`
      ).bind(now, ch.id),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('telegram_user_id')) {
      // NEVER auto-merge accounts: a Telegram account bound elsewhere stays
      // where it is until support resolves ownership.
      throw conflict(
        'هذا الحساب في تيليغرام مرتبط بحساب LEVONIS آخر. تواصل مع الدعم لحل ملكية الحساب. / ' +
          'This Telegram account is already linked to a different LEVONIS account. Please contact LEVONIS support to resolve account ownership.'
      );
    }
    throw e;
  }

  const consumed = results[1]?.meta?.changes === 1;
  if (!consumed) {
    // Concurrent confirm already finished — succeed only if the link really
    // exists for this user now (idempotent double-tap), otherwise be honest.
    const link = await c.env.DB.prepare(
      'SELECT phone_e164, verified_at FROM telegram_links WHERE user_id = ? AND telegram_user_id = ? AND revoked_at IS NULL'
    )
      .bind(user.id, ch.telegram_user_id)
      .first<{ phone_e164: string; verified_at: string }>();
    if (!link) throw badRequest('The linking request is no longer valid — start again', 'CHALLENGE_CONSUMED');
    return c.json({ success: true, linked: true, phone_masked: maskPhone(link.phone_e164), verified_at: link.verified_at });
  }

  await audit(c.env.DB, user.id, 'telegram.link_confirmed', `user:${user.id}`, {
    phone_masked: maskPhone(ch.phone_entered),
    telegram_user_id: ch.telegram_user_id,
  });
  c.executionCtx.waitUntil(sendToChat(c.env, ch.chat_id, TXT_LINKED_DONE, REMOVE_KEYBOARD).then(() => undefined));

  return c.json({ success: true, linked: true, phone_masked: maskPhone(ch.phone_entered), verified_at: now });
});

// ------------------------------------------------------------ OTP verify

/**
 * Consumes an OTP for the SIGNED-IN user. Anonymous flows (login/reset)
 * must call lib/telegram.verifyOtp inside their own route so consumption
 * and the authorized transition stay together.
 */
telegramRoutes.post('/otp/verify', requireAuth, async (c) => {
  await rateLimit(c, 'tg-otp-verify', 10, 300);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const purpose = oneOf(body.purpose, 'purpose', OTP_PURPOSES) as OtpPurpose;
  const code = str(body.code, 'code', { min: 1, max: 12 });

  const result = await verifyOtp(c.env, user.id, purpose, code);
  if (!result.ok) {
    switch (result.reason) {
      case 'no_challenge':
        throw badRequest('No active code — request a new one', 'OTP_NOT_FOUND');
      case 'expired':
        throw badRequest('The code has expired — request a new one', 'OTP_EXPIRED');
      case 'too_many_attempts':
        throw badRequest('Too many wrong attempts — request a new code', 'OTP_LOCKED');
      default:
        throw badRequest('Incorrect code', 'OTP_WRONG');
    }
  }
  return c.json({ success: true, purpose, verified: true });
});

// --------------------------------------------------------------- webhook

interface TgUser {
  id: number;
  is_bot?: boolean;
}
interface TgContact {
  phone_number: string;
  first_name?: string;
  user_id?: number;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat?: { id: number; type: string };
  text?: string;
  contact?: TgContact;
  forward_date?: number;
  forward_origin?: unknown;
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
}

telegramRoutes.post('/webhook', async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    throw unavailable('Telegram webhook is not configured (TELEGRAM_WEBHOOK_SECRET is unset)');
  }
  const header = c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(header), enc.encode(secret))) {
    throw forbidden('Invalid webhook secret');
  }

  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update !== 'object') throw badRequest('Invalid update payload');
  if (!Number.isInteger(update.update_id)) return c.json({ ok: true });

  // Dedup: the UNIQUE primary key makes redelivered updates no-ops. A
  // duplicate is acknowledged 200 so Telegram stops retrying.
  try {
    await c.env.DB.prepare('INSERT INTO telegram_updates (update_id) VALUES (?)')
      .bind(update.update_id)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY')) return c.json({ ok: true });
    throw e;
  }

  // Processing failures must not turn into non-200s (the update is already
  // recorded; a retry would be dropped as a duplicate anyway).
  try {
    await handleUpdate(c.env, update);
  } catch (e) {
    console.error('telegram webhook: update handling failed', e instanceof Error ? e.message : e);
  }
  return c.json({ ok: true });
});

async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.chat || typeof msg.chat.id !== 'number') return;
  // Linking and OTP conversations are PRIVATE-chat only; group/channel
  // traffic (e.g. the admin chat) is never part of these flows.
  if (msg.chat.type !== 'private') return;

  if (msg.contact) {
    await handleContact(env, msg);
    return;
  }
  if (typeof msg.text === 'string' && msg.text.startsWith('/start')) {
    await handleStart(env, msg);
  }
}

async function handleStart(env: Env, msg: TgMessage): Promise<void> {
  const chatId = msg.chat!.id;
  const payload = (msg.text || '').split(/\s+/)[1] || '';
  if (!payload || !/^[A-Za-z0-9_-]{16,64}$/.test(payload)) {
    await sendToChat(env, chatId, TXT_UNKNOWN_START);
    return;
  }

  const id = await sha256Hex(payload);
  const now = nowIso();
  // Bind this private chat to the challenge — conditionally, so a consumed
  // or expired challenge is never revived. Unknown/expired nonces get one
  // generic reply (no enumeration of which case it was).
  const res = await env.DB.prepare(
    `UPDATE link_challenges SET chat_id = ?, telegram_user_id = ?
      WHERE id = ? AND consumed_at IS NULL AND state IN ('pending','contact_received') AND expires_at > ?`
  )
    .bind(chatId, msg.from?.id ?? null, id, now)
    .run();

  if (!res.meta || res.meta.changes === 0) {
    await sendToChat(env, chatId, TXT_UNKNOWN_START);
    return;
  }
  await sendToChat(env, chatId, TXT_CONTACT_PROMPT, CONTACT_KEYBOARD);
}

async function handleContact(env: Env, msg: TgMessage): Promise<void> {
  const chatId = msg.chat!.id;
  const contact = msg.contact!;

  // A forwarded contact proves nothing about the sender — reject it.
  if (msg.forward_origin !== undefined || msg.forward_date !== undefined) {
    await sendToChat(env, chatId, TXT_FORWARDED_REJECTED);
    return;
  }

  const now = nowIso();
  const ch = await env.DB.prepare(
    `SELECT id, phone_entered FROM link_challenges
      WHERE chat_id = ? AND consumed_at IS NULL AND state IN ('pending','contact_received') AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(chatId, now)
    .first<{ id: string; phone_entered: string }>();
  if (!ch) {
    await sendToChat(env, chatId, TXT_NO_ACTIVE_REQUEST, REMOVE_KEYBOARD);
    return;
  }

  // The contact must belong to the SENDER (typed numbers and other people's
  // contact cards carry no user_id / a different user_id).
  if (typeof contact.user_id !== 'number' || !msg.from || contact.user_id !== msg.from.id) {
    await env.DB.prepare(
      `UPDATE link_challenges SET state = 'contact_received'
        WHERE id = ? AND consumed_at IS NULL AND state = 'pending'`
    )
      .bind(ch.id)
      .run();
    await sendToChat(env, chatId, TXT_NOT_OWN_CONTACT, CONTACT_KEYBOARD);
    return;
  }

  // Full E.164 equality — never loose suffix matching.
  if (!phonesMatch(contact.phone_number, ch.phone_entered)) {
    await env.DB.prepare(
      `UPDATE link_challenges SET state = 'contact_received', telegram_user_id = ?
        WHERE id = ? AND consumed_at IS NULL AND state IN ('pending','contact_received')`
    )
      .bind(msg.from.id, ch.id)
      .run();
    // Honest, without revealing the expected number.
    await sendToChat(env, chatId, TXT_PHONE_MISMATCH, REMOVE_KEYBOARD);
    return;
  }

  const res = await env.DB.prepare(
    `UPDATE link_challenges SET state = 'phone_verified', telegram_user_id = ?, chat_id = ?
      WHERE id = ? AND consumed_at IS NULL AND state IN ('pending','contact_received')`
  )
    .bind(msg.from.id, chatId, ch.id)
    .run();
  if (res.meta && res.meta.changes > 0) {
    await sendToChat(env, chatId, TXT_PHONE_VERIFIED, REMOVE_KEYBOARD);
  }
}

// ----------------------------------------------------------------- admin

/**
 * Registers the webhook for THIS deployment's origin. Deliberate friction
 * (confirm: "SET-WEBHOOK") because a bot has exactly ONE webhook: pointing
 * it at staging silently disconnects production. Never calls deleteWebhook
 * and never drops pending updates.
 */
telegramRoutes.post('/admin/set-webhook', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-set-webhook', 5, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== 'SET-WEBHOOK') {
    throw badRequest('Confirmation required: send { "confirm": "SET-WEBHOOK" }', 'CONFIRM_REQUIRED');
  }

  const missing: string[] = [];
  if (!c.env.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!c.env.TELEGRAM_WEBHOOK_SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!c.env.APP_ORIGIN) missing.push('APP_ORIGIN');
  if (missing.length) {
    throw unavailable(`Telegram webhook setup is not configured — missing: ${missing.join(', ')}`);
  }
  const origin = c.env.APP_ORIGIN!.replace(/\/+$/, '');
  if (!origin.startsWith('https://')) {
    throw badRequest('APP_ORIGIN must be an https:// origin', 'BAD_ORIGIN');
  }
  const url = `${origin}/api/telegram/webhook`;

  let ok = false;
  let description = '';
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: c.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message'],
        // NEVER drop pending updates — that needs explicit owner approval.
        drop_pending_updates: false,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    ok = res.ok && data.ok === true;
    description = maskBotToken(c.env, String(data.description ?? `HTTP ${res.status}`));
  } catch (e) {
    description = 'Telegram API unreachable';
    console.error('setWebhook failed', e instanceof Error ? e.message : e);
  }

  await audit(c.env.DB, user.id, 'telegram.set_webhook', url, { ok, description });
  return c.json({
    success: ok,
    ok,
    url,
    description,
    note:
      'A Telegram bot has exactly ONE webhook. Setting it here disconnects any other environment (staging vs production) using the same bot — use a separate staging bot for staging tests.',
  }, ok ? 200 : 502);
});

telegramRoutes.get('/admin/webhook-info', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-webhook-info', 30, 3600);
  if (!c.env.TELEGRAM_BOT_TOKEN) {
    throw unavailable('Telegram is not configured (TELEGRAM_BOT_TOKEN is unset)');
  }
  let info: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: Record<string, unknown> };
    if (res.ok && data.ok && data.result) info = data.result;
  } catch (e) {
    console.error('getWebhookInfo failed', e instanceof Error ? e.message : e);
  }
  if (!info) throw unavailable('Telegram API unreachable — try again later', 'TELEGRAM_UNAVAILABLE');

  // Response minimization + masking: only operational fields, with any
  // accidental bot-token occurrence redacted.
  const masked = (v: unknown) => (typeof v === 'string' ? maskBotToken(c.env, v) : v);
  return c.json({
    success: true,
    webhook: {
      url: masked(info.url),
      has_custom_certificate: info.has_custom_certificate ?? false,
      pending_update_count: info.pending_update_count ?? 0,
      ip_address: info.ip_address ?? null,
      last_error_date: info.last_error_date ?? null,
      last_error_message: masked(info.last_error_message) ?? null,
      max_connections: info.max_connections ?? null,
      allowed_updates: info.allowed_updates ?? null,
    },
  });
});

function maskBotToken(env: Env, s: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) return s;
  return s.split(env.TELEGRAM_BOT_TOKEN).join('***');
}
