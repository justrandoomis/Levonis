/**
 * Telegram wallet-approval tests — caption sanitization, action-token
 * mechanics and admin authority (integrated mandate §12.1/§12.2/§12.3,
 * acceptance rows WAL-02, WAL-04, WAL-05, WAL-06).
 *
 * These are NOT mock tests for the database parts. Every statement runs
 * against a real SQLite database created from the REAL migration file
 * (migrations/0017_tg_actions.sql) plus the real `wallet_transactions`
 * definition lifted out of migrations/0001_init.sql, through a thin adapter
 * that gives node:sqlite the D1 surface (prepare/bind/run/first/all/batch,
 * batch in ONE transaction, meta.changes from the driver). The CHECK
 * constraints, the conditional-UPDATE guards and the "0 rows updated aborts
 * the dependent write" behaviour are therefore exercised, not asserted about.
 *
 * What these tests cannot prove: Telegram's own delivery behaviour and D1's
 * concurrency on Cloudflare's storage. Races are simulated by interleaving
 * calls in one process, which exercises the guards but not the platform.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_TTL_HOURS,
  CAPTION_MAX,
  adminDeepLink,
  buildClosingCaption,
  buildDepositCaption,
  claimDecisionToken,
  closedKeyboard,
  decisionKeyboard,
  encodeCallbackData,
  finalizeDecisionToken,
  formatUsdCents,
  groupDigits,
  iqdFromUsdCents,
  lookupActionToken,
  parseCallbackData,
  proofLine,
  quoteUserBlock,
  reasonKeyboard,
  rejectReasonLabel,
  releaseDecisionToken,
  resolveAdminActor,
  sanitizeUserText,
  supersedeSiblingTokens,
  supersedeTokensForDecidedRequest,
  tokenExpiry,
  withProofFailureNote,
  REJECT_REASONS,
  type AdminActor,
} from '../worker/lib/walletNotify';
import { sha256Hex } from '../worker/lib/crypto';
import type { Env } from '../worker/lib/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------- D1 adapter

type Row = Record<string, unknown>;

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  private args(): never[] {
    return this.params as never[];
  }

  async run() {
    const res = this.db.prepare(this.sql).run(...this.args());
    return {
      success: true,
      results: [],
      meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid), duration: 0 },
    };
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row === undefined ? null : (row as T)) as T | null;
  }

  async all<T = Row>() {
    const rows = this.db.prepare(this.sql).all(...this.args()) as T[];
    return { success: true, results: rows, meta: { changes: 0, duration: 0 } };
  }
}

class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** D1 semantics: one transaction; any SQL error rolls the whole batch back. */
  async batch(statements: SqliteStatement[]) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Lifts one CREATE TABLE block out of a migration file, verbatim. */
function createTableSql(file: string, table: string): string {
  const src = readFileSync(join(ROOT, 'migrations', file), 'utf8');
  const start = src.indexOf(`CREATE TABLE ${table} (`);
  assert.ok(start >= 0, `${table} not found in ${file}`);
  const end = src.indexOf('\n);', start);
  assert.ok(end > start, `${table} block not terminated in ${file}`);
  return `${src.slice(start, end)}\n);`;
}

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  // `admin_scope` is here because migration 0021 puts it on `users` in
  // production and `resolveAdminActor` now reads it: approving a wallet
  // deposit from the bot is a FINANCIAL act, and an assistant admin — who
  // satisfies `role = 'admin'` — must not be able to perform one (mandate §11,
  // worker/lib/adminScope.ts). A fixture without the column would hide that
  // rule rather than test it.
  raw.exec(
    `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT, name TEXT NOT NULL DEFAULT '',
       role TEXT NOT NULL DEFAULT 'customer', admin_scope TEXT)`
  );
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(createTableSql('0001_init.sql', 'audit_log'));
  // The real 0017 file, applied exactly as production would apply it.
  raw.exec(readFileSync(join(ROOT, 'migrations', '0017_tg_actions.sql'), 'utf8'));

  raw.prepare("INSERT INTO users (id, email, username, name, role) VALUES (?,?,?,?,'admin')").run(
    'adm1',
    'a1@example.com',
    'ali',
    'Ali Finance'
  );
  raw.prepare("INSERT INTO users (id, email, username, name, role) VALUES (?,?,?,?,'admin')").run(
    'adm2',
    'a2@example.com',
    'sara',
    'Sara Finance'
  );
  raw.prepare("INSERT INTO users (id, email, username, name, role) VALUES (?,?,?,?,'customer')").run(
    'cus1',
    'c1@example.com',
    'omar',
    'Omar Customer'
  );
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

const envOf = (db: D1Database, extra: Partial<Env> = {}) => ({ DB: db, ...extra }) as unknown as Env;

function seedDeposit(raw: DatabaseSync, id = 'wtx_1', userId = 'cus1', amount = 10_000): void {
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, receipt_key, created_by)
       VALUES (?, ?, 'deposit', 'USD', ?, 'pending', '', 'receipts/cus1/x.jpg', 'user')`
    )
    .run(id, userId, amount);
}

function seedNotification(
  raw: DatabaseSync,
  p: { id?: string; requestId?: string; chatId?: number | null; messageId?: number | null; state?: string } = {}
): string {
  const id = p.id ?? 'tgn_1';
  const chatId = p.chatId === undefined ? -100777 : p.chatId;
  const messageId = p.messageId === undefined ? 55 : p.messageId;
  const state = p.state ?? (chatId === null ? 'pending' : 'sent');
  raw
    .prepare(
      `INSERT INTO tg_admin_notifications
         (id, event_key, request_kind, request_id, target_chat, photo_key, caption, state, chat_id, message_id, sent_as)
       VALUES (?, ?, 'deposit', ?, '-100777', 'receipts/cus1/x.jpg', 'caption', ?, ?, ?, ?)`
    )
    .run(
      id,
      `wallet.deposit.requested:${p.requestId ?? 'wtx_1'}:tg_admin`,
      p.requestId ?? 'wtx_1',
      state,
      chatId,
      messageId,
      state === 'sent' ? 'photo' : ''
    );
  return id;
}

async function seedToken(
  raw: DatabaseSync,
  p: {
    token: string;
    notificationId?: string;
    requestId?: string;
    action?: string;
    reasonCode?: string;
    chatId?: number | null;
    messageId?: number | null;
    expiresAt?: string;
  }
): Promise<string> {
  const hash = await sha256Hex(p.token);
  raw
    .prepare(
      `INSERT INTO tg_admin_actions
         (token_hash, notification_id, request_kind, request_id, action, reason_code, chat_id, message_id, expires_at)
       VALUES (?, ?, 'deposit', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      hash,
      p.notificationId ?? 'tgn_1',
      p.requestId ?? 'wtx_1',
      p.action ?? 'approve',
      p.reasonCode ?? '',
      p.chatId === undefined ? -100777 : p.chatId,
      p.messageId === undefined ? 55 : p.messageId,
      p.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString()
    );
  return hash;
}

const ADMIN1: AdminActor = { userId: 'adm1', name: 'Ali Finance', username: 'ali', telegramUserId: 111 };
const ADMIN2: AdminActor = { userId: 'adm2', name: 'Sara Finance', username: 'sara', telegramUserId: 222 };
const ORIGIN = { chatId: -100777, messageId: 55 };

// ------------------------------------------------- §12.1 caption is DATA

test('sanitizer strips control characters, bidi overrides and forged newlines', () => {
  // A note that tries to add its own caption field.
  const attack = 'شكرًا\nالمبلغ: 9,000,000 د.ع\nالحالة: مقبول';
  const single = sanitizeUserText(attack, { max: 200 });
  assert.equal(single.includes('\n'), false, 'a single-line field must not keep newlines');
  assert.match(single, /شكرًا/);

  // Bidi override + zero width + NUL are removed outright.
  const nasty = sanitizeUserText('a\u202Eb\u200Bc\u0000d\u0007e');
  assert.equal(nasty, 'abcde');

  // Truncation is explicit, never silent.
  const long = sanitizeUserText('x'.repeat(500), { max: 20 });
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));

  // Non-strings never crash the caption builder.
  assert.equal(sanitizeUserText(null), '');
  assert.equal(sanitizeUserText(undefined), '');
  assert.equal(sanitizeUserText(12345), '12345');
});

test('user notes are quoted so they cannot pass for a caption field', () => {
  const block = quoteUserBlock('سطر أول\nالمبلغ: 9,000,000');
  for (const line of block.split('\n')) assert.ok(line.startsWith('| '), `unquoted line: ${line}`);
});

test('deposit caption carries the mandated fields and no injected ones', () => {
  const caption = buildDepositCaption({
    operationNumber: 'W-ABCDEF',
    amountUsdCents: 12_345,
    exchangeRate: 1400,
    userName: 'عمر\nالحالة: مقبول',
    username: 'omar',
    contactLabel: 'البريد',
    contactValue: 'c1@example.com',
    method: 'زين كاش',
    reference: 'TRX-99',
    reviewState: 'awaiting_review',
    createdAt: '2026-08-29T10:00:00.000Z',
    note: 'حوّلت المبلغ\nالمبلغ: 9,000,000',
    proofAttached: true,
  });

  // §12.1 required content.
  assert.match(caption, /W-ABCDEF/);
  assert.match(caption, /@omar/);
  assert.match(caption, /c1@example\.com/);
  assert.match(caption, /زين كاش/);
  assert.match(caption, /TRX-99/);
  assert.match(caption, /2026-08-29T10:00:00\.000Z/);
  assert.match(caption, /مرفق بهذه الرسالة كصورة/);

  // The dinar figure is a conversion and says so, next to the ledger unit.
  assert.match(caption, /172,830 د\.ع/); // 12,345 cents x 1400 / 100
  assert.match(caption, /\$123\.45/);
  assert.match(caption, /سعر الصرف 1,400/);

  // Exactly ONE amount line and ONE status line survive the injection attempt.
  const amountLines = caption.split('\n').filter((l) => l.startsWith('المبلغ: '));
  assert.equal(amountLines.length, 1);
  assert.equal(caption.split('\n').some((l) => l.startsWith('الحالة: ')), false);

  // No secret, no storage URL, no R2 key.
  assert.equal(/https?:\/\//.test(caption), false);
  assert.equal(caption.includes('receipts/'), false);
});

test('caption never exceeds the Telegram limit, however long the user text', () => {
  const caption = buildDepositCaption({
    operationNumber: 'W-ABCDEF',
    amountUsdCents: 100_000,
    exchangeRate: 1400,
    userName: 'ن'.repeat(300),
    username: 'u'.repeat(200),
    contactLabel: 'البريد',
    contactValue: `${'e'.repeat(300)}@example.com`,
    method: 'م'.repeat(300),
    reference: 'r'.repeat(400),
    reviewState: 'awaiting_review',
    createdAt: '2026-08-29T10:00:00.000Z',
    note: 'ملاحظة طويلة جدًا. '.repeat(200),
    proofAttached: true,
  });
  assert.ok(caption.length <= CAPTION_MAX, `caption too long: ${caption.length}`);
});

test('a missing proof is stated plainly — the request is never silently dropped', () => {
  const attached = proofLine(true);
  const missing = proofLine(false, 'المرفق غير موجود في التخزين');
  assert.notEqual(attached, missing);
  assert.match(missing, /تعذّر إرفاق الصورة/);
  assert.match(missing, /الطلب لم يسقط/);

  const caption = buildDepositCaption({
    operationNumber: 'W-1',
    amountUsdCents: 1000,
    exchangeRate: 1400,
    userName: 'x',
    username: null,
    contactLabel: 'الهاتف',
    contactValue: '+9647*****789',
    method: 'cash',
    reference: '',
    reviewState: 'awaiting_review',
    createdAt: '2026-08-29T10:00:00.000Z',
    note: '',
    proofAttached: true,
  });
  const fallback = withProofFailureNote(caption, 'المرفق غير موجود في التخزين');
  assert.equal(fallback.includes('مرفق بهذه الرسالة كصورة'), false);
  assert.match(fallback, /تعذّر إرفاق الصورة/);
  // Exactly one proof line survives the rewrite.
  assert.equal(fallback.split('\n').filter((l) => l.startsWith('الإثبات: ')).length, 1);
});

test('the decision stamp always survives — a long caption is trimmed, the record is not', () => {
  const original = 'ن'.repeat(CAPTION_MAX);
  const closed = buildClosingCaption(original, {
    status: 'approved',
    actorLabel: 'Ali Finance (@ali)',
    at: '2026-08-29T11:00:00.000Z',
    via: 'تيليغرام',
  });
  assert.ok(closed.length <= CAPTION_MAX);
  // The part that proves who decided and when must never be the part cut off.
  assert.match(closed, /تمت الموافقة/);
  assert.match(closed, /Ali Finance/);
  assert.match(closed, /2026-08-29T11:00:00\.000Z/);
});

test('a message delivered without the image still says so after the decision', () => {
  const caption = buildDepositCaption({
    operationNumber: 'W-1',
    amountUsdCents: 1000,
    exchangeRate: 1400,
    userName: 'x',
    username: null,
    contactLabel: 'الهاتف',
    contactValue: '+9647*****789',
    method: 'cash',
    reference: '',
    reviewState: 'awaiting_review',
    createdAt: '2026-08-29T10:00:00.000Z',
    note: '',
    proofAttached: true,
  });
  // What closeNotificationMessage does for a sent_as='text' row.
  const delivered = withProofFailureNote(caption, 'المرفق غير موجود في التخزين');
  const closed = buildClosingCaption(delivered, {
    status: 'approved',
    actorLabel: 'Ali',
    at: '2026-08-29T11:00:00.000Z',
    via: 'تيليغرام',
  }, 4000);
  assert.equal(closed.includes('مرفق بهذه الرسالة كصورة'), false);
  assert.match(closed, /تعذّر إرفاق الصورة/);
  assert.match(closed, /تمت الموافقة/);
});

test('closing stamp records status, who and when — and a rejection reason', () => {
  const closed = buildClosingCaption('LEVONIS — طلب إيداع', {
    status: 'rejected',
    actorLabel: 'Ali Finance (@ali)',
    at: '2026-08-29T11:00:00.000Z',
    reason: rejectReasonLabel('not_received'),
    via: 'تيليغرام',
  });
  assert.match(closed, /تم الرفض/);
  assert.match(closed, /Ali Finance/);
  assert.match(closed, /2026-08-29T11:00:00\.000Z/);
  assert.match(closed, /لم يصل المبلغ/);
  assert.ok(closed.length <= CAPTION_MAX);
});

// ------------------------------------------------------------ money format

test('IQD conversion floors to whole dinars and rejects nonsense input', () => {
  assert.equal(iqdFromUsdCents(10_000, 1400), 140_000);
  assert.equal(iqdFromUsdCents(1, 1400), 14);
  assert.equal(iqdFromUsdCents(1, 150), 1); // 1.5 IQD floors to 1 — never rounded up
  assert.equal(iqdFromUsdCents(Number.NaN, 1400), 0);
  assert.equal(iqdFromUsdCents(1000, 0), 0);
  assert.equal(iqdFromUsdCents(1000, -5), 0);
  assert.equal(groupDigits(1_234_567), '1,234,567');
  assert.equal(groupDigits(0), '0');
  assert.equal(formatUsdCents(12_345), '$123.45');
  assert.equal(formatUsdCents(5), '$0.05');
});

// ------------------------------------------------ §12.2 callback_data rules

test('callback_data carries only an opaque token — no amount, no user id', () => {
  const data = encodeCallbackData('AbCd_-0123456789xyzABCD');
  assert.ok(new TextEncoder().encode(data).length <= 64, 'callback_data must fit 64 bytes');
  assert.match(data, /^wa:[A-Za-z0-9_-]+$/);
  assert.equal(parseCallbackData(data), 'AbCd_-0123456789xyzABCD');

  // Anything that is not ours, or that tries to smuggle a payload, is refused.
  assert.equal(parseCallbackData('approve:wtx_1:10000'), null);
  assert.equal(parseCallbackData('wa:short'), null);
  assert.equal(parseCallbackData('wa:has spaces and stuff!!'), null);
  assert.equal(parseCallbackData(undefined), null);
  assert.equal(parseCallbackData({ toString: () => 'wa:xxxxxxxxxxxxxxxxxxxx' }), null);

  // A token longer than the button allows is a programming error, not a
  // silently truncated button.
  assert.throws(() => encodeCallbackData('z'.repeat(70)));
});

test('keyboards only ever contain our tokens and an authority-free admin link', () => {
  const kb = decisionKeyboard({ approve: 'a'.repeat(24), rejectMenu: 'b'.repeat(24) }, 'https://levonis-iq.com/admin?tab=wallet_requests&op=wtx_1');
  const json = JSON.stringify(kb);
  assert.match(json, /wa:a{24}/);
  assert.match(json, /wa:b{24}/);
  // The URL button is a plain navigation link — no token in the query.
  // The URL button is navigation only: no token is ever placed in a link.
  const urlBtn = (kb.inline_keyboard as Array<Array<Record<string, unknown>>>)[1][0];
  assert.equal(String(urlBtn.url).includes('wa:'), false);
  assert.match(json, /levonis-iq\.com\/admin\?tab=wallet_requests/);

  const reasons = reasonKeyboard(
    { menuMain: 'm'.repeat(24), reasons: REJECT_REASONS.map((r, i) => ({ code: r.code, token: `${'t'.repeat(23)}${i}` })) },
    null
  );
  assert.equal((reasons.inline_keyboard as unknown[]).length, REJECT_REASONS.length + 1);

  // A closed message keeps no decision button at all.
  assert.deepEqual(closedKeyboard(null), { inline_keyboard: [] });
});

test('the admin deep link is refused unless APP_ORIGIN is a configured https origin', () => {
  assert.equal(adminDeepLink(envOf(null as unknown as D1Database), 'deposit', 'wtx_1'), null);
  assert.equal(adminDeepLink(envOf(null as unknown as D1Database, { APP_ORIGIN: 'http://insecure' }), 'deposit', 'wtx_1'), null);
  const link = adminDeepLink(envOf(null as unknown as D1Database, { APP_ORIGIN: 'https://levonis-iq.com/' }), 'deposit', 'wtx_1');
  assert.equal(link, 'https://levonis-iq.com/admin?tab=wallet_requests&op=wtx_1');
});

test('the click window is anchored to the notification, so redrawing cannot extend it', () => {
  const created = '2026-08-29T00:00:00.000Z';
  const expiry = tokenExpiry(created);
  assert.equal(new Date(expiry).getTime() - new Date(created).getTime(), ACTION_TTL_HOURS * 3_600_000);
});

// ------------------------------------------------- §12.2 who may decide

test('only a seeded identity whose site account is STILL an admin may decide', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);

  // Nothing is authorized before an admin seeds the mapping.
  assert.equal(await resolveAdminActor(env, 111), null);

  raw.prepare('INSERT INTO admin_tg_identities (telegram_user_id, user_id, created_by) VALUES (?,?,?)').run(111, 'adm1', 'adm2');
  const actor = await resolveAdminActor(env, 111);
  assert.equal(actor?.userId, 'adm1');

  // Group membership / a Telegram id that was never seeded grants nothing.
  assert.equal(await resolveAdminActor(env, 999), null);
  // Non-integer or missing sender ids are refused without touching the DB.
  assert.equal(await resolveAdminActor(env, undefined), null);
  assert.equal(await resolveAdminActor(env, '111'), null);

  // Demotion on the SITE immediately removes Telegram authority.
  raw.prepare("UPDATE users SET role = 'customer' WHERE id = 'adm1'").run();
  assert.equal(await resolveAdminActor(env, 111), null);

  // RESTRICTING THE SCOPE REMOVES THE BUTTON, not just the screen.
  //
  // `users.role = 'admin'` is TRUE for an assistant admin, so this query used
  // to authorise one to approve wallet deposits from the bot — the exact
  // financial authority §11 exists to withhold. Demoting somebody to assistant
  // must take the approval away, and it did not.
  raw.prepare("UPDATE users SET role = 'admin' WHERE id = 'adm1'").run();
  raw.prepare("UPDATE users SET admin_scope = 'assistant' WHERE id = 'adm1'").run();
  assert.equal(await resolveAdminActor(env, 111), null, 'an assistant admin may not decide money from the bot');

  // THE OWNER IS EXEMPT, exactly as `canViewFinancials` exempts them: the
  // INITIAL_ADMIN_EMAIL account is always financial and can never be demoted,
  // so a stray 'assistant' on that row must not lock the owner out of the bot.
  const ownerEnv = envOf(db, { INITIAL_ADMIN_EMAIL: 'A1@Example.com  ' } as Partial<Env>);
  assert.ok(await resolveAdminActor(ownerEnv, 111), 'the owner is financial whatever the column says');

  // An UNSET owner email must not turn into "matches any empty email".
  raw.prepare("UPDATE users SET email = '' WHERE id = 'adm1'").run();
  assert.equal(await resolveAdminActor(envOf(db, { INITIAL_ADMIN_EMAIL: '' } as Partial<Env>), 111), null);

  raw.prepare("UPDATE users SET admin_scope = NULL, email = 'a1@example.com' WHERE id = 'adm1'").run();
  assert.ok(await resolveAdminActor(env, 111));
  raw
    .prepare(
      "UPDATE admin_tg_identities SET revoked_at = '2026-08-29T00:00:00.000Z', revoked_by = 'adm2', revoke_reason = 'left finance' WHERE telegram_user_id = 111"
    )
    .run();
  assert.equal(await resolveAdminActor(env, 111), null);
});

test('a revocation without an actor and a reason is unrepresentable (schema CHECK)', () => {
  const { raw } = freshDb();
  raw.prepare('INSERT INTO admin_tg_identities (telegram_user_id, user_id) VALUES (?,?)').run(111, 'adm1');
  assert.throws(
    () => raw.prepare("UPDATE admin_tg_identities SET revoked_at = '2026-08-29T00:00:00.000Z' WHERE telegram_user_id = 111").run(),
    /CHECK/i
  );
});

test('one site admin cannot hold two live Telegram identities', () => {
  const { raw } = freshDb();
  raw.prepare('INSERT INTO admin_tg_identities (telegram_user_id, user_id) VALUES (?,?)').run(111, 'adm1');
  assert.throws(
    () => raw.prepare('INSERT INTO admin_tg_identities (telegram_user_id, user_id) VALUES (?,?)').run(222, 'adm1'),
    /UNIQUE/i
  );
  // Revoking the first frees the admin to link a new account.
  raw
    .prepare(
      "UPDATE admin_tg_identities SET revoked_at = '2026-08-29T00:00:00.000Z', revoked_by = 'adm2', revoke_reason = 'device lost' WHERE telegram_user_id = 111"
    )
    .run();
  raw.prepare('INSERT INTO admin_tg_identities (telegram_user_id, user_id) VALUES (?,?)').run(222, 'adm1');
});

// ---------------------------------------------- §12.2 where it was pressed

test('a token only works on the exact chat and message it was delivered to', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw);
  await seedToken(raw, { token: 'tok-approve-000000000000' });

  // Right message → valid.
  const ok = await lookupActionToken(env, 'tok-approve-000000000000', ORIGIN);
  assert.equal(ok.ok, true);

  // WAL-05: a copied button in another group, or on another message.
  const otherChat = await lookupActionToken(env, 'tok-approve-000000000000', { chatId: -100888, messageId: 55 });
  assert.deepEqual([otherChat.ok, otherChat.ok === false && otherChat.failure], [false, 'wrong_message']);
  const otherMsg = await lookupActionToken(env, 'tok-approve-000000000000', { chatId: -100777, messageId: 56 });
  assert.deepEqual([otherMsg.ok, otherMsg.ok === false && otherMsg.failure], [false, 'wrong_message']);

  // An unknown / guessed token resolves to nothing.
  const unknown = await lookupActionToken(env, 'tok-guessed-0000000000000', ORIGIN);
  assert.deepEqual([unknown.ok, unknown.ok === false && unknown.failure], [false, 'unknown_token']);
});

test('an undelivered token cannot be used, even with the right raw value', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw, { chatId: null, messageId: null, state: 'pending' });
  await seedToken(raw, { token: 'tok-not-delivered-0000000', chatId: null, messageId: null });

  const res = await lookupActionToken(env, 'tok-not-delivered-0000000', ORIGIN);
  assert.deepEqual([res.ok, res.ok === false && res.failure], [false, 'not_delivered']);
});

test('an expired button is refused and points at the admin panel instead', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw);
  await seedToken(raw, { token: 'tok-expired-000000000000', expiresAt: new Date(Date.now() - 1000).toISOString() });

  const res = await lookupActionToken(env, 'tok-expired-000000000000', ORIGIN);
  assert.deepEqual([res.ok, res.ok === false && res.failure], [false, 'expired']);

  // The claim itself refuses it too — expiry is enforced in the WHERE, not
  // only in the read above.
  const hash = await sha256Hex('tok-expired-000000000000');
  assert.equal(await claimDecisionToken(env, hash, ADMIN1, ORIGIN), false);
});

// -------------------------------- §12.2 exactly one final transition (WAL-02/03)

test('two reviewers pressing the same button: exactly one claim wins', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw);
  const hash = await seedToken(raw, { token: 'tok-race-00000000000000' });

  const first = await claimDecisionToken(env, hash, ADMIN1, ORIGIN);
  const second = await claimDecisionToken(env, hash, ADMIN2, ORIGIN);
  assert.equal(first, true);
  assert.equal(second, false, 'a consumed token must never be claimed twice');

  const row = raw.prepare('SELECT consumed_by, consumed_tg_user_id, outcome FROM tg_admin_actions WHERE token_hash = ?').get(hash) as Row;
  assert.equal(row.consumed_by, 'adm1');
  assert.equal(row.consumed_tg_user_id, 111);
  assert.equal(row.outcome, 'claimed');

  // The loser sees the truth after the winner's decision is recorded.
  await finalizeDecisionToken(env, hash, 'decided');
  assert.equal(
    (raw.prepare('SELECT outcome FROM tg_admin_actions WHERE token_hash = ?').get(hash) as Row).outcome,
    'decided'
  );
});

test('a claim whose decision did not happen is released so the reviewer can retry', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw);
  const hash = await seedToken(raw, { token: 'tok-release-0000000000000' });

  assert.equal(await claimDecisionToken(env, hash, ADMIN1, ORIGIN), true);
  await releaseDecisionToken(env, hash);
  const row = raw.prepare('SELECT consumed_at, consumed_by, outcome FROM tg_admin_actions WHERE token_hash = ?').get(hash) as Row;
  assert.equal(row.consumed_at, null);
  assert.equal(row.consumed_by, null);
  assert.equal(row.outcome, '');
  // …and the button works again.
  assert.equal(await claimDecisionToken(env, hash, ADMIN1, ORIGIN), true);

  // A token that already DECIDED is never released back into use.
  await finalizeDecisionToken(env, hash, 'decided');
  await releaseDecisionToken(env, hash);
  assert.notEqual(
    (raw.prepare('SELECT consumed_at FROM tg_admin_actions WHERE token_hash = ?').get(hash) as Row).consumed_at,
    null
  );
});

test('deciding one button kills every other button on that message', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw);
  const approve = await seedToken(raw, { token: 'tok-approve-111111111111' });
  await seedToken(raw, { token: 'tok-rejmenu-11111111111', action: 'reject_menu' });
  for (const [i, r] of REJECT_REASONS.entries()) {
    await seedToken(raw, { token: `tok-reason-${i}-1111111111`, action: 'reject', reasonCode: r.code });
  }

  assert.equal(await claimDecisionToken(env, approve, ADMIN1, ORIGIN), true);
  const killed = await supersedeSiblingTokens(env, 'tgn_1', approve);
  assert.equal(killed, REJECT_REASONS.length + 1);

  // A rejection button pressed after the approval is simply not valid any more.
  const late = await lookupActionToken(env, 'tok-reason-0-1111111111', ORIGIN);
  assert.deepEqual([late.ok, late.ok === false && late.failure], [false, 'already_used']);
});

test('a decision taken on the SITE kills the Telegram buttons for that request', async () => {
  const { db, raw } = freshDb();
  const env = envOf(db);
  seedDeposit(raw);
  seedNotification(raw);
  await seedToken(raw, { token: 'tok-site-race-00000000000' });

  // While the request is pending, nothing is superseded.
  assert.equal(await supersedeTokensForDecidedRequest(env, 'wtx_1'), 0);
  assert.equal((await lookupActionToken(env, 'tok-site-race-00000000000', ORIGIN)).ok, true);

  // The site approves…
  raw
    .prepare(
      "UPDATE wallet_transactions SET status = 'approved', decided_by = 'adm2', decided_at = '2026-08-29T12:00:00.000Z' WHERE id = 'wtx_1'"
    )
    .run();
  assert.equal(await supersedeTokensForDecidedRequest(env, 'wtx_1'), 1);
  const after = await lookupActionToken(env, 'tok-site-race-00000000000', ORIGIN);
  assert.deepEqual([after.ok, after.ok === false && after.failure], [false, 'already_used']);
});

// --------------------------------------------------- schema honesty (§12.3)

test('a notification cannot claim to be sent without a real message reference', () => {
  const { raw } = freshDb();
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO tg_admin_notifications (id, event_key, request_kind, request_id, target_chat, state)
           VALUES ('tgn_x', 'k1', 'deposit', 'wtx_1', '-100777', 'sent')`
        )
        .run(),
    /CHECK/i
  );
});

test('the delivery record can state why the proof was not attached', () => {
  const { raw } = freshDb();
  seedNotification(raw, { id: 'tgn_note' });
  raw.prepare("UPDATE tg_admin_notifications SET sent_as = 'text', delivery_note = ? WHERE id = 'tgn_note'").run(
    'المرفق غير موجود في التخزين'
  );
  const row = raw.prepare("SELECT sent_as, delivery_note FROM tg_admin_notifications WHERE id = 'tgn_note'").get() as Row;
  assert.equal(row.sent_as, 'text');
  assert.equal(row.delivery_note, 'المرفق غير موجود في التخزين');
});

test('one business event enqueues one admin message (UNIQUE event_key)', () => {
  const { raw } = freshDb();
  seedDeposit(raw);
  seedNotification(raw, { id: 'tgn_a' });
  assert.throws(() => seedNotification(raw, { id: 'tgn_b' }), /UNIQUE/i);
});

test('a consumed action row must always record what became of it', () => {
  const { raw } = freshDb();
  seedNotification(raw);
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO tg_admin_actions (token_hash, notification_id, request_kind, request_id, action, expires_at, consumed_at)
           VALUES ('h1', 'tgn_1', 'deposit', 'wtx_1', 'approve', '2030-01-01T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`
        )
        .run(),
    /CHECK/i
  );
});

test('only a rejection may carry a reason code', () => {
  const { raw } = freshDb();
  seedNotification(raw);
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO tg_admin_actions (token_hash, notification_id, request_kind, request_id, action, reason_code, expires_at)
           VALUES ('h2', 'tgn_1', 'deposit', 'wtx_1', 'approve', 'not_received', '2030-01-01T00:00:00.000Z')`
        )
        .run(),
    /CHECK/i
  );
});

test('the stored token is only a digest — the raw value is never persisted', async () => {
  const { raw } = freshDb();
  seedNotification(raw);
  const token = 'tok-secret-999999999999';
  await seedToken(raw, { token });
  const rows = raw.prepare('SELECT * FROM tg_admin_actions').all() as Row[];
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(token), false, 'the raw token must never appear in the database');
  assert.match(String(rows[0].token_hash), /^[0-9a-f]{64}$/);
});
