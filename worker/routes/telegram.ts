import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext, Env } from '../lib/types';
import {
  requireAuth,
  requireAdmin,
  badRequest,
  forbidden,
  conflict,
  notFound,
  unavailable,
  int,
  str,
  oneOf,
} from '../lib/http';
import { sha256Hex, randomToken, timingSafeEqual } from '../lib/crypto';
import { handlePriceAdjustCallback, isPriceCallbackData, type PriceCallback } from '../lib/orderPriceAdjust';
import { normalizePhone, phonesMatch, maskPhone } from '../lib/phone';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import {
  getBotUsername,
  scrubTokens,
  sendToChat,
  telegramCanDeliver,
  verifyOtp,
  maybeSendAuthChallengeOtp,
  botToken,
  OTP_PURPOSES,
  type OtpPurpose,
  extractStartPayload,
  startDeepLink,
} from '../lib/telegram';
import { setPrimaryChannelStatements } from '../lib/channelReadiness';
import { canViewFinancials } from '../lib/adminScope';
import {
  BINDABLE_TOPIC_KEYS,
  adminBotConfigured,
  adminTelegramIds,
  auditAdminBot,
  isBotAdmin,
  readAdminGroup,
  readTopics,
  topicLabel,
} from '../lib/telegramAdmin';
import {
  handleAdminCommand,
  refuseUnauthorized,
  type AdminMessage,
} from '../lib/telegramAdminCommands';
import {
  handleAdminActionCallback,
  processWalletNotifications,
  type CallbackQueryInput,
} from '../lib/walletNotify';
import {
  handleOrderConfirmCallback,
  isOrderConfirmData,
  type OrderConfirmCallback,
} from '../lib/orderTelegramConfirm';

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

// Auth (signup/login) variant of the verified message: the next step is the
// code, not a browser-side "confirm link". Generic on purpose — whether the
// code actually follows depends on server-side linkability, and the site
// explains the specific outcome.
const TXT_PHONE_VERIFIED_AUTH =
  'LEVONIS ✅\n' +
  'تم التحقق من رقم هاتفك. إذا وصلك رمز تحقق هنا فأدخله في موقع LEVONIS؛ وإن لم يصلك، ارجع إلى الموقع واتبع التعليمات.\n' +
  'Your phone number is verified. If a verification code arrives here, enter it on the LEVONIS website; otherwise return to the site and follow the instructions.\n' +
  'ژمارەی تەلەفۆنەکەت پشتڕاستکرایەوە. ئەگەر کۆدی پشتڕاستکردنەوە لێرە گەیشت، لە ماڵپەڕی LEVONIS بینووسە؛ ئەگەرنا بگەڕێوە بۆ ماڵپەڕەکە و ڕێنماییەکان جێبەجێبکە.';

// A plain "/start" (the chat's START/RESTART button without a payload) or any
// other message from a chat that has no request bound to it. It used to get
// «هذا الرابط غير صالح» — which, to someone whose iPhone just opened the chat
// without the START payload, reads as "the site is broken". It now says what
// to do: go back and tap the button again, or paste the command shown there.
// OWNER: Sorani to be written by hand.
const TXT_START_HELP =
  'LEVONIS\n' +
  'أهلًا بك. لتسجيل الدخول أو توثيق رقمك: ارجع إلى موقع LEVONIS واضغط «فتح البوت في تيليغرام» مرة أخرى، أو انسخ الأمر الظاهر في الموقع (يبدأ بـ /start) وأرسله هنا كرسالة.\n\n' +
  "Welcome. To sign in or verify your number: go back to the LEVONIS website and tap 'Open the bot in Telegram' again, or copy the command shown there (it starts with /start) and send it here as a message.";

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

  // ONE definition of "Telegram can deliver", shared with readiness, with the
  // outbox's own send gate and with `channelsLive` (lib/telegram.ts). The bare
  // `!c.env.TELEGRAM_BOT_TOKEN` that used to be here treated a whitespace-only
  // secret as configured, so the activation sheet offered a button that led to
  // a bot nothing could reach.
  if (!telegramCanDeliver(c.env)) {
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
    deep_link: startDeepLink(botUsername, nonce),
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

  /**
   * THE ACCOUNT'S OWN PHONE, STAMPED HERE — because linking is the only place
   * a customer can prove one from inside the shop, and until now it did not.
   *
   * This route wrote `telegram_links.phone_e164` and stopped. Every OTHER
   * reader in the codebase asks `users.phone_e164`: `publicUser` (`phone`,
   * `has_phone`), the WhatsApp pill on the settings screen, and the account
   * lookup WhatsApp OTP sign-in performs (`SELECT … FROM users WHERE
   * phone_e164 = ?`). So a person who linked Telegram from Settings saw their
   * verified number inside the Telegram card — read from `telegram_links` —
   * while the account itself reported no phone, for ever.
   *
   * Two of the owner's reports are that one gap. «لا يوجد خيار لربط الواتساب»:
   * `channelReadiness` answered WhatsApp with `ACCOUNT_NO_DESTINATION`,
   * `can_activate: false`, `action: null` — a dead end with no button to
   * offer, because the account held no number to send to. And «الرقم موجود في
   * الإعدادات ولا يظهر في تعديل الملف الشخصي»: two screens, two different
   * tables, one of them empty.
   *
   * The statement is copied from the Telegram LOGIN path (worker/routes/auth.ts),
   * which has always self-healed this way — the LINK path simply never did.
   * Its guards are why it is safe: `phone_e164 IS NULL` never overwrites a
   * number the account already holds, and `NOT EXISTS` means it can never take
   * one another account holds. A lost race on the UNIQUE index is swallowed,
   * for the same reason as the primary-channel write below: the link is
   * already committed, and undoing a verified link because a stamp would not
   * write is not a trade worth making.
   */
  try {
    await c.env.DB.prepare(
      `UPDATE users SET phone_e164 = ?1
        WHERE id = ?2 AND phone_e164 IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE phone_e164 = ?1)`
    )
      .bind(ch.phone_entered, user.id)
      .run();
  } catch (e) {
    console.error('phone_e164 self-heal failed for user', user.id, e instanceof Error ? e.message : String(e));
  }

  /**
   * LINKING TELEGRAM IS AN EXPLICIT ACTIVATION, AND EXPLICIT ACTIVATION IS THE
   * ONLY THING ALLOWED TO CHOOSE A PRIMARY CHANNEL.
   *
   * A person who has just walked through a deep link, shared their contact with
   * the bot and confirmed it in this browser has told the shop, unambiguously,
   * where they want to be reached. Nothing else in the system may write
   * `is_primary` — in particular not `email_verified_at`, which is stamped in
   * six places including the first Google sign-in and would otherwise make
   * every Google account email-primary before it had opened a product page
   * (see `setPrimaryChannelStatements`). This one write is what makes the
   * owner's rule — «تيليغرام أولاً» — true for the great majority of customers,
   * who will never open the notification settings screen at all.
   *
   * Written AFTER the link is committed and guarded on its own: the preference
   * is a consequence of the link, never a condition of it. A failure here loses
   * a default the person can still set by hand; undoing a verified link because
   * a preference row would not write is not a trade worth making.
   */
  try {
    await c.env.DB.batch(setPrimaryChannelStatements(c.env.DB, user.id, 'telegram'));
  } catch (e) {
    console.error('telegram link: primary channel not stored:', e instanceof Error ? e.message : String(e));
  }

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
interface TgCallbackQuery {
  id?: string;
  from?: { id?: number };
  data?: string;
  message?: { message_id?: number; chat?: { id?: number; type?: string }; text?: string };
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
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
  // Inline-button presses on the wallet approval message (§12.2). They come
  // from the admin GROUP, so they are handled BEFORE the private-chat guard
  // below. Authority, message binding and single-use token consumption are
  // all enforced in worker/lib/walletNotify.ts — this route only routes.
  const cb = update.callback_query;
  if (cb) {
    if (typeof cb.id !== 'string' || !cb.id) return;
    // «تم تأكيد الطلب» on an order message the legacy ladder sent through this
    // bot (no admin group bound yet). Its own namespace, its own checks —
    // worker/lib/orderTelegramConfirm.ts; everything else is a wallet button.
    if (isOrderConfirmData(cb.data)) {
      await handleOrderConfirmCallback(env, cb as OrderConfirmCallback, 'customer');
      return;
    }
    // «موافق على السعر الجديد» / «رفض» in a CUSTOMER's private chat (0140).
    // Owner binding and replay safety live in worker/lib/orderPriceAdjust.ts.
    if (isPriceCallbackData(cb.data)) {
      await handlePriceAdjustCallback(env, cb as PriceCallback);
      return;
    }
    await handleAdminActionCallback(env, cb as CallbackQueryInput);
    return;
  }

  const msg = update.message;
  if (!msg?.chat || typeof msg.chat.id !== 'number') return;
  // Linking and OTP conversations are PRIVATE-chat only; group/channel
  // traffic (e.g. the admin chat) is never part of these flows.
  if (msg.chat.type !== 'private') return;

  if (msg.contact) {
    await handleContact(env, msg);
    return;
  }
  if (typeof msg.text === 'string') {
    await handleText(env, msg);
  }
}

/** The site's own sign-in page, as an inline button under the help text. */
function openSiteKeyboard(env: Env): Record<string, unknown> {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!origin.startsWith('https://')) return {};
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '🌐 فتح LEVONIS / Open LEVONIS', url: `${origin}/auth` }]],
    },
  };
}

/**
 * Every private text message. «عند الضغط على start … لا يفتح ولا يضغط الزر،
 * هذا في الايفون»: on iPhone the START button does not always carry the
 * payload (an existing chat, an in-app browser that swallowed the tg:// hop),
 * so the challenge can also be bound by pasting `/start <code>`, the t.me
 * link, or the bare code — the same nonce, the same single conditional UPDATE,
 * no new secret. A payload-less /start or any other text from a chat that
 * already has a live request re-shows the share-contact keyboard (it may have
 * been dismissed); from a chat with none it gets instructions, never silence.
 */
async function handleText(env: Env, msg: TgMessage): Promise<void> {
  const chatId = msg.chat!.id;
  const { kind, payload } = extractStartPayload(msg.text || '');
  if (payload) {
    await handleStart(env, msg, payload);
    return;
  }
  const live = await env.DB.prepare(
    `SELECT id FROM link_challenges
      WHERE chat_id = ? AND consumed_at IS NULL AND state IN ('pending','contact_received') AND expires_at > ?
      LIMIT 1`
  )
    .bind(chatId, nowIso())
    .first<{ id: string }>();
  if (live) {
    await sendToChat(env, chatId, TXT_CONTACT_PROMPT, CONTACT_KEYBOARD);
    return;
  }
  const typed = (msg.text || '').trim();
  if (kind === 'start' && /^\/start(?:@\S+)?\s+\S/i.test(typed)) {
    // A payload was sent but it is not one of ours (truncated, edited).
    await sendToChat(env, chatId, TXT_UNKNOWN_START, openSiteKeyboard(env));
    return;
  }
  await sendToChat(env, chatId, TXT_START_HELP, openSiteKeyboard(env));
}

async function handleStart(env: Env, msg: TgMessage, payload: string): Promise<void> {
  const chatId = msg.chat!.id;

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
    await sendToChat(env, chatId, TXT_UNKNOWN_START, openSiteKeyboard(env));
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
    `SELECT id, purpose, phone_entered, expires_at FROM link_challenges
      WHERE chat_id = ? AND consumed_at IS NULL AND state IN ('pending','contact_received') AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(chatId, now)
    .first<{ id: string; purpose: string; phone_entered: string; expires_at: string }>();
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
    if (ch.purpose === 'signup' || ch.purpose === 'login') {
      // Anonymous auth flow (§4): the code can go out right away — the
      // customer is still in this chat, saving one app switch. The guarded
      // claim in maybeSendAuthChallengeOtp keeps this race-safe with the
      // browser's status poll (at most one dispatch), and the browser still
      // learns the honest outcome (otp_sent / not_linkable / send_failed)
      // from its next poll.
      await sendToChat(env, chatId, TXT_PHONE_VERIFIED_AUTH, REMOVE_KEYBOARD);
      await maybeSendAuthChallengeOtp(env, {
        id: ch.id,
        purpose: ch.purpose,
        phone_entered: ch.phone_entered,
        state: 'phone_verified',
        telegram_user_id: msg.from.id,
        chat_id: chatId,
        otp_sent_at: null,
        expires_at: ch.expires_at,
        consumed_at: null,
      });
    } else {
      await sendToChat(env, chatId, TXT_PHONE_VERIFIED, REMOVE_KEYBOARD);
    }
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
  // Same predicate as the linking gate above, so a whitespace-only secret is
  // reported as missing here rather than passing this check and failing at the
  // Telegram API with a 401 nobody reads.
  if (!telegramCanDeliver(c.env)) missing.push('TELEGRAM_BOT_TOKEN');
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
        // 'callback_query' is required for the wallet approval buttons
        // (§12.2). Telegram only delivers the update types listed here, so
        // an existing webhook must be re-registered once after this change.
        allowed_updates: ['message', 'callback_query'],
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
  if (!telegramCanDeliver(c.env)) {
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

/**
 * Masks EVERY bot token, not just the customer one (0080). A second bot's
 * token would otherwise appear in clear the first time `getWebhookInfo`
 * echoed a URL or an error containing it.
 */
function maskBotToken(env: Env, s: string): string {
  return scrubTokens(env, s);
}

// ------------------------------------------- wallet approval authority (§12.2)
//
// "Verify callback_query.from.id and match it to a KNOWN administrative user
//  with real approval authority. Being in the group, being a Telegram admin
//  or having a matching name does not automatically grant financial authority
//  on the site."
//
// That mapping is created here and nowhere else: never by /start, never by
// joining the group, never by the bot. Every seed and revocation is audited.

/**
 * BINDING A TELEGRAM IDENTITY IS HANDING OUT FINANCIAL AUTHORITY, SO IT IS
 * GATED LIKE ONE.
 *
 * A row in `admin_tg_identities` is what lets a Telegram account press
 * «موافقة» on a wallet deposit — `resolveAdminActor` in
 * worker/lib/walletNotify.ts resolves the button press through exactly this
 * table. `requireAdmin` alone was therefore not enough: an ASSISTANT admin
 * (`users.admin_scope = 'assistant'`), whom mandate §11 forbids even from
 * SEEING a cost, satisfies `requireAdmin` and satisfies the `u.role = 'admin'`
 * test inside both writes below — so they could bind their own numeric id and
 * approve money from the bot, which is the one authority the scope exists to
 * withhold.
 *
 * The READ is gated with the same key and not a weaker one: the list is the
 * roster of who may approve payments, and handing an assistant the map of the
 * financial approval path is disclosure of the same fact the write grants.
 *
 * 403 and not 404, matching adminFinance and adminPriceGrid: the caller IS an
 * administrator and the route exists for them as a person — what they lack is
 * financial scope, and saying so is how they know to ask the owner.
 */
async function requireFinancialAdmin(c: Context<AppContext>, next: Next) {
  if (!canViewFinancials(c.env, c.get('user'))) {
    throw forbidden('Telegram payment-approval authority is restricted to financial admins');
  }
  await next();
}

/** Live identity rows (never exposes anything but the mapping itself). */
telegramRoutes.get('/admin/tg-identities', requireAdmin, requireFinancialAdmin, async (c) => {
  await rateLimit(c, 'tg-identities-list', 60, 3600);
  const { results } = await c.env.DB.prepare(
    `SELECT i.telegram_user_id, i.user_id, i.label, i.created_at, i.created_by,
            i.revoked_at, i.revoke_reason, u.name, u.username, u.role
       FROM admin_tg_identities i JOIN users u ON u.id = i.user_id
      ORDER BY i.revoked_at IS NOT NULL, i.created_at DESC LIMIT 200`
  ).all<{
    telegram_user_id: number;
    user_id: string;
    label: string;
    created_at: string;
    created_by: string | null;
    revoked_at: string | null;
    revoke_reason: string;
    name: string;
    username: string | null;
    role: string;
  }>();
  return c.json({
    success: true,
    identities: (results ?? []).map((r) => ({
      telegram_user_id: r.telegram_user_id,
      user_id: r.user_id,
      name: r.name,
      username: r.username,
      // An identity whose site account is no longer an admin authorizes
      // nothing — surfaced so it is visible, not silently ignored.
      active: r.revoked_at === null && r.role === 'admin',
      site_role: r.role,
      label: r.label,
      created_at: r.created_at,
      created_by: r.created_by,
      revoked_at: r.revoked_at,
      revoke_reason: r.revoke_reason,
    })),
  });
});

/**
 * Seeds (or revives a previously revoked) Telegram identity for a site admin.
 * The admin-role requirement lives inside the WHERE of both writes, so the
 * mapping cannot be created for a non-admin even under a concurrent role
 * change, and an existing LIVE mapping is never silently retargeted.
 */
telegramRoutes.post('/admin/tg-identities', requireAdmin, requireFinancialAdmin, async (c) => {
  await rateLimit(c, 'tg-identity-seed', 20, 3600);
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const userId = str(body.userId, 'userId', { min: 3, max: 60 });
  const telegramUserId = int(body.telegramUserId, 'telegramUserId', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const label = str(body.label, 'label', { max: 80, required: false });

  let res: D1Result[];
  try {
    res = await c.env.DB.batch([
      // Revive: only a REVOKED row may be reused for this Telegram account.
      c.env.DB.prepare(
        `UPDATE admin_tg_identities
            SET user_id = ?2, label = ?3, created_by = ?4,
                created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                revoked_at = NULL, revoked_by = NULL, revoke_reason = ''
          WHERE telegram_user_id = ?1 AND revoked_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.role = 'admin')`
      ).bind(telegramUserId, userId, label, admin.id),
      // Fresh mapping: only when this Telegram account is unknown.
      c.env.DB.prepare(
        `INSERT INTO admin_tg_identities (telegram_user_id, user_id, label, created_by)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.role = 'admin')
            AND NOT EXISTS (SELECT 1 FROM admin_tg_identities a WHERE a.telegram_user_id = ?1)`
      ).bind(telegramUserId, userId, label, admin.id),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) {
      throw conflict('This administrator already has a live Telegram identity — revoke it before linking another account');
    }
    throw e;
  }

  const changed = (res[0]?.meta.changes ?? 0) + (res[1]?.meta.changes ?? 0);
  if (changed === 0) {
    const target = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?')
      .bind(userId)
      .first<{ role: string }>();
    if (!target) throw notFound('No such user');
    if (target.role !== 'admin') throw badRequest('Only a site administrator can be given Telegram approval authority', 'NOT_ADMIN');
    throw conflict('This Telegram account is already mapped to an administrator — revoke that mapping first');
  }

  await audit(c.env.DB, admin.id, 'telegram.admin_identity.seeded', `user:${userId}`, {
    telegram_user_id: telegramUserId,
    label,
  });
  return c.json({ success: true, telegram_user_id: telegramUserId, user_id: userId });
});

/** Revokes approval authority. The reason is mandatory (schema CHECK): a
 *  silent de-authorization would leave an unauditable hole in a financial
 *  approval path. */
telegramRoutes.post('/admin/tg-identities/:telegramUserId/revoke', requireAdmin, requireFinancialAdmin, async (c) => {
  await rateLimit(c, 'tg-identity-revoke', 20, 3600);
  const admin = c.get('user')!;
  const telegramUserId = int(c.req.param('telegramUserId'), 'telegramUserId', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 200 });

  const res = await c.env.DB.prepare(
    `UPDATE admin_tg_identities
        SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = ?2, revoke_reason = substr(?3, 1, 200)
      WHERE telegram_user_id = ?1 AND revoked_at IS NULL`
  )
    .bind(telegramUserId, admin.id, reason)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw notFound('No live Telegram identity for this account');

  await audit(c.env.DB, admin.id, 'telegram.admin_identity.revoked', `tg:${telegramUserId}`, { reason });
  return c.json({ success: true });
});

// ------------------------------------ notification delivery log / retry (§12.3)
//
// "Administration gets a failed-send list and a retry — NOT a button that
//  duplicates the balance." Retrying re-sends a MESSAGE; it can never credit,
//  debit or re-decide anything.

telegramRoutes.get('/admin/wallet-notifications', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-notify-list', 60, 3600);
  const state = str(c.req.query('state'), 'state', { max: 20, required: false });
  const allowed = ['pending', 'sent', 'failed', 'dead', 'skipped'];
  const filter = allowed.includes(state) ? state : '';
  const stmt = filter
    ? c.env.DB.prepare(
        `SELECT id, request_kind, request_id, state, sent_as, attempts, last_error,
                closed_state, closed_at, created_at, sent_at, message_id
           FROM tg_admin_notifications WHERE state = ? ORDER BY created_at DESC LIMIT 100`
      ).bind(filter)
    : c.env.DB.prepare(
        `SELECT id, request_kind, request_id, state, sent_as, attempts, last_error,
                closed_state, closed_at, created_at, sent_at, message_id
           FROM tg_admin_notifications ORDER BY created_at DESC LIMIT 100`
      );
  const { results } = await stmt.all<Record<string, unknown>>();
  // The caption, the R2 key and the chat id stay server-side: this list is an
  // operational view, not a second copy of the customer's data.
  return c.json({ success: true, notifications: results ?? [] });
});

telegramRoutes.post('/admin/wallet-notifications/:id/retry', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-notify-retry', 30, 3600);
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 3, max: 60 });

  // Only a failed/dead, still-open notification is re-armed. A message whose
  // request was already decided is not re-sent — its buttons are dead and a
  // fresh copy would only invite a second click.
  const res = await c.env.DB.prepare(
    `UPDATE tg_admin_notifications
        SET state = 'pending', attempts = 0, last_error = '',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND state IN ('failed','dead') AND closed_state = ''`
  )
    .bind(id)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('This notification is not in a retryable state (only failed/dead and still-open messages can be re-sent)');
  }
  await audit(c.env.DB, admin.id, 'telegram.notification.retry', id, {});
  c.executionCtx.waitUntil(processWalletNotifications(c.env, 5).then(() => undefined));
  return c.json({ success: true, state: 'pending' });
});

// =========================================================================
//  THE ADMIN BOT — @alilevobot (migration 0080)
// =========================================================================
//
// WHY THE PATH IS `/api/telegram/ops/webhook` AND NOT `/api/telegram/admin/webhook`.
//
// `/admin` in a route path is a CAPABILITY declaration in this codebase, not a
// naming convention: `services/gateway/test/capabilities.test.ts` discovers
// every core route whose path contains "admin" and fails the build unless it
// is apex-only AND gated behind an admin SESSION. A Telegram webhook has no
// session — it is a machine ingress authenticated by a shared secret header,
// exactly like `/api/telegram/webhook` — so putting it under `/admin` would
// either 401 every update Telegram sends or force a hole in that gate.
//
// The bot's MANAGEMENT endpoints below DO live under `/admin`, because they
// are genuine admin surfaces and do require a session. The webhook path is
// never typed by a human: our own tooling registers it with Telegram.

/** The admin bot's update-dedup table is its own — see migration 0080 for why
 *  sharing `telegram_updates` would silently swallow this bot's first updates. */
async function claimAdminUpdate(env: Env, updateId: number): Promise<boolean> {
  try {
    await env.DB.prepare('INSERT INTO telegram_admin_updates (update_id) VALUES (?)').bind(updateId).run();
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY')) return false;
    throw e;
  }
}

telegramRoutes.post('/ops/webhook', async (c) => {
  const secret = c.env.TELEGRAM_ADMIN_WEBHOOK_SECRET;
  if (!secret) {
    throw unavailable('Admin Telegram webhook is not configured (TELEGRAM_ADMIN_WEBHOOK_SECRET is unset)');
  }
  const header = c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(header), enc.encode(secret))) {
    throw forbidden('Invalid webhook secret');
  }

  const update = (await c.req.json().catch(() => null)) as AdminUpdate | null;
  if (!update || typeof update !== 'object') throw badRequest('Invalid update payload');
  if (!Number.isInteger(update.update_id)) return c.json({ ok: true });

  // §16 — a redelivered update is acknowledged 200 and NOT re-processed. The
  // business operations behind the buttons are independently idempotent
  // (single-use action tokens + the conditional flip inside decideDeposit),
  // so this is defence in depth rather than the only guard.
  if (!(await claimAdminUpdate(c.env, update.update_id))) return c.json({ ok: true });

  try {
    await handleAdminUpdate(c.env, update);
  } catch (e) {
    // Same contract as the customer webhook: the update is already recorded,
    // so a non-200 would only earn a retry that gets deduped away. The error
    // is logged with both tokens scrubbed.
    console.error('telegram admin webhook: update handling failed', scrubTokens(c.env, e instanceof Error ? e.message : String(e)));
  }
  return c.json({ ok: true });
});

interface AdminUpdate {
  update_id: number;
  message?: AdminMessage;
  callback_query?: {
    id?: string;
    from?: { id?: number };
    data?: string;
    message?: { message_id?: number; chat?: { id?: number }; text?: string };
  };
}

async function handleAdminUpdate(env: Env, update: AdminUpdate): Promise<void> {
  // ---- button presses -----------------------------------------------------
  const cb = update.callback_query;
  if (cb) {
    if (typeof cb.id !== 'string' || !cb.id) return;
    const from = cb.from?.id;
    // DOOR 1 (§3): the bot allow-list, numeric ids only. DOOR 2 — the site
    // role that actually authorises money — is enforced inside
    // handleAdminActionCallback by resolveAdminActor, and this does not
    // replace it. Someone on the allow-list with no admin_tg_identities row
    // still cannot approve a dinar.
    if (!isBotAdmin(env, from)) {
      await answerAdminCallback(env, cb.id, 'غير مصرح لك بهذا الإجراء.');
      await auditAdminBot(env.DB, null, 'telegram_admin.callback.denied', `tg:${from ?? 'unknown'}`, typeof from === 'number' ? from : null, {
        reason: 'not_in_allow_list',
      });
      return;
    }
    // THE ORDER BUTTON — «تم تأكيد الطلب» on the «📝 Orders» topic message.
    // Past door 1 like every button here; door 2 (a live site admin behind this
    // Telegram id) and the group check are inside the handler. Dispatched
    // BEFORE the wallet handler, which answers anything it cannot parse as a
    // wallet token with «زر غير صالح».
    if (isOrderConfirmData(cb.data)) {
      await handleOrderConfirmCallback(env, cb as OrderConfirmCallback, 'admin');
      return;
    }
    await handleAdminActionCallback(env, cb as CallbackQueryInput, 'admin');
    return;
  }

  // ---- commands -----------------------------------------------------------
  const msg = update.message;
  if (!msg?.chat || typeof msg.chat.id !== 'number') return;
  const from = msg.from?.id;
  if (!isBotAdmin(env, from)) {
    // §20: an unauthorized sender learns nothing about the platform.
    await refuseUnauthorized(env, msg);
    return;
  }
  const outcome = await handleAdminCommand({ env, msg, telegramUserId: from as number });
  // THE ONLY MOMENT THE SCOPED MENU CAN EVER BE WRITTEN.
  //
  // `setAdminBotCommands` needs a bound group to scope to, and the other call
  // site — POST /admin/set-admin-webhook — runs BEFORE any `/topic_here` can
  // reach this worker at all, so on a fresh setup there is necessarily no group
  // and it returns false. `bound_group` is returned only when this command is
  // the one that created the config row (telegramAdminCommands.bindHere), so
  // this fires exactly once per binding, including after /admin/group/reset.
  //
  // Best effort on purpose: the menu is cosmetic, the binding is not, and the
  // owner has already been told «تم ربط…» by the time we get here. A Telegram
  // hiccup must not turn a successful bind into a failed webhook delivery that
  // Telegram then retries.
  if (outcome === 'bound_group') {
    try {
      await setAdminBotCommands(env);
    } catch (e) {
      console.error('admin menu registration after bind failed', scrubTokens(env, e instanceof Error ? e.message : String(e)));
    }
  }
}

/** The admin bot's own fast callback answer for refusals it makes before the
 *  wallet machinery is reached (§14 — the spinner never stays stuck). */
async function answerAdminCallback(env: Env, callbackQueryId: string, text: string): Promise<void> {
  const token = botToken(env, 'admin');
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200), show_alert: true }),
    });
  } catch (e) {
    console.error('admin answerCallbackQuery failed', scrubTokens(env, e instanceof Error ? e.message : String(e)));
  }
}

// ------------------------------------------- admin-bot management (session)
//
// These DO live under `/admin` and DO require a site admin session: they are
// operator surfaces, not machine ingress. `requireAdmin` also enforces the
// apex-host rule, which is what the gateway's capability table declares for
// this prefix.

/** Seeded Telegram approvers who are NOT on the bot allow-list, so the gap is
 *  visible on the screen rather than discovered when a button refuses. The
 *  mapping itself is already admin-visible at /admin/tg-identities. */
async function identitiesOutsideAllowList(
  env: Env
): Promise<Array<{ telegram_user_id: number; user_id: string; name: string }>> {
  const allowed = adminTelegramIds(env);
  const { results } = await env.DB.prepare(
    `SELECT i.telegram_user_id, i.user_id, u.name
       FROM admin_tg_identities i JOIN users u ON u.id = i.user_id
      WHERE i.revoked_at IS NULL AND u.role = 'admin'`
  ).all<{ telegram_user_id: number; user_id: string; name: string }>();
  return (results ?? []).filter((r) => !allowed.has(Number(r.telegram_user_id)));
}

/** Everything an operator needs to see whether the admin bot is wired up,
 *  with no secret value in the response — only whether each one is SET. */
telegramRoutes.get('/admin/bot-status', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-admin-bot-status', 60, 3600);
  const group = await readAdminGroup(c.env.DB);
  const topics = await readTopics(c.env.DB);
  const bound = new Map(topics.filter((t) => t.enabled).map((t) => [t.topicKey, t]));
  return c.json({
    success: true,
    configured: {
      bot_token: !!c.env.TELEGRAM_ADMIN_BOT_TOKEN,
      webhook_secret: !!c.env.TELEGRAM_ADMIN_WEBHOOK_SECRET,
      // The COUNT of allowed ids, never the ids themselves.
      admin_user_ids: adminTelegramIds(c.env).size,
      legacy_chat_fallback: !!(c.env.TELEGRAM_ADMIN_CHAT_ID || '').trim(),
    },
    group: group
      ? { chat_id: group.groupChatId, title: group.groupTitle, updated_at: group.updatedAt }
      : null,
    /**
     * THE TWO DOORS, SIDE BY SIDE.
     *
     * A site admin can hold a live `admin_tg_identities` row (door 2 — the one
     * that authorises money) and still not be on `TELEGRAM_ADMIN_USER_IDS`
     * (door 1 — the one that opens the bot). The buttons then refuse them, and
     * the refusal is correct but bewildering: nothing on any screen said the
     * two lists had drifted. This names the gap instead.
     */
    identities_missing_from_allow_list: await identitiesOutsideAllowList(c.env),
    /**
     * THE SAME NINE THE BOT ASKS FOR, AND NOT ONE ROW MORE.
     *
     * This listed `TOPIC_KEYS`, which carries the legacy `orders` key as a
     * tenth entry. The owner would bind the nine topics their group actually
     * has, the bot would answer «🎉 كل المواضيع مربوطة», and then this
     * screen would show a tenth row sitting at `bound: false` for a topic that
     * does not exist in Telegram — two of the shop's own surfaces disagreeing
     * about whether the setup is finished. `BINDABLE_TOPIC_KEYS` is the list
     * `/topics` counts against, so the two now cannot drift.
     *
     * A live legacy binding is NOT hidden: it is appended below as its own
     * labelled row, which is the same treatment `topicsText` gives it — an
     * existing binding that still carries traffic must stay visible, it just
     * must not read as an unfinished checklist item.
     */
    topics: [
      ...BINDABLE_TOPIC_KEYS.map((key) => {
        const t = bound.get(key);
        return {
          key,
          label: topicLabel(key),
          bound: !!t,
          legacy: false,
          // null = the forum's General topic, which Telegram addresses with no
          // thread id at all. Not a missing value.
          message_thread_id: t ? t.messageThreadId : null,
        };
      }),
      ...(bound.has('orders')
        ? [{
            key: 'orders',
            label: topicLabel('orders'),
            bound: true,
            legacy: true,
            message_thread_id: bound.get('orders')!.messageThreadId,
          }]
        : []),
    ],
  });
});

/**
 * Registers @alilevobot's webhook for THIS deployment. Same deliberate
 * friction as the customer bot: a bot has exactly ONE webhook, and pointing
 * this one at the wrong environment silently disconnects the other.
 */
telegramRoutes.post('/admin/set-admin-webhook', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-set-admin-webhook', 5, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== 'SET-ADMIN-WEBHOOK') {
    throw badRequest('Confirmation required: send { "confirm": "SET-ADMIN-WEBHOOK" }', 'CONFIRM_REQUIRED');
  }
  const missing: string[] = [];
  if (!c.env.TELEGRAM_ADMIN_BOT_TOKEN) missing.push('TELEGRAM_ADMIN_BOT_TOKEN');
  if (!c.env.TELEGRAM_ADMIN_WEBHOOK_SECRET) missing.push('TELEGRAM_ADMIN_WEBHOOK_SECRET');
  if (!c.env.APP_ORIGIN) missing.push('APP_ORIGIN');
  if (missing.length) {
    throw unavailable(`Admin bot webhook setup is not configured — missing: ${missing.join(', ')}`);
  }
  const origin = c.env.APP_ORIGIN!.replace(/\/+$/, '');
  if (!origin.startsWith('https://')) throw badRequest('APP_ORIGIN must be an https:// origin', 'BAD_ORIGIN');
  const url = `${origin}/api/telegram/ops/webhook`;

  let ok = false;
  let description = '';
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_ADMIN_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: c.env.TELEGRAM_ADMIN_WEBHOOK_SECRET,
        // Telegram delivers ONLY what is listed. `message` carries /topic_here
        // and friends; `callback_query` carries the wallet buttons.
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    ok = res.ok && data.ok === true;
    description = maskBotToken(c.env, String(data.description ?? `HTTP ${res.status}`));
  } catch (e) {
    description = 'Telegram API unreachable';
    console.error('admin setWebhook failed', scrubTokens(c.env, e instanceof Error ? e.message : String(e)));
  }

  // Best effort, and only after the webhook is live: the command menu is
  // cosmetic and its failure must not fail the registration.
  let commandsOk = false;
  if (ok) commandsOk = await setAdminBotCommands(c.env);

  await audit(c.env.DB, user.id, 'telegram_admin.set_webhook', url, { ok, description, commands: commandsOk });
  return c.json(
    {
      success: ok,
      ok,
      url,
      description,
      commands_registered: commandsOk,
      note: 'A Telegram bot has exactly ONE webhook. This registers @alilevobot only; the customer bot is untouched.',
    },
    ok ? 200 : 502
  );
});

/** getWebhookInfo for the ADMIN bot, minimized and masked like the customer one. */
telegramRoutes.get('/admin/admin-webhook-info', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-admin-webhook-info', 30, 3600);
  if (!adminBotConfigured(c.env)) {
    throw unavailable('Admin bot is not configured (TELEGRAM_ADMIN_BOT_TOKEN is unset)');
  }
  let info: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_ADMIN_BOT_TOKEN}/getWebhookInfo`);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: Record<string, unknown> };
    if (res.ok && data.ok && data.result) info = data.result;
  } catch (e) {
    console.error('admin getWebhookInfo failed', scrubTokens(c.env, e instanceof Error ? e.message : String(e)));
  }
  if (!info) throw unavailable('Telegram API unreachable — try again later', 'TELEGRAM_UNAVAILABLE');
  const masked = (v: unknown) => (typeof v === 'string' ? maskBotToken(c.env, v) : v);
  return c.json({
    success: true,
    webhook: {
      url: masked(info.url),
      pending_update_count: info.pending_update_count ?? 0,
      ip_address: info.ip_address ?? null,
      last_error_date: info.last_error_date ?? null,
      last_error_message: masked(info.last_error_message) ?? null,
      max_connections: info.max_connections ?? null,
      allowed_updates: info.allowed_updates ?? null,
    },
  });
});

/**
 * Unbinds the admin group so a DIFFERENT group can be adopted by the next
 * `/topic_here`. Deliberately a site-admin action behind a confirm string:
 * `/topic_here` alone must never be able to move the platform's notifications
 * to whatever group the sender happens to be standing in (§5).
 *
 * The TOPIC bindings go with it — a thread id is meaningless in another group.
 */
telegramRoutes.post('/admin/group/reset', requireAdmin, async (c) => {
  await rateLimit(c, 'tg-admin-group-reset', 5, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== 'RESET-ADMIN-GROUP') {
    throw badRequest('Confirmation required: send { "confirm": "RESET-ADMIN-GROUP" }', 'CONFIRM_REQUIRED');
  }
  const before = await readAdminGroup(c.env.DB);
  if (!before) throw notFound('No admin group is bound');
  // Unbinding while messages are still queued used to strand them: the row
  // carried a frozen destination and every retry re-sent to the dead chat.
  // The delivery pass now RE-RESOLVES on each attempt, so a queued message
  // simply waits and then lands in the new group — but say so, because an
  // operator who resets mid-queue should know the queue is still there.
  const queued = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tg_admin_notifications WHERE state IN ('pending','failed')"
  ).first<{ n: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM telegram_admin_topics'),
    c.env.DB.prepare("DELETE FROM telegram_admin_config WHERE id = 'singleton'"),
  ]);
  await auditAdminBot(c.env.DB, user.id, 'telegram_admin.group.reset', before.groupChatId, null, {
    previous_title: before.groupTitle,
  });
  return c.json({
    success: true,
    queued_notifications: queued?.n ?? 0,
    note:
      'The next /topic_here from an authorized admin adopts the group it is sent in. '
      + 'Queued notifications are not lost: each delivery attempt resolves the destination again.',
  });
});

/**
 * The command menu Telegram shows in the bot's UI (§25).
 *
 * SCOPED TO THE ADMIN GROUP, never registered globally. An unscoped
 * `setMyCommands` writes `BotCommandScopeDefault`, which Telegram shows to
 * EVERY user who opens the bot — so the whole admin command surface, including
 * `/topic_here`, would be advertised to any stranger who found @alilevobot.
 * Before a group is bound there is no chat to scope to, so nothing is
 * registered: the commands still work, only the menu waits.
 */
async function setAdminBotCommands(env: Env): Promise<boolean> {
  const token = botToken(env, 'admin');
  if (!token) return false;
  const group = await readAdminGroup(env.DB);
  if (!group) return false;
  const commands = [
    { command: 'start', description: 'بدء استخدام بوت الإدارة' },
    { command: 'help', description: 'قائمة الأوامر' },
    { command: 'status', description: 'حالة البوت والمجموعة' },
    { command: 'topics', description: 'حالة ربط المواضيع' },
    { command: 'topic_here', description: 'ربط الموضوع الحالي — مثال: /topic_here wallet' },
  ];
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands, scope: { type: 'chat', chat_id: group.groupChatId } }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && data.ok === true;
  } catch (e) {
    console.error('setMyCommands failed', scrubTokens(env, e instanceof Error ? e.message : String(e)));
    return false;
  }
}
