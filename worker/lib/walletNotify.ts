import type { Env } from './types';
import { newId, randomToken, sha256Hex } from './crypto';
import { audit } from './audit';
import { enqueue as enqueueOutbox } from './outbox';
import { maskPhone } from './phone';
import { getSetting } from './settings';
import { escapeHtml, emailLang, type EmailLang } from './emailTemplates';
import {
  answerCallbackQuery,
  botConfigured,
  editMessageCaption,
  editMessageReplyMarkup,
  editMessageText,
  sendMessageToChat,
  sendPhotoToChat,
  type BotId,
  type TgSendResult,
} from './telegram';
import { resolveAdminDestination, threadExtra } from './telegramAdmin';
import { operationNumber } from './walletOps';
import { getMediaObject, headMediaObject } from './mediaStorage';

/**
 * Wallet ⇄ Telegram notification and approval-token mechanics
 * (integrated mandate §12.1, §12.2, §12.3).
 *
 * SCOPE — what this file is and is not
 * ------------------------------------
 * It builds and delivers the admin-group message, mints and validates the
 * short-lived action tokens behind the inline buttons, renders the final
 * state back onto the message, and queues the customer's transactional
 * status notification. It performs NO financial transition of its own: a
 * deposit decision goes through `decideDeposit` in worker/lib/walletOps.ts —
 * the same service the site's admin panel calls — and the ledger is then
 * RE-READ to render the outcome, so what the group sees is what the database
 * actually holds, never what this code hoped would happen.
 *
 * THE THREE THINGS THAT MAKE A BUTTON SAFE (§12.2)
 * ------------------------------------------------
 *  1. WHO — callback_query.from.id must map, through admin_tg_identities, to
 *     a site user that STILL holds role='admin' at click time. Group
 *     membership, Telegram group-admin rights and matching names grant
 *     nothing (`resolveAdminActor`).
 *  2. WHERE — the chat id and message id of the callback must equal the ones
 *     Telegram itself reported when the notification was delivered. A copied
 *     or forwarded button, or the same button pressed in another group, has
 *     no matching row.
 *  3. WHAT — callback_data carries ONLY an unguessable random token whose
 *     SHA-256 digest is stored server-side with the request id, the action
 *     and an expiry. No amount and no user id ever travel in a button, so
 *     there is nothing in it worth tampering with.
 *
 * WHY TOKENS ARE MINTED AT RENDER TIME
 * ------------------------------------
 * Only the DIGEST is stored, so a raw token cannot be recovered from the
 * database — which means every keyboard is drawn from tokens minted in the
 * same call that draws it, and the previous, still-undelivered tokens for
 * that message are superseded in the same transaction. A retry after a
 * failed send, or the rejection-reason sub-menu, therefore always shows
 * buttons that actually work, and only the newest keyboard is live.
 *
 * EXACTLY ONE FINAL TRANSITION (§12.2, acceptance WAL-02/WAL-03)
 * -------------------------------------------------------------
 * Two guards, in this order: the token is claimed by a conditional UPDATE
 * (`consumed_at IS NULL` in the WHERE), and the decision itself is guarded
 * inside walletOps. A double click, two reviewers, or one reviewer on the
 * site and another in Telegram therefore produce one transition; the loser
 * is TOLD the request was already processed and by whom, and writes nothing.
 * If the decision call throws, the token claim is released so the reviewer
 * can retry honestly — a consumed token is never left standing over a
 * decision that did not happen.
 *
 * MESSAGE FAILURE NEVER TOUCHES MONEY (§12.3)
 * -------------------------------------------
 * Delivery lives in its own table with attempts, last_error and a visible
 * dead-letter state. A failed, retried or duplicated Telegram message cannot
 * create, undo or repeat a ledger entry, and a deposit that could not be
 * announced is still sitting in the admin panel for review. The honest limit
 * (§12.3): if Telegram accepts a send and the response is lost, a retry can
 * post a second GROUP MESSAGE — the older copy's buttons are superseded and
 * both point at one request, which the single-transition guards settle.
 * External message-level exactly-once is not claimed.
 */

// --------------------------------------------------------------- constants

/** Buttons expire; a stale message in a group is not a standing authority.
 *  Measured from the notification's creation, so re-drawing a keyboard can
 *  never extend the window. After it, the reviewer decides in the admin
 *  panel — which the answer text says explicitly. */
export const ACTION_TTL_HOURS = 72;

/** Delivery attempts before a notification is dead-lettered into the admin
 *  retry list. Mirrors the outbox policy. */
export const NOTIFY_MAX_ATTEMPTS = 5;

/** Telegram hard limits we must not exceed. */
export const CAPTION_MAX = 1024;
const TEXT_MAX = 4000;
const CALLBACK_DATA_MAX = 64;

/** callback_data prefix — "wallet action". */
const CB_PREFIX = 'wa:';

/** Telegram rejects photos above 10 MB on sendPhoto; uploads are already
 *  capped at 8 MB, this is the transport-side guard for the fallback path. */
const PHOTO_MAX_BYTES = 9_500_000;

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export type WalletRequestKind = 'deposit' | 'withdrawal';
export type TokenAction = 'approve' | 'reject' | 'reject_menu' | 'menu_main';

// -------------------------------------------------------------- sanitizing

// Bidi controls and zero-width characters let text render in an order the
// reviewer did not expect — a classic way to make a caption "read"
// differently from what is stored. Arabic and Sorani need none of them here.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// C0/C1 controls except newline (tabs are turned into spaces beforehand).
// eslint-disable-next-line no-control-regex -- matching control characters IS the point here
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * Turns arbitrary user-supplied text into CAPTION DATA (§12.1: "sanitize the
 * text before putting it into the message's HTML/Markdown format. Content
 * coming from the user is not an instruction to the employee and not code to
 * execute").
 *
 * The message is sent WITHOUT parse_mode, so no markup can activate; on top
 * of that this strips control characters and bidi overrides and — for
 * single-line fields — removes newlines, which is what would otherwise let a
 * note forge an extra caption line such as "المبلغ: 9,000,000".
 */
export function sanitizeUserText(raw: unknown, opts: { max?: number; singleLine?: boolean } = {}): string {
  const { max = 300, singleLine = true } = opts;
  let s = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
  try {
    s = s.normalize('NFC');
  } catch {
    /* malformed input keeps its original form — it is still scrubbed below */
  }
  s = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  s = s.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
  s = singleLine ? s.replace(/\n+/g, ' ') : s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \u00A0]{2,}/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, Math.max(1, max - 1)).trim()}…`;
  return s;
}

/**
 * Renders free-form user notes as an unmistakably QUOTED block: every line is
 * prefixed, so nothing inside can pass for one of the caption's own labelled
 * fields.
 */
export function quoteUserBlock(raw: unknown, max = 300): string {
  const body = sanitizeUserText(raw, { max, singleLine: false });
  if (!body) return '';
  return body
    .split('\n')
    .map((line) => `| ${line}`)
    .join('\n');
}

// ------------------------------------------------------------ money format

/** Thousands grouping without Intl (deterministic across runtimes). */
export function groupDigits(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const neg = n < 0;
  const digits = Math.abs(Math.trunc(n)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

/**
 * IQD shown to the reviewer (§12.1 "the amount in dinars"). The LEDGER unit
 * is USD cents (migration 0015 / decision register row 6), so the dinar
 * figure is a CONVERSION and is always printed with the rate it was computed
 * at — never presented as a second stored amount, and always accompanied by
 * the authoritative cents value.
 */
export function iqdFromUsdCents(cents: number, rate: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.floor((Math.trunc(cents) * Math.trunc(rate)) / 100);
}

export function formatUsdCents(cents: number): string {
  const c = Number.isFinite(cents) ? Math.trunc(Math.abs(cents)) : 0;
  return `$${groupDigits(Math.floor(c / 100))}.${String(c % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------- rejection reasons

/** Selectable rejection reasons (§12.2: "rejection needs a selectable,
 *  recordable reason; if it needs detail, open the admin path"). Codes are
 *  stable; the label is what the reviewer sees and what is recorded with the
 *  decision. */
export const REJECT_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'not_received', label: 'لم يصل المبلغ إلى الحساب' },
  { code: 'amount_mismatch', label: 'المبلغ لا يطابق الإثبات' },
  { code: 'proof_unclear', label: 'الإثبات غير واضح أو ناقص' },
  { code: 'duplicate_transfer', label: 'تحويل مكرر سبق اعتماده' },
  { code: 'needs_admin_review', label: 'سبب آخر — يُستكمل من لوحة الإدارة' },
];

export function rejectReasonLabel(code: string): string {
  return REJECT_REASONS.find((r) => r.code === code)?.label ?? 'سبب غير محدد';
}

// ----------------------------------------------------------- callback data

/** `wa:<token>` — 3 + 24 characters, far inside Telegram's 64-byte limit. */
export function encodeCallbackData(rawToken: string): string {
  const data = `${CB_PREFIX}${rawToken}`;
  if (data.length > CALLBACK_DATA_MAX) throw new Error('callback_data too long');
  return data;
}

/** Extracts the raw token, or null for anything that is not ours. */
export function parseCallbackData(data: unknown): string | null {
  if (typeof data !== 'string' || !data.startsWith(CB_PREFIX)) return null;
  const token = data.slice(CB_PREFIX.length);
  return /^[A-Za-z0-9_-]{16,60}$/.test(token) ? token : null;
}

// --------------------------------------------------------------- keyboards

export interface DecisionTokens {
  approve: string;
  rejectMenu: string;
}
export interface ReasonTokens {
  menuMain: string;
  reasons: Array<{ code: string; token: string }>;
}

/**
 * Deep link to the operation in the admin panel. It carries NO token and
 * grants NOTHING: it opens the normal admin route, which authenticates and
 * authorizes on its own (§12.1 "a safe link to the operation's details in the
 * admin panel"). Returns null when APP_ORIGIN is unconfigured — an unlinked
 * message is honest, a fabricated origin is not.
 */
export function adminDeepLink(env: Env, _kind: WalletRequestKind, requestId: string): string | null {
  const origin = (env.APP_ORIGIN || '').replace(/\/+$/, '');
  if (!origin.startsWith('https://')) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return null;
  return `${origin}/admin?tab=wallet_requests&op=${encodeURIComponent(requestId)}`;
}

export function decisionKeyboard(tokens: DecisionTokens, adminUrl: string | null): Record<string, unknown> {
  const rows: Array<Array<Record<string, unknown>>> = [
    [
      { text: '✅ قبول', callback_data: encodeCallbackData(tokens.approve) },
      { text: '❌ رفض', callback_data: encodeCallbackData(tokens.rejectMenu) },
    ],
  ];
  if (adminUrl) rows.push([{ text: '🔗 فتح في لوحة الإدارة', url: adminUrl }]);
  return { inline_keyboard: rows };
}

export function reasonKeyboard(tokens: ReasonTokens, adminUrl: string | null): Record<string, unknown> {
  const rows: Array<Array<Record<string, unknown>>> = tokens.reasons.map((r) => [
    { text: `❌ ${rejectReasonLabel(r.code)}`, callback_data: encodeCallbackData(r.token) },
  ]);
  rows.push([{ text: '↩️ رجوع', callback_data: encodeCallbackData(tokens.menuMain) }]);
  if (adminUrl) rows.push([{ text: '🔗 فتح في لوحة الإدارة', url: adminUrl }]);
  return { inline_keyboard: rows };
}

/** Closed state: the consumed decision buttons are gone; only the
 *  authority-free admin link may remain (§12.2). */
export function closedKeyboard(adminUrl: string | null): Record<string, unknown> {
  return { inline_keyboard: adminUrl ? [[{ text: '🔗 فتح في لوحة الإدارة', url: adminUrl }]] : [] };
}

// ----------------------------------------------------------------- caption

export interface DepositCaptionInput {
  operationNumber: string;
  amountUsdCents: number;
  exchangeRate: number;
  userName: string;
  username: string | null;
  /** Minimized contact for review: a verified email, else a masked phone. */
  contactLabel: string;
  contactValue: string;
  method: string;
  reference: string;
  reviewState: string;
  createdAt: string;
  note: string;
  /** false → the message says plainly that the image is not attached. */
  proofAttached: boolean;
  proofNote?: string;
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  awaiting_review: 'بانتظار المراجعة',
  amount_mismatch: '⚠️ المبلغ المرصود لا يطابق المطلوب',
  duplicate_reference_signal: '⚠️ إشارة مرجع مكرر',
  fingerprint_reuse_signal: '⚠️ إشارة إعادة استخدام صورة الإثبات',
  cleared_for_decision: 'تم رصد المبلغ ويطابق الطلب',
};

/** The proof line, so the caption and its fallback rewrite stay in sync. */
export function proofLine(attached: boolean, problem = ''): string {
  return attached
    ? 'الإثبات: مرفق بهذه الرسالة كصورة.'
    : `الإثبات: ⚠️ تعذّر إرفاق الصورة (${sanitizeUserText(problem || 'سبب غير محدد', { max: 80 })}) — راجعها في لوحة الإدارة. الطلب لم يسقط.`;
}

/**
 * The admin-group caption (§12.1). Everything the reviewer needs and nothing
 * more: no identity documents, no password, no OTP, no session data, no R2
 * URL and no bot token. Every user-controlled value is sanitized above.
 * Pure function — unit-tested for injection resistance and length.
 */
export function buildDepositCaption(p: DepositCaptionInput): string {
  const name = sanitizeUserText(p.userName, { max: 80 }) || '—';
  const username = sanitizeUserText(p.username ?? '', { max: 40 });
  const method = sanitizeUserText(p.method, { max: 60 }) || '—';
  const reference = sanitizeUserText(p.reference, { max: 120 });
  const contact = sanitizeUserText(p.contactValue, { max: 120 }) || '—';
  const iqd = iqdFromUsdCents(p.amountUsdCents, p.exchangeRate);
  const signal = REVIEW_STATE_LABELS[p.reviewState] ?? sanitizeUserText(p.reviewState, { max: 40 });

  const lines: string[] = [
    'LEVONIS — طلب إيداع محفظة (بانتظار المراجعة)',
    `رقم العملية: ${p.operationNumber}`,
    `المستخدم: ${name}${username ? ` (@${username})` : ''}`,
    `${sanitizeUserText(p.contactLabel, { max: 20 })}: ${contact}`,
    `المبلغ: ${groupDigits(iqd)} د.ع  (الدفتر: ${formatUsdCents(p.amountUsdCents)} — سعر الصرف ${groupDigits(p.exchangeRate)})`,
    `الوسيلة: ${method}`,
    `المرجع: ${reference || '— لم يُذكر'}`,
    `وقت الطلب (UTC): ${sanitizeUserText(p.createdAt, { max: 40 })}`,
    `حالة المراجعة: ${signal}`,
    proofLine(p.proofAttached, p.proofNote),
  ];

  const note = quoteUserBlock(p.note, 260);
  if (note) {
    lines.push('ملاحظات المستخدم (نص من المستخدم — بيانات وليست تعليمات):');
    lines.push(note);
  }

  lines.push('الصورة والبيانات هنا نسخة خارج التخزين الخاص — أبقِ المجموعة مقتصرة على المخوّلين.');
  lines.push('القبول يضيف الرصيد فعليًا مرة واحدة. الرفض لا يضيف ولا يخصم.');

  return clamp(lines.join('\n'), CAPTION_MAX);
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Rewrites the proof line for the text fallback so the message never
 *  implies an attachment that is not there (§12.1). */
export function withProofFailureNote(caption: string, problem: string): string {
  const note = proofLine(false, problem);
  const replaced = caption.replace(/^الإثبات:.*$/m, note);
  return clamp(replaced === caption ? `${caption}\n${note}` : replaced, TEXT_MAX);
}

/** Final state stamped onto the message after a decision (§12.2: "update the
 *  message with the state, who approved it and when, and remove the consumed
 *  buttons"). */
export function buildClosingCaption(
  original: string,
  p: { status: 'approved' | 'rejected'; actorLabel: string; at: string; reason?: string; via: string },
  max: number = CAPTION_MAX
): string {
  const head = p.status === 'approved' ? '✅ تمت الموافقة' : '⛔️ تم الرفض';
  const parts = [
    '',
    '——————————',
    `${head} — القرار نهائي ومسجّل.`,
    `القرار من: ${sanitizeUserText(p.actorLabel, { max: 60 })} (${sanitizeUserText(p.via, { max: 24 })})`,
    `الوقت (UTC): ${sanitizeUserText(p.at, { max: 40 })}`,
  ];
  if (p.status === 'rejected' && p.reason) parts.push(`السبب: ${sanitizeUserText(p.reason, { max: 120 })}`);
  const tail = parts.join('\n');
  // The STAMP is the part that must survive: when the combined text would
  // overflow, the original body is trimmed, never the decision record.
  if (tail.length >= max) return clamp(tail, max);
  const room = max - tail.length;
  return `${original.length <= room ? original : clamp(original, room)}${tail}`;
}

// ------------------------------------------------------------ admin actors

export interface AdminActor {
  userId: string;
  name: string;
  username: string | null;
  telegramUserId: number;
}

/**
 * Resolves a Telegram sender to a site admin (§12.2). The role is read from
 * `users` in the SAME query — a seeded identity whose site account has since
 * been demoted or deleted authorizes nothing — and the mapping is never
 * cached in this module.
 */
export async function resolveAdminActor(env: Env, telegramUserId: unknown): Promise<AdminActor | null> {
  if (typeof telegramUserId !== 'number' || !Number.isInteger(telegramUserId)) return null;
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

function labelOf(name: string, username: string | null, userId: string): string {
  const uname = sanitizeUserText(username ?? '', { max: 40 });
  const clean = sanitizeUserText(name, { max: 60 });
  return uname ? `${clean || 'مسؤول'} (@${uname})` : clean || `مسؤول #${userId.slice(-6)}`;
}

export function actorLabel(actor: AdminActor): string {
  return labelOf(actor.name, actor.username, actor.userId);
}

/** Human label for "who decided", resolved from the ledger's actor id. */
export async function describeDecider(env: Env, userId: string | null): Promise<string> {
  if (!userId) return 'مسؤول غير محدد';
  const row = await env.DB.prepare('SELECT name, username FROM users WHERE id = ?')
    .bind(userId)
    .first<{ name: string; username: string | null }>();
  return row ? labelOf(row.name, row.username, userId) : `مسؤول #${userId.slice(-6)}`;
}

// -------------------------------------------------------------- enqueueing

export interface EnqueueResult {
  enqueued: boolean;
  id: string | null;
  reason?: 'already_enqueued' | 'request_not_found' | 'not_configured';
}

interface DepositFacts {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  receipt_key: string | null;
  payment_method: string;
  note: string;
  created_at: string;
  name: string;
  username: string | null;
  email: string;
  email_verified_at: string | null;
  phone_e164: string | null;
  provider: string | null;
  channel: string | null;
  reference: string | null;
  review_state: string | null;
}

/** A Telegram-signup placeholder address is not a contact channel, and an
 *  unverified address is not a verified one (§12.3). */
function verifiedEmail(email: string, verifiedAt: string | null): string | null {
  if (!email || email.endsWith('@telegram.local')) return null;
  return verifiedAt ? email : null;
}

/**
 * Records the admin-group notification for a NEW deposit request. Idempotent
 * per business event: the UNIQUE event_key means a replayed call (retry,
 * double submit, cron) adds nothing and returns `already_enqueued`.
 *
 * It reads the facts from the database rather than taking them as arguments,
 * so the caption can never describe an amount, a user or a proof the ledger
 * does not actually hold.
 */
export async function enqueueDepositAdminNotification(env: Env, requestId: string): Promise<EnqueueResult> {
  const facts = await env.DB.prepare(
    `SELECT t.id, t.user_id, t.amount, t.status, t.receipt_key, t.payment_method, t.note, t.created_at,
            u.name, u.username, u.email, u.email_verified_at, u.phone_e164,
            m.provider, m.channel, m.reference, m.review_state
       FROM wallet_transactions t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN wallet_deposit_meta m ON m.tx_id = t.id
      WHERE t.id = ? AND t.type = 'deposit' AND t.currency = 'USD'`
  )
    .bind(requestId)
    .first<DepositFacts>();
  if (!facts) return { enqueued: false, id: null, reason: 'request_not_found' };

  /**
   * 0080 — WHERE THIS GOES IS DECIDED ONCE, HERE, AND STORED.
   *
   * The destination is resolved at enqueue time rather than at each delivery
   * attempt so that a retry three hours later cannot land in a different
   * topic than the buttons were minted for, and so the row itself records
   * where the message was meant to go. The ladder is §9's: the wallet topic,
   * else GENERAL, else the pre-0080 chat on the customer bot.
   */
  const routed = await resolveAdminDestination(env, 'wallet');
  if (!routed.ok) {
    // NOT a silent return any more. The row IS the durable record §12.3 exists
    // for, so it is written even with nowhere to send: the delivery pass
    // re-resolves the destination on every attempt, so binding the group ten
    // minutes later delivers this message instead of losing it. Returning
    // early here left a deposit with no retryable record at all, and
    // `/admin/group/reset` made that a routine window.
    console.error(
      JSON.stringify({
        event: 'telegram_admin_routing_error',
        topic: 'wallet',
        reason: routed.miss,
        request_id: facts.id,
        detail: 'no admin destination yet; the notification is queued and will be delivered once one exists',
      })
    );
  }
  const dest = routed.ok ? routed.destination : null;
  const targetChat = dest?.chatId ?? '';

  const rate = Number(await getSetting(env.DB, 'exchangeRate')) || 1400;
  const email = verifiedEmail(facts.email, facts.email_verified_at);
  const caption = buildDepositCaption({
    operationNumber: operationNumber(facts.id),
    amountUsdCents: facts.amount,
    exchangeRate: rate,
    userName: facts.name,
    username: facts.username,
    // Minimum necessary data (§12.1): a verified email is a working contact;
    // otherwise a MASKED phone, with the full record left in the admin panel.
    contactLabel: email ? 'البريد' : 'الهاتف',
    contactValue: email ?? (facts.phone_e164 ? maskPhone(facts.phone_e164) : 'غير متاح — راجع لوحة الإدارة'),
    method: facts.provider || facts.payment_method || '',
    reference: facts.reference || '',
    reviewState: facts.review_state || 'awaiting_review',
    createdAt: facts.created_at,
    note: facts.note,
    proofAttached: !!facts.receipt_key,
    proofNote: facts.receipt_key ? undefined : 'لا يوجد مفتاح مرفق مسجّل',
  });

  const notificationId = newId('tgn');
  const eventKey = `wallet.deposit.requested:${facts.id}:tg_admin`;
  try {
    await env.DB.prepare(
      `INSERT INTO tg_admin_notifications
         (id, event_key, request_kind, request_id, target_chat, photo_key, caption, state,
          bot, message_thread_id, topic_key)
       VALUES (?1, ?2, 'deposit', ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9)`
    )
      .bind(
        notificationId,
        eventKey,
        facts.id,
        targetChat,
        facts.receipt_key ?? '',
        caption,
        dest?.bot ?? 'customer',
        dest?.messageThreadId ?? null,
        dest?.topicKey ?? ''
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) return { enqueued: false, id: null, reason: 'already_enqueued' };
    throw e;
  }
  return { enqueued: true, id: notificationId };
}

/**
 * Enqueue + immediate delivery attempt — the entry point the wallet slice
 * calls from its deposit route inside `ctx.waitUntil`. The business write has
 * already committed and nothing here can undo it: a delivery failure only
 * leaves a retryable row behind (§12.1 "if a photo cannot be sent, the
 * operation still shows up for review and is never dropped").
 */
export async function notifyAdminsOfDeposit(env: Env, requestId: string): Promise<EnqueueResult> {
  const res = await enqueueDepositAdminNotification(env, requestId);
  if (res.enqueued) {
    try {
      await processWalletNotifications(env, 3);
    } catch (e) {
      console.error('wallet notification delivery failed', e instanceof Error ? e.message : e);
    }
  }
  return res;
}

// ----------------------------------------------------------- token minting

/** The click window never moves: it is anchored to the notification. */
export function tokenExpiry(notificationCreatedAt: string): string {
  const base = new Date(notificationCreatedAt).getTime();
  const anchor = Number.isFinite(base) ? base : Date.now();
  return new Date(anchor + ACTION_TTL_HOURS * 3_600_000).toISOString();
}

interface MintContext {
  notificationId: string;
  kind: WalletRequestKind;
  requestId: string;
  expiresAt: string;
  chatId: number | null;
  messageId: number | null;
}

/**
 * Mints one keyboard's worth of tokens and supersedes every still-unconsumed
 * token of that notification, in ONE transaction: only the newest keyboard is
 * ever live, and a token row can never exist without its notification.
 *
 * The raw values live in this call's memory and in callback_data only —
 * never in the database (digest only), a log or an API response.
 */
async function mintTokens(
  env: Env,
  ctx: MintContext,
  specs: Array<{ action: TokenAction; reasonCode?: string }>
): Promise<string[]> {
  const raws: string[] = [];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE tg_admin_actions SET consumed_at = ${NOW_SQL}, outcome = 'superseded'
        WHERE notification_id = ?1 AND consumed_at IS NULL`
    ).bind(ctx.notificationId),
  ];
  for (const spec of specs) {
    const raw = randomToken(18); // 24 base64url chars → 27-byte callback_data
    raws.push(raw);
    const hash = await sha256Hex(raw);
    statements.push(
      env.DB.prepare(
        `INSERT INTO tg_admin_actions
           (token_hash, notification_id, request_kind, request_id, action, reason_code, chat_id, message_id, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
          WHERE EXISTS (SELECT 1 FROM tg_admin_notifications n WHERE n.id = ?2)`
      ).bind(
        hash,
        ctx.notificationId,
        ctx.kind,
        ctx.requestId,
        spec.action,
        spec.reasonCode ?? '',
        ctx.chatId,
        ctx.messageId,
        ctx.expiresAt
      )
    );
  }
  await env.DB.batch(statements);
  return raws;
}

async function mintDecisionTokens(env: Env, ctx: MintContext): Promise<DecisionTokens> {
  const [approve, rejectMenu] = await mintTokens(env, ctx, [{ action: 'approve' }, { action: 'reject_menu' }]);
  return { approve, rejectMenu };
}

async function mintReasonTokens(env: Env, ctx: MintContext): Promise<ReasonTokens> {
  const specs: Array<{ action: TokenAction; reasonCode?: string }> = REJECT_REASONS.map((r) => ({
    action: 'reject' as TokenAction,
    reasonCode: r.code,
  }));
  specs.push({ action: 'menu_main' });
  const raws = await mintTokens(env, ctx, specs);
  return {
    reasons: REJECT_REASONS.map((r, i) => ({ code: r.code, token: raws[i] })),
    menuMain: raws[raws.length - 1],
  };
}

// ---------------------------------------------------------- delivery (§12.3)

interface NotificationRow {
  /** 0080. 'customer' on every row written before the admin bot existed. */
  bot?: string;
  message_thread_id?: number | null;
  id: string;
  request_kind: WalletRequestKind;
  request_id: string;
  target_chat: string;
  photo_key: string;
  caption: string;
  attempts: number;
  created_at: string;
}

export interface ProcessReport {
  sent: number;
  failed: number;
  dead: number;
}

/**
 * Delivers pending/failed notifications. Each row is claimed with a
 * compare-and-swap on `attempts`, so two concurrent processors never send the
 * same row twice. Nothing here reads or writes the ledger.
 *
 * The proof is uploaded as BYTES read from private R2 — never a URL (§12.1).
 * When the object is missing, oversized, or Telegram refuses the photo, it
 * falls back to a text message that SAYS the image is not attached and the
 * row records `sent_as='text'`; the request stays reviewable in the admin
 * panel either way and is never dropped.
 */
export async function processWalletNotifications(env: Env, limit = 10): Promise<ProcessReport> {
  const report: ProcessReport = { sent: 0, failed: 0, dead: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, request_kind, request_id, target_chat, photo_key, caption, attempts, created_at,
            bot, message_thread_id
       FROM tg_admin_notifications
      WHERE state IN ('pending','failed') AND attempts < ?
      ORDER BY created_at LIMIT ?`
  )
    .bind(NOTIFY_MAX_ATTEMPTS, limit)
    .all<NotificationRow>();

  for (const row of results ?? []) {
    const claim = await env.DB.prepare(
      `UPDATE tg_admin_notifications SET attempts = attempts + 1, updated_at = ${NOW_SQL}
        WHERE id = ? AND state IN ('pending','failed') AND attempts = ?`
    )
      .bind(row.id, row.attempts)
      .run()
      .catch(() => null);
    if (!claim || (claim.meta.changes ?? 0) === 0) continue;

    /**
     * 0080 — THE DESTINATION IS RESOLVED AGAIN, ON EVERY ATTEMPT.
     *
     * The columns on the row are the recorded ROUTING INTENT (what the ladder
     * chose when the deposit was filed, kept for the audit); they are not the
     * address. Freezing the address is what stranded a message when the group
     * was later re-bound or reset: the admin's "retry" wrote `state='pending'`
     * and the next pass re-sent to the same dead chat, for ever.
     *
     * Re-resolving also means a notification queued while NOTHING was bound
     * delivers itself the moment a group exists.
     */
    const routed = await resolveAdminDestination(env, 'wallet');
    if (!routed.ok) {
      // No destination anywhere. Leave it PENDING and do not spend the attempt
      // budget on a wall: this is a configuration gap, not a delivery failure,
      // and burning five attempts would dead-letter a perfectly good message.
      // §9: the miss is REPORTED, with the reason that names the repair.
      console.error(
        JSON.stringify({
          event: 'telegram_admin_routing_error',
          topic: 'wallet',
          reason: routed.miss,
          detail: 'wallet top-up has no admin destination; it stays pending and reviewable in the admin panel',
        })
      );
      await env.DB.prepare(
        `UPDATE tg_admin_notifications
            SET attempts = ?2, last_error = 'NO_ADMIN_DESTINATION', updated_at = ${NOW_SQL}
          WHERE id = ?1`
      )
        .bind(row.id, row.attempts)
        .run();
      report.failed++;
      continue;
    }
    const dest = routed.destination;
    const rowBot: BotId = dest.bot;
    if (!botConfigured(env, rowBot)) {
      await markDead(env, row.id, 'TELEGRAM_NOT_CONFIGURED');
      report.dead++;
      continue;
    }
    const targetChat = dest.chatId;
    const thread = threadExtra(dest.messageThreadId);
    // Record where this attempt is ACTUALLY going, so the row never describes
    // a destination the send did not use.
    await env.DB.prepare(
      `UPDATE tg_admin_notifications
          SET target_chat = ?2, bot = ?3, message_thread_id = ?4, topic_key = ?5, updated_at = ${NOW_SQL}
        WHERE id = ?1`
    )
      .bind(row.id, targetChat, dest.bot, dest.messageThreadId, dest.topicKey)
      .run();

    // Fresh buttons for this attempt; the previous attempt's tokens (which
    // were never bound to a delivered message) are superseded here.
    const adminUrl = adminDeepLink(env, row.request_kind, row.request_id);
    const expiresAt = tokenExpiry(row.created_at);
    let keyboard: Record<string, unknown>;
    if (new Date(expiresAt).getTime() <= Date.now()) {
      // The click window is already over — send the record WITHOUT decision
      // buttons rather than a button that cannot work.
      keyboard = closedKeyboard(adminUrl);
    } else {
      const tokens = await mintDecisionTokens(env, {
        notificationId: row.id,
        kind: row.request_kind,
        requestId: row.request_id,
        expiresAt,
        chatId: null,
        messageId: null,
      });
      keyboard = decisionKeyboard(tokens, adminUrl);
    }

    let result: TgSendResult | null = null;
    let sentAs: 'photo' | 'text' = 'photo';
    let photoProblem = '';

    if (row.photo_key) {
      const bytes = await readProofBytes(env, row.photo_key);
      if (bytes.ok) {
        result = await sendPhotoToChat(
          env,
          targetChat,
          bytes.bytes,
          row.caption,
          { reply_markup: keyboard, ...thread },
          rowBot
        );
        // A transient transport problem is RETRIED as a photo; it is never
        // silently downgraded to a message claiming the proof is missing.
        if (!result.ok && result.retryable) {
          await markRetry(env, row.id, row.attempts + 1, result.error, report);
          continue;
        }
        if (!result.ok) photoProblem = 'رفض تيليغرام الصورة';
      } else {
        photoProblem = bytes.reason;
      }
    } else {
      photoProblem = 'لا يوجد مفتاح مرفق مسجّل';
    }

    if (!result || !result.ok) {
      sentAs = 'text';
      result = await sendMessageToChat(
        env,
        targetChat,
        withProofFailureNote(row.caption, photoProblem),
        { reply_markup: keyboard, ...thread },
        rowBot
      );
    }

    if (!result.ok) {
      await markRetry(env, row.id, row.attempts + 1, result.error, report);
      continue;
    }

    // Bind the delivered message to the row AND to its tokens in one
    // transaction. Until this lands no token can pass the chat/message check,
    // so a digest leaked from a backup is still unusable.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE tg_admin_notifications
            SET state = 'sent', chat_id = ?2, message_id = ?3, sent_as = ?4,
                delivery_note = substr(?5, 1, 200),
                sent_at = ${NOW_SQL}, updated_at = ${NOW_SQL}, last_error = ''
          WHERE id = ?1`
      ).bind(row.id, result.chat_id, result.message_id, sentAs, sentAs === 'text' ? photoProblem : ''),
      env.DB.prepare(
        `UPDATE tg_admin_actions SET chat_id = ?2, message_id = ?3
          WHERE notification_id = ?1 AND consumed_at IS NULL
            AND EXISTS (SELECT 1 FROM tg_admin_notifications n WHERE n.id = ?1 AND n.state = 'sent')`
      ).bind(row.id, result.chat_id, result.message_id),
    ]);
    report.sent++;
  }
  return report;
}

async function markRetry(env: Env, id: string, attempts: number, error: string, report: ProcessReport): Promise<void> {
  if (attempts >= NOTIFY_MAX_ATTEMPTS) {
    await markDead(env, id, error);
    report.dead++;
    return;
  }
  await env.DB.prepare(
    `UPDATE tg_admin_notifications SET state = 'failed', last_error = substr(?2, 1, 400), updated_at = ${NOW_SQL} WHERE id = ?1`
  )
    .bind(id, error)
    .run();
  report.failed++;
}

async function markDead(env: Env, id: string, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE tg_admin_notifications SET state = 'dead', last_error = substr(?2, 1, 400), updated_at = ${NOW_SQL} WHERE id = ?1`
  )
    .bind(id, error)
    .run();
}

type ProofBytes = { ok: true; bytes: ArrayBuffer } | { ok: false; reason: string };

/** Reads the private R2 object. No URL is ever produced or handed out. */
async function readProofBytes(env: Env, key: string): Promise<ProofBytes> {
  try {
    const head = await headMediaObject(env, 'private', key);
    if (!head) return { ok: false, reason: 'المرفق غير موجود في التخزين' };
    if (head.size > PHOTO_MAX_BYTES) return { ok: false, reason: 'حجم المرفق أكبر من حد تيليغرام' };
    const obj = await getMediaObject(env, 'private', key);
    if (!obj) return { ok: false, reason: 'المرفق غير موجود في التخزين' };
    return { ok: true, bytes: await obj.arrayBuffer() };
  } catch (e) {
    console.error('proof read failed', e instanceof Error ? e.message : e);
    return { ok: false, reason: 'تعذّر قراءة المرفق' };
  }
}

// ------------------------------------------------------- token validation

export type TokenFailure = 'unknown_token' | 'expired' | 'already_used' | 'wrong_message' | 'not_delivered';

export interface TokenRow {
  token_hash: string;
  notification_id: string;
  request_kind: WalletRequestKind;
  request_id: string;
  action: TokenAction;
  reason_code: string;
  chat_id: number | null;
  message_id: number | null;
  expires_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
  outcome: string;
}

export interface CallbackOrigin {
  chatId: number;
  messageId: number;
}

export type TokenLookup = { ok: true; row: TokenRow } | { ok: false; failure: TokenFailure; row?: TokenRow };

/**
 * Looks a token up and checks WHERE it was pressed. Every failure is
 * distinguishable server-side (for the audit trail) while the reviewer only
 * ever sees a generic, non-enumerating answer.
 */
export async function lookupActionToken(env: Env, rawToken: string, origin: CallbackOrigin): Promise<TokenLookup> {
  const hash = await sha256Hex(rawToken);
  const row = await env.DB.prepare(
    `SELECT token_hash, notification_id, request_kind, request_id, action, reason_code,
            chat_id, message_id, expires_at, consumed_at, consumed_by, outcome
       FROM tg_admin_actions WHERE token_hash = ?`
  )
    .bind(hash)
    .first<TokenRow>();
  if (!row) return { ok: false, failure: 'unknown_token' };
  if (row.chat_id === null || row.message_id === null) return { ok: false, failure: 'not_delivered', row };
  // §12.2: a copied button, or the same button in a second group, fails here.
  if (row.chat_id !== origin.chatId || row.message_id !== origin.messageId) {
    return { ok: false, failure: 'wrong_message', row };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, failure: 'expired', row };
  if (row.consumed_at) return { ok: false, failure: 'already_used', row };
  return { ok: true, row };
}

/**
 * Single-use claim for a DECISION token. The guard lives in the WHERE, so two
 * clicks on the same button — or the same button pressed by two reviewers —
 * cannot both proceed.
 */
export async function claimDecisionToken(
  env: Env,
  tokenHash: string,
  actor: AdminActor,
  origin: CallbackOrigin
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE tg_admin_actions
        SET consumed_at = ${NOW_SQL}, consumed_by = ?2, consumed_tg_user_id = ?3, outcome = 'claimed'
      WHERE token_hash = ?1 AND consumed_at IS NULL AND expires_at > ${NOW_SQL}
        AND action IN ('approve','reject') AND chat_id = ?4 AND message_id = ?5`
  )
    .bind(tokenHash, actor.userId, actor.telegramUserId, origin.chatId, origin.messageId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Releases a claim whose decision did NOT happen (transport/DB error) so the
 *  reviewer can press again. It never releases a claim that decided. */
export async function releaseDecisionToken(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE tg_admin_actions
        SET consumed_at = NULL, consumed_by = NULL, consumed_tg_user_id = NULL, outcome = ''
      WHERE token_hash = ? AND outcome = 'claimed'`
  )
    .bind(tokenHash)
    .run();
}

/** Records what a consumed token actually achieved. */
export async function finalizeDecisionToken(
  env: Env,
  tokenHash: string,
  outcome: 'decided' | 'lost_race'
): Promise<void> {
  await env.DB.prepare("UPDATE tg_admin_actions SET outcome = ?2 WHERE token_hash = ?1 AND outcome = 'claimed'")
    .bind(tokenHash, outcome)
    .run();
}

/** Once the request is decided, every other button on that message is dead. */
export async function supersedeSiblingTokens(env: Env, notificationId: string, exceptHash: string): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE tg_admin_actions
        SET consumed_at = ${NOW_SQL}, outcome = 'superseded'
      WHERE notification_id = ?1 AND token_hash <> ?2 AND consumed_at IS NULL`
  )
    .bind(notificationId, exceptHash)
    .run();
  return res.meta.changes ?? 0;
}

/** Every outstanding button for a request that is no longer pending is dead —
 *  including after a decision taken on the SITE (§12.2). */
export async function supersedeTokensForDecidedRequest(env: Env, requestId: string): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE tg_admin_actions SET consumed_at = ${NOW_SQL}, outcome = 'superseded'
      WHERE request_id = ?1 AND consumed_at IS NULL
        AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1 AND t.status <> 'pending')`
  )
    .bind(requestId)
    .run();
  return res.meta.changes ?? 0;
}

// ------------------------------------------------------- the decision call

export type DecisionAction = 'approve' | 'reject';

/**
 * FROZEN CROSS-SLICE CONTRACT — the exact argument this module hands to
 * `walletOps.decideDeposit`. §12.2: "approval from the site and from Telegram
 * calls the SAME approval service, with the same constraints and the same
 * record. The bot never writes extra SQL that bypasses the safe path."
 *
 * `source` lets the wallet slice record WHERE a decision came from without
 * changing its guards; `reason` is the selected rejection reason label.
 */
export interface DepositDecisionRequest {
  requestId: string;
  action: DecisionAction;
  actorUserId: string;
  reason: string;
  source: 'telegram' | 'site';
}
type DecideDepositFn = (env: Env, p: DepositDecisionRequest) => Promise<unknown>;

/**
 * The ONLY way this module changes a deposit — nothing in this file writes to
 * wallet_transactions.
 *
 * The lookup is deliberately RUNTIME-CHECKED rather than a static import: the
 * wallet slice owns worker/lib/walletOps.ts and, at the time this slice was
 * written, had not yet exported `decideDeposit` (the frozen stub carried only
 * getAvailableBalances). A hard import would take the whole Telegram webhook —
 * linking, OTP and all — down with it over a contract that is still landing.
 * When the export is missing the call fails LOUDLY and the caller's
 * authoritative ledger re-read then reports "not decided": no button ever
 * pretends to have moved money that walletOps did not move.
 *
 * The return value is treated as OPAQUE on purpose. The authoritative outcome
 * is re-read from `wallet_transactions` afterwards, so the group message
 * reports what the database holds rather than what a return value claimed —
 * which also makes this side immune to the shape the wallet slice settles on.
 */
export async function callDepositDecision(
  env: Env,
  requestId: string,
  action: DecisionAction,
  actorUserId: string,
  reason: string
): Promise<{ called: boolean; raw: unknown; error?: string }> {
  let decide: DecideDepositFn;
  try {
    const mod = (await import('./walletOps')) as unknown as Record<string, unknown>;
    const fn = mod.decideDeposit;
    if (typeof fn !== 'function') {
      return {
        called: false,
        raw: null,
        error: 'walletOps.decideDeposit is not exported yet — the shared deposit approval service is missing',
      };
    }
    decide = fn as DecideDepositFn;
  } catch (e) {
    return { called: false, raw: null, error: `walletOps unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const raw: unknown = await decide(env, { requestId, action, actorUserId, reason, source: 'telegram' });
    return { called: true, raw };
  } catch (e) {
    return { called: false, raw: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface LedgerState {
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  admin_note: string;
  user_id: string;
  amount: number;
}

/** Authoritative post-decision read. */
export function readLedgerState(env: Env, requestId: string): Promise<LedgerState | null> {
  return env.DB.prepare(
    "SELECT status, decided_by, decided_at, admin_note, user_id, amount FROM wallet_transactions WHERE id = ? AND type = 'deposit'"
  )
    .bind(requestId)
    .first<LedgerState>();
}

// --------------------------------------------------- callback orchestration

export interface CallbackQueryInput {
  id: string;
  from?: { id?: number };
  data?: string;
  message?: { message_id?: number; chat?: { id?: number } };
}

export type CallbackOutcome =
  | 'ignored'
  | 'not_authorized'
  | 'expired'
  | 'wrong_message'
  | 'already_processed'
  | 'menu'
  | 'decided'
  | 'lost_race'
  | 'decision_failed'
  | 'unsupported_kind';

/**
 * Handles one inline-button press end to end (§12.2). Order matters:
 * authority → message binding → single-use claim → the shared decision
 * service → fast callback answer → message rewrite. Nothing is announced
 * before it is committed, and nothing is committed by this file.
 */
export async function handleAdminActionCallback(
  env: Env,
  cb: CallbackQueryInput,
  /**
   * WHICH BOT DELIVERED THE BUTTON (0080). A callback can only be answered,
   * and its message only edited, by the bot that owns that conversation — so
   * the webhook that received it passes its own identity in. It defaults to
   * `'customer'`, which is what every button minted before the admin bot
   * existed was delivered by.
   */
  bot: BotId = 'customer'
): Promise<CallbackOutcome> {
  const rawToken = parseCallbackData(cb.data);
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!rawToken || typeof chatId !== 'number' || typeof messageId !== 'number') {
    if (cb.id) await answerCallbackQuery(env, cb.id, 'زر غير صالح.', true, bot);
    return 'ignored';
  }
  const origin: CallbackOrigin = { chatId, messageId };

  // 1. WHO. Group membership grants nothing (§12.2).
  const actor = await resolveAdminActor(env, cb.from?.id);
  if (!actor) {
    await answerCallbackQuery(env, cb.id, 'لا تملك صلاحية اعتماد مالي في الموقع. اطلب من الإدارة ربط حسابك.', true, bot);
    await audit(env.DB, null, 'telegram.callback.denied', `tg:${cb.from?.id ?? 'unknown'}`, {
      chat_id: chatId,
      message_id: messageId,
      reason: 'no_admin_identity',
    });
    return 'not_authorized';
  }

  // 2. WHERE + token validity.
  const lookup = await lookupActionToken(env, rawToken, origin);
  if (!lookup.ok) {
    const text =
      lookup.failure === 'expired'
        ? 'انتهت صلاحية هذا الزر — أكمل القرار من لوحة الإدارة.'
        : lookup.failure === 'already_used'
          ? await staleButtonText(env, lookup.row)
          : 'هذا الزر غير صالح لهذه الرسالة.';
    await answerCallbackQuery(env, cb.id, text, true, bot);
    await audit(env.DB, actor.userId, 'telegram.callback.rejected', `wallet:${lookup.row?.request_id ?? 'unknown'}`, {
      failure: lookup.failure,
      chat_id: chatId,
      message_id: messageId,
    });
    if (lookup.failure === 'expired') return 'expired';
    if (lookup.failure === 'already_used') return 'already_processed';
    return 'wrong_message';
  }

  const row = lookup.row;
  const adminUrl = adminDeepLink(env, row.request_kind, row.request_id);

  // 3. Navigation actions move no money — they only redraw the keyboard so a
  //    rejection can carry a recorded reason (§12.2).
  if (row.action === 'reject_menu' || row.action === 'menu_main') {
    const ctx: MintContext = {
      notificationId: row.notification_id,
      kind: row.request_kind,
      requestId: row.request_id,
      expiresAt: row.expires_at,
      chatId,
      messageId,
    };
    const markup =
      row.action === 'reject_menu'
        ? reasonKeyboard(await mintReasonTokens(env, ctx), adminUrl)
        : decisionKeyboard(await mintDecisionTokens(env, ctx), adminUrl);
    await answerCallbackQuery(env, cb.id, row.action === 'reject_menu' ? 'اختر سبب الرفض.' : 'رجوع.', false, bot);
    await editMessageReplyMarkup(env, chatId, messageId, markup, bot);
    return 'menu';
  }

  // Withdrawals share this machinery but NOT the deposit decision service:
  // §12.2 "for a withdrawal, approve only authorises processing" — wiring it
  // to walletOps.advanceWithdrawal belongs to the wallet slice's contract, and
  // until that exists this answers honestly instead of guessing.
  if (row.request_kind !== 'deposit') {
    await answerCallbackQuery(env, cb.id, 'قرارات السحب تُتخذ من لوحة الإدارة — الموافقة هنا لا تنفّذ تحويلًا.', true, bot);
    return 'unsupported_kind';
  }

  // 4. Single-use claim.
  const claimed = await claimDecisionToken(env, row.token_hash, actor, origin);
  if (!claimed) {
    await answerCallbackQuery(env, cb.id, await staleButtonText(env, row), true, bot);
    return 'already_processed';
  }

  const action: DecisionAction = row.action === 'approve' ? 'approve' : 'reject';
  const reason = action === 'reject' ? rejectReasonLabel(row.reason_code) : '';

  // 5. The shared approval service.
  const call = await callDepositDecision(env, row.request_id, action, actor.userId, reason);

  // 6. Authoritative re-read: the message reports the DATABASE, not a hope.
  const state = await readLedgerState(env, row.request_id);
  if (!state || state.status === 'pending') {
    // The transition did not happen — release the claim so the reviewer can
    // retry, and say so plainly. No "done" is ever shown for a non-commit.
    await releaseDecisionToken(env, row.token_hash);
    await answerCallbackQuery(env, cb.id, 'تعذّر تنفيذ القرار الآن — أعد المحاولة أو أكمل من لوحة الإدارة.', true, bot);
    await audit(env.DB, actor.userId, 'telegram.deposit.decision_failed', row.request_id, {
      action,
      called: call.called,
      error: (call.error ?? '').slice(0, 200),
    });
    return 'decision_failed';
  }

  const expected = action === 'approve' ? 'approved' : 'rejected';
  const won = state.status === expected && state.decided_by === actor.userId;
  await finalizeDecisionToken(env, row.token_hash, won ? 'decided' : 'lost_race');
  await supersedeSiblingTokens(env, row.notification_id, row.token_hash);

  const deciderLabel = won ? actorLabel(actor) : await describeDecider(env, state.decided_by);
  const decidedAt = state.decided_at ?? new Date().toISOString();

  // 7. Fast answer FIRST (§12.2), then the message rewrite.
  await answerCallbackQuery(
    env,
    cb.id,
    won
      ? state.status === 'approved'
        ? 'تمت الموافقة وأُضيف الرصيد.'
        : 'تم تسجيل الرفض. لم يتغيّر الرصيد.'
      : `عولج الطلب مسبقًا (${state.status === 'approved' ? 'موافقة' : 'رفض'}) بواسطة ${deciderLabel}.`,
    !won,
    bot
  );

  await audit(env.DB, actor.userId, won ? `telegram.deposit.${expected}` : 'telegram.deposit.lost_race', row.request_id, {
    action,
    reason_code: row.reason_code,
    final_status: state.status,
    decided_by: state.decided_by,
    source: 'telegram',
  });

  await closeNotificationMessage(env, row.notification_id, {
    status: state.status === 'approved' ? 'approved' : 'rejected',
    actorLabel: deciderLabel,
    at: decidedAt,
    reason: state.status === 'rejected' ? reason || sanitizeUserText(state.admin_note, { max: 120 }) : undefined,
    via: won ? 'تيليغرام' : 'قرار سابق',
  });

  await enqueueUserDepositStatusNotification(env, row.request_id);
  return won ? 'decided' : 'lost_race';
}

/**
 * Honest "you are too late" answer (§12.2: the second reviewer is TOLD, and
 * no balance is silently reversed).
 */
async function staleButtonText(env: Env, row?: TokenRow): Promise<string> {
  if (!row) return 'هذا الإجراء لم يعد صالحًا.';
  const state = await readLedgerState(env, row.request_id);
  if (!state || state.status === 'pending') return 'هذا الزر لم يعد صالحًا — استخدم أزرار أحدث رسالة أو لوحة الإدارة.';
  const who = await describeDecider(env, state.decided_by);
  return `عولج الطلب مسبقًا: ${state.status === 'approved' ? 'الموافقة' : 'الرفض'} بواسطة ${who}.`;
}

/**
 * Stamps the final state onto the group message and removes the consumed
 * buttons (§12.2). Idempotent and best-effort: a failure changes no money and
 * leaves `closed_state` unset so a later pass can retry.
 */
export async function closeNotificationMessage(
  env: Env,
  notificationId: string,
  p: { status: 'approved' | 'rejected'; actorLabel: string; at: string; reason?: string; via: string }
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id, request_kind, request_id, chat_id, message_id, caption, sent_as, delivery_note, bot
       FROM tg_admin_notifications WHERE id = ?`
  )
    .bind(notificationId)
    .first<{
      id: string;
      request_kind: WalletRequestKind;
      request_id: string;
      chat_id: number | null;
      message_id: number | null;
      caption: string;
      sent_as: string;
      delivery_note: string;
      bot: string | null;
    }>();
  if (!row || row.chat_id === null || row.message_id === null) return false;

  const adminUrl = adminDeepLink(env, row.request_kind, row.request_id);
  const isPhoto = row.sent_as === 'photo';
  // A message that went out WITHOUT the image must keep saying so after the
  // decision — the closing edit rebuilds the same honest proof line rather
  // than reverting to the stored photo caption.
  const body = isPhoto ? row.caption : withProofFailureNote(row.caption, row.delivery_note);
  const finalText = buildClosingCaption(body, p, isPhoto ? CAPTION_MAX : TEXT_MAX);
  // 0080 — edited by the bot that SENT it. A decision taken on the site has no
  // callback to name the bot, so the row is the only thing that knows.
  const rowBot: BotId = row.bot === 'admin' ? 'admin' : 'customer';
  const res = isPhoto
    ? await editMessageCaption(env, row.chat_id, row.message_id, finalText, closedKeyboard(adminUrl), rowBot)
    : await editMessageText(env, row.chat_id, row.message_id, finalText, closedKeyboard(adminUrl), rowBot);

  if (res.ok) {
    await env.DB.prepare(
      `UPDATE tg_admin_notifications SET closed_state = ?2, closed_at = ${NOW_SQL}, updated_at = ${NOW_SQL} WHERE id = ?1`
    )
      .bind(notificationId, p.status)
      .run();
  }
  return res.ok;
}

/**
 * Closes the group message for a decision taken ON THE SITE (§12.2: "if one
 * approves from the site and another from Telegram, only one final transition
 * succeeds… the second is told the request was processed"). The wallet slice
 * calls this from its admin decide route inside `ctx.waitUntil` — it updates a
 * message, never the ledger.
 */
export async function closeDepositNotification(env: Env, requestId: string): Promise<boolean> {
  const state = await readLedgerState(env, requestId);
  if (!state || state.status === 'pending') return false;
  await supersedeTokensForDecidedRequest(env, requestId);
  const row = await env.DB.prepare(
    `SELECT id FROM tg_admin_notifications
      WHERE request_kind = 'deposit' AND request_id = ? AND closed_state = ''
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(requestId)
    .first<{ id: string }>();
  if (!row) return false;
  return closeNotificationMessage(env, row.id, {
    status: state.status === 'approved' ? 'approved' : 'rejected',
    actorLabel: await describeDecider(env, state.decided_by),
    at: state.decided_at ?? new Date().toISOString(),
    reason: state.status === 'rejected' ? sanitizeUserText(state.admin_note, { max: 120 }) : undefined,
    via: 'لوحة الإدارة',
  });
}

// ------------------------------------------- customer status notifications

const STATUS_COPY: Record<'approved' | 'rejected', Record<EmailLang, { subject: string; line: string }>> = {
  approved: {
    ar: {
      subject: 'LEVONIS — تمت الموافقة على طلب إيداع المحفظة',
      line: 'تمت الموافقة على طلب الإيداع وأُضيف المبلغ إلى رصيدك المتاح.',
    },
    en: {
      subject: 'LEVONIS — wallet deposit approved',
      line: 'Your deposit request was approved and the amount was added to your available balance.',
    },
    ckb: {
      subject: 'LEVONIS — داواکاری زیادکردنی باڵانس پەسەندکرا',
      line: 'داواکارییەکەت پەسەندکرا و بڕەکە بۆ باڵانسی بەردەستت زیادکرا.',
    },
  },
  rejected: {
    ar: {
      subject: 'LEVONIS — تم رفض طلب إيداع المحفظة',
      line: 'تم رفض طلب الإيداع. لم يتغيّر رصيدك.',
    },
    en: {
      subject: 'LEVONIS — wallet deposit rejected',
      line: 'Your deposit request was rejected. Your balance did not change.',
    },
    ckb: {
      subject: 'LEVONIS — داواکاری زیادکردنی باڵانس ڕەتکرایەوە',
      line: 'داواکارییەکەت ڕەتکرایەوە. باڵانسەکەت نەگۆڕا.',
    },
  },
};

/**
 * Transactional status notification for the CUSTOMER (§12.3): in-site (the
 * ledger row itself, which the wallet page reads), plus the VERIFIED private
 * Telegram chat when one exists, plus a VERIFIED email address. Both external
 * channels go through the existing outbox, whose UNIQUE event_key makes a
 * replay a no-op. These are transactional messages, not marketing: they carry
 * no other user's data, no secret, and no link that acts on its own.
 */
export async function enqueueUserDepositStatusNotification(
  env: Env,
  requestId: string
): Promise<{ telegram: boolean; email: boolean }> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.status, t.amount, t.user_id, u.locale, u.email, u.email_verified_at,
            (SELECT l.chat_id FROM telegram_links l WHERE l.user_id = t.user_id AND l.revoked_at IS NULL) AS chat_id
       FROM wallet_transactions t JOIN users u ON u.id = t.user_id
      WHERE t.id = ? AND t.type = 'deposit'`
  )
    .bind(requestId)
    .first<{
      id: string;
      status: string;
      amount: number;
      user_id: string;
      locale: string;
      email: string;
      email_verified_at: string | null;
      chat_id: number | null;
    }>();
  if (!row || (row.status !== 'approved' && row.status !== 'rejected')) return { telegram: false, email: false };

  const status = row.status as 'approved' | 'rejected';
  const lang = emailLang(row.locale === 'ku' ? 'ckb' : row.locale);
  const copy = STATUS_COPY[status][lang];
  const rate = Number(await getSetting(env.DB, 'exchangeRate')) || 1400;
  const amountLine = `${groupDigits(iqdFromUsdCents(row.amount, rate))} د.ع (${formatUsdCents(row.amount)})`;
  const opNo = operationNumber(row.id);

  let telegram = false;
  if (row.chat_id !== null) {
    const id = await enqueueOutbox(env, `wallet.deposit.${status}:${row.id}:tg_user`, {
      kind: 'telegram',
      chat_id: row.chat_id,
      text: `LEVONIS\n${copy.line}\n\nرقم العملية: ${opNo}\nالمبلغ: ${amountLine}`,
    });
    telegram = id !== null;
  }

  let email = false;
  const address = verifiedEmail(row.email, row.email_verified_at);
  if (address) {
    const dir = lang === 'en' ? 'ltr' : 'rtl';
    const html =
      `<div dir="${dir}" style="font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;background:#0b0b0f;color:#e9e9ef;padding:24px">` +
      `<div style="max-width:520px;margin:0 auto;background:#15151c;border-radius:14px;padding:24px">` +
      `<div style="font-size:18px;font-weight:700;letter-spacing:1px;margin-bottom:12px">LEVONIS</div>` +
      `<p style="margin:0 0 12px;line-height:1.7">${escapeHtml(copy.line)}</p>` +
      `<p style="margin:0 0 6px;font-size:14px;opacity:.85">${escapeHtml(`رقم العملية: ${opNo}`)}</p>` +
      `<p style="margin:0;font-size:14px;opacity:.85">${escapeHtml(`المبلغ: ${amountLine}`)}</p>` +
      `</div></div>`;
    const id = await enqueueOutbox(env, `wallet.deposit.${status}:${row.id}:email`, {
      kind: 'email',
      to: address,
      subject: copy.subject,
      html,
      text: `${copy.line}\n\nرقم العملية: ${opNo}\nالمبلغ: ${amountLine}`,
    });
    email = id !== null;
  }
  return { telegram, email };
}
